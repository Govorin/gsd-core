'use strict';

/**
 * TRANSITIONAL golden test: `plan-status.mjs` / `orphan-plans.mjs` ↔ `check mn-plan-status` /
 * `check mn-orphan-plans`, on the same fixtures (decision 6 of .plans/mn-verify-gate-to-cli.md).
 *
 * Requires "script exited non-zero" to equal "verdict blocks", and "script exited 2" to equal
 * `status: unresolvable`. Deleted with the scripts.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnPlanStatus, evaluateMnOrphanPlans } = require('../gsd-core/bin/lib/gate-mn-plan-status.cjs');

const SCRIPTS = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts');
const RUN_TIMEOUT_MS = 30000;
const SUMMARY = '---\nphase: 01\n---\n\n# summary\n';

function plan(fields = {}) {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\nphase: 01\nplan: 01\n${lines.join('\n')}${lines.length ? '\n' : ''}---\n\n# plan\n`;
}

const FIXTURES = [
  ['empty phase', {}],
  ['no status', { '01-01-PLAN.md': plan() }],
  ['unknown status', { '01-01-PLAN.md': plan({ status: 'frobnicated' }) }],
  ['hyphenated near-miss', { '01-01-PLAN.md': plan({ status: 'in-progress' }) }],
  ['stranded in_progress', { '01-01-PLAN.md': plan({ status: 'in_progress' }) }],
  ['finished in_progress', { '01-01-PLAN.md': plan({ status: 'in_progress' }), '01-01-SUMMARY.md': SUMMARY }],
  ['sibling summary', { '01-01-PLAN.md': plan({ status: 'in_progress' }), '01-02-PLAN.md': plan({ status: 'in_progress' }), '01-01-SUMMARY.md': SUMMARY }],
  ['blocked with reason', { '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'waiting on upstream' }) }],
  ['blocked without reason', { '01-01-PLAN.md': plan({ status: 'blocked' }) }],
  ['blocked whitespace reason', { '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: '"   "' }) }],
  ['blocked reason at ceiling', { '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'x'.repeat(2048) }) }],
  ['blocked reason over ceiling', { '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'x'.repeat(2049) }) }],
  ['superseded with successor', { '01-01-PLAN.md': plan({ status: 'superseded', superseded_by: '01-02-PLAN.md' }) }],
  ['superseded without successor', { '01-01-PLAN.md': plan({ status: 'superseded' }) }],
  ['done without summary', { '01-01-PLAN.md': plan({ status: 'done' }) }],
  ['cased superseded', { '01-01-PLAN.md': plan({ status: '  SUPERSEDED  ', superseded_by: 'x' }) }],
  ['only summaries', { '01-01-SUMMARY.md': SUMMARY }],
  ['mixed phase', { '01-01-PLAN.md': plan({ status: 'in_progress' }), '01-01-SUMMARY.md': SUMMARY, '01-02-PLAN.md': plan({ status: 'superseded' }), '01-03-PLAN.md': plan() }],
];

describe('plan-status / orphan-plans scripts ↔ check verbs (transitional)', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-eq-plan-status-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function compare(script, evaluate, files) {
    const { phaseDir, phaseNumber } = makePhase(projectDir, files);
    const r = runNode([path.join(SCRIPTS, script), '--dir', phaseDir], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    const v = evaluate({ projectDir, args: [phaseNumber] }).payload;
    assert.equal(v.block, r.exitCode !== 0, `${script}: exit ${r.exitCode} vs block ${v.block} (${v.message})`);
    assert.equal(v.status === 'unresolvable', r.exitCode === 2, `${script}: exit ${r.exitCode} vs status ${v.status}`);
  }

  for (const [label, files] of FIXTURES) {
    test(`plan-status: ${label}`, () => compare('plan-status.mjs', evaluateMnPlanStatus, files));
    test(`orphan-plans: ${label}`, () => compare('orphan-plans.mjs', evaluateMnOrphanPlans, files));
  }

  test('a missing phase is "could not check" on both sides', () => {
    const r = runNode([path.join(SCRIPTS, 'plan-status.mjs'), '--dir', path.join(projectDir, 'nope')], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, 2);
    assert.equal(evaluateMnPlanStatus({ projectDir, args: ['77'] }).payload.status, 'unresolvable');
  });
});
