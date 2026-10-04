/**
 * `gsd_run check mn-failure-paths` — the pre-mortem as an artifact (mn-verify-gate; upstream-sync
 * plan, phase 4.2). Contract: gsd-core/references/failure-paths.md.
 *
 * ── What was there, and what was missing ────────────────────────────────
 *
 * The planner's Pre-Mortem (gsd-core/references/thinking-models-planning.md) asks it to assume the
 * plan failed and list the likely reasons. The answer lived in the planner's head: nothing in
 * PLAN.md recorded it, so nothing could check whether each named failure had a way to be noticed.
 * A plan declares its failure paths in a `<failure_paths>` block instead; each `<failure_path>`
 * names the `<invariant>` that must hold and a `<check>` that fails when it does not.
 *
 * ── One grammar for "a check that can fail" ─────────────────────────────
 *
 * A `<check>` body is the `<automated>` / `<fails_when>` pair of #3172, judged by the SAME
 * recognizer the plan-checker's failing-direction probe uses — `extractFailingDirections` and
 * `resolveFailingDirection` (src/verify-command-grounding.cts) — never a second parser. A command
 * without a stated failing direction is no check: it reads as rigour and delivers none. The
 * `<invariant>` statement is classified by the same statement rule (missing / empty / placeholder
 * / ok), so `TBD` means the same thing in both places.
 *
 * ── When a plan must declare failure paths ──────────────────────────────
 *
 * Decided from the plan's own data, never from its prose, so small plans pay nothing:
 *   - `files_modified` names a migration (`isMigrationPath`, the predicate mn-migration-safety
 *     uses): a migration is the one artifact a follow-up commit cannot repair;
 *   - `user_setup` is non-empty: the plan depends on an external service the executor does not
 *     control, so its failure modes are outside the code.
 * Any other plan may declare failure paths; the gate judges every block it finds.
 *
 * ── Verdict ─────────────────────────────────────────────────────────────
 *
 *   blocker  required-absent (a triggered plan declares no path) · no-check (a path without a
 *            `<check>` command) · check-unstated (a check command whose `<fails_when>` is missing,
 *            empty or a placeholder) · invariant-unstated (the same for `<invariant>`)
 *   warning  empty-block (a `<failure_paths>` with no path on a plan nothing requires it of) ·
 *            orphan-statement (a `<fails_when>` before every command of its check)
 *
 * Any blocker → finding (blocks). Warnings ride in a passing verdict. A plan that cannot be listed
 * or read → unresolvable (fail-closed, mn-gate convention).
 *
 * The metric the gate exists to move is in `metrics`: `paths_without_check` over `paths` — a path
 * counts as checked when at least one of its commands can fail (status `ok`, or the Wave-0
 * `MISSING` sentinel that the plan-checker's 8a/8d already own).
 *
 * ── Where it runs ───────────────────────────────────────────────────────
 *
 * The planner runs the verb on its own plans before returning (the `workflow.failure_paths`
 * fragment, on by default), and plan:post dispatches it as a blocking gate under
 * `workflow.failure_paths_enforce` (opt-in: halting there has no revision loop behind it). The
 * verb reads no config: what it judges is the plans, and the keys decide only who listens.
 *
 * Every list in the payload is capped at `MAX_LISTED` with the true count beside it (the `@file:`
 * threshold rule in gate-mn-waves.cts).
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { MAX_LISTED } from './gate-mn-waves.cjs';
import { isMigrationPath } from './gate-mn-migration-safety.cjs';
import { extractTaggedBlocks } from './markdown-sectionizer.cjs';
import { readFrontmatterFieldsFromSource } from './planning-document.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-command-grounding.cjs is an export= CommonJS module
import verifyCommandGroundingMod = require('./verify-command-grounding.cjs');
const { extractFailingDirections, resolveFailingDirection } = verifyCommandGroundingMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-document.cjs is an export= CommonJS module
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScope = require('./planning-scope.cjs');
const { SCOPE } = planningScope;

const VERB = 'mn-failure-paths';

/**
 * The fixed subject an `<invariant>` statement is classified under. `resolveFailingDirection`
 * judges a statement relative to a command; any runnable, non-sentinel subject yields the bare
 * statement verdict (missing / empty / placeholder / ok), which is all an invariant needs.
 */
const INVARIANT_SUBJECT = 'invariant';

export type FailurePathFindingKind =
  | 'required-absent'
  | 'no-check'
  | 'check-unstated'
  | 'invariant-unstated'
  | 'empty-block'
  | 'orphan-statement';

export type FailurePathSeverity = 'blocker' | 'warning';

/** The closed verdict: every kind the gate emits and its severity. */
export const FAILURE_PATH_SEVERITY: Readonly<Record<FailurePathFindingKind, FailurePathSeverity>> = Object.freeze({
  'required-absent': 'blocker',
  'no-check': 'blocker',
  'check-unstated': 'blocker',
  'invariant-unstated': 'blocker',
  'empty-block': 'warning',
  'orphan-statement': 'warning',
});

export interface FailurePathFinding {
  plan: string;
  /** 1-based position of the path in its plan; `null` for a plan-level finding. */
  path: number | null;
  kind: FailurePathFindingKind;
  severity: FailurePathSeverity;
  detail: string;
}

export interface FailurePathCheck {
  command: string;
  statement: string | null;
  status: string;
}

export interface FailurePathRow {
  plan: string;
  path: number;
  name: string | null;
  invariant: string | null;
  invariantStatus: string;
  checks: FailurePathCheck[];
  /** At least one command of the path can fail (`ok`, or the Wave-0 sentinel). */
  checked: boolean;
}

export interface FailurePathPlan {
  plan: string;
  /** Why the plan must declare failure paths; empty when nothing requires it. */
  requiredBy: string[];
  declared: boolean;
  paths: number;
}

export interface FailurePathMetrics {
  plans: number;
  plans_required: number;
  plans_required_absent: number;
  paths: number;
  paths_without_check: number;
  /** `paths_without_check / paths`; `null` when the phase declares no path (0/0 is not 0). */
  paths_without_check_ratio: number | null;
}

export interface FailurePathAnalysis {
  plans: FailurePathPlan[];
  paths: FailurePathRow[];
  findings: FailurePathFinding[];
  metrics: FailurePathMetrics;
}

function finding(plan: string, pathIndex: number | null, kind: FailurePathFindingKind, detail: string): FailurePathFinding {
  return { plan, path: pathIndex, kind, severity: FAILURE_PATH_SEVERITY[kind], detail };
}

function firstBody(text: string, tag: string): string | undefined {
  const bodies = extractTaggedBlocks(text, tag, true);
  return bodies.length > 0 ? bodies[0] : undefined;
}

/** Why `text` (one PLAN.md) must declare failure paths — from its frontmatter, never its prose. */
export function failurePathTriggers(text: string): string[] {
  const reasons: string[] = [];
  for (const entry of parsePlanDocument(text).filesModified) {
    if (isMigrationPath(entry)) reasons.push(`migration ${entry}`);
  }
  const userSetup = readFrontmatterFieldsFromSource(text, ['user_setup'])['user_setup'];
  if (userSetup.ok) {
    const value = userSetup.value;
    const declared = Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '' && value.trim() !== '[]';
    if (declared) reasons.push('user_setup');
  }
  return reasons;
}

/** Judge one `<failure_path>` body: the row, and the findings it raises. */
function judgePath(plan: string, index: number, body: string): { row: FailurePathRow; findings: FailurePathFinding[] } {
  const findings: FailurePathFinding[] = [];
  const nameBody = firstBody(body, 'name');
  const name = nameBody === undefined || nameBody.trim() === '' ? null : nameBody.trim();
  const label = name === null ? `path ${index}` : `path ${index} "${name}"`;

  const invariant = resolveFailingDirection(INVARIANT_SUBJECT, firstBody(body, 'invariant'));
  if (invariant.status !== 'ok') {
    findings.push(finding(plan, index, 'invariant-unstated', `${label}: <invariant> is ${invariant.status} — name what must stay true`));
  }

  const checkBodies = extractTaggedBlocks(body, 'check', true);
  const checks: FailurePathCheck[] = [];
  for (const checkBody of checkBodies) {
    for (const entry of extractFailingDirections(checkBody)) {
      if (entry.status === 'orphan') {
        findings.push(finding(plan, index, 'orphan-statement', `${label}: a <fails_when> follows no <automated> command — it satisfies nothing`));
        continue;
      }
      checks.push({ command: entry.command, statement: entry.statement, status: entry.status });
      if (entry.severity === 'blocker') {
        findings.push(
          finding(plan, index, 'check-unstated', `${label}: <fails_when> is ${entry.status} for \`${entry.command}\` — a command with no stated failure signal cannot fail`),
        );
      }
    }
  }
  const checked = checks.some((c) => c.status === 'ok' || c.status === 'sentinel');
  if (checks.length === 0) {
    findings.push(
      finding(plan, index, 'no-check', `${label}: no <check> command — ${checkBodies.length === 0 ? 'the path has no <check> block' : 'its <check> holds no <automated>'}`),
    );
  }

  return {
    row: {
      plan,
      path: index,
      name,
      invariant: invariant.statement,
      invariantStatus: invariant.status,
      checks,
      checked,
    },
    findings,
  };
}

/** Judge one PLAN.md's text. `plan` is the file name the findings carry. */
export function analyzePlanFailurePaths(plan: string, text: string): { plan: FailurePathPlan; paths: FailurePathRow[]; findings: FailurePathFinding[] } {
  const requiredBy = failurePathTriggers(text);
  const blocks = extractTaggedBlocks(text, 'failure_paths', true);
  const pathBodies = blocks.flatMap((block) => extractTaggedBlocks(block, 'failure_path', true));
  const findings: FailurePathFinding[] = [];
  const paths: FailurePathRow[] = [];

  pathBodies.forEach((body, i) => {
    const judged = judgePath(plan, i + 1, body);
    paths.push(judged.row);
    findings.push(...judged.findings);
  });

  if (pathBodies.length === 0 && requiredBy.length > 0) {
    findings.unshift(
      finding(plan, null, 'required-absent', `declares no failure path, but must: ${requiredBy.join(', ')} — add a <failure_paths> block`),
    );
  } else if (pathBodies.length === 0 && blocks.length > 0) {
    findings.unshift(finding(plan, null, 'empty-block', '<failure_paths> holds no <failure_path> — remove it or fill it'));
  }

  return { plan: { plan, requiredBy, declared: blocks.length > 0, paths: pathBodies.length }, paths, findings };
}

/** Judge every executable plan of a phase. `{ unreadable }` when a plan cannot be listed or read. */
export function analyzeFailurePaths(phaseDir: string): FailurePathAnalysis | { unreadable: string } {
  const scan = scanPhasePlans(phaseDir);
  if (scan.scope !== SCOPE.COMPLETE) return { unreadable: `could not list every plan in ${phaseDir} (scope: ${scan.scope})` };

  const plans: FailurePathPlan[] = [];
  const paths: FailurePathRow[] = [];
  const findings: FailurePathFinding[] = [];
  for (const plan of [...scan.planFiles].sort()) {
    const full = path.join(phaseDir, plan);
    let text: string;
    try {
      // A PLAN.md that is a directory is "could not look": skipping it silently would read as clean.
      if (!fs.statSync(full).isFile()) return { unreadable: `${plan} is not a readable file` };
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      return { unreadable: `cannot read ${plan}: ${(err as Error).message}` };
    }
    const judged = analyzePlanFailurePaths(plan, text);
    plans.push(judged.plan);
    paths.push(...judged.paths);
    findings.push(...judged.findings);
  }

  const withoutCheck = paths.filter((p) => !p.checked).length;
  const metrics: FailurePathMetrics = {
    plans: plans.length,
    plans_required: plans.filter((p) => p.requiredBy.length > 0).length,
    plans_required_absent: findings.filter((f) => f.kind === 'required-absent').length,
    paths: paths.length,
    paths_without_check: withoutCheck,
    paths_without_check_ratio: paths.length === 0 ? null : withoutCheck / paths.length,
  };
  return { plans, paths, findings, metrics };
}

/** `gsd_run check mn-failure-paths <phase>` */
export function evaluateMnFailurePaths(input: MnGateInput): GateResult {
  return withMnPhase(VERB, input, ({ phaseDir }) => {
    const analysis = analyzeFailurePaths(phaseDir);
    if ('unreadable' in analysis) return mnUnresolvable(`${VERB}: ${analysis.unreadable}`, { phaseDir });

    const counts = {
      blocker: analysis.findings.filter((f) => f.severity === 'blocker').length,
      warning: analysis.findings.filter((f) => f.severity === 'warning').length,
    };
    const { metrics } = analysis;
    const tally = `${metrics.paths} path(s) in ${metrics.plans} plan(s), ${metrics.paths_without_check} without a check`;
    const details = {
      phaseDir,
      // One line with the metric, for a reader who wants the number rather than the findings.
      summary: `failure paths: ${tally}; ${counts.blocker} blocker(s), ${counts.warning} warning(s)`,
      metrics,
      counts,
      findingsTotal: analysis.findings.length,
      findings: analysis.findings.slice(0, MAX_LISTED),
      pathsTotal: analysis.paths.length,
      paths: analysis.paths.slice(0, MAX_LISTED),
      plans: analysis.plans.slice(0, MAX_LISTED),
    };

    if (counts.blocker > 0) {
      const shown = analysis.findings
        .filter((f) => f.severity === 'blocker')
        .slice(0, 5)
        .map((f) => `${f.plan}: ${f.detail}`)
        .join('; ');
      return mnFinding(`${VERB}: ${counts.blocker} blocker(s) — ${shown}. ${tally}`, details);
    }
    if (metrics.paths === 0 && metrics.plans_required === 0) {
      return mnPass(`${VERB}: no plan requires or declares failure paths — nothing to check`, details);
    }
    return mnPass(`${VERB}: OK — ${tally}${counts.warning > 0 ? ` (${counts.warning} warning(s))` : ''}`, details);
  });
}
