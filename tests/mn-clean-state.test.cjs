'use strict';

/**
 * `gsd_run check mn-clean-state` — turns ship.md's "Clean working tree?" question into a verdict,
 * and adds the one state `git status --short` cannot show (src/gate-mn-clean-state.cts; replaces
 * capabilities/mn-verify-gate/scripts/clean-state.mjs).
 *
 * ship.md asks the model to read `git status --short` and stop on output. That is discipline, not
 * mechanism. And a stopped cherry-pick or rebase can leave the tree clean while history sits
 * halfway through an operation — status is empty, ship continues.
 *
 * The non-blocking half carries as much weight as the detection: `.planning/` churns while the work
 * runs, so a gate that failed on it would block every phase and be switched off the day it shipped.
 *
 * The gate is project-scoped: it judges the project's working tree and ignores the phase argument
 * the dispatcher appends.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnCleanState, CLEAN_STATE_SHOWN, parsePorcelainV2 } = require('../gsd-core/bin/lib/gate-mn-clean-state.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** Bounds one git call building the fixture (add, commit, worktree add). */
const FIXTURE_GIT_TIMEOUT_MS = 30000;

describe('check mn-clean-state', () => {
  let project;
  let phaseDir;
  const extra = [];

  beforeEach(() => {
    project = createTempGitProject('gsd-mn-clean-state-');
    phaseDir = path.join(project, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(project);
    while (extra.length) cleanup(extra.pop());
  });

  function git(args, cwd = project) {
    const r = runGit(args, { cwd, timeoutMs: FIXTURE_GIT_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, `git ${args.join(' ')} did not exit: ${r.stderr}`);
    assert.equal(r.exitCode, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  }

  /** The verdict payload for `projectDir` (defaults to the fixture project), phase argument as dispatched. */
  function gate(projectDir = project, args = ['01']) {
    return evaluateMnCleanState({ projectDir, args }).payload;
  }

  function commitAll(message) {
    git(['add', '-A']);
    git(['commit', '-q', '-m', message]);
  }

  // ── detection ─────────────────────────────────────────────────────────────

  test('passes a clean tree', () => {
    const v = gate();
    assert.equal(v.block, false);
    assert.equal(v.status, 'pass');
  });

  test('blocks an untracked file outside .planning and names it', () => {
    fs.writeFileSync(path.join(project, 'scratch.txt'), 'x');
    const v = gate();
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(v.dirty, ['scratch.txt']);
  });

  test('blocks a modified tracked file', () => {
    fs.writeFileSync(path.join(project, 'a.txt'), 'one');
    commitAll('add a');
    fs.writeFileSync(path.join(project, 'a.txt'), 'two');
    assert.deepEqual(gate().dirty, ['a.txt']);
  });

  test('blocks a modified tracked file whose status has a leading space (` M`)', () => {
    // The exec seam trims its output; porcelain v1's first record ` M a.txt` would lose a character.
    fs.writeFileSync(path.join(project, 'a.txt'), 'one');
    commitAll('add a');
    fs.writeFileSync(path.join(project, 'a.txt'), 'two');
    fs.writeFileSync(path.join(project, 'b.txt'), 'new');
    assert.deepEqual(gate().dirty.sort(), ['a.txt', 'b.txt']);
  });

  test('names a path with a space and a non-ASCII letter intact', () => {
    // -z exists for exactly this: plain porcelain quotes such paths.
    fs.writeFileSync(path.join(project, 'мой файл.txt'), 'x');
    assert.deepEqual(gate().dirty, ['мой файл.txt']);
  });

  test('reports a staged rename once, under its new path, with the old path not mangled in', () => {
    // A rename is two records in `-z` output; reading the second as a normal record reports a
    // path that never existed.
    fs.writeFileSync(path.join(project, 'old-name.txt'), 'x');
    commitAll('add old');
    git(['mv', 'old-name.txt', 'new-name.txt']);
    assert.deepEqual(gate().dirty, ['new-name.txt']);
  });

  test('parsePorcelainV2 reads every record type and skips a rename\'s original path', () => {
    const out = [
      '1 .M N... 100644 100644 100644 abc abc a b.txt',
      '2 R. N... 100644 100644 100644 abc abc R100 new name.txt',
      'old name.txt',
      'u UU N... 100644 100644 100644 100644 abc abc abc conflict.txt',
      '? untracked file.txt',
      '',
    ].join('\0');
    assert.deepEqual(parsePorcelainV2(out), ['a b.txt', 'new name.txt', 'conflict.txt', 'untracked file.txt']);
  });

  // ── the state status cannot show ──────────────────────────────────────────

  test('blocks an unfinished cherry-pick even though the tree is clean', () => {
    const head = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(project, '.git', 'CHERRY_PICK_HEAD'), `${head}\n`);
    assert.equal(git(['status', '--porcelain']), '', 'precondition: status really is empty');
    const v = gate();
    assert.equal(v.block, true);
    assert.deepEqual([v.operations, v.dirty], [['cherry-pick'], []]);
  });

  test('blocks an unfinished rebase (directory marker)', () => {
    fs.mkdirSync(path.join(project, '.git', 'rebase-merge'));
    assert.deepEqual(gate().operations, ['rebase']);
  });

  test('finds the operation marker inside a linked worktree, where .git is a file', () => {
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-mn-clean-state-wt-'));
    extra.push(linked);
    // Only the unique name is wanted: `git worktree add` creates the directory itself.
    cleanup(linked);
    git(['worktree', 'add', '-q', '-b', 'linked-branch', linked]);
    const marker = git(['rev-parse', '--git-path', 'CHERRY_PICK_HEAD'], linked);
    const head = git(['rev-parse', 'HEAD'], linked);
    fs.writeFileSync(path.resolve(linked, marker), `${head}\n`);
    fs.mkdirSync(path.join(linked, '.planning', 'phases', '01-demo'), { recursive: true });

    const v = gate(linked);
    assert.equal(v.block, true, 'a hand-built .git/ path would miss this');
    assert.deepEqual(v.operations, ['cherry-pick']);
  });

  // ── what must NOT block ───────────────────────────────────────────────────

  test('ignores changes under .planning/', () => {
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), 'draft');
    fs.writeFileSync(path.join(project, '.planning', 'STATE.md'), 'edited');
    assert.equal(gate().block, false);
  });

  test('does not treat a leftover .continue-here.md as an abandoned session', () => {
    fs.writeFileSync(path.join(phaseDir, '.continue-here.md'), 'resume here');
    assert.equal(gate().block, false);
  });

  test('is project-scoped: the phase argument is ignored, and none is needed', () => {
    fs.writeFileSync(path.join(project, 'scratch.txt'), 'x');
    for (const args of [[], ['01'], ['99'], ['.planning/phases/01-demo', 'REQ-1']]) {
      const v = gate(project, args);
      assert.equal(v.block, true, JSON.stringify(args));
      assert.deepEqual(v.dirty, ['scratch.txt'], JSON.stringify(args));
    }
  });

  // ── display cap boundary ──────────────────────────────────────────────────

  for (const [count, more] of [
    [CLEAN_STATE_SHOWN - 1, 0],
    [CLEAN_STATE_SHOWN, 0],
    [CLEAN_STATE_SHOWN + 1, 1],
  ]) {
    test(`lists ${count} changed path(s)${more ? ' and counts the one it cuts' : ' in full'}`, () => {
      for (let i = 0; i < count; i++) {
        fs.writeFileSync(path.join(project, `f${String(i).padStart(2, '0')}.txt`), 'x');
      }
      const v = gate();
      assert.equal(v.block, true);
      assert.equal(v.dirty.length, count);
      assert.equal(v.dirtyShown.length, Math.min(count, CLEAN_STATE_SHOWN));
      assert.equal(v.dirtyMore, more);
    });
  }

  // ── cannot look is not unclean ────────────────────────────────────────────

  test('outside a git repository the gate is unresolvable, not unclean', () => {
    // An environment fault routed as a finding would send the reader to clean a tree never examined.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-mn-clean-state-nogit-'));
    extra.push(outside);
    const v = gate(outside);
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('a git that fails mid-check is unresolvable', () => {
    let calls = 0;
    const deps = {
      runGit: () => {
        calls += 1;
        return calls === 1
          ? { exitCode: 0, stdout: project, stderr: '', signal: null, error: null, timedOut: false }
          : { exitCode: 128, stdout: '', stderr: 'fatal: index locked', signal: null, error: null, timedOut: false };
      },
    };
    assert.equal(evaluateMnCleanState({ projectDir: project, args: [] }, deps).payload.status, 'unresolvable');
  });

  // ── wiring ────────────────────────────────────────────────────────────────

  test('the capability runs check mn-clean-state at ship:pre', () => {
    const g = CAPABILITY.gates.find((x) => x.when === 'workflow.clean_state_enforce');
    assert.ok(g);
    assert.equal(g.point, 'ship:pre');
    assert.deepEqual(g.check, { query: 'mn-clean-state' });
  });

  test('gsd_run check mn-clean-state "${PHASE_DIR}" prints the verdict', () => {
    fs.writeFileSync(path.join(project, 'scratch.txt'), 'x');
    const payload = runMnCheck(project, 'mn-clean-state', [phaseDir]);
    assert.equal(payload.block, true);
    assert.deepEqual(payload.dirty, ['scratch.txt']);
  });
});
