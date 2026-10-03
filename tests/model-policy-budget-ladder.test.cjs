'use strict';

/**
 * Each budget level shifts every tier down one step.
 *
 * `model_policy.budget` picks how expensive the whole policy is. For the presets
 * that have a middle model, the shape is the same everywhere: at budget `low` the
 * opus-tier agents get the model the sonnet tier gets at `medium`, and the
 * sonnet-tier agents get the model the haiku tier gets at `medium`.
 *
 * The anthropic presets broke that shape. Their opus/low step was
 * `claude-opus-4-5`, an older Opus, while every other provider stepped down. On
 * the claude runtime that ID has no alias, so it silently fell through to the
 * plain `opus` alias — "low budget" kept the planner on Opus — and the docs table
 * said Haiku for all three tiers, which a third reading contradicted. Nothing
 * compared the presets with each other, so three sources disagreed unnoticed.
 *
 * google is left out on purpose: its low budget collapses every tier to the same
 * lite model and has no middle step to shift to.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { PROVIDER_PRESETS } = require('../gsd-core/bin/lib/model-catalog.cjs');

const STEPPED = ['anthropic', 'anthropic-fable', 'openai', 'qwen'];
const modelAt = (provider, tier, level) => PROVIDER_PRESETS[provider]?.[tier]?.[level]?.model;

describe('model_policy budget ladder', () => {
  for (const provider of STEPPED) {
    test(`${provider}: budget low gives the opus tier what the sonnet tier gets at medium`, () => {
      const lowOpus = modelAt(provider, 'opus', 'low');
      assert.ok(lowOpus, `${provider} has no opus/low model`);
      assert.equal(lowOpus, modelAt(provider, 'sonnet', 'medium'));
    });

    test(`${provider}: budget low gives the sonnet tier what the haiku tier gets at medium`, () => {
      const lowSonnet = modelAt(provider, 'sonnet', 'low');
      assert.ok(lowSonnet, `${provider} has no sonnet/low model`);
      assert.equal(lowSonnet, modelAt(provider, 'haiku', 'medium'));
    });
  }

  test('the fable preset differs from the plain anthropic one only where fable is the point', () => {
    // Fable is an opt-in for the top step. Everything below it must not drift
    // from the plain preset, or a user choosing fable silently changes their
    // medium and low budgets too.
    for (const tier of ['opus', 'sonnet', 'haiku']) {
      for (const level of ['medium', 'low']) {
        assert.equal(
          modelAt('anthropic-fable', tier, level),
          modelAt('anthropic', tier, level),
          `anthropic-fable ${tier}/${level} drifted from anthropic`,
        );
      }
    }
  });
});
