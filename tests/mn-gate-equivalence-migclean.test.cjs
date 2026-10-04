'use strict';

/**
 * TRANSITIONAL golden test: `migration-safety.mjs` / `clean-state.mjs` ↔ `check mn-migration-safety`
 * / `check mn-clean-state`, on the same fixtures (decision 6 of .plans/mn-verify-gate-to-cli.md).
 *
 * Requires "script exited non-zero" to equal "verdict blocks", and "script exited 2" to equal
 * `status: unresolvable`. Deleted with the scripts.
 *
 * Intentional divergences, excluded here and pinned in the family tests:
 *   - clean-state is project-scoped: a phase directory that does not exist made the script exit 2
 *     (it ran git inside `--dir`); the verb ignores the phase (mn-clean-state.test.cjs, "is
 *     project-scoped").
 *   - migration-safety reads `git diff`/`ls-files` with `-z`: a migration path with non-ASCII
 *     characters was quoted by the script's plain output and silently left out of scope.
 *   - migration-safety resolves paths against the repository top level and lists untracked files
 *     with `--full-name`: the script mixed toplevel-relative (diff) and cwd-relative (ls-files) paths.
 *     The fixtures run at the repository root, where both agree.
 *   - the script's `--all` and `--json` exploration modes are not ported: the gate never passed them.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runNode, runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { evaluateMnMigrationSafety } = require('../gsd-core/bin/lib/gate-mn-migration-safety.cjs');
const { evaluateMnCleanState } = require('../gsd-core/bin/lib/gate-mn-clean-state.cjs');

const SCRIPTS = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts');
const RUN_TIMEOUT_MS = 60000;

function git(args, cwd) {
  const r = runGit(args, { cwd, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(r.exitCode, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function assertSame(label, r, v) {
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(v.block, r.exitCode !== 0, `${label}: exit ${r.exitCode} vs block ${v.block} (${v.payload.message})`);
  assert.equal(v.payload.status === 'unresolvable', r.exitCode === 2, `${label}: exit ${r.exitCode} vs status ${v.payload.status}`);
}

describe('migration-safety.mjs ↔ check mn-migration-safety (transitional)', () => {
  let repo;
  let phaseDir;

  beforeEach(() => {
    repo = createTempGitProject('gsd-mn-eq-migration-');
    phaseDir = path.join(repo, '.planning', 'phases', '01-schema');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '---\nwave: 1\n---\n\n# plan\n');
  });

  afterEach(() => {
    cleanup(repo);
  });

  function commit(files, message = 'feat(01): migration') {
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), content);
    }
    git(['add', '-A'], repo);
    git(['commit', '-q', '-m', message, '--no-verify'], repo);
  }

  function compare(label, flags) {
    const r = runNode([path.join(SCRIPTS, 'migration-safety.mjs'), '--dir', phaseDir, '--root', repo, ...flags], { cwd: repo, timeoutMs: RUN_TIMEOUT_MS });
    const v = evaluateMnMigrationSafety({ projectDir: repo, args: ['01', ...flags] });
    assertSame(label, r, v);
  }

  const SQL = [
    ['additive', 'ALTER TABLE books ADD COLUMN subtitle text;\n'],
    ['drop column', 'ALTER TABLE books DROP COLUMN subtitle;\n'],
    ['drop table', 'DROP TABLE legacy;\n'],
    ['declared drop', '-- gsd:irreversible accepted\nALTER TABLE books DROP COLUMN subtitle;\n'],
    ['reverse declared', '-- gsd:reverse: ALTER TABLE books ADD COLUMN subtitle text\nALTER TABLE books DROP COLUMN subtitle;\n'],
    ['rollback comment only', 'ALTER TABLE books ADD COLUMN s text;\n-- Reverse: ALTER TABLE books DROP COLUMN s;\n'],
    ['truncate', 'TRUNCATE books;\n'],
    ['delete all', 'DELETE FROM books;\n'],
    ['delete where', "DELETE FROM books WHERE id = 1;\n"],
    ['notnull no default', 'ALTER TABLE books ADD COLUMN isbn text NOT NULL;\n'],
    ['notnull backfilled', 'ALTER TABLE books ADD COLUMN isbn text NOT NULL;\nUPDATE books SET isbn = id;\n'],
    ['notnull fresh table', 'CREATE TABLE shelves (id int);\nALTER TABLE shelves ADD COLUMN label text NOT NULL;\n'],
    ['set not null', 'ALTER TABLE books ALTER COLUMN title SET NOT NULL;\n'],
    ['cast using', 'ALTER TABLE books ALTER COLUMN pages TYPE int USING pages::int;\n'],
    ['widening', 'ALTER TABLE books ALTER COLUMN title TYPE text;\n'],
    ['sqlite rebuild', 'CREATE TABLE `__new_books` (id int);\nINSERT INTO `__new_books` SELECT id FROM `books`;\nDROP TABLE `books`;\nALTER TABLE `__new_books` RENAME TO `books`;\n'],
    ['bootstrap drop', 'DROP TABLE IF EXISTS cache;\nCREATE TABLE cache (k text);\n'],
    ['comments only', '-- nothing here\n'],
  ];

  for (const [label, sql] of SQL) {
    test(`${label} (--base HEAD~1)`, () => {
      commit({ 'drizzle/0001_x.sql': sql });
      compare(label, ['--base', 'HEAD~1']);
    });
    test(`${label} (--base HEAD~1 --strict)`, () => {
      commit({ 'drizzle/0001_x.sql': sql });
      compare(label, ['--base', 'HEAD~1', '--strict']);
    });
  }

  test('automatic base on a lone branch', () => {
    commit({ 'drizzle/0001_x.sql': 'DROP TABLE books;\n' });
    compare('auto base', []);
  });

  test('no base at all', () => compare('no base', []));

  test('missing base ref', () => {
    commit({ 'drizzle/0001_x.sql': 'DROP TABLE books;\n' });
    compare('missing base', ['--base', 'refs/heads/nope']);
  });

  test('plan discusses rollback, relaxed and strict', () => {
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '---\nwave: 1\n---\n\nRollback: restore from backup.\n');
    commit({ 'drizzle/0001_x.sql': 'ALTER TABLE books DROP COLUMN subtitle;\n' });
    compare('plan covers', ['--base', 'HEAD~1']);
    compare('plan covers strict', ['--base', 'HEAD~1', '--strict']);
  });

  test('journal desync, missing file, duplicate index, manual declaration', () => {
    commit({
      'drizzle/meta/_journal.json': JSON.stringify({ entries: [{ tag: '0000_init' }, { tag: '0003_gone' }] }),
      'drizzle/0000_init.sql': 'CREATE TABLE books (id int);\n',
    }, 'init');
    commit({ 'drizzle/0001_hand.sql': 'ALTER TABLE books ADD COLUMN s text;\n', 'drizzle/0001_twin.sql': '-- gsd:manual\nALTER TABLE books ADD COLUMN t text;\n' });
    compare('journal', ['--base', 'HEAD~1']);
    compare('journal strict', ['--base', 'HEAD~1', '--strict']);
  });

  test('untracked migration', () => {
    fs.mkdirSync(path.join(repo, 'drizzle'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'drizzle', '0001_wip.sql'), 'TRUNCATE books;\n');
    compare('untracked', ['--base', 'HEAD']);
  });
});

describe('clean-state.mjs ↔ check mn-clean-state (transitional)', () => {
  let project;
  let phaseDir;
  const extra = [];

  beforeEach(() => {
    project = createTempGitProject('gsd-mn-eq-clean-');
    phaseDir = path.join(project, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(project);
    while (extra.length) cleanup(extra.pop());
  });

  function compare(label, projectDir = project, dir = phaseDir) {
    const r = runNode([path.join(SCRIPTS, 'clean-state.mjs'), '--dir', dir], { timeoutMs: RUN_TIMEOUT_MS });
    const v = evaluateMnCleanState({ projectDir, args: [dir] });
    assertSame(label, r, v);
  }

  test('clean tree', () => compare('clean'));

  test('untracked file', () => {
    fs.writeFileSync(path.join(project, 'scratch.txt'), 'x');
    compare('untracked');
  });

  test('modified tracked file', () => {
    fs.writeFileSync(path.join(project, 'a.txt'), 'one');
    git(['add', '-A'], project);
    git(['commit', '-q', '-m', 'a'], project);
    fs.writeFileSync(path.join(project, 'a.txt'), 'two');
    compare('modified');
  });

  test('staged rename', () => {
    fs.writeFileSync(path.join(project, 'old.txt'), 'x');
    git(['add', '-A'], project);
    git(['commit', '-q', '-m', 'old'], project);
    git(['mv', 'old.txt', 'new.txt'], project);
    compare('rename');
  });

  test('only .planning churn', () => {
    fs.writeFileSync(path.join(project, '.planning', 'STATE.md'), 'edited');
    fs.writeFileSync(path.join(phaseDir, '.continue-here.md'), 'x');
    compare('planning');
  });

  test('unfinished cherry-pick', () => {
    fs.writeFileSync(path.join(project, '.git', 'CHERRY_PICK_HEAD'), `${git(['rev-parse', 'HEAD'], project)}\n`);
    compare('cherry-pick');
  });

  test('unfinished rebase and merge', () => {
    fs.mkdirSync(path.join(project, '.git', 'rebase-apply'));
    fs.writeFileSync(path.join(project, '.git', 'MERGE_HEAD'), `${git(['rev-parse', 'HEAD'], project)}\n`);
    compare('rebase+merge');
  });

  test('not a git repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-mn-eq-clean-nogit-'));
    extra.push(outside);
    compare('no git', outside, outside);
  });
});
