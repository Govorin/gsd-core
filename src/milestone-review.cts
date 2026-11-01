/**
 * Milestone review coverage — has the code a milestone changed been through a window review, and
 * does that review still hold an open Critical finding? The deterministic half of the code-review
 * capability's `milestone:pre` gate (`check milestone-review`, src/gate-milestone-review.cts) and
 * of the owner's recorded override (`review milestone-accept`, src/review-command-router.cts).
 *
 * ── The milestone window ──
 *
 * `base` (exclusive) is where the milestone's change starts:
 *
 *   1. `tag`             the newest `v*` tag merged into HEAD that is not the milestone being
 *                        closed — the previous milestone's close (complete-milestone tags it);
 *   2. `planning-start`  no such tag (a first milestone): the parent of the first commit that added
 *                        anything under `.planning/` — the work GSD planned starts there;
 *   3. `root`            neither: the whole history (`base` null).
 *
 * The milestone's CODE commits are `base..HEAD` without merges, restricted by the window review's
 * own exclusions (`SCOPE_EXCLUSION_PATHSPECS`: planning artifacts, lockfiles) — a commit that only
 * moved `.planning/` (the review's own `docs(review)` commit, a SUMMARY) needs no review.
 *
 * ── Covered ──
 *
 * A composed window REVIEW.md (`<planning>/reviews/<date>-window/REVIEW.md`, frontmatter `base`,
 * `tip`, `status`) covers the code commits of `base..tip`; its REVIEW-FIX.md covers the commits its
 * fix pass made (`**Commit:** <sha>` under each fixed finding — gsd-code-fixer and
 * `review record-fixed` both write it), because those commits are that review's own remedy. A
 * milestone code commit is covered when ANY review covers it — windows chain (`--since last`) and
 * may overlap, so coverage is a set union, never "the newest review". A review that is
 * `incomplete` (a lens report was never written) or whose tip is not in the repository covers
 * nothing, and is listed as ignored with the reason.
 *
 * ── Open Critical ──
 *
 * The Critical findings of every review that covers at least one milestone commit, minus: a finding
 * the refuter disproved (the composer already moved it out of the findings), one listed under
 * `## Fixed Issues` of the review's REVIEW-FIX.md, and one whose broken-window entry (WINDOWS.md,
 * matched by the composed finding's `wr:` fingerprint — `review window-deferred` records every
 * surviving Critical/Warning) is `fixed` or `waived` (`windows waive <id> "<reason>"`: accepted
 * with a recorded reason). Warnings never block; they are counted.
 *
 * ── The owner's override ──
 *
 * `<planning>/reviews/MILESTONE-<version>-ACCEPT.json` records an explicit acceptance: the reason,
 * the instant, HEAD, and the exact uncovered commits and open Critical keys accepted. It is
 * self-invalidating: it holds only while every commit still uncovered and every Critical still open
 * is one it named — a commit or a finding that appears after it blocks again.
 *
 * Every git call goes through the `execGit` seam with a bounded timeout; a read that fails is
 * `unreadable`, never "nothing found".
 *
 * ADR-457 build-at-publish: source in src/milestone-review.cts, compiled to
 * gsd-core/bin/lib/milestone-review.cjs (gitignored).
 */

import path from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { SCOPE_EXCLUSION_PATHSPECS } from './gate-evaluation-scope.cjs';
import { readDirEntriesEvidence, readTextEvidence } from './gate-evidence.cjs';
import { openWindowFindings, REVIEWS_DIR, WINDOW_FILES } from './window-review.cjs';
import type { GitRunner } from './window-review.cjs';
import { splitLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import brokenWindowsMod = require('./broken-windows.cjs');

const { rawFrontmatterMapping } = frontmatterMod;
const { planningDir } = planningWorkspaceMod;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MilestoneCommit {
  sha: string;
  subject: string;
}

export type MilestoneBaseFrom = 'tag' | 'planning-start' | 'root';

export interface CoveringReview {
  /** Project-relative, posix. */
  review: string;
  base: string | null;
  tip: string;
  status: string;
  /** Milestone code commits this review (or its fix pass) covers. */
  covered: number;
}

export interface IgnoredReview {
  review: string;
  reason: string;
}

export interface OpenCriticalFinding {
  review: string;
  id: string;
  title: string;
  file: string | null;
  line: number | null;
  /** The composed finding's `wr:` fingerprint, else `<review>#<id>` — what an acceptance names. */
  key: string;
}

export interface MilestoneAcceptRecord {
  version: 1;
  milestone: string;
  reason: string;
  acceptedAt: string;
  head: string;
  /** Full shas of the milestone code commits no review covered when this was recorded. */
  uncovered: string[];
  /** Keys of the Critical findings open when this was recorded. */
  openCritical: string[];
}

export interface MilestoneAcceptState {
  /** Project-relative, posix. */
  path: string;
  record: MilestoneAcceptRecord | null;
  /** Why the file is not a usable record (malformed, another milestone); null when it is one. */
  problem: string | null;
}

export interface MilestoneReviewState {
  milestone: string;
  base: string | null;
  baseFrom: MilestoneBaseFrom;
  /** The tag `base` came from (`baseFrom: 'tag'`), else null. */
  baseTag: string | null;
  head: string;
  codeCommits: MilestoneCommit[];
  uncovered: MilestoneCommit[];
  reviews: CoveringReview[];
  ignored: IgnoredReview[];
  openCritical: OpenCriticalFinding[];
  openWarnings: number;
  /** Is there a LAST-WINDOW marker, so `--since last` resolves? */
  lastWindow: boolean;
  accept: MilestoneAcceptState | null;
}

export type MilestoneReviewAssessment =
  | { kind: 'no-history'; reason: string }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'assessed'; state: MilestoneReviewState };

// ─── Constants ───────────────────────────────────────────────────────────────

export const MILESTONE_REVIEW_DEFAULTS = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024 * 1024,
});

/** A milestone version as complete-milestone passes it (`v1.2`, `v2.0-beta`): a safe file-name segment. */
export const MILESTONE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The longest reason an acceptance records. */
export const ACCEPT_REASON_MAX = 500;

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT_LINE = /^\*\*Commit:\*\*\s*`?([0-9a-f]{7,64})`?/;
const FINGERPRINT_SUFFIX = /\[(wr:[0-9a-f]{10})\]$/;
const WINDOW_DIR_SUFFIX = '-window';
const LAST_WINDOW_FILE = 'LAST-WINDOW.json';

// ─── Git ─────────────────────────────────────────────────────────────────────

class GitUnreadable extends Error {}

function makeGit(projectDir: string, runner: GitRunner) {
  const call = (args: string[]): SpawnResultOutput => {
    const r = runner(args, { cwd: projectDir, timeout: MILESTONE_REVIEW_DEFAULTS.timeoutMs, maxBuffer: MILESTONE_REVIEW_DEFAULTS.maxOutputBytes });
    if (r.timedOut) throw new GitUnreadable('git-timeout');
    if (r.error !== null && 'code' in r.error && r.error.code === 'ENOBUFS') throw new GitUnreadable('git-output-overflow');
    if (r.exitCode === 127) throw new GitUnreadable('git-unavailable');
    return r;
  };
  return {
    /** stdout of a command that must succeed. */
    text(args: string[]): string {
      const r = call(args);
      if (r.exitCode !== 0) throw new GitUnreadable(`git-failed:${args[0] ?? ''}`);
      return r.stdout;
    },
    /** The full sha `rev` names as a commit, or null when it names none. */
    commit(rev: string): string | null {
      const r = call(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
      if (r.exitCode !== 0) return null;
      const sha = r.stdout.trim();
      return FULL_SHA.test(sha) ? sha : null;
    },
    /** Is the project inside a git work tree? */
    isRepo(): boolean {
      const r = call(['rev-parse', '--is-inside-work-tree']);
      return r.exitCode === 0 && r.stdout.trim() === 'true';
    },
  };
}
type Git = ReturnType<typeof makeGit>;

function lines(text: string): string[] {
  return splitLines(text).map((l) => l.trim()).filter((l) => l !== '');
}

/** The window review's own pathspec: the project, minus planning artifacts and lockfiles. */
function codePathspec(): string[] {
  return ['--', '.', ...SCOPE_EXCLUSION_PATHSPECS];
}

/** Code commits reachable from `tip` and not from `base`, newest first, without merges. */
function codeCommitsIn(git: Git, base: string | null, tip: string): MilestoneCommit[] {
  const range = base === null ? [tip] : [tip, `^${base}`];
  return lines(git.text(['log', '--no-merges', '--format=%H%x09%s', ...range, ...codePathspec()])).map((line) => {
    const tab = line.indexOf('\t');
    return tab === -1 ? { sha: line, subject: '' } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
}

/** Where the milestone's change starts (module header). */
export function milestoneBase(
  projectDir: string,
  milestone: string | null,
  runner: GitRunner = execGitSeam,
): { base: string | null; from: MilestoneBaseFrom; tag: string | null } {
  const git = makeGit(projectDir, runner);
  const tags = lines(git.text(['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'])).filter((t) => t !== milestone);
  for (const tag of tags) {
    const sha = git.commit(tag);
    if (sha !== null) return { base: sha, from: 'tag', tag };
  }
  const first = lines(git.text(['rev-list', '--reverse', 'HEAD', '--', '.planning']))[0];
  if (first !== undefined) {
    const parent = git.commit(`${first}^`);
    if (parent !== null) return { base: parent, from: 'planning-start', tag: null };
  }
  return { base: null, from: 'root', tag: null };
}

// ─── Reviews on disk ─────────────────────────────────────────────────────────

interface WindowOnDisk {
  review: string;
  text: string;
  fixReport: string | null;
}

class ReadUnreadable extends Error {}

function readOrThrow(file: string): string | null {
  const ev = readTextEvidence(file);
  if (ev.kind === 'found') return ev.value;
  if (ev.kind === 'none') return null;
  throw new ReadUnreadable(`${ev.reason}: ${file}`);
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Every `<date>-window/REVIEW.md` under `<planning>/reviews`, in directory-name order. */
function windowsOnDisk(projectDir: string): WindowOnDisk[] {
  const root = path.join(planningDir(projectDir), REVIEWS_DIR);
  const listing = readDirEntriesEvidence(root);
  if (listing.kind === 'none') return [];
  if (listing.kind === 'unreadable') throw new ReadUnreadable(`${listing.reason}: ${root}`);
  const out: WindowOnDisk[] = [];
  const names = listing.value.filter((e) => e.isDirectory() && e.name.endsWith(WINDOW_DIR_SUFFIX)).map((e) => e.name).sort();
  for (const name of names) {
    const dir = path.join(root, name);
    const text = readOrThrow(path.join(dir, WINDOW_FILES.review));
    if (text === null) continue;
    out.push({ review: toPosix(path.relative(projectDir, path.join(dir, WINDOW_FILES.review))), text, fixReport: readOrThrow(path.join(dir, WINDOW_FILES.fixReport)) });
  }
  return out;
}

/** The commit shas a REVIEW-FIX.md names on its `**Commit:**` lines, as written. */
export function fixCommitRefs(fixReport: string): string[] {
  const refs: string[] = [];
  for (const line of splitLines(fixReport)) {
    const m = COMMIT_LINE.exec(line.trim());
    if (m !== null) refs.push(m[1]);
  }
  return refs;
}

/** Fingerprint → the status of its newest broken-window entry. */
function ledgerStatuses(projectDir: string): Map<string, string> {
  const file = path.join(planningDir(projectDir), brokenWindowsMod.LEDGER_FILE_NAME);
  const text = readOrThrow(file);
  const out = new Map<string, string>();
  if (text === null) return out;
  let entries: Array<{ id: number; description: string; status: string }>;
  try {
    entries = brokenWindowsMod.parseLedger(text).entries;
  } catch (e) {
    throw new ReadUnreadable(`${brokenWindowsMod.LEDGER_FILE_NAME} cannot be parsed: ${(e as Error).message}`);
  }
  for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
    const m = FINGERPRINT_SUFFIX.exec(entry.description);
    if (m !== null) out.set(m[1], entry.status);
  }
  return out;
}

// ─── Acceptance record ───────────────────────────────────────────────────────

/** `<planning>/reviews/MILESTONE-<version>-ACCEPT.json`, absolute. */
export function milestoneAcceptPath(projectDir: string, milestone: string): string {
  if (!MILESTONE_VERSION_RE.test(milestone)) throw new RangeError(`milestone-review: not a milestone version: ${milestone}`);
  return path.join(planningDir(projectDir), REVIEWS_DIR, `MILESTONE-${milestone}-ACCEPT.json`);
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? [...value] : null;
}

/** The record, or null when the text is not a well-formed version-1 record. */
export function parseAcceptRecord(text: string): MilestoneAcceptRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const r = data as Record<string, unknown>;
  const uncovered = stringArray(r.uncovered);
  const openCritical = stringArray(r.openCritical);
  if (r.version !== 1 || typeof r.milestone !== 'string' || typeof r.reason !== 'string' || r.reason.trim() === '') return null;
  if (typeof r.acceptedAt !== 'string' || typeof r.head !== 'string' || uncovered === null || openCritical === null) return null;
  return { version: 1, milestone: r.milestone, reason: r.reason, acceptedAt: r.acceptedAt, head: r.head, uncovered, openCritical };
}

/** The record's file text, keys in a fixed order. */
export function formatAcceptRecord(record: Omit<MilestoneAcceptRecord, 'version'>): string {
  const ordered: MilestoneAcceptRecord = {
    version: 1,
    milestone: record.milestone,
    reason: record.reason,
    acceptedAt: record.acceptedAt,
    head: record.head,
    uncovered: [...record.uncovered],
    openCritical: [...record.openCritical],
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** Why `reason` cannot be recorded, or null when it can (trimmed, one line, at most ACCEPT_REASON_MAX). */
export function acceptReasonProblem(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed === '') return 'the reason is empty';
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return 'the reason must be one line with no control characters';
  if (trimmed.length > ACCEPT_REASON_MAX) return `the reason is ${trimmed.length} characters; at most ${ACCEPT_REASON_MAX}`;
  return null;
}

/** Does `record` still cover what is open now? Every uncovered commit and every open Critical key must be one it named. */
export function acceptCovers(record: MilestoneAcceptRecord, state: Pick<MilestoneReviewState, 'milestone' | 'uncovered' | 'openCritical'>): boolean {
  if (record.milestone !== state.milestone) return false;
  const commits = new Set(record.uncovered);
  const keys = new Set(record.openCritical);
  return state.uncovered.every((c) => commits.has(c.sha)) && state.openCritical.every((f) => keys.has(f.key));
}

function readAccept(projectDir: string, milestone: string): MilestoneAcceptState | null {
  const file = milestoneAcceptPath(projectDir, milestone);
  const text = readOrThrow(file);
  if (text === null) return null;
  const rel = toPosix(path.relative(projectDir, file));
  const record = parseAcceptRecord(text);
  if (record === null) return { path: rel, record: null, problem: 'not a well-formed acceptance record' };
  if (record.milestone !== milestone) return { path: rel, record: null, problem: `records milestone ${record.milestone}` };
  return { path: rel, record, problem: null };
}

// ─── Assessment ──────────────────────────────────────────────────────────────

function assess(projectDir: string, milestone: string, runner: GitRunner): MilestoneReviewAssessment {
  const git = makeGit(projectDir, runner);
  if (!git.isRepo()) return { kind: 'no-history', reason: 'not a git repository' };
  const head = git.commit('HEAD');
  if (head === null) return { kind: 'no-history', reason: 'the repository has no commits' };

  const { base, from, tag } = milestoneBase(projectDir, milestone, runner);
  const codeCommits = codeCommitsIn(git, base, head);
  const milestoneShas = new Set(codeCommits.map((c) => c.sha));

  const reviews: CoveringReview[] = [];
  const ignored: IgnoredReview[] = [];
  const covered = new Set<string>();
  const coveringTexts: WindowOnDisk[] = [];
  for (const w of windowsOnDisk(projectDir)) {
    const fm = rawFrontmatterMapping(w.text);
    const tipValue = fm?.tip;
    // The composer writes `base: null` for a window from the root; the frontmatter loader reads it as the string.
    const baseValue = fm?.base === 'null' ? null : fm?.base;
    const status = typeof fm?.status === 'string' ? fm.status : '';
    if (fm === null || typeof tipValue !== 'string' || (baseValue !== null && typeof baseValue !== 'string')) {
      ignored.push({ review: w.review, reason: 'not a composed window review (no tip/base frontmatter)' });
      continue;
    }
    if (status === 'incomplete') {
      ignored.push({ review: w.review, reason: 'incomplete: a lens report was never written' });
      continue;
    }
    const tip = git.commit(tipValue);
    const reviewBase = baseValue === null ? null : git.commit(baseValue);
    if (tip === null || (baseValue !== null && reviewBase === null)) {
      ignored.push({ review: w.review, reason: 'its tip or base is not in this repository' });
      continue;
    }
    const mine = new Set<string>();
    for (const c of codeCommitsIn(git, reviewBase, tip)) if (milestoneShas.has(c.sha)) mine.add(c.sha);
    if (w.fixReport !== null) {
      for (const ref of fixCommitRefs(w.fixReport)) {
        const sha = git.commit(ref);
        if (sha !== null && milestoneShas.has(sha)) mine.add(sha);
      }
    }
    if (mine.size === 0) continue;
    for (const sha of mine) covered.add(sha);
    reviews.push({ review: w.review, base: reviewBase, tip, status, covered: mine.size });
    coveringTexts.push(w);
  }

  const ledger = ledgerStatuses(projectDir);
  const openCritical: OpenCriticalFinding[] = [];
  let openWarnings = 0;
  for (const w of coveringTexts) {
    for (const f of openWindowFindings(w.text, w.fixReport).findings) {
      const ledgerStatus = f.fingerprint === null ? undefined : ledger.get(f.fingerprint);
      if (ledgerStatus === 'fixed' || ledgerStatus === 'waived') continue;
      if (f.severity === 'warning') openWarnings++;
      if (f.severity !== 'critical') continue;
      openCritical.push({ review: w.review, id: f.id, title: f.title, file: f.file, line: f.line, key: f.fingerprint ?? `${w.review}#${f.id}` });
    }
  }

  const lastWindow = readOrThrow(path.join(planningDir(projectDir), REVIEWS_DIR, LAST_WINDOW_FILE)) !== null;
  return {
    kind: 'assessed',
    state: {
      milestone,
      base,
      baseFrom: from,
      baseTag: tag,
      head,
      codeCommits,
      uncovered: codeCommits.filter((c) => !covered.has(c.sha)),
      reviews,
      ignored,
      openCritical,
      openWarnings,
      lastWindow,
      accept: readAccept(projectDir, milestone),
    },
  };
}

/**
 * The milestone's review state (module header). `no-history` when there is nothing git can show
 * (not a repository, no commits); `unreadable` when git or a file could not be read.
 */
export function assessMilestoneReview(projectDir: string, milestone: string, runner: GitRunner = execGitSeam): MilestoneReviewAssessment {
  if (!MILESTONE_VERSION_RE.test(milestone)) throw new RangeError(`milestone-review: not a milestone version: ${milestone}`);
  try {
    return assess(projectDir, milestone, runner);
  } catch (err) {
    if (err instanceof GitUnreadable || err instanceof ReadUnreadable) return { kind: 'unreadable', reason: err.message };
    throw err;
  }
}
