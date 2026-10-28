/**
 * Retro cadence — when a retro is due by schedule rather than by friction
 * (ADR-5209 §9).
 *
 * retro-signals answers "did this session struggle?". A smooth run of phases
 * never crosses `retro.signal_threshold`, yet the environment still drifts: a
 * journaled check goes silent, a new script is never wired, a guardrail is
 * missing for a class of change the milestone just started making. So a
 * retro is also due on a schedule, under two named triggers:
 *
 *   milestone-start  the milestone is planned (its ROADMAP has phases), no
 *                    phase of it has started executing, it has not shipped,
 *                    and no retro has been held in it yet
 *                    (`retro.at_milestone_start`, default true)
 *   cadence          at least `retro.cadence_phases` phases of the current
 *                    milestone finished executing since the last retro held
 *                    in it (default 2; 0 switches the cadence off)
 *
 * The schedule makes a retro due; it never decides what runs. That stays
 * `retro.auto` (suggest | auto | off) in the router.
 *
 * ── "Since the last retro" is journaled, not inferred ──────────────────
 *
 * `.planning/retro/RUNS.json` records every retro held — each `retro prepare`
 * — with the planning directory it ran in, the milestone, and the phases of
 * that milestone executed at that moment. "Phases since the last retro" is the
 * set difference between the phases executed now and that snapshot. The
 * existing artifacts cannot answer it: a RETRO stem carries a date and no
 * time (several phases finish in one day), file mtimes are reset by every
 * clone and checkout, and a retro that found nothing to propose writes no
 * report at all — yet it was held, and the cadence must restart from it.
 *
 * A phase counts as executed once every plan has a summary (`disk_status`
 * `executed` or `complete`): `execute:post` runs before the verifier marks the
 * phase complete, and the phase that just finished must count there.
 *
 * Counts are scoped to the current milestone: a milestone boundary restarts
 * the count, and `milestone-start` covers the boundary itself. A planning
 * directory (a workstream) keeps its own schedule.
 */

import fs from 'node:fs';
import path from 'node:path';
import { retroDir, writeTextAtomic, isRetroStem, withJournalLock, journalLockPath, defaultJournalLock } from './retro-artifacts.cjs';
import type { JournalLock, SignalFacts } from './retro-artifacts.cjs';
import { DISK_STATUS } from './phase-status.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspaceModule = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap.cjs is an export= CommonJS module
import roadmapModule = require('./roadmap.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParserModule = require('./roadmap-parser.cjs');

const { planningDir, planningPaths } = planningWorkspaceModule;
const { analyzeRoadmap } = roadmapModule;
const { getMilestoneInfo, isMilestoneShippedInRoadmap } = roadmapParserModule;

// ─── Vocabulary ───────────────────────────────────────────────────────────────

/** Why a retro is proposed: friction (retro-signals) or one of the two schedules. */
export const RETRO_TRIGGER = Object.freeze({
  SIGNALS: 'signals',
  MILESTONE_START: 'milestone-start',
  CADENCE: 'cadence',
} as const);

export type RetroTrigger = (typeof RETRO_TRIGGER)[keyof typeof RETRO_TRIGGER];
export type ScheduleTrigger = typeof RETRO_TRIGGER.MILESTONE_START | typeof RETRO_TRIGGER.CADENCE;

export const DEFAULT_CADENCE_PHASES = 2;
export const DEFAULT_AT_MILESTONE_START = true;

/** Executed: every plan has a summary. `complete` adds a passing verification. */
const EXECUTED_STATUSES: ReadonlySet<string> = new Set([DISK_STATUS.EXECUTED, DISK_STATUS.COMPLETE]);
/** Started: execution has begun — a milestone with such a phase is past its start. */
const STARTED_STATUSES: ReadonlySet<string> = new Set([DISK_STATUS.EXECUTED, DISK_STATUS.COMPLETE, DISK_STATUS.PARTIAL]);

// ─── Config ───────────────────────────────────────────────────────────────────

export interface CadenceConfig {
  /** Executed phases since the last retro that make one due; 0 = cadence off. */
  cadencePhases: number;
  atMilestoneStart: boolean;
}

/**
 * `retro.cadence_phases` / `retro.at_milestone_start` as read from config;
 * absent keeps the default, an invalid value keeps the default and is named.
 */
export function resolveCadenceConfig(raw: { cadencePhases?: unknown; atMilestoneStart?: unknown }): { config: CadenceConfig; problems: string[] } {
  const problems: string[] = [];
  let cadencePhases = DEFAULT_CADENCE_PHASES;
  const c = raw.cadencePhases;
  if (c !== undefined && c !== null) {
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) cadencePhases = c;
    else problems.push(`retro.cadence_phases must be an integer >= 0, got ${JSON.stringify(c)} — using ${DEFAULT_CADENCE_PHASES}`);
  }
  let atMilestoneStart = DEFAULT_AT_MILESTONE_START;
  const a = raw.atMilestoneStart;
  if (a !== undefined && a !== null) {
    if (typeof a === 'boolean') atMilestoneStart = a;
    else problems.push(`retro.at_milestone_start must be a boolean, got ${JSON.stringify(a)} — using ${DEFAULT_AT_MILESTONE_START}`);
  }
  return { config: { cadencePhases, atMilestoneStart }, problems };
}

// ─── The runs journal ─────────────────────────────────────────────────────────

export interface RetroRun {
  /** The retro's stem, `RETRO-<date>[-n]`. */
  stem: string;
  /** ISO instant the retro was prepared. */
  at: string;
  /** Project-relative POSIX path of the planning directory it ran in (`.planning`, `.planning/workstreams/x`). */
  planningDir: string;
  /** The current milestone's version then, or null when none could be read. */
  milestone: string | null;
  /** Numbers of that milestone's phases that had finished executing then. */
  executedPhases: string[];
  /**
   * The candidates of this retro a human applied (`retro applied`), so a later
   * retro can tell a proposal that was ignored from one that did not work
   * (ADR-5209 §10). Absent when nothing was applied.
   */
  applied?: AppliedCandidate[];
  /**
   * The signals this retro saw, as ids, fingerprints (kind + key, hashed) and
   * counts — no key, no text. A later retro recognises recurring friction
   * from them after this retro's `.work/` bundle is gone (ADR-5209 §10).
   * Absent on a run journaled before §10.
   */
  signals?: SignalFacts[];
  /** The runtime and its version the retro's session ran (the transcript's record), as code read it. */
  host?: { name: string | null; version: string | null };
  /** The GSD version that ran `retro prepare`, or null. */
  gsdVersion?: string | null;
}

/** Signals journaled on one run, at most. */
export const MAX_RUN_SIGNALS = 100;
const RUN_SIGNAL_RE = /^[a-z][a-z0-9-]{0,40}:[0-9a-f]{6,16}$/;

function runSignalsProblems(v: unknown): string[] {
  if (!Array.isArray(v)) return ['signals must be an array'];
  if (v.length > MAX_RUN_SIGNALS) return [`signals holds at most ${MAX_RUN_SIGNALS} entries, got ${v.length}`];
  const problems: string[] = [];
  v.forEach((raw: unknown, i: number) => {
    const f = (raw && typeof raw === 'object' ? raw : {}) as Partial<SignalFacts>;
    if (typeof f.id !== 'string' || !RUN_SIGNAL_RE.test(f.id)) problems.push(`signals[${i}]: id must be a signal id`);
    if (!(f.fingerprint === null || (typeof f.fingerprint === 'string' && RUN_SIGNAL_RE.test(f.fingerprint)))) problems.push(`signals[${i}]: fingerprint must be a fingerprint or null`);
    if (typeof f.count !== 'number' || !Number.isInteger(f.count) || f.count < 0) problems.push(`signals[${i}]: count must be a non-negative integer`);
  });
  return problems;
}

/** One candidate of a retro a human routed with `/gsd-retro --apply`. */
export interface AppliedCandidate {
  /** `cand-<n>`. */
  candidate: string;
  /** Where it went: quick, capture, user (the human edited their own file) or lesson. */
  route: string;
  /** ISO instant it was recorded. */
  at: string;
}

const APPLIED_CANDIDATE_RE = /^cand-[1-9]\d{0,3}$/;
const APPLIED_ROUTES = Object.freeze(['quick', 'capture', 'user', 'lesson']);

function appliedProblems(a: unknown): string[] {
  if (!a || typeof a !== 'object') return ['applied entry is not an object'];
  const e = a as Partial<AppliedCandidate>;
  const problems: string[] = [];
  if (typeof e.candidate !== 'string' || !APPLIED_CANDIDATE_RE.test(e.candidate)) problems.push(`applied candidate must be cand-<n>, got ${JSON.stringify(e.candidate)}`);
  if (typeof e.route !== 'string' || !APPLIED_ROUTES.includes(e.route)) problems.push(`applied route must be one of ${APPLIED_ROUTES.join(', ')}, got ${JSON.stringify(e.route)}`);
  if (typeof e.at !== 'string' || !ISO_INSTANT_RE.test(e.at) || Number.isNaN(Date.parse(e.at))) problems.push(`applied at must be an ISO instant in UTC, got ${JSON.stringify(e.at)}`);
  return problems;
}

/**
 * The envelope version written. 2 since ADR-5209 §10 added `signals`,
 * `applied`, `host` and `gsdVersion` to a run: a gsd-tools from before §10
 * reads only version 1, so it refuses (journal-invalid, nothing rewritten)
 * instead of rewriting the journal without the fields it does not know.
 * Version 1 journals are still read; the next write upgrades them.
 */
export const RUNS_JOURNAL_VERSION = 2;

export interface RunsJournal {
  version: typeof RUNS_JOURNAL_VERSION;
  runs: RetroRun[];
}

export interface RunsJournalRead {
  status: 'ok' | 'absent' | 'invalid';
  journal: RunsJournal;
  problems: string[];
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const MAX_FIELD = 200;

export function runsJournalPath(projectRoot: string): string {
  return path.join(retroDir(projectRoot), 'RUNS.json');
}

function emptyRuns(): RunsJournal {
  return { version: RUNS_JOURNAL_VERSION, runs: [] };
}

function boundedString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD;
}

/** Problems with one run object; empty when it is well-formed. */
export function runProblems(r: Partial<RetroRun> | null | undefined): string[] {
  if (!r || typeof r !== 'object') return ['not an object'];
  const problems: string[] = [];
  if (typeof r.stem !== 'string' || !isRetroStem(r.stem)) problems.push(`stem must be RETRO-YYYY-MM-DD[-n], got ${JSON.stringify(r.stem)}`);
  if (typeof r.at !== 'string' || !ISO_INSTANT_RE.test(r.at) || Number.isNaN(Date.parse(r.at))) problems.push(`at must be an ISO instant in UTC, got ${JSON.stringify(r.at)}`);
  if (!boundedString(r.planningDir)) problems.push(`planningDir must be a non-empty path, got ${JSON.stringify(r.planningDir)}`);
  if (r.milestone !== null && !boundedString(r.milestone)) problems.push(`milestone must be a version or null, got ${JSON.stringify(r.milestone)}`);
  if (!Array.isArray(r.executedPhases) || !r.executedPhases.every(boundedString)) problems.push('executedPhases must be an array of phase numbers');
  if (r.signals !== undefined) problems.push(...runSignalsProblems(r.signals));
  if (r.host !== undefined) {
    const h = r.host as { name?: unknown; version?: unknown } | null;
    const ok = (v: unknown) => v === null || boundedString(v);
    if (!h || typeof h !== 'object' || !ok(h.name) || !ok(h.version)) problems.push('host must be { name, version }, each a string or null');
  }
  if (r.gsdVersion !== undefined && !(r.gsdVersion === null || boundedString(r.gsdVersion))) problems.push('gsdVersion must be a version or null');
  if (r.applied !== undefined) {
    if (!Array.isArray(r.applied)) problems.push('applied must be an array');
    else r.applied.forEach((a, i) => { for (const p of appliedProblems(a)) problems.push(`applied[${i}]: ${p}`); });
  }
  return problems;
}

/**
 * Parse RUNS.json text. A malformed entry is skipped and named: a run that
 * cannot be read is not silently taken for "no retro was ever held".
 */
export function parseRunsJournal(text: string): RunsJournalRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', journal: emptyRuns(), problems: [`RUNS.json is not JSON: ${(err as Error).message}`] };
  }
  const obj = parsed as { version?: unknown; runs?: unknown };
  if (!obj || typeof obj !== 'object' || (obj.version !== 1 && obj.version !== RUNS_JOURNAL_VERSION) || !Array.isArray(obj.runs)) {
    return { status: 'invalid', journal: emptyRuns(), problems: ['RUNS.json must be { "version": 1 | 2, "runs": [...] }'] };
  }
  const problems: string[] = [];
  const runs: RetroRun[] = [];
  obj.runs.forEach((raw: unknown, i: number) => {
    const r = raw as Partial<RetroRun>;
    const p = runProblems(r);
    if (p.length > 0) {
      problems.push(`runs[${i}]: ${p.join('; ')}`);
      return;
    }
    runs.push({
      stem: r.stem as string,
      at: r.at as string,
      planningDir: r.planningDir as string,
      milestone: r.milestone ?? null,
      executedPhases: [...(r.executedPhases as string[])],
      ...(Array.isArray(r.applied) && r.applied.length > 0 ? { applied: r.applied.map(a => ({ candidate: a.candidate, route: a.route, at: a.at })) } : {}),
      ...(Array.isArray(r.signals) ? { signals: r.signals.map(f => ({ id: f.id, fingerprint: f.fingerprint, count: f.count })) } : {}),
      ...(r.host ? { host: { name: r.host.name ?? null, version: r.host.version ?? null } } : {}),
      ...(r.gsdVersion !== undefined ? { gsdVersion: r.gsdVersion ?? null } : {}),
    });
  });
  return { status: 'ok', journal: { version: RUNS_JOURNAL_VERSION, runs }, problems };
}

export function readRunsJournal(projectRoot: string): RunsJournalRead {
  let text: string;
  try {
    text = fs.readFileSync(runsJournalPath(projectRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', journal: emptyRuns(), problems: [] };
    return { status: 'invalid', journal: emptyRuns(), problems: [`RUNS.json unreadable: ${(err as Error).message}`] };
  }
  return parseRunsJournal(text);
}

/** Stable serialisation: runs in time order, keys in a fixed order. */
export function formatRunsJournal(journal: RunsJournal): string {
  const runs = [...journal.runs].sort((a, b) => a.at.localeCompare(b.at)).map(r => ({
    stem: r.stem,
    at: r.at,
    planningDir: r.planningDir,
    milestone: r.milestone,
    executedPhases: [...r.executedPhases],
    // Written only when there is one: a journal nothing was applied from keeps its bytes.
    ...(r.applied && r.applied.length > 0 ? { applied: r.applied.map(a => ({ candidate: a.candidate, route: a.route, at: a.at })) } : {}),
    ...(r.signals ? { signals: r.signals.map(f => ({ id: f.id, fingerprint: f.fingerprint, count: f.count })) } : {}),
    ...(r.host ? { host: { name: r.host.name, version: r.host.version } } : {}),
    ...(r.gsdVersion !== undefined ? { gsdVersion: r.gsdVersion } : {}),
  }));
  return `${JSON.stringify({ version: RUNS_JOURNAL_VERSION, runs }, null, 2)}\n`;
}

export type RunsEdit = { ok: true; journal: RunsJournal } | { ok: false; reason: string };

export function appendRun(journal: RunsJournal, run: RetroRun): RunsEdit {
  const problems = runProblems(run);
  if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
  return { ok: true, journal: { version: RUNS_JOURNAL_VERSION, runs: [...journal.runs, run] } };
}

// ─── Milestone facts ──────────────────────────────────────────────────────────

export interface MilestoneFacts {
  /** Project-relative POSIX path of the active planning directory. */
  planningDir: string;
  /** ROADMAP.md exists and its current milestone could be analysed. */
  roadmap: boolean;
  milestone: string | null;
  /** The current milestone carries a shipped marker or an archived snapshot. */
  shipped: boolean;
  /** The current milestone's phases, in ROADMAP order, with their `disk_status`. */
  phases: Array<{ number: string; status: string }>;
  problems: string[];
}

function posixRel(projectRoot: string, abs: string): string {
  const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
  return rel === '' ? '.' : rel;
}

/**
 * The current milestone's phases and their status, from the same owner
 * `roadmap analyze` reads (`analyzeRoadmap`). Never throws: what could not be
 * read is a problem, and the schedule then has nothing to be due on.
 */
export function readMilestoneFacts(projectRoot: string): MilestoneFacts {
  const facts: MilestoneFacts = { planningDir: '.planning', roadmap: false, milestone: null, shipped: false, phases: [], problems: [] };
  let roadmapPath: string;
  try {
    facts.planningDir = posixRel(projectRoot, planningDir(projectRoot));
    roadmapPath = planningPaths(projectRoot).roadmap;
  } catch (err) {
    facts.problems.push(`planning directory unresolved: ${(err as Error).message}`);
    return facts;
  }
  let analysis: ReturnType<typeof analyzeRoadmap>;
  try {
    analysis = analyzeRoadmap(projectRoot);
  } catch (err) {
    facts.problems.push(`ROADMAP.md could not be analysed: ${(err as Error).message}`);
    return facts;
  }
  if (!analysis.ok) return facts;
  facts.roadmap = true;
  facts.phases = analysis.analysis.phases.map(p => ({ number: p.number, status: p.disk_status }));
  const info = getMilestoneInfo(projectRoot).value;
  facts.milestone = info ? info.version : null;
  if (facts.milestone !== null) {
    const snapshot = path.join(path.dirname(roadmapPath), 'milestones', `${facts.milestone}-ROADMAP.md`);
    let shippedInRoadmap = false;
    try {
      shippedInRoadmap = isMilestoneShippedInRoadmap(fs.readFileSync(roadmapPath, 'utf8'), facts.milestone);
    } catch (err) {
      facts.problems.push(`ROADMAP.md unreadable: ${(err as Error).message}`);
    }
    facts.shipped = shippedInRoadmap || fs.existsSync(snapshot);
  }
  return facts;
}

/** The phase numbers of the current milestone that finished executing. */
export function executedPhaseNumbers(facts: Pick<MilestoneFacts, 'phases'>): string[] {
  return facts.phases.filter(p => EXECUTED_STATUSES.has(p.status)).map(p => p.number);
}

// ─── The schedule ─────────────────────────────────────────────────────────────

export type RetroDueReason =
  | 'capability-disabled'
  | 'retro-auto-off'
  | 'no-roadmap'
  | 'milestone-shipped'
  | 'journal-invalid'
  | 'milestone-start'
  | 'cadence-reached'
  | 'not-due';

export interface RetroDue {
  due: boolean;
  /** The trigger that made it due (milestone-start before cadence); null when not due. */
  trigger: ScheduleTrigger | null;
  /** Every schedule trigger that fired, whatever the mode. */
  triggers: ScheduleTrigger[];
  reason: RetroDueReason;
  active: boolean;
  mode: 'suggest' | 'auto' | 'off';
  planningDir: string;
  milestone: string | null;
  /** `retro.cadence_phases`; 0 = off. */
  cadencePhases: number;
  atMilestoneStart: boolean;
  phases: { total: number; executed: number; started: number };
  /** Phases of this milestone executed since the baseline; null when the journal cannot be read. */
  phasesSinceRetro: number | null;
  phasesSinceRetroIds: string[] | null;
  /**
   * What the count runs from: the last retro held in this milestone, the
   * milestone's start, or `unknown` when the journal cannot be read.
   */
  baseline: 'retro' | 'milestone' | 'unknown';
  /** The last retro journaled for this planning directory, any milestone; null also when the journal cannot be read. */
  lastRetro: { stem: string; at: string; milestone: string | null } | null;
  /** The newest retro report on disk (`latestRetroStem`), journaled or not. */
  latestReport: string | null;
  /** Project-relative path of the runs journal. */
  journal: string;
  problems: string[];
}

/**
 * Whether a retro is due by schedule. Pure: the facts, the journal and the
 * config in, the answer out. `active`/`mode` only switch `due` off — the
 * counts are reported either way, so a dashboard can show where the schedule
 * stands even while it is silenced.
 *
 * A journal that could not be read whole (`journalProblems` non-empty: not
 * JSON, the wrong shape, or a malformed entry) fails closed: nothing is
 * counted from it, so no trigger fires, the counts and the last retro are
 * null, and the reason is `journal-invalid` — never "no retro yet", which
 * would propose a retro on every stage while a held one could not clear it.
 */
export function computeRetroDue(input: {
  facts: MilestoneFacts;
  runs: readonly RetroRun[];
  config: CadenceConfig;
  active: boolean;
  mode: 'suggest' | 'auto' | 'off';
  /** Why the runs journal could not be read whole; empty when it could. */
  journalProblems?: readonly string[];
  latestReport?: string | null;
  journal?: string;
  problems?: string[];
}): RetroDue {
  const { facts, config } = input;
  const journalProblems = [...(input.journalProblems ?? [])];
  const countable = journalProblems.length === 0;
  const inScope = input.runs.filter(r => r.planningDir === facts.planningDir).sort((a, b) => a.at.localeCompare(b.at));
  const last = inScope.length > 0 ? inScope[inScope.length - 1] : null;
  const inMilestone = inScope.filter(r => r.milestone === facts.milestone);
  const lastInMilestone = inMilestone.length > 0 ? inMilestone[inMilestone.length - 1] : null;

  const executed = executedPhaseNumbers(facts);
  const started = facts.phases.filter(p => STARTED_STATUSES.has(p.status)).length;
  const before = new Set(lastInMilestone ? lastInMilestone.executedPhases : []);
  const since = executed.filter(n => !before.has(n));

  const triggers: ScheduleTrigger[] = [];
  const open = facts.roadmap && !facts.shipped;
  if (countable && open && config.atMilestoneStart && facts.phases.length > 0 && started === 0 && lastInMilestone === null) {
    triggers.push(RETRO_TRIGGER.MILESTONE_START);
  }
  if (countable && open && config.cadencePhases > 0 && since.length >= config.cadencePhases) {
    triggers.push(RETRO_TRIGGER.CADENCE);
  }
  const scheduled = config.cadencePhases > 0 || config.atMilestoneStart;

  let reason: RetroDueReason;
  if (!input.active) reason = 'capability-disabled';
  else if (input.mode === 'off') reason = 'retro-auto-off';
  else if (!facts.roadmap) reason = 'no-roadmap';
  else if (facts.shipped) reason = 'milestone-shipped';
  else if (!countable && scheduled) reason = 'journal-invalid';
  else if (triggers.length > 0) reason = triggers[0] === RETRO_TRIGGER.MILESTONE_START ? 'milestone-start' : 'cadence-reached';
  else reason = 'not-due';
  const due = reason === 'milestone-start' || reason === 'cadence-reached';

  return {
    due,
    trigger: due ? triggers[0] : null,
    triggers,
    reason,
    active: input.active,
    mode: input.mode,
    planningDir: facts.planningDir,
    milestone: facts.milestone,
    cadencePhases: config.cadencePhases,
    atMilestoneStart: config.atMilestoneStart,
    phases: { total: facts.phases.length, executed: executed.length, started },
    phasesSinceRetro: countable ? since.length : null,
    phasesSinceRetroIds: countable ? since : null,
    baseline: !countable ? 'unknown' : lastInMilestone ? 'retro' : 'milestone',
    lastRetro: countable && last ? { stem: last.stem, at: last.at, milestone: last.milestone } : null,
    latestReport: input.latestReport ?? null,
    journal: input.journal ?? '.planning/retro/RUNS.json',
    problems: [...facts.problems, ...journalProblems, ...(input.problems ?? [])],
  };
}

/**
 * The run `retro prepare` journals for a retro with this stem, at this
 * instant; with `signals`, the report's signal facts (at most
 * `MAX_RUN_SIGNALS`, in report order — highest score first).
 */
export function runFor(
  stem: string,
  now: Date,
  facts: MilestoneFacts,
  signals?: readonly SignalFacts[],
  machine?: { host: { name: string | null; version: string | null }; gsdVersion: string | null },
): RetroRun {
  return {
    stem,
    at: now.toISOString(),
    planningDir: facts.planningDir,
    milestone: facts.milestone,
    executedPhases: executedPhaseNumbers(facts),
    ...(signals ? { signals: signals.slice(0, MAX_RUN_SIGNALS).map(f => ({ id: f.id, fingerprint: f.fingerprint, count: f.count })) } : {}),
    ...(machine ? { host: { ...machine.host }, gsdVersion: machine.gsdVersion } : {}),
  };
}

/** The latest run journaled for `stem`, or null. */
export function runOf(runs: readonly RetroRun[], stem: string): RetroRun | null {
  for (let i = runs.length - 1; i >= 0; i--) if (runs[i].stem === stem) return runs[i];
  return null;
}

/** stem → the signal facts its run journaled (the latest run of a stem wins); runs from before §10 carry none. */
export function journaledSignals(runs: readonly RetroRun[]): Map<string, SignalFacts[]> {
  const out = new Map<string, SignalFacts[]>();
  for (const r of runs) if (r.signals) out.set(r.stem, r.signals);
  return out;
}

/**
 * Journal a held retro. The read-append-write runs under the journal's lock:
 * the journal sits under the planning root and every workstream writes it, so
 * two `retro prepare` at once would otherwise lose a run. An unreadable or
 * invalid journal — or one with a malformed entry — is left as it is:
 * rewriting it would erase the history the schedule counts from. A lock that
 * cannot be had writes nothing. Either way the reason is returned.
 */
export function recordRun(projectRoot: string, run: RetroRun, lock: JournalLock = defaultJournalLock): { recorded: boolean; problems: string[] } {
  const file = runsJournalPath(projectRoot);
  const locked = withJournalLock(journalLockPath(projectRoot, file), () => {
    const read = readRunsJournal(projectRoot);
    if (read.status === 'invalid' || read.problems.length > 0) {
      return { recorded: false, problems: [...read.problems, `${posixRel(projectRoot, file)} left unchanged; fix it so the cadence can count from this retro`] };
    }
    const edit = appendRun(read.journal, run);
    if (!edit.ok) return { recorded: false, problems: [edit.reason] };
    writeTextAtomic(file, formatRunsJournal(edit.journal));
    return { recorded: true, problems: [] };
  }, lock);
  return locked.ok ? locked.value : { recorded: false, problems: [locked.reason] };
}

/** Why `recordApplied` wrote nothing. */
export const APPLIED_REFUSAL = Object.freeze({
  JOURNAL_INVALID: 'journal-invalid',
  NO_RUN: 'no-run',
  LOCKED: 'locked',
  INVALID: 'invalid',
} as const);
export type AppliedRefusal = typeof APPLIED_REFUSAL[keyof typeof APPLIED_REFUSAL];

/**
 * Journal that a human applied a candidate of the retro `stem`, on that
 * retro's run. Applying the same candidate twice keeps the first record. The
 * same rules as `recordRun`: under the lock, and a journal that cannot be read
 * whole is left as it is. A retro with no run (held before RUNS.json existed)
 * cannot take one: a run invented now would restart the schedule's count.
 */
export function recordApplied(
  projectRoot: string,
  stem: string,
  entry: AppliedCandidate,
  lock: JournalLock = defaultJournalLock,
): { recorded: boolean; already: boolean; refusal: AppliedRefusal | null; problems: string[] } {
  const bad = appliedProblems(entry);
  if (bad.length > 0) return { recorded: false, already: false, refusal: APPLIED_REFUSAL.INVALID, problems: bad };
  const file = runsJournalPath(projectRoot);
  const locked = withJournalLock(journalLockPath(projectRoot, file), () => {
    const read = readRunsJournal(projectRoot);
    if (read.status === 'invalid' || read.problems.length > 0) {
      return { recorded: false, already: false, refusal: APPLIED_REFUSAL.JOURNAL_INVALID, problems: [...read.problems, `${posixRel(projectRoot, file)} left unchanged`] };
    }
    const runs = read.journal.runs;
    const index = runs.map(r => r.stem).lastIndexOf(stem);
    if (index < 0) return { recorded: false, already: false, refusal: APPLIED_REFUSAL.NO_RUN, problems: [`no run of ${stem} in ${posixRel(projectRoot, file)}`] };
    const run = runs[index];
    if ((run.applied ?? []).some(a => a.candidate === entry.candidate)) return { recorded: false, already: true, refusal: null, problems: [] };
    const next = runs.map((r, i) => (i === index ? { ...r, applied: [...(r.applied ?? []), entry] } : r));
    writeTextAtomic(file, formatRunsJournal({ version: RUNS_JOURNAL_VERSION, runs: next }));
    return { recorded: true, already: false, refusal: null, problems: [] };
  }, lock);
  return locked.ok ? locked.value : { recorded: false, already: false, refusal: APPLIED_REFUSAL.LOCKED, problems: [locked.reason] };
}

/** `stem:cand` of every candidate the runs journal records as applied. */
export function appliedFromRuns(runs: readonly RetroRun[]): Set<string> {
  const out = new Set<string>();
  for (const r of runs) for (const a of r.applied ?? []) out.add(`${r.stem}:${a.candidate}`);
  return out;
}

export function runsJournalRelPath(projectRoot: string): string {
  return posixRel(projectRoot, runsJournalPath(projectRoot));
}
