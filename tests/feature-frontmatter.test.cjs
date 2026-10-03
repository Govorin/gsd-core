/**
 * Plan `feature:` vocabulary — ROADMAP Phase 5 criterion 1.
 *
 * ─── The trap this file exists to close ──────────────────────────────────────
 *
 * Criterion 1 reads: an out-of-list `feature:` is "rejected by the same
 * `allowedValues` mechanism as Phase 1, not by a second implementation".
 *
 * That sentence is ALSO satisfied by a schema which never checks `feature:` at
 * all — because an ABSENT field is valid by design (D-04), so "no plan on disk
 * broke" is exactly what you observe when the mechanism is not wired up. The
 * absence half alone therefore proves nothing.
 *
 * So the two halves are asserted TOGETHER, in this one file:
 *
 *   1. a plan with NO `feature:` validates true   (nothing on disk is migrated)
 *   2. a plan with `feature: <garbage>` fails      (the check is LIVE, not nominal)
 *
 * Neither may be deleted without the other becoming visibly pointless. This is
 * the same trap Phase 1 documented for `status`, closed the same way in
 * tests/frontmatter-cli.test.cjs (the plan `status` vocabulary section).
 *
 * ─── Surfaces ────────────────────────────────────────────────────────────────
 *
 * Two typed surfaces only: the real CLI's parsed JSON (via runGsdTools) and the
 * exported FRONTMATTER_SCHEMAS / FEATURE_VALUES objects. No source file is read
 * and substring-matched — `local/no-source-grep` rejects that and this file
 * claims no exception.
 *
 * The expected allowed set is DERIVED from the compiled vocabulary module, never
 * hand-copied. A hardcoded list here would be a third place the vocabulary lives
 * and would keep passing while the real vocabulary drifted.
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runGsdTools } = require('./helpers.cjs');

const { FRONTMATTER_SCHEMAS } = require('../gsd-core/bin/lib/frontmatter.cjs');
const { FEATURE_VALUES } = require('../gsd-core/bin/lib/feature-vocabulary.cjs');
const { PLAN_STATUSES } = require('../gsd-core/bin/lib/plan-status.cjs');

// ─── Fixtures ────────────────────────────────────────────────────────────────

let tempFiles = [];

function writeTempFile(content) {
  const tmpFile = path.join(os.tmpdir(), `gsd-fm-feature-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
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
 * A plan carrying all 8 required fields, plus whatever extra lines are given.
 * Pass no extras for a plan with NO `feature:` field at all.
 */
function planWith(...extraLines) {
  return [
    '---',
    'phase: 05',
    'plan: 02',
    'type: execute',
    'wave: 2',
    'depends_on: []',
    'files_modified: [src/frontmatter.cts]',
    'autonomous: true',
    ...extraLines,
    'must_haves:',
    '  truths:',
    '    - "All tests pass"',
    '---',
    'body',
  ].join('\n');
}

/** The same plan shape plus the gap-closure flag, for the 'plan-gap-closure' schema. */
function gapClosurePlanWith(...extraLines) {
  return planWith('gap_closure: true', ...extraLines);
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

/** A real token from the closed list, derived rather than hardcoded. */
const A_VALID_FEATURE = FEATURE_VALUES[0];

// ─── The trap: BOTH halves, in this one file ─────────────────────────────────

describe('criterion 1 trap: absence passes AND a present-but-invalid value fails', () => {
  test('a plan with NO feature field is valid — D-52 says zero plans on disk carry one', () => {
    const parsed = validate(planWith());
    assert.strictEqual(parsed.valid, true, 'absence of feature must not invalidate any plan on disk');
    assert.ok(!parsed.missing.includes('feature'), 'an absent optional field is not "missing"');
    assert.ok(!parsed.invalidValue.includes('feature'), 'an absent optional field has no invalid value');
  });

  test('the SAME plan with feature: not-a-real-feature is invalid — so absence-passes is not schema-ignores', () => {
    const parsed = validate(planWith('feature: not-a-real-feature'));
    assert.strictEqual(parsed.valid, false, 'an out-of-vocabulary feature must fail');
    assert.ok(parsed.invalidValue.includes('feature'), 'feature must be listed in invalidValue');
  });
});

// ─── The failure names the value AND the whole allowed set ───────────────────

describe('an out-of-vocabulary feature names both the value and the allowed set', () => {
  test('the message names the offending value', () => {
    const parsed = validate(planWith('feature: not-a-real-feature'));
    assert.ok(allText(parsed).includes('not-a-real-feature'), 'the offending value must appear in the output');
  });

  test('the message names every allowed value, derived from the compiled vocabulary', () => {
    const parsed = validate(planWith('feature: not-a-real-feature'));
    const entry = parsed.errors.find(e => e.startsWith('Invalid feature:'));
    assert.ok(entry, 'an errors entry for feature must exist');
    assert.ok(entry.includes('not-a-real-feature'), 'the entry names the offending value');
    for (const feature of FEATURE_VALUES) {
      assert.ok(entry.includes(feature), `the allowed set must name "${feature}"`);
    }
  });

  test('the failure surfaces through the existing contract, not a novel top-level key', () => {
    const parsed = validate(planWith('feature: not-a-real-feature'));
    assert.deepStrictEqual(
      Object.keys(parsed).sort(),
      ['errors', 'invalidValue', 'missing', 'present', 'schema', 'valid'],
      'no new top-level response key may be introduced',
    );
  });

  test('feature lands in BOTH invalidValue and missing, so valid stays derived from missing.length', () => {
    const parsed = validate(planWith('feature: not-a-real-feature'));
    assert.ok(parsed.invalidValue.includes('feature'), 'visibly present in the file → invalidValue');
    assert.ok(parsed.missing.includes('feature'), 'missing carries it too, keeping the valid formula untouched');
    assert.strictEqual(parsed.valid, parsed.missing.length === 0);
  });
});

// ─── A real token passes, including case and whitespace variants ─────────────

describe('a valid token passes through the shared trim + lowercase normalisation', () => {
  test('an exact token validates', () => {
    const parsed = validate(planWith(`feature: ${A_VALID_FEATURE}`));
    assert.strictEqual(parsed.valid, true, `"${A_VALID_FEATURE}" is in the closed list`);
    assert.deepStrictEqual(parsed.invalidValue, []);
  });

  test('every token in the vocabulary validates — none is accidentally unreachable', () => {
    for (const feature of FEATURE_VALUES) {
      const parsed = validate(planWith(`feature: ${feature}`));
      assert.strictEqual(parsed.valid, true, `"${feature}" must validate`);
    }
  });

  test('an uppercase token validates via the existing normalisation', () => {
    const parsed = validate(planWith(`feature: ${A_VALID_FEATURE.toUpperCase()}`));
    assert.strictEqual(parsed.valid, true, 'trim + lowercase is the shared normalisation (D-51)');
  });

  test('a surrounding-whitespace token validates via the existing normalisation', () => {
    const parsed = validate(planWith(`feature: "  ${A_VALID_FEATURE}  "`));
    assert.strictEqual(parsed.valid, true, 'leading/trailing whitespace is trimmed, not rejected');
  });
});

// ─── Empty is rejected, not silently treated as absent ───────────────────────

describe('an empty feature value is rejected rather than read as absence', () => {
  test('`feature:` with no value fails', () => {
    const parsed = validate(planWith('feature:'));
    assert.strictEqual(parsed.valid, false, 'an empty value is a present-but-invalid value, not an absent field');
    assert.ok(parsed.invalidValue.includes('feature'));
  });

  test('`feature: ""` fails', () => {
    const parsed = validate(planWith('feature: ""'));
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.invalidValue.includes('feature'));
  });
});

// ─── T-05-04: prototype keys are rejected, not resolved through the chain ────

describe('T-05-04: prototype-chain values do not resolve to a member', () => {
  for (const hostile of ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty']) {
    test(`feature: ${hostile} is rejected as out-of-vocabulary`, () => {
      const parsed = validate(planWith(`feature: ${hostile}`));
      assert.strictEqual(parsed.valid, false, `"${hostile}" is not a feature token`);
      assert.ok(parsed.invalidValue.includes('feature'), 'it must be flagged, not silently accepted');
    });
  }
});

// ─── The same three outcomes hold for plan-gap-closure ───────────────────────

describe('plan-gap-closure carries the identical vocabulary — one object, two schemas', () => {
  test('absent feature is valid', () => {
    const parsed = validate(gapClosurePlanWith(), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, true);
    assert.ok(!parsed.invalidValue.includes('feature'));
  });

  test('a valid token is valid', () => {
    const parsed = validate(gapClosurePlanWith(`feature: ${A_VALID_FEATURE}`), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, true);
  });

  test('an invalid token fails, naming the value and the allowed set', () => {
    const parsed = validate(gapClosurePlanWith('feature: not-a-real-feature'), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.invalidValue.includes('feature'));
    const entry = parsed.errors.find(e => e.startsWith('Invalid feature:'));
    assert.ok(entry, 'an errors entry for feature must exist on this schema too');
    for (const feature of FEATURE_VALUES) {
      assert.ok(entry.includes(feature), `the allowed set must name "${feature}"`);
    }
  });

  test('the two plan-shaped schemas reference ONE vocabulary object, so they cannot drift', () => {
    assert.strictEqual(
      FRONTMATTER_SCHEMAS.plan.allowedValues,
      FRONTMATTER_SCHEMAS['plan-gap-closure'].allowedValues,
      'both schemas must share the same object by reference, never a hand-copy',
    );
  });

  test('gap_closure requiredValues behaviour is unchanged by the sibling key', () => {
    const parsed = validate(planWith(`feature: ${A_VALID_FEATURE}`), 'plan-gap-closure');
    assert.strictEqual(parsed.valid, false, 'a missing gap_closure still fails');
    assert.ok(parsed.missing.includes('gap_closure'));
  });
});

// ─── Per-field: the two vocabularies do not shadow each other ────────────────

describe('status and feature are checked per-field, neither shadowing the other', () => {
  test('a plan with BOTH an invalid status and an invalid feature reports both', () => {
    const parsed = validate(planWith('status: frobnicated', 'feature: not-a-real-feature'));
    assert.strictEqual(parsed.valid, false);
    assert.ok(parsed.invalidValue.includes('status'), 'status must be flagged');
    assert.ok(parsed.invalidValue.includes('feature'), 'feature must be flagged');
    const statusEntry = parsed.errors.find(e => e.startsWith('Invalid status:'));
    const featureEntry = parsed.errors.find(e => e.startsWith('Invalid feature:'));
    assert.ok(statusEntry, 'a distinct errors entry for status');
    assert.ok(featureEntry, 'a distinct errors entry for feature');
    assert.notStrictEqual(statusEntry, featureEntry, 'two defects, two entries');
  });

  test('each field is offered only its OWN vocabulary — a status token is not a feature token', () => {
    const statusOnly = PLAN_STATUSES.filter(s => !FEATURE_VALUES.includes(s));
    assert.ok(statusOnly.length > 0, 'the two vocabularies must not be identical for this test to mean anything');
    const parsed = validate(planWith(`feature: ${statusOnly[0]}`));
    assert.strictEqual(parsed.valid, false, 'a valid status is not thereby a valid feature');
    assert.ok(parsed.invalidValue.includes('feature'));
  });

  test('a valid status alongside a valid feature validates', () => {
    const parsed = validate(planWith('status: done', `feature: ${A_VALID_FEATURE}`));
    assert.strictEqual(parsed.valid, true);
    assert.deepStrictEqual(parsed.invalidValue, []);
  });
});

// ─── feature is OPTIONAL: the required-field count is unchanged ──────────────

describe('feature is optional — the required-field arrays are untouched', () => {
  test('the plan schema still requires exactly 8 fields, none of them feature', () => {
    assert.strictEqual(FRONTMATTER_SCHEMAS.plan.required.length, 8);
    assert.ok(!FRONTMATTER_SCHEMAS.plan.required.includes('feature'));
  });

  test('the plan-gap-closure schema still requires exactly 9 fields, none of them feature', () => {
    assert.strictEqual(FRONTMATTER_SCHEMAS['plan-gap-closure'].required.length, 9);
    assert.ok(!FRONTMATTER_SCHEMAS['plan-gap-closure'].required.includes('feature'));
  });

  test('the vocabulary the schema offers IS the compiled one, not a copy', () => {
    assert.deepStrictEqual(
      [...FRONTMATTER_SCHEMAS.plan.allowedValues.feature],
      [...FEATURE_VALUES],
      'the schema must serve the generated vocabulary, so ROADMAP stays the one source',
    );
  });

  test('a non-empty vocabulary is what makes the closed list meaningful', () => {
    assert.ok(
      FEATURE_VALUES.length > 0,
      'an EMPTY vocabulary would make every feature: value invalid — the generator forbids emitting one, and this pins that the wiring inherits a real list',
    );
  });
});
