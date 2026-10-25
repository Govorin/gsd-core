'use strict';

/**
 * Drift pin: `check mn-orphan-plans` against the plan-status vocabulary (src/plan-status.cts).
 *
 * The orphan gate is the second live reader of a plan's `status`. It used to be a script carrying
 * its own copy of the words, and this file held that copy equal by running it. The gate now
 * imports the vocabulary (src/gate-mn-plan-status.cts), so a word cannot drift out of sync with
 * src/ — but its VERDICT for each word still can, and that is what is pinned here, by hand:
 *
 *   - a value added to PLAN_STATUSES with no entry below fails the completeness assertion;
 *   - a value whose verdict in the gate changes fails its own test.
 *
 * Restating the expectations by hand rather than deriving them is deliberate: a table derived from
 * the thing it checks cannot disagree with it. tests/mn-plan-status-gate.test.cjs pins the other
 * reader, `check mn-plan-status`, the same way.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnOrphanPlans } = require('../gsd-core/bin/lib/gate-mn-orphan-plans.cjs');
const { PLAN_STATUSES } = require('../gsd-core/bin/lib/plan-status.cjs');

const SUMMARY = '---\nphase: 01\n---\n\n# summary\n';

function plan(status) {
  return `---\nphase: 01\nplan: 01\n${status === undefined ? '' : `status: ${status}\n`}---\n\n# plan\n`;
}

describe('plan-status vocabulary ↔ check mn-orphan-plans', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-plan-status-drift-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function gateOn(files) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnOrphanPlans({ projectDir, args: [phaseNumber] }).payload;
  }

  // ── D-05: completion comes from the SUMMARY, not from the status claim ────

  test('status: done WITHOUT a SUMMARY is not counted as done — it falls through to unknown', () => {
    const v = gateOn({ '01-01-PLAN.md': plan('done') });
    assert.equal(v.block, false);
    assert.equal(v.done, 0, 'the status claim alone does not make a plan done');
    assert.deepEqual(v.unknownState, ['01-01-PLAN.md']);
  });

  test('a SUMMARY with NO status at all IS counted as done', () => {
    const v = gateOn({ '01-01-PLAN.md': plan(), '01-01-SUMMARY.md': SUMMARY });
    assert.equal(v.done, 1);
    assert.deepEqual(v.unknownState, []);
  });

  // ── the drift pin ─────────────────────────────────────────────────────────

  const GATE_VERDICTS = {
    // the gate's only failing branch
    in_progress: { block: true, bucket: 'orphaned' },
    // #2349: skipped always
    superseded: { block: false, bucket: 'superseded' },
    // D-05: no SUMMARY, so not done — falls through
    done: { block: false, bucket: 'unknownState' },
    // D-00c: a value the gate has no branch for keeps falling through
    blocked: { block: false, bucket: 'unknownState' },
  };

  test('every value in PLAN_STATUSES has a declared gate expectation', () => {
    assert.deepEqual(
      [...PLAN_STATUSES].sort(),
      Object.keys(GATE_VERDICTS).sort(),
      'a status added to src/plan-status.cts must declare its observed mn-orphan-plans verdict here',
    );
  });

  for (const status of PLAN_STATUSES) {
    test(`the gate's verdict for status: ${status} is unchanged`, () => {
      const expected = GATE_VERDICTS[status];
      assert.ok(expected, `no declared expectation for ${status}`);
      const v = gateOn({ '01-01-PLAN.md': plan(status) });
      assert.equal(v.block, expected.block, `status: ${status}`);
      const bucket = v[expected.bucket];
      assert.equal(Array.isArray(bucket) ? bucket.length : bucket, 1, `status: ${status} must land in ${expected.bucket}`);
    });
  }
});
