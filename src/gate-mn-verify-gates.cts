/**
 * `gsd_run check mn-verify-gates` — block ship while the phase's recorded checks are not all green
 * (mn-verify-gate, ship:pre, `workflow.verify_gates_enforce`). It reads the `gates:` block
 * `gsd_run verify gates` wrote into VERIFICATION.md; it never runs a check.
 *
 * It replaces the `artifact-frontmatter-equals` predicate on `gates.all_passed`, which blocked on
 * the right cases but could only say "all_passed is false" — the same words for "the tests are
 * red" and "the configured command no longer exists". A gate that calls a stale roster broken code
 * is the gate people learn to switch off.
 *
 *   every check green                → pass.
 *   a check red (`fail`)             → FINDING, naming each red check and its exit code.
 *   a check stale or timed out       → UNRESOLVABLE: not measured — repair the roster or the budget.
 *   no VERIFICATION.md, no `gates:`, → UNRESOLVABLE: nothing was measured (run `verify gates`).
 *   or a block that names no checks
 */

import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import { readTextEvidence } from './gate-evidence.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, mnPhaseCliArg, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
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

const { verificationPathFor, recordedChecks, judgeRecordedChecks, describeCheck } = verifyGates;

/** The remedy a missing record, or an unmeasured check, names: (re-)record the gates. */
export function recordStep(phaseArg: string): string {
  return `run \`gsd_run verify gates ${mnPhaseCliArg(phaseArg)}\` (the verify:pre step) first`;
}

/** `gsd_run check mn-verify-gates <phase>` */
export function evaluateMnVerifyGates(input: MnGateInput): GateResult {
  return withMnPhase('mn-verify-gates', input, ({ phaseDir, phaseArg }) => {
    const runStep = recordStep(phaseArg);
    const verificationPath = verificationPathFor(phaseDir);
    const recordFile = readTextEvidence(verificationPath);
    if (recordFile.kind === 'none') return mnUnresolvedBlock(`mn-verify-gates: no ${verificationPath} — ${runStep}`, { verificationPath, recorded: false });
    if (recordFile.kind === 'unreadable') {
      return mnUnreadable(`mn-verify-gates: could not read ${verificationPath} (${recordFile.reason})`, { verificationPath, recorded: false, readError: recordFile.reason });
    }
    const text = recordFile.value;
    const raw = (extractFrontmatter(text) as Record<string, unknown>)['gates'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      // An absent measurement is not a green one.
      return mnUnresolvedBlock(`mn-verify-gates: ${verificationPath} carries no gates: record — ${runStep}`, {
        verificationPath,
        recorded: false,
      });
    }
    const record = raw as Record<string, unknown>;
    const checks = recordedChecks(record);
    const judgement = judgeRecordedChecks(checks);
    const unmeasured = [...judgement.unmeasured, ...judgement.unreadable];
    const details = {
      verificationPath,
      recorded: true,
      ranAt: record['ran_at'],
      ran: checks.map((c) => c.name),
      red: judgement.red.map((c) => c.name),
      unmeasured: unmeasured.map((c) => c.name),
    };

    if (checks.length === 0) {
      return mnUnresolvedBlock(`mn-verify-gates: the gates: record in ${verificationPath} names no checks — ${runStep}`, details);
    }
    const alsoUnmeasured = unmeasured.length > 0 ? ` Not measured either: ${unmeasured.map(describeCheck).join('; ')}.` : '';
    if (judgement.red.length > 0) {
      return mnFinding(
        `mn-verify-gates: ${judgement.red.length} of ${checks.length} recorded check(s) failed — ` +
          `${judgement.red.map(describeCheck).join('; ')}.${alsoUnmeasured} Fix them and re-record before shipping.`,
        details,
      );
    }
    if (unmeasured.length > 0) {
      return mnUnresolvedBlock(
        `mn-verify-gates: ${unmeasured.length} check(s) were not measured — ${unmeasured.map(describeCheck).join('; ')}. ` +
          'A check that cannot run proves nothing either way: repair workflow.verify_gates (or the budget of a check ' +
          'that timed out) and re-record.',
        details,
      );
    }
    return mnPass(`mn-verify-gates: all ${checks.length} recorded check(s) passed`, details);
  });
}
