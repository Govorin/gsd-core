'use strict';

/**
 * worktree-gc.mjs — garbage-collects abandoned worktrees, with one rule that
 * matters more than the collection itself.
 *
 * It exists because `worktree reap-orphans` only sweeps trees carrying a `locked`
 * file — a crash while locked. A worktree abandoned the ordinary way (a session
 * died, an orchestrator was killed, a wave was interrupted) has no such file and
 * is invisible to the sweeper. gsd-health warns about them (W017) but offers no
 * repair action, so nothing removes them automatically. Observed live: 35
 * abandoned worktrees and 19 GB, filling the disk until writes failed. Three of
 * them carried real work.
 *
 * Hence the rule these tests exist for: **a branch holding unique commits is
 * never deleted, not even with --yes.** It is reported instead, with the commands
 * to rescue it. Automation that erases unreproducible work is worse than no
 * automation — 19 GB is cheap, 33 commits are not.
 *
 * The tests below verify that rule holds under the flag that would otherwise
 * authorize deletion, because that is the only condition under which breaking it
 * would cost anything.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, runGit } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'worktree-gc.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 60000;

describe('worktree-gc', () => {
  let repo;

  beforeEach(() => {
    repo = createTempGitProject('gsd-worktree-gc-');
  });

  afterEach(() => {
    cleanup(repo);
  });

  function run(extra = []) {
    return runNode([SCRIPT, ...extra], { cwd: repo, timeoutMs: RUN_TIMEOUT_MS });
  }

  /**
   * A worktree whose branch carries a commit that exists nowhere else.
   *
   * The name must start with `worktree-`: the script scopes itself to that
   * prefix, so a branch called anything else is invisible to it. Worth stating,
   * because a fixture named `feat-*` here passes the deletion tests for the
   * wrong reason — nothing was ever a candidate.
   */
  function addWorktreeWithUniqueWork(name) {
    const wt = path.join(repo, '.worktrees', name);
    runGit(['worktree', 'add', '-b', name, wt], { cwd: repo });
    fs.writeFileSync(path.join(wt, 'unique-work.txt'), 'work that exists only here\n');
    runGit(['add', '-A'], { cwd: wt });
    runGit(['commit', '-m', `feat(${name}): unique work`, '--no-verify'], { cwd: wt });
    return wt;
  }

  test('is a sweeper, not a gate: a clean repo exits 0', () => {
    // Its header says so outright. A cleanup tool that failed would block every
    // point it ran at for reasons unrelated to correctness.
    const r = run();
    assert.equal(r.exitCode, 0, `a sweeper must not fail a clean repo: ${r.stderr}`);
  });

  test('defaults to reporting, without deleting anything', () => {
    const wt = addWorktreeWithUniqueWork('worktree-dry-run');

    const r = run();
    assert.equal(r.exitCode, 0, `${r.stderr}`);
    assert.ok(fs.existsSync(wt), 'no --yes means nothing is removed');
  });

  test('never deletes a branch holding unique commits, even with --yes', () => {
    // The rule the script exists to guarantee. --yes is the only condition under
    // which breaking it would cost anything, so it is the only one worth testing.
    const wt = addWorktreeWithUniqueWork('worktree-precious');

    const r = run(['--yes']);
    assert.equal(r.exitCode, 0, `${r.stdout}${r.stderr}`);
    assert.ok(
      fs.existsSync(path.join(wt, 'unique-work.txt')),
      'unique commits must survive --yes — erasing unreproducible work is worse than not collecting',
    );

    const branches = runGit(['branch', '--list', 'worktree-precious'], { cwd: repo });
    assert.match(branches.stdout, /worktree-precious/, 'the branch itself must survive too');
  });

  test('names the worktree it declined to remove', () => {
    // Surviving silently would be its own failure: the disk stays full and
    // nobody learns which tree to look at.
    addWorktreeWithUniqueWork('worktree-reported');

    const r = run(['--yes']);
    assert.match(
      `${r.stdout}${r.stderr}`,
      /worktree-reported/,
      `a retained worktree must be named so a human can act on it: ${r.stdout}`,
    );
  });

  test('--older-than does not remove a worktree created moments ago', () => {
    const wt = addWorktreeWithUniqueWork('worktree-fresh');

    const r = run(['--yes', '--older-than', '7']);
    assert.equal(r.exitCode, 0, `${r.stderr}`);
    assert.ok(fs.existsSync(wt), 'an age filter must exclude a tree younger than the window');
  });
});
