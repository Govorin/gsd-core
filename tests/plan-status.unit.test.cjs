'use strict';

/**
 * Unit tests for plan-status.cjs
 *
 * Module: gsd-core/bin/lib/plan-status.cjs (built from src/plan-status.cts)
 *
 * Covers:
 *   - PLAN_STATUSES: the D-06 vocabulary, including the two literals that already
 *     ship with live readers
 *   - normalizePlanStatus: trim + lowercase, identical to src/plan-scan.cts:67
 *   - isPlanStatus: membership, including the D-06 exclusions
 *   - PLAN_STATUS_TRANSITIONS / isTransitionAllowed: every origin/target pair in the
 *     D-07 matrix, asserted against an independently-written expectation
 *   - BLOCKED_REASON_MAX_LENGTH / validateBlockedReason: the ceiling at
 *     limit-1 / limit / limit+1, and the absence of any truncation path
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  PLAN_STATUSES,
  PLAN_STATUS_TRANSITIONS,
  PLAN_STATUS_COMPANION_FIELDS,
  BLOCKED_REASON_MAX_LENGTH,
  normalizePlanStatus,
  isPlanStatus,
  isTransitionAllowed,
  validateBlockedReason,
} = require('../gsd-core/bin/lib/plan-status.cjs');

// ─── Vocabulary ───────────────────────────────────────────────────────────────

describe('PLAN_STATUSES', () => {
  test('is exactly the four D-06 values, in order', () => {
    assert.deepEqual(Array.from(PLAN_STATUSES), [
      'in_progress',
      'done',
      'blocked',
      'superseded',
    ]);
  });

  // These two literals are not hypothetical: they are read by shipped code.
  // Renaming either value here would silently break a live reader, so membership
  // is asserted rather than assumed.
  test("includes 'superseded' — the literal src/plan-scan.cts:67 already reads (D-00a, #2349)", () => {
    assert.ok(PLAN_STATUSES.includes('superseded'));
  });

  test("includes 'in_progress' — the literal check mn-orphan-plans (src/gate-mn-plan-status.cts) reads (D-00b)", () => {
    assert.ok(PLAN_STATUSES.includes('in_progress'));
  });
});

describe('PLAN_STATUS_COMPANION_FIELDS', () => {
  test('is exactly blocked_reason, superseded_by, status_at (D-08, D-12)', () => {
    assert.deepEqual(Array.from(PLAN_STATUS_COMPANION_FIELDS), [
      'blocked_reason',
      'superseded_by',
      'status_at',
    ]);
  });
});

// ─── normalizePlanStatus ──────────────────────────────────────────────────────

describe('normalizePlanStatus: trim then lowercase', () => {
  // The exact shape criterion 2's regression names: mixed case with a leading space.
  test("' SUPERSEDED ' normalises to 'superseded'", () => {
    assert.equal(normalizePlanStatus(' SUPERSEDED '), 'superseded');
  });

  test('mixed case alone is lowercased', () => {
    assert.equal(normalizePlanStatus('In_Progress'), 'in_progress');
  });

  test('surrounding whitespace alone is trimmed', () => {
    assert.equal(normalizePlanStatus('\t done \n'), 'done');
  });

  test('an already-normalised value is unchanged', () => {
    assert.equal(normalizePlanStatus('blocked'), 'blocked');
  });

  test('normalisation matches the shipped src/plan-scan.cts:67 comparison', () => {
    // plan-scan does: status.trim().toLowerCase() === 'superseded'
    for (const raw of [' SUPERSEDED ', 'Superseded', 'superseded\n', '  superseded']) {
      assert.equal(normalizePlanStatus(raw), raw.trim().toLowerCase());
    }
  });
});

describe('normalizePlanStatus: absence yields null (D-04, "not started" is VALID)', () => {
  const absent = [
    ['undefined', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace only', '   '],
    ['a number', 42],
    ['an object', { status: 'done' }],
    ['an array', ['done']],
    ['a boolean', true],
  ];

  for (const [label, value] of absent) {
    test(`${label} returns null`, () => {
      assert.equal(normalizePlanStatus(value), null);
    });
  }
});

// ─── isPlanStatus ─────────────────────────────────────────────────────────────

describe('isPlanStatus', () => {
  for (const status of PLAN_STATUSES) {
    test(`'${status}' is a member`, () => {
      assert.equal(isPlanStatus(status), true);
    });
  }

  test('normalises before testing membership', () => {
    assert.equal(isPlanStatus(' DONE '), true);
  });

  // D-06 exclusions, named so a future contributor does not "helpfully" add them:
  //   cancelled — indistinguishable from superseded by resulting action
  //   failed    — that is `blocked` with a reason; a separate status invites the
  //               model to invent intermediates
  test("'cancelled' is rejected (D-06: same resulting action as superseded)", () => {
    assert.equal(isPlanStatus('cancelled'), false);
  });

  test("'failed' is rejected (D-06: that is blocked with a reason)", () => {
    assert.equal(isPlanStatus('failed'), false);
  });

  test('absent input is not a status', () => {
    assert.equal(isPlanStatus(undefined), false);
    assert.equal(isPlanStatus(''), false);
    assert.equal(isPlanStatus(null), false);
  });
});

// ─── Transition matrix ────────────────────────────────────────────────────────

/**
 * A SECOND, hand-written statement of the D-07 matrix, deliberately independent of
 * the production table. Asserting the production table against itself would prove
 * nothing; because this is written out separately, a typo in EITHER one fails the
 * suite.
 *
 *   (none)       → in_progress | superseded
 *   in_progress  → done | blocked | superseded
 *   blocked      → in_progress | superseded
 *   done         → superseded
 *   superseded   → (terminal)
 */
const EXPECTED_TRANSITIONS = {
  none: ['in_progress', 'superseded'],
  in_progress: ['done', 'blocked', 'superseded'],
  blocked: ['in_progress', 'superseded'],
  done: ['superseded'],
  superseded: [],
};

describe('PLAN_STATUS_TRANSITIONS: the table itself', () => {
  test('has a row for every origin, including the explicit "none"', () => {
    assert.deepEqual(
      Object.keys(PLAN_STATUS_TRANSITIONS).sort(),
      Object.keys(EXPECTED_TRANSITIONS).sort(),
    );
  });

  test('superseded is terminal — its row is empty (D-07)', () => {
    assert.deepEqual(Array.from(PLAN_STATUS_TRANSITIONS.superseded), []);
  });

  test('every row matches the independently-written expectation', () => {
    for (const origin of Object.keys(EXPECTED_TRANSITIONS)) {
      assert.deepEqual(
        Array.from(PLAN_STATUS_TRANSITIONS[origin]).sort(),
        Array.from(EXPECTED_TRANSITIONS[origin]).sort(),
        `row for origin '${origin}'`,
      );
    }
  });
});

describe('isTransitionAllowed: exhaustive over the cartesian product', () => {
  const origins = ['none', ...PLAN_STATUSES];

  // 5 origins x 4 targets = 20 pairs, none left untested.
  for (const origin of origins) {
    for (const target of PLAN_STATUSES) {
      const expected = EXPECTED_TRANSITIONS[origin].includes(target);
      test(`${origin} -> ${target} is ${expected ? 'allowed' : 'rejected'}`, () => {
        const from = origin === 'none' ? undefined : origin;
        assert.equal(isTransitionAllowed(from, target), expected);
      });
    }
  }

  test('the cartesian product covers all 20 pairs', () => {
    assert.equal(origins.length * PLAN_STATUSES.length, 20);
  });
});

describe('isTransitionAllowed: named cases from D-07', () => {
  test("done -> in_progress is rejected: reopening is a NEW plan, not a rollback", () => {
    assert.equal(isTransitionAllowed('done', 'in_progress'), false);
  });

  test('in_progress -> done is allowed', () => {
    assert.equal(isTransitionAllowed('in_progress', 'done'), true);
  });

  test('no status yet -> in_progress is allowed', () => {
    assert.equal(isTransitionAllowed(undefined, 'in_progress'), true);
  });

  test('no status yet -> done is rejected', () => {
    assert.equal(isTransitionAllowed(undefined, 'done'), false);
  });

  test('every status may be superseded', () => {
    for (const origin of ['none', ...PLAN_STATUSES]) {
      const from = origin === 'none' ? undefined : origin;
      const expected = origin !== 'superseded';
      assert.equal(isTransitionAllowed(from, 'superseded'), expected, `${origin} -> superseded`);
    }
  });
});

describe('isTransitionAllowed: values outside the vocabulary', () => {
  test('an unknown origin cannot fall through to an allow branch', () => {
    for (const target of PLAN_STATUSES) {
      assert.equal(isTransitionAllowed('cancelled', target), false);
      assert.equal(isTransitionAllowed('failed', target), false);
    }
  });

  test('an unknown target is never reachable', () => {
    for (const origin of ['none', ...PLAN_STATUSES]) {
      const from = origin === 'none' ? undefined : origin;
      assert.equal(isTransitionAllowed(from, 'cancelled'), false);
      assert.equal(isTransitionAllowed(from, 'failed'), false);
    }
  });

  test('an absent target is rejected', () => {
    assert.equal(isTransitionAllowed('in_progress', undefined), false);
    assert.equal(isTransitionAllowed('in_progress', ''), false);
  });

  // A prototype key must not be mistaken for a table row.
  test('a prototype key is not an origin row', () => {
    assert.equal(isTransitionAllowed('constructor', 'in_progress'), false);
    assert.equal(isTransitionAllowed('toString', 'superseded'), false);
  });

  test('normalises both sides before lookup', () => {
    assert.equal(isTransitionAllowed(' IN_PROGRESS ', ' DONE '), true);
    assert.equal(isTransitionAllowed(' DONE ', ' IN_PROGRESS '), false);
  });
});

// ─── blocked_reason ceiling ───────────────────────────────────────────────────

describe('BLOCKED_REASON_MAX_LENGTH', () => {
  test('is exported and equals 2048', () => {
    assert.equal(BLOCKED_REASON_MAX_LENGTH, 2048);
  });

  // The ceiling exists to stay far below plan-scan's PLAN_FRONTMATTER_READ_CAP
  // (64 * 1024), so a maximal reason cannot push `status` out of reader #1's
  // bounded prefix.
  test('stays far below plan-scan PLAN_FRONTMATTER_READ_CAP (64 KiB)', () => {
    assert.ok(BLOCKED_REASON_MAX_LENGTH * 32 <= 64 * 1024);
  });
});

describe('validateBlockedReason: boundary at limit-1 / limit / limit+1', () => {
  // Fixtures are DERIVED from the constant, never from the literal 2048, so
  // changing the constant moves these boundaries with it instead of silently
  // invalidating them.
  test('limit-1 is accepted', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH - 1);
    assert.deepEqual(validateBlockedReason(reason), { ok: true });
  });

  test('limit is accepted — the ceiling is inclusive', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH);
    assert.deepEqual(validateBlockedReason(reason), { ok: true });
  });

  test('limit+1 is rejected', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);
    const result = validateBlockedReason(reason);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too_long');
    assert.equal(result.length, BLOCKED_REASON_MAX_LENGTH + 1);
    assert.equal(result.limit, BLOCKED_REASON_MAX_LENGTH);
  });
});

describe('validateBlockedReason: never truncates (D-10)', () => {
  test('no property of an oversized result carries a shortened input', () => {
    const reason = 'x'.repeat(BLOCKED_REASON_MAX_LENGTH + 1);
    const result = validateBlockedReason(reason);

    // The executable form of "fails; it is never truncated": the result reports
    // only length and limit, and carries no string value at all.
    assert.deepEqual(Object.keys(result).sort(), ['length', 'limit', 'ok', 'reason']);
    for (const value of Object.values(result)) {
      if (typeof value !== 'string') continue;
      assert.equal(value, 'too_long', 'the only string in the result is the failure code');
      assert.ok(!reason.startsWith(value), 'no prefix of the input is echoed back');
    }
  });

  test('the reason content is never echoed, so an oversized reason cannot reach gate output', () => {
    const reason = 'secret-'.repeat(BLOCKED_REASON_MAX_LENGTH);
    const result = validateBlockedReason(reason);
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
});

describe('validateBlockedReason: emptiness (D-08 requires a NON-EMPTY reason)', () => {
  test('an empty string is rejected', () => {
    const result = validateBlockedReason('');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty');
    assert.equal(result.length, 0);
    assert.equal(result.limit, BLOCKED_REASON_MAX_LENGTH);
  });

  test('a whitespace-only string is rejected as empty, not accepted as its length', () => {
    const result = validateBlockedReason('   \t\n  ');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'empty');
  });

  const missing = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { reason: 'blocked' }],
  ];

  for (const [label, value] of missing) {
    test(`${label} is rejected as missing`, () => {
      const result = validateBlockedReason(value);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'missing');
      assert.equal(result.limit, BLOCKED_REASON_MAX_LENGTH);
    });
  }
});

describe('validateBlockedReason: length is measured before trimming', () => {
  test('a padded reason at the ceiling is accepted', () => {
    // The file carries those bytes either way, so the on-disk length is what
    // competes with reader #1's bounded prefix.
    const reason = ' '.repeat(10) + 'x'.repeat(BLOCKED_REASON_MAX_LENGTH - 10);
    assert.equal(reason.length, BLOCKED_REASON_MAX_LENGTH);
    assert.deepEqual(validateBlockedReason(reason), { ok: true });
  });

  test('padding that pushes the raw length past the ceiling is rejected', () => {
    const reason = ' '.repeat(10) + 'x'.repeat(BLOCKED_REASON_MAX_LENGTH - 9);
    assert.equal(reason.length, BLOCKED_REASON_MAX_LENGTH + 1);
    const result = validateBlockedReason(reason);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'too_long');
    assert.equal(result.length, BLOCKED_REASON_MAX_LENGTH + 1);
  });

  test('an ordinary short reason is accepted', () => {
    assert.deepEqual(validateBlockedReason('waiting on upstream API keys'), { ok: true });
  });
});
