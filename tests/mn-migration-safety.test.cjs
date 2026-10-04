'use strict';

/**
 * `gsd_run check mn-migration-safety` — the gate on irreversible schema operations
 * (src/gate-mn-migration-safety.cts; replaces capabilities/mn-verify-gate/scripts/migration-safety.mjs).
 *
 * Two things it looks for in migrations a phase adds: operations that lose data without a way back
 * (DROP COLUMN/TABLE, TRUNCATE), and a meta/_journal.json out of step with the .sql files on disk —
 * a file outside the journal was written by hand, and drizzle-kit will neither apply it nor account
 * for it in the hash.
 *
 * The contract is deliberately a WARNING one, not a prohibition. A DROP COLUMN is often exactly
 * right; what is dangerous is an UNDECLARED one. So a finding is silenced by declaring it, and the
 * tests below pin both halves — the detection and the declaration that clears it. A gate that could
 * not be satisfied by doing the right thing would just be switched off.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { writeWorkflowConfig, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnMigrationSafety, isMigrationPath } = require('../gsd-core/bin/lib/gate-mn-migration-safety.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

describe('check mn-migration-safety', () => {
  let repo;
  let phaseDir;

  beforeEach(() => {
    repo = createTempGitProject('gsd-mn-migration-safety-');
    phaseDir = path.join(repo, '.planning', 'phases', '01-schema');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '---\nwave: 1\nfiles_modified:\n  - drizzle/0001_init.sql\n---\n');
  });

  afterEach(() => {
    cleanup(repo);
  });

  function git(args) {
    const r = runGit(args, { cwd: repo });
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, 0, `git ${args.join(' ')}: ${r.stderr}`);
  }

  /** Add a migration and commit it, so it appears in the phase diff. */
  function commitMigration(name, sql, dir = 'drizzle') {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
    fs.writeFileSync(path.join(repo, dir, name), sql);
    git(['add', '-A']);
    git(['commit', '-q', '-m', `feat(01): add ${name}`, '--no-verify']);
  }

  function gate(extra = []) {
    return evaluateMnMigrationSafety({ projectDir: repo, args: ['01', ...extra] });
  }

  const kinds = (v) => v.payload.findings.map((f) => f.kind);

  test('passes a phase whose scope holds no migrations', () => {
    // Silence where there is nothing to check is what keeps a gate switched on.
    const v = gate(['--base', 'HEAD']);
    assert.equal(v.block, false);
    assert.deepEqual(v.payload.files, []);
  });

  test('passes an additive migration', () => {
    commitMigration('0001_add_column.sql', 'ALTER TABLE books ADD COLUMN subtitle text;\n');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false, 'adding a column loses nothing');
    assert.deepEqual(v.payload.files, ['drizzle/0001_add_column.sql']);
  });

  test('flags an undeclared DROP COLUMN, naming the file', () => {
    commitMigration('0001_drop_column.sql', 'ALTER TABLE books DROP COLUMN subtitle;\n');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, true);
    assert.equal(v.payload.status, 'finding');
    assert.deepEqual(v.payload.findings.map((f) => [f.kind, f.file]), [['drop-column', 'drizzle/0001_drop_column.sql']]);
  });

  test('flags an undeclared DROP TABLE', () => {
    commitMigration('0001_drop_table.sql', 'DROP TABLE legacy_books;\n');
    assert.deepEqual(kinds(gate(['--base', 'HEAD~1'])), ['drop-table']);
  });

  test('a declared irreversible operation clears the finding', () => {
    // Doing the right thing must satisfy the gate; otherwise the only way past it is to turn it off.
    commitMigration('0001_declared_drop.sql', '-- gsd:irreversible subtitle was never populated\nALTER TABLE books DROP COLUMN subtitle;\n');
    assert.equal(gate(['--base', 'HEAD~1']).block, false);
  });

  test('a DROP written in a rollback comment is not a DROP', () => {
    commitMigration('0001_add.sql', 'ALTER TABLE books ADD COLUMN subtitle text;\n-- Reverse: ALTER TABLE books DROP COLUMN subtitle;\n');
    assert.equal(gate(['--base', 'HEAD~1']).block, false);
  });

  test('NOT NULL without DEFAULT is a finding unless the table is created in the same file', () => {
    commitMigration('0001_notnull.sql', 'ALTER TABLE books ADD COLUMN isbn text NOT NULL;\n');
    assert.deepEqual(kinds(gate(['--base', 'HEAD~1'])), ['notnull-no-default']);

    commitMigration('0002_fresh.sql', 'CREATE TABLE shelves (id int);\nALTER TABLE shelves ADD COLUMN label text NOT NULL;\n');
    const v = gate(['--base', 'HEAD~1']);
    assert.equal(v.block, false, 'a table created here has no rows');
  });

  test('an untracked migration is in scope too', () => {
    fs.mkdirSync(path.join(repo, 'drizzle'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'drizzle', '0001_wip.sql'), 'TRUNCATE books;\n');
    const v = gate(['--base', 'HEAD']);
    assert.deepEqual(v.payload.findings.map((f) => [f.kind, f.file]), [['truncate', 'drizzle/0001_wip.sql']]);
  });

  test('a .sql outside a migrations directory is not a migration', () => {
    assert.equal(isMigrationPath('scripts/seed.sql'), false);
    assert.equal(isMigrationPath('drizzle/meta/0000_snapshot.sql'), false);
    assert.equal(isMigrationPath('libs/db/migrations/0001_x.sql'), true);
  });

  // ── the journal ───────────────────────────────────────────────────────────

  test('a .sql on disk missing from meta/_journal.json is a finding; -- gsd:manual declares it', () => {
    fs.mkdirSync(path.join(repo, 'drizzle', 'meta'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'drizzle', 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '0000_init' }] }));
    fs.writeFileSync(path.join(repo, 'drizzle', '0000_init.sql'), 'CREATE TABLE books (id int);\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'init']);
    commitMigration('0001_hand.sql', 'ALTER TABLE books ADD COLUMN subtitle text;\n');
    assert.deepEqual(kinds(gate(['--base', 'HEAD~1'])), ['journal-desync']);

    commitMigration('0001_hand.sql', '-- gsd:manual written for a hotfix\nALTER TABLE books ADD COLUMN subtitle text;\n');
    assert.equal(gate(['--base', 'HEAD~2']).block, false);
  });

  test('a journal naming a missing file is a finding', () => {
    fs.mkdirSync(path.join(repo, 'drizzle', 'meta'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'drizzle', 'meta', '_journal.json'), JSON.stringify({ entries: [{ tag: '0001_add' }, { tag: '0002_gone' }] }));
    commitMigration('0001_add.sql', 'ALTER TABLE books ADD COLUMN subtitle text;\n');
    assert.deepEqual(kinds(gate(['--base', 'HEAD~1'])), ['journal-missing-file']);
  });

  // ── strict mode, from config or by hand ───────────────────────────────────

  test('phase artifacts discussing a rollback silence a finding — unless strict', () => {
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), '---\nwave: 1\n---\n\nRollback: restore subtitle from the nightly backup.\n');
    commitMigration('0001_drop_column.sql', 'ALTER TABLE books DROP COLUMN subtitle;\n');
    const relaxed = gate(['--base', 'HEAD~1']);
    assert.equal(relaxed.block, false);
    assert.equal(relaxed.payload.planCovers, true);
    assert.equal(relaxed.payload.strict, false);

    const byFlag = gate(['--base', 'HEAD~1', '--strict']);
    assert.equal(byFlag.block, true);
    assert.equal(byFlag.payload.strict, true);
    assert.deepEqual(kinds(byFlag), ['drop-column']);

    writeWorkflowConfig(repo, { migration_safety_strict: true });
    const byConfig = gate(['--base', 'HEAD~1']);
    assert.equal(byConfig.block, true, 'workflow.migration_safety_strict turns strict mode on');
    assert.equal(byConfig.payload.strict, true);
  });

  test('strict blocks on a warning; relaxed passes it', () => {
    commitMigration('0001_cast.sql', 'ALTER TABLE books ALTER COLUMN pages TYPE int USING pages::int;\n');
    assert.equal(gate(['--base', 'HEAD~1']).block, false);
    const strict = gate(['--base', 'HEAD~1', '--strict']);
    assert.equal(strict.block, true);
    assert.equal(strict.payload.warn, 1);
  });

  test('--strict before the phase does not swallow the phase', () => {
    commitMigration('0001_cast.sql', 'ALTER TABLE books ALTER COLUMN pages TYPE int USING pages::int;\n');
    const v = evaluateMnMigrationSafety({ projectDir: repo, args: ['--strict', '01', '--base', 'HEAD~1'] });
    assert.equal(v.payload.strict, true);
    assert.equal(v.block, true);
  });

  // ── the base, and "could not check" ───────────────────────────────────────

  test('without --base the gate finds one itself (HEAD~1 on a lone branch)', () => {
    // The gate dispatch passes no flags: the automatic base is the path that actually runs.
    commitMigration('0001_drop.sql', 'DROP TABLE books;\n');
    const v = gate();
    assert.equal(v.payload.base, 'HEAD~1');
    assert.equal(v.block, true);
  });

  test('no comparison base at all is unresolvable — a single-commit repo has no HEAD~1', () => {
    const v = gate();
    assert.equal(v.block, true);
    assert.equal(v.payload.status, 'unresolvable');
  });

  test('a comparison base that does not exist is unresolvable, not safe', () => {
    // An empty file list from a bad base is "could not check", never "nothing changed".
    commitMigration('0001_drop.sql', 'DROP TABLE books;\n');
    const v = gate(['--base', 'refs/heads/does-not-exist']);
    assert.equal(v.payload.status, 'unresolvable');
  });

  test('a failing git is unresolvable', () => {
    const deps = { runGit: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: boom', signal: null, error: null, timedOut: false }) };
    const v = evaluateMnMigrationSafety({ projectDir: repo, args: ['01'] }, deps);
    assert.equal(v.payload.status, 'unresolvable');
  });

  test('a phase that does not exist is unresolvable', () => {
    assert.equal(evaluateMnMigrationSafety({ projectDir: repo, args: ['77'] }).payload.status, 'unresolvable');
  });

  test('--base without a ref is a usage failure', () => {
    assert.ok(evaluateMnMigrationSafety({ projectDir: repo, args: ['01', '--base'] }).failure);
  });

  // ── wiring ────────────────────────────────────────────────────────────────

  test('both capability entries run check mn-migration-safety at execute:wave:post', () => {
    for (const when of ['workflow.migration_safety', 'workflow.migration_safety_strict']) {
      const g = CAPABILITY.gates.find((x) => x.when === when);
      assert.ok(g, when);
      assert.equal(g.point, 'execute:wave:post');
      assert.deepEqual(g.check, { query: 'mn-migration-safety' });
    }
  });

  test('gsd_run check mn-migration-safety "${PHASE_NUMBER}" prints the verdict', () => {
    commitMigration('0001_drop.sql', 'DROP TABLE books;\n');
    const payload = runMnCheck(repo, 'mn-migration-safety', ['01']);
    assert.equal(payload.block, true);
    assert.equal(payload.status, 'finding');
  });
});
