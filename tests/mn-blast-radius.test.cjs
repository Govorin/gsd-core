'use strict';

/**
 * `gsd_run check mn-blast-radius` — compares what a phase CHANGED against what it DECLARED
 * (src/gate-mn-blast-radius.cts).
 *
 * The rule: a file changed but declared in no PLAN.md means either the executor left the task's
 * boundary, or the plan was incomplete and nobody noticed. Both need a human, and neither is
 * visible to tests, lint or types — an undeclared edit compiles exactly like a declared one.
 *
 * The phase's commits come from the shared evaluation-scope resolver (the commits its SUMMARYs list
 * under `## Task Commits`; the phase window, flagged `degraded`, when none are listed yet; the working
 * tree when the phase has committed nothing). Two layers: real-git fixtures for that history, and an
 * injected git runner for failure modes a real repository cannot easily produce. Assertions are on
 * the verdict (`block`, `status`) and its typed fields, never on message text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnBlastRadius, computeBlastRadius, foldNumstat } = require('../gsd-core/bin/lib/gate-mn-blast-radius.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** A plan declaring the files it intends to touch. */
function plan(files) {
  const list = files.map((f) => `  - ${f}`).join('\n');
  return `---\nwave: 1\nfiles_modified:\n${list}\nstatus: complete\n---\n\n# plan\n`;
}

/** A SUMMARY whose `## Task Commits` section lists `shas` — the resolver's evidence of the phase. */
function summary(shas) {
  const rows = shas.map((sha, i) => `${i + 1}. **Task ${i + 1}: work** - \`${sha}\` (feat)`).join('\n');
  return `---\nphase: 01\n---\n\n# Summary\n\n## Task Commits\n\n${rows}\n\n## Notes\n`;
}

describe('check mn-blast-radius (real git)', () => {
  let repo;
  let phaseDir;
  let phaseNumber;

  beforeEach(() => {
    repo = createTempGitProject('gsd-mn-blast-radius-');
    ({ phaseDir, phaseNumber } = makePhase(repo, {}, 'example'));
  });

  afterEach(() => {
    cleanup(repo);
  });

  function writePlan(name, files) {
    fs.writeFileSync(path.join(phaseDir, name), plan(files));
  }

  /** Write files (repo-relative), commit them with `message`, return the commit sha. */
  function commit(files, message, cwd = repo) {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(repo, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    runGit(['add', '-A'], { cwd });
    runGit(['commit', '--allow-empty', '-m', message, '--no-verify'], { cwd });
    return runGit(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
  }

  /** Record the task commits of the phase in its SUMMARY and commit it. */
  function summarize(shas) {
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), summary(shas));
    commit({}, 'docs(01-01): summary');
  }

  const gate = (extra = []) => evaluateMnBlastRadius({ projectDir: repo, args: [phaseNumber, ...extra] }).payload;
  const undeclaredPaths = (v) => v.undeclared.map((u) => u.path);

  // ── could-not-look is its own answer ──────────────────────────────────────

  test('a phase that does not exist is unresolvable', () => {
    const v = evaluateMnBlastRadius({ projectDir: repo, args: ['77'] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('a phase with no plans at all is unresolvable — nothing was declared to compare against', () => {
    const v = gate();
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.plans, 0);
  });

  test('plans that declare no files_modified are unresolvable, not a pass', () => {
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '---\nwave: 1\n---\n\n# plan\n');
    const v = gate();
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.declared, 0);
  });

  test('outside a git repository the radius is unresolvable', () => {
    const notGit = createMnProject('gsd-mn-blast-not-git-');
    const { phaseNumber: n } = makePhase(notGit, { '01-01-PLAN.md': plan(['src/a.ts']) });
    const v = evaluateMnBlastRadius({ projectDir: notGit, args: [n] }).payload;
    cleanup(notGit);
    assert.equal(v.status, 'unresolvable');
  });

  test('an unresolvable --base is unresolvable', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({}, 'docs(01): plan');
    const v = gate(['--base', 'no-such-ref']);
    assert.equal(v.status, 'unresolvable');
    assert.equal(typeof v.scopeReason, 'string');
  });

  // ── the comparison, on the phase's task commits ───────────────────────────

  test('accepts a phase whose task commits touched only declared files', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    const task = commit({ 'src/declared.ts': 'export const a = 1;\n' }, 'feat(01-01): declared change');
    summarize([task.slice(0, 7)]);
    const v = gate();
    assert.equal(v.block, false);
    assert.equal(v.scopeStatus, 'resolved');
    assert.equal(v.scopeSource, 'task-commits');
    assert.equal(v.commits, 1);
    assert.equal(v.matched, 1);
    assert.equal(v.workingTreeIncluded, false);
  });

  test('reports a file a task commit changed but no plan declared, with its line counts', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    const task = commit({ 'src/declared.ts': '1\n', 'src/undeclared.ts': 'a\nb\n' }, 'feat(01-01): declared and stray');
    summarize([task]);
    const v = gate();
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(v.undeclared, [{ path: 'src/undeclared.ts', added: 2, deleted: 0 }]);
    assert.equal(v.changedLines, 3);
  });

  // Review M7: the task commits are the executor's own report. A commit it did not list must not take
  // its files out of the radius; another project's or a sibling phase's commit must not enter it.
  test('a commit the SUMMARY leaves out still counts: its undeclared files block, marked unlisted-commit', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    const task = commit({ 'src/declared.ts': '1\n' }, 'feat(01-01): declared');
    commit({ 'src/stray.ts': 'a\nb\n' }, 'feat(01-01): not reported');
    const second = commit({ 'src/declared.ts': '2\n' }, 'feat(01-01): declared again');
    summarize([task, second]);
    const v = gate();
    assert.equal(v.block, true);
    assert.deepEqual(v.undeclared, [{ path: 'src/stray.ts', via: 'unlisted-commit', added: 2, deleted: 0 }]);
  });

  test('a sibling phase\'s declared file inside the window is attributed to it, not undeclared here', () => {
    const sibling = makePhase(repo, { '02-01-PLAN.md': plan(['src/parallel.ts']) }, 'parallel');
    assert.ok(sibling.phaseDir);
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    const task = commit({ 'src/declared.ts': '1\n' }, 'feat(01-01): declared');
    commit({ 'src/parallel.ts': '1\n' }, 'feat(02-01): parallel work');
    const second = commit({ 'src/declared.ts': '2\n' }, 'feat(01-01): declared again');
    summarize([task, second]);
    const v = gate();
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
    assert.deepEqual(v.attributedElsewhere, ['src/parallel.ts']);
  });

  test('another project\'s commit inside the phase window (monorepo) is outside the union, not undeclared', () => {
    const appDir = path.join(repo, 'apps', 'demo');
    const app = makePhase(appDir, { '01-01-PLAN.md': plan(['libs/demo/a.ts']) }, 'example');
    commit({}, 'docs(demo-01-01): plan');
    const task = commit({ 'libs/demo/a.ts': '1\n' }, 'feat(demo-01-01): a');
    commit({ 'apps/other/elsewhere.ts': '1\n', 'libs/other/b.ts': '1\n' }, 'feat(other-03): another project');
    const second = commit({ 'libs/demo/a.ts': '2\n' }, 'feat(demo-01-01): a again');
    fs.writeFileSync(path.join(app.phaseDir, '01-01-SUMMARY.md'), summary([task, second]));
    commit({}, 'docs(demo-01-01): summary');
    const v = evaluateMnBlastRadius({ projectDir: appDir, args: [app.phaseNumber] }).payload;
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
    assert.deepEqual(v.outsideUnion, ['apps/other/elsewhere.ts', 'libs/other/b.ts']);
    assert.deepEqual(v.attributedElsewhere, ['apps/other/elsewhere.ts', 'libs/other/b.ts']);
  });

  test('degraded phase window in a monorepo keeps only the project\'s files', () => {
    const appDir = path.join(repo, 'apps', 'demo');
    const app = makePhase(appDir, { '01-01-PLAN.md': plan(['libs/demo/a.ts']) }, 'example');
    commit({}, 'docs(demo-01-01): plan');
    commit({ 'libs/demo/a.ts': '1\n', 'libs/demo/stray.ts': '1\n' }, 'feat(demo-01-01): code');
    commit({ 'apps/other/elsewhere.ts': '1\n' }, 'feat(other-03): another project');
    const v = evaluateMnBlastRadius({ projectDir: appDir, args: [app.phaseNumber] }).payload;
    assert.equal(v.scopeStatus, 'degraded');
    assert.deepEqual(undeclaredPaths(v), ['libs/demo/stray.ts']);
    assert.deepEqual(v.attributedElsewhere, ['apps/other/elsewhere.ts']);
  });

  test('a listed commit not reachable from HEAD is named in unreachable', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    const task = commit({ 'src/declared.ts': '1\n' }, 'feat(01-01): declared');
    summarize([task, 'deadbeefcafe']);
    const v = gate();
    assert.equal(v.block, false);
    assert.deepEqual(v.unreachable, ['deadbeefcafe']);
  });

  test('does not report a declared file that went unchanged — it is undelivered, not a finding', () => {
    writePlan('01-01-PLAN.md', ['src/touched.ts', 'src/never-written.ts']);
    commit({}, 'docs(01-01): plan');
    summarize([commit({ 'src/touched.ts': '1\n' }, 'feat(01-01): partial')]);
    const v = gate();
    assert.equal(v.block, false);
    assert.deepEqual(v.undelivered, ['src/never-written.ts']);
  });

  test('unions declarations across every plan in the phase', () => {
    writePlan('01-01-PLAN.md', ['src/one.ts']);
    writePlan('01-02-PLAN.md', ['src/two.ts']);
    commit({}, 'docs(01): plans');
    const one = commit({ 'src/one.ts': '1\n' }, 'feat(01-01): one');
    const two = commit({ 'src/two.ts': '2\n' }, 'feat(01-02): two');
    summarize([one, two]);
    const v = gate();
    assert.equal(v.block, false);
    assert.equal(v.declared, 2);
    assert.equal(v.plans, 2);
  });

  test('reads every files_modified shape: inline list, blank line in the block, ./ prefix, comment', () => {
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '---\nfiles_modified: [src/a.ts, "src/b.ts"]\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '---\nfiles_modified:\n  - ./src/c.ts\n\n  - src/d.ts # the second file\n---\n');
    commit({}, 'docs(01): plans');
    summarize([commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n', 'src/c.ts': '3\n', 'src/d.ts': '4\n' }, 'feat(01-01): four')]);
    const v = gate();
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
    assert.equal(v.matched, 4);
  });

  test('planning artifacts and lockfiles are excluded from the comparison', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({}, 'docs(01-01): plan');
    summarize([commit({ 'src/a.ts': '1\n', '.planning/STATE.md': '# state\n', 'package-lock.json': '{}\n' }, 'feat(01-01): a')]);
    const v = gate();
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
    assert.equal(v.changedFiles, 1);
  });

  test('a rename counts its target path', () => {
    commit({ 'src/old-name.ts': 'export const a = 1;\n' }, 'chore: seed');
    writePlan('01-01-PLAN.md', ['src/new-name.ts']);
    commit({}, 'docs(01-01): plan');
    runGit(['mv', 'src/old-name.ts', 'src/new-name.ts'], { cwd: repo });
    runGit(['commit', '-m', 'refactor(01-01): rename', '--no-verify'], { cwd: repo });
    summarize([runGit(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim()]);
    const v = gate();
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
  });

  test('a project inside a monorepo compares paths from the repository root', () => {
    const appDir = path.join(repo, 'apps', 'demo');
    const app = makePhase(appDir, { '01-01-PLAN.md': plan(['libs/demo/a.ts']) }, 'example');
    commit({}, 'docs(demo-01-01): plan');
    const task = commit({ 'libs/demo/a.ts': '1\n', 'libs/demo/stray.ts': '1\n' }, 'feat(demo-01-01): code');
    fs.writeFileSync(path.join(app.phaseDir, '01-01-SUMMARY.md'), summary([task]));
    commit({}, 'docs(demo-01-01): summary');
    const v = evaluateMnBlastRadius({ projectDir: appDir, args: [app.phaseNumber] }).payload;
    assert.deepEqual(undeclaredPaths(v), ['libs/demo/stray.ts']);
    assert.equal(v.matched, 1);
  });

  // ── no task commits yet: the degraded phase window, then the working tree ─

  test('a committed phase with no SUMMARY yet is judged on the phase window, flagged degraded', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({}, 'docs(01-01): plan');
    commit({ 'src/a.ts': '1\n', 'src/b.ts': '1\n' }, 'feat(01-01): a and b');
    const v = gate();
    assert.equal(v.scopeStatus, 'degraded');
    assert.equal(v.scopeSource, 'phase-range');
    assert.equal(v.scopeReason, 'no-summary');
    assert.deepEqual(undeclaredPaths(v), ['src/b.ts']);
  });

  test('a committed phase ignores uncommitted edits in the tree', () => {
    // Measured: a dirty tree put the same 5-7 "undeclared" files into all nine phases of a project.
    commit({ 'src/someone-elses.ts': '1\n' }, 'chore: seed');
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({}, 'docs(01-01): plan');
    summarize([commit({ 'src/a.ts': '1\n' }, 'feat(01-01): a')]);
    fs.writeFileSync(path.join(repo, 'src', 'someone-elses.ts'), '2\n');
    const v = gate();
    assert.equal(v.workingTreeIncluded, false);
    assert.equal(v.block, false, 'another agent\'s uncommitted edit is not this phase\'s');
  });

  test('a phase that has committed nothing is judged on the working tree', () => {
    commit({ 'src/tracked.ts': '1\n' }, 'chore: seed');
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    fs.writeFileSync(path.join(repo, 'src', 'tracked.ts'), '2\n');
    const v = gate();
    assert.equal(v.scopeStatus, 'working-tree');
    assert.equal(v.workingTreeIncluded, true);
    assert.deepEqual(undeclaredPaths(v), ['src/tracked.ts']);
  });

  // ── --base: only what came after <ref>, plus the uncommitted tree ─────────

  test('--base judges the commits after <ref> and the dirty tree', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    commit({ 'src/early.ts': '1\n' }, 'feat(01-01): before the base');
    const base = runGit(['rev-parse', 'HEAD'], { cwd: repo }).stdout.trim();
    commit({ 'src/declared.ts': '1\n' }, 'feat(01-01): after the base');
    const v = gate(['--base', base]);
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
    assert.equal(v.workingTreeIncluded, true);

    fs.writeFileSync(path.join(repo, 'src', 'early.ts'), '2\n');
    assert.deepEqual(undeclaredPaths(gate(['--base', base])), ['src/early.ts']);
  });

  // ── volume reports, never blocks (unless asked) ───────────────────────────

  function twoDeclaredFiles() {
    writePlan('01-01-PLAN.md', ['src/a.ts', 'src/b.ts']);
    commit({}, 'docs(01-01): plan');
    summarize([commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01-01): two')]);
  }

  test('over a --max-files budget is reported but does not block', () => {
    twoDeclaredFiles();
    const v = gate(['--max-files', '1']);
    assert.equal(v.block, false, 'size alone is not a defect');
    assert.deepEqual(v.overBudget, { files: true, lines: false });
  });

  test('a budget exactly met is within budget; one over is over', () => {
    twoDeclaredFiles();
    assert.equal(gate(['--max-files', '3']).overBudget.files, false, 'limit+1 budget');
    assert.equal(gate(['--max-files', '2']).overBudget.files, false, 'limit');
    assert.equal(gate(['--max-files', '1']).overBudget.files, true, 'limit-1 budget');
    assert.equal(gate(['--max-lines', '2']).overBudget.lines, false);
    assert.equal(gate(['--max-lines', '1']).overBudget.lines, true);
  });

  test('--strict-budget turns an over-budget phase into a finding, even before the phase', () => {
    twoDeclaredFiles();
    const v = evaluateMnBlastRadius({ projectDir: repo, args: ['--strict-budget', phaseNumber, '--max-files', '1'] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
  });

  // ── through the CLI ───────────────────────────────────────────────────────

  test('gsd_run check mn-blast-radius "${PHASE_DIR}" prints the verdict', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01-01): plan');
    summarize([commit({ 'src/undeclared.ts': '1\n' }, 'feat(01-01): stray')]);
    const payload = runMnCheck(repo, 'mn-blast-radius', [path.relative(repo, phaseDir)]);
    assert.equal(payload.block, true);
    assert.deepEqual(payload.undeclared.map((u) => u.path), ['src/undeclared.ts']);
  });
});

describe('check mn-blast-radius (injected git)', () => {
  let projectDir;
  let phaseDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-blast-fake-');
    ({ phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': plan(['src/a.ts']) }));
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  const options = { maxFiles: 0, maxLines: 0, strictBudget: false };
  const ok = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null, timedOut: false });
  const fail = (exitCode, timedOut = false) => ({ exitCode, stdout: '', stderr: 'boom', signal: null, error: null, timedOut });

  test('a non-repository is unresolvable before anything else is read', () => {
    const v = computeBlastRadius(projectDir, phaseDir, options, () => fail(128)).payload;
    assert.equal(v.status, 'unresolvable');
  });

  test('a git that times out inside the resolver is unresolvable, never a pass', () => {
    const runner = (args) => (args[0] === 'rev-parse' && args[1] === '--show-toplevel' ? ok(projectDir) : fail(1, true));
    const v = computeBlastRadius(projectDir, phaseDir, options, runner).payload;
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.scopeStatus, 'unresolvable');
  });

  test('foldNumstat folds brace renames to the target and binary counts to zero', () => {
    const stats = new Map();
    foldNumstat('3\t1\tsrc/{old => a}.ts\n-\t-\tsrc/bin.png\n2\t0\tdocs/x.md => docs/y.md\nnot a numstat line\n', stats);
    assert.deepEqual([...stats], [
      ['src/a.ts', { added: 3, deleted: 1 }],
      ['src/bin.png', { added: 0, deleted: 0 }],
      ['docs/y.md', { added: 2, deleted: 0 }],
    ]);
  });
});

describe('check mn-blast-radius wiring', () => {
  test('the capability registers the gate at verify:pre through check mn-blast-radius', () => {
    const gate = CAPABILITY.gates.find((g) => g.when === 'workflow.blast_radius');
    assert.ok(gate);
    assert.equal(gate.point, 'verify:pre');
    assert.equal(gate.blocking, true);
    assert.deepEqual(gate.check, { query: 'mn-blast-radius' });
  });
});
