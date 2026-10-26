/**
 * `gsd_run check mn-wave-solve <phase> [--expand]` — the declared waves judged against the computed
 * assignment. The analysis (`analyzeWaveSolve`) and the rule it checks are in `gate-mn-waves.cts`.
 */

import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { MAX_LISTED, MAX_SHARED_LISTED, analyzeWaveSolve, readMode } from './gate-mn-waves.cjs';

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
 * Could not judge yet, for a reason the user fixes (no record, a stale one, nothing configured or
 * measured): a DELIVERED blocking verdict — exit 0, so the gate dispatch shows its message and its
 * accept path (step 2). `mnUnreadable` (exit 69) is for a read that failed, never for an absence.
 */
function mnUnresolvedBlock(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, mnPayload(MN_GATE_STATUS.UNRESOLVABLE, message, details));
}

/** `gsd_run check mn-wave-solve <phase> [--expand]` */
export function evaluateMnWaveSolve(input: MnGateInput): GateResult {
  const mode = readMode(input.projectDir, input.args);
  const args = input.args.filter((a) => a !== '--expand');
  return withMnPhase('mn-wave-solve', { projectDir: input.projectDir, args }, ({ phaseDir }) => {
    const analysis = analyzeWaveSolve(input.projectDir, phaseDir, mode);
    if ('unreadable' in analysis) return mnUnreadable(`mn-wave-solve: ${analysis.unreadable}`, { phaseDir, mode });
    if ('cycle' in analysis) {
      return mnUnresolvedBlock(
        `mn-wave-solve: dependency cycle among ${analysis.cycle.join(', ')} — a cyclic graph has no wave assignment, and inventing one would be worse than none`,
        { phaseDir, mode, cycle: analysis.cycle },
      );
    }
    const details = {
      phaseDir,
      mode,
      base: analysis.base,
      waves: analysis.waves,
      matched: analysis.matched,
      undeclared: analysis.undeclared,
      counts: { plans: analysis.plans.length, violations: analysis.violations.length, conservative: analysis.conservative.length },
      plans: analysis.plans.slice(0, MAX_LISTED),
      violations: analysis.violations.slice(0, MAX_LISTED).map((v) =>
        v.kind === 'shares-file-in-wave' ? { ...v, shared: v.shared.slice(0, MAX_SHARED_LISTED), sharedCount: v.shared.length } : v,
      ),
      conservative: analysis.conservative.slice(0, MAX_LISTED),
      unresolvedDependencies: analysis.unresolvedDependencies.slice(0, MAX_LISTED),
    };
    if (analysis.violations.length === 0) {
      return mnPass(
        analysis.plans.length === 0
          ? 'mn-wave-solve: no plans here — nothing to solve'
          : `mn-wave-solve: OK — ${analysis.matched} plan(s) match the computed assignment` +
              (analysis.conservative.length > 0 ? `, ${analysis.conservative.length} scheduled later than necessary (safe, only slower)` : '') +
              (analysis.undeclared > 0 ? `, ${analysis.undeclared} declare no wave` : '') +
              `, ${analysis.waves} wave(s) computed`,
        details,
      );
    }
    return mnFinding(
      `mn-wave-solve: ${analysis.violations.length} declared wave(s) break the invariant (` +
        analysis.violations.slice(0, 5).map((v) => (v.kind === 'before-dependency' ? `${v.plan} runs no later than its dependency ${v.dependency}` : `${v.plan} shares wave ${v.wave} and a file with ${v.with}`)).join('; ') +
        ') — a plan scheduled before its dependency runs against work that does not exist yet; one sharing a wave with a plan ' +
        'touching the same file races it in a separate worktree. Renumber the waves (see plans[].computed), or fix depends_on.',
      details,
    );
  });
}
