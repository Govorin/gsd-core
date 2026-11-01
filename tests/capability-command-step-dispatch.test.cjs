'use strict';

/**
 * A capability step whose target is a command has to be run by someone.
 *
 * `loop render-hooks` does not execute steps — it prints them. The workflow that
 * owns the loop point runs them, and since #3866 it does so by deferring to the
 * shared dispatcher (`references/loop-hook-dispatch.md` § `step`): validate
 * `ref.command` against a closed pattern, then run
 * `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw`. Three ways a declared
 * command step is silently never run, each fenced below:
 *
 *   1. The owning point does not defer to the dispatcher and does not call the
 *      command by hand (mn-verify-gate's verify:pre step had no caller at all
 *      before the dispatcher existed; its own test called the command directly
 *      and so could not see that).
 *   2. `ref.command` fails the dispatcher's pattern — the dispatcher then records
 *      a warning and skips the hook (`gsd_run verify gates "${PHASE_DIR}" --raw`
 *      fails on `_`, `"`, `$`, `--`).
 *   3. The command does not understand the dispatcher's call shape — it gets a
 *      phase NUMBER through `--phase`, never a directory. A command that takes a
 *      positional directory refuses, and an `onError: skip` step swallows that.
 *
 * The workflow and reference text is the contract the runtime loads, so asserting
 * on it is the `source-text-is-the-product` case (CONTRIBUTING.md). No
 * allow-test-rule marker: nothing here reads a code file, so `no-source-grep`
 * has no violation for one to suppress, and an idle marker only inflates the
 * unverified-marker pool `lint-allow-test-rule-refs` ratchets. The list of steps
 * comes from the typed registry, and
 * the pattern and call shape are read out of the dispatcher reference rather than
 * restated here, so the fence moves with the dispatcher.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readWorkflowCombined, createTempDir, cleanup } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

const ROOT = path.join(__dirname, '..');
const WORKFLOWS = path.join(ROOT, 'gsd-core', 'workflows');
const DISPATCH_REF = path.join(ROOT, 'gsd-core', 'references', 'loop-hook-dispatch.md');
const TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');

// The workflow that owns each loop point. A new point has to be added here, which
// is the point: an unmapped point fails below rather than passing unexamined.
const POINT_WORKFLOW = {
  'roadmap:pre': 'new-milestone.md',
  'roadmap:post': 'new-milestone.md',
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
  'milestone:pre': 'complete-milestone.md',
  'milestone:post': 'complete-milestone.md',
};

// ─── The dispatcher contract, read from the reference ────────────────────────

/** The `### \`step\`` section of the dispatcher reference, or '' when absent. */
function stepSection(text) {
  const start = text.indexOf('### `step`');
  if (start === -1) return '';
  const next = text.indexOf('\n### ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

const DISPATCH_STEP = stepSection(fs.readFileSync(DISPATCH_REF, 'utf8'));

/** The closed pattern a `ref.command` must match before the dispatcher runs it. */
const COMMAND_PATTERN = (() => {
  const m = /`(\^\[a-z\][^`]*\$)`/.exec(DISPATCH_STEP);
  // allow-adhoc-regex-escape: the value IS a pattern (the dispatcher's own), compiled as written, not a literal
  return m ? new RegExp(m[1]) : null;
})();

/** The dispatcher's invocation line, e.g. `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw`. */
const INVOCATION = (() => {
  const m = /^\s*(gsd_run \$\{ref\.command\}[^\n]*)$/m.exec(DISPATCH_STEP);
  return m ? m[1].trim() : null;
})();

// ─── Locating the dispatch for one point inside its workflow ─────────────────

/**
 * The text that handles `point`: from each `render-hooks <point>` call up to the
 * next `render-hooks` call for a DIFFERENT point (or the end). A workflow serves
 * several points; a directive belonging to another point's block must not count
 * as this point's caller.
 */
function pointSpans(text, point) {
  const calls = [...text.matchAll(/render-hooks ([a-z]+(?::[a-z]+)+)/g)].map((m) => ({
    point: m[1],
    index: m.index,
  }));
  const spans = [];
  calls.forEach((call, i) => {
    if (call.point !== point) return;
    const next = calls.slice(i + 1).find((c) => c.point !== point);
    spans.push(text.slice(call.index, next ? next.index : text.length));
  });
  return spans;
}

/** A directive deferring `kind == "step"` hooks to the shared dispatcher. */
const DEFERRAL = /`kind == "step"`[^\n]*loop-hook-dispatch\.md/;
const GATE_DISPATCH = /`kind == "gate"`/;

/** Where, in `span`, the step is run: a hand call naming it, or the deferral. -1 when neither. */
function callerIndex(span, command) {
  const named = span.indexOf(command);
  const deferred = DEFERRAL.exec(span);
  const candidates = [named, deferred ? deferred.index : -1].filter((i) => i !== -1);
  return candidates.length ? Math.min(...candidates) : -1;
}

const commandSteps = [];
for (const [point, hooks] of Object.entries(registry.byLoopPoint)) {
  for (const step of hooks.steps || []) {
    if (step.ref && step.ref.command) commandSteps.push({ point, capId: step.capId, command: step.ref.command });
  }
}

describe('the shared step dispatcher runs command refs', () => {
  test('the reference states the pattern a command must match', () => {
    assert.ok(COMMAND_PATTERN, 'loop-hook-dispatch.md § step no longer states the ref.command pattern');
  });

  test('the reference states how a command step is invoked', () => {
    assert.ok(INVOCATION, 'loop-hook-dispatch.md § step no longer states the gsd_run ${ref.command} invocation');
    assert.match(INVOCATION, /--phase "\$\{PHASE_NUMBER\}"/, 'the invocation hands the step a phase number');
  });

  // A command step may run for minutes by design (`verify mutation`: one suite run per mutant in
  // a nine-minute budget). Left at the Bash default of two minutes, the call is killed mid-run.
  test('the reference makes the command-step call with the ten-minute Bash timeout', () => {
    assert.match(DISPATCH_STEP, /`timeout: 600000`/, 'loop-hook-dispatch.md § step must ask for timeout: 600000 explicitly');
  });
});

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
    test(`${capId} @ ${point}: \`${command}\` passes the dispatcher's pattern`, () => {
      assert.ok(COMMAND_PATTERN, 'no pattern to check against');
      assert.match(
        command,
        COMMAND_PATTERN,
        `${capId}'s ${point} step "${command}" fails the dispatcher's ref.command pattern — ` +
          'the dispatcher would warn and skip it. Declare the bare subcommand (e.g. "verify gates"); ' +
          'the dispatcher prepends gsd_run and appends --phase/--raw itself',
      );
    });

    test(`${capId} @ ${point}: \`${command}\` is run by ${POINT_WORKFLOW[point]}`, () => {
      const text = readWorkflowCombined(path.join(WORKFLOWS, POINT_WORKFLOW[point]));
      const spans = pointSpans(text, point);
      assert.ok(spans.length > 0, `${POINT_WORKFLOW[point]} never renders ${point} hooks`);
      assert.ok(
        spans.some((span) => callerIndex(span, command) !== -1),
        `${capId} registers a ${point} step "${command}", but the ${point} block of ${POINT_WORKFLOW[point]} ` +
          'neither calls it nor defers `kind == "step"` to loop-hook-dispatch.md — the step would be declared and never run',
      );
    });

    test(`${capId} @ ${point}: a dispatcher-run step runs before the point's gates`, () => {
      // A gate may read what the step records (mn-verify-gate's gates: block), so
      // a step dispatched after the gates is read by nothing on this run. Only the
      // generic deferral is held to this order — the dispatcher contract is
      // contribution → step → gate; a hand call placed elsewhere is that
      // workflow's own sequencing (intel's plan:pre call follows the plan:pre gates).
      const text = readWorkflowCombined(path.join(WORKFLOWS, POINT_WORKFLOW[point]));
      for (const span of pointSpans(text, point)) {
        const deferred = DEFERRAL.exec(span);
        const gate = GATE_DISPATCH.exec(span);
        if (!deferred || !gate || span.includes(command)) continue;
        assert.ok(
          deferred.index < gate.index,
          `in ${POINT_WORKFLOW[point]}, the ${point} step dispatch comes after its gate dispatch`,
        );
      }
    });
  }
});

describe('mn-verify-gate: the verify:pre step, run the way the dispatcher runs it', () => {
  let dir;
  let home;
  let phaseDir;
  const env = () => ({ ...process.env, HOME: home, USERPROFILE: home, GSD_HOME: home });

  beforeEach(() => {
    dir = createTempDir('gsd-step-dispatch-');
    home = createTempDir('gsd-step-dispatch-home-');
    phaseDir = path.join(dir, '.planning', 'phases', '03-ports');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({
        workflow: {
          verify_gates_record: true,
          verify_gates: { tests: 'echo "# pass 12" && echo "# fail 0"' },
        },
      }),
    );
  });
  afterEach(() => {
    cleanup(dir);
    cleanup(home);
  });

  test('render-hooks lists the step before the gates, and the dispatched call records gates:', () => {
    const rendered = runNode([TOOLS, 'loop', 'render-hooks', 'verify:pre', '--raw', '--cwd', dir], {
      cwd: dir,
      env: env(),
    });
    assert.equal(rendered.outcome, OUTCOME.EXITED, rendered.stderr);
    assert.equal(rendered.exitCode, 0, rendered.stderr);
    const active = JSON.parse(rendered.stdout).activeHooks || [];
    const stepIndex = active.findIndex((h) => h.kind === 'step' && h.capId === 'mn-verify-gate');
    assert.ok(stepIndex !== -1, `mn-verify-gate's step is not active: ${JSON.stringify(active)}`);
    const firstGate = active.findIndex((h) => h.kind === 'gate');
    if (firstGate !== -1) assert.ok(stepIndex < firstGate, 'the step must be listed before the gates');

    // Validate and invoke exactly as loop-hook-dispatch.md § step says.
    const command = active[stepIndex].ref.command;
    assert.match(command, COMMAND_PATTERN);
    const argv = [];
    for (const token of INVOCATION.split(/\s+/)) {
      if (token === 'gsd_run') argv.push(TOOLS);
      else if (token === '${ref.command}') argv.push(...command.split(' '));
      else if (token === '"${PHASE_NUMBER}"') argv.push('3');
      else if (token.startsWith('--')) argv.push(token);
      else assert.fail(`unrecognised token in the dispatcher invocation: ${token} — update this emulation`);
    }
    const run = runNode([...argv, '--cwd', dir], { cwd: dir, env: env() });
    assert.equal(run.outcome, OUTCOME.EXITED, run.stderr);
    assert.equal(run.exitCode, 0, `dispatched call refused: ${run.stdout} ${run.stderr}`);

    const vpath = path.join(phaseDir, '03-VERIFICATION.md');
    assert.ok(fs.existsSync(vpath), 'the dispatched call wrote no VERIFICATION.md');
    const fm = extractFrontmatter(fs.readFileSync(vpath, 'utf8'));
    assert.ok(fm.gates && typeof fm.gates === 'object', 'no gates: block recorded');
    assert.equal(String(fm.gates.all_passed), 'true');
    assert.equal(String(fm.gates.failed), '0');
  });
});
