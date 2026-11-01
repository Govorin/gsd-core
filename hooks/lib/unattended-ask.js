'use strict';

// mn fork — what an `ask` guard answers when nobody is there to be asked.
//
// gsd-prohibition-guard.js and gsd-test-tamper-guard.js take a mode: "ask"
// escalates a write to the user, "deny" blocks it. In an autonomous chain an
// `ask` has no one to answer it: a recorded project's background agents sat on
// 61 such prompts for more than two minutes each, 3285 minutes in total, the
// longest 529. The write is no more acceptable for having waited, so while
// an auto-chain runs an `ask` is answered `deny` instead — immediately, with a
// reason that tells the agent to adapt rather than retry.
//
// "Active" is the run-scoped auto-chain flag only — `auto_chain_active` in
// what `gsd_run check auto-mode` reports (src/check-auto-mode.cts
// readAutoModeState), read through that module so a change to where the flag
// lives reaches the guards with it. `workflow.auto_advance` alone does NOT
// count: it is a standing preference, and the person who set it may be at the
// terminal. If the module cannot be loaded the answer stays `ask` — the
// behaviour before this file existed.

const AUTO_RUN_NOTE =
  ' Answered deny instead of ask: this guard is set to "ask", but an auto-chain is running ' +
  '(gsd_run check auto-mode), so nobody is there to approve the write and it would wait for hours. ' +
  'Do not retry it in another form. Finish what you can inside the rule, and report this write as a ' +
  'blocker in your summary for the user to decide.';

function loadAutoModeReader() {
  const { ensureRuntimeBuild } = require('../../gsd-core/bin/ensure-runtime-build.cjs');
  ensureRuntimeBuild();
  return require('../../gsd-core/bin/lib/check-auto-mode.cjs').readAutoModeState;
}

/**
 * Is an auto-chain running for the project at `planningRoot`? False when the
 * state cannot be read. `loadReader` is injectable for tests.
 */
function autoRunActive(planningRoot, loadReader = loadAutoModeReader) {
  try {
    return loadReader()(planningRoot).auto_chain_active === true;
  } catch {
    return false;
  }
}

/**
 * The action for a write the guard objects to, given its mode ("ask" | "deny").
 * Returns `{ action, reason, unattended }`; `unattended` is true only when an
 * `ask` was answered `deny` because an auto-chain is running. `isAutoRun` is
 * injectable for tests.
 */
function askOrDeny(mode, planningRoot, reason, isAutoRun = autoRunActive) {
  if (mode === 'deny') return { action: 'deny', reason, unattended: false };
  if (isAutoRun(planningRoot)) return { action: 'deny', reason: reason + AUTO_RUN_NOTE, unattended: true };
  return { action: 'ask', reason, unattended: false };
}

module.exports = { askOrDeny, autoRunActive };
