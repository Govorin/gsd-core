/**
 * `gsd_run check mn-plan-status` and `gsd_run check mn-orphan-plans` — the two readers of a plan's
 * `status` that gate a phase (mn-verify-gate; replaces scripts/plan-status.mjs and orphan-plans.mjs).
 *
 * Both read the vocabulary from `src/plan-status.cts`, the plan and summary files from
 * `src/plan-scan.cts`, and pair a plan with its SUMMARY through `findUnsummarizedPlans`
 * (`src/core-utils.cts`) — the one rule progress and state already use. The scripts carried their
 * own copies of all three because they ran from `$HOME` and could not reach `src/`; a copy is a
 * second reader, and two readers disagreeing about one file is the defect the vocabulary exists
 * to prevent.
 *
 * ── mn-plan-status: is every plan's state interpretable? ────────────────
 *
 *   in_progress + no SUMMARY   → FINDING: the executor set it at start and never finished.
 *   value outside vocabulary   → FINDING: nobody can interpret it.
 *   blocked without a reason   → FINDING: a status without a reason blocks nothing.
 *   superseded without successor → FINDING: superseded by whom?
 *   blocked_reason over the cap → FINDING: never truncated (only length and limit are reported,
 *                                  never the reason's content — T-02-01).
 *
 * Deliberately NOT findings: no `status` (not started — ~1031 plans on consuming trees carry none,
 * and a gate failing them is switched off on day one); `blocked` with a reason (a legitimate,
 * declared outcome); `superseded` with a successor (skipped past every other rule, like plan-scan);
 * `done` (completion is read from the SUMMARY and only from there — D-05); an empty phase.
 *
 * Scope is the whole phase directory, not the finished wave: wave membership is a planner-written
 * field nothing yet makes reliable, and a gate filtering on it silently under-covers.
 *
 * ── mn-orphan-plans: did an executor abandon a plan? ────────────────────
 *
 *   in_progress + no SUMMARY → ORPHANED (finding). No status and no SUMMARY is reported but does
 *   not block: it reads as never-started, and declaring a third of a repository broken
 *   retroactively gets the gate switched off. superseded is always skipped; a SUMMARY means done.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-status.cjs is an export= CommonJS module
import planStatus = require('./plan-status.cjs');
const { PLAN_STATUSES, normalizePlanStatus, isPlanStatus, validateBlockedReason } = planStatus;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtils = require('./core-utils.cjs');
const { findUnsummarizedPlans } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScope = require('./planning-scope.cjs');
const { SCOPE } = planningScope;

/**
 * A plan's frontmatter always sits at byte 0 and closes long before the body — the same bounded
 * prefix `plan-scan` reads (`PLAN_FRONTMATTER_READ_CAP`), for the same reason.
 */
const PLAN_FRONTMATTER_READ_CAP = 64 * 1024;

const BLOCKED_REASON_FIELD = 'blocked_reason';
const SUPERSEDED_BY_FIELD = 'superseded_by';

/** A plan file that cannot be read: the gate could not look at it. */
class PlanUnreadableError extends Error {}

/**
 * A plan's frontmatter, or `null` when the file is not a regular non-empty file (a directory, a
 * device behind a symlink — #2378/#2383 — or an empty file: nothing to interpret, not a defect).
 * The `isFile()` check happens BEFORE any open.
 */
function readPlanFrontmatter(file: string): Record<string, unknown> | null {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return null;
    const length = Math.min(st.size, PLAN_FRONTMATTER_READ_CAP);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(length);
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, length, 0);
    } finally {
      fs.closeSync(fd);
    }
    text = buf.toString('utf8', 0, bytesRead);
  } catch (err) {
    throw new PlanUnreadableError(`cannot read ${file}: ${(err as Error).message}`);
  }
  return extractFrontmatter(text, file);
}

/**
 * A scalar frontmatter field as a string. `key:` with no value parses as an empty map; for a
 * companion field that is an empty value, not an absent one.
 */
function scalar(fm: Record<string, unknown>, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(fm, key)) return undefined;
  const value = fm[key];
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return '';
  return undefined;
}

interface PhasePlans {
  plans: string[];
  unsummarized: Set<string>;
}

/** The phase's plans (root and nested, sorted) and which of them have no SUMMARY. */
function listPhasePlans(phaseDir: string): PhasePlans | { unreadable: string } {
  const scan = scanPhasePlans(phaseDir);
  if (scan.scope !== SCOPE.COMPLETE) {
    return { unreadable: `could not list every plan in ${phaseDir} (scope: ${scan.scope})` };
  }
  const plans = [...scan.allPlanFiles].sort();
  return { plans, unsummarized: new Set(findUnsummarizedPlans(plans, scan.summaryFiles)) };
}

interface PlanFinding {
  plan: string;
  kind: string;
  detail: string;
}

/**
 * A plan's state under mn-plan-status: one of the interpretable states (`no-status`, `superseded`,
 * `blocked`, `done`) or the kind of the one finding it produces — one defect, one message.
 */
function judgePlan(fm: Record<string, unknown>, finished: boolean): string {
  const status = normalizePlanStatus(fm['status']);
  if (status === null) return 'no-status';
  if (!isPlanStatus(status)) return 'unknown-status';
  if (status === 'superseded') {
    const successor = scalar(fm, SUPERSEDED_BY_FIELD);
    return successor === undefined || successor.trim() === '' ? 'superseded-without-successor' : 'superseded';
  }
  if (status === 'blocked') {
    const verdict = validateBlockedReason(scalar(fm, BLOCKED_REASON_FIELD));
    if (verdict.ok) return 'blocked';
    if (verdict.reason === 'missing') return 'blocked-without-reason';
    if (verdict.reason === 'empty') return 'blocked-with-empty-reason';
    return 'blocked-reason-too-long';
  }
  if (status === 'in_progress') return finished ? 'done' : 'stranded-in-progress';
  return 'done';
}

function describeFinding(kind: string, fm: Record<string, unknown>): string {
  switch (kind) {
    case 'unknown-status':
      return `status: ${normalizePlanStatus(fm['status'])} is outside the vocabulary (${PLAN_STATUSES.join(', ')}) — a value nobody can interpret must fail loudly`;
    case 'superseded-without-successor':
      return `status: superseded but no ${SUPERSEDED_BY_FIELD} — superseded by whom?`;
    case 'blocked-without-reason':
      return `status: blocked but no ${BLOCKED_REASON_FIELD} — a status without a reason blocks nothing`;
    case 'blocked-with-empty-reason':
      return `status: blocked but ${BLOCKED_REASON_FIELD} is empty after trim — there is no reason`;
    case 'blocked-reason-too-long': {
      const verdict = validateBlockedReason(scalar(fm, BLOCKED_REASON_FIELD));
      const length = verdict.ok ? 0 : verdict.length;
      return `${BLOCKED_REASON_FIELD} is ${length} characters, over the ${planStatus.BLOCKED_REASON_MAX_LENGTH} limit — never truncated: a reason nobody can read is not a reason`;
    }
    default:
      return 'status: in_progress but no SUMMARY — the executor started and did not finish';
  }
}

/** `gsd_run check mn-plan-status <phase>` */
export function evaluateMnPlanStatus(input: MnGateInput): GateResult {
  return withMnPhase('mn-plan-status', input, ({ phaseDir }) => {
    const listed = listPhasePlans(phaseDir);
    if ('unreadable' in listed) return mnUnresolvable(`mn-plan-status: ${listed.unreadable}`, { phaseDir });
    const counts = { plans: listed.plans.length, done: 0, superseded: 0, blocked: 0, noStatus: 0 };
    if (listed.plans.length === 0) {
      return mnPass('mn-plan-status: no plans in this phase — nothing to interpret', { phaseDir, ...counts, findings: [] });
    }

    const findings: PlanFinding[] = [];
    for (const plan of listed.plans) {
      let fm: Record<string, unknown> | null;
      try {
        fm = readPlanFrontmatter(path.join(phaseDir, plan));
      } catch (err) {
        if (err instanceof PlanUnreadableError) return mnUnresolvable(`mn-plan-status: ${err.message}`, { phaseDir });
        throw err;
      }
      if (fm === null) continue;
      const verdict = judgePlan(fm, !listed.unsummarized.has(plan));
      if (verdict === 'no-status') counts.noStatus++;
      else if (verdict === 'superseded') counts.superseded++;
      else if (verdict === 'blocked') counts.blocked++;
      else if (verdict === 'done') counts.done++;
      else findings.push({ plan, kind: verdict, detail: describeFinding(verdict, fm) });
    }

    if (findings.length === 0) {
      return mnPass(
        `mn-plan-status: OK — ${counts.plans} plan(s): ${counts.done} done, ${counts.superseded} superseded, ` +
          `${counts.blocked} blocked, ${counts.noStatus} without status`,
        { phaseDir, ...counts, findings },
      );
    }
    return mnFinding(
      `mn-plan-status: ${findings.length} of ${counts.plans} plan(s) in a state nobody can interpret — ` +
        `add the missing companion field (${BLOCKED_REASON_FIELD} for blocked, ${SUPERSEDED_BY_FIELD} for superseded), ` +
        `correct the status to one of ${PLAN_STATUSES.join(', ')}, or finish the plan and write its SUMMARY: ` +
        findings.map((f) => `${f.plan} (${f.kind})`).join(', '),
      { phaseDir, ...counts, findings },
    );
  });
}

/**
 * `gsd_run check mn-orphan-plans <phase> [--strict]`
 *
 * `--strict` (by hand only — the gate dispatch passes no flags) also blocks unknown-state plans:
 * the opt-in for a project that has finished backfilling statuses and wants it to stay that way.
 */
export function evaluateMnOrphanPlans(input: MnGateInput): GateResult {
  const strict = input.args.includes('--strict');
  // A bare boolean flag is removed before the phase is parsed: `--strict 3` must not read `3` as its value.
  const args = input.args.filter((a) => a !== '--strict');
  return withMnPhase('mn-orphan-plans', { projectDir: input.projectDir, args }, ({ phaseDir }) => {
    const listed = listPhasePlans(phaseDir);
    if ('unreadable' in listed) return mnUnresolvable(`mn-orphan-plans: ${listed.unreadable}`, { phaseDir });

    const orphaned: string[] = [];
    const unknownState: string[] = [];
    let done = 0;
    let superseded = 0;
    for (const plan of listed.plans) {
      let fm: Record<string, unknown> | null;
      try {
        fm = readPlanFrontmatter(path.join(phaseDir, plan));
      } catch (err) {
        if (err instanceof PlanUnreadableError) return mnUnresolvable(`mn-orphan-plans: ${err.message}`, { phaseDir });
        throw err;
      }
      const status = fm === null ? null : normalizePlanStatus(fm['status']);
      if (status === 'superseded') superseded++;
      else if (!listed.unsummarized.has(plan)) done++;
      else if (status === 'in_progress') orphaned.push(plan);
      else unknownState.push(plan);
    }

    const details = { phaseDir, strict, orphaned, unknownState, done, superseded };
    if (strict && unknownState.length > 0) {
      return mnFinding(
        `mn-orphan-plans: ${orphaned.length} orphaned, ${unknownState.length} unknown-state under --strict ` +
          `(${[...orphaned, ...unknownState].join(', ')}) — give each plan a status or a SUMMARY`,
        details,
      );
    }
    if (orphaned.length === 0) {
      return mnPass(
        listed.plans.length === 0
          ? 'mn-orphan-plans: no plans in this phase — nothing to check'
          : `mn-orphan-plans: OK — ${done} done, ${superseded} superseded, ${unknownState.length} unknown-state`,
        details,
      );
    }
    return mnFinding(
      `mn-orphan-plans: ${orphaned.length} plan(s) began and left no record (${orphaned.join(', ')}) — ` +
        'a plan that began and left no record is re-run from scratch on the next pass, on top of whatever it ' +
        'already changed. Write its SUMMARY, or set status: superseded if it was replaced.',
      details,
    );
  });
}
