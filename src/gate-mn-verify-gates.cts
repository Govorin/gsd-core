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

import fs from 'node:fs';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnPhaseCliArg, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-gates.cjs is an export= CommonJS module
import verifyGates = require('./verify-gates.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;

const { verificationPathFor, recordedChecks, judgeRecordedChecks, describeCheck } = verifyGates;

/** `gsd_run check mn-verify-gates <phase>` */
export function evaluateMnVerifyGates(input: MnGateInput): GateResult {
  return withMnPhase('mn-verify-gates', input, ({ phaseDir, phaseArg }) => {
    const runStep = `run \`gsd_run verify gates ${mnPhaseCliArg(phaseArg)}\` (the verify:pre step) first`;
    const verificationPath = verificationPathFor(phaseDir);
    let text: string;
    try {
      text = fs.readFileSync(verificationPath, 'utf8');
    } catch {
      return mnUnresolvable(`mn-verify-gates: no ${verificationPath} — ${runStep}`, { verificationPath, recorded: false });
    }
    const raw = (extractFrontmatter(text) as Record<string, unknown>)['gates'];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      // An absent measurement is not a green one.
      return mnUnresolvable(`mn-verify-gates: ${verificationPath} carries no gates: record — ${runStep}`, {
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
      return mnUnresolvable(`mn-verify-gates: the gates: record in ${verificationPath} names no checks — ${runStep}`, details);
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
      return mnUnresolvable(
        `mn-verify-gates: ${unmeasured.length} check(s) were not measured — ${unmeasured.map(describeCheck).join('; ')}. ` +
          'A check that cannot run proves nothing either way: repair workflow.verify_gates (or the budget of a check ' +
          'that timed out) and re-record.',
        details,
      );
    }
    return mnPass(`mn-verify-gates: all ${checks.length} recorded check(s) passed`, details);
  });
}
