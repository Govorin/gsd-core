'use strict';
/**
 * requirements-review command router — `gsd-tools requirements-review <sub>`, the deterministic
 * half of /gsd:requirements-review (capability mn-requirements-review, ADR-5212).
 *
 *   requirements-review prepare [--milestone <v>] [--lens data,compat,security,testability]
 *     (no --milestone → STATE.md's milestone; --lens over a run of the same requirements re-runs
 *     only those lenses and keeps the other reports)
 *   requirements-review compose
 *   requirements-review accept <CR-ID>... --reason "<why>"
 *
 * Registered through the capability registry (ADR-959 `commands` in
 * capabilities/mn-requirements-review/capability.json → `commandFamilies['requirements-review']`),
 * not by a line in gsd-tools.cjs. The planning directory is the active workstream's (`--ws`).
 *
 * Output: a JSON result. Failure mapping (ADR-3889, through io.error's reason):
 *   - a missing/unknown flag or lens, an ID that is not a critical finding of the review, an
 *     acceptance without a reason → `usage`;
 *   - nothing to work on (no REQUIREMENTS.md, no prepared run, no composed review) or a journal that
 *     cannot be read → generic failure, the precise cause in `--json-errors` (`cause`).
 *
 * The gate verdict is not here: `gsd_run check mn-requirements-review` reads what these write.
 */

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
import gapCheckerMod = require('./gap-checker.cjs');
import { prepareReview, composeReviewFiles, acceptFindings, parseLenses, REQUIREMENTS_REVIEW_LENSES } from './requirements-review.cjs';
import type { ReviewFailure } from './requirements-review.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { planningDir } = planningWorkspaceMod;
const { parseRequirements } = gapCheckerMod;

export const REQUIREMENTS_REVIEW_SUBCOMMANDS: readonly string[] = Object.freeze(['prepare', 'compose', 'accept']);

const PREPARE_USAGE = `Usage: gsd-tools requirements-review prepare [--milestone <version>] [--lens ${REQUIREMENTS_REVIEW_LENSES.join(',')}]`;
const COMPOSE_USAGE = 'Usage: gsd-tools requirements-review compose';
const ACCEPT_USAGE = 'Usage: gsd-tools requirements-review accept <CR-ID>... --reason "<why>"';

/** The default lenses: `workflow.requirements_review_lenses`, as the capability declares it. */
export const LENSES_CONFIG_KEY = 'workflow.requirements_review_lenses';

type ErrorFn = (message: string, reason?: string, extra?: Record<string, unknown>) => void;

interface RouteOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: ErrorFn;
  /** Test seam: the clock every written timestamp comes from. */
  _now?: () => Date;
}

/** The value after `--name`, or null when the flag is absent or has no value. */
function flagValue(args: readonly string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return null;
  const v = args[i + 1];
  return v.startsWith('--') ? null : v;
}

/** A flag given without a value is a usage error, not an absent flag. */
function danglingFlag(args: readonly string[], names: readonly string[]): string | null {
  return names.find((n) => args.includes(`--${n}`) && flagValue(args, n) === null) ?? null;
}

/** Flags this subcommand does not know: a typo must fail, not be ignored. */
function unknownFlags(args: readonly string[], known: readonly string[]): string[] {
  return args.filter((a) => a.startsWith('--') && !known.includes(a.slice(2)));
}

function fail(error: ErrorFn, failure: ReviewFailure): void {
  const usage = failure.reason === 'unknown-id' || failure.reason === 'not-critical' || failure.reason === 'no-reason';
  error(`requirements-review: ${failure.message}`, usage ? ERROR_REASON.USAGE : ERROR_REASON.UNKNOWN, { cause: failure.reason });
}

function configuredLenses(cwd: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;
  const config = loadConfig(cwd);
  return resolveConfigKey(LENSES_CONFIG_KEY, { config, cwd, registry, quiet: true }).value;
}

function routePrepare(opts: RouteOptions): void {
  const { args, cwd, raw, error } = opts;
  const rest = args.slice(2);
  if (danglingFlag(rest, ['milestone', 'lens']) !== null || unknownFlags(rest, ['milestone', 'lens']).length > 0) {
    error(PREPARE_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const lensArg = flagValue(rest, 'lens');
  const lenses = parseLenses(lensArg ?? configuredLenses(cwd) ?? REQUIREMENTS_REVIEW_LENSES.join(','));
  if (!lenses.ok) {
    error(`requirements-review prepare: ${lensArg === null ? `${LENSES_CONFIG_KEY}: ` : '--lens: '}${lenses.message}`, ERROR_REASON.USAGE);
    return;
  }
  const result = prepareReview({
    planning: planningDir(cwd),
    cwd,
    milestone: flagValue(rest, 'milestone'),
    lenses: lenses.lenses,
    lensesExplicit: lensArg !== null,
    requirements: (text) => parseRequirements(text).map((r) => ({ id: r.id, text: r.text })),
    now: opts._now ?? (() => new Date()),
  });
  if (!result.ok) {
    fail(error, result);
    return;
  }
  output(result, raw);
}

function routeCompose(opts: RouteOptions): void {
  const { args, cwd, raw, error } = opts;
  if (args.length > 2) {
    error(COMPOSE_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const result = composeReviewFiles(planningDir(cwd), cwd, opts._now ?? (() => new Date()));
  if (!result.ok) {
    fail(error, result);
    return;
  }
  output(result, raw);
}

function routeAccept(opts: RouteOptions): void {
  const { args, cwd, raw, error } = opts;
  const rest = args.slice(2);
  const reasonIdx = rest.indexOf('--reason');
  if (danglingFlag(rest, ['reason']) !== null || unknownFlags(rest, ['reason']).length > 0) {
    error(ACCEPT_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const ids = rest.filter((a, i) => !a.startsWith('--') && !(reasonIdx !== -1 && i === reasonIdx + 1));
  if (ids.length === 0 || ids.some((id) => !/^CR-\d+$/.test(id))) {
    error(`${ACCEPT_USAGE} — name the critical findings by their REQUIREMENTS-REVIEW.md IDs (CR-01, …)`, ERROR_REASON.USAGE);
    return;
  }
  const result = acceptFindings({
    planning: planningDir(cwd),
    cwd,
    ids,
    reason: flagValue(rest, 'reason') ?? '',
    now: opts._now ?? (() => new Date()),
  });
  if (!result.ok) {
    fail(error, result);
    return;
  }
  output(result, raw);
}

function routeRequirementsReviewCommand(opts: RouteOptions): void {
  const { args, cwd, raw, error } = opts;
  routeHubCommandFamily({
    family: 'requirements-review',
    args,
    subcommands: [...REQUIREMENTS_REVIEW_SUBCOMMANDS],
    handlers: {
      prepare: () => { routePrepare(opts); },
      compose: () => { routeCompose(opts); },
      accept: () => { routeAccept(opts); },
    },
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown requirements-review subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeRequirementsReviewCommand };
