/**
 * `gsd_run check mn-baseline` — block execute-phase before its first wave while the project's own
 * checks are red (mn-verify-gate, execute:pre, `workflow.verify_gates_baseline`). It reads the
 * `baseline:` record `gsd_run verify baseline` wrote into `{N}-BASELINE.md`; it never runs a check.
 *
 *   every check green                          → pass.
 *   red checks, all accepted (`--accept`)      → pass: started on a known red base, on record.
 *   a red check not accepted                   → FINDING: a red base hides the failures this phase
 *                                                introduces. Fix it, or accept it knowingly.
 *   a check stale or timed out, not accepted   → UNRESOLVABLE: the base is unmeasured — a command
 *                                                that cannot run is a roster problem, not a red.
 *   no record, or a record of other code or    → UNRESOLVABLE: the step did not measure THIS tree
 *   another roster (digest differs)              with THESE checks.
 *   workflow.verify_gates empty or malformed   → UNRESOLVABLE: there is nothing to measure with.
 *
 * Red outranks unmeasured in the verdict (a finding is the stronger claim), and both lists are
 * named in the message either way.
 */

import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import { readTextEvidence } from './gate-evidence.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, mnPhaseCliArg, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { BASELINE_RECORD_KEY, baselineDigest, baselinePathFor } from './verify-baseline.cjs';
import type { GitRunner } from './verify-baseline.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-gates.cjs is an export= CommonJS module
import verifyGates = require('./verify-gates.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');

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
const { extractFrontmatter } = frontmatterMod;

const { readChecks, recordedChecks, recordedList, judgeRecordedChecks, describeCheck } = verifyGates;

/** The remedy a missing or stale baseline names: record it. */
export function recordStep(phaseArg: string): string {
  return `run \`gsd_run verify baseline ${mnPhaseCliArg(phaseArg)}\` (the execute:pre step)`;
}

/** The acceptance command a red or unmeasured base offers (execute-pre-gate-hooks.md step 2). */
export function acceptHint(phaseArg: string): string {
  return `\`gsd_run verify baseline ${mnPhaseCliArg(phaseArg)} --accept "<why this base is acceptable>"\``;
}

/** `gsd_run check mn-baseline <phase>` */
export function evaluateMnBaseline(input: MnGateInput, git?: GitRunner): GateResult {
  return withMnPhase('mn-baseline', input, ({ phaseDir, phaseArg }) => {
    const config = readChecks(input.projectDir);
    if (!config.ok) {
      return mnUnresolvedBlock(
        `mn-baseline: workflow.verify_gates is set but cannot be run (${config.problems.join('; ')}) — repair it before measuring a baseline`,
        { phaseDir, problems: config.problems },
      );
    }
    if (config.checks.length === 0) {
      return mnUnresolvedBlock(
        'mn-baseline: workflow.verify_gates names no checks, so there is no baseline to measure — name the project\'s checks ' +
          `(gsd_run query config-set workflow.verify_gates '{"tests":"npm test"}') or turn workflow.verify_gates_baseline off`,
        { phaseDir, recorded: false },
      );
    }

    const baselinePath = baselinePathFor(phaseDir);
    const recordFile = readTextEvidence(baselinePath);
    if (recordFile.kind === 'none') return mnUnresolvedBlock(`mn-baseline: no ${baselinePath} — ${recordStep(phaseArg)}`, { baselinePath, recorded: false });
    if (recordFile.kind === 'unreadable') {
      return mnUnreadable(`mn-baseline: could not read ${baselinePath} (${recordFile.reason})`, { baselinePath, recorded: false, readError: recordFile.reason });
    }
    const text = recordFile.value;
    const raw = (extractFrontmatter(text) as Record<string, unknown>)[BASELINE_RECORD_KEY];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return mnUnresolvedBlock(`mn-baseline: ${baselinePath} carries no baseline: record — ${recordStep(phaseArg)}`, {
        baselinePath,
        recorded: false,
      });
    }
    const record = raw as Record<string, unknown>;
    const ranAt = typeof record['ran_at'] === 'string' ? record['ran_at'] : 'undated';

    if (record['digest'] !== baselineDigest(input.projectDir, config.checks, git)) {
      return mnUnresolvedBlock(
        `mn-baseline: the baseline (${ranAt}) was measured on other code or with other checks — ` +
          `the tree outside .planning/ or workflow.verify_gates changed since; ${recordStep(phaseArg)}`,
        { baselinePath, recorded: true, stale: true, ranAt },
      );
    }

    const checks = recordedChecks(record);
    const accepted = new Set(recordedList(record['accepted']));
    const reason = typeof record['accepted_reason'] === 'string' ? record['accepted_reason'] : '';
    const judgement = judgeRecordedChecks(checks);
    const open = (list: typeof checks) => list.filter((c) => !accepted.has(c.name));
    const red = open(judgement.red);
    const unmeasured = open([...judgement.unmeasured, ...judgement.unreadable]);
    const acceptedNotGreen = [...judgement.red, ...judgement.unmeasured, ...judgement.unreadable].filter((c) => accepted.has(c.name));
    const details = {
      baselinePath,
      recorded: true,
      ranAt,
      ran: checks.map((c) => c.name),
      red: red.map((c) => c.name),
      unmeasured: unmeasured.map((c) => c.name),
      accepted: [...accepted],
    };

    if (checks.length === 0) {
      return mnUnresolvedBlock(`mn-baseline: ${baselinePath} records no checks — ${recordStep(phaseArg)}`, details);
    }
    const alsoUnmeasured = unmeasured.length > 0 ? ` Not measured either: ${unmeasured.map(describeCheck).join('; ')}.` : '';
    if (red.length > 0) {
      return mnFinding(
        `mn-baseline: the project's checks are red before the first wave — ${red.map(describeCheck).join('; ')}.${alsoUnmeasured} ` +
          'A red base hides the failures this phase introduces among the ones it inherited. Fix the base first, or start ' +
          `on it knowingly: ${acceptHint(phaseArg)}, then re-run execute-phase.`,
        details,
      );
    }
    if (unmeasured.length > 0) {
      return mnUnresolvedBlock(
        `mn-baseline: the base is unmeasured — ${unmeasured.map(describeCheck).join('; ')}. A check that cannot run is a ` +
          'stale roster, not a red one: repair workflow.verify_gates (or raise the budget of a check that timed out), or ' +
          `accept it knowingly: ${acceptHint(phaseArg)}.`,
        details,
      );
    }
    if (acceptedNotGreen.length > 0) {
      return mnPass(
        `mn-baseline: starting on an accepted base — ${acceptedNotGreen.map(describeCheck).join('; ')}` +
          `${reason ? ` (accepted: ${reason})` : ''}; every other check is green`,
        details,
      );
    }
    return mnPass(`mn-baseline: the base is green — ${checks.length} check(s) passed before the first wave`, details);
  });
}
