/**
 * `gsd-tools config-advise [--json]` — which existing knobs would this project's own artifacts have
 * wanted on? (S7 of the October usage review.)
 *
 * Half of what the reviewed projects missed already existed in GSD, off by default and never found:
 * chunked planning, per-wave code review, recorded verification gates, install-time agent grants.
 * Each rule below reads one cheap, deterministic signal from `.planning/` and, when it fires and the
 * knob is not already on, recommends the knob with a one-line reason and the exact command. Nothing
 * here writes configuration.
 *
 * Rules (thresholds are `ADVISE_THRESHOLDS`; each fires at `>=` its value):
 *   plan_chunked       a phase with PLANS_PER_PHASE+ plans (on disk, or declared in ROADMAP for a
 *                      phase still to plan: not checked done, with a phase dir or in STATE's milestone)
 *                      → `workflow.plan_chunked` + `planning.chunked_parallel`
 *   code_review_point  a phase-end `*-REVIEW.md` with REVIEW_FIX_FINDINGS+ critical+warning findings
 *                      → `workflow.code_review_point: execute:wave:post`
 *   verify_work        HUMAN_VERIFICATION_PHASES+ active phases waiting on human verification
 *                      (VERIFICATION `human_needed`, or an open UAT) → run verify-work / audit-uat
 *   verify_gates       GATE_CITING_REPORTS+ VERIFICATION reports citing check commands while
 *                      `workflow.verify_gates` is empty → `workflow.verify_gates` (+ `_record`)
 *   agent_tools        a plan still to run declares a tool its executor does not grant (the tool
 *                      preflight, `src/tool-preflight.cts`) → `agent_tools` + reinstall
 *
 * Only the active milestone's phases (`.planning/phases/`) are read: an archived milestone's
 * artifacts describe a configuration that may already have changed. A rule's knob counts as on by
 * its main key alone, so a companion key switched off on purpose is never re-recommended.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocatorMod = require('./phase-locator.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- audit.cjs is an export= CommonJS module
import auditMod = require('./audit.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserMod = require('./roadmap-parser.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
import { runtimeCommand } from './runtime-slash.cjs';
import { scanFencedBlocks, scanInlineCodeSpans } from './markdown-sectionizer.cjs';
import { joinLines, splitLines } from './text-lines.cjs';
import {
  buildPreflightFix,
  preflightIncompletePlans,
  PREFLIGHT_STATUS,
} from './tool-preflight.cjs';
import type { AgentFileScope, ToolPreflight } from './tool-preflight.cjs';

const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
const { scanPhasePlans } = planScanMod;
const { getMilestoneInfo } = roadmapParserMod;
const { planningDir } = planningWorkspace;
const { listActiveAndArchivedPhaseDirs } = phaseLocatorMod;
const { output } = ioMod;

/**
 * Where each rule fires. Chosen from the October 2026 review of three projects (`.plans/gsd-usage-
 * review-2026-10/`), not tuned:
 *
 *   PLANS_PER_PHASE 6 — the smallest plan count among phases whose single planner ran long: gyl's
 *     phases of 6–13 plans took a median 42 min (up to 517 min) per planner run; mn's 20–25-plan
 *     phases compacted the planner. Below 6 no reviewed planner run was a problem.
 *   REVIEW_FIX_FINDINGS 5 — a phase-end review asking for five or more fixes (critical + warning)
 *     sends the fixer across several plans' files; a per-wave review sees each defect with one
 *     wave's diff in scope, while the code is fresh. Info findings ask for no fix and do not count.
 *   HUMAN_VERIFICATION_PHASES 2 — one phase awaiting human verification is the normal state right
 *     after execution; a second means the debt has been carried past the next phase.
 *   GATE_CITING_REPORTS 2 — the verifier re-running the same checks by hand in two reports is the
 *     repetition `workflow.verify_gates` records once, with exit codes the verifier did not produce.
 */
export const ADVISE_THRESHOLDS = Object.freeze({
  PLANS_PER_PHASE: 6,
  REVIEW_FIX_FINDINGS: 5,
  HUMAN_VERIFICATION_PHASES: 2,
  GATE_CITING_REPORTS: 2,
});

export const ADVICE_RULE = Object.freeze({
  PLAN_CHUNKED: 'plan_chunked',
  CODE_REVIEW_POINT: 'code_review_point',
  VERIFY_WORK: 'verify_work',
  VERIFY_GATES: 'verify_gates',
  AGENT_TOOLS: 'agent_tools',
} as const);
export type AdviceRule = (typeof ADVICE_RULE)[keyof typeof ADVICE_RULE];

export interface Recommendation {
  rule: AdviceRule;
  /** The settings the command writes (`null` for a command to run, not a knob). */
  settings: Record<string, unknown> | null;
  reason: string;
  command: string;
}

export interface RuleOutcome {
  rule: AdviceRule;
  /** The signal crossed its threshold. */
  fired: boolean;
  /** The knob is already on, so nothing is recommended even if the signal fired. */
  already_enabled: boolean;
  evidence: Record<string, unknown>;
}

export interface ConfigAdvice {
  recommendations: Recommendation[];
  rules: RuleOutcome[];
  count: number;
  /** One line for `/gsd-progress` and `/gsd-health`; `null` when there is nothing to recommend. */
  summary: string | null;
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

interface PhaseDir {
  dir: string;
  fullPath: string;
}

function readJsonObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The project config `config-get` reads: the workstream's, else the root `.planning/config.json`. */
function readProjectConfig(cwd: string): Record<string, unknown> {
  return readJsonObject(path.join(planningDir(cwd), 'config.json'))
    ?? readJsonObject(path.join(cwd, '.planning', 'config.json'))
    ?? {};
}

function configValue(config: Record<string, unknown>, keyPath: string): unknown {
  let cursor: unknown = config;
  for (const segment of keyPath.split('.')) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function activePhaseDirs(cwd: string): PhaseDir[] {
  try {
    const { targets } = listActiveAndArchivedPhaseDirs(planningDir(cwd), cwd);
    return targets.filter((t) => t.milestone === undefined).map((t) => ({ dir: t.dir, fullPath: t.fullPath }));
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function frontmatterOf(text: string, file: string): Record<string, unknown> {
  try {
    return extractFrontmatter(text, file);
  } catch {
    return {};
  }
}

function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function configSetCommand(settings: Record<string, unknown>): string {
  const arg = (value: unknown): string => {
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') return /^[\w.:-]+$/.test(value) ? value : shellQuote(value);
    return shellQuote(JSON.stringify(value));
  };
  return Object.entries(settings).map(([key, value]) => `gsd-tools config-set ${key} ${arg(value)}`).join(' && ');
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/** A phase token for comparison: `03` → `3`, `03.1` → `3.1`; anything else as written, lower-cased. */
function phaseKey(token: string): string {
  const t = token.trim().replace(/[*:]+$/, '');
  return /^\d+(\.\d+)*$/.test(t) ? t.split('.').map((p) => String(parseInt(p, 10))).join('.') : t.toLowerCase();
}

const VERSION_TOKEN_RE = /\bv\d+(?:\.\d+)+\b/i;

export interface RoadmapPlanCount {
  phase: string;
  plans: number;
  /** The milestone version of the section the phase heading sits in; `null` in the preamble. */
  milestone: string | null;
  /** A `- [x] … Phase N` entry marks the phase done. */
  done: boolean;
}

/**
 * Plans declared per phase in ROADMAP.md (`**Plans**: 7 plans` / `**Plans:** 7 plans`), by phase
 * heading, with the milestone section each heading sits in (the last milestone heading or
 * `<summary>` carrying a `vX.Y` token above it) and whether a checked entry marks it done.
 */
export function roadmapPlanCounts(roadmap: string): RoadmapPlanCount[] {
  const out: RoadmapPlanCount[] = [];
  const done = new Set<string>();
  let phase: string | null = null;
  let milestone: string | null = null;
  for (const line of splitLines(roadmap)) {
    const checked = /^\s*[-*]\s*\[[xX]\].*?\bPhase\s+([^\s:*]+)/.exec(line);
    if (checked) done.add(phaseKey(checked[1]));
    const heading = /^#{2,4}\s+(?:Phase\s+([^\s:]+)|(\[[^\]]+\]\s*\d[^\s:]*))/i.exec(line);
    if (heading) {
      phase = heading[1] ?? heading[2];
    } else if (/^#{1,4}\s/.test(line) || /<summary>/i.test(line)) {
      phase = null;
      const version = VERSION_TOKEN_RE.exec(line);
      if (version) milestone = version[0].toLowerCase();
    }
    const plans = /^\s*(?:[-*]\s+)?\*\*Plans(?::\*\*|\*\*:)\s*(\d+)\s+plans?\b/i.exec(line);
    if (plans && phase !== null) out.push({ phase, plans: parseInt(plans[1], 10), milestone, done: false });
  }
  return out.map((r) => ({ ...r, done: done.has(phaseKey(r.phase)) }));
}

/**
 * The ROADMAP counts that describe phases still to plan: not marked done, AND either the phase has
 * a directory in `.planning/phases/` or it sits in the milestone STATE names as active. A preamble
 * that lists an earlier milestone's phases (mn's 01–03 of v1.0) is neither.
 */
function activeRoadmapCounts(cwd: string, roadmap: string, phases: PhaseDir[]): RoadmapPlanCount[] {
  const dirKeys = new Set(phases.map((p) => phaseKey(p.dir.split('-')[0])));
  let active: string | null = null;
  try {
    const info = getMilestoneInfo(cwd).value;
    active = info && typeof info.version === 'string' ? info.version.toLowerCase() : null;
  } catch {
    active = null;
  }
  return roadmapPlanCounts(roadmap).filter((r) => !r.done
    && (dirKeys.has(phaseKey(r.phase)) || (active !== null && r.milestone === active)));
}

function rulePlanChunked(cwd: string, config: Record<string, unknown>, phases: PhaseDir[]): { outcome: RuleOutcome; rec: Recommendation | null } {
  const counts: Array<{ phase: string; plans: number; source: string }> = [];
  for (const p of phases) {
    const n = scanPhasePlans(p.fullPath).allPlanFiles.length;
    if (n > 0) counts.push({ phase: p.dir, plans: n, source: 'disk' });
  }
  const roadmap = readText(path.join(planningDir(cwd), 'ROADMAP.md'));
  if (roadmap !== null) {
    // Phases still to plan only — a shipped or future milestone's phases say nothing about how the
    // phases being planned now are planned.
    for (const r of activeRoadmapCounts(cwd, roadmap, phases)) counts.push({ phase: r.phase, plans: r.plans, source: 'roadmap' });
  }
  const largest = counts.reduce<{ phase: string; plans: number; source: string } | null>((best, c) => (best === null || c.plans > best.plans ? c : best), null);
  const fired = largest !== null && largest.plans >= ADVISE_THRESHOLDS.PLANS_PER_PHASE;
  const chunked = configValue(config, 'workflow.plan_chunked') === true;
  const outcome: RuleOutcome = {
    rule: ADVICE_RULE.PLAN_CHUNKED,
    fired,
    // Decided by the primary key: a project that turned chunked planning on and chunked_parallel
    // off on purpose must not get the same advice forever.
    already_enabled: chunked,
    evidence: { largest, threshold: ADVISE_THRESHOLDS.PLANS_PER_PHASE },
  };
  if (!fired || outcome.already_enabled || largest === null) return { outcome, rec: null };
  const settings: Record<string, unknown> = {};
  settings['workflow.plan_chunked'] = true;
  // An explicit chunked_parallel (even false) is the project's choice; only an absent one is offered.
  if (configValue(config, 'planning.chunked_parallel') === undefined) settings['planning.chunked_parallel'] = true;
  return {
    outcome,
    rec: {
      rule: ADVICE_RULE.PLAN_CHUNKED,
      settings,
      reason: `phase ${largest.phase} has ${largest.plans} plans (${largest.source === 'roadmap' ? 'declared in ROADMAP.md' : 'on disk'}; ≥ ${ADVISE_THRESHOLDS.PLANS_PER_PHASE}) — one planner writing them all runs for hours and compacts; chunked mode gives each plan its own short planner`,
      command: configSetCommand(settings),
    },
  };
}

function ruleCodeReviewPoint(config: Record<string, unknown>, phases: PhaseDir[]): { outcome: RuleOutcome; rec: Recommendation | null } {
  let worst: { file: string; critical: number; warning: number } | null = null;
  for (const p of phases) {
    for (const f of listFiles(p.fullPath).filter((name) => name.endsWith('-REVIEW.md'))) {
      const text = readText(path.join(p.fullPath, f));
      if (text === null) continue;
      const fm = frontmatterOf(text, f);
      if (typeof fm['status'] === 'string' && fm['status'].toLowerCase() === 'skipped') continue;
      const findings = fm['findings'];
      if (!findings || typeof findings !== 'object' || Array.isArray(findings)) continue;
      const critical = toCount((findings as Record<string, unknown>)['critical']);
      const warning = toCount((findings as Record<string, unknown>)['warning']);
      if (worst === null || critical + warning > worst.critical + worst.warning) worst = { file: `${p.dir}/${f}`, critical, warning };
    }
  }
  const total = worst === null ? 0 : worst.critical + worst.warning;
  const fired = total >= ADVISE_THRESHOLDS.REVIEW_FIX_FINDINGS;
  const already = configValue(config, 'workflow.code_review_point') === 'execute:wave:post';
  const outcome: RuleOutcome = {
    rule: ADVICE_RULE.CODE_REVIEW_POINT,
    fired,
    already_enabled: already,
    evidence: { worst, threshold: ADVISE_THRESHOLDS.REVIEW_FIX_FINDINGS },
  };
  if (!fired || already || worst === null) return { outcome, rec: null };
  const settings = { 'workflow.code_review_point': 'execute:wave:post' };
  return {
    outcome,
    rec: {
      rule: ADVICE_RULE.CODE_REVIEW_POINT,
      settings,
      reason: `${worst.file} asked for ${total} fixes at the end of the phase (${worst.critical} critical, ${worst.warning} warning; ≥ ${ADVISE_THRESHOLDS.REVIEW_FIX_FINDINGS}) — a review per wave catches them with one wave's diff in scope`,
      command: configSetCommand(settings),
    },
  };
}

interface AuditItem {
  phase?: string;
  status?: string;
  scan_error?: boolean;
  archived_milestone?: string;
}

function ruleVerifyWork(cwd: string): { outcome: RuleOutcome; rec: Recommendation | null } {
  let phasesWaiting: string[] = [];
  let scanError: string | null = null;
  try {
    const audit = auditMod.auditOpenArtifacts(cwd) as unknown as { items: { verification_gaps: AuditItem[]; uat_gaps: AuditItem[] } };
    const live = (i: AuditItem): boolean => !i.scan_error && i.archived_milestone === undefined && typeof i.phase === 'string' && i.phase !== '';
    const human = audit.items.verification_gaps.filter((i) => live(i) && i.status === 'human_needed');
    const uat = audit.items.uat_gaps.filter(live);
    phasesWaiting = [...new Set([...human, ...uat].map((i) => i.phase as string))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  } catch (err) {
    scanError = (err as Error).message;
  }
  const fired = phasesWaiting.length >= ADVISE_THRESHOLDS.HUMAN_VERIFICATION_PHASES;
  const outcome: RuleOutcome = {
    rule: ADVICE_RULE.VERIFY_WORK,
    fired,
    already_enabled: false,
    evidence: { phases: phasesWaiting, threshold: ADVISE_THRESHOLDS.HUMAN_VERIFICATION_PHASES, ...(scanError ? { scan_error: scanError } : {}) },
  };
  if (!fired) return { outcome, rec: null };
  return {
    outcome,
    rec: {
      rule: ADVICE_RULE.VERIFY_WORK,
      settings: null,
      reason: `${phasesWaiting.length} phases wait on human verification (${phasesWaiting.join(', ')}; ≥ ${ADVISE_THRESHOLDS.HUMAN_VERIFICATION_PHASES}) — nothing downstream runs until someone closes them`,
      command: `${runtimeCommand(cwd, `verify-work ${phasesWaiting[0]}`)}, then ${runtimeCommand(cwd, 'audit-uat')}`,
    },
  };
}

const GATE_RUNNER_RE = /^(?:\$\s*)?((?:npm|pnpm|yarn|bun|bunx|npx|nx|cargo|go|pytest|make|gradle|\.\/gradlew|mvn|dotnet|tsc|eslint|vitest|jest|deno|swift|flutter|dart|mix|ruff|mypy)\s[^\n`|]*|tsc|pytest|eslint)$/;
const GATE_KIND_RE = /\b(tests?|lint|typecheck|type-check|tsc|build|check|vet|clippy|mypy|ruff|eslint|pytest|vitest|jest)\b/;

function gateKind(word: string): string {
  if (/^(tests?|pytest|vitest|jest)$/.test(word)) return 'tests';
  if (/^(typecheck|type-check|tsc|mypy)$/.test(word)) return 'typecheck';
  if (/^(lint|eslint|ruff|clippy|vet)$/.test(word)) return 'lint';
  return word;
}

/** A gate's name: its one kind (`tests`, `lint`, …), or `checks` for a command running several
 * (`nx run-many -t typecheck lint test build`). */
export function gateName(command: string): string {
  const kinds = new Set([...command.matchAll(new RegExp(GATE_KIND_RE.source, 'g'))].map((m) => gateKind(m[1])));
  if (kinds.size === 0) return 'check';
  return kinds.size === 1 ? [...kinds][0] : 'checks';
}

/** Check commands a VERIFICATION report cites (inline code spans and fenced lines), normalised. */
export function citedGateCommands(report: string): string[] {
  // The frontmatter's `gates:` block, if any, is a record, not a citation.
  const body = splitLines(stripFrontmatter(report));
  const candidates: string[] = scanInlineCodeSpans(joinLines(body)).map((span) => span.content);
  for (const block of scanFencedBlocks(body)) {
    const last = block.closeLineIdx === -1 ? body.length : block.closeLineIdx;
    candidates.push(...body.slice(block.openLineIdx + 1, last));
  }
  const found = new Set<string>();
  for (const raw of candidates) {
    const text = raw.trim().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
    if (text.length === 0 || text.length > 120) continue;
    const m = GATE_RUNNER_RE.exec(text);
    if (m && GATE_KIND_RE.test(m[1])) found.add(m[1].trim());
  }
  return [...found];
}

function ruleVerifyGates(config: Record<string, unknown>, phases: PhaseDir[]): { outcome: RuleOutcome; rec: Recommendation | null } {
  const reports: Array<{ file: string; commands: string[] }> = [];
  for (const p of phases) {
    for (const f of listFiles(p.fullPath).filter((name) => name.endsWith('-VERIFICATION.md'))) {
      const text = readText(path.join(p.fullPath, f));
      if (text === null) continue;
      const commands = citedGateCommands(text);
      if (commands.length > 0) reports.push({ file: `${p.dir}/${f}`, commands });
    }
  }
  const fired = reports.length >= ADVISE_THRESHOLDS.GATE_CITING_REPORTS;
  const gates = configValue(config, 'workflow.verify_gates');
  const configured = gates !== null && typeof gates === 'object' && !Array.isArray(gates) && Object.keys(gates).length > 0;
  const outcome: RuleOutcome = {
    rule: ADVICE_RULE.VERIFY_GATES,
    fired,
    // Decided by the primary key (see plan_chunked): verify_gates_record is offered only alongside it.
    already_enabled: configured,
    evidence: { reports, threshold: ADVISE_THRESHOLDS.GATE_CITING_REPORTS, verify_gates_configured: configured },
  };
  if (!fired || outcome.already_enabled) return { outcome, rec: null };
  const settings: Record<string, unknown> = {};
  const tally = new Map<string, number>();
  for (const r of reports) for (const c of r.commands) tally.set(c, (tally.get(c) ?? 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const repeated = ranked.filter(([, n]) => n >= ADVISE_THRESHOLDS.GATE_CITING_REPORTS);
  const map: Record<string, string> = {};
  for (const [command] of (repeated.length > 0 ? repeated : ranked).slice(0, 4)) {
    let name = gateName(command);
    for (let i = 2; Object.prototype.hasOwnProperty.call(map, name); i++) name = `${gateName(command)}_${i}`;
    map[name] = command;
  }
  settings['workflow.verify_gates'] = map;
  // An explicit verify_gates_record (even false) is the project's choice; only an absent one is offered.
  if (configValue(config, 'workflow.verify_gates_record') === undefined) settings['workflow.verify_gates_record'] = true;
  return {
    outcome,
    rec: {
      rule: ADVICE_RULE.VERIFY_GATES,
      settings,
      reason: `${reports.length} VERIFICATION reports cite checks run by hand (${reports.map((r) => r.file).join(', ')}; ≥ ${ADVISE_THRESHOLDS.GATE_CITING_REPORTS}) — record them once, with exit codes the verifier does not produce`,
      command: configSetCommand(settings),
    },
  };
}

function ruleAgentTools(cwd: string, phases: PhaseDir[]): { outcome: RuleOutcome; rec: Recommendation | null } {
  const results: ToolPreflight[] = [];
  const unreadable: string[] = [];
  for (const p of phases) {
    const scanned = preflightIncompletePlans(cwd, p.fullPath);
    if ('unreadable' in scanned) unreadable.push(`${p.dir}: ${scanned.unreadable}`);
    else results.push(...scanned.results);
  }
  const missing = results.filter((r) => r.status === PREFLIGHT_STATUS.MISSING);
  const unknown = results.filter((r) => r.status === PREFLIGHT_STATUS.UNKNOWN);
  const outcome: RuleOutcome = {
    rule: ADVICE_RULE.AGENT_TOOLS,
    fired: missing.length > 0,
    already_enabled: false,
    evidence: {
      checked: results.length,
      missing: missing.map((r) => ({ plan: r.plan, agent: r.agent, missing: r.missing })),
      unknown: unknown.map((r) => ({ plan: r.plan, agent: r.agent, reason: r.reason })),
      ...(unreadable.length > 0 ? { unreadable } : {}),
    },
  };
  if (missing.length === 0) return { outcome, rec: null };
  // One fix per agent, over every plan that needs it.
  const byAgent = new Map<string, { missing: Set<string>; plans: string[]; runtime: string; scope: AgentFileScope | null }>();
  for (const r of missing) {
    const entry = byAgent.get(r.agent) ?? { missing: new Set<string>(), plans: [], runtime: r.runtime, scope: r.agent_scope };
    for (const t of r.missing) entry.missing.add(t);
    entry.plans.push(r.plan);
    byAgent.set(r.agent, entry);
  }
  const settings: Record<string, unknown> = {};
  const commands: string[] = [];
  const reasons: string[] = [];
  const reinstalls = new Set<string>();
  for (const [agent, entry] of byAgent) {
    const fix = buildPreflightFix(agent, [...entry.missing], entry.runtime, cwd, entry.scope);
    if (!fix.already_configured) {
      settings[`agent_tools.${agent}`] = fix.agent_tools[agent];
      commands.push(fix.config_set);
    }
    reinstalls.add(fix.reinstall);
    reasons.push(`${entry.plans.join(', ')} ${entry.plans.length === 1 ? 'needs' : 'need'} ${fix.grants.join(', ')}, which the installed ${agent} does not grant`);
  }
  return {
    outcome,
    rec: {
      rule: ADVICE_RULE.AGENT_TOOLS,
      settings: Object.keys(settings).length > 0 ? settings : null,
      reason: `${reasons.join('; ')} — execute-phase halts on them (check mn-tool-preflight)`,
      command: commands.length > 0
        ? `${commands.join(' && ')}, then ${[...reinstalls].join('; ')}`
        : [...reinstalls].join('; '),
    },
  };
}

// ─── Entry points ────────────────────────────────────────────────────────────

/** Evaluate every rule. Never throws for a project in any state: a rule that cannot look reports why. */
export function adviseConfig(cwd: string): ConfigAdvice {
  const config = readProjectConfig(cwd);
  const phases = activePhaseDirs(cwd);
  const evaluated = [
    rulePlanChunked(cwd, config, phases),
    ruleCodeReviewPoint(config, phases),
    ruleVerifyWork(cwd),
    ruleVerifyGates(config, phases),
    ruleAgentTools(cwd, phases),
  ];
  const recommendations = evaluated.map((e) => e.rec).filter((r): r is Recommendation => r !== null);
  const labels = recommendations.map((r) => (r.settings ? Object.keys(r.settings).join(' + ') : r.rule.replace('_', '-')));
  return {
    recommendations,
    rules: evaluated.map((e) => e.outcome),
    count: recommendations.length,
    summary: recommendations.length === 0
      ? null
      : `Config advice: ${recommendations.length} recommendation${recommendations.length === 1 ? '' : 's'} (${labels.join('; ')}) — see \`gsd-tools config-advise\``,
  };
}

/** The `{count, summary}` the progress and health payloads carry; `null` if advising itself failed. */
export function configAdviceField(cwd: string): { count: number; summary: string | null } | null {
  try {
    const advice = adviseConfig(cwd);
    return { count: advice.count, summary: advice.summary };
  } catch {
    return null;
  }
}

export function formatConfigAdvice(advice: ConfigAdvice): string {
  if (advice.count === 0) return 'Config advice: nothing to recommend — no signal in .planning/ asks for a knob that is off.\n';
  const lines = [`Config advice (${advice.count}):`];
  advice.recommendations.forEach((r, i) => {
    const what = r.settings
      ? Object.entries(r.settings).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
      : r.rule.replace('_', '-');
    lines.push(`  ${i + 1}. ${what}`, `     why: ${r.reason}`, `     run: ${r.command}`);
  });
  return `${lines.join('\n')}\n`;
}

/** `config-advise [--json]`: human text by default, the `ConfigAdvice` object with `--json`. */
export function cmdConfigAdvise(cwd: string, args: readonly string[], raw: boolean): void {
  const advice = adviseConfig(cwd);
  if (args.includes('--json')) output(advice, raw);
  else output(null, true, formatConfigAdvice(advice));
}
