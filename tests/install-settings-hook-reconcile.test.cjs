/**
 * Install reconciles the managed settings.json hooks with the current build.
 *
 * Registration is only-if-absent, so before this a managed hook an older build
 * put on another event or matcher stayed beside the current one across every
 * reinstall — a live install kept an old PostCompact `gsd-pin-invariants`
 * entry next to the SessionStart one. Install now keeps exactly the slots
 * (event × matcher × managed script) the build registers; uninstall strips every
 * managed hook. Both go through filterManagedSettingsHooks, so a user hook that
 * shares an entry with a managed one survives either way (#1755).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup, scrubConfigLocationEnv } = require('./helpers.cjs');
const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const { install, finishInstall } = require('../bin/install.js');

const USER_HOOK = { type: 'command', command: 'echo user-owned-hook' };

/** Commands registered under `event` whose text names `name`. */
function commandsNaming(settings, event, name) {
  return ((settings.hooks || {})[event] || [])
    .flatMap((entry) => (entry && Array.isArray(entry.hooks) ? entry.hooks : []))
    .map((h) => h && h.command)
    .filter((command) => typeof command === 'string' && command.includes(name));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

/** Persist an install result the way installAllRuntimes does. */
function finish(result, isGlobal) {
  finishInstall(result.settingsPath, result.settings, result.statuslineCommand, false, result.runtime, isGlobal, result.configDir, {
    configuredEntrypoints: result.configuredEntrypoints,
  });
}

/** HOME, cwd and every config-location env var point into a fresh temp tree. */
function sandbox() {
  const state = {};
  beforeEach(() => {
    state.root = createTempDir('gsd-hook-reconcile-');
    state.saved = { home: process.env.HOME, userProfile: process.env.USERPROFILE, cwd: process.cwd() };
    process.env.HOME = state.root;
    process.env.USERPROFILE = state.root;
    state.restoreEnv = scrubConfigLocationEnv();
    state.userDir = path.join(state.root, '.claude');
    state.project = path.join(state.root, 'project');
    fs.mkdirSync(state.project, { recursive: true });
    process.chdir(state.project);
  });
  afterEach(() => {
    process.chdir(state.saved.cwd);
    state.restoreEnv();
    if (state.saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = state.saved.home;
    if (state.saved.userProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = state.saved.userProfile;
    cleanup(state.root);
  });
  return state;
}

describe('global Claude install retires managed hooks the build no longer registers', () => {
  const box = sandbox();

  test('a PostCompact pin left by an older install goes; the user hook in its entry and the one SessionStart pin stay', () => {
    const pinCommand = hooksSurface.buildHookCommand(box.userDir, 'gsd-pin-invariants.js', { runtime: 'claude' });
    writeJson(path.join(box.userDir, 'settings.json'), {
      hooks: {
        PostCompact: [{ hooks: [USER_HOOK, { type: 'command', command: pinCommand }] }],
        SessionStart: [{ hooks: [{ type: 'command', command: pinCommand }] }],
      },
    });

    const { settings } = install(true, 'claude');

    assert.deepEqual(settings.hooks.PostCompact, [{ hooks: [USER_HOOK] }]);
    assert.equal(commandsNaming(settings, 'SessionStart', 'gsd-pin-invariants.js').length, 1);
  });

  test('a duplicate of a registered slot goes, and the first copy is the one kept', () => {
    const pinCommand = hooksSurface.buildHookCommand(box.userDir, 'gsd-pin-invariants.js', { runtime: 'claude' });
    const first = { type: 'command', command: pinCommand };
    writeJson(path.join(box.userDir, 'settings.json'), {
      hooks: { SessionStart: [{ hooks: [first] }, { hooks: [{ ...first }, USER_HOOK] }] },
    });

    const { settings } = install(true, 'claude');

    assert.equal(commandsNaming(settings, 'SessionStart', 'gsd-pin-invariants.js').length, 1);
    assert.deepEqual(settings.hooks.SessionStart[0], { hooks: [first] });
    assert.deepEqual(settings.hooks.SessionStart[1], { hooks: [USER_HOOK] });
  });

  test('a managed hook on a matcher the build no longer uses is re-registered on the current one', () => {
    const guardCommand = hooksSurface.buildHookCommand(box.userDir, 'gsd-prohibition-guard.js', { runtime: 'claude' });
    writeJson(path.join(box.userDir, 'settings.json'), {
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: guardCommand }] }] },
    });

    const { settings } = install(true, 'claude');

    const matchers = settings.hooks.PreToolUse
      .filter((entry) => entry.hooks.some((h) => String(h.command).includes('gsd-prohibition-guard.js')))
      .map((entry) => entry.matcher);
    assert.deepEqual(matchers, ['Write|Edit|MultiEdit']);
  });

  test('a reinstall leaves settings.json byte-identical', () => {
    writeJson(path.join(box.userDir, 'settings.json'), {
      hooks: { PostCompact: [{ hooks: [USER_HOOK] }], SessionStart: [{ hooks: [USER_HOOK] }] },
    });
    const first = install(true, 'claude');
    finish(first, true);
    const afterFirst = fs.readFileSync(first.settingsPath, 'utf8');

    finish(install(true, 'claude'), true);

    assert.equal(fs.readFileSync(first.settingsPath, 'utf8'), afterFirst);
  });
});

describe('local Claude install reconciles its own layer only', () => {
  const box = sandbox();

  test('the user layer is not touched, and a hook it already carries is not registered for the project (M2)', () => {
    const userSettingsPath = path.join(box.userDir, 'settings.json');
    // gsd-worktree-provision.js counts as a user-layer registration only when
    // the script it names exists (findUserLayerWorktreeProvision).
    const provision = path.join(box.userDir, 'hooks', 'gsd-worktree-provision.js');
    fs.mkdirSync(path.dirname(provision), { recursive: true });
    fs.writeFileSync(provision, '// stub\n');
    const userCommand = (file) => hooksSurface.buildHookCommand(box.userDir, file, { runtime: 'claude' });
    writeJson(userSettingsPath, {
      hooks: {
        PostCompact: [{ hooks: [{ type: 'command', command: userCommand('gsd-pin-invariants.js') }] }],
        WorktreeCreate: [{ hooks: [{ type: 'command', command: userCommand('gsd-worktree-provision.js') }] }],
      },
    });
    const userBefore = fs.readFileSync(userSettingsPath, 'utf8');
    const projectPin = '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-pin-invariants.js';
    writeJson(path.join(box.project, '.claude', 'settings.local.json'), {
      hooks: { PostCompact: [{ hooks: [{ type: 'command', command: `node ${projectPin}` }, USER_HOOK] }] },
    });

    const result = install(false, 'claude');
    finish(result, false);

    assert.equal(fs.readFileSync(userSettingsPath, 'utf8'), userBefore);
    const project = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8'));
    assert.deepEqual(project.hooks.PostCompact, [{ hooks: [USER_HOOK] }]);
    assert.equal(commandsNaming(project, 'SessionStart', 'gsd-pin-invariants.js').length, 1);
    assert.equal(commandsNaming(project, 'WorktreeCreate', 'gsd-worktree-provision.js').length, 0);
  });
});

describe('other settings.json runtimes reconcile too', () => {
  const box = sandbox();

  test('a Claude-only managed hook in a Qwen settings.json is removed; the user hook beside it stays', () => {
    const qwenDir = path.join(box.root, '.qwen');
    const exitGate = hooksSurface.buildHookCommand(qwenDir, 'gsd-exit-gate.js', { runtime: 'qwen' });
    writeJson(path.join(qwenDir, 'settings.json'), {
      hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: exitGate }, USER_HOOK] }] },
    });

    const { settings } = install(true, 'qwen');

    assert.equal(commandsNaming(settings, 'SubagentStop', 'gsd-exit-gate.js').length, 0);
    assert.equal(commandsNaming(settings, 'SubagentStop', 'echo user-owned-hook').length, 1);
  });
});

describe('reconcileManagedSettingsHooks', () => {
  const managed = (file) => ({ type: 'command', command: `node /cfg/hooks/${file}` });

  test('a registration of a script the build does not register is removed, with the event it leaves empty', () => {
    const settings = {
      hooks: {
        WorktreeCreate: [{ hooks: [managed('gsd-worktree-provision.js')] }],
        SessionStart: [{ hooks: [managed('gsd-check-update.js')] }],
      },
    };
    const desired = { hooks: { SessionStart: [{ hooks: [managed('gsd-check-update.js')] }] } };

    assert.equal(hooksSurface.reconcileManagedSettingsHooks(settings, desired), true);
    assert.deepEqual(settings, desired);
  });

  test('the opt-in update banner is kept on SessionStart, and only there', () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [managed('gsd-update-banner.js')] }],
        Stop: [{ hooks: [managed('gsd-update-banner.js'), USER_HOOK] }],
      },
    };

    hooksSurface.reconcileManagedSettingsHooks(settings, { hooks: {} });

    assert.deepEqual(settings.hooks, {
      SessionStart: [{ hooks: [managed('gsd-update-banner.js')] }],
      Stop: [{ hooks: [USER_HOOK] }],
    });
  });

  test('a dry run that wrote no hooks block reconciles nothing', () => {
    const settings = { hooks: { PostCompact: [{ hooks: [managed('gsd-pin-invariants.js')] }] } };
    const before = structuredClone(settings);

    assert.equal(hooksSurface.reconcileManagedSettingsHooks(settings, {}), false);
    assert.deepEqual(settings, before);
  });

  test('matching ignores timeout and command form: a registered slot already in place is not changed', () => {
    const settings = { hooks: { SessionStart: [{ hooks: [managed('gsd-pin-invariants.js')] }] } };
    const before = structuredClone(settings);
    const desired = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"/other/node" "/cfg/hooks/gsd-pin-invariants.js"', timeout: hooksSurface.BLOCKING_GUARD_TIMEOUT_S }] }] } };

    assert.equal(hooksSurface.reconcileManagedSettingsHooks(settings, desired), false);
    assert.deepEqual(settings, before);
  });
});
