'use strict';

/**
 * mutation-spot-check.mjs — proves the phase's tests REACT to code changes,
 * rather than merely existing and passing.
 *
 * Seam: capabilities/mn-verify-gate/scripts/mutation-spot-check.mjs, driven
 * through the process seam over a real temp project with a real (tiny) test
 * command, because the script's whole job is to run one and read its exit code.
 *
 * The defect: a green run cannot distinguish "the code is correct" from "the
 * test asserts nothing". The assertion ratchet catches a check that was
 * deleted; it cannot catch one that never checked anything, since
 * `expect(true).toBe(true)` counts the same as a real assertion. This project
 * has the case on record — norn/13-01-SUMMARY.md: "my own test was a false
 * green, caught by mutation" — found by hand, and left as a technique someone
 * has to remember rather than a step that runs.
 *
 * Two properties are load-bearing and asserted below: a surviving mutant fails
 * the check, and the source file is ALWAYS restored — a script that leaves a
 * mutation in the working tree is worse than no script.
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
  'mutation-spot-check.mjs'
);

const ALL_KILLED = 0;
const SURVIVED = 1;
const CANNOT_CHECK = 2;

/*
 * Passed as `timeoutMs`: the seam ignores a `timeout` key, so these bounds used
 * to be dead and every call fell back to the seam's 60000ms default.
 */

/** Bounds a full spot-check: the test command runs once clean and once per mutant. */
const MUTATION_RUN_TIMEOUT_MS = 120000;

/** Bounds a run that refuses after at most one attempt at the test command. */
const REFUSAL_TIMEOUT_MS = 60000;

/** Bounds a run refused at argument parsing, before any command runs. */
const ARGS_TIMEOUT_MS = 30000;

describe('mutation spot-check', () => {
  let root;
  let phaseDir;

  /** A source file whose behaviour a test can either check or ignore. */
  const SOURCE = [
    'function isAdult(age) {',
    '  return age >= 18;',
    '}',
    'module.exports = { isAdult };',
    '',
  ].join('\n');

  /** A test that pins the boundary — a `>=` → `>` mutation must fail it. */
  const REAL_TEST = [
    "const assert = require('node:assert');",
    "const { isAdult } = require('./src.js');",
    'assert.equal(isAdult(18), true);',
    'assert.equal(isAdult(17), false);',
    '',
  ].join('\n');

  /** A test that runs the code and asserts nothing about the boundary. */
  const HOLLOW_TEST = [
    "const assert = require('node:assert');",
    "const { isAdult } = require('./src.js');",
    'isAdult(18);',
    'assert.equal(typeof isAdult, "function");',
    '',
  ].join('\n');

  const write = (testBody) => {
    fs.writeFileSync(path.join(root, 'src.js'), SOURCE);
    fs.writeFileSync(path.join(root, 'check.js'), testBody);
  };

  const runCheck = (extra = []) =>
    runNode(
      [SCRIPT, '--dir', phaseDir, '--command', `node "${path.join(root, 'check.js')}"`, ...extra],
      { timeoutMs: MUTATION_RUN_TIMEOUT_MS }
    );

  beforeEach(() => {
    root = createTempDir();
    phaseDir = path.join(root, '.planning', 'phases', '03-ports');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nphase: 03\nplan: 01\nstatus: in_progress\nfiles_modified:\n  - src.js\n---\n\n# Plan\n'
    );
  });
  afterEach(() => {
    cleanup(root);
  });

  test('a test that pins the behaviour kills the mutant', () => {
    write(REAL_TEST);
    const result = runCheck();
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, ALL_KILLED, result.stderr);
  });

  test('a test that asserts nothing about the behaviour lets it survive', () => {
    // This is the case the technique exists for: the suite is green, the
    // ratchet is satisfied, and nothing checks the boundary.
    write(HOLLOW_TEST);
    const result = runCheck();
    assert.equal(result.exitCode, SURVIVED);
    assert.ok(
      result.stderr.includes('survived'),
      'the failure must name what survived, not merely that something did'
    );
  });

  test('the source file is restored whatever the verdict', () => {
    for (const body of [REAL_TEST, HOLLOW_TEST]) {
      write(body);
      runCheck();
      assert.equal(
        fs.readFileSync(path.join(root, 'src.js'), 'utf8'),
        SOURCE,
        'a script that leaves a mutation in the working tree is worse than no script'
      );
    }
  });

  test('refuses on an already-red suite instead of reporting kills', () => {
    // On a red tree "the mutant was killed" cannot be told from "the tests
    // were already failing" — the check would report success for a suite that
    // proves nothing.
    write('process.exit(1);\n');
    const result = runCheck();
    assert.equal(result.exitCode, CANNOT_CHECK);
    assert.ok(result.stderr.includes('already red'));
  });

  test('refuses when the test command cannot run at all', () => {
    write(REAL_TEST);
    const result = runNode(
      [SCRIPT, '--dir', phaseDir, '--command', 'this-command-does-not-exist-xyz'],
      { timeoutMs: REFUSAL_TIMEOUT_MS }
    );
    assert.equal(result.exitCode, CANNOT_CHECK);
  });

  test('passes when the phase declares nothing mutable', () => {
    // Declaring only a glob, a directory or a test file leaves nothing to
    // mutate — and "nothing to check" must not read as a failure.
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nphase: 03\nplan: 01\nstatus: in_progress\nfiles_modified:\n' +
        '  - libs/**\n  - src.spec.js\n  - tests/helper.js\n---\n\n# Plan\n'
    );
    write(REAL_TEST);
    assert.equal(runCheck().exitCode, ALL_KILLED);
  });

  test('never mutates the tests themselves', () => {
    // Mutating a test checks a test with a test. The declared spec file below
    // is skipped by construction; if it were not, this suite would mutate its
    // own oracle.
    const spec = path.join(root, 'src.spec.js');
    const specBody = 'const x = true === true;\n';
    fs.writeFileSync(spec, specBody);
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nphase: 03\nplan: 01\nstatus: in_progress\nfiles_modified:\n  - src.spec.js\n---\n\n# Plan\n'
    );
    write(REAL_TEST);
    runCheck();
    assert.equal(fs.readFileSync(spec, 'utf8'), specBody);
  });

  test('reads the command from config when the gate cannot pass one', () => {
    // A gate predicate can interpolate only PHASE_NUMBER, PHASE_DIR and
    // PHASE_REQ_IDS (src/gate-predicate-evaluator.cts), so a `${WORKFLOW_…}`
    // in the gate's command line would reach the script as a literal string.
    // The script therefore reads the project's config itself — which also
    // keeps one source of truth rather than a copy in the gate declaration.
    write(REAL_TEST);
    fs.writeFileSync(
      path.join(root, '.planning', 'config.json'),
      JSON.stringify({
        workflow: { mutation_test_command: `node "${path.join(root, 'check.js')}"` },
      })
    );
    const result = runNode([SCRIPT, '--dir', phaseDir], { timeoutMs: MUTATION_RUN_TIMEOUT_MS });
    assert.equal(result.exitCode, ALL_KILLED, result.stderr);
  });

  test('refuses when no command is configured anywhere', () => {
    // Guessing a runner would produce an unrunnable check, which reads as a
    // code failure — the confusion that gets a gate switched off.
    write(REAL_TEST);
    fs.writeFileSync(path.join(root, '.planning', 'config.json'), JSON.stringify({ workflow: {} }));
    const result = runNode([SCRIPT, '--dir', phaseDir], { timeoutMs: REFUSAL_TIMEOUT_MS });
    assert.equal(result.exitCode, CANNOT_CHECK);
    assert.ok(result.stderr.includes('no test command'));
  });

  test('refuses unusable arguments rather than passing', () => {
    const noArgs = runNode([SCRIPT], { timeoutMs: ARGS_TIMEOUT_MS });
    assert.equal(noArgs.exitCode, CANNOT_CHECK);
    const noPhase = runNode(
      [SCRIPT, '--dir', path.join(root, 'nope'), '--command', 'true'],
      { timeoutMs: ARGS_TIMEOUT_MS }
    );
    assert.equal(noPhase.exitCode, CANNOT_CHECK);
  });
});
