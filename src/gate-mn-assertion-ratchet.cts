/**
 * `gsd_run check mn-assertion-ratchet` — the assertion ratchet as a READ-ONLY gate
 * (mn-verify-gate, verify:pre; replaces the gate half of scripts/assertion-ratchet.mjs).
 *
 * Measures the project's assertions and skip markers (src/mn-assertion-count.cts) and compares
 * them with the recorded baseline:
 *
 *   assertions dropped, or skips grew   → FINDING: a check was removed or silenced without a record.
 *   neither                             → pass (growth is always fine — the ratchet is one-way).
 *   no baseline / unreadable / malformed → UNRESOLVABLE: nothing to compare against.
 *   zero spec files found               → UNRESOLVABLE: almost always a missed walk, not a project
 *                                         without tests.
 *
 * The gate never writes. The script created the baseline on its first run; a gate that writes
 * the floor it is about to judge against can be satisfied by deleting the file. Recording a
 * baseline — first time, or after a declared drop — is `gsd_run mn assertion-baseline --update`.
 *
 * Project-scoped: the dispatcher appends the phase, and the gate ignores it — the ratchet counts
 * the whole repository.
 */

import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnProject } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import {
  assertionBaselinePath,
  compareAssertionCounts,
  measureAssertions,
  readAssertionBaseline,
} from './mn-assertion-count.cjs';
import type { AssertionCountDeps } from './mn-assertion-count.cjs';

/** How a baseline is recorded — named in every verdict that needs one. */
export const ASSERTION_BASELINE_COMMAND = 'gsd_run mn assertion-baseline --update';

/** `gsd_run check mn-assertion-ratchet [<phase>]` (the phase is accepted and ignored). */
export function evaluateMnAssertionRatchet(input: MnGateInput, deps?: AssertionCountDeps): GateResult {
  return withMnProject('mn-assertion-ratchet', () => {
    const baselineFile = assertionBaselinePath(input.projectDir);
    const read = readAssertionBaseline(baselineFile);
    if (!read.ok) {
      return mnUnresolvable(
        `mn-assertion-ratchet: ${read.detail} — nothing to compare against. Record one with \`${ASSERTION_BASELINE_COMMAND}\`.`,
        { baselineFile, baselineProblem: read.reason },
      );
    }

    const measured = measureAssertions(input.projectDir, deps ? { deps } : {});
    const current = measured.count;
    if (current.files === 0) {
      return mnUnresolvable(
        `mn-assertion-ratchet: no spec files found under [${measured.roots.join(', ')}] (repository root ${measured.repoRoot}) — ` +
          'a walk that finds nothing measured nothing.',
        { baselineFile, repoRoot: measured.repoRoot, roots: measured.roots },
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
