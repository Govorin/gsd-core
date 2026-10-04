'use strict';

/**
 * `gsd_run check mn-wave-collision`, literal mode — two same-wave plans declaring the same file
 * (src/gate-mn-waves.cts; replaces capabilities/mn-verify-gate/scripts/wave-collision.mjs).
 *
 * Same-wave plans execute concurrently in separate worktrees and commit in sequence, so a shared
 * file means the second commit either overwrites the first or lands in a merge conflict. Measured
 * across 13 planning roots and 1412 plans: 38 phases of 283 (13.4%) violate the rule, 107
 * colliding pairs — stable while data quality doubled, which rules out "dirty data".
 *
 * Literal mode is the default (`workflow.wave_normalize` off): only concrete files are compared,
 * directories and globs are counted as `skipped`. Expand mode is pinned in
 * tests/mn-wave-normalize.test.cjs.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnWaveCollision } = require('../gsd-core/bin/lib/gate-mn-waves.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** A plan with the frontmatter shape the real planner emits. */
function plan(wave, files) {
  const list = files.map((f) => `  - ${f}`).join('\n');
  return `---\nwave: ${wave}\nfiles_modified:\n${list}\n---\n\n# plan\n`;
}

describe('check mn-wave-collision (literal mode)', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-wave-collision-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function gateOn(files) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnWaveCollision({ projectDir, args: [phaseNumber] }).payload;
  }

  // ── the defect ────────────────────────────────────────────────────────────

  test('catches two plans in the same wave declaring the same file', () => {
    // The shape measured on the live project: 06-02 and 06-03, both wave 2, both main.ts.
    const v = gateOn({
      '06-02-PLAN.md': plan(2, ['apps/api/src/main.ts', 'apps/api/src/vault.ts']),
      '06-03-PLAN.md': plan(2, ['apps/api/src/main.ts', 'apps/api/src/heimdall.ts']),
    });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.equal(v.mode, 'literal');
    assert.deepEqual(v.collisions, [
      { wave: 2, a: '06-02-PLAN.md', b: '06-03-PLAN.md', shared: ['apps/api/src/main.ts'], sharedCount: 1 },
    ]);
  });

  test('reports every colliding pair, not just the first', () => {
    // Three plans over one file are three distinct pairs.
    const v = gateOn({
      'a-PLAN.md': plan(1, ['src/shared.ts']),
      'b-PLAN.md': plan(1, ['src/shared.ts']),
      'c-PLAN.md': plan(1, ['src/shared.ts']),
    });
    assert.equal(v.counts.collisions, 3);
    assert.deepEqual(v.collisions.map((c) => [c.a, c.b]), [
      ['a-PLAN.md', 'b-PLAN.md'],
      ['a-PLAN.md', 'c-PLAN.md'],
      ['b-PLAN.md', 'c-PLAN.md'],
    ]);
  });

  // ── what must NOT count as a collision ────────────────────────────────────

  test('passes when the same file is declared in DIFFERENT waves', () => {
    // Sequencing is precisely the remedy: wave 2 runs after wave 1 finishes.
    const v = gateOn({ 'a-PLAN.md': plan(1, ['src/shared.ts']), 'b-PLAN.md': plan(2, ['src/shared.ts']) });
    assert.equal(v.block, false);
  });

  test('passes when same-wave plans declare disjoint files', () => {
    const v = gateOn({ 'a-PLAN.md': plan(1, ['src/a.ts', 'src/b.ts']), 'b-PLAN.md': plan(1, ['src/c.ts', 'src/d.ts']) });
    assert.equal(v.block, false);
    assert.equal(v.pairsChecked, 1);
  });

  test('normalizes ./-prefixed and trailing-slash paths before comparing', () => {
    const v = gateOn({ 'a-PLAN.md': plan(1, ['./src/a.ts']), 'b-PLAN.md': plan(1, ['src/a.ts']) });
    assert.equal(v.block, true, 'path formatting must not mask a collision');
    assert.deepEqual(v.collisions[0].shared, ['src/a.ts']);
  });

  test('does not compare directory or glob entries, and counts them as skipped', () => {
    // Expanding a glob needs a tree walk; literal mode skips rather than guesses.
    const v = gateOn({ 'a-PLAN.md': plan(1, ['libs/shared/**']), 'b-PLAN.md': plan(1, ['libs/shared/**']) });
    assert.equal(v.block, false);
    assert.equal(v.skipped, 2, 'skipped entries must be reported, not vanish');
  });

  test('literal mode reports no declared-nothing, stale-glob or prose findings', () => {
    const v = gateOn({ 'a-PLAN.md': '---\nwave: 1\n---\n\n# empty\n', 'b-PLAN.md': plan(1, ['gone/**', '"two words"']) });
    assert.equal(v.block, false);
    assert.deepEqual([v.counts.declaredNothing, v.counts.resolvedToNothing, v.counts.unparseable], [0, 0, 0]);
  });

  test('passes a phase whose plans carry no wave tag', () => {
    // Untagged plans are not parallelised, so they cannot collide.
    const v = gateOn({
      'x-PLAN.md': '---\nfiles_modified:\n  - src/a.ts\n---\n\n# no wave\n',
      'y-PLAN.md': '---\nfiles_modified:\n  - src/a.ts\n---\n\n# no wave\n',
    });
    assert.equal(v.block, false);
    assert.equal(v.plans, 0);
  });

  test('passes a phase with a single plan', () => {
    assert.equal(gateOn({ 'only-PLAN.md': plan(1, ['src/a.ts']) }).block, false);
  });

  test('passes a plan declaring no files', () => {
    const v = gateOn({ 'a-PLAN.md': '---\nwave: 1\n---\n\n# empty\n', 'b-PLAN.md': plan(1, ['src/a.ts']) });
    assert.equal(v.block, false);
  });

  test('a superseded plan never runs, so it cannot collide', () => {
    const v = gateOn({
      'a-PLAN.md': '---\nwave: 1\nstatus: superseded\nsuperseded_by: b\nfiles_modified:\n  - src/a.ts\n---\n',
      'b-PLAN.md': plan(1, ['src/a.ts']),
    });
    assert.equal(v.block, false);
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('a phase that does not exist is unresolvable', () => {
    const v = evaluateMnWaveCollision({ projectDir, args: ['42'] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('no phase argument is a usage failure', () => {
    assert.ok(evaluateMnWaveCollision({ projectDir, args: [] }).failure);
  });

  // ── the gate is dispatched, not merely present ────────────────────────────

  test('the capability registers the gate at plan:post through check mn-wave-collision', () => {
    const gate = CAPABILITY.gates.find((g) => g.when === 'workflow.wave_collision');
    assert.ok(gate, 'a gate keyed on workflow.wave_collision must be declared');
    // plan:post: at planning time the fix is renumbering a wave; by verify the commits landed.
    assert.equal(gate.point, 'plan:post');
    assert.equal(gate.blocking, true);
    assert.deepEqual(gate.check, { query: 'mn-wave-collision' });
    assert.equal(CAPABILITY.config['workflow.wave_collision'].default, false, 'a new blocking gate ships off');
  });

  test('gsd_run check mn-wave-collision "${PHASE_DIR}" "${PHASE_REQ_IDS}" prints the verdict', () => {
    const { phaseDir } = makePhase(projectDir, { 'a-PLAN.md': plan(1, ['src/a.ts']), 'b-PLAN.md': plan(1, ['src/a.ts']) });
    const payload = runMnCheck(projectDir, 'mn-wave-collision', [phaseDir, 'REQ-01']);
    assert.equal(payload.block, true);
    assert.equal(payload.counts.collisions, 1);
  });
});
