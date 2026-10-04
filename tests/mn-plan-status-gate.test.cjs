'use strict';

/**
 * `gsd_run check mn-plan-status` — the enforcement half of the status vocabulary
 * (src/gate-mn-plan-status.cts; replaces capabilities/mn-verify-gate/scripts/plan-status.mjs).
 *
 * Phase 1 introduced the vocabulary, the transition matrix and the validation. This gate is their
 * caller: it inspects every plan in a phase and refuses a wave left in a state nobody can
 * interpret — while passing every state that IS interpretable.
 *
 * The gate imports the vocabulary from src/plan-status.cts rather than carrying a copy, so the
 * pins below are on OBSERVED verdicts: the `status` / `block` of the GateResult and the typed
 * `findings[].kind`, never on message text (local/no-source-grep).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnPlanStatus } = require('../gsd-core/bin/lib/gate-mn-plan-status.cjs');
const { PLAN_STATUSES, BLOCKED_REASON_MAX_LENGTH } = require('../gsd-core/bin/lib/plan-status.cjs');

const SUMMARY = '---\nphase: 01\n---\n\n# a summary\n';

describe('check mn-plan-status', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-plan-status-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  /**
   * Render plan frontmatter carrying ONLY the fields given. A fixture with no status must
   * genuinely have no `status:` line rather than an empty one — an empty value is a different
   * input, and the gate treats it differently.
   */
  function plan(fields = {}) {
    const lines = ['phase: 01', 'plan: 01'];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      lines.push(`${key}: ${value}`);
    }
    return `---\n${lines.join('\n')}\n---\n\n# a plan\n`;
  }

  /** Evaluate the gate on a fresh phase holding `files`. */
  function gateOn(files, extraArgs = []) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnPlanStatus({ projectDir, args: [phaseNumber, ...extraArgs] }).payload;
  }

  const kinds = (payload) => payload.findings.map((f) => f.kind);

  // ── criterion 1, and the sibling that proves the gate is not inert ────────

  test('a plan with no status field at all passes, and is counted', () => {
    // Absence means "not started". Roughly 1031 plans sit on consuming trees with no status; a
    // gate that failed them would be switched off on the day it shipped.
    const v = gateOn({ '01-01-PLAN.md': plan() });
    assert.equal(v.block, false);
    assert.equal(v.status, 'pass');
    assert.equal(v.noStatus, 1, 'it must still be counted, not merely ignored');
  });

  test('the SAME fixture with an out-of-vocabulary status is a finding', () => {
    // The trap-sibling for the test above: if the gate were inert, this would pass too.
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'frobnicated' }) });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(kinds(v), ['unknown-status']);
    assert.equal(v.findings[0].plan, '01-01-PLAN.md');
  });

  // ── criterion 2: the well-formed blocked plan PASSES ──────────────────────

  test('blocked with a non-empty in-bounds reason passes', () => {
    // Failing a correctly declared blocked plan would block the exact case the status was
    // introduced for: the author declared it, so the gate has nothing to add.
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'waiting on upstream release' }) });
    assert.equal(v.block, false);
    assert.equal(v.blocked, 1);
  });

  // ── criterion 3: the stranded in_progress, and its converse ───────────────

  test('in_progress with no matching SUMMARY is a finding naming the plan', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'in_progress' }) });
    assert.equal(v.block, true);
    assert.deepEqual(v.findings.map((f) => [f.plan, f.kind]), [['01-01-PLAN.md', 'stranded-in-progress']]);
  });

  test('in_progress WITH a matching SUMMARY passes', () => {
    // Executing and finishing is the normal path; the status left behind is a record of the run.
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'in_progress' }), '01-01-SUMMARY.md': SUMMARY });
    assert.equal(v.block, false);
    assert.equal(v.done, 1);
  });

  test('a sibling plan\'s SUMMARY does not finish another plan', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ status: 'in_progress' }),
      '01-02-PLAN.md': plan({ status: 'in_progress' }),
      '01-01-SUMMARY.md': SUMMARY,
    });
    assert.deepEqual(v.findings.map((f) => f.plan), ['01-02-PLAN.md']);
  });

  // ── criterion 4: the companion fields ─────────────────────────────────────

  test('blocked with no blocked_reason is a finding', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked' }) });
    assert.deepEqual(kinds(v), ['blocked-without-reason']);
  });

  test('blocked with an empty blocked_reason value is a finding', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: '' }) });
    assert.equal(v.block, true);
    assert.deepEqual(kinds(v), ['blocked-with-empty-reason']);
  });

  test('blocked with a whitespace-only blocked_reason is a finding — non-empty means non-blank', () => {
    // Emptiness is measured AFTER trim: the same cut validateBlockedReason makes.
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: '"     "' }) });
    assert.deepEqual(kinds(v), ['blocked-with-empty-reason']);
  });

  test('superseded with no superseded_by is a finding', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'superseded' }) });
    assert.deepEqual(kinds(v), ['superseded-without-successor']);
  });

  test('superseded with a successor passes', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'superseded', superseded_by: '01-02-PLAN.md' }) });
    assert.equal(v.block, false);
    assert.equal(v.superseded, 1);
  });

  test('one finding per plan — a plan with two defects yields one message', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ status: 'frobnicated' }),
      '01-02-PLAN.md': plan({ status: 'blocked' }),
    });
    assert.deepEqual(kinds(v), ['unknown-status', 'blocked-without-reason']);
  });

  // ── D-05: completion is read from the SUMMARY and only from there ─────────

  test('status: done with no SUMMARY passes — the gate adds no second completion signal', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'done' }) });
    assert.equal(v.block, false);
  });

  test('a plan with a SUMMARY and no status at all passes', () => {
    const v = gateOn({ '01-01-PLAN.md': plan(), '01-01-SUMMARY.md': SUMMARY });
    assert.equal(v.block, false);
  });

  // ── nothing to interpret ──────────────────────────────────────────────────

  test('an empty phase directory passes', () => {
    const v = gateOn({});
    assert.equal(v.block, false);
    assert.equal(v.plans, 0);
  });

  test('a directory holding only SUMMARYs passes', () => {
    const v = gateOn({ '01-01-SUMMARY.md': SUMMARY, '01-02-SUMMARY.md': SUMMARY });
    assert.equal(v.block, false);
  });

  test('an empty plan file is nothing to interpret, not a defect', () => {
    const v = gateOn({ '01-01-PLAN.md': '' });
    assert.equal(v.block, false);
  });

  test('derivative files beside a plan are not plans (plan-scan owns the file set)', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan(),
      '01-01-PLAN-REVIEW.md': plan({ status: 'frobnicated' }),
      '01-01-OUTLINE.md': plan({ status: 'frobnicated' }),
    });
    assert.equal(v.block, false);
    assert.equal(v.plans, 1);
  });

  test('a nested plans/ layout is read too (#3139)', () => {
    const v = gateOn({ 'plans/PLAN-01-setup.md': plan({ status: 'in_progress' }) });
    assert.deepEqual(v.findings.map((f) => [f.plan, f.kind]), [['plans/PLAN-01-setup.md', 'stranded-in-progress']]);
  });

  // ── the ceiling, derived from the constant and never from a literal ───────

  test('a blocked_reason one character below the ceiling passes', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'x'.repeat(BLOCKED_REASON_MAX_LENGTH - 1) }) });
    assert.equal(v.block, false, 'limit-1 must pass');
  });

  test('a blocked_reason of exactly the ceiling passes — the limit is inclusive', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'x'.repeat(BLOCKED_REASON_MAX_LENGTH) }) });
    assert.equal(v.block, false, 'the ceiling itself must pass');
  });

  test('a blocked_reason one character above the ceiling is a finding', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);
    assert.ok(reason.length > BLOCKED_REASON_MAX_LENGTH, 'the over-limit fixture must genuinely exceed the ceiling');
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: reason }) });
    assert.deepEqual(kinds(v), ['blocked-reason-too-long']);
  });

  test('the oversized reason is rejected, never truncated — its content never reaches the payload', () => {
    // T-02-12: printing even a shortened prefix of an unreadable reason would let an unreadable
    // report pass for nothing to report.
    const needle = 'QZX'.repeat(8);
    const reason = needle + 'y'.repeat(BLOCKED_REASON_MAX_LENGTH + 1 - needle.length);
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: reason }) });
    assert.equal(v.block, true);
    assert.equal(JSON.stringify(v).includes(needle), false, 'the reason must not be echoed, even shortened');
  });

  // ── D-28: "could not check" is not "checked and found something" ──────────

  test('a phase that does not exist is unresolvable — blocks, and says it could not check', () => {
    const v = evaluateMnPlanStatus({ projectDir, args: ['99'] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('a path naming a file rather than a directory is unresolvable', () => {
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': plan({ status: 'in_progress' }) });
    const v = evaluateMnPlanStatus({ projectDir, args: [path.join(phaseDir, '01-01-PLAN.md')] }).payload;
    assert.equal(v.status, 'unresolvable');
  });

  test('no phase argument is a usage failure', () => {
    assert.ok(evaluateMnPlanStatus({ projectDir, args: [] }).failure);
  });

  test('a plan that cannot be read is unresolvable, not clean', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const { phaseDir, phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': plan({ status: 'done' }) });
    fs.chmodSync(path.join(phaseDir, '01-01-PLAN.md'), 0o000);
    const v = evaluateMnPlanStatus({ projectDir, args: [phaseNumber] }).payload;
    fs.chmodSync(path.join(phaseDir, '01-01-PLAN.md'), 0o644);
    assert.equal(v.status, 'unresolvable');
  });

  // ── the drift pin ─────────────────────────────────────────────────────────

  /**
   * The gate's OBSERVED verdict for every value in the vocabulary, stated BY HAND. A value added
   * to PLAN_STATUSES with no entry here fails the set equality; a value whose verdict changes
   * fails its own test. A table derived from the thing it checks cannot disagree with it.
   */
  const GATE_VERDICTS = {
    in_progress: { fields: {}, block: true, count: null, kind: 'stranded-in-progress' },
    done: { fields: {}, block: false, count: 'done' },
    blocked: { fields: { blocked_reason: 'waiting on upstream release' }, block: false, count: 'blocked' },
    superseded: { fields: { superseded_by: '01-02-PLAN.md' }, block: false, count: 'superseded' },
  };

  test('every value in PLAN_STATUSES has a declared gate expectation', () => {
    assert.deepEqual([...PLAN_STATUSES].sort(), Object.keys(GATE_VERDICTS).sort());
  });

  for (const status of PLAN_STATUSES) {
    test(`the gate's verdict for status: ${status} is unchanged`, () => {
      const expected = GATE_VERDICTS[status];
      assert.ok(expected, `no declared expectation for ${status}`);
      const v = gateOn({ '01-01-PLAN.md': plan({ status, ...expected.fields }) });
      assert.equal(v.block, expected.block, `status: ${status}`);
      if (expected.count) assert.equal(v[expected.count], 1, `status: ${status} must be counted as ${expected.count}`);
      if (expected.kind) assert.deepEqual(kinds(v), [expected.kind]);
    });
  }

  // ── the near-misses the set-equality cannot see ───────────────────────────

  test('a hyphenated near-miss is a finding — it is not in the vocabulary', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ status: 'in-progress' }) });
    assert.deepEqual(kinds(v), ['unknown-status']);
  });

  test('a differently-cased status with surrounding whitespace passes — trim and lowercase, nothing more', () => {
    // A stricter rule here would make the gate reject a file plan-scan accepts.
    const v = gateOn({ '01-01-PLAN.md': plan({ status: '  SUPERSEDED  ', superseded_by: '01-02-PLAN.md' }) });
    assert.equal(v.block, false);
    assert.equal(v.superseded, 1);
  });

  test('a differently-cased done passes', () => {
    assert.equal(gateOn({ '01-01-PLAN.md': plan({ status: 'Done' }) }).block, false);
  });

  // ── through the CLI, the way execute:wave:post dispatches it ──────────────

  test('gsd_run check mn-plan-status "${PHASE_NUMBER}" prints the verdict', () => {
    const { phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': plan({ status: 'in_progress' }) });
    const payload = runMnCheck(projectDir, 'mn-plan-status', [phaseNumber]);
    assert.equal(payload.block, true);
    assert.equal(payload.status, 'finding');
  });
});
