'use strict';

/**
 * The VERIFICATION report set every reader judges, and the report whose
 * frontmatter does not parse (fork FU-F, found while repairing live projects).
 *
 * Two defects, one seam:
 * - Coverage. `validate health` judged only the current milestone's phases
 *   while `audit-open`/`audit-uat` read every active phase directory and every
 *   archived one, so health was clean while `audit-open` failed with
 *   `verification_status_invalid` on an archived `status: verified`. Both now
 *   read the verification owner's one enumeration (`listVerificationReports`).
 * - Unparseable frontmatter. A nested key under a scalar made
 *   `extractFrontmatter` return an empty object, and the aggregates read that
 *   as "no status": the report vanished. The readers now refuse it
 *   (`VerificationReportUnparseableError`, a `VerificationStatusError`) and
 *   health reports it (W032) with the line and the parser's reason.
 *
 * Fixture provenance: MECHANICAL MUTATION of the passing report every 5118
 * surface fixture writes (`---\nstatus: passed\n---`), with `status` replaced
 * by the legacy value, or with the live project's nested-under-scalar block.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const frontmatter = require('../gsd-core/bin/lib/frontmatter.cjs');
const verification = require('../gsd-core/bin/lib/verification.cjs');

const {
  VerificationStatusError,
  VerificationReportUnparseableError,
  VERIFICATION_STATUS_ERROR_CODE,
  readReportStatus,
  reportStatusOf,
  selectPhaseVerificationReports,
  listVerificationReports,
} = verification;

const NESTED_UNDER_SCALAR = [
  '---',
  'phase: 01',
  'status: passed',
  're_verification: true',
  '  previous_status: gaps_found',
  '---',
  '# Verification',
  '',
].join('\n');

/** The structured `--json-errors` envelope: the last stderr line that parses as `{ ok: false }`. */
function errorEnvelope(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.ok === false) return parsed;
    } catch {
      // not the envelope line
    }
  }
  return null;
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** One current phase with a passing report; config.json lacks the workflow keys health can add (W008/W016). */
function writeProject(root) {
  writeFile(root, '.planning/PROJECT.md', '# Project\n\n## What This Is\n\nx\n\n## Core Value\n\nx\n\n## Requirements\n\nx\n');
  writeFile(root, '.planning/config.json', '{"workflow": {}}\n');
  writeFile(root, '.planning/ROADMAP.md', ['# Roadmap', '', '## v2.0 Current', '', '### Phase 2: Bar', '**Goal:** Bar', ''].join('\n'));
  writeFile(root, '.planning/STATE.md', '---\nmilestone: v2.0\n---\n# State\n');
  writeFile(root, '.planning/phases/02-bar/02-01-PLAN.md', '# Plan\n');
  writeFile(root, '.planning/phases/02-bar/02-01-SUMMARY.md', '# Summary\n');
  writeFile(root, '.planning/phases/02-bar/02-VERIFICATION.md', '---\nstatus: passed\n---\n');
}

function healthJson(root, args = []) {
  const res = runGsdTools(['validate', 'health', ...args], root);
  assert.equal(res.exitCode, 0, res.error);
  return JSON.parse(res.output);
}

// ─── parseFrontmatterStrict ────────────────────────────────────────────────

describe('parseFrontmatterStrict — extractFrontmatter plus the reason a closed block does not parse', () => {
  test('a parseable block, no block, and an unterminated fence answer exactly as extractFrontmatter does', () => {
    for (const doc of ['---\nstatus: passed\nscore: 5\n---\nbody\n', '# no frontmatter\n', '---\nstatus: passed\n']) {
      const strict = frontmatter.parseFrontmatterStrict(doc);
      assert.equal(strict.ok, true, JSON.stringify(doc));
      assert.deepEqual(strict.frontmatter, frontmatter.extractFrontmatter(doc), JSON.stringify(doc));
    }
  });

  test('a nested key under a scalar is not ok, naming document line 5 and the parser\'s reason', () => {
    assert.deepEqual(frontmatter.parseFrontmatterStrict(NESTED_UNDER_SCALAR), {
      ok: false,
      line: 5,
      reason: 'bad indentation of a mapping entry',
    });
  });

  test('line boundaries: the first block line is document line 2, the next is 3; a leading BOM shifts neither', () => {
    const onFirstBlockLine = '---\n\tstatus: passed\n---\n';
    const onSecondBlockLine = '---\nphase: 1\n  status: passed\n---\n';
    assert.equal(frontmatter.parseFrontmatterStrict(onFirstBlockLine).line, 2);
    assert.equal(frontmatter.parseFrontmatterStrict(onSecondBlockLine).line, 3);
    assert.equal(frontmatter.parseFrontmatterStrict(`\uFEFF${onFirstBlockLine}`).line, 2);
    assert.equal(frontmatter.parseFrontmatterStrict(`\uFEFF${NESTED_UNDER_SCALAR}`).line, 5);
  });

  test('a refusal with no position (an anchor) is not ok with `line: null`', () => {
    const result = frontmatter.parseFrontmatterStrict('---\nstatus: &verdict passed\n---\n');
    assert.equal(result.ok, false);
    assert.equal(result.line, null);
    assert.equal(typeof result.reason, 'string');
  });

  test('extractFrontmatter is unchanged: the same block still reads as the marked empty object', () => {
    const fm = frontmatter.extractFrontmatter(NESTED_UNDER_SCALAR);
    assert.deepEqual(Object.keys(fm), []);
    assert.equal(fm[frontmatter.FRONTMATTER_UNPARSEABLE], true);
  });
});

// ─── The readers' judgement ────────────────────────────────────────────────

describe('readReportStatus / reportStatusOf — an unparseable block is refused, never "no status"', () => {
  test('readReportStatus throws VerificationReportUnparseableError carrying the file, line and reason — a VerificationStatusError', () => {
    assert.throws(() => readReportStatus(NESTED_UNDER_SCALAR, '/p/01-VERIFICATION.md'), (err) => {
      assert.ok(err instanceof VerificationReportUnparseableError);
      assert.ok(err instanceof VerificationStatusError, 'rides every path that carries a VerificationStatusError');
      assert.deepEqual(
        { code: err.code, reason: err.reason, file: err.file, line: err.line, parseReason: err.parseReason, rawStatus: err.rawStatus },
        {
          code: VERIFICATION_STATUS_ERROR_CODE,
          reason: 'verification_status_invalid',
          file: '/p/01-VERIFICATION.md',
          line: 5,
          parseReason: 'bad indentation of a mapping entry',
          rawStatus: undefined,
        },
      );
      return true;
    });
  });

  test('reportStatusOf on the unparseable marker throws the same error class with no line', () => {
    assert.throws(
      () => reportStatusOf(frontmatter.extractFrontmatter(NESTED_UNDER_SCALAR), '/p/01-VERIFICATION.md'),
      (err) => err instanceof VerificationReportUnparseableError && err.line === null,
    );
  });

  test('baseline: a parseable report answers its status and frontmatter; no status key is still null', () => {
    assert.deepEqual(readReportStatus('---\nstatus: gaps_found\nscore: 3\n---\n', '/p/r.md'), {
      fm: { status: 'gaps_found', score: '3' },
      status: 'gaps_found',
    });
    assert.equal(readReportStatus('---\nphase: 1\n---\n', '/p/r.md').status, null);
  });
});

// ─── The one report set ────────────────────────────────────────────────────

describe('selectPhaseVerificationReports — one per-phase selection for every reader', () => {
  test('scoped dashed reports, never a stray naming another phase', () => {
    assert.deepEqual(
      selectPhaseVerificationReports(['01-VERIFICATION.md', '01-VERIFICATION-r2.md', '07-VERIFICATION.md', '01-01-PLAN.md'], '01-foo'),
      ['01-VERIFICATION-r2.md', '01-VERIFICATION.md'],
    );
  });

  test('a bare VERIFICATION.md is selected when it is the report `verification status` resolves, and only then', () => {
    assert.deepEqual(selectPhaseVerificationReports(['VERIFICATION.md', '01-01-PLAN.md'], '01-foo'), ['VERIFICATION.md']);
    assert.deepEqual(selectPhaseVerificationReports(['VERIFICATION.md', '01-VERIFICATION.md'], '01-foo'), ['01-VERIFICATION.md']);
    assert.deepEqual(selectPhaseVerificationReports(['01-01-PLAN.md'], '01-foo'), []);
  });
});

describe('listVerificationReports — active (every directory) and archived phases', () => {
  test('lists the out-of-window active report and the archived report, labelling the archive', (t) => {
    const root = createTempProject('gsd-fuf-list-');
    t.after(() => cleanup(root));
    writeProject(root);
    writeFile(root, '.planning/phases/01-foo/01-VERIFICATION.md', '---\nstatus: passed\n---\n');
    writeFile(root, '.planning/milestones/v1.0-phases/01-old/01-VERIFICATION.md', '---\nstatus: passed\n---\n');

    const { reports, activeUnreadable } = listVerificationReports(root);
    assert.equal(activeUnreadable, false);
    assert.deepEqual(
      reports.map((r) => [r.milestone ?? null, r.dir, r.file]),
      [[null, '01-foo', '01-VERIFICATION.md'], [null, '02-bar', '02-VERIFICATION.md'], ['v1.0', '01-old', '01-VERIFICATION.md']],
    );
  });
});

// ─── Coverage parity: what audit-open refuses, health reports ──────────────

describe('audit-open ↔ validate health parity (the live-repair defect)', () => {
  test('an archived `status: verified`: audit-open refuses it, health reports W031 for the same file, `--repair --only W031` fixes it and nothing else', (t) => {
    const root = createTempProject('gsd-fuf-parity-');
    t.after(() => cleanup(root));
    writeProject(root);
    const archived = writeFile(root, '.planning/milestones/v1.0-phases/01-old/01-VERIFICATION.md', '---\nstatus: verified\n---\n# Old\n');

    const refused = runGsdTools(['--json-errors', 'audit-open', '--json'], root);
    assert.notEqual(refused.exitCode, 0, refused.output);
    const envelope = errorEnvelope(refused.error);
    assert.equal(envelope?.reason, 'verification_status_invalid', refused.error);
    assert.ok(envelope.message.includes(path.join('v1.0-phases', '01-old', '01-VERIFICATION.md')), envelope.message);

    const report = healthJson(root);
    const w031 = report.warnings.filter((w) => w.code === 'W031');
    assert.equal(w031.length, 1, JSON.stringify(report.warnings));
    assert.ok(report.warnings.some((w) => w.code === 'W008'), 'fixture sanity: a config.json repair is also available');

    const configBefore = fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf-8');
    const repaired = healthJson(root, ['--repair', '--only', 'W031']);
    assert.deepEqual(repaired.repairs_performed.map((r) => [r.action, r.success]), [['normalizeVerificationStatus', true]]);
    assert.equal(fs.readFileSync(archived, 'utf-8'), '---\nstatus: passed\n---\n# Old\n');
    assert.equal(fs.readFileSync(path.join(root, '.planning', 'config.json'), 'utf-8'), configBefore, 'config.json untouched');

    const ok = runGsdTools(['--json-errors', 'audit-open', '--json'], root);
    assert.equal(ok.exitCode, 0, ok.error);
    assert.equal(healthJson(root).warnings.some((w) => ['W030', 'W031'].includes(w.code)), false);
  });

  test('an unparseable report: audit-open, audit-uat and phase uat-passed refuse it with verification_status_invalid, health reports W032, `verification status` keeps `unparseable`', (t) => {
    const root = createTempProject('gsd-fuf-unparseable-');
    t.after(() => cleanup(root));
    writeProject(root);
    const reportPath = writeFile(root, '.planning/phases/02-bar/02-VERIFICATION.md', NESTED_UNDER_SCALAR);

    for (const argv of [['audit-open', '--json'], ['audit-uat'], ['phase', 'uat-passed', '2']]) {
      const res = runGsdTools(['--json-errors', ...argv], root);
      assert.notEqual(res.exitCode, 0, `${argv[0]} must not read the report as "no status": ${res.output}`);
      assert.equal(res.output, '', `${argv[0]}: no answer on stdout`);
      assert.equal(errorEnvelope(res.error)?.reason, 'verification_status_invalid', res.error);
    }

    const w032 = healthJson(root).warnings.filter((w) => w.code === 'W032');
    assert.equal(w032.length, 1);
    assert.equal(w032[0].repairable, false);

    const status = runGsdTools(['verification', 'status', path.dirname(reportPath)], root);
    assert.equal(status.exitCode, 0, status.error);
    assert.equal(JSON.parse(status.output).status, 'unparseable');
  });

  test('baseline: the same project with a parseable report — audit-open answers, no W030/W031/W032', (t) => {
    const root = createTempProject('gsd-fuf-parity-neg-');
    t.after(() => cleanup(root));
    writeProject(root);
    writeFile(root, '.planning/milestones/v1.0-phases/01-old/01-VERIFICATION.md', '---\nstatus: passed\n---\n');

    assert.equal(runGsdTools(['audit-open', '--json'], root).exitCode, 0);
    assert.equal(healthJson(root).warnings.some((w) => ['W030', 'W031', 'W032'].includes(w.code)), false);
  });
});
