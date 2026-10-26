/**
 * `gsd_run check mn-assertion-ratchet` — the assertion ratchet as a READ-ONLY gate
 * (mn-verify-gate, verify:pre; replaces the gate half of scripts/assertion-ratchet.mjs).
 *
 * Counts the repository's assertions and skip markers with the counter `mn assertion-baseline`
 * records through (src/mn-assertion-count.cts) and compares them with the recorded baseline:
 *
 *   assertions dropped, or skips grew   → FINDING: a check was removed or silenced without a record.
 *   neither                             → pass (growth is always fine — the ratchet is one-way).
 *   no baseline / unreadable baseline    → UNRESOLVABLE: nothing to compare against.
 *   zero spec files found               → UNRESOLVABLE: almost always a missed walk, not a project
 *                                         without tests.
 *
 * The gate never writes. The script created the baseline on its first run; a gate that writes
 * the floor it is about to judge against can be satisfied by deleting the file. Recording a
 * baseline — first time, or after a declared drop — is `gsd_run mn assertion-baseline`.
 *
 * Project-scoped: the dispatcher appends the phase, and the gate ignores it — the ratchet counts
 * the whole repository.
 */

import path from 'node:path';
import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnProject } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { countAssertions, readAssertionBaseline, DEFAULT_ROOTS } from './mn-assertion-count.cjs';
import { projectRoots } from './project-root.cjs';
import type { GitRunner } from './project-root.cjs';
import type { AssertionCounts } from './mn-assertion-count.cjs';

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

/** How a baseline is recorded — named in every verdict that needs one. */
export const ASSERTION_BASELINE_COMMAND = 'gsd_run mn assertion-baseline';

/** Injected effects: the git runner `projectRoots` asks for the repository root (production: real git). */
export interface MnAssertionRatchetDeps {
  git?: GitRunner;
}

export interface AssertionComparison {
  assertionDelta: number;
  skippedDelta: number;
  problems: string[];
}

/** The ratchet's one-way rule: assertions may not drop and skip markers may not grow. */
export function compareAssertionCounts(baseline: AssertionCounts, current: AssertionCounts): AssertionComparison {
  const assertionDelta = current.assertions - baseline.assertions;
  const skippedDelta = current.skipped - baseline.skipped;
  const problems: string[] = [];
  if (assertionDelta < 0) problems.push(`${-assertionDelta} assertion(s) disappeared`);
  if (skippedDelta > 0) problems.push(`${skippedDelta} test(s) newly skipped`);
  return { assertionDelta, skippedDelta, problems };
}

/** `gsd_run check mn-assertion-ratchet [<phase>]` (the phase is accepted and ignored). */
export function evaluateMnAssertionRatchet(input: MnGateInput, deps: MnAssertionRatchetDeps = {}): GateResult {
  return withMnProject('mn-assertion-ratchet', () => {
    // The baseline and the spec roots are anchored on the REPOSITORY root, exactly where
    // `mn assertion-baseline` records and walks (src/mn-assertion-count.cts).
    const repoRoot = projectRoots(input.projectDir, deps.git).content;
    const read = readAssertionBaseline(repoRoot);
    if (!read.ok) {
      const message = `mn-assertion-ratchet: ${read.message} — nothing to compare against. Record one with \`${ASSERTION_BASELINE_COMMAND}\`.`;
      const details = { baselineFile: read.path, baselineProblem: read.reason };
      // No baseline yet is a state the user fixes by recording one; a baseline that cannot be read is not.
      return read.reason === 'missing' ? mnUnresolvedBlock(message, details) : mnUnreadable(message, details);
    }
    const baselineFile = read.path;

    const roots = DEFAULT_ROOTS.map((root) => path.join(repoRoot, root));
    const current = countAssertions(roots);
    if (current.files === 0) {
      return mnUnresolvedBlock(
        `mn-assertion-ratchet: no spec files found under [${roots.join(', ')}] (repository root ${repoRoot}) — ` +
          'a walk that finds nothing measured nothing.',
        { baselineFile, repoRoot, roots },
      );
    }

    const comparison = compareAssertionCounts(read.baseline, current);
    const details = {
      baselineFile,
      baseline: { assertions: read.baseline.assertions, skipped: read.baseline.skipped, files: read.baseline.files },
      current,
      assertionDelta: comparison.assertionDelta,
      skippedDelta: comparison.skippedDelta,
    };
    if (comparison.problems.length > 0) {
      return mnFinding(
        `mn-assertion-ratchet: ${comparison.problems.join('; ')} (assertions ${read.baseline.assertions} → ${current.assertions}, ` +
          `skipped ${read.baseline.skipped} → ${current.skipped}). Removing a check makes the suite greener while proving less — ` +
          `say why, or restore it. Record the reason in VALIDATION.md "## Assertion Ratchet", then \`${ASSERTION_BASELINE_COMMAND}\`.`,
        { ...details, problems: comparison.problems },
      );
    }
    return mnPass(
      `mn-assertion-ratchet: OK — assertions ${read.baseline.assertions} → ${current.assertions}, ` +
        `skipped ${read.baseline.skipped} → ${current.skipped}; no check was silently removed`,
      details,
    );
  });
}
