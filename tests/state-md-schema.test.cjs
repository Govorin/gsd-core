'use strict';

// The STATE.md status lifecycle vocabulary (ADR-2207) owned by
// state-md-schema: which raw Status values mean the milestone is closed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { isMilestoneClosedStatus } = require('../gsd-core/bin/lib/state-md-schema.cjs');

describe('isMilestoneClosedStatus — the statuses only the milestone-close verb writes', () => {
  test('"<version> milestone complete" and the legacy bare form are closed', () => {
    assert.equal(isMilestoneClosedStatus('v1.12 milestone complete'), true);
    assert.equal(isMilestoneClosedStatus('1.0 Milestone Complete'), true);
    assert.equal(isMilestoneClosedStatus('Milestone complete'), true);
  });

  test('"Awaiting next milestone", the value the Current Position reset leaves, is closed', () => {
    assert.equal(isMilestoneClosedStatus('Awaiting next milestone'), true);
    assert.equal(isMilestoneClosedStatus('  awaiting   NEXT milestone '), true);
  });

  test('the intermediate "All phases complete" is not closed', () => {
    assert.equal(isMilestoneClosedStatus('All phases complete'), false);
  });

  test('prose that merely contains a closing status is not closed (anchored, #4186)', () => {
    assert.equal(isMilestoneClosedStatus('Awaiting next milestone review'), false);
    assert.equal(isMilestoneClosedStatus('not v1.0 milestone complete'), false);
    assert.equal(isMilestoneClosedStatus('next: Awaiting next milestone'), false);
    assert.equal(isMilestoneClosedStatus('Phase 7 complete'), false);
  });

  test('an absent status is not closed', () => {
    assert.equal(isMilestoneClosedStatus(null), false);
    assert.equal(isMilestoneClosedStatus(undefined), false);
    assert.equal(isMilestoneClosedStatus(''), false);
  });
});
