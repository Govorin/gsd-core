'use strict';

/**
 * blast-radius.mjs — compares what a phase CHANGED against what it DECLARED.
 *
 * The gate has run on the live project since an earlier session and had no
 * tests, which is the same shape as the defect the fork exists to close: a
 * mechanism whose behaviour nothing pins. These tests pin the contract its own
 * header states — most importantly the three exit codes, since a gate built on
 * `command-exit-zero` is only as good as its exit discipline.
 *
 * The rule under test: a file changed but declared in no PLAN.md means either
 * the executor left the task's boundary, or the plan was incomplete and nobody
 * noticed. Both need a human, and neither is visible to tests, lint or types —
 * an undeclared edit compiles exactly like a declared one.
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
  'blast-radius.mjs',
);

const MATCHED = 0;
const DIVERGED = 1;
const CANNOT_LOOK = 2;

describe('blast-radius gate', () => {
  let repo;
  let phaseDir;

  beforeEach(() => {
    repo = createTempGitProject('gsd-blast-radius-');
    phaseDir = path.join(repo, '.planning', 'phases', '01-example');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(repo);
  });

  /** A plan declaring the files it intends to touch. */
  function writePlan(name, files) {
    const list = files.map((f) => `  - ${f}`).join('\n');
    fs.writeFileSync(
      path.join(phaseDir, name),
      `---\nwave: 1\nfiles_modified:\n${list}\nstatus: complete\n---\n\n# ${name}\n`,
    );
  }

  /** Commit a file so it appears in the phase diff. */
  function commitFile(relPath, body, message) {
    const full = path.join(repo, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    runGit(['add', '-A'], { cwd: repo });
    runGit(['commit', '-m', message, '--no-verify'], { cwd: repo });
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, ...extra], { cwd: repo, timeoutMs: 60000 });
  }

  // ── could-not-look is its own answer ──────────────────────────────────────
  //
  // The script's header states this explicitly: "не смог проверить" ≠ "проверил
  // и всё плохо". A gate that conflated them would either block on a missing
  // directory or, worse, pass on one.

  test('exits 2 when the phase directory does not exist', () => {
    const r = runNode([SCRIPT, '--dir', path.join(repo, 'nope')], { cwd: repo, timeoutMs: 60000 });
    assert.equal(r.exitCode, CANNOT_LOOK, `a missing phase dir is unverifiable, not a failure: ${r.stderr}`);
  });

  test('exits 2 when the phase declares no plans at all', () => {
    // An empty phase directory gives nothing to compare a diff against.
    const r = run();
    assert.equal(r.exitCode, CANNOT_LOOK, `no plans means nothing to verify: ${r.stdout}${r.stderr}`);
  });

  test('exits 2 outside a git repository', () => {
    const notGit = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-not-git-'));
    const phase = path.join(notGit, 'phase');
    fs.mkdirSync(phase, { recursive: true });
    fs.writeFileSync(
      path.join(phase, 'a-PLAN.md'),
      '---\nwave: 1\nfiles_modified:\n  - src/a.ts\n---\n',
    );

    const r = runNode([SCRIPT, '--dir', phase], { cwd: notGit, timeoutMs: 60000 });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- outside the repo fixture; cleanup() targets project trees
    fs.rmSync(notGit, { recursive: true, force: true });
    assert.equal(r.exitCode, CANNOT_LOOK, 'no git history means the diff cannot be computed');
  });

  // ── the comparison itself ─────────────────────────────────────────────────

  test('accepts a phase whose changes were all declared', () => {
    writePlan('01-PLAN.md', ['src/declared.ts']);
    commitFile('src/declared.ts', 'export const a = 1;\n', 'feat(01): declared change');

    const r = run(['--base', 'HEAD~1']);
    assert.equal(
      r.exitCode,
      MATCHED,
      `a declared change must not be reported: ${r.stdout}${r.stderr}`,
    );
  });

  test('reports a file changed but declared in no plan', () => {
    writePlan('01-PLAN.md', ['src/declared.ts']);
    commitFile('src/declared.ts', 'export const a = 1;\n', 'feat(01): declared');
    commitFile('src/undeclared.ts', 'export const b = 2;\n', 'feat(01): undeclared');

    const r = run(['--base', 'HEAD~2']);
    assert.equal(r.exitCode, DIVERGED, `an undeclared file must be reported: ${r.stdout}`);
    // The file must be named — a count alone leaves the reader to hunt for it.
    const output = `${r.stdout}${r.stderr}`;
    assert.match(output, /undeclared\.ts/, `the offending path must appear in the report: ${output}`);
  });

  test('does not report a declared file that went unchanged', () => {
    // Asymmetric by design: declaring more than you touched is a plan that
    // overestimated, not an executor that strayed. Only the other direction is
    // evidence of a boundary being crossed.
    writePlan('01-PLAN.md', ['src/touched.ts', 'src/never-written.ts']);
    commitFile('src/touched.ts', 'export const a = 1;\n', 'feat(01): partial');

    const r = run(['--base', 'HEAD~1']);
    assert.equal(
      r.exitCode,
      MATCHED,
      `an unused declaration is not a divergence: ${r.stdout}${r.stderr}`,
    );
  });

  test('unions declarations across every plan in the phase', () => {
    // A file declared by plan 02 must not be reported while auditing plan 01 —
    // the phase is the unit, not the individual plan.
    writePlan('01-PLAN.md', ['src/one.ts']);
    writePlan('02-PLAN.md', ['src/two.ts']);
    commitFile('src/one.ts', 'export const a = 1;\n', 'feat(01): one');
    commitFile('src/two.ts', 'export const b = 2;\n', 'feat(01): two');

    const r = run(['--base', 'HEAD~2']);
    assert.equal(r.exitCode, MATCHED, `declarations union across plans: ${r.stdout}${r.stderr}`);
  });
});
