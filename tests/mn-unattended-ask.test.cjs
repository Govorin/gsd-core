'use strict';

/**
 * The fork's two ask-capable write guards in an autonomous run.
 *
 * gsd-prohibition-guard.js and gsd-test-tamper-guard.js answer a write they
 * object to with "ask" or "deny" (workflow.prohibition_guard /
 * workflow.test_tamper_guard). In an autonomous chain an "ask" has nobody to
 * answer it — a recorded project's background agents waited 3285 minutes on 61
 * such prompts — so while auto mode is active (`gsd_run check auto-mode`,
 * src/check-auto-mode.cts) the guards answer "deny" with a reason instead.
 *
 * Matrix per guard: ask+auto → deny (marked unattended), ask+manual → ask,
 * deny+auto and deny+manual → deny (not marked), off+auto → allow. The auto
 * signal is injected for the matrix (`isAutoRun`), and read for real through
 * readAutoModeState on the process-seam cases, where the exit code is the
 * enforcement: once from the persistent `workflow.auto_advance` setting, and
 * once from an auto-chain set by `gsd-tools auto-chain set` — the chain is run
 * state outside config.json, so it is set through its own verb, never by
 * writing the file the tests do not own.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const prohibition = require(path.join(HOOKS_DIR, 'gsd-prohibition-guard.js'));
const tamper = require(path.join(HOOKS_DIR, 'gsd-test-tamper-guard.js'));
const { askOrDeny, autoRunActive } = require(path.join(HOOKS_DIR, 'lib', 'unattended-ask.js'));

const THREE_ASSERTIONS = [
  "describe('order', () => {",
  "  it('a', () => { expect(1).toBe(1); });",
  "  it('b', () => { expect(2).toBe(2); });",
  "  it('c', () => { expect(3).toBe(3); });",
  '});',
  '',
].join('\n');
const TWO_ASSERTIONS = THREE_ASSERTIONS.replace("  it('c', () => { expect(3).toBe(3); });\n", '');

function writeConfig(dir, workflow) {
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow }, null, 2));
}

/** A project with a running phase that declares one file, and a three-assertion spec. */
function makeProject(dir) {
  const phaseDir = path.join(dir, '.planning', 'phases', '03-ports');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\ncurrent_phase: 03\n---\n');
  fs.writeFileSync(
    path.join(phaseDir, '03-01-PLAN.md'),
    '---\nphase: 03\nplan: 03-01\nstatus: in_progress\nfiles_modified:\n  - libs/declared.ts\n---\n\n# Plan\n'
  );
  fs.mkdirSync(path.join(dir, 'libs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'libs', 'order.spec.ts'), THREE_ASSERTIONS);
  writeConfig(dir, {});
}

const GUARDS = [
  {
    name: 'prohibition guard',
    key: 'prohibition_guard',
    file: 'gsd-prohibition-guard.js',
    payload: (dir) => ({ tool_name: 'Write', tool_input: { file_path: 'libs/undeclared.ts', content: 'x' }, cwd: dir }),
    decide: (data, isAutoRun) => prohibition.evaluateWrite(data, { isAutoRun }),
  },
  {
    name: 'test tamper guard',
    key: 'test_tamper_guard',
    file: 'gsd-test-tamper-guard.js',
    payload: (dir) => ({
      tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'libs', 'order.spec.ts'), content: TWO_ASSERTIONS },
      cwd: dir,
    }),
    decide: (data, isAutoRun) => tamper.evaluateTestWrite(data, { isAutoRun }),
  },
];

for (const guard of GUARDS) {
  describe(`unattended ask — ${guard.name}`, () => {
    let dir;
    beforeEach(() => {
      dir = createTempDir('gsd-unattended-');
      makeProject(dir);
    });
    afterEach(() => cleanup(dir));

    const autoOn = () => true;
    const autoOff = () => false;

    test('ask while auto mode is active is answered deny, marked unattended, with a longer reason', () => {
      writeConfig(dir, { [guard.key]: 'ask' });
      const manual = guard.decide(guard.payload(dir), autoOff);
      const auto = guard.decide(guard.payload(dir), autoOn);
      assert.equal(auto.action, 'deny');
      assert.equal(auto.unattended, true);
      assert.ok(auto.reason.startsWith(manual.reason), 'the guard\'s own reason is kept');
      assert.ok(auto.reason.length > manual.reason.length, 'and the deny explains itself');
    });

    test('ask in a manual session still asks', () => {
      writeConfig(dir, { [guard.key]: 'ask' });
      const decision = guard.decide(guard.payload(dir), autoOff);
      assert.equal(decision.action, 'ask');
      assert.equal(decision.unattended, false);
    });

    test('deny is deny with or without auto mode, and is not marked unattended', () => {
      writeConfig(dir, { [guard.key]: 'deny' });
      for (const isAutoRun of [autoOn, autoOff]) {
        const decision = guard.decide(guard.payload(dir), isAutoRun);
        assert.equal(decision.action, 'deny');
        assert.equal(decision.unattended, false);
      }
    });

    test('off stays off in auto mode — auto mode never arms a guard', () => {
      writeConfig(dir, { [guard.key]: 'off' });
      assert.equal(guard.decide(guard.payload(dir), autoOn).action, 'allow');
      writeConfig(dir, {});
      assert.equal(guard.decide(guard.payload(dir), autoOn).action, 'allow');
    });

    test('the auto-mode reader is asked about this project', () => {
      writeConfig(dir, { [guard.key]: 'ask' });
      const asked = [];
      guard.decide(guard.payload(dir), (root) => { asked.push(root); return false; });
      assert.deepEqual(asked.map((p) => fs.realpathSync(p)), [fs.realpathSync(dir)]);
    });

    test('through the hook: ask + workflow.auto_advance exits 2 with an unattended deny', () => {
      writeConfig(dir, { [guard.key]: 'ask', auto_advance: true });
      const r = runHook(path.join(HOOKS_DIR, guard.file), [], {
        input: JSON.stringify(guard.payload(dir)),
        cwd: dir,
        timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, 2, `exit 2 is what blocks the call; stdout=${r.stdout}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(out.unattended, true);
      assert.equal(r.stderr, out.reason);
    });

    test('through the hook: ask + an active auto-chain exits 2 with an unattended deny', (t) => {
      writeConfig(dir, { [guard.key]: 'ask' });
      const set = runGsdTools(['auto-chain', 'set'], dir);
      if (!set.success) {
        // The run-scoped chain verb lands with the auto-chain state move; until
        // then auto_advance above is the only real signal to drive.
        t.skip('gsd-tools auto-chain set is not available in this tree');
        return;
      }
      const r = runHook(path.join(HOOKS_DIR, guard.file), [], {
        input: JSON.stringify(guard.payload(dir)),
        cwd: dir,
        timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, 2, `exit 2 is what blocks the call; stdout=${r.stdout}`);
      assert.equal(JSON.parse(r.stdout).unattended, true);
    });

    test('through the hook: ask without auto mode exits 0 with an ask', () => {
      writeConfig(dir, { [guard.key]: 'ask', auto_advance: false });
      const r = runHook(path.join(HOOKS_DIR, guard.file), [], {
        input: JSON.stringify(guard.payload(dir)),
        cwd: dir,
        timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
      assert.equal(out.unattended, undefined);
    });
  });
}

describe('unattended ask — the shared decision', () => {
  test('askOrDeny maps each mode, and only an ask under auto mode is marked', () => {
    assert.deepEqual(askOrDeny('ask', '/p', 'r', () => false), { action: 'ask', reason: 'r', unattended: false });
    assert.deepEqual(askOrDeny('deny', '/p', 'r', () => true), { action: 'deny', reason: 'r', unattended: false });
    const auto = askOrDeny('ask', '/p', 'r', () => true);
    assert.equal(auto.action, 'deny');
    assert.equal(auto.unattended, true);
  });

  test('a project the auto-mode reader cannot read counts as manual (the ask stands)', (t) => {
    const dir = createTempDir('gsd-unattended-');
    t.after(() => cleanup(dir));
    assert.equal(autoRunActive(path.join(dir, 'no-such-project')), false);
  });
});
