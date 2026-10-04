/**
 * `gsd_run verify gates` — run the project's own checks and record what they
 * returned into the phase's VERIFICATION.md frontmatter.
 *
 * ── The defect this closes ───────────────────────────────────────────────
 *
 * VERIFICATION.md is written by an agent that also decides whether the phase
 * passed. Its "Automated checks: 2 passed, 8 failed" line is prose the agent
 * typed, not output a command produced, and nothing downstream can tell the
 * difference between a verifier that ran the suite and one that described
 * running it. Measured on this fork's own projects: the best reports do carry
 * the evidence by hand — `norn/13-01-SUMMARY.md` has a `## Gates` line reading
 * "typecheck 5/5 · tests 204 · oxlint 0 errors", and `ucars/16-VERIFICATION.md`
 * opens by insisting "every command below was actually executed" — but most
 * carry zero command blocks, because it is per-agent discipline rather than a
 * mechanism.
 *
 * The gate that would consume such evidence already exists and already has a
 * predicate for it: `artifact-frontmatter-equals` (ADR-2008,
 * src/gate-predicate-evaluator.cts). It has had nothing to read, because
 * nothing writes machine-checkable gate results. This command writes them.
 *
 * ── Why the tool runs the checks, not the agent ──────────────────────────
 *
 * "Put the judge in a different context than the worker" is the strongest
 * finding in the 2026 harness literature, and the cheapest possible judge is
 * one that is not a model at all. A typecheck exit code cannot be optimistic.
 * The verifier agent still reads these fields and still reasons about the
 * phase goal — it simply no longer supplies the numbers it is judged on.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────
 *
 * It does not decide whether the phase passed. It records what the commands
 * returned; the gate decides, the verifier interprets. A check that fails
 * still writes its failure and exits 0 — the exit code of THIS command means
 * "did the recording succeed", not "were the checks green" — because a
 * recording step that fails when the news is bad is a step people route
 * around. `--strict` inverts that for callers who want the failure to
 * propagate directly.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterModule = require('./frontmatter.cjs');
const { extractFrontmatter, spliceFrontmatter } = frontmatterModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocator = require('./phase-locator.cjs');
const { findPhaseInternal } = phaseLocator;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cliExitModule = require('./cli-exit.cjs');
const { projectOutcome, getContractVersion } = cliExitModule;

// ─── Types ────────────────────────────────────────────────────────────────

interface GateCheck {
  /** Key under `gates:` — `tests`, `typecheck`, `lint`, or a project's own. */
  name: string;
  /** The command line, exactly as configured. */
  command: string;
}

/**
 * What `workflow.verify_gates` resolved to. An empty roster and an unreadable
 * one are different answers: the first is "nothing configured yet", the second
 * is "configured, but not in a form that can run" — and reporting the second
 * as the first sends the user looking for a setting they already wrote.
 */
type ChecksConfig = { ok: true; checks: GateCheck[] } | { ok: false; problems: string[] };

/**
 * What one check run came to — a closed set, and the only one a reader of the
 * record branches on.
 *
 *   pass     exited 0.
 *   fail     exited non-zero: the check ran and said no. The only status that
 *            says something about the code.
 *   stale    the check did not run as a check: the configured command is gone
 *            or not executable, or the environment cut it off before it could
 *            answer. A roster that outlived its tools reads here, not as red.
 *   timeout  killed at the time budget — it may have been about to pass.
 *
 * `stale` and `timeout` are both "not measured"; they stay apart because the
 * remedy differs (repair the roster vs. raise the budget or split the check).
 */
const CHECK_STATUS = Object.freeze({
  PASS: 'pass',
  FAIL: 'fail',
  STALE: 'stale',
  TIMEOUT: 'timeout',
} as const);

type CheckStatus = (typeof CHECK_STATUS)[keyof typeof CHECK_STATUS];

/**
 * What a gate makes of each status — the three mn gate verdicts (gate-mn-support.cts). Only a
 * measured red is a finding about the code; a check that could not answer is "could not check",
 * which still blocks (fail-closed) but says so instead of calling the code broken.
 */
const CHECK_STATUS_VERDICT: Readonly<Record<CheckStatus, 'pass' | 'finding' | 'unresolvable'>> = Object.freeze({
  pass: 'pass',
  fail: 'finding',
  stale: 'unresolvable',
  timeout: 'unresolvable',
});

/** What the runner reports for one command — `spawnSync`'s shape, narrowed. */
interface RawRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error: { code?: string } | null;
  signal: string | null;
}

/**
 * One classification rule: what was observed about a run, the status that means, and the cause
 * recorded beside it. `match` returns the cause when the rule applies (`''` for pass/fail, which
 * need none) and `null` when it does not. The first rule that matches decides.
 */
interface CheckOutcomeRule {
  id: string;
  observed: string;
  status: CheckStatus;
  match(run: RawRun): string | null;
}

/**
 * The classifier, as data — `classifyRun` walks it and `docs/reference/state-machines.md` is
 * drawn from it, so the diagram cannot describe a rule the code does not apply.
 *
 * Order matters. A timeout and an output-cap overflow both arrive as an `error` WITH a signal, so
 * they are tested before the generic spawn error and the bare signal. Exit codes 126 and 127 are
 * the two the shell itself reserves for "could not run that" (POSIX 2.8.2); every other non-zero
 * exit is the check's own answer. That includes 128+n — the shell reporting a child killed by a
 * signal — because a runner may exit with any code it likes, and reading 137 as "environment"
 * would excuse a test that crashed the process it was testing.
 */
const CHECK_OUTCOME_RULES: ReadonlyArray<CheckOutcomeRule> = Object.freeze([
  {
    id: 'timed_out',
    observed: 'killed at the time budget',
    status: CHECK_STATUS.TIMEOUT,
    match: (run: RawRun) => (run.error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : null),
  },
  {
    id: 'output_cap',
    observed: 'killed at the output capture limit',
    status: CHECK_STATUS.STALE,
    match: (run: RawRun) => (run.error?.code === 'ENOBUFS' ? 'ENOBUFS' : null),
  },
  {
    id: 'spawn_error',
    observed: 'could not be started',
    status: CHECK_STATUS.STALE,
    match: (run: RawRun) => (run.error ? `spawn_${run.error.code || 'UNKNOWN'}` : null),
  },
  {
    id: 'signal',
    observed: 'ended by a signal it did not raise',
    status: CHECK_STATUS.STALE,
    match: (run: RawRun) => (run.status === null ? `signal_${run.signal || 'UNKNOWN'}` : null),
  },
  {
    id: 'not_found',
    observed: 'exit 127: no such command',
    status: CHECK_STATUS.STALE,
    match: (run: RawRun) => (run.status === 127 ? 'exit_127' : null),
  },
  {
    id: 'not_executable',
    observed: 'exit 126: not executable',
    status: CHECK_STATUS.STALE,
    match: (run: RawRun) => (run.status === 126 ? 'exit_126' : null),
  },
  {
    id: 'exit_zero',
    observed: 'exit 0',
    status: CHECK_STATUS.PASS,
    match: (run: RawRun) => (run.status === 0 ? '' : null),
  },
  {
    id: 'exit_other',
    observed: 'any other exit code',
    status: CHECK_STATUS.FAIL,
    match: () => '',
  },
]);

interface GateResult {
  name: string;
  command: string;
  /** null when the command produced no exit code at all. */
  exitCode: number | null;
  status: CheckStatus;
  /** Why a check was not measured (`exit_127`, `ETIMEDOUT`, `spawn_ENOENT`, …) — empty otherwise. */
  cause: string;
  passed: boolean;
  durationMs: number;
  /** Parsed counts, when the output states them in a recognised shape. */
  counts?: Record<string, number>;
}

interface RunGatesOptions {
  cwd: string;
  phaseDir: string;
  checks: GateCheck[];
  /** Injected for tests; defaults to a real spawn. */
  runner?: (command: string, cwd: string, timeoutMs: number) => RawRun;
  /** Injected for tests (the repo's clock-seam convention). */
  clock?: { now(): number };
  timeoutMs?: number;
}

/**
 * The recorded block, in the ONE shape the frontmatter writer can serialize
 * faithfully: a single level of scalar-valued keys.
 *
 * This is a constraint, not a preference. `spliceFrontmatter` refuses a nested
 * object-list outright ("cannot faithfully serialize … it would emit
 * [object Object]"), so the obvious shape — `gates.checks.tests.exit_code` —
 * cannot be written at all. Flattening to `tests_exit_code` is what the writer
 * supports, and it happens to be what the reader wants too:
 * `artifact-frontmatter-equals` addresses a field by a flat dotted path, so
 * `gates.tests_exit_code` is directly gateable where the nested form would
 * have needed a new predicate kind.
 *
 * Per-check keys are `{name}_status`, `{name}_exit_code`, `{name}_passed`,
 * `{name}_ms`, `{name}_cause` (only for a check that was not measured), plus
 * any parsed counts as `{name}_{count}` (e.g. `tests_passed_count`).
 */
interface GatesFrontmatter {
  ran_at: string;
  all_passed: boolean;
  /** Checks that ran and said no (`fail`). */
  failed: number;
  /** Checks that did not run as checks (`stale`). */
  stale: number;
  /** Checks killed at the time budget (`timeout`). */
  timed_out: number;
  /** Names of the checks that ran, so a reader can see coverage at a glance. */
  ran: string[];
  // The index signature carries the per-check flattened keys and is what lets
  // this satisfy the frontmatter module's `FrontmatterValue`.
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 600000;

// ─── Output parsing ───────────────────────────────────────────────────────

/**
 * Pull counts out of a test runner's summary line.
 *
 * Deliberately conservative: only shapes that are unambiguous are read, and a
 * command whose output is not recognised simply carries no counts. A WRONG
 * count is worse than no count — it would be evidence that says something
 * false, which is precisely the failure this command exists to remove. The
 * exit code is always authoritative for pass/fail; counts are colour.
 *
 * Recognised, because these are what this fork's projects actually emit:
 *   node:test   "# pass 41" / "# fail 0"
 *   vitest      "Tests  204 passed (206)" / "Tests  2 failed | 204 passed"
 *   jest        "Tests:  204 passed, 206 total"
 *   tsc         "Found 3 errors"
 *   oxlint      "Found 0 warnings and 3 errors"
 */
function parseCounts(output: string): Record<string, number> | undefined {
  const counts: Record<string, number> = {};

  // node:test TAP-ish summary
  const nodePass = /^#\s+pass\s+(\d+)\s*$/m.exec(output);
  const nodeFail = /^#\s+fail\s+(\d+)\s*$/m.exec(output);
  if (nodePass) counts['passed'] = Number(nodePass[1]);
  if (nodeFail) counts['failed'] = Number(nodeFail[1]);

  // vitest / jest
  if (counts['passed'] === undefined) {
    const passed = /\b(\d+)\s+passed\b/.exec(output);
    if (passed) counts['passed'] = Number(passed[1]);
  }
  if (counts['failed'] === undefined) {
    const failed = /\b(\d+)\s+failed\b/.exec(output);
    if (failed) counts['failed'] = Number(failed[1]);
  }
  const skipped = /\b(\d+)\s+(?:skipped|todo)\b/.exec(output);
  if (skipped) counts['skipped'] = Number(skipped[1]);

  // tsc / oxlint error counts
  const errors = /\bFound\s+(\d+)\s+errors?\b/.exec(output);
  if (errors) counts['errors'] = Number(errors[1]);
  const warnings = /\bFound\s+(\d+)\s+warnings?\b/.exec(output);
  if (warnings) counts['warnings'] = Number(warnings[1]);
  const oxlintPair = /\bFound\s+(\d+)\s+warnings?\s+and\s+(\d+)\s+errors?\b/.exec(output);
  if (oxlintPair) {
    counts['warnings'] = Number(oxlintPair[1]);
    counts['errors'] = Number(oxlintPair[2]);
  }

  return Object.keys(counts).length ? counts : undefined;
}

// ─── Execution ────────────────────────────────────────────────────────────

function defaultRunner(command: string, cwd: string, timeoutMs: number) {
  // A shell is required: the configured value is a command line
  // ("nx affected -t test"), not an argv array. It comes from the project's
  // own .planning/config.json — the same trust boundary as every other
  // command GSD runs from that file — and is never model-authored here.
  // The empty argv is deliberate: it is the (command, args, options) overload,
  // so the options object — and its timeout — sits where
  // local/require-subprocess-timeout looks for it. Passing args with
  // shell:true is deprecated (DEP0190); an empty array passes none.
  const res = spawnSync(command, [], {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    error: (res.error as { code?: string } | undefined) || null,
    signal: res.signal || null,
  };
}

/**
 * Run every configured check and return what each one returned.
 *
 * Every check runs even after one fails: the point of the record is the whole
 * picture, and stopping at the first red would make the field `tests: null`
 * indistinguishable from "no test command configured".
 */
function runGates(options: RunGatesOptions): GateResult[] {
  const { cwd, checks } = options;
  const runner = options.runner || defaultRunner;
  const clock = options.clock || Date;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  const results: GateResult[] = [];
  for (const check of checks) {
    const started = clock.now();
    let raw: RawRun;
    try {
      raw = runner(check.command, cwd, timeoutMs);
    } catch (err) {
      // A runner that throws never started the command: the spawn-error rule, with the error's code.
      const code = (err as { code?: string } | null)?.code;
      raw = { status: null, stdout: '', stderr: '', error: { code: code ? String(code) : 'SPAWN_FAILED' }, signal: null };
    }
    const durationMs = clock.now() - started;

    // A check that could not execute is NOT a check that failed. Conflating
    // the two turns "your config names a command that does not exist" into
    // "your code is broken", and the resulting false red is the thing that
    // trains people to ignore the field entirely.
    const { status, cause } = classifyRun(raw);
    const measured = status === CHECK_STATUS.PASS || status === CHECK_STATUS.FAIL;
    // Counts only from a run that answered: a timed-out suite's partial summary is not its result.
    const counts = measured ? parseCounts(`${raw.stdout}\n${raw.stderr}`) : undefined;
    results.push({
      name: check.name,
      command: check.command,
      exitCode: raw.error ? null : raw.status,
      status,
      cause,
      passed: status === CHECK_STATUS.PASS,
      durationMs,
      ...(counts ? { counts } : {}),
    });
  }
  return results;
}

/** Classify one run by the first rule of `CHECK_OUTCOME_RULES` that matches. */
function classifyRun(run: RawRun): { status: CheckStatus; cause: string } {
  for (const rule of CHECK_OUTCOME_RULES) {
    const cause = rule.match(run);
    if (cause !== null) return { status: rule.status, cause };
  }
  // Unreachable: the last rule matches every run. Kept so a reordered table fails safe.
  return { status: CHECK_STATUS.STALE, cause: 'unclassified' };
}

/** A recorded cause in words, for a message a person reads. */
function describeCause(cause: string): string {
  if (cause === 'exit_127') return 'command not found (exit 127)';
  if (cause === 'exit_126') return 'not executable (exit 126)';
  if (cause === 'ETIMEDOUT') return 'timed out';
  if (cause === 'ENOBUFS') return 'output exceeded the capture limit';
  if (cause.startsWith('spawn_')) return `could not start (${cause.slice('spawn_'.length)})`;
  if (cause.startsWith('signal_')) return `killed by ${cause.slice('signal_'.length)}`;
  return cause || 'no cause recorded';
}

/** One check, as a person reads it in a gate message: `tests (exit 1)`, `lint — command not found (exit 127)`. */
function describeCheck(check: { name: string; status: CheckStatus | null; cause: string; exitCode: number | null }): string {
  if (check.status === null) return `${check.name} — the record does not say how it ended`;
  if (check.status === CHECK_STATUS.FAIL) return `${check.name} (exit ${check.exitCode ?? '?'})`;
  if (check.status === CHECK_STATUS.PASS) return check.name;
  return `${check.name} — ${describeCause(check.cause)}`;
}

// ─── Recording ────────────────────────────────────────────────────────────

/**
 * Normalise a check name into a frontmatter key segment.
 *
 * A project may name a check anything ("type-check", "e2e:web"); the key must
 * stay a plain YAML scalar key, so anything outside [a-z0-9_] collapses to an
 * underscore. Collisions are possible in principle ("a-b" and "a.b" both →
 * "a_b") and are resolved by the later check winning, which is the same
 * last-writer-wins rule the config object itself already has.
 */
function keySegment(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'check';
}

/** Shape the results into the frontmatter block a gate predicate can read. */
function buildGatesFrontmatter(results: GateResult[], ranAt: string): GatesFrontmatter {
  const block: GatesFrontmatter = {
    ran_at: ranAt,
    all_passed: false,
    failed: 0,
    stale: 0,
    timed_out: 0,
    ran: [],
  };
  const tally: Record<CheckStatus, number> = { pass: 0, fail: 0, stale: 0, timeout: 0 };

  for (const result of results) {
    // A check that was not measured keeps `all_passed` false — a gate that
    // could not run is not a gate that passed (the same rule autonomous.md
    // applies to loop gates). It is counted under its own status, never under
    // `failed`, so a reader can tell "broken roster" from "broken code"
    // without guessing.
    tally[result.status] += 1;
    const key = keySegment(result.name);
    block.ran.push(result.name);
    block[`${key}_status`] = result.status;
    block[`${key}_passed`] = result.passed;
    block[`${key}_exit_code`] = result.exitCode;
    block[`${key}_ms`] = result.durationMs;
    if (result.cause) block[`${key}_cause`] = result.cause;
    if (result.counts) {
      // `_count` suffix, not the bare count name: `tests` parsing out a
      // `passed: 41` would otherwise write `tests_passed`, which is already
      // the BOOLEAN verdict for that check — and the number silently replaced
      // it, so `gates.tests_passed == true` (the natural gate to write) went
      // from meaning "the suite is green" to meaning "41", which is neither
      // true nor false. Caught while eyeballing the first real output.
      for (const [countName, value] of Object.entries(result.counts)) {
        block[`${key}_${keySegment(countName)}_count`] = value;
      }
    }
  }

  block.failed = tally.fail;
  block.stale = tally.stale;
  block.timed_out = tally.timeout;
  block.all_passed = results.length > 0 && tally.pass === results.length;
  return block;
}

/** One check as a gate reads it back out of a recorded block; `status: null` when the record cannot say. */
interface RecordedCheck {
  name: string;
  status: CheckStatus | null;
  cause: string;
  exitCode: number | null;
}

function isCheckStatus(value: unknown): value is CheckStatus {
  return typeof value === 'string' && (Object.values(CHECK_STATUS) as string[]).includes(value);
}

/** A recorded list: frontmatter hands back an array, or one bare scalar for a one-item list. */
function recordedList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter((s) => s !== '');
  if (typeof value === 'string' && value.trim() !== '') return [value.trim()];
  return [];
}

/**
 * Read the per-check results back out of a recorded block (`gates:` or `baseline:`).
 *
 * extractFrontmatter returns every scalar as a string, so values are compared as strings. A block
 * written before `{name}_status` existed is still read: `_passed: true` is a pass, a legacy
 * `_unrunnable` key is a stale check (its value the cause), and a recorded exit code is a fail. A
 * check named in `ran` with none of these is `status: null` — the record cannot say, and a gate
 * must not guess.
 */
function recordedChecks(block: Record<string, unknown>): RecordedCheck[] {
  return recordedList(block['ran']).map((name) => {
    const key = keySegment(name);
    const exitRaw = block[`${key}_exit_code`];
    const exitNum = exitRaw === null || exitRaw === undefined || exitRaw === 'null' || exitRaw === '' ? NaN : Number(exitRaw);
    const exitCode = Number.isInteger(exitNum) ? exitNum : null;
    const status = block[`${key}_status`];
    const cause = block[`${key}_cause`];
    if (isCheckStatus(status)) return { name, status, cause: typeof cause === 'string' ? cause : '', exitCode };
    const legacyUnrunnable = block[`${key}_unrunnable`];
    if (String(block[`${key}_passed`]) === 'true') return { name, status: CHECK_STATUS.PASS, cause: '', exitCode };
    if (typeof legacyUnrunnable === 'string' && legacyUnrunnable !== '') {
      return { name, status: CHECK_STATUS.STALE, cause: legacyUnrunnable, exitCode };
    }
    if (exitCode !== null) return { name, status: CHECK_STATUS.FAIL, cause: '', exitCode };
    return { name, status: null, cause: '', exitCode };
  });
}

/** Recorded checks sorted by the verdict their status maps to (`CHECK_STATUS_VERDICT`). */
interface CheckJudgement {
  passed: RecordedCheck[];
  /** Measured red — a finding about the code. */
  red: RecordedCheck[];
  /** Not measured (stale, timeout) — could not check. */
  unmeasured: RecordedCheck[];
  /** Named in `ran` but unreadable. */
  unreadable: RecordedCheck[];
}

function judgeRecordedChecks(checks: readonly RecordedCheck[]): CheckJudgement {
  const judgement: CheckJudgement = { passed: [], red: [], unmeasured: [], unreadable: [] };
  for (const check of checks) {
    if (check.status === null) judgement.unreadable.push(check);
    else if (CHECK_STATUS_VERDICT[check.status] === 'pass') judgement.passed.push(check);
    else if (CHECK_STATUS_VERDICT[check.status] === 'finding') judgement.red.push(check);
    else judgement.unmeasured.push(check);
  }
  return judgement;
}

/**
 * Write the block into VERIFICATION.md's frontmatter, creating the file when
 * the verifier has not written it yet.
 *
 * Writing BEFORE the verifier runs is the intended order: the agent should
 * read numbers it did not produce. A later verifier write must preserve them,
 * which is why this uses spliceFrontmatter (key-level) rather than rewriting
 * the document.
 */
function recordGates(
  verificationPath: string,
  gates: GatesFrontmatter
): { created: boolean } {
  return recordVerificationBlock(verificationPath, 'gates', gates);
}

/**
 * Write one top-level frontmatter block (`gates:`, `mutation:`) into a phase's VERIFICATION.md,
 * creating the file when the verifier has not written it yet. Key-level (spliceFrontmatter), so
 * every other key — the verifier's, or another recorder's block — is preserved.
 */
function recordVerificationBlock(
  verificationPath: string,
  key: string,
  block: Record<string, unknown>
): { created: boolean } {
  // No `status` key in the seed: the verifier has not run, and only the
  // verifier writes a status. Upstream's closed VerificationStatus
  // (src/verification.cts, reportStatusOf) accepts only passed | gaps_found |
  // human_needed and throws on anything else — `pending` included — while an
  // absent status routes to `missing`, "the verify step never ran", which is
  // exactly this state.
  return recordFrontmatterBlock(verificationPath, key, block, {
    suffix: '-VERIFICATION.md',
    body: '# Verification Report\n\nGate results were recorded before verification ran.\n',
  });
}

/**
 * Write one top-level frontmatter block into a phase artifact, creating the artifact from `seed`
 * (a `phase:` key named for the file, then `seed.body`) when it does not exist yet. Key-level, so
 * every other key and the body are preserved.
 */
function recordFrontmatterBlock(
  filePath: string,
  key: string,
  block: Record<string, unknown>,
  seed: { suffix: string; body: string }
): { created: boolean } {
  let content = '';
  let created = false;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    created = true;
    const phase = path.basename(filePath).slice(0, -seed.suffix.length);
    content = `---\nphase: ${phase}\n---\n\n${seed.body}`;
  }

  const existing = extractFrontmatter(content);
  // A one-level block of scalars and scalar lists is a FrontmatterValue map; the writer refuses
  // anything deeper at runtime.
  const updated = { ...existing, [key]: block };
  fs.writeFileSync(filePath, spliceFrontmatter(content, updated));
  return { created };
}

/**
 * The phase's VERIFICATION.md is named for the phase directory: a directory
 * `03-ports` holds `03-VERIFICATION.md` (the phase number, not the full
 * directory name) — matching what the verifier writes.
 */
function verificationPathFor(phaseDir: string): string {
  return phaseArtifactPath(phaseDir, 'VERIFICATION.md');
}

/** `{phase number}-{name}` inside the phase directory — the naming every phase artifact follows. */
function phaseArtifactPath(phaseDir: string, name: string): string {
  const phaseName = path.basename(phaseDir);
  const phaseNum = /^(\d+(?:\.\d+)?[a-z]?)/.exec(phaseName)?.[1] || phaseName;
  return path.join(phaseDir, `${phaseNum}-${name}`);
}

// ─── Configuration ────────────────────────────────────────────────────────

/**
 * Read the check roster from `.planning/config.json`.
 *
 * `workflow.verify_gates` is an object of name → command line. It is empty by
 * default: only the project knows what its own green looks like, and inventing
 * a default (`npm test`) would produce an unrunnable check on most projects,
 * which is worse than no check at all.
 *
 * The key is declared `string-map`, so `config-set` stores a real object. A
 * string holding that object as JSON text is still read: it is what the key
 * had to be when the capability config schema admitted scalars only, and a
 * config written then must not start refusing.
 *
 * The file is read raw rather than through loadConfig, which replaces a
 * wrong-typed value with the default `{}` — that is exactly the collapse of
 * "malformed" into "nothing configured" this reader exists to prevent.
 *
 * Absent, null, an empty string and an empty object all mean "nothing
 * configured". Anything else that does not resolve to an object of non-empty
 * command lines is a problem the caller reports as such: dropping a
 * malformed entry would let half a roster stand in for the whole one, and
 * collapsing a typo into "nothing configured" hides the setting the user wrote.
 */
function readChecks(cwd: string): ChecksConfig {
  let text: string;
  try {
    text = fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8');
  } catch (err) {
    if ((err as { code?: string } | null)?.code === 'ENOENT') return { ok: true, checks: [] };
    return { ok: false, problems: [`.planning/config.json could not be read: ${(err as Error).message}`] };
  }
  let cfg: unknown;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    return { ok: false, problems: [`.planning/config.json is not valid JSON: ${(err as Error).message}`] };
  }
  const workflow = cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>)['workflow'] : undefined;
  let raw = workflow && typeof workflow === 'object' ? (workflow as Record<string, unknown>)['verify_gates'] : undefined;
  if (raw === undefined || raw === null) return { ok: true, checks: [] };

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: true, checks: [] };
    try {
      raw = JSON.parse(trimmed);
    } catch (err) {
      return { ok: false, problems: [`workflow.verify_gates is not valid JSON: ${(err as Error).message}`] };
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const got = Array.isArray(raw) ? 'an array' : raw === null ? 'null' : `a ${typeof raw}`;
    return {
      ok: false,
      problems: [`workflow.verify_gates must be an object of check name → command line, got ${got}`],
    };
  }

  const checks: GateCheck[] = [];
  const problems: string[] = [];
  for (const [name, command] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof command === 'string' && command.trim()) {
      checks.push({ name, command: command.trim() });
    } else {
      problems.push(`workflow.verify_gates.${name} must be a non-empty command line, got ${JSON.stringify(command)}`);
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, checks };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

interface CmdOptions {
  strict?: boolean;
  runner?: RunGatesOptions['runner'];
  clock?: { now(): number };
  /** Injected for tests so the recorded timestamp is deterministic. */
  timestamp?: string;
  /**
   * A phase NUMBER (`--phase 3`), resolved to its directory the way
   * `find-phase` resolves it. This is the form the shared loop-hook dispatcher
   * calls a command step with (`gsd_run <ref.command> --phase N --raw`, see
   * references/loop-hook-dispatch.md § step) — it never passes a path.
   */
  phase?: string;
}

/**
 * `gsd_run verify gates <phase-dir> [--strict]`
 * `gsd_run verify gates --phase <N> [--strict]`   (the dispatcher's form)
 *
 * Exit codes:
 *   0  the results were recorded (whatever they say)
 *   1  a check failed AND --strict was passed
 *   2  the results could not be recorded, or nothing was configured to run
 *  69  workflow.verify_gates is set but malformed (UNAVAILABLE, ADR-3889)
 *
 * The default 0-on-red is deliberate; see the module header.
 */
function cmdVerifyGates(
  cwd: string,
  phaseDirArg: string | undefined,
  raw: boolean,
  options: CmdOptions = {}
): void {
  const emit = (payload: Record<string, unknown>, exitCode: number) => {
    if (raw) {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    }
    process.exitCode = exitCode;
  };

  const target = resolveRecorderPhase(cwd, phaseDirArg, options.phase, 'Usage: verify gates <phase-dir> | --phase <N> [--strict]');
  if (!target.ok) {
    emit(target.payload, target.exitCode);
    return;
  }
  const { phaseDir } = target;

  const roster = resolveRoster(cwd);
  if (!roster.ok) {
    emit(roster.payload, roster.exitCode);
    return;
  }
  const { checks } = roster;

  const results = runGates({ cwd, phaseDir, checks, runner: options.runner, clock: options.clock });
  const ranAt = options.timestamp || new Date().toISOString();
  const gates = buildGatesFrontmatter(results, ranAt);

  const verificationPath = verificationPathFor(phaseDir);

  let created = false;
  try {
    created = recordGates(verificationPath, gates).created;
  } catch (err) {
    // The results are echoed even though they could not be persisted: they
    // were genuinely measured, and losing them because the file was unwritable
    // would waste the run and leave the caller with nothing to act on.
    emit(
      {
        ok: false,
        reason: 'record_failed',
        verificationPath,
        error: (err as { code?: string } | null)?.code || 'UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
        gates,
      },
      2
    );
    return;
  }

  // --strict propagates anything short of green: a check that could not run
  // has not shown the code is fine either.
  const strictFailure = Boolean(options.strict) && !gates.all_passed;
  emit(
    {
      ok: true,
      verificationPath,
      created,
      allPassed: gates.all_passed,
      failed: gates.failed,
      stale: gates.stale,
      timedOut: gates.timed_out,
      ran: gates.ran,
      // The full per-check detail, keyed as it was written, so a caller reading
      // stdout sees exactly what a gate will read from the file.
      gates,
      // The raw results carry what the flattened block deliberately drops (the
      // command line itself), for a human reading a failure.
      results: resultsPayload(results),
      warnings: unmeasuredWarnings(results),
    },
    strictFailure ? 1 : 0
  );
}

/** Per-check detail for a recorder's stdout. */
function resultsPayload(results: readonly GateResult[]): Array<Record<string, unknown>> {
  return results.map((r) => ({
    name: r.name,
    command: r.command,
    status: r.status,
    exitCode: r.exitCode,
    passed: r.passed,
    ...(r.cause ? { cause: r.cause } : {}),
  }));
}

/**
 * One line per check that was not measured, naming the command and what to do. A stale check is
 * a roster problem, not a code problem, and it is printed as one — the warning is the difference
 * between "repair the config" and a red the reader learns to ignore.
 */
function unmeasuredWarnings(
  results: readonly GateResult[]
): Array<{ check: string; status: CheckStatus; cause: string; setting: string; message: string }> {
  return results
    .filter((r) => r.status === CHECK_STATUS.STALE || r.status === CHECK_STATUS.TIMEOUT)
    .map((r) => ({
      check: r.name,
      status: r.status,
      cause: r.cause,
      setting: `workflow.verify_gates.${r.name}`,
      message:
        r.status === CHECK_STATUS.TIMEOUT
          ? `check "${r.name}" timed out — not measured; raise its budget or split it (\`${r.command}\`)`
          : `check "${r.name}" is stale or cannot run here — ${describeCause(r.cause)}; repair workflow.verify_gates.${r.name} (\`${r.command}\`)`,
    }));
}

type Refusal = { ok: false; payload: Record<string, unknown>; exitCode: number };

/**
 * Which phase a recorder writes into: a directory argument, or `--phase <N>` (the step
 * dispatcher's form). Shared by `verify gates` and `verify baseline`.
 */
function resolveRecorderPhase(
  cwd: string,
  phaseDirArg: string | undefined,
  phase: string | undefined,
  usage: string
): { ok: true; phaseDir: string } | Refusal {
  if (phaseDirArg && phase) {
    // Two answers to "which phase" is a caller bug; picking one silently would
    // record a run into a directory the other half of the caller never meant.
    return { ok: false, payload: { ok: false, reason: 'conflicting_phase_args', message: usage }, exitCode: 2 };
  }
  if (!phaseDirArg && !phase) {
    return { ok: false, payload: { ok: false, reason: 'missing_phase_dir', message: usage }, exitCode: 2 };
  }

  let phaseDir: string;
  if (phase) {
    // The dispatcher hands over a number, never a path. Resolving it here —
    // rather than path.resolve(cwd, '3') — is the difference between recording
    // the run and refusing with phase_dir_not_found on every dispatch, which
    // an onError:skip step would swallow without a trace.
    const found = findPhaseInternal(cwd, phase);
    if (!found || !found.found || !found.directory) {
      return {
        ok: false,
        payload: {
          ok: false,
          reason: 'phase_not_found',
          phase,
          ...(found?.ambiguous_matches?.length ? { ambiguous_matches: found.ambiguous_matches } : {}),
        },
        exitCode: 2,
      };
    }
    phaseDir = path.resolve(cwd, found.directory);
  } else {
    phaseDir = path.resolve(cwd, phaseDirArg as string);
  }
  if (!fs.existsSync(phaseDir)) {
    return { ok: false, payload: { ok: false, reason: 'phase_dir_not_found', phaseDir }, exitCode: 2 };
  }
  return { ok: true, phaseDir };
}

/** The roster a recorder runs, or the refusal to print. Shared by `verify gates` and `verify baseline`. */
function resolveRoster(cwd: string): { ok: true; checks: GateCheck[] } | Refusal {
  const config = readChecks(cwd);
  if (!config.ok) {
    // UNAVAILABLE, the registry's "could not run — input unreadable" (ADR-3889),
    // the same outcome core gives an unparseable config.json. It is not the
    // no_checks_configured refusal: the user did configure something, and
    // telling them to add a setting they already wrote is the wrong advice.
    return {
      ok: false,
      payload: {
        ok: false,
        reason: 'invalid_checks_config',
        problems: config.problems,
        message:
          'workflow.verify_gates is set but cannot be run. It takes an object of check name → command line, ' +
          `e.g. gsd_run query config-set workflow.verify_gates '{"tests":"npm test"}'.`,
      },
      exitCode: projectOutcome('UNAVAILABLE', getContractVersion()),
    };
  }
  if (config.checks.length === 0) {
    // Refusing rather than passing: "no checks configured" recorded as
    // all_passed:true would be a green field that proves nothing, and a gate
    // reading it would report success for a project that ran nothing at all.
    return {
      ok: false,
      payload: {
        ok: false,
        reason: 'no_checks_configured',
        message:
          'workflow.verify_gates names no commands. Set it with e.g. ' +
          `gsd_run query config-set workflow.verify_gates '{"tests":"npm test","typecheck":"npx tsc --noEmit"}' — ` +
          'recording "no checks" as a pass would be a green field that proves nothing.',
      },
      exitCode: 2,
    };
  }
  return { ok: true, checks: config.checks };
}

export = {
  cmdVerifyGates,
  runGates,
  classifyRun,
  buildGatesFrontmatter,
  recordGates,
  recordVerificationBlock,
  recordFrontmatterBlock,
  verificationPathFor,
  phaseArtifactPath,
  readChecks,
  parseCounts,
  recordedChecks,
  recordedList,
  judgeRecordedChecks,
  describeCheck,
  describeCause,
  resultsPayload,
  unmeasuredWarnings,
  resolveRecorderPhase,
  resolveRoster,
  CHECK_STATUS,
  CHECK_STATUS_VERDICT,
  CHECK_OUTCOME_RULES,
};
