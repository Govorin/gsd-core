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
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnProject } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { countAssertions, readAssertionBaseline, resolveRepoRoot, DEFAULT_ROOTS } from './mn-assertion-count.cjs';
import type { AssertionCounts } from './mn-assertion-count.cjs';

/** How a baseline is recorded — named in every verdict that needs one. */
export const ASSERTION_BASELINE_COMMAND = 'gsd_run mn assertion-baseline';

/** Injected effects: the git lookup of the repository root (production: `git rev-parse --show-toplevel`). */
export interface MnAssertionRatchetDeps {
  git?: (args: string[], cwd: string) => string | null;
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
    const repoRoot = resolveRepoRoot(input.projectDir, deps.git);
    const read = readAssertionBaseline(repoRoot);
    if (!read.ok) {
      return mnUnresolvable(
        `mn-assertion-ratchet: ${read.message} — nothing to compare against. Record one with \`${ASSERTION_BASELINE_COMMAND}\`.`,
        { baselineFile: read.path, baselineProblem: read.reason },
      );
    }
    const baselineFile = read.path;

    const roots = DEFAULT_ROOTS.map((root) => path.join(repoRoot, root));
    const current = countAssertions(roots);
    if (current.files === 0) {
      return mnUnresolvable(
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
