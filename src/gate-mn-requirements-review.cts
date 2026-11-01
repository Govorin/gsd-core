/**
 * `gsd_run check mn-requirements-review` — the requirements review's gate at `roadmap:pre`
 * (capability mn-requirements-review, ADR-5212): the roadmap waits while a critical finding about
 * the milestone's requirements survived refutation and nobody accepted it as a known risk.
 *
 *   critical finding, upheld or unverified, not accepted   → FINDING (block): revise or accept.
 *   a lens wrote no report                                  → UNRESOLVABLE (block): those requirements
 *                                                             were never read along that lens.
 *   no review yet, or a review of other requirements       → UNRESOLVABLE (block): run the review.
 *   none of these                                           → pass, warnings named in the message.
 *   REQUIREMENTS.md, the review or ACCEPTED.json unreadable → UNRESOLVABLE, outcome `unreadable`
 *                                                             (exit 69, routed by the gate's onError).
 *
 * The gate never writes and never runs a model: the review is `/gsd:requirements-review`, an
 * acceptance is `gsd_run requirements-review accept`. Project-scoped (`roadmap:pre` has no phase);
 * the planning directory is the active workstream's when `--ws` is given.
 */

import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { readTextEvidence } from './gate-evidence.cjs';
import { MN_GATE_STATUS, mnPayload, withMnProject } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { judgeReview, parseAccepted, reviewPaths, REVIEW_FILE, REQUIREMENTS_FILE } from './requirements-review.cjs';
import type { AcceptedRisk } from './requirements-review.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;

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
/** Could not judge yet, for a reason the user fixes (no review, a stale one): a delivered block, exit 0. */
function mnUnresolvedBlock(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, mnPayload(MN_GATE_STATUS.UNRESOLVABLE, message, details));
}

/** How a review is run, and how a finding is accepted — named in every verdict that needs one. */
export const REVIEW_COMMAND = '/gsd-requirements-review';
export const ACCEPT_COMMAND = 'gsd_run requirements-review accept';

const VERB = 'mn-requirements-review';

/** `gsd_run check mn-requirements-review [--milestone <v>]` (arguments are accepted and ignored). */
export function evaluateMnRequirementsReview(input: MnGateInput): GateResult {
  return withMnProject(VERB, () => {
    const paths = reviewPaths(planningDir(input.projectDir));
    const details = { review: paths.review, requirements: paths.requirements };

    const requirements = readTextEvidence(paths.requirements);
    if (requirements.kind === 'unreadable') return mnUnreadable(`${VERB}: could not read ${REQUIREMENTS_FILE} (${requirements.reason})`, details);
    if (requirements.kind === 'none') {
      return mnUnresolvedBlock(`${VERB}: no ${REQUIREMENTS_FILE} at ${paths.requirements} — there are no requirements to review yet.`, details);
    }

    const review = readTextEvidence(paths.review);
    if (review.kind === 'unreadable') return mnUnreadable(`${VERB}: could not read ${REVIEW_FILE} (${review.reason})`, details);
    if (review.kind === 'none') {
      return mnUnresolvedBlock(
        `${VERB}: the requirements have not been reviewed — no ${REVIEW_FILE}. Run ${REVIEW_COMMAND}, or turn the review off with workflow.requirements_review false.`,
        details,
      );
    }

    const acceptedText = readTextEvidence(paths.accepted);
    if (acceptedText.kind === 'unreadable') return mnUnreadable(`${VERB}: could not read ${paths.accepted} (${acceptedText.reason})`, details);
    let accepted: AcceptedRisk[] = [];
    if (acceptedText.kind === 'found') {
      try {
        accepted = parseAccepted(acceptedText.value);
      } catch (err) {
        return mnUnreadable(`${VERB}: ${paths.accepted} is not the accepted-risk journal (${err instanceof Error ? err.message : String(err)})`, details);
      }
    }

    const judged = judgeReview(review.value, requirements.value, accepted);
    switch (judged.kind) {
      case 'malformed':
        return mnUnresolvedBlock(`${VERB}: ${REVIEW_FILE} is not a composed review (${judged.problem}). Run ${REVIEW_COMMAND} again.`, details);
      case 'stale':
        return mnUnresolvedBlock(
          `${VERB}: ${REVIEW_FILE} reviewed other requirements — ${REQUIREMENTS_FILE} changed since. Run ${REVIEW_COMMAND} again.`,
          { ...details, reviewedSha256: judged.reviewedSha256, currentSha256: judged.currentSha256 },
        );
      case 'blocking': {
        const list = judged.blocking.map((f) => `${f.id} (${f.lens}) ${f.title}`).join('; ');
        const missing = judged.missing.length > 0 ? ` Lenses that wrote no report: ${judged.missing.join(', ')}.` : '';
        return mnFinding(
          `${VERB}: ${judged.blocking.length} critical finding(s) about the requirements survived refutation and are not accepted: ${list}.${missing} ` +
            `Revise ${REQUIREMENTS_FILE} and review again, or accept one as a known risk: \`${ACCEPT_COMMAND} ${judged.blocking[0].id} --reason "<why>"\`. Full review: ${paths.review}`,
          { ...details, blocking: judged.blocking, missing: judged.missing },
        );
      }
      case 'incomplete':
        return mnUnresolvedBlock(
          `${VERB}: lenses ${judged.missing.join(', ')} wrote no report, so the requirements were not read along them. Run ${REVIEW_COMMAND} again (or narrow workflow.requirements_review_lenses).`,
          { ...details, missing: judged.missing },
        );
      case 'pass':
        return mnPass(
          `${VERB}: OK — no unaccepted critical finding (${judged.total} finding(s), ${judged.warnings} warning(s), ${judged.accepted} accepted risk(s)); see ${paths.review}`,
          { ...details, findings: judged.total, warnings: judged.warnings, accepted: judged.accepted },
        );
    }
  });
}
