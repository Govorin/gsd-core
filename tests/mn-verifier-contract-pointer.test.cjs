'use strict';

// allow-test-rule: source-text-is-the-product (ADR-5210) — the spawn prompt in a
// shipped workflow step and the reference it hands over are the runtime surface.

/**
 * The fork's verifier contract (SPEC `AC-n` as truths, `truths_unproven` in the
 * frontmatter) reaches gsd-verifier through the phase-verification spawn prompt,
 * not through agents/gsd-verifier.md, which stays upstream's bytes (ADR-5210).
 * The mn-verify-gate ship:pre gate reads `truths_unproven`; a verifier that never
 * received the contract would omit it and every gated ship would halt.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const STEP = path.join(REPO_ROOT, 'gsd-core', 'workflows', 'execute-phase', 'steps', 'verify-phase-goal.md');
const REFERENCE = 'gsd-core/references/verifier-spec-contract.md';

function block(text, open, close) {
  const start = text.indexOf(open);
  assert.ok(start !== -1, `missing ${open}`);
  const end = text.indexOf(close, start + open.length);
  assert.ok(end !== -1, `missing ${close} after ${open}`);
  return text.slice(start + open.length, end);
}

test('the verifier spawn prompt lists the contract reference in its <required_reading>', () => {
  const dispatch = block(fs.readFileSync(STEP, 'utf8'), '<step name="verifier_dispatch">', '</step>');
  const spawn = block(dispatch, 'Agent(', 'subagent_type="gsd-verifier"');
  const reading = block(spawn, '<required_reading>', '</required_reading>')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split(' ')[0]);
  assert.ok(reading.includes(`~/.claude/${REFERENCE}`),
    `the verifier must be handed ${REFERENCE}; got ${JSON.stringify(reading)}`);
});

test('the handed reference carries both rules under the verifier step names it applies at', () => {
  const headings = fs.readFileSync(path.join(REPO_ROOT, REFERENCE), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3));
  assert.deepStrictEqual(headings, [
    'Step 2a-bis — SPEC Acceptance Criteria as `spec_truths`',
    'Step 9 — `truths_unproven`',
  ]);
});

test('the verifier agent mandates reading every <required_reading> file of its prompt', () => {
  // The pointer only works because the agent includes mandatory-initial-read.md,
  // which obliges it to Read every file listed in the prompt's <required_reading>.
  const agent = fs.readFileSync(path.join(REPO_ROOT, 'agents', 'gsd-verifier.md'), 'utf8');
  const includes = agent.split(/\r?\n/).filter((line) => line.startsWith('@~/.claude/gsd-core/references/'));
  assert.ok(includes.includes('@~/.claude/gsd-core/references/mandatory-initial-read.md'));
});
