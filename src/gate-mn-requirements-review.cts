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
/** How a roadmap the gate held is resumed without asking for the requirements again. */
export const RESUME_HINT = 'A held roadmap resumes with /gsd-new-milestone --from-roadmap (a first milestone: /gsd-new-project, which resumes an interrupted bootstrap).';

/**
 * The re-review command for `lenses` — only those lenses run again, the other reports are kept;
 * no lenses → the whole review (the requirements changed, or there is none).
 */
export function rerunCommand(lenses: readonly string[]): string {
  return lenses.length === 0 ? REVIEW_COMMAND : `${REVIEW_COMMAND} --lens ${[...new Set(lenses)].join(',')}`;
}

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
        `${VERB}: the requirements have not been reviewed — no ${REVIEW_FILE}. Run ${REVIEW_COMMAND}, or turn the review off with workflow.requirements_review false. ${RESUME_HINT}`,
        { ...details, rerun: [] },
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
        return mnUnresolvedBlock(`${VERB}: ${REVIEW_FILE} is not a composed review (${judged.problem}). Run ${REVIEW_COMMAND} again. ${RESUME_HINT}`, { ...details, rerun: [] });
      case 'stale':
        return mnUnresolvedBlock(
          `${VERB}: ${REVIEW_FILE} reviewed other requirements — ${REQUIREMENTS_FILE} changed since. Run ${REVIEW_COMMAND} again. ${RESUME_HINT}`,
          { ...details, rerun: [], reviewedSha256: judged.reviewedSha256, currentSha256: judged.currentSha256 },
        );
      case 'blocking': {
        const list = judged.blocking.map((f) => `${f.id} (${f.lens}) ${f.title}`).join('; ');
        const missing = judged.missing.length > 0 ? ` Lenses that wrote no report: ${judged.missing.join(', ')}.` : '';
        const rerun = [...judged.blocking.map((f) => f.lens), ...judged.missing];
        return mnFinding(
          `${VERB}: ${judged.blocking.length} critical finding(s) about the requirements survived refutation and are not accepted: ${list}.${missing} ` +
            `Revise ${REQUIREMENTS_FILE} and review again, review those lenses again as written (\`${rerunCommand(rerun)}\`), ` +
            `or accept one as a known risk: \`${ACCEPT_COMMAND} ${judged.blocking[0].id} --reason "<why>"\`. ${RESUME_HINT} Full review: ${paths.review}`,
          { ...details, blocking: judged.blocking, missing: judged.missing, rerun: [...new Set(rerun)] },
        );
      }
      case 'incomplete':
        return mnUnresolvedBlock(
          `${VERB}: lenses ${judged.missing.join(', ')} wrote no report, so the requirements were not read along them. Run \`${rerunCommand(judged.missing)}\` (the other lenses' reports are kept), or narrow workflow.requirements_review_lenses. ${RESUME_HINT}`,
          { ...details, missing: judged.missing, rerun: judged.missing },
        );
      case 'pass':
        return mnPass(
          `${VERB}: OK — no unaccepted critical finding (${judged.total} finding(s), ${judged.warnings} warning(s), ${judged.accepted} accepted risk(s)); see ${paths.review}`,
          { ...details, findings: judged.total, warnings: judged.warnings, accepted: judged.accepted },
        );
    }
  });
}
