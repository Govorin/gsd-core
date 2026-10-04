'use strict';

/**
 * `gsd_run check mn-wave-solve` — the wave assignment computed instead of trusted
 * (src/gate-mn-waves.cts; replaces capabilities/mn-verify-gate/scripts/wave-solve.mjs).
 *
 * The one parallelism rule: a plan's wave must be strictly later than every plan it depends on,
 * and two plans in the same wave may not share a file. The gate composes upstream functions —
 * `computeDependencyLevels` (src/phase.cts) for the depends_on levels and cycles, then
 * `partitionByFileOverlap` inside a level — and judges the DECLARED waves against the invariant.
 *
 * Three things the script got wrong on first contact with real data, each producing confident
 * nonsense rather than an error, stay pinned:
 *   - numbering starts at 0 in some phases and 1 in others;
 *   - declaring a LATER wave than necessary is safe (conservative, never blocking);
 *   - declaring an EARLIER wave is the violation.
 * And two the composition fixes over the script (see "beyond the script" below): a valid
 * assignment that merely differs from one greedy answer is not flagged, and a dependency of a
 * plan pushed back by a file clash is still scheduled after it.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, writeFiles, writeWorkflowConfig, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnWaveSolve, analyzeWaveSolve } = require('../gsd-core/bin/lib/gate-mn-waves.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** A plan in the shape the real planner emits. */
function plan({ wave, deps = [], files = [] }) {
  const depLine = `depends_on: [${deps.map((d) => `"${d}"`).join(', ')}]`;
  const fileLines = files.map((f) => `  - "${f}"`).join('\n');
  const waveLine = wave === undefined ? '' : `wave: ${wave}\n`;
  return `---\n${waveLine}${depLine}\nfiles_modified:\n${fileLines}\n---\n\n# plan\n`;
}

describe('check mn-wave-solve', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-wave-solve-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function gateOn(files, extra = []) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnWaveSolve({ projectDir, args: [phaseNumber, ...extra] }).payload;
  }

  const kinds = (v) => v.violations.map((x) => [x.plan, x.kind]);
  const assignment = (v) => v.plans.map((p) => [p.id, p.declared, p.computed]);

  // ── the violation ─────────────────────────────────────────────────────────

  test('flags a plan sharing a wave with one that touches the same file, and states the fix', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/main.ts', 'src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, files: ['src/main.ts', 'src/b.ts'] }),
    });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(kinds(v), [['01-02-PLAN.md', 'shares-file-in-wave']]);
    assert.deepEqual(v.violations[0].shared, ['src/main.ts']);
    assert.equal(v.plans.find((p) => p.id === '01-02').computed, 2, 'the fix must be stated, not just the fault');
  });

  test('flags a plan scheduled before its own dependency', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 2, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, deps: ['01-01'], files: ['src/b.ts'] }),
    });
    assert.equal(v.block, true);
    assert.deepEqual(v.violations, [
      { plan: '01-02-PLAN.md', kind: 'before-dependency', wave: 1, declared: 1, dependency: '01-01-PLAN.md', dependencyWave: 2 },
    ]);
  });

  test('a plan in the SAME wave as its dependency is a violation — strictly later is required', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, deps: ['01-01'], files: ['src/b.ts'] }),
    });
    assert.deepEqual(kinds(v), [['01-02-PLAN.md', 'before-dependency']]);
  });

  test('a bare plan-number dependency resolves like phase-plan-index resolves it', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, deps: ['01'], files: ['src/b.ts'] }),
    });
    assert.deepEqual(kinds(v), [['01-02-PLAN.md', 'before-dependency']]);
  });

  // ── what must NOT be a violation ──────────────────────────────────────────

  test('accepts a plan scheduled LATER than necessary, and reports it as conservative', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 5, files: ['src/b.ts'] }),
    });
    assert.equal(v.block, false);
    assert.deepEqual(v.conservative.map((c) => [c.plan, c.declared, c.computed]), [['01-02-PLAN.md', 5, 1]]);
  });

  test('takes the wave base from the phase, not from a constant', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 0, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, deps: ['01-01'], files: ['src/b.ts'] }),
    });
    assert.equal(v.block, false);
    assert.equal(v.base, 0);
    assert.deepEqual(assignment(v), [['01-01', 0, 0], ['01-02', 1, 1]]);
  });

  test('accepts a correct multi-wave chain', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 2, deps: ['01-01'], files: ['src/b.ts'] }),
      '01-03-PLAN.md': plan({ wave: 3, deps: ['01-02'], files: ['src/c.ts'] }),
    });
    assert.equal(v.block, false);
    assert.equal(v.matched, 3);
  });

  test('does not treat a glob as a file collision in literal mode', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['libs/shared/**'] }),
      '01-02-PLAN.md': plan({ wave: 1, files: ['libs/shared/**'] }),
    });
    assert.equal(v.block, false);
    assert.equal(v.mode, 'literal');
  });

  test('with workflow.wave_normalize on, it compares the resolved file sets', () => {
    writeWorkflowConfig(projectDir, { wave_normalize: true });
    writeFiles(projectDir, { 'libs/shared/a.ts': 'x\n' });
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['libs/shared/**'] }),
      '01-02-PLAN.md': plan({ wave: 1, files: ['libs/shared/a.ts'] }),
    });
    assert.equal(v.mode, 'expand');
    assert.deepEqual(kinds(v), [['01-02-PLAN.md', 'shares-file-in-wave']]);
  });

  test('a plan declaring no wave runs at its depends_on level, and is judged there', () => {
    // phase-plan-index schedules an undeclared plan at its DAG level; at level 0 that is wave 1,
    // the same wave 01-02 declares — over the same file.
    const v = gateOn({ '01-01-PLAN.md': plan({ files: ['src/a.ts'] }), '01-02-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }) });
    assert.equal(v.undeclared, 1);
    assert.deepEqual(v.violations.map((x) => [x.plan, x.kind, x.wave, x.declared]), [['01-02-PLAN.md', 'shares-file-in-wave', 1, 1]]);
  });

  test('an undeclared plan clear of every other plan passes', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ files: ['src/a.ts'] }), '01-02-PLAN.md': plan({ wave: 1, files: ['src/b.ts'] }) });
    assert.equal(v.block, false);
    assert.equal(v.undeclared, 1);
  });

  test('a dependency outside the phase is reported, not blocking', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ wave: 1, deps: ['07-03'], files: ['src/a.ts'] }) });
    assert.equal(v.block, false);
    assert.deepEqual(v.unresolvedDependencies, [{ plan: '01-01-PLAN.md', token: '07-03' }]);
  });

  test('passes a phase with a single plan', () => {
    assert.equal(gateOn({ '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }) }).block, false);
  });

  test('passes a phase with no plans', () => {
    const v = gateOn({});
    assert.equal(v.block, false);
    assert.equal(v.counts.plans, 0);
  });

  // ── beyond the script: the invariant, not one greedy answer ───────────────

  test('a valid assignment that differs from the greedy order is not flagged', () => {
    // The script computed 01-01 → 1, 01-02 → 2 (lexicographic first-fit) and flagged 01-02
    // declared 1 < 2, although the declared split (01-02 first, 01-01 second) is equally valid.
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 2, files: ['src/main.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, files: ['src/main.ts'] }),
    });
    assert.equal(v.block, false);
  });

  test('a plan depending on one pushed back by a file clash is computed after it', () => {
    // The script derived dependents' waves BEFORE the file-clash shift, so 01-03 (depends on 01-02)
    // was computed into the very wave 01-02 had been pushed into.
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/main.ts'] }),
      '01-02-PLAN.md': plan({ wave: 2, files: ['src/main.ts'] }),
      '01-03-PLAN.md': plan({ wave: 3, deps: ['01-02'], files: ['src/c.ts'] }),
    });
    assert.equal(v.block, false);
    const computed = Object.fromEntries(v.plans.map((p) => [p.id, p.computed]));
    assert.ok(computed['01-03'] > computed['01-02'], JSON.stringify(computed));
  });

  // ── determinism ───────────────────────────────────────────────────────────

  test('produces the same assignment on repeated runs, independent of file creation order', () => {
    const { phaseDir } = makePhase(projectDir, {
      '01-03-PLAN.md': plan({ wave: 1, files: ['src/c.ts'] }),
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, files: ['src/b.ts'] }),
    });
    assert.deepEqual(analyzeWaveSolve(projectDir, phaseDir, 'literal'), analyzeWaveSolve(projectDir, phaseDir, 'literal'));
  });

  test('emits the computed assignment for every plan', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 2, deps: ['01-01'], files: ['src/b.ts'] }),
    });
    assert.deepEqual(assignment(v), [['01-01', 1, 1], ['01-02', 2, 2]]);
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('a dependency cycle is unresolvable rather than an invented order', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ wave: 1, deps: ['01-02'], files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 2, deps: ['01-01'], files: ['src/b.ts'] }),
    });
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
    assert.deepEqual(v.cycle, ['01-01-PLAN.md', '01-02-PLAN.md']);
  });

  test('a phase that does not exist is unresolvable', () => {
    assert.equal(evaluateMnWaveSolve({ projectDir, args: ['88'] }).payload.status, 'unresolvable');
  });

  test('no phase argument is a usage failure', () => {
    assert.ok(evaluateMnWaveSolve({ projectDir, args: [] }).failure);
  });

  // ── wiring ────────────────────────────────────────────────────────────────

  test('the capability registers the solver at plan:post through check mn-wave-solve', () => {
    const gate = CAPABILITY.gates.find((g) => g.when === 'workflow.wave_solve');
    assert.ok(gate, 'a gate keyed on workflow.wave_solve must be declared');
    assert.equal(gate.point, 'plan:post');
    assert.equal(gate.blocking, true);
    assert.deepEqual(gate.check, { query: 'mn-wave-solve' });
    assert.equal(CAPABILITY.config['workflow.wave_solve'].default, false);
  });

  test('gsd_run check mn-wave-solve --phase N prints the verdict', () => {
    const { phaseNumber } = makePhase(projectDir, {
      '01-01-PLAN.md': plan({ wave: 2, files: ['src/a.ts'] }),
      '01-02-PLAN.md': plan({ wave: 1, deps: ['01-01'], files: ['src/b.ts'] }),
    });
    const payload = runMnCheck(projectDir, 'mn-wave-solve', ['--phase', phaseNumber]);
    assert.equal(payload.block, true);
    assert.equal(payload.violations[0].kind, 'before-dependency');
  });
});
