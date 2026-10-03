#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Worktree Provisioning — WorktreeCreate hook (mn fork)
//
// Problem: a fresh git worktree is a checkout, not an environment. The tools an
// agent had a moment ago are gone, and it discovers this only by failing.
// Measured, from the ucars retrospective, which names worktree isolation "the
// #1 recurring operational failure across multiple milestones":
//
//   • `mcp__pencil__*` unavailable in every worktree agent — the phase's own
//     design tooling, absent, because `.mcp.json` lives in the main checkout,
//   • the same for atlas (`.planning/ideas/atlas-mcp-backlog.md §B-2`,
//     "tools don't reach GSD agents"),
//   • node_modules missing or symlinked to a stale tree, so the first command
//     the agent runs fails for a reason that has nothing to do with its task,
//   • a base 380 commits behind main, discovered mid-phase.
//
// None of these are the agent's mistake, and none are visible until work is
// already underway. This hook makes the environment part of creating the
// worktree, and — where it cannot — says so BEFORE any work happens.
//
// What it does, each step independently configurable because projects differ:
//
//   1. base freshness — refuses the worktree when its base is behind the
//      branch it forked from by more than `worktree.max_base_lag` commits.
//      Refusing costs one command; discovering it after three plans have been
//      written against stale code costs the phase.
//   2. tool config — copies `.mcp.json` and `.claude/settings.local.json` from
//      the main checkout, so the agent has the same tools it would have had.
//   3. dependencies — `link` (symlink node_modules, fast, the default),
//      `install` (run the project's install command), or `none`.
//
// Failure policy is deliberately split, because the two halves have different
// costs. A stale base BLOCKS: proceeding produces work that must be redone.
// A missing `.mcp.json` or a failed install WARNS: the agent may not need the
// tool at all, and refusing to create a worktree over an optional convenience
// would make isolation itself feel unreliable — which is how people turn it off.
//
// Inert unless `workflow.worktree_provision` is set. On runtimes without a
// WorktreeCreate event the workflow's existing dispatch path is unchanged;
// nothing here is required for a worktree to work, only for it to be equipped.
//
// NOT WIRED on Claude Code's WorktreeCreate. That event REPLACES `git worktree
// add`: the host takes the path the hook prints on stdout and fails creation
// when none is printed. This hook equips a worktree that already exists and
// prints no path, so registering it there would fail every worktree spawn.
// tests/plugin-manifest.test.cjs pins its absence from hooks/hooks.json.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');

/** Files copied into a new worktree when they exist in the main checkout. */
const TOOL_CONFIG_FILES = [
  '.mcp.json',
  path.join('.claude', 'settings.local.json'),
  path.join('.claude', 'settings.json'),
];

const DEFAULT_MAX_BASE_LAG = 200;
const DEFAULT_INSTALL_TIMEOUT_MS = 600000;

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
 * Read the provisioning configuration.
 *
 * `workflow.worktree_provision` is the master switch and is absent by default:
 * this hook copies files and can run an install command, and neither should
 * happen in a project that did not ask for it.
 */
function readConfig(planningRoot) {
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

  return { deps, maxBaseLag, installCommand, copyToolConfig: workflow.worktree_copy_tools !== false };
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  }).trim();
}

/**
 * How far the worktree's HEAD is behind the branch it forked from.
 *
 * Returns `{ behind }`, or `{ unknown: reason }` when the question cannot be
 * answered — which is NOT treated as "fresh". A base check that silently
 * passes when it cannot compare is the same defect class as a gate that cannot
 * run reporting success.
 */
function measureBaseLag(worktreePath, mainPath) {
  let head;
  try {
    head = git(['rev-parse', 'HEAD'], worktreePath);
  } catch {
    return { unknown: 'HEAD did not resolve in the new worktree' };
  }

  // Compare against the main checkout's current HEAD: that is the tree the
  // work will eventually merge back into, and the one whose staleness the
  // retrospective actually recorded ("380 commits behind main at start").
  let mainHead;
  try {
    mainHead = git(['rev-parse', 'HEAD'], mainPath);
  } catch {
    return { unknown: 'HEAD did not resolve in the main checkout' };
  }

  if (head === mainHead) return { behind: 0 };

  try {
    const count = git(['rev-list', '--count', `${head}..${mainHead}`], worktreePath);
    const behind = Number(count);
    if (!Number.isFinite(behind)) return { unknown: 'rev-list did not return a count' };
    return { behind };
  } catch {
    return { unknown: 'rev-list failed (unrelated histories, or a shallow clone)' };
  }
}

/** Copy the tool configuration an agent needs to have the tools it expects. */
function copyToolConfig(mainPath, worktreePath) {
  const copied = [];
  const skipped = [];
  for (const rel of TOOL_CONFIG_FILES) {
    const source = path.join(mainPath, rel);
    const target = path.join(worktreePath, rel);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target)) {
      // Never clobber: a worktree that already carries its own settings is
      // making a deliberate statement, and overwriting it would be the hook
      // deciding something the project already decided.
      skipped.push(rel);
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      copied.push(rel);
    } catch {
      skipped.push(rel);
    }
  }
  return { copied, skipped };
}

/**
 * Make dependencies available.
 *
 * `link` symlinks the main checkout's node_modules — the measured-fast option,
 * and correct whenever the lockfile has not moved, which is the overwhelmingly
 * common case for a phase branch. `install` runs the project's own command for
 * the cases where it has. Neither is safe to guess at, hence the config key.
 */
function provisionDeps(mode, mainPath, worktreePath, installCommand, timeoutMs) {
  if (mode === 'none') return { mode, done: false, reason: 'disabled' };

  if (mode === 'link') {
    const source = path.join(mainPath, 'node_modules');
    const target = path.join(worktreePath, 'node_modules');
    if (!fs.existsSync(source)) return { mode, done: false, reason: 'no node_modules in the main checkout' };
    if (fs.existsSync(target)) return { mode, done: false, reason: 'the worktree already has node_modules' };
    try {
      fs.symlinkSync(source, target, 'dir');
      return { mode, done: true };
    } catch (err) {
      return { mode, done: false, reason: err && err.code ? String(err.code) : 'symlink failed' };
    }
  }

  if (!installCommand) {
    return { mode, done: false, reason: 'workflow.worktree_install_command names no command' };
  }
  const res = spawnSync(installCommand, {
    cwd: worktreePath,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true, // shell:true would otherwise flash a console window (#685)
  });
  if (res.error || res.status !== 0) {
    return {
      mode,
      done: false,
      reason: res.error
        ? `install could not run (${res.error.code || 'unknown'})`
        : `install exited ${res.status}`,
    };
  }
  return { mode, done: true };
}

/**
 * Decide and act on one WorktreeCreate payload. Pure over its injected deps so
 * tests need no git, no network and no install.
 *
 * Returns `{ action: 'allow', notes[] }` or `{ action: 'block', reason }`.
 */
function provisionWorktree(data, options = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow', notes: [] };

  const worktreePath = options.worktreePath || data.worktree_path || data.path || '';
  const mainPath = options.mainPath || data.cwd || process.cwd();
  if (!worktreePath || !fs.existsSync(worktreePath)) {
    // Nothing to provision — the event fired for something this hook cannot
    // see. Silence is right: it is not this hook's place to fail a creation it
    // cannot even locate.
    return { action: 'allow', notes: [] };
  }

  const planningRoot = findPlanningRoot(mainPath);
  if (!planningRoot) return { action: 'allow', notes: [] };

  const config = options.config || readConfig(planningRoot);
  if (!config) return { action: 'allow', notes: [] };

  const notes = [];

  // 1. Base freshness — the one blocking check.
  const measure = options.measureBaseLag || measureBaseLag;
  const lag = measure(worktreePath, planningRoot);
  if (lag.unknown) {
    // Cannot compare ≠ fresh. Warn rather than block: unlike a gate, refusing
    // here strands the phase entirely, and the failure mode being guarded
    // (stale base) is visible to the executor's own first build.
    notes.push(`base freshness unverified — ${lag.unknown}`);
  } else if (config.maxBaseLag > 0 && lag.behind > config.maxBaseLag) {
    return {
      action: 'block',
      behind: lag.behind,
      maxBaseLag: config.maxBaseLag,
      reason:
        `Worktree provisioning: this worktree's base is ${lag.behind} commit(s) behind the main ` +
        `checkout, over the limit of ${config.maxBaseLag} (workflow.worktree_max_base_lag). Plans ` +
        `written against it would be written against code that has already moved — the failure ` +
        `recorded as "worktree 380 commits behind main at start". Update the branch this forks ` +
        `from, then create the worktree again.`,
    };
  } else if (lag.behind > 0) {
    notes.push(`base is ${lag.behind} commit(s) behind main (limit ${config.maxBaseLag})`);
  }

  // 2. Tool configuration — the agent should have the tools it expects.
  if (config.copyToolConfig) {
    const copy = (options.copyToolConfig || copyToolConfig)(planningRoot, worktreePath);
    if (copy.copied.length) notes.push(`copied ${copy.copied.join(', ')}`);
    if (copy.skipped.length) notes.push(`left existing ${copy.skipped.join(', ')} untouched`);
  }

  // 3. Dependencies.
  const deps = (options.provisionDeps || provisionDeps)(
    config.deps,
    planningRoot,
    worktreePath,
    config.installCommand,
    options.installTimeoutMs || DEFAULT_INSTALL_TIMEOUT_MS
  );
  if (deps.done) {
    notes.push(`dependencies: ${deps.mode}ed`);
  } else if (deps.reason !== 'disabled') {
    // A warning, not a block: the phase may not need dependencies at all, and
    // refusing a worktree over an optional convenience is how people come to
    // distrust isolation and turn it off.
    notes.push(`dependencies not provisioned (${deps.mode}: ${deps.reason})`);
  }

  return { action: 'allow', notes };
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
      decision = provisionWorktree(JSON.parse(input));
    } catch {
      crash(HOOK_ON_CRASH.ALLOW, undefined); // provisioning must never be the reason a session stops
    }
    if (!decision) allow(undefined);

    if (decision.action === 'block') {
      const output = {
        decision: 'block',
        reason: decision.reason,
        behind: decision.behind,
        maxBaseLag: decision.maxBaseLag,
      };
      deny(output, decision.reason);
    }

    allow(
      decision.notes && decision.notes.length
        ? { systemMessage: `Worktree provisioning: ${decision.notes.join('; ')}` }
        : undefined
    );
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  provisionWorktree,
  measureBaseLag,
  copyToolConfig,
  provisionDeps,
  readConfig,
  TOOL_CONFIG_FILES,
};
