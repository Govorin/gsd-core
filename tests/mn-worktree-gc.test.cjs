'use strict';

/**
 * `gsd-tools mn worktree-gc` — garbage-collects abandoned worktrees, with one
 * rule that matters more than the collection itself
 * (src/mn-worktree-gc.cts, routed by src/mn-command-router.cts).
 *
 * It exists because `worktree reap-orphans` only sweeps trees carrying a
 * `locked` file — a crash while locked. A worktree abandoned the ordinary way
 * has no such file and is invisible to that sweeper. Observed live: 35
 * abandoned worktrees and 19 GB, three of them carrying real work.
 *
 * Hence the rule these tests exist for: **a branch holding unique commits is
 * never deleted, not even with --yes** — and, since the port, neither is a
 * branch whose commits could not be COUNTED (the script read an unknown count
 * as zero). The decision logic is driven with an injected git runner and
 * clock; the real-git cases pin the command end to end, reading the typed
 * JSON result (`kept`, `reapable`, `removed`).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('./helpers/process-seam.cjs');
const { runGsdTools, createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');

const gc = require('../gsd-core/bin/lib/mn-worktree-gc.cjs');

const DAY = 86_400_000;

/**
 * A scripted git: `answers` maps a joined argv to stdout (string) or null
 * (non-zero exit). Unscripted calls fail. Every call is recorded.
 */
function fakeGit(answers) {
  const calls = [];
  const git = (args) => {
    const key = args.join(' ');
    calls.push(key);
    return Object.prototype.hasOwnProperty.call(answers, key) ? answers[key] : null;
  };
  return { git, calls };
}

const base = (branches, extra = {}) => ({
  'rev-parse --show-toplevel': '/repo',
  'symbolic-ref --quiet --short refs/remotes/origin/HEAD': null,
  'rev-parse --verify --quiet refs/heads/main': 'abc',
  'for-each-ref --format=%(refname:short) refs/heads/': ['main', ...branches].join('\n'),
  'worktree list --porcelain': '',
  ...extra,
});

describe('mn worktree-gc: decisions', () => {
  test('the main ref is origin/HEAD, else main, else master — and only one that resolves', () => {
    const pick = (answers) => gc.resolveMainRef(fakeGit(answers).git, '/repo');
    assert.equal(pick({ 'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/next' }), 'origin/next');
    assert.equal(pick({ 'rev-parse --verify --quiet refs/heads/main': 'a', 'rev-parse --verify --quiet refs/heads/master': 'b' }), 'main');
    assert.equal(pick({ 'rev-parse --verify --quiet refs/heads/master': 'b' }), 'master');
    assert.equal(pick({}), null);
  });

  test('with no main ref nothing is swept — not even looked at', () => {
    const { git, calls } = fakeGit({ 'rev-parse --show-toplevel': '/repo' });
    const r = gc.runWorktreeGc({ cwd: '/repo', apply: true, olderThanDays: 0, _git: git });
    assert.deepEqual([r.ok, r.reason], [false, 'no_main_ref']);
    assert.equal(calls.some((c) => c.startsWith('branch -D') || c.startsWith('worktree remove')), false);
  });

  test('a branch whose commits cannot be counted is kept, even with apply', () => {
    const { git, calls } = fakeGit(base(['worktree-a']));
    const r = gc.runWorktreeGc({ cwd: '/repo', apply: true, olderThanDays: 0, _git: git, _mtimeMs: () => null });
    assert.deepEqual(r.kept.map((k) => [k.branch, k.ahead]), [['worktree-a', null]]);
    assert.deepEqual(r.reapable, []);
    assert.equal(calls.includes('branch -D worktree-a'), false);
  });

  test('unique commits keep a branch; only worktree-* branches are ever considered', () => {
    const { git } = fakeGit(
      base(['worktree-a', 'feature-x'], { 'rev-list --count main..worktree-a': '3', 'rev-list --count main..feature-x': '0' }),
    );
    const r = gc.runWorktreeGc({ cwd: '/repo', apply: false, olderThanDays: 0, _git: git, _mtimeMs: () => null });
    assert.equal(r.branch_count, 1);
    assert.deepEqual(r.kept.map((k) => [k.branch, k.ahead]), [['worktree-a', 3]]);
  });

  test('--older-than keeps a worktree younger than the window (boundary: just under, exactly, just over)', () => {
    const now = 100 * DAY;
    const verdict = (ageDays) => {
      const { git } = fakeGit(
        base(['worktree-a'], {
          'rev-list --count main..worktree-a': '0',
          'worktree list --porcelain': 'worktree /repo/.wt/a\nHEAD abc\nbranch refs/heads/worktree-a\n',
          '-C /repo/.wt/a status --porcelain --untracked-files=all': '',
        }),
      );
      const r = gc.runWorktreeGc({ cwd: '/repo', apply: false, olderThanDays: 7, now: () => now, _git: git, _mtimeMs: () => now - ageDays * DAY });
      return r.reapable.length === 1 ? 'reap' : 'keep';
    };
    assert.equal(verdict(6.99), 'keep');
    assert.equal(verdict(7), 'reap');
    assert.equal(verdict(7.01), 'reap');
  });

  test('a dirty worktree is kept; apply reports a branch it failed to delete', () => {
    const { git } = fakeGit(
      base(['worktree-dirty', 'worktree-stuck'], {
        'rev-list --count main..worktree-dirty': '0',
        'rev-list --count main..worktree-stuck': '0',
        'worktree list --porcelain': 'worktree /repo/.wt/d\nbranch refs/heads/worktree-dirty\n',
        '-C /repo/.wt/d status --porcelain --untracked-files=all': '?? notes.txt',
      }),
    );
    const r = gc.runWorktreeGc({ cwd: '/repo', apply: true, olderThanDays: 0, _git: git, _mtimeMs: (p) => (p === '/repo/.wt/d' ? 0 : null) });
    assert.deepEqual(r.kept.map((k) => [k.branch, k.reason]), [['worktree-dirty', 'uncommitted changes in worktree']]);
    assert.deepEqual([r.removed, r.failed], [[], ['worktree-stuck']]);
  });

  test('parses the porcelain listing into branch → path', () => {
    const paths = gc.parseWorktreePaths('worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\nbranch refs/heads/worktree-c\n');
    assert.deepEqual([...paths], [['main', '/a'], ['worktree-c', '/c']]);
  });
});

describe('gsd-tools mn worktree-gc', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('gsd-worktree-gc-');
  });
  afterEach(() => cleanup(repo));

  const run = (extra = []) => {
    const r = runGsdTools(['mn', 'worktree-gc', ...extra], repo);
    assert.equal(r.success, true, `a sweeper must not fail: ${r.error}`);
    return JSON.parse(r.output);
  };

  /** The name must start with `worktree-`, or nothing is ever a candidate and deletion tests pass for the wrong reason. */
  function addWorktree(name, { unique }) {
    const wt = path.join(repo, '.worktrees', name);
    runGit(['worktree', 'add', '-b', name, wt], { cwd: repo });
    if (unique) {
      fs.writeFileSync(path.join(wt, 'unique-work.txt'), 'work that exists only here\n');
      runGit(['add', '-A'], { cwd: wt });
      runGit(['commit', '-m', `feat(${name}): unique work`, '--no-verify'], { cwd: wt });
    }
    return wt;
  }

  test('a clean repo is nothing to do, not a failure', () => {
    const r = run();
    assert.deepEqual([r.ok, r.branch_count, r.reapable, r.kept], [true, 0, [], []]);
  });

  test('defaults to reporting, without deleting anything', () => {
    const wt = addWorktree('worktree-idle', { unique: false });
    const r = run();
    assert.deepEqual(r.reapable.map((b) => b.branch), ['worktree-idle']);
    assert.equal(r.applied, false);
    assert.equal(fs.existsSync(wt), true);
  });

  test('never deletes a branch holding unique commits, even with --yes — and names it', () => {
    const wt = addWorktree('worktree-precious', { unique: true });
    const r = run(['--yes']);
    assert.deepEqual(r.kept.map((k) => [k.branch, k.ahead]), [['worktree-precious', 1]]);
    assert.equal(fs.existsSync(path.join(wt, 'unique-work.txt')), true);
    const listed = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-precious'], { cwd: repo });
    assert.equal(listed.stdout.trim(), 'worktree-precious');
  });

  test('--yes removes an idle worktree and its branch', () => {
    const wt = addWorktree('worktree-idle', { unique: false });
    const r = run(['--yes']);
    assert.deepEqual(r.removed, ['worktree-idle']);
    assert.equal(fs.existsSync(wt), false);
    const listed = runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/worktree-idle'], { cwd: repo });
    assert.equal(listed.stdout.trim(), '');
  });

  test('--older-than does not remove a worktree created moments ago', () => {
    const wt = addWorktree('worktree-fresh', { unique: false });
    const r = run(['--yes', '--older-than', '7']);
    assert.deepEqual(r.removed, []);
    assert.equal(fs.existsSync(wt), true);
  });

  test('a non-integer --older-than is a usage error; outside a repository is a failure to look', () => {
    const bad = runGsdTools(['mn', 'worktree-gc', '--older-than', 'soon', '--json-errors'], repo);
    assert.equal(JSON.parse(bad.error.trim().split('\n').at(-1)).reason, 'usage');
    const plain = createTempDir('gsd-worktree-gc-plain-');
    const r = runGsdTools(['mn', 'worktree-gc', '--json-errors'], plain);
    cleanup(plain);
    assert.equal(r.success, false);
    assert.equal(JSON.parse(r.error.trim().split('\n').at(-1)).cause, 'not_a_repo');
  });
});
