/**
 * `gsd_run check mn-orphan-plans <phase> [--strict]` — did an executor abandon a plan? The second
 * reader of a plan's `status` (the rules are in `gate-mn-plan-status.cts`, whose plan reading this
 * gate shares).
 *
 *   in_progress + no SUMMARY → ORPHANED (finding). No status and no SUMMARY is reported but does
 *   not block: it reads as never-started, and declaring a third of a repository broken
 *   retroactively gets the gate switched off. superseded is always skipped; a SUMMARY means done.
 */

import path from 'node:path';
import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { PlanUnreadableError, listPhasePlans, readPlanFrontmatter } from './gate-mn-plan-status.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-status.cjs is an export= CommonJS module
import planStatus = require('./plan-status.cjs');
const { normalizePlanStatus } = planStatus;

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
 * `--strict` (by hand only — the gate dispatch passes no flags) also blocks unknown-state plans:
 * the opt-in for a project that has finished backfilling statuses and wants it to stay that way.
 */
export function evaluateMnOrphanPlans(input: MnGateInput): GateResult {
  const strict = input.args.includes('--strict');
  // A bare boolean flag is removed before the phase is parsed: `--strict 3` must not read `3` as its value.
  const args = input.args.filter((a) => a !== '--strict');
  return withMnPhase('mn-orphan-plans', { projectDir: input.projectDir, args }, ({ phaseDir }) => {
    const listed = listPhasePlans(phaseDir);
    if ('unreadable' in listed) return mnUnreadable(`mn-orphan-plans: ${listed.unreadable}`, { phaseDir });

    const orphaned: string[] = [];
    const unknownState: string[] = [];
    let done = 0;
    let superseded = 0;
    for (const plan of listed.plans) {
      let fm: Record<string, unknown> | null;
      try {
        fm = readPlanFrontmatter(path.join(phaseDir, plan));
      } catch (err) {
        if (err instanceof PlanUnreadableError) return mnUnreadable(`mn-orphan-plans: ${err.message}`, { phaseDir });
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
