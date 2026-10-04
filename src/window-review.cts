/**
 * Window review (ADR-5208, design D2 of `.plans/pocock-practices-design.md`): the deterministic
 * half of `/gsd-code-review --since`. The lenses (correctness, standards, spec, simplify) are
 * agents; everything a program can answer about the window is answered here, so the agents get
 * it as data and spend their context on judgement (P1).
 *
 * ── The pre-pass ──
 *
 * `computeWindowPrepass` resolves the window through the evaluation-scope resolver (the `window`
 * unit: the union of the files each window commit touched, `base..until`) and measures what one
 * change at a time cannot show — the CUMULATIVE drift of the window:
 *
 *   - `loc-growth`              net lines per file, `base` → `tip` (one `git diff --numstat`);
 *   - `complexity-delta`        functions whose decision-point score jumped past
 *                               `refactor.complexity_jump_delta`, or crossed
 *                               `refactor.complexity_threshold`, between `git show base:f` and
 *                               `git show tip:f` (`complexity-trigger` does the scoring; both
 *                               bounds strictly greater, as there);
 *   - `unconsumed-exports`      exports of a window file with no consumer in the import graph
 *                               (`code-graph`, by the imported `names`): new in the window, or
 *                               whose last consumer the window removed (the base graph is built
 *                               from the files the window changed, read at `base`);
 *   - `churn`                   commits per file inside the window (`git-history`);
 *   - `review-only-recurrence`  files that collect `guarded by: review only` findings in two or
 *                               more earlier REVIEW.md (the window's phases and earlier windows) —
 *                               a class nobody built a mechanism for.
 *
 * Each class reports whether it ran (`classes[]`). A class that could not run says why and is
 * never presented as "nothing found": the lens prompts list exactly the classes that were checked
 * and tell the agent everything else is its own to find (P3, the 4.9 anchoring lesson).
 *
 * ── After the lenses ──
 *
 * `composeWindowReview` stitches the lens reports into the window's REVIEW.md: one section per
 * lens report, in lens order, findings verbatim and NEVER re-ranked or merged across lenses
 * (Pocock's two-axis rule), renumbered CR-/WR-/IN- across the document so `gsd-code-fixer` can
 * address each one. Findings the refuter disproved with evidence move to their own section;
 * findings the refuter did not cover stay, marked `unverified`. `deferredWindowEntries` turns the
 * surviving Critical/Warning findings that a fix pass did not fix into broken-windows entries,
 * each carrying a stable fingerprint so a re-run does not record it twice. `windowMarkerFor`
 * builds the `--since last` marker — written only once REVIEW.md exists.
 *
 * Every git call goes through the `execGit` seam with a bounded timeout. Pure functions
 * (`planBatches`, `complexityRises`, `parseReviewFindings`, `recurringReviewOnly`,
 * `parseRefutation`, `composeWindowReview`, `deferredWindowEntries`) are exported for tests.
 *
 * ADR-457 build-at-publish: source in src/window-review.cts, compiled to
 * gsd-core/bin/lib/window-review.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execGit as execGitSeam, retryRenameSync } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { resolveEvaluationScope, formatLastWindowMarker, lastWindowMarkerPath } from './gate-evaluation-scope.cjs';
import type { EvaluationScope, ScopeStatus, WindowSince } from './gate-evaluation-scope.cjs';
import { analyzeSource, evaluateCandidates, isAnalyzablePath, DEFAULTS as COMPLEXITY_DEFAULTS } from './complexity-trigger.cjs';
import type { AnalyzedFile, Baseline } from './complexity-trigger.cjs';
import { buildImportGraph, exportedNames, loadTsconfigAliases } from './code-graph.cjs';
import type { ImportGraph } from './code-graph.cjs';
import { readHistory, churnOf } from './git-history.cjs';
import { lex, languageOf } from './symbol-index.cjs';
import { splitLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { rawFrontmatterField } = frontmatterMod;
import { CODE_REVIEW_LENSES } from './code-review-flags.cjs';
import type { CodeReviewLens } from './code-review-flags.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
const { planningDir } = planningWorkspaceMod;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The `execGit` seam's shape; every option optional so the resolver and git-history accept it. */
export type GitRunner = (args: string[], opts?: { cwd?: string; timeout?: number; maxBuffer?: number }) => SpawnResultOutput;

/** What the pre-pass measures. Adding a member means adding its measurement, its test and its line in the lens prompt. */
export const PREPASS_CLASS = Object.freeze({
  LOC_GROWTH: 'loc-growth',
  COMPLEXITY_DELTA: 'complexity-delta',
  UNCONSUMED_EXPORTS: 'unconsumed-exports',
  CHURN: 'churn',
  REVIEW_ONLY_RECURRENCE: 'review-only-recurrence',
} as const);
export type PrepassClass = (typeof PREPASS_CLASS)[keyof typeof PREPASS_CLASS];

/** `checked` with a `reason` ran on partial evidence (a commit cap, say); `skipped` did not run. */
export interface ClassOutcome {
  class: PrepassClass;
  status: 'checked' | 'skipped';
  reason: string | null;
}

export interface FileGrowth {
  file: string;
  /** Null for a binary file. */
  added: number | null;
  removed: number | null;
  net: number | null;
}

export interface ComplexityRise {
  file: string;
  name: string;
  startLine: number;
  /** Score at `base`; null when the function did not exist there. */
  base: number | null;
  tip: number;
  /** `tip - base`; null when `base` is null. */
  delta: number | null;
  reasons: Array<'threshold' | 'jump'>;
}

export interface UnconsumedExport {
  file: string;
  name: string;
  /** `new`: exported first in the window. `lost-last-consumer`: consumed at `base`, by nothing at `tip`. */
  change: 'new' | 'lost-last-consumer';
}

export interface WindowFileChurn {
  file: string;
  commits: number;
  added: number;
  removed: number;
}

/** A finding read back from a REVIEW.md. */
export interface ReviewFinding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  file: string | null;
  line: number | null;
  /** The `guarded by:` value as written; null when the finding states none. */
  guardedBy: string | null;
  reviewOnly: boolean;
  /** The finding's full text: heading line through the line before the next heading. */
  block: string;
}

export interface RecurringReviewOnly {
  file: string;
  /** Distinct REVIEW.md files that carry a review-only finding on this file. */
  reviews: number;
  occurrences: Array<{ review: string; id: string; title: string }>;
}

/** One lens report the workflow expects an agent to write. */
export interface LensReport {
  /** `correctness`, `correctness-2` (a batch), `standards`, `spec`, `simplify`. */
  label: string;
  lens: CodeReviewLens;
  /** Project-relative, posix. */
  path: string;
  /** Correctness batches only: the files this report covers. */
  files?: string[];
}

export interface WindowMeta {
  since: string;
  sinceKind: WindowSince['kind'];
  until: string;
  tip: string;
  base: string | null;
  boundary: string | null;
  phases: Record<string, { dir: string; commits: string[] }>;
  unattributed: string[];
}

export interface WindowPrepass {
  version: 1;
  status: ScopeStatus;
  reason: string | null;
  window: WindowMeta | null;
  commits: number;
  /** The reviewable union (exists on disk). */
  files: string[];
  missingOnDisk: string[];
  classes: ClassOutcome[];
  locGrowth: FileGrowth[];
  complexity: { threshold: number; jumpDelta: number; rises: ComplexityRise[]; skipped: Array<{ file: string; reason: string }> };
  exports: UnconsumedExport[];
  churn: WindowFileChurn[];
  reviewOnly: { reviewsRead: string[]; recurring: RecurringReviewOnly[] };
  /** Files past `maxFiles` whose content was not analysed (complexity, exports), by name. */
  truncated: string[];
  /** The reviewable files split for the correctness lens, highest churn × complexity first. */
  batches: string[][];
  lenses: CodeReviewLens[];
  /** Project-relative, posix. */
  dir: string;
  review: string;
  reports: LensReport[];
}

export interface WindowPrepassOptions {
  since: string;
  /** Default `HEAD`. */
  until?: string;
  /** Lenses the review runs; default every lens. */
  lenses?: readonly CodeReviewLens[];
  /** The window directory's date, `YYYY-MM-DD`; default today (UTC, from `clock`). */
  date?: string;
  execGit?: GitRunner;
  clock?: { now(): number };
  /** Files whose content is analysed (complexity, exports); the rest are named in `truncated`. */
  maxFiles?: number;
  /** Correctness-lens batch size (`code_review.window_max_files_per_batch`). */
  batchSize?: number;
  threshold?: number;
  jumpDelta?: number;
  /** Distinct reviews a file needs to count as a review-only recurrence. */
  minRecurrence?: number;
  /** Per git call, ms. */
  timeoutMs?: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULTS = Object.freeze({
  maxFiles: 200,
  batchSize: 40,
  minRecurrence: 2,
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024 * 1024,
});

/** Where window reviews live, under the (workstream-aware) planning dir. */
export const REVIEWS_DIR = 'reviews';
const WINDOW_DIR_SUFFIX = '-window';
const REVIEW_FILE = 'REVIEW.md';
const PREPASS_FILE = 'prepass.json';
const FIX_REPORT_FILE = 'REVIEW-FIX.md';
const REFUTATION_FILE = 'REFUTATION.md';

const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const EMPTY_TREE_SHA256 = '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321';
/** Literal pathspecs per `git diff` call, safely under the Windows argv ceiling. */
const PATH_CHUNK = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Small helpers ───────────────────────────────────────────────────────────

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`window-review: ${name} must be a positive integer, got ${n}`);
  return n;
}

class GitUnreadable extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** A bounded git runner: stdout, `null` for a path git says is absent (exit 128 on `show`), or a throw. */
function makeGit(projectDir: string, runner: GitRunner, timeout: number) {
  const call = (args: string[]): SpawnResultOutput => {
    const r = runner(args, { cwd: projectDir, timeout, maxBuffer: DEFAULTS.maxOutputBytes });
    if (r.timedOut) throw new GitUnreadable('git-timeout');
    if (r.error !== null && 'code' in r.error && r.error.code === 'ENOBUFS') throw new GitUnreadable('git-output-overflow');
    if (r.exitCode === 127) throw new GitUnreadable('git-unavailable');
    return r;
  };
  return {
    text(args: string[]): string {
      const r = call(args);
      if (r.exitCode !== 0) throw new GitUnreadable(`git-failed:${args[0] ?? ''}`);
      return r.stdout;
    },
    /** The file at `rev`, or null when `rev` has no such path. */
    show(rev: string, file: string): string | null {
      const r = call(['show', `${rev}:${file}`]);
      if (r.exitCode === 0) return r.stdout;
      if (r.exitCode === 128) return null;
      throw new GitUnreadable('git-failed:show');
    },
  };
}
type Git = ReturnType<typeof makeGit>;

// ─── Batching ────────────────────────────────────────────────────────────────

/**
 * Split `files` into batches of at most `size`, highest `rank` first (ties by path), so the files
 * most likely to hold a cumulative defect are reviewed first and a cut-off never drops them.
 */
export function planBatches(files: readonly string[], size: number, rank: ReadonlyMap<string, number> = new Map()): string[][] {
  const n = positiveInt(size, DEFAULTS.batchSize, 'batchSize');
  const ordered = [...files].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0) || byPath(a, b));
  return chunks(ordered, n);
}

// ─── Complexity delta ────────────────────────────────────────────────────────

/**
 * Functions whose complexity rose inside the window: a jump past `jumpDelta` over the function's
 * score at `base`, or a crossing of `threshold` (absent or at/below it at `base`, above it at
 * `tip`). A function already above the threshold at `base` that did not jump is not a window
 * change and is not reported. Both bounds are strictly greater (`complexity-trigger` semantics).
 */
export function complexityRises(
  files: ReadonlyArray<{ file: string; base: string | null; tip: string }>,
  bounds: { threshold?: number; jumpDelta?: number } = {},
): { threshold: number; jumpDelta: number; rises: ComplexityRise[]; skipped: Array<{ file: string; reason: string }> } {
  const analyzed: AnalyzedFile[] = [];
  const baseline: Baseline = {};
  for (const f of files) {
    const tip = analyzeSource(f.tip);
    analyzed.push(tip.ok ? { file: f.file, ok: true, method: tip.method, functions: tip.functions } : { file: f.file, ok: false, reason: tip.reason });
    if (f.base === null) continue;
    const base = analyzeSource(f.base);
    if (!base.ok) continue;
    for (const fn of base.functions) baseline[`${f.file}::${fn.name}`] = { score: fn.score };
  }
  const evaluation = evaluateCandidates({ analyzed, baseline, threshold: bounds.threshold, jumpDelta: bounds.jumpDelta });
  const rises = evaluation.candidates
    .filter((c) => c.reasons.includes('jump') || (c.baseline === null || c.baseline <= evaluation.thresholdUsed))
    .map((c) => ({
      file: c.file, name: c.name, startLine: c.startLine, base: c.baseline, tip: c.score, delta: c.delta,
      reasons: c.reasons.filter((r) => r === 'jump' || c.baseline === null || c.baseline <= evaluation.thresholdUsed),
    }));
  return { threshold: evaluation.thresholdUsed, jumpDelta: evaluation.jumpDeltaUsed, rises, skipped: evaluation.skipped };
}

// ─── Unconsumed exports ──────────────────────────────────────────────────────

function namesOf(text: string): string[] {
  return exportedNames(lex(text, 'ts').code);
}

/** Does any module other than `file` bind `name` from it (a whole-module import binds everything)? */
function consumed(graph: ImportGraph, file: string, name: string): boolean {
  return graph.edges.some((e) => e.to === file && e.from !== file && (e.names === null || e.names.includes(name)));
}

export interface ExportsInput {
  /** Window files with their text at both ends (`base` null when the file is new). */
  windowFiles: ReadonlyArray<{ file: string; base: string | null; tip: string }>;
  /** The whole project at the tip. */
  tipGraph: ImportGraph;
  /** The names a file exports at the tip; null when it cannot be read. */
  tipNames: (file: string) => string[] | null;
  /** The window-changed files as they were at `base` (only they are lexed); null for a root window. */
  baseGraph: ImportGraph | null;
  /** Files the window changed (deleted ones included). */
  changed: ReadonlySet<string>;
}

/**
 * Exports with no consumer at the tip. `new`: a window file exports a name it did not export at
 * `base`. `lost-last-consumer`: at `base` a module the window changed bound the name by name, and
 * at the tip the name is still exported but nothing binds it — wherever the exporting file lives,
 * since the consumer's edit is what orphaned it. A whole-module import (`import * as`, `require`)
 * counts as consuming every name, so neither class reports through one.
 */
export function unconsumedExports(input: ExportsInput): UnconsumedExport[] {
  const found = new Map<string, UnconsumedExport>();
  const add = (e: UnconsumedExport): void => {
    found.set(`${e.file}\0${e.name}`, e);
  };
  for (const f of input.windowFiles) {
    if (languageOf(f.file) !== 'ts') continue;
    const before = f.base === null ? null : new Set(namesOf(f.base));
    for (const name of namesOf(f.tip)) {
      if ((before === null || !before.has(name)) && !consumed(input.tipGraph, f.file, name)) add({ file: f.file, name, change: 'new' });
    }
  }
  for (const e of input.baseGraph?.edges ?? []) {
    if (!input.changed.has(e.from) || e.from === e.to || e.names === null) continue;
    const exported = input.tipNames(e.to);
    if (exported === null) continue;
    for (const name of e.names) {
      if (!exported.includes(name) || consumed(input.tipGraph, e.to, name)) continue;
      if (!found.has(`${e.to}\0${name}`)) add({ file: e.to, name, change: 'lost-last-consumer' });
    }
  }
  return [...found.values()].sort((a, b) => byPath(a.file, b.file) || byPath(a.name, b.name));
}

// ─── REVIEW.md findings ──────────────────────────────────────────────────────

const FINDING_HEADING = /^### ((?:CR|WR|IN|BL)-\d+):[ \t]*(.*)$/;
const ANY_HEADING = /^#{1,3} /;
const FILE_LINE = /\*\*File:\*\*\s*`([^`]+)`/;
const GUARDED_BY = /guarded by\**\s*:\s*\**\s*(.+)$/im;
const SEVERITY_BY_PREFIX: Readonly<Record<string, ReviewFinding['severity']>> = Object.freeze({
  CR: 'critical', BL: 'critical', WR: 'warning', IN: 'info',
});

function splitFileRef(ref: string): { file: string; line: number | null } {
  const m = /^(.*?):(\d+)(?:[-–]\d+)?$/.exec(ref.trim());
  return m === null ? { file: ref.trim(), line: null } : { file: m[1], line: Number(m[2]) };
}

/**
 * The `### CR-01: …` / `WR-` / `IN-` / `BL-` findings of a REVIEW.md, in document order. A finding
 * runs from its heading to the next heading of level 1–3; `**File:** \`path:line\`` and
 * `guarded by: …` are read from inside it.
 */
export function parseReviewFindings(text: string): ReviewFinding[] {
  const lines = splitLines(text);
  const findings: ReviewFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FINDING_HEADING.exec(lines[i]);
    if (m === null) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_HEADING.test(lines[end])) end++;
    const block = lines.slice(i, end).join('\n').replace(/\n+$/, '');
    const fileRef = FILE_LINE.exec(block);
    const where = fileRef === null ? { file: null, line: null } : splitFileRef(fileRef[1]);
    const guard = GUARDED_BY.exec(block);
    const guardedBy = guard === null ? null : guard[1].replace(/[`*_]/g, '').trim();
    findings.push({
      id: m[1],
      severity: SEVERITY_BY_PREFIX[m[1].slice(0, 2)] ?? 'info',
      title: m[2].trim(),
      file: where.file,
      line: where.line,
      guardedBy,
      reviewOnly: guardedBy !== null && /^review[ -]only\b/i.test(guardedBy),
      block,
    });
    i = end - 1;
  }
  return findings;
}

/** Files carrying a review-only finding in at least `min` distinct reviews, most reviews first. */
export function recurringReviewOnly(
  reviews: ReadonlyArray<{ review: string; findings: readonly ReviewFinding[] }>,
  min: number = DEFAULTS.minRecurrence,
): RecurringReviewOnly[] {
  const floor = positiveInt(min, DEFAULTS.minRecurrence, 'minRecurrence');
  const byFile = new Map<string, RecurringReviewOnly & { seen: Set<string> }>();
  for (const r of reviews) {
    for (const f of r.findings) {
      if (!f.reviewOnly || f.file === null) continue;
      const entry = byFile.get(f.file) ?? { file: f.file, reviews: 0, occurrences: [], seen: new Set<string>() };
      entry.occurrences.push({ review: r.review, id: f.id, title: f.title });
      entry.seen.add(r.review);
      entry.reviews = entry.seen.size;
      byFile.set(f.file, entry);
    }
  }
  return [...byFile.values()]
    .filter((e) => e.reviews >= floor)
    .map(({ seen: _seen, ...rest }) => rest)
    .sort((a, b) => b.reviews - a.reviews || byPath(a.file, b.file));
}

/** The REVIEW.md files the recurrence class reads: the window phases' and every earlier window's. */
function earlierReviews(projectDir: string, window: WindowMeta, ownDir: string): string[] {
  const found = new Set<string>();
  for (const { dir } of Object.values(window.phases)) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(projectDir, dir));
    } catch {
      continue;
    }
    for (const n of names) if (/-REVIEW\.md$/.test(n)) found.add(toPosix(path.join(dir, n)));
  }
  const reviewsRoot = path.join(planningDir(projectDir), REVIEWS_DIR);
  let windows: string[] = [];
  try {
    windows = fs.readdirSync(reviewsRoot);
  } catch {
    windows = [];
  }
  for (const w of windows) {
    if (!w.endsWith(WINDOW_DIR_SUFFIX)) continue;
    const rel = toPosix(path.relative(projectDir, path.join(reviewsRoot, w, REVIEW_FILE)));
    if (toPosix(path.relative(projectDir, path.join(reviewsRoot, w))) === ownDir) continue;
    if (fs.existsSync(path.join(projectDir, rel))) found.add(rel);
  }
  return [...found].sort(byPath);
}

// ─── Lens layout ─────────────────────────────────────────────────────────────

/** The window's directory, project-relative and posix: `<planning>/reviews/<date>-window`. */
export function windowDirFor(projectDir: string, date: string): string {
  if (!DATE_RE.test(date)) throw new RangeError(`window-review: date must be YYYY-MM-DD, got ${date}`);
  return toPosix(path.relative(projectDir, path.join(planningDir(projectDir), REVIEWS_DIR, `${date}${WINDOW_DIR_SUFFIX}`)));
}

/** The reports the lens agents write: one per lens, the correctness lens one per batch when it has several. */
export function lensReports(dir: string, lenses: readonly CodeReviewLens[], batches: readonly string[][]): LensReport[] {
  const reports: LensReport[] = [];
  for (const lens of CODE_REVIEW_LENSES) {
    if (!lenses.includes(lens)) continue;
    if (lens === 'correctness' && batches.length > 1) {
      batches.forEach((files, i) => reports.push({ label: `correctness-${i + 1}`, lens, path: `${dir}/REVIEW-correctness-${i + 1}.md`, files }));
    } else if (lens === 'correctness') {
      reports.push({ label: lens, lens, path: `${dir}/REVIEW-${lens}.md`, files: batches[0] ?? [] });
    } else {
      reports.push({ label: lens, lens, path: `${dir}/REVIEW-${lens}.md` });
    }
  }
  return reports;
}

// ─── The pre-pass ────────────────────────────────────────────────────────────

function emptyPrepass(scope: EvaluationScope | null, status: ScopeStatus, reason: string | null): Omit<WindowPrepass, 'lenses' | 'dir' | 'review' | 'reports'> {
  const skipped = (r: string): ClassOutcome[] => Object.values(PREPASS_CLASS).map((c) => ({ class: c, status: 'skipped' as const, reason: r }));
  return {
    version: 1,
    status,
    reason,
    window: scope?.window === undefined ? null : windowMeta(scope),
    commits: scope?.commits.length ?? 0,
    files: scope?.files ?? [],
    missingOnDisk: scope?.missingOnDisk ?? [],
    classes: skipped(reason ?? 'no-files'),
    locGrowth: [],
    complexity: { threshold: COMPLEXITY_DEFAULTS.threshold, jumpDelta: COMPLEXITY_DEFAULTS.jumpDelta, rises: [], skipped: [] },
    exports: [],
    churn: [],
    reviewOnly: { reviewsRead: [], recurring: [] },
    truncated: [],
    batches: [],
  };
}

function windowMeta(scope: EvaluationScope): WindowMeta | null {
  const w = scope.window;
  if (w === undefined) return null;
  return { since: w.since, sinceKind: w.sinceKind, until: w.until, tip: w.tip, base: w.base, boundary: w.boundary, phases: w.phases, unattributed: w.unattributed };
}

function measureGrowth(git: Git, base: string | null, tip: string, files: readonly string[]): FileGrowth[] {
  const from = base ?? (tip.length === 64 ? EMPTY_TREE_SHA256 : EMPTY_TREE_SHA1);
  const rows: FileGrowth[] = [];
  for (const chunk of chunks(files, PATH_CHUNK)) {
    const out = git.text(['-c', 'core.quotepath=off', 'diff', '--numstat', '-z', '--no-renames', from, tip, '--', ...chunk.map((f) => `:(literal)${f}`)]);
    for (const record of out.split('\0')) {
      const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record.replace(/^\n/, ''));
      if (m === null) continue;
      const added = m[1] === '-' ? null : Number(m[1]);
      const removed = m[2] === '-' ? null : Number(m[2]);
      rows.push({ file: m[3], added, removed, net: added === null || removed === null ? null : added - removed });
    }
  }
  return rows.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity) || byPath(a.file, b.file));
}

function lensesOrAll(lenses: readonly CodeReviewLens[] | undefined): CodeReviewLens[] {
  const wanted = lenses === undefined || lenses.length === 0 ? CODE_REVIEW_LENSES : lenses;
  return CODE_REVIEW_LENSES.filter((l) => wanted.includes(l));
}

/** Measure the window `since..until`. Never throws on git trouble: a class that cannot run says why. */
export function computeWindowPrepass(projectDir: string, opts: WindowPrepassOptions): WindowPrepass {
  const runner: GitRunner = opts.execGit ?? execGitSeam;
  const timeout = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const maxFiles = positiveInt(opts.maxFiles, DEFAULTS.maxFiles, 'maxFiles');
  const batchSize = positiveInt(opts.batchSize, DEFAULTS.batchSize, 'batchSize');
  const clock = opts.clock ?? Date;
  const date = opts.date ?? new Date(clock.now()).toISOString().slice(0, 10);
  const dir = windowDirFor(projectDir, date);
  const lenses = lensesOrAll(opts.lenses);
  const layout = (batches: string[][]) => ({ lenses, dir, review: `${dir}/${REVIEW_FILE}`, reports: lensReports(dir, lenses, batches) });

  const unit = opts.until === undefined ? { kind: 'window' as const, since: opts.since } : { kind: 'window' as const, since: opts.since, until: opts.until };
  const scope = resolveEvaluationScope(projectDir, unit, { execGit: runner, clock });
  const meta = windowMeta(scope);
  if (scope.status === 'unresolvable' || meta === null) return { ...emptyPrepass(scope, 'unresolvable', scope.reason), ...layout([]) };
  if (scope.files.length === 0) return { ...emptyPrepass(scope, scope.status, scope.reason ?? 'no-files'), ...layout([]) };

  const git = makeGit(projectDir, runner, timeout);
  const classes: ClassOutcome[] = [];
  const outcome = (c: PrepassClass, run: () => string | null): void => {
    try {
      classes.push({ class: c, status: 'checked', reason: run() });
    } catch (error) {
      if (!(error instanceof GitUnreadable)) throw error;
      classes.push({ class: c, status: 'skipped', reason: error.reason });
    }
  };

  // Churn first: it ranks the files the content classes analyse and the batches.
  let churn: WindowFileChurn[] = [];
  const window = new Set(scope.files);
  outcome(PREPASS_CLASS.CHURN, () => {
    const history = readHistory(projectDir, meta.base === null ? { tip: meta.tip } : { tip: meta.tip, base: meta.base }, { execGit: runner, timeoutMs: timeout });
    if (history.status === 'unresolvable') throw new GitUnreadable(history.reason ?? 'git-failed:log');
    churn = churnOf(history).files.filter((f) => window.has(f.file));
    return history.status === 'resolved' || history.reason === 'empty-window' ? null : history.reason;
  });
  const churnOfFile = new Map(churn.map((c) => [c.file, c.commits]));

  let locGrowth: FileGrowth[] = [];
  outcome(PREPASS_CLASS.LOC_GROWTH, () => {
    locGrowth = measureGrowth(git, meta.base, meta.tip, scope.changedFiles);
    return null;
  });

  // Content classes read each analysable file at both ends; the cap keeps the subprocess count bounded.
  const analysable = scope.files.filter(isAnalyzablePath).sort((a, b) => (churnOfFile.get(b) ?? 0) - (churnOfFile.get(a) ?? 0) || byPath(a, b));
  const truncated = analysable.slice(maxFiles).sort(byPath);
  let contents: Array<{ file: string; base: string | null; tip: string }> = [];
  let contentError: string | null = null;
  try {
    for (const file of analysable.slice(0, maxFiles)) {
      const tip = git.show(meta.tip, file);
      if (tip === null) continue;
      contents.push({ file, base: meta.base === null ? null : git.show(meta.base, file), tip });
    }
  } catch (error) {
    if (!(error instanceof GitUnreadable)) throw error;
    contentError = error.reason;
    contents = [];
  }
  const partial = truncated.length > 0 ? `max-files:${maxFiles}` : null;

  let complexity: WindowPrepass['complexity'] = { threshold: COMPLEXITY_DEFAULTS.threshold, jumpDelta: COMPLEXITY_DEFAULTS.jumpDelta, rises: [], skipped: [] };
  outcome(PREPASS_CLASS.COMPLEXITY_DELTA, () => {
    if (contentError !== null) throw new GitUnreadable(contentError);
    complexity = complexityRises(contents, { threshold: opts.threshold, jumpDelta: opts.jumpDelta });
    return partial;
  });

  let exportsFound: UnconsumedExport[] = [];
  outcome(PREPASS_CLASS.UNCONSUMED_EXPORTS, () => {
    if (contentError !== null) throw new GitUnreadable(contentError);
    // The graph reads the work tree, so it describes the tip only when the tip is checked out.
    const head = git.text(['rev-parse', '--verify', 'HEAD^{commit}']).trim();
    if (head !== meta.tip) throw new GitUnreadable('tip-not-checked-out');
    const tipGraph = buildImportGraph(projectDir);
    const changed = new Set(scope.changedFiles);
    // The base graph lexes only the window-changed sources (the consumers whose edits can orphan
    // an export), read at `base`, ranked like the content files and under the same cap.
    const changedSources = scope.changedFiles.filter((f) => languageOf(f) === 'ts')
      .sort((a, b) => (churnOfFile.get(b) ?? 0) - (churnOfFile.get(a) ?? 0) || byPath(a, b));
    const lexedAtBase = new Set(changedSources.slice(0, maxFiles));
    let baseGraph: ImportGraph | null = null;
    if (meta.base !== null && lexedAtBase.size > 0) {
      const baseRev = meta.base;
      const listed = git.text(['-c', 'core.quotepath=off', 'ls-tree', '-r', '--name-only', '-z', baseRev]).split('\0').filter((f) => f !== '');
      baseGraph = buildImportGraph(projectDir, {
        listFiles: () => listed,
        aliases: loadTsconfigAliases(projectDir),
        readText: (file) => (lexedAtBase.has(file) ? git.show(baseRev, file) : null),
      });
    }
    const tipNames = (file: string): string[] | null => {
      try {
        return namesOf(fs.readFileSync(path.join(projectDir, file), 'utf-8'));
      } catch {
        return null;
      }
    };
    exportsFound = unconsumedExports({ windowFiles: contents, tipGraph, tipNames, baseGraph, changed });
    return partial ?? (changedSources.length > maxFiles ? `max-files:${maxFiles}` : null);
  });

  let reviewOnly: WindowPrepass['reviewOnly'] = { reviewsRead: [], recurring: [] };
  outcome(PREPASS_CLASS.REVIEW_ONLY_RECURRENCE, () => {
    const reviews = earlierReviews(projectDir, meta, dir).map((review) => ({
      review, findings: parseReviewFindings(fs.readFileSync(path.join(projectDir, review), 'utf-8')),
    }));
    reviewOnly = { reviewsRead: reviews.map((r) => r.review), recurring: recurringReviewOnly(reviews, opts.minRecurrence) };
    return reviews.length === 0 ? 'no-earlier-reviews' : null;
  });

  const peak = new Map<string, number>();
  for (const f of contents) {
    const scored = analyzeSource(f.tip);
    if (scored.ok) peak.set(f.file, Math.max(1, ...scored.functions.map((fn) => fn.score)));
  }
  const rank = new Map(scope.files.map((f) => [f, (churnOfFile.get(f) ?? 1) * (peak.get(f) ?? 1)]));
  const batches = planBatches(scope.files, batchSize, rank);
  const order = Object.values(PREPASS_CLASS);

  return {
    version: 1,
    status: scope.status,
    reason: scope.reason,
    window: meta,
    commits: scope.commits.length,
    files: scope.files,
    missingOnDisk: scope.missingOnDisk,
    classes: classes.sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class)),
    locGrowth,
    complexity,
    exports: exportsFound,
    churn,
    reviewOnly,
    truncated,
    batches,
    ...layout(batches),
  };
}

// ─── Refutation and composition ──────────────────────────────────────────────

export interface Verdict {
  label: string;
  id: string;
  verdict: 'upheld' | 'refuted';
  evidence: string;
}

const REFUTATION_HEADING = /^### ((?:correctness(?:-\d+)?|standards|spec|simplify)) ((?:CR|WR|IN|BL)-\d+):/;

/**
 * The refuter's verdicts (`gsd-finding-refuter`, review mode): each `### <label> <ID>: <title>`
 * heading, then `verdict: UPHELD | REFUTED` and `evidence: …`. A heading with no readable verdict
 * is UPHELD — a finding nobody could check must not be dropped.
 */
export function parseRefutation(text: string): Verdict[] {
  const lines = splitLines(text);
  const verdicts: Verdict[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = REFUTATION_HEADING.exec(lines[i]);
    if (m === null) continue;
    let verdict: Verdict['verdict'] = 'upheld';
    let evidence = '';
    for (let j = i + 1; j < lines.length && !ANY_HEADING.test(lines[j]); j++) {
      const v = /^verdict:\s*(UPHELD|REFUTED)\b/i.exec(lines[j]);
      if (v !== null) verdict = v[1].toUpperCase() === 'REFUTED' ? 'refuted' : 'upheld';
      const e = /^evidence:\s*(.*)$/i.exec(lines[j]);
      if (e !== null) evidence = e[1].trim();
    }
    verdicts.push({ label: m[1], id: m[2], verdict, evidence });
  }
  return verdicts;
}

/** A finding's identity across runs: lens, file and normalised title — never a line number or an ID. */
export function findingFingerprint(lens: string, finding: Pick<ReviewFinding, 'file' | 'title' | 'id'>): string {
  const title = finding.title.toLowerCase().replace(/\(external:[^)]*\)/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const digest = crypto.createHash('sha256').update(`${lens}\0${finding.file ?? ''}\0${title}`).digest('hex').slice(0, 10);
  return `wr:${digest}`;
}

export interface ComposeInput {
  window: WindowMeta;
  files: readonly string[];
  reports: ReadonlyArray<LensReport & { text: string | null }>;
  /** The refuter's output, or null when it did not run. */
  refutation: string | null;
  reviewedAt: string;
}

export interface ComposedReview {
  text: string;
  counts: { critical: number; warning: number; info: number; total: number; refuted: number; unverified: number };
  missingReports: string[];
  status: 'clean' | 'issues_found' | 'incomplete';
}

function yamlList(items: readonly string[], indent: string): string {
  return items.length === 0 ? ' []' : `\n${items.map((i) => `${indent}- ${JSON.stringify(i)}`).join('\n')}`;
}

/**
 * The window's REVIEW.md. Lens reports keep their own sections in lens order and their findings
 * their own order — no merge, no re-ranking. IDs are renumbered across the document (a fixer needs
 * each ID once); every finding names the lens report and ID it came from, its verification and its
 * fingerprint. A report that was expected but not written is named, and with no findings the
 * review is `incomplete`, never `clean`.
 */
export function composeWindowReview(input: ComposeInput): ComposedReview {
  const verdicts = input.refutation === null ? [] : parseRefutation(input.refutation);
  const verdictOf = (label: string, id: string): Verdict | undefined => verdicts.find((v) => v.label === label && v.id === id);
  const counters = { CR: 0, WR: 0, IN: 0 };
  const counts = { critical: 0, warning: 0, info: 0, total: 0, refuted: 0, unverified: 0 };
  const sections: string[] = [];
  const refutedLines: string[] = [];
  const missingReports: string[] = [];

  for (const report of input.reports) {
    if (report.text === null) {
      missingReports.push(report.label);
      continue;
    }
    const body: string[] = [];
    for (const f of parseReviewFindings(report.text)) {
      const verdict = verdictOf(report.label, f.id);
      if (verdict?.verdict === 'refuted') {
        counts.refuted++;
        refutedLines.push(`- ${report.label} ${f.id}: ${f.title} — ${verdict.evidence || 'no evidence recorded'}`);
        continue;
      }
      const prefix = f.severity === 'critical' ? 'CR' : f.severity === 'warning' ? 'WR' : 'IN';
      counters[prefix]++;
      counts[f.severity]++;
      counts.total++;
      const verification = verdict === undefined ? 'unverified' : 'upheld';
      if (verdict === undefined) counts.unverified++;
      const id = `${prefix}-${String(counters[prefix]).padStart(2, '0')}`;
      const [, ...rest] = f.block.split('\n');
      body.push([
        `### ${id}: ${f.title}`,
        `_Lens: ${report.label} ${f.id} · verification: ${verification} · id: ${findingFingerprint(report.lens, f)}_`,
        ...rest,
      ].join('\n'));
    }
    sections.push(`## Lens: ${report.label}\n\n${body.length === 0 ? 'No findings.' : body.join('\n\n')}`);
  }

  const status: ComposedReview['status'] = counts.total > 0 ? 'issues_found' : missingReports.length > 0 ? 'incomplete' : 'clean';
  const w = input.window;
  const frontmatter = [
    '---',
    `window: ${JSON.stringify(`${w.since}..${w.until}`)}`,
    `since: ${JSON.stringify(w.since)}`,
    `until: ${JSON.stringify(w.until)}`,
    `tip: ${JSON.stringify(w.tip)}`,
    `base: ${w.base === null ? 'null' : JSON.stringify(w.base)}`,
    `reviewed: ${input.reviewedAt}`,
    `lenses:${yamlList(input.reports.map((r) => r.label), '  ')}`,
    `files_reviewed: ${input.files.length}`,
    `files_reviewed_list:${yamlList(input.files, '  ')}`,
    'findings:',
    `  critical: ${counts.critical}`,
    `  warning: ${counts.warning}`,
    `  info: ${counts.info}`,
    `  total: ${counts.total}`,
    `refuted: ${counts.refuted}`,
    `unverified: ${counts.unverified}`,
    `missing_reports:${yamlList(missingReports, '  ')}`,
    `status: ${status}`,
    '---',
  ].join('\n');
  const parts = [
    frontmatter,
    '',
    `# Window Review: ${w.since}..${w.until}`,
    '',
    `**Tip:** \`${w.tip}\`  **Base:** \`${w.base ?? 'root'}\`  **Files:** ${input.files.length}  **Status:** ${status}`,
    '',
    'Each lens is its own section, findings in the order the lens reported them. Findings are not merged or re-ranked across lenses.',
    '',
    ...sections.flatMap((s) => [s, '']),
  ];
  if (refutedLines.length > 0) parts.push('## Refuted on verification', '', ...refutedLines, '');
  if (missingReports.length > 0) parts.push('## Lens reports not written', '', ...missingReports.map((l) => `- ${l}`), '');
  if (input.refutation === null) parts.push('_The refutation pass did not run: every finding is unverified._', '');
  return { text: `${parts.join('\n').replace(/\n+$/, '')}\n`, counts, missingReports, status };
}

/**
 * Is `review` a composed REVIEW.md of this very window — the same base and the same tip, however
 * `since` was spelled? Then a `--fix` run can fix it as it stands instead of reviewing it again.
 */
export function reviewMatchesWindow(review: string, window: Pick<WindowMeta, 'base' | 'tip'>): boolean {
  const tip = rawFrontmatterField(review, 'tip');
  const base = rawFrontmatterField(review, 'base');
  return tip !== null && base !== null && tip.value === window.tip && base.value === window.base;
}

// ─── Deferred findings → broken windows ──────────────────────────────────────

export interface DeferredEntry {
  phase: string;
  file: string;
  line: number | null;
  description: string;
  fingerprint: string;
}

const COMPOSED_ORIGIN = /^_Lens: (\S+) ((?:CR|WR|IN|BL)-\d+) · verification: \w+ · id: (wr:[0-9a-f]{10})_$/m;

/** The finding IDs a REVIEW-FIX.md lists under `## Fixed Issues`. */
export function fixedFindingIds(fixReport: string): Set<string> {
  const ids = new Set<string>();
  let inFixed = false;
  for (const line of splitLines(fixReport)) {
    if (/^## /.test(line)) inFixed = /^## Fixed Issues\b/.test(line);
    const m = inFixed ? /^### ((?:CR|WR|IN|BL)-\d+):/.exec(line) : null;
    if (m !== null) ids.add(m[1]);
  }
  return ids;
}

/**
 * The window findings to record as broken windows: Critical and Warning findings of the composed
 * REVIEW.md that a fix pass did not fix and that `known` (fingerprints already in WINDOWS.md) does
 * not hold. Descriptions are one line, tab-free, and end with the fingerprint.
 */
export function deferredWindowEntries(review: string, fixReport: string | null, known: ReadonlySet<string>, phase: string): DeferredEntry[] {
  const fixed = fixReport === null ? new Set<string>() : fixedFindingIds(fixReport);
  const out: DeferredEntry[] = [];
  for (const f of parseReviewFindings(review)) {
    if (f.severity === 'info' || fixed.has(f.id)) continue;
    const origin = COMPOSED_ORIGIN.exec(f.block);
    if (origin === null || known.has(origin[3])) continue;
    const title = f.title.replace(/\s+/g, ' ').trim();
    out.push({
      phase,
      file: f.file ?? '',
      line: f.line,
      description: `window review ${origin[1]} ${origin[2]}: ${title} [${origin[3]}]`,
      fingerprint: origin[3],
    });
  }
  return out;
}

/**
 * Open broken-window entries this review's fix pass closed: an entry whose description ends with
 * the fingerprint of a composed finding the REVIEW-FIX.md lists as fixed. Ids, ascending.
 */
export function fixedWindowEntryIds(
  review: string,
  fixReport: string | null,
  entries: ReadonlyArray<{ id: number; description: string; status: string }>,
): number[] {
  if (fixReport === null) return [];
  const fixed = fixedFindingIds(fixReport);
  const fingerprints = new Set<string>();
  for (const f of parseReviewFindings(review)) {
    const origin = COMPOSED_ORIGIN.exec(f.block);
    if (origin !== null && fixed.has(f.id)) fingerprints.add(origin[3]);
  }
  return entries
    .filter((e) => e.status === 'open' && fingerprints.has(/\[(wr:[0-9a-f]{10})\]$/.exec(e.description)?.[1] ?? ''))
    .map((e) => e.id)
    .sort((a, b) => a - b);
}

// ─── Files on disk ───────────────────────────────────────────────────────────

/** Write `content` to `file` through a sibling temp file and a rename. */
export function writeTextAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    retryRenameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/** The file names a window directory holds. */
export const WINDOW_FILES = Object.freeze({ review: REVIEW_FILE, prepass: PREPASS_FILE, fixReport: FIX_REPORT_FILE, refutation: REFUTATION_FILE });

/** The `--since last` marker for a window whose REVIEW.md exists, or why not. */
export function windowMarkerFor(
  projectDir: string,
  prepass: Pick<WindowPrepass, 'window' | 'review'>,
  reviewedAt: string,
): { ok: true; path: string; text: string } | { ok: false; reason: 'no-window' | 'no-review' } {
  if (prepass.window === null) return { ok: false, reason: 'no-window' };
  if (!fs.existsSync(path.join(projectDir, prepass.review))) return { ok: false, reason: 'no-review' };
  const { tip, since, until } = prepass.window;
  return { ok: true, path: lastWindowMarkerPath(projectDir), text: formatLastWindowMarker({ tip, since, until, reviewedAt, review: prepass.review }) };
}

// ─── Milestone stage (code-review capability, `milestone:pre`) ───────────────

/**
 * Where a milestone's window starts: the last window review (`last`) when one was recorded,
 * otherwise the latest `v*` tag merged into HEAD that is not the milestone being closed (a re-run
 * after tagging must not review an empty window). `null` when neither exists — the stage then has
 * no window to measure and says so instead of reviewing the whole history.
 */
export function milestoneWindowSince(projectDir: string, milestone: string | null, runner: GitRunner = execGitSeam): string | null {
  if (fs.existsSync(lastWindowMarkerPath(projectDir))) return 'last';
  const r = runner(['tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-v:refname'], { cwd: projectDir, timeout: DEFAULTS.timeoutMs });
  if (r.exitCode !== 0) return null;
  const tags = splitLines(r.stdout).map((t) => t.trim()).filter((t) => t !== '' && t !== milestone);
  return tags[0] ?? null;
}

/** The stage answer of `review stage` (loop-hook-dispatch.md). */
export interface MilestoneReviewAnswer {
  decision: 'skip' | 'suggest' | 'auto';
  message: string | null;
  next: { skill: 'code-review'; args: string } | null;
}

/**
 * What `complete-milestone` does with a milestone window's pre-pass: an empty window is skip;
 * otherwise the pre-pass is summarised and the model review follows when
 * `code_review.window_at_milestone` is on (`auto`), or is only named when it is off (`suggest`).
 * A window that could not be resolved is a `suggest` naming why — never a silent skip.
 */
export function milestoneReviewAnswer(
  prepass: Pick<WindowPrepass, 'status' | 'reason' | 'files' | 'commits' | 'classes' | 'dir'> | null,
  since: string | null,
  atMilestone: boolean,
  slash = '/gsd-code-review',
): MilestoneReviewAnswer {
  if (since === null) {
    return { decision: 'suggest', message: `No window review yet and no earlier milestone tag to start from: run ${slash} --since <ref> once to set the baseline`, next: null };
  }
  const command = `${slash} --since ${since}`;
  if (prepass === null || prepass.status === 'unresolvable') {
    return { decision: 'suggest', message: `The milestone window --since ${since} did not resolve (${prepass?.reason ?? 'unknown'}): run ${command} by hand`, next: null };
  }
  if (prepass.files.length === 0) return { decision: 'skip', message: null, next: null };
  const checked = prepass.classes.filter((c) => c.status === 'checked').length;
  const summary = `Milestone window --since ${since}: ${prepass.files.length} file(s), ${prepass.commits} commit(s); pre-pass checked ${checked} of ${prepass.classes.length} classes → ${prepass.dir}/${PREPASS_FILE}`;
  if (atMilestone) return { decision: 'auto', message: summary, next: { skill: 'code-review', args: `--since ${since}` } };
  return { decision: 'suggest', message: `${summary}. Model review is off (code_review.window_at_milestone): run ${command}`, next: null };
}
