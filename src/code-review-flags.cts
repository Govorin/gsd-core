/**
 * Typed flag parser for the /gsd:code-review command (ADR-457 build-at-publish:
 * the hand-written bin/lib/code-review-flags.cjs collapsed to a TypeScript
 * source of truth). Behaviour is preserved byte-for-behaviour from the prior
 * hand-written .cjs; only types are added.
 *
 * This is the canonical IR for code-review argument parsing. The workflow
 * (code-review.md) delegates flag dispatch to this module so that tests assert
 * on a structured IR rather than rendered bash text, and the dispatch decision
 * is testable without instantiating the workflow.
 *
 * Window review (ADR-5208): `--since <7d|YYYY-MM-DD|ref|last> [--until <ref>]
 * [--lens a,b]` reviews the work that landed in a period instead of one phase.
 * `parseCodeReviewFlags` stays permissive (unknown flags ignored, nothing
 * rejected); `resolveCodeReviewInvocation` is the validating entry point that
 * decides phase-or-window and refuses an ambiguous or malformed invocation
 * with a usage error carrying its ADR-3889 registry exit code.
 */

import { parseWindowSince, isSafeRefArgument } from './gate-evaluation-scope.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import exitCodeRegistryModule = require('./exit-code-registry.cjs');

/** The window-review lenses, each run by its own agent (ADR-5208). */
export const CODE_REVIEW_LENSES = Object.freeze(['correctness', 'standards', 'spec', 'simplify'] as const);
export type CodeReviewLens = (typeof CODE_REVIEW_LENSES)[number];

/** Parsed code-review flags. `--all` and `--auto` both imply `--fix`. */
export interface CodeReviewFlags {
  /** true when --fix is present (or implied by --all/--auto) */
  fix: boolean;
  /** true when --all is present (implies fix) */
  all: boolean;
  /** true when --auto is present (implies fix) */
  auto: boolean;
  /** --depth override value, or '' if not supplied */
  depth: string;
  /** --files override value, or '' if not supplied */
  files: string;
  /** The first positional argument (the phase), or '' if none */
  phase: string;
  /** --since window start, or '' if not supplied */
  since: string;
  /** --until window tip, or '' if not supplied */
  until: string;
  /** --lens entries in the order given, duplicates dropped; [] if not supplied */
  lens: string[];
}

/** Workflow filename the orchestrator should load. */
export type CodeReviewWorkflow = 'code-review.md' | 'code-review-fix.md';

/**
 * Flags that take a value, as `--flag=value` or `--flag value`. `--ws` is listed only so its value
 * is not mistaken for the phase; the workflow resolves the workstream itself.
 */
const VALUE_FLAGS = new Set(['--depth', '--files', '--since', '--until', '--lens', '--ws']);

interface Tokenized {
  flags: CodeReviewFlags;
  /** Value flags that appeared without a value. */
  missingValues: string[];
}

function tokenize(argv: readonly string[]): Tokenized {
  const flags: CodeReviewFlags = {
    fix: false,
    all: false,
    auto: false,
    depth: '',
    files: '',
    phase: '',
    since: '',
    until: '',
    lens: [],
  };
  const missingValues: string[] = [];
  const values = new Map<string, string>();
  let phaseSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--fix') {
      flags.fix = true;
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--auto') {
      flags.auto = true;
    } else if (arg.startsWith('--') && arg.includes('=') && VALUE_FLAGS.has(arg.slice(0, arg.indexOf('=')))) {
      values.set(arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1));
    } else if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        missingValues.push(arg);
      } else {
        values.set(arg, next);
        i += 1;
      }
    } else if (!arg.startsWith('-') && !phaseSeen) {
      flags.phase = arg;
      phaseSeen = true;
    }
  }

  flags.depth = values.get('--depth') ?? '';
  flags.files = values.get('--files') ?? '';
  flags.since = values.get('--since') ?? '';
  flags.until = values.get('--until') ?? '';
  flags.lens = [...new Set((values.get('--lens') ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0))];

  // --all and --auto imply --fix
  if (flags.all || flags.auto) {
    flags.fix = true;
  }

  return { flags, missingValues };
}

/**
 * Parse code-review flags from an argv array. The first positional argument
 * is reported as `phase` but not validated — phase validation is handled by
 * `gsd-tools query init.phase-op`. Unknown flags are silently ignored.
 */
export function parseCodeReviewFlags(argv: string[]): CodeReviewFlags {
  return tokenize(argv).flags;
}

/**
 * Determine which workflow to dispatch based on parsed flags:
 *  - 'code-review-fix.md' when fix=true (--fix, --all, or --auto present)
 *  - 'code-review.md'     otherwise (review-only pass)
 */
export function resolveCodeReviewWorkflow(flags: CodeReviewFlags): CodeReviewWorkflow {
  return flags.fix ? 'code-review-fix.md' : 'code-review.md';
}

// ─── Validated invocation: phase or window ────────────────────────────────────

/** Why an invocation was refused. Adding a member means adding the emitting branch and its test. */
export const CODE_REVIEW_USAGE = Object.freeze({
  MISSING_VALUE: 'missing-value',
  PHASE_AND_SINCE: 'phase-and-since',
  PHASE_OR_SINCE_REQUIRED: 'phase-or-since-required',
  INVALID_SINCE: 'invalid-since',
  UNTIL_WITHOUT_SINCE: 'until-without-since',
  INVALID_UNTIL: 'invalid-until',
  LENS_WITHOUT_SINCE: 'lens-without-since',
  UNKNOWN_LENS: 'unknown-lens',
  FILES_AND_SINCE: 'files-and-since',
} as const);
export type CodeReviewUsageCode = (typeof CODE_REVIEW_USAGE)[keyof typeof CODE_REVIEW_USAGE];

/** The registered exit-code name every refusal carries (ADR-3889: bad argv is the caller's error). */
const USAGE_EXIT = 'USAGE';

export interface CodeReviewUsageError {
  ok: false;
  code: CodeReviewUsageCode;
  message: string;
  exit: typeof USAGE_EXIT;
  /** `exit`'s number from the ADR-3889 registry — what the caller's process must exit with. */
  exitCode: number;
}

export type CodeReviewInvocation =
  | { ok: true; mode: 'phase'; phase: string; flags: CodeReviewFlags }
  | {
    ok: true;
    mode: 'window';
    since: string;
    /** The window tip; `HEAD` when `--until` is absent. */
    until: string;
    /** Lenses to run, in the order given; [] means "the configured default set". */
    lenses: CodeReviewLens[];
    flags: CodeReviewFlags;
  }
  | CodeReviewUsageError;

function refuse(code: CodeReviewUsageCode, message: string): CodeReviewUsageError {
  return { ok: false, code, message: `code-review: ${message}`, exit: USAGE_EXIT, exitCode: exitCodeRegistryModule.exitCodeFor(USAGE_EXIT) };
}

function isLens(value: string): value is CodeReviewLens {
  return (CODE_REVIEW_LENSES as readonly string[]).includes(value);
}

/**
 * Decide what a code-review invocation reviews. A phase and `--since` together are refused, never
 * resolved by a silent precedence; so are `--files` with `--since` (two scopes), `--until` or
 * `--lens` without `--since` (window-only), a malformed `--since`/`--until`, an unknown lens, and
 * a value flag with no value. Whether `--since last` has a recorded tip to start from is the scope
 * resolver's answer (`no-last-window-marker`), not argv's.
 */
export function resolveCodeReviewInvocation(argv: string[]): CodeReviewInvocation {
  const { flags, missingValues } = tokenize(argv);
  const [missing] = missingValues;
  if (missing !== undefined) return refuse(CODE_REVIEW_USAGE.MISSING_VALUE, `${missing} requires a value`);

  if (flags.since === '') {
    if (flags.until !== '') return refuse(CODE_REVIEW_USAGE.UNTIL_WITHOUT_SINCE, '--until applies only to a window review; add --since');
    if (flags.lens.length > 0) return refuse(CODE_REVIEW_USAGE.LENS_WITHOUT_SINCE, '--lens applies only to a window review; add --since');
    if (flags.phase === '') return refuse(CODE_REVIEW_USAGE.PHASE_OR_SINCE_REQUIRED, 'a phase number or --since <7d|YYYY-MM-DD|ref|last> is required');
    return { ok: true, mode: 'phase', phase: flags.phase, flags };
  }

  if (flags.phase !== '') {
    return refuse(CODE_REVIEW_USAGE.PHASE_AND_SINCE, `review either phase ${flags.phase} or the window --since ${flags.since}, not both`);
  }
  if (flags.files !== '') return refuse(CODE_REVIEW_USAGE.FILES_AND_SINCE, '--files and --since each choose the scope; pass one');
  if (parseWindowSince(flags.since) === null) {
    return refuse(CODE_REVIEW_USAGE.INVALID_SINCE, `--since must be last, a duration (7d, 12h, 2w), a date (YYYY-MM-DD, UTC) or a ref, got: ${flags.since}`);
  }
  if (flags.until !== '' && !isSafeRefArgument(flags.until)) {
    return refuse(CODE_REVIEW_USAGE.INVALID_UNTIL, `--until must be a git ref, got: ${flags.until}`);
  }
  const unknown = flags.lens.filter((lens) => !isLens(lens));
  if (unknown.length > 0) {
    return refuse(CODE_REVIEW_USAGE.UNKNOWN_LENS, `unknown --lens ${unknown.join(', ')}; expected any of ${CODE_REVIEW_LENSES.join(', ')}`);
  }
  return {
    ok: true,
    mode: 'window',
    since: flags.since,
    until: flags.until === '' ? 'HEAD' : flags.until,
    lenses: flags.lens.filter(isLens),
    flags,
  };
}
