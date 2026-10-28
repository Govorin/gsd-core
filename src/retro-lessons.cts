/**
 * Retro lessons — the journal of causes a retro traced OUTSIDE the project it
 * ran in (ADR-5209 §10).
 *
 * A retro's candidate names the layer that owns its cause: the project, the
 * user's own setup, GSD's shipped surface, or the runtime (host). A project
 * candidate lands in the project. The other three would repeat in every
 * repository with the same setup, so they are journaled once, per user, in
 * `${GSD_HOME||homedir()}/.gsd/lessons/LESSONS.json` — the same user-owned
 * store outside any repository that capability consent uses — and every later
 * retro, in any repository, sees them.
 *
 *   lesson      id (`lesson-<hash of layer + target + title>`), layer, target,
 *               title, change, status (open | fixed | wontfix), fixedIn, the
 *               occurrences (project, retro, candidate, date, signal ids, the
 *               GSD and runtime versions), regressions, and for gsd and host a
 *               `draft`: the text of an issue a human may file. Nothing is sent.
 *   record      from a retro candidate (`retro lessons record`); a candidate
 *               citing `lesson:<id>` adds to that lesson, an identical one to
 *               the lesson with its hash, otherwise a new lesson starts.
 *   regression  a `fixed` lesson that recurs on a version at or past `fixedIn`
 *               (or with either version unknown) is `open` again.
 *
 * Privacy (§3): only signal ids, the analyst's own words and versions are
 * journaled — never transcript text. The draft names a project by its
 * directory name, not its path.
 *
 * The read-edit-write holds `.LESSONS.lock` beside the journal (the shared
 * capability-lock primitive, through retro-artifacts' `withJournalLock`). A
 * journal that is not JSON, not the envelope, or holds a single malformed
 * entry fails closed (`lessons-invalid`): nothing is read from it and it is
 * never rewritten.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { withJournalLock, defaultJournalLock, writeTextAtomic, isRetroStem } from './retro-artifacts.cjs';
import type { JournalLock } from './retro-artifacts.cjs';

// ─── Layout ───────────────────────────────────────────────────────────────────

export const LESSON_LAYERS = Object.freeze(['user', 'gsd', 'host'] as const);
export type LessonLayer = typeof LESSON_LAYERS[number];

export const LESSON_STATUSES = Object.freeze(['open', 'fixed', 'wontfix'] as const);
export type LessonStatus = typeof LESSON_STATUSES[number];

/** The answer a journal that cannot be read whole gives, everywhere it is read. */
export const LESSONS_INVALID = 'lessons-invalid';

/** `${gsdHome || GSD_HOME || homedir()}/.gsd/lessons` — the capability-consent rule. */
export function lessonsDir(gsdHome?: string | null): string {
  const home = gsdHome || process.env['GSD_HOME'] || os.homedir();
  return path.join(home, '.gsd', 'lessons');
}

export function lessonsJournalPath(gsdHome?: string | null): string {
  return path.join(lessonsDir(gsdHome), 'LESSONS.json');
}

export function lessonsLockPath(gsdHome?: string | null): string {
  return path.join(lessonsDir(gsdHome), '.LESSONS.lock');
}

export function lessonDraftPath(id: string, gsdHome?: string | null): string {
  return path.join(lessonsDir(gsdHome), 'drafts', `${id}.md`);
}

// ─── Shape ────────────────────────────────────────────────────────────────────

export interface LessonOccurrence {
  /** The repository, `~`-folded (the main worktree's root, so a repository's worktrees count once). */
  project: string;
  retro: string;
  candidate: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signal ids of the candidate (plain ids only), at most `MAX_OCCURRENCE_SIGNALS`. */
  signals: string[];
  gsdVersion: string | null;
  hostVersion: string | null;
}

export interface Lesson {
  id: string;
  layer: LessonLayer;
  target: string;
  title: string;
  change: string;
  status: LessonStatus;
  /** The GSD or runtime version that fixed it (as the human said), or null. */
  fixedIn: string | null;
  /** How many times a fixed lesson recurred and was opened again. */
  regressions: number;
  createdAt: string;
  updatedAt: string;
  occurrences: LessonOccurrence[];
  /** For gsd and host: the text of an issue a human may file; null for user. */
  draft: string | null;
}

export interface LessonsJournal {
  version: 1;
  lessons: Lesson[];
}

export interface LessonsRead {
  status: 'ok' | 'absent' | 'invalid';
  /** `lessons-invalid` when the journal cannot be read whole, else null. */
  reason: typeof LESSONS_INVALID | null;
  journal: LessonsJournal;
  problems: string[];
}

export const MAX_OCCURRENCE_SIGNALS = 20;
const TEXT_MAX = Object.freeze({ target: 300, title: 300, change: 2000, project: 400, version: 64, draft: 12000 });
const LESSON_ID_RE = /^lesson-[0-9a-f]{10}$/;
const CANDIDATE_ID_RE = /^cand-[1-9]\d{0,3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SIGNAL_ID_RE = /^[a-z][a-z0-9-]{0,40}:[0-9a-f]{6,16}$/;

function emptyJournal(): LessonsJournal {
  return { version: 1, lessons: [] };
}

function boundedText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

function nullableVersion(v: unknown): boolean {
  return v === null || boundedText(v, TEXT_MAX.version);
}

function occurrenceProblems(o: unknown): string[] {
  if (!o || typeof o !== 'object') return ['occurrence is not an object'];
  const e = o as Partial<LessonOccurrence>;
  const problems: string[] = [];
  if (!boundedText(e.project, TEXT_MAX.project)) problems.push('project must be a non-empty string');
  if (typeof e.retro !== 'string' || !isRetroStem(e.retro)) problems.push(`retro must be a retro stem, got ${JSON.stringify(e.retro)}`);
  if (typeof e.candidate !== 'string' || !CANDIDATE_ID_RE.test(e.candidate)) problems.push(`candidate must be cand-<n>, got ${JSON.stringify(e.candidate)}`);
  if (typeof e.date !== 'string' || !DATE_RE.test(e.date)) problems.push(`date must be YYYY-MM-DD, got ${JSON.stringify(e.date)}`);
  if (!Array.isArray(e.signals) || e.signals.length > MAX_OCCURRENCE_SIGNALS || !e.signals.every(s => typeof s === 'string' && SIGNAL_ID_RE.test(s))) {
    problems.push(`signals must be at most ${MAX_OCCURRENCE_SIGNALS} signal ids`);
  }
  if (!nullableVersion(e.gsdVersion)) problems.push('gsdVersion must be a version or null');
  if (!nullableVersion(e.hostVersion)) problems.push('hostVersion must be a version or null');
  return problems;
}

/** Problems with one lesson object; empty when it is well-formed. */
export function lessonProblems(l: unknown): string[] {
  if (!l || typeof l !== 'object') return ['not an object'];
  const e = l as Partial<Lesson>;
  const problems: string[] = [];
  if (typeof e.id !== 'string' || !LESSON_ID_RE.test(e.id)) problems.push(`id must be lesson-<10 hex>, got ${JSON.stringify(e.id)}`);
  if (typeof e.layer !== 'string' || !(LESSON_LAYERS as readonly string[]).includes(e.layer)) problems.push(`layer must be one of ${LESSON_LAYERS.join(', ')}, got ${JSON.stringify(e.layer)}`);
  if (!boundedText(e.target, TEXT_MAX.target)) problems.push(`target must be a non-empty string of at most ${TEXT_MAX.target} characters`);
  if (!boundedText(e.title, TEXT_MAX.title)) problems.push(`title must be a non-empty string of at most ${TEXT_MAX.title} characters`);
  if (!boundedText(e.change, TEXT_MAX.change)) problems.push(`change must be a non-empty string of at most ${TEXT_MAX.change} characters`);
  if (typeof e.status !== 'string' || !(LESSON_STATUSES as readonly string[]).includes(e.status)) problems.push(`status must be one of ${LESSON_STATUSES.join(', ')}, got ${JSON.stringify(e.status)}`);
  if (!nullableVersion(e.fixedIn)) problems.push('fixedIn must be a version or null');
  if (typeof e.regressions !== 'number' || !Number.isInteger(e.regressions) || e.regressions < 0) problems.push('regressions must be a non-negative integer');
  for (const k of ['createdAt', 'updatedAt'] as const) {
    const v = e[k];
    if (typeof v !== 'string' || !ISO_INSTANT_RE.test(v) || Number.isNaN(Date.parse(v))) problems.push(`${k} must be an ISO instant in UTC`);
  }
  if (!Array.isArray(e.occurrences)) problems.push('occurrences must be an array');
  else e.occurrences.forEach((o, i) => { for (const p of occurrenceProblems(o)) problems.push(`occurrences[${i}]: ${p}`); });
  if (!(e.draft === null || boundedText(e.draft, TEXT_MAX.draft))) problems.push('draft must be text or null');
  return problems;
}

/**
 * Parse LESSONS.json text. Unlike CHECKS.json, one malformed lesson makes the
 * whole journal invalid: a lesson that cannot be read would otherwise be
 * started again by the next record, and the rewrite would erase it.
 */
export function parseLessonsJournal(text: string): LessonsRead {
  const invalid = (problems: string[]): LessonsRead => ({ status: 'invalid', reason: LESSONS_INVALID, journal: emptyJournal(), problems });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return invalid([`LESSONS.json is not JSON: ${(err as Error).message}`]);
  }
  const obj = parsed as { version?: unknown; lessons?: unknown };
  if (!obj || typeof obj !== 'object' || obj.version !== 1 || !Array.isArray(obj.lessons)) {
    return invalid(['LESSONS.json must be { "version": 1, "lessons": [...] }']);
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  obj.lessons.forEach((raw: unknown, i: number) => {
    const p = lessonProblems(raw);
    const id = (raw as { id?: unknown })?.id;
    if (p.length === 0 && seen.has(id as string)) p.push(`duplicate id ${String(id)}`);
    if (typeof id === 'string') seen.add(id);
    if (p.length > 0) problems.push(`lessons[${i}]: ${p.join('; ')}`);
  });
  if (problems.length > 0) return invalid(problems);
  return { status: 'ok', reason: null, journal: { version: 1, lessons: (obj.lessons as Lesson[]).map(copyLesson) }, problems: [] };
}

function copyLesson(l: Lesson): Lesson {
  return {
    id: l.id,
    layer: l.layer,
    target: l.target,
    title: l.title,
    change: l.change,
    status: l.status,
    fixedIn: l.fixedIn ?? null,
    regressions: l.regressions,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
    occurrences: l.occurrences.map(o => ({
      project: o.project, retro: o.retro, candidate: o.candidate, date: o.date,
      signals: [...o.signals], gsdVersion: o.gsdVersion ?? null, hostVersion: o.hostVersion ?? null,
    })),
    draft: l.draft ?? null,
  };
}

export function readLessonsJournal(gsdHome?: string | null): LessonsRead {
  let text: string;
  try {
    text = fs.readFileSync(lessonsJournalPath(gsdHome), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'absent', reason: null, journal: emptyJournal(), problems: [] };
    return { status: 'invalid', reason: LESSONS_INVALID, journal: emptyJournal(), problems: [`LESSONS.json unreadable: ${(err as Error).message}`] };
  }
  return parseLessonsJournal(text);
}

/** Stable serialisation: lessons ordered by id, keys in a fixed order. */
export function formatLessonsJournal(journal: LessonsJournal): string {
  const lessons = [...journal.lessons].sort((a, b) => a.id.localeCompare(b.id)).map(copyLesson);
  return `${JSON.stringify({ version: 1, lessons }, null, 2)}\n`;
}

// ─── Identity ─────────────────────────────────────────────────────────────────

const HOST_VERSION_RE = /^([A-Za-z0-9._-]+)@[^\s:]+/;

/**
 * The part of a target that names the cause, not the moment: no `#anchor`
 * case or spacing, and for a host target no version — the same runtime defect
 * on the next version is the same lesson (and, once fixed, a regression).
 */
export function normalizeLessonTarget(layer: LessonLayer, target: string): string {
  let t = target.trim().replace(/\s+/g, ' ').toLowerCase();
  if (layer === 'host') t = t.replace(HOST_VERSION_RE, '$1');
  else {
    const hash = t.indexOf('#');
    if (hash >= 0) t = t.slice(0, hash).trim();
    t = t.replace(/\/{2,}/g, '/');
  }
  return t;
}

export function lessonId(layer: LessonLayer, target: string, title: string): string {
  const key = `${layer}\n${normalizeLessonTarget(layer, target)}\n${title.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  return `lesson-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
}

/** `a` vs `b` by their `major.minor.patch` prefix; null when either has none. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// ─── Edits ────────────────────────────────────────────────────────────────────

export interface LessonInput {
  layer: LessonLayer;
  target: string;
  title: string;
  change: string;
  /** Lesson ids the candidate cited (`lesson:<id>`); the first that exists takes the occurrence. */
  cited: readonly string[];
  occurrence: LessonOccurrence;
}

export const RECORD_OUTCOME = Object.freeze({
  CREATED: 'created',
  APPENDED: 'appended',
  DUPLICATE: 'duplicate',
  REGRESSION: 'regression',
  BEFORE_FIX: 'before-fix',
} as const);
export type RecordOutcome = typeof RECORD_OUTCOME[keyof typeof RECORD_OUTCOME];

export type LessonEdit =
  | { ok: true; journal: LessonsJournal; lesson: Lesson; outcome: RecordOutcome }
  | { ok: false; reason: string };

/** The version a fix of this layer is measured against: GSD's for gsd, the runtime's for host. */
function fixVersion(layer: LessonLayer, o: LessonOccurrence): string | null {
  if (layer === 'gsd') return o.gsdVersion;
  if (layer === 'host') return o.hostVersion;
  return null;
}

/**
 * Add one occurrence. The same project, retro and candidate twice is one
 * occurrence (`duplicate`, nothing changes). A `fixed` lesson that recurs is
 * `open` again (`regression`), unless the occurrence ran a version known to be
 * older than `fixedIn` (`before-fix`: the fix had not reached it).
 */
export function recordLesson(journal: LessonsJournal, input: LessonInput, now: Date): LessonEdit {
  const occ: LessonOccurrence = { ...input.occurrence, signals: input.occurrence.signals.slice(0, MAX_OCCURRENCE_SIGNALS) };
  const occBad = occurrenceProblems(occ);
  if (occBad.length > 0) return { ok: false, reason: occBad.join('; ') };
  const at = now.toISOString();
  const byId = new Map(journal.lessons.map(l => [l.id, l]));
  const citedHit = input.cited.find(id => byId.has(id));
  const id = citedHit ?? lessonId(input.layer, input.target, input.title);
  const existing = byId.get(id);
  let lesson: Lesson;
  let outcome: RecordOutcome;
  if (!existing) {
    lesson = {
      id,
      layer: input.layer,
      target: input.target.trim(),
      title: input.title.trim(),
      change: input.change.trim(),
      status: 'open',
      fixedIn: null,
      regressions: 0,
      createdAt: at,
      updatedAt: at,
      occurrences: [occ],
      draft: null,
    };
    outcome = RECORD_OUTCOME.CREATED;
  } else {
    if (existing.occurrences.some(o => o.project === occ.project && o.retro === occ.retro && o.candidate === occ.candidate)) {
      return { ok: true, journal, lesson: existing, outcome: RECORD_OUTCOME.DUPLICATE };
    }
    lesson = { ...copyLesson(existing), updatedAt: at, occurrences: [...existing.occurrences.map(o => ({ ...o, signals: [...o.signals] })), occ] };
    outcome = RECORD_OUTCOME.APPENDED;
    if (existing.status === 'fixed') {
      const current = fixVersion(existing.layer, occ);
      const cmp = current !== null && existing.fixedIn !== null ? compareVersions(current, existing.fixedIn) : null;
      if (cmp !== null && cmp < 0) {
        outcome = RECORD_OUTCOME.BEFORE_FIX;
      } else {
        lesson.status = 'open';
        lesson.regressions = existing.regressions + 1;
        outcome = RECORD_OUTCOME.REGRESSION;
      }
    }
  }
  lesson.draft = lesson.layer === 'user' ? null : renderLessonDraft(lesson);
  const bad = lessonProblems(lesson);
  if (bad.length > 0) return { ok: false, reason: bad.join('; ') };
  const lessons = existing ? journal.lessons.map(l => (l.id === id ? lesson : l)) : [...journal.lessons, lesson];
  return { ok: true, journal: { version: 1, lessons }, lesson, outcome };
}

export function closeLesson(journal: LessonsJournal, id: string, status: 'fixed' | 'wontfix', fixedIn: string | null, now: Date): LessonEdit {
  const existing = journal.lessons.find(l => l.id === id);
  if (!existing) return { ok: false, reason: `no lesson with id ${JSON.stringify(id)}` };
  if (fixedIn !== null && (status !== 'fixed' || !boundedText(fixedIn, TEXT_MAX.version) || compareVersions(fixedIn, '0.0.0') === null)) {
    return { ok: false, reason: '--fixed-in is a version (major.minor.patch) and goes with --status fixed' };
  }
  const lesson: Lesson = { ...copyLesson(existing), status, fixedIn: status === 'fixed' ? fixedIn : null, updatedAt: now.toISOString() };
  lesson.draft = lesson.layer === 'user' ? null : renderLessonDraft(lesson);
  return { ok: true, journal: { version: 1, lessons: journal.lessons.map(l => (l.id === id ? lesson : l)) }, lesson, outcome: RECORD_OUTCOME.APPENDED };
}

// ─── Views ────────────────────────────────────────────────────────────────────

export function projectCount(l: Lesson): number {
  return new Set(l.occurrences.map(o => o.project)).size;
}

const DRAFT_OCCURRENCES = 10;

/**
 * The issue text for a gsd or host lesson: what, the evidence (counts, dates,
 * versions, signal ids — no transcript text), where, the proposal. A project
 * is named by its directory name.
 */
export function renderLessonDraft(l: Lesson): string {
  const distinct = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
  const dates = l.occurrences.map(o => o.date).sort();
  const gsdVersions = distinct(l.occurrences.map(o => o.gsdVersion));
  const hostVersions = distinct(l.occurrences.map(o => o.hostVersion));
  const where = l.layer === 'gsd' ? 'GSD' : 'the runtime';
  const lines = [
    `# ${l.title}`,
    '',
    `- Layer: ${l.layer} — \`${l.target}\``,
    `- Status: ${l.status}${l.fixedIn ? ` (fixedIn ${l.fixedIn})` : ''}${l.regressions > 0 ? `, ${l.regressions} regression(s)` : ''}`,
    `- Seen: ${l.occurrences.length} time(s) in ${projectCount(l)} project(s), ${dates[0] ?? '?'} → ${dates[dates.length - 1] ?? '?'}`,
    `- GSD: ${gsdVersions.join(', ') || 'unknown'} · host: ${hostVersions.join(', ') || 'unknown'}`,
    '',
    '## What happens',
    '',
    `Session retros traced this friction to ${where} (\`${l.target}\`), not to the repositories they ran in: it recurs in each of them with the same setup.`,
    '',
    '## Evidence',
    '',
    ...l.occurrences.slice(-DRAFT_OCCURRENCES).map(o => `- ${o.date} · ${path.basename(o.project) || o.project} · ${o.retro} ${o.candidate} · signals: ${o.signals.join(', ') || 'none'}`),
    ...(l.occurrences.length > DRAFT_OCCURRENCES ? [`- … ${l.occurrences.length - DRAFT_OCCURRENCES} earlier occurrence(s)`] : []),
    '',
    '## Proposal',
    '',
    l.change,
    '',
  ];
  return lines.join('\n');
}

export interface BundleLesson {
  id: string;
  layer: LessonLayer;
  target: string;
  title: string;
  status: LessonStatus;
  fixedIn: string | null;
  occurrences: number;
  projects: number;
}

export interface BundleLessons {
  status: LessonsRead['status'];
  reason: LessonsRead['reason'];
  problems: string[];
  items: BundleLesson[];
  /** Lessons left out past `max`. */
  omitted: number;
}

export const MAX_BUNDLE_LESSONS = 50;
const STATUS_RANK: Readonly<Record<LessonStatus, number>> = Object.freeze({ open: 0, fixed: 1, wontfix: 2 });

/**
 * What the analyst sees of the journal: every lesson cut to its headline,
 * open first, then by how many projects and occurrences it has, at most
 * `max`. A journal that cannot be read gives no lessons and says why.
 */
export function bundleLessons(read: LessonsRead, max: number = MAX_BUNDLE_LESSONS): BundleLessons {
  if (read.status === 'invalid') return { status: 'invalid', reason: LESSONS_INVALID, problems: read.problems, items: [], omitted: 0 };
  const items = read.journal.lessons.map(l => ({
    id: l.id, layer: l.layer, target: l.target, title: l.title, status: l.status, fixedIn: l.fixedIn,
    occurrences: l.occurrences.length, projects: projectCount(l),
  }));
  items.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.projects - a.projects || b.occurrences - a.occurrences || a.id.localeCompare(b.id));
  const kept = items.slice(0, Math.max(0, max));
  return { status: read.status, reason: null, problems: [], items: kept, omitted: items.length - kept.length };
}

/** `stem:cand` of every candidate of `project` already journaled as a lesson. */
export function appliedFromLessons(journal: LessonsJournal, project: string): Set<string> {
  const out = new Set<string>();
  for (const l of journal.lessons) for (const o of l.occurrences) if (o.project === project) out.add(`${o.retro}:${o.candidate}`);
  return out;
}

// ─── Journal edit ─────────────────────────────────────────────────────────────

export type LessonsWrite =
  | { ok: true; lesson: Lesson; outcome: RecordOutcome; journal: string; draft: string | null }
  | { ok: false; reason: typeof LESSONS_INVALID | 'locked' | 'refused'; message: string };

/**
 * Run one read-edit-write of the journal under its lock, and refresh the
 * edited lesson's draft file. An invalid journal is never rewritten.
 */
export function editLessons(
  edit: (journal: LessonsJournal) => LessonEdit,
  opts: { gsdHome?: string | null; lock?: JournalLock } = {},
): LessonsWrite {
  const file = lessonsJournalPath(opts.gsdHome);
  const locked = withJournalLock(lessonsLockPath(opts.gsdHome), (): LessonsWrite => {
    const read = readLessonsJournal(opts.gsdHome);
    if (read.status === 'invalid') {
      return { ok: false, reason: LESSONS_INVALID, message: `${file} cannot be read (${read.problems.join('; ')}); it was left unchanged — fix or move it` };
    }
    const r = edit(read.journal);
    if (!r.ok) return { ok: false, reason: 'refused', message: r.reason };
    const draftFile = r.lesson.draft === null ? null : lessonDraftPath(r.lesson.id, opts.gsdHome);
    if (r.outcome !== RECORD_OUTCOME.DUPLICATE) {
      writeTextAtomic(file, formatLessonsJournal(r.journal));
      if (draftFile && r.lesson.draft) writeTextAtomic(draftFile, r.lesson.draft);
    }
    return { ok: true, lesson: r.lesson, outcome: r.outcome, journal: file, draft: draftFile };
  }, opts.lock ?? defaultJournalLock);
  return locked.ok ? locked.value : { ok: false, reason: 'locked', message: locked.reason };
}

// ─── Where the retro runs ─────────────────────────────────────────────────────

/** A path with the home directory folded to `~`. */
export function foldHome(p: string, homeDir: string = os.homedir()): string {
  if (homeDir && homeDir.length > 1 && (p === homeDir || p.startsWith(`${homeDir}${path.sep}`))) { // allow-handrolled-containment: display folding of a path to ~, not a containment decision
    return `~${p.slice(homeDir.length).split(path.sep).join('/')}`;
  }
  return p.split(path.sep).join('/');
}

interface WorktreeSafetyModule {
  resolveWorktreeLinkage(cwd: string): { effectiveRoot: string };
}

/**
 * The repository a retro ran in, as lessons count it: the main worktree's
 * root (a linked worktree is the same repository), `~`-folded.
 */
export function projectKey(cwd: string, homeDir: string = os.homedir()): string {
  let root = cwd;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ws = require('./worktree-safety.cjs') as WorktreeSafetyModule;
    root = ws.resolveWorktreeLinkage(cwd).effectiveRoot || cwd;
  } catch { /* not a git repository: the directory itself */ }
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* keep the resolved path */ }
  let realHome = homeDir;
  try { realHome = fs.realpathSync(homeDir); } catch { /* keep the given home */ }
  return foldHome(real, realHome);
}

interface CapabilityLoaderModule {
  readHostVersion(libDir?: string): string;
}

/**
 * The GSD install this `gsd-tools` runs from: the directory that holds
 * `gsd-core/` (the source checkout, or a runtime's config directory), and its
 * version (`gsd-core/VERSION`, else `package.json`; the identity verb's rule).
 * Null root when the layout is not recognised; null version when unknown.
 */
export function resolveGsdInstall(libDir: string = __dirname): { root: string | null; version: string | null } {
  const root = path.resolve(libDir, '..', '..', '..');
  const ok = fs.existsSync(path.join(root, 'gsd-core', 'bin'));
  let version: string | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loader = require('./capability-loader.cjs') as CapabilityLoaderModule;
    const v = loader.readHostVersion(libDir);
    version = v === '0.0.0' ? null : v;
  } catch { /* version unknown */ }
  return { root: ok ? root : null, version };
}
