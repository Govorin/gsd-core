/**
 * Milestone review coverage — has the code a milestone changed been through a window review, and
 * does that review still hold an open Critical finding? The deterministic half of the code-review
 * capability's `milestone:pre` gate (`check milestone-review`, src/gate-milestone-review.cts) and
 * of the owner's recorded override (`review milestone-accept`, src/review-command-router.cts).
 *
 * ── The milestone window ──
 *
 * `base` (exclusive) is where the milestone's change starts — ONE answer, `milestoneBase`, shared with
 * the code-review stage's `--since` (`milestoneWindowStart`). The candidates, nearest to HEAD wins:
 *
 *   - `archive`  the previous milestone's archive commit: the newest commit that added a
 *                `<planning>/milestones/<v>-ROADMAP.md` other than the milestone being closed. It
 *                exists whatever the tagging scheme (git.create_tag off, per-repo tags).
 *   - `tag`      the previous milestone's tag: a tag naming that archived version under any prefix
 *                (`v1.2`, `polyglot-v1.2`, `a/b/v1.2`); with nothing archived, a `v*` tag only when
 *                this repository is the one complete-milestone tags (create_tag on, not per_repo,
 *                and the project is the repository's root, not a project nested in a monorepo).
 *
 * With neither (a first milestone): `planning-start`, the parent of the first commit under this
 * project's own `.planning/` (a nested `.planning` in a monorepo has its own history), else `root`.
 * A shallow clone is `unreadable`: there, a missing tag or archive means "not fetched".
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
 * `incomplete`, carries a status outside `clean`/`issues_found`, has no full-sha `tip`/`base`, has
 * no `## Lens:` section, or whose tip is not in the repository covers nothing (fail closed), and is
 * listed as ignored with the reason. A fix commit counts only when REVIEW-FIX.md records it under a
 * fixed-issues entry, it descends from the review's tip, and its subject names a finding that entry names.
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
 * the instant, the exact uncovered commits and open Critical keys accepted, and (informational, not
 * checked) the HEAD it was recorded at. It is self-invalidating: it holds only while every commit still uncovered and every Critical still open
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
import { SCOPE_EXCLUSION_PATHSPECS, parseLastWindowMarker } from './gate-evaluation-scope.cjs';
import { readWorkflowConfigValue } from './gate-config.cjs';
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
const { planningDir, planningRoot } = planningWorkspaceMod;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MilestoneCommit {
  sha: string;
  subject: string;
}

export type MilestoneBaseFrom = 'archive' | 'tag' | 'planning-start' | 'root';

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
  /** The previous milestone's version, from its archive file; null when none is archived. */
  previous: string | null;
  head: string;
  codeCommits: MilestoneCommit[];
  uncovered: MilestoneCommit[];
  reviews: CoveringReview[];
  ignored: IgnoredReview[];
  openCritical: OpenCriticalFinding[];
  openWarnings: number;
  /** The `--since` a review of what is left starts from (`milestoneWindowStart`); null when git cannot express one. */
  reviewSince: string | null;
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
const COMMIT_LINE = /^\*\*Commit:\*\*(.*)$/;
const SHA_TOKEN = /\b[0-9a-f]{7,64}\b/g;
const FINDING_ID = /(?<![A-Za-z0-9-])(?:CR|WR|IN|BL)-\d+(?![0-9])/g;
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
    /** Is `a` an ancestor of (or equal to) `b`? */
    isAncestor(a: string, b: string): boolean {
      const r = call(['merge-base', '--is-ancestor', a, b]);
      if (r.exitCode === 0) return true;
      if (r.exitCode === 1) return false;
      throw new GitUnreadable('git-failed:merge-base');
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

/** Where the milestone's change starts, and what pointed there (module header). */
export interface MilestoneBase {
  base: string | null;
  from: MilestoneBaseFrom;
  /** The tag `base` came from (`from: 'tag'`), else null. */
  tag: string | null;
  /** The previous milestone's version, read from its archive file name; null when none is archived. */
  previous: string | null;
}

/** A path under the project as a git pathspec relative to `projectDir` (the cwd every call runs in). */
function relSpec(projectDir: string, abs: string): string {
  return toPosix(path.relative(projectDir, abs)) || '.';
}

/** Is a `git.*` switch explicitly off? Absent = on. */
function configOff(projectDir: string, key: string): boolean {
  const resolved = readWorkflowConfigValue(projectDir, key);
  return resolved.found && (resolved.value === false || resolved.value === 'false');
}

/** Does `tag` name `version` under some prefix scheme (`v1.2`, `polyglot-v1.2`, `apps/polyglot/v1.2`)? */
export function tagNamesVersion(tag: string, version: string): boolean {
  return tag === version || tag.endsWith(`-${version}`) || tag.endsWith(`/${version}`);
}

/**
 * Throw unless git can show the whole history: a shallow clone cuts it off, so "no earlier tag, no
 * archive commit" there means "not fetched", never "the milestone is the whole history".
 */
function assertFullHistory(git: Git): void {
  if (git.text(['rev-parse', '--is-shallow-repository']).trim() === 'true') throw new GitUnreadable('shallow-repository: this clone does not hold the whole history — run `git fetch --unshallow`, or turn the gate off with code_review.milestone_gate: false');
}

function nearestToHead(git: Git, candidates: ReadonlyArray<MilestoneBase & { base: string }>): (MilestoneBase & { base: string }) | null {
  let best: (MilestoneBase & { base: string }) | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const distance = Number(git.text(['rev-list', '--count', `${c.base}..HEAD`]).trim());
    if (Number.isFinite(distance) && distance < bestDistance) {
      best = c;
      bestDistance = distance;
    }
  }
  return best;
}

function resolveBase(projectDir: string, milestone: string | null, git: Git): MilestoneBase {
  assertFullHistory(git);
  const planning = planningDir(projectDir);
  const archive = relSpec(projectDir, path.join(planning, 'milestones'));
  const candidates: Array<MilestoneBase & { base: string }> = [];

  // The previous milestone's archive commit: the newest commit that added a `<v>-ROADMAP.md` to the
  // archive, the milestone being closed excluded (a re-run after archiving).
  const specs = ['--', `:(glob)${archive}/*-ROADMAP.md`];
  if (milestone !== null) specs.push(`:(exclude,glob)${archive}/${milestone}-ROADMAP.md`);
  const added = lines(git.text(['log', '-n', '1', '--diff-filter=A', '--format=@@%H', '--name-only', 'HEAD', ...specs]));
  const archiveSha = added.find((l) => l.startsWith('@@'))?.slice(2) ?? null;
  const archivedFile = added.find((l) => !l.startsWith('@@') && l.endsWith('-ROADMAP.md')) ?? null;
  const previous = archivedFile === null ? null : path.posix.basename(archivedFile).slice(0, -'-ROADMAP.md'.length);
  if (archiveSha !== null && FULL_SHA.test(archiveSha)) candidates.push({ base: archiveSha, from: 'archive', tag: null, previous });

  // The previous milestone's tag. Known version: any tag naming it under the project's prefix scheme,
  // whatever git.create_tag says now. No archive to name it: `v*` tags, only when this repository is
  // the one complete-milestone tags (git.create_tag not off, repo_tagging not per_repo).
  const tagged = lines(git.text(['tag', '--merged', 'HEAD', '--sort=-v:refname']));
  const tagFor = (pred: (t: string) => boolean): void => {
    for (const tag of tagged) {
      if (milestone !== null && tagNamesVersion(tag, milestone)) continue;
      if (!pred(tag)) continue;
      const sha = git.commit(tag);
      if (sha !== null) {
        candidates.push({ base: sha, from: 'tag', tag, previous });
        return;
      }
    }
  };
  // A project nested in a monorepo (`rev-parse --show-prefix` non-empty) does not own the repository's
  // bare `v*` tags: without an archived version to name, it has no tag of its own.
  const nested = git.text(['rev-parse', '--show-prefix']).trim() !== '';
  if (previous !== null) tagFor((t) => tagNamesVersion(t, previous));
  else if (!nested && !configOff(projectDir, 'git.create_tag') && readWorkflowConfigValue(projectDir, 'git.repo_tagging').value !== 'per_repo') {
    tagFor((t) => /^v\d/.test(t));
  }

  const nearest = nearestToHead(git, candidates);
  if (nearest !== null) return nearest;

  // A first milestone: the work GSD planned starts at the first commit under this project's own
  // planning directory (a nested `.planning` in a monorepo is its own history, not the repository's).
  const first = lines(git.text(['rev-list', '--reverse', 'HEAD', '--', relSpec(projectDir, planningRoot(projectDir))]))[0];
  if (first !== undefined) {
    const parent = git.commit(`${first}^`);
    if (parent !== null) return { base: parent, from: 'planning-start', tag: null, previous: null };
  }
  return { base: null, from: 'root', tag: null, previous: null };
}

function windowStart(projectDir: string, git: Git, found: MilestoneBase): string | null {
  const markerText = readOrThrow(path.join(planningDir(projectDir), REVIEWS_DIR, LAST_WINDOW_FILE));
  const marker = markerText === null ? null : parseLastWindowMarker(markerText);
  const markerTip = marker === null ? null : git.commit(marker.tip);
  if (markerTip !== null && git.isAncestor(markerTip, 'HEAD') && (found.base === null || git.isAncestor(found.base, markerTip))) return 'last';
  if (found.base === null) return null;
  return found.tag ?? found.base;
}

/** Where the milestone's change starts (module header). Throws on a git failure or a shallow clone. */
export function milestoneBase(projectDir: string, milestone: string | null, runner: GitRunner = execGitSeam): MilestoneBase {
  return resolveBase(projectDir, milestone, makeGit(projectDir, runner));
}

/**
 * The `--since` the code-review milestone stage reviews from: the recorded window (`last`) when its
 * tip is at least as near to HEAD as the milestone base, else the base (its tag name when it has one,
 * else its sha). Null when there is no start git can express (a base at the root, a git failure, a
 * shallow clone) — the stage then names no window instead of reviewing the whole history.
 */
export function milestoneWindowStart(projectDir: string, milestone: string | null, runner: GitRunner = execGitSeam): string | null {
  try {
    const git = makeGit(projectDir, runner);
    return windowStart(projectDir, git, resolveBase(projectDir, milestone, git));
  } catch (err) {
    if (err instanceof GitUnreadable || err instanceof ReadUnreadable) return null;
    throw err;
  }
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

/** One commit a REVIEW-FIX.md records as a fix. */
export interface FixCommitClaim {
  /** Every finding id the `### …` entry under `## Fixed Issues` names (one entry may fix several). */
  ids: string[];
  /** The sha as written (abbreviated or full). */
  ref: string;
}

/**
 * The commits a REVIEW-FIX.md records as fixes: every sha on a `**Commit:**` line (a line may name
 * several) inside a `### …` entry of `## Fixed Issues`, with every finding id that heading names —
 * `### CR-01: …`, `### WR-04 (correctness-2 WR-01): …`, `### WR-01 (correctness-1), WR-12 и WR-13 …`.
 * A sha anywhere else — a skipped finding, prose — is no claim.
 */
export function fixCommitClaims(fixReport: string): FixCommitClaim[] {
  const claims: FixCommitClaim[] = [];
  let inFixed = false;
  let ids: string[] = [];
  for (const raw of splitLines(fixReport)) {
    const line = raw.trim();
    if (/^## /.test(line)) {
      inFixed = /^## Fixed Issues\b/.test(line);
      ids = [];
      continue;
    }
    if (/^### /.test(line)) {
      ids = inFixed ? [...new Set(line.match(FINDING_ID) ?? [])] : [];
      continue;
    }
    const m = COMMIT_LINE.exec(line);
    if (m !== null && ids.length > 0) for (const ref of m[1].match(SHA_TOKEN) ?? []) claims.push({ ids: [...ids], ref });
  }
  return claims;
}

/**
 * Does a commit subject name finding `id`? Both fix conventions put it there: gsd-code-fixer
 * `fix(<phase>): CR-01 …`, `/gsd-audit-fix` `fix(<scope>): resolve CR-01 — …`. `CR-1` is not `CR-10`.
 */
export function subjectNamesFinding(subject: string, id: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9])`).test(subject);
}

/** The statuses a composed window review that ran every lens can carry. */
export const COVERING_STATUSES: readonly string[] = Object.freeze(['clean', 'issues_found']);

interface WindowReviewHeader {
  tip: string;
  base: string | null;
  status: string;
}

function windowReviewHeader(text: string): WindowReviewHeader {
  const fm = rawFrontmatterMapping(text);
  // The composer writes `base: null` for a window from the root; the frontmatter loader reads it as the string.
  const base = fm?.base === 'null' || fm?.base === null ? null : fm?.base;
  return { tip: typeof fm?.tip === 'string' ? fm.tip : '', base: typeof base === 'string' ? base : null, status: typeof fm?.status === 'string' ? fm.status : '' };
}

/**
 * Why a REVIEW.md cannot count as coverage, or null when it can: only a composed review — full-sha
 * `tip` and `base` (or `base: null`), a status from COVERING_STATUSES, at least one `## Lens:`
 * section — covers anything. Fail closed: a hand-written or truncated file reviews nothing.
 */
export function windowReviewProblem(text: string): { reason: string } | null {
  const fm = rawFrontmatterMapping(text);
  if (fm === null) return { reason: 'not a composed window review (no frontmatter)' };
  const base = fm.base === 'null' || fm.base === null ? null : fm.base;
  if (typeof fm.tip !== 'string' || !FULL_SHA.test(fm.tip)) return { reason: 'not a composed window review (tip is not a full commit sha)' };
  if (base !== null && (typeof base !== 'string' || !FULL_SHA.test(base))) return { reason: 'not a composed window review (base is not a full commit sha or null)' };
  const status = typeof fm.status === 'string' ? fm.status : '';
  if (status === 'incomplete') return { reason: 'incomplete: a lens report was never written' };
  if (!COVERING_STATUSES.includes(status)) return { reason: `status ${JSON.stringify(status)} is not one a finished review carries (${COVERING_STATUSES.join(', ')})` };
  if (!splitLines(text).some((l) => /^## Lens: \S/.test(l))) return { reason: 'no lens section: no lens reviewed anything' };
  return null;
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

  const found = resolveBase(projectDir, milestone, git);
  const { base, from, tag } = found;
  const codeCommits = codeCommitsIn(git, base, head);
  const milestoneShas = new Set(codeCommits.map((c) => c.sha));
  const subjectOf = new Map(codeCommits.map((c) => [c.sha, c.subject]));

  const reviews: CoveringReview[] = [];
  const ignored: IgnoredReview[] = [];
  const covered = new Set<string>();
  const coveringTexts: WindowOnDisk[] = [];
  for (const w of windowsOnDisk(projectDir)) {
    const problem = windowReviewProblem(w.text);
    if (problem !== null) {
      ignored.push({ review: w.review, reason: problem.reason });
      continue;
    }
    const header = windowReviewHeader(w.text);
    const status = header.status;
    const tip = git.commit(header.tip);
    const reviewBase = header.base === null ? null : git.commit(header.base);
    if (tip === null || (header.base !== null && reviewBase === null)) {
      ignored.push({ review: w.review, reason: 'its tip or base is not in this repository' });
      continue;
    }
    const mine = new Set<string>();
    for (const c of codeCommitsIn(git, reviewBase, tip)) if (milestoneShas.has(c.sha)) mine.add(c.sha);
    // A fix commit is this review's remedy only when it is a fix of one of its findings: recorded
    // under that finding's Fixed Issues entry, made after what was reviewed, and naming the finding
    // in its subject (both fix conventions do). A feature commit a REVIEW-FIX.md happens to name is
    // new work, never covered by a review that predates it.
    if (w.fixReport !== null) {
      for (const claim of fixCommitClaims(w.fixReport)) {
        const sha = git.commit(claim.ref);
        if (sha === null || !milestoneShas.has(sha) || !git.isAncestor(tip, sha)) continue;
        const subject = subjectOf.get(sha) ?? '';
        if (claim.ids.some((id) => subjectNamesFinding(subject, id))) mine.add(sha);
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

  return {
    kind: 'assessed',
    state: {
      milestone,
      base,
      baseFrom: from,
      baseTag: tag,
      previous: found.previous,
      head,
      codeCommits,
      uncovered: codeCommits.filter((c) => !covered.has(c.sha)),
      reviews,
      ignored,
      openCritical,
      openWarnings,
      reviewSince: windowStart(projectDir, git, found),
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
