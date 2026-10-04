'use strict';
/**
 * Discuss command router — `gsd-tools discuss <subcommand>`.
 *
 *   discuss tree --file <checkpoint.json|CONTEXT.md> [--out <file>] [--strict]
 *
 * The decisions of a discuss-phase session as a dependency tree
 * (src/decision-tree.cts): the next question grill mode asks, the frontier,
 * what is blocked and what lies past `workflow.max_discuss_passes`, and the
 * mermaid picture. Output follows the gsd-tools convention: a JSON result by
 * default; with `--raw`, the markdown document itself — or, when `--out` wrote
 * it to a file, the one-line `OK: …` summary.
 *
 * Paths are user input, so both are confined to the project (`--cwd`): a
 * relative path resolves against it, an absolute one must still lie inside it.
 *
 * Failure mapping (ADR-3889 registry, through io.error's reason → outcome):
 *   - missing `--file` / a path outside the project → `usage`;
 *   - nothing to look at (no file, unreadable, no tree in it) or the output
 *     cannot be written → `phase_not_found` (UNAVAILABLE under exit contract v2);
 *   - `--strict` with defects → the result is printed first, then a generic
 *     failure (exit 1). Without `--strict` defects never fail the process — the
 *     grill loop reads them from the JSON and repairs the tree.
 *
 * Test seam: `_decisionTree` replaces the decision-tree module.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import decisionTree = require('./decision-tree.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { tryWithinRoot, PathAcceptance } from './security.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

export const DISCUSS_SUBCOMMANDS: readonly string[] = Object.freeze(['tree']);

const TREE_USAGE = 'Usage: gsd-tools discuss tree --file <checkpoint.json|CONTEXT.md> [--out <file>] [--strict]';

interface RouteDiscussCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _decisionTree?: Pick<typeof decisionTree, 'runDecisionTree' | 'summaryLine' | 'readMaxDiscussPasses'>;
}

/** The value after `--name`, or null when the flag is absent or has no value. */
function flagValue(args: string[], name: string): string | null {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return null;
  const v = args[i + 1];
  return v.startsWith('--') ? null : v;
}

function routeDiscussCommand({ args, cwd, raw, error, _decisionTree }: RouteDiscussCommandOptions): void {
  const dt = _decisionTree ?? decisionTree;
  routeHubCommandFamily({
    family: 'discuss',
    args,
    subcommands: [...DISCUSS_SUBCOMMANDS],
    handlers: {
      tree: () => {
        const fileArg = flagValue(args, 'file');
        if (fileArg === null) {
          error(TREE_USAGE, ERROR_REASON.USAGE);
          return;
        }
        const file = tryWithinRoot(fileArg, cwd, PathAcceptance.AbsoluteInsideRoot);
        if (file === null) {
          error(`discuss tree: --file ${JSON.stringify(fileArg)} is outside the project`, ERROR_REASON.USAGE);
          return;
        }
        const outArg = flagValue(args, 'out');
        if (args.includes('--out') && outArg === null) {
          error(TREE_USAGE, ERROR_REASON.USAGE);
          return;
        }
        let out: string | null = null;
        if (outArg !== null) {
          out = tryWithinRoot(outArg, cwd, PathAcceptance.AbsoluteInsideRoot);
          if (out === null) {
            error(`discuss tree: --out ${JSON.stringify(outArg)} is outside the project`, ERROR_REASON.USAGE);
            return;
          }
        }
        const result = dt.runDecisionTree({
          file,
          out,
          strict: args.includes('--strict'),
          maxPasses: dt.readMaxDiscussPasses(cwd),
        });
        if (!result.ok) {
          error(`discuss tree: cannot look — ${result.message}`, ERROR_REASON.PHASE_NOT_FOUND);
          return;
        }
        const rawValue = result.written !== null ? `${dt.summaryLine(result, outArg as string)}\n` : result.markdown;
        output(result, raw, rawValue);
        if (result.strict_failed) {
          error(`discuss tree: ${result.defect_count} defect(s) in the decision tree (--strict)`, ERROR_REASON.UNKNOWN);
        }
      },
    },
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown discuss subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeDiscussCommand };
