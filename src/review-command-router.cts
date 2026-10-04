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
 * A milestone-boundary stage reviews the milestone's range through the same entry point:
 * `review window-prepass --since last` (or `--since <previous milestone tag>`).
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
import { CODE_REVIEW_LENSES } from './code-review-flags.cjs';
import type { CodeReviewLens } from './code-review-flags.cjs';
import {
  computeWindowPrepass, composeWindowReview, deferredWindowEntries, fixedWindowEntryIds, reviewMatchesWindow, windowMarkerFor, writeTextAtomic,
  REVIEWS_DIR, WINDOW_FILES,
} from './window-review.cjs';
import type { WindowPrepass } from './window-review.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { planningDir } = planningWorkspaceMod;

export const REVIEW_SUBCOMMANDS: readonly string[] = Object.freeze([
  'window-compose', 'window-deferred', 'window-mark', 'window-paths', 'window-prepass',
]);

const USAGE = Object.freeze({
  'window-prepass': 'Usage: gsd-tools review window-prepass --since <7d|YYYY-MM-DD|ref|last> [--until <ref>] [--lens a,b] [--date YYYY-MM-DD] [--max-files N] [--batch-size N]',
  'window-compose': 'Usage: gsd-tools review window-compose --dir <window dir>',
  'window-deferred': 'Usage: gsd-tools review window-deferred --dir <window dir> [--raw]',
  'window-mark': 'Usage: gsd-tools review window-mark --dir <window dir>',
  'window-paths': 'Usage: gsd-tools review window-paths --review <window REVIEW.md>',
});

interface RouteReviewCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  /** Test seam: the clock `--since 7d` and the window date are measured from. */
  _clock?: { now(): number };
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

function handlePaths(args: string[], cwd: string, raw: boolean): void {
  const reviewArg = flagValue(args, 'review');
  if (reviewArg === null) throw new UsageError(USAGE['window-paths']);
  const reviews = path.join(planningDir(cwd), REVIEWS_DIR);
  const abs = tryWithinRoot(path.resolve(cwd, reviewArg), reviews, PathAcceptance.AbsoluteInsideRoot);
  if (abs === null || path.basename(abs) !== WINDOW_FILES.review || path.dirname(abs) === path.resolve(reviews)) {
    throw new UsageError(`--review ${JSON.stringify(reviewArg)} is not a window ${WINDOW_FILES.review} under ${REVIEWS_DIR}/<window>/`);
  }
  if (!fs.existsSync(abs)) throw new Unresolvable(`${rel(cwd, abs)} does not exist — run /gsd-code-review --since first`);
  const dir = path.dirname(abs);
  output({
    review: rel(cwd, abs),
    fixReport: rel(cwd, path.join(dir, WINDOW_FILES.fixReport)),
    dir: rel(cwd, dir),
    label: path.basename(dir),
  }, raw, `${rel(cwd, abs)}\n`);
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

function routeReviewCommand({ args, cwd, raw, error, _clock }: RouteReviewCommandOptions): void {
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
