/**
 * mn gate support — what every `gsd_run check mn-*` gate module shares: which phase it evaluates,
 * and the three verdicts it can return (.plans/mn-verify-gate-to-cli.md §3.1, decisions 2 and 3).
 *
 * ── Which phase ──────────────────────────────────────────────────────────
 *
 * The loop dispatchers hand a gate its phase in three shapes, and a gate must accept every one of
 * them, because a parsing mistake here turns EVERY mn gate into "could not check" — and a blocking
 * gate that cannot check halts the run:
 *
 *   --phase <N>          the shared dispatcher's form (`gsd_run <cmd> --phase N`, loop-hook-dispatch.md)
 *   --phase-dir <dir>    explicit directory, contained in the project (ADR-4650)
 *   <positional>         `"${PHASE_DIR}"` (ship.md, verify-work.md, plan-phase.md — plan-phase adds
 *                        `"${PHASE_REQ_IDS}"` after it) or `"${PHASE_NUMBER}"` (execute-phase
 *                        wave-post, verify-phase-goal). A value carrying a path separator is a
 *                        directory; anything else is a phase token resolved like `find-phase`.
 *
 * Extra positionals are ignored. Precedence: `--phase-dir`, then `--phase`, then the first
 * positional.
 *
 * ── Three verdicts ───────────────────────────────────────────────────────
 *
 *   pass          `block: false`, `status: 'pass'`
 *   finding       `block: true`,  `status: 'finding'` — the gate looked and found a defect
 *   unresolvable  `block: true`,  `status: 'unresolvable'` — the gate could not judge. The fail-closed
 *                 half of the old scripts' exit 2: "did not check" never reads as "checked and clean".
 *                 Two outcomes, drawn where upstream's gate-evidence draws them (#5170, ADR-5057 §4):
 *                 - a state the user fixes — no record yet, a stale one, nothing configured, a base
 *                   not measured — is a DELIVERED blocking verdict (outcome `block`, exit 0), so the
 *                   dispatch reaches step 2 and shows the message and its accept path;
 *                 - a read that failed (EACCES, EIO), a tool that would not run, a phase that cannot
 *                   be found, a crashed body — outcome `unreadable`: the verb exits 69 (UNAVAILABLE)
 *                   with this payload, routed by the gate's `onError` (`halt` for every mn gate).
 *
 * Each gate module builds its own three verdicts with `gateVerdict` / `gateUnreadable` over
 * `mnPayload`, so its failing arms are visible in its own file to the positive-control lint (#5204);
 * this module owns only the payload shape.
 *
 * A wrong invocation (no phase argument at all, a path escaping the project) is neither: it is a
 * `GateUsageFailure`, which the router turns into `error()` and the gate's `onError` routes.
 *
 * Every payload carries `block` and `message` — the gate-dispatch contract the workflows read.
 */

import path from 'node:path';
import { gateUnreadable, gateUsageFailure, isGateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult, GateUsageFailure, GateVerdict } from './gate-verdict.cjs';
import { partitionPredicateArgs } from './gate-args.cjs';
import { statEvidence } from './gate-evidence.cjs';
import { resolveContainedPath, resolvePhaseDir } from './gate-phase-context.cjs';

/** The `status` an mn gate payload carries — names the verdict, separately from `block`. */
export const MN_GATE_STATUS = Object.freeze({
  PASS: 'pass',
  FINDING: 'finding',
  UNRESOLVABLE: 'unresolvable',
} as const);
export type MnGateStatus = (typeof MN_GATE_STATUS)[keyof typeof MN_GATE_STATUS];

/** The input every mn gate module receives from the router: the argv AFTER the verb. */
export interface MnGateInput {
  projectDir: string;
  args: readonly string[];
}

/** A phase the gate can evaluate: its directory (absolute, existing) and the argument that named it. */
export interface MnPhase {
  phaseDir: string;
  phaseArg: string;
}

/** The gate was invoked correctly but the phase cannot be found — "could not check". */
export interface MnPhaseUnresolved {
  unresolved: string;
}

/** The payload of an mn verdict: `block` follows the status, and `message` is always present. */
export function mnPayload(status: MnGateStatus, message: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { block: status !== MN_GATE_STATUS.PASS, status, message, ...details };
}

/** The gate could not look — this module's own arm (an unresolved phase, a crashed body). */
function mnUnreadable(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateUnreadable(true, mnPayload(MN_GATE_STATUS.UNRESOLVABLE, message, details));
}

/**
 * Whether a candidate phase directory is one: a directory, absent (or not a directory), or a path
 * that could not be examined (EACCES on a parent) — the last is never collapsed into "not found".
 */
function directoryState(candidate: string): 'directory' | 'absent' | { unreadable: string } {
  const stat = statEvidence(candidate);
  if (stat.kind === 'unreadable') return { unreadable: stat.reason };
  return stat.kind === 'found' && stat.value.isDirectory() ? 'directory' : 'absent';
}

/** The `unresolved` reason for a candidate that is not an examinable directory, or null when it is one. */
function notADirectory(candidate: string, what: string): string | null {
  const state = directoryState(candidate);
  if (state === 'directory') return null;
  if (state === 'absent') return `${what} not found`;
  return `${what} could not be examined: ${state.unreadable}`;
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.isAbsolute(value);
}

function fromDirectory(projectDir: string, dirArg: string): MnPhase | GateUsageFailure | MnPhaseUnresolved {
  const contained = resolveContainedPath(dirArg, projectDir);
  if (isGateUsageFailure(contained)) return contained;
  const problem = notADirectory(contained, 'phase directory');
  if (problem !== null) return { unresolved: `${problem}: ${dirArg}` };
  return { phaseDir: contained, phaseArg: dirArg };
}

function fromToken(projectDir: string, token: string): MnPhase | MnPhaseUnresolved {
  const located = resolvePhaseDir(projectDir, token);
  // A lookup that could not look is "could not check", never "no such phase" (#5170, ADR-5057 §4).
  if (located.kind === 'unreadable') {
    return { unresolved: `could not read the phase directory for phase ${token}: ${located.reason}` };
  }
  if (located.kind === 'none') return { unresolved: `phase not found: ${token}` };
  const problem = notADirectory(located.value, 'phase');
  if (problem !== null) return { unresolved: `${problem}: ${token}` };
  return { phaseDir: located.value, phaseArg: token };
}

/**
 * Resolve the phase an mn gate evaluates from its argv (the forms are in the module header).
 * Returns the phase, a usage failure (nothing names a phase; a path escapes the project), or the
 * reason the named phase could not be found.
 */
export function resolveMnPhase(
  projectDir: string,
  args: readonly string[],
): MnPhase | GateUsageFailure | MnPhaseUnresolved {
  const { flags, positionals } = partitionPredicateArgs(args);
  const phaseDirFlag = flags['phase-dir'];
  if (typeof phaseDirFlag === 'string' && phaseDirFlag !== '') return fromDirectory(projectDir, phaseDirFlag);
  const phaseFlag = flags['phase'];
  if (typeof phaseFlag === 'string' && phaseFlag !== '') return fromToken(projectDir, phaseFlag);
  const first = positionals.find((p) => p !== '' && !p.startsWith('--'));
  if (first === undefined) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'an mn gate requires a phase: --phase <N>, --phase-dir <dir>, or a positional phase number or directory',
    );
  }
  return looksLikePath(first) ? fromDirectory(projectDir, first) : fromToken(projectDir, first);
}

/**
 * The phase as a gate's remedy line should hand it to a recorder: `--phase <N>` for a phase token,
 * the quoted directory for a path (ship.md and verify-work.md dispatch with `"${PHASE_DIR}"`, and
 * `--phase /abs/dir` would not resolve).
 */
export function mnPhaseCliArg(phaseArg: string): string {
  return looksLikePath(phaseArg) ? JSON.stringify(phaseArg) : `--phase ${phaseArg}`;
}

/**
 * Run an mn gate body against its resolved phase. Owns the two ways a gate ends without an answer:
 * a usage failure passes through, and an unresolved phase or a body that THROWS becomes an
 * `unresolvable` verdict — never a pass, never a finding (a crash is "could not check").
 */
export function withMnPhase(
  verb: string,
  input: MnGateInput,
  body: (phase: MnPhase) => GateResult,
): GateResult {
  const phase = resolveMnPhase(input.projectDir, input.args);
  if (isGateUsageFailure(phase)) return phase;
  // `phaseResolved: false` names this cause in the payload: a reader (and the per-verb argument
  // matrix test) can tell "no such phase" from "the phase was found but could not be checked".
  if ('unresolved' in phase) return mnUnreadable(`${verb}: ${phase.unresolved}`, { phaseResolved: false });
  try {
    return body(phase);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return mnUnreadable(`${verb}: could not check — ${reason}`, { phaseDir: phase.phaseDir });
  }
}

/** Run an mn gate body that needs no phase (the project is its scope), with the same crash rule. */
export function withMnProject(verb: string, body: () => GateResult): GateResult {
  try {
    return body();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return mnUnreadable(`${verb}: could not check — ${reason}`);
  }
}
