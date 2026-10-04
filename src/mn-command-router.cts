'use strict';
/**
 * mn command router — `gsd-tools mn <tool>`, the mn-verify-gate tools that are
 * run by a person or an agent rather than by a loop gate.
 *
 *   mn zod-fieldtable (--file <ts> | --module <specifier> | --json-schema <file>) --export <name>
 *   mn design-registry (--html <dir|file> | --registry <DESIGN-SYSTEM.md> | --pen <file.pen>) --code <dir>
 *                      [--map <file.json>] [--check [--threshold N]]
 *   mn worktree-gc [--yes] [--older-than <days>]
 *   mn assertion-baseline [--paths "<dir> <dir>…"]
 *
 * Registered through the capability registry (ADR-959 `commands` in
 * capabilities/mn-verify-gate/capability.json → `commandFamilies.mn`), not by
 * a line in gsd-tools.cjs: that is upstream's extension point for a
 * capability's command family, so the fork adds a family without touching the
 * host dispatch table.
 *
 * Output follows the gsd-tools convention: a JSON result by default; with
 * `--raw`, the document itself (markdown, or the worktree-gc report).
 *
 * Paths are user input, so every one is confined to the project (`--cwd`): a
 * relative path resolves against it, an absolute one must still lie inside it.
 * `assertion-baseline` walks the REPOSITORY (a project may sit in a monorepo
 * sub-directory), so its `--paths` are confined to the repository root.
 *
 * Failure mapping (ADR-3889 registry, through io.error's reason → outcome):
 *   - a missing/contradictory flag, a path outside the project, a name the
 *     schema module does not export, a `--map` naming absent symbols →
 *     `usage`;
 *   - nothing could be looked at (no runtime, the module would not import, a
 *     file is unreadable, not a repository, no spec files) → generic failure,
 *     with the precise cause in the `--json-errors` payload (`cause`);
 *   - `design-registry --check` with components unimplemented beyond the
 *     threshold → the result is printed first, then a generic failure. Without
 *     `--check` nothing fails on findings: a reporter that fails on bad news
 *     is a reporter people stop running.
 *
 * Test seams: `_zodFieldtable`, `_designRegistry`, `_worktreeGc`,
 * `_assertionCount` replace the tool modules.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import zodFieldtable = require('./mn-zod-fieldtable.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import designRegistry = require('./mn-design-registry.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeGc = require('./mn-worktree-gc.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import assertionCount = require('./mn-assertion-count.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { tryWithinRoot, PathAcceptance } from './security.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

export const MN_SUBCOMMANDS: readonly string[] = Object.freeze(['zod-fieldtable', 'design-registry', 'worktree-gc', 'assertion-baseline']);

const ZOD_USAGE =
  'Usage: gsd-tools mn zod-fieldtable (--file <path.ts> | --module <specifier> | --json-schema <file.json>) --export <name>';
const REGISTRY_USAGE =
  'Usage: gsd-tools mn design-registry (--html <dir|file> | --registry <DESIGN-SYSTEM.md> | --pen <file.pen>) --code <dir> [--map <file.json>] [--check [--threshold N]]';
const GC_USAGE = 'Usage: gsd-tools mn worktree-gc [--yes] [--older-than <days>]';
const BASELINE_USAGE = 'Usage: gsd-tools mn assertion-baseline [--paths "<dir> <dir>…"]';

type ErrorFn = (message: string, reason?: string, extra?: Record<string, unknown>) => void;

interface RouteMnCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: ErrorFn;
  _zodFieldtable?: Pick<typeof zodFieldtable, 'runZodFieldtable'>;
  _designRegistry?: Pick<typeof designRegistry, 'runDesignRegistry'>;
  _worktreeGc?: Pick<typeof worktreeGc, 'runWorktreeGc'>;
  _assertionCount?: Pick<typeof assertionCount, 'resolveRepoRoot' | 'recordAssertionBaseline'>;
}

/** A non-negative integer flag value, or null when it is not one. */
function nonNegativeInt(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** The value after `--name`, or null when the flag is absent or has no value. */
function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return null;
  const v = args[i + 1];
  return v.startsWith('--') ? null : v;
}

/** A flag given without a value is a usage error, not an absent flag. */
function danglingFlag(args: string[], names: readonly string[]): string | null {
  return names.find((n) => args.includes(`--${n}`) && flagValue(args, n) === null) ?? null;
}

/** Reasons that mean "the caller named something wrong", as opposed to "could not look". */
const ZOD_USAGE_REASONS: ReadonlySet<string> = new Set(['no_export', 'not_an_object_or_enum', 'bad_json']);

function routeZodFieldtable(opts: RouteMnCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  const zf = opts._zodFieldtable ?? zodFieldtable;
  const dangling = danglingFlag(args, ['file', 'module', 'json-schema', 'export']);
  const exportName = flagValue(args, 'export');
  const given = (['file', 'module', 'json-schema'] as const).filter((n) => flagValue(args, n) !== null);
  if (dangling !== null || exportName === null || given.length !== 1) {
    error(ZOD_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const kind = given[0];
  const value = flagValue(args, kind) as string;
  let source: zodFieldtable.ZodFieldtableSource;
  if (kind === 'module') {
    source = { kind: 'module', target: value };
  } else {
    const resolved = tryWithinRoot(value, cwd, PathAcceptance.AbsoluteInsideRoot);
    if (resolved === null) {
      error(`mn zod-fieldtable: --${kind} ${JSON.stringify(value)} is outside the project`, ERROR_REASON.USAGE);
      return;
    }
    source = kind === 'file' ? { kind: 'file', target: resolved } : { kind: 'json-schema', path: resolved };
  }
  const result = zf.runZodFieldtable({ cwd, source, exportName });
  if (!result.ok) {
    const hint = result.available && result.available.length > 0 ? ` (available: ${result.available.join(', ')})` : '';
    error(
      `mn zod-fieldtable: ${result.message}${hint}`,
      ZOD_USAGE_REASONS.has(result.reason) ? ERROR_REASON.USAGE : ERROR_REASON.UNKNOWN,
      { cause: result.reason },
    );
    return;
  }
  output(result, raw, result.markdown);
}

function routeDesignRegistry(opts: RouteMnCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  const dr = opts._designRegistry ?? designRegistry;
  const dangling = danglingFlag(args, ['html', 'registry', 'pen', 'code', 'map', 'threshold']);
  const modes = (['html', 'registry', 'pen'] as const).filter((n) => flagValue(args, n) !== null);
  const codeArg = flagValue(args, 'code');
  const thresholdArg = flagValue(args, 'threshold');
  const threshold = thresholdArg === null ? 0 : nonNegativeInt(thresholdArg);
  if (dangling !== null || modes.length !== 1 || codeArg === null || threshold === null) {
    error(REGISTRY_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const confine = (flag: string, value: string): string | null => {
    const resolved = tryWithinRoot(value, cwd, PathAcceptance.AbsoluteInsideRoot);
    if (resolved === null) error(`mn design-registry: --${flag} ${JSON.stringify(value)} is outside the project`, ERROR_REASON.USAGE);
    return resolved;
  };
  const mode = modes[0];
  const input = confine(mode, flagValue(args, mode) as string);
  if (input === null) return;
  const code = confine('code', codeArg);
  if (code === null) return;
  const mapArg = flagValue(args, 'map');
  const map = mapArg === null ? null : confine('map', mapArg);
  if (mapArg !== null && map === null) return;
  const result = dr.runDesignRegistry({ cwd, source: { mode, path: input }, code, map, check: args.includes('--check'), threshold });
  if (!result.ok) {
    const hint = result.hint ? `\n${result.hint}` : '';
    error(`mn design-registry: ${result.message}${hint}`, result.reason === 'bad_map' ? ERROR_REASON.USAGE : ERROR_REASON.UNKNOWN, {
      cause: result.reason,
    });
    return;
  }
  output(result, raw, result.markdown);
  if (result.check_failed !== null) {
    error(
      `mn design-registry: ${result.check_failed.message}`,
      result.check_failed.reason === 'map_broken' ? ERROR_REASON.USAGE : ERROR_REASON.UNKNOWN,
      { cause: result.check_failed.reason },
    );
  }
}

function routeWorktreeGc(opts: RouteMnCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  const gc = opts._worktreeGc ?? worktreeGc;
  const olderArg = flagValue(args, 'older-than');
  const olderThanDays = olderArg === null ? 0 : nonNegativeInt(olderArg);
  if (danglingFlag(args, ['older-than']) !== null || olderThanDays === null) {
    error(GC_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const result = gc.runWorktreeGc({ cwd, apply: args.includes('--yes'), olderThanDays });
  if (!result.ok) {
    error(`mn worktree-gc: ${result.message}`, ERROR_REASON.UNKNOWN, { cause: result.reason });
    return;
  }
  output(result, raw, result.report);
}

function routeAssertionBaseline(opts: RouteMnCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  const ac = opts._assertionCount ?? assertionCount;
  if (danglingFlag(args, ['paths']) !== null) {
    error(BASELINE_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const repoRoot = ac.resolveRepoRoot(cwd);
  const pathsArg = flagValue(args, 'paths');
  const rels = pathsArg === null ? [...assertionCount.DEFAULT_ROOTS] : pathsArg.split(/\s+/).filter(Boolean);
  if (rels.length === 0) {
    error(BASELINE_USAGE, ERROR_REASON.USAGE);
    return;
  }
  const roots: string[] = [];
  for (const rel of rels) {
    const resolved = tryWithinRoot(rel, repoRoot, PathAcceptance.AbsoluteInsideRoot);
    if (resolved === null) {
      error(`mn assertion-baseline: --paths entry ${JSON.stringify(rel)} is outside the repository`, ERROR_REASON.USAGE);
      return;
    }
    roots.push(resolved);
  }
  const result = ac.recordAssertionBaseline({ repoRoot, roots });
  if (!result.ok) {
    error(`mn assertion-baseline: ${result.message}`, ERROR_REASON.UNKNOWN, { cause: result.reason });
    return;
  }
  const b = result.baseline;
  output(result, raw, `baseline written: ${b.assertions} assertions, ${b.skipped} skipped, across ${b.files} spec files\n`);
}

function routeMnCommand(opts: RouteMnCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  routeHubCommandFamily({
    family: 'mn',
    args,
    subcommands: [...MN_SUBCOMMANDS],
    handlers: {
      'zod-fieldtable': () => routeZodFieldtable(opts),
      'design-registry': () => routeDesignRegistry(opts),
      'worktree-gc': () => routeWorktreeGc(opts),
      'assertion-baseline': () => routeAssertionBaseline(opts),
    },
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown mn subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeMnCommand };
