'use strict';

/**
 * TRANSITIONAL — deleted together with
 * capabilities/mn-verify-gate/scripts/worktree-gc.mjs.
 *
 * Builds the same repository twice (an idle worktree, one with unique
 * commits, one with uncommitted changes) and runs the legacy script on one
 * copy and `gsd-tools mn worktree-gc` on the other: the same branches are
 * kept, the same are reapable, and after `--yes` the same branches survive.
 * The script's report is parsed (KEPT / DRY RUN lists) into branch sets.
 *
 * The deliberate difference — a branch whose commits cannot be counted is
 * kept, and no sweep without a resolvable main ref — needs a repository the
 * script would wreck, so it is pinned in tests/mn-worktree-gc.test.cjs.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');

const LEGACY = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'worktree-gc.mjs');

function build(repo) {
  const add = (name) => {
    const wt = path.join(repo, '.worktrees', name);
    runGit(['worktree', 'add', '-b', name, wt], { cwd: repo });
    return wt;
  };
  add('worktree-idle');
  const precious = add('worktree-precious');
  fs.writeFileSync(path.join(precious, 'work.txt'), 'only here\n');
  runGit(['add', '-A'], { cwd: precious });
  runGit(['commit', '-m', 'feat: unique', '--no-verify'], { cwd: precious });
  const dirty = add('worktree-dirty');
  fs.writeFileSync(path.join(dirty, 'notes.txt'), 'uncommitted\n');
}

/** { kept, reap } branch-name sets from the script's report. */
function parseLegacy(stdout) {
  const kept = [];
  const reap = [];
  let section = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('KEPT')) section = 'kept';
    else if (line.startsWith('DRY RUN')) section = 'reap';
    else if (line === '') section = section === 'reap' ? null : section;
    else if (section !== null) {
      const m = line.match(/^ {2}(worktree-[\w-]+)/);
      if (m) (section === 'kept' ? kept : reap).push(m[1]);
    }
  }
  return { kept: kept.sort(), reap: reap.sort() };
}

const branchesOf = (repo) =>
  runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { cwd: repo })
    .stdout.split('\n')
    .filter((b) => b.startsWith('worktree-'))
    .sort();

describe('worktree-gc: legacy script ↔ gsd-tools mn worktree-gc', () => {
  let a;
  let b;
  beforeEach(() => {
    a = createTempGitProject('gsd-wtgc-eq-a-');
    b = createTempGitProject('gsd-wtgc-eq-b-');
    build(a);
    build(b);
  });
  afterEach(() => {
    cleanup(a);
    cleanup(b);
  });

  test('same kept / reapable classification in a dry run', () => {
    const old = runNode([LEGACY], { cwd: a, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(old.outcome, OUTCOME.EXITED);
    assert.equal(old.exitCode, 0, old.stderr);
    const was = parseLegacy(old.stdout);
    const now = JSON.parse(runGsdTools(['mn', 'worktree-gc'], b).output);
    assert.deepEqual(was, { kept: ['worktree-dirty', 'worktree-precious'], reap: ['worktree-idle'] });
    assert.deepEqual({ kept: now.kept.map((k) => k.branch).sort(), reap: now.reapable.map((r) => r.branch).sort() }, was);
  });

  test('the same branches survive --yes', () => {
    assert.equal(runNode([LEGACY, '--yes'], { cwd: a, timeoutMs: PROBE_TIMEOUT_MS }).exitCode, 0);
    assert.equal(runGsdTools(['mn', 'worktree-gc', '--yes'], b).success, true);
    assert.deepEqual(branchesOf(b), branchesOf(a));
    assert.deepEqual(branchesOf(b), ['worktree-dirty', 'worktree-precious']);
  });
});
