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
 *   - equipment happens only in a GSD project (`.planning/config.json` inside the repository):
 *     the hook replaces creation in every git project, and a GSD default must not reach the rest;
 *   - `claude --worktree "#123"` arrives as `pr-123` and is based on origin's head of that
 *     request, with the harness's per-host fetch table;
 *   - a warning raised at creation reaches the first session in that worktree (SessionStart,
 *     gsd-pin-invariants.js) through the worktree's git dir, once;
 *   - WorktreeRemove deletes the worktree, and the branch only when no work would be lost.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runHook, runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { createTempDir, createTempGitProject, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { createFixture } = require('./fixtures/index.cjs');
const { STAGED_HOOK_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { exitCodeFor } = require('../hooks/lib/exit-code-registry.js');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-worktree-provision.js');
const PIN_HOOK = path.join(__dirname, '..', 'hooks', 'gsd-pin-invariants.js');
const provision = require(HOOK);
const pin = require(PIN_HOOK);
const notice = require('../hooks/lib/worktree-notice.js');
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

function create(cwd, payload, extraEnv = {}) {
  return runHook(HOOK, [], {
    input: typeof payload === 'string' ? payload : JSON.stringify({ hook_event_name: 'WorktreeCreate', cwd, ...payload }),
    cwd,
    env: { ...TEST_ENV_BASE, ...extraEnv },
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

  test('#5548: an inherited GIT_DIR naming another repository does not redirect the creation', (t) => {
    const other = createTempGitProject('wt-provision-other-');
    t.after(() => cleanup(other));
    const head = git(repo, ['rev-parse', 'HEAD']);
    // A hook git runs (post-checkout, pre-commit) exports these; the worktree still belongs to cwd's repository.
    const r = create(repo, { name: 'x' }, { GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other });
    assert.equal(r.outcome, OUTCOME.EXITED, `stderr=${r.stderr}`);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    const expected = managedPath(repo, 'x');
    assert.equal(r.stdout, expected, 'the worktree is made under cwd\'s repository');
    assert.equal(git(expected, ['rev-parse', 'HEAD']), head);
    assert.equal(branchExists(other, 'worktree-x'), false, 'nothing is made in the repository GIT_DIR names');
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

  test('a name the harness accepts is accepted: "/" becomes "+" in path and branch, a leading dot is fine', () => {
    const slashed = create(repo, { name: 'feature/login' });
    assert.equal(slashed.exitCode, EXIT.PASS, `stderr=${slashed.stderr}`);
    assert.equal(slashed.stdout, managedPath(repo, 'feature+login'));
    assert.equal(git(slashed.stdout, ['rev-parse', '--abbrev-ref', 'HEAD']), 'worktree-feature+login');

    const dotted = create(repo, { name: '.scratch' });
    assert.equal(dotted.exitCode, EXIT.PASS, `stderr=${dotted.stderr}`);
    assert.equal(dotted.stdout, managedPath(repo, '.scratch'));
  });

  test('WorktreeRemove takes a "/" name back down, branch included', () => {
    const made = create(repo, { name: 'feature/gone' });
    assert.equal(made.exitCode, EXIT.PASS, `stderr=${made.stderr}`);
    assert.equal(remove(repo, made.stdout).exitCode, EXIT.PASS);
    assert.equal(fs.existsSync(made.stdout), false);
    assert.equal(branchExists(repo, 'worktree-feature+gone'), false);
  });
});

describe('WorktreeCreate: a pull/merge request (`claude --worktree "#123"`)', () => {
  // Claude Code maps `--worktree "#123"` (or a PR/MR URL) to the name `pr-123`
  // before any hook runs and passes only that name — so `pr-<n>` is what the
  // hook receives for `#123`, and it must base the worktree on that change's
  // head fetched from origin, as the harness's own git path does.
  let repo;
  let origin;
  let localHead;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-pr-');
    origin = createTempDir('wt-provision-origin-');
    gitOrThrow(['init', '-q', '--bare', origin]);
    git(repo, ['remote', 'add', 'origin', origin]);
    localHead = git(repo, ['rev-parse', 'HEAD']);
  });
  afterEach(() => {
    cleanup(repo);
    cleanup(origin);
  });

  /** Publish a commit the local HEAD does not have at `ref` on origin; returns its sha. */
  function publishChange(ref, file) {
    const home = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    git(repo, ['checkout', '-q', '-b', 'change-src']);
    const sha = commit(repo, file, `change for ${ref}`);
    git(repo, ['push', '-q', 'origin', `change-src:${ref}`]);
    git(repo, ['checkout', '-q', home]);
    git(repo, ['branch', '-q', '-D', 'change-src']);
    return sha;
  }

  test('"#123" → pr-123: based on origin pull/123/head, not the local HEAD', () => {
    const prHead = publishChange('refs/pull/123/head', 'pr.txt');
    const r = create(repo, { name: 'pr-123' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(r.stdout, managedPath(repo, 'pr-123'), 'the harness location for a PR worktree');
    assert.equal(git(r.stdout, ['rev-parse', 'HEAD']), prHead);
    assert.equal(git(r.stdout, ['rev-parse', '--abbrev-ref', 'HEAD']), 'worktree-pr-123');
    assert.notEqual(prHead, localHead, 'negative control: the two candidate bases differ');
  });

  test('on a host that is neither github.com nor gitlab.com, merge-requests/<n>/head is tried after pull/<n>/head', () => {
    const mrHead = publishChange('refs/merge-requests/45/head', 'mr.txt');
    const result = provision.createWorktree({ name: 'pr-45', cwd: repo });
    assert.equal(result.outcome, 'created', JSON.stringify(result));
    assert.equal(result.prNumber, 45);
    assert.equal(git(result.path, ['rev-parse', 'HEAD']), mrHead);
  });

  test('a request origin does not have → UNAVAILABLE, nothing created', () => {
    const r = create(repo, { name: 'pr-77' });
    assertRefused(r, EXIT.UNAVAILABLE);
    assert.equal(fs.existsSync(managedPath(repo, 'pr-77')), false);
    assert.equal(branchExists(repo, 'worktree-pr-77'), false);
    assert.equal(provision.createWorktree({ name: 'pr-77', cwd: repo }).code, REFUSAL.PULL_REQUEST_FETCH_FAILED);
  });

  test('no remote named origin → UNAVAILABLE, nothing created', () => {
    git(repo, ['remote', 'remove', 'origin']);
    assert.equal(provision.createWorktree({ name: 'pr-5', cwd: repo }).code, REFUSAL.PULL_REQUEST_FETCH_FAILED);
    assert.equal(fs.existsSync(managedPath(repo, 'pr-5')), false);
  });

  test('a request head is not measured against workflow.worktree_max_base_lag', () => {
    const prHead = publishChange('refs/pull/9/head', 'old-pr.txt');
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'none', worktree_copy_tools: false, worktree_max_base_lag: 1 });
    commit(repo, 'main-1.txt', '1');
    commit(repo, 'main-2.txt', '2');
    const result = provision.createWorktree({ name: 'pr-9', cwd: repo });
    assert.equal(result.outcome, 'created', JSON.stringify(result));
    assert.equal(git(result.path, ['rev-parse', 'HEAD']), prHead);
  });

  test('the name → request mapping and the per-host fetch table match the harness', () => {
    assert.equal(provision.pullRequestNumber('pr-123'), 123);
    for (const notOne of ['pr-0', 'pr-', 'pr-12a', 'PR-12', 'xpr-12', 'pr-0123']) {
      assert.equal(provision.pullRequestNumber(notOne), null, notOne);
    }
    assert.deepEqual(provision.pullRequestRefs('github.com', 7), ['pull/7/head']);
    assert.deepEqual(provision.pullRequestRefs('gitlab.com', 7), ['merge-requests/7/head']);
    assert.deepEqual(provision.pullRequestRefs('git.corp.example', 7), ['pull/7/head', 'merge-requests/7/head']);
    assert.deepEqual(provision.pullRequestRefs(null, 7), ['pull/7/head', 'merge-requests/7/head']);
    assert.equal(provision.remoteHost('https://github.com/o/r.git'), 'github.com');
    assert.equal(provision.remoteHost('ssh://git@gitlab.com:2222/g/r.git'), 'gitlab.com');
    assert.equal(provision.remoteHost('git@github.com:o/r.git'), 'github.com');
    assert.equal(provision.remoteHost('/srv/repos/r.git'), null);
  });
});

describe('WorktreeCreate: refusals leave nothing behind and print no path', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-refuse-');
  });
  afterEach(() => cleanup(repo));

  // The harness validates names before any hook runs ("/"-separated segments of
  // [A-Za-z0-9._-], no "."/".." segment, no ".git" segment); this matrix is what
  // it refuses, plus names no git branch can carry.
  for (const [label, name] of [
    ['a missing name', undefined],
    ['an empty name', ''],
    ['a non-string name', 7],
    ['a traversal', '../escape'],
    ['a ".." segment mid-name', 'a/../b'],
    ['a "." segment', 'a/./b'],
    ['an empty segment', 'a//b'],
    ['a leading slash', '/abs'],
    ['a ".git" segment', 'x/.GIT.'],
    ['a double dot', 'a..b'],
    ['a trailing .lock', 'x.lock'],
    ['a shell metacharacter', 'x;rm'],
    ['a raw "#" reference (the harness never passes one: it sends pr-<n>)', '#123'],
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

  test('a strict rollback that cannot finish says what it left behind instead of claiming a clean slate', () => {
    writeConfig(repo, {
      worktree_provision: true,
      worktree_provision_strict: true,
      worktree_deps: 'install',
      worktree_install_command: 'exit 1',
    });
    // Fault injection at the git seam: the branch deletion of the rollback fails.
    const gitWithFailingBranchDelete = (args, cwd, opts) =>
      args[0] === 'branch' && args[1] === '-D'
        ? { ok: false, status: 1, stdout: '', stderr: 'injected: cannot delete', error: null }
        : provision.runGit(args, cwd, opts);
    const typed = provision.createWorktree({ name: 'half-undone', cwd: repo }, { git: gitWithFailingBranchDelete });
    assert.equal(typed.code, REFUSAL.PROVISION_FAILED);
    assert.equal(typed.leftBehind.length, 1);
    assert.ok(typed.leftBehind[0].includes('worktree-half-undone'), typed.leftBehind[0]);
    assert.ok(!typed.reason.includes('removed again'), typed.reason);
    assert.equal(branchExists(repo, 'worktree-half-undone'), true, 'the injected failure really left the branch');

    const clean = provision.createWorktree({ name: 'fully-undone', cwd: repo });
    assert.deepEqual(clean.leftBehind, [], 'negative control: a rollback that finishes leaves nothing');
    assert.ok(clean.reason.includes('removed again'));
  });

  test('strict with nothing failing creates normally', () => {
    writeConfig(repo, { worktree_provision: true, worktree_provision_strict: true, worktree_deps: 'none' });
    const r = create(repo, { name: 'strict-ok' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
  });
});

describe('WorktreeCreate: equipment only in a GSD project (.planning/config.json in the repository)', () => {
  // The hook replaces worktree creation in EVERY git project on the machine;
  // a GSD default must not reach a repository that never chose GSD.
  const equipmentBait = (dir) => {
    fs.writeFileSync(path.join(dir, '.mcp.json'), '{"servers":{}}');
    fs.mkdirSync(path.join(dir, 'node_modules'));
  };
  const equipped = (worktree) =>
    fs.existsSync(path.join(worktree, '.mcp.json')) || fs.existsSync(path.join(worktree, 'node_modules'));
  const ON = { worktree_provision: true };

  test('a project without .planning/ → worktree created from HEAD, no equipment', (t) => {
    const repo = createFixture({ prefix: 'wt-provision-nogsd-', git: true, planning: false, projectDoc: false });
    t.after(() => cleanup(repo));
    assert.equal(fs.existsSync(path.join(repo, '.planning')), false, 'precondition: not a GSD project');
    equipmentBait(repo);
    const head = git(repo, ['rev-parse', 'HEAD']);

    const r = create(repo, { name: 'plain' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(git(r.stdout, ['rev-parse', 'HEAD']), head);
    assert.equal(equipped(r.stdout), false);
  });

  test('a .planning/config.json in an ancestor OUTSIDE the repository does not make it a GSD project', (t) => {
    const outer = createTempDir('wt-provision-ancestor-');
    t.after(() => cleanup(outer));
    writeConfig(outer, ON);
    const repo = path.join(outer, 'nested');
    fs.mkdirSync(repo);
    gitOrThrow(['init', '-q', repo]);
    git(repo, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'init']);
    equipmentBait(repo);

    const r = create(repo, { name: 'nested' });
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(equipped(r.stdout), false, 'the ancestor config belongs to another project');
    assert.equal(provision.findPlanningRoot(repo, { sourceTop: repo, mainRoot: repo }), null);
  });

  test('.planning/ without config.json is not a GSD project; adding the config makes it one', (t) => {
    const repo = createTempGitProject('wt-provision-noconfig-');
    t.after(() => cleanup(repo));
    equipmentBait(repo);
    const bare = create(repo, { name: 'no-config' });
    assert.equal(bare.exitCode, EXIT.PASS, `stderr=${bare.stderr}`);
    assert.equal(equipped(bare.stdout), false);

    writeConfig(repo, ON);
    const gsd = create(repo, { name: 'with-config' });
    assert.equal(gsd.exitCode, EXIT.PASS, `stderr=${gsd.stderr}`);
    assert.equal(equipped(gsd.stdout), true, 'positive control: the same repository with the config is equipped');
  });

  test('from a linked worktree whose checkout lacks the (untracked) config, the main checkout\'s config applies', (t) => {
    const repo = createTempGitProject('wt-provision-mirror-');
    t.after(() => cleanup(repo));
    writeConfig(repo, ON); // written, never committed
    const outer = create(repo, { name: 'outer-gsd' });
    assert.equal(outer.exitCode, EXIT.PASS, `stderr=${outer.stderr}`);
    assert.equal(fs.existsSync(path.join(outer.stdout, '.planning', 'config.json')), false, 'precondition');
    const mainRoot = fs.realpathSync.native(repo);
    assert.equal(provision.findPlanningRoot(outer.stdout, { sourceTop: outer.stdout, mainRoot }), mainRoot);
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

describe('WorktreeCreate warnings reach the first session in the worktree (SessionStart via gsd-pin-invariants)', () => {
  // stdout carries only the path, so a warning on stderr reaches nobody but
  // Claude Code's debug log. It is recorded in the worktree's git dir and the
  // first SessionStart there hands it to the agent, once.
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('wt-provision-notice-');
  });
  afterEach(() => cleanup(repo));

  const sessionStart = (cwd, event = 'SessionStart', source = 'startup') =>
    runNode([PIN_HOOK], {
      input: JSON.stringify({ hook_event_name: event, source, cwd }),
      cwd,
      env: { ...TEST_ENV_BASE },
      timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
    });

  const failingInstall = { worktree_provision: true, worktree_deps: 'install', worktree_install_command: 'exit 1', worktree_copy_tools: false };

  test('a warned creation records the warning inside the git dir; the first session receives it, the next does not', () => {
    writeConfig(repo, failingInstall);
    const made = create(repo, { name: 'warned' });
    assert.equal(made.exitCode, EXIT.PASS, `stderr=${made.stderr}`);

    const gitDir = git(made.stdout, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const noticeFile = path.join(gitDir, notice.NOTICE_DIR, notice.NOTICE_FILE);
    assert.ok(fs.existsSync(noticeFile), 'recorded in the worktree\'s git dir');
    assert.equal(git(made.stdout, ['status', '--porcelain']), '', 'nothing lands in the working tree');

    const first = sessionStart(made.stdout);
    assert.equal(first.outcome, OUTCOME.EXITED, `stderr=${first.stderr}`);
    assert.equal(first.exitCode, 0);
    const out = JSON.parse(first.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    const context = out.hookSpecificOutput.additionalContext;
    assert.ok(context.includes('dependencies'), context);
    assert.ok(context.includes('install exited 1'), context);
    assert.ok(context.includes('worktree-warned'), 'names the worktree it is about');

    const stamped = JSON.parse(fs.readFileSync(noticeFile, 'utf8'));
    assert.equal(typeof stamped.delivered_at, 'string', 'marked as read');

    const again = sessionStart(made.stdout, 'SessionStart', 'compact');
    assert.equal(again.exitCode, 0);
    assert.equal(again.stdout.trim(), '', 'delivered once — not repeated after a compaction');
  });

  test('an event that cannot carry context does not consume the notice', () => {
    writeConfig(repo, failingInstall);
    const made = create(repo, { name: 'kept-for-later' });
    assert.equal(made.exitCode, EXIT.PASS, `stderr=${made.stderr}`);
    const silent = sessionStart(made.stdout, 'PostCompact');
    assert.equal(silent.stdout.trim(), '');
    const first = sessionStart(made.stdout);
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput.additionalContext.includes('install exited 1'));
  });

  test('the notice precedes the pin when both apply, and arrives even with workflow.pin_invariants off', () => {
    writeConfig(repo, { ...failingInstall, pin_invariants: false });
    const made = provision.createWorktree({ name: 'pin-off', cwd: repo });
    assert.equal(made.outcome, 'created');
    assert.ok(made.noticePath, 'the created result names where the notice went');
    const out = pin.sessionStartOutput({ hook_event_name: 'SessionStart', cwd: made.path });
    assert.ok(out.hookSpecificOutput.additionalContext.startsWith('WORKTREE PROVISIONING'));
  });

  test('a clean creation records nothing, and a session there gets no notice', () => {
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'none', worktree_copy_tools: false });
    const made = provision.createWorktree({ name: 'clean', cwd: repo });
    assert.equal(made.outcome, 'created');
    assert.equal(made.noticePath, null);
    const gitDir = git(made.path, ['rev-parse', '--path-format=absolute', '--git-dir']);
    assert.equal(fs.existsSync(path.join(gitDir, notice.NOTICE_DIR, notice.NOTICE_FILE)), false);
    assert.equal(pin.sessionStartOutput({ hook_event_name: 'SessionStart', cwd: made.path }), null);
  });

  test('the main checkout never reads a notice (only linked worktrees carry one)', () => {
    assert.equal(notice.linkedWorktreeGitDir(repo), null);
  });

  test('warning list bound: MAX_WARNINGS shown, the rest counted', () => {
    const at = (n) => ({ schema: 1, branch: 'b', warnings: Array.from({ length: n }, (_, i) => ({ step: `s${i}`, reason: 'r' })) });
    const lines = (n) => notice.formatNotice(at(n)).split('\n').filter((l) => l.startsWith('- '));
    assert.equal(lines(notice.MAX_WARNINGS - 1).length, notice.MAX_WARNINGS - 1);
    assert.equal(lines(notice.MAX_WARNINGS).length, notice.MAX_WARNINGS);
    const over = lines(notice.MAX_WARNINGS + 1);
    assert.equal(over.length, notice.MAX_WARNINGS + 1);
    assert.equal(over.at(-1), '- (1 more not shown)');
  });
});

describe('WorktreeCreate: two registrations of this hook create one worktree (review M2)', () => {
  // Claude Code runs every matching WorktreeCreate handler in parallel; GSD registered globally
  // AND in the project means two copies for one name. The create lock serializes them: the
  // second waits, then finds the finished worktree. Driven with an injected sleep and pid probe —
  // the "other creator" acts inside the wait, no timing involved.
  let repo;
  let lockPath;
  const OTHER_PID = 2147483646;

  beforeEach(() => {
    repo = createTempGitProject('wt-provision-lock-');
    lockPath = path.join(fs.realpathSync.native(repo), '.git', 'gsd-worktree-create', 'x.lock');
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  });
  afterEach(() => cleanup(repo));

  test('a creator that finds the lock held waits, then reuses the worktree the holder made — same path, nothing doubled', () => {
    fs.writeFileSync(lockPath, String(OTHER_PID));
    let waits = 0;
    const result = provision.createWorktree(
      { name: 'x', cwd: repo },
      {
        config: null,
        isAlive: (pid) => pid === OTHER_PID && fs.existsSync(lockPath),
        sleep: () => {
          waits += 1;
          // The other creator finishes: its worktree exists, its lock is released.
          git(repo, ['worktree', 'add', '-q', '-b', 'worktree-x', managedPath(repo, 'x'), 'HEAD']);
          fs.unlinkSync(lockPath);
        },
      },
    );
    assert.equal(waits, 1);
    assert.equal(result.outcome, 'reused', JSON.stringify(result));
    assert.equal(result.path, managedPath(repo, 'x'));
    assert.equal(fs.existsSync(lockPath), false, 'the waiter releases what it took');
  });

  test('a lock left by a dead creator is taken over: the worktree is created, the lock released', () => {
    fs.writeFileSync(lockPath, String(OTHER_PID));
    const result = provision.createWorktree(
      { name: 'x', cwd: repo },
      { config: null, isAlive: () => false, sleep: () => assert.fail('a stale lock is not waited on') },
    );
    assert.equal(result.outcome, 'created', JSON.stringify(result));
    assert.equal(fs.existsSync(lockPath), false);
  });

  test('a holder that never finishes: refused once the wait runs out, nothing created', () => {
    fs.writeFileSync(lockPath, String(OTHER_PID));
    let now = 0;
    const result = provision.createWorktree(
      { name: 'x', cwd: repo },
      { config: null, isAlive: () => true, lockWaitMs: 1000, clock: { now: () => now }, sleep: () => { now += 600; } },
    );
    assert.equal(result.code, REFUSAL.CREATE_LOCKED);
    assert.equal(fs.existsSync(managedPath(repo, 'x')), false);
    assert.equal(branchExists(repo, 'worktree-x'), false);
    assert.equal(fs.readFileSync(lockPath, 'utf8'), String(OTHER_PID), 'the live holder keeps its lock');
  });

  test('an uncontended create takes and releases the lock', () => {
    const result = provision.createWorktree({ name: 'x', cwd: repo }, { config: null });
    assert.equal(result.outcome, 'created', JSON.stringify(result));
    assert.equal(fs.existsSync(lockPath), false);
  });
});

describe('WorktreeCreate: a local install\'s hooks still run in the worktree (review L7)', () => {
  // A local install registers "$CLAUDE_PROJECT_DIR"/.claude/hooks/…, and .claude/hooks is
  // gitignored. Inside the worktree CLAUDE_PROJECT_DIR is the worktree, so a verbatim copy of
  // settings.local.json points every hook — SessionStart's pin-invariants, which delivers this
  // hook's own warnings, included — at a missing file.
  let repo;
  let main;
  const PIN_CMD = 'node "$CLAUDE_PROJECT_DIR"/.claude/hooks/gsd-pin-invariants.js';

  beforeEach(() => {
    repo = createTempGitProject('wt-provision-local-');
    main = fs.realpathSync.native(repo);
    fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/hooks/\n.claude/settings.local.json\n.claude/worktrees/\n');
    commit(repo, 'tracked.sh', 'echo tracked\n');
    // The local install: the real hook scripts under the gitignored .claude/hooks.
    fs.cpSync(path.dirname(HOOK), path.join(repo, '.claude', 'hooks'), { recursive: true });
  });
  afterEach(() => cleanup(repo));

  function writeLocalSettings(settings) {
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), JSON.stringify(settings, null, 2));
  }

  test('project-dir paths missing in the worktree point at the source checkout; paths it carries, and everything else, stay', () => {
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'none' });
    writeLocalSettings({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: PIN_CMD }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR/tracked.sh"' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/nowhere.js' }] }],
      },
    });
    const made = provision.createWorktree({ name: 'local', cwd: repo });
    assert.equal(made.outcome, 'created', JSON.stringify(made));
    const copied = JSON.parse(fs.readFileSync(path.join(made.path, '.claude', 'settings.local.json'), 'utf8'));
    const pinPath = path.join(main, '.claude', 'hooks', 'gsd-pin-invariants.js');
    assert.equal(copied.hooks.SessionStart[0].hooks[0].command, `node "${pinPath}"`);
    assert.equal(copied.hooks.PostToolUse[0].hooks[0].command, 'bash "$CLAUDE_PROJECT_DIR/tracked.sh"', 'the worktree carries tracked.sh');
    assert.equal(copied.hooks.Stop[0].hooks[0].command, 'node ${CLAUDE_PROJECT_DIR}/.claude/hooks/nowhere.js', 'missing on both sides: nothing to point at');
    assert.deepEqual(copied.permissions, { allow: ['Bash(npm test)'] });
    assert.ok(made.notes.some((n) => n.includes('.claude/settings.local.json (1)')), made.notes.join(' | '));
  });

  test('the provisioning warning reaches the first session through the copied SessionStart hook', () => {
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'install', worktree_install_command: 'exit 1' });
    writeLocalSettings({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: PIN_CMD }] }] } });
    const made = provision.createWorktree({ name: 'warned-local', cwd: repo });
    assert.equal(made.outcome, 'created', JSON.stringify(made));
    assert.equal(fs.existsSync(path.join(made.path, '.claude', 'hooks', 'gsd-pin-invariants.js')), false, 'precondition: hooks are not in the worktree');

    const command = JSON.parse(fs.readFileSync(path.join(made.path, '.claude', 'settings.local.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
    const script = /^node "(.+)"$/.exec(command)[1];
    const first = runNode([script], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: made.path }),
      cwd: made.path,
      env: { ...TEST_ENV_BASE, CLAUDE_PROJECT_DIR: made.path },
      timeoutMs: STAGED_HOOK_SCRIPT_TIMEOUT_MS,
    });
    assert.equal(first.outcome, OUTCOME.EXITED, `stderr=${first.stderr}`);
    assert.equal(first.exitCode, 0, first.stderr);
    assert.ok(JSON.parse(first.stdout).hookSpecificOutput.additionalContext.includes('install exited 1'));
  });

  test('a settings file that is not JSON is copied verbatim', () => {
    writeConfig(repo, { worktree_provision: true, worktree_deps: 'none' });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{ not json "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.js');
    const made = provision.createWorktree({ name: 'odd', cwd: repo });
    assert.equal(fs.readFileSync(path.join(made.path, '.claude', 'settings.local.json'), 'utf8'), '{ not json "$CLAUDE_PROJECT_DIR"/.claude/hooks/x.js');
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

  test('a directory already gone drops only ITS registration, never another missing worktree\'s', (t) => {
    // An unreachable worktree elsewhere (an unmounted disk, say) is not this hook's to forget.
    const elsewhere = createTempDir('wt-provision-unmounted-');
    t.after(() => cleanup(elsewhere));
    git(repo, ['worktree', 'add', '--detach', elsewhere, 'HEAD']);
    cleanup(elsewhere);
    const made = create(repo, { name: 'gone-alone' });
    cleanup(made.stdout);

    const r = remove(repo, made.stdout);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    const registered = git(repo, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => fs.realpathSync.native(path.dirname(l.slice('worktree '.length))) + path.sep + path.basename(l.slice('worktree '.length)));
    assert.ok(registered.includes(fs.realpathSync.native(path.dirname(elsewhere)) + path.sep + path.basename(elsewhere)), 'the other missing worktree stays registered');
    assert.ok(!registered.includes(made.stdout), 'this one is forgotten');
  });

  test('a directory already gone counts as removed', () => {
    const made = create(repo, { name: 'gone' });
    cleanup(made.stdout);
    const r = remove(repo, made.stdout);
    assert.equal(r.exitCode, EXIT.PASS, `stderr=${r.stderr}`);
    assert.equal(branchExists(repo, 'worktree-gone'), false, 'the empty branch goes too');
  });
});

describe('git spawns: GIT_OPTIONAL_LOCKS=0 reaches the OS (#5048)', () => {
  // A read such as `ls-files --others --ignored` or `worktree remove`'s status check must not take the
  // optional .git/index.lock a concurrent commit needs. Observed in the child itself: a git alias that
  // prints the variable runs as a real git subprocess with the env runGit built.
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-provision-optlocks-'); });
  afterEach(() => cleanup(dir));

  const printEnv = (name) => ['-c', `alias.printenv-probe=!printenv ${name}`, 'printenv-probe'];

  test('runGit sets it on the default environment', () => {
    const res = provision.runGit(printEnv('GIT_OPTIONAL_LOCKS'), dir);
    assert.equal(res.ok, true, res.stderr);
    assert.equal(res.stdout.trim(), '0');
  });

  test('runGit sets it on a caller environment and keeps the caller keys', () => {
    const env = { ...process.env, GSD_PROBE_KEY: 'kept', GIT_OPTIONAL_LOCKS: '1' };
    assert.equal(provision.runGit(printEnv('GIT_OPTIONAL_LOCKS'), dir, { env }).stdout.trim(), '0');
    assert.equal(provision.runGit(printEnv('GSD_PROBE_KEY'), dir, { env }).stdout.trim(), 'kept');
  });
});
