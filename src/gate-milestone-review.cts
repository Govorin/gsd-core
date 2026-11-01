/**
 * `gsd_run check milestone-review --milestone <vX.Y>` (or the version as the first positional) — the code-review capability's blocking gate
 * at `milestone:pre` (complete-milestone): a milestone does not close while code it changed was
 * never window-reviewed, or while a window review of it holds a Critical finding nobody fixed,
 * refuted or accepted.
 *
 * ── What already existed, and what was missing ──
 *
 * The same point carries the capability's `review stage` step: it measures the milestone window and,
 * with `code_review.window_at_milestone` on, starts `/gsd-code-review --since <since>`. A step is
 * advisory by construction (loop-hook-dispatch.md), so nothing checked that the review ran, and its
 * Critical findings never stood between the milestone and its tag: in get_your_look_up both closes
 * of 2026-10 shipped first and were reviewed after (1 CR + 40 WR, then 53 findings). This gate is
 * the reader; coverage and open findings are computed by src/milestone-review.cts, shared with the
 * owner's override writer `review milestone-accept`.
 *
 * ── Verdicts ──
 *
 *   skip      `block: false` — `workflow.code_review` is off (no review is owed), or there is no
 *             history to review (not a git repository, no commits)
 *   pass      `block: false` — no code changed in the milestone (`no-change`); every code commit is
 *             covered and no Critical is open (`pass`, warnings counted, never blocking); or what is
 *             open is exactly what the owner accepted (`accepted`, the record's reason in the message)
 *   block     `block: true`, `status: 'finding'` — `reasons` names `uncovered` (code commits no
 *             window review covers; `no-review` when there is no covering review at all) and/or
 *             `open-critical`; the message carries the three ways out (review, fix, accept)
 *   unreadable  git or a review file could not be read, or the body crashed — exit 69, routed by the
 *             gate's `onError` (`halt`): "could not check" never reads as "reviewed"
 *
 * A gate module decides and returns; the check router prints (src/gate-verdict.cts).
 */

import { gateUnreadable, gateUsageFailure, gateVerdict, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { partitionPredicateArgs } from './gate-args.cjs';
import { readWorkflowConfigValue } from './gate-config.cjs';
import { acceptCovers, assessMilestoneReview, MILESTONE_VERSION_RE } from './milestone-review.cjs';
import type { MilestoneReviewState } from './milestone-review.cjs';
import type { GitRunner } from './window-review.cjs';
import { runtimeCommand } from './runtime-slash.cjs';

export const MILESTONE_REVIEW_STATUS = Object.freeze({
  PASS: 'pass',
  NO_CHANGE: 'no-change',
  ACCEPTED: 'accepted',
  SKIPPED: 'skipped',
  FINDING: 'finding',
  UNRESOLVABLE: 'unresolvable',
} as const);

/** How many uncovered commits and open findings the payload and message name. */
export const MILESTONE_REVIEW_NAMED_MAX = 20;

export interface MilestoneReviewGateInput {
  projectDir: string;
  args: readonly string[];
  /** Test seam: the git runner (the execGit seam when absent). */
  execGit?: GitRunner;
}

function payload(status: string, block: boolean, message: string, details: Record<string, unknown> = {}): Record<string, unknown> {
  return { block, status, message, ...details };
}

function skipped(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('skip', false, payload(MILESTONE_REVIEW_STATUS.SKIPPED, false, message, details));
}

function passed(status: string, message: string, details: Record<string, unknown>): GateVerdict {
  return gateVerdict('pass', false, payload(status, false, message, details));
}

function blocked(message: string, details: Record<string, unknown>): GateVerdict {
  return gateVerdict('block', true, payload(MILESTONE_REVIEW_STATUS.FINDING, true, message, details));
}

function unreadableVerdict(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateUnreadable(true, payload(MILESTONE_REVIEW_STATUS.UNRESOLVABLE, true, message, details));
}

/** Absent = enabled: only an explicit false (boolean or the string) turns code review off. */
function codeReviewOn(projectDir: string): boolean {
  const resolved = readWorkflowConfigValue(projectDir, 'workflow.code_review');
  if (!resolved.found) return true;
  const v = resolved.value;
  return !(v === false || (typeof v === 'string' && v.toLowerCase() === 'false'));
}

function short(sha: string): string {
  return sha.slice(0, 10);
}

function details(state: MilestoneReviewState): Record<string, unknown> {
  return {
    milestone: state.milestone,
    base: state.base,
    baseFrom: state.baseFrom,
    baseTag: state.baseTag,
    previous: state.previous,
    reviewSince: state.reviewSince,
    head: state.head,
    codeCommits: state.codeCommits.length,
    uncovered: state.uncovered.length,
    uncoveredCommits: state.uncovered.slice(0, MILESTONE_REVIEW_NAMED_MAX),
    reviews: state.reviews,
    ignoredReviews: state.ignored,
    openCritical: state.openCritical.length,
    openCriticalFindings: state.openCritical.slice(0, MILESTONE_REVIEW_NAMED_MAX),
    openWarnings: state.openWarnings,
    accept: state.accept === null ? null : {
      path: state.accept.path,
      problem: state.accept.problem,
      reason: state.accept.record?.reason ?? null,
      acceptedAt: state.accept.record?.acceptedAt ?? null,
    },
  };
}


function named<T>(items: readonly T[], render: (item: T) => string): string {
  const shown = items.slice(0, MILESTONE_REVIEW_NAMED_MAX).map(render).join('; ');
  const more = items.length > MILESTONE_REVIEW_NAMED_MAX ? `; … and ${items.length - MILESTONE_REVIEW_NAMED_MAX} more` : '';
  return `${shown}${more}`;
}

function blockMessage(projectDir: string, state: MilestoneReviewState): string {
  const parts: string[] = [];
  const from = state.baseFrom === 'tag' ? `since ${state.baseTag}`
    : state.baseFrom === 'archive' ? `since ${state.previous ?? 'the previous milestone'} was archived`
    : state.baseFrom === 'planning-start' ? 'since planning began' : 'over the whole history';
  if (state.uncovered.length > 0) {
    const what = state.reviews.length === 0
      ? `no window review covers milestone ${state.milestone} (${state.codeCommits.length} code commit(s) ${from})`
      : `${state.uncovered.length} of ${state.codeCommits.length} code commit(s) of milestone ${state.milestone} (${from}) are in no window review`;
    parts.push(`${what}: ${named(state.uncovered, (c) => `${short(c.sha)} ${c.subject}`)}`);
  }
  if (state.openCritical.length > 0) {
    parts.push(`${state.openCritical.length} Critical finding(s) open: ${named(state.openCritical, (f) => `${f.review} ${f.id}: ${f.title}`)}`);
  }
  if (state.ignored.length > 0) parts.push(`ignored: ${state.ignored.map((r) => `${r.review} (${r.reason})`).join('; ')}`);
  if (state.accept !== null) {
    parts.push(state.accept.problem !== null
      ? `${state.accept.path} is not usable (${state.accept.problem})`
      : `the acceptance in ${state.accept.path} (${state.accept.record?.acceptedAt ?? '?'}) no longer covers what is open — it was recorded before these appeared`);
  }
  const since = state.reviewSince;
  const ways: string[] = [];
  if (state.uncovered.length > 0) {
    ways.push(since === null
      ? `review it: ${runtimeCommand(projectDir, 'code-review --since <ref>')} from the commit the milestone starts at`
      : `review it: ${runtimeCommand(projectDir, `code-review --since ${since}`)}`);
  }
  if (state.openCritical.length > 0) {
    ways.push(`fix it: ${runtimeCommand(projectDir, 'code-review --since <window base> --until <window tip> --fix')} or ${runtimeCommand(projectDir, 'audit-fix --source window-review')}; a finding fixed by hand: gsd_run review record-fixed --review <REVIEW.md> --finding <ID>; a deliberate deferral: gsd_run windows waive <id> "<reason>"`);
  }
  ways.push(`or accept it as the owner, with a reason recorded for the milestone: gsd_run review milestone-accept --milestone ${state.milestone} --reason "<why>"`);
  return `milestone-review: ${parts.join('. ')}. Then re-run the close — ${ways.join('; ')}.`;
}

function judge(projectDir: string, state: MilestoneReviewState): GateVerdict {
  const d = details(state);
  if (state.codeCommits.length === 0) {
    return passed(MILESTONE_REVIEW_STATUS.NO_CHANGE, `milestone-review: milestone ${state.milestone} changed no code — nothing to review`, d);
  }
  if (state.uncovered.length === 0 && state.openCritical.length === 0) {
    const warn = state.openWarnings > 0 ? `; ${state.openWarnings} warning(s) open (they do not block)` : '';
    return passed(MILESTONE_REVIEW_STATUS.PASS, `milestone-review: all ${state.codeCommits.length} code commit(s) of milestone ${state.milestone} are window-reviewed and no Critical finding is open${warn}`, d);
  }
  const record = state.accept?.record ?? null;
  if (record !== null && acceptCovers(record, state)) {
    return passed(
      MILESTONE_REVIEW_STATUS.ACCEPTED,
      `milestone-review: accepted by the owner (${state.accept?.path}, ${record.acceptedAt}): ${record.reason} — ${state.uncovered.length} unreviewed commit(s), ${state.openCritical.length} open Critical finding(s). Record this override in the milestone's MILESTONES.md entry.`,
      d,
    );
  }
  const reasons: string[] = [];
  if (state.uncovered.length > 0) reasons.push(state.reviews.length === 0 ? 'no-review' : 'uncovered');
  if (state.openCritical.length > 0) reasons.push('open-critical');
  return blocked(blockMessage(projectDir, state), { reasons, ...d });
}

/** `gsd_run check milestone-review --milestone <vX.Y>` */
export function evaluateMilestoneReview(input: MilestoneReviewGateInput): GateResult {
  // `--milestone <v>` (the milestone:pre dispatch form), else the first positional (`check milestone-review v1.2`).
  const { flags, positionals } = partitionPredicateArgs(input.args);
  const milestone = flags['milestone'] ?? positionals.find((p) => p !== '' && !p.startsWith('--'));
  if (typeof milestone !== 'string' || milestone === '') {
    return gateUsageFailure(GATE_FAILURE_CODE.SDK_MISSING_ARG, 'milestone-review requires --milestone <version> (the milestone being closed, e.g. v1.2)');
  }
  if (!MILESTONE_VERSION_RE.test(milestone)) {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `milestone-review: --milestone must be a version like v1.2, got ${JSON.stringify(milestone)}`);
  }
  if (!codeReviewOn(input.projectDir)) {
    return skipped('milestone-review: workflow.code_review is off — no window review is owed', { milestone });
  }
  try {
    const assessment = assessMilestoneReview(input.projectDir, milestone, input.execGit);
    if (assessment.kind === 'no-history') return skipped(`milestone-review: ${assessment.reason} — nothing to review`, { milestone });
    if (assessment.kind === 'unreadable') return unreadableVerdict(`milestone-review: could not check — ${assessment.reason}`, { milestone });
    return judge(input.projectDir, assessment.state);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return unreadableVerdict(`milestone-review: could not check — ${reason}`, { milestone });
  }
}
