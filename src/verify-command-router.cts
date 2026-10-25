/**
 * Manifest-backed verify subcommand router.
 * Keeps gsd-tools.cjs thin while preserving existing command semantics.
 *
 * ADR-457 build-at-publish: the hand-written bin/lib/verify-command-router.cjs
 * collapsed to a TypeScript source of truth. Behaviour is preserved byte-for-behaviour
 * from the prior hand-written .cjs; only types are added.
 */

import { VERIFY_SUBCOMMANDS } from './command-aliases.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
const { routeCjsCommandFamily } = cjsCommandRouterAdapter;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import checkCommandRouter = require('./check-command-router.cjs');
const { routeCheckCommand } = checkCommandRouter;

// ─── Types ────────────────────────────────────────────────────────────────────

interface VerifyModule {
  cmdVerifyPlanStructure(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdVerifyPhaseCompleteness(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdVerifyReferences(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdVerifyCommits(cwd: string, args: string[], raw: boolean): void;
  cmdVerifyArtifacts(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdVerifyKeyLinks(cwd: string, phase: string | undefined, raw: boolean): void;
  cmdVerifyGates(
    cwd: string,
    phaseDir: string | undefined,
    raw: boolean,
    options?: { strict?: boolean; phase?: string }
  ): void;
  cmdVerifyMutation(cwd: string, args: readonly string[], raw: boolean): Promise<void>;
  cmdVerifyBaseline(cwd: string, args: readonly string[], raw: boolean): void;
}

interface RouteVerifyCommandOptions {
  verify: VerifyModule;
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * `verify gates` arguments. Two caller shapes reach this route:
 *   - by hand:            verify gates <phase-dir> [--strict]
 *   - the step dispatcher: verify gates --phase <N> --raw
 *     (references/loop-hook-dispatch.md § step appends `--phase "${PHASE_NUMBER}"`;
 *     `--raw` is stripped by gsd-tools before routing).
 * The value after `--phase` is consumed by the flag, so it is never mistaken
 * for the positional phase directory — taking the first non-flag argument
 * would read `3` as a path and refuse with phase_dir_not_found.
 */
function parseVerifyGatesArgs(rest: string[]): { phaseDir: string | undefined; phase: string | undefined; strict: boolean } {
  let phaseDir: string | undefined;
  let phase: string | undefined;
  let strict = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--strict') {
      strict = true;
    } else if (arg === '--phase') {
      const value = rest[i + 1];
      if (value !== undefined && !value.startsWith('-')) {
        phase = value;
        i++;
      }
    } else if (arg.startsWith('--phase=')) {
      phase = arg.slice('--phase='.length) || undefined;
    } else if (!arg.startsWith('-') && phaseDir === undefined) {
      phaseDir = arg;
    }
  }
  return { phaseDir, phase, strict };
}

/**
 * Returns the pending promise of an async subcommand (`mutation` spawns test runs without blocking
 * the event loop) so the host awaits it; the family hub itself dispatches synchronously.
 */
function routeVerifyCommand({ verify, args, cwd, raw, error }: RouteVerifyCommandOptions): Promise<void> | undefined {
  let pending: Promise<void> | undefined;
  routeCjsCommandFamily({
    args,
    subcommands: VERIFY_SUBCOMMANDS,
    unsupported: {},
    error,
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown verify subcommand. Available: ${available.join(', ')}`,
    handlers: {
      'plan-structure': () => verify.cmdVerifyPlanStructure(cwd, args[2], raw),
      'phase-completeness': () => verify.cmdVerifyPhaseCompleteness(cwd, args[2], raw),
      references: () => verify.cmdVerifyReferences(cwd, args[2], raw),
      commits: () => verify.cmdVerifyCommits(cwd, args.slice(2), raw),
      artifacts: () => verify.cmdVerifyArtifacts(cwd, args[2], raw),
      'key-links': () => verify.cmdVerifyKeyLinks(cwd, args[2], raw),
      // The three drift verbs are the `drift` capability's gates (#5219, ADR-5057 §4): each is one gate
      // module (src/gate-{schema,codebase,context}-drift.cts) that the check router formats; this
      // surface hands them to it. `--skip` is this surface's bypass of the schema gate (it reads no
      // GSD_SKIP_SCHEMA_CHECK), carried to the gate as the env flag the check router reads.
      'schema-drift': () => {
        const rest = args.slice(2);
        const skipFlag = rest.includes('--skip');
        const phaseArg = rest.find((arg) => !arg.startsWith('-')) ?? '';
        routeCheckCommand({
          args: ['check', 'verify-schema-drift', phaseArg],
          cwd,
          raw,
          env: skipFlag ? { GSD_SKIP_SCHEMA_CHECK: 'true' } : {},
        });
      },
      // verify codebase-drift and context-drift are the same gate modules `check verify-<name>`
      // runs (#5219, ADR-5057 §4): this surface hands them to the check router, which formats them.
      'codebase-drift': () => routeCheckCommand({ args: ['check', 'verify-codebase-drift'], cwd, raw }),
      'context-drift': () => routeCheckCommand({ args: ['check', 'verify-context-drift', args[2] ?? ''], cwd, raw }),
      gates: () => {
        const { phaseDir, phase, strict } = parseVerifyGatesArgs(args.slice(2));
        verify.cmdVerifyGates(cwd, phaseDir, raw, { strict, phase });
      },
      // mn-verify-gate's mutation spot-check step: `verify mutation --phase <N>` (the step
      // dispatcher's form) or `verify mutation <phase-dir>`; records, the gate judges.
      mutation: () => {
        pending = verify.cmdVerifyMutation(cwd, args.slice(2), raw);
      },
      // mn-verify-gate's execute:pre baseline step: `verify baseline --phase <N>` (the step
      // dispatcher's form) or `verify baseline <phase-dir>`, `--accept <why>` to start on a known
      // red base; records into {N}-BASELINE.md, the gate `check mn-baseline` judges.
      baseline: () => verify.cmdVerifyBaseline(cwd, args.slice(2), raw),
    },
  });
  return pending;
}

export = {
  routeVerifyCommand,
  parseVerifyGatesArgs,
};
