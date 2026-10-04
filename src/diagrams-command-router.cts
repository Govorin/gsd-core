'use strict';
/**
 * Diagrams command router — `gsd-tools diagrams <subcommand>`.
 *
 *   diagrams check --file <md> [--root <dir>] [--mode docs|design] [--strict]
 *
 * Checks every mermaid block of one markdown document (src/diagrams-check.cts):
 * the block keeps to the subset the builders express, and each identifier it
 * claims is declared in the code under `--root` (default: the project). The
 * mode defaults from the file name — `*DESIGN.md` is `design`, where names
 * the document itself introduces count as planned.
 *
 * Output follows the gsd-tools convention: a JSON result by default; with
 * `--raw`, a header line plus one line per finding.
 *
 * Failure mapping (ADR-3889 registry, through io.error's reason → outcome):
 *   - missing `--file`, a bad `--mode`, a path outside the project → `usage`;
 *   - the file cannot be read or the root is not a directory → `phase_not_found`
 *     (UNAVAILABLE under exit contract v2: nothing to look at);
 *   - `--strict` with a BLOCKER finding → the result is printed first, then a
 *     generic failure (exit 1). Without `--strict` findings never fail the
 *     process; callers (gsd-doc-verifier, the architecture gate) read
 *     `blocker_count`.
 *
 * Test seam: `_diagramsCheck` replaces the check module.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import diagramsCheck = require('./diagrams-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { buildProjectSymbolIndex } from './symbol-index.cjs';

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

export const DIAGRAMS_SUBCOMMANDS: readonly string[] = Object.freeze(['check']);

const CHECK_USAGE = 'Usage: gsd-tools diagrams check --file <md> [--root <dir>] [--mode docs|design] [--strict]';

interface RouteDiagramsCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _diagramsCheck?: Pick<typeof diagramsCheck, 'runDiagramsCheck' | 'summaryText'>;
}

/** The value after `--name`; null when absent; `undefined` when present without a value. */
function flagValue(args: string[], name: string): string | null | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

function routeDiagramsCommand({ args, cwd, raw, error, _diagramsCheck }: RouteDiagramsCommandOptions): void {
  const dc = _diagramsCheck ?? diagramsCheck;
  routeHubCommandFamily({
    family: 'diagrams',
    args,
    subcommands: [...DIAGRAMS_SUBCOMMANDS],
    handlers: {
      check: () => {
        const fileArg = flagValue(args, 'file');
        const rootArg = flagValue(args, 'root');
        const modeArg = flagValue(args, 'mode');
        if (typeof fileArg !== 'string' || rootArg === undefined || modeArg === undefined) {
          error(CHECK_USAGE, ERROR_REASON.USAGE);
          return;
        }
        if (modeArg !== null && modeArg !== 'docs' && modeArg !== 'design') {
          error(`diagrams check: --mode must be docs or design, got ${JSON.stringify(modeArg)}`, ERROR_REASON.USAGE);
          return;
        }
        const file = tryWithinRoot(fileArg, cwd, PathAcceptance.AbsoluteInsideRoot);
        if (file === null) {
          error(`diagrams check: --file ${JSON.stringify(fileArg)} is outside the project`, ERROR_REASON.USAGE);
          return;
        }
        let root: string = cwd;
        if (rootArg !== null) {
          const r = tryWithinRoot(rootArg, cwd, PathAcceptance.AbsoluteInsideRoot);
          if (r === null) {
            error(`diagrams check: --root ${JSON.stringify(rootArg)} is outside the project`, ERROR_REASON.USAGE);
            return;
          }
          root = r;
        }
        const result = dc.runDiagramsCheck({
          file,
          root,
          // Identifiers are looked up across the whole repository, not only under the project
          // directory: a monorepo sub-project's code lives beside it (review M6).
          buildIndex: buildProjectSymbolIndex,
          strict: args.includes('--strict'),
          ...(modeArg !== null ? { mode: modeArg } : {}),
        });
        if (!result.ok) {
          error(`diagrams check: cannot look — ${result.message}`, ERROR_REASON.DIAGRAMS_SOURCE_UNAVAILABLE);
          return;
        }
        output(result, raw, `${dc.summaryText(result)}\n`);
        if (result.strict_failed) {
          error(`diagrams check: ${result.blocker_count} blocker finding(s) (--strict)`, ERROR_REASON.UNKNOWN);
        }
      },
    },
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown diagrams subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeDiagramsCommand };
