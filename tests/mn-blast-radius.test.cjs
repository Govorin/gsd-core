'use strict';

/**
 * `gsd_run check mn-blast-radius` — compares what a phase CHANGED against what it DECLARED
 * (src/gate-mn-blast-radius.cts; replaces capabilities/mn-verify-gate/scripts/blast-radius.mjs).
 *
 * The rule: a file changed but declared in no PLAN.md means either the executor left the task's
 * boundary, or the plan was incomplete and nobody noticed. Both need a human, and neither is
 * visible to tests, lint or types — an undeclared edit compiles exactly like a declared one.
 *
 * Two layers: real-git fixtures for the history the gate reads (path anchor, scope siblings,
 * working tree, `--base` range mode), and an injected `RunGit` for the failure modes a real
 * repository cannot easily produce. Assertions are on the verdict (`block`, `status`) and its typed
 * fields (`undeclared`, `undelivered`, `overBudget`, …), never on message text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnBlastRadius, computeBlastRadius } = require('../gsd-core/bin/lib/gate-mn-blast-radius.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** A plan declaring the files it intends to touch. */
function plan(files, extra = '') {
  const list = files.map((f) => `  - ${f}`).join('\n');
  return `---\nwave: 1\nfiles_modified:\n${list}\n${extra}status: complete\n---\n\n# plan\n`;
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

  function writePlan(name, files, extra) {
    fs.writeFileSync(path.join(phaseDir, name), plan(files, extra));
  }

  /** Write files (repo-relative) and commit them with `message`. */
  function commit(files, message) {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(repo, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    runGit(['add', '-A'], { cwd: repo });
    runGit(['commit', '-m', message, '--no-verify'], { cwd: repo });
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
    const v = gate(['--base', 'no-such-ref']);
    assert.equal(v.status, 'unresolvable');
  });

  // ── the comparison itself (range mode, as the script's own tests ran it) ──

  test('accepts a phase whose changes were all declared', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({ 'src/declared.ts': 'export const a = 1;\n' }, 'feat(01): declared change');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false);
    assert.equal(v.matched, 1);
    assert.equal(v.commits, null, 'range mode is not a commit selection');
  });

  test('reports a file changed but declared in no plan, naming it', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({ 'src/declared.ts': 'export const a = 1;\n' }, 'feat(01): declared');
    commit({ 'src/undeclared.ts': 'export const b = 2;\n' }, 'feat(01): undeclared');
    const v = gate(['--base', 'HEAD~2']);
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(undeclaredPaths(v), ['src/undeclared.ts']);
    assert.deepEqual(v.undeclared[0], { path: 'src/undeclared.ts', added: 1, deleted: 0 });
  });

  test('does not report a declared file that went unchanged — it is undelivered, not a finding', () => {
    writePlan('01-01-PLAN.md', ['src/touched.ts', 'src/never-written.ts']);
    commit({ 'src/touched.ts': 'export const a = 1;\n' }, 'feat(01): partial');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false);
    assert.deepEqual(v.undelivered, ['src/never-written.ts']);
  });

  test('unions declarations across every plan in the phase', () => {
    writePlan('01-01-PLAN.md', ['src/one.ts']);
    writePlan('01-02-PLAN.md', ['src/two.ts']);
    commit({ 'src/one.ts': 'export const a = 1;\n' }, 'feat(01): one');
    commit({ 'src/two.ts': 'export const b = 2;\n' }, 'feat(01): two');
    const v = gate(['--base', 'HEAD~2']);
    assert.equal(v.block, false);
    assert.equal(v.declared, 2);
    assert.equal(v.plans, 2);
  });

  test('reads every files_modified shape: inline list, blank line in the block, ./ prefix, comment', () => {
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '---\nfiles_modified: [src/a.ts, "src/b.ts"]\n---\n');
    fs.writeFileSync(
      path.join(phaseDir, '01-02-PLAN.md'),
      '---\nfiles_modified:\n  - ./src/c.ts\n\n  - src/d.ts # the second file\n---\n',
    );
    commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n', 'src/c.ts': '3\n', 'src/d.ts': '4\n' }, 'feat(01): four');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
    assert.equal(v.matched, 4);
  });

  test('planning artifacts are excluded from the comparison', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({ 'src/a.ts': '1\n', '.planning/STATE.md': '# state\n' }, 'feat(01): a');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false);
    assert.equal(v.changedFiles, 1);
  });

  test('a rename counts its target path', () => {
    commit({ 'src/old-name.ts': 'export const a = 1;\n' }, 'chore: seed');
    writePlan('01-01-PLAN.md', ['src/new-name.ts']);
    runGit(['mv', 'src/old-name.ts', 'src/new-name.ts'], { cwd: repo });
    runGit(['commit', '-m', 'refactor(01): rename', '--no-verify'], { cwd: repo });
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false, JSON.stringify(v.undeclared));
  });

  // ── which commits are the phase ───────────────────────────────────────────

  test('path-anchored selection: commits that touched the phase directory are the radius', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({ 'src/a.ts': '1\n' }, 'feat(01): a with its plan');
    const v = gate();
    assert.equal(v.block, false);
    assert.equal(v.commits, 1);
    assert.equal(v.workingTreeIncluded, false, 'a committed phase does not own the dirty tree');
  });

  test('a code commit with the anchored commit\'s qualified scope joins the radius', () => {
    // The executor commits code and docs separately; the path anchor alone sees only the docs.
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(demo-01-01): plan');
    commit({ 'src/stray.ts': '1\n' }, 'feat(demo-01-01): code outside the declaration');
    const v = gate();
    assert.equal(v.block, true, 'the scope sibling must be read');
    assert.deepEqual(undeclaredPaths(v), ['src/stray.ts']);
  });

  test('a purely numeric scope is ambiguous and pulls in no siblings', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({}, 'docs(01): plan');
    commit({ 'src/elsewhere.ts': '1\n' }, 'feat(01): another project\'s phase 01');
    const v = gate();
    assert.equal(v.block, false, 'a bare 01 scope must not glue unrelated work onto the phase');
  });

  test('a committed phase ignores uncommitted edits in the tree', () => {
    // Measured: a dirty tree put the same 5-7 "undeclared" files into all nine phases of a project.
    commit({ 'src/someone-elses.ts': '1\n' }, 'chore: seed');
    writePlan('01-01-PLAN.md', ['src/a.ts']);
    commit({ 'src/a.ts': '1\n' }, 'feat(01): a');
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
    assert.equal(v.workingTreeIncluded, true);
    assert.deepEqual(undeclaredPaths(v), ['src/tracked.ts']);
  });

  // ── volume reports, never blocks (unless asked) ───────────────────────────

  test('over a --max-files budget is reported but does not block', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts', 'src/b.ts']);
    commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01): two');
    const v = gate(['--base', 'HEAD~1', '--max-files', '1']);
    assert.equal(v.block, false, 'size alone is not a defect');
    assert.deepEqual(v.overBudget, { files: true, lines: false });
  });

  test('a budget exactly met is within budget; one over is over', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts', 'src/b.ts']);
    commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01): two');
    assert.equal(gate(['--base', 'HEAD~1', '--max-files', '3']).overBudget.files, false, 'limit+1 budget');
    assert.equal(gate(['--base', 'HEAD~1', '--max-files', '2']).overBudget.files, false, 'limit');
    assert.equal(gate(['--base', 'HEAD~1', '--max-files', '1']).overBudget.files, true, 'limit-1 budget');
    assert.equal(gate(['--base', 'HEAD~1', '--max-lines', '2']).overBudget.lines, false);
    assert.equal(gate(['--base', 'HEAD~1', '--max-lines', '1']).overBudget.lines, true);
  });

  test('--strict-budget turns an over-budget phase into a finding, even before the phase', () => {
    writePlan('01-01-PLAN.md', ['src/a.ts', 'src/b.ts']);
    commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01): two');
    const v = evaluateMnBlastRadius({
      projectDir: repo,
      args: ['--strict-budget', phaseNumber, '--base', 'HEAD~1', '--max-files', '1'],
    }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
  });

  // ── through the CLI ───────────────────────────────────────────────────────

  test('gsd_run check mn-blast-radius "${PHASE_DIR}" prints the verdict', () => {
    writePlan('01-01-PLAN.md', ['src/declared.ts']);
    commit({ 'src/undeclared.ts': '1\n' }, 'feat(01): stray with plan');
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

  /** A fake git answering by the first argv words; anything unlisted fails. */
  function fakeGit(answers) {
    return (args) => {
      const key = args.slice(0, 2).join(' ');
      if (key === 'rev-parse --show-toplevel') return { ok: true, stdout: `${projectDir}\n`, stderr: '' };
      const answer = answers[key];
      return answer === undefined ? { ok: false, stdout: '', stderr: `unexpected git ${args.join(' ')}` } : answer;
    };
  }

  test('a git command that fails mid-selection is unresolvable, never a pass', () => {
    const v = computeBlastRadius(projectDir, phaseDir, options, fakeGit({
      'log --format=%H': { ok: true, stdout: 'abc\n', stderr: '' },
    })).payload;
    assert.equal(v.status, 'unresolvable');
  });

  test('merge numstat and brace renames are folded into target paths', () => {
    const v = computeBlastRadius(projectDir, phaseDir, options, fakeGit({
      'log --format=%H': { ok: true, stdout: 'abc\n', stderr: '' },
      'log -1': { ok: true, stdout: 'docs: plan\n', stderr: '' },
      'show --format=': { ok: true, stdout: '3\t1\tsrc/{old => a}.ts\n-\t-\tsrc/bin.png\n', stderr: '' },
    })).payload;
    assert.deepEqual(v.undeclared.map((u) => [u.path, u.added, u.deleted]), [['src/bin.png', 0, 0]]);
    assert.equal(v.matched, 1);
  });

  test('a failing anchor lookup degrades to the working tree, as before', () => {
    const v = computeBlastRadius(projectDir, phaseDir, options, fakeGit({
      'diff --numstat': { ok: true, stdout: '1\t0\tsrc/a.ts\n', stderr: '' },
    })).payload;
    assert.equal(v.workingTreeIncluded, true);
    assert.equal(v.block, false);
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
