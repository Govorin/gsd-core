'use strict';

/**
 * #4799 — a sequential executor sitting in a linked phase worktree must be able to commit on the
 * configured phase branch.
 *
 * The executor's Step 0 pre-commit assertion applied the per-agent branch allow-list whenever `.git`
 * was a file, i.e. in ANY linked worktree. A deliberately sequential run
 * (`workflow.use_worktrees: false`, phase branching) inside a linked worktree on `feature/phase-48`
 * is not an agent-isolated worktree, so the commit was refused after the work was done.
 *
 * The orchestrator tells each executor by value, in that executor's own prompt, which kind of
 * dispatch it is: a `<sequential_execution>` block on a sequential dispatch, a
 * `<worktree_branch_check>` block on an isolated one. The executor adds `--sequential` to the Step 0
 * guard verb (ADR-5211: `worktree guard pre-commit`) only from that block; with no block (unknown)
 * the allow-list applies, so the guard still fails closed. No shared state (a sentinel file, an
 * environment variable) carries the decision, so two plans in one wave cannot overwrite each other's.
 *
 * These run the shipped Step 0 block, launcher substituted the way the orchestrator substitutes
 * it, against real repositories — a linked worktree and a main checkout.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanup, createTempDir, TOOLS_PATH } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_IDENTITY_ENV } = require('./helpers/worktree-guard-corpus.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const gitEnv = { ...process.env, ...GIT_IDENTITY_ENV };
const git = (args, cwd) => gitOrThrow(args, { cwd, env: gitEnv }).trim();

/** The first ```bash block after the "Pre-commit HEAD safety assertion" heading in the executor. */
function extractStep0Bash() {
  const lines = splitLines(read('agents/gsd-executor.md'));
  const heading = lines.findIndex((line) => line.includes('Pre-commit HEAD safety assertion'));
  assert.notEqual(heading, -1, 'executor Step 0 heading not found');
  const body = [];
  let inBash = false;
  for (const line of lines.slice(heading + 1)) {
    if (!inBash && /^\s*```bash\s*$/.test(line)) inBash = true;
    else if (inBash && /^\s*```\s*$/.test(line)) return body.join('\n');
    else if (inBash) body.push(line);
  }
  throw new Error('no bash block after the Step 0 heading');
}

const BASH = extractStep0Bash();
const LAUNCHER = `node '${TOOLS_PATH.split(path.sep).join('/')}'`;

/** What the executor does with the snippet: the launcher from its prompt, `--sequential` only from the block. */
function asExecutorWouldRun(sequentialBlockInPrompt) {
  assert.match(BASH, /^\{GSD_TOOLS_CMD\} worktree guard pre-commit$/m, 'Step 0 must run the pre-commit guard verb');
  const command = BASH.replace('{GSD_TOOLS_CMD}', LAUNCHER);
  return sequentialBlockInPrompt ? command.replace('worktree guard pre-commit', 'worktree guard pre-commit --sequential') : command;
}

function runStep0(t, { branch, sequential, linkedWorktree = true }) {
  const dir = createTempDir('gsd-4799-');
  t.after(() => cleanup(dir));
  const main = path.join(dir, 'main');
  git(['init', '-q', main], dir);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
  // The project's configured base branch is protected (#3819); pin it so the default branch
  // name of the host's git does not decide the row.
  fs.mkdirSync(path.join(main, '.planning'));
  fs.writeFileSync(path.join(main, '.planning', 'config.json'), JSON.stringify({ git: { base_branch: 'main' } }));
  let cwd = main;
  if (linkedWorktree) {
    cwd = path.join(dir, 'wt');
    git(['worktree', 'add', '-q', '--detach', cwd], main);
  }
  const head = git(['rev-parse', 'HEAD'], cwd);
  git(['update-ref', `refs/heads/${branch}`, head], cwd);
  git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd);
  const r = runHook('-c', [`set -e\n${asExecutorWouldRun(sequential)}\nprintf 'GUARD_PASSED\n'`], {
    interpreter: 'bash', cwd, timeoutMs: PROBE_TIMEOUT_MS, env: gitEnv,
  });
  const json = JSON.parse(r.stdout.slice(0, r.stdout.lastIndexOf('}') + 1));
  return { status: r.exitCode, json, passed: r.stdout.endsWith('GUARD_PASSED\n') };
}

describe('#4799 executor Step 0: the branch allow-list follows the dispatch, not the physical worktree', () => {
  test('sequential dispatch in a linked phase worktree on feature/phase-48 may commit', (t) => {
    const r = runStep0(t, { branch: 'feature/phase-48', sequential: true });
    assert.equal(r.status, 0);
    assert.equal(r.passed, true);
  });

  test('sequential dispatch still refuses a protected branch', (t) => {
    const r = runStep0(t, { branch: 'main', sequential: true });
    assert.equal(r.status, 1);
    assert.equal(r.json.code, 'protected_branch');
  });

  test('isolated dispatch (no sequential block) on a non-agent branch is still refused', (t) => {
    const r = runStep0(t, { branch: 'feature/phase-48', sequential: false });
    assert.equal(r.status, 1);
    assert.equal(r.json.code, 'namespace_mismatch');
  });

  test('isolated dispatch on an agent-* branch may commit', (t) => {
    const r = runStep0(t, { branch: 'agent-42', sequential: false });
    assert.equal(r.status, 0);
    assert.equal(r.passed, true);
  });

  test('an executor that cannot tell which dispatch it is (no --sequential) fails closed', (t) => {
    const r = runStep0(t, { branch: 'feature/phase-48', sequential: false });
    assert.equal(r.status, 1);
    assert.equal(r.passed, false);
  });

  for (const [branch, expected] of [['agent-', 1], ['agent-x', 0], ['xagent-1', 1], ['worktree-agent-7', 0], ['worktree-wf_abc', 0]]) {
    test(`allow-list boundary: isolated worktree on '${branch}' ${expected === 0 ? 'passes' : 'is refused'}`, (t) => {
      assert.equal(runStep0(t, { branch, sequential: false }).status, expected);
    });
  }

  test('a main checkout (.git is a directory) is not subject to the allow-list in either mode', (t) => {
    assert.equal(runStep0(t, { branch: 'feature/phase-48', sequential: false, linkedWorktree: false }).status, 0);
  });
});

describe('#4799 the orchestrator tells each sequential executor, in its own prompt', () => {
  const sequentialBlock = /<sequential_execution>/;

  test('execute-phase sequential dispatch carries the block', () => {
    const doc = read('gsd-core/workflows/execute-phase.md');
    const sequentialMode = doc.slice(doc.indexOf('**Sequential mode**'));
    assert.match(sequentialMode.slice(0, 2500), sequentialBlock);
  });

  test('quick.md carries the block on a dispatch that is not isolated', () => {
    assert.match(read('gsd-core/workflows/quick.md'), sequentialBlock);
  });

  test('execute-plan Pattern B segment dispatches carry the block', () => {
    const doc = read('gsd-core/workflows/execute-plan.md');
    const patternB = doc.slice(doc.indexOf('**Pattern B: segments are NOT isolated'));
    assert.match(patternB.slice(0, 1500), sequentialBlock);
  });

  test('the executor sets the literal only from that block', () => {
    const doc = read('agents/gsd-executor.md');
    const step0 = doc.slice(doc.indexOf('Pre-commit HEAD safety assertion'));
    assert.match(step0.slice(0, 4500), /`<sequential_execution>`/);
    assert.match(step0.slice(0, 4500), /fail(s)? closed/i);
  });
});
