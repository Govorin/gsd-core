'use strict';

/**
 * TRANSITIONAL golden test: `blast-radius.mjs` / `contract-drift.mjs` ↔ `check mn-blast-radius` /
 * `check mn-contract-drift`, on the same fixtures (decision 6 of .plans/mn-verify-gate-to-cli.md).
 *
 * Requires "script exited non-zero" to equal "verdict blocks", and "script exited 2" to equal
 * `status: unresolvable`. Deleted with the scripts.
 *
 * Intentional divergences, excluded from the fixtures and pinned in the family tests instead:
 *   - blast-radius: a git command failing mid-run crashed the script (an uncaught exception, exit 1
 *     — a "finding" by accident); the verb returns `unresolvable`.
 *   - blast-radius: the plan set comes from plan-scan (a nested `plans/` layout is read; legacy
 *     `NN-PLAN-MM.md` names count as plans) and `files_modified` from the shared frontmatter parser
 *     (`files-modified` alias and a scalar value are read; the script saw nothing there).
 *   - contract-drift: the source root is the project directory; the script took `--root`, which the
 *     gate always set to the project root (`${PROJECT_ROOT:-.}`), so the gate's behaviour is the same.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, writeFiles } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnBlastRadius } = require('../gsd-core/bin/lib/gate-mn-blast-radius.cjs');
const { evaluateMnContractDrift } = require('../gsd-core/bin/lib/gate-mn-contract-drift.cjs');

const SCRIPTS = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts');
const RUN_TIMEOUT_MS = 60000;

function plan(files) {
  return `---\nwave: 1\nfiles_modified:\n${files.map((f) => `  - ${f}`).join('\n')}\n---\n\n# plan\n`;
}

function compare(script, scriptArgs, cwd, verdict) {
  const r = runNode([path.join(SCRIPTS, script), ...scriptArgs], { cwd, timeoutMs: RUN_TIMEOUT_MS });
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  const v = verdict.payload;
  assert.equal(v.block, r.exitCode !== 0, `${script}: exit ${r.exitCode} vs block ${v.block} (${v.message})\n${r.stdout}${r.stderr}`);
  assert.equal(v.status === 'unresolvable', r.exitCode === 2, `${script}: exit ${r.exitCode} vs status ${v.status}`);
}

describe('blast-radius.mjs ↔ check mn-blast-radius (transitional)', () => {
  let repo;

  beforeEach(() => {
    repo = createTempGitProject('gsd-mn-eq-blast-');
  });

  afterEach(() => {
    cleanup(repo);
  });

  function commit(files, message) {
    writeFiles(repo, files);
    runGit(['add', '-A'], { cwd: repo });
    runGit(['commit', '-m', message, '--no-verify'], { cwd: repo });
  }

  /** [label, setup(phaseDir) → extra args shared by both sides] */
  const CASES = [
    ['no plans', () => []],
    ['plans without files_modified', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '---\nwave: 1\n---\n');
      return [];
    }],
    ['declared change (range)', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts']));
      commit({ 'src/a.ts': '1\n' }, 'feat(01): a');
      return ['--base', 'HEAD~1'];
    }],
    ['undeclared change (range)', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts']));
      commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01): a and b');
      return ['--base', 'HEAD~1'];
    }],
    ['undelivered declaration (range)', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts', 'src/never.ts']));
      commit({ 'src/a.ts': '1\n' }, 'feat(01): a');
      return ['--base', 'HEAD~1'];
    }],
    ['unresolvable base', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts']));
      return ['--base', 'no-such-ref'];
    }],
    ['path-anchored, declared', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts']));
      commit({ 'src/a.ts': '1\n' }, 'feat(01): a with plan');
      return [];
    }],
    ['qualified scope sibling, undeclared', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts']));
      commit({}, 'docs(demo-01-01): plan');
      commit({ 'src/stray.ts': '1\n' }, 'feat(demo-01-01): stray');
      return [];
    }],
    ['numeric scope sibling ignored', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts']));
      commit({}, 'docs(01): plan');
      commit({ 'src/elsewhere.ts': '1\n' }, 'feat(01): elsewhere');
      return [];
    }],
    ['uncommitted phase, dirty tree', (dir) => {
      commit({ 'src/tracked.ts': '1\n' }, 'chore: seed');
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/declared.ts']));
      fs.writeFileSync(path.join(repo, 'src', 'tracked.ts'), '2\n');
      return [];
    }],
    ['over budget, not strict', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts', 'src/b.ts']));
      commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01): two');
      return ['--base', 'HEAD~1', '--max-files', '1'];
    }],
    ['over budget, strict', (dir) => {
      fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), plan(['src/a.ts', 'src/b.ts']));
      commit({ 'src/a.ts': '1\n', 'src/b.ts': '2\n' }, 'feat(01): two');
      return ['--base', 'HEAD~1', '--max-files', '1', '--strict-budget'];
    }],
  ];

  for (const [label, setup] of CASES) {
    test(label, () => {
      const { phaseDir, phaseNumber } = makePhase(repo, {}, 'example');
      const extra = setup(phaseDir);
      // Relative, as the gate passed `${PHASE_DIR}`: the script resolves it against its realpath cwd,
      // while an absolute macOS tmp path (/var → /private/var) would miss git's realpath root.
      compare('blast-radius.mjs', ['--dir', path.relative(repo, phaseDir), ...extra], repo, evaluateMnBlastRadius({ projectDir: repo, args: [phaseNumber, ...extra] }));
    });
  }

  test('outside a git repository both sides cannot look', () => {
    const notGit = createMnProject('gsd-mn-eq-blast-nogit-');
    const { phaseDir, phaseNumber } = makePhase(notGit, { '01-01-PLAN.md': plan(['src/a.ts']) });
    const r = runNode([path.join(SCRIPTS, 'blast-radius.mjs'), '--dir', phaseDir], { cwd: notGit, timeoutMs: RUN_TIMEOUT_MS });
    const v = evaluateMnBlastRadius({ projectDir: notGit, args: [phaseNumber] }).payload;
    cleanup(notGit);
    assert.equal(r.exitCode, 2);
    assert.equal(v.status, 'unresolvable');
  });
});

describe('contract-drift.mjs ↔ check mn-contract-drift (transitional)', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-eq-contract-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  const CONTRACT = '---\nphase: 01\n---\n\n## Contracts\n\n```typescript\nexport interface IRepo {\n  findById(id: Id): Promise<Either<E, Book | null>>;\n}\n```\n\n## Notes\n';
  const MATCHING = 'export interface IRepo {\n  findById(bookId: Id): Promise<Either<E, Book | null>>;\n}\n';
  const DRIFTED = 'export interface IRepo {\n  findById(id: Id): Promise<Book | null>;\n}\n';

  /** [label, phase files, project source files] */
  const CASES = [
    ['no design', {}, { 'src/a.ts': MATCHING }],
    ['no contracts section', { 'DESIGN.md': '# DESIGN\n\nprose\n' }, { 'src/a.ts': MATCHING }],
    ['match', { 'DESIGN.md': CONTRACT }, { 'src/a.ts': MATCHING }],
    ['match across whitespace', { 'DESIGN.md': CONTRACT }, { 'src/a.ts': 'findById( id : Id ) : Promise< Either< E , Book | null > >;\n' }],
    ['drift', { 'DESIGN.md': CONTRACT }, { 'src/a.ts': DRIFTED }],
    ['missing', { 'DESIGN.md': CONTRACT }, { 'src/a.ts': 'export const x = 1;\n' }],
    ['phase-numbered design file', { '01-DESIGN.md': CONTRACT }, { 'src/a.ts': DRIFTED }],
    ['superseded', { 'DESIGN.md': CONTRACT.replace('phase: 01', 'phase: 01\ncontracts_superseded: true') }, { 'src/a.ts': DRIFTED }],
    ['contracts outside the section ignored', { 'DESIGN.md': '## Notes\n\n```ts\nghost(a: A): B;\n```\n' }, { 'src/a.ts': MATCHING }],
    ['no typescript at all', { 'DESIGN.md': CONTRACT }, {}],
    ['only skipped directories', { 'DESIGN.md': CONTRACT }, { 'node_modules/p/a.ts': MATCHING }],
  ];

  for (const [label, phaseFiles, sources] of CASES) {
    test(label, () => {
      writeFiles(projectDir, sources);
      const { phaseDir, phaseNumber } = makePhase(projectDir, phaseFiles);
      compare(
        'contract-drift.mjs',
        ['--dir', phaseDir, '--root', projectDir],
        projectDir,
        evaluateMnContractDrift({ projectDir, args: [phaseNumber] }),
      );
    });
  }
});
