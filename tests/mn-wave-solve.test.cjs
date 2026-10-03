'use strict';

/**
 * wave-solve.mjs — computes the wave assignment instead of trusting an LLM to.
 *
 * The one parallelism rule: a plan's wave must be strictly later than every
 * plan it depends on, and two plans in the same wave may not share a file. It
 * lives as pseudocode inside the planner prompt, an LLM executes it, and until
 * wave-collision shipped nothing checked the result — 38 phases of 283 violate
 * it. The detector catches a violation after the fact; this answers the other
 * question, what the assignment should have been.
 *
 * The tests weight three things the solver got wrong on first contact with real
 * data, because each produced confident nonsense rather than an error:
 *
 *   - Wave numbering starts at 0 in some phases and 1 in others. A solver
 *     hardcoding 1 reports every plan of a zero-based phase as diverged, and a
 *     real violation drowns in that noise.
 *   - Declaring a LATER wave than necessary is safe — sequential where parallel
 *     would do, slower but never wrong. Blocking it fails phases for
 *     conservative planning.
 *   - Declaring an EARLIER wave is the violation: the plan runs before its
 *     dependency exists, or races another plan over the same file.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'wave-solve.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

const AGREES = 0;
const VIOLATION = 1;
const CANNOT_LOOK = 2;

describe('wave-solve', () => {
  let phaseDir;

  beforeEach(() => {
    phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wave-solve-'));
  });

  afterEach(() => {
    cleanup(phaseDir);
  });

  /** A plan in the shape the real planner emits. */
  function writePlan(name, { wave, deps = [], files = [] }) {
    const depLine = `depends_on: [${deps.map((d) => `"${d}"`).join(', ')}]`;
    const fileLines = files.map((f) => `  - "${f}"`).join('\n');
    fs.writeFileSync(
      path.join(phaseDir, name),
      `---\nwave: ${wave}\n${depLine}\nfiles_modified:\n${fileLines}\n---\n\n# ${name}\n`,
    );
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
  }

  // ── the violation ─────────────────────────────────────────────────────────

  test('flags a plan sharing a wave with one that touches the same file', () => {
    // The measured shape: two plans, same wave, both declaring main.ts.
    writePlan('01-01-PLAN.md', { wave: 1, files: ['src/main.ts', 'src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 1, files: ['src/main.ts', 'src/b.ts'] });

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, VIOLATION, `a file collision must be reported: ${r.stdout}`);
    assert.match(r.stderr, /01-02-PLAN\.md/);
    assert.match(r.stderr, /computed: wave 2/, 'the fix must be stated, not just the fault');
  });

  test('flags a plan scheduled before its own dependency', () => {
    writePlan('01-01-PLAN.md', { wave: 2, files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 1, deps: ['01-01'], files: ['src/b.ts'] });

    const r = run();
    assert.equal(r.exitCode, VIOLATION, `running before a dependency must block: ${r.stdout}`);
    assert.match(r.stderr, /01-02-PLAN\.md/);
    // The consequence has to be named or the reader cannot judge severity.
    assert.match(r.stderr, /does not exist yet|races/);
  });

  // ── what must NOT be a violation ──────────────────────────────────────────

  test('accepts a plan scheduled LATER than necessary', () => {
    // Sequential where parallel would do: slower, never wrong. Most real
    // divergence is this, and blocking it fails phases for caution.
    writePlan('01-01-PLAN.md', { wave: 1, files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 5, files: ['src/b.ts'] });

    const r = run(['--verbose']);
    assert.equal(r.exitCode, AGREES, `a conservative wave must not block: ${r.stderr}`);
    assert.match(r.stdout, /scheduled later than necessary/);
    assert.match(r.stdout, /01-02-PLAN\.md/, 'it is still reported, not silently dropped');
  });

  test('takes the wave base from the phase, not from a constant', () => {
    // Both conventions exist in live data. A solver starting at 1 reports every
    // plan of a zero-based phase as diverged, and the real violation drowns.
    writePlan('01-01-PLAN.md', { wave: 0, files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 1, deps: ['01-01'], files: ['src/b.ts'] });

    const r = run();
    assert.equal(r.exitCode, AGREES, `zero-based numbering must be honoured: ${r.stderr}`);
  });

  test('accepts a correct multi-wave chain', () => {
    writePlan('01-01-PLAN.md', { wave: 1, files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 2, deps: ['01-01'], files: ['src/b.ts'] });
    writePlan('01-03-PLAN.md', { wave: 3, deps: ['01-02'], files: ['src/c.ts'] });

    const r = run();
    assert.equal(r.exitCode, AGREES, `a correct chain must pass: ${r.stderr}`);
    assert.match(r.stdout, /3 plan\(s\) match/);
  });

  test('does not treat a glob as a file collision', () => {
    // Expanding one needs a tree walk and fires on paths the plan is about to
    // create. These are skipped and reported, never guessed at.
    writePlan('01-01-PLAN.md', { wave: 1, files: ['libs/shared/**'] });
    writePlan('01-02-PLAN.md', { wave: 1, files: ['libs/shared/**'] });

    const r = run(['--verbose']);
    assert.equal(r.exitCode, AGREES, `globs must not compare literally: ${r.stderr}`);
    assert.match(r.stdout, /non-file entr/, 'skipped entries must be reported');
  });

  test('passes a phase with a single plan', () => {
    writePlan('01-01-PLAN.md', { wave: 1, files: ['src/a.ts'] });

    const r = run();
    assert.equal(r.exitCode, AGREES);
  });

  test('passes a phase with no plans', () => {
    const r = run(['--verbose']);
    assert.equal(r.exitCode, AGREES);
    assert.match(r.stdout, /nothing to solve/);
  });

  // ── determinism ───────────────────────────────────────────────────────────

  test('produces the same assignment on repeated runs', () => {
    // A solver depending on directory read order is unreproducible, and an
    // unreproducible answer cannot be compared against an existing assignment.
    writePlan('01-03-PLAN.md', { wave: 1, files: ['src/c.ts'] });
    writePlan('01-01-PLAN.md', { wave: 1, files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 1, files: ['src/b.ts'] });

    const first = run(['--json']);
    const second = run(['--json']);
    assert.equal(first.stdout, second.stdout, 'the same input must give the same output');
  });

  test('--json emits the computed assignment for every plan', () => {
    writePlan('01-01-PLAN.md', { wave: 1, files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 2, deps: ['01-01'], files: ['src/b.ts'] });

    const r = run(['--json']);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.plans.length, 2);
    assert.deepEqual(
      parsed.plans.map((p) => [p.id, p.declared, p.computed]),
      [['01-01', 1, 1], ['01-02', 2, 2]],
    );
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('exits 2 on a dependency cycle rather than inventing an order', () => {
    // A cyclic graph has no wave assignment. Producing one would be worse than
    // producing none, because it looks like an answer.
    writePlan('01-01-PLAN.md', { wave: 1, deps: ['01-02'], files: ['src/a.ts'] });
    writePlan('01-02-PLAN.md', { wave: 2, deps: ['01-01'], files: ['src/b.ts'] });

    const r = run();
    assert.equal(r.exitCode, CANNOT_LOOK, `a cycle is unsolvable, not a violation: ${r.stdout}`);
    assert.match(r.stderr, /cycle/i);
  });

  test('exits 2 when the phase directory does not exist', () => {
    const r = runNode([SCRIPT, '--dir', path.join(phaseDir, 'nope')], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK);
  });

  test('exits 2 when --dir is omitted', () => {
    const r = runNode([SCRIPT], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK);
  });

  test('the capability registers the solver at plan:post', () => {
    // allow-test-rule: source-text-is-the-product
    // The manifest IS the deployed contract — the runtime reads this JSON.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'capability.json'),
        'utf8',
      ),
    );

    const gate = (manifest.gates || []).find((g) => g.when === 'workflow.wave_solve');
    assert.ok(gate, 'a gate keyed on workflow.wave_solve must be declared');
    // plan:post, beside the detector: at planning time the fix is renumbering a
    // wave; by execute the colliding worktrees are already running.
    assert.equal(gate.point, 'plan:post');
    assert.equal(gate.blocking, true);
    assert.match(gate.check.predicate.command, /wave-solve\.mjs/);
    assert.equal(manifest.config['workflow.wave_solve'].default, false);
  });
});
