/**
 * `gsd_run check mn-mutation-spot-check` — the cheap half of the mutation spot-check
 * (mn-verify-gate, verify:pre). It reads the `mutation:` block that `gsd_run verify mutation`
 * recorded into the phase's VERIFICATION.md and judges it; it never runs a test.
 *
 *   survivors                              → FINDING: the suite stayed green with the code changed.
 *   passed, nothing_to_mutate              → pass.
 *   budget_exhausted, ≥1 attempted, 0 survived → pass: every mutant that ran was killed. The claim
 *                                            of a spot-check is "at these points the tests react";
 *                                            fewer points is a smaller claim, not a false one.
 *   budget_exhausted with 0 attempted      → UNRESOLVABLE: nothing was measured.
 *   no_command, unrunnable, red_baseline   → UNRESOLVABLE: the step could not check.
 *   no VERIFICATION.md, no record          → UNRESOLVABLE: the step never ran (run `verify mutation`).
 *   record of other code (digest differs)  → UNRESOLVABLE: the record is stale — the phase's files
 *                                            changed after it was taken.
 *   a mutant still on disk (restore journal → UNRESOLVABLE: a run is in progress or was killed
 *   holds a pending entry, or is unreadable)  mid-mutant; the tree is not the code under review.
 *                                            The step restores it on its next run.
 */

import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import { readTextEvidence } from './gate-evidence.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { MUTATION_RECORD_KEY, MUTATION_STATUS, digestCandidates, mutationCandidates } from './verify-mutation.cjs';
import { readRestoreJournal } from './mutation-restore-journal.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-gates.cjs is an export= CommonJS module
import verifyGates = require('./verify-gates.cjs');

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
const { verificationPathFor } = verifyGates;

/** The remedy a missing or stale mutation record names. */
export const RUN_STEP = 'run `gsd_run verify mutation --phase <N>` (the verify:pre step) first';

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function count(record: Record<string, unknown>, key: string): number {
  const n = Number(record[key]);
  return Number.isFinite(n) ? n : 0;
}

/** `gsd_run check mn-mutation-spot-check <phase>` */
export function evaluateMnMutationSpotCheck(input: MnGateInput): GateResult {
  return withMnPhase('mn-mutation-spot-check', input, ({ phaseDir }) => {
    const journal = readRestoreJournal(input.projectDir);
    if (journal.kind === 'unreadable') {
      return mnUnreadable(
        `mn-mutation-spot-check: the restore journal ${journal.journalPath} is unreadable (${journal.why}) — a mutant may be on disk; inspect it before judging`,
        { journalPath: journal.journalPath, mutantOnDisk: true },
      );
    }
    if (journal.kind === 'held' && journal.pending !== null) {
      const { pending } = journal;
      return mnUnresolvedBlock(
        `mn-mutation-spot-check: ${pending.file} still carries a mutant (${pending.label}, line ${pending.line}) — a run (pid ${journal.pid}) ` +
          `is in progress or was killed mid-mutant, so the tree is not the code under review; ${RUN_STEP} (it restores the file first)`,
        { journalPath: journal.journalPath, mutantOnDisk: true, mutantFile: pending.file },
      );
    }
    const verificationPath = verificationPathFor(phaseDir);
    const recordFile = readTextEvidence(verificationPath);
    if (recordFile.kind === 'none') return mnUnresolvedBlock(`mn-mutation-spot-check: no ${verificationPath} — ${RUN_STEP}`, { verificationPath, recorded: false });
    if (recordFile.kind === 'unreadable') {
      return mnUnreadable(`mn-mutation-spot-check: could not read ${verificationPath} (${recordFile.reason})`, { verificationPath, recorded: false, readError: recordFile.reason });
    }
    const text = recordFile.value;
    const raw = (extractFrontmatter(text) as Record<string, unknown>)[MUTATION_RECORD_KEY];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return mnUnresolvedBlock(`mn-mutation-spot-check: ${verificationPath} carries no mutation: record — ${RUN_STEP}`, {
        verificationPath,
        recorded: false,
      });
    }
    const record = raw as Record<string, unknown>;
    const status = typeof record['status'] === 'string' ? record['status'] : '';
    const attempted = count(record, 'attempted');
    const killed = count(record, 'killed');
    const survived = count(record, 'survived');
    const survivors = Array.isArray(record['survivors']) ? record['survivors'].map(String) : [];
    const details = { verificationPath, recorded: true, recordStatus: status, ranAt: record['ran_at'], attempted, killed, survived, survivors };

    const digest = digestCandidates(input.projectDir, mutationCandidates(input.projectDir, phaseDir));
    if (record['digest'] !== digest) {
      return mnUnresolvedBlock(
        `mn-mutation-spot-check: the mutation record (${stringField(record, 'ran_at')}) was taken on different code — ` +
          `the phase's declared files changed since; ${RUN_STEP}`,
        { ...details, stale: true },
      );
    }

    switch (status) {
      case MUTATION_STATUS.SURVIVORS:
        return mnFinding(
          `mn-mutation-spot-check: ${survived} of ${attempted} mutant(s) survived — the suite stayed green with the code changed ` +
            `(${survivors.join('; ')}). A green suite cannot tell "the code is right" from "nothing checks this": add an ` +
            'assertion that fails when the behaviour at these points changes.',
          details,
        );
      case MUTATION_STATUS.PASSED:
        return mnPass(`mn-mutation-spot-check: ${killed}/${attempted} mutant(s) killed — the tests react to changes in this code`, details);
      case MUTATION_STATUS.NOTHING_TO_MUTATE:
        return mnPass("mn-mutation-spot-check: none of this phase's declared files carries a mutable construct — nothing to spot-check", details);
      case MUTATION_STATUS.BUDGET_EXHAUSTED:
        if (attempted > 0 && survived === 0) {
          return mnPass(
            `mn-mutation-spot-check: ${killed}/${attempted} mutant(s) killed before the time budget ran out — a smaller spot-check, every point of it held`,
            details,
          );
        }
        return mnUnresolvedBlock(`mn-mutation-spot-check: the time budget ran out before any mutant completed — ${stringField(record, 'reason')}`, details);
      case MUTATION_STATUS.NO_COMMAND:
      case MUTATION_STATUS.UNRUNNABLE:
      case MUTATION_STATUS.RED_BASELINE:
        return mnUnresolvedBlock(`mn-mutation-spot-check: the step could not check (${status}) — ${stringField(record, 'reason')}`, details);
      default:
        return mnUnresolvedBlock(`mn-mutation-spot-check: the record's status "${status}" is not one this gate knows — ${RUN_STEP}`, details);
    }
  });
}
