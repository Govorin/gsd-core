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
 *   unresolvable  `block: true`,  `status: 'unresolvable'` — the gate could not look (no phase, an
 *                 unreadable file, a tool that would not run). The fail-closed half of the old
 *                 scripts' exit 2: "did not check" never reads as "checked and clean". It stays
 *                 distinguishable in the payload, and the exit code stays 0 (ADR-3889: 2 belongs to
 *                 the hook protocol; ADR-5057 §4: the exit code is a function of the verdict).
 *
 * A wrong invocation (no phase argument at all, a path escaping the project) is neither: it is a
 * `GateUsageFailure`, which the router turns into `error()` and the gate's `onError` routes.
 *
 * Every payload carries `block` and `message` — the gate-dispatch contract the workflows read.
 */

import fs from 'node:fs';
import path from 'node:path';
import { gateVerdict, gateUsageFailure, isGateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult, GateUsageFailure, GateVerdict } from './gate-verdict.cjs';
import { partitionPredicateArgs } from './gate-args.cjs';
import { resolveContainedPath, resolvePhaseDir } from './gate-phase-context.cjs';

/** The `status` an mn gate payload carries — names the verdict, separately from `block`. */
export const MN_GATE_STATUS = Object.freeze({
  PASS: 'pass',
  FINDING: 'finding',
  UNRESOLVABLE: 'unresolvable',
} as const);

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

/** The checked half of the verdict: the gate looked and the phase is clean. */
export function mnPass(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('pass', false, { block: false, status: MN_GATE_STATUS.PASS, message, ...details });
}

/** The gate looked and found a defect. */
export function mnFinding(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, { block: true, status: MN_GATE_STATUS.FINDING, message, ...details });
}

/** The gate could not look. Blocks (fail-closed), and says so in `status` and `message`. */
export function mnUnresolvable(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, { block: true, status: MN_GATE_STATUS.UNRESOLVABLE, message, ...details });
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || path.isAbsolute(value);
}

function fromDirectory(projectDir: string, dirArg: string): MnPhase | GateUsageFailure | MnPhaseUnresolved {
  const contained = resolveContainedPath(dirArg, projectDir);
  if (isGateUsageFailure(contained)) return contained;
  if (!isDirectory(contained)) return { unresolved: `phase directory not found: ${dirArg}` };
  return { phaseDir: contained, phaseArg: dirArg };
}

function fromToken(projectDir: string, token: string): MnPhase | MnPhaseUnresolved {
  const located = resolvePhaseDir(projectDir, token);
  // A lookup that could not look is "could not check", never "no such phase" (#5170, ADR-5057 §4).
  if (located.kind === 'unreadable') {
    return { unresolved: `could not read the phase directory for phase ${token}: ${located.reason}` };
  }
  if (located.kind === 'none' || !isDirectory(located.value)) return { unresolved: `phase not found: ${token}` };
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
  if ('unresolved' in phase) return mnUnresolvable(`${verb}: ${phase.unresolved}`, { phaseResolved: false });
  try {
    return body(phase);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return mnUnresolvable(`${verb}: could not check — ${reason}`, { phaseDir: phase.phaseDir });
  }
}

/** Run an mn gate body that needs no phase (the project is its scope), with the same crash rule. */
export function withMnProject(verb: string, body: () => GateResult): GateResult {
  try {
    return body();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return mnUnresolvable(`${verb}: could not check — ${reason}`);
  }
}
