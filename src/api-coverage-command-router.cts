'use strict';
/**
 * API-coverage command router — `gsd-tools api-coverage <subcommand>`.
 *
 *   api-coverage detect [--verbs a,b] [--nouns a,b]      (stdin: the phase scope text)
 *
 * The external-API-integration detector (src/api-coverage.cts, `detectApiIntegration`) through the
 * installed CLI, for the ai-integration capability's `plan:pre` fragment. The fragment used to run
 * `node gsd-core/bin/lib/api-coverage.cjs`, a path that resolves against the user's project and so
 * existed only in this repository: everywhere else the probe silently degraded to
 * `probe_unavailable`.
 *
 * The scope travels on stdin, never argv (ARG_MAX). The verdict is the payload, as with
 * `assumption-delta scan`: `{detected, signals, terms}`, or `{skipped: true, reason: "no_input"}`
 * for an empty or whitespace-only scope and `{skipped: true, reason: "stdin_error"}` when stdin
 * cannot be read — an unexamined input is never reported as a negative (ADR-3889 Phase 3, #3907).
 * Exit stays 0 for all three (ADR-3889 P8 pins the gsd-tools exit projection); `--json` is
 * accepted and ignored, the output is JSON either way.
 *
 * Test seam: `_readStdin` replaces the read of the process's standard input.
 */

import fs from 'node:fs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
import { detectApiIntegration, parseTermsOverride } from './api-coverage.cjs';

const { output } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;

export const API_COVERAGE_SUBCOMMANDS: readonly string[] = Object.freeze(['detect']);

interface RouteApiCoverageCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _readStdin?: () => string;
}

function routeApiCoverageCommand({ args, cwd, raw, error, _readStdin }: RouteApiCoverageCommandOptions): void {
  const readStdin = _readStdin ?? (() => fs.readFileSync(0, 'utf-8'));
  routeHubCommandFamily({
    family: 'api-coverage',
    args,
    subcommands: [...API_COVERAGE_SUBCOMMANDS],
    handlers: {
      detect: () => {
        let input: string;
        try {
          input = readStdin();
        } catch {
          output({ skipped: true, reason: 'stdin_error' }, raw);
          return;
        }
        // Whitespace-only counts as empty; a lone NUL byte, which .trim() keeps, is real input.
        if (input.trim().length === 0) {
          output({ skipped: true, reason: 'no_input' }, raw);
          return;
        }
        output(detectApiIntegration(input, parseTermsOverride(args)), raw);
      },
    },
    unknownMessage: (_subcommand: string, available: string[]) => `Unknown api-coverage subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeApiCoverageCommand };
