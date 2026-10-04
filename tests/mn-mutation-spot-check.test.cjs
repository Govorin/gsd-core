'use strict';

/**
 * The mutation spot-check — the step `gsd_run verify mutation` (src/verify-mutation.cts) records a
 * `mutation:` block into VERIFICATION.md, and the gate `gsd_run check mn-mutation-spot-check`
 * (src/gate-mn-mutation-spot-check.cts) judges the record. Replaces
 * scripts/mutation-spot-check.mjs (decision 1 of the 3.12 design: the long run is a step, the gate
 * only reads; no stretched timeouts).
 *
 * The defect: a green run cannot distinguish "the code is correct" from "the test asserts
 * nothing". The case is on record — norn/13-01-SUMMARY.md: "my own test was a false green, caught
 * by mutation".
 *
 * Load-bearing and pinned below: a surviving mutant blocks; the source file is ALWAYS restored
 * (after each run, on a throw, on SIGINT/SIGTERM); the step bounds itself by a total budget; and a
 * record that is missing, stale or could-not-check never reads as a pass. Unit tests drive the run
 * with an injected runner and clock — nothing waits on wall time; the CLI tests use a tiny real
 * project whose test command is a node script.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, runGsdTools } = require('./helpers.cjs');
const { createMnProject, makePhase, writeWorkflowConfig, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const {
  runMutationSpotCheck,
  mutationCandidates,
  mutateOnce,
  buildMutationRecord,
  digestCandidates,
  readMaxMutants,
  MUTATION_STATUS,
  MUTATION_DEFAULT_MAX_MUTANTS,
} = require('../gsd-core/bin/lib/verify-mutation.cjs');
const { recordVerificationBlock, verificationPathFor } = require('../gsd-core/bin/lib/verify-gates.cjs');
const { evaluateMnMutationSpotCheck } = require('../gsd-core/bin/lib/gate-mn-mutation-spot-check.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** A source file whose behaviour a test can either check or ignore. */
const SOURCE = 'function isAdult(age) {\n  return age >= 18;\n}\nmodule.exports = { isAdult };\n';

function planDeclaring(files) {
  return `---\nphase: 03\nplan: 01\nfiles_modified:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n\n# Plan\n`;
}

/** Fake effects: a clock that only moves when a run "takes time", and a recorded signal surface. */
function fakeDeps({ runMs = 100, decide = () => 0 } = {}) {
  let now = 0;
  const handlers = {};
  const calls = [];
  return {
    calls,
    handlers,
    deps: {
      clock: { now: () => now },
      runner: (command, cwd, timeoutMs) => {
        calls.push({ command, cwd, timeoutMs });
        now += runMs;
        const status = decide(calls.length);
        return status === null ? { status: null, error: null, signal: 'SIGTERM' } : { status, error: null, signal: null };
      },
      writeFile: (file, content) => fs.writeFileSync(file, content),
      signals: {
        on: (sig, fn) => { handlers[sig] = fn; },
        off: (sig, fn) => { if (handlers[sig] === fn) delete handlers[sig]; },
        raise: (sig) => { const e = new Error('raised'); e.signal = sig; throw e; },
      },
    },
  };
}

describe('verify mutation — the run (injected runner and clock)', () => {
  let projectDir;
  let phaseDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-mutation-');
    ({ phaseDir } = makePhase(projectDir, { '03-01-PLAN.md': planDeclaring(['src.js']) }, 'ports'));
    fs.writeFileSync(path.join(projectDir, 'src.js'), SOURCE);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  const run = (overrides = {}) => runMutationSpotCheck({ projectDir, phaseDir, command: 'npm test', maxMutants: 3, ...overrides });
  const readSource = () => fs.readFileSync(path.join(projectDir, 'src.js'), 'utf8');

  test('a test that reacts to the mutant kills it', () => {
    const { deps } = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) }); // green baseline, red on the mutant
    const outcome = run({ deps });
    assert.equal(outcome.status, MUTATION_STATUS.PASSED);
    assert.deepEqual([outcome.attempted, outcome.killed.length, outcome.survived.length], [1, 1, 0]);
  });

  test('a test that stays green on the mutant lets it survive, and names it', () => {
    const { deps } = fakeDeps({ decide: () => 0 });
    const outcome = run({ deps });
    assert.equal(outcome.status, MUTATION_STATUS.SURVIVORS);
    assert.deepEqual(outcome.survived, [{ file: 'src.js', line: 2, label: '>= → >' }]);
  });

  test('the source file is restored whatever the verdict', () => {
    for (const decide of [() => 0, (n) => (n === 1 ? 0 : 1)]) {
      run({ deps: fakeDeps({ decide }).deps });
      assert.equal(readSource(), SOURCE, 'a step that leaves a mutation in the working tree is worse than no step');
    }
  });

  test('the runner sees the MUTATED file, then the original is back', () => {
    let seen = null;
    const { deps } = fakeDeps();
    deps.runner = () => {
      seen = seen === null ? 'baseline' : readSource();
      return { status: 0, error: null, signal: null };
    };
    run({ deps });
    assert.match(seen, /age > 18/);
    assert.equal(readSource(), SOURCE);
  });

  test('a runner that throws mid-mutant still restores the file', () => {
    const { deps } = fakeDeps();
    let calls = 0;
    deps.runner = () => {
      calls += 1;
      if (calls === 2) throw new Error('runner crashed');
      return { status: 0, error: null, signal: null };
    };
    assert.throws(() => run({ deps }), /runner crashed/);
    assert.equal(readSource(), SOURCE);
  });

  test('SIGTERM during a mutant run restores the file and re-raises; the handlers are installed only during the run', () => {
    const fake = fakeDeps();
    fake.deps.runner = (command) => {
      fake.calls.push(command);
      if (fake.calls.length === 2) {
        assert.match(readSource(), /age > 18/, 'the signal arrives while the mutant is on disk');
        fake.handlers.SIGTERM();
      }
      return { status: 0, error: null, signal: null };
    };
    assert.throws(() => run({ deps: fake.deps }), (err) => err.signal === 'SIGTERM');
    assert.equal(readSource(), SOURCE);
    assert.deepEqual(Object.keys(fake.handlers), [], 'no handler may outlive the run');
  });

  test('SIGINT restores and re-raises SIGINT', () => {
    const fake = fakeDeps();
    fake.deps.runner = (command) => {
      fake.calls.push(command);
      if (fake.calls.length === 2) fake.handlers.SIGINT();
      return { status: 0, error: null, signal: null };
    };
    assert.throws(() => run({ deps: fake.deps }), (err) => err.signal === 'SIGINT');
    assert.equal(readSource(), SOURCE);
  });

  test('refuses on an already-red suite instead of reporting kills', () => {
    const { deps, calls } = fakeDeps({ decide: () => 1 });
    const outcome = run({ deps });
    assert.equal(outcome.status, MUTATION_STATUS.RED_BASELINE);
    assert.equal(calls.length, 1, 'no mutant runs on a red tree');
  });

  test('refuses when the test command cannot run at all', () => {
    const { deps } = fakeDeps({ decide: () => null });
    assert.equal(run({ deps }).status, MUTATION_STATUS.UNRUNNABLE);
  });

  test('refuses when no command is configured', () => {
    const { deps, calls } = fakeDeps();
    assert.equal(run({ deps, command: '   ' }).status, MUTATION_STATUS.NO_COMMAND);
    assert.equal(calls.length, 0);
  });

  test('a mutant run that does not complete is not counted as killed — all of them failing is unrunnable', () => {
    const { deps } = fakeDeps({ decide: (n) => (n === 1 ? 0 : null) });
    const outcome = run({ deps });
    assert.deepEqual([outcome.attempted, outcome.unrunnable], [0, 1]);
    assert.equal(outcome.status, MUTATION_STATUS.UNRUNNABLE, 'nothing was measured: could not check, not nothing to check');
  });

  // ── what is mutated ───────────────────────────────────────────────────────

  test('nothing mutable declared — globs, directories, tests — is nothing_to_mutate, and runs nothing', () => {
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), planDeclaring(['libs/**', 'src.spec.js', 'tests/helper.js', 'assets/']));
    fs.writeFileSync(path.join(projectDir, 'src.spec.js'), 'const x = true === true;\n');
    const { deps, calls } = fakeDeps();
    assert.equal(run({ deps }).status, MUTATION_STATUS.NOTHING_TO_MUTATE);
    assert.equal(calls.length, 0);
  });

  test('never mutates the tests themselves', () => {
    const specBody = 'const x = true === true;\n';
    fs.writeFileSync(path.join(projectDir, 'src.spec.js'), specBody);
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), planDeclaring(['src.spec.js', 'src.js']));
    assert.deepEqual(mutationCandidates(projectDir, phaseDir), ['src.js']);
  });

  test('candidates come from every plan, deduplicated, sorted, existing files only', () => {
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), planDeclaring(['./b.ts', 'src.js', 'missing.js']));
    fs.writeFileSync(path.join(projectDir, 'b.ts'), 'export const b = true;\n');
    assert.deepEqual(mutationCandidates(projectDir, phaseDir), ['b.ts', 'src.js']);
  });

  test('mutateOnce changes exactly one place and never touches >= inside >==-like runs', () => {
    assert.deepEqual(mutateOnce('a >= b && c'), { label: '>= → >', line: 1, mutated: 'a > b && c' });
    assert.equal(mutateOnce('a === b').mutated, 'a !== b');
    assert.equal(mutateOnce('no operators here'), null);
  });

  // ── the budgets: mutation_max_mutants and the wall-clock budget ───────────

  function threeMutableFiles() {
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), planDeclaring(['a.js', 'b.js', 'c.js']));
    for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(projectDir, f), 'module.exports = 1 >= 0;\n');
  }

  for (const [maxMutants, expected] of [[2, 2], [3, 3], [4, 3]]) {
    test(`mutation_max_mutants ${maxMutants} over three mutable files attempts ${expected}`, () => {
      threeMutableFiles();
      const { deps } = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) });
      const outcome = run({ deps, maxMutants });
      assert.equal(outcome.attempted, expected);
      assert.equal(outcome.status, MUTATION_STATUS.PASSED);
    });
  }

  test('readMaxMutants: a positive integer is taken, anything else is the default', () => {
    for (const [value, expected] of [[1, 1], [5, 5], [0, MUTATION_DEFAULT_MAX_MUTANTS], [-2, MUTATION_DEFAULT_MAX_MUTANTS], [2.5, MUTATION_DEFAULT_MAX_MUTANTS], ['x', MUTATION_DEFAULT_MAX_MUTANTS]]) {
      writeWorkflowConfig(projectDir, { mutation_max_mutants: value });
      assert.equal(readMaxMutants(projectDir), expected, String(value));
    }
  });

  // Each run "takes" 100ms. Baseline + 2 mutants = 300ms.
  test('budget exactly spent before the next mutant (remaining 0) stops — budget_exhausted', () => {
    threeMutableFiles();
    const { deps } = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) });
    const outcome = run({ deps, budgetMs: 300 });
    assert.equal(outcome.attempted, 2);
    assert.equal(outcome.status, MUTATION_STATUS.BUDGET_EXHAUSTED);
  });

  test('budget one millisecond over lets the next mutant start', () => {
    threeMutableFiles();
    const { deps } = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) });
    const outcome = run({ deps, budgetMs: 301 });
    assert.equal(outcome.attempted, 3);
    assert.equal(outcome.status, MUTATION_STATUS.PASSED);
  });

  test('budget one millisecond under stops a mutant earlier', () => {
    threeMutableFiles();
    const { deps } = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) });
    assert.equal(run({ deps, budgetMs: 299 }).attempted, 2);
    const again = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) });
    assert.equal(run({ deps: again.deps, budgetMs: 200 }).attempted, 1);
  });

  test('each run is bounded by what is left of the budget, and by the per-run cap', () => {
    threeMutableFiles();
    const fake = fakeDeps({ decide: (n) => (n === 1 ? 0 : 1) });
    run({ deps: fake.deps, budgetMs: 1000, runTimeoutMs: 850 });
    assert.deepEqual(fake.calls.map((c) => c.timeoutMs), [850, 850, 800, 700]);
  });

  test('a survivor found before the budget ran out is still a survivor', () => {
    threeMutableFiles();
    const { deps } = fakeDeps({ decide: () => 0 });
    assert.equal(run({ deps, budgetMs: 200 }).status, MUTATION_STATUS.SURVIVORS);
  });
});

describe('check mn-mutation-spot-check — the gate reads the record', () => {
  let projectDir;
  let phaseDir;
  let phaseNumber;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-mutation-gate-');
    ({ phaseDir, phaseNumber } = makePhase(projectDir, { '03-01-PLAN.md': planDeclaring(['src.js']) }, 'ports'));
    fs.writeFileSync(path.join(projectDir, 'src.js'), SOURCE);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function record(fields) {
    const digest = digestCandidates(projectDir, mutationCandidates(projectDir, phaseDir));
    const outcome = { status: 'passed', candidates: 1, maxMutants: 3, attempted: 1, killed: [{}], survived: [], unrunnable: 0, budgetMs: 540000, ...fields };
    recordVerificationBlock(verificationPathFor(phaseDir), 'mutation', buildMutationRecord(outcome, '2026-10-04T00:00:00.000Z', digest));
  }

  const gate = () => evaluateMnMutationSpotCheck({ projectDir, args: [phaseNumber] }).payload;

  test('no VERIFICATION.md: the step never ran — unresolvable', () => {
    const v = gate();
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.recorded, false);
  });

  test('a VERIFICATION.md without a mutation: record is unresolvable', () => {
    fs.writeFileSync(verificationPathFor(phaseDir), '---\nphase: 03\ntruths_unproven: 0\n---\n');
    assert.equal(gate().recorded, false);
  });

  test('passed → pass; nothing_to_mutate → pass', () => {
    record({});
    assert.equal(gate().block, false);
    record({ status: 'nothing_to_mutate', attempted: 0, killed: [] });
    assert.equal(gate().block, false);
  });

  test('survivors → finding, naming them', () => {
    record({ status: 'survivors', attempted: 1, killed: [], survived: [{ file: 'src.js', line: 2, label: '>= → >' }] });
    const v = gate();
    assert.equal(v.status, 'finding');
    assert.deepEqual(v.survivors, ['src.js:2 (>= → >)']);
  });

  for (const status of ['no_command', 'unrunnable', 'red_baseline']) {
    test(`${status} → unresolvable: the step could not check`, () => {
      record({ status, attempted: 0, killed: [], reason: 'why' });
      assert.equal(gate().status, 'unresolvable');
    });
  }

  test('budget_exhausted: ≥1 killed and no survivor passes; nothing attempted is unresolvable', () => {
    record({ status: 'budget_exhausted', attempted: 1 });
    assert.equal(gate().block, false);
    record({ status: 'budget_exhausted', attempted: 0, killed: [] });
    assert.equal(gate().status, 'unresolvable');
  });

  test('a record taken on different code is stale — unresolvable, never a pass', () => {
    record({});
    fs.appendFileSync(path.join(projectDir, 'src.js'), '// edited after the run\n');
    const v = gate();
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.stale, true);
  });

  test('a status the gate does not know is unresolvable', () => {
    record({ status: 'mystery' });
    assert.equal(gate().status, 'unresolvable');
  });

  test('the capability runs the step before the gate at verify:pre, both on workflow.mutation_spot_check', () => {
    const step = CAPABILITY.steps.find((s) => s.ref.command === 'verify mutation');
    const gateDecl = CAPABILITY.gates.find((g) => g.when === 'workflow.mutation_spot_check');
    assert.deepEqual([step.point, step.when, step.onError], ['verify:pre', 'workflow.mutation_spot_check', 'skip']);
    assert.deepEqual([gateDecl.point, gateDecl.check], ['verify:pre', { query: 'mn-mutation-spot-check' }]);
  });
});

describe('verify mutation + check mn-mutation-spot-check through the CLI (real tiny project)', () => {
  let projectDir;
  let phaseDir;

  const REAL_TEST = "const assert = require('node:assert');\nconst { isAdult } = require('./src.js');\nassert.equal(isAdult(18), true);\nassert.equal(isAdult(17), false);\n";
  const HOLLOW_TEST = "const { isAdult } = require('./src.js');\nisAdult(18);\n";

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-mutation-cli-');
    ({ phaseDir } = makePhase(projectDir, { '03-01-PLAN.md': planDeclaring(['src.js']) }, 'ports'));
    fs.writeFileSync(path.join(projectDir, 'src.js'), SOURCE);
    writeWorkflowConfig(projectDir, { mutation_test_command: 'node check.js' });
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function step() {
    const r = runGsdTools(['verify', 'mutation', '--phase', '1', '--raw'], projectDir);
    assert.equal(r.success, true, r.error);
    return JSON.parse(r.output);
  }

  test('a pinning test: recorded passed, gate passes, source untouched', () => {
    fs.writeFileSync(path.join(projectDir, 'check.js'), REAL_TEST);
    const out = step();
    assert.equal(out.mutation.status, 'passed');
    const fm = extractFrontmatter(fs.readFileSync(path.join(phaseDir, '01-VERIFICATION.md'), 'utf8'));
    assert.equal(fm.mutation.status, 'passed');
    assert.equal(fs.readFileSync(path.join(projectDir, 'src.js'), 'utf8'), SOURCE);
    assert.equal(runMnCheck(projectDir, 'mn-mutation-spot-check', [phaseDir]).block, false);
  });

  test('a hollow test: recorded survivors, gate blocks', () => {
    fs.writeFileSync(path.join(projectDir, 'check.js'), HOLLOW_TEST);
    assert.equal(step().mutation.status, 'survivors');
    const payload = runMnCheck(projectDir, 'mn-mutation-spot-check', ['1']);
    assert.equal(payload.block, true);
    assert.equal(payload.status, 'finding');
  });

  test('the record is written beside what the verifier wrote, without disturbing it', () => {
    fs.writeFileSync(path.join(projectDir, 'check.js'), REAL_TEST);
    fs.writeFileSync(path.join(phaseDir, '01-VERIFICATION.md'), '---\nphase: 01\ntruths_unproven: 0\n---\n\n# Report\n');
    step();
    const fm = extractFrontmatter(fs.readFileSync(path.join(phaseDir, '01-VERIFICATION.md'), 'utf8'));
    assert.equal(fm.truths_unproven, '0');
    assert.equal(fm.mutation.status, 'passed');
  });

  test('a phase that does not exist records nothing and exits non-zero', () => {
    const r = runGsdTools(['verify', 'mutation', '--phase', '42', '--raw'], projectDir);
    assert.notEqual(r.exitCode, 0);
  });
});
