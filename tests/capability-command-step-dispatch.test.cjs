// allow-test-rule: source-text-is-the-product
'use strict';

/**
 * A capability step whose target is a command has to be run by someone.
 *
 * `loop render-hooks` does not execute steps — it prints them. A step with
 * `ref.skill` or `ref.agent` is picked up by the generic dispatch contract in
 * the workflow; a step with `ref.command` is not dispatched by anything unless
 * the workflow says so. The shipped examples show both shapes: `intel`'s
 * plan:pre step works because plan-phase.md calls `gsd_run intel api-surface`
 * by hand, while mn-verify-gate's verify:pre step (`gsd_run verify gates`) had
 * no caller at all, so `workflow.verify_gates_record` could be switched on and
 * nothing would ever record. Its own test called the command directly and so
 * could not see that.
 *
 * This is the fence for the whole class, not that one step. For every command
 * step the registry declares, the workflow that owns its loop point must either
 * name the command or carry the generic `ref.command` dispatch. The workflow
 * text is the contract the runtime loads, hence the source-text exception; the
 * list of steps comes from the typed registry, not from a search.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readWorkflowCombined } = require('./helpers.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');

// The workflow that owns each loop point. A new point has to be added here, which
// is the point: an unmapped point fails below rather than passing unexamined.
const POINT_WORKFLOW = {
  'discuss:pre': 'discuss-phase.md',
  'discuss:post': 'discuss-phase.md',
  'plan:pre': 'plan-phase.md',
  'plan:post': 'plan-phase.md',
  'execute:pre': 'execute-phase.md',
  'execute:wave:pre': 'execute-phase.md',
  'execute:wave:post': 'execute-phase.md',
  'execute:post': 'execute-phase.md',
  'verify:pre': 'verify-work.md',
  'verify:post': 'verify-work.md',
  'ship:pre': 'ship.md',
  'ship:post': 'ship.md',
};

/** `gsd_run verify gates "${PHASE_DIR}" --raw` → `verify gates`; `intel api-surface` → same. */
function commandHead(command) {
  return command
    .replace(/^gsd_run\s+/, '')
    .split(/\s+/)
    .filter((t) => !t.startsWith('-') && !t.startsWith('"') && !t.startsWith('$'))
    .slice(0, 2)
    .join(' ');
}

const commandSteps = [];
for (const [point, hooks] of Object.entries(registry.byLoopPoint)) {
  for (const step of hooks.steps || []) {
    if (step.ref && step.ref.command) commandSteps.push({ point, capId: step.capId, command: step.ref.command });
  }
}

describe('command-ref capability steps have a caller', () => {
  test('there are command steps to check (the fence is not vacuous)', () => {
    assert.ok(
      commandSteps.length >= 2,
      `expected the registry to declare command steps, got ${JSON.stringify(commandSteps)}`,
    );
  });

  test('every loop point maps to a workflow', () => {
    for (const { point, capId } of commandSteps) {
      assert.ok(POINT_WORKFLOW[point], `${capId} declares a step at ${point}, which has no owning workflow in this test`);
    }
  });

  for (const { point, capId, command } of commandSteps) {
    test(`${capId} @ ${point}: \`${commandHead(command)}\` is run by ${POINT_WORKFLOW[point]}`, () => {
      const text = readWorkflowCombined(path.join(WORKFLOWS, POINT_WORKFLOW[point]));
      const head = commandHead(command);
      assert.ok(head.length > 0, `could not derive a command head from ${command}`);
      const named = text.includes(head);
      const generic = text.includes('`ref.command`');
      assert.ok(
        named || generic,
        `${capId} registers a ${point} step "${command}", but ${POINT_WORKFLOW[point]} neither calls ` +
          `\`${head}\` nor dispatches \`ref.command\` — the step would be declared and never run`,
      );
    });
  }
});
