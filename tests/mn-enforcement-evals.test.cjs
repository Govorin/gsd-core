'use strict';

/**
 * Behavioural evals for the enforcement layer — the situations that actually
 * burned this author's projects, each with one verdict the harness must reach.
 *
 * Seam: the four hooks and the UAT gate, driven through their real decision
 * surfaces, from a declarative case file (`tests/qa/enforcement-cases.json`).
 *
 * Why this exists next to the per-hook unit tests, which already pass:
 *
 *   A unit test asks "does this function return deny for this input". These
 *   ask "given the situation recorded in the retrospective, does the harness
 *   refuse". The distinction is not academic — every failure listed in the
 *   case file happened while the surrounding code was correct and tested. The
 *   gap was never in whether a function worked; it was in whether the
 *   situation was wired to anything at all. blast-radius could always detect
 *   an undeclared file; nothing asked it at the moment of the write. audit-uat
 *   could always find an unrun check; nothing read it before ship.
 *
 * The case file is the artifact worth keeping. It is written so a reader who
 * has never seen this code can tell whether a verdict is right — each case
 * names its source, states the situation in one sentence, and says why the
 * expected verdict is the correct one. Cases whose verdict is `allow` carry
 * their weight: a guard that blocks a legitimate shape is the failure mode
 * that gets guards disabled, and those are pinned here as deliberately as the
 * blocking ones.
 *
 * Adding a case when something new burns you is the intended way to use this.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOKS = path.join(__dirname, '..', 'hooks');
const prohibition = require(path.join(HOOKS, 'gsd-prohibition-guard.js'));
const tamper = require(path.join(HOOKS, 'gsd-test-tamper-guard.js'));
const exitGate = require(path.join(HOOKS, 'gsd-exit-gate.js'));
const worktree = require(path.join(HOOKS, 'gsd-worktree-provision.js'));

const UAT_GATE = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'uat-open.mjs'
);

/**
 * Bounds one run of the UAT gate over a case fixture. Passed as `timeoutMs`:
 * the seam ignores a `timeout` key, so this bound used to be dead and the call
 * fell back to the seam's 60000ms default.
 */
const UAT_GATE_TIMEOUT_MS = 90000;

const CASES = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'qa', 'enforcement-cases.json'), 'utf8')
);

/** Test-file bodies referenced by name from the case file. */
const SPECS = {
  'spec-three-assertions': [
    "describe('order', () => {",
    "  it('a', () => { expect(1).toBe(1); });",
    "  it('b', () => { expect(2).toBe(2); });",
    "  it('c', () => { expect(3).toBe(3); });",
    '});',
    '',
  ].join('\n'),
  'spec-two-assertions': [
    "describe('order', () => {",
    "  it('a', () => { expect(1).toBe(1); });",
    "  it('b', () => { expect(2).toBe(2); });",
    '});',
    '',
  ].join('\n'),
  'spec-four-assertions': [
    "describe('order', () => {",
    "  it('a', () => { expect(1).toBe(1); });",
    "  it('b', () => { expect(2).toBe(2); });",
    "  it('c', () => { expect(3).toBe(3); });",
    "  it('d', () => { expect(4).toBe(4); });",
    '});',
    '',
  ].join('\n'),
  'spec-one-commented': [
    "describe('order', () => {",
    "  it('a', () => { expect(1).toBe(1); });",
    "  it('b', () => { expect(2).toBe(2); });",
    "  it('c', () => { /* expect(3).toBe(3); */ });",
    '});',
    '',
  ].join('\n'),
};

/** Every runner reduces a case to one of these three words. */
const VERDICTS = new Set(['block', 'allow', 'warn']);

function writeProject(dir, workflow) {
  fs.mkdirSync(path.join(dir, '.planning', 'phases', '03-ports'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ workflow }, null, 2)
  );
  fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\ncurrent_phase: 03\n---\n');
  return path.join(dir, '.planning', 'phases', '03-ports');
}

function writePlan(phaseDir, plan) {
  const files = (plan.files_modified || []).map((f) => `  - ${f}`).join('\n');
  fs.writeFileSync(
    path.join(phaseDir, '03-01-PLAN.md'),
    `---\nphase: 03\nplan: 01\nstatus: ${plan.status}\n` +
      (files ? `files_modified:\n${files}\n` : 'files_modified: []\n') +
      '---\n\n# Plan\n'
  );
}

/** Normalise a hook decision into the case file's vocabulary. */
const asVerdict = (action) => (action === 'deny' || action === 'block' ? 'block' : action === 'ask' ? 'block' : 'allow');

const RUNNERS = {
  prohibition(testCase, dir) {
    const phaseDir = writeProject(dir, testCase.config);
    writePlan(phaseDir, testCase.plan);
    const target = testCase.write.startsWith('.planning/')
      ? path.join(dir, testCase.write)
      : testCase.write;
    const decision = prohibition.evaluateWrite({
      tool_name: 'Write',
      tool_input: { file_path: target, content: 'x' },
      cwd: dir,
    });
    return asVerdict(decision.action);
  },

  tamper(testCase, dir) {
    writeProject(dir, testCase.config);
    const specPath = path.join(dir, 'libs', 'order.spec.ts');
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, SPECS[testCase.existing]);
    const decision = tamper.evaluateTestWrite({
      tool_name: 'Write',
      tool_input: { file_path: specPath, content: SPECS[testCase.write] },
      cwd: dir,
    });
    return asVerdict(decision.action);
  },

  'exit-gate'(testCase, dir) {
    writeProject(dir, { ...testCase.config, exit_gate: 'configured' });
    // The two situations the case file distinguishes: a check that ran and
    // failed, versus one that could not run at all.
    const runner =
      testCase.config.exit_gate === 'MISSING'
        ? () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' }, signal: null })
        : () => ({ status: 1, stdout: 'tsc: 3 errors', stderr: '', error: null, signal: null });
    const decision = exitGate.evaluateStop({ subagent_type: 'gsd-executor', cwd: dir }, { runner });
    return asVerdict(decision.action);
  },

  worktree(testCase, dir, t) {
    writeProject(dir, testCase.config);
    const tree = createTempDir();
    t.after(() => cleanup(tree));
    const decision = worktree.provisionWorktree(
      { worktree_path: tree, cwd: dir },
      {
        measureBaseLag: () => ({ behind: testCase.behind }),
        provisionDeps: () => ({ mode: 'none', done: false, reason: 'disabled' }),
      }
    );
    return asVerdict(decision.action);
  },

  uat(testCase, dir) {
    const phaseDir = writeProject(dir, {});
    if (testCase.uat !== 'absent') {
      fs.writeFileSync(
        path.join(phaseDir, '03-UAT.md'),
        `---\nstatus: testing\nphase: 03\n---\n\n## Tests\n\n` +
          `### 1. Login works\nexpected: dashboard appears\nresult: ${testCase.uat}\n`
      );
    }
    const result = runNode([UAT_GATE, '--dir', phaseDir], { timeoutMs: UAT_GATE_TIMEOUT_MS });
    assert.equal(result.outcome, OUTCOME.EXITED, `${testCase.id}: the gate must exit cleanly`);
    return result.exitCode === 0 ? 'allow' : 'block';
  },
};

describe('enforcement evals — the situations that actually burned us', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  before(() => {
    // The case file is the artifact; a malformed one must fail loudly rather
    // than silently running fewer cases than it claims.
    assert.ok(Array.isArray(CASES.cases) && CASES.cases.length > 0, 'the case file must hold cases');
    const ids = new Set();
    for (const c of CASES.cases) {
      assert.ok(c.id && !ids.has(c.id), `duplicate or missing case id: ${c.id}`);
      ids.add(c.id);
      assert.ok(RUNNERS[c.hook], `case ${c.id} names an unknown hook: ${c.hook}`);
      assert.ok(VERDICTS.has(c.verdict), `case ${c.id} has an unusable verdict: ${c.verdict}`);
      assert.ok(c.source && c.situation && c.because, `case ${c.id} must say where it came from, what happens, and why the verdict is right`);
    }
  });

  for (const testCase of CASES.cases) {
    test(`${testCase.id} → ${testCase.verdict}`, (t) => {
      const got = RUNNERS[testCase.hook](testCase, dir, t);
      assert.equal(
        got,
        testCase.verdict,
        `${testCase.situation}\n  expected: ${testCase.verdict}\n  because:  ${testCase.because}\n  source:   ${testCase.source}`
      );
    });
  }

  test('the suite covers every enforcement mechanism, and both verdicts', () => {
    // A case set that only ever expects `block` would pin the guards' teeth
    // while leaving the false-positive behaviour — the thing that actually
    // gets guards disabled — untested. This asserts the balance stays.
    const hooks = new Set(CASES.cases.map((c) => c.hook));
    for (const required of ['prohibition', 'tamper', 'exit-gate', 'worktree', 'uat']) {
      assert.ok(hooks.has(required), `no case exercises the ${required} mechanism`);
    }
    const verdicts = CASES.cases.map((c) => c.verdict);
    assert.ok(verdicts.includes('block'), 'no case asserts that anything is refused');
    assert.ok(
      verdicts.filter((v) => v === 'allow').length >= 5,
      'too few cases pin the legitimate shapes a guard must not block'
    );
  });
});
