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
 *                    in it (default 3; 0 switches the cadence off)
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
import type { JournalLock } from './retro-artifacts.cjs';
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

export const DEFAULT_CADENCE_PHASES = 3;
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
}

export interface RunsJournal {
  version: 1;
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
  return { version: 1, runs: [] };
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
  if (!obj || typeof obj !== 'object' || obj.version !== 1 || !Array.isArray(obj.runs)) {
    return { status: 'invalid', journal: emptyRuns(), problems: ['RUNS.json must be { "version": 1, "runs": [...] }'] };
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
    });
  });
  return { status: 'ok', journal: { version: 1, runs }, problems };
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
  }));
  return `${JSON.stringify({ version: 1, runs }, null, 2)}\n`;
}

export type RunsEdit = { ok: true; journal: RunsJournal } | { ok: false; reason: string };

export function appendRun(journal: RunsJournal, run: RetroRun): RunsEdit {
  const problems = runProblems(run);
  if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
  return { ok: true, journal: { version: 1, runs: [...journal.runs, run] } };
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

/** The run `retro prepare` journals for a retro with this stem, at this instant. */
export function runFor(stem: string, now: Date, facts: MilestoneFacts): RetroRun {
  return {
    stem,
    at: now.toISOString(),
    planningDir: facts.planningDir,
    milestone: facts.milestone,
    executedPhases: executedPhaseNumbers(facts),
  };
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

export function runsJournalRelPath(projectRoot: string): string {
  return posixRel(projectRoot, runsJournalPath(projectRoot));
}
