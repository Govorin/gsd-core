'use strict';

/**
 * uat-open.mjs — the ship gate that reads the manual checks nobody ran.
 *
 * Seam: capabilities/mn-verify-gate/scripts/uat-open.mjs, driven through the
 * process seam because the exit code IS the gate (0 pass / 1 block / 2 could
 * not check).
 *
 * The defect: the verifier already writes checks it could not confirm by
 * reading code into {phase}-UAT.md (agents/gsd-verifier.md, the single sink),
 * and `audit-uat` already finds them. Nothing read that, so a phase whose own
 * report says "nobody checked this" shipped anyway. In the ucars retrospective
 * the author worked around it by inventing a per-phase NN-HUMAN-UAT.md, because
 * otherwise the items "got silently dropped".
 *
 * The gate deliberately does NOT introduce that second artifact: a second sink
 * for something that already has one is how two records start disagreeing.
 * It reads the existing one.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'uat-open.mjs'
);

/** Exit codes, named so the assertions read as intent rather than arithmetic. */
const PASS = 0;
const BLOCK = 1;
const CANNOT_CHECK = 2;

function runGate(phaseDir, extra = []) {
  const result = runNode([SCRIPT, '--dir', phaseDir, ...extra], { timeout: 90000 });
  assert.equal(result.outcome, OUTCOME.EXITED, 'the gate must exit, not hang or die on a signal');
  return result;
}

describe('uat-open gate', () => {
  let root;
  let phase3;
  let phase4;

  const writeUat = (dir, phaseNum, body) =>
    fs.writeFileSync(
      path.join(dir, `${phaseNum}-UAT.md`),
      `---\nstatus: testing\nphase: ${phaseNum}\n---\n\n## Tests\n\n${body}`
    );

  beforeEach(() => {
    root = createTempDir();
    phase3 = path.join(root, '.planning', 'phases', '03-ports');
    phase4 = path.join(root, '.planning', 'phases', '04-api');
    fs.mkdirSync(phase3, { recursive: true });
    fs.mkdirSync(phase4, { recursive: true });
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), '{}');
  });
  afterEach(() => {
    cleanup(root);
  });

  test('a phase that deferred nothing passes', () => {
    // Most phases produce no UAT file at all. Requiring one would block them
    // for having nothing to check — the opposite of blast-radius, where an
    // empty declaration IS the defect because the planner was supposed to
    // declare something.
    assert.equal(runGate(phase3).exitCode, PASS);
  });

  test('an item nobody ran blocks the ship', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: pending\n');
    const result = runGate(phase3);
    assert.equal(result.exitCode, BLOCK);
    assert.ok(
      result.stderr.includes('Login works'),
      'the block must name the check, or nobody knows what to run'
    );
  });

  test('once every item has been run, the gate opens', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: pass\n');
    assert.equal(runGate(phase3).exitCode, PASS);
  });

  test('a FAILED item is not this gate\'s business', () => {
    // A failed manual check is a known defect, and which of gaps_found /
    // human_needed it produces is the verifier's call. This gate asks exactly
    // one question: did anything go unrun. Blocking on a recorded failure too
    // would make the two mechanisms fight over the same verdict.
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: fail\n');
    assert.equal(runGate(phase3).exitCode, PASS);
  });

  test('scopes to the phase being shipped, not the whole project', () => {
    // audit-uat reports project-wide; a ship:pre gate asks about ONE phase.
    // Matching by directory name rather than phase number is deliberate: in a
    // monorepo the number repeats across projects (the same collision that
    // makes commit-scope selection unusable in blast-radius), the path does not.
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard\nresult: pass\n');
    writeUat(phase4, '04', '### 1. API responds\nexpected: 200\nresult: pending\n');
    assert.equal(runGate(phase3).exitCode, PASS, "another phase's debt must not block this one");
    assert.equal(runGate(phase4).exitCode, BLOCK, 'the phase that owns it still blocks');
  });

  test('--all widens the question to the whole project', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard\nresult: pass\n');
    writeUat(phase4, '04', '### 1. API responds\nexpected: 200\nresult: pending\n');
    assert.equal(runGate(phase3, ['--all']).exitCode, BLOCK);
  });

  test('refuses rather than passes when it cannot check', () => {
    // Each of these is "the gate could not answer", which must never read as
    // "the answer is yes" — the rule autonomous.md already applies to loop
    // gates ("a gate that could not run is not a gate that passed").
    const noArgs = runNode([SCRIPT], { timeout: 30000 });
    assert.equal(noArgs.exitCode, CANNOT_CHECK, 'missing --dir');

    assert.equal(
      runGate(path.join(root, '.planning', 'phases', 'does-not-exist')).exitCode,
      CANNOT_CHECK,
      'nonexistent phase directory'
    );

    const orphan = createTempDir();
    try {
      assert.equal(runGate(orphan).exitCode, CANNOT_CHECK, 'no .planning/ above the directory');
    } finally {
      cleanup(orphan);
    }
  });
});
