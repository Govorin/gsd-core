'use strict';
/**
 * Review command router — `gsd-tools review <subcommand>`: the deterministic steps of a window
 * review (`/gsd-code-review --since`, ADR-5208). The workflow step
 * `gsd-core/workflows/code-review/steps/window-scope.md` calls them in this order:
 *
 *   review window-prepass --since <7d|YYYY-MM-DD|ref|last> [--until <ref>] [--lens a,b]
 *                         [--date YYYY-MM-DD] [--max-files N] [--batch-size N]
 *       Resolve the window, measure it (src/window-review.cts), write
 *       `<planning>/reviews/<date>-window/prepass.json`, print the pre-pass with the paths every
 *       lens report goes to. No `--lens` → `code_review.window_lenses`; no `--batch-size` →
 *       `code_review.window_max_files_per_batch`; complexity bounds → `refactor.complexity_*`.
 *   review window-compose --dir <window dir>
 *       Stitch the lens reports and REFUTATION.md into the window's REVIEW.md.
 *   review window-deferred --dir <window dir> [--raw]
 *       Broken-window bookkeeping: the surviving Critical/Warning findings no fix pass fixed and
 *       WINDOWS.md does not hold yet (`windows append` arguments), and the open entries of this
 *       review the fix pass did fix (`windows fixed` ids). `--raw`: one tab-separated line each,
 *       `append\tphase\tfile\tline\tdescription` (`-` for no file or line) or `fixed\t<id>`.
 *   review window-mark --dir <window dir>
 *       Record the window's tip for `--since last` — refused until REVIEW.md exists.
 *   review window-paths --review <path to a window REVIEW.md>
 *       Validate a window REVIEW.md path for `code-review-fix.md --review`.
 *
 *   review invocation -- <the /gsd-code-review arguments>
 *       The invocation IR of `/gsd-code-review` (code-review-flags.cts): phase or window mode and
 *       every flag, as JSON. A refusal (a phase with --since, --lens without --since, …) exits
 *       with the registry's USAGE code and its `code-review: …` message. The workflow reads its
 *       arguments through this instead of requiring the module from the project directory, which
 *       only exists in this repository.
 *   review findings [--review <path to a window REVIEW.md>]
 *       The findings of a window review no fix reached (`openWindowFindings`), for
 *       `/gsd-audit-fix --source window-review`. Without `--review`, the newest window under
 *       `<planning>/reviews`. Each finding carries its `/gsd-audit-fix` level (high|medium|low).
 *   review record-fixed --review <path to a window REVIEW.md> --finding <ID> [--commit <sha>]
 *       List a finding fixed outside `gsd-code-fixer` under `## Fixed Issues` of the window's
 *       REVIEW-FIX.md (`recordFixedFinding`), so `window-deferred` closes its broken-window entry.
 *
 *   review depth          (stdin: {flagDepth, configDepth, overrides, files, repoRoot} as JSON)
 *       The path-scoped review depth of the phase-review step `resolve_depth`
 *       (code-review-depth.cts), printed as the resolver returns it: `ok: false` with `errors` is a
 *       result the workflow halts on, not a CLI failure. Files travel on stdin, never argv (the
 *       Windows argv ceiling).
 *   review fallow-binary
 *       The fallow binary of the structural pre-pass: `node_modules/.bin` first, then PATH
 *       (fallow-runner.cts). `binary: null` when there is none; `--raw` prints the path or nothing.
 *   review fallow-normalize --report <FALLOW.json> --out <file>
 *       Write fallow's raw report normalized to the `{summary, findings[]}` the reviewer reads. An
 *       unreadable or invalid report normalizes to an empty one. Both paths stay in the project.
 *   review plan-coverage --manifest <file> --review <file>
 *       Which plan ids of a `/gsd-review` plans manifest (`- <id>` lines) one reviewer's output
 *       names, as `{complete, missing_ids, total}`; an id preceded or followed by a word character
 *       or a hyphen does not count. Read-only — both files live in the run's temp directory, so
 *       neither is confined to the project.
 *
 *   These steps used to `require('./gsd-core/bin/lib/…')` from the workflow, which resolves
 *   against the user's project and so worked only in this repository.
 *
 *   review stage [--milestone vX.Y] [--date YYYY-MM-DD]
 *       The code-review capability's `milestone:pre` command step: resolve the milestone's window
 *       (`last`, else the previous `v*` tag, else the parent of the first `.planning/` commit), run the pre-pass over it (written like
 *       window-prepass), and answer per loop-hook-dispatch.md — `auto` with `/gsd-code-review
 *       --since <since>` as `next` when `code_review.window_at_milestone` is on, `suggest` when it
 *       is off, `skip` for an empty window. The deterministic pre-pass always runs.
 *
 *   review milestone-accept --milestone vX.Y --reason "<why>"
 *       The owner's recorded override of the `milestone:pre` gate `check milestone-review`: the
 *       unreviewed commits and open Critical findings of the milestone as they stand now, with the
 *       reason, written to `<planning>/reviews/MILESTONE-<vX.Y>-ACCEPT.json`
 *       (src/milestone-review.cts). Self-invalidating: a commit or a finding that appears after it
 *       blocks again. Nothing open → nothing written (`written: false`).
 *
 * Failure mapping (ADR-3889, through io.error's reason → outcome): bad argv or a path outside
 * `<planning>/reviews` → `usage`; a window git cannot resolve (`no-last-window-marker`, an unknown
 * ref, a git timeout) → `window_review_unresolvable` (UNAVAILABLE: the review could not look); a
 * missing prepass/REVIEW.md where one is required → `window_review_unresolvable`.
 *
 * First-party and always routable, like `review-lane` and `windows`; the workflow gates on
 * `workflow.code_review`.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationMod = require('./capability-activation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import brokenWindowsMod = require('./broken-windows.cjs');
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { parseWindowSince, isSafeRefArgument } from './gate-evaluation-scope.cjs';
import { CODE_REVIEW_LENSES, resolveCodeReviewInvocation } from './code-review-flags.cjs';
import type { CodeReviewLens } from './code-review-flags.cjs';
import {
  computeWindowPrepass, composeWindowReview, deferredWindowEntries, fixedWindowEntryIds, milestoneReviewAnswer, milestoneWindowSince,
  openWindowFindings, recordFixedFinding, reviewMatchesWindow, windowMarkerFor, writeTextAtomic,
  REVIEWS_DIR, WINDOW_FILES,
} from './window-review.cjs';
import type { GitRunner, WindowPrepass } from './window-review.cjs';
import { formatGsdSlashFor } from './runtime-slash.cjs';
import { resolveCodeReviewDepth } from './code-review-depth.cjs';
import type { ResolveCodeReviewDepthInput } from './code-review-depth.cjs';
import { normalizeFallowReportFile, resolveFallowBinary } from './fallow-runner.cjs';
import { escapeRegex } from './pattern.cjs';
import {
  acceptReasonProblem, assessMilestoneReview, formatAcceptRecord, milestoneAcceptPath, milestoneBase, MILESTONE_VERSION_RE,
} from './milestone-review.cjs';

const { output, getJsonErrorMode, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { planningDir } = planningWorkspaceMod;

export const REVIEW_SUBCOMMANDS: readonly string[] = Object.freeze([
  'depth', 'fallow-binary', 'fallow-normalize', 'findings', 'invocation', 'milestone-accept', 'plan-coverage', 'record-fixed', 'stage',
  'window-compose', 'window-deferred', 'window-mark', 'window-paths', 'window-prepass',
]);

const USAGE = Object.freeze({
  'window-prepass': 'Usage: gsd-tools review window-prepass --since <7d|YYYY-MM-DD|ref|last> [--until <ref>] [--lens a,b] [--date YYYY-MM-DD] [--max-files N] [--batch-size N]',
  'window-compose': 'Usage: gsd-tools review window-compose --dir <window dir>',
  'window-deferred': 'Usage: gsd-tools review window-deferred --dir <window dir> [--raw]',
  'window-mark': 'Usage: gsd-tools review window-mark --dir <window dir>',
  'window-paths': 'Usage: gsd-tools review window-paths --review <window REVIEW.md>',
  stage: 'Usage: gsd-tools review stage [--milestone vX.Y] [--date YYYY-MM-DD]',
  'milestone-accept': 'Usage: gsd-tools review milestone-accept --milestone vX.Y --reason "<why the milestone closes without a full review>"',
  invocation: 'Usage: gsd-tools review invocation -- <code-review arguments>',
  findings: 'Usage: gsd-tools review findings [--review <window REVIEW.md>]',
  'record-fixed': 'Usage: gsd-tools review record-fixed --review <window REVIEW.md> --finding <ID> [--commit <sha>]',
  depth: 'Usage: gsd-tools review depth  (stdin: {"flagDepth","configDepth","overrides","files","repoRoot"} as JSON)',
  'fallow-binary': 'Usage: gsd-tools review fallow-binary',
  'fallow-normalize': 'Usage: gsd-tools review fallow-normalize --report <FALLOW.json> --out <file>',
  'plan-coverage': 'Usage: gsd-tools review plan-coverage --manifest <file> --review <file>',
});

interface RouteReviewCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: the clock `--since 7d` and the window date are measured from. */
  _clock?: { now(): number };
  /** Test seam: the git runner of `stage` (window start lookup and pre-pass). */
  _execGit?: GitRunner;
  /** Test seam: replaces the read of the process's standard input (`depth`). */
  _readStdin?: () => string;
}

class UsageError extends Error {}
class Unresolvable extends Error {}

/** The value after `--name` (or `--name=v`); null when absent; a UsageError when present without one. */
function flagValue(args: readonly string[], name: string): string | null {
  let value: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${name}`) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} requires a value`);
      value = v;
      i++;
    } else if (a.startsWith(`--${name}=`)) {
      value = a.slice(name.length + 3);
    }
  }
  return value;
}

/** A positive-integer flag; undefined when absent. */
function intFlag(args: readonly string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === null) return undefined;
  if (!/^[1-9]\d{0,5}$/.test(raw)) throw new UsageError(`--${name} must be a positive integer, got ${raw}`);
  return Number(raw);
}

/** A config value used as a positive integer; undefined (the module default) when it is not one. */
function configInt(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function parseLenses(value: string): { lenses: CodeReviewLens[]; unknown: string[] } {
  const entries = [...new Set(value.split(',').map((s) => s.trim()).filter((s) => s !== ''))];
  const known = CODE_REVIEW_LENSES as readonly string[];
  return {
    lenses: CODE_REVIEW_LENSES.filter((l) => entries.includes(l)),
    unknown: entries.filter((e) => !known.includes(e)),
  };
}

function readConfig(cwd: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;
  const config = loadConfig(cwd);
  const get = (key: string): unknown => resolveConfigKey(key, { config, cwd, registry, quiet: true }).value;
  return {
    lenses: get('code_review.window_lenses'),
    batchSize: get('code_review.window_max_files_per_batch'),
    atMilestone: get('code_review.window_at_milestone'),
    threshold: get('refactor.complexity_threshold'),
    jumpDelta: get('refactor.complexity_jump_delta'),
  };
}

/** A window directory named by `--dir`: inside `<planning>/reviews`, absolute. */
function windowDirArg(args: readonly string[], cwd: string, usage: string): string {
  const raw = flagValue(args, 'dir');
  if (raw === null) throw new UsageError(usage);
  const reviews = path.join(planningDir(cwd), REVIEWS_DIR);
  const abs = tryWithinRoot(path.resolve(cwd, raw), reviews, PathAcceptance.AbsoluteInsideRoot);
  if (abs === null || abs === path.resolve(reviews)) throw new UsageError(`--dir ${JSON.stringify(raw)} is not a window directory under ${REVIEWS_DIR}/`);
  return abs;
}

function readPrepass(dir: string): WindowPrepass {
  const file = path.join(dir, WINDOW_FILES.prepass);
  const text = readOrNull(file);
  if (text === null) throw new Unresolvable(`no ${WINDOW_FILES.prepass} in ${dir} — run review window-prepass first`);
  try {
    return JSON.parse(text) as WindowPrepass;
  } catch {
    throw new Unresolvable(`${WINDOW_FILES.prepass} in ${dir} is not valid JSON — re-run review window-prepass`);
  }
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

function rel(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join('/');
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function handlePrepass(args: string[], cwd: string, raw: boolean, clock: { now(): number } | undefined): void {
  const since = flagValue(args, 'since');
  if (since === null) throw new UsageError(USAGE['window-prepass']);
  if (parseWindowSince(since) === null) throw new UsageError(`--since must be last, a duration (7d, 12h, 2w), a date or a ref, got ${since}`);
  const until = flagValue(args, 'until');
  if (until !== null && !isSafeRefArgument(until)) throw new UsageError(`--until must be a git ref, got ${until}`);
  const date = flagValue(args, 'date');
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`--date must be YYYY-MM-DD, got ${date}`);

  const lensFlag = flagValue(args, 'lens');
  const lensArg = lensFlag === null ? null : parseLenses(lensFlag);
  if (lensArg !== null && lensArg.unknown.length > 0) {
    throw new UsageError(`unknown --lens ${lensArg.unknown.join(', ')}; expected any of ${CODE_REVIEW_LENSES.join(', ')}`);
  }
  const maxFiles = intFlag(args, 'max-files');
  const batchFlag = intFlag(args, 'batch-size');

  // Argv is fully validated above: a usage error never depends on, or waits for, the config.
  const config = readConfig(cwd);
  const warnings: string[] = [];
  let lenses: CodeReviewLens[];
  if (lensArg !== null) {
    lenses = lensArg.lenses;
  } else {
    const parsed = parseLenses(typeof config.lenses === 'string' ? config.lenses : '');
    if (parsed.unknown.length > 0) warnings.push(`code_review.window_lenses: ignored unknown lens ${parsed.unknown.join(', ')}`);
    lenses = parsed.lenses.length > 0 ? parsed.lenses : [...CODE_REVIEW_LENSES];
  }

  const prepass = computeWindowPrepass(cwd, {
    since,
    ...(until !== null ? { until } : {}),
    ...(date !== null ? { date } : {}),
    ...(clock !== undefined ? { clock } : {}),
    lenses,
    maxFiles,
    batchSize: batchFlag ?? configInt(config.batchSize),
    threshold: typeof config.threshold === 'number' ? config.threshold : undefined,
    jumpDelta: typeof config.jumpDelta === 'number' ? config.jumpDelta : undefined,
  });
  if (prepass.status === 'unresolvable') throw new Unresolvable(`cannot resolve the window --since ${since}: ${prepass.reason ?? 'unknown'}`);
  const file = path.join(cwd, prepass.dir, WINDOW_FILES.prepass);
  writeTextAtomic(file, `${JSON.stringify(prepass, null, 2)}\n`);
  // A REVIEW.md of this very window (same since, same tip) lets `--fix` fix it without re-reviewing.
  const existing = readOrNull(path.join(cwd, prepass.review));
  const reviewedAlready = existing !== null && prepass.window !== null && reviewMatchesWindow(existing, prepass.window);
  output({ ...prepass, prepass: rel(cwd, file), reviewedAlready, warnings }, raw, `${rel(cwd, file)}\n`);
}

function handleInvocation(args: string[], raw: boolean): void {
  const sep = args.indexOf('--');
  if (sep === -1) throw new UsageError(USAGE.invocation);
  const invocation = resolveCodeReviewInvocation(args.slice(sep + 1));
  if (invocation.ok) {
    output(invocation, raw);
    return;
  }
  // The refusal carries its own `code-review: …` message and the registry's USAGE exit code
  // (ADR-3889), which the workflow passes on as its own exit status.
  process.stderr.write(getJsonErrorMode()
    ? `${JSON.stringify({ ok: false, reason: ERROR_REASON.USAGE, code: invocation.code, message: invocation.message })}\n`
    : `${invocation.message}\n`);
  process.exitCode = invocation.exitCode;
}

function planningStartSince(cwd: string, milestone: string | null, execGit: GitRunner | undefined): string | null {
  try {
    const found = milestoneBase(cwd, milestone, execGit);
    return found.from === 'planning-start' ? found.base : null;
  } catch {
    // git could not answer: the stage then names no start, as before — a suggestion, never a review of the whole history.
    return null;
  }
}

function handleStage(args: string[], cwd: string, raw: boolean, clock: { now(): number } | undefined, execGit: GitRunner | undefined): void {
  const milestone = flagValue(args, 'milestone');
  if (milestone !== null && !isSafeRefArgument(milestone)) throw new UsageError(`--milestone must be a version like v1.2, got ${milestone}`);
  const date = flagValue(args, 'date');
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError(`--date must be YYYY-MM-DD, got ${date}`);
  const config = readConfig(cwd);
  // Absent = enabled: only an explicit false turns the model review off.
  const atMilestone = config.atMilestone !== false;
  const slashOut = formatGsdSlashFor(cwd, 'code-review');
  const slash = typeof slashOut === 'string' ? slashOut : undefined;
  // No window marker and no earlier milestone tag (a first milestone): the window starts where the
  // planning began, the same base the milestone-review gate measures coverage from.
  const since = milestoneWindowSince(cwd, milestone, execGit) ?? planningStartSince(cwd, milestone, execGit);
  if (since === null) {
    output({ since, window: null, ...milestoneReviewAnswer(null, null, atMilestone, slash) }, raw);
    return;
  }
  const parsedLenses = parseLenses(typeof config.lenses === 'string' ? config.lenses : '');
  const prepass = computeWindowPrepass(cwd, {
    since,
    ...(date !== null ? { date } : {}),
    ...(clock !== undefined ? { clock } : {}),
    ...(execGit !== undefined ? { execGit } : {}),
    lenses: parsedLenses.lenses.length > 0 ? parsedLenses.lenses : [...CODE_REVIEW_LENSES],
    batchSize: configInt(config.batchSize),
    threshold: typeof config.threshold === 'number' ? config.threshold : undefined,
    jumpDelta: typeof config.jumpDelta === 'number' ? config.jumpDelta : undefined,
  });
  const answer = milestoneReviewAnswer(prepass, since, atMilestone, slash);
  let written: string | null = null;
  if (prepass.status !== 'unresolvable' && prepass.files.length > 0) {
    const file = path.join(cwd, prepass.dir, WINDOW_FILES.prepass);
    writeTextAtomic(file, `${JSON.stringify(prepass, null, 2)}\n`);
    written = rel(cwd, file);
  }
  output({
    since,
    status: prepass.status,
    reason: prepass.reason,
    window: prepass.window,
    files: prepass.files.length,
    commits: prepass.commits,
    classes: prepass.classes,
    prepass: written,
    ...answer,
  }, raw);
}

function handleCompose(args: string[], cwd: string, raw: boolean, clock: { now(): number } | undefined): void {
  const dir = windowDirArg(args, cwd, USAGE['window-compose']);
  const prepass = readPrepass(dir);
  if (prepass.window === null) throw new Unresolvable(`${WINDOW_FILES.prepass} in ${dir} has no resolved window`);
  const composed = composeWindowReview({
    window: prepass.window,
    files: prepass.files,
    reports: prepass.reports.map((r) => ({ ...r, text: readOrNull(path.join(cwd, r.path)) })),
    refutation: readOrNull(path.join(dir, WINDOW_FILES.refutation)),
    reviewedAt: new Date((clock ?? Date).now()).toISOString(),
  });
  const file = path.join(dir, WINDOW_FILES.review);
  writeTextAtomic(file, composed.text);
  output({ review: rel(cwd, file), status: composed.status, counts: composed.counts, missingReports: composed.missingReports }, raw, `${rel(cwd, file)}\n`);
}

function handleDeferred(args: string[], cwd: string, raw: boolean): void {
  const dir = windowDirArg(args, cwd, USAGE['window-deferred']);
  const review = readOrNull(path.join(dir, WINDOW_FILES.review));
  if (review === null) throw new Unresolvable(`no ${WINDOW_FILES.review} in ${dir} — run review window-compose first`);
  const ledgerText = readOrNull(path.join(planningDir(cwd), brokenWindowsMod.LEDGER_FILE_NAME));
  let ledgerEntries: ReturnType<typeof brokenWindowsMod.parseLedger>['entries'] = [];
  if (ledgerText !== null) {
    try {
      ledgerEntries = brokenWindowsMod.parseLedger(ledgerText).entries;
    } catch (e) {
      throw new Unresolvable(`${brokenWindowsMod.LEDGER_FILE_NAME} cannot be read: ${(e as Error).message}`);
    }
  }
  const known = new Set<string>();
  for (const entry of ledgerEntries) {
    const m = /\[(wr:[0-9a-f]{10})\]$/.exec(entry.description);
    if (m !== null) known.add(m[1]);
  }
  const fixReport = readOrNull(path.join(dir, WINDOW_FILES.fixReport));
  const entries = deferredWindowEntries(review, fixReport, known, path.basename(dir));
  const fixed = fixedWindowEntryIds(review, fixReport, ledgerEntries);
  const lines = [
    // `-` stands for an absent file or line: a shell `read` with a tab IFS collapses empty fields.
    ...entries.map((e) => ['append', e.phase, e.file === '' ? '-' : e.file, e.line === null ? '-' : String(e.line), e.description].join('\t')),
    ...fixed.map((id) => `fixed\t${id}`),
  ];
  output({ entries, fixed, alreadyRecorded: known.size }, raw, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

function handleMark(args: string[], cwd: string, raw: boolean, clock: { now(): number } | undefined): void {
  const dir = windowDirArg(args, cwd, USAGE['window-mark']);
  const prepass = readPrepass(dir);
  const marker = windowMarkerFor(cwd, prepass, new Date((clock ?? Date).now()).toISOString());
  if (!marker.ok) {
    throw new Unresolvable(marker.reason === 'no-review'
      ? `${prepass.review} does not exist — the marker is written only after the window's REVIEW.md`
      : `${WINDOW_FILES.prepass} in ${dir} has no resolved window`);
  }
  writeTextAtomic(marker.path, marker.text);
  output({ marker: rel(cwd, marker.path), ...JSON.parse(marker.text) as Record<string, unknown> }, raw, `${rel(cwd, marker.path)}\n`);
}

/** A window REVIEW.md named by `--review`: `<planning>/reviews/<window>/REVIEW.md`, existing, absolute. */
function windowReviewArg(reviewArg: string, cwd: string): string {
  const reviews = path.join(planningDir(cwd), REVIEWS_DIR);
  const abs = tryWithinRoot(path.resolve(cwd, reviewArg), reviews, PathAcceptance.AbsoluteInsideRoot);
  if (abs === null || path.basename(abs) !== WINDOW_FILES.review || path.dirname(abs) === path.resolve(reviews)) {
    throw new UsageError(`--review ${JSON.stringify(reviewArg)} is not a window ${WINDOW_FILES.review} under ${REVIEWS_DIR}/<window>/`);
  }
  if (!fs.existsSync(abs)) throw new Unresolvable(`${rel(cwd, abs)} does not exist — run /gsd-code-review --since first`);
  return abs;
}

/** The newest window's REVIEW.md: window directories are date-named, so the last in name order. */
function newestWindowReview(cwd: string): string {
  const reviews = path.join(planningDir(cwd), REVIEWS_DIR);
  let names: string[] = [];
  try {
    names = fs.readdirSync(reviews, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    names = [];
  }
  const newest = names.sort().reverse().find((n) => fs.existsSync(path.join(reviews, n, WINDOW_FILES.review)));
  if (newest === undefined) throw new Unresolvable(`no window ${WINDOW_FILES.review} under ${REVIEWS_DIR}/ — run /gsd-code-review --since first`);
  return path.join(reviews, newest, WINDOW_FILES.review);
}

function windowTarget(cwd: string, abs: string) {
  const dir = path.dirname(abs);
  return {
    review: rel(cwd, abs),
    fixReport: rel(cwd, path.join(dir, WINDOW_FILES.fixReport)),
    dir: rel(cwd, dir),
    label: path.basename(dir),
  };
}

function handlePaths(args: string[], cwd: string, raw: boolean): void {
  const reviewArg = flagValue(args, 'review');
  if (reviewArg === null) throw new UsageError(USAGE['window-paths']);
  const abs = windowReviewArg(reviewArg, cwd);
  output(windowTarget(cwd, abs), raw, `${rel(cwd, abs)}\n`);
}

function handleFindings(args: string[], cwd: string, raw: boolean): void {
  const reviewArg = flagValue(args, 'review');
  const abs = reviewArg === null ? newestWindowReview(cwd) : windowReviewArg(reviewArg, cwd);
  const review = readOrNull(abs);
  if (review === null) throw new Unresolvable(`${rel(cwd, abs)} cannot be read`);
  const { findings, fixed } = openWindowFindings(review, readOrNull(path.join(path.dirname(abs), WINDOW_FILES.fixReport)));
  const lines = findings.map((f) => [f.id, f.level, f.file ?? '-', f.line === null ? '-' : String(f.line), f.title].join('\t'));
  output({ ...windowTarget(cwd, abs), findings, fixed }, raw, lines.length === 0 ? '' : `${lines.join('\n')}\n`);
}

function handleRecordFixed(args: string[], cwd: string, raw: boolean): void {
  const reviewArg = flagValue(args, 'review');
  const id = flagValue(args, 'finding');
  if (reviewArg === null || id === null) throw new UsageError(USAGE['record-fixed']);
  if (!/^(?:CR|WR|IN|BL)-\d+$/.test(id)) throw new UsageError(`--finding must be a finding id like WR-03, got ${id}`);
  const commit = flagValue(args, 'commit');
  if (commit !== null && !/^[0-9a-f]{4,64}$/.test(commit)) throw new UsageError(`--commit must be a commit sha, got ${commit}`);
  const abs = windowReviewArg(reviewArg, cwd);
  const review = readOrNull(abs);
  if (review === null) throw new Unresolvable(`${rel(cwd, abs)} cannot be read`);
  const fixFile = path.join(path.dirname(abs), WINDOW_FILES.fixReport);
  const recorded = recordFixedFinding(review, readOrNull(fixFile), id, commit);
  if (!recorded.ok) throw new UsageError(`${rel(cwd, abs)} has no finding ${id}`);
  if (recorded.changed) writeTextAtomic(fixFile, recorded.text);
  output({ fixReport: rel(cwd, fixFile), finding: id, changed: recorded.changed }, raw, `${rel(cwd, fixFile)}\n`);
}

/**
 * The owner's recorded override of the milestone-review gate: what is open now (unreviewed commits,
 * open Critical findings) is written with the reason to `<planning>/reviews/MILESTONE-<v>-ACCEPT.json`.
 * It is self-invalidating (src/milestone-review.cts): anything that appears after it blocks again.
 */
function handleMilestoneAccept(args: string[], cwd: string, raw: boolean, clock: { now(): number } | undefined, execGit: GitRunner | undefined): void {
  const milestone = flagValue(args, 'milestone');
  const reason = flagValue(args, 'reason');
  if (milestone === null || reason === null) throw new UsageError(USAGE['milestone-accept']);
  if (!MILESTONE_VERSION_RE.test(milestone)) throw new UsageError(`--milestone must be a version like v1.2, got ${milestone}`);
  const problem = acceptReasonProblem(reason);
  if (problem !== null) throw new UsageError(`--reason: ${problem}`);
  const assessment = assessMilestoneReview(cwd, milestone, execGit);
  if (assessment.kind === 'unreadable') throw new Unresolvable(`the milestone review state could not be read: ${assessment.reason}`);
  if (assessment.kind === 'no-history') throw new Unresolvable(`${assessment.reason} — there is nothing to accept`);
  const { state } = assessment;
  const file = milestoneAcceptPath(cwd, milestone);
  if (state.uncovered.length === 0 && state.openCritical.length === 0) {
    output({ written: false, path: rel(cwd, file), milestone, uncovered: 0, openCritical: 0, message: `milestone ${milestone} is fully reviewed with no open Critical finding — nothing to accept` }, raw, '');
    return;
  }
  const record = {
    milestone,
    reason: reason.trim(),
    acceptedAt: new Date((clock ?? Date).now()).toISOString(),
    head: state.head,
    uncovered: state.uncovered.map((c) => c.sha),
    openCritical: state.openCritical.map((f) => f.key),
  };
  writeTextAtomic(file, formatAcceptRecord(record));
  output({
    written: true,
    path: rel(cwd, file),
    milestone,
    reason: record.reason,
    acceptedAt: record.acceptedAt,
    head: record.head,
    uncovered: record.uncovered.length,
    openCritical: record.openCritical.length,
  }, raw, `${rel(cwd, file)}\n`);
}

function handleDepth(readStdin: () => string, raw: boolean): void {
  let input: unknown;
  try {
    input = JSON.parse(readStdin());
  } catch {
    throw new UsageError(`${USAGE.depth} — stdin is not JSON`);
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new UsageError(`${USAGE.depth} — stdin is not a JSON object`);
  output(resolveCodeReviewDepth(input as ResolveCodeReviewDepthInput), raw);
}

function handleFallowBinary(cwd: string, raw: boolean): void {
  const binary = resolveFallowBinary({ cwd });
  output({ binary }, raw, binary ?? '');
}

/** A path argument confined to the project, absolute. */
function projectPathArg(args: readonly string[], name: string, cwd: string, usage: string): string {
  const raw = flagValue(args, name);
  if (raw === null) throw new UsageError(usage);
  const abs = tryWithinRoot(path.resolve(cwd, raw), cwd, PathAcceptance.AbsoluteInsideRoot);
  if (abs === null) throw new UsageError(`--${name} ${JSON.stringify(raw)} is outside the project`);
  return abs;
}

function handleFallowNormalize(args: string[], cwd: string, raw: boolean): void {
  const report = projectPathArg(args, 'report', cwd, USAGE['fallow-normalize']);
  const out = projectPathArg(args, 'out', cwd, USAGE['fallow-normalize']);
  const normalized = normalizeFallowReportFile(report);
  writeTextAtomic(out, JSON.stringify(normalized, null, 2));
  output({ out: rel(cwd, out), summary: normalized.summary }, raw, `${rel(cwd, out)}\n`);
}

/** Which ids of a plans manifest (`- <id>` lines) `review` names, each bounded by neither a word character nor a hyphen. */
export function planCoverage(manifest: string, review: string): { complete: boolean; missing_ids: string[]; total: number } {
  const ids = manifest.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
  const missing = ids.filter((id) => !new RegExp(`(?<![\\w-])${escapeRegex(id)}(?![\\w-])`).test(review));
  return { complete: missing.length === 0, missing_ids: missing, total: ids.length };
}

function handlePlanCoverage(args: string[], cwd: string, raw: boolean): void {
  const manifestArg = flagValue(args, 'manifest');
  const reviewArg = flagValue(args, 'review');
  if (manifestArg === null || reviewArg === null) throw new UsageError(USAGE['plan-coverage']);
  const manifest = readOrNull(path.resolve(cwd, manifestArg));
  if (manifest === null) throw new Unresolvable(`--manifest ${JSON.stringify(manifestArg)} cannot be read`);
  const review = readOrNull(path.resolve(cwd, reviewArg));
  if (review === null) throw new Unresolvable(`--review ${JSON.stringify(reviewArg)} cannot be read`);
  output(planCoverage(manifest, review), raw);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

function routeReviewCommand({ args, cwd, raw, error, _clock, _execGit, _readStdin }: RouteReviewCommandOptions): void {
  const guarded = (run: () => void) => (): void => {
    try {
      run();
    } catch (e) {
      if (e instanceof UsageError) error(`review: ${e.message}`, ERROR_REASON.USAGE);
      else if (e instanceof Unresolvable) error(`review: ${e.message}`, ERROR_REASON.WINDOW_REVIEW_UNRESOLVABLE);
      else throw e;
    }
  };
  routeHubCommandFamily({
    family: 'review',
    args,
    subcommands: [...REVIEW_SUBCOMMANDS],
    handlers: {
      depth: guarded(() => handleDepth(_readStdin ?? (() => fs.readFileSync(0, 'utf-8')), raw)),
      'fallow-binary': guarded(() => handleFallowBinary(cwd, raw)),
      'fallow-normalize': guarded(() => handleFallowNormalize(args, cwd, raw)),
      findings: guarded(() => handleFindings(args, cwd, raw)),
      invocation: guarded(() => handleInvocation(args, raw)),
      'milestone-accept': guarded(() => handleMilestoneAccept(args, cwd, raw, _clock, _execGit)),
      'plan-coverage': guarded(() => handlePlanCoverage(args, cwd, raw)),
      'record-fixed': guarded(() => handleRecordFixed(args, cwd, raw)),
      stage: guarded(() => handleStage(args, cwd, raw, _clock, _execGit)),
      'window-prepass': guarded(() => handlePrepass(args, cwd, raw, _clock)),
      'window-compose': guarded(() => handleCompose(args, cwd, raw, _clock)),
      'window-deferred': guarded(() => handleDeferred(args, cwd, raw)),
      'window-mark': guarded(() => handleMark(args, cwd, raw, _clock)),
      'window-paths': guarded(() => handlePaths(args, cwd, raw)),
    },
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown review subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeReviewCommand };
