/**
 * Plan `status` vocabulary — the `allowedValues` mechanism in src/frontmatter.cts
 *
 * Behavioural coverage through TWO typed surfaces only: the real CLI's parsed JSON
 * (via runGsdTools, the surface tests/frontmatter-cli.test.cjs already uses) and the
 * exported FRONTMATTER_SCHEMAS object. No source file is read and substring-matched —
 * `local/no-source-grep` rejects that and this file claims no exception.
 *
 * Covers ROADMAP Phase 1 criteria 1 (out-of-vocabulary fails loud, naming value and
 * allowed set), 2 (absence is valid — and its trap), and 4 (blocked_reason boundary at
 * limit-1 / limit / limit+1, fixtures derived from the exported constant).
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runGsdTools } = require('./helpers.cjs');

const { FRONTMATTER_SCHEMAS } = require('../gsd-core/bin/lib/frontmatter.cjs');
const {
  PLAN_STATUSES,
  BLOCKED_REASON_MAX_LENGTH,
  PLAN_STATUS_COMPANION_FIELDS,
} = require('../gsd-core/bin/lib/plan-status.cjs');

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tempFiles = [];

function writeTempFile(content) {
  const tmpFile = path.join(os.tmpdir(), `gsd-fm-status-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmpFile, content, 'utf-8');
  tempFiles.push(tmpFile);
  return tmpFile;
}

afterEach(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch { /* already cleaned */ }
  }
  tempFiles = [];
});

/**
 * A plan carrying all 8 D-03 required fields, plus whatever extra lines are given.
 * Pass no extras for a plan with NO status field at all.
 */
function planWith(...extraLines) {
  return [
    '---',
    'phase: 01',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    'files_modified: [src/auth.ts]',
    'autonomous: true',
    ...extraLines,
    'must_haves:',
    '  truths:',
    '    - "All tests pass"',
    '---',
    'body',
  ].join('\n');
}

/** Run `frontmatter validate` against a plan body and return the parsed JSON. */
function validate(content, schema = 'plan') {
  const file = writeTempFile(content);
  const result = runGsdTools(['frontmatter', 'validate', file, '--schema', schema]);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

/** Every string anywhere in the response, for "is X named / is X echoed" assertions. */
function allText(parsed) {
  return JSON.stringify(parsed);
}

// ─── Criterion 2 and its trap ────────────────────────────────────────────────

// The trap: "an absent status is valid" is ALSO satisfied by a schema that ignores
// `status` entirely — in which case "back-compat" silently means "the mechanism never
// runs". These two cases are siblings on purpose. Neither can be deleted without the
// other becoming visibly pointless, and the pair cannot both pass unless the mechanism
// both exists and is correctly scoped.
describe('criterion 2 + its trap: absence passes AND a present-but-invalid value fails', () => {
  test('a plan with NO status field is valid — absence means "not started" (D-04)', () => {
    const parsed = validate(planWith());
    assert.strictEqual(parsed.valid, true, 'absence of status must not invalidate any plan on disk');
    assert.deepStrictEqual(parsed.missing, [], 'status must not be reported as a missing field');
    assert.deepStrictEqual(parsed.invalidValue, []);
  });

  test('the SAME plan with status: frobnicated is invalid — so absence-passes is not schema-ignores', () => {
    const parsed = validate(planWith('status: frobnicated'));
    assert.strictEqual(parsed.valid, false, 'an out-of-vocabulary status must fail');
    assert.ok(parsed.invalidValue.includes('status'), 'status must be listed in invalidValue');
  });
});

// ─── Criterion 1: fail loud, naming the value AND the allowed set (D-09) ─────

describe('criterion 1: an out-of-vocabulary status names both the value and the allowed set', () => {
  test('the message names the offending value', () => {
    const parsed = validate(planWith('status: frobnicated'));
    assert.ok(allText(parsed).includes('frobnicated'), 'the offending value must appear in the output');
  });

  test('the message names every allowed value', () => {
    const parsed = validate(planWith('status: frobnicated'));
    const text = allText(parsed);
    for (const status of PLAN_STATUSES) {
      assert.ok(text.includes(status), `the allowed set must name "${status}"`);
    }
  });

  test('the failure surfaces through the existing invalidValue/missing contract, not a novel key', () => {
    const parsed = validate(planWith('status: frobnicated'));
    // `valid` stays derived from missing.length === 0 — the formula is unchanged.
    assert.ok(parsed.missing.includes('status'));
    assert.strictEqual(parsed.valid, parsed.missing.length === 0);
    assert.ok(Array.isArray(parsed.errors), 'errors is the established key on this surface (the NUL path already emits it)');
  });

  test('a passing response carries no errors key at all — unchanged shape for existing callers', () => {
    const parsed = validate(planWith('status: done'));
    assert.strictEqual(parsed.valid, true);
    assert.strictEqual('errors' in parsed, false, 'a valid response must be shaped exactly as before this change');
  });

  test('an empty status value is rejected rather than read as absence', () => {
    const parsed = validate(planWith('status: "   "'));
    assert.strictEqual(parsed.valid, false, 'a blank status is a declared-but-meaningless value, not absence');
    assert.ok(parsed.invalidValue.includes('status'));
  });

  test('a frontmatter key of __proto__ cannot reach a prototype member (T-01-04)', () => {
    const parsed = validate(planWith('__proto__: superseded', 'constructor: done'));
    assert.strictEqual(parsed.valid, true, 'prototype-named keys must not be mistaken for a status');
  });
});

// ─── D-06a: case-insensitive after trim ──────────────────────────────────────

describe('D-06a: comparison is case-insensitive after trim, matching src/plan-scan.cts:67', () => {
  const CASE_VARIANTS = ['Superseded', 'SUPERSEDED', '  superseded  ', 'sUpErSeDeD'];

  for (const variant of CASE_VARIANTS) {
    test(`status: "${variant}" validates — a stricter validator would reject a file plan-scan accepts`, () => {
      const parsed = validate(planWith(`status: "${variant}"`, 'superseded_by: 01-03'));
      assert.strictEqual(parsed.valid, true, `"${variant}" must normalise into the vocabulary`);
      assert.deepStrictEqual(parsed.invalidValue, []);
    });
  }

  test('mixed case is honoured for the companion rule too, not only for membership', () => {
    // If normalisation were skipped before the companion lookup, "BLOCKED" would
    // silently require nothing — passing for the wrong reason.
    const parsed = validate(planWith('status: BLOCKED'));
    assert.strictEqual(parsed.valid, false, 'BLOCKED must still demand a blocked_reason');
    assert.ok(parsed.missing.includes('blocked_reason'));
  });
});

// ─── D-08: companion fields ──────────────────────────────────────────────────

describe('D-08: blocked requires a non-empty blocked_reason; superseded requires superseded_by', () => {
  test('status: blocked with no blocked_reason fails, naming the field', () => {
    const parsed = validate(planWith('status: blocked'));
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.missing.includes('blocked_reason'));
    assert.ok(allText(parsed).includes('blocked_reason'));
  });

  test('status: blocked with a whitespace-only blocked_reason fails — non-empty means non-blank', () => {
    const parsed = validate(planWith('status: blocked', 'blocked_reason: "   "'));
    assert.strictEqual(parsed.valid, false, 'a blank reason records a state without recording why (T-01-07)');
    assert.ok(parsed.missing.includes('blocked_reason'));
  });

  test('status: blocked with a real reason is valid', () => {
    const parsed = validate(planWith('status: blocked', 'blocked_reason: "waiting on upstream API keys"'));
    assert.strictEqual(parsed.valid, true);
    assert.deepStrictEqual(parsed.invalidValue, []);
  });

  test('status: superseded with no superseded_by fails, naming the field', () => {
    const parsed = validate(planWith('status: superseded'));
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.missing.includes('superseded_by'));
    assert.ok(allText(parsed).includes('superseded_by'));
  });

  test('status: superseded with superseded_by is valid', () => {
    const parsed = validate(planWith('status: superseded', 'superseded_by: 01-03'));
    assert.strictEqual(parsed.valid, true);
  });

  test('status: superseded with a blank superseded_by fails', () => {
    const parsed = validate(planWith('status: superseded', 'superseded_by: "  "'));
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.missing.includes('superseded_by'));
  });

  test('status: in_progress requires no companion field', () => {
    const parsed = validate(planWith('status: in_progress'));
    assert.strictEqual(parsed.valid, true, 'in_progress has no D-08 entry and must require nothing');
    assert.deepStrictEqual(parsed.missing, []);
  });

  test('status: done requires no companion field', () => {
    const parsed = validate(planWith('status: done'));
    assert.strictEqual(parsed.valid, true, 'done has no D-08 entry and must require nothing');
    assert.deepStrictEqual(parsed.missing, []);
  });

  test('a garbage status does NOT also demand a companion field — one defect, one error', () => {
    const parsed = validate(planWith('status: frobnicated'));
    assert.deepStrictEqual(
      parsed.missing, ['status'],
      'demanding blocked_reason for an unknown status would emit two confusing errors for one defect',
    );
  });

  test('status_at is a recognised companion but is never required (D-12)', () => {
    assert.ok(PLAN_STATUS_COMPANION_FIELDS.includes('status_at'), 'status_at is in the roster');
    const parsed = validate(planWith('status: done'));
    assert.strictEqual(parsed.valid, true, 'a plan may omit status_at entirely');
    assert.ok(!parsed.missing.includes('status_at'));
  });
});

// ─── Criterion 4: the blocked_reason ceiling (D-10) ──────────────────────────

// Fixtures are DERIVED from the exported constant, never from the literal 2048, so
// moving the constant moves the boundary with it.
describe('criterion 4: blocked_reason boundary at limit-1 / limit / limit+1, never truncated', () => {
  test(`limit-1 (${BLOCKED_REASON_MAX_LENGTH - 1} chars) is valid`, () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH - 1);
    const parsed = validate(planWith('status: blocked', `blocked_reason: "${reason}"`));
    assert.strictEqual(parsed.valid, true);
  });

  test(`exactly the limit (${BLOCKED_REASON_MAX_LENGTH} chars) is valid — the ceiling is inclusive`, () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH);
    const parsed = validate(planWith('status: blocked', `blocked_reason: "${reason}"`));
    assert.strictEqual(parsed.valid, true);
  });

  test(`limit+1 (${BLOCKED_REASON_MAX_LENGTH + 1} chars) fails, naming the length and the limit`, () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);
    const parsed = validate(planWith('status: blocked', `blocked_reason: "${reason}"`));
    assert.strictEqual(parsed.valid, false);
    const text = allText(parsed);
    assert.ok(text.includes(String(BLOCKED_REASON_MAX_LENGTH + 1)), 'the actual length must be named');
    assert.ok(text.includes(String(BLOCKED_REASON_MAX_LENGTH)), 'the limit must be named');
  });

  test('an oversized reason is reported through invalidValue, not missing-only — the field IS in the file', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);
    const parsed = validate(planWith('status: blocked', `blocked_reason: "${reason}"`));
    assert.ok(
      parsed.invalidValue.includes('blocked_reason'),
      'calling a visible field "missing" sends the author hunting for something they can see',
    );
  });

  test('no field of the response carries the reason content, whole or shortened (D-10)', () => {
    // A distinctive body, so any echo — full or truncated — is detectable.
    const reason = 'Z'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);
    const parsed = validate(planWith('status: blocked', `blocked_reason: "${reason}"`));
    const text = allText(parsed);
    assert.ok(!text.includes('ZZZZZZZZZZ'), 'there is no truncation path — the reason must never be echoed back');
  });
});

// ─── Data-driven: every vocabulary value validates with its companion ────────

describe('every value in PLAN_STATUSES validates when its companion field is supplied', () => {
  // Fails if someone adds a fifth value to the vocabulary without a companion rule.
  const COMPANION_FOR = {
    blocked: 'blocked_reason: "a real reason"',
    superseded: 'superseded_by: 01-03',
  };

  for (const status of PLAN_STATUSES) {
    test(`status: ${status} validates`, () => {
      const extras = Object.prototype.hasOwnProperty.call(COMPANION_FOR, status)
        ? [`status: ${status}`, COMPANION_FOR[status]]
        : [`status: ${status}`];
      const parsed = validate(planWith(...extras));
      assert.strictEqual(parsed.valid, true, `${status} must validate with its companion field supplied`);
      assert.deepStrictEqual(parsed.invalidValue, []);
    });
  }
});

// ─── Back-compat pins ────────────────────────────────────────────────────────

describe('back-compat: the 8-field array and the #2847 requiredValues path are untouched', () => {
  test('FRONTMATTER_SCHEMAS.plan.required is still exactly the 8 D-03 fields', () => {
    assert.deepStrictEqual(FRONTMATTER_SCHEMAS.plan.required, [
      'phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves',
    ]);
  });

  test('status is NOT a member of plan.required — it is optional by design (D-03)', () => {
    assert.ok(!FRONTMATTER_SCHEMAS.plan.required.includes('status'));
  });

  test('allowedValues sits BESIDE requiredValues — plan carries one and not the other', () => {
    assert.strictEqual(FRONTMATTER_SCHEMAS.plan.requiredValues, undefined, 'plan still has no requiredValues');
    assert.deepStrictEqual(FRONTMATTER_SCHEMAS.plan.allowedValues.status, PLAN_STATUSES);
  });

  test('a schema may carry NEITHER mechanism — summary and verification are unchanged', () => {
    assert.strictEqual(FRONTMATTER_SCHEMAS.summary.requiredValues, undefined);
    assert.strictEqual(FRONTMATTER_SCHEMAS.summary.allowedValues, undefined);
    assert.strictEqual(FRONTMATTER_SCHEMAS.verification.requiredValues, undefined);
    assert.strictEqual(FRONTMATTER_SCHEMAS.verification.allowedValues, undefined);
  });

  test('a schema may carry BOTH — plan-gap-closure keeps requiredValues.gap_closure === "true" (#2847)', () => {
    assert.strictEqual(FRONTMATTER_SCHEMAS['plan-gap-closure'].requiredValues.gap_closure, 'true');
    assert.deepStrictEqual(FRONTMATTER_SCHEMAS['plan-gap-closure'].allowedValues.status, PLAN_STATUSES);
  });

  test('the vocabulary is imported, never re-declared — the schema holds the same reference', () => {
    assert.strictEqual(
      FRONTMATTER_SCHEMAS.plan.allowedValues.status,
      PLAN_STATUSES,
      'a copy here would be a second definition free to drift (the gates.tests_passed collision)',
    );
  });

  test('a valid gap-closure plan with gap_closure: true and NO status is still valid', () => {
    const parsed = validate(planWith('gap_closure: true'), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, true);
    assert.deepStrictEqual(parsed.missing, []);
    assert.deepStrictEqual(parsed.invalidValue, []);
  });

  test('gap_closure: false still fails through invalidValue — the new mechanism did not disturb the old', () => {
    const parsed = validate(planWith('gap_closure: false'), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.invalidValue.includes('gap_closure'), 'the #2847 failure path is unchanged');
    assert.ok(parsed.missing.includes('gap_closure'));
  });

  test('the two mechanisms compose: gap_closure: false AND status: frobnicated both surface', () => {
    const parsed = validate(planWith('gap_closure: false', 'status: frobnicated'), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.invalidValue.includes('gap_closure'), 'requiredValues still fires');
    assert.ok(parsed.invalidValue.includes('status'), 'allowedValues fires alongside it');
  });
});
