'use strict';

/**
 * clean-state.mjs — the gate that turns ship.md's "Clean working tree?" question
 * into an exit code, and adds the one state `git status --short` cannot show.
 *
 * ship.md asks the model to read `git status --short` and stop on output. That is
 * discipline, not mechanism. And a stopped cherry-pick or rebase can leave the
 * tree clean while history sits halfway through an operation — status is empty,
 * ship continues. Those two cases are what this file pins.
 *
 * The non-blocking half carries as much weight as the detection: `.planning/`
 * churns while the work itself runs, so a gate that failed on it would block every
 * phase and be switched off the day it shipped.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode, runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'clean-state.mjs',
);

const CLEAN = 0;
const UNCLEAN = 1;
const CANNOT_LOOK = 2;

// The display cap in the script. Named here so the boundary tests below stay
// honest if it ever moves.
const SHOWN = 10;

describe('clean-state gate', () => {
  let project;
  let phaseDir;
  const extra = [];

  beforeEach(() => {
    project = createTempGitProject('gsd-clean-state-');
    phaseDir = path.join(project, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(project);
    while (extra.length) cleanup(extra.pop());
  });

  function git(args, cwd = project) {
    const r = runGit(args, { cwd, timeoutMs: 30000 });
    assert.equal(r.outcome, OUTCOME.EXITED, `git ${args.join(' ')} did not exit: ${r.stderr}`);
    assert.equal(r.exitCode, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  function run(dir = phaseDir) {
    return runNode([SCRIPT, '--dir', dir], { timeoutMs: 30000 });
  }

  function commitAll(message) {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message]);
  }

  // ── detection ─────────────────────────────────────────────────────────────

  test('passes a clean tree', () => {
    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, CLEAN, `a clean tree must pass: ${r.stderr}`);
  });

  test('blocks an untracked file outside .planning and names it', () => {
    fs.writeFileSync(path.join(project, 'scratch.txt'), 'x');

    const r = run();
    assert.equal(r.exitCode, UNCLEAN, `untracked work must block: ${r.stdout}`);
    assert.match(r.stderr, /1 path\(s\) changed outside \.planning\//);
    assert.match(r.stderr, /scratch\.txt/);
  });

  test('blocks a modified tracked file', () => {
    fs.writeFileSync(path.join(project, 'a.txt'), 'one');
    commitAll('add a');
    fs.writeFileSync(path.join(project, 'a.txt'), 'two');

    const r = run();
    assert.equal(r.exitCode, UNCLEAN);
    assert.match(r.stderr, /a\.txt/);
  });

  test('names a path with a space and a non-ASCII letter intact', () => {
    // -z exists for exactly this: plain porcelain quotes such paths and a
    // naive reader would report the quoting, not the file.
    fs.writeFileSync(path.join(project, 'мой файл.txt'), 'x');

    const r = run();
    assert.equal(r.exitCode, UNCLEAN);
    assert.match(r.stderr, /мой файл\.txt/);
  });

  test('reports a staged rename once, under its new path, with the old path not mangled in', () => {
    // A rename is two records in `-z` output. Reading the second as a normal
    // record cuts its first three characters and reports a path that never existed.
    fs.writeFileSync(path.join(project, 'old-name.txt'), 'x');
    commitAll('add old');
    git(['mv', 'old-name.txt', 'new-name.txt']);

    const r = run();
    assert.equal(r.exitCode, UNCLEAN);
    assert.match(r.stderr, /1 path\(s\) changed/, `a rename is one change: ${r.stderr}`);
    const listed = r.stderr
      .split('\n')
      .filter((line) => line.startsWith('  '))
      .map((line) => line.trim());
    assert.deepEqual(listed, ['new-name.txt'], 'the old path must not appear, whole or with its head cut off');
  });

  // ── the state status cannot show ──────────────────────────────────────────

  test('blocks an unfinished cherry-pick even though the tree is clean', () => {
    // Status is empty here by construction; only the marker file gives it away.
    const head = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(project, '.git', 'CHERRY_PICK_HEAD'), `${head}\n`);
    assert.equal(git(['status', '--porcelain']), '', 'precondition: status really is empty');

    const r = run();
    assert.equal(r.exitCode, UNCLEAN, `an unfinished operation must block: ${r.stdout}`);
    assert.match(r.stderr, /git operation not finished: cherry-pick/);
  });

  test('blocks an unfinished rebase (directory marker)', () => {
    fs.mkdirSync(path.join(project, '.git', 'rebase-merge'));

    const r = run();
    assert.equal(r.exitCode, UNCLEAN);
    assert.match(r.stderr, /git operation not finished: rebase/);
  });

  test('finds the operation marker inside a linked worktree, where .git is a file', () => {
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clean-state-wt-'));
    extra.push(linked);
    fs.rmSync(linked, { recursive: true });
    git(['worktree', 'add', '-q', '-b', 'linked-branch', linked]);
    const marker = git(['rev-parse', '--git-path', 'CHERRY_PICK_HEAD'], linked);
    const head = git(['rev-parse', 'HEAD'], linked);
    fs.writeFileSync(path.resolve(linked, marker), `${head}\n`);

    const linkedPhase = path.join(linked, '.planning', 'phases', '01-demo');
    fs.mkdirSync(linkedPhase, { recursive: true });

    const r = run(linkedPhase);
    assert.equal(r.exitCode, UNCLEAN, `a hand-built .git/ path would miss this: ${r.stdout}`);
    assert.match(r.stderr, /cherry-pick/);
  });

  // ── what must NOT block ───────────────────────────────────────────────────

  test('ignores changes under .planning/', () => {
    // Planning state changes while the work runs; requiring it clean would
    // block every phase.
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), 'draft');
    fs.writeFileSync(path.join(project, '.planning', 'STATE.md'), 'edited');

    const r = run();
    assert.equal(r.exitCode, CLEAN, `.planning churn must not block: ${r.stderr}`);
  });

  test('does not treat a leftover .continue-here.md as an abandoned session', () => {
    // resume-project deletes HANDOFF.json but not this file, so its presence
    // says nothing about whether the session was dropped.
    fs.writeFileSync(path.join(phaseDir, '.continue-here.md'), 'resume here');

    const r = run();
    assert.equal(r.exitCode, CLEAN, `a healthy phase must pass: ${r.stderr}`);
  });

  // ── display cap boundary ──────────────────────────────────────────────────

  for (const [count, tail] of [
    [SHOWN - 1, false],
    [SHOWN, false],
    [SHOWN + 1, true],
  ]) {
    test(`lists ${count} changed path(s)${tail ? ' and counts the one it cuts' : ' in full'}`, () => {
      for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(project, `f${String(i).padStart(2, '0')}.txt`), 'x');
      }

      const r = run();
      assert.equal(r.exitCode, UNCLEAN);
      assert.match(r.stderr, new RegExp(`${count} path\\(s\\) changed`));
      if (tail) {
        assert.match(r.stderr, /… and 1 more/);
        assert.doesNotMatch(r.stderr, /f10\.txt/, 'the 11th path is counted, not listed');
      } else {
        assert.doesNotMatch(r.stderr, /and \d+ more/);
        assert.match(r.stderr, new RegExp(`f${String(count - 1).padStart(2, '0')}\\.txt`));
      }
    });
  }

  // ── cannot look is not unclean ────────────────────────────────────────────

  test('exits 2, not 1, outside a git repository', () => {
    // Unclean and "could not look" must stay distinct: the second is an
    // environment fault, and routing it as a finding would send the reader
    // to clean a tree that was never examined.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-clean-state-nogit-'));
    extra.push(outside);

    const r = run(outside);
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, CANNOT_LOOK, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /cannot look/);
  });

  test('exits 2 for a missing --dir argument', () => {
    const r = runNode([SCRIPT], { timeoutMs: 30000 });
    assert.equal(r.exitCode, CANNOT_LOOK);
    assert.match(r.stderr, /usage/);
  });

  test('exits 2 for a phase directory that does not exist', () => {
    const r = run(path.join(project, 'no-such-dir'));
    assert.equal(r.exitCode, CANNOT_LOOK);
    assert.match(r.stderr, /not found/);
  });
});
