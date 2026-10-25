/**
 * `gsd_run verify baseline` — run the project's own checks (`workflow.verify_gates`) at
 * execute:pre, before the first wave, and record what they returned into the phase's
 * `{N}-BASELINE.md`. The gate `check mn-baseline` reads the record and blocks the run on a red
 * base (mn-verify-gate, `workflow.verify_gates_baseline`).
 *
 * ── The defect this closes ───────────────────────────────────────────────
 *
 * A phase that starts on a red tree finishes on a red tree, and nothing tells the failures it
 * brought from the failures it introduced. `verify gates` at verify:pre measures the end state
 * only, so "tests: 3 failed" after execution reads as the phase's own work even when all three
 * were red before the first commit — and a reviewer who learns that once stops reading the field.
 *
 * ── Why a separate artifact, not VERIFICATION.md ─────────────────────────
 *
 * VERIFICATION.md's `gates:` block is the phase's result: the ship gate reads it, and the verifier
 * reads it as "what the commands said about this work". A baseline is the opposite end — what the
 * commands said BEFORE the work — and writing it there would create VERIFICATION.md at execute
 * time (the execute-phase router reads that file's status to decide whether verification ran) and
 * put two measurements of different code under one name. `{N}-BASELINE.md` carries the same
 * per-check shape (`buildGatesFrontmatter`), so the two can be compared key for key.
 *
 * ── Why a step plus a gate, and the digest ───────────────────────────────
 *
 * The dispatcher runs a command step with a ten-minute Bash budget and a gate check with the
 * default; a test suite belongs in the step. The gate reads the record, which leaves one hole: a
 * step that failed before writing would let the gate read an older record. `digest` closes it —
 * a hash of the working tree (outside `.planning/`, untracked files included) and of the roster
 * the checks came from. The gate recomputes it; a record of other code or other checks is
 * "could not check", never a pass. Identical code with an identical roster gives an identical
 * digest, so an old record of the SAME code is still a valid measurement of it.
 *
 * ── Accepting a red base knowingly ───────────────────────────────────────
 *
 * `--accept "<why>"` records the checks that are not green now as accepted, with the reason. The
 * gate passes while every non-green check is on that list; a check that goes red later is not on
 * it and blocks. Re-recording without `--accept` keeps the list, so the next execute-phase run
 * (whose step re-records) does not silently undo the decision. The decision is per phase and
 * lives in the phase's own artifact, where a reviewer finds it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-gates.cjs is an export= CommonJS module
import verifyGates = require('./verify-gates.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioModule = require('./io.cjs');
const { output, error, ERROR_REASON } = ioModule;
import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import type { GateVerdict } from './gate-verdict.cjs';
import { declareGateExit } from './gate-exit.cjs';

/** The frontmatter key the baseline is recorded under. */
export const BASELINE_RECORD_KEY = 'baseline';

const BASELINE_ARTIFACT = 'BASELINE.md';

/** A git call: the seam tests replace. Returns trimmed stdout, or null when git refused. */
export type GitRunner = (args: string[], cwd: string, env?: Record<string, string>) => string | null;

const defaultGit: GitRunner = (args, cwd, env) => {
  // `add -A` hashes every changed and untracked file; a minute covers a large tree.
  const result = execGit(args, { cwd, env, timeout: 60_000 });
  return result.exitCode === 0 && !result.timedOut ? result.stdout : null;
};

/** `{N}-BASELINE.md` in the phase directory. */
export function baselinePathFor(phaseDir: string): string {
  return verifyGates.phaseArtifactPath(phaseDir, BASELINE_ARTIFACT);
}

function realPath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The tree id of the working tree as it is now — tracked changes and untracked, non-ignored files
 * included, `.planning/` excluded — or null outside a git repository.
 *
 * Built in a throwaway index seeded from the real one (so unchanged files are not re-hashed), never
 * the real index: the user's staging area is theirs. `.planning/` is excluded because the recorder
 * writes into it, and so does every workflow step between the record and the gate; including it
 * would make every record stale the moment it was written.
 */
function workingTreeId(cwd: string, git: GitRunner): string | null {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top === null || top === '') return null;
  const realIndex = git(['rev-parse', '--git-path', 'index'], cwd);
  // git prints the top level with symlinks resolved (macOS: /var → /private/var); a cwd spelled
  // through the link would otherwise sit "outside" it and `.planning/` would go unexcluded.
  const planningRel = path.relative(top, path.join(realPath(cwd), '.planning')).split(path.sep).join('/');
  const tmpIndex = path.join(os.tmpdir(), `gsd-baseline-index-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    if (realIndex) {
      const realIndexPath = path.resolve(cwd, realIndex);
      if (fs.existsSync(realIndexPath)) fs.copyFileSync(realIndexPath, tmpIndex);
    }
    const env = { GIT_INDEX_FILE: tmpIndex };
    const excluded = planningRel && !planningRel.startsWith('..') ? planningRel : null;
    const addArgs = excluded ? ['add', '-A', '--', '.', `:(exclude)${excluded}`] : ['add', '-A', '--', '.'];
    if (git(addArgs, top, env) === null) return null;
    if (excluded && git(['rm', '-r', '--cached', '-q', '--ignore-unmatch', '--', excluded], top, env) === null) return null;
    return git(['write-tree'], top, env);
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }
}

/**
 * What a baseline record must match to describe the code and roster in front of the gate: the
 * working tree's id (null outside git, where only the roster can be compared) and the checks.
 */
export function baselineDigest(
  cwd: string,
  checks: ReadonlyArray<{ name: string; command: string }>,
  git: GitRunner = defaultGit
): string {
  const payload = JSON.stringify({ tree: workingTreeId(cwd, git), checks: checks.map((c) => [c.name, c.command]) });
  return `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

interface BaselineArgs {
  phaseDir?: string;
  phase?: string;
  accept?: string;
  problem?: string;
}

/** `[<phase-dir>] [--phase <N>] [--accept <why>]`, with the `--flag=value` forms. */
export function parseBaselineArgs(args: readonly string[]): BaselineArgs {
  const parsed: BaselineArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    if (flag === '--phase' || flag === '--accept') {
      let value: string | undefined;
      if (eq !== -1) value = arg.slice(eq + 1);
      else if (i + 1 < args.length && !args[i + 1].startsWith('--')) value = args[++i];
      if (value === undefined) {
        // A dangling flag is a missing value, never the next flag read as one.
        parsed.problem = `${flag} needs a value`;
        continue;
      }
      if (flag === '--phase') parsed.phase = value;
      else parsed.accept = value;
    } else if (!arg.startsWith('--') && parsed.phaseDir === undefined) {
      parsed.phaseDir = arg;
    }
  }
  return parsed;
}

interface BaselineOptions {
  runner?: Parameters<typeof verifyGates.runGates>[0]['runner'];
  clock?: { now(): number };
  /** Injected for tests so the recorded timestamp is deterministic. */
  timestamp?: string;
  git?: GitRunner;
}

/** The acceptance a previous record carries, so a plain re-record does not drop it. */
function previousAcceptance(baselinePath: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(baselinePath, 'utf8');
  } catch {
    return {};
  }
  const block = (extractFrontmatter(text) as Record<string, unknown>)[BASELINE_RECORD_KEY];
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return {};
  const record = block as Record<string, unknown>;
  const accepted = verifyGates.recordedList(record['accepted']);
  if (accepted.length === 0) return {};
  const field = (key: string): string => {
    const value = record[key];
    return typeof value === 'string' ? value : '';
  };
  return { accepted, accepted_reason: field('accepted_reason'), accepted_at: field('accepted_at') };
}

/**
 * `gsd_run verify baseline <phase-dir> [--accept <why>]`
 * `gsd_run verify baseline --phase <N> [--accept <why>]`   (the dispatcher's form)
 *
 * Exit status as `verify gates`, through the gate-exit seam (status mode; #5170):
 *   0  the baseline was recorded (whatever it says — the gate judges)
 *  66  nothing is configured to run (NO_INPUT)
 *  69  the phase could not be found, it could not be recorded, or workflow.verify_gates is set but
 *      malformed (UNAVAILABLE, ADR-3889)
 *  wrong arguments are a usage error through `error()` (1; 64 under v2)
 */
export function cmdVerifyBaseline(cwd: string, args: readonly string[], raw: boolean, options: BaselineOptions = {}): void {
  // Printed (compact under --raw), then the exit declared from the verdict.
  const emit = (verdict: GateVerdict): void => {
    output(verdict.payload, raw, raw ? JSON.stringify(verdict.payload) : undefined);
    declareGateExit(verdict, 'status');
  };
  const usage = 'Usage: verify baseline <phase-dir> | --phase <N> [--accept "<why the red base is accepted>"]';

  const parsed = parseBaselineArgs(args);
  if (parsed.problem) {
    error(`${parsed.problem} — ${usage}`, ERROR_REASON.USAGE, { refusal: 'bad_arguments', problem: parsed.problem });
    return;
  }
  if (parsed.accept !== undefined && parsed.accept.trim() === '') {
    // An acceptance with no reason is a bypass nobody can review later.
    error(`--accept needs a reason — ${usage}`, ERROR_REASON.USAGE, { refusal: 'accept_needs_reason' });
    return;
  }
  const target = verifyGates.resolveRecorderPhase(cwd, parsed.phaseDir, parsed.phase, usage);
  if (!target.ok) {
    if ('usage' in target) {
      error(target.usage.message, ERROR_REASON.USAGE, target.usage.payload);
      return;
    }
    emit(target.verdict);
    return;
  }
  const roster = verifyGates.resolveRoster(cwd);
  if (!roster.ok) {
    if ('usage' in roster) {
      error(roster.usage.message, ERROR_REASON.USAGE, roster.usage.payload);
      return;
    }
    emit(roster.verdict);
    return;
  }

  const { phaseDir } = target;
  const { checks } = roster;
  const results = verifyGates.runGates({ cwd, phaseDir, checks, runner: options.runner, clock: options.clock });
  const ranAt = options.timestamp || new Date().toISOString();
  const measured = verifyGates.buildGatesFrontmatter(results, ranAt);
  // After the run, not before: a check that leaves untracked output behind (a coverage report
  // nobody ignored) changes the tree, and the gate — which runs nothing — sees the tree as the
  // run left it.
  const digest = baselineDigest(cwd, checks, options.git);

  const baselinePath = baselinePathFor(phaseDir);
  const notGreen = results.filter((r) => !r.passed).map((r) => r.name);
  const acceptance =
    parsed.accept !== undefined
      ? notGreen.length > 0
        ? { accepted: notGreen, accepted_reason: parsed.accept.trim(), accepted_at: ranAt }
        : {}
      : previousAcceptance(baselinePath);
  const block = { ...measured, digest, ...acceptance };

  let created = false;
  try {
    created = verifyGates.recordFrontmatterBlock(baselinePath, BASELINE_RECORD_KEY, block, {
      suffix: `-${BASELINE_ARTIFACT}`,
      body:
        '# Baseline\n\nThe project\'s own checks (`workflow.verify_gates`), measured at execute:pre before the first ' +
        'wave. Written by `gsd_run verify baseline`; judged by `gsd_run check mn-baseline`.\n',
    }).created;
  } catch (err) {
    emit(
      gateUnreadable(false, {
        ok: false,
        reason: 'record_failed',
        baselinePath,
        error: (err as { code?: string } | null)?.code || 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
        baseline: block,
      })
    );
    return;
  }

  emit(
    gateVerdict(measured.all_passed ? 'pass' : 'advisory', false, {
      ok: true,
      baselinePath,
      created,
      allPassed: measured.all_passed,
      failed: measured.failed,
      stale: measured.stale,
      timedOut: measured.timed_out,
      ran: measured.ran,
      accepted: (block as Record<string, unknown>)['accepted'] ?? [],
      baseline: block,
      results: verifyGates.resultsPayload(results),
      warnings: verifyGates.unmeasuredWarnings(results),
    })
  );
}
