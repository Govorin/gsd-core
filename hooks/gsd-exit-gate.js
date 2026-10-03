#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Executor Exit Gate — SubagentStop hook (mn fork)
//
// Problem: an executor decides for itself when its work is done. The GSD
// pipeline then verifies that decision two steps later — code-review at
// execute:post, verifier at verify — by which point the commits are in history
// and a failing typecheck is a revert, not an edit. The measured shape of this
// in the fork's own projects: ~80% of sampled SUMMARY.md files carry a
// deviation, and several say the plan's own snippet did not compile.
//
// The cheapest possible verifier already exists in these projects and is not
// consulted: `lefthook run pre-commit`, `nx affected -t lint,typecheck`, 99
// custom oxlint rules, 40+ self-testing check scripts. They are deterministic,
// they are fast, and their verdict does not depend on an agent's self-report.
// This hook runs them when the executor tries to finish, and refuses the exit
// while they fail — the "near-perfect verifier" advice applied at the layer
// where it is actually near-perfect.
//
// Prior art in this fork's own environment: mn/.claude/hooks/quality-gate.sh,
// hand-written for exactly this purpose. Two of its lessons are load-bearing
// here and are reproduced deliberately:
//   • scope to the tree the agent worked in (`git rev-parse --show-toplevel`
//     from the payload cwd), never to the project root: agents run in
//     worktrees, and judging one against the main checkout's uncommitted WIP
//     reported 19 files across 9 projects as a single agent's failure;
//   • pre-existing breakage must not be attributed to this agent — hence the
//     retry budget below, after which the gate escalates to a human instead of
//     looping an executor against debt it did not create.
//
// Applicability (must positively determine all of these — otherwise inert):
//   1. this is a GSD project (`.planning/` resolves from the payload cwd),
//   2. `workflow.exit_gate` names a command (absent → inert; the gate is
//      opt-in because only the project knows what "green" means for it),
//   3. the stopping subagent is an executor — `gsd-executor` by default,
//      configurable via `workflow.exit_gate_agents`,
//   4. the retry budget for this phase is not exhausted.
//
// Decision:
//   command exits 0        → allow the stop (exit 0)
//   command exits non-zero → block the stop (exit 2) with the command's own
//                            tail on stderr, so the agent fixes against real
//                            output rather than a paraphrase
//   budget exhausted       → allow the stop, with a systemMessage saying the
//                            gate stayed red. An executor looped forever
//                            against pre-existing debt is worse than one that
//                            hands a red tree to the verifier, which is built
//                            to report exactly that.
//
// The retry ledger lives at `.planning/.exit-gate-state.json`, keyed by phase
// and worktree, so a fresh phase starts with a fresh budget and two worktrees
// running in parallel do not consume each other's.
//
// Fail-open by construction: no `.planning/`, no configured command, a
// non-executor subagent, a spawn failure (ENOENT on the command, a timeout) —
// all allow the stop. A gate that cannot run must not become a wall; that
// distinction matters because unlike a PreToolUse guard, blocking here can
// strand a session with no path forward.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');

/** Default executor identity. Overridable per project. */
const DEFAULT_AGENTS = ['gsd-executor'];
/** Default retries before the gate steps aside (see header). */
const DEFAULT_MAX_RETRIES = 3;
/** Default per-run wall clock. Long enough for `nx affected -t typecheck`. */
const DEFAULT_TIMEOUT_MS = 600000;
/** How much of the command's output the blocked agent is shown. */
const TAIL_LIMIT = 6000;

const STATE_FILE = '.exit-gate-state.json';

function findPlanningRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(path.join(dir, '.planning'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Read the gate's configuration. A missing command means the gate is off. */
function readConfig(planningRoot) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(planningRoot, '.planning', 'config.json'), 'utf8'));
  } catch {
    return null; // opt-in: an unreadable config cannot have opted in
  }
  const workflow = cfg && typeof cfg === 'object' ? cfg.workflow : null;
  if (!workflow || typeof workflow !== 'object') return null;

  const command = workflow.exit_gate;
  if (typeof command !== 'string' || !command.trim()) return null;

  // Both shapes are accepted. The capability config schema admits boolean,
  // string, number and enum only, so the declared type is a comma-separated
  // string — but a hand-written config.json may perfectly reasonably carry a
  // YAML/JSON list, and rejecting that would be a silent inertness rather than
  // an error the author can see.
  const rawAgents = workflow.exit_gate_agents;
  let agents = DEFAULT_AGENTS;
  if (typeof rawAgents === 'string' && rawAgents.trim()) {
    const parsed = rawAgents
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    if (parsed.length) agents = parsed;
  } else if (Array.isArray(rawAgents)) {
    const parsed = rawAgents.filter((a) => typeof a === 'string' && a.trim()).map((a) => a.trim());
    if (parsed.length) agents = parsed;
  }

  const rawRetries = workflow.exit_gate_max_retries;
  const maxRetries =
    Number.isInteger(rawRetries) && rawRetries >= 0 ? rawRetries : DEFAULT_MAX_RETRIES;

  const rawTimeout = workflow.exit_gate_timeout;
  // Configured in seconds (the unit every other GSD timeout key uses), held in ms.
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0 ? Math.round(rawTimeout * 1000) : DEFAULT_TIMEOUT_MS;

  return { command: command.trim(), agents, maxRetries, timeoutMs };
}

/**
 * The tree the subagent actually worked in.
 *
 * `git rev-parse --show-toplevel` from the payload's cwd, so a worktree reports
 * itself rather than the main checkout (quality-gate.sh's first lesson). Falls
 * back to the planning root when git cannot answer.
 */
function resolveWorkTree(cwd, planningRoot) {
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const top = out.trim();
    if (top) return top;
  } catch {
    /* not a git tree, or git is unavailable */
  }
  return planningRoot;
}

/** Current phase id, for keying the retry ledger. Unknown → a stable literal. */
function currentPhase(planningRoot) {
  try {
    const text = fs.readFileSync(path.join(planningRoot, '.planning', 'STATE.md'), 'utf8');
    const m = /^current_phase:\s*(.+?)\s*$/m.exec(text);
    if (m) {
      const v = m[1].replace(/^['"]|['"]$/g, '').trim();
      if (v && v !== 'null' && v !== 'none') return v;
    }
  } catch {
    /* no STATE.md */
  }
  return 'unknown';
}

function ledgerPath(planningRoot) {
  return path.join(planningRoot, '.planning', STATE_FILE);
}

function readLedger(planningRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(planningRoot), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLedger(planningRoot, ledger) {
  try {
    fs.writeFileSync(ledgerPath(planningRoot), `${JSON.stringify(ledger, null, 2)}\n`);
  } catch {
    /* a ledger that cannot be written costs retries, never correctness */
  }
}

/** Keep the last `TAIL_LIMIT` characters — failures print at the end. */
function tail(text) {
  if (typeof text !== 'string' || !text) return '';
  return text.length <= TAIL_LIMIT ? text : `…\n${text.slice(-TAIL_LIMIT)}`;
}

/**
 * Decide one SubagentStop payload.
 *
 * Pure apart from the command it is asked to run and the ledger it keeps:
 * `runner` and `now` are injectable so tests drive them without spawning
 * anything or racing a real clock (the repo's clock-seam convention).
 *
 * Returns `{ action: 'allow' }` or
 * `{ action: 'block', reason, exitCode, output, attempt, maxRetries }`.
 */
function evaluateStop(data, options = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow' };

  const cwd = options.cwd || data.cwd || process.cwd();
  const planningRoot = findPlanningRoot(cwd);
  if (!planningRoot) return { action: 'allow' };

  const config = readConfig(planningRoot);
  if (!config) return { action: 'allow' }; // gate not configured

  // Which subagent is stopping. Payload field names differ across hosts, so
  // read the ones that exist rather than assuming a single spelling.
  const identity =
    (typeof data.subagent_type === 'string' && data.subagent_type) ||
    (typeof data.agent_type === 'string' && data.agent_type) ||
    (typeof data.agent_name === 'string' && data.agent_name) ||
    '';
  if (!identity || !config.agents.includes(identity)) return { action: 'allow' };

  const workTree = resolveWorkTree(cwd, planningRoot);
  const phase = currentPhase(planningRoot);
  const key = `${phase}::${workTree}`;

  const ledger = readLedger(planningRoot);
  const entry = ledger[key] && typeof ledger[key] === 'object' ? ledger[key] : { attempts: 0 };
  const attempts = Number.isInteger(entry.attempts) ? entry.attempts : 0;

  // The budget governs the VERDICT, never whether the check runs. Skipping the
  // run once the budget is spent looked cheaper, and was a defect: the ledger
  // could then never be cleared, because only a green run clears it and no run
  // happened. One red phase would disarm the gate permanently, for every later
  // phase in that worktree, with nothing on screen to say so. The command is
  // cheap relative to a session; the wrong answer is not.
  const budgetSpent = attempts >= config.maxRetries;

  const runner =
    options.runner ||
    ((command, execCwd, timeoutMs) => {
      // A shell is required: the configured value is a command line
      // ("lefthook run pre-commit", "nx affected -t lint,typecheck"), not an
      // argv array. It comes from the project's own config.json — the same
      // trust boundary as every other command GSD runs from that file — and is
      // never model-authored at this point.
      const res = spawnSync(command, {
        cwd: execCwd,
        shell: true,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true, // shell:true would otherwise flash a console window (#685)
      });
      return {
        status: res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        error: res.error || null,
        signal: res.signal || null,
      };
    });

  let result;
  try {
    result = runner(config.command, workTree, config.timeoutMs);
  } catch (err) {
    return {
      action: 'allow',
      spawnError: err && err.code ? String(err.code) : 'UNKNOWN',
      reason:
        `Exit gate: could not run '${config.command}' (${err && err.message ? err.message : 'spawn failed'}). ` +
        `A gate that cannot run does not become a wall — the stop is allowed.`,
    };
  }

  // A gate that could not execute (command missing, killed by timeout) is not a
  // gate that failed. Distinguishing these is the difference between "fix your
  // code" and "fix your config", and conflating them trains people to disable it.
  if (result.error || result.status === null) {
    const why = result.signal
      ? `terminated by ${result.signal} (timeout is workflow.exit_gate_timeout=${Math.round(config.timeoutMs / 1000)}s)`
      : `could not be executed (${result.error && result.error.code ? result.error.code : 'unknown'})`;
    return {
      action: 'allow',
      spawnError: result.signal || (result.error && result.error.code) || 'UNKNOWN',
      reason: `Exit gate: '${config.command}' ${why}. The stop is allowed; fix the gate's configuration.`,
    };
  }

  if (result.status === 0) {
    // Green: clear the ledger so the next phase starts fresh.
    if (ledger[key]) {
      delete ledger[key];
      writeLedger(planningRoot, ledger);
    }
    return { action: 'allow', passed: true, command: config.command };
  }

  const attempt = attempts + 1;
  ledger[key] = { attempts: attempt, command: config.command, exitCode: result.status };
  writeLedger(planningRoot, ledger);

  const output = tail(`${result.stdout}${result.stdout && result.stderr ? '\n' : ''}${result.stderr}`);

  // Budget spent: report, do not block. Looping an executor against breakage it
  // may not own burns the session and produces no record; a red tree handed to
  // verification is exactly what the verifier is built to report.
  if (budgetSpent) {
    return {
      action: 'allow',
      exhausted: true,
      exitCode: result.status,
      output,
      attempt: attempts,
      maxRetries: config.maxRetries,
      command: config.command,
      workTree,
      reason:
        `Exit gate: '${config.command}' still fails (exit ${result.status}) in '${workTree}' after ` +
        `${attempts} blocked attempt(s) — the retry budget ` +
        `(workflow.exit_gate_max_retries=${config.maxRetries}) is spent, so the stop is allowed ` +
        `and the failure travels to verification rather than looping here. It is not fixed:\n\n${output}`,
    };
  }

  const reason =
    `Exit gate: '${config.command}' failed with exit ${result.status} in '${workTree}' ` +
    `(attempt ${attempt} of ${config.maxRetries}). The work is not finished while the project's ` +
    `own checks are red. Fix the failures below and stop again — do not disable the check, ` +
    `narrow its scope, or delete the assertions it runs.\n\n${output}`;

  return {
    action: 'block',
    reason,
    exitCode: result.status,
    output,
    attempt,
    maxRetries: config.maxRetries,
    command: config.command,
    workTree,
  };
}

/* istanbul ignore next -- stdin adapter, exercised via the process seam in tests */
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => allow(undefined), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    let decision;
    try {
      decision = evaluateStop(JSON.parse(input));
    } catch {
      crash(HOOK_ON_CRASH.ALLOW, undefined); // malformed payload must never strand a session
    }
    if (!decision) allow(undefined);

    if (decision.action === 'block') {
      const output = {
        decision: 'block',
        reason: decision.reason,
        exitCode: decision.exitCode,
        attempt: decision.attempt,
        maxRetries: decision.maxRetries,
        command: decision.command,
      };
      // JSON on fd 1, the plain reason on fd 2 (the host reads stderr on exit 2).
      deny(output, decision.reason);
    }

    // Allowed, but worth saying so: an exhausted budget or an unrunnable gate is
    // information the session should carry into verification.
    allow(decision.reason ? { systemMessage: decision.reason } : undefined);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateStop,
  readConfig,
  findPlanningRoot,
  resolveWorkTree,
  currentPhase,
};
