'use strict';

/**
 * Tests for `src/health-diagnostic-rules/phase-structure.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — the "Phase directory structure" rule
 * group: W005, W023, I001, W009, W030 (#5118) and the fork's W031.
 *
 * Design:       .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"):
 * - W005/W023 are MECHANICAL MUTATION — a malformed directory name / two
 *   directories deliberately constructed to collide on the same normalized
 *   phase key. Both are directory-NAME shapes, not a document format being
 *   modeled, so there is nothing to mutate from a template; the mutation IS
 *   the directory name itself.
 * - I001/W009 are STRUCTURAL ABSENCE — a missing SUMMARY.md / missing
 *   VALIDATION.md file. Exempt from the provenance concern per §8.5's own
 *   category 1: the fixture *is* the absence, no format is being modeled.
 *
 * Every case calls the REAL `buildPlanningSnapshot(cwd)` (Phase 10,
 * `src/planning-snapshot.cts`) against real temp `.planning/` trees, then
 * calls the REAL rule `check` functions from the compiled module under
 * test — no hand-built in-memory snapshot mocks. Fixture helpers mirror
 * `tests/planning-snapshot.test.cjs`'s own `writeState`/`writeRoadmap`/
 * `writeFile`/`makeCompletePhaseDir` verbatim.
 *
 * All fixtures use a ROADMAP.md with NO `Phase N:` headings under the
 * current milestone section. `getMilestonePhaseFilter`
 * (`src/roadmap-parser.cts:1341-1355`) degrades to a pass-all filter
 * whenever `milestonePhaseNums.size === 0`, so `listMilestonePhaseDirs`
 * enumerates every on-disk phase directory regardless of whether its name
 * parses as a phase id — which is exactly what these rules need to exercise
 * (a malformed dir name would otherwise never reach `phaseDirs.value` in the
 * first place, since a non-matching name also fails the window's own
 * numeric-prefix membership test).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { RULES } = require('../../gsd-core/bin/lib/health-diagnostic-rules/phase-structure.cjs');

const ruleByCode = Object.fromEntries(RULES.map((r) => [r.code, r]));

// ─── Fixture helpers (mirrors tests/planning-snapshot.test.cjs) ────────────

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeState(cwd, fields) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${v}`);
  lines.push('---', '');
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), lines.join('\n'));
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeCompletePhaseDir(cwd, relPhaseDir) {
  writeFile(cwd, `${relPhaseDir}/01-01-PLAN.md`, '# Plan\n');
  writeFile(cwd, `${relPhaseDir}/01-01-SUMMARY.md`, '# Summary\n');
  writeFile(cwd, `${relPhaseDir}/01-VERIFICATION.md`, '---\nstatus: passed\n---\n');
}

// No `Phase N:` heading anywhere -> getMilestonePhaseFilter's pass-all
// degrade -> listMilestonePhaseDirs enumerates every on-disk phase dir name
// verbatim, malformed or not.
function writePassAllRoadmap(cwd) {
  writeRoadmap(cwd, ['## v1.0 Current 🚧', ''].join('\n'));
}

function baseFixture(cwd) {
  writeState(cwd, { milestone: 'v1.0' });
  writePassAllRoadmap(cwd);
}

// ─── W005 — phase directory doesn't follow NN-name format ──────────────────

describe('W005 — phase directory naming', () => {
  test('MECHANICAL MUTATION: a directory name with no NN- prefix fires W005', (t) => {
    const cwd = createTempDir('gsd-3309-w005-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/notaphase/README.md', '# not a phase dir\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.ok(snap.phaseDirs.value.includes('notaphase'), 'fixture sanity: malformed dir enumerated');

    const diagnostics = ruleByCode['W005'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['W005'],
    );
    assert.match(diagnostics[0].message, /"notaphase"/);
    assert.match(diagnostics[0].message, /doesn't follow NN-name format/);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].remedy.action, 'advise');
    assert.equal(diagnostics[0].remedy.risk, 'none');
  });

  test('baseline: only well-formed directory names produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w005-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W005'].check(snap), []);
  });
});

// ─── W023 — phase directories collide on normalized key ────────────────────

describe('W023 — colliding phase directories', () => {
  test('MECHANICAL MUTATION: two directories that normalize to the same key fire W023', (t) => {
    const cwd = createTempDir('gsd-3309-w023-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    // extractPhaseToken("05-real") === "05"; extractPhaseToken("05-real-stray")
    // === "05" too (the tokenizer stops at the first non-continuation segment,
    // "real"/"stray" is a slug word, not a zero-padded continuation) — both
    // normalize to phase key "05" via normalizePhaseName.
    makeCompletePhaseDir(cwd, '.planning/phases/05-real');
    writeFile(cwd, '.planning/phases/05-real-stray/01-01-PLAN.md', '# Plan\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.ok(
      snap.phaseDirs.value.includes('05-real') && snap.phaseDirs.value.includes('05-real-stray'),
      'fixture sanity: both colliding dirs enumerated',
    );

    const diagnostics = ruleByCode['W023'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['W023'],
    );
    assert.match(diagnostics[0].message, /collide on normalized key "05"/);
    assert.match(diagnostics[0].message, /05-real \(/);
    assert.match(diagnostics[0].message, /05-real-stray \(/);
    assert.equal(diagnostics[0].severity, 'warning');
  });

  test('baseline: distinct phase keys produce no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w023-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W023'].check(snap), []);
  });
});

// ─── I001 — plan(s) without a matching SUMMARY.md ──────────────────────────

describe('I001 — unsummarized plans', () => {
  test('STRUCTURAL ABSENCE: a PLAN.md with no matching SUMMARY.md fires I001', (t) => {
    const cwd = createTempDir('gsd-3309-i001-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');

    const snap = buildPlanningSnapshot(cwd);
    const phase = snap.phases.value.find((p) => p.dir === '01-foo');
    assert.equal(phase.planCount, 1);
    assert.equal(phase.summaryCount, 0);

    const diagnostics = ruleByCode['I001'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['I001'],
    );
    assert.match(diagnostics[0].message, /Phase 01-foo has 1 plan\(s\) without a matching summary/);
    assert.equal(diagnostics[0].severity, 'info');
  });

  test('baseline: matched plan/summary pairs produce no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-i001-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['I001'].check(snap), []);
  });
});

// ─── W009 — Validation Architecture in RESEARCH.md but no VALIDATION.md ───

describe('W009 — missing VALIDATION.md', () => {
  test('STRUCTURAL ABSENCE: RESEARCH.md has Validation Architecture but no VALIDATION.md fires W009', (t) => {
    const cwd = createTempDir('gsd-3309-w009-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(
      cwd,
      '.planning/phases/01-foo/01-RESEARCH.md',
      '# Research\n\n## Validation Architecture\n\nSome content.\n',
    );

    const snap = buildPlanningSnapshot(cwd);
    const entry = snap.researchValidationStatus.value.find((e) => e.dir === '01-foo');
    assert.equal(entry.hasValidationArchitecture, true);
    assert.equal(entry.hasValidationMd, false);

    const diagnostics = ruleByCode['W009'].check(snap);
    assert.deepEqual(
      diagnostics.map((d) => d.code),
      ['W009'],
    );
    assert.match(
      diagnostics[0].message,
      /Phase 01-foo: has Validation Architecture in RESEARCH\.md but no VALIDATION\.md/,
    );
    assert.equal(diagnostics[0].severity, 'warning');
  });

  test('baseline: VALIDATION.md present alongside Validation Architecture produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w009-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(
      cwd,
      '.planning/phases/01-foo/01-RESEARCH.md',
      '# Research\n\n## Validation Architecture\n\nSome content.\n',
    );
    writeFile(cwd, '.planning/phases/01-foo/01-VALIDATION.md', '# Validation\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W009'].check(snap), []);
  });

  test('baseline: RESEARCH.md without Validation Architecture heading produces no diagnostics', (t) => {
    const cwd = createTempDir('gsd-3309-w009-neg2-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/01-foo/01-RESEARCH.md', '# Research\n\nNo relevant heading here.\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleByCode['W009'].check(snap), []);
  });
});

// ─── §8.2 rule 1 — every diagnostic's severity matches its rule's declared severity ─

describe('rule/severity 1:1 (§8.2 rule 1)', () => {
  test('every emitted diagnostic carries the same severity as its rule entry', (t) => {
    const cwd = createTempDir('gsd-3309-sev-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/notaphase/README.md', '# not a phase dir\n');
    writeFile(cwd, '.planning/phases/05-real-stray/01-01-PLAN.md', '# Plan\n');
    writeFile(cwd, '.planning/phases/02-bar/01-01-PLAN.md', '# Plan\n');
    writeFile(
      cwd,
      '.planning/phases/02-bar/01-RESEARCH.md',
      '## Validation Architecture\n',
    );

    const snap = buildPlanningSnapshot(cwd);
    for (const rule of RULES) {
      for (const diagnostic of rule.check(snap)) {
        assert.equal(diagnostic.code, rule.code);
        assert.equal(diagnostic.severity, rule.severity);
      }
    }
  });
});

// ─── W030 — verification report status outside the closed set (#5118) ─────
//
// MECHANICAL MUTATION of the rule's own positive fixture: the passing report
// `makeCompletePhaseDir` writes, with its `status: passed` token replaced by
// an out-of-set value. The owner (`isPhaseComplete`) keeps its no-throw
// contract and the snapshot carries the typed error, so the rule reports the
// file instead of health failing on the defect it diagnoses. `passed-degraded`
// is a real legacy value (live-projects census, fork 3.4a): it could mean a
// gap or an accepted degradation, so W030 proposes and never rewrites.
// `verified` — the one unambiguous legacy value — is W031's, not W030's.

function writeReport(cwd, status) {
  baseFixture(cwd);
  makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
  writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', `---\nstatus: ${status}\n---\n`);
}

describe('W030 — verification report status outside the closed set', () => {
  test('MECHANICAL MUTATION: a report whose status is `passed-degraded` fires W030 naming the file, the accepted set and the proposed value', (t) => {
    const cwd = createTempDir('gsd-5118-w030-');
    t.after(() => cleanup(cwd));
    writeReport(cwd, 'passed-degraded');

    const snap = buildPlanningSnapshot(cwd);
    const diagnostics = ruleByCode['W030'].check(snap);
    assert.deepEqual(diagnostics.map((d) => d.code), ['W030']);
    assert.match(diagnostics[0].message, /01-VERIFICATION\.md/);
    assert.match(diagnostics[0].message, /"passed-degraded"/);
    assert.match(diagnostics[0].message, /passed \| gaps_found \| human_needed/);
    assert.equal(diagnostics[0].severity, 'warning');
    assert.equal(diagnostics[0].remedy.action, 'advise');
    // The proposal rides as data: the gate-closing value first, `passed` as
    // the owner's alternative, and the reason.
    const { args } = diagnostics[0].remedy;
    assert.equal(args.suggested, 'gaps_found');
    assert.equal(args.alternative, 'passed');
    assert.match(args.reason, /degradation/);
    assert.match(args.file, /01-VERIFICATION\.md$/);
    assert.match(args.command, /^Suggested: `status: gaps_found` \(or `passed`\) — /);
    // #2617: command surfaces are projected per runtime; the fix text names no
    // command at all (a hardcoded `/gsd-...` would be wrong on Codex). Checked
    // on the fix sentence — `args.file` is a path and may contain anything.
    assert.match(args.command, /delete the report and re-run the phase verification/);
    assert.doesNotMatch(args.command, /\/gsd-|\$gsd-|gsd:/);
  });

  test('every ambiguous legacy value from the live-projects census gets its own proposal', (t) => {
    const expected = [
      ['passed_with_human_verification', 'human_needed', 'passed'],
      ['passed_with_open_checkpoint', 'human_needed', null],
      ['passed-degraded', 'gaps_found', 'passed'],
      ['PASS-WITH-FLAGS', 'gaps_found', 'passed'],
    ];
    for (const [status, suggested, alternative] of expected) {
      const cwd = createTempDir('gsd-3-4a-w030-census-');
      t.after(() => cleanup(cwd));
      writeReport(cwd, status);
      const [diagnostic, ...rest] = ruleByCode['W030'].check(buildPlanningSnapshot(cwd));
      assert.deepEqual(rest, [], status);
      assert.equal(diagnostic.remedy.args.suggested, suggested, status);
      assert.equal(diagnostic.remedy.args.alternative, alternative, status);
      assert.deepEqual(ruleByCode['W031'].check(buildPlanningSnapshot(cwd)), [], `${status} is not W031`);
    }
  });

  test('a spelling variant of a closed-set member is proposed as that member, not rewritten', (t) => {
    for (const [status, suggested] of [['Passed', 'passed'], ['gaps-found', 'gaps_found'], ['HUMAN NEEDED', 'human_needed'], ['Verified', 'passed']]) {
      const cwd = createTempDir('gsd-3-4a-w030-variant-');
      t.after(() => cleanup(cwd));
      writeReport(cwd, status);
      const [diagnostic] = ruleByCode['W030'].check(buildPlanningSnapshot(cwd));
      assert.equal(diagnostic.remedy.args.suggested, suggested, status);
      assert.equal(diagnostic.remedy.args.alternative, null, status);
      assert.match(diagnostic.remedy.args.reason, /spelling variant/, status);
    }
  });

  test('an unknown value carries no proposal and says the verdict must be read from the report', (t) => {
    const cwd = createTempDir('gsd-3-4a-w030-unknown-');
    t.after(() => cleanup(cwd));
    writeReport(cwd, 'some_unknown_status');
    const [diagnostic] = ruleByCode['W030'].check(buildPlanningSnapshot(cwd));
    assert.equal(diagnostic.remedy.args.suggested, null);
    assert.equal(diagnostic.remedy.args.reason, null);
    assert.match(diagnostic.remedy.args.command, /^No known mapping for this value/);
  });

  test('`verified` is not W030 — it is the one unambiguous value, reported as W031', (t) => {
    const cwd = createTempDir('gsd-3-4a-w030-verified-');
    t.after(() => cleanup(cwd));
    writeReport(cwd, 'verified');
    assert.deepEqual(ruleByCode['W030'].check(buildPlanningSnapshot(cwd)), []);
  });

  test('baseline: an in-set status (passed / gaps_found / human_needed) produces no W030', (t) => {
    for (const status of ['passed', 'gaps_found', 'human_needed']) {
      const cwd = createTempDir(`gsd-5118-w030-neg-${status}-`);
      t.after(() => cleanup(cwd));
      writeReport(cwd, status);
      assert.deepEqual(ruleByCode['W030'].check(buildPlanningSnapshot(cwd)), [], status);
    }
  });
});

// ─── W031 — unambiguous legacy verification status (fork 3.4a) ─────────────
//
// MECHANICAL MUTATION: the same passing report with `status: verified` — the
// value six trade-mind and two ucars reports carry (live-projects census).

describe('W031 — verification report carries an unambiguous legacy status', () => {
  test('MECHANICAL MUTATION: `status: verified` fires W031 with a NONE-risk normalizeVerificationStatus remedy to `passed`', (t) => {
    const cwd = createTempDir('gsd-3-4a-w031-');
    t.after(() => cleanup(cwd));
    writeReport(cwd, 'verified');

    const diagnostics = ruleByCode['W031'].check(buildPlanningSnapshot(cwd));
    assert.deepEqual(diagnostics.map((d) => d.code), ['W031']);
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic.severity, 'warning');
    assert.match(diagnostic.message, /01-VERIFICATION\.md/);
    assert.match(diagnostic.message, /legacy status "verified"/);
    assert.deepEqual(
      { action: diagnostic.remedy.action, risk: diagnostic.remedy.risk, from: diagnostic.remedy.args.from, to: diagnostic.remedy.args.to },
      { action: 'normalizeVerificationStatus', risk: 'none', from: 'verified', to: 'passed' },
    );
    assert.match(diagnostic.remedy.args.file, /01-foo[\\/]01-VERIFICATION\.md$/);
    assert.equal(ruleByCode['W031'].repairable, true);
  });

  test('baseline: in-set and ambiguous statuses produce no W031', (t) => {
    for (const status of ['passed', 'gaps_found', 'human_needed', 'passed-degraded', 'Verified', 'VERIFIED']) {
      const cwd = createTempDir('gsd-3-4a-w031-neg-');
      t.after(() => cleanup(cwd));
      writeReport(cwd, status);
      assert.deepEqual(ruleByCode['W031'].check(buildPlanningSnapshot(cwd)), [], status);
    }
  });
});

// ─── Coverage: W030/W031 judge every report the readers read (fork FU-F) ───
//
// MECHANICAL MUTATION of `makeCompletePhaseDir`'s passing report, placed where
// the audits read it but the current milestone's phase list does not: an
// archived phase (`milestones/v1.0-phases/`) and an active directory outside
// the milestone window. Health used to judge only the window, so it reported
// nothing while `audit-open` failed on exactly these reports.

describe('W030/W031 coverage — the reports outside the current milestone', () => {
  test('an archived report with `status: verified` is W031, labelled with its archive, its remedy naming the archived file', (t) => {
    const cwd = createTempDir('gsd-fuf-w031-archived-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');
    writeFile(cwd, '.planning/milestones/v1.0-phases/01-old/01-VERIFICATION.md', '---\nstatus: verified\n---\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.equal(snap.phaseDirs.value.includes('01-old'), false, 'fixture sanity: archived phase is not in the window');
    const [diagnostic, ...rest] = ruleByCode['W031'].check(snap);
    assert.deepEqual(rest, []);
    assert.match(diagnostic.message, /^Phase v1\.0\/01-old: /);
    assert.equal(
      diagnostic.remedy.args.file,
      path.join(cwd, '.planning', 'milestones', 'v1.0-phases', '01-old', '01-VERIFICATION.md'),
    );
    assert.deepEqual(ruleByCode['W030'].check(snap), []);
  });

  test('an archived report with an ambiguous status is W030 with its proposal', (t) => {
    const cwd = createTempDir('gsd-fuf-w030-archived-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/milestones/v1.0-phases/01-old/01-VERIFICATION.md', '---\nstatus: passed-degraded\n---\n');

    const [diagnostic, ...rest] = ruleByCode['W030'].check(buildPlanningSnapshot(cwd));
    assert.deepEqual(rest, []);
    assert.match(diagnostic.message, /^Phase v1\.0\/01-old: /);
    assert.equal(diagnostic.remedy.args.suggested, 'gaps_found');
  });

  test('an active directory outside the milestone window is still judged', (t) => {
    const cwd = createTempDir('gsd-fuf-w031-window-');
    t.after(() => cleanup(cwd));
    writeState(cwd, { milestone: 'v2.0' });
    writeRoadmap(cwd, ['## v2.0 Current 🚧', '', '### Phase 2: Bar', ''].join('\n'));
    makeCompletePhaseDir(cwd, '.planning/phases/02-bar');
    writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', '---\nstatus: verified\n---\n');

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(snap.phaseDirs.value, ['02-bar'], 'fixture sanity: 01-foo is outside the window');
    assert.deepEqual(ruleByCode['W031'].check(snap).map((d) => d.message.split(':')[0]), ['Phase 01-foo']);
  });

  test('a bare VERIFICATION.md — the report `verification status` reads — is judged too', (t) => {
    const cwd = createTempDir('gsd-fuf-w030-bare-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/phases/01-foo/VERIFICATION.md', '---\nstatus: Passed\n---\n');

    const [diagnostic] = ruleByCode['W030'].check(buildPlanningSnapshot(cwd));
    assert.ok(diagnostic, 'a bare report with an out-of-set status is a finding');
    assert.match(diagnostic.remedy.args.file, /01-foo[\\/]VERIFICATION\.md$/);
  });

  test('a stray report naming another phase is not this phase\'s report and is not judged under it', (t) => {
    const cwd = createTempDir('gsd-fuf-w030-stray-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/01-foo/07-VERIFICATION.md', '---\nstatus: verified\n---\n');

    assert.deepEqual(ruleByCode['W031'].check(buildPlanningSnapshot(cwd)), []);
  });

  test('a report symlinked outside its phase directory is not read — no finding, nothing of it reaches a message', { skip: process.platform === 'win32' }, (t) => {
    const cwd = createTempDir('gsd-fuf-w031-escape-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, 'outside/02-VERIFICATION.md', '---\nstatus: verified\n---\n');
    fs.mkdirSync(path.join(cwd, '.planning', 'phases', '02-bar'), { recursive: true });
    fs.symlinkSync(path.join(cwd, 'outside', '02-VERIFICATION.md'), path.join(cwd, '.planning', 'phases', '02-bar', '02-VERIFICATION.md'));

    const snap = buildPlanningSnapshot(cwd);
    assert.deepEqual(snap.verificationReportDefects.value, []);
  });
});

// ─── W032 — verification report frontmatter does not parse (fork FU-F) ─────
//
// MECHANICAL MUTATION from a live project: a nested key indented under a
// scalar (`re_verification: true` followed by indented keys) — the shape that
// made the report's status vanish, read as "no status" by every aggregate.

describe('W032 — verification report frontmatter does not parse', () => {
  const NESTED_UNDER_SCALAR = [
    '---',
    'phase: 01',
    'status: passed',
    're_verification: true',
    '  previous_status: gaps_found',
    '  gaps_closed: 2',
    '---',
    '# Verification',
    '',
  ].join('\n');

  test('MECHANICAL MUTATION: a nested key under a scalar fires W032 naming the file, line 5 and the parser\'s reason — not W030/W031', (t) => {
    const cwd = createTempDir('gsd-fuf-w032-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    makeCompletePhaseDir(cwd, '.planning/phases/01-foo');
    writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', NESTED_UNDER_SCALAR);

    const snap = buildPlanningSnapshot(cwd);
    const diagnostics = ruleByCode['W032'].check(snap);
    assert.deepEqual(diagnostics.map((d) => d.code), ['W032']);
    const [diagnostic] = diagnostics;
    assert.equal(diagnostic.severity, 'warning');
    assert.equal(diagnostic.remedy.action, 'advise');
    assert.equal(diagnostic.remedy.args.line, 5);
    assert.equal(diagnostic.remedy.args.reason, 'bad indentation of a mapping entry');
    assert.match(diagnostic.remedy.args.file, /01-foo[\\/]01-VERIFICATION\.md$/);
    assert.match(diagnostic.remedy.args.command, /at line 5/);
    assert.equal(ruleByCode['W032'].repairable, false);
    assert.deepEqual(ruleByCode['W030'].check(snap), []);
    assert.deepEqual(ruleByCode['W031'].check(snap), []);
  });

  test('an archived unparseable report is W032 too', (t) => {
    const cwd = createTempDir('gsd-fuf-w032-archived-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/milestones/v1.0-phases/01-old/01-VERIFICATION.md', NESTED_UNDER_SCALAR);

    const [diagnostic, ...rest] = ruleByCode['W032'].check(buildPlanningSnapshot(cwd));
    assert.deepEqual(rest, []);
    assert.match(diagnostic.message, /^Phase v1\.0\/01-old: /);
  });

  test('a refusal with no position (an anchor) carries `line: null` and no line in the fix', (t) => {
    const cwd = createTempDir('gsd-fuf-w032-anchor-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', '---\nstatus: &verdict passed\n---\n');

    const [diagnostic] = ruleByCode['W032'].check(buildPlanningSnapshot(cwd));
    assert.ok(diagnostic, 'an anchor is refused by the parser');
    assert.equal(diagnostic.remedy.args.line, null);
    assert.doesNotMatch(diagnostic.remedy.args.command, /at line/);
  });

  test('baseline: the same report with the nested keys under a mapping parses — no W032', (t) => {
    const cwd = createTempDir('gsd-fuf-w032-neg-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', NESTED_UNDER_SCALAR.replace('re_verification: true', 're_verification:'));

    assert.deepEqual(ruleByCode['W032'].check(buildPlanningSnapshot(cwd)), []);
  });

  test('baseline: an unterminated fence is not W032 — it keeps its own #1882 reading', (t) => {
    const cwd = createTempDir('gsd-fuf-w032-unterminated-');
    t.after(() => cleanup(cwd));
    baseFixture(cwd);
    writeFile(cwd, '.planning/phases/01-foo/01-VERIFICATION.md', '---\nstatus: passed\n');

    assert.deepEqual(ruleByCode['W032'].check(buildPlanningSnapshot(cwd)), []);
  });
});
