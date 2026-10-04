/**
 * Evaluation-scope resolver (#5164, epic #5056, ADR-5057 §4 second bullet): the ONE answer to
 * "which commits and which file set does this gate or workflow step evaluate for this plan,
 * phase or quick task".
 *
 * Before this module every consumer derived its own answer — `HEAD~1..HEAD`, `DIFF_BASE..HEAD`,
 * `git log --all --grep` — and all of them disagreed with each other and with the work they
 * meant to scope. Three constraints from the design lock hold here:
 *
 *   1. The scope is the UNION of each commit's own file set, never a range. A range keeps every
 *      interleaved non-phase commit in its window (measured on a 9,676-commit repo: the range
 *      held 23, 194 and 602 files where the union of the phase's commits held 9, 42 and 69).
 *   2. Only commits reachable from the evaluated ref count (`git log --all` is gone). A commit
 *      that lives only on another branch is NAMED in `unreachable` and contributes nothing.
 *   3. An empty union never becomes an empty scope that reviews nothing and reports success. It
 *      degrades to wider evidence (the phase-directory range) and SAYS so (`status: 'degraded'`,
 *      `reason`). What the union drops is named by path, not counted: `outsideUnion` (range
 *      minus union) and `missingOnDisk` (scoped paths that no longer exist).
 *
 * A phase's commits are the `## Task Commits` rows of its SUMMARY files (path-anchored: no commit
 * message grep, the class re-fixed in #2989/#3191/#3503/#3995). A plan's commits are the
 * reachable commits whose SUBJECT is `<type>(<phase>-<plan>):`, anchored and zero-padding
 * tolerant (#4003). The row parse is a port of the byte-parity model from the closed PR #4127.
 *
 * Every git call goes through the `execGit` seam, which bounds each subprocess (its default
 * budget); a timeout or a missing git is `unresolvable`, never a throw and never an empty scope.
 *
 * A `window` unit (ADR-5208, extending ADR-5057 §4) is the work that LANDED on `until` inside a
 * period: `since` is a duration (`7d`), a UTC date, a ref, or `last` (the tip the previous window
 * review recorded in `.planning/reviews/LAST-WINDOW.json`). The window is the commit SET
 * `base..until` — `base` is the ref itself, or for a time form the newest first-parent commit
 * older than the boundary — and its scope is still the union of each commit's own files (a merge
 * contributes only what it introduced itself, `--cc`). Each commit is attributed to the phase whose
 * SUMMARY `## Task Commits` names it, else `unattributed`. An empty window degrades and says why.
 *
 * A gate module: imports no io module and writes nothing; `evaluateEvaluationScope` returns a
 * `GateResult` the command router formats (`check evaluation-scope`).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { gateVerdict, gateUsageFailure, isGateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolveContainedPath, resolvePhaseDirOrEmpty } from './gate-phase-context.cjs';
import { escapeEre } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorMod = require('./phase-locator.cjs');
const { listActiveAndArchivedPhaseDirs } = phaseLocatorMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('./phase-id.cjs');
const { extractPhaseToken } = phaseIdMod;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * What is being evaluated. A plan id is `<phase>-<plan>` ("03-01", "3-1", "03A-02"). A window is
 * the work that landed on `until` (default: the `ref` option, else `HEAD`) since `since` — see
 * `parseWindowSince` for the accepted forms.
 */
export type ScopeUnit =
  | { kind: 'phase'; phase: string; /** An already-resolved absolute phase directory (skips the phase lookup). */ phaseDir?: string }
  | { kind: 'plan'; planId: string }
  | { kind: 'quick'; id: string }
  | { kind: 'window'; since: string; until?: string };

export interface ScopeOptions {
  /** The ref the scope is evaluated on. Default `HEAD`. */
  ref?: string;
  /** Commits that are ancestors of (or equal to) this commit are excluded — wave scoping (#3661). */
  since?: string;
  /** Git pathspecs: only commits touching one of these count (plan/quick units). */
  pathspecs?: readonly string[];
  /** Bound a plan/quick lookup at the latest reachable tag (`<tag>..<ref>`). Default false. */
  milestoneBound?: boolean;
  /** Carry each commit's body in `commits[].body`. Default false. */
  includeBody?: boolean;
  /** Carry each commit's own file list in `commits[].files`. Default true for phase, false otherwise. */
  includeFiles?: boolean;
  /** Maximum commits a subject lookup returns. Default 200. */
  maxCommits?: number;
  /** Plan/quick units only: answer "which commits" and skip the per-commit file lookups. */
  commitsOnly?: boolean;
  /** Plan/quick units only: only commits made since this git date ("1 hour ago", "2026-10-01"). */
  committedSince?: string;
  /** Git runner. Default: `execGit` from shell-command-projection. */
  execGit?: GitRunner;
  /** Shas per git argv chunk (default 400, safely under the Windows 32,767-char limit). A test seam. */
  shaChunk?: number;
  /** Window units only: the clock a duration (`7d`) is measured back from. Default `Date`. */
  clock?: { now(): number };
}

export type GitRunner = (args: string[], opts?: { cwd?: string }) => SpawnResultOutput;

export interface ScopeCommit {
  sha: string;
  subject: string;
  body?: string;
  files?: string[];
  /** Window units only: the phase whose SUMMARY `## Task Commits` names this commit, or `unattributed`. */
  phase?: string;
}

export type ScopeSource = 'task-commits' | 'plan-subjects' | 'quick-subjects' | 'phase-range' | 'window-commits' | 'none';

/** How a window's `since` was written (see `parseWindowSince`). */
export type WindowSince =
  | { kind: 'duration'; value: string; seconds: number }
  | { kind: 'date'; value: string; epochSeconds: number }
  | { kind: 'ref'; value: string }
  | { kind: 'last'; value: string };

/** What a window unit resolved to — present on the scope of a window unit only. */
export interface WindowScope {
  since: string;
  sinceKind: WindowSince['kind'];
  until: string;
  /** `until` as a full sha. */
  tip: string;
  /** Commits reachable from `base` are outside the window; null means the window reaches the root. */
  base: string | null;
  /** Time forms: the inclusive lower bound on the committer date, ISO 8601 UTC; null for ref / last. */
  boundary: string | null;
  /** Phase → its directory (relative, posix) and the window commits its SUMMARYs name, in log order. */
  phases: Record<string, { dir: string; commits: string[] }>;
  /** Window commits no SUMMARY names, by sha, in log order. */
  unattributed: string[];
  /** Phase directories or SUMMARY files that could not be read, so attribution may be incomplete. */
  unreadablePhaseDirs: string[];
}

/**
 * `resolved`      the scope is exactly what the unit's own commits touched.
 * `degraded`      the preferred evidence was absent or empty; `files` come from WIDER evidence and
 *                 `reason` says why. A consumer must surface this, never treat it as a clean scope.
 * `unresolvable`  git or the phase could not be read; `files` is empty and means "could not look".
 */
export type ScopeStatus = 'resolved' | 'degraded' | 'unresolvable';

export interface EvaluationScope {
  unit: ScopeUnit;
  status: ScopeStatus;
  source: ScopeSource;
  /**
   * Present whenever `status` is not `resolved`, and for a plan/quick unit that matched no commits
   * (`no-matching-commits`: git was read and the answer is "none" — not an unread scope).
   */
  reason: string | null;
  commits: ScopeCommit[];
  /** Every path the scope touched, deleted ones included. */
  changedFiles: string[];
  /** `changedFiles` that exist on disk — the reviewable set. */
  files: string[];
  /** `changedFiles` that no longer exist on disk, by name. */
  missingOnDisk: string[];
  /** Range minus union: files changed in the phase window by commits that are not the unit's. */
  outsideUnion: string[];
  /** Listed commit ids not reachable from the ref (other branch, dropped by a rebase), by name. */
  unreachable: string[];
  /** The phase-start anchor (parent of the commit that first added the phase dir); a window's `base`; null if none. */
  rangeBase: string | null;
  /** Window units only. */
  window?: WindowScope;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Paths that are never part of a code-review or UI scope (planning artifacts, lockfiles). */
export const SCOPE_EXCLUSION_PATHSPECS: readonly string[] = Object.freeze([
  ':!.planning/', ':!ROADMAP.md', ':!STATE.md',
  ':!*-SUMMARY.md', ':!*-VERIFICATION.md', ':!*-PLAN.md',
  ':!package-lock.json', ':!yarn.lock', ':!Gemfile.lock', ':!poetry.lock',
]);

/** 41 chars per sha; 400 of them stay well under the 28K Windows-safe argv chunk. */
const SHA_CHUNK = 400;
const DEFAULT_MAX_COMMITS = 200;
const MAX_PATHSPECS = 20;

// ─── Window `since` grammar and the LAST-WINDOW marker (ADR-5208) ─────────────

/** The `since` keyword meaning "from the tip the previous window review recorded". */
export const WINDOW_SINCE_LAST = 'last';

/** The attribution of a window commit no phase SUMMARY names. */
export const UNATTRIBUTED = 'unattributed';

const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = Object.freeze({ h: 3600, d: 86400, w: 604800 });
const DURATION = /^([1-9][0-9]{0,3})([hdw])$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})$/;

function epochSecondsOf(iso: string, y: string, mo: string, d: string): number | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  // Date.parse rolls 2026-02-30 over to March; a date that does not round-trip is not a date.
  const probe = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(mo) - 1 || probe.getUTCDate() !== Number(d)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Parse a window's `since`, or null when it is none of the accepted forms. In precedence order:
 * the keyword `last`; a duration `<1-9999><h|d|w>`; a date `YYYY-MM-DD` (00:00:00 UTC); a date-time
 * `YYYY-MM-DDTHH:MM[:SS]` with an explicit `Z` or `±HH:MM` offset; anything else a git ref
 * (`isSafeRefArgument`). A branch literally named `7d` or `last` is reached as `refs/heads/7d`.
 */
export function parseWindowSince(raw: string): WindowSince | null {
  if (raw === WINDOW_SINCE_LAST) return { kind: 'last', value: raw };
  const duration = DURATION.exec(raw);
  if (duration) {
    return { kind: 'duration', value: raw, seconds: Number(duration[1]) * (DURATION_UNIT_SECONDS[duration[2] ?? ''] ?? 0) };
  }
  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) {
    const epochSeconds = epochSecondsOf(`${raw}T00:00:00Z`, dateOnly[1] ?? '', dateOnly[2] ?? '', dateOnly[3] ?? '');
    return epochSeconds === null ? null : { kind: 'date', value: raw, epochSeconds };
  }
  const dateTime = DATE_TIME.exec(raw);
  if (dateTime) {
    if (Number(dateTime[4]) > 23 || Number(dateTime[5]) > 59 || Number(dateTime[6] ?? '0') > 59) return null;
    const epochSeconds = epochSecondsOf(raw, dateTime[1] ?? '', dateTime[2] ?? '', dateTime[3] ?? '');
    return epochSeconds === null ? null : { kind: 'date', value: raw, epochSeconds };
  }
  // An out-of-range duration or a malformed date is refused, never re-read as a ref.
  if (/^\d+[hdw]$/.test(raw) || /^\d{4}-\d{1,2}-\d{1,2}/.test(raw)) return null;
  return isSafeRefArgument(raw) ? { kind: 'ref', value: raw } : null;
}

/** Where the previous window review's tip is recorded, under the (workstream-aware) planning dir. */
export function lastWindowMarkerPath(projectDir: string): string {
  return path.join(planningDir(projectDir), 'reviews', 'LAST-WINDOW.json');
}

/** The tip a finished window review records, read back by the next `--since last`. */
export interface LastWindowMarker {
  version: 1;
  /** Full sha of the reviewed window's tip. */
  tip: string;
  /** The `since` and `until` the reviewed window was asked for, as written. */
  since: string;
  until: string;
  /** ISO 8601 instant the review finished. */
  reviewedAt: string;
  /** The REVIEW.md the window review wrote (relative, posix), or null. */
  review: string | null;
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The marker, or null when the text is not a well-formed version-1 marker. */
export function parseLastWindowMarker(text: string): LastWindowMarker | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const record = data as Record<string, unknown>;
  const { version, tip, since, until, reviewedAt, review } = record;
  if (version !== 1 || typeof tip !== 'string' || !FULL_SHA.test(tip)) return null;
  if (typeof since !== 'string' || typeof until !== 'string' || typeof reviewedAt !== 'string') return null;
  if (review !== null && typeof review !== 'string') return null;
  return { version: 1, tip, since, until, reviewedAt, review };
}

/** The marker's file text; the window-review step writes it once its REVIEW.md exists. */
export function formatLastWindowMarker(marker: Omit<LastWindowMarker, 'version'>): string {
  const ordered: LastWindowMarker = {
    version: 1, tip: marker.tip, since: marker.since, until: marker.until, reviewedAt: marker.reviewedAt, review: marker.review,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ─── SUMMARY `## Task Commits` extraction (port of the #4127 model) ───────────

const TASK_COMMITS_HEADING = /^## Task Commits[ \t\r]*$/;
const NEXT_HEADING = /^## /;
const TASK_ROW_PREFIX = /^[ \t]*(?:[0-9]+\.|[-*])?[ \t]*\*\*Task[ \t]+[0-9]+:/;
const HEX_TOKEN = /`[0-9a-f]{7,40}`/g;

/**
 * The commit ids a SUMMARY names, in document order, duplicates included. Section-scoped (every
 * `## Task Commits` section), row-scoped (an optional list marker, the `**Task N:` label closed by
 * its FIRST `**`) and backtick-anchored: only backticked lowercase hex AFTER that closing bold
 * counts, so a sha quoted in prose or on the `**Plan metadata:**` line is not a task commit.
 */
export function extractTaskCommitRefs(text: string): string[] {
  const refs: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (TASK_COMMITS_HEADING.test(line)) { inside = true; continue; }
    if (NEXT_HEADING.test(line)) { inside = false; continue; }
    if (!inside) continue;
    const row = TASK_ROW_PREFIX.exec(line);
    if (!row) continue;
    const rest = line.slice(row[0].length);
    const close = rest.indexOf('**');
    if (close === -1) continue;
    for (const token of rest.slice(close + 2).match(HEX_TOKEN) ?? []) refs.push(token.slice(1, -1));
  }
  return refs;
}

// ─── Plan-id → anchored subject pattern ───────────────────────────────────────

/**
 * Tolerate zero padding in the leading integer of a phase or plan segment (#4003, #4619, #4748);
 * everything after the integer (`A`, `.1.2`) is matched literally.
 */
function paddedPattern(value: string): string {
  const m = /^(\d+)(.*)$/.exec(value);
  if (!m) return escapeEre(value);
  const intPart = (m[1] ?? '').replace(/^0+(?=\d)/, '');
  return `0*${escapeEre(intPart)}${escapeEre(m[2] ?? '')}`;
}

/**
 * The anchored subject pattern for a plan id, or null when `planId` is empty, over-long or carries a
 * control / whitespace character.
 *
 * A `<phase>-<plan>` id (`03-01`) is zero-padding tolerant: `feat(03-01):`, `test(3-1):` and
 * `fix(03-01)!:` match, `feat(03-010):` does not. Any other id (a plan FILE NAME that does not follow
 * the numbering) is matched LITERALLY — every ERE metacharacter escaped — so `x.*` or `a[b]` can only
 * match a commit that names that exact id, and never widens the pattern.
 */
export function planSubjectPattern(planId: string): string | null {
  if (planId.length === 0 || planId.length > 200 || /[\s\x00-\x1f\x7f]/.test(planId)) return null;
  const dash = planId.indexOf('-');
  const phasePart = dash > 0 ? planId.slice(0, dash) : '';
  const planPart = dash > 0 ? planId.slice(dash + 1) : '';
  if (/^[0-9A-Za-z.]+$/.test(phasePart) && /^[0-9A-Za-z.]+$/.test(planPart)) {
    return `^[a-z]+\\(${paddedPattern(phasePart)}-${paddedPattern(planPart)}\\)!?:`;
  }
  return `^[a-z]+\\(${escapeEre(planId)}\\)!?:`;
}

// ─── Git plumbing ─────────────────────────────────────────────────────────────

class ScopeUnreadable extends Error {
  readonly reason: string;
  /** git's exit status when the failure was a plain non-zero exit (not a timeout or a missing git). */
  readonly exitCode: number | null;
  constructor(reason: string, exitCode: number | null = null) {
    super(reason);
    this.reason = reason;
    this.exitCode = exitCode;
  }
}

type Git = (args: string[], cwd?: string) => string;

function makeGit(projectDir: string, runner: GitRunner): Git {
  return (args, cwd = projectDir) => {
    const result = runner(args, { cwd });
    if (result.timedOut) throw new ScopeUnreadable('git-timeout');
    if (result.exitCode === 127) throw new ScopeUnreadable('git-unavailable');
    if (result.exitCode !== 0) throw new ScopeUnreadable(`git-failed:${args[0] ?? ''}`, result.exitCode);
    return result.stdout;
  };
}

/**
 * Run a git question whose exit status 1 is a legitimate "no" (`merge-base --is-ancestor`,
 * `rev-parse --verify --quiet`). Exit 1 returns `null`; every other failure — a timeout, a missing
 * git, a bad object (exit 128) — still rethrows, so a hung or broken git is `unresolvable`, never a
 * silent "no".
 */
function gitOrNo(git: Git, args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch (error) {
    if (error instanceof ScopeUnreadable && error.exitCode === 1) return null;
    throw error;
  }
}

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry.length > 0);
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function uniqueSorted(items: Iterable<string>): string[] {
  return [...new Set(items)].sort();
}

/** True when `candidate` cannot be read as a git option and carries no whitespace or control byte. */
export function isSafeRefArgument(candidate: string): boolean {
  return candidate.length > 0 && candidate.length <= 256 && !candidate.startsWith('-') && !/[\s\x00-\x1f\x7f]/.test(candidate);
}

/** A git approxidate: words, digits and `- : . ,` only, so it can never read as an option or a pathspec. */
export function isSafeDateArgument(candidate: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9 .,:+-]{0,63}$/.test(candidate);
}

function isAncestor(git: Git, sha: string, of: string): boolean {
  return gitOrNo(git, ['merge-base', '--is-ancestor', sha, of]) !== null;
}

// ─── The resolver ─────────────────────────────────────────────────────────────

function emptyScope(unit: ScopeUnit): EvaluationScope {
  return {
    unit, status: 'resolved', source: 'none', reason: null, commits: [],
    changedFiles: [], files: [], missingOnDisk: [], outsideUnion: [], unreachable: [], rangeBase: null,
  };
}

export function resolveEvaluationScope(projectDir: string, unit: ScopeUnit, options: ScopeOptions = {}): EvaluationScope {
  const scope = emptyScope(unit);
  const git = makeGit(projectDir, options.execGit ?? execGitSeam);
  const ref = (unit.kind === 'window' ? unit.until : undefined) ?? options.ref ?? 'HEAD';
  try {
    if (!isSafeRefArgument(ref)) throw new ScopeUnreadable('unsafe-ref');
    if (options.since !== undefined && !isSafeRefArgument(options.since)) throw new ScopeUnreadable('unsafe-since');
    // A window carries its own lower bound and its own tip; a second one would be a silent choice.
    if (unit.kind === 'window' && options.since !== undefined) throw new ScopeUnreadable('window-with-since-option');
    if (unit.kind === 'window' && unit.until !== undefined && options.ref !== undefined) throw new ScopeUnreadable('window-until-with-ref-option');
    const tip = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const repoRoot = git(['rev-parse', '--show-toplevel']);

    if (unit.kind === 'phase') resolvePhase(projectDir, unit, scope, git, ref, options, repoRoot);
    else if (unit.kind === 'window') resolveWindow(projectDir, unit, scope, git, { ref, tip }, options, repoRoot);
    else resolveBySubject(unit, scope, git, ref, options, repoRoot);
    return scope;
  } catch (error) {
    const reason = error instanceof ScopeUnreadable ? error.reason : 'resolver-error';
    return { ...emptyScope(unit), status: 'unresolvable', reason };
  }
}

/** A commit's own file set. `--first-parent`: a merge commit contributes its diff against parent 1. */
function commitFiles(git: Git, sha: string): string[] {
  const out = git(
    ['-c', 'core.quotepath=off', 'show', '--first-parent', '--pretty=format:', '--name-only', '-z', sha, '--', '.', ...SCOPE_EXCLUSION_PATHSPECS],
  );
  return splitNul(out);
}

function rangeFiles(git: Git, base: string, tip: string): string[] {
  const out = git(
    ['-c', 'core.quotepath=off', 'diff', '--name-only', '-z', `${base}..${tip}`, '--', '.', ...SCOPE_EXCLUSION_PATHSPECS],
  );
  return splitNul(out);
}

function finalizeFiles(scope: EvaluationScope, repoRoot: string, changed: Iterable<string>): void {
  scope.changedFiles = uniqueSorted(changed);
  const existing: string[] = [];
  const missing: string[] = [];
  for (const file of scope.changedFiles) {
    (fs.existsSync(path.join(repoRoot, file)) ? existing : missing).push(file);
  }
  scope.files = existing;
  scope.missingOnDisk = missing;
}

function logFormat(withBody: boolean): string {
  return withBody ? '--format=%H%x1f%s%x1f%b%x1e' : '--format=%H%x1f%s%x1e';
}

function parseLog(out: string, withBody: boolean): ScopeCommit[] {
  const commits: ScopeCommit[] = [];
  for (const record of out.split('\x1e')) {
    const trimmed = record.replace(/^\n+/, '');
    if (!trimmed) continue;
    const [sha, subject, body] = trimmed.split('\x1f');
    if (!sha || !/^[0-9a-f]{40}$/.test(sha)) continue;
    const commit: ScopeCommit = { sha, subject: subject ?? '' };
    if (withBody) commit.body = (body ?? '').trim();
    commits.push(commit);
  }
  return commits;
}

function subjectsFor(git: Git, shas: readonly string[], withBody: boolean, chunkSize: number): ScopeCommit[] {
  const out: ScopeCommit[] = [];
  for (const group of chunk(shas, chunkSize)) {
    out.push(...parseLog(git(['log', '--no-walk=unsorted', logFormat(withBody), ...group]), withBody));
  }
  return out;
}

/**
 * The tip of `shas`: topological order lists a descendant before its ancestors, so the first
 * commit of a walk started at all of them is one no other listed commit descends from. (Commit
 * DATES are not used — commits made within one second tie, and a tie picks an arbitrary tip.)
 */
function newestOf(git: Git, shas: readonly string[], chunkSize: number): string {
  // More shas than fit one argv chunk are reduced chunk by chunk: the chunks' tips are themselves a
  // (shorter) list, until one chunk holds them all. Nothing is silently dropped.
  if (shas.length > chunkSize) {
    const tips = chunk(shas, chunkSize).map((group) => newestOf(git, group, chunkSize));
    return newestOf(git, tips, chunkSize);
  }
  const tip = git(['rev-list', '--topo-order', '-n', '1', ...shas]).split('\n').filter(Boolean)[0];
  return tip ?? shas[0] ?? 'HEAD';
}

/** One clamp for every commit cap, so the CLI limit and the resolver's ceiling cannot diverge. */
export const MAX_COMMITS_CEILING = 1000;
function clampMaxCommits(requested: number | undefined): number {
  return Math.max(1, Math.min(requested ?? DEFAULT_MAX_COMMITS, MAX_COMMITS_CEILING));
}

/** git's empty tree (SHA-1 repositories): the base a range needs to include a root commit's own files. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The phase-start anchor on `ref`: the parent of the commit that first added anything under the
 * phase dir. A phase directory that arrived with the repository's root commit has no parent, so the
 * anchor is the empty tree — `<empty>..<ref>` then includes the root commit's own files.
 */
function phaseRangeBase(git: Git, phaseDir: string, ref: string): string | null {
  const first = git(['log', ref, '--format=%H', '--diff-filter=A', '--', '.'], phaseDir)
    .split('\n').filter(Boolean).pop();
  if (!first) return null;
  return gitOrNo(git, ['rev-parse', '--verify', '--quiet', `${first}^`]) ?? EMPTY_TREE;
}

function resolvePhase(
  projectDir: string, unit: { kind: 'phase'; phase: string; phaseDir?: string }, scope: EvaluationScope,
  git: Git, ref: string, options: ScopeOptions, repoRoot: string,
): void {
  const phaseDir = unit.phaseDir ?? resolvePhaseDirOrEmpty(projectDir, unit.phase);
  if (!phaseDir) throw new ScopeUnreadable('phase-dir-not-found');

  const refs: string[] = [];
  let summaryCount = 0;
  let entries: string[];
  try {
    // The canonical LIVE summary set (root + nested, superseded excluded) from its single owner.
    entries = [...scanPhasePlans(phaseDir).summaryFiles].sort();
  } catch {
    throw new ScopeUnreadable('phase-dir-unreadable');
  }
  for (const name of entries) {
    try {
      refs.push(...extractTaskCommitRefs(fs.readFileSync(path.join(phaseDir, name), 'utf-8')));
      summaryCount += 1;
    } catch {
      throw new ScopeUnreadable(`summary-unreadable:${name}`);
    }
  }

  // Resolve each listed id to a full sha reachable from the ref (and, for wave scoping, newer than `since`).
  const shas: string[] = [];
  const unreachable: string[] = [];
  let sinceDropped = 0;
  for (const id of [...new Set(refs)]) {
    // Exit 1 = no object answers to the id (rebased away); exit 128 = an ambiguous short id. Both
    // are named below, per id, and neither poisons the phase. A timeout still rethrows.
    let full = '';
    try {
      full = gitOrNo(git, ['rev-parse', '--verify', '--quiet', `${id}^{commit}`]) ?? '';
    } catch (error) {
      if (!(error instanceof ScopeUnreadable && error.exitCode === 128)) throw error;
    }
    if (!full || !isAncestor(git, full, ref)) { unreachable.push(id); continue; }
    if (options.since !== undefined && isAncestor(git, full, options.since)) { sinceDropped += 1; continue; }
    shas.push(full);
  }
  scope.unreachable = unreachable.sort();
  scope.rangeBase = options.since ?? phaseRangeBase(git, phaseDir, ref);

  const union = new Set<string>();
  const commits: ScopeCommit[] = [];
  const withFiles = options.includeFiles ?? true;
  // At least 2: a chunk of one never shrinks the list `newestOf` reduces.
  const chunkSize = Math.max(2, options.shaChunk ?? SHA_CHUNK);
  for (const meta of subjectsFor(git, [...new Set(shas)], options.includeBody === true, chunkSize)) {
    const files = commitFiles(git, meta.sha);
    for (const file of files) union.add(file);
    commits.push(withFiles ? { ...meta, files: [...files].sort() } : meta);
  }

  if (union.size > 0) {
    scope.source = 'task-commits';
    scope.commits = commits;
    finalizeFiles(scope, repoRoot, union);
    if (scope.rangeBase) {
      const window = rangeFiles(git, scope.rangeBase, newestOf(git, commits.map((c) => c.sha), chunkSize));
      scope.outsideUnion = uniqueSorted(window.filter((f) => !union.has(f)));
    }
    return;
  }

  // Empty union: the planning-only phase, a phase with no SUMMARY, or one whose ids are all gone.
  const reason =
    summaryCount === 0 ? 'no-summary'
      : refs.length === 0 ? 'no-task-commit-rows'
        : shas.length === 0 ? (sinceDropped > 0 ? 'no-task-commits-since' : 'no-reachable-task-commits')
          : 'empty-after-exclusions';
  if (!scope.rangeBase) throw new ScopeUnreadable(`${reason}:no-phase-start-anchor`);
  scope.status = 'degraded';
  scope.reason = reason;
  scope.source = 'phase-range';
  const max = clampMaxCommits(options.maxCommits);
  scope.commits = parseLog(
    git(['log', `${scope.rangeBase}..${ref}`, logFormat(options.includeBody === true), '-n', String(max)]),
    options.includeBody === true,
  );
  finalizeFiles(scope, repoRoot, rangeFiles(git, scope.rangeBase, ref));
}

// ─── The window unit (ADR-5208) ───────────────────────────────────────────────

/**
 * Each listed commit's own file set, in one `git log` per sha chunk. `--cc` gives a merge only the
 * paths it changed against EVERY parent (a conflict resolution, an evil-merge edit): what it merged
 * in is already in the window as the merged commits themselves. A commit absent from the output
 * touched no included path.
 */
function windowCommitFiles(git: Git, shas: readonly string[], chunkSize: number): Map<string, string[]> {
  const files = new Map<string, string[]>();
  for (const group of chunk(shas, chunkSize)) {
    const out = git(
      ['-c', 'core.quotepath=off', 'log', '--no-walk=unsorted', '--cc', '--name-only', '-z', '--format=%x1e%H', ...group, '--', '.', ...SCOPE_EXCLUSION_PATHSPECS],
    );
    for (const record of out.split('\x1e')) {
      const [sha, ...names] = record.split('\0');
      if (!sha || !FULL_SHA.test(sha)) continue;
      // `-z` puts a newline between the header and the first path.
      if (names[0] !== undefined) names[0] = names[0].replace(/^\n/, '');
      files.set(sha, names.filter((name) => name.length > 0));
    }
  }
  return files;
}

interface PhaseAttribution {
  /** A `## Task Commits` id (7–40 hex) → the phase that names it first. */
  byRef: Map<string, string>;
  /** Phase → its directory, relative and posix. */
  dirs: Map<string, string>;
  unreadable: string[];
}

function toPosixRelative(projectDir: string, target: string): string {
  return path.relative(projectDir, target).split(path.sep).join('/');
}

/**
 * Every phase's SUMMARY task-commit ids, active and archived (a window can cross a milestone). An
 * archived phase is keyed `<milestone>/<token>` so `01` of two milestones stay apart. What cannot be
 * read is NAMED: its commits would otherwise read as `unattributed`, a false "no spec".
 */
function windowAttribution(projectDir: string): PhaseAttribution {
  const attribution: PhaseAttribution = { byRef: new Map(), dirs: new Map(), unreadable: [] };
  let planDir: string;
  try {
    planDir = planningDir(projectDir);
  } catch {
    attribution.unreadable.push('.planning');
    return attribution;
  }
  const { targets, activeUnreadable } = listActiveAndArchivedPhaseDirs(planDir, projectDir);
  if (activeUnreadable) attribution.unreadable.push(toPosixRelative(projectDir, path.join(planDir, 'phases')));
  for (const target of targets) {
    const token = extractPhaseToken(target.dir);
    const key = target.milestone ? `${target.milestone}/${token}` : token;
    const rel = toPosixRelative(projectDir, target.fullPath);
    let summaries: string[];
    try {
      summaries = [...scanPhasePlans(target.fullPath).summaryFiles].sort();
    } catch {
      attribution.unreadable.push(rel);
      continue;
    }
    for (const name of summaries) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(target.fullPath, name), 'utf-8');
      } catch {
        attribution.unreadable.push(`${rel}/${name}`);
        continue;
      }
      for (const id of extractTaskCommitRefs(text)) {
        if (attribution.byRef.has(id)) continue;
        attribution.byRef.set(id, key);
        if (!attribution.dirs.has(key)) attribution.dirs.set(key, rel);
      }
    }
  }
  return attribution;
}

function attributedPhase(byRef: ReadonlyMap<string, string>, sha: string): string {
  for (let length = 7; length <= sha.length; length += 1) {
    const phase = byRef.get(sha.slice(0, length));
    if (phase !== undefined) return phase;
  }
  return UNATTRIBUTED;
}

function readLastWindowMarker(projectDir: string): LastWindowMarker {
  let file: string;
  try {
    file = lastWindowMarkerPath(projectDir);
  } catch {
    throw new ScopeUnreadable('planning-dir-unresolvable');
  }
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    throw new ScopeUnreadable(missing ? 'no-last-window-marker' : 'last-window-marker-unreadable');
  }
  const marker = parseLastWindowMarker(text);
  if (marker === null) throw new ScopeUnreadable('last-window-marker-invalid');
  return marker;
}

/** The window's `base` (exclusive) and, for a time form, its inclusive boundary in epoch seconds. */
function windowBase(
  projectDir: string, since: WindowSince, git: Git, tip: string, options: ScopeOptions,
): { base: string | null; boundary: number | null; notAncestor: boolean } {
  if (since.kind === 'duration' || since.kind === 'date') {
    const boundary = since.kind === 'duration'
      ? Math.floor((options.clock ?? Date).now() / 1000) - since.seconds
      : since.epochSeconds;
    // The newest first-parent commit OLDER than the boundary (`--before` is inclusive, hence -1):
    // a commit made exactly at the boundary is inside the window. Before the epoch there is none.
    if (boundary - 1 < 0) return { base: null, boundary, notAncestor: false };
    const base = git(['rev-list', '--first-parent', '-n', '1', `--before=@${boundary - 1} +0000`, tip]);
    return { base: base || null, boundary, notAncestor: false };
  }
  if (since.kind === 'ref') {
    const base = gitOrNo(git, ['rev-parse', '--verify', '--quiet', `${since.value}^{commit}`]);
    if (base === null) throw new ScopeUnreadable('window-since-not-found');
    return { base, boundary: null, notAncestor: false };
  }
  const marker = readLastWindowMarker(projectDir);
  const base = gitOrNo(git, ['rev-parse', '--verify', '--quiet', `${marker.tip}^{commit}`]);
  if (base === null) throw new ScopeUnreadable('last-window-tip-missing');
  return { base, boundary: null, notAncestor: !isAncestor(git, base, tip) };
}

function resolveWindow(
  projectDir: string, unit: { kind: 'window'; since: string; until?: string }, scope: EvaluationScope,
  git: Git, at: { ref: string; tip: string }, options: ScopeOptions, repoRoot: string,
): void {
  const since = parseWindowSince(unit.since);
  if (since === null) throw new ScopeUnreadable('invalid-window-since');
  const { base, boundary, notAncestor } = windowBase(projectDir, since, git, at.tip, options);
  const window: WindowScope = {
    since: unit.since, sinceKind: since.kind, until: at.ref, tip: at.tip, base,
    boundary: boundary === null ? null : new Date(boundary * 1000).toISOString(),
    phases: {}, unattributed: [], unreadablePhaseDirs: [],
  };
  scope.window = window;
  scope.source = 'window-commits';
  scope.rangeBase = base;
  // The last review's tip was rewritten away: `tip..until` still runs, but it can re-include
  // commits that review already saw, so the scope is wider than asked — and says so, by name.
  if (notAncestor && base !== null) scope.unreachable = [base];

  const withBody = options.includeBody === true;
  const listed = parseLog(git(['log', logFormat(withBody), base === null ? at.tip : `${base}..${at.tip}`]), withBody);
  const chunkSize = Math.max(2, options.shaChunk ?? SHA_CHUNK);
  const filesBySha = windowCommitFiles(git, listed.map((c) => c.sha), chunkSize);
  const attribution = windowAttribution(projectDir);
  window.unreadablePhaseDirs = attribution.unreadable;
  const withFiles = options.includeFiles ?? true;
  const union = new Set<string>();
  for (const meta of listed) {
    const files = filesBySha.get(meta.sha) ?? [];
    for (const file of files) union.add(file);
    const phase = attributedPhase(attribution.byRef, meta.sha);
    if (phase === UNATTRIBUTED) {
      window.unattributed.push(meta.sha);
    } else {
      const entry = window.phases[phase] ?? { dir: attribution.dirs.get(phase) ?? '', commits: [] };
      entry.commits.push(meta.sha);
      window.phases[phase] = entry;
    }
    scope.commits.push(withFiles ? { ...meta, files: [...files].sort(), phase } : { ...meta, phase });
  }
  finalizeFiles(scope, repoRoot, union);
  if (listed.length > 0) {
    scope.outsideUnion = uniqueSorted(rangeFiles(git, base ?? EMPTY_TREE, at.tip).filter((f) => !union.has(f)));
  }
  // A window has no wider evidence to fall back to (every path its range changes was changed by
  // one of its own commits), so an empty window degrades with an empty file set and a reason —
  // never a clean, empty `resolved`.
  const reason = listed.length === 0 ? 'empty-window'
    : union.size === 0 ? 'empty-after-exclusions'
      : notAncestor ? 'last-window-tip-not-ancestor' : null;
  if (reason !== null) {
    scope.status = 'degraded';
    scope.reason = reason;
  }
}

function resolveBySubject(
  unit: { kind: 'plan'; planId: string } | { kind: 'quick'; id: string }, scope: EvaluationScope,
  git: Git, ref: string, options: ScopeOptions, repoRoot: string,
): void {
  const withBody = options.includeBody === true;
  // Refuse rather than truncate: a silently dropped positive pathspec narrows the match.
  const pathspecs = options.pathspecs ?? [];
  if (pathspecs.length > MAX_PATHSPECS) throw new ScopeUnreadable('too-many-pathspecs');
  const max = clampMaxCommits(options.maxCommits);
  let range = ref;
  if (options.milestoneBound === true) {
    let tag = '';
    try {
      tag = git(['describe', '--tags', '--abbrev=0', ref]);
    } catch (error) {
      // Exit 128 = no reachable tag → unbounded; a timeout or a missing git still rethrows.
      if (!(error instanceof ScopeUnreadable && error.exitCode === 128)) throw error;
    }
    if (tag) range = `${tag}..${ref}`;
  }
  const grepArgs: string[] = [];
  let anchored: RegExp | null = null;
  if (unit.kind === 'plan') {
    const pattern = planSubjectPattern(unit.planId);
    if (pattern === null) throw new ScopeUnreadable('invalid-plan-id');
    grepArgs.push('--extended-regexp', `--grep=${pattern}`);
    anchored = new RegExp(pattern);
    scope.source = 'plan-subjects';
  } else {
    if (!isSafeRefArgument(unit.id)) throw new ScopeUnreadable('invalid-quick-id');
    grepArgs.push('--fixed-strings', `--grep=${unit.id}`);
    scope.source = 'quick-subjects';
  }
  const sinceArgs: string[] = [];
  if (options.committedSince !== undefined) {
    if (!isSafeDateArgument(options.committedSince)) throw new ScopeUnreadable('unsafe-committed-since');
    sinceArgs.push(`--since=${options.committedSince}`);
  }
  const out = git(
    ['log', range, logFormat(withBody), '-n', String(max * 2), ...sinceArgs, ...grepArgs, ...(pathspecs.length > 0 ? ['--', ...pathspecs] : [])],
  );
  // `--grep` matches ANY message line; a plan lookup is subject-anchored, so filter on the subject.
  let commits = parseLog(out, withBody).filter((c) => anchored === null || anchored.test(c.subject)).slice(0, max);
  const since = options.since;
  if (since !== undefined) commits = commits.filter((c) => !isAncestor(git, c.sha, since));
  if (options.commitsOnly === true) {
    scope.commits = commits;
    if (commits.length === 0) scope.reason = 'no-matching-commits';
    return;
  }
  const withFiles = options.includeFiles ?? false;
  const union = new Set<string>();
  const result: ScopeCommit[] = [];
  for (const meta of commits) {
    const files = commitFiles(git, meta.sha);
    for (const file of files) union.add(file);
    result.push(withFiles ? { ...meta, files: [...files].sort() } : meta);
  }
  scope.commits = result;
  finalizeFiles(scope, repoRoot, union);
  // Found nothing: a truthful "none" (status stays `resolved` — git was read), said out loud so a
  // caller can tell "no such commits" from "an empty scope that was never computed". Commits whose
  // every path is excluded (planning-only) are an empty scope too, and say so.
  if (result.length === 0) scope.reason = 'no-matching-commits';
  else if (scope.changedFiles.length === 0) scope.reason = 'empty-after-exclusions';
}

// ─── The `check evaluation-scope` verb ────────────────────────────────────────

const VALUE_FLAGS = new Set(['--phase', '--phase-dir', '--plan', '--quick', '--window', '--until', '--since', '--ref', '--pathspec', '--committed-since', '--max-commits']);
const BOOLEAN_FLAGS = new Set(['--milestone-bound', '--include-body', '--include-files', '--commits-only']);

function parseScopeArgs(args: readonly string[]): { unit: ScopeUnit; options: ScopeOptions } | string {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (BOOLEAN_FLAGS.has(arg)) { flags.add(arg); continue; }
    if (!VALUE_FLAGS.has(arg)) return `unknown argument: ${arg}`;
    const value = args[i + 1];
    if (value === undefined) return `${arg} requires a value`;
    i += 1;
    values.set(arg, [...(values.get(arg) ?? []), value]);
  }
  const one = (flag: string): string | undefined => values.get(flag)?.[0];
  const phase = one('--phase');
  const phaseDir = one('--phase-dir');
  const plan = one('--plan');
  const quick = one('--quick');
  const windowSince = one('--window');
  const until = one('--until');
  const given = [phase, phaseDir, plan, quick, windowSince].filter((v) => v !== undefined).length;
  if (given !== 1) return 'exactly one of --phase <phase>, --phase-dir <dir>, --plan <phase>-<plan>, --quick <id> or --window <since> is required';
  if (until !== undefined && windowSince === undefined) return '--until <ref> requires --window <since>';
  if (windowSince !== undefined && one('--since') !== undefined) return '--since is wave scoping; a --window carries its own lower bound';
  if (windowSince !== undefined && one('--ref') !== undefined) return '--ref does not apply to --window; use --until <ref>';
  if (windowSince !== undefined && parseWindowSince(windowSince) === null) {
    return `--window must be last, a duration (7d, 12h, 2w), a date (YYYY-MM-DD, UTC) or a ref, got: ${windowSince}`;
  }
  let unit: ScopeUnit;
  if (windowSince !== undefined) unit = until === undefined ? { kind: 'window', since: windowSince } : { kind: 'window', since: windowSince, until };
  else if (quick !== undefined) unit = { kind: 'quick', id: quick };
  else if (plan !== undefined) unit = { kind: 'plan', planId: plan };
  else if (phaseDir !== undefined) unit = { kind: 'phase', phase: '', phaseDir };
  else unit = { kind: 'phase', phase: phase ?? '' };
  const options: ScopeOptions = {};
  const ref = one('--ref');
  const since = one('--since');
  const pathspecs = values.get('--pathspec');
  if (ref !== undefined) options.ref = ref;
  if (since !== undefined) options.since = since;
  if (pathspecs !== undefined) options.pathspecs = pathspecs;
  const committedSince = one('--committed-since');
  if (committedSince !== undefined) options.committedSince = committedSince;
  const maxCommits = one('--max-commits');
  if (maxCommits !== undefined) {
    if (!/^[1-9][0-9]{0,3}$/.test(maxCommits) || Number(maxCommits) > MAX_COMMITS_CEILING) {
      return `--max-commits must be an integer from 1 to ${MAX_COMMITS_CEILING}, got: ${maxCommits}`;
    }
    options.maxCommits = Number(maxCommits);
  }
  if (flags.has('--milestone-bound')) options.milestoneBound = true;
  if (flags.has('--include-body')) options.includeBody = true;
  if (flags.has('--include-files')) options.includeFiles = true;
  if (flags.has('--commits-only')) options.commitsOnly = true;
  return { unit, options };
}

/** `check evaluation-scope` — argv after the verb. A resolver, not a policy: it never blocks. */
export function evaluateEvaluationScope(input: { projectDir: string; args: readonly string[]; execGit?: GitRunner }): GateResult {
  const parsed = parseScopeArgs(input.args);
  if (typeof parsed === 'string') {
    return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `check evaluation-scope: ${parsed}`);
  }
  const options: ScopeOptions = input.execGit ? { ...parsed.options, execGit: input.execGit } : parsed.options;
  let unit = parsed.unit;
  if (unit.kind === 'phase' && unit.phaseDir !== undefined) {
    // `--phase-dir` is caller-supplied: it must stay inside the project (realpath containment).
    const contained = resolveContainedPath(unit.phaseDir, input.projectDir);
    if (isGateUsageFailure(contained)) return contained;
    unit = { kind: 'phase', phase: '', phaseDir: contained };
  }
  const scope = resolveEvaluationScope(input.projectDir, unit, options);
  // `pass` only for a scope with nothing to explain; an empty-but-resolved scope (it carries a reason) is advisory.
  const outcome = scope.status === 'unresolvable' ? 'skip' : scope.status === 'degraded' || scope.reason !== null ? 'advisory' : 'pass';
  return gateVerdict(outcome, false, { ...scope });
}
