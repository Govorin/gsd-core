'use strict';

/**
 * orphan-plans.mjs — the gate for plans whose fate nothing records.
 *
 * A plan's state is inferred today from whether a SUMMARY.md sits beside it,
 * which distinguishes exactly two of four cases. SUMMARY present means executed;
 * SUMMARY absent means never started, OR started and abandoned, OR the executor
 * died mid-run, OR superseded and irrelevant. All four read as "never started".
 *
 * Measured across 8 planning roots: 445 plans of 1190 (37.4%) have no SUMMARY.
 * The cost is not bookkeeping — an autonomous pass meeting such a plan re-runs
 * it from scratch on top of work it already did.
 *
 * Two of the four states already exist upstream: `status: superseded` in the
 * plan (#2349, plan-scan.cts) and `status: halted` in the SUMMARY
 * (phase-locator.cts). The missing one is `in_progress` in the PLAN, because it
 * is the only state that cannot be reconstructed afterwards — a SUMMARY that
 * does not exist cannot say that work was underway.
 *
 * The tests below weight the non-blocking half as heavily as the detection.
 * A plan with no status at all is REPORTED, never blocked: 37.4% of live plans
 * are in that state, and a gate that fails a third of a repository is switched
 * off on the day it ships and protects nothing afterwards.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'orphan-plans.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

const CLEAN = 0;
const ORPHANED = 1;
const CANNOT_LOOK = 2;

describe('orphan-plans gate', () => {
  let phaseDir;

  beforeEach(() => {
    phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-orphan-plans-'));
  });

  afterEach(() => {
    cleanup(phaseDir);
  });

  function writePlan(name, frontmatter = {}) {
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
    fs.writeFileSync(
      path.join(phaseDir, name),
      `---\nphase: 01\n${lines.join('\n')}\n---\n\n# ${name}\n`,
    );
  }

  function writeSummary(name) {
    fs.writeFileSync(path.join(phaseDir, name), '---\nphase: 01\n---\n\n# summary\n');
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
  }

  // ── the state that cannot be reconstructed afterwards ─────────────────────

  test('blocks a plan that declares in_progress and produced no SUMMARY', () => {
    writePlan('01-01-PLAN.md', { status: 'in_progress' });

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, ORPHANED, `an abandoned plan must block: ${r.stdout}`);
    assert.match(r.stderr, /ORPHANED\s+01-01-PLAN\.md/);
    // The consequence has to be stated, or the reader cannot tell why it matters.
    assert.match(r.stderr, /re-run from scratch|never finished/);
  });

  test('accepts in_progress once the SUMMARY exists', () => {
    // Executing and finishing is the normal path; the status is left behind as a
    // record of the run, not as a defect.
    writePlan('01-01-PLAN.md', { status: 'in_progress' });
    writeSummary('01-01-SUMMARY.md');

    const r = run();
    assert.equal(r.exitCode, CLEAN, `a finished plan must pass: ${r.stderr}`);
  });

  // ── what must NOT block ───────────────────────────────────────────────────

  test('reports a plan with no status at all without blocking', () => {
    // 445 of 1190 live plans are exactly this. Blocking them would fail a third
    // of the repository on day one, and the gate would be disabled by day two.
    writePlan('01-01-PLAN.md');

    const r = run(['--verbose']);
    assert.equal(r.exitCode, CLEAN, `an unknown-state plan must not block: ${r.stderr}`);
    assert.match(r.stdout, /1 unknown-state/, 'it must still be counted');
    assert.match(r.stdout, /01-01-PLAN\.md/, 'and named under --verbose');
  });

  test('--strict blocks unknown-state plans for a repository that has cleaned up', () => {
    // The opt-in for a project that has finished backfilling: once no plan is
    // unknown, the flag keeps it that way.
    writePlan('01-01-PLAN.md');

    const r = run(['--strict']);
    assert.equal(r.exitCode, ORPHANED, `--strict must block unknown state: ${r.stdout}`);
    assert.match(r.stderr, /UNKNOWN\s+01-01-PLAN\.md/);
  });

  test('skips a superseded plan entirely', () => {
    // #2349 already drops these from the plan set; a superseded plan without a
    // SUMMARY is correct, not abandoned.
    writePlan('01-01-PLAN.md', { status: 'superseded' });

    const r = run();
    assert.equal(r.exitCode, CLEAN, `superseded must never be an orphan: ${r.stderr}`);
    assert.match(r.stdout, /1 superseded/);
  });

  test('a superseded plan is skipped even under --strict', () => {
    writePlan('01-01-PLAN.md', { status: 'superseded' });

    const r = run(['--strict']);
    assert.equal(r.exitCode, CLEAN, 'superseded is a decision, not missing information');
  });

  test('passes a phase holding no plans', () => {
    const r = run(['--verbose']);
    assert.equal(r.exitCode, CLEAN, 'silence where there is nothing to check');
    assert.match(r.stdout, /nothing to check/);
  });

  test('counts every plan in a mixed phase', () => {
    writePlan('01-01-PLAN.md', { status: 'in_progress' });
    writeSummary('01-01-SUMMARY.md');
    writePlan('01-02-PLAN.md', { status: 'superseded' });
    writePlan('01-03-PLAN.md');

    const r = run();
    assert.equal(r.exitCode, CLEAN);
    assert.match(r.stdout, /1 done/);
    assert.match(r.stdout, /1 superseded/);
    assert.match(r.stdout, /1 unknown-state/);
  });

  test('matches a SUMMARY to its own plan, not to a sibling', () => {
    // 01-01-SUMMARY.md must not vouch for 01-02-PLAN.md. Getting this wrong
    // would silently clear every orphan in any phase that finished one plan.
    writePlan('01-01-PLAN.md', { status: 'in_progress' });
    writeSummary('01-01-SUMMARY.md');
    writePlan('01-02-PLAN.md', { status: 'in_progress' });

    const r = run();
    assert.equal(r.exitCode, ORPHANED, `a sibling SUMMARY must not clear another plan: ${r.stdout}`);
    assert.match(r.stderr, /01-02-PLAN\.md/);
    assert.doesNotMatch(r.stderr, /ORPHANED\s+01-01-PLAN\.md/, '01-01 finished and must not be named');
  });

  test('reads status from the last line of frontmatter', () => {
    // Regression guard: a regex requiring a newline after each entry drops the
    // LAST frontmatter line, whose newline the closing --- consumes. That exact
    // bug shipped in wave-collision.mjs and was caught by its own tests.
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01\nplan: 01\nstatus: in_progress\n---\n\n# body\n',
    );

    const r = run();
    assert.equal(r.exitCode, ORPHANED, 'status on the final frontmatter line must still be read');
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('exits 2 when the phase directory does not exist', () => {
    const r = runNode([SCRIPT, '--dir', path.join(phaseDir, 'nope')], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK, '"could not look" must differ from "found nothing"');
  });

  test('exits 2 when --dir is omitted', () => {
    const r = runNode([SCRIPT], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK);
  });

  // ── the gate is dispatched, not merely present ────────────────────────────

  test('the capability registers the gate as opt-in at verify:pre', () => {
    // allow-test-rule: source-text-is-the-product
    // The manifest IS the deployed contract — the runtime reads this JSON to
    // decide what runs and when.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'capability.json'),
        'utf8',
      ),
    );

    const gate = (manifest.gates || []).find((g) => g.when === 'workflow.orphan_plans');
    assert.ok(gate, 'a gate keyed on workflow.orphan_plans must be declared');
    assert.equal(gate.point, 'verify:pre');
    assert.equal(gate.blocking, true, 'an orphan that does not block is a report, not a gate');
    assert.match(gate.check.predicate.command, /orphan-plans\.mjs/);

    const cfg = manifest.config['workflow.orphan_plans'];
    assert.ok(cfg, 'the gate must own a config key so it can be switched off');
    assert.equal(cfg.default, false, 'a new blocking gate ships off and is opted into');
  });
});
