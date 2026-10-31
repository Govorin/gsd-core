/**
 * worktree-guard.cts — the worktree guards as typed CLI verbs (ADR-5211).
 *
 * `gsd-tools worktree guard <stage> …` and `gsd-tools worktree plan-ledger …`.
 *
 * ## Why verbs
 *
 * Claude Code ≥ 2.1.310 refuses unverifiable Bash in an `isolation: "worktree"`
 * agent: git with computed arguments, `$(git …)`, `cd … &&`, `git -C`. Every
 * mandatory block a GSD sub-agent ran in a worktree was written in exactly
 * those forms — the spawn-time branch check, the cwd-drift sentinel, the
 * absolute-path check, the `<automated>` containment scan, the supplied-root
 * pin, the pre-commit HEAD check, the plan ledger. A refused guard gets
 * improvised or skipped, and a skipped branch check is the failure it exists to
 * prevent (#2924, #48). Here git runs from node, where the host's command check
 * does not reach, and each guard has ONE owner with a typed result
 * (ADR-3473) instead of a bash copy in three markdown files.
 *
 * ## Contract
 *
 * Every invocation prints one JSON object on stdout —
 * `{ ok, stage, code, exit_code, applies, detail }` — and exits with
 * `exit_code`: 0 when the guard passes, 42 for any refusal of the `branch`
 * stage (the #48 contract the orchestrator recognises), 1 for every other
 * refusal. ANY fault of the verb itself — git missing or timing out, an
 * unknown stage, a missing or malformed flag, an internal error — is a
 * refusal, never a pass (ADR-3409). `applies: false` marks a pass because the
 * guard does not apply here (the sentinel outside a linked worktree, a task
 * with no `<automated>` command), so a caller can tell "checked and fine" from
 * "nothing to check".
 *
 * The guard runs git against the INVOKING cwd (the worktree the agent stands
 * in), never the main-worktree remap gsd-tools applies to planning commands;
 * only the protected-branch configuration is read from the project root.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam, posixNormalize, toComparablePathKey, type SpawnResultOutput } from './shell-command-projection.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { resolveProtectedBranchStatus } from './git-base-branch.cjs';
import { checkAutomatedCommand } from './automated-command-containment.cjs';
import { AGENT_BRANCH_RE, FALLBACK_PROTECTED_BRANCH_RE } from './worktree-agent-branch.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyCommandGrounding = require('./verify-command-grounding.cjs');

export const GUARD_STAGES = Object.freeze(['branch', 'pre-commit', 'sentinel', 'abs-path', 'automated', 'pin'] as const);
export type GuardStage = (typeof GUARD_STAGES)[number];

/** Exit code of a refusal, per stage. `branch` keeps the #48 exit 42. */
export const REFUSAL_EXIT: Readonly<Record<GuardStage | 'plan-ledger' | 'materialize' | 'unknown', number>> = Object.freeze({
  branch: 42,
  'pre-commit': 1,
  sentinel: 1,
  'abs-path': 1,
  automated: 1,
  pin: 1,
  'plan-ledger': 1,
  materialize: 42,
  unknown: 1,
});

export const GUARD_CODE = Object.freeze({
  OK: 'ok',
  NOT_APPLICABLE: 'not_applicable',
  USAGE: 'usage',
  UNKNOWN_STAGE: 'unknown_stage',
  GIT_UNAVAILABLE: 'git_unavailable',
  INTERNAL_ERROR: 'internal_error',
  // branch / pre-commit
  HEAD_DETACHED: 'head_detached',
  PROTECTED_BRANCH: 'protected_branch',
  NAMESPACE_MISMATCH: 'namespace_mismatch',
  EXPECTED_BASE_INVALID: 'expected_base_invalid',
  BASE_MISMATCH: 'base_mismatch',
  // sentinel
  CWD_DRIFT: 'cwd_drift',
  SENTINEL_CORRUPT: 'sentinel_corrupt',
  // abs-path / automated
  ROOT_UNRESOLVED: 'root_unresolved',
  OUTSIDE_WORKTREE: 'outside_worktree',
  PLAN_OUTSIDE_PROJECT: 'plan_outside_project',
  PLAN_UNREADABLE: 'plan_unreadable',
  PLAN_MALFORMED: 'plan_malformed',
  TASK_NOT_FOUND: 'task_not_found',
  RELOCATES_OUTSIDE_WORKTREE: 'relocates_outside_worktree',
  NAMES_MAIN_CHECKOUT: 'names_main_checkout',
  COMMAND_TOO_LARGE: 'command_too_large',
  COMMAND_INVALID: 'command_invalid',
  UNWRAP_TOO_DEEP: 'unwrap_too_deep',
  // pin
  PIN_UNBOUND: 'pin_unbound',
  PIN_NOT_ABSOLUTE: 'pin_not_absolute',
  PIN_UNRESOLVED: 'pin_unresolved',
  ROOT_MISMATCH: 'root_mismatch',
  // plan-ledger
  LEDGER_CORRUPT: 'ledger_corrupt',
  // materialize
  PATH_OUTSIDE_WORKTREE: 'path_outside_worktree',
  NOT_IN_COMMIT: 'not_in_commit',
  WRITE_FAILED: 'write_failed',
} as const);

export type GuardCode = (typeof GUARD_CODE)[keyof typeof GUARD_CODE];

export interface GuardResult {
  ok: boolean;
  stage: GuardStage | 'plan-ledger' | 'materialize' | null;
  code: GuardCode;
  exit_code: number;
  applies: boolean;
  detail: Record<string, unknown>;
}

type ExecGitFn = (args: string[], opts?: { cwd?: string; timeout?: number }) => SpawnResultOutput;

export interface GuardDeps {
  /** git runner (defaults to the shell-projection seam, which scrubs GIT_DIR/GIT_WORK_TREE). */
  execGit?: ExecGitFn;
  /** Protected-branch predicate; defaults to `resolveProtectedBranchStatus`. */
  resolveProtected?: (configCwd: string, branch: string) => { isProtected: boolean; verified: boolean };
  platform?: string;
}

const GIT_TIMEOUT_MS = 10_000;
const FULL_SHA_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const COMMIT_RE = /^[0-9a-f]{7,64}$/;
const LEDGER_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SENTINEL_FILE = 'gsd-spawn-toplevel';
const UNBOUND_PIN = '{PINNED_ROOT}';

// ─── Result builders ────────────────────────────────────────────────────────

function pass(stage: GuardResult['stage'], detail: Record<string, unknown> = {}, applies = true): GuardResult {
  return { ok: true, stage, code: applies ? GUARD_CODE.OK : GUARD_CODE.NOT_APPLICABLE, exit_code: 0, applies, detail };
}

function refuse(stage: GuardResult['stage'], code: GuardCode, detail: Record<string, unknown> = {}): GuardResult {
  const exit = REFUSAL_EXIT[stage ?? 'unknown'];
  return { ok: false, stage, code, exit_code: exit, applies: true, detail };
}

// ─── git ────────────────────────────────────────────────────────────────────

type GitAnswer =
  | { kind: 'ok'; out: string }
  | { kind: 'exit'; exitCode: number; stderr: string }
  | { kind: 'unavailable'; reason: string };

function runGit(deps: GuardDeps, cwd: string, args: string[]): GitAnswer {
  const exec = deps.execGit ?? execGitSeam;
  let r: SpawnResultOutput;
  try {
    r = exec(args, { cwd, timeout: GIT_TIMEOUT_MS });
  } catch (e) {
    return { kind: 'unavailable', reason: e instanceof Error ? e.message : String(e) };
  }
  if (r.timedOut) return { kind: 'unavailable', reason: `git ${args[0]} timed out` };
  if (r.error) return { kind: 'unavailable', reason: r.error.message };
  if (r.exitCode !== 0) return { kind: 'exit', exitCode: r.exitCode, stderr: (r.stderr || '').trim() };
  return { kind: 'ok', out: (r.stdout || '').replace(/\n+$/, '') };
}

function gitDetail(a: Exclude<GitAnswer, { kind: 'ok' }>, args: string[]): Record<string, unknown> {
  return a.kind === 'exit'
    ? { git: args.join(' '), git_exit: a.exitCode, git_stderr: a.stderr }
    : { git: args.join(' '), reason: a.reason };
}

/**
 * HEAD attachment and branch name, or the refusal that stops the caller. The
 * name is the symbolic ref itself minus `refs/heads/` — never
 * `rev-parse --abbrev-ref HEAD`, which answers `heads/main` when a tag named
 * `main` also exists and so slipped a protected branch past every name check.
 */
function readHead(stage: GuardStage, deps: GuardDeps, cwd: string): { branch: string } | GuardResult {
  const sym = runGit(deps, cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  if (sym.kind === 'exit' && sym.exitCode === 1) return refuse(stage, GUARD_CODE.HEAD_DETACHED, {});
  if (sym.kind !== 'ok') return refuse(stage, GUARD_CODE.GIT_UNAVAILABLE, gitDetail(sym, ['symbolic-ref', '--quiet', 'HEAD']));
  const prefix = 'refs/heads/';
  if (!sym.out.startsWith(prefix) || sym.out.length === prefix.length) {
    return refuse(stage, GUARD_CODE.HEAD_DETACHED, { head_ref: sym.out, reason: 'HEAD is not a local branch' });
  }
  return { branch: sym.out.slice(prefix.length) };
}

/** `git rev-parse --show-toplevel`, where an empty answer (no work tree) is no answer. */
function showToplevel(deps: GuardDeps, cwd: string): GitAnswer {
  const top = runGit(deps, cwd, ['rev-parse', '--show-toplevel']);
  if (top.kind === 'ok' && top.out === '') return { kind: 'unavailable', reason: 'git reported no work tree' };
  return top;
}

/** What `$(cat file)` yields: the content without its trailing line breaks. */
function stripTrailingNewlines(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '\n' || s[end - 1] === '\r')) end -= 1;
  return s.slice(0, end);
}

function isResult(x: unknown): x is GuardResult {
  return typeof x === 'object' && x !== null && 'exit_code' in x;
}

function samePath(a: string, b: string, platform: string): boolean {
  return toComparablePathKey(a, platform) === toComparablePathKey(b, platform);
}

// ─── Stages ─────────────────────────────────────────────────────────────────

export interface BranchOptions { expectedBase: string; alternateBase?: string }

/**
 * Spawn-time branch check (`worktree_branch_check`, #2924/#48/#1265). VERIFY-ONLY:
 * HEAD attached, not a protected name, inside the agent namespace, and at the
 * orchestrator's captured base (or its declared alternate). Every refusal exits 42.
 */
export function guardBranch(cwd: string, opts: BranchOptions, deps: GuardDeps = {}): GuardResult {
  const head = readHead('branch', deps, cwd);
  if (isResult(head)) return head;
  const { branch } = head;
  if (FALLBACK_PROTECTED_BRANCH_RE.test(branch)) return refuse('branch', GUARD_CODE.PROTECTED_BRANCH, { branch });
  if (!AGENT_BRANCH_RE.test(branch)) return refuse('branch', GUARD_CODE.NAMESPACE_MISMATCH, { branch, namespace: AGENT_BRANCH_RE.source });
  const rev = runGit(deps, cwd, ['rev-parse', 'HEAD']);
  if (rev.kind !== 'ok') return refuse('branch', GUARD_CODE.GIT_UNAVAILABLE, gitDetail(rev, ['rev-parse', 'HEAD']));
  const actual = rev.out;
  if (!FULL_SHA_RE.test(opts.expectedBase)) {
    return refuse('branch', GUARD_CODE.EXPECTED_BASE_INVALID, { branch, actual_base: actual, expected_base: opts.expectedBase });
  }
  const alternate = opts.alternateBase ?? '';
  const allowed = [opts.expectedBase, ...(alternate !== '' ? [alternate] : [])];
  if (!allowed.includes(actual)) {
    return refuse('branch', GUARD_CODE.BASE_MISMATCH, { branch, actual_base: actual, allowed_bases: allowed });
  }
  return pass('branch', { branch, actual_base: actual });
}

export interface PreCommitOptions { sequential: boolean; configCwd: string }

/**
 * Pre-commit HEAD check (executor step 0, #2924/#3819/#4799): attached HEAD, not
 * a protected or default branch (the configured answer, else the five-name
 * fallback), and — in an agent-isolated linked worktree — inside the agent
 * namespace. `--sequential` (the orchestrator dispatched onto its own tree)
 * lifts only the namespace rule.
 */
export function guardPreCommit(cwd: string, opts: PreCommitOptions, deps: GuardDeps = {}): GuardResult {
  const head = readHead('pre-commit', deps, cwd);
  if (isResult(head)) return head;
  const { branch } = head;
  let isProtected: boolean;
  let source: 'config' | 'fallback';
  try {
    const resolve = deps.resolveProtected ?? ((c: string, b: string) => resolveProtectedBranchStatus(c, b));
    const status = resolve(opts.configCwd, branch);
    isProtected = status.verified ? status.isProtected : true;
    source = 'config';
  } catch {
    isProtected = FALLBACK_PROTECTED_BRANCH_RE.test(branch);
    source = 'fallback';
  }
  if (isProtected) return refuse('pre-commit', GUARD_CODE.PROTECTED_BRANCH, { branch, protection_source: source });
  const top = showToplevel(deps, cwd);
  if (top.kind !== 'ok') return refuse('pre-commit', GUARD_CODE.GIT_UNAVAILABLE, gitDetail(top, ['rev-parse', '--show-toplevel']));
  let linked = false;
  try { linked = fs.statSync(path.join(top.out, '.git')).isFile(); } catch { linked = false; }
  if (linked && !opts.sequential && !AGENT_BRANCH_RE.test(branch)) {
    return refuse('pre-commit', GUARD_CODE.NAMESPACE_MISMATCH, { branch, namespace: AGENT_BRANCH_RE.source });
  }
  return pass('pre-commit', { branch, protection_source: source, linked_worktree: linked, sequential: opts.sequential });
}

/**
 * cwd-drift sentinel (step 0a, #3097). In a linked worktree the first call
 * records the spawn-time toplevel in `<git-dir>/gsd-spawn-toplevel`; every later
 * call refuses when the toplevel moved. Outside a linked worktree it does not
 * apply. An unreadable git answer or an empty sentinel is a refusal — the bash
 * this replaces wrote an empty sentinel when git failed and then passed forever.
 */
export function guardSentinel(cwd: string, deps: GuardDeps = {}): GuardResult {
  const platform = deps.platform ?? process.platform;
  const gd = runGit(deps, cwd, ['rev-parse', '--git-dir']);
  if (gd.kind !== 'ok') return refuse('sentinel', GUARD_CODE.GIT_UNAVAILABLE, gitDetail(gd, ['rev-parse', '--git-dir']));
  const gitDir = path.resolve(cwd, gd.out);
  if (!/\.git\/worktrees\/./.test(posixNormalize(gitDir))) return pass('sentinel', { git_dir: gitDir }, false);
  const top = showToplevel(deps, cwd);
  if (top.kind !== 'ok') return refuse('sentinel', GUARD_CODE.GIT_UNAVAILABLE, gitDetail(top, ['rev-parse', '--show-toplevel']));
  const sentinel = path.join(gitDir, SENTINEL_FILE);
  let created = false;
  try {
    fs.writeFileSync(sentinel, `${top.out}\n`, { flag: 'wx' });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') {
      return refuse('sentinel', GUARD_CODE.INTERNAL_ERROR, { sentinel, reason: (e as Error).message });
    }
  }
  let expected: string;
  try {
    expected = stripTrailingNewlines(fs.readFileSync(sentinel, 'utf8'));
  } catch (e) {
    return refuse('sentinel', GUARD_CODE.SENTINEL_CORRUPT, { sentinel, reason: (e as Error).message });
  }
  if (expected === '') return refuse('sentinel', GUARD_CODE.SENTINEL_CORRUPT, { sentinel, reason: 'empty' });
  if (!samePath(expected, top.out, platform)) {
    return refuse('sentinel', GUARD_CODE.CWD_DRIFT, { spawn_toplevel: expected, current_toplevel: top.out, recovery_cd: expected });
  }
  return pass('sentinel', { toplevel: top.out, created });
}

/**
 * Absolute-path check (step 0b, #3099): every `--path` must resolve inside the
 * worktree. `tryWithinRoot` (ADR-4650) resolves symlinks on both sides, so a
 * link inside the worktree that lands in the main checkout is outside, and a
 * sibling `<root>-x` never passes a string-prefix test. A relative path is
 * taken from the invoking cwd.
 */
export function guardAbsPath(cwd: string, opts: { paths: string[] }, deps: GuardDeps = {}): GuardResult {
  const top = showToplevel(deps, cwd);
  if (top.kind !== 'ok') return refuse('abs-path', GUARD_CODE.ROOT_UNRESOLVED, gitDetail(top, ['rev-parse', '--show-toplevel']));
  const outside: string[] = [];
  for (const p of opts.paths) {
    const candidate = path.isAbsolute(p) ? p : path.resolve(cwd, p);
    if (tryWithinRoot(candidate, top.out, PathAcceptance.AbsoluteInsideRoot) === null) outside.push(p);
  }
  if (outside.length > 0) return refuse('abs-path', GUARD_CODE.OUTSIDE_WORKTREE, { root: top.out, outside });
  return pass('abs-path', { root: top.out, checked: opts.paths.length });
}

/** Worktree root (git's spelling) and the physical main-checkout root, or the refusal. */
function containmentRoots(stage: GuardStage, cwd: string, deps: GuardDeps): { worktreeRoot: string; mainRoot: string } | GuardResult {
  const top = showToplevel(deps, cwd);
  if (top.kind !== 'ok') return refuse(stage, GUARD_CODE.ROOT_UNRESOLVED, gitDetail(top, ['rev-parse', '--show-toplevel']));
  const common = runGit(deps, cwd, ['rev-parse', '--git-common-dir']);
  if (common.kind !== 'ok') return refuse(stage, GUARD_CODE.ROOT_UNRESOLVED, gitDetail(common, ['rev-parse', '--git-common-dir']));
  let mainRoot: string;
  try {
    mainRoot = fs.realpathSync.native(path.resolve(cwd, common.out, '..'));
  } catch (e) {
    return refuse(stage, GUARD_CODE.ROOT_UNRESOLVED, { reason: (e as Error).message });
  }
  return { worktreeRoot: top.out, mainRoot };
}

export interface AutomatedOptions { command?: string; plan?: string; task?: string }

/**
 * `<automated>` containment (step 0c, #4767). The executor names the plan and
 * the task ordinal; the verb reads that task's `<automated>` commands itself, so
 * the command checked is the command the plan carries, not a re-typed copy.
 * `--command` checks literal text (tests and tooling).
 */
export function guardAutomated(cwd: string, opts: AutomatedOptions, deps: GuardDeps = {}): GuardResult {
  const roots = containmentRoots('automated', cwd, deps);
  if (isResult(roots)) return roots;
  let commands: string[];
  let source: Record<string, unknown>;
  if (opts.command === undefined && (opts.plan === undefined || opts.task === undefined || !/^[1-9][0-9]*$/.test(opts.task))) {
    return refuse('automated', GUARD_CODE.USAGE, { reason: 'give --plan <PLAN.md> --task <n> (1-based <task> ordinal), or --command <text>', task: opts.task ?? null });
  }
  if (opts.command !== undefined) {
    commands = [opts.command];
    source = { source: 'command' };
  } else {
    const planArg = opts.plan as string;
    const candidate = path.isAbsolute(planArg) ? planArg : path.resolve(cwd, planArg);
    const contained = tryWithinRoot(candidate, roots.worktreeRoot, PathAcceptance.AbsoluteInsideRoot)
      ?? tryWithinRoot(candidate, roots.mainRoot, PathAcceptance.AbsoluteInsideRoot);
    if (contained === null) return refuse('automated', GUARD_CODE.PLAN_OUTSIDE_PROJECT, { plan: planArg });
    let text: string;
    try {
      text = fs.readFileSync(contained, 'utf8');
    } catch (e) {
      return refuse('automated', GUARD_CODE.PLAN_UNREADABLE, { plan: planArg, reason: (e as Error).message });
    }
    const index = Number(opts.task) - 1;
    const read = verifyCommandGrounding.extractAutomatedCommandsByTask(text);
    if (!read.ok) {
      return refuse('automated', GUARD_CODE.PLAN_MALFORMED, { plan: planArg, task: opts.task, reason: read.reason, at_task: read.task ?? null });
    }
    if (index < 0 || index >= read.tasks.length) {
      return refuse('automated', GUARD_CODE.TASK_NOT_FOUND, { plan: planArg, task: opts.task, tasks_in_plan: read.tasks.length });
    }
    commands = read.tasks[index].commands;
    source = { source: 'plan', plan: planArg, task: opts.task, task_name: read.tasks[index].name };
    if (commands.length === 0) return pass('automated', { ...source, commands: 0 }, false);
  }
  for (let i = 0; i < commands.length; i += 1) {
    const v = checkAutomatedCommand(commands[i], roots);
    if (!v.ok) {
      const { ok: _ok, code, ...rest } = v;
      return refuse('automated', code, { ...source, command_index: i, command: commands[i], worktree_root: roots.worktreeRoot, ...rest });
    }
  }
  return pass('automated', { ...source, commands: commands.length, worktree_root: roots.worktreeRoot });
}

/**
 * Supplied-root pin (step 0p, #4254): the executor's actual root must equal the
 * root the ORCHESTRATOR validated and substituted at build time. git-vs-git on
 * both sides, so symlink aliases, trailing slashes and `/var`/`/private/var`
 * spellings compare equal by construction. The immediate submodule of the pinned
 * checkout is the one legitimate other root.
 */
export function guardPin(cwd: string, opts: { root: string }, deps: GuardDeps = {}): GuardResult {
  const platform = deps.platform ?? process.platform;
  const pinned = opts.root;
  if (pinned === '' || pinned === UNBOUND_PIN) return refuse('pin', GUARD_CODE.PIN_UNBOUND, { pinned_root: pinned });
  if (!(pinned.startsWith('/') || /^[A-Za-z]:[\\/]/.test(pinned))) {
    return refuse('pin', GUARD_CODE.PIN_NOT_ABSOLUTE, { pinned_root: pinned });
  }
  const actual = showToplevel(deps, cwd);
  if (actual.kind !== 'ok') return refuse('pin', GUARD_CODE.ROOT_UNRESOLVED, { pinned_root: pinned, ...gitDetail(actual, ['rev-parse', '--show-toplevel']) });
  const pinnedTop = showToplevel(deps, pinned);
  if (pinnedTop.kind !== 'ok') return refuse('pin', GUARD_CODE.PIN_UNRESOLVED, { pinned_root: pinned, ...gitDetail(pinnedTop, ['rev-parse', '--show-toplevel']) });
  if (samePath(actual.out, pinnedTop.out, platform)) return pass('pin', { root: actual.out });
  const superTop = runGit(deps, cwd, ['rev-parse', '--show-superproject-working-tree']);
  if (superTop.kind === 'ok' && superTop.out !== '' && samePath(superTop.out, pinnedTop.out, platform)) {
    return pass('pin', { root: actual.out, submodule_of: pinnedTop.out });
  }
  return refuse('pin', GUARD_CODE.ROOT_MISMATCH, {
    actual_root: actual.out,
    pinned_root: pinnedTop.out,
    superproject: superTop.kind === 'ok' && superTop.out !== '' ? superTop.out : null,
  });
}

/**
 * Plan commit ledger (#3968). The first call records HEAD in
 * `<git-dir>/gsd-plan-head-before-<phase>-<plan>`; every call reports the recorded
 * base, the current HEAD and the commit count between them — the SUMMARY's
 * measured `commits:`, `plan_head_before:` and `plan_head_after:`. Each Bash call
 * is a fresh shell, so the ledger lives on disk, per plan.
 */
export function planLedger(cwd: string, opts: { phase: string; plan: string }, deps: GuardDeps = {}): GuardResult {
  const stage = 'plan-ledger' as const;
  if (!LEDGER_TOKEN_RE.test(opts.phase) || !LEDGER_TOKEN_RE.test(opts.plan)) {
    return refuse(stage, GUARD_CODE.USAGE, { reason: '--phase and --plan must match [A-Za-z0-9][A-Za-z0-9._-]*', phase: opts.phase, plan: opts.plan });
  }
  const gd = runGit(deps, cwd, ['rev-parse', '--git-dir']);
  if (gd.kind !== 'ok') return refuse(stage, GUARD_CODE.GIT_UNAVAILABLE, gitDetail(gd, ['rev-parse', '--git-dir']));
  const head = runGit(deps, cwd, ['rev-parse', 'HEAD']);
  if (head.kind !== 'ok') return refuse(stage, GUARD_CODE.GIT_UNAVAILABLE, gitDetail(head, ['rev-parse', 'HEAD']));
  const ledger = path.join(path.resolve(cwd, gd.out), `gsd-plan-head-before-${opts.phase}-${opts.plan}`);
  let created = false;
  try {
    fs.writeFileSync(ledger, `${head.out}\n`, { flag: 'wx' });
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return refuse(stage, GUARD_CODE.INTERNAL_ERROR, { ledger, reason: (e as Error).message });
  }
  let before: string;
  try {
    before = fs.readFileSync(ledger, 'utf8').trim();
  } catch (e) {
    return refuse(stage, GUARD_CODE.LEDGER_CORRUPT, { ledger, reason: (e as Error).message });
  }
  if (!FULL_SHA_RE.test(before)) return refuse(stage, GUARD_CODE.LEDGER_CORRUPT, { ledger, recorded: before });
  const count = runGit(deps, cwd, ['rev-list', '--count', `${before}..HEAD`]);
  if (count.kind !== 'ok' || !/^\d+$/.test(count.out)) {
    return refuse(stage, GUARD_CODE.GIT_UNAVAILABLE, count.kind === 'ok' ? { git: 'rev-list --count', output: count.out } : gitDetail(count, ['rev-list', '--count', `${before}..HEAD`]));
  }
  return pass(stage, { ledger, created, plan_head_before: before, plan_head_after: head.out, commits: Number(count.out) });
}

/**
 * Materialise planning files from a commit into the worktree (quick's isolated
 * dispatch: the PLAN.md the orchestrator committed before spawning, plus its
 * optional CONTEXT/RESEARCH companions). A file already present is left alone.
 * A `--path` that cannot be produced refuses with exit 42 (the quick contract);
 * an `--optional-path` absent from the commit is skipped. Every path is
 * worktree-relative and must stay inside the worktree (ADR-4650).
 */
export function materializeFromCommit(
  cwd: string,
  opts: { commit: string; paths: string[]; optionalPaths: string[] },
  deps: GuardDeps = {},
): GuardResult {
  const stage = 'materialize' as const;
  if (!COMMIT_RE.test(opts.commit)) return refuse(stage, GUARD_CODE.USAGE, { reason: '--from must be a commit SHA', from: opts.commit });
  const roots = containmentRoots('automated', cwd, deps);
  if (isResult(roots)) return { ...roots, stage, exit_code: REFUSAL_EXIT[stage] };
  const written: string[] = [];
  const present: string[] = [];
  const skipped: string[] = [];
  const all = [...opts.paths.map((p) => ({ p, required: true })), ...opts.optionalPaths.map((p) => ({ p, required: false }))];
  for (const { p, required } of all) {
    // `init` anchors quick_dir on the orchestrator's checkout (#2376), so an
    // absolute path under the MAIN checkout names the same repository path; it
    // is rebased onto this worktree. Anything else must already be inside it.
    const inMain = path.isAbsolute(p) ? tryWithinRoot(p, roots.mainRoot, PathAcceptance.AbsoluteInsideRoot) : null;
    const relative = inMain !== null && tryWithinRoot(p, roots.worktreeRoot, PathAcceptance.AbsoluteInsideRoot) === null
      ? path.relative(fs.realpathSync.native(roots.mainRoot), inMain)
      : p;
    const target = tryWithinRoot(relative, roots.worktreeRoot, path.isAbsolute(relative) ? PathAcceptance.AbsoluteInsideRoot : PathAcceptance.RelativeOnly);
    if (target === null) return refuse(stage, GUARD_CODE.PATH_OUTSIDE_WORKTREE, { path: p, root: roots.worktreeRoot });
    if (fs.existsSync(target)) { present.push(p); continue; }
    const rel = posixNormalize(path.relative(fs.realpathSync.native(roots.worktreeRoot), target));
    // `git restore --source` writes the blob into the working tree byte for byte
    // (through git's own checkout filters) and leaves the index alone; a captured
    // `git show` would pass through the seam's stdout trim.
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (e) {
      return refuse(stage, GUARD_CODE.WRITE_FAILED, { path: p, reason: (e as Error).message });
    }
    const restoreArgs = ['restore', `--source=${opts.commit}`, '--worktree', '--', `:(literal)${rel}`];
    const restored = runGit(deps, roots.worktreeRoot, restoreArgs);
    if (restored.kind !== 'ok') {
      if (!required && restored.kind === 'exit') { skipped.push(p); continue; }
      return refuse(stage, restored.kind === 'exit' ? GUARD_CODE.NOT_IN_COMMIT : GUARD_CODE.GIT_UNAVAILABLE, { path: p, from: opts.commit, ...gitDetail(restored, restoreArgs) });
    }
    written.push(p);
  }
  return pass(stage, { from: opts.commit, written, present, skipped });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

/** Flags each stage accepts: value-taking, repeatable, boolean. */
const STAGE_FLAGS: Readonly<Record<GuardStage, { values: string[]; repeat: string[]; booleans: string[] }>> = Object.freeze({
  branch: { values: ['--expected-base', '--alternate-base'], repeat: [], booleans: [] },
  'pre-commit': { values: [], repeat: [], booleans: ['--sequential'] },
  sentinel: { values: [], repeat: [], booleans: [] },
  'abs-path': { values: [], repeat: ['--path'], booleans: [] },
  automated: { values: ['--plan', '--task', '--command'], repeat: [], booleans: [] },
  pin: { values: ['--root'], repeat: [], booleans: [] },
});

interface ParsedFlags { values: Map<string, string>; repeated: Map<string, string[]>; booleans: Set<string> }

function parseFlags(
  args: string[],
  spec: { values: string[]; repeat: string[]; booleans: string[] },
): ParsedFlags | { error: string } {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  const booleans = new Set<string>();
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (spec.booleans.includes(a)) {
      if (booleans.has(a)) return { error: `${a} given twice` };
      booleans.add(a);
    } else if (spec.values.includes(a) || spec.repeat.includes(a)) {
      if (i + 1 >= args.length) return { error: `${a} needs a value` };
      const v = args[i + 1];
      i += 1;
      if (spec.repeat.includes(a)) repeated.set(a, [...(repeated.get(a) ?? []), v]);
      else if (values.has(a)) return { error: `${a} given twice` };
      else values.set(a, v);
    } else {
      return { error: `unexpected argument ${JSON.stringify(a)}` };
    }
  }
  return { values, repeated, booleans };
}

/** Run one guard stage from CLI arguments `[stage, ...flags]`. Never throws. */
export function runGuardCli(invokingCwd: string, configCwd: string, args: string[], deps: GuardDeps = {}): GuardResult {
  const stageArg = args[0];
  if (!(GUARD_STAGES as readonly string[]).includes(stageArg)) {
    return refuse(null, GUARD_CODE.UNKNOWN_STAGE, { stage: stageArg ?? null, stages: [...GUARD_STAGES] });
  }
  const stage = stageArg as GuardStage;
  const parsed = parseFlags(args.slice(1), STAGE_FLAGS[stage]);
  if ('error' in parsed) return refuse(stage, GUARD_CODE.USAGE, { reason: parsed.error });
  try {
    switch (stage) {
      case 'branch': {
        const expected = parsed.values.get('--expected-base');
        if (expected === undefined) return refuse(stage, GUARD_CODE.USAGE, { reason: '--expected-base is required' });
        return guardBranch(invokingCwd, { expectedBase: expected, alternateBase: parsed.values.get('--alternate-base') }, deps);
      }
      case 'pre-commit':
        return guardPreCommit(invokingCwd, { sequential: parsed.booleans.has('--sequential'), configCwd }, deps);
      case 'sentinel':
        return guardSentinel(invokingCwd, deps);
      case 'abs-path': {
        const paths = parsed.repeated.get('--path') ?? [];
        if (paths.length === 0) return refuse(stage, GUARD_CODE.USAGE, { reason: 'at least one --path is required' });
        return guardAbsPath(invokingCwd, { paths }, deps);
      }
      case 'automated': {
        const command = parsed.values.get('--command');
        const plan = parsed.values.get('--plan');
        const task = parsed.values.get('--task');
        const byPlan = plan !== undefined || task !== undefined;
        if (command !== undefined && byPlan) return refuse(stage, GUARD_CODE.USAGE, { reason: '--command and --plan/--task are exclusive' });
        if (command === undefined && (plan === undefined || task === undefined)) {
          return refuse(stage, GUARD_CODE.USAGE, { reason: 'give --plan <PLAN.md> --task <n>, or --command <text>' });
        }
        if (task !== undefined && !/^[1-9][0-9]*$/.test(task)) return refuse(stage, GUARD_CODE.USAGE, { reason: '--task is a 1-based task ordinal', task });
        return guardAutomated(invokingCwd, { command, plan, task }, deps);
      }
      case 'pin': {
        const root = parsed.values.get('--root');
        if (root === undefined) return refuse(stage, GUARD_CODE.USAGE, { reason: '--root is required' });
        return guardPin(invokingCwd, { root }, deps);
      }
    }
  } catch (e) {
    return refuse(stage, GUARD_CODE.INTERNAL_ERROR, { reason: e instanceof Error ? e.message : String(e) });
  }
}

/** Run the plan ledger from CLI arguments `[--phase X --plan Y]`. Never throws. */
export function runPlanLedgerCli(invokingCwd: string, args: string[], deps: GuardDeps = {}): GuardResult {
  const parsed = parseFlags(args, { values: ['--phase', '--plan'], repeat: [], booleans: [] });
  if ('error' in parsed) return refuse('plan-ledger', GUARD_CODE.USAGE, { reason: parsed.error });
  const phase = parsed.values.get('--phase');
  const plan = parsed.values.get('--plan');
  if (phase === undefined || plan === undefined) return refuse('plan-ledger', GUARD_CODE.USAGE, { reason: '--phase and --plan are required' });
  try {
    return planLedger(invokingCwd, { phase, plan }, deps);
  } catch (e) {
    return refuse('plan-ledger', GUARD_CODE.INTERNAL_ERROR, { reason: e instanceof Error ? e.message : String(e) });
  }
}

/** Run `worktree materialize --from <sha> --path <p>... [--optional-path <p>...]`. Never throws. */
export function runMaterializeCli(invokingCwd: string, args: string[], deps: GuardDeps = {}): GuardResult {
  const parsed = parseFlags(args, { values: ['--from'], repeat: ['--path', '--optional-path'], booleans: [] });
  if ('error' in parsed) return refuse('materialize', GUARD_CODE.USAGE, { reason: parsed.error });
  const commit = parsed.values.get('--from');
  const paths = parsed.repeated.get('--path') ?? [];
  if (commit === undefined || paths.length === 0) return refuse('materialize', GUARD_CODE.USAGE, { reason: '--from and at least one --path are required' });
  try {
    return materializeFromCommit(invokingCwd, { commit, paths, optionalPaths: parsed.repeated.get('--optional-path') ?? [] }, deps);
  } catch (e) {
    return refuse('materialize', GUARD_CODE.INTERNAL_ERROR, { reason: e instanceof Error ? e.message : String(e) });
  }
}

function writeStdoutSync(s: string): void {
  const buf = Buffer.from(s, 'utf8');
  let offset = 0;
  while (offset < buf.length) offset += fs.writeSync(1, buf, offset, buf.length - offset);
}

/**
 * Emit a result the CLI way: JSON on stdout, a one-line reason on stderr for a
 * refusal, and the exit code through `process.exitCode` (runMain never lowers a
 * non-zero code main() set).
 */
export function emitGuardResult(result: GuardResult): void {
  writeStdoutSync(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    const verb = result.stage === 'plan-ledger' || result.stage === 'materialize' ? result.stage : `guard ${result.stage ?? '<stage>'}`;
    process.stderr.write(`gsd-tools worktree ${verb}: REFUSED (${result.code}); HALT — do not self-recover.\n`);
  }
  process.exitCode = result.exit_code;
}

export function cmdWorktreeGuard(invokingCwd: string, configCwd: string, args: string[]): GuardResult {
  const result = runGuardCli(invokingCwd, configCwd, args);
  emitGuardResult(result);
  return result;
}

export function cmdWorktreeMaterialize(invokingCwd: string, args: string[]): GuardResult {
  const result = runMaterializeCli(invokingCwd, args);
  emitGuardResult(result);
  return result;
}

export function cmdWorktreePlanLedger(invokingCwd: string, args: string[]): GuardResult {
  const result = runPlanLedgerCli(invokingCwd, args);
  emitGuardResult(result);
  return result;
}
