'use strict';

/**
 * migration-safety.mjs — the gate on irreversible schema operations.
 *
 * Two things it looks for in migrations a phase adds: operations that lose data
 * without a way back (DROP COLUMN/TABLE, TRUNCATE), and a meta/_journal.json out
 * of step with the .sql files on disk — a file outside the journal was written
 * by hand, and drizzle-kit will neither apply it nor account for it in the hash.
 *
 * The contract is deliberately a WARNING one, not a prohibition. A DROP COLUMN is
 * often exactly right; what is dangerous is an UNDECLARED one. So a finding is
 * silenced by declaring it in the migration itself, and the tests below pin both
 * halves — the detection and the declaration that clears it. A gate that could
 * not be satisfied by doing the right thing would just be switched off.
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
  'migration-safety.mjs',
);

const SAFE = 0;
const NEEDS_ATTENTION = 1;
const CANNOT_LOOK = 2;

describe('migration-safety gate', () => {
  let repo;
  let phaseDir;

  beforeEach(() => {
    repo = createTempGitProject('gsd-migration-safety-');
    phaseDir = path.join(repo, '.planning', 'phases', '01-schema');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '01-PLAN.md'),
      '---\nwave: 1\nfiles_modified:\n  - drizzle/0001_init.sql\n---\n',
    );
  });

  afterEach(() => {
    cleanup(repo);
  });

  /** Add a migration and commit it, so it appears in the phase diff. */
  function commitMigration(name, sql) {
    const dir = path.join(repo, 'drizzle');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), sql);
    runGit(['add', '-A'], { cwd: repo });
    runGit(['commit', '-m', `feat(01): add ${name}`, '--no-verify'], { cwd: repo });
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, '--root', repo, ...extra], {
      cwd: repo,
      timeoutMs: 60000,
    });
  }

  test('passes a phase whose scope holds no migrations', () => {
    // Silence where there is nothing to check is what keeps a gate switched on.
    const r = run(['--base', 'HEAD']);
    assert.equal(r.exitCode, SAFE, `no migrations means nothing to check: ${r.stdout}${r.stderr}`);
  });

  test('passes an additive migration', () => {
    commitMigration(
      '0001_add_column.sql',
      'ALTER TABLE books ADD COLUMN subtitle text;\n',
    );

    const r = run(['--base', 'HEAD~1']);
    assert.equal(r.exitCode, SAFE, `adding a column loses nothing: ${r.stdout}${r.stderr}`);
  });

  test('flags an undeclared DROP COLUMN', () => {
    commitMigration(
      '0001_drop_column.sql',
      'ALTER TABLE books DROP COLUMN subtitle;\n',
    );

    const r = run(['--base', 'HEAD~1']);
    assert.equal(
      r.exitCode,
      NEEDS_ATTENTION,
      `an undeclared data-losing operation must be reported: ${r.stdout}`,
    );
    const output = `${r.stdout}${r.stderr}`;
    assert.match(output, /0001_drop_column\.sql/, `the file must be named: ${output}`);
  });

  test('flags an undeclared DROP TABLE', () => {
    commitMigration('0001_drop_table.sql', 'DROP TABLE legacy_books;\n');

    const r = run(['--base', 'HEAD~1']);
    assert.equal(r.exitCode, NEEDS_ATTENTION, `DROP TABLE must be reported: ${r.stdout}`);
  });

  test('a declared irreversible operation clears the finding', () => {
    // The half that matters as much as detection: doing the right thing must
    // satisfy the gate. Otherwise the only way past it is to turn it off.
    const declared = [
      '-- gsd:irreversible subtitle was never populated; confirmed empty in prod',
      'ALTER TABLE books DROP COLUMN subtitle;',
      '',
    ].join('\n');
    commitMigration('0001_declared_drop.sql', declared);

    const r = run(['--base', 'HEAD~1']);
    assert.equal(
      r.exitCode,
      SAFE,
      `a declared operation must pass — otherwise the gate is unsatisfiable: ${r.stdout}${r.stderr}`,
    );
  });

  test('exits 2 when the comparison base does not exist', () => {
    // Its header states this outright: an empty file list from a bad base is
    // "could not check", never "nothing changed". Conflating them would turn a
    // broken invocation into a clean bill of health.
    commitMigration('0001_drop.sql', 'DROP TABLE books;\n');

    const r = run(['--base', 'refs/heads/does-not-exist']);
    assert.equal(
      r.exitCode,
      CANNOT_LOOK,
      `a missing base is unverifiable, not safe: ${r.stdout}${r.stderr}`,
    );
  });

  test('exits 2 when the phase directory does not exist', () => {
    const r = runNode([SCRIPT, '--dir', path.join(repo, 'nope'), '--root', repo], {
      cwd: repo,
      timeoutMs: 60000,
    });
    assert.equal(r.exitCode, CANNOT_LOOK);
  });
});
