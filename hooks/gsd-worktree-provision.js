#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Worktree Provisioning — Claude Code WorktreeCreate / WorktreeRemove hook (mn fork)
//
// Contract (Claude Code hooks reference, "WorktreeCreate" / "WorktreeRemove"):
//
//   • A WorktreeCreate hook REPLACES the harness's own `git worktree add`. It
//     fires for `claude --worktree <name>`, EnterWorktree and every subagent
//     with `isolation: "worktree"`. stdin is JSON carrying `name` (a slug such
//     as `agent-a3f2b1c4` or `wf_…`); the hook creates the checkout itself and
//     prints its absolute path as the ONLY stdout. Any other stdout corrupts the
//     path; every diagnostic goes to stderr. Exit 0 = created, the path is the
//     session's working directory; non-zero = creation fails.
//   • `.worktreeinclude` is NOT processed by the harness once a hook is in
//     place, so this hook copies those files itself.
//   • WorktreeRemove carries `worktree_path`. Exit 0 = removed (the directory
//     must be gone); non-zero = the removal fails while the directory remains.
//     The harness never deletes a hook-created branch, so this hook does —
//     but only when no work would be lost.
//
// Why this hook creates the worktree itself rather than only equipping one:
// a fresh worktree is a checkout, not an environment. The ucars retrospective
// names worktree isolation "the #1 recurring operational failure across
// multiple milestones": `mcp__pencil__*` and atlas unavailable in every
// worktree agent (`.mcp.json` lives in the main checkout), node_modules missing
// or stale, a base hundreds of commits behind main — each discovered only by
// failing, mid-phase. And the harness's default base is `origin/HEAD`, which in
// a fork whose `origin` lags the local branch hands every isolated agent a
// base hundreds of commits old. This hook:
//
//   1. creates `<main checkout>/.claude/worktrees/<name>` on a new branch
//      `worktree-<name>` from the invoking checkout's LOCAL HEAD — the same
//      location and branch name the harness uses, a base that is correct by
//      construction;
//   2. copies `.worktreeinclude` files (harness parity, always on);
//   3. when `workflow.worktree_provision` is on, equips it: tool config
//      (`.mcp.json`, `.claude/settings*.json`), dependencies per
//      `workflow.worktree_deps`, and a base-freshness check against the main
//      checkout (`workflow.worktree_max_base_lag`), which refuses BEFORE any
//      worktree exists.
//
// Failure policy. A stale base always refuses: work done against it must be
// redone. A failed equipment step (copy, link, install) WARNS on stderr by
// default — refusing a worktree over an optional convenience is how people come
// to distrust isolation and turn it off — and REFUSES under
// `workflow.worktree_provision_strict`, after rolling the half-equipped worktree
// back so nothing is left on disk for a creation the harness reports as failed.
//
// Exit codes come from the ADR-3889 registry (hooks/lib/exit-code-registry.js):
// PASS 0, FAIL 1 (a policy refusal: stale base, strict equipment failure),
// USAGE 64 (an invalid worktree name), UNAVAILABLE 69 (unreadable payload, not
// a repository, an existing path or branch, git failed), INTERNAL 70 (this
// hook's own crash). There is no fail-open path: printing no path IS failure on
// this event, so a crash cannot be waved through.
//
// Registered by the installer in settings.json for Claude Code
// (src/runtime-hooks-surface.cts), not in the plugin hooks.json: the hooks
// reference documents WorktreeCreate for settings files only.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { terminateNow } = require('./lib/cli-exit.js');

/** Files copied into a provisioned worktree when they exist in the source checkout. */
const TOOL_CONFIG_FILES = [
  '.mcp.json',
  path.join('.claude', 'settings.local.json'),
  path.join('.claude', 'settings.json'),
];

const WORKTREES_DIR_SEGMENTS = ['.claude', 'worktrees'];
const BRANCH_PREFIX = 'worktree-';
const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Slug the harness passes: letters, digits, `.`, `_`, `-`; never a path. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const DEFAULT_MAX_BASE_LAG = 200;
const DEFAULT_INSTALL_TIMEOUT_MS = 600000;
const GIT_QUERY_TIMEOUT_MS = 30000;
// `git worktree add` checks out the whole tree; `remove --force` deletes it,
// installed dependencies included.
const GIT_WORKTREE_TIMEOUT_MS = 120000;
const STDIN_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Why a create/remove was refused. The `code` is the typed surface tests assert on. */
const REFUSAL = Object.freeze({
  INVALID_PAYLOAD: 'invalid-payload',
  INVALID_NAME: 'invalid-name',
  NOT_A_REPOSITORY: 'not-a-repository',
  NO_HEAD: 'no-head',
  PATH_EXISTS: 'path-exists',
  BRANCH_EXISTS: 'branch-exists',
  GIT_FAILED: 'git-failed',
  NOT_MANAGED: 'not-managed',
  BASE_TOO_STALE: 'base-too-stale',
  PROVISION_FAILED: 'provision-failed',
});

/** Registered exit outcome (ADR-3889) per refusal code. */
const EXIT_OUTCOME_FOR_REFUSAL = Object.freeze({
  [REFUSAL.INVALID_PAYLOAD]: 'UNAVAILABLE',
  [REFUSAL.INVALID_NAME]: 'USAGE',
  [REFUSAL.NOT_A_REPOSITORY]: 'UNAVAILABLE',
  [REFUSAL.NO_HEAD]: 'UNAVAILABLE',
  [REFUSAL.PATH_EXISTS]: 'UNAVAILABLE',
  [REFUSAL.BRANCH_EXISTS]: 'UNAVAILABLE',
  [REFUSAL.GIT_FAILED]: 'UNAVAILABLE',
  [REFUSAL.NOT_MANAGED]: 'UNAVAILABLE',
  [REFUSAL.BASE_TOO_STALE]: 'FAIL',
  [REFUSAL.PROVISION_FAILED]: 'FAIL',
});

function refuse(code, reason, extra = {}) {
  return { outcome: 'refused', code, reason, ...extra };
}

// ─── git ─────────────────────────────────────────────────────────────────────

/**
 * Run git, bounded. Never throws: returns `{ ok, status, stdout, stderr, error }`.
 * stdin is ignored unless `input` is given, so git can never wait on a prompt.
 */
function runGit(args, cwd, { timeoutMs = GIT_QUERY_TIMEOUT_MS, input } = {}) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    ok: !res.error && res.status === 0,
    status: res.status,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr.trim() : '',
    error: res.error ? String(res.error.code || 'spawn failed') : null,
  };
}

function gitDetail(res) {
  return res.error ? `git could not run (${res.error})` : res.stderr || `git exited ${res.status}`;
}

/** Realpath when the path exists, so `/var` and `/private/var` compare equal. */
function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The main checkout of the repository containing `dir`. The common git dir of
 * a non-bare repository is `<main checkout>/.git`, for the main checkout and
 * every linked worktree alike — so worktrees spawned from inside a worktree
 * still land beside their siblings rather than nested in a checkout.
 */
function resolveMainRoot(dir, git) {
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (!top.ok) return null;
  const sourceTop = canonical(top.stdout.trim());
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  const commonDir = common.ok ? path.resolve(common.stdout.trim()) : '';
  const mainRoot = commonDir && path.basename(commonDir) === '.git' ? canonical(path.dirname(commonDir)) : sourceTop;
  return { sourceTop, mainRoot };
}

function resolveHead(dir, git) {
  const res = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], dir);
  const sha = res.ok ? res.stdout.trim() : '';
  return sha || null;
}

/** `git worktree list --porcelain` → `[{ path, branch }]` (branch is a full ref or null). */
function listWorktrees(mainRoot, git) {
  const res = git(['worktree', 'list', '--porcelain'], mainRoot);
  if (!res.ok) return [];
  const entries = [];
  let current = null;
  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null };
      entries.push(current);
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  return entries;
}

function findWorktreeEntry(mainRoot, target, git) {
  const wanted = canonical(target);
  return listWorktrees(mainRoot, git).find((entry) => canonical(entry.path) === wanted) || null;
}

function branchExists(mainRoot, branch, git) {
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], mainRoot).ok;
}

// ─── configuration ───────────────────────────────────────────────────────────

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

/**
 * Read the provisioning configuration, or null when provisioning is off.
 *
 * `workflow.worktree_provision` is the master switch and is absent by default:
 * equipping copies files and can run an install command, and neither should
 * happen in a project that did not ask for it. Creating the worktree itself
 * does not depend on it — the harness's creation is replaced either way.
 */
function readConfig(planningRoot) {
  if (!planningRoot) return null;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(planningRoot, '.planning', 'config.json'), 'utf8'));
  } catch {
    return null;
  }
  const workflow = cfg && typeof cfg === 'object' ? cfg.workflow : null;
  if (!workflow || typeof workflow !== 'object') return null;
  if (workflow.worktree_provision !== true) return null;

  const rawDeps = workflow.worktree_deps;
  const deps = rawDeps === 'install' || rawDeps === 'none' ? rawDeps : 'link';

  const rawLag = workflow.worktree_max_base_lag;
  const maxBaseLag = Number.isInteger(rawLag) && rawLag >= 0 ? rawLag : DEFAULT_MAX_BASE_LAG;

  const installCommand =
    typeof workflow.worktree_install_command === 'string' && workflow.worktree_install_command.trim()
      ? workflow.worktree_install_command.trim()
      : null;

  return {
    deps,
    maxBaseLag,
    installCommand,
    copyToolConfig: workflow.worktree_copy_tools !== false,
    strict: workflow.worktree_provision_strict === true,
  };
}

// ─── provisioning steps ──────────────────────────────────────────────────────

/**
 * How far `baseSha` is behind the main checkout's HEAD.
 *
 * Returns `{ behind }`, or `{ unknown: reason }` when the question cannot be
 * answered — which is NOT treated as "fresh". A base check that silently
 * passes when it cannot compare is the same defect class as a gate that cannot
 * run reporting success.
 */
function measureBaseLag(repoDir, baseSha, mainHeadSha, git = runGit) {
  if (!mainHeadSha) return { unknown: 'HEAD did not resolve in the main checkout' };
  if (baseSha === mainHeadSha) return { behind: 0 };
  const res = git(['rev-list', '--count', `${baseSha}..${mainHeadSha}`], repoDir);
  if (!res.ok) return { unknown: 'rev-list failed (unrelated histories, or a shallow clone)' };
  const behind = Number(res.stdout.trim());
  if (!Number.isFinite(behind)) return { unknown: 'rev-list did not return a count' };
  return { behind };
}

/** Copy the tool configuration an agent needs to have the tools it expects. */
function copyToolConfig(sourceDir, worktreeDir) {
  const copied = [];
  const existing = [];
  const failed = [];
  for (const rel of TOOL_CONFIG_FILES) {
    const source = path.join(sourceDir, rel);
    const target = path.join(worktreeDir, rel);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target)) {
      // Never clobber: a checkout that already carries its own settings (a
      // tracked .claude/settings.json, say) is making a deliberate statement.
      existing.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied.push(rel);
    } catch (err) {
      failed.push({ file: rel, reason: err && err.code ? String(err.code) : 'copy failed' });
    }
  }
  return { copied, existing, failed };
}

/**
 * Make dependencies available.
 *
 * `link` symlinks the source checkout's node_modules — the measured-fast option,
 * and correct whenever the lockfile has not moved, which is the overwhelmingly
 * common case for a phase branch. `install` runs the project's own command for
 * the cases where it has. Neither is safe to guess at, hence the config key.
 *
 * `failed` separates "could not provide what was configured" from the benign
 * outcomes (disabled; the checkout already has node_modules).
 */
function provisionDeps(mode, sourceDir, worktreeDir, installCommand, timeoutMs) {
  if (mode === 'none') return { mode, done: false, failed: false, reason: 'disabled' };

  if (mode === 'link') {
    const source = path.join(sourceDir, 'node_modules');
    const target = path.join(worktreeDir, 'node_modules');
    if (fs.existsSync(target)) {
      return { mode, done: false, failed: false, reason: 'the worktree already has node_modules' };
    }
    if (!fs.existsSync(source)) {
      return { mode, done: false, failed: true, reason: 'no node_modules in the source checkout' };
    }
    try {
      fs.symlinkSync(source, target, 'dir');
      return { mode, done: true, failed: false };
    } catch (err) {
      return { mode, done: false, failed: true, reason: err && err.code ? String(err.code) : 'symlink failed' };
    }
  }

  if (!installCommand) {
    return { mode, done: false, failed: true, reason: 'workflow.worktree_install_command names no command' };
  }
  const res = spawnSync(installCommand, {
    cwd: worktreeDir,
    shell: true,
    encoding: 'utf8',
    // The install's own output must never reach the hook's stdout, which
    // carries nothing but the worktree path.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true, // shell:true would otherwise flash a console window (#685)
  });
  if (res.error || res.status !== 0) {
    return {
      mode,
      done: false,
      failed: true,
      reason: res.error ? `install could not run (${res.error.code || 'unknown'})` : `install exited ${res.status}`,
    };
  }
  return { mode, done: true, failed: false };
}

/**
 * Copy `.worktreeinclude` files — the harness's own behaviour, which a
 * WorktreeCreate hook disables: untracked files that match a pattern in
 * `.worktreeinclude` (gitignore syntax) AND are gitignored. git does the
 * matching both times, so the semantics are git's, not a re-implementation.
 */
function copyWorktreeInclude(sourceTop, worktreeDir, git = runGit) {
  const includeFile = path.join(sourceTop, WORKTREE_INCLUDE_FILE);
  if (!fs.existsSync(includeFile)) return { copied: [], failed: [] };

  const matched = git(['ls-files', '-z', '--others', '--ignored', `--exclude-from=${includeFile}`], sourceTop);
  if (!matched.ok) return { copied: [], failed: [{ file: WORKTREE_INCLUDE_FILE, reason: gitDetail(matched) }] };
  const candidates = matched.stdout.split('\0').filter(Boolean);
  if (candidates.length === 0) return { copied: [], failed: [] };

  // check-ignore exits 1 when none of the candidates is ignored — an answer, not an error.
  const ignored = git(['check-ignore', '-z', '--stdin'], sourceTop, { input: `${candidates.join('\0')}\0` });
  if (!ignored.ok && ignored.status !== 1) {
    return { copied: [], failed: [{ file: WORKTREE_INCLUDE_FILE, reason: gitDetail(ignored) }] };
  }

  const copied = [];
  const failed = [];
  for (const rel of ignored.stdout.split('\0').filter(Boolean)) {
    const target = path.join(worktreeDir, rel);
    if (fs.existsSync(target)) continue;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(sourceTop, rel), target);
      copied.push(rel);
    } catch (err) {
      failed.push({ file: rel, reason: err && err.code ? String(err.code) : 'copy failed' });
    }
  }
  return { copied, failed };
}

/**
 * Equip a created worktree. Returns `{ notes[], failures[] }`; a failure is
 * `{ step, reason }` and is what the strict policy refuses on.
 */
function equipWorktree({ sourceTop, worktreeDir, planningRoot, config, installTimeoutMs }, steps = {}) {
  const notes = [];
  const failures = [];

  const include = (steps.copyWorktreeInclude || copyWorktreeInclude)(sourceTop, worktreeDir);
  if (include.copied.length) notes.push(`copied ${include.copied.length} .worktreeinclude file(s)`);
  for (const f of include.failed) failures.push({ step: 'worktree-include', reason: `${f.file}: ${f.reason}` });

  if (!config) return { notes, failures };

  // Equipment sources sit at the planning root (the project root) and land at
  // the same place inside the new checkout. A planning root outside the
  // repository falls back to the repository root on both sides.
  const rel = planningRoot ? path.relative(sourceTop, canonical(planningRoot)) : '';
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const sourceDir = inside ? path.join(sourceTop, rel) : sourceTop;
  const targetDir = inside ? path.join(worktreeDir, rel) : worktreeDir;

  if (config.copyToolConfig) {
    const copy = (steps.copyToolConfig || copyToolConfig)(sourceDir, targetDir);
    if (copy.copied.length) notes.push(`copied ${copy.copied.join(', ')}`);
    if (copy.existing.length) notes.push(`left existing ${copy.existing.join(', ')} untouched`);
    for (const f of copy.failed) failures.push({ step: 'tool-config', reason: `${f.file}: ${f.reason}` });
  }

  const deps = (steps.provisionDeps || provisionDeps)(
    config.deps,
    sourceDir,
    targetDir,
    config.installCommand,
    installTimeoutMs || DEFAULT_INSTALL_TIMEOUT_MS
  );
  if (deps.done) notes.push(`dependencies: ${deps.mode}ed`);
  else if (deps.failed) failures.push({ step: 'dependencies', reason: `${deps.mode}: ${deps.reason}` });
  else if (deps.reason !== 'disabled') notes.push(`dependencies: ${deps.reason}`);

  return { notes, failures };
}

// ─── WorktreeCreate ──────────────────────────────────────────────────────────

function validateName(raw) {
  if (typeof raw !== 'string' || raw === '') return 'the payload carries no worktree name';
  if (!NAME_PATTERN.test(raw)) {
    return `worktree name ${JSON.stringify(raw)} must be 1-128 characters of [A-Za-z0-9._-], starting with a letter or digit`;
  }
  if (raw.includes('..') || raw.endsWith('.') || raw.endsWith('.lock')) {
    return `worktree name ${JSON.stringify(raw)} cannot form a git branch name (no "..", no trailing "." or ".lock")`;
  }
  return null;
}

function resolveCwd(data, options) {
  if (options.cwd) return options.cwd;
  if (typeof data.cwd === 'string' && path.isAbsolute(data.cwd) && isDirectory(data.cwd)) return data.cwd;
  return process.cwd();
}

/** Undo a creation the harness is about to report as failed. */
function rollback(mainRoot, worktreeDir, branch, git) {
  git(['worktree', 'remove', '--force', worktreeDir], mainRoot, { timeoutMs: GIT_WORKTREE_TIMEOUT_MS });
  git(['branch', '-D', branch], mainRoot);
}

/**
 * Handle one WorktreeCreate payload. Returns
 *   `{ outcome: 'created' | 'reused', path, branch, baseSha, notes[], warnings[] }`
 * or `{ outcome: 'refused', code, reason, … }`. Never prints, never exits.
 */
function createWorktree(data, options = {}) {
  const git = options.git || runGit;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return refuse(REFUSAL.INVALID_PAYLOAD, 'the hook payload is not a JSON object');
  }
  const nameProblem = validateName(data.name);
  if (nameProblem) return refuse(REFUSAL.INVALID_NAME, nameProblem);
  const name = data.name;
  const branch = BRANCH_PREFIX + name;

  const cwd = resolveCwd(data, options);
  const roots = resolveMainRoot(cwd, git);
  if (!roots) return refuse(REFUSAL.NOT_A_REPOSITORY, `${cwd} is not inside a git repository`);
  const { sourceTop, mainRoot } = roots;

  if (!git(['check-ref-format', '--branch', branch], mainRoot).ok) {
    return refuse(REFUSAL.INVALID_NAME, `"${branch}" is not a valid git branch name`);
  }

  const baseSha = resolveHead(cwd, git);
  if (!baseSha) return refuse(REFUSAL.NO_HEAD, `HEAD does not resolve to a commit in ${sourceTop} (a repository with no commits?)`);

  const worktreeDir = path.join(mainRoot, ...WORKTREES_DIR_SEGMENTS, name);

  if (fs.existsSync(worktreeDir)) {
    // Resuming a kept worktree (`claude --worktree <name> --resume`) asks for
    // the same name again: the checkout this hook made earlier is the answer.
    // Anything else at that path is not ours to take over.
    const entry = findWorktreeEntry(mainRoot, worktreeDir, git);
    if (entry && entry.branch === `refs/heads/${branch}`) {
      return { outcome: 'reused', path: worktreeDir, branch, baseSha: null, notes: ['reused the existing worktree'], warnings: [] };
    }
    return refuse(
      REFUSAL.PATH_EXISTS,
      `${worktreeDir} already exists and is not the worktree of branch ${branch}; remove it or choose another name`,
      { path: worktreeDir }
    );
  }
  if (branchExists(mainRoot, branch, git)) {
    return refuse(
      REFUSAL.BRANCH_EXISTS,
      `branch ${branch} already exists (left by an earlier worktree?); delete it (git branch -D ${branch}) or choose another name`,
      { branch }
    );
  }

  const planningRoot = findPlanningRoot(cwd);
  const config = options.config !== undefined ? options.config : readConfig(planningRoot);
  const notes = [];

  // Base freshness — the one check that refuses on its own, and it does so
  // BEFORE anything exists on disk. From the main checkout the base is its
  // own HEAD (lag 0); from a linked worktree it is that worktree's HEAD,
  // which can trail main.
  if (config && config.maxBaseLag > 0) {
    const mainHeadSha = canonical(sourceTop) === mainRoot ? baseSha : resolveHead(mainRoot, git);
    const lag = (options.measureBaseLag || measureBaseLag)(mainRoot, baseSha, mainHeadSha, git);
    if (lag.unknown) {
      notes.push(`base freshness unverified — ${lag.unknown}`);
    } else if (lag.behind > config.maxBaseLag) {
      return refuse(
        REFUSAL.BASE_TOO_STALE,
        `the base (${baseSha.slice(0, 12)}) is ${lag.behind} commit(s) behind the main checkout, over the limit of ` +
          `${config.maxBaseLag} (workflow.worktree_max_base_lag). Plans written against it would be written against ` +
          `code that has already moved. Update the checkout this forks from, then create the worktree again.`,
        { behind: lag.behind, maxBaseLag: config.maxBaseLag }
      );
    } else if (lag.behind > 0) {
      notes.push(`base is ${lag.behind} commit(s) behind main (limit ${config.maxBaseLag})`);
    }
  }

  const added = git(['worktree', 'add', '-b', branch, worktreeDir, baseSha], mainRoot, { timeoutMs: GIT_WORKTREE_TIMEOUT_MS });
  if (!added.ok) {
    return refuse(REFUSAL.GIT_FAILED, `git worktree add failed: ${gitDetail(added)}`);
  }

  const equipped = equipWorktree(
    { sourceTop, worktreeDir, planningRoot, config, installTimeoutMs: options.installTimeoutMs },
    options.steps || {}
  );
  notes.push(...equipped.notes);

  if (equipped.failures.length && config && config.strict) {
    rollback(mainRoot, worktreeDir, branch, git);
    return refuse(
      REFUSAL.PROVISION_FAILED,
      `worktree equipment failed and workflow.worktree_provision_strict is on, so the worktree was removed again: ` +
        equipped.failures.map((f) => `${f.step} (${f.reason})`).join('; '),
      { failures: equipped.failures }
    );
  }

  return {
    outcome: 'created',
    path: worktreeDir,
    branch,
    baseSha,
    notes,
    warnings: equipped.failures,
  };
}

// ─── WorktreeRemove ──────────────────────────────────────────────────────────

/**
 * Whether deleting `branch` loses nothing: its tip is reachable from another
 * branch or remote-tracking ref, or from the main checkout's HEAD. An agent
 * that committed nothing leaves its branch at the base, which the branch it
 * forked from still contains.
 */
function branchIsReachableElsewhere(mainRoot, branch, git) {
  const ref = `refs/heads/${branch}`;
  const tip = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], mainRoot);
  if (!tip.ok) return false;
  const sha = tip.stdout.trim();
  const containing = git(['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes'], mainRoot);
  if (containing.ok && containing.stdout.split(/\r?\n/).some((r) => r && r !== ref)) return true;
  return git(['merge-base', '--is-ancestor', sha, 'HEAD'], mainRoot).ok;
}

/**
 * Handle one WorktreeRemove payload. Returns
 *   `{ outcome: 'removed', path, branch, branchDeleted, notes[] }`
 * or `{ outcome: 'refused', code, reason }`. Only worktrees under
 * `<main checkout>/.claude/worktrees/` are touched: `remove --force` on an
 * arbitrary path is not a cleanup this hook may perform.
 */
function removeWorktree(data, options = {}) {
  const git = options.git || runGit;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return refuse(REFUSAL.INVALID_PAYLOAD, 'the hook payload is not a JSON object');
  }
  const rawPath = data.worktree_path;
  if (typeof rawPath !== 'string' || !path.isAbsolute(rawPath)) {
    return refuse(REFUSAL.INVALID_PAYLOAD, 'the payload carries no absolute worktree_path');
  }
  const worktreeDir = path.resolve(rawPath);
  const present = fs.existsSync(worktreeDir);

  const roots = resolveMainRoot(present ? worktreeDir : resolveCwd(data, options), git);
  if (!roots) return refuse(REFUSAL.NOT_A_REPOSITORY, `${worktreeDir} does not belong to a git repository this hook can see`);
  const { mainRoot } = roots;

  const managedDir = path.join(mainRoot, ...WORKTREES_DIR_SEGMENTS);
  if (canonical(path.dirname(worktreeDir)) !== canonical(managedDir)) {
    return refuse(REFUSAL.NOT_MANAGED, `${worktreeDir} is not under ${managedDir}; refusing to remove it`);
  }

  const notes = [];
  let branch = BRANCH_PREFIX + path.basename(worktreeDir);
  if (present) {
    const entry = findWorktreeEntry(mainRoot, worktreeDir, git);
    if (!entry) {
      return refuse(REFUSAL.NOT_MANAGED, `${worktreeDir} is not a git worktree of ${mainRoot}; refusing to remove it`);
    }
    if (entry.branch && entry.branch.startsWith('refs/heads/')) branch = entry.branch.slice('refs/heads/'.length);
    const removed = git(['worktree', 'remove', '--force', worktreeDir], mainRoot, { timeoutMs: GIT_WORKTREE_TIMEOUT_MS });
    if (!removed.ok) return refuse(REFUSAL.GIT_FAILED, `git worktree remove failed: ${gitDetail(removed)}`);
  } else {
    // Already gone from disk: drop git's stale registration so the name can be reused.
    git(['worktree', 'prune'], mainRoot);
    notes.push('the directory was already gone');
  }

  let branchDeleted = false;
  if (branch.startsWith(BRANCH_PREFIX) && branchExists(mainRoot, branch, git)) {
    if (branchIsReachableElsewhere(mainRoot, branch, git)) {
      branchDeleted = git(['branch', '-D', branch], mainRoot).ok;
      if (!branchDeleted) notes.push(`could not delete branch ${branch}`);
    } else {
      notes.push(`kept branch ${branch}: it carries commits no other branch contains`);
    }
  }
  return { outcome: 'removed', path: worktreeDir, branch, branchDeleted, notes };
}

// ─── dispatch + stdin adapter ────────────────────────────────────────────────

function handle(data, options = {}) {
  const event = data && typeof data === 'object' ? data.hook_event_name : undefined;
  if (event === 'WorktreeRemove') return removeWorktree(data, options);
  if (event === 'WorktreeCreate') return createWorktree(data, options);
  if (event === undefined && data && typeof data === 'object' && 'worktree_path' in data && !('name' in data)) {
    return removeWorktree(data, options);
  }
  if (event === undefined) return createWorktree(data, options);
  return refuse(REFUSAL.INVALID_PAYLOAD, `unexpected hook event ${JSON.stringify(event)}`);
}

function writeAll(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) offset += fs.writeSync(fd, buf, offset, buf.length - offset);
}

function logLine(text) {
  try {
    writeAll(2, `gsd-worktree-provision: ${text}\n`);
  } catch {
    /* a lost diagnostic must not change the outcome */
  }
}

function finish(result) {
  if (result.outcome === 'refused') {
    logLine(result.reason);
    terminateNow(EXIT_OUTCOME_FOR_REFUSAL[result.code] || 'INTERNAL', undefined);
    return;
  }
  if (result.outcome === 'created' || result.outcome === 'reused') {
    // The path is the ONLY stdout. If it cannot be written the harness gets no
    // path and fails the creation, which is the truth.
    writeAll(1, result.path);
    logLine(`${result.outcome} ${result.path} on ${result.branch}${result.baseSha ? ` from ${result.baseSha.slice(0, 12)}` : ''}`);
    for (const note of result.notes) logLine(note);
    for (const w of result.warnings) logLine(`warning: ${w.step} not provisioned (${w.reason})`);
    terminateNow('PASS', undefined);
    return;
  }
  logLine(`removed ${result.path}${result.branchDeleted ? ` and branch ${result.branch}` : ''}`);
  for (const note of result.notes) logLine(note);
  terminateNow('PASS', undefined);
}

/* istanbul ignore next -- stdin adapter, exercised via the process seam in tests */
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => {
    finish(refuse(REFUSAL.INVALID_PAYLOAD, `no hook payload arrived on stdin within ${STDIN_TIMEOUT_MS} ms`));
  }, STDIN_TIMEOUT_MS);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      finish(refuse(REFUSAL.INVALID_PAYLOAD, 'the hook payload is not valid JSON'));
      return;
    }
    if (process.env.GSD_DEBUG) logLine(`payload ${JSON.stringify(data)}`);
    let result;
    try {
      result = handle(data);
    } catch (err) {
      logLine(`internal error: ${err && err.stack ? err.stack : String(err)}`);
      terminateNow('INTERNAL', undefined);
      return;
    }
    finish(result);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  handle,
  createWorktree,
  removeWorktree,
  equipWorktree,
  measureBaseLag,
  copyToolConfig,
  copyWorktreeInclude,
  provisionDeps,
  readConfig,
  validateName,
  REFUSAL,
  EXIT_OUTCOME_FOR_REFUSAL,
  TOOL_CONFIG_FILES,
  BRANCH_PREFIX,
};
