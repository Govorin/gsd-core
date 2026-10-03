'use strict';

/**
 * Reader #2 regression pins, and the drift pin holding the gate's copy of the
 * vocabulary equal to src/.
 *
 * `capabilities/mn-verify-gate/scripts/orphan-plans.mjs` is the second live
 * reader of `status`. It hardcodes two literals — `superseded` and
 * `in_progress` — and it cannot import from `src/`: capability scripts are
 * installed to ~/.gsd/capabilities/.../scripts/ and run as separate node
 * processes. The established convention there is to duplicate the shape under a
 * comment naming the source (cf. contract-drift.mjs:322). A comment, though, is
 * not enforcement, and three independent lists that can drift is the
 * `gates.tests_passed` collision this fork already paid for once.
 *
 * ── Why this file RUNS the gate instead of importing it ───────────────────
 *
 * An earlier revision of the plan proposed hoisting the gate's literals into an
 * `export const KNOWN_PLAN_STATUSES` for a test to import. That is not
 * implementable, and it was caught in owner review: orphan-plans.mjs executes
 * entirely at module top level and reaches `process.exit(2)` when `--dir` is
 * absent. A dynamic import() of it from a test would terminate the test process
 * before any export became reachable. There is no import-time guard to hide
 * behind, and adding one would change a shipped gate's startup path for the sake
 * of a test.
 *
 * So the pin is OBSERVED BEHAVIOUR, which is both implementable and a stronger
 * claim: an exported array would prove the gate *declares* the same words;
 * running it proves the gate *acts* on them. The script is driven through
 * `runNode` from tests/helpers/process-seam.cjs — the same seam
 * tests/mn-orphan-plans.test.cjs already uses against this exact script.
 *
 * orphan-plans.mjs is NOT modified by this phase. Nothing here reads its source
 * text; the process's exit code and stdout/stderr are the typed surface
 * (local/no-source-grep).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { PLAN_STATUSES } = require('../gsd-core/bin/lib/plan-status.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'orphan-plans.mjs',
);

const CLEAN = 0;
const ORPHANED = 1;

const RUN_TIMEOUT_MS = 30000;

describe('orphan-plans (reader #2) after the status vocabulary landed', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-orphan-vocab-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function phaseWith(files) {
    const dir = path.join(tmpDir, `phase-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  function plan(status) {
    const statusLine = status === undefined ? '' : `status: ${status}\n`;
    return `---\nphase: 01\nplan: 01\n${statusLine}---\n\n# a plan\n`;
  }

  const SUMMARY = '---\nphase: 01\n---\n\n# a summary\n';

  /**
   * Run the real gate against a phase directory. Branch on `outcome` against the
   * OUTCOME constants, never on `signal`: a timeout and a maxBuffer overflow are
   * indistinguishable by signal alone.
   */
  function runGate(dir, extra = []) {
    const result = runNode([SCRIPT, '--dir', dir, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(
      result.outcome,
      OUTCOME.EXITED,
      `the gate must run to completion, not ${result.outcome}: ${result.stderr}`,
    );
    return result;
  }

  // ── the four branches the gate has today ─────────────────────────────────

  test('a superseded plan is skipped and does not fail the gate', () => {
    const dir = phaseWith({ '01-01-PLAN.md': plan('superseded') });

    const r = runGate(dir);

    assert.equal(r.exitCode, CLEAN, `superseded is a decision, not a defect: ${r.stderr}`);
    assert.match(r.stdout, /1 superseded/);
  });

  test('a plan with a matching SUMMARY reads as done', () => {
    const dir = phaseWith({
      '01-01-PLAN.md': plan('in_progress'),
      '01-01-SUMMARY.md': SUMMARY,
    });

    const r = runGate(dir);

    assert.equal(r.exitCode, CLEAN, `a finished plan must pass: ${r.stderr}`);
    assert.match(r.stdout, /1 done/);
  });

  test('an in_progress plan with no SUMMARY is orphaned and fails the gate', () => {
    // The gate's only failing branch, and the state that cannot be reconstructed
    // afterwards: a SUMMARY that does not exist cannot say work was underway.
    const dir = phaseWith({ '01-01-PLAN.md': plan('in_progress') });

    const r = runGate(dir);

    assert.equal(r.exitCode, ORPHANED, `an abandoned plan must block: ${r.stdout}`);
    assert.match(r.stderr, /ORPHANED\s+01-01-PLAN\.md/, 'the plan must be named, not just counted');
  });

  test('a plan carrying NO status still reads as unknown and does NOT fail the gate', () => {
    // D-00c, and the single most important non-regression in this file. Roughly
    // 445 of 1190 live plans carry no status. A gate that failed a third of a
    // repository would be switched off on the day it shipped and protect nothing
    // afterwards. Teaching src/ a vocabulary must not change that.
    const dir = phaseWith({ '01-01-PLAN.md': plan() });

    const r = runGate(dir, ['--verbose']);

    assert.equal(r.exitCode, CLEAN, `an unknown-state plan must not block: ${r.stderr}`);
    assert.match(r.stdout, /1 unknown-state/, 'it must still be counted');
    assert.match(r.stdout, /01-01-PLAN\.md/, 'and named under --verbose');
  });

  test('a plan carrying status: blocked — a value the gate has no branch for — still reads as unknown', () => {
    // The specific new risk this phase creates. `blocked` is newly recognised in
    // src/, and the tempting follow-up is to make the gate "handle" it. It must
    // keep falling through to unknown in this phase: making a currently-unknown
    // plan start failing would change gate behaviour for existing trees, which
    // belongs to Phase 2's enforcement half (D-00c, threat T-01-10 accepted).
    const dir = phaseWith({ '01-01-PLAN.md': plan('blocked') });

    const r = runGate(dir);

    assert.equal(r.exitCode, CLEAN, `an unhandled vocabulary value must not start failing: ${r.stderr}`);
    assert.match(r.stdout, /1 unknown-state/);
  });

  // ── D-05: completion comes from the SUMMARY, not from the status claim ────

  test('status: done WITHOUT a SUMMARY is not counted as done', () => {
    // A plan claiming completion with nothing in git history must not be able to
    // talk itself into being complete. This phase adds `done` to the recognised
    // vocabulary as a parallel, optional signal — it does not replace the
    // existing inference.
    const dir = phaseWith({ '01-01-PLAN.md': plan('done') });

    const r = runGate(dir);

    assert.equal(r.exitCode, CLEAN);
    assert.match(r.stdout, /0 done/, 'the status claim alone does not make a plan done');
    assert.match(r.stdout, /1 unknown-state/, 'it falls through to unknown, exactly as before');
  });

  test('a SUMMARY with NO status at all IS counted as done', () => {
    // The converse, and the behaviour every one of the ~1031 unmigrated plans
    // depends on: completion is read from SUMMARY presence, with no status
    // required anywhere.
    const dir = phaseWith({
      '01-01-PLAN.md': plan(),
      '01-01-SUMMARY.md': SUMMARY,
    });

    const r = runGate(dir);

    assert.equal(r.exitCode, CLEAN);
    assert.match(r.stdout, /1 done/);
    assert.match(r.stdout, /0 unknown-state/);
  });

  // ── the drift pin ─────────────────────────────────────────────────────────

  /**
   * The gate's OBSERVED verdict for every value in the src/ vocabulary, stated
   * by hand. This table IS the pin, and it catches drift in both directions:
   *
   *   - a value added to PLAN_STATUSES in src/ with no entry here fails the
   *     completeness assertion below, for a missing expectation;
   *   - a value whose behaviour in the gate changes fails its own assertion.
   *
   * Restating the expectations by hand rather than deriving them is deliberate,
   * the same discipline plan-status.unit.test.cjs applies to the transition
   * matrix: a table derived from the thing it checks cannot disagree with it.
   */
  const GATE_VERDICTS = {
    // the gate's only failing branch
    in_progress: { exitCode: ORPHANED, verdict: /ORPHANED\s+01-01-PLAN\.md/, stream: 'stderr' },
    // #2349: skipped always
    superseded: { exitCode: CLEAN, verdict: /1 superseded/, stream: 'stdout' },
    // D-05: no SUMMARY, so not done — falls through
    done: { exitCode: CLEAN, verdict: /1 unknown-state/, stream: 'stdout' },
    // D-00c: a value the gate has no branch for keeps falling through
    blocked: { exitCode: CLEAN, verdict: /1 unknown-state/, stream: 'stdout' },
  };

  test('every value in PLAN_STATUSES has a declared gate expectation', () => {
    // Direction one: src/ grows a value, this table does not. Asserted as a set
    // comparison so the failure message names the value that lost its pin.
    assert.deepEqual(
      [...PLAN_STATUSES].sort(),
      Object.keys(GATE_VERDICTS).sort(),
      'a status added to src/plan-status.cts must declare its observed gate behaviour here — ' +
        'the gate script cannot import from src/, so this table is what holds its copy equal',
    );
  });

  for (const status of PLAN_STATUSES) {
    test(`the gate's verdict for status: ${status} is unchanged`, () => {
      // Direction two: the gate's behaviour for a pinned value moves. Every
      // fixture is a single plan carrying the value and no SUMMARY, so the
      // status is the only thing that varies between runs.
      const expected = GATE_VERDICTS[status];
      assert.ok(expected, `no declared expectation for ${status}`);

      const dir = phaseWith({ '01-01-PLAN.md': plan(status) });

      const r = runGate(dir);

      assert.equal(
        r.exitCode,
        expected.exitCode,
        `status: ${status} must still exit ${expected.exitCode}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`,
      );
      assert.match(
        expected.stream === 'stderr' ? r.stderr : r.stdout,
        expected.verdict,
        `status: ${status} must still report ${expected.verdict} on ${expected.stream}`,
      );
    });
  }
});
