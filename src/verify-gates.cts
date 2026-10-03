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

// ─── Types ────────────────────────────────────────────────────────────────

interface GateCheck {
  /** Key under `gates:` — `tests`, `typecheck`, `lint`, or a project's own. */
  name: string;
  /** The command line, exactly as configured. */
  command: string;
}

interface GateResult {
  name: string;
  command: string;
  /** null when the command could not be executed at all. */
  exitCode: number | null;
  passed: boolean;
  /** Populated only when the command could not run — never on a red check. */
  unrunnable?: string;
  durationMs: number;
  /** Parsed counts, when the output states them in a recognised shape. */
  counts?: Record<string, number>;
}

interface RunGatesOptions {
  cwd: string;
  phaseDir: string;
  checks: GateCheck[];
  /** Injected for tests; defaults to a real spawn. */
  runner?: (command: string, cwd: string, timeoutMs: number) => {
    status: number | null;
    stdout: string;
    stderr: string;
    error: { code?: string } | null;
    signal: string | null;
  };
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
 * Per-check keys are `{name}_exit_code`, `{name}_passed`, `{name}_ms`, plus
 * any parsed counts as `{name}_{count}` (e.g. `tests_passed_count`).
 */
interface GatesFrontmatter {
  ran_at: string;
  all_passed: boolean;
  failed: number;
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
    let raw;
    try {
      raw = runner(check.command, cwd, timeoutMs);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      results.push({
        name: check.name,
        command: check.command,
        exitCode: null,
        passed: false,
        unrunnable: code ? String(code) : 'SPAWN_FAILED',
        durationMs: clock.now() - started,
      });
      continue;
    }

    const durationMs = clock.now() - started;

    // A check that could not execute is NOT a check that failed. Conflating
    // the two turns "your config names a command that does not exist" into
    // "your code is broken", and the resulting false red is the thing that
    // trains people to ignore the field entirely.
    if (raw.error || raw.status === null) {
      results.push({
        name: check.name,
        command: check.command,
        exitCode: null,
        passed: false,
        unrunnable: raw.signal || raw.error?.code || 'UNKNOWN',
        durationMs,
      });
      continue;
    }

    const output = `${raw.stdout}\n${raw.stderr}`;
    const counts = parseCounts(output);
    results.push({
      name: check.name,
      command: check.command,
      exitCode: raw.status,
      passed: raw.status === 0,
      durationMs,
      ...(counts ? { counts } : {}),
    });
  }
  return results;
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
    ran: [],
  };
  let failed = 0;

  for (const result of results) {
    // An unrunnable check counts as failed for `all_passed` — a gate that
    // could not run is not a gate that passed (the same rule autonomous.md
    // applies to loop gates). It stays distinguishable in the record by its
    // null exit code and its `_unrunnable` key, so a reader can tell "broken
    // config" from "broken code" without guessing.
    if (!result.passed) failed += 1;
    const key = keySegment(result.name);
    block.ran.push(result.name);
    block[`${key}_passed`] = result.passed;
    block[`${key}_exit_code`] = result.exitCode;
    block[`${key}_ms`] = result.durationMs;
    if (result.unrunnable) block[`${key}_unrunnable`] = result.unrunnable;
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

  block.failed = failed;
  block.all_passed = failed === 0 && results.length > 0;
  return block;
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
  let content = '';
  let created = false;
  try {
    content = fs.readFileSync(verificationPath, 'utf8');
  } catch {
    created = true;
    const phase = path.basename(verificationPath).replace(/-VERIFICATION\.md$/, '');
    // No `status` key: the verifier has not run, and only the verifier writes a
    // status. Upstream's closed VerificationStatus (src/verification.cts,
    // reportStatusOf) accepts only passed | gaps_found | human_needed and throws
    // on anything else — `pending` included — while an absent status routes to
    // `missing`, "the verify step never ran", which is exactly this state.
    content = `---\nphase: ${phase}\n---\n\n# Verification Report\n\nGate results were recorded before verification ran.\n`;
  }

  const existing = extractFrontmatter(content) as Record<string, unknown>;
  const updated = { ...existing, gates };
  fs.writeFileSync(verificationPath, spliceFrontmatter(content, updated));
  return { created };
}

// ─── Configuration ────────────────────────────────────────────────────────

/**
 * Read the check roster from `.planning/config.json`.
 *
 * `workflow.verify_gates` is an object of name → command line. It is empty by
 * default: only the project knows what its own green looks like, and inventing
 * a default (`npm test`) would produce an unrunnable check on most projects,
 * which is worse than no check at all.
 */
function readChecks(cwd: string): GateCheck[] {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(cwd, '.planning', 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return [];
  }
  const workflow = (cfg['workflow'] || {}) as Record<string, unknown>;
  let raw = workflow['verify_gates'];

  // Both shapes are accepted. The capability config schema admits boolean,
  // string, number and enum only, so the key is DECLARED as a string holding
  // JSON — but a hand-written config.json will naturally carry a real object,
  // and rejecting that would make the command silently refuse on a config that
  // reads as perfectly correct.
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      raw = JSON.parse(trimmed);
    } catch {
      return [];
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const checks: GateCheck[] = [];
  for (const [name, command] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof command === 'string' && command.trim()) {
      checks.push({ name, command: command.trim() });
    }
  }
  return checks;
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

  const usage = 'Usage: verify gates <phase-dir> | --phase <N> [--strict]';
  if (phaseDirArg && options.phase) {
    // Two answers to "which phase" is a caller bug; picking one silently would
    // record a run into a directory the other half of the caller never meant.
    emit({ ok: false, reason: 'conflicting_phase_args', message: usage }, 2);
    return;
  }
  if (!phaseDirArg && !options.phase) {
    emit({ ok: false, reason: 'missing_phase_dir', message: usage }, 2);
    return;
  }

  let phaseDir: string;
  if (options.phase) {
    // The dispatcher hands over a number, never a path. Resolving it here —
    // rather than path.resolve(cwd, '3') — is the difference between recording
    // the run and refusing with phase_dir_not_found on every dispatch, which
    // an onError:skip step would swallow without a trace.
    const found = findPhaseInternal(cwd, options.phase);
    if (!found || !found.found || !found.directory) {
      emit(
        {
          ok: false,
          reason: 'phase_not_found',
          phase: options.phase,
          ...(found?.ambiguous_matches?.length ? { ambiguous_matches: found.ambiguous_matches } : {}),
        },
        2
      );
      return;
    }
    phaseDir = path.resolve(cwd, found.directory);
  } else {
    phaseDir = path.resolve(cwd, phaseDirArg as string);
  }
  if (!fs.existsSync(phaseDir)) {
    emit({ ok: false, reason: 'phase_dir_not_found', phaseDir }, 2);
    return;
  }

  const checks = readChecks(cwd);
  if (checks.length === 0) {
    // Refusing rather than passing: "no checks configured" recorded as
    // all_passed:true would be a green field that proves nothing, and a gate
    // reading it would report success for a project that ran nothing at all.
    emit(
      {
        ok: false,
        reason: 'no_checks_configured',
        message:
          'workflow.verify_gates names no commands. Add e.g. {"tests":"npm test","typecheck":"npx tsc --noEmit"} — ' +
          'recording "no checks" as a pass would be a green field that proves nothing.',
      },
      2
    );
    return;
  }

  const results = runGates({ cwd, phaseDir, checks, runner: options.runner, clock: options.clock });
  const ranAt = options.timestamp || new Date().toISOString();
  const gates = buildGatesFrontmatter(results, ranAt);

  // The phase's VERIFICATION.md is named for the phase directory: a directory
  // `03-ports` holds `03-VERIFICATION.md` (the phase number, not the full
  // directory name) — matching what the verifier writes.
  const phaseName = path.basename(phaseDir);
  const phaseNum = /^(\d+(?:\.\d+)?[a-z]?)/.exec(phaseName)?.[1] || phaseName;
  const verificationPath = path.join(phaseDir, `${phaseNum}-VERIFICATION.md`);

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

  const strictFailure = Boolean(options.strict) && gates.failed > 0;
  emit(
    {
      ok: true,
      verificationPath,
      created,
      allPassed: gates.all_passed,
      failed: gates.failed,
      ran: gates.ran,
      // The full per-check detail, keyed as it was written, so a caller reading
      // stdout sees exactly what a gate predicate will read from the file.
      gates,
      // The raw results carry what the flattened block deliberately drops (the
      // command line itself), for a human reading a failure.
      results: results.map((r) => ({
        name: r.name,
        command: r.command,
        exitCode: r.exitCode,
        passed: r.passed,
        ...(r.unrunnable ? { unrunnable: r.unrunnable } : {}),
      })),
    },
    strictFailure ? 1 : 0
  );
}

export = {
  cmdVerifyGates,
  runGates,
  buildGatesFrontmatter,
  recordGates,
  readChecks,
  parseCounts,
};
