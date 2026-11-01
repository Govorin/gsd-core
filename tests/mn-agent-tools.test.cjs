'use strict';

/**
 * Every agentTools block in the frozen first-party registry (fork, ADR-5210):
 * the installer reads only that registry, and a malformed block contributes
 * nothing — silently. So the registry is checked here, block by block, for
 * every capability that declares one, present and future: each block is
 * well-formed enough to contribute, each agent it lists ships, and the
 * reference a block names is a file the install ships.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const {
  resolveCapabilityAgentTools,
  resolveCapabilityAgentReferences,
  grantsForAgent,
  referencesForAgent,
} = require('../gsd-core/bin/lib/mn-agent-tools.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const BLOCKS = Object.entries(registry.capabilities)
  .filter(([, cap]) => cap && cap.agentTools)
  .map(([id, cap]) => ({ id, ...cap.agentTools }));

// Every activation key on, so a block that contributes nothing is malformed, not switched off.
const allOn = () => true;

test('precondition: the registry declares agentTools blocks', () => {
  assert.ok(BLOCKS.length >= 2, `expected mn-code-navigation and mn-nx-tasks, got ${BLOCKS.map((b) => b.id)}`);
});

test('every block is well-formed: each listed agent gets all of its grants', () => {
  const grants = resolveCapabilityAgentTools(registry, allOn);
  for (const { id, agents, grants: declared } of BLOCKS) {
    for (const agent of agents) {
      const got = grantsForAgent(grants, agent);
      assert.deepStrictEqual(declared.filter((grant) => !got.includes(grant)), [], `${id} -> ${agent}`);
    }
  }
});

test('every listed agent ships in agents/', () => {
  for (const { id, agents } of BLOCKS) {
    for (const agent of agents) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, 'agents', `${agent}.md`)), `${id} lists ${agent}, which agents/ does not ship`);
    }
  }
});

test('every reference a block names ships in gsd-core/references/ and reaches each listed agent', () => {
  const references = resolveCapabilityAgentReferences(registry, allOn);
  for (const { id, agents, reference } of BLOCKS.filter((block) => block.reference !== undefined)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'gsd-core', 'references', reference)),
      `${id} names gsd-core/references/${reference}, which does not exist`);
    for (const agent of agents) {
      assert.ok(referencesForAgent(references, agent).some((r) => r.capability === id && r.reference === reference),
        `${id} -> ${agent} gets no pointer`);
    }
  }
});
