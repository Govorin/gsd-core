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

    assert.deepEqual(json(dir, ['auto-chain', 'status']), {
      active: false, scope: '', path: '.gsd/auto-chain/active.json', owner: null, since: null, expires_at: null,
    });

    const set = json(dir, ['query', 'auto-chain', 'set']);
    assert.equal(set.active, true);
    assert.equal(set.owner, 'chain');
    assert.equal(typeof set.expires_at, 'string', 'every record lapses unless refreshed');
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

describe('an autonomous run holds the chain for its whole length', () => {
  // /gsd:autonomous calls plan-phase and execute-phase WITHOUT --auto; their manual-invocation
  // guard (`auto-chain clear`) and transition.md's boundary clear must not end the run under it,
  // because hooks read check auto-mode's `active` to decide whether a human can be asked.
  const NESTED_CLEARS = [
    ['plan-phase auto-advance-check, no --auto/--chain', ['auto-chain', 'clear']],
    ['execute-phase chain sync, no --auto', ['query', 'auto-chain', 'clear']],
    ['transition.md milestone boundary', ['auto-chain', 'clear']],
  ];

  test('active stays true through every nested clear and plain set; only the autonomous release ends it', (t) => {
    const dir = createTempProject('gsd-x5-autonomous-');
    t.after(() => cleanup(dir));
    const { readAutoModeState } = require('../gsd-core/bin/lib/check-auto-mode.cjs');

    const hold = json(dir, ['auto-chain', 'set', '--owner', 'autonomous']);
    assert.equal(hold.owner, 'autonomous');
    assert.equal(typeof hold.expires_at, 'string');
    assert.equal(readAutoModeState(dir).active, true);

    for (const [label, args] of NESTED_CLEARS) {
      const result = json(dir, args);
      assert.equal(result.changed, false, `${label} must not release the hold`);
      assert.equal(result.held_by, 'autonomous', `${label} reports who holds the run`);
      assert.equal(readAutoModeState(dir).active, true, `${label}: active stays true`);
      assert.equal(autoMode(dir).active, true, `${label}: check auto-mode agrees`);
    }

    const plainSet = json(dir, ['auto-chain', 'set']);
    assert.equal(plainSet.owner, 'autonomous', 'a nested --auto set does not downgrade the hold');
    assert.equal(plainSet.changed, false);

    const release = json(dir, ['auto-chain', 'clear', '--owner=autonomous']);
    assert.equal(release.active, false);
    assert.equal(release.changed, true);
    assert.equal(readAutoModeState(dir).active, false);
  });

  test('autonomous takes over a chain record, keeps its since on refresh, and an invalid owner is a usage error', (t) => {
    const dir = createTempProject('gsd-x5-autonomous-refresh-');
    t.after(() => cleanup(dir));

    json(dir, ['auto-chain', 'set']);
    const first = json(dir, ['auto-chain', 'set', '--owner', 'autonomous']);
    assert.equal(first.owner, 'autonomous');
    assert.equal(first.changed, true);
    const refreshed = json(dir, ['auto-chain', 'set', '--owner', 'autonomous']);
    assert.equal(refreshed.since, first.since);
    assert.equal(refreshed.changed, false);

    const bad = run(dir, ['--json-errors', 'auto-chain', 'set', '--owner', 'robot']);
    assert.equal(bad.success, false);
    assert.equal(JSON.parse(bad.error).reason, 'usage');
  });

  test('the hold is scoped like any record: --ws on set and release', (t) => {
    const dir = createTempProject('gsd-x5-autonomous-ws-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });

    json(dir, ['auto-chain', 'set', '--owner', 'autonomous', '--ws=alpha']);
    assert.equal(autoMode(dir, { GSD_WORKSTREAM: 'alpha' }).active, true);
    assert.equal(autoMode(dir).active, false);
    json(dir, ['auto-chain', 'clear', '--ws=alpha']);
    assert.equal(autoMode(dir, { GSD_WORKSTREAM: 'alpha' }).active, true, 'a nested plain clear in the workstream keeps it');
    json(dir, ['auto-chain', 'clear', '--owner', 'autonomous', '--ws=alpha']);
    assert.equal(autoMode(dir, { GSD_WORKSTREAM: 'alpha' }).active, false);
  });

});

describe('a record a dead run left behind is not active (when in doubt, ask the human)', () => {
  const lib = () => require('../gsd-core/bin/lib/auto-chain-state.cjs');
  const T0 = Date.parse('2026-06-01T00:00:00.000Z');
  const alive = () => true;

  function record(dir, fields) {
    const file = path.join(dir, STATE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ active: true, since: new Date(T0).toISOString(), touched_at: new Date(T0).toISOString(), ...fields }));
  }

  for (const owner of ['chain', 'autonomous']) {
    for (const [label, ageDelta, active] of [['limit-1', -1, true], ['limit', 0, false], ['limit+1', 1, false]]) {
      test(`${owner}: age ${label} of RUN_STATE_TTL_MS -> ${active ? 'active' : 'lapsed'}`, (t) => {
        const dir = createTempProject('gsd-x5-ttl-');
        t.after(() => cleanup(dir));
        const { RUN_STATE_TTL_MS, readAutoChainActive, readAutoChainState } = lib();
        record(dir, { owner });
        const now = () => new Date(T0 + RUN_STATE_TTL_MS + ageDelta);
        assert.equal(readAutoChainActive(dir, { now, isAlive: alive }), active);
        assert.equal(readAutoChainState(dir, { now, isAlive: alive }).owner, active ? owner : null);
      });
    }
  }

  test('a record whose holder process is gone lapses at once; a live holder keeps it', (t) => {
    const dir = createTempProject('gsd-x5-holder-');
    t.after(() => cleanup(dir));
    const { readAutoChainActive } = lib();
    const now = () => new Date(T0 + 1000);
    record(dir, { owner: 'autonomous', holder_pid: 4242 });
    assert.equal(readAutoChainActive(dir, { now, isAlive: (pid) => pid !== 4242 }), false, 'dead holder');
    assert.equal(readAutoChainActive(dir, { now, isAlive: (pid) => pid === 4242 }), true, 'live holder');
    record(dir, { owner: 'autonomous', holder_pid: process.pid });
    assert.equal(readAutoChainActive(dir, { now }), true, 'the default liveness probe sees a live process');
  });

  test('set records the runtime process from CLAUDE_PID, and none without it', (t) => {
    const dir = createTempProject('gsd-x5-holder-set-');
    t.after(() => cleanup(dir));
    const readRaw = () => JSON.parse(fs.readFileSync(path.join(dir, STATE), 'utf8'));
    json(dir, ['auto-chain', 'set', '--owner', 'autonomous'], { CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: 'sess-1' });
    assert.equal(readRaw().holder_pid, process.pid);
    assert.equal(readRaw().session, 'sess-1');
    json(dir, ['auto-chain', 'set', '--owner', 'autonomous'], { CLAUDE_PID: '' });
    assert.equal(readRaw().holder_pid, null, 'no runtime pid: only the TTL applies');
    assert.equal(autoMode(dir).active, true);
  });

  test('a lapsed hold no longer blocks a plain clear, and expires_at names the deadline', (t) => {
    const dir = createTempProject('gsd-x5-ttl-clear-');
    t.after(() => cleanup(dir));
    const { RUN_STATE_TTL_MS, setAutoChain, readAutoChainState } = lib();
    record(dir, { owner: 'autonomous' });
    assert.equal(readAutoChainState(dir, { now: () => new Date(T0), isAlive: alive }).expires_at, new Date(T0 + RUN_STATE_TTL_MS).toISOString());
    const cleared = setAutoChain(dir, false, { now: () => new Date(T0 + RUN_STATE_TTL_MS), isAlive: alive });
    assert.equal(cleared.held_by, null);
    assert.equal(fs.existsSync(path.join(dir, STATE)), false);
  });

  for (const [label, fields] of [['no touched_at', { touched_at: undefined }], ['an unparseable touched_at', { touched_at: 'yesterday' }]]) {
    test(`a record with ${label} is not active`, (t) => {
      const dir = createTempProject('gsd-x5-ttl-missing-');
      t.after(() => cleanup(dir));
      record(dir, { owner: 'autonomous', ...fields });
      assert.equal(lib().readAutoChainActive(dir, { isAlive: alive }), false);
    });
  }
});

describe('a reader in a linked worktree sees the main checkout\'s run', () => {
  function gitOk(args, cwd) {
    const r = runGit(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    return r;
  }

  for (const committedPlanning of [false, true]) {
    test(`state set in main -> active from the worktree (worktree ${committedPlanning ? 'with' : 'without'} its own .planning)`, (t) => {
      const main = createTempGitProject('gsd-x5-wt-main-');
      const wtParent = createTempDir('gsd-x5-wt-');
      t.after(() => { cleanup(main); cleanup(wtParent); });
      const wt = path.join(wtParent, 'wt');
      gitOk(['worktree', 'add', '-q', '-b', 'agent-x5', wt], main);
      // The fixture commits .planning/ (commit_docs); a project that ignores it has none in the worktree.
      if (!committedPlanning) cleanup(path.join(wt, '.planning'));
      assert.equal(fs.existsSync(path.join(wt, '.planning')), committedPlanning);

      json(main, ['auto-chain', 'set', '--owner', 'autonomous']);
      const { readAutoModeState } = require('../gsd-core/bin/lib/check-auto-mode.cjs');
      assert.equal(readAutoModeState(wt).active, true, 'in-process reader (the guard hook path)');
      assert.equal(autoMode(wt).active, true, 'CLI reader from the worktree');
      assert.equal(fs.existsSync(path.join(wt, '.gsd')), false, 'nothing is written into the worktree');

      json(main, ['auto-chain', 'clear', '--owner', 'autonomous']);
      assert.equal(readAutoModeState(wt).active, false);
    });
  }
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

describe('review fixes: who advances, who releases, whose session, which workstream (X5)', () => {
  const lib = () => require('../gsd-core/bin/lib/auto-chain-state.cjs');
  const T0 = Date.parse('2026-06-01T00:00:00.000Z');
  const alive = () => true;

  function record(dir, fields) {
    const file = path.join(dir, STATE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ active: true, owner: 'autonomous', since: new Date(T0).toISOString(), touched_at: new Date(T0).toISOString(), ...fields }));
  }

  // BLOCKER 1: an autonomous hold made `init plan-phase` report an active chain, so plan-phase's
  // step 15 launched execute-phase and autonomous then executed the phase a second time.
  test('init tells an autonomous hold from a chain, so plan-phase does not advance under autonomous', (t) => {
    const dir = createTempProject('gsd-x5-init-owner-');
    t.after(() => cleanup(dir));
    json(dir, ['auto-chain', 'set', '--owner', 'autonomous']);
    const held = json(dir, ['init', 'plan-phase', '1']);
    assert.equal(held.auto_chain_active, true, 'still active for checkpoints and hooks');
    assert.equal(held.auto_chain_owner, 'autonomous', 'step 15 advances only for owner chain');

    json(dir, ['auto-chain', 'clear', '--owner', 'autonomous']);
    json(dir, ['auto-chain', 'set']);
    assert.equal(json(dir, ['init', 'plan-phase', '1']).auto_chain_owner, 'chain');
  });

  test('the discuss-assumptions auto-advance fact ignores an autonomous hold but honours a chain', (t) => {
    const dir = createTempProject('gsd-x5-init-assumptions-');
    t.after(() => cleanup(dir));
    const included = () => json(dir, ['init', 'discuss-phase-assumptions', '99']).section_manifest.included.includes('auto-advance-dispatch');
    json(dir, ['auto-chain', 'set', '--owner', 'autonomous']);
    assert.equal(included(), false, 'autonomous drives plan itself');
    json(dir, ['auto-chain', 'clear', '--owner', 'autonomous']);
    json(dir, ['auto-chain', 'set']);
    assert.equal(included(), true, 'a chain still dispatches');
  });

  // SF2: an interrupted autonomous run must not keep a later, hand-started workflow unattended.
  test('clear --manual releases an autonomous hold and says so on stderr; a plain clear does not', (t) => {
    const dir = createTempProject('gsd-x5-manual-');
    t.after(() => cleanup(dir));
    json(dir, ['auto-chain', 'set', '--owner', 'autonomous']);
    assert.equal(json(dir, ['auto-chain', 'clear']).held_by, 'autonomous');

    const result = runGsdTools(['auto-chain', 'clear', '--manual'], dir, { HOME: dir, USERPROFILE: dir });
    assert.equal(result.success, true, result.error);
    assert.equal(JSON.parse(result.output).released, 'autonomous');
    assert.equal(autoMode(dir).active, false);

    for (const args of [['auto-chain', 'set', '--manual'], ['auto-chain', 'clear', '--manual', '--owner', 'chain']]) {
      const bad = run(dir, ['--json-errors', ...args]);
      assert.equal(bad.success, false, args.join(' '));
      assert.equal(JSON.parse(bad.error).reason, 'usage');
    }
  });

  for (const [label, recSession, readerSession, active] of [
    ['same session', 'sess-A', 'sess-A', true],
    ['another session', 'sess-A', 'sess-B', false],
    ['reader without a session (pid + TTL decide)', 'sess-A', undefined, true],
    ['record without a session (pid + TTL decide)', undefined, 'sess-B', true],
  ]) {
    test(`session: ${label} -> ${active ? 'active' : 'not active'}`, (t) => {
      const dir = createTempProject('gsd-x5-session-');
      t.after(() => cleanup(dir));
      record(dir, recSession === undefined ? {} : { session: recSession });
      const env = { ...process.env, CLAUDE_CODE_SESSION_ID: readerSession ?? '' };
      assert.equal(lib().readAutoChainActive(dir, { now: () => new Date(T0 + 1000), isAlive: alive, env }), active);
    });
  }

  // SF4: a touched_at in the future must not make a record active for ever.
  for (const [label, delta, active] of [['limit-1', -1, true], ['limit', 0, true], ['limit+1', 1, false]]) {
    test(`touched_at CLOCK_SKEW_MS ${label} in the future -> ${active ? 'active' : 'not active'}`, (t) => {
      const dir = createTempProject('gsd-x5-skew-');
      t.after(() => cleanup(dir));
      const { CLOCK_SKEW_MS, readAutoChainActive } = lib();
      record(dir, { touched_at: new Date(T0 + CLOCK_SKEW_MS + delta).toISOString() });
      assert.equal(readAutoChainActive(dir, { now: () => new Date(T0), isAlive: alive }), active);
    });
  }

  test('a symlinked .gsd directory is not read', (t) => {
    const dir = createTempProject('gsd-x5-link-read-');
    const outside = createTempDir('gsd-x5-link-read-target-');
    t.after(() => { cleanup(dir); cleanup(outside); });
    const forged = path.join(outside, 'auto-chain', 'active.json');
    fs.mkdirSync(path.dirname(forged), { recursive: true });
    fs.writeFileSync(forged, JSON.stringify({ active: true, touched_at: new Date().toISOString() }));
    try {
      fs.symlinkSync(outside, path.join(dir, '.gsd'), 'junction');
    } catch (err) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(err.code)) return t.skip(`symlink unavailable: ${err.code}`);
      throw err;
    }
    assert.equal(lib().readAutoChainActive(dir, { isAlive: alive }), false);
  });

  // SF3: guard hooks call readAutoModeState(dir) in-process; the workstream pointer must count there
  // exactly as it does for the CLI, or a workstream run reads inactive in the hooks.
  test('an in-process reader resolves the active-workstream pointer like the CLI does', (t) => {
    const dir = createTempProject('gsd-x5-pointer-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    // One pointer session for the test process and its CLI children (the key is env-first).
    const saved = { ws: process.env.GSD_WORKSTREAM, key: process.env.GSD_SESSION_KEY };
    delete process.env.GSD_WORKSTREAM;
    process.env.GSD_SESSION_KEY = `x5-pointer-${process.pid}`;
    t.after(() => {
      if (saved.ws === undefined) delete process.env.GSD_WORKSTREAM; else process.env.GSD_WORKSTREAM = saved.ws;
      if (saved.key === undefined) delete process.env.GSD_SESSION_KEY; else process.env.GSD_SESSION_KEY = saved.key;
    });
    const { setActiveWorkstream, clearActiveWorkstream } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
    setActiveWorkstream(dir, 'alpha');
    t.after(() => clearActiveWorkstream(dir));
    const env = { GSD_SESSION_KEY: process.env.GSD_SESSION_KEY };
    json(dir, ['auto-chain', 'set', '--owner', 'autonomous'], env);
    assert.equal(json(dir, ['auto-chain', 'status'], env).scope, 'workstreams/alpha', 'the CLI wrote the pointer scope');

    const { readAutoModeState } = require('../gsd-core/bin/lib/check-auto-mode.cjs');
    assert.equal(readAutoModeState(dir).active, true);
    assert.equal(lib().readAutoChainState(dir).scope, 'workstreams/alpha');
  });
});
