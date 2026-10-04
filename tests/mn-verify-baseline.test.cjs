'use strict';

/**
 * The execute:pre baseline — `gsd_run verify baseline` measures the project's own checks before
 * the first wave into {N}-BASELINE.md, and `gsd_run check mn-baseline` blocks the run on a red
 * base (mn-verify-gate, `workflow.verify_gates_baseline`).
 *
 * Seams: src/verify-baseline.cts and src/gate-mn-baseline.cts through the real `gsd-tools.cjs`
 * (process seam), and — for the record's digest — real git in a temp repository: the digest is a
 * tree id of the working tree, and a fake git would only test the fake.
 *
 * The defect: a phase that starts on a red tree finishes on one, and nothing tells the failures it
 * inherited from the failures it introduced. The round trip at the bottom is the one that
 * matters: render the execute:pre hooks, run the step as the dispatcher does, run the gate as the
 * gate file says, and watch a red base stop the run and a repaired one let it through.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { exitCodeFor } = require('../gsd-core/bin/lib/exit-code-registry.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const GATE_FILE = path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'execute-pre-gate-hooks.md');
const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

function writeConfig(dir, workflow) {
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow }, null, 2));
}

function makePhase(dir) {
  const phaseDir = path.join(dir, '.planning', 'phases', '03-ports');
  fs.mkdirSync(phaseDir, { recursive: true });
  return phaseDir;
}

function json(result) {
  assert.equal(result.outcome, OUTCOME.EXITED, result.stderr);
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`not JSON (exit ${result.exitCode}): ${result.stdout}${result.stderr}`);
  }
}

function baseline(dir, args = []) {
  const result = runNode([TOOLS, 'verify', 'baseline', '--phase', '3', ...args, '--raw', '--cwd', dir], { cwd: dir });
  return { exitCode: result.exitCode, payload: json(result) };
}

function gate(dir, phaseArg = '3') {
  const result = runNode([TOOLS, 'check', 'mn-baseline', phaseArg, '--raw', '--cwd', dir], { cwd: dir });
  assert.equal(result.exitCode, 0, `a verdict is never an exit code: ${result.stdout}${result.stderr}`);
  return json(result);
}

function readRecord(phaseDir) {
  return extractFrontmatter(fs.readFileSync(path.join(phaseDir, '03-BASELINE.md'), 'utf8')).baseline;
}

describe('verify baseline — the declaration', () => {
  test('a step and a blocking gate at execute:pre, both behind one opt-in key', () => {
    const steps = CAPABILITY.steps.filter((s) => s.point === 'execute:pre');
    const gates = CAPABILITY.gates.filter((g) => g.point === 'execute:pre');
    assert.deepEqual(steps.map((s) => [s.ref.command, s.when]), [['verify baseline', 'workflow.verify_gates_baseline']]);
    assert.deepEqual(
      gates.map((g) => [g.check.query, g.when, g.blocking, g.onError]),
      [['mn-baseline', 'workflow.verify_gates_baseline', true, 'halt']]
    );
  });

  test('the key is off by default: blocking behaviour is never switched on behind a project\'s back', () => {
    const key = CAPABILITY.config['workflow.verify_gates_baseline'];
    assert.deepEqual([key.type, key.default], ['boolean', false]);
  });

  test('nothing renders at execute:pre until the key is on', () => {
    const dir = createTempGitProject('gsd-baseline-render-');
    makePhase(dir);
    writeConfig(dir, { verify_gates: { tests: 'true' } });
    const off = json(runNode([TOOLS, 'loop', 'render-hooks', 'execute:pre', '--raw', '--cwd', dir], { cwd: dir }));
    assert.deepEqual((off.activeHooks || []).filter((h) => h.capId === 'mn-verify-gate'), []);
    writeConfig(dir, { verify_gates: { tests: 'true' }, verify_gates_baseline: true });
    const on = json(runNode([TOOLS, 'loop', 'render-hooks', 'execute:pre', '--raw', '--cwd', dir], { cwd: dir }));
    assert.deepEqual(
      on.activeHooks.filter((h) => h.capId === 'mn-verify-gate').map((h) => h.kind),
      ['step', 'gate'],
      'the step is listed before the gate that reads its record'
    );
    cleanup(dir);
  });
});

describe('verify baseline — recording', () => {
  let dir;
  let phaseDir;
  beforeEach(() => {
    dir = createTempGitProject('gsd-baseline-');
    phaseDir = makePhase(dir);
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('records into {N}-BASELINE.md, never into VERIFICATION.md', () => {
    writeConfig(dir, { verify_gates: { tests: 'echo "# pass 7" && echo "# fail 0"' } });
    const { exitCode, payload } = baseline(dir);
    assert.equal(exitCode, 0);
    assert.equal(payload.baselinePath, path.join(phaseDir, '03-BASELINE.md'));
    assert.equal(fs.existsSync(path.join(phaseDir, '03-VERIFICATION.md')), false, 'the baseline is not the phase result');
    const record = readRecord(phaseDir);
    assert.equal(record.all_passed, 'true');
    assert.equal(record.tests_status, 'pass');
    assert.equal(record.tests_passed_count, '7');
    assert.match(record.digest, /^sha256:[0-9a-f]{64}$/);
  });

  test('a red base still records and still exits 0 — the gate judges, the recorder records', () => {
    writeConfig(dir, { verify_gates: { tests: 'exit 1', lint: 'gsd-no-such-command-4-1' } });
    const { exitCode, payload } = baseline(dir);
    assert.equal(exitCode, 0);
    assert.deepEqual([payload.allPassed, payload.failed, payload.stale], [false, 1, 1]);
    assert.deepEqual(payload.warnings.map((w) => w.setting), ['workflow.verify_gates.lint']);
  });

  test('refuses with nothing configured, and writes nothing', () => {
    writeConfig(dir, {});
    const { exitCode, payload } = baseline(dir);
    assert.equal(exitCode, 2);
    assert.equal(payload.reason, 'no_checks_configured');
    assert.equal(fs.existsSync(path.join(phaseDir, '03-BASELINE.md')), false);
  });

  test('a malformed roster fails as UNAVAILABLE', () => {
    writeConfig(dir, { verify_gates: { tests: '' } });
    const { exitCode, payload } = baseline(dir);
    assert.equal(exitCode, exitCodeFor('UNAVAILABLE'));
    assert.equal(payload.reason, 'invalid_checks_config');
  });

  test('takes a phase directory positionally, and refuses two answers to "which phase"', () => {
    writeConfig(dir, { verify_gates: { tests: 'true' } });
    const byDir = json(runNode([TOOLS, 'verify', 'baseline', phaseDir, '--raw', '--cwd', dir], { cwd: dir }));
    assert.equal(byDir.ok, true);
    const both = runNode([TOOLS, 'verify', 'baseline', phaseDir, '--phase', '3', '--raw', '--cwd', dir], { cwd: dir });
    assert.equal(both.exitCode, 2);
    assert.equal(json(both).reason, 'conflicting_phase_args');
  });

  test('--accept needs a reason: an acceptance nobody can review later is a bypass', () => {
    writeConfig(dir, { verify_gates: { tests: 'exit 1' } });
    for (const args of [['--accept'], ['--accept='], ['--accept', '   ']]) {
      const { exitCode, payload } = baseline(dir, args);
      assert.equal(exitCode, 2, JSON.stringify(args));
      assert.ok(['bad_arguments', 'accept_needs_reason'].includes(payload.reason), JSON.stringify(args));
    }
    assert.equal(fs.existsSync(path.join(phaseDir, '03-BASELINE.md')), false);
  });

  test('--accept records exactly the checks that are not green, with the reason', () => {
    writeConfig(dir, { verify_gates: { tests: 'exit 1', lint: 'gsd-no-such-command-4-1', types: 'true' } });
    const reason = 'tests red on main since #12: tracked; lint: tool retired';
    baseline(dir, ['--accept', reason]);
    const record = readRecord(phaseDir);
    assert.deepEqual(record.accepted, ['tests', 'lint']);
    assert.equal(record.accepted_reason, reason, 'a reason with a colon and a # survives the YAML round trip');
  });

  test('a plain re-record keeps the acceptance — the next execute-phase run must not undo it', () => {
    writeConfig(dir, { verify_gates: { tests: 'exit 1' } });
    baseline(dir, ['--accept', 'known red']);
    baseline(dir);
    const record = readRecord(phaseDir);
    assert.deepEqual(record.accepted, ['tests']);
    assert.equal(record.accepted_reason, 'known red');
  });

  test('--accept on a green base records no acceptance', () => {
    writeConfig(dir, { verify_gates: { tests: 'true' } });
    baseline(dir, ['--accept', 'nothing to accept']);
    assert.equal(Object.prototype.hasOwnProperty.call(readRecord(phaseDir), 'accepted'), false);
  });
});

describe('check mn-baseline — the verdicts', () => {
  let dir;
  beforeEach(() => {
    dir = createTempGitProject('gsd-baseline-gate-');
    makePhase(dir);
  });
  afterEach(() => {
    cleanup(dir);
  });

  const measure = (roster, args) => {
    writeConfig(dir, { verify_gates: roster, verify_gates_baseline: true });
    baseline(dir, args);
  };

  test('a green base passes', () => {
    measure({ tests: 'true', lint: 'true' });
    assert.deepEqual([gate(dir).block, gate(dir).status], [false, 'pass']);
  });

  test('a red base is a finding that names the red check', () => {
    measure({ tests: 'exit 1', lint: 'true' });
    const payload = gate(dir);
    assert.deepEqual([payload.block, payload.status, payload.red, payload.unmeasured], [true, 'finding', ['tests'], []]);
  });

  test('a stale check is "could not check", not a red base', () => {
    measure({ tests: 'true', lint: 'gsd-no-such-command-4-1' });
    const payload = gate(dir);
    assert.deepEqual([payload.block, payload.status, payload.red, payload.unmeasured], [true, 'unresolvable', [], ['lint']]);
  });

  test('red and stale together: the finding wins and both are named', () => {
    measure({ tests: 'exit 1', lint: 'gsd-no-such-command-4-1' });
    const payload = gate(dir);
    assert.deepEqual([payload.status, payload.red, payload.unmeasured], ['finding', ['tests'], ['lint']]);
  });

  test('an accepted red base passes, on record', () => {
    measure({ tests: 'exit 1', lint: 'gsd-no-such-command-4-1' }, ['--accept', 'known']);
    const payload = gate(dir);
    assert.deepEqual([payload.block, payload.status, payload.accepted], [false, 'pass', ['tests', 'lint']]);
  });

  test('a check that goes red after the acceptance is not covered by it', () => {
    measure({ tests: 'exit 1', lint: 'true' }, ['--accept', 'tests known red']);
    measure({ tests: 'exit 1', lint: 'exit 2' });
    const payload = gate(dir);
    assert.deepEqual([payload.status, payload.red], ['finding', ['lint']]);
  });

  test('no record is unresolvable — the step did not measure this tree', () => {
    writeConfig(dir, { verify_gates: { tests: 'true' }, verify_gates_baseline: true });
    const payload = gate(dir);
    assert.deepEqual([payload.block, payload.status, payload.recorded], [true, 'unresolvable', false]);
  });

  test('nothing configured is unresolvable, not a pass', () => {
    writeConfig(dir, { verify_gates_baseline: true });
    const payload = gate(dir);
    assert.deepEqual([payload.block, payload.status], [true, 'unresolvable']);
  });

  test('an unknown phase is unresolvable', () => {
    writeConfig(dir, { verify_gates: { tests: 'true' } });
    const payload = gate(dir, '9');
    assert.deepEqual([payload.block, payload.status, payload.phaseResolved], [true, 'unresolvable', false]);
  });
});

/**
 * The digest: a record only describes the code and roster it was measured on. Without it, a step
 * that failed before writing would let the gate read an older record of different code.
 */
describe('check mn-baseline — a record of other code is never read as this one', () => {
  let dir;
  beforeEach(() => {
    dir = createTempGitProject('gsd-baseline-digest-');
    makePhase(dir);
    writeConfig(dir, { verify_gates: { tests: 'true' }, verify_gates_baseline: true });
    baseline(dir);
    assert.equal(gate(dir).status, 'pass', 'precondition: a fresh green record passes');
  });
  afterEach(() => {
    cleanup(dir);
  });

  const isStale = (payload) => payload.status === 'unresolvable' && payload.stale === true;

  test('an edit to a tracked file makes the record stale', () => {
    fs.appendFileSync(path.join(dir, 'PROJECT.md'), '\nedited\n');
    assert.ok(isStale(gate(dir)));
  });

  test('a new untracked file makes the record stale', () => {
    fs.writeFileSync(path.join(dir, 'new-module.js'), 'module.exports = 1;\n');
    assert.ok(isStale(gate(dir)));
  });

  test('a git-ignored file does not', () => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'build/\n');
    baseline(dir);
    fs.mkdirSync(path.join(dir, 'build'));
    fs.writeFileSync(path.join(dir, 'build', 'out.js'), 'x');
    assert.equal(gate(dir).status, 'pass');
  });

  test('a change under .planning/ does not — every workflow step writes there', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '# state\nmoved on\n');
    fs.writeFileSync(path.join(dir, '.planning', 'phases', '03-ports', '03-01-PLAN.md'), '# plan\n');
    assert.equal(gate(dir).status, 'pass');
  });

  test('a change to the roster makes the record stale', () => {
    writeConfig(dir, { verify_gates: { tests: 'true', lint: 'true' }, verify_gates_baseline: true });
    assert.ok(isStale(gate(dir)));
  });

  test('re-recording after the change is fresh again', () => {
    fs.appendFileSync(path.join(dir, 'PROJECT.md'), '\nedited\n');
    baseline(dir);
    assert.equal(gate(dir).status, 'pass');
  });

  test('the user\'s staging area is left as it was', () => {
    fs.writeFileSync(path.join(dir, 'staged.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'unstaged.txt'), 'b');
    assert.equal(runGit(['add', 'staged.txt'], { cwd: dir }).exitCode, 0);
    const status = () => runGit(['status', '--porcelain'], { cwd: dir }).stdout;
    const before = status();
    baseline(dir);
    gate(dir);
    assert.equal(status(), before);
  });
});

describe('check mn-baseline — outside a git repository', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir('gsd-baseline-nogit-');
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    makePhase(dir);
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('still records and judges; only the roster can be compared', () => {
    writeConfig(dir, { verify_gates: { tests: 'exit 1' }, verify_gates_baseline: true });
    assert.equal(baseline(dir).exitCode, 0);
    assert.equal(gate(dir).status, 'finding');
    writeConfig(dir, { verify_gates: { tests: 'true' }, verify_gates_baseline: true });
    assert.equal(gate(dir).stale, true, 'the roster changed, so the record no longer describes it');
  });
});

/**
 * The round trip execute-phase makes: render the execute:pre hooks, run the step the way
 * loop-hook-dispatch.md § step runs a command step, run the gate the way
 * execute-pre-gate-hooks.md runs a query gate.
 */
describe('verify baseline — the round trip execute-phase makes', () => {
  let dir;
  beforeEach(() => {
    dir = createTempGitProject('gsd-baseline-roundtrip-');
    makePhase(dir);
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('the gate file runs a query gate with the phase number', () => {
    // The shipped instruction is the contract the runtime follows (source-text-is-the-product).
    const text = fs.readFileSync(GATE_FILE, 'utf8');
    // Quoted: an unquoted ${hook.check.query} word-splits (SC2086, lint-workflow-shellcheck).
    assert.ok(text.includes('gsd_run check "${hook_check_query}" "${PHASE_NUMBER}" --raw'), 'the emulation below follows this line');
  });

  test('execute-phase dispatches the gate file as an entry point, so it inherits the response language', () => {
    // A bare path mention does not count as a dispatch (lint-response-language-coverage);
    // the stub has to read and execute it, the way the sibling wave:post gate file is reached.
    const host = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'execute-phase.md'), 'utf8');
    assert.ok(host.includes('read and execute `gsd-core/workflows/execute-phase/steps/execute-pre-gate-hooks.md`'));
  });

  function dispatch() {
    const rendered = json(runNode([TOOLS, 'loop', 'render-hooks', 'execute:pre', '--raw', '--cwd', dir], { cwd: dir }));
    const hooks = rendered.activeHooks.filter((h) => h.capId === 'mn-verify-gate');
    const step = hooks.find((h) => h.kind === 'step');
    const gateHook = hooks.find((h) => h.kind === 'gate');
    runNode([TOOLS, ...step.ref.command.split(' '), '--phase', '3', '--raw', '--cwd', dir], { cwd: dir });
    const verdict = json(runNode([TOOLS, 'check', gateHook.check.query, '3', '--raw', '--cwd', dir], { cwd: dir }));
    return { verdict, blocking: gateHook.blocking };
  }

  test('a red base stops the run before the first wave; a repaired one lets it through', () => {
    writeConfig(dir, { verify_gates: { tests: 'exit 1' }, verify_gates_baseline: true });
    const red = dispatch();
    assert.equal(red.blocking && red.verdict.block, true, 'a blocking gate that blocks halts execute-phase');

    writeConfig(dir, { verify_gates: { tests: 'true' }, verify_gates_baseline: true });
    const green = dispatch();
    assert.equal(green.verdict.block, false);
  });
});
