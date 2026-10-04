/**
 * Git history — how often each file changed in a window (churn) and which
 * files change together (co-change). Shared by the architecture survey
 * (`arch metrics`: hot spots = churn × complexity, "behaviour smeared across
 * files") and the window review pre-pass.
 *
 * ── One read, a bounded budget ──
 *
 * The window is read with ONE `git log --numstat` (plus a `rev-parse` per ref
 * argument), whatever the number of commits, and every call goes through the
 * `execGit` seam (stable locale, a timeout per call, an output bound).
 * `maxCommits` caps the walk; a capped window is `degraded` with the cap
 * named, never a silent partial answer. `readHistory` returns the parsed commits so a caller that
 * needs both churn and co-change pays for one read.
 *
 * ── Honest emptiness ──
 *
 * A window with no commits is `degraded` with `reason: 'empty-window'`, not an
 * empty success: "nothing changed" and "looked at nothing" read differently. A
 * missing git, a timeout or a ref git does not know is `unresolvable` with the
 * reason (the same vocabulary as `gate-evaluation-scope`).
 *
 * ── Counting ──
 *
 * Merge commits are skipped (their branch commits are walked individually).
 * Renames are followed backwards: changes made under an old name count for the
 * file's current name. Planning artefacts and lockfiles are excluded
 * (`SCOPE_EXCLUSION_PATHSPECS`). Co-change ignores commits touching more than
 * `maxFilesPerCommit` files (a mass reformat is not coupling) and names them in
 * `largeCommits`.
 *
 * For a pair (a, b): `support` is the number of commits touching both;
 * `confidence(a→b) = support / commits(a)`. A pair is reported when
 * `support >= minSupport` and the larger of its two confidences is
 * `>= minConfidence` (both thresholds inclusive).
 *
 * Paths are relative to the git top level (`project-root.projectRoots(...).content`),
 * the base `code-graph` uses, so the two join on file keys.
 *
 * ADR-457 build-at-publish: source in src/git-history.cts, compiled to
 * gsd-core/bin/lib/git-history.cjs (gitignored).
 */

import * as path from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { SCOPE_EXCLUSION_PATHSPECS, isSafeRefArgument, isSafeDateArgument } from './gate-evaluation-scope.cjs';
import type { ScopeStatus } from './gate-evaluation-scope.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';

// ─── Types ───────────────────────────────────────────────────────────────────

/** The commits a history question is asked over: reachable from `tip`, not from `base`, since `since`. */
export interface HistoryRange {
  /** Default `HEAD`. */
  tip?: string;
  /** Exclusive lower bound: commits reachable from it are left out. */
  base?: string;
  /** Git approxidate on the committer date ("90 days ago", "2026-07-01"). */
  since?: string;
  /** Only changes under these paths count (root-relative or absolute inside the root). */
  paths?: readonly string[];
}

/** The `execGit` seam's shape (a test substitutes it to count calls or inject failures). */
export type GitRunner = (args: string[], opts: { cwd?: string; timeout?: number; maxBuffer?: number }) => SpawnResultOutput;

export interface HistoryOptions {
  /** Walk at most this many commits (default `DEFAULTS.maxCommits`, clamped to `MAX_COMMITS_CEILING`). */
  maxCommits?: number;
  /** Per git call, ms (default 30 000). */
  timeoutMs?: number;
  /** Git runner seam; default `execGit`. */
  execGit?: GitRunner;
}

export interface FileChange {
  file: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
}

export interface HistoryCommit {
  sha: string;
  /** Committer time, unix seconds. */
  time: number;
  changes: FileChange[];
}

export type HistoryStatus = ScopeStatus;

export interface History {
  status: HistoryStatus;
  /** Set whenever `status` is not `resolved`: `empty-window`, `commit-cap:<n>`, `git-timeout`, … */
  reason: string | null;
  range: HistoryRange;
  /** Newest first. */
  commits: HistoryCommit[];
  /** Git subprocesses spent — bounded by the number of ref arguments plus one. */
  gitCalls: number;
}

export interface FileChurn {
  file: string;
  commits: number;
  added: number;
  removed: number;
}

export interface Churn {
  status: HistoryStatus;
  reason: string | null;
  commits: number;
  /** Most-changed first, then by path. */
  files: FileChurn[];
  gitCalls: number;
}

export interface CoChangeOptions {
  /** Minimum commits touching both files (inclusive). Default `DEFAULTS.minSupport`. */
  minSupport?: number;
  /** Minimum of the larger directional confidence, 0..1 (inclusive). Default `DEFAULTS.minConfidence`. */
  minConfidence?: number;
  /** Commits touching more files than this are left out of pair counting. Default `DEFAULTS.maxFilesPerCommit`. */
  maxFilesPerCommit?: number;
}

export interface CoChangePair {
  /** `a < b`. */
  a: string;
  b: string;
  support: number;
  /** support / commits(a). */
  aToB: number;
  /** support / commits(b). */
  bToA: number;
  /** max(aToB, bToA). */
  confidence: number;
}

export interface CoChange {
  status: HistoryStatus;
  reason: string | null;
  commits: number;
  minSupport: number;
  minConfidence: number;
  /** Strongest first: support, then confidence, then paths. */
  pairs: CoChangePair[];
  /** Commits skipped by `maxFilesPerCommit`, by sha. */
  largeCommits: string[];
  gitCalls: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  maxCommits: 2000,
  minSupport: 3,
  minConfidence: 0.6,
  maxFilesPerCommit: 50,
  timeoutMs: 30_000,
  /** Output bound of the window read; an overflow is `unresolvable: git-output-overflow`. */
  maxOutputBytes: 64 * 1024 * 1024,
});

export const MAX_COMMITS_CEILING = 20_000;

const RECORD = '\x1e';
const FIELD = '\x1f';
const NUMSTAT_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

// ─── Window argument ─────────────────────────────────────────────────────────

const WINDOW_UNIT: Readonly<Record<string, string>> = Object.freeze({ d: 'days', w: 'weeks', m: 'months', y: 'years' });

/**
 * A `--since` argument as a range: `90d` / `12w` / `6m` / `1y` and an ISO date become a committer
 * date bound; anything else that is a safe ref becomes an exclusive `base`. Null when the argument
 * is neither.
 */
export function parseWindow(arg: string): HistoryRange | null {
  const rel = /^(\d{1,5})([dwmy])$/.exec(arg);
  if (rel !== null) return { since: `${Number(rel[1])} ${WINDOW_UNIT[rel[2]]} ago` };
  if (/^\d{4}-\d{2}-\d{2}(?:[T ][\d:]+)?$/.test(arg) && isSafeDateArgument(arg)) return { since: arg };
  return isSafeRefArgument(arg) ? { base: arg } : null;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

class HistoryUnreadable extends Error {
  /** git's exit status when the failure was a plain non-zero exit. */
  constructor(readonly reason: string, readonly exitCode: number | null = null) {
    super(reason);
  }
}

function clampMaxCommits(requested: number | undefined): number {
  const n = requested ?? DEFAULTS.maxCommits;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`git-history: maxCommits must be a positive integer, got ${n}`);
  return Math.min(n, MAX_COMMITS_CEILING);
}

/** Root-relative literal pathspecs for `range.paths`; a path outside the root is refused. */
function pathspecs(root: string, paths: readonly string[] | undefined): string[] {
  if (paths === undefined || paths.length === 0) return ['.'];
  return paths.map((p) => {
    if (tryWithinRoot(path.resolve(root, p), root, PathAcceptance.AbsoluteInsideRoot) === null) {
      throw new HistoryUnreadable(`path-outside-root:${p}`);
    }
    const rel = path.relative(path.resolve(root), path.resolve(root, p)).split(path.sep).join('/');
    return `:(literal)${rel === '' ? '.' : rel}`;
  });
}

function parseCount(s: string): number | null {
  return s === '-' ? null : Number(s);
}

/** `git log -z --numstat` records → commits, renames resolved to the newest name. */
function parseLog(out: string): HistoryCommit[] {
  const commits: HistoryCommit[] = [];
  /** old name → the name the file carries at the tip; filled newest-first, so it applies to older commits. */
  const renamedTo = new Map<string, string>();
  const current = (file: string): string => renamedTo.get(file) ?? file;
  for (const record of out.split(RECORD)) {
    if (record.trim() === '') continue;
    const headerEnd = record.indexOf('\0');
    const header = headerEnd === -1 ? record : record.slice(0, headerEnd);
    const [sha, time] = header.split(FIELD);
    if (!/^[0-9a-f]{40}$/.test(sha ?? '')) continue;
    const tokens = headerEnd === -1 ? [] : record.slice(headerEnd + 1).replace(/^\n/, '').split('\0');
    const changes = new Map<string, FileChange>();
    for (let i = 0; i < tokens.length; i++) {
      const m = NUMSTAT_RE.exec(tokens[i]);
      if (m === null) continue;
      let file = m[3];
      if (file === '') {
        // Rename: `added\tremoved\t\0old\0new`.
        const oldName = tokens[i + 1];
        const newName = tokens[i + 2];
        i += 2;
        if (oldName === undefined || newName === undefined) continue;
        file = current(newName);
        renamedTo.set(oldName, file);
      } else {
        file = current(file);
      }
      const prev = changes.get(file);
      const added = parseCount(m[1]);
      const removed = parseCount(m[2]);
      changes.set(file, prev === undefined ? { file, added, removed } : {
        file,
        added: prev.added === null || added === null ? null : prev.added + added,
        removed: prev.removed === null || removed === null ? null : prev.removed + removed,
      });
    }
    commits.push({ sha, time: Number(time), changes: [...changes.values()].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0)) });
  }
  return commits;
}

/**
 * The commits of `range` under `root` (the git top level), newest first, with their per-file
 * line counts. One `git log` plus one `rev-parse` per ref argument.
 */
export function readHistory(root: string, range: HistoryRange = {}, opts: HistoryOptions = {}): History {
  const runner = opts.execGit ?? execGitSeam;
  const timeout = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxCommits = clampMaxCommits(opts.maxCommits);
  let gitCalls = 0;
  const git = (args: string[]): string => {
    gitCalls++;
    const r = runner(args, { cwd: root, timeout, maxBuffer: DEFAULTS.maxOutputBytes });
    if (r.timedOut) throw new HistoryUnreadable('git-timeout');
    if (r.error !== null && 'code' in r.error && r.error.code === 'ENOBUFS') throw new HistoryUnreadable('git-output-overflow');
    if (r.exitCode === 127) throw new HistoryUnreadable('git-unavailable');
    if (r.exitCode !== 0) throw new HistoryUnreadable(`git-failed:${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''}`, r.exitCode);
    return r.stdout;
  };
  const tip = range.tip ?? 'HEAD';
  try {
    if (!isSafeRefArgument(tip)) throw new HistoryUnreadable('unsafe-tip');
    if (range.base !== undefined && !isSafeRefArgument(range.base)) throw new HistoryUnreadable('unsafe-base');
    if (range.since !== undefined && !isSafeDateArgument(range.since)) throw new HistoryUnreadable('unsafe-since');
    const specs = pathspecs(root, range.paths);
    // `rev-parse --verify --quiet` exits 1 for a ref the repository does not know; anything else
    // (128: not a repository) stays a git failure.
    const verify = (ref: string, label: string): void => {
      try {
        git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      } catch (error) {
        if (error instanceof HistoryUnreadable && error.exitCode === 1) throw new HistoryUnreadable(`unknown-${label}:${ref}`);
        throw error;
      }
    };
    verify(tip, 'tip');
    if (range.base !== undefined) verify(range.base, 'base');
    const out = git([
      '-c', 'core.quotepath=off', 'log', '--no-merges', '--find-renames', '--numstat', '-z',
      `--format=${RECORD}%H${FIELD}%ct`, `--max-count=${maxCommits + 1}`,
      ...(range.since !== undefined ? [`--since=${range.since}`] : []),
      tip, ...(range.base !== undefined ? [`^${range.base}`] : []),
      '--', ...specs, ...SCOPE_EXCLUSION_PATHSPECS,
    ]);
    const commits = parseLog(out);
    if (commits.length === 0) return { status: 'degraded', reason: 'empty-window', range, commits, gitCalls };
    if (commits.length > maxCommits) {
      return { status: 'degraded', reason: `commit-cap:${maxCommits}`, range, commits: commits.slice(0, maxCommits), gitCalls };
    }
    return { status: 'resolved', reason: null, range, commits, gitCalls };
  } catch (error) {
    if (!(error instanceof HistoryUnreadable)) throw error;
    return { status: 'unresolvable', reason: error.reason, range, commits: [], gitCalls };
  }
}

// ─── Churn ───────────────────────────────────────────────────────────────────

/** Per-file change counts of an already-read history. Binary changes count as commits, not lines. */
export function churnOf(history: History): Churn {
  const byFile = new Map<string, FileChurn>();
  for (const c of history.commits) {
    for (const ch of c.changes) {
      const f = byFile.get(ch.file) ?? { file: ch.file, commits: 0, added: 0, removed: 0 };
      f.commits++;
      f.added += ch.added ?? 0;
      f.removed += ch.removed ?? 0;
      byFile.set(ch.file, f);
    }
  }
  const files = [...byFile.values()].sort((a, b) => b.commits - a.commits || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { status: history.status, reason: history.reason, commits: history.commits.length, files, gitCalls: history.gitCalls };
}

/** Churn of `range` under `root`. */
export function churn(root: string, range: HistoryRange = {}, opts: HistoryOptions = {}): Churn {
  return churnOf(readHistory(root, range, opts));
}

// ─── Co-change ───────────────────────────────────────────────────────────────

function checkCoChangeOptions(opts: CoChangeOptions): Required<CoChangeOptions> {
  const minSupport = opts.minSupport ?? DEFAULTS.minSupport;
  const minConfidence = opts.minConfidence ?? DEFAULTS.minConfidence;
  const maxFilesPerCommit = opts.maxFilesPerCommit ?? DEFAULTS.maxFilesPerCommit;
  if (!Number.isInteger(minSupport) || minSupport < 1) throw new RangeError(`git-history: minSupport must be a positive integer, got ${minSupport}`);
  if (!(minConfidence >= 0 && minConfidence <= 1)) throw new RangeError(`git-history: minConfidence must be within 0..1, got ${minConfidence}`);
  if (!Number.isInteger(maxFilesPerCommit) || maxFilesPerCommit < 2) {
    throw new RangeError(`git-history: maxFilesPerCommit must be an integer >= 2, got ${maxFilesPerCommit}`);
  }
  return { minSupport, minConfidence, maxFilesPerCommit };
}

/**
 * Pairs of files that change together in an already-read history. Commit counts per file (the
 * confidence denominators) come from the same commits the pairs are counted over, so a large
 * commit left out of pairing is left out of the denominators too.
 */
export function coChangeOf(history: History, opts: CoChangeOptions = {}): CoChange {
  const { minSupport, minConfidence, maxFilesPerCommit } = checkCoChangeOptions(opts);
  const perFile = new Map<string, number>();
  const together = new Map<string, number>();
  const largeCommits: string[] = [];
  for (const c of history.commits) {
    const files = c.changes.map((ch) => ch.file);
    if (files.length > maxFilesPerCommit) {
      largeCommits.push(c.sha);
      continue;
    }
    for (const f of files) perFile.set(f, (perFile.get(f) ?? 0) + 1);
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = `${files[i]}\0${files[j]}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }
  const pairs: CoChangePair[] = [];
  for (const [key, support] of together) {
    if (support < minSupport) continue;
    const [a, b] = key.split('\0');
    const aToB = support / (perFile.get(a) ?? support);
    const bToA = support / (perFile.get(b) ?? support);
    const confidence = Math.max(aToB, bToA);
    if (confidence < minConfidence) continue;
    pairs.push({ a, b, support, aToB, bToA, confidence });
  }
  pairs.sort((x, y) => y.support - x.support || y.confidence - x.confidence || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return {
    status: history.status, reason: history.reason, commits: history.commits.length,
    minSupport, minConfidence, pairs, largeCommits, gitCalls: history.gitCalls,
  };
}

/** Co-change pairs of `range` under `root`. */
export function coChange(root: string, range: HistoryRange = {}, opts: CoChangeOptions & HistoryOptions = {}): CoChange {
  checkCoChangeOptions(opts);
  return coChangeOf(readHistory(root, range, opts), opts);
}
