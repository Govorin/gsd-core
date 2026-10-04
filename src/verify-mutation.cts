/**
 * `gsd_run verify mutation` — the mutation spot-check as a RECORDING step (mn-verify-gate,
 * verify:pre; replaces the run half of scripts/mutation-spot-check.mjs). The gate
 * `gsd_run check mn-mutation-spot-check` reads what this step records and judges it.
 *
 * ── What it proves ───────────────────────────────────────────────────────
 *
 * That the phase's tests REACT to changes in the phase's code, not merely exist and pass. A green
 * run cannot tell "the code is correct" from "the test asserts nothing"; the assertion ratchet
 * catches a deleted check, not one that never checked (`expect(true).toBe(true)` counts the same).
 * The case is on record — norn/13-01-SUMMARY.md: "my own test was a false green, caught by
 * mutation" — found by hand. No Stryker: none of the projects that need this installs it, and a
 * gate that first requires a tool does not get switched on. The project's own test command runs.
 *
 * ── Why a step and not a gate ────────────────────────────────────────────
 *
 * One full test run per mutant can take many minutes; a gate is one Bash call bounded at two (ten
 * at most). Decision 1 of the 3.12 design: the long run is a step that RECORDS a `mutation:` block
 * into the phase's VERIFICATION.md — exactly as `verify gates` records `gates:` — and the gate only
 * reads the record. The step bounds itself: a total wall-clock budget below the 10-minute Bash cap
 * (no new mutant starts once it is spent, and the record says so), and a per-run timeout.
 *
 * ── Boundaries chosen on purpose ─────────────────────────────────────────
 *
 * • Files come from `files_modified` of the phase's plans: the phase answers only for its own code.
 * • Mutations change behaviour and almost never syntax (`>=`→`>`, `===`→`!==`, `&&`→`||`,
 *   `true`→`false`): a mutant that fails to compile is "killed" by the compiler, proving nothing.
 * • Tests are never mutated (`*.spec.*`, `*.test.*`, `tests/`): that checks a test with a test.
 * • One mutant per file, at most `workflow.mutation_max_mutants` (default 3): a spot-check, not
 *   coverage.
 * • A green baseline run first: on a red suite "the mutant was killed" cannot be told from "the
 *   tests were already failing".
 * • The source file is ALWAYS restored — after each run, in `finally`, and on SIGINT/SIGTERM. A
 *   step that leaves a mutation in the working tree is worse than no step.
 *
 * The record carries a digest of the candidate files, so the gate can tell a record of THIS code
 * from a stale one left by an earlier run.
 *
 * Exit code means "was the result recorded" (like `verify gates`): 0 recorded — whatever it says;
 * 1 nothing recorded (no such phase, VERIFICATION.md unwritable).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isGateUsageFailure } from './gate-verdict.cjs';
import { resolveMnPhase } from './gate-mn-support.cjs';
import { readWorkflowConfigValue } from './gate-config.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- verify-gates.cjs is an export= CommonJS module
import verifyGates = require('./verify-gates.cjs');
const { recordVerificationBlock, verificationPathFor } = verifyGates;

// ─── Constants ────────────────────────────────────────────────────────────

/** Mutants per phase when `workflow.mutation_max_mutants` is unset or not a positive integer. */
export const MUTATION_DEFAULT_MAX_MUTANTS = 3;

/**
 * The whole step's wall-clock budget: nine minutes, under the ten-minute cap a Bash call has. No
 * mutant starts once it is spent; a run started inside it is bounded by what is left.
 */
export const MUTATION_TOTAL_BUDGET_MS = 9 * 60 * 1000;

/** The ceiling for any single test run, whatever budget is left. */
export const MUTATION_RUN_TIMEOUT_MS = 5 * 60 * 1000;

/** The frontmatter key the step writes and the gate reads. */
export const MUTATION_RECORD_KEY = 'mutation';

/** What the record says happened. */
export const MUTATION_STATUS = Object.freeze({
  PASSED: 'passed',
  SURVIVORS: 'survivors',
  NOTHING_TO_MUTATE: 'nothing_to_mutate',
  NO_COMMAND: 'no_command',
  UNRUNNABLE: 'unrunnable',
  RED_BASELINE: 'red_baseline',
  BUDGET_EXHAUSTED: 'budget_exhausted',
} as const);
export type MutationStatus = (typeof MUTATION_STATUS)[keyof typeof MUTATION_STATUS];

const MUTATIONS: ReadonlyArray<{ from: RegExp; to: string; label: string }> = [
  { from: /([^=!<>])>=/, to: '$1>', label: '>= → >' },
  { from: /([^=!<>])<=/, to: '$1<', label: '<= → <' },
  { from: /===/, to: '!==', label: '=== → !==' },
  { from: /!==/, to: '===', label: '!== → ===' },
  { from: /&&/, to: '||', label: '&& → ||' },
  { from: /\btrue\b/, to: 'false', label: 'true → false' },
];

// ─── Injected effects ─────────────────────────────────────────────────────

/** One run of the test command: its exit status, or why it did not complete. */
export interface MutationRunResult {
  status: number | null;
  error: { code?: string } | null;
  signal: string | null;
}

export type MutationRunner = (command: string, cwd: string, timeoutMs: number) => MutationRunResult;

type MutationSignal = 'SIGINT' | 'SIGTERM';

/**
 * The process-signal surface the restore obligation hooks into. After restoring, the handler
 * removes itself and RE-RAISES the signal, so the process still dies of it (default action, the
 * conventional 128+n status) — no exit code is invented here (ADR-3889).
 */
export interface MutationSignals {
  on: (signal: MutationSignal, handler: () => void) => void;
  off: (signal: MutationSignal, handler: () => void) => void;
  raise: (signal: MutationSignal) => void;
}

export interface MutationDeps {
  runner: MutationRunner;
  clock: { now(): number };
  /** Writes a source file (mutate and restore). Injected so a failing restore can be simulated. */
  writeFile(file: string, content: string): void;
  signals: MutationSignals;
}

function defaultRunner(command: string, cwd: string, timeoutMs: number): MutationRunResult {
  // A shell is required: the configured value is a command line ("npx vitest run"), from the
  // project's own .planning/config.json — the same trust boundary as `verify gates`. The empty
  // argv is the (command, args, options) overload, so the timeout sits where
  // local/require-subprocess-timeout looks for it (passing args with shell:true is DEP0190).
  const res = spawnSync(command, [], { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { status: res.status, error: (res.error as { code?: string } | undefined) || null, signal: res.signal || null };
}

export function defaultMutationDeps(): MutationDeps {
  return {
    runner: defaultRunner,
    clock: Date,
    writeFile: (file, content) => fs.writeFileSync(file, content),
    signals: {
      on: (signal, handler) => {
        process.on(signal, handler);
      },
      off: (signal, handler) => {
        process.off(signal, handler);
      },
      raise: (signal) => {
        process.kill(process.pid, signal);
      },
    },
  };
}

// ─── Candidates ───────────────────────────────────────────────────────────

/**
 * The phase's mutable source files, sorted, relative to the project: every `files_modified` entry
 * of every plan, minus globs, non-JS/TS files, tests, and files that do not exist.
 */
export function mutationCandidates(projectDir: string, phaseDir: string): string[] {
  const declared = new Set<string>();
  for (const plan of scanPhasePlans(phaseDir).allPlanFiles) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(phaseDir, plan), 'utf8');
    } catch {
      continue;
    }
    const raw = (extractFrontmatter(text) as Record<string, unknown>)['files_modified'];
    const entries = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() !== '' ? [raw] : [];
    for (const entry of entries) {
      if (typeof entry !== 'string') continue;
      const cleaned = entry.trim().replace(/^\.\//, '').replace(/^\/+/, '');
      if (cleaned !== '') declared.add(cleaned);
    }
  }
  return [...declared]
    .filter((entry) => !entry.includes('*'))
    .filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))
    .filter((entry) => !/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry))
    .filter((entry) => !/(^|\/)(tests?|__tests__)\//.test(entry))
    .filter((entry) => {
      try {
        return fs.statSync(path.join(projectDir, entry)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** A digest over the candidate list and each candidate's bytes — what "this code" means to a record. */
export function digestCandidates(projectDir: string, candidates: readonly string[]): string {
  const hash = crypto.createHash('sha256');
  for (const rel of candidates) {
    hash.update(rel);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(projectDir, rel)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** The first applicable mutation for a file, made in exactly one place, or null. */
export function mutateOnce(source: string): { label: string; line: number; mutated: string } | null {
  for (const rule of MUTATIONS) {
    const match = rule.from.exec(source);
    if (!match) continue;
    const at = match.index;
    const replaced = match[0].replace(rule.from, rule.to);
    return {
      label: rule.label,
      line: source.slice(0, at).split('\n').length,
      mutated: source.slice(0, at) + replaced + source.slice(at + match[0].length),
    };
  }
  return null;
}

// ─── The run ──────────────────────────────────────────────────────────────

export interface MutantResult {
  file: string;
  line: number;
  label: string;
}

export interface MutationOutcome {
  status: MutationStatus;
  candidates: number;
  maxMutants: number;
  attempted: number;
  killed: MutantResult[];
  survived: MutantResult[];
  /** Mutant runs that did not complete (crash, timeout) — neither killed nor survived. */
  unrunnable: number;
  budgetMs: number;
  reason?: string;
}

export interface MutationRunOptions {
  projectDir: string;
  phaseDir: string;
  command: string;
  maxMutants: number;
  budgetMs?: number;
  runTimeoutMs?: number;
  deps?: Partial<MutationDeps>;
}

function completed(r: MutationRunResult): boolean {
  return !r.error && r.status !== null;
}

/**
 * Run the spot-check. Every mutated file is restored after its run, in `finally` (any throw), and
 * on SIGINT/SIGTERM (restore, then re-raise). Never writes the record — see `cmdVerifyMutation`.
 */
export function runMutationSpotCheck(options: MutationRunOptions): MutationOutcome {
  const deps: MutationDeps = { ...defaultMutationDeps(), ...(options.deps || {}) };
  const budgetMs = options.budgetMs ?? MUTATION_TOTAL_BUDGET_MS;
  const runCap = options.runTimeoutMs ?? MUTATION_RUN_TIMEOUT_MS;
  const { projectDir, phaseDir, command, maxMutants } = options;
  const outcome: MutationOutcome = {
    status: MUTATION_STATUS.PASSED,
    candidates: 0,
    maxMutants,
    attempted: 0,
    killed: [],
    survived: [],
    unrunnable: 0,
    budgetMs,
  };

  if (command.trim() === '') {
    return {
      ...outcome,
      status: MUTATION_STATUS.NO_COMMAND,
      reason: 'no test command — set workflow.mutation_test_command; guessing a runner would produce an unrunnable check',
    };
  }

  const candidates = mutationCandidates(projectDir, phaseDir);
  outcome.candidates = candidates.length;
  if (candidates.length === 0) return { ...outcome, status: MUTATION_STATUS.NOTHING_TO_MUTATE };

  const started = deps.clock.now();
  const remaining = () => budgetMs - (deps.clock.now() - started);

  const baseline = deps.runner(command, projectDir, Math.max(1, Math.min(runCap, remaining())));
  if (!completed(baseline)) {
    return {
      ...outcome,
      status: MUTATION_STATUS.UNRUNNABLE,
      reason: `the test command could not run (${baseline.signal || baseline.error?.code || 'spawn failed'}) — fix the command, not the code`,
    };
  }
  if (baseline.status !== 0) {
    return {
      ...outcome,
      status: MUTATION_STATUS.RED_BASELINE,
      reason: `the suite is already red (exit ${baseline.status}) — a surviving mutant cannot be told from a pre-existing failure`,
    };
  }

  const originals = new Map<string, string>();
  const restoreAll = () => {
    for (const [file, source] of originals) {
      deps.writeFile(file, source);
      originals.delete(file);
    }
  };
  const detach = () => {
    deps.signals.off('SIGINT', onSigint);
    deps.signals.off('SIGTERM', onSigterm);
  };
  function onSignal(signal: MutationSignal): void {
    restoreAll();
    detach();
    deps.signals.raise(signal);
  }
  function onSigint(): void {
    onSignal('SIGINT');
  }
  function onSigterm(): void {
    onSignal('SIGTERM');
  }
  deps.signals.on('SIGINT', onSigint);
  deps.signals.on('SIGTERM', onSigterm);

  let budgetExhausted = false;
  try {
    for (const rel of candidates) {
      if (outcome.attempted >= maxMutants) break;
      const left = remaining();
      if (left <= 0) {
        budgetExhausted = true;
        break;
      }
      const file = path.join(projectDir, rel);
      const source = fs.readFileSync(file, 'utf8');
      const mutation = mutateOnce(source);
      if (!mutation) continue;

      originals.set(file, source);
      deps.writeFile(file, mutation.mutated);
      let result: MutationRunResult;
      try {
        result = deps.runner(command, projectDir, Math.max(1, Math.min(runCap, left)));
      } finally {
        deps.writeFile(file, source);
        originals.delete(file);
      }

      const mutant: MutantResult = { file: rel, line: mutation.line, label: mutation.label };
      if (!completed(result)) {
        // A run that did not complete is not "killed": the attempt does not count.
        outcome.unrunnable += 1;
        if (remaining() <= 0) budgetExhausted = true;
        continue;
      }
      outcome.attempted += 1;
      if (result.status === 0) outcome.survived.push(mutant);
      else outcome.killed.push(mutant);
    }
  } finally {
    restoreAll();
    detach();
  }

  if (outcome.survived.length > 0) return { ...outcome, status: MUTATION_STATUS.SURVIVORS };
  if (budgetExhausted) {
    return {
      ...outcome,
      status: MUTATION_STATUS.BUDGET_EXHAUSTED,
      reason: `the ${Math.round(budgetMs / 1000)}s budget ran out after ${outcome.attempted} mutant(s) — narrow workflow.mutation_test_command`,
    };
  }
  if (outcome.attempted === 0 && outcome.unrunnable > 0) {
    // Every mutant run crashed or timed out: nothing was measured. The script reported this as
    // "nothing to spot-check" (a pass); "could not check" is the honest reading.
    return {
      ...outcome,
      status: MUTATION_STATUS.UNRUNNABLE,
      reason: `no mutant run completed (${outcome.unrunnable} did not finish) — check the command and its time budget`,
    };
  }
  if (outcome.attempted === 0) return { ...outcome, status: MUTATION_STATUS.NOTHING_TO_MUTATE };
  return outcome;
}

// ─── The record ───────────────────────────────────────────────────────────

/** A survivor as one plain string (`file:line (label)`); commas would split the inline YAML list. */
function describeMutant(m: MutantResult): string {
  return `${m.file.replace(/,/g, ' ')}:${m.line} (${m.label})`;
}

/**
 * The `mutation:` block — one level of scalar keys and a scalar list, the shape spliceFrontmatter
 * serializes faithfully.
 */
export function buildMutationRecord(outcome: MutationOutcome, ranAt: string, digest: string): Record<string, unknown> {
  return {
    ran_at: ranAt,
    status: outcome.status,
    candidates: outcome.candidates,
    max_mutants: outcome.maxMutants,
    attempted: outcome.attempted,
    killed: outcome.killed.length,
    survived: outcome.survived.length,
    unrunnable: outcome.unrunnable,
    budget_ms: outcome.budgetMs,
    digest,
    survivors: outcome.survived.map(describeMutant),
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

/** `workflow.mutation_max_mutants` when it is a positive integer, else the default. */
export function readMaxMutants(projectDir: string): number {
  const resolved = readWorkflowConfigValue(projectDir, 'workflow.mutation_max_mutants');
  const value = resolved.found ? Number(resolved.value) : NaN;
  return Number.isInteger(value) && value > 0 ? value : MUTATION_DEFAULT_MAX_MUTANTS;
}

/** `workflow.mutation_test_command`, trimmed, or ''. */
export function readMutationCommand(projectDir: string): string {
  const resolved = readWorkflowConfigValue(projectDir, 'workflow.mutation_test_command');
  return resolved.found && typeof resolved.value === 'string' ? resolved.value.trim() : '';
}

// ─── CLI ──────────────────────────────────────────────────────────────────

export interface CmdVerifyMutationOptions {
  deps?: Partial<MutationDeps>;
  budgetMs?: number;
  /** Injected for tests so the recorded timestamp is deterministic. */
  timestamp?: string;
}

/**
 * `gsd_run verify mutation --phase <N>`   (the step dispatcher's form)
 * `gsd_run verify mutation <phase-dir | N>`
 */
export function cmdVerifyMutation(cwd: string, args: readonly string[], raw: boolean, options: CmdVerifyMutationOptions = {}): void {
  const emit = (payload: Record<string, unknown>, exitCode: number) => {
    process.stdout.write(`${raw ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = exitCode;
  };

  const phase = resolveMnPhase(cwd, args);
  if (isGateUsageFailure(phase)) {
    emit({ ok: false, reason: 'usage', message: `${phase.failure.message} — usage: verify mutation --phase <N> | <phase-dir>` }, 1);
    return;
  }
  if ('unresolved' in phase) {
    emit({ ok: false, reason: 'phase_not_found', message: phase.unresolved }, 1);
    return;
  }

  const { phaseDir } = phase;
  const outcome = runMutationSpotCheck({
    projectDir: cwd,
    phaseDir,
    command: readMutationCommand(cwd),
    maxMutants: readMaxMutants(cwd),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
    ...(options.deps ? { deps: options.deps } : {}),
  });
  const record = buildMutationRecord(
    outcome,
    options.timestamp || new Date().toISOString(),
    digestCandidates(cwd, mutationCandidates(cwd, phaseDir)),
  );

  const verificationPath = verificationPathFor(phaseDir);
  let created = false;
  try {
    created = recordVerificationBlock(verificationPath, MUTATION_RECORD_KEY, record).created;
  } catch (err) {
    emit(
      {
        ok: false,
        reason: 'record_failed',
        verificationPath,
        message: err instanceof Error ? err.message : String(err),
        mutation: record,
      },
      1,
    );
    return;
  }
  emit({ ok: true, verificationPath, created, mutation: record }, 0);
}
