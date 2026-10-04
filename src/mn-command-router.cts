'use strict';
/**
 * mn command router — `gsd-tools mn <tool>`, the mn-verify-gate tools that are
 * run by a person or an agent rather than by a loop gate.
 *
 *   mn zod-fieldtable (--file <ts> | --module <specifier> | --json-schema <file>) --export <name>
 *
 * Registered through the capability registry (ADR-959 `commands` in
 * capabilities/mn-verify-gate/capability.json → `commandFamilies.mn`), not by
 * a line in gsd-tools.cjs: that is upstream's extension point for a
 * capability's command family, so the fork adds a family without touching the
 * host dispatch table.
 *
 * Output follows the gsd-tools convention: a JSON result by default; with
 * `--raw`, the markdown document itself.
 *
 * Paths are user input, so every one is confined to the project (`--cwd`): a
 * relative path resolves against it, an absolute one must still lie inside it.
 *
 * Failure mapping (ADR-3889 registry, through io.error's reason → outcome):
 *   - a missing/contradictory flag, a path outside the project, or a name the
 *     schema module does not export → `usage`;
 *   - nothing could be looked at (no runtime, the module would not import,
 *     the file is unreadable) → generic failure, with the precise cause in
 *     the `--json-errors` payload (`cause`).
 *
 * Test seam: `_zodFieldtable` replaces the zod-fieldtable module.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import zodFieldtable = require('./mn-zod-fieldtable.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { tryWithinRoot, PathAcceptance } from './security.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

export const MN_SUBCOMMANDS: readonly string[] = Object.freeze(['zod-fieldtable']);

const ZOD_USAGE =
  'Usage: gsd-tools mn zod-fieldtable (--file <path.ts> | --module <specifier> | --json-schema <file.json>) --export <name>';

type ErrorFn = (message: string, reason?: string, extra?: Record<string, unknown>) => void;

interface RouteMnCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: ErrorFn;
  _zodFieldtable?: Pick<typeof zodFieldtable, 'runZodFieldtable'>;
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

function routeMnCommand(opts: RouteMnCommandOptions): void {
  const { args, cwd, raw, error } = opts;
  routeHubCommandFamily({
    family: 'mn',
    args,
    subcommands: [...MN_SUBCOMMANDS],
    handlers: {
      'zod-fieldtable': () => routeZodFieldtable(opts),
    },
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown mn subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeMnCommand };
