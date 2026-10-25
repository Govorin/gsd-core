'use strict';

/**
 * `gsd_run check mn-orphan-plans` — the gate for plans whose fate nothing records
 * (src/gate-mn-plan-status.cts; replaces capabilities/mn-verify-gate/scripts/orphan-plans.mjs).
 *
 * A plan's state is inferred from whether a SUMMARY sits beside it, which distinguishes exactly
 * two of four cases: present means executed; absent means never started, OR started and
 * abandoned, OR the executor died mid-run, OR superseded. Measured across 8 planning roots: 445
 * plans of 1190 (37.4%) have no SUMMARY, and an autonomous pass meeting such a plan re-runs it
 * from scratch on top of work it already did.
 *
 * `in_progress` in the PLAN is the one state that cannot be reconstructed afterwards. The tests
 * weight the non-blocking half as heavily as the detection: a plan with no status at all is
 * REPORTED, never blocked — a gate failing a third of a repository is switched off on day one.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnOrphanPlans } = require('../gsd-core/bin/lib/gate-mn-orphan-plans.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

const SUMMARY = '---\nphase: 01\n---\n\n# summary\n';

function plan(frontmatter = {}) {
  const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
  return `---\nphase: 01\n${lines.join('\n')}\n---\n\n# plan\n`;
}

describe('check mn-orphan-plans', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-orphan-plans-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function gateOn(files, extraArgs = []) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnOrphanPlans({ projectDir, args: [phaseNumber, ...extraArgs] }).payload;
  }

  // ── the state that cannot be reconstructed afterwards ─────────────────────

  test('blocks a plan that declares in_progress and produced no SUMMARY', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'in_progress' }) });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(v.orphaned, ['01-01-PLAN.md']);
  });

  test('accepts in_progress once the SUMMARY exists', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'in_progress' }), '01-01-SUMMARY.md': SUMMARY });
    assert.equal(v.block, false);
    assert.equal(v.done, 1);
  });

  // ── what must NOT block ───────────────────────────────────────────────────

  test('reports a plan with no status at all without blocking', () => {
    const v = gateOn({ '01-01-PLAN.md': plan() });
    assert.equal(v.block, false, 'an unknown-state plan must not block');
    assert.deepEqual(v.unknownState, ['01-01-PLAN.md'], 'it must still be counted and named');
  });

  test('--strict blocks unknown-state plans for a repository that has cleaned up', () => {
    const v = gateOn({ '01-01-PLAN.md': plan() }, ['--strict']);
    assert.equal(v.block, true);
    assert.equal(v.strict, true);
    assert.deepEqual(v.unknownState, ['01-01-PLAN.md']);
  });

  test('--strict before the phase does not swallow the phase as its value', () => {
    const { phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': plan() });
    const v = evaluateMnOrphanPlans({ projectDir, args: ['--strict', phaseNumber] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.strict, true);
  });

  test('skips a superseded plan entirely', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'superseded', superseded_by: '01-02-PLAN.md' }) });
    assert.equal(v.block, false);
    assert.equal(v.superseded, 1);
  });

  test('a superseded plan is skipped even under --strict', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'superseded' }) }, ['--strict']);
    assert.equal(v.block, false, 'superseded is a decision, not missing information');
  });

  test('passes a phase holding no plans', () => {
    const v = gateOn({});
    assert.equal(v.block, false);
    assert.deepEqual([v.orphaned, v.unknownState, v.done, v.superseded], [[], [], 0, 0]);
  });

  test('counts every plan in a mixed phase', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ status: 'in_progress' }),
      '01-01-SUMMARY.md': SUMMARY,
      '01-02-PLAN.md': plan({ status: 'superseded' }),
      '01-03-PLAN.md': plan(),
    });
    assert.equal(v.block, false);
    assert.deepEqual([v.done, v.superseded, v.unknownState.length], [1, 1, 1]);
  });

  test('matches a SUMMARY to its own plan, not to a sibling', () => {
    // 01-01-SUMMARY.md must not vouch for 01-02-PLAN.md — that would silently clear every orphan
    // in any phase that finished one plan.
    const v = gateOn({
      '01-01-PLAN.md': plan({ status: 'in_progress' }),
      '01-01-SUMMARY.md': SUMMARY,
      '01-02-PLAN.md': plan({ status: 'in_progress' }),
    });
    assert.equal(v.block, true);
    assert.deepEqual(v.orphaned, ['01-02-PLAN.md']);
  });

  test('reads status from the last line of frontmatter', () => {
    // A reader requiring a newline after each entry drops the LAST frontmatter line, whose newline
    // the closing --- consumes. That bug shipped once in wave-collision and was caught by its tests.
    const v = gateOn({ '01-01-PLAN.md': '---\nphase: 01\nplan: 01\nstatus: in_progress\n---\n\n# body\n' });
    assert.deepEqual(v.orphaned, ['01-01-PLAN.md']);
  });

  // ── "could not look" is not "found nothing" ───────────────────────────────

  test('a phase that does not exist is unresolvable', () => {
    const v = evaluateMnOrphanPlans({ projectDir, args: ['42'] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('no phase argument is a usage failure', () => {
    assert.ok(evaluateMnOrphanPlans({ projectDir, args: [] }).failure);
  });

  // ── wiring ────────────────────────────────────────────────────────────────

  test('the capability registers the gate as opt-in at verify:pre, through check mn-orphan-plans', () => {
    const gate = CAPABILITY.gates.find((g) => g.when === 'workflow.orphan_plans');
    assert.ok(gate, 'a gate keyed on workflow.orphan_plans must be declared');
    assert.equal(gate.point, 'verify:pre');
    assert.equal(gate.blocking, true, 'an orphan that does not block is a report, not a gate');
    assert.deepEqual(gate.check, { query: 'mn-orphan-plans' });
    const cfg = CAPABILITY.config['workflow.orphan_plans'];
    assert.ok(cfg, 'the gate must own a config key so it can be switched off');
    assert.equal(cfg.default, false, 'a new blocking gate ships off and is opted into');
  });

  test('gsd_run check mn-orphan-plans "${PHASE_DIR}" prints the verdict', () => {
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': plan({ status: 'in_progress' }) });
    const payload = runMnCheck(projectDir, 'mn-orphan-plans', [phaseDir]);
    assert.equal(payload.block, true);
    assert.deepEqual(payload.orphaned, ['01-01-PLAN.md']);
  });
});
