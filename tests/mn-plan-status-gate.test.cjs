'use strict';

/**
 * plan-status.mjs — the enforcement half of the status vocabulary.
 *
 * Phase 1 introduced the vocabulary, the transition matrix and the validation,
 * and nothing called any of it. `capabilities/mn-verify-gate/scripts/plan-status.mjs`
 * is the first caller: it inspects every `*-PLAN.md` in a phase directory and
 * refuses to pass a wave left in a state nobody can interpret — while passing
 * every state that IS interpretable.
 *
 * ── Why this file RUNS the gate instead of importing it ───────────────────
 *
 * The gate is installed to ~/.gsd/mn-verify-gate/scripts/ and runs
 * as a separate node process; it cannot reach `src/`, so it carries its own copy
 * of the vocabulary under a comment naming the source (the same convention as
 * contract-drift.mjs:322). A comment is not enforcement. This suite pins
 * OBSERVED BEHAVIOUR, which is also the stronger claim: an exported array would
 * prove the gate *declares* the same words; running it proves the gate *acts*
 * on them.
 *
 * The script is driven through `runNode` from tests/helpers/process-seam.cjs —
 * the same seam tests/mn-orphan-plans.test.cjs uses against a sibling script.
 * Nothing here reads the script's source text; the exit code and the two output
 * streams are the typed surface (local/no-source-grep).
 *
 * This suite pins reader #3. tests/plan-status-vocabulary-drift.test.cjs pins
 * reader #2 (orphan-plans.mjs) and must keep passing unchanged.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const { PLAN_STATUSES, BLOCKED_REASON_MAX_LENGTH } = require('../gsd-core/bin/lib/plan-status.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'plan-status.mjs',
);

/**
 * The three verdicts, named. Asserting against bare integers would let "could
 * not check" and "checked and found something" be confused at a glance, which is
 * the exact distinction D-28 exists to keep.
 */
const CLEAN = 0;
const FINDING = 1;
const UNCHECKABLE = 2;

const RUN_TIMEOUT_MS = 30000;

const SUMMARY = '---\nphase: 01\n---\n\n# a summary\n';

describe('plan-status gate (reader #3)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-plan-status-gate-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Materialise a phase directory from a map of filename to content. */
  function phaseWith(files) {
    const dir = path.join(tmpDir, `phase-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  /**
   * Render plan frontmatter carrying ONLY the fields given. A fixture with no
   * status must genuinely have no `status:` line rather than an empty one —
   * an empty value is a different input, and the gate treats it differently.
   */
  function plan(fields = {}) {
    const lines = ['phase: 01', 'plan: 01'];
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      lines.push(`${key}: ${value}`);
    }
    return `---\n${lines.join('\n')}\n---\n\n# a plan\n`;
  }

  /**
   * Run the real gate. Branch on `outcome` against the OUTCOME constants, never
   * on `signal`: a timeout and a maxBuffer overflow are indistinguishable by
   * signal alone.
   */
  function runGate(args) {
    const result = runNode([SCRIPT, ...args], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(
      result.outcome,
      OUTCOME.EXITED,
      `the gate must run to completion, not ${result.outcome}: ${result.stderr}`,
    );
    return result;
  }

  const runOn = (dir, extra = []) => runGate(['--dir', dir, ...extra]);

  // ── criterion 1, and the sibling that proves the gate is not inert ────────

  /**
   * These two tests carry disproportionate weight and are deliberately adjacent.
   *
   * "A plan with no status passes" is satisfied just as well by a gate that
   * never runs at all, and the ~1031 unmigrated plans already on disk make that
   * failure invisible in practice: everything would keep passing. The
   * invalid-value sibling over the SAME fixture shape is what distinguishes
   * "absence is accepted" from "the gate is inert". Phase 01-02 established this
   * pairing for the validator; the gate needs its own.
   */

  test('a plan with no status field at all passes', () => {
    // Absence means "not started". Roughly 1031 plans sit on consuming trees
    // with no status; a gate that failed them would be switched off on the day
    // it shipped and protect nothing afterwards.
    const dir = phaseWith({ '01-01-PLAN.md': plan() });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `an unstated status must not block: ${r.stderr}`);
    assert.match(r.stdout, /1 без статуса/, 'it must still be counted, not merely ignored');
  });

  test('the SAME fixture with an out-of-vocabulary status fails, naming value and allowed set', () => {
    // The trap-sibling for the test above: if the gate were inert, this would
    // pass too, and the pair could not both hold.
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'frobnicated' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `an uninterpretable value must block: ${r.stdout}`);
    assert.match(r.stderr, /frobnicated/, 'the offending value must be named');
    for (const status of PLAN_STATUSES) {
      assert.match(r.stderr, new RegExp(status), `the allowed set must list ${status}`);
    }
  });

  // ── criterion 2: the well-formed blocked plan PASSES ──────────────────────

  test('blocked with a non-empty in-bounds reason passes', () => {
    // The second inverse-of-naive-reading behaviour. Failing a correctly
    // declared blocked plan would block the exact case the status was introduced
    // for. The precedent is uat-open.mjs, where a `failed` item passes because it
    // is a known DECLARED defect, against blast-radius, where an empty
    // declaration IS the defect. The difference is who was obliged to declare
    // something: here the author declared it, so the gate has nothing to add.
    const dir = phaseWith({
      '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: 'waiting on upstream release' }),
    });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `a declared blockage is a legitimate outcome: ${r.stderr}`);
    assert.match(r.stdout, /1 заблокировано/);
  });

  // ── criterion 3: the stranded in_progress, and its converse ───────────────

  test('in_progress with no matching SUMMARY fails, naming the plan file', () => {
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'in_progress' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `a stranded plan must block: ${r.stdout}`);
    assert.match(r.stderr, /FINDING\s+01-01-PLAN\.md/, 'the plan must be named, not just counted');
  });

  test('in_progress WITH a matching SUMMARY passes', () => {
    // The converse. Executing and finishing is the normal path; the status left
    // behind is a record of the run, not a defect.
    const dir = phaseWith({
      '01-01-PLAN.md': plan({ status: 'in_progress' }),
      '01-01-SUMMARY.md': SUMMARY,
    });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `a finished plan must pass: ${r.stderr}`);
  });

  // ── criterion 4: the companion fields ─────────────────────────────────────

  test('blocked with no blocked_reason fails, naming the missing field', () => {
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'blocked' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `a status without a reason blocks nothing: ${r.stdout}`);
    assert.match(r.stderr, /blocked_reason/, 'the missing field must be named');
  });

  test('blocked with a whitespace-only blocked_reason fails — non-empty means non-blank', () => {
    // Emptiness is measured AFTER trim: a reason of forty spaces is no reason,
    // not forty characters of one. The same cut validateBlockedReason makes.
    const dir = phaseWith({
      '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: '"     "' }),
    });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `whitespace is not a reason: ${r.stdout}`);
    assert.match(r.stderr, /blocked_reason/);
  });

  test('superseded with no superseded_by fails, naming the missing field', () => {
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'superseded' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `superseded by whom?: ${r.stdout}`);
    assert.match(r.stderr, /superseded_by/, 'the missing field must be named');
  });

  test('superseded with a successor passes', () => {
    const dir = phaseWith({
      '01-01-PLAN.md': plan({ status: 'superseded', superseded_by: '01-02-PLAN.md' }),
    });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `a declared supersession is a decision: ${r.stderr}`);
    assert.match(r.stdout, /1 вытеснено/);
  });

  // ── D-05: completion is read from the SUMMARY and only from there ─────────

  test('status: done with no SUMMARY passes — the gate adds no second completion signal', () => {
    // The gate neither infers completion from the status nor cross-checks the
    // two against each other in either direction. A second signal could disagree
    // with the first, and two readers disagreeing about one file is the defect
    // the whole vocabulary was introduced to prevent.
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'done' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `a done claim is not this gate's finding: ${r.stderr}`);
  });

  test('a plan with a SUMMARY and no status at all passes', () => {
    // The behaviour every unmigrated plan depends on: completion is read from
    // SUMMARY presence, with no status required anywhere.
    const dir = phaseWith({
      '01-01-PLAN.md': plan(),
      '01-01-SUMMARY.md': SUMMARY,
    });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `an unmigrated finished plan must pass: ${r.stderr}`);
  });

  // ── nothing to interpret ──────────────────────────────────────────────────

  test('an empty phase directory passes', () => {
    const dir = phaseWith({});

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `there is nothing to interpret: ${r.stderr}`);
  });

  test('a directory holding only SUMMARYs passes', () => {
    const dir = phaseWith({ '01-01-SUMMARY.md': SUMMARY, '01-02-SUMMARY.md': SUMMARY });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `there is nothing to interpret: ${r.stderr}`);
  });

  // ── the ceiling, derived from the constant and never from a literal ───────

  /**
   * Every boundary fixture is derived from BLOCKED_REASON_MAX_LENGTH. Writing
   * the number by hand would turn the next change to the ceiling into a silent
   * test failure that gets "fixed" by editing the number, which is the opposite
   * of what a boundary test is for. Moving the constant must move these tests.
   */

  test('a blocked_reason one character below the ceiling passes', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH - 1);
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: reason }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `limit-1 must pass: ${r.stderr}`);
  });

  test('a blocked_reason of exactly the ceiling passes — the limit is inclusive', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH);
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: reason }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `the ceiling itself must pass: ${r.stderr}`);
  });

  test('a blocked_reason one character above the ceiling fails, reporting length and limit', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);

    // Fixture self-guard: if the constant ever grows past the fixture, this test
    // must fail loudly rather than pass vacuously.
    assert.ok(
      reason.length > BLOCKED_REASON_MAX_LENGTH,
      'the over-limit fixture must genuinely exceed the ceiling',
    );

    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: reason }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `limit+1 must be a finding: ${r.stdout}`);
    assert.match(r.stderr, new RegExp(String(reason.length)), 'the measured length must be reported');
    assert.match(
      r.stderr,
      new RegExp(String(BLOCKED_REASON_MAX_LENGTH)),
      'the ceiling must be reported',
    );
  });

  test('the oversized reason is rejected, never truncated — its content reaches neither stream', () => {
    // T-02-12. A gate that printed even a shortened prefix of an unreadable
    // reason would defeat the point: an unreadable report must never be able to
    // pass for nothing to report. The needle is a distinctive run, long enough
    // that it cannot occur by accident and short enough to survive truncation.
    const needle = 'QZX'.repeat(8);
    const reason = needle + 'y'.repeat(BLOCKED_REASON_MAX_LENGTH + 1 - needle.length);

    assert.ok(reason.length > BLOCKED_REASON_MAX_LENGTH, 'the fixture must exceed the ceiling');

    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'blocked', blocked_reason: reason }) });

    const r = runOn(dir, ['--verbose']);

    assert.equal(r.exitCode, FINDING);
    assert.ok(!r.stdout.includes(needle), 'the reason must not be echoed to stdout, even shortened');
    assert.ok(!r.stderr.includes(needle), 'the reason must not be echoed to stderr, even shortened');
  });

  // ── D-28: "could not check" is not "checked and found something" ──────────

  /**
   * A gate that cannot check must say so, not halt. The precedent is
   * loop-resolver.cts:545-559, where a synthetic blocking gate injected for
   * skipped capabilities stopped every `ship:pre` and had to be removed
   * outright rather than made non-blocking.
   */

  test('exit 2 is a distinct verdict from exit 1', () => {
    // D-28 stated as an assertion rather than as prose.
    assert.notEqual(UNCHECKABLE, FINDING, '"could not check" must not collapse into "found something"');
  });

  test('no --dir argument exits uncheckable', () => {
    const r = runGate([]);

    assert.equal(r.exitCode, UNCHECKABLE, `a gate with no target has not checked anything: ${r.stdout}`);
    assert.match(r.stderr, /UNKNOWN/, 'it must say it could not check');
  });

  test('--dir naming a directory that does not exist exits uncheckable', () => {
    const missing = path.join(tmpDir, 'no-such-phase-directory');

    const r = runOn(missing);

    assert.equal(r.exitCode, UNCHECKABLE, `an absent directory is unreadable, not clean: ${r.stdout}`);
    assert.match(r.stderr, /UNKNOWN/);
  });

  test('--dir naming a file rather than a directory exits uncheckable', () => {
    // The shape a caller passing a PLAN.md path instead of its directory would
    // produce. It must be uncheckable rather than silently clean.
    const filePath = path.join(tmpDir, '01-01-PLAN.md');
    fs.writeFileSync(filePath, plan({ status: 'in_progress' }));

    const r = runOn(filePath);

    assert.equal(r.exitCode, UNCHECKABLE, `a file is not a phase directory: ${r.stdout}`);
    assert.match(r.stderr, /UNKNOWN/);
  });

  // ── the drift pin ─────────────────────────────────────────────────────────

  /**
   * The gate's OBSERVED verdict for every value in the src/ vocabulary, stated
   * BY HAND. This table IS the pin, and it catches drift in both directions:
   *
   *   - a value added to PLAN_STATUSES in src/ with no entry here fails the
   *     set-equality assertion below, for a missing expectation;
   *   - a value whose behaviour in the gate changes fails its own generated test.
   *
   * Restating the expectations by hand rather than deriving them from the gate is
   * deliberate — the same discipline plan-status.unit.test.cjs applies to the
   * transition matrix. A table derived from the thing it checks cannot disagree
   * with it, and a pin that cannot disagree is not a pin.
   *
   * Each fixture is a single plan carrying the value in its minimal well-formed
   * shape and no SUMMARY, so the status is the only thing that varies.
   */
  const GATE_VERDICTS = {
    // the executor started and did not reach the end — the gate's core finding
    in_progress: {
      fields: {},
      exitCode: FINDING,
      verdict: /FINDING\s+01-01-PLAN\.md/,
      stream: 'stderr',
    },
    // D-05: completion is read from the SUMMARY; the claim alone is not a finding
    done: { fields: {}, exitCode: CLEAN, verdict: /1 завершено/, stream: 'stdout' },
    // the declared blockage — legitimate, and the case the status exists for
    blocked: {
      fields: { blocked_reason: 'waiting on upstream release' },
      exitCode: CLEAN,
      verdict: /1 заблокировано/,
      stream: 'stdout',
    },
    // #2349: skipped past every other rule once a successor is named
    superseded: {
      fields: { superseded_by: '01-02-PLAN.md' },
      exitCode: CLEAN,
      verdict: /1 вытеснено/,
      stream: 'stdout',
    },
  };

  test('every value in PLAN_STATUSES has a declared gate expectation', () => {
    // Drift direction one: src/ grows a value and this table does not. Asserted
    // as a set comparison so the failure names the value that lost its pin.
    assert.deepEqual(
      [...PLAN_STATUSES].sort(),
      Object.keys(GATE_VERDICTS).sort(),
      'a status added to src/plan-status.cts must declare its observed gate behaviour here — ' +
        'the gate script cannot import from src/, so this table is what holds its copy equal',
    );
  });

  for (const status of PLAN_STATUSES) {
    test(`the gate's verdict for status: ${status} is unchanged`, () => {
      // Drift direction two: the gate's behaviour for a pinned value moves.
      const expected = GATE_VERDICTS[status];
      assert.ok(expected, `no declared expectation for ${status}`);

      const dir = phaseWith({ '01-01-PLAN.md': plan({ status, ...expected.fields }) });

      const r = runOn(dir);

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

  // ── the near-misses the set-equality cannot see ───────────────────────────

  /**
   * Set-equality proves the gate has an expectation for every word in the
   * vocabulary. It says nothing about words just outside it. Normalisation is
   * `.trim().toLowerCase()` and NOTHING else, exactly as src/plan-scan.cts:67
   * reads the same file — so a differently-cased status is the same status, and
   * a hyphenated one is a different word that nobody can interpret. Two readers
   * disagreeing about one file is the failure the vocabulary exists to prevent,
   * so both directions are pinned.
   */

  test('a hyphenated near-miss is a FINDING — it is not in the vocabulary', () => {
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'in-progress' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, FINDING, `in-progress is not in_progress: ${r.stdout}`);
    assert.match(r.stderr, /in-progress/, 'the offending value must be named');
  });

  test('a differently-cased status with surrounding whitespace is CLEAN — trim and lowercase, nothing more', () => {
    // `Status:  SUPERSEDED` with a doubled space is the same declaration as
    // `status: superseded`. A stricter rule here would make the gate reject a
    // file plan-scan accepts.
    const dir = phaseWith({
      '01-01-PLAN.md': plan({ status: '  SUPERSEDED  ', superseded_by: '01-02-PLAN.md' }),
    });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `normalisation must match plan-scan: ${r.stderr}`);
    assert.match(r.stdout, /1 вытеснено/);
  });

  test('a differently-cased done is CLEAN', () => {
    const dir = phaseWith({ '01-01-PLAN.md': plan({ status: 'Done' }) });

    const r = runOn(dir);

    assert.equal(r.exitCode, CLEAN, `Done is done: ${r.stderr}`);
  });
});
