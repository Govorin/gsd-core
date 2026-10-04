/**
 * Worktree garbage collection — with a unique-commit check that cannot be
 * argued with.
 *
 * Why a separate command: `worktree reap-orphans` sweeps only worktrees that
 * carry a `locked` file (a crash while locked, #3707). A worktree abandoned
 * the ordinary way — the session died, the orchestrator was killed, the wave
 * was interrupted — has no `locked` file and is invisible to that sweeper.
 * `gsd-health` warns about it (W017) but has no repair action. Observed live:
 * 35 abandoned worktrees, 19 GB, a disk full enough to refuse writes — and
 * three of those trees held real work.
 *
 * Hence the one rule that matters here: a branch with commits that exist
 * nowhere else is NEVER deleted, not even with `--yes`. It is reported with
 * the commands to inspect, keep or discard it. Automation that erases
 * unreproducible work is worse than no automation: 19 GB is cheap, 33 commits
 * are not.
 *
 * Fail-closed where the script failed open: when a branch cannot be compared
 * with the main ref (the count is unknown), it is KEPT; and when no main ref
 * resolves at all, nothing is swept. The script read an unknown count as zero
 * and fell back to `master` blindly — in a repo with neither `origin/HEAD`,
 * `main` nor `master` that made every `worktree-*` branch "reapable".
 *
 * A sweeper, not a gate: it reports, it deletes only with `apply`, and it
 * fails only when it cannot look (not a repository, no main ref).
 *
 * Ported from `capabilities/mn-verify-gate/scripts/worktree-gc.mjs`.
 *
 * ADR-457 build-at-publish: source in src/mn-worktree-gc.cts, compiled to
 * gsd-core/bin/lib/mn-worktree-gc.cjs (gitignored).
 */

import fs from 'node:fs';
import { execGit } from './shell-command-projection.cjs';

/** A git call: stdout (trimmed) when it exited 0, else null. */
export type GitRunner = (args: string[], cwd: string) => string | null;

export const defaultGit: GitRunner = (args, cwd) => {
  const r = execGit(args, { cwd, timeout: 30_000 });
  return r.exitCode === 0 ? r.stdout : null;
};

/** The branch-name prefix the worktree tooling creates; nothing else is ever considered. */
export const WORKTREE_BRANCH_PREFIX = 'worktree-';

const DAY_MS = 86_400_000;

export interface KeptBranch {
  branch: string;
  path: string | null;
  reason: string;
  /** Unique commits ahead of the main ref; null when the comparison failed. */
  ahead: number | null;
}

export interface ReapableBranch {
  branch: string;
  path: string | null;
}

export interface WorktreeGcOptions {
  cwd: string;
  /** Actually remove (`--yes`); default is a report. */
  apply: boolean;
  /** Only sweep worktrees older than this many days (`--older-than`). */
  olderThanDays: number;
  now?: () => number;
  _git?: GitRunner;
  /** mtime of a worktree directory, or null when it does not exist. */
  _mtimeMs?: (p: string) => number | null;
}

export type WorktreeGcResult =
  | {
      ok: true;
      main_ref: string;
      branch_count: number;
      reapable: ReapableBranch[];
      kept: KeptBranch[];
      applied: boolean;
      removed: string[];
      /** Branches `apply` tried and failed to delete. */
      failed: string[];
      report: string;
    }
  | { ok: false; reason: 'not_a_repo' | 'no_main_ref'; message: string };

const defaultMtime = (p: string): number | null => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
};

/** `origin/HEAD` when set, else a local `main`, else `master` — only one that actually resolves. */
export function resolveMainRef(git: GitRunner, cwd: string): string | null {
  const origin = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (origin) return origin;
  for (const candidate of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`], cwd) !== null) return candidate;
  }
  return null;
}

/** branch → worktree path, from `git worktree list --porcelain`. */
export function parseWorktreePaths(porcelain: string): Map<string, string> {
  const paths = new Map<string, string>();
  let cur: string | null = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice('worktree '.length);
    else if (line.startsWith('branch ') && cur !== null) paths.set(line.slice('branch '.length).replace('refs/heads/', ''), cur);
  }
  return paths;
}

function renderReport(r: { main_ref: string; branch_count: number; reapable: ReapableBranch[]; kept: KeptBranch[]; applied: boolean; removed: string[]; failed: string[] }): string {
  const out: string[] = [];
  out.push(`main ref: ${r.main_ref}`);
  out.push(`${WORKTREE_BRANCH_PREFIX}* branches: ${r.branch_count} — ${r.reapable.length} reapable, ${r.kept.length} kept`, '');
  if (r.kept.length > 0) {
    out.push('KEPT — holds work that exists nowhere else, or could not be checked:');
    for (const k of r.kept) {
      out.push(`  ${k.branch}  (${k.reason})`);
      if (k.ahead === null || k.ahead > 0) {
        out.push(`      inspect: git log ${r.main_ref}..${k.branch}`);
        out.push(`      keep:    git merge ${k.branch}`);
        out.push(`      discard: git branch -D ${k.branch}`);
      }
    }
    out.push('');
  }
  if (r.reapable.length === 0) {
    out.push('Nothing to reap.');
  } else if (!r.applied) {
    out.push(`DRY RUN — would remove ${r.reapable.length} branch(es) and their worktrees:`);
    for (const b of r.reapable) out.push(`  ${b.branch}${b.path ? `  → ${b.path}` : ''}`);
    out.push('', 'Re-run with --yes to apply.');
  } else {
    out.push(`Removed ${r.removed.length} branch(es); pruned stale worktree registrations.`);
    if (r.failed.length > 0) out.push(`Could not remove: ${r.failed.join(', ')}`);
    if (r.kept.length > 0) out.push(`${r.kept.length} branch(es) kept — see the list above before discarding any.`);
  }
  return `${out.join('\n')}\n`;
}

/** Everything `gsd-tools mn worktree-gc` does except argv parsing and exit. */
export function runWorktreeGc(opts: WorktreeGcOptions): WorktreeGcResult {
  const git = opts._git ?? defaultGit;
  const mtime = opts._mtimeMs ?? defaultMtime;
  const now = (opts.now ?? Date.now)();
  const root = git(['rev-parse', '--show-toplevel'], opts.cwd);
  if (!root) return { ok: false, reason: 'not_a_repo', message: `${opts.cwd} is not inside a git repository` };
  const mainRef = resolveMainRef(git, root);
  if (mainRef === null) {
    return {
      ok: false,
      reason: 'no_main_ref',
      message: 'no main ref resolves (origin/HEAD, main, master) — without one, unique commits cannot be counted, so nothing is swept',
    };
  }

  const branches = (git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], root) ?? '')
    .split('\n')
    .filter((b) => b.startsWith(WORKTREE_BRANCH_PREFIX));
  const worktreePaths = parseWorktreePaths(git(['worktree', 'list', '--porcelain'], root) ?? '');

  const reapable: ReapableBranch[] = [];
  const kept: KeptBranch[] = [];
  for (const branch of branches) {
    const p = worktreePaths.get(branch) ?? null;
    const countText = git(['rev-list', '--count', `${mainRef}..${branch}`], root);
    const ahead = countText !== null && /^\d+$/.test(countText) ? Number(countText) : null;
    const modified = p !== null ? mtime(p) : null;
    const dirty = p !== null && modified !== null ? Boolean(git(['-C', p, 'status', '--porcelain', '--untracked-files=all'], root)) : false;
    const ageDays = modified !== null ? (now - modified) / DAY_MS : Infinity;
    if (ahead === null) kept.push({ branch, path: p, reason: `cannot compare with ${mainRef}`, ahead: null });
    else if (ahead > 0) kept.push({ branch, path: p, reason: `${ahead} unique commit(s)`, ahead });
    else if (dirty) kept.push({ branch, path: p, reason: 'uncommitted changes in worktree', ahead: 0 });
    else if (ageDays < opts.olderThanDays) kept.push({ branch, path: p, reason: `younger than ${opts.olderThanDays}d`, ahead: 0 });
    else reapable.push({ branch, path: p });
  }
  // Unknown counts first (they need a look), then by work at stake.
  kept.sort((a, b) => (b.ahead ?? Infinity) - (a.ahead ?? Infinity));

  const removed: string[] = [];
  const failed: string[] = [];
  if (opts.apply && reapable.length > 0) {
    for (const r of reapable) {
      if (r.path !== null && mtime(r.path) !== null) {
        git(['worktree', 'unlock', r.path], root);
        git(['worktree', 'remove', '--force', r.path], root);
      }
      if (git(['branch', '-D', r.branch], root) !== null) removed.push(r.branch);
      else failed.push(r.branch);
    }
    git(['worktree', 'prune'], root);
  }
  const body = {
    main_ref: mainRef,
    branch_count: branches.length,
    reapable,
    kept,
    applied: opts.apply && reapable.length > 0,
    removed,
    failed,
  };
  return { ok: true, ...body, report: renderReport(body) };
}
