/**
 * Retro artifacts — the `.planning/retro/` layout, the accepted-checks journal
 * and the candidate contract of `/gsd-retro` (ADR-5209).
 *
 * retro-signals decides whether a session struggled and retro-inventory says
 * what the environment already enforces; this module owns what a retro leaves
 * behind and what it may claim:
 *
 *   .planning/retro/RETRO-<date>.md          the analyst's report (human)
 *   .planning/retro/RETRO-<date>.json        its candidates (machine, validated here)
 *   .planning/retro/patches/RETRO-<date>/    proposed patches, one per candidate, never applied
 *   .planning/retro/CHECKS.json              checks a human accepted, for the removal loop
 *   .planning/retro/.work/                   the analyst's input bundle — self-ignoring
 *
 * The retro directory sits under the planning ROOT, not a workstream: the
 * environment (lint rules, hooks, CLAUDE.md) belongs to the repository, so
 * every workstream sees the same journal.
 *
 * ── Candidates are claims, checked here ────────────────────────────────
 *
 * The analyst is a model; what it may assert is not left to its judgement.
 * A candidate that names no signal the bundle actually carries is dropped
 * (`unknown-signal`) — Pocock's own failure mode is inventing generic advice
 * under each category once the session's middle is forgotten. A judgement
 * candidate aimed at CLAUDE.md / AGENTS.md is dropped
 * (`judgement-in-steering-file`): standards belong to the reviewer, who has the
 * least context pressure, not to every agent's prompt. A mechanical candidate
 * without a command that shows the check firing is dropped (`missing-verify`).
 * Every candidate names the layer that owns its cause (`project`, `user`,
 * `gsd`, `host`; ADR-5209 §10), and its target is checked against that layer:
 * a gsd target must exist in the installed GSD, a host target must name the
 * runtime and version the session ran, a user target must sit under the home
 * directory and outside the project. Each drop carries a typed code
 * (`CANDIDATE_DROP`) beside its sentence.
 *
 * ── The removal loop ───────────────────────────────────────────────────
 *
 * A check a human accepted is journaled with the signal it came from. Its
 * firings are counted in later transcripts (a hook event or a failed tool
 * result whose text carries the check's `match` literal). A check that has
 * not fired across a window at least `check_stale_days` long, and was accepted
 * at least that long ago, is a removal candidate. When no transcript could be
 * read, nothing is a removal candidate: "never fired" and "not looked at" are
 * different answers.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retryRenameSync } from './shell-command-projection.cjs';
import { tryWithinRoot, tryWithinRootLexical, PathAcceptance } from './security.cjs';
import { formatPointer } from './session-transcript.cjs';
import type { SessionTranscript, TranscriptPointer } from './session-transcript.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceModule = require('./planning-workspace.cjs');
const { planningRoot } = planningWorkspaceModule;

// ─── Layout ───────────────────────────────────────────────────────────────────

export interface RetroPaths {
  /** Absolute `.planning/retro`. */
  dir: string;
  /** Project-relative POSIX paths of one retro's artifacts. */
  report: string;
  candidates: string;
  patches: string;
  bundle: string;
  /** `RETRO-<date>` or `RETRO-<date>-<n>`. */
  stem: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function retroDir(projectRoot: string): string {
  return path.join(planningRoot(projectRoot), 'retro');
}

function rel(projectRoot: string, abs: string): string {
  return path.relative(projectRoot, abs).split(path.sep).join('/');
}

/**
 * The artifact paths of a new retro dated `date` (`YYYY-MM-DD`, UTC). The
 * first retro of a day is `RETRO-<date>`; later ones take the next free
 * `-<n>` (2, 3, …) so a second retro never overwrites the first report.
 */
export function nextRetroPaths(projectRoot: string, date: string): RetroPaths {
  if (!DATE_RE.test(date)) throw new RangeError(`retro date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const dir = retroDir(projectRoot);
  let stem = `RETRO-${date}`;
  for (let n = 2; fs.existsSync(path.join(dir, `${stem}.md`)) || fs.existsSync(path.join(dir, `${stem}.json`)); n++) {
    stem = `RETRO-${date}-${n}`;
  }
  return retroPathsFor(projectRoot, stem);
}

const STEM_RE = /^RETRO-\d{4}-\d{2}-\d{2}(?:-[1-9]\d{0,3})?$/;

/** The paths of an existing retro by stem; throws a RangeError for anything that is not a retro stem. */
export function retroPathsFor(projectRoot: string, stem: string): RetroPaths {
  if (!STEM_RE.test(stem)) throw new RangeError(`not a retro stem: ${JSON.stringify(stem)}`);
  const dir = retroDir(projectRoot);
  return {
    dir,
    stem,
    report: rel(projectRoot, path.join(dir, `${stem}.md`)),
    candidates: rel(projectRoot, path.join(dir, `${stem}.json`)),
    patches: rel(projectRoot, path.join(dir, 'patches', stem)),
    bundle: rel(projectRoot, path.join(dir, '.work', `${stem}.bundle.json`)),
  };
}

export function isRetroStem(stem: string): boolean {
  return STEM_RE.test(stem);
}

/** Retro stems in time order: by date, then sequence numerically. */
export function compareRetroStems(a: string, b: string): number {
  const order = (s: string): [string, number] => {
    const m = /^RETRO-(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/.exec(s) as RegExpExecArray;
    return [m[1], m[2] ? Number(m[2]) : 1];
  };
  const [da, na] = order(a);
  const [db, nb] = order(b);
  return da === db ? na - nb : da.localeCompare(db);
}

/** Every retro stem with a candidates file on disk, oldest first. */
export function retroStemsOnDisk(projectRoot: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(retroDir(projectRoot));
  } catch {
    return [];
  }
  return names
    .filter(n => n.endsWith('.json') && n !== 'CHECKS.json')
    .map(n => n.slice(0, -'.json'.length))
    .filter(isRetroStem)
    .sort(compareRetroStems);
}

/** The newest retro stem on disk (by date, then sequence), or null. */
export function latestRetroStem(projectRoot: string): string | null {
  const stems = retroStemsOnDisk(projectRoot);
  return stems.length === 0 ? null : stems[stems.length - 1];
}

/**
 * Atomic publish: write a sibling temp file, then rename over the target via
 * `retryRenameSync` (transient-Windows-lock-tolerant). On failure the temp file
 * is removed and the error rethrown.
 */
export function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    retryRenameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Write the analyst's input bundle under `.planning/retro/.work/`, which
 * ignores itself: excerpts are redacted, but they are still transcript text
 * and must not ride along when planning docs are committed.
 */
export function writeBundle(projectRoot: string, paths: RetroPaths, bundle: unknown): void {
  const workDir = path.join(paths.dir, '.work');
  fs.mkdirSync(workDir, { recursive: true });
  const ignore = path.join(workDir, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n', 'utf8');
  writeTextAtomic(path.join(projectRoot, paths.bundle), `${JSON.stringify(bundle, null, 2)}\n`);
}

// ─── Journal lock ─────────────────────────────────────────────────────────────

/**
 * The cross-process lock a journal's read-compute-write cycle runs under.
 * The journals sit under the planning root and every workstream writes them,
 * so two writers can race. A seam so tests drive contention without real
 * processes; production uses the shared primitive (capability-lock).
 */
export interface JournalLock {
  acquire(lockPath: string): unknown;
  release(handle: unknown): void;
}

interface CapabilityLockModule {
  acquireLock(lockPath: string, opts?: { maxAttempts?: number; waitForFresh?: boolean }): unknown;
  releaseLock(handle: unknown): void;
}

let _lockMod: CapabilityLockModule | null = null;
/** Lazy: capability-lock probes the process start time at load, which readers must not pay. */
function capabilityLock(): CapabilityLockModule {
  if (_lockMod === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _lockMod = require('./capability-lock.cjs') as CapabilityLockModule;
  }
  return _lockMod;
}

/**
 * Budget as for the broken-windows ledger: racing writers serialize (the
 * critical section is sub-millisecond), a holder that never releases is
 * refused after a bounded wait.
 */
const JOURNAL_LOCK_MAX_ATTEMPTS = 50;

export const defaultJournalLock: JournalLock = Object.freeze({
  acquire: (lockPath: string) => capabilityLock().acquireLock(lockPath, { maxAttempts: JOURNAL_LOCK_MAX_ATTEMPTS, waitForFresh: true }),
  release: (handle: unknown) => capabilityLock().releaseLock(handle),
});

/** `.planning/retro/.<NAME>.lock` for the journal `<NAME>.json`. */
export function journalLockPath(projectRoot: string, journalFile: string): string {
  return path.join(retroDir(projectRoot), `.${path.basename(journalFile, '.json')}.lock`);
}

/**
 * Run `fn` (one journal read-compute-write) holding the journal's lock. A
 * lock that cannot be had is an answer, never an unlocked write.
 */
export function withJournalLock<T>(lockPath: string, fn: () => T, lock: JournalLock = defaultJournalLock): { ok: true; value: T } | { ok: false; reason: string } {
  const handle = lock.acquire(lockPath);
  if (handle === null || handle === undefined) {
    return { ok: false, reason: `another writer holds ${path.basename(lockPath)}; nothing was written — re-run once it finishes` };
  }
  try {
    return { ok: true, value: fn() };
  } finally {
    lock.release(handle);
  }
}

// ─── Accepted-checks journal ──────────────────────────────────────────────────

export const CHECK_KINDS = Object.freeze(['lint-rule', 'hook', 'gate', 'verify-gate', 'script', 'test'] as const);
export type CheckKind = typeof CHECK_KINDS[number];

export interface AcceptedCheck {
  /** Stable slug: `[a-z0-9][a-z0-9-]*`, at most 64 characters. */
  id: string;
  kind: CheckKind;
  /** The literal that identifies a firing in a transcript: a rule id, a hook name, a gate name. */
  match: string;
  /** `YYYY-MM-DD` the human accepted it. */
  acceptedAt: string;
  /** The incident it came from. */
  source: { retro: string | null; candidate: string | null; signal: string | null };
}

export interface ChecksJournal {
  version: 1;
  checks: AcceptedCheck[];
}

export interface JournalRead {
  status: 'ok' | 'absent' | 'invalid';
  journal: ChecksJournal;
  problems: string[];
}

const CHECK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MATCH_MAX = 200;

export function checksJournalPath(projectRoot: string): string {
  return path.join(retroDir(projectRoot), 'CHECKS.json');
}

function emptyJournal(): ChecksJournal {
  return { version: 1, checks: [] };
}

function nullableString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Problems with one check object; empty when it is well-formed. */
export function checkProblems(c: Partial<AcceptedCheck> | null | undefined): string[] {
  const problems: string[] = [];
  if (!c || typeof c !== 'object') return ['not an object'];
  if (typeof c.id !== 'string' || !CHECK_ID_RE.test(c.id)) problems.push(`id must match ${CHECK_ID_RE}, got ${JSON.stringify(c.id)}`);
  if (typeof c.kind !== 'string' || !(CHECK_KINDS as readonly string[]).includes(c.kind)) {
    problems.push(`kind must be one of ${CHECK_KINDS.join(', ')}, got ${JSON.stringify(c.kind)}`);
  }
  if (typeof c.match !== 'string' || c.match.trim().length === 0 || c.match.length > MATCH_MAX) {
    problems.push(`match must be a non-empty string of at most ${MATCH_MAX} characters`);
  }
  if (typeof c.acceptedAt !== 'string' || !DATE_RE.test(c.acceptedAt) || Number.isNaN(Date.parse(`${c.acceptedAt}T00:00:00Z`))) {
    problems.push(`acceptedAt must be YYYY-MM-DD, got ${JSON.stringify(c.acceptedAt)}`);
  }
  return problems;
}

/**
 * Parse CHECKS.json text. A malformed entry is skipped and named, never
 * silently kept: a journal entry that cannot be matched can never fire, and so
 * would turn into a bogus removal candidate.
 */
export function parseChecksJournal(text: string): JournalRead {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { status: 'invalid', journal: emptyJournal(), problems: [`CHECKS.json is not JSON: ${(err as Error).message}`] };
  }
  const obj = parsed as { version?: unknown; checks?: unknown };
  if (!obj || typeof obj !== 'object' || obj.version !== 1 || !Array.isArray(obj.checks)) {
    return { status: 'invalid', journal: emptyJournal(), problems: ['CHECKS.json must be { "version": 1, "checks": [...] }'] };
  }
  const problems: string[] = [];
  const checks: AcceptedCheck[] = [];
  const seen = new Set<string>();
  obj.checks.forEach((raw: unknown, i: number) => {
    const c = raw as Partial<AcceptedCheck> & { source?: Record<string, unknown> };
    const p = checkProblems(c);
    if (p.length === 0 && seen.has(c.id as string)) p.push(`duplicate id ${c.id}`);
    if (p.length > 0) {
      problems.push(`checks[${i}]: ${p.join('; ')}`);
      return;
    }
    seen.add(c.id as string);
    const src: Record<string, unknown> = c.source && typeof c.source === 'object' ? c.source : {};
    checks.push({
      id: c.id as string,
      kind: c.kind as CheckKind,
      match: c.match as string,
      acceptedAt: c.acceptedAt as string,
      source: { retro: nullableString(src['retro']), candidate: nullableString(src['candidate']), signal: nullableString(src['signal']) },
    });
  });
  return { status: 'ok', journal: { version: 1, checks }, problems };
}

export function readChecksJournal(projectRoot: string): JournalRead {
  let text: string;
  try {
    text = fs.readFileSync(checksJournalPath(projectRoot), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', journal: emptyJournal(), problems: [] };
    return { status: 'invalid', journal: emptyJournal(), problems: [`CHECKS.json unreadable: ${(err as Error).message}`] };
  }
  return parseChecksJournal(text);
}

/** Stable serialisation: checks ordered by id, keys in a fixed order. */
export function formatChecksJournal(journal: ChecksJournal): string {
  const checks = [...journal.checks].sort((a, b) => a.id.localeCompare(b.id)).map(c => ({
    id: c.id,
    kind: c.kind,
    match: c.match,
    acceptedAt: c.acceptedAt,
    source: { retro: c.source.retro, candidate: c.source.candidate, signal: c.source.signal },
  }));
  return `${JSON.stringify({ version: 1, checks }, null, 2)}\n`;
}

export type JournalEdit = { ok: true; journal: ChecksJournal } | { ok: false; reason: string };

export function recordCheck(journal: ChecksJournal, check: AcceptedCheck): JournalEdit {
  const problems = checkProblems(check);
  if (problems.length > 0) return { ok: false, reason: problems.join('; ') };
  if (journal.checks.some(c => c.id === check.id)) return { ok: false, reason: `a check with id ${check.id} is already journaled` };
  return { ok: true, journal: { version: 1, checks: [...journal.checks, check] } };
}

export function retireCheck(journal: ChecksJournal, id: string): JournalEdit {
  if (!journal.checks.some(c => c.id === id)) return { ok: false, reason: `no journaled check with id ${JSON.stringify(id)}` };
  return { ok: true, journal: { version: 1, checks: journal.checks.filter(c => c.id !== id) } };
}

// ─── Firings ──────────────────────────────────────────────────────────────────

export interface CheckFires {
  id: string;
  fires: number;
  sessions: number;
  lastFiredAt: string | null;
  /** The first firings, as `file:line#uuid8`. */
  pointers: string[];
}

const MAX_FIRE_POINTERS = 5;

/**
 * Count each check's firings in the given transcripts: a hook event whose
 * hook name or text carries the check's `match`, or a tool result that failed
 * or was blocked and carries it. The match is a literal, case-sensitive.
 */
export function countCheckFires(checks: readonly AcceptedCheck[], transcripts: readonly SessionTranscript[]): CheckFires[] {
  return checks.map(c => {
    let fires = 0;
    let last: string | null = null;
    const sessions = new Set<string>();
    const pointers: string[] = [];
    const hit = (ptr: TranscriptPointer) => {
      fires++;
      sessions.add(ptr.session);
      if (ptr.timestamp && (last === null || ptr.timestamp > last)) last = ptr.timestamp;
      if (pointers.length < MAX_FIRE_POINTERS) pointers.push(`${ptr.session}/${formatPointer(ptr)}`);
    };
    for (const t of transcripts) {
      for (const ev of t.events) {
        if (ev.kind === 'hook' && ((ev.hook ?? '').includes(c.match) || ev.text.includes(c.match))) hit(ev.ptr);
        else if (ev.kind === 'tool-result' && (ev.isError || ev.blockedBy !== null) && ev.text.includes(c.match)) hit(ev.ptr);
      }
    }
    return { id: c.id, fires, sessions: sessions.size, lastFiredAt: last, pointers };
  });
}

export type CheckState = 'fired' | 'silent' | 'removal-candidate' | 'unknown';

export interface CheckStatusEntry extends CheckFires {
  kind: CheckKind;
  match: string;
  acceptedAt: string;
  ageDays: number;
  state: CheckState;
  /** Why a silent check is not (yet) a removal candidate. */
  note: string | null;
}

export interface ChecksStatus {
  status: 'ok' | 'degraded';
  reasons: string[];
  staleDays: number;
  windowDays: number;
  sessionsScanned: number;
  checks: CheckStatusEntry[];
  removalCandidates: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide each journaled check's state. `windowDays` is how far back the
 * scanned transcripts reach; `transcriptsRead` false means none could be read,
 * and every silent check is then `unknown`, never a removal candidate.
 */
export function checksStatus(input: {
  journal: ChecksJournal;
  fires: readonly CheckFires[];
  now: Date;
  staleDays: number;
  windowDays: number;
  sessionsScanned: number;
  transcriptsRead: boolean;
  reasons?: string[];
}): ChecksStatus {
  const byId = new Map(input.fires.map(f => [f.id, f]));
  const reasons = [...(input.reasons ?? [])];
  const entries: CheckStatusEntry[] = input.journal.checks.map(c => {
    const f = byId.get(c.id) ?? { id: c.id, fires: 0, sessions: 0, lastFiredAt: null, pointers: [] };
    const ageDays = Math.floor((input.now.getTime() - Date.parse(`${c.acceptedAt}T00:00:00Z`)) / DAY_MS);
    let state: CheckState;
    let note: string | null = null;
    if (f.fires > 0) {
      state = 'fired';
    } else if (!input.transcriptsRead) {
      state = 'unknown';
      note = 'no transcript could be read';
    } else if (ageDays < input.staleDays) {
      state = 'silent';
      note = `accepted ${ageDays} day(s) ago, younger than retro.check_stale_days (${input.staleDays})`;
    } else if (input.windowDays < input.staleDays) {
      state = 'silent';
      note = `scanned ${input.windowDays} day(s) of transcripts, fewer than retro.check_stale_days (${input.staleDays})`;
    } else {
      state = 'removal-candidate';
    }
    return { ...f, kind: c.kind, match: c.match, acceptedAt: c.acceptedAt, ageDays, state, note };
  });
  return {
    status: input.transcriptsRead && reasons.length === 0 ? 'ok' : 'degraded',
    reasons,
    staleDays: input.staleDays,
    windowDays: input.windowDays,
    sessionsScanned: input.sessionsScanned,
    checks: entries,
    removalCandidates: entries.filter(e => e.state === 'removal-candidate').map(e => e.id),
  };
}

// ─── Candidates ───────────────────────────────────────────────────────────────

export const CANDIDATE_CATEGORIES = Object.freeze([
  'navigation', 'mechanical', 'judgement', 'environment', 'steering', 'retire-check',
] as const);
export type CandidateCategory = typeof CANDIDATE_CATEGORIES[number];

export const CANDIDATE_SEVERITIES = Object.freeze(['high', 'medium', 'low'] as const);

/**
 * The layer that owns a candidate's cause (ADR-5209 §10): where the fix has to
 * land so the friction does not come back.
 *
 *   project  this repository's files (a lint rule, a pointer in its CLAUDE.md)
 *   user     the user's own setup outside any repository (~/.claude settings,
 *            hooks, personal skills, the global CLAUDE.md)
 *   gsd      GSD's shipped surface (agents, workflows, references, hooks, CLI)
 *   host     the runtime itself (Claude Code …): fixable here only by a workaround
 *
 * A candidates file of version 1 predates layers: its candidates without one
 * are read as `project`, exactly as they were routed before.
 */
export const CANDIDATE_LAYERS = Object.freeze(['project', 'user', 'gsd', 'host'] as const);
export type CandidateLayer = typeof CANDIDATE_LAYERS[number];

/** Where a human sends a chosen PROJECT candidate. Only checks (and their removal) are code work. */
export const CANDIDATE_ROUTE: Readonly<Record<CandidateCategory, 'quick' | 'capture'>> = Object.freeze({
  'navigation': 'capture',
  'mechanical': 'quick',
  'judgement': 'capture',
  'environment': 'capture',
  'steering': 'capture',
  'retire-check': 'quick',
});

/**
 * The `--apply` route: a project candidate goes to /gsd-quick or /gsd-capture
 * as before; a user candidate is shown to the human, who edits their own file
 * (`user`); a gsd or host candidate becomes a lesson in the cross-repository
 * journal (`lesson`) and leaves the project untouched.
 */
export type CandidateRoute = 'quick' | 'capture' | 'user' | 'lesson';

export function candidateRoute(layer: CandidateLayer, category: CandidateCategory): CandidateRoute {
  if (layer === 'project') return CANDIDATE_ROUTE[category];
  return layer === 'user' ? 'user' : 'lesson';
}

/**
 * Why the validator dropped a candidate: one code per reason, in the same
 * order as the human-readable `reasons` (a consumer branches on the code,
 * never on the sentence).
 */
export const CANDIDATE_DROP = Object.freeze({
  INVALID_ENVELOPE: 'invalid-envelope',
  INVALID_ID: 'invalid-id',
  DUPLICATE_ID: 'duplicate-id',
  INVALID_CATEGORY: 'invalid-category',
  INVALID_SEVERITY: 'invalid-severity',
  MISSING_FIELD: 'missing-field',
  NO_SIGNAL: 'no-signal',
  UNKNOWN_SIGNAL: 'unknown-signal',
  JUDGEMENT_IN_STEERING_FILE: 'judgement-in-steering-file',
  MISSING_VERIFY: 'missing-verify',
  PATCH_OUTSIDE: 'patch-outside',
  PATCH_MISSING: 'patch-missing',
  MISSING_LAYER: 'missing-layer',
  INVALID_LAYER: 'invalid-layer',
  LAYER_CATEGORY: 'layer-category-mismatch',
  MISSING_TARGET: 'missing-target',
  PROJECT_TARGET_OUTSIDE: 'project-target-outside',
  USER_TARGET_OUTSIDE_HOME: 'user-target-outside-home',
  USER_TARGET_IN_PROJECT: 'user-target-in-project',
  GSD_ROOT_UNKNOWN: 'gsd-root-unknown',
  GSD_TARGET_NOT_SURFACE: 'gsd-target-not-surface',
  GSD_TARGET_MISSING: 'gsd-target-missing',
  HOST_UNKNOWN: 'host-unknown',
  HOST_TARGET_NAME: 'host-target-name',
  HOST_TARGET_VERSION: 'host-target-version',
  INVALID_RELATED: 'invalid-related',
  RECURRING_UNCITED: 'recurring-uncited',
  RECURRING_NOT_ESCALATED: 'recurring-not-escalated',
} as const);
export type CandidateDropCode = typeof CANDIDATE_DROP[keyof typeof CANDIDATE_DROP];

/** Typed remarks on a candidate that survived: kept, but flagged for the human. */
export const CANDIDATE_NOTE = Object.freeze({
  /** A host candidate whose runtime version the bundle did not know. */
  HOST_VERSION_UNKNOWN: 'host-version-unknown',
} as const);
export type CandidateNote = typeof CANDIDATE_NOTE[keyof typeof CANDIDATE_NOTE];

export interface RetroCandidate {
  id: string;
  severity: typeof CANDIDATE_SEVERITIES[number];
  category: CandidateCategory;
  /** The layer that owns the cause; `project` for a version-1 candidate without one. */
  layer: CandidateLayer;
  /** False when `layer` was defaulted (version-1 file), true when the analyst wrote it. */
  layerDeclared: boolean;
  title: string;
  /** Evidence refs: signal ids, `inventory:<kind>:<subject>`, `check:<id>`, `lesson:<id>`, `retro:<stem>:<cand>`. */
  signals: string[];
  /** What already exists that this builds on or replaces (from the inventory), or null. */
  existing: string | null;
  /** The file or setting the change lands in. */
  target: string | null;
  change: string;
  /** Project-relative path of a proposed patch under the retro's patches dir, or null. */
  patch: string | null;
  /** A command that shows the check firing on the incident (mechanical) or the change in effect. */
  verify: string | null;
  /** Ids of other candidates of this retro answering the same cause in another layer (a project stopgap for a gsd lesson). */
  related: string[];
}

export interface EvidenceIndex {
  signals: ReadonlySet<string>;
  inventory: ReadonlySet<string>;
  checks: ReadonlySet<string>;
  /** Lesson ids the bundle carried (cited as `lesson:<id>`). */
  lessons?: ReadonlySet<string>;
  /** `<stem>:<cand>` of the earlier proposals the bundle carried as recurring (cited as `retro:<stem>:<cand>`). */
  retros?: ReadonlySet<string>;
}

/** What the layer checks need to know about the machine the retro ran on. */
export interface LayerContext {
  /** The GSD install root (the directory holding `gsd-core/`), or null when it could not be found. */
  gsdRoot: string | null;
  /** The runtime the session ran in (`resolveRuntime`), or null. */
  hostName: string | null;
  /** Its version as the transcript recorded it, or null. */
  hostVersion: string | null;
  /** The user's home directory (`~` in a user target). */
  homeDir: string;
}

/** An earlier proposal of this project whose signals came back (the bundle's `recurring[]`). */
export interface RecurringRef {
  retro: string;
  candidate: string;
  /** The signal ids it shares with this retro. */
  signals: readonly string[];
  /** Not applied and the shared signals grew: a candidate answering it must be `high`. */
  escalate: boolean;
}

export interface ValidCandidate extends RetroCandidate {
  route: CandidateRoute;
  notes: CandidateNote[];
}

export interface DroppedCandidate {
  id: string;
  reasons: string[];
  /** One code per entry of `reasons`, same order. */
  codes: CandidateDropCode[];
}

export interface CandidateValidation {
  /** The candidates file's version: 1 (layers optional, default project) or 2 (layer required). */
  version: 1 | 2 | null;
  valid: ValidCandidate[];
  dropped: DroppedCandidate[];
}

const CANDIDATE_ID_RE = /^cand-[1-9]\d{0,3}$/;
const STEERING_FILES = new Set(['claude.md', 'agents.md', 'gemini.md']);
const LESSON_REF_RE = /^lesson:(lesson-[0-9a-f]{10})$/;
const RETRO_REF_RE = /^retro:(RETRO-\d{4}-\d{2}-\d{2}(?:-[1-9]\d{0,3})?):(cand-[1-9]\d{0,3})$/;

function isEvidence(ref: string, ev: EvidenceIndex): boolean {
  if (ref.startsWith('inventory:')) return ev.inventory.has(ref);
  if (ref.startsWith('check:')) return ev.checks.has(ref.slice('check:'.length));
  if (ref.startsWith('lesson:')) {
    const m = LESSON_REF_RE.exec(ref);
    return m !== null && (ev.lessons?.has(m[1]) ?? false);
  }
  if (ref.startsWith('retro:')) {
    const m = RETRO_REF_RE.exec(ref);
    return m !== null && (ev.retros?.has(`${m[1]}:${m[2]}`) ?? false);
  }
  return ev.signals.has(ref);
}

/** The lesson ids a candidate cites (`lesson:<id>`), in order. */
export function citedLessons(signals: readonly string[]): string[] {
  return signals.map(s => LESSON_REF_RE.exec(s)).filter((m): m is RegExpExecArray => m !== null).map(m => m[1]);
}

/**
 * The places a `gsd` target may name, relative to the install root. Installed
 * commands are skills on most runtimes, and the user's own agents and hooks
 * share those directories, so only GSD's own names count.
 */
export const GSD_SURFACE_PREFIXES = Object.freeze(['gsd-core/', 'agents/gsd-', 'hooks/gsd-', 'commands/gsd/', 'skills/gsd-'] as const);

/** A target without its `#anchor` (a section, a settings key): the file it lands in. */
function targetFile(target: string): string {
  const hash = target.indexOf('#');
  return (hash >= 0 ? target.slice(0, hash) : target).trim();
}

const HOST_TARGET_RE = /^([A-Za-z0-9._-]+)(?:@([^\s:]+))?(?:\s*:\s*(.*))?$/;

/** `<runtime>[@<version>][: <area>]` — the runtime and version a host candidate is about. */
export function parseHostTarget(target: string): { name: string; version: string | null; area: string | null } | null {
  const m = HOST_TARGET_RE.exec(target.trim());
  if (!m) return null;
  return { name: m[1], version: m[2] ?? null, area: m[3] ? m[3].trim() || null : null };
}

type Drop = (code: CandidateDropCode, reason: string) => void;

/**
 * The checks that depend on the layer: where its target may point. A version-1
 * candidate that did not declare a layer is not checked here — it is routed
 * exactly as before layers existed.
 */
function checkLayerTarget(
  layer: CandidateLayer,
  category: CandidateCategory,
  target: string | null,
  ctx: LayerContext,
  projectRoot: string,
  drop: Drop,
  notes: CandidateNote[],
): void {
  if (category === 'retire-check' && layer !== 'project') {
    drop(CANDIDATE_DROP.LAYER_CATEGORY, 'layer-category-mismatch: a retire-check removes a journaled check of this project, so its layer is project');
  }
  if (layer === 'project') {
    const file = target ? targetFile(target) : '';
    if (target && (file.startsWith('~') || tryWithinRootLexical(file || '.', projectRoot) === null)) {
      drop(CANDIDATE_DROP.PROJECT_TARGET_OUTSIDE, `project-target-outside: ${target} is not inside the project; a change outside it belongs to another layer`);
    }
    return;
  }
  if (!target) {
    drop(CANDIDATE_DROP.MISSING_TARGET, `missing-target: a ${layer} candidate must name where the change lands`);
    return;
  }
  if (layer === 'user') {
    const file = targetFile(target);
    if (!(file === '~' || file.startsWith('~/'))) {
      drop(CANDIDATE_DROP.USER_TARGET_OUTSIDE_HOME, `user-target-outside-home: a user target is written from the home directory, ~/…, got ${target}`);
      return;
    }
    const abs = tryWithinRootLexical(file === '~' ? '.' : file.slice(2), ctx.homeDir);
    if (abs === null) {
      drop(CANDIDATE_DROP.USER_TARGET_OUTSIDE_HOME, `user-target-outside-home: ${target} leaves the home directory`);
    } else if (tryWithinRootLexical(abs, projectRoot) !== null) {
      drop(CANDIDATE_DROP.USER_TARGET_IN_PROJECT, `user-target-in-project: ${target} is inside this project; that is a project candidate`);
    }
    return;
  }
  if (layer === 'gsd') {
    const file = targetFile(target);
    const plain = !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
    if (!plain || !GSD_SURFACE_PREFIXES.some(p => file.startsWith(p))) {
      drop(CANDIDATE_DROP.GSD_TARGET_NOT_SURFACE, `gsd-target-not-surface: a gsd target is a path of the installed GSD under ${GSD_SURFACE_PREFIXES.join(', ')}; got ${target}`);
      return;
    }
    if (ctx.gsdRoot === null) {
      drop(CANDIDATE_DROP.GSD_ROOT_UNKNOWN, 'gsd-root-unknown: the GSD install root is not known, so a gsd target cannot be checked');
      return;
    }
    if (!fs.existsSync(path.join(ctx.gsdRoot, file))) {
      drop(CANDIDATE_DROP.GSD_TARGET_MISSING, `gsd-target-missing: ${file} does not exist in the installed GSD`);
    }
    return;
  }
  // host
  if (ctx.hostName === null) {
    drop(CANDIDATE_DROP.HOST_UNKNOWN, 'host-unknown: the bundle does not name the runtime, so a host candidate cannot be tied to it');
    return;
  }
  const parsed = parseHostTarget(target);
  if (parsed === null || parsed.name.toLowerCase() !== ctx.hostName.toLowerCase()) {
    drop(CANDIDATE_DROP.HOST_TARGET_NAME, `host-target-name: a host target starts with the runtime the bundle names, ${ctx.hostName}[@<version>][: <area>]; got ${target}`);
    return;
  }
  if (ctx.hostVersion === null) {
    if (parsed.version !== null && parsed.version !== 'unknown') {
      drop(CANDIDATE_DROP.HOST_TARGET_VERSION, `host-target-version: the bundle does not know the ${ctx.hostName} version, so ${parsed.version} cannot be claimed`);
    } else {
      notes.push(CANDIDATE_NOTE.HOST_VERSION_UNKNOWN);
    }
  } else if (parsed.version !== ctx.hostVersion) {
    drop(CANDIDATE_DROP.HOST_TARGET_VERSION, `host-target-version: a host target names the version the session ran, ${ctx.hostName}@${ctx.hostVersion}; got ${target}`);
  }
}

/** `inventory:<kind>:<subject>` refs for an inventory's findings. */
export function inventoryRefs(findings: ReadonlyArray<{ kind: string; subject: string }>): string[] {
  return findings.map(f => `inventory:${f.kind}:${f.subject}`);
}

function defaultLayerContext(): LayerContext {
  return { gsdRoot: null, hostName: null, hostVersion: null, homeDir: os.homedir() };
}

/**
 * Validate the analyst's candidates against the evidence the bundle carried.
 * Every rule is mechanical; a candidate that breaks any is dropped with its
 * reasons and their codes, never repaired. Valid candidates come back ordered
 * by severity, then id, with their route.
 *
 * Version 2 files must give every candidate a `layer`, and its target is
 * checked against that layer (ADR-5209 §10). A version-1 file (or one with no
 * version) predates layers: a candidate without one is `project` and is not
 * checked by layer. A candidate whose signals came back from an earlier
 * proposal (`recurring`) must cite it as `retro:<stem>:<cand>`, and as `high`
 * when that proposal was not applied and its signals grew.
 */
export function validateCandidates(
  raw: unknown,
  evidence: EvidenceIndex,
  opts: { projectRoot: string; patchesDir: string; layer?: LayerContext; recurring?: readonly RecurringRef[] },
): CandidateValidation {
  const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as { version?: unknown; candidates?: unknown } : null;
  const version = envelope && (envelope.version === undefined || envelope.version === 1) ? 1 : envelope && envelope.version === 2 ? 2 : null;
  if (envelope === null || version === null || !Array.isArray(envelope.candidates)) {
    return {
      version: null,
      valid: [],
      dropped: [{ id: '(file)', reasons: ['invalid-envelope: candidates file must be { "version": 1 | 2, "candidates": [...] }'], codes: [CANDIDATE_DROP.INVALID_ENVELOPE] }],
    };
  }
  const list = envelope.candidates as unknown[];
  const ctx = opts.layer ?? defaultLayerContext();
  const recurring = opts.recurring ?? [];
  const fileIds = new Set(list.map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>)['id'] : null)).filter((v): v is string => typeof v === 'string'));
  const valid: ValidCandidate[] = [];
  const dropped: DroppedCandidate[] = [];
  const seen = new Set<string>();
  const patchesAbs = path.join(opts.projectRoot, opts.patchesDir);
  list.forEach((item, i) => {
    const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = typeof c['id'] === 'string' ? c['id'] : `(index ${i})`;
    const reasons: string[] = [];
    const codes: CandidateDropCode[] = [];
    const drop: Drop = (code, reason) => { codes.push(code); reasons.push(reason); };
    const notes: CandidateNote[] = [];
    if (!CANDIDATE_ID_RE.test(id)) drop(CANDIDATE_DROP.INVALID_ID, 'id must look like cand-<n>');
    else if (seen.has(id)) drop(CANDIDATE_DROP.DUPLICATE_ID, 'duplicate id');
    seen.add(id);
    const category = c['category'] as CandidateCategory;
    const categoryOk = (CANDIDATE_CATEGORIES as readonly string[]).includes(category);
    if (!categoryOk) drop(CANDIDATE_DROP.INVALID_CATEGORY, `category must be one of ${CANDIDATE_CATEGORIES.join(', ')}`);
    if (!(CANDIDATE_SEVERITIES as readonly string[]).includes(c['severity'] as string)) drop(CANDIDATE_DROP.INVALID_SEVERITY, `severity must be one of ${CANDIDATE_SEVERITIES.join(', ')}`);
    const rawLayer = c['layer'];
    let layer: CandidateLayer = 'project';
    let layerDeclared = false;
    let layerOk = true;
    if (rawLayer === undefined || rawLayer === null) {
      if (version === 2) {
        drop(CANDIDATE_DROP.MISSING_LAYER, `missing-layer: a version 2 candidate names the layer that owns its cause (${CANDIDATE_LAYERS.join(', ')})`);
        layerOk = false;
      }
    } else if (typeof rawLayer === 'string' && (CANDIDATE_LAYERS as readonly string[]).includes(rawLayer)) {
      layer = rawLayer as CandidateLayer;
      layerDeclared = true;
    } else {
      drop(CANDIDATE_DROP.INVALID_LAYER, `invalid-layer: layer must be one of ${CANDIDATE_LAYERS.join(', ')}, got ${JSON.stringify(rawLayer)}`);
      layerOk = false;
    }
    for (const field of ['title', 'change']) {
      const v = c[field];
      if (typeof v !== 'string' || v.trim() === '') drop(CANDIDATE_DROP.MISSING_FIELD, `${field} is required`);
    }
    const signals = Array.isArray(c['signals']) ? (c['signals'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    if (signals.length === 0) drop(CANDIDATE_DROP.NO_SIGNAL, 'no-signal: a candidate must point at the signal it answers');
    for (const s of signals) if (!isEvidence(s, evidence)) drop(CANDIDATE_DROP.UNKNOWN_SIGNAL, `unknown-signal: ${s}`);
    const target = nullableString(c['target']);
    if (category === 'judgement' && target && STEERING_FILES.has(path.basename(targetFile(target)).toLowerCase())) {
      drop(CANDIDATE_DROP.JUDGEMENT_IN_STEERING_FILE, 'judgement-in-steering-file: a judgement rule goes to the reviewer (agent_skills.*), not to CLAUDE.md/AGENTS.md');
    }
    if (categoryOk && layerOk && layerDeclared) checkLayerTarget(layer, category, target, ctx, opts.projectRoot, drop, notes);
    const verify = nullableString(c['verify']);
    // A check is verified where it lands: in this project, or in the user's
    // setup. A gsd or host check is verified in GSD's repository or the
    // runtime's, never here.
    const verifiedHere = layer === 'project' || layer === 'user';
    if ((category === 'mechanical' || category === 'retire-check') && verifiedHere && !verify) {
      drop(CANDIDATE_DROP.MISSING_VERIFY, 'missing-verify: a check needs a command that shows it firing');
    }
    const patch = nullableString(c['patch']);
    if (patch) {
      const abs = tryWithinRoot(patch, opts.projectRoot, PathAcceptance.RelativeOnly);
      if (!abs || !tryWithinRoot(path.relative(patchesAbs, abs), patchesAbs, PathAcceptance.RelativeOnly)) {
        drop(CANDIDATE_DROP.PATCH_OUTSIDE, `patch must live under ${opts.patchesDir}/`);
      } else if (!fs.existsSync(abs)) {
        drop(CANDIDATE_DROP.PATCH_MISSING, `patch not found: ${patch}`);
      }
    }
    const relatedRaw = c['related'];
    const related: string[] = [];
    if (relatedRaw !== undefined && relatedRaw !== null) {
      const items = Array.isArray(relatedRaw) ? relatedRaw : [relatedRaw];
      for (const r of items) {
        if (typeof r !== 'string' || !CANDIDATE_ID_RE.test(r) || r === id || !fileIds.has(r)) {
          drop(CANDIDATE_DROP.INVALID_RELATED, `invalid-related: ${JSON.stringify(r)} is not another candidate of this file`);
        } else if (!related.includes(r)) {
          related.push(r);
        }
      }
    }
    for (const r of recurring) {
      if (!r.signals.some(s => signals.includes(s))) continue;
      const ref = `retro:${r.retro}:${r.candidate}`;
      if (!signals.includes(ref)) {
        drop(CANDIDATE_DROP.RECURRING_UNCITED, `recurring-uncited: its signals came back from ${r.retro} ${r.candidate}; cite ${ref} and say what became of it`);
      } else if (r.escalate && c['severity'] !== 'high') {
        drop(CANDIDATE_DROP.RECURRING_NOT_ESCALATED, `recurring-not-escalated: ${ref} was not applied and its signals grew, so this candidate is high`);
      }
    }
    if (reasons.length > 0) {
      dropped.push({ id, reasons, codes });
      return;
    }
    valid.push({
      id,
      severity: c['severity'] as RetroCandidate['severity'],
      category,
      layer,
      layerDeclared,
      title: c['title'] as string,
      signals,
      existing: nullableString(c['existing']),
      target,
      change: c['change'] as string,
      patch,
      verify,
      related,
      route: candidateRoute(layer, category),
      notes,
    });
  });
  const rank = (s: string) => (CANDIDATE_SEVERITIES as readonly string[]).indexOf(s);
  valid.sort((a, b) => rank(a.severity) - rank(b.severity) || Number(a.id.slice(5)) - Number(b.id.slice(5)));
  return { version, valid, dropped };
}

// ─── Earlier proposals ────────────────────────────────────────────────────────

/**
 * What a signal is about, stable across sessions: its kind and key. A signal's
 * `id` also hashes its first pointer (`file:line` of one transcript), so the
 * same friction in another session has another id; the fingerprint is how a
 * retro recognises it. A signal without a key has no subject to recognise.
 */
export function signalFingerprint(kind: string, key: string | null | undefined): string | null {
  if (typeof key !== 'string' || key.trim() === '') return null;
  return `${kind}:${crypto.createHash('sha1').update(`${kind}\u0000${key}`).digest('hex').slice(0, 10)}`;
}

/** The part of a bundle signal recurrence reads. */
export interface SignalFacts {
  id: string;
  kind: string;
  key: string | null;
  count: number;
}

/** A candidate an earlier retro of this project proposed. */
export interface PastProposal {
  retro: string;
  candidate: string;
  title: string;
  layer: CandidateLayer;
  /** The signal ids it cited. */
  signals: string[];
  /** Those signals as that retro's bundle recorded them; null when the bundle is gone. */
  facts: SignalFacts[] | null;
}

const SIGNAL_REF_RE = /^[a-z][a-z0-9-]{0,40}:[0-9a-f]{6,16}$/;

/** The signals a bundle's report carries (only `signals[]` has keys and counts). */
export function bundleSignalFacts(bundle: unknown): SignalFacts[] {
  const report = (bundle as { report?: { signals?: unknown } } | null)?.report;
  const list = Array.isArray(report?.signals) ? report.signals as Array<Record<string, unknown>> : [];
  return list
    .filter(s => s && typeof s['id'] === 'string' && typeof s['kind'] === 'string')
    .map(s => ({ id: s['id'] as string, kind: s['kind'] as string, key: typeof s['key'] === 'string' ? s['key'] : null, count: typeof s['count'] === 'number' ? s['count'] : 0 }));
}

function readBundleFacts(projectRoot: string, stem: string): SignalFacts[] | null {
  try {
    return bundleSignalFacts(JSON.parse(fs.readFileSync(path.join(projectRoot, retroPathsFor(projectRoot, stem).bundle), 'utf8')));
  } catch {
    return null;
  }
}

/**
 * The candidates of every earlier retro on disk (not `currentStem`), read as
 * written: an unreadable file contributes nothing, a candidate without a
 * layer is `project`. What their signals were about comes from that retro's
 * bundle under `.work/`, which stays on the machine that ran it.
 */
export function readPastProposals(projectRoot: string, currentStem: string | null): PastProposal[] {
  const out: PastProposal[] = [];
  for (const stem of retroStemsOnDisk(projectRoot)) {
    if (stem === currentStem) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(projectRoot, retroPathsFor(projectRoot, stem).candidates), 'utf8'));
    } catch {
      continue;
    }
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { candidates?: unknown }).candidates) ? (raw as { candidates: unknown[] }).candidates : [];
    let facts: SignalFacts[] | null | undefined;
    for (const item of list) {
      const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
      if (typeof c['id'] !== 'string' || !CANDIDATE_ID_RE.test(c['id'])) continue;
      const signals = Array.isArray(c['signals']) ? (c['signals'] as unknown[]).filter((s): s is string => typeof s === 'string' && SIGNAL_REF_RE.test(s)) : [];
      if (signals.length === 0) continue;
      if (facts === undefined) facts = readBundleFacts(projectRoot, stem);
      const layer = typeof c['layer'] === 'string' && (CANDIDATE_LAYERS as readonly string[]).includes(c['layer']) ? c['layer'] as CandidateLayer : 'project';
      out.push({
        retro: stem,
        candidate: c['id'],
        title: typeof c['title'] === 'string' ? c['title'] : '',
        layer,
        signals,
        facts: facts === null ? null : facts.filter(f => signals.includes(f.id)),
      });
    }
  }
  return out;
}

export type AppliedSource = 'runs' | 'checks' | 'lessons';

/** An earlier proposal whose signals this retro saw again (the bundle's `recurring.items[]`). */
export interface RecurringEntry {
  retro: string;
  candidate: string;
  title: string;
  layer: CandidateLayer;
  /** THIS retro's signal ids that are the same friction (same kind and key). */
  signals: string[];
  /** Whether a human applied it, and which journal says so. */
  applied: boolean;
  appliedBy: AppliedSource | null;
  /** The matched signals' summed count then and now. */
  countThen: number;
  countNow: number;
  /** Not applied and grown: a candidate answering it must be `high` (ADR-5209 §10). */
  escalate: boolean;
}

export const MAX_RECURRING = 30;

/**
 * Compare this retro's signals with the earlier proposals. Code decides what
 * recurred (same signal fingerprint: kind and key) and whether it was applied
 * (`stem:cand` in the runs, checks or lessons journal); the analyst says what
 * that means. An earlier retro whose bundle is gone cannot be compared and is
 * named in `unreadable`. Newest retro first, at most `max`.
 */
export function computeRecurring(input: {
  current: readonly SignalFacts[];
  past: readonly PastProposal[];
  applied: Readonly<Record<AppliedSource, ReadonlySet<string>>>;
  max?: number;
}): { items: RecurringEntry[]; omitted: number; unreadable: string[] } {
  const now = new Map<string, SignalFacts[]>();
  for (const s of input.current) {
    const fp = signalFingerprint(s.kind, s.key);
    if (fp === null) continue;
    now.set(fp, [...(now.get(fp) ?? []), s]);
  }
  const entries: RecurringEntry[] = [];
  const unreadable = new Set<string>();
  for (const p of input.past) {
    if (p.facts === null) {
      unreadable.add(p.retro);
      continue;
    }
    const matchedThen = p.facts.filter(f => { const fp = signalFingerprint(f.kind, f.key); return fp !== null && now.has(fp); });
    if (matchedThen.length === 0) continue;
    const fps = new Set(matchedThen.map(f => signalFingerprint(f.kind, f.key) as string));
    const matchedNow = [...fps].flatMap(fp => now.get(fp) ?? []);
    const key = `${p.retro}:${p.candidate}`;
    const appliedBy = (['runs', 'checks', 'lessons'] as const).find(src => input.applied[src].has(key)) ?? null;
    const countThen = matchedThen.reduce((n, f) => n + f.count, 0);
    const countNow = matchedNow.reduce((n, f) => n + f.count, 0);
    entries.push({
      retro: p.retro,
      candidate: p.candidate,
      title: p.title,
      layer: p.layer,
      signals: [...new Set(matchedNow.map(f => f.id))],
      applied: appliedBy !== null,
      appliedBy,
      countThen,
      countNow,
      escalate: appliedBy === null && countNow > countThen,
    });
  }
  entries.sort((a, b) => compareRetroStems(b.retro, a.retro) || Number(a.candidate.slice(5)) - Number(b.candidate.slice(5)));
  const max = Math.max(0, input.max ?? MAX_RECURRING);
  return { items: entries.slice(0, max), omitted: Math.max(0, entries.length - max), unreadable: [...unreadable].sort(compareRetroStems) };
}

/** `stem:cand` of every check journaled from a retro candidate. */
export function appliedFromChecks(journal: ChecksJournal): Set<string> {
  const out = new Set<string>();
  for (const c of journal.checks) if (c.source.retro && c.source.candidate) out.add(`${c.source.retro}:${c.source.candidate}`);
  return out;
}
