'use strict';

/**
 * The verifier is the judge of the executor's work, so no profile may give it a
 * smaller model than the executor, and it sits on the heavy tier.
 *
 * "Put the judge in a different context than the worker" only helps if the judge
 * is not the weaker party. The verifier used to be routed to the standard tier,
 * with Haiku under `budget`: the same effort as the executor it checks, and a
 * smaller model than it in one profile. Nothing compared the two rows, so the
 * gap was only visible by reading the catalog.
 *
 * Scope is the verifier alone. The code reviewer, plan checker and the other
 * judges sit on their own tiers for their own reasons and are not asserted here.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { MODEL_PROFILES, AGENT_DEFAULT_TIERS, VALID_PROFILES } = require('../gsd-core/bin/lib/model-catalog.cjs');

const RANK = { haiku: 0, sonnet: 1, opus: 2 };

describe('verifier is not weaker than the executor it judges', () => {
  test('the verifier is routed to the heavy tier', () => {
    assert.equal(AGENT_DEFAULT_TIERS['gsd-verifier'], 'heavy');
  });

  const profiles = VALID_PROFILES.filter((p) => p !== 'inherit');
  assert.ok(profiles.length >= 4, `expected the named profiles, got ${JSON.stringify(profiles)}`);

  for (const profile of profiles) {
    test(`${profile}: the verifier's model is at least the executor's`, () => {
      const verifier = MODEL_PROFILES['gsd-verifier'][profile];
      const executor = MODEL_PROFILES['gsd-executor'][profile];
      assert.ok(verifier in RANK && executor in RANK, `unexpected tier names: verifier=${verifier} executor=${executor}`);
      assert.ok(
        RANK[verifier] >= RANK[executor],
        `${profile}: verifier gets ${verifier}, executor gets ${executor} — the judge is the weaker party`,
      );
    });
  }
});
