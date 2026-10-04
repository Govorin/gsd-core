'use strict';

/**
 * gsd-worktree-provision.js — the Claude Code WorktreeCreate / WorktreeRemove contract.
 *
 * Seam: hooks/gsd-worktree-provision.js, driven through the real stdin → stdout/exit-code
 * contract the harness consumes (process seam, real git repositories), plus its exported
 * decision functions where a typed field says more than an exit code.
 *
 * The contract (Claude Code hooks reference, "WorktreeCreate"): a WorktreeCreate hook
 * REPLACES `git worktree add`. stdin carries `name`; the hook creates the checkout and prints
 * its absolute path as the ONLY stdout; exit 0 = created, non-zero = creation fails.
 * WorktreeRemove carries `worktree_path`; the harness never deletes a hook-created branch.
 *
 * What is asserted, and why it matters:
 *   - the worktree forks from the LOCAL HEAD — never origin/HEAD, which in this fork lagged
 *     ~900 commits and handed every isolated agent a stale base;
 *   - stdout is exactly the path on success and empty on every refusal;
 *   - an invalid name / occupied path / existing branch refuses with nothing created;
 *   - an equipment failure warns by default and, under the strict policy, refuses AND rolls
 *     the half-made worktree back (a creation reported as failed must leave nothing behind);
 *   - WorktreeRemove deletes the worktree, and the branch only when no work would be lost.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, createTempGitProject, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { exitCodeFor } = require('../hooks/lib/exit-code-registry.js');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-worktree-provision.js');
const provision = require(HOOK);
const { REFUSAL } = provision;

const EXIT = {
  PASS: 0,
  FAIL: 1,
  USAGE: exitCodeFor('USAGE'),
  UNAVAILABLE: exitCodeFor('UNAVAILABLE'),
};

const IDENTITY = ['-c', 'user.email=provision@test.local', '-c', 'user.name=provision'];

function git(repo, args) {
  return gitOrThrow(['-C', repo, ...args]).trim();
}

function commit(repo, file, content) {
  fs.writeFileSync(path.join(repo, file), content);
  git(repo, ['add', '--', file]);
  git(repo, [...IDENTITY, 'commit', '-q', '-m', `add ${file}`]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function writeConfig(repo, workflow) {
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.planning', 'config.json'), JSON.stringify({ workflow }));
}

function managedPath(repo, name) {
  return path.join(fs.realpathSync.native(repo), '.claude', 'worktrees', name);
}

function branchExists(repo, branch) {
  return gitOrThrow(['-C', repo, 'branch', '--list', branch]).trim() !== '';
}

function create(cwd, payload) {
  return runHook(HOOK, [], {
    input: typeof payload === 'string' ? payload : JSON.stringify({ hook_event_name: 'WorktreeCreate', cwd, ...payload }),
    cwd,
    env: { ...TEST_ENV_BASE },
    timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
  });
}

function remove(cwd, worktreePath) {
  return runHook(HOOK, [], {
    input: JSON.stringify({ hook_event_name: 'WorktreeRemove', cwd, worktree_path: worktreePath }),
    cwd,
    env: { ...TEST_ENV_BASE },
    timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
  });
}

function assertRefused(result, exitCode) {
  assert.equal(result.outcome, OUTCOME.EXITED, `stderr=${result.stderr}`);
  assert.equal(result.exitCode, exitCode, `stdout=${result.stdout} stderr=${result.stderr}`);
  assert.equal(result.stdout, '', 'a refusal prints no path — any stdout would be read as one');
  assert.notEqual(result.stderr, '', 'a refusal says why on stderr');
}

describe('WorktreeCreate: creates the worktree and prints only its path', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-');
  });
  afterEach(() => cleanup(repo));

  test('{"name":"x"} → worktree at .claude/worktrees/x on worktree-x from HEAD, stdout exactly the path', () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const r = create(repo, { name: 'x' });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    const expected = managedPath(repo, 'x');
    assert.equal(r.stdout, expected, 'stdout carries the path and nothing else');
    assert.equal(git(expected, ['rev-parse', 'HEAD']), head);
    assert.equal(git(expected, ['rev-parse', '--abbrev-ref', 'HEAD']), 'worktree-x');
  });

  test('forks from the LOCAL HEAD even when origin/HEAD points at an older commit', () => {
    // The fork's recorded failure: the harness default (origin/HEAD) lagged ~900 commits.
    const stale = git(repo, ['rev-parse', 'HEAD']);
    const local = commit(repo, 'ahead.txt', 'local work');
    git(repo, ['update-ref', 'refs/remotes/origin/main', stale]);
    git(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const r = create(repo, { name: 'agent-a1b2c3' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(git(r.stdout, ['rev-parse', 'HEAD']), local);
    assert.notEqual(local, stale, 'negative control: the two candidate bases differ');
  });

  test('a second create with the same name reuses the worktree it made (resume)', () => {
    const first = create(repo, { name: 'resume-me' });
    assert.equal(first.exitCode, EXIT.PASS, `stderr=${first.stderr}`);
    const second = create(repo, { name: 'resume-me' });
    assert.equal(second.exitCode, EXIT.PASS, `stderr=${second.stderr}`);
    assert.equal(second.stdout, first.stdout);
  });

  test('from inside a linked worktree, the new worktree lands beside it under the main checkout', () => {
    const outer = create(repo, { name: 'outer' });
    assert.equal(outer.exitCode, EXIT.PASS, `stderr=${outer.stderr}`);
    const inner = create(outer.stdout, { name: 'inner' });
    assert.equal(inner.exitCode, EXIT.PASS, `stderr=${inner.stderr}`);
    assert.equal(inner.stdout, managedPath(repo, 'inner'), 'not nested inside the outer checkout');
  });
});

describe('WorktreeCreate: refusals leave nothing behind and print no path', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-refuse-');
  });
  afterEach(() => cleanup(repo));

  for (const [label, name] of [
    ['a missing name', undefined],
    ['an empty name', ''],
    ['a non-string name', 7],
    ['a traversal', '../escape'],
    ['a path separator', 'a/b'],
    ['a leading dot', '.hidden'],
    ['a double dot', 'a..b'],
    ['a trailing .lock', 'x.lock'],
    ['a shell metacharacter', 'x;rm'],
  ]) {
    test(`${label} → USAGE, nothing created`, () => {
      const r = create(repo, name === undefined ? {} : { name });
      assertRefused(r, EXIT.USAGE);
      assert.equal(fs.existsSync(path.join(repo, '.claude', 'worktrees')), false);
    });
  }

  test('name length boundary: 127 and 128 characters are accepted, 129 is refused', () => {
    assert.equal(provision.validateName('a'.repeat(127)), null);
    assert.equal(provision.validateName('a'.repeat(128)), null);
    assert.equal(typeof provision.validateName('a'.repeat(129)), 'string');
    assertRefused(create(repo, { name: 'a'.repeat(129) }), EXIT.USAGE);
  });

  test('an existing path that is not this worktree → UNAVAILABLE, the directory untouched', () => {
    const occupied = path.join(repo, '.claude', 'worktrees', 'taken');
    fs.mkdirSync(occupied, { recursive: true });
    fs.writeFileSync(path.join(occupied, 'keep.txt'), 'mine');
    assertRefused(create(repo, { name: 'taken' }), EXIT.UNAVAILABLE);
    assert.equal(fs.readFileSync(path.join(occupied, 'keep.txt'), 'utf8'), 'mine');
    assert.equal(branchExists(repo, 'worktree-taken'), false);
  });

  test('an existing branch worktree-<name> → UNAVAILABLE, the branch untouched', () => {
    const head = git(repo, ['rev-parse', 'HEAD']);
    git(repo, ['branch', 'worktree-old', head]);
    const r = create(repo, { name: 'old' });
    assertRefused(r, EXIT.UNAVAILABLE);
    assert.equal(fs.existsSync(managedPath(repo, 'old')), false);
    assert.equal(provision.createWorktree({ name: 'old', cwd: repo }).code, REFUSAL.BRANCH_EXISTS);
  });

  test('outside a git repository → UNAVAILABLE', (t) => {
    const plain = createTempDir('wt-provision-plain-');
    t.after(() => cleanup(plain));
    assertRefused(create(plain, { name: 'x' }), EXIT.UNAVAILABLE);
  });

  test('a payload that is not JSON → UNAVAILABLE', () => {
    assertRefused(create(repo, '{not json'), EXIT.UNAVAILABLE);
  });
});

describe('WorktreeCreate: equipment', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-equip-');
  });
  afterEach(() => cleanup(repo));

  test('.worktreeinclude copies files that are listed AND gitignored — nothing else (harness parity)', () => {
    commit(repo, '.gitignore', '.env\n.cache\n');
    commit(repo, '.worktreeinclude', '.env\ndraft.md\n');
    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(repo, '.cache'), 'ignored but not listed');
    fs.writeFileSync(path.join(repo, 'draft.md'), 'listed but not ignored');

    const r = create(repo, { name: 'inc' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(r.stdout, '.env'), 'utf8'), 'SECRET=1');
    assert.equal(fs.existsSync(path.join(r.stdout, '.cache')), false);
    assert.equal(fs.existsSync(path.join(r.stdout, 'draft.md')), false);
  });

  test('provisioning off: no tool config is copied and no dependencies are linked', () => {
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{"servers":{}}');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    const r = create(repo, { name: 'bare' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(fs.existsSync(path.join(r.stdout, '.mcp.json')), false);
    assert.equal(fs.existsSync(path.join(r.stdout, 'node_modules')), false);
  });

  test('provisioning on: tool config travels, node_modules is linked to the source checkout', () => {
    writeConfig(repo, { worktree_provision: true });
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{"servers":{}}');
    fs.mkdirSync(path.join(repo, 'node_modules'));
    fs.writeFileSync(path.join(repo, 'node_modules', '.marker'), 'x');

    const r = create(repo, { name: 'equipped' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(r.stdout, '.mcp.json'), 'utf8'), '{"servers":{}}');
    assert.equal(fs.readFileSync(path.join(r.stdout, 'node_modules', '.marker'), 'utf8'), 'x');
  });

  test('a config the checkout already carries is never clobbered', () => {
    commit(repo, '.mcp.json', '{"from":"tracked"}');
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'none' });
    fs.writeFileSync(path.join(repo, '.mcp.json'), '{"from":"working-tree"}');
    const result = provision.createWorktree({ name: 'keep', cwd: repo });
    assert.equal(result.outcome, 'created');
    assert.equal(fs.readFileSync(path.join(result.path, '.mcp.json'), 'utf8'), '{"from":"tracked"}');
  });

  test('a failed install WARNS by default: the worktree is created and the failure is reported', () => {
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'install', worktree_install_command: 'exit 1' });
    const result = provision.createWorktree({ name: 'warned', cwd: repo });
    assert.equal(result.outcome, 'created');
    assert.deepEqual(result.warnings.map((w) => w.step), ['dependencies']);
    assert.ok(fs.existsSync(result.path));

    const r = create(repo, { name: 'warned-process' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(r.stdout, managedPath(repo, 'warned-process'));
  });

  test('a failed install under worktree_provision_strict REFUSES and rolls the worktree back', () => {
    writeConfig(repo, {
      worktree_provision: true,
      worktree_provision_strict: true,
      worktree_deps: 'install',
      worktree_install_command: 'exit 1',
    });
    const r = create(repo, { name: 'strict' });
    assertRefused(r, EXIT.FAIL);
    assert.equal(fs.existsSync(managedPath(repo, 'strict')), false, 'no half-equipped worktree is left on disk');
    assert.equal(branchExists(repo, 'worktree-strict'), false, 'nor its branch');

    const typed = provision.createWorktree({ name: 'strict-typed', cwd: repo });
    assert.equal(typed.code, REFUSAL.PROVISION_FAILED);
    assert.deepEqual(typed.failures.map((f) => f.step), ['dependencies']);
  });

  test('strict with nothing failing creates normally', () => {
    writeConfig(repo, { worktree_provision: true, worktree_provision_strict: true, worktree_deps: 'none' });
    const r = create(repo, { name: 'strict-ok' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
  });
});

describe('WorktreeCreate: base freshness from a linked worktree', () => {
  let repo;
  let behindTree;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-lag-');
    // The config is committed, so the linked worktree forked below carries it.
    fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
    commit(repo, path.join('.planning', 'config.json'), JSON.stringify({
      workflow: { worktree_provision: true, worktree_deps: 'none', worktree_copy_tools: false, worktree_max_base_lag: 2 },
    }));
    behindTree = createTempDir('wt-provision-behind-');
    git(repo, ['worktree', 'add', '--detach', behindTree, 'HEAD']);
  });
  afterEach(() => {
    cleanup(behindTree);
    cleanup(repo);
  });

  const advanceMain = (n) => {
    for (let i = 1; i <= n; i += 1) commit(repo, `moved-${i}.txt`, String(i));
  };

  test('at the limit (2 behind, limit 2) the worktree is created', () => {
    advanceMain(2);
    const r = create(behindTree, { name: 'at-limit' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
  });

  test('one under the limit (1 behind) the worktree is created', () => {
    advanceMain(1);
    assert.equal(create(behindTree, { name: 'under' }).exitCode, EXIT.PASS);
  });

  test('one over the limit (3 behind) → FAIL before anything exists, distance reported', () => {
    advanceMain(3);
    assertRefused(create(behindTree, { name: 'over' }), EXIT.FAIL);
    assert.equal(fs.existsSync(managedPath(repo, 'over')), false);
    assert.equal(branchExists(repo, 'worktree-over'), false);

    const typed = provision.createWorktree({ name: 'over', cwd: behindTree });
    assert.equal(typed.code, REFUSAL.BASE_TOO_STALE);
    assert.equal(typed.behind, 3);
    assert.equal(typed.maxBaseLag, 2);
  });
});

describe('WorktreeRemove: cleans up what WorktreeCreate made', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-remove-');
  });
  afterEach(() => cleanup(repo));

  test('an untouched worktree is removed together with its branch', () => {
    const made = create(repo, { name: 'clean' });
    assert.equal(made.exitCode, EXIT.PASS, `stderr=${made.stderr}`);
    const r = remove(repo, made.stdout);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(made.stdout), false);
    assert.equal(branchExists(repo, 'worktree-clean'), false);
  });

  test('a branch carrying unmerged commits is kept — no work is deleted', () => {
    const made = create(repo, { name: 'worked' });
    commit(made.stdout, 'work.txt', 'agent output');
    const result = provision.removeWorktree({ worktree_path: made.stdout, cwd: repo });
    assert.equal(result.outcome, 'removed');
    assert.equal(result.branchDeleted, false);
    assert.equal(fs.existsSync(made.stdout), false);
    assert.equal(branchExists(repo, 'worktree-worked'), true);
  });

  test('a branch whose commits were merged is deleted', () => {
    const made = create(repo, { name: 'merged' });
    commit(made.stdout, 'merged.txt', 'merged work');
    git(repo, [...IDENTITY, 'merge', '-q', '--ff-only', 'worktree-merged']);
    const r = remove(repo, made.stdout);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(branchExists(repo, 'worktree-merged'), false);
  });

  test('a path outside .claude/worktrees is refused and left alone', (t) => {
    const elsewhere = createTempDir('wt-provision-elsewhere-');
    t.after(() => cleanup(elsewhere));
    git(repo, ['worktree', 'add', '--detach', elsewhere, 'HEAD']);
    assertRefused(remove(repo, elsewhere), EXIT.UNAVAILABLE);
    assert.ok(fs.existsSync(elsewhere));
  });

  test('a directory already gone counts as removed', () => {
    const made = create(repo, { name: 'gone' });
    cleanup(made.stdout);
    const r = remove(repo, made.stdout);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(branchExists(repo, 'worktree-gone'), false, 'the empty branch goes too');
  });
});
