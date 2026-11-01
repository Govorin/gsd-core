/**
 * `gsd_run check mn-tool-preflight <phase> [--wave N] [--gaps-only]` — mn-verify-gate's execute:pre
 * gate (LG-01): does every plan the run will execute have an executor whose installed agent grants
 * the tools the plan declares?
 *
 * The orchestrator met a plan its executor could not carry out (a `.pen` design file, an MCP tool
 * not in `tools:`) by spawning `general-purpose` in place of `gsd-executor`; the only thing against
 * it was a sentence in `execute-phase.md`. This gate turns the missing grant into a halt before the
 * first wave, with the exact fix in the message (`agent_tools` + reinstall). It reads
 * `src/tool-preflight.cts`; it decides nothing about the installed agent itself.
 *
 *   - any plan the run will execute (unsummarized, inside `--wave`/`--gaps-only`) with status
 *     `missing` — a DECLARED need (`requires_tools`, a `.pen` in `files_modified`) → finding (blocks);
 *     tools only mentioned in prose never block;
 *   - `unknown` (the agent's grants could not be read) → pass with the reason in the message: the
 *     gate cannot prove a grant is absent, and `verify plan-structure` / `config-advise` already
 *     report the unknown;
 *   - plans with a SUMMARY are done and are not checked.
 */

import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { preflightIncompletePlans, PREFLIGHT_STATUS } from './tool-preflight.cjs';
import type { PlanSelection } from './tool-preflight.cjs';

// This gate's verdicts, built here so its failing arms are visible in its own file to the
// positive-control lint (#5204); gate-mn-support owns the payload shape.
function mnPass(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('pass', false, mnPayload(MN_GATE_STATUS.PASS, message, details));
}
function mnFinding(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, mnPayload(MN_GATE_STATUS.FINDING, message, details));
}
/** Could not look: outcome `unreadable` (exit 69, routed by the gate's `onError`), blocking. */
function mnUnreadable(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateUnreadable(true, mnPayload(MN_GATE_STATUS.UNRESOLVABLE, message, details));
}

/**
 * `--wave N` and `--gaps-only` are the run's own selection flags, passed by the execute:pre gate
 * dispatch (`execute-phase/steps/execute-pre-gate-hooks.md`) so a plan the run will not execute
 * cannot halt it. Both are removed before the phase is parsed.
 */
export function parseSelectionArgs(args: readonly string[]): { rest: string[]; selection: PlanSelection } {
  const rest: string[] = [];
  const selection: PlanSelection = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--gaps-only') selection.gapsOnly = true;
    else if (arg === '--wave' && args[i + 1] !== undefined && !args[i + 1].startsWith('-')) {
      selection.wave = args[i + 1];
      i++;
    } else if (arg.startsWith('--wave=')) selection.wave = arg.slice('--wave='.length);
    else rest.push(arg);
  }
  return { rest, selection };
}

export function evaluateMnToolPreflight(input: MnGateInput): GateResult {
  const { rest, selection } = parseSelectionArgs(input.args);
  return withMnPhase('mn-tool-preflight', { projectDir: input.projectDir, args: rest }, ({ phaseDir }) => {
    const scanned = preflightIncompletePlans(input.projectDir, phaseDir, selection);
    if ('unreadable' in scanned) return mnUnreadable(`mn-tool-preflight: ${scanned.unreadable}`, { phaseDir });

    const missing = scanned.results.filter((r) => r.status === PREFLIGHT_STATUS.MISSING);
    const unknown = scanned.results.filter((r) => r.status === PREFLIGHT_STATUS.UNKNOWN);
    const details = { phaseDir, selection, checked: scanned.results.length, plans: scanned.results };
    if (missing.length > 0) {
      return mnFinding(
        `mn-tool-preflight: ${missing.length} plan(s) declare tools their executor does not grant — ` +
          missing.map((r) => r.message).join(' | '),
        details,
      );
    }
    const unknownNote = unknown.length > 0
      ? `; ${unknown.length} could not be checked (${unknown.map((r) => `${r.plan}: ${r.reason}`).join('; ')})`
      : '';
    return mnPass(`mn-tool-preflight: OK — ${scanned.results.length} plan(s) to run checked${unknownNote}`, details);
  });
}
