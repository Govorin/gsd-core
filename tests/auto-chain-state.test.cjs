'use strict';

/**
 * X5 — the auto-chain flag is run state, not configuration.
 *
 * Every `--auto` / `--chain` workflow used to flip `workflow._auto_chain_active` in the versioned
 * `.planning/config.json` through `config-set`, so an autonomous run left the tree dirty in every
 * project. The flag now lives in `<project>/.gsd/auto-chain/<scope>/active.json` (the tool-owned,
 * locally ignored run directory the dispatch-isolation sentinel already uses), written through
 * `gsd-tools auto-chain set|clear` and read back by `auto-chain status` and `check auto-mode`.
 *
 * Contract pinned here, all through the real CLI:
 *   - set/clear/status round-trip, idempotent, and `check auto-mode` keeps its public shape;
 *   - the versioned tree stays clean (git status, untracked files included) across a chain;
 *   - the retired config key is never read, and set/clear delete it (scope + root config) without
 *     touching a config that never had it;
 *   - `config-set workflow._auto_chain_active` is refused with a typed reason;
 *   - workstream scoping: a chain in one workstream is not active in another, nor at the root;
 *   - a damaged record (malformed, symlinked) reads inactive; a symlinked `.gsd` is refused.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { runGit } = require('./helpers/process-seam.cjs');
const { GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');

const STATE = path.join('.gsd', 'auto-chain', 'active.json');

function run(dir, args, env = {}) {
  return runGsdTools(args, dir, { HOME: dir, USERPROFILE: dir, ...env });
}

function json(dir, args, env) {
  const result = run(dir, args, env);
  assert.equal(result.success, true, result.error);
  return JSON.parse(result.output);
}

function autoMode(dir, env) {
  return json(dir, ['check', 'auto-mode'], env);
}

function writeConfig(dir, config, rel = '.planning') {
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  fs.writeFileSync(path.join(dir, rel, 'config.json'), JSON.stringify(config, null, 2));
}

function readConfig(dir, rel = '.planning') {
  return JSON.parse(fs.readFileSync(path.join(dir, rel, 'config.json'), 'utf8'));
}

function gitStatus(dir) {
  const status = runGit(['status', '--porcelain', '--untracked-files=all'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  assert.equal(status.exitCode, 0, status.stderr);
  return status.stdout.trim();
}

describe('auto-chain set|clear|status', () => {
  test('set records the chain, check auto-mode reports it, clear removes it', (t) => {
    const dir = createTempProject('gsd-x5-roundtrip-');
    t.after(() => cleanup(dir));

    assert.deepEqual(json(dir, ['auto-chain', 'status']), { active: false, scope: '', path: '.gsd/auto-chain/active.json', since: null });

    const set = json(dir, ['query', 'auto-chain', 'set']);
    assert.equal(set.active, true);
    assert.equal(set.changed, true);
    assert.deepEqual(set.legacy_cleaned, []);
    assert.equal(typeof set.since, 'string');
    assert.ok(fs.existsSync(path.join(dir, STATE)));
    assert.deepEqual(autoMode(dir), { active: true, source: 'auto_chain', auto_chain_active: true, auto_advance: false });

    const clear = json(dir, ['auto-chain', 'clear']);
    assert.equal(clear.active, false);
    assert.equal(clear.changed, true);
    assert.equal(fs.existsSync(path.join(dir, STATE)), false);
    assert.deepEqual(autoMode(dir), { active: false, source: 'none', auto_chain_active: false, auto_advance: false });
  });

  test('set and clear are idempotent; a second set keeps the original since', (t) => {
    const dir = createTempProject('gsd-x5-idempotent-');
    t.after(() => cleanup(dir));

    const first = json(dir, ['auto-chain', 'set']);
    const second = json(dir, ['auto-chain', 'set']);
    assert.equal(second.changed, false);
    assert.equal(second.since, first.since);

    assert.equal(json(dir, ['auto-chain', 'clear']).changed, true);
    const again = json(dir, ['auto-chain', 'clear']);
    assert.equal(again.changed, false);
    assert.equal(again.active, false);
  });

  test('--raw prints the boolean, as workflows and --pick consume it', (t) => {
    const dir = createTempProject('gsd-x5-raw-');
    t.after(() => cleanup(dir));

    assert.equal(run(dir, ['auto-chain', 'status', '--raw']).output, 'false');
    assert.equal(run(dir, ['auto-chain', 'set', '--raw']).output, 'true');
    assert.equal(run(dir, ['check', 'auto-mode', '--pick', 'auto_chain_active']).output, 'true');
    assert.equal(run(dir, ['auto-chain', 'clear', '--raw']).output, 'false');
  });

  test('both sources on -> source both (auto_advance stays configuration)', (t) => {
    const dir = createTempProject('gsd-x5-both-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { workflow: { auto_advance: true } });

    json(dir, ['auto-chain', 'set']);
    assert.deepEqual(autoMode(dir), { active: true, source: 'both', auto_chain_active: true, auto_advance: true });
  });

  test('an unknown subcommand, a missing one, or an extra argument is a usage error', (t) => {
    const dir = createTempProject('gsd-x5-usage-');
    t.after(() => cleanup(dir));

    for (const args of [['auto-chain', 'bogus'], ['auto-chain'], ['auto-chain', 'set', 'true']]) {
      const result = run(dir, ['--json-errors', ...args]);
      assert.equal(result.success, false, args.join(' '));
      assert.equal(JSON.parse(result.error).reason, 'usage', args.join(' '));
    }
    assert.equal(fs.existsSync(path.join(dir, '.gsd')), false, 'a refused call writes nothing');
  });
});

describe('the versioned tree stays clean', () => {
  test('a whole chain (set, read, clear) leaves git status empty, untracked files included', (t) => {
    const dir = createTempGitProject('gsd-x5-clean-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { workflow: { auto_advance: false } });
    runGit(['add', '-A'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    runGit(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'config'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    assert.equal(gitStatus(dir), '');

    json(dir, ['auto-chain', 'set']);
    assert.equal(autoMode(dir).active, true);
    assert.equal(gitStatus(dir), '', 'an active chain must not show in git status');

    json(dir, ['auto-chain', 'clear']);
    assert.equal(gitStatus(dir), '');
  });

  test('an existing .gsd/.gitignore without "*" gains the auto-chain rules once', (t) => {
    const dir = createTempGitProject('gsd-x5-ignore-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.gsd'));
    fs.writeFileSync(path.join(dir, '.gsd', '.gitignore'), '!keep.txt\n');
    fs.writeFileSync(path.join(dir, '.gsd', 'keep.txt'), 'keep\n');

    json(dir, ['auto-chain', 'set']);
    json(dir, ['auto-chain', 'clear']);
    json(dir, ['auto-chain', 'set']);

    const ignore = fs.readFileSync(path.join(dir, '.gsd', '.gitignore'), 'utf8');
    assert.ok(ignore.startsWith('!keep.txt\n'));
    assert.equal(ignore.match(/# gsd-core auto-chain state/g)?.length, 1);
    const status = gitStatus(dir).split('\n').filter((l) => l.includes('.gsd/'));
    assert.deepEqual(status, ['?? .gsd/keep.txt']);
  });
});

describe('the retired workflow._auto_chain_active config key', () => {
  test('a legacy true in config.json is not read (no second source)', (t) => {
    const dir = createTempProject('gsd-x5-legacy-read-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { workflow: { _auto_chain_active: true } });

    assert.deepEqual(autoMode(dir), { active: false, source: 'none', auto_chain_active: false, auto_advance: false });
    assert.equal(json(dir, ['auto-chain', 'status']).active, false);
  });

  for (const verb of ['set', 'clear']) {
    test(`auto-chain ${verb} deletes the legacy key and keeps every other key`, (t) => {
      const dir = createTempProject(`gsd-x5-legacy-${verb}-`);
      t.after(() => cleanup(dir));
      writeConfig(dir, { mode: 'yolo', workflow: { auto_advance: false, _auto_chain_active: true, research: true } });

      const result = json(dir, ['auto-chain', verb]);
      assert.deepEqual(result.legacy_cleaned, ['.planning/config.json']);
      assert.deepEqual(readConfig(dir), { mode: 'yolo', workflow: { auto_advance: false, research: true } });
      assert.deepEqual(json(dir, ['auto-chain', verb]).legacy_cleaned, [], 'cleanup happens once');
    });
  }

  test('a config without the key is left byte-identical', (t) => {
    const dir = createTempProject('gsd-x5-legacy-absent-');
    t.after(() => cleanup(dir));
    const configPath = path.join(dir, '.planning', 'config.json');
    const original = '{"workflow":{"auto_advance":false}}\n';
    fs.writeFileSync(configPath, original);

    json(dir, ['auto-chain', 'set']);
    json(dir, ['auto-chain', 'clear']);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
  });

  test('inside a workstream, both the workstream config and the root config are cleaned', (t) => {
    const dir = createTempProject('gsd-x5-legacy-ws-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { workflow: { _auto_chain_active: false } });
    writeConfig(dir, { workflow: { _auto_chain_active: true } }, path.join('.planning', 'workstreams', 'alpha'));

    const result = json(dir, ['auto-chain', 'clear', '--ws', 'alpha']);
    assert.deepEqual(result.legacy_cleaned.sort(), ['.planning/config.json', '.planning/workstreams/alpha/config.json']);
    assert.deepEqual(readConfig(dir), { workflow: {} });
    assert.deepEqual(readConfig(dir, path.join('.planning', 'workstreams', 'alpha')), { workflow: {} });
  });

  test('config-set refuses the key with a typed reason and writes nothing', (t) => {
    const dir = createTempProject('gsd-x5-config-set-');
    t.after(() => cleanup(dir));
    writeConfig(dir, { workflow: { auto_advance: false } });
    const before = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');

    for (const value of ['true', 'false']) {
      const result = run(dir, ['--json-errors', 'config-set', 'workflow._auto_chain_active', value]);
      assert.equal(result.success, false);
      assert.equal(JSON.parse(result.error).reason, 'config_invalid_key');
    }
    assert.equal(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'), before);
  });
});

describe('workstream scope', () => {
  test('a chain set in one workstream is inactive in another and at the root', (t) => {
    const dir = createTempProject('gsd-x5-ws-');
    t.after(() => cleanup(dir));
    for (const ws of ['alpha', 'beta']) fs.mkdirSync(path.join(dir, '.planning', 'workstreams', ws), { recursive: true });

    const set = json(dir, ['auto-chain', 'set', '--ws', 'alpha']);
    assert.equal(set.scope, 'workstreams/alpha');
    assert.equal(set.path, '.gsd/auto-chain/workstreams/alpha/active.json');

    assert.equal(json(dir, ['auto-chain', 'status', '--ws', 'alpha']).active, true);
    assert.equal(autoMode(dir, { GSD_WORKSTREAM: 'alpha' }).auto_chain_active, true);
    assert.equal(json(dir, ['auto-chain', 'status', '--ws', 'beta']).active, false);
    assert.equal(autoMode(dir, { GSD_WORKSTREAM: 'beta' }).auto_chain_active, false);
    assert.equal(json(dir, ['auto-chain', 'status']).active, false, 'no workstream -> root fallback either way');

    json(dir, ['auto-chain', 'clear', '--ws', 'beta']);
    assert.equal(json(dir, ['auto-chain', 'status', '--ws', 'alpha']).active, true, 'clearing beta leaves alpha running');
  });
});

describe('a damaged record fails toward asking a human', () => {
  for (const [label, content] of [['malformed JSON', '{not json'], ['active not true', '{"active":"yes"}'], ['empty file', '']]) {
    test(`${label} reads inactive`, (t) => {
      const dir = createTempProject('gsd-x5-damaged-');
      t.after(() => cleanup(dir));
      fs.mkdirSync(path.dirname(path.join(dir, STATE)), { recursive: true });
      fs.writeFileSync(path.join(dir, STATE), content);
      assert.equal(autoMode(dir).auto_chain_active, false);
    });
  }

  test('a symlinked state file reads inactive and clear removes the link, not its target', (t) => {
    const dir = createTempProject('gsd-x5-link-file-');
    const outside = createTempDir('gsd-x5-link-target-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    const target = path.join(outside, 'forged.json');
    fs.writeFileSync(target, '{"active":true}');
    fs.mkdirSync(path.dirname(path.join(dir, STATE)), { recursive: true });
    try {
      fs.symlinkSync(target, path.join(dir, STATE), 'file');
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip(`symlink unavailable: ${err.code}`);
      throw err;
    }

    assert.equal(autoMode(dir).auto_chain_active, false);
    json(dir, ['auto-chain', 'clear']);
    assert.equal(fs.existsSync(path.join(dir, STATE)), false);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"active":true}');
  });

  test('a symlinked .gsd directory is refused and nothing is written through it', (t) => {
    const dir = createTempProject('gsd-x5-link-dir-');
    const outside = createTempDir('gsd-x5-link-outside-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    try {
      fs.symlinkSync(outside, path.join(dir, '.gsd'), 'junction');
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip(`symlink unavailable: ${err.code}`);
      throw err;
    }

    const result = run(dir, ['auto-chain', 'set']);
    assert.equal(result.success, false);
    assert.deepEqual(fs.readdirSync(outside), []);
  });
});
