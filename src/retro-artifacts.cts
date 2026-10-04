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

import fs from 'node:fs';
import path from 'node:path';
import { retryRenameSync } from './shell-command-projection.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
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

/** The newest retro stem on disk (by date, then sequence), or null. */
export function latestRetroStem(projectRoot: string): string | null {
  let names: string[];
  try {
    names = fs.readdirSync(retroDir(projectRoot));
  } catch {
    return null;
  }
  const stems = names
    .filter(n => n.endsWith('.json') && n !== 'CHECKS.json')
    .map(n => n.slice(0, -'.json'.length))
    .filter(isRetroStem);
  if (stems.length === 0) return null;
  const order = (s: string): [string, number] => {
    const m = /^RETRO-(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/.exec(s) as RegExpExecArray;
    return [m[1], m[2] ? Number(m[2]) : 1];
  };
  stems.sort((a, b) => {
    const [da, na] = order(a);
    const [db, nb] = order(b);
    return da === db ? na - nb : da.localeCompare(db);
  });
  return stems[stems.length - 1];
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

/** Where a human sends a chosen candidate. Only checks (and their removal) are code work. */
export const CANDIDATE_ROUTE: Readonly<Record<CandidateCategory, 'quick' | 'capture'>> = Object.freeze({
  'navigation': 'capture',
  'mechanical': 'quick',
  'judgement': 'capture',
  'environment': 'capture',
  'steering': 'capture',
  'retire-check': 'quick',
});

export interface RetroCandidate {
  id: string;
  severity: typeof CANDIDATE_SEVERITIES[number];
  category: CandidateCategory;
  title: string;
  /** Evidence refs: signal ids, `inventory:<kind>:<subject>`, `check:<id>`. */
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
}

export interface EvidenceIndex {
  signals: ReadonlySet<string>;
  inventory: ReadonlySet<string>;
  checks: ReadonlySet<string>;
}

export interface CandidateValidation {
  valid: Array<RetroCandidate & { route: 'quick' | 'capture' }>;
  dropped: Array<{ id: string; reasons: string[] }>;
}

const CANDIDATE_ID_RE = /^cand-[1-9]\d{0,3}$/;
const STEERING_FILES = new Set(['claude.md', 'agents.md', 'gemini.md']);

function isEvidence(ref: string, ev: EvidenceIndex): boolean {
  if (ref.startsWith('inventory:')) return ev.inventory.has(ref);
  if (ref.startsWith('check:')) return ev.checks.has(ref.slice('check:'.length));
  return ev.signals.has(ref);
}

/** `inventory:<kind>:<subject>` refs for an inventory's findings. */
export function inventoryRefs(findings: ReadonlyArray<{ kind: string; subject: string }>): string[] {
  return findings.map(f => `inventory:${f.kind}:${f.subject}`);
}

/**
 * Validate the analyst's candidates against the evidence the bundle carried.
 * Every rule is mechanical; a candidate that breaks any is dropped with its
 * reasons, never repaired. Valid candidates come back ordered by severity,
 * then id, with their route.
 */
export function validateCandidates(raw: unknown, evidence: EvidenceIndex, opts: { projectRoot: string; patchesDir: string }): CandidateValidation {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { candidates?: unknown }).candidates)
    ? (raw as { candidates: unknown[] }).candidates
    : null;
  if (list === null) return { valid: [], dropped: [{ id: '(file)', reasons: ['candidates file must be { "version": 1, "candidates": [...] }'] }] };
  const valid: CandidateValidation['valid'] = [];
  const dropped: CandidateValidation['dropped'] = [];
  const seen = new Set<string>();
  const patchesAbs = path.join(opts.projectRoot, opts.patchesDir);
  list.forEach((item, i) => {
    const c = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const id = typeof c['id'] === 'string' ? c['id'] : `(index ${i})`;
    const reasons: string[] = [];
    if (!CANDIDATE_ID_RE.test(id)) reasons.push('id must look like cand-<n>');
    else if (seen.has(id)) reasons.push('duplicate id');
    seen.add(id);
    const category = c['category'] as CandidateCategory;
    if (!(CANDIDATE_CATEGORIES as readonly string[]).includes(category)) reasons.push(`category must be one of ${CANDIDATE_CATEGORIES.join(', ')}`);
    if (!(CANDIDATE_SEVERITIES as readonly string[]).includes(c['severity'] as string)) reasons.push(`severity must be one of ${CANDIDATE_SEVERITIES.join(', ')}`);
    for (const field of ['title', 'change']) {
      const v = c[field];
      if (typeof v !== 'string' || v.trim() === '') reasons.push(`${field} is required`);
    }
    const signals = Array.isArray(c['signals']) ? (c['signals'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
    if (signals.length === 0) reasons.push('no-signal: a candidate must point at the signal it answers');
    for (const s of signals) if (!isEvidence(s, evidence)) reasons.push(`unknown-signal: ${s}`);
    const target = nullableString(c['target']);
    if (category === 'judgement' && target && STEERING_FILES.has(path.basename(target).toLowerCase())) {
      reasons.push('judgement-in-steering-file: a judgement rule goes to the reviewer (agent_skills.*), not to CLAUDE.md/AGENTS.md');
    }
    const verify = nullableString(c['verify']);
    if ((category === 'mechanical' || category === 'retire-check') && !verify) reasons.push('missing-verify: a check needs a command that shows it firing');
    const patch = nullableString(c['patch']);
    if (patch) {
      const abs = tryWithinRoot(patch, opts.projectRoot, PathAcceptance.RelativeOnly);
      if (!abs || !tryWithinRoot(path.relative(patchesAbs, abs), patchesAbs, PathAcceptance.RelativeOnly)) {
        reasons.push(`patch must live under ${opts.patchesDir}/`);
      } else if (!fs.existsSync(abs)) {
        reasons.push(`patch not found: ${patch}`);
      }
    }
    if (reasons.length > 0) {
      dropped.push({ id, reasons });
      return;
    }
    valid.push({
      id,
      severity: c['severity'] as RetroCandidate['severity'],
      category,
      title: c['title'] as string,
      signals,
      existing: nullableString(c['existing']),
      target,
      change: c['change'] as string,
      patch,
      verify,
      route: CANDIDATE_ROUTE[category],
    });
  });
  const rank = (s: string) => (CANDIDATE_SEVERITIES as readonly string[]).indexOf(s);
  valid.sort((a, b) => rank(a.severity) - rank(b.severity) || Number(a.id.slice(5)) - Number(b.id.slice(5)));
  return { valid, dropped };
}
