'use strict';
/**
 * Retro command router — CLI dispatcher for `gsd-tools retro` (ADR-5209).
 *
 * Follows `src/refactor-trigger-command-router.cts`: `routeHubCommandFamily`,
 * `makeInvalidArgs` for usage failures, `output(value, raw)` for results, a
 * capability-active gate. The deterministic halves of `/gsd-retro` live here;
 * the model (gsd-retro-analyst) only reads what `prepare` hands it.
 *
 *   signals     friction report for one session (retro-signals), or with
 *               `--decide` the lifecycle answer skip | suggest | auto
 *   stage       `signals --decide` as a loop-point command step (ship:post,
 *               execute:post): the stage answer of loop-hook-dispatch.md
 *   inventory   what the environment already enforces (retro-inventory)
 *   prepare     the analyst's input bundle + this retro's artifact paths
 *   candidates  validate the analyst's candidates against that bundle
 *   checks      the accepted-checks journal: status | record | retire
 *
 * Arg indexing:
 *   args[0] = 'retro'      (family — matched by dispatchCapabilityCommand)
 *   args[1] = subcommand
 *   args[2..] = flags      (`--flag value` or `--flag=value`)
 *
 * Async note: reading a transcript is streamed (session-transcript
 * `readSession` is async) and dispatchCapabilityCommand refuses a router that
 * returns a Promise. As in profile-pipeline-command-router, the async half is
 * started without being returned; argument validation and session selection
 * stay synchronous so every usage error still goes through `error()`, and a
 * rejection is reported by `reportRejection` (stderr + `process.exitCode`)
 * instead of throwing from a detached chain.
 */

import path from 'node:path';
import fs from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExit = require('./cli-exit.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import commandRoutingHub = require('./command-routing-hub.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityStateMod = require('./capability-state.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationMod = require('./capability-activation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
import { resolveRuntime, formatGsdSlashFor } from './runtime-slash.cjs';
import {
  findProjectSessions,
  selectSession,
  readSession,
  transcriptSupport,
  eventContext,
  formatPointer,
} from './session-transcript.cjs';
import type { ProjectSessions, SessionFile, SessionTranscript } from './session-transcript.cjs';
import {
  computeRetroSignals,
  collectPlanningEvidence,
  collectGitReverts,
} from './retro-signals.cjs';
import type { RetroSignalReport } from './retro-signals.cjs';
import { buildRetroInventory } from './retro-inventory.cjs';
import type { RetroInventory } from './retro-inventory.cjs';
import {
  nextRetroPaths,
  retroPathsFor,
  latestRetroStem,
  writeBundle,
  writeTextAtomic,
  readChecksJournal,
  checksJournalPath,
  formatChecksJournal,
  recordCheck,
  retireCheck,
  countCheckFires,
  checksStatus,
  validateCandidates,
  inventoryRefs,
  CHECK_KINDS,
} from './retro-artifacts.cjs';
import type { ChecksStatus, CheckKind, RetroPaths } from './retro-artifacts.cjs';

const { output, ERROR_REASON, formatDiagnosticToken, getJsonErrorMode } = io;
const { ExitError } = cliExit;
const { makeInvalidArgs } = commandRoutingHub;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { isCapabilityActive } = capabilityStateMod;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { readScopedConfigValue } = planningWorkspaceMod;

const CAPABILITY_ID = 'retro';
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 200;

// ─── Config ───────────────────────────────────────────────────────────────────

/** The `retro.*` threshold keys `resolveRetroThresholds` reads (retro-signals). */
const RETRO_THRESHOLD_KEYS = Object.freeze([
  'signal_threshold', 'kind_cap', 'volume_calls', 'volume_turns', 'repeat_call_min', 'repeat_error_min', 'reread_min', 'edit_churn_min',
  'nav_streak_min', 'checker_loop_min', 'checkpoint_min', 'hook_block_min',
  'excerpt_window', 'max_signals', 'excerpt_chars',
] as const);

type RetroAutoMode = 'suggest' | 'auto' | 'off';
const RETRO_AUTO_MODES: readonly RetroAutoMode[] = ['suggest', 'auto', 'off'];

/** `retro.auto` as a mode; anything but the three values keeps `suggest` and is named. */
function resolveRetroAuto(value: unknown): { mode: RetroAutoMode; problem: string | null } {
  if (value === undefined || value === null) return { mode: 'suggest', problem: null };
  if (typeof value === 'string' && (RETRO_AUTO_MODES as readonly string[]).includes(value)) return { mode: value as RetroAutoMode, problem: null };
  return { mode: 'suggest', problem: `retro.auto must be one of ${RETRO_AUTO_MODES.join(', ')}, got ${JSON.stringify(value)} — using suggest` };
}

interface RetroConfig {
  active: boolean;
  mode: RetroAutoMode;
  problems: string[];
  /** Flat `retro.<key>` values a project actually set, for `resolveRetroThresholds`. */
  thresholdConfig: Record<string, unknown>;
  checkStaleDays: number;
}

function readRetroConfig(cwd: string): RetroConfig {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;
  const config = loadConfig(cwd);
  // The project's own config.json first, uncoerced: loadConfig puts the schema
  // default in place of an invalid value, which would hide a typo instead of
  // naming it. Global defaults and the schema default come after.
  const read = (key: string): { found: boolean; value: unknown } => {
    const scoped = readScopedConfigValue(cwd, ['retro', key]);
    if (scoped.present) return { found: true, value: scoped.value };
    return resolveConfigKey(`retro.${key}`, { config, cwd, registry, quiet: true });
  };
  const thresholdConfig: Record<string, unknown> = {};
  for (const key of RETRO_THRESHOLD_KEYS) {
    const r = read(key);
    if (r.found) thresholdConfig[`retro.${key}`] = r.value;
  }
  const auto = resolveRetroAuto(read('auto').value);
  const problems = auto.problem ? [auto.problem] : [];
  const staleRaw = read('check_stale_days').value;
  let checkStaleDays = 30;
  if (staleRaw !== undefined && staleRaw !== null) {
    if (typeof staleRaw === 'number' && Number.isInteger(staleRaw) && staleRaw >= 1) checkStaleDays = staleRaw;
    else problems.push(`retro.check_stale_days must be an integer >= 1, got ${JSON.stringify(staleRaw)} — using 30`);
  }
  return { active: isCapabilityActive(CAPABILITY_ID, cwd), mode: auto.mode, problems, thresholdConfig, checkStaleDays };
}

function retroSlash(cwd: string): string {
  const s = formatGsdSlashFor(cwd, 'retro');
  return typeof s === 'string' ? s : '/gsd-retro';
}

function disabledResponse(): { disabled: true; message: string } {
  return { disabled: true, message: 'retro is not enabled. Enable with: gsd config-set retro.enabled true' };
}

// ─── Decision ─────────────────────────────────────────────────────────────────

type RetroDecisionKind = 'skip' | 'suggest' | 'auto';

interface RetroDecision {
  decision: RetroDecisionKind;
  reason: 'capability-disabled' | 'retro-auto-off' | 'below-threshold' | 'threshold-reached';
  mode: RetroAutoMode;
  score: number | null;
  threshold: number | null;
  session: string | null;
  status: RetroSignalReport['status'] | null;
  /** What to run when the answer is not skip. */
  command: string | null;
  /** The one line a suggest prints; null otherwise. */
  message: string | null;
  /** What the host dispatches on `auto` (loop-hook-dispatch.md stage answer); null on skip. */
  next: { skill: 'retro'; args: string } | null;
  problems: string[];
}

/**
 * The lifecycle answer for a loop point (ship:post, end of execute-phase):
 * skip below the threshold or when switched off; otherwise what `retro.auto`
 * says. `auto` licenses spawning the analyst, never applying its candidates.
 */
function decideRetro(input: {
  active: boolean;
  mode: RetroAutoMode;
  report: Pick<RetroSignalReport, 'score' | 'threshold' | 'session' | 'status'> | null;
  problems?: string[];
  /** The retro command in the runtime's own slash form (default `/gsd-retro`). */
  slash?: string;
}): RetroDecision {
  const r = input.report;
  const base = {
    mode: input.mode,
    score: r ? r.score : null,
    threshold: r ? r.threshold : null,
    session: r ? r.session : null,
    status: r ? r.status : null,
    problems: [...(input.problems ?? [])],
  };
  const skip = (reason: RetroDecision['reason']): RetroDecision => ({ ...base, decision: 'skip', reason, command: null, message: null, next: null });
  if (!input.active) return skip('capability-disabled');
  if (input.mode === 'off') return skip('retro-auto-off');
  if (!r || r.score < r.threshold) return skip('below-threshold');
  const slash = input.slash ?? '/gsd-retro';
  const args = r.session ? `--session ${r.session}` : '';
  const command = args === '' ? slash : `${slash} ${args}`;
  return {
    ...base,
    decision: input.mode,
    reason: 'threshold-reached',
    command,
    message: input.mode === 'suggest' ? `This session struggled (friction ${r.score} >= ${r.threshold}): run ${command}` : null,
    next: { skill: 'retro', args },
  };
}

// ─── Arguments ────────────────────────────────────────────────────────────────

type Invalid = ReturnType<typeof makeInvalidArgs>;

function isInvalid(v: unknown): v is Invalid {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false;
}

/** The value of `--name value` / `--name=value`; null when absent; Invalid when the value is missing. */
function flagValue(args: readonly string[], name: string, usage: string): string | null | Invalid {
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) return makeInvalidArgs(name, `${name} needs a value. ${usage}`, ERROR_REASON.USAGE);
      return v;
    }
    if (a.startsWith(`${name}=`)) {
      const v = a.slice(name.length + 1);
      if (v === '') return makeInvalidArgs(name, `${name} needs a value. ${usage}`, ERROR_REASON.USAGE);
      return v;
    }
  }
  return null;
}

const DURATION_RE = /^([1-9]\d{0,4})([hdw])$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({ h: 60 * 60 * 1000, d: DAY_MS, w: 7 * DAY_MS });

/**
 * A `--since` window as an instant: a duration back from `now` (`12h`, `7d`,
 * `2w`), a bare date at 00:00 UTC, or a date-time carrying its offset. Null
 * for anything else — never re-read as something looser.
 */
function parseSince(value: string, now: Date): number | null {
  const d = DURATION_RE.exec(value);
  if (d) return now.getTime() - Number(d[1]) * UNIT_MS[d[2]];
  if (DATE_ONLY_RE.test(value) || DATE_TIME_RE.test(value)) {
    const iso = DATE_ONLY_RE.test(value) ? `${value}T00:00:00Z` : value;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    // Reject dates the parser rolled over (2026-02-30 → March 2).
    if (new Date(ms).toISOString().slice(0, 10) !== value.slice(0, 10) && DATE_ONLY_RE.test(value)) return null;
    return ms;
  }
  return null;
}

interface Selection {
  sessionId: string | null;
  sinceMs: number | null;
  sessionsDir: string | null;
}

const SELECTION_USAGE = 'Usage: gsd-tools retro <signals|prepare> [--session <id>|--last] [--since <12h|7d|2w|YYYY-MM-DD>] [--sessions-dir <dir>]';

function parseSelection(args: readonly string[], now: Date): Selection | Invalid {
  const session = flagValue(args, '--session', SELECTION_USAGE);
  if (isInvalid(session)) return session;
  if (session !== null && args.includes('--last')) {
    return makeInvalidArgs('--session', `--session and --last both pick a session. ${SELECTION_USAGE}`, ERROR_REASON.USAGE);
  }
  const since = flagValue(args, '--since', SELECTION_USAGE);
  if (isInvalid(since)) return since;
  let sinceMs: number | null = null;
  if (since !== null) {
    sinceMs = parseSince(since, now);
    if (sinceMs === null) return makeInvalidArgs('--since', `--since ${formatDiagnosticToken(since)} is not a duration (12h, 7d, 2w) or a date. ${SELECTION_USAGE}`, ERROR_REASON.USAGE);
  }
  const sessionsDir = flagValue(args, '--sessions-dir', SELECTION_USAGE);
  if (isInvalid(sessionsDir)) return sessionsDir;
  return { sessionId: session, sinceMs, sessionsDir: sessionsDir === null ? null : path.resolve(sessionsDir) };
}

// ─── Async reporting ──────────────────────────────────────────────────────────

/**
 * A rejection of the detached async half: an ExitError keeps its code; any
 * other error is written the way `error()` writes it, with `process.exitCode`
 * set in place — calling `error()` here would throw from a chain nothing
 * awaits (profile-pipeline-command-router `_handlePipelineRejection`).
 */
function reportRejection(e: unknown): void {
  if (e instanceof ExitError) {
    if (e.hasUserMessage && e.code !== 0) process.stderr.write(`${e.message}\n`);
    process.exitCode = e.code;
    return;
  }
  const message = e instanceof Error ? e.message : String(e);
  if (getJsonErrorMode()) process.stderr.write(`${JSON.stringify({ ok: false, reason: ERROR_REASON.UNKNOWN, message })}\n`);
  else process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}

// ─── Gathering ────────────────────────────────────────────────────────────────

interface SessionPick {
  /** The session to read, or null with the reason none can be. */
  session: SessionFile | null;
  found: ProjectSessions | null;
  unavailable: string | null;
}

/**
 * Synchronous half of session selection, so an unknown `--session` is a
 * usage error before anything is read. Runtimes without a transcript adapter
 * and projects with no recorded sessions are not errors: the report says
 * which sources it could not read.
 */
function pickSession(cwd: string, sel: Selection): SessionPick | Invalid {
  const support = transcriptSupport(resolveRuntime(cwd));
  if (support.status === 'degraded') return { session: null, found: null, unavailable: support.reason };
  const found = findProjectSessions({ projectRoot: cwd, sessionsDir: sel.sessionsDir });
  if (found.status === 'degraded') return { session: null, found, unavailable: found.reason };
  const session = selectSession(found, { sessionId: sel.sessionId });
  if (session) return { session, found, unavailable: null };
  if (sel.sessionId !== null) {
    return makeInvalidArgs('--session', `no Claude Code session ${formatDiagnosticToken(sel.sessionId)} is recorded for this project`, ERROR_REASON.USAGE);
  }
  return { session: null, found, unavailable: 'no Claude Code sessions recorded for this project' };
}

function firstTimestampMs(t: SessionTranscript | null): number | null {
  if (!t) return null;
  for (const ev of t.events) {
    if (!ev.ptr.timestamp) continue;
    const ms = Date.parse(ev.ptr.timestamp);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

async function gatherSignals(cwd: string, sel: Selection, pick: SessionPick, cfg: RetroConfig, now: Date): Promise<{ report: RetroSignalReport; transcript: SessionTranscript | null }> {
  const transcript = pick.session ? await readSession(pick.session) : null;
  // The evidence window: what the caller asked for, else the session's own
  // start, else a week — reverts and gaps_found from long before the session
  // are not this session's friction.
  const sinceMs = sel.sinceMs ?? firstTimestampMs(transcript) ?? now.getTime() - 7 * DAY_MS;
  const planning = collectPlanningEvidence(cwd, { sinceMs });
  const git = collectGitReverts(cwd, { since: new Date(sinceMs).toISOString() });
  const report = computeRetroSignals({
    transcript,
    planning,
    git,
    config: cfg.thresholdConfig,
    transcriptUnavailable: transcript ? null : pick.unavailable,
  });
  report.reasons.unshift(...cfg.problems);
  return { report, transcript };
}

function rulesRegistryPath(cwd: string): string | undefined {
  const p = path.join(cwd, '.plans', 'rules-registry', 'merged.json');
  return fs.existsSync(p) ? p : undefined;
}

function inventoryFor(cwd: string): RetroInventory {
  return buildRetroInventory(cwd, { rulesRegistryPath: rulesRegistryPath(cwd) });
}

/**
 * Firings of every journaled check over the sessions of the last
 * `staleDays` days. `windowDays` is how far back the read transcripts
 * actually reach: the full window when the project has older sessions too,
 * otherwise the age of its oldest session.
 */
async function gatherChecksStatus(cwd: string, sessionsDir: string | null, cfg: RetroConfig, now: Date, maxSessions: number): Promise<ChecksStatus | null> {
  const read = readChecksJournal(cwd);
  if (read.status === 'absent') return null;
  const reasons = [...read.problems];
  const support = transcriptSupport(resolveRuntime(cwd));
  const transcripts: SessionTranscript[] = [];
  let windowDays = 0;
  let transcriptsRead = false;
  if (support.status === 'degraded') {
    reasons.push(support.reason);
  } else {
    const found = findProjectSessions({ projectRoot: cwd, sessionsDir });
    if (found.status === 'degraded') {
      reasons.push(found.reason ?? 'sessions unavailable');
    } else {
      const cutoff = now.getTime() - cfg.checkStaleDays * DAY_MS;
      const inWindow = found.sessions.filter(s => s.modified.getTime() >= cutoff);
      const scanned = inWindow.slice(0, maxSessions);
      if (inWindow.length > scanned.length) reasons.push(`read the newest ${scanned.length} of ${inWindow.length} sessions in the window`);
      for (const s of scanned) {
        const t = await readSession(s);
        if (t.status === 'degraded' && t.reason) reasons.push(t.reason);
        transcripts.push(t);
      }
      transcriptsRead = scanned.length > 0;
      const oldest = found.sessions.length > 0 ? found.sessions[found.sessions.length - 1].modified.getTime() : now.getTime();
      const reach = inWindow.length > scanned.length
        ? now.getTime() - scanned[scanned.length - 1].modified.getTime()
        : now.getTime() - oldest;
      windowDays = Math.min(cfg.checkStaleDays, Math.floor(reach / DAY_MS));
      if (!transcriptsRead) reasons.push(`no session in the last ${cfg.checkStaleDays} day(s)`);
    }
  }
  return checksStatus({
    journal: read.journal,
    fires: countCheckFires(read.journal.checks, transcripts),
    now,
    staleDays: cfg.checkStaleDays,
    windowDays,
    sessionsScanned: transcripts.length,
    transcriptsRead,
    reasons,
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

interface Env {
  args: string[];
  cwd: string;
  raw: boolean;
  now: Date;
}

function handleSignals(env: Env, stage = false): Invalid | undefined {
  const sel = parseSelection(env.args, env.now);
  if (isInvalid(sel)) return sel;
  const decide = stage || env.args.includes('--decide');
  const cfg = readRetroConfig(env.cwd);
  if (!cfg.active || (decide && cfg.mode === 'off')) {
    // Nothing is read when the answer cannot depend on it.
    output(decide ? decideRetro({ active: cfg.active, mode: cfg.mode, report: null, problems: cfg.problems }) : disabledResponse(), env.raw);
    return undefined;
  }
  const pick = pickSession(env.cwd, sel);
  if (isInvalid(pick)) return pick;
  gatherSignals(env.cwd, sel, pick, cfg, env.now)
    .then(({ report }) => {
      output(decide ? decideRetro({ active: true, mode: cfg.mode, report, problems: cfg.problems, slash: retroSlash(env.cwd) }) : report, env.raw);
    })
    .catch(reportRejection);
  return undefined;
}

function handleInventory(env: Env): undefined {
  const cfg = readRetroConfig(env.cwd);
  output(cfg.active ? inventoryFor(env.cwd) : disabledResponse(), env.raw);
  return undefined;
}

function signalContexts(report: RetroSignalReport, transcript: SessionTranscript | null, window: number, maxChars: number): Record<string, Array<{ pointer: string; kind: string; text: string }>> {
  const out: Record<string, Array<{ pointer: string; kind: string; text: string }>> = {};
  if (!transcript) return out;
  for (const s of report.signals) {
    const first = s.pointers[0];
    if (!first || first.source !== 'transcript') continue;
    const index = transcript.events.findIndex(e => e.ptr.file === first.file && e.ptr.line === first.line);
    if (index < 0) continue;
    out[s.id] = eventContext(transcript.events, index, window, maxChars).map(c => ({ pointer: formatPointer(c.ptr), kind: c.kind, text: c.text }));
  }
  return out;
}

function handlePrepare(env: Env): Invalid | undefined {
  const sel = parseSelection(env.args, env.now);
  if (isInvalid(sel)) return sel;
  const cfg = readRetroConfig(env.cwd);
  if (!cfg.active) {
    output(disabledResponse(), env.raw);
    return undefined;
  }
  const pick = pickSession(env.cwd, sel);
  if (isInvalid(pick)) return pick;
  const run = async () => {
    const { report, transcript } = await gatherSignals(env.cwd, sel, pick, cfg, env.now);
    const inventory = inventoryFor(env.cwd);
    const checks = await gatherChecksStatus(env.cwd, sel.sessionsDir, cfg, env.now, DEFAULT_MAX_SESSIONS);
    const paths = nextRetroPaths(env.cwd, env.now.toISOString().slice(0, 10));
    const bundle = {
      version: 1,
      stem: paths.stem,
      createdAt: env.now.toISOString(),
      runtime: resolveRuntime(env.cwd),
      paths: { report: paths.report, candidates: paths.candidates, patches: paths.patches },
      report,
      contexts: signalContexts(report, transcript, report.thresholds.excerptWindow, report.thresholds.excerptChars),
      inventory,
      checks,
      evidence: {
        signals: [...report.signals.map(s => s.id), ...report.omitted.map(s => s.id)],
        inventory: inventoryRefs(inventory.findings),
        checks: checks ? checks.removalCandidates : [],
      },
    };
    writeBundle(env.cwd, paths, bundle);
    output({
      stem: paths.stem,
      bundle: paths.bundle,
      report: paths.report,
      candidates: paths.candidates,
      patches: paths.patches,
      status: report.status,
      score: report.score,
      threshold: report.threshold,
      suggest: report.suggest,
      session: report.session,
      signals: report.signals.length,
      omitted: report.omitted.length,
      inventoryFindings: inventory.findings.length,
      removalCandidates: checks ? checks.removalCandidates.length : 0,
    }, env.raw);
  };
  run().catch(reportRejection);
  return undefined;
}

const CANDIDATES_USAGE = 'Usage: gsd-tools retro candidates [--retro <RETRO-YYYY-MM-DD[-n]>] [--id <cand-n>]';

function readJsonFile(abs: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(abs, 'utf8')) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

function handleCandidates(env: Env): Invalid | undefined {
  const stemArg = flagValue(env.args, '--retro', CANDIDATES_USAGE);
  if (isInvalid(stemArg)) return stemArg;
  const idArg = flagValue(env.args, '--id', CANDIDATES_USAGE);
  if (isInvalid(idArg)) return idArg;
  const cfg = readRetroConfig(env.cwd);
  if (!cfg.active) {
    output(disabledResponse(), env.raw);
    return undefined;
  }
  const stem = stemArg ?? latestRetroStem(env.cwd);
  if (stem === null) return makeInvalidArgs('--retro', `no retro candidates under .planning/retro/. ${CANDIDATES_USAGE}`, ERROR_REASON.USAGE);
  let paths: RetroPaths;
  try {
    paths = retroPathsFor(env.cwd, stem);
  } catch {
    return makeInvalidArgs('--retro', `${formatDiagnosticToken(stem)} is not a retro stem. ${CANDIDATES_USAGE}`, ERROR_REASON.USAGE);
  }
  const candidates = readJsonFile(path.join(env.cwd, paths.candidates));
  if (!candidates.ok) return makeInvalidArgs('--retro', `cannot read ${paths.candidates}: ${candidates.reason}`, ERROR_REASON.USAGE);
  const bundle = readJsonFile(path.join(env.cwd, paths.bundle));
  const ev = bundle.ok ? (bundle.value as { evidence?: { signals?: string[]; inventory?: string[]; checks?: string[] } }).evidence ?? {} : {};
  const result = validateCandidates(candidates.value, {
    signals: new Set(ev.signals ?? []),
    inventory: new Set(ev.inventory ?? []),
    checks: new Set(ev.checks ?? []),
  }, { projectRoot: env.cwd, patchesDir: paths.patches });
  if (idArg !== null) {
    const hit = result.valid.find(c => c.id === idArg);
    if (!hit) {
      const dropped = result.dropped.find(d => d.id === idArg);
      return makeInvalidArgs('--id', dropped
        ? `${formatDiagnosticToken(idArg)} was dropped: ${dropped.reasons.join('; ')}`
        : `no candidate ${formatDiagnosticToken(idArg)} in ${paths.candidates}`, ERROR_REASON.USAGE);
    }
    output({ retro: stem, report: paths.report, candidate: hit }, env.raw);
    return undefined;
  }
  output({
    retro: stem,
    report: paths.report,
    bundle: bundle.ok ? paths.bundle : null,
    // Without the bundle no evidence can be checked, so every candidate is dropped as unknown-signal — said, not hidden.
    problems: bundle.ok ? [] : [`bundle ${paths.bundle} unreadable: ${bundle.reason}`],
    valid: result.valid,
    dropped: result.dropped,
  }, env.raw);
  return undefined;
}

const CHECKS_USAGE = 'Usage: gsd-tools retro checks [status [--sessions-dir <dir>] [--max-sessions N] | record --id <id> --kind <kind> --match <literal> [--retro <stem>] [--candidate <cand-n>] [--signal <id>] | retire --id <id>]';

function handleChecks(env: Env): Invalid | undefined {
  const action = env.args[2] && !env.args[2].startsWith('--') ? env.args[2] : 'status';
  if (!['status', 'record', 'retire'].includes(action)) {
    return makeInvalidArgs('action', `unknown checks action ${formatDiagnosticToken(action)}. ${CHECKS_USAGE}`, ERROR_REASON.USAGE);
  }
  const cfg = readRetroConfig(env.cwd);
  if (!cfg.active) {
    output(disabledResponse(), env.raw);
    return undefined;
  }
  if (action === 'status') {
    const sessionsDir = flagValue(env.args, '--sessions-dir', CHECKS_USAGE);
    if (isInvalid(sessionsDir)) return sessionsDir;
    const maxRaw = flagValue(env.args, '--max-sessions', CHECKS_USAGE);
    if (isInvalid(maxRaw)) return maxRaw;
    const max = maxRaw === null ? DEFAULT_MAX_SESSIONS : Number(maxRaw);
    if (!Number.isInteger(max) || max < 1) return makeInvalidArgs('--max-sessions', `--max-sessions must be a positive integer. ${CHECKS_USAGE}`, ERROR_REASON.USAGE);
    gatherChecksStatus(env.cwd, sessionsDir === null ? null : path.resolve(sessionsDir), cfg, env.now, max)
      .then(status => output(status ?? { journal: 'absent', checks: [], removalCandidates: [] }, env.raw))
      .catch(reportRejection);
    return undefined;
  }
  const id = flagValue(env.args, '--id', CHECKS_USAGE);
  if (isInvalid(id)) return id;
  if (id === null) return makeInvalidArgs('--id', `--id is required. ${CHECKS_USAGE}`, ERROR_REASON.USAGE);
  const read = readChecksJournal(env.cwd);
  if (read.status === 'invalid') {
    return makeInvalidArgs('journal', `${path.relative(env.cwd, checksJournalPath(env.cwd))} is invalid (${read.problems.join('; ')}); fix it before editing`, ERROR_REASON.USAGE);
  }
  let edit;
  if (action === 'retire') {
    edit = retireCheck(read.journal, id);
  } else {
    const fields: Record<string, string | null> = {};
    for (const f of ['--kind', '--match', '--retro', '--candidate', '--signal']) {
      const v = flagValue(env.args, f, CHECKS_USAGE);
      if (isInvalid(v)) return v;
      fields[f] = v;
    }
    if (fields['--kind'] === null || fields['--match'] === null) {
      return makeInvalidArgs('--kind', `record needs --kind (${CHECK_KINDS.join(', ')}) and --match. ${CHECKS_USAGE}`, ERROR_REASON.USAGE);
    }
    edit = recordCheck(read.journal, {
      id,
      kind: fields['--kind'] as CheckKind,
      match: fields['--match'],
      acceptedAt: env.now.toISOString().slice(0, 10),
      source: { retro: fields['--retro'], candidate: fields['--candidate'], signal: fields['--signal'] },
    });
  }
  if (!edit.ok) return makeInvalidArgs('--id', edit.reason, ERROR_REASON.USAGE);
  writeTextAtomic(checksJournalPath(env.cwd), formatChecksJournal(edit.journal));
  output({ action, id, journal: path.relative(env.cwd, checksJournalPath(env.cwd)).split(path.sep).join('/'), checks: edit.journal.checks.length }, env.raw);
  return undefined;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

interface RouteRetroCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: the clock. Production callers omit it. */
  _now?: () => Date;
}

function routeRetroCommand({ args, cwd, raw, error, _now }: RouteRetroCommandOptions): void {
  const env: Env = { args, cwd, raw, now: (_now ?? (() => new Date()))() };
  routeHubCommandFamily({
    family: 'retro',
    args,
    // Alphabetical for a stable unknown-subcommand message.
    subcommands: ['candidates', 'checks', 'inventory', 'prepare', 'signals', 'stage'],
    handlers: {
      candidates: () => handleCandidates(env),
      checks: () => handleChecks(env),
      inventory: () => handleInventory(env),
      prepare: () => handlePrepare(env),
      signals: () => handleSignals(env),
      // A loop-point command step is `retro stage --phase N`: the phase is the
      // host's, the session is still the newest one, so `--phase` is ignored.
      stage: () => handleSignals(env, true),
    },
    unknownMessage: (subcommand: string, available: string[]) =>
      `Unknown retro subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export = {
  routeRetroCommand,
  decideRetro,
  resolveRetroAuto,
  parseSince,
  RETRO_THRESHOLD_KEYS,
};
