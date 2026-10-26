'use strict';

/**
 * Fork (mn): `applySettingsJsonHooks` is upstream's table registration (#5207) followed by the
 * fork's Claude-only enforcement layer (prohibition guard, test-tamper guard, exit gate, invariant
 * pin, worktree provisioning) — .plans/sync-1.18/zone-2.md.
 *
 * tests/hook-registration-table.test.cjs pins the TABLES against upstream's pre-migration golden;
 * this file pins the composition against the same golden, so neither half can drift unseen:
 *   - off Claude the fork layer adds nothing: the entry point reproduces the golden exactly;
 *   - on Claude, with no fork hook installed (the scenarios install only upstream's hooks), the
 *     settings, the registered slots and stdout are the golden's — the layer touches no upstream
 *     registration and adds none without its file — and the quiet dry run prints nothing at all;
 *   - with the fork hooks installed, every one of them is registered.
 * The user settings layer is sandboxed: the worktree step reads it (one registration per user).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const surface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
const scenarios = require('./fixtures/hook-registration/run-scenarios.cjs');
const golden = require('./fixtures/hook-registration/golden.json');

const FORK_HOOK_FILES = [...new Set(surface.FORK_ENFORCEMENT_SLOTS.map((s) => s.file))];
const tableEvent = (event) => (event === 'PreToolUse' || event === 'BeforeTool' ? 'pre' : event);

/** Registered commands of a settings object, as `<event>:<hook file>`. */
function registeredSlots(settings) {
  const slots = [];
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    for (const group of groups) {
      for (const h of group.hooks || []) {
        const m = /(gsd-[a-z-]+\.(?:js|sh))"?$/.exec(h.command);
        if (m) slots.push(`${event}:${m[1]}`);
      }
    }
  }
  return slots.sort();
}

describe('mn hook registration layer — applySettingsJsonHooks = tables + fork layer', () => {
  let userLayer;
  let savedConfigDir;

  beforeEach(() => {
    userLayer = createTempDir('gsd-mn-hookreg-user-');
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = userLayer;
  });
  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    cleanup(userLayer);
  });

  for (const rt of scenarios.settingsJsonRuntimes()) {
    test(`${rt.id}: the entry point reproduces the table golden in every scenario`, () => {
      for (const [name, spec] of Object.entries(scenarios.scenarioSpecs(rt))) {
        const actual = scenarios.runOne(rt, spec, surface.applySettingsJsonHooks);
        const expected = golden[rt.id][name];
        if (rt.id !== 'claude') {
          assert.deepEqual(actual, expected, `${rt.id} ${name}`);
          continue;
        }
        assert.deepEqual(actual.settings, expected.settings, `${name}: the fork layer changed a registration`);
        assert.equal(actual.stdout, expected.stdout, `${name}: stdout`);
        assert.deepEqual(registeredSlots(actual.settings), registeredSlots(expected.settings), `${name}: no fork slot without its file`);
        // The dry run the installer makes (quiet): the same registrations and not one line of output.
        const quiet = scenarios.runOne(rt, spec, (settings, opts) => surface.applySettingsJsonHooks(settings, { ...opts, quiet: true }));
        assert.deepEqual(quiet.settings, expected.settings, `${name}: quiet changes what is registered`);
        // runOne separates repeated runs with its own `--- run N ---` line; nothing else may appear.
        const printed = (text) => text.split('\n').filter((line) => line !== '' && !/^--- run \d+ ---$/.test(line));
        assert.deepEqual([printed(quiet.stdout), printed(quiet.stderr)], [[], []], `${name}: quiet prints`);
      }
    });
  }

  test('claude: with the fork hooks installed every one of them is registered beside the golden', () => {
    const rt = scenarios.settingsJsonRuntimes().find((r) => r.id === 'claude');
    for (const isGlobal of [false, true]) {
      const scope = isGlobal ? 'global' : 'local';
      const spec = { isGlobal, present: [...scenarios.ALL_HOOKS, ...FORK_HOOK_FILES] };
      const actual = scenarios.runOne(rt, spec, surface.applySettingsJsonHooks);
      const base = registeredSlots(golden.claude[`${scope}/all-present`].settings);
      const added = registeredSlots(actual.settings).filter((s) => !base.includes(s));
      // Exactly the declared slots: FORK_ENFORCEMENT_SLOTS is what census tests (hook-activation-probe)
      // derive the fork's registrations from, so it must be what the layer registers.
      const declared = surface.FORK_ENFORCEMENT_SLOTS.map((slot) => `${slot.event}:${slot.file}`).sort();
      assert.deepEqual(added.map((a) => { const [event, file] = a.split(':'); return `${tableEvent(event)}:${file}`; }).sort(), declared, scope);
      for (const slot of base) assert.ok(registeredSlots(actual.settings).includes(slot), `${scope}: lost ${slot}`);
    }
  });

  test('the sandboxed user layer is the one read (a user-level provision defers the project one)', () => {
    const rt = scenarios.settingsJsonRuntimes().find((r) => r.id === 'claude');
    fs.writeFileSync(path.join(userLayer, 'settings.json'), JSON.stringify({
      hooks: { WorktreeCreate: [{ hooks: [{ type: 'command', command: 'node /u/hooks/gsd-worktree-provision.js' }] }] },
    }));
    const spec = { isGlobal: false, present: [...scenarios.ALL_HOOKS, ...FORK_HOOK_FILES] };
    const actual = scenarios.runOne(rt, spec, surface.applySettingsJsonHooks);
    assert.equal(registeredSlots(actual.settings).some((s) => s.endsWith('gsd-worktree-provision.js')), false);
  });
});
