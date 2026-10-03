'use strict';
/**
 * Plan command router — `gsd-tools plan <subcommand>`.
 *
 *   plan graph --dir <phase-dir> [--out <file>] [--strict]
 *
 * Draws the phase's plans as a mermaid flowchart from `wave` / `depends_on`
 * (src/plan-graph.cts). Output follows the gsd-tools convention: a JSON result
 * by default; with `--raw`, the markdown document itself — or, when `--out`
 * wrote it to a file, the one-line `OK: …` summary.
 *
 * Paths are user input, so both are confined to the project (`--cwd`): a
 * relative path resolves against it, an absolute one must still lie inside it.
 *
 * Failure mapping (ADR-3889 registry, through io.error's reason → outcome):
 *   - missing `--dir` / a path outside the project → `usage`;
 *   - nothing to look at (no directory, unreadable, no plans) or the file
 *     cannot be written → `phase_not_found` (UNAVAILABLE under exit contract v2);
 *   - `--strict` with defects → the result is printed first, then a generic
 *     failure (exit 1). Without `--strict` defects never fail the process: a
 *     renderer that fails on bad news is a renderer people stop running.
 *
 * Test seam: `_planGraph` replaces the plan-graph module.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planGraph = require('./plan-graph.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { tryWithinRoot, PathAcceptance } from './security.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

export const PLAN_SUBCOMMANDS: readonly string[] = Object.freeze(['graph']);

const GRAPH_USAGE = 'Usage: gsd-tools plan graph --dir <phase-dir> [--out <file>] [--strict]';

interface RoutePlanCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _planGraph?: Pick<typeof planGraph, 'runPlanGraph' | 'summaryLine'>;
}

/** The value after `--name`, or null when the flag is absent or has no value. */
function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return null;
  const v = args[i + 1];
  return v.startsWith('--') ? null : v;
}

function routePlanCommand({ args, cwd, raw, error, _planGraph }: RoutePlanCommandOptions): void {
  const pg = _planGraph ?? planGraph;
  routeHubCommandFamily({
    family: 'plan',
    args,
    subcommands: [...PLAN_SUBCOMMANDS],
    handlers: {
      graph: () => {
        const dirArg = flagValue(args, 'dir');
        if (dirArg === null) {
          error(GRAPH_USAGE, ERROR_REASON.USAGE);
          return;
        }
        const dir = tryWithinRoot(dirArg, cwd, PathAcceptance.AbsoluteInsideRoot);
        if (dir === null) {
          error(`plan graph: --dir ${JSON.stringify(dirArg)} is outside the project`, ERROR_REASON.USAGE);
          return;
        }
        const outArg = flagValue(args, 'out');
        if (args.includes('--out') && outArg === null) {
          error(GRAPH_USAGE, ERROR_REASON.USAGE);
          return;
        }
        let out: string | null = null;
        if (outArg !== null) {
          out = tryWithinRoot(outArg, cwd, PathAcceptance.AbsoluteInsideRoot);
          if (out === null) {
            error(`plan graph: --out ${JSON.stringify(outArg)} is outside the project`, ERROR_REASON.USAGE);
            return;
          }
        }
        const result = pg.runPlanGraph({ dir, out, strict: args.includes('--strict') });
        if (!result.ok) {
          error(`plan graph: cannot look — ${result.message}`, ERROR_REASON.PHASE_NOT_FOUND);
          return;
        }
        const rawValue = result.written !== null ? `${pg.summaryLine(result, outArg as string)}\n` : result.markdown;
        output(result, raw, rawValue);
        if (result.strict_failed) {
          error(`plan graph: ${result.defect_count} defect(s) drawn in red (--strict)`, ERROR_REASON.UNKNOWN);
        }
      },
    },
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown plan subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routePlanCommand };
