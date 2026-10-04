'use strict';

/**
 * `gsd_run check mn-uat-open` — the ship gate that reads the manual checks nobody ran
 * (src/gate-mn-uat-open.cts; replaces capabilities/mn-verify-gate/scripts/uat-open.mjs).
 *
 * The defect: the verifier already writes checks it could not confirm by reading code into
 * {phase}-UAT.md (agents/gsd-verifier.md, the single sink), and `audit-uat` already finds them.
 * Nothing read that, so a phase whose own report says "nobody checked this" shipped anyway. In
 * the ucars retrospective the author worked around it by inventing a per-phase NN-HUMAN-UAT.md,
 * because otherwise the items "got silently dropped".
 *
 * The gate deliberately does NOT introduce that second artifact: a second sink for something that
 * already has one is how two records start disagreeing. It reads the existing one — the
 * `audit-uat` report, collected in-process (the script spawned `gsd-tools audit-uat` found on
 * fixed paths under $HOME, so what it read depended on the machine's install).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnUatOpen } = require('../gsd-core/bin/lib/gate-mn-uat-open.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

describe('check mn-uat-open', () => {
  let root;
  let phase3;
  let phase4;

  const writeUat = (dir, phaseNum, body, status = 'testing') =>
    fs.writeFileSync(
      path.join(dir, `${phaseNum}-UAT.md`),
      `---\nstatus: ${status}\nphase: ${phaseNum}\n---\n\n## Tests\n\n${body}`,
    );

  const gate = (phaseArg, extra = []) => evaluateMnUatOpen({ projectDir: root, args: [phaseArg, ...extra] });

  beforeEach(() => {
    root = createMnProject('gsd-mn-uat-open-');
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
    // Most phases produce no UAT file at all. Requiring one would block them for having nothing to
    // check — the opposite of blast-radius, where an empty declaration IS the defect.
    const v = gate(phase3);
    assert.equal(v.block, false);
    assert.equal(v.payload.status, 'pass');
    assert.equal(v.payload.filesChecked, 0);
  });

  test('an item nobody ran blocks the ship, and names the check', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: pending\n');
    const v = gate(phase3);
    assert.equal(v.block, true);
    assert.equal(v.payload.status, 'finding');
    assert.deepEqual(v.payload.open, [{ file: '03-UAT.md', test: 1, name: 'Login works' }], 'the block must name the check, or nobody knows what to run');
  });

  test('once every item has been run, the gate opens', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: pass\n');
    const v = gate(phase3);
    assert.equal(v.block, false);
    assert.deepEqual(v.payload.open, []);
  });

  test('a FAILED item is not this gate\'s business', () => {
    // A failed manual check is a known defect, and which of gaps_found / human_needed it produces
    // is the verifier's call. Blocking on a recorded failure too would make the two mechanisms
    // fight over the same verdict.
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: fail\n');
    const v = gate(phase3);
    assert.equal(v.block, false);
    assert.equal(v.payload.filesChecked, 1, 'the file was read, its failed item was not counted as open');
  });

  test('every pending item is listed, a passed sibling is not', () => {
    writeUat(
      phase3,
      '03',
      '### 1. Login works\nexpected: dashboard\nresult: pending\n\n### 2. Logout works\nexpected: login page\nresult: pass\n\n### 3. Reset works\nexpected: email\nresult: pending\n',
    );
    assert.deepEqual(gate(phase3).payload.open.map((o) => o.test), [1, 3]);
  });

  test('scopes to the phase being shipped, not the whole project', () => {
    // audit-uat reports project-wide; a ship:pre gate asks about ONE phase. Matching by directory
    // name rather than phase number is deliberate: in a monorepo the number repeats across
    // projects, the path does not.
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard\nresult: pass\n');
    writeUat(phase4, '04', '### 1. API responds\nexpected: 200\nresult: pending\n');
    assert.equal(gate(phase3).block, false, "another phase's debt must not block this one");
    assert.equal(gate(phase4).block, true, 'the phase that owns it still blocks');
  });

  test('--all widens the question to the whole project', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard\nresult: pass\n');
    writeUat(phase4, '04', '### 1. API responds\nexpected: 200\nresult: pending\n');
    const v = gate(phase3, ['--all']);
    assert.equal(v.block, true);
    assert.equal(v.payload.all, true);
    assert.equal(evaluateMnUatOpen({ projectDir: root, args: ['--all', '03'] }).block, true, '--all before the phase does not swallow it');
  });

  test('the phase is resolved from its number as well as its directory', () => {
    writeUat(phase4, '04', '### 1. API responds\nexpected: 200\nresult: pending\n');
    assert.equal(gate('04').block, true);
    assert.equal(evaluateMnUatOpen({ projectDir: root, args: ['--phase', '4'] }).block, true);
  });

  test('refuses rather than passes when it cannot check', () => {
    // "The gate could not answer" must never read as "the answer is yes" — the rule autonomous.md
    // applies to loop gates ("a gate that could not run is not a gate that passed").
    assert.ok(evaluateMnUatOpen({ projectDir: root, args: [] }).failure, 'no phase named: a usage failure');

    const missing = gate(path.join(root, '.planning', 'phases', 'does-not-exist'));
    assert.equal(missing.block, true, 'nonexistent phase directory');
    assert.equal(missing.payload.status, 'unresolvable');
  });

  test('an audit that cannot read the phase is unresolvable, not clean', () => {
    // audit-uat throws on a VERIFICATION.md status outside the closed enum (reportStatusOf). The
    // script exited 2 when its audit-uat subprocess failed; in-process the throw is the same
    // "could not check".
    fs.writeFileSync(path.join(phase3, '03-VERIFICATION.md'), '---\nphase: 03\nstatus: bogus\n---\n\n# report\n');
    const v = gate(phase3);
    assert.equal(v.block, true);
    assert.equal(v.payload.status, 'unresolvable');
  });

  test('the capability declares the gate at ship:pre through check mn-uat-open', () => {
    const declared = CAPABILITY.gates.find((g) => g.when === 'workflow.uat_enforce');
    assert.ok(declared, 'a gate keyed on workflow.uat_enforce must be declared');
    assert.equal(declared.point, 'ship:pre');
    assert.equal(declared.blocking, true);
    assert.deepEqual(declared.check, { query: 'mn-uat-open' });
  });

  test('gsd_run check mn-uat-open "${PHASE_DIR}" prints the verdict', () => {
    writeUat(phase3, '03', '### 1. Login works\nexpected: dashboard appears\nresult: pending\n');
    const payload = runMnCheck(root, 'mn-uat-open', [path.relative(root, phase3)]);
    assert.equal(payload.block, true);
    assert.equal(payload.status, 'finding');
    assert.equal(payload.open.length, 1);
  });
});
