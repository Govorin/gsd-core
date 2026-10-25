/**
 * `gsd_run check mn-clean-state` — refuses to ship while the session left the working tree dirty
 * or git halfway through an operation (mn-verify-gate; replaces scripts/clean-state.mjs).
 *
 * ── What existed and what was missing ────────────────────────────────────
 *
 * ship.md ("Clean working tree?") asks the model to run `git status --short` and stop on output.
 * That is discipline, not mechanism; here the same check becomes a verdict.
 *
 * And `git status` cannot show everything: a stopped rebase or cherry-pick can leave the tree
 * clean while history sits halfway through an operation. Only git's own marker files show it
 * (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, `rebase-apply/`), and their
 * path is asked from git (`rev-parse --git-path`) — in a linked worktree `.git` is a file.
 *
 * ── What is NOT checked, and why ─────────────────────────────────────────
 *
 * `.planning/` is excluded: planning state changes while the work runs, and requiring it clean
 * would block every phase. A leftover `.continue-here.md` is not counted either.
 *
 * ── Scope ────────────────────────────────────────────────────────────────
 *
 * The whole project (its git working tree), not a phase: the script took `--dir` only to choose
 * where git runs. The verb is project-scoped and ignores the phase the dispatcher appends.
 *
 * Not a git repository, or git failing, is "could not check" (`unresolvable`) — never "unclean":
 * the reader would be sent to clean a tree that was never examined.
 */

import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import { statEvidence } from './gate-evidence.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnProject } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';

// This gate's verdicts, built here so its failing arms are visible in its own file to the
// positive-control lint (#5204); gate-mn-support owns the payload shape.
function mnPass(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('pass', false, mnPayload(MN_GATE_STATUS.PASS, message, details));
}
function mnFinding(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, mnPayload(MN_GATE_STATUS.FINDING, message, details));
}
/** Could not look: outcome `unreadable` (exit 69, routed by the gate's `onError`), blocking. */
function mnUnreadable(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateUnreadable(true, mnPayload(MN_GATE_STATUS.UNRESOLVABLE, message, details));
}

/** The git seam — injected so tests can drive a failing git without breaking the host's. */
export interface CleanStateDeps {
  runGit(args: string[], cwd: string): SpawnResultOutput;
}

const DEFAULT_DEPS: CleanStateDeps = {
  runGit: (args, cwd) => execGit(args, { cwd, timeout: 15_000 }),
};

/** How many changed paths the message lists before it counts the rest. */
export const CLEAN_STATE_SHOWN = 10;

const OPERATIONS: ReadonlyArray<readonly [string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
];

class GitFailure extends Error {}

function git(deps: CleanStateDeps, args: string[], cwd: string): string {
  const r = deps.runGit(args, cwd);
  if (r.exitCode !== 0 || r.timedOut) {
    throw new GitFailure(`git ${args[0] ?? ''} failed: ${(r.stderr || (r.error ? r.error.message : '') || `exit ${r.exitCode}`).trim()}`);
  }
  return r.stdout;
}

/**
 * Changed paths from `git status --porcelain=v2 -z`. Version 2, not 1: every v2 record starts
 * with a type letter, so the shared exec seam trimming its output cannot eat a leading-space
 * status code (` M path` in v1). A rename/copy (`2 ...`) is followed by a second NUL-terminated
 * record holding the ORIGINAL path, which is skipped — reporting it would name a path that is gone.
 */
export function parsePorcelainV2(out: string): string[] {
  const records = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? '';
    if (rec === '') continue;
    const type = rec[0];
    if (type === '1') {
      paths.push(rec.split(' ').slice(8).join(' '));
    } else if (type === '2') {
      paths.push(rec.split(' ').slice(9).join(' '));
      i++; // the original path
    } else if (type === 'u') {
      paths.push(rec.split(' ').slice(10).join(' '));
    } else if (type === '?' || type === '!') {
      paths.push(rec.slice(2));
    }
  }
  return paths;
}

/** `gsd_run check mn-clean-state [<phase>]` — the phase, if given, is ignored. */
export function evaluateMnCleanState(input: MnGateInput, deps: CleanStateDeps = DEFAULT_DEPS): GateResult {
  return withMnProject('mn-clean-state', () => {
    const cwd = input.projectDir;
    try {
      git(deps, ['rev-parse', '--show-toplevel'], cwd);
    } catch (err) {
      return mnUnreadable(`mn-clean-state: cannot look — not a git repository or git unavailable (${(err as Error).message})`);
    }

    const operations: string[] = [];
    let dirty: string[];
    try {
      for (const [name, label] of OPERATIONS) {
        // `--git-path` prints a path relative to the cwd it ran in, so it is resolved from there.
        const marker = git(deps, ['rev-parse', '--git-path', name], cwd).trim();
        // A marker that cannot be examined is not "no operation in progress".
        const seen = statEvidence(path.resolve(cwd, marker));
        if (seen.kind === 'unreadable') return mnUnreadable(`mn-clean-state: cannot look — ${marker} could not be examined (${seen.reason})`);
        if (seen.kind === 'found' && !operations.includes(label)) operations.push(label);
      }
      dirty = parsePorcelainV2(git(deps, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], cwd)).filter(
        (p) => !p.startsWith('.planning/'),
      );
    } catch (err) {
      if (err instanceof GitFailure) return mnUnreadable(`mn-clean-state: cannot look — ${err.message}`);
      throw err;
    }

    const dirtyShown = dirty.slice(0, CLEAN_STATE_SHOWN);
    const dirtyMore = dirty.length - dirtyShown.length;
    const details = { operations, dirty, dirtyShown, dirtyMore };
    if (operations.length === 0 && dirty.length === 0) {
      return mnPass('mn-clean-state: working tree clean, no git operation in progress', details);
    }
    const parts: string[] = [];
    if (operations.length > 0) parts.push(`git operation not finished: ${operations.join(', ')} — finish or abort it before shipping`);
    if (dirty.length > 0) {
      parts.push(
        `${dirty.length} path(s) changed outside .planning/ — commit or stash them: ${dirtyShown.join(', ')}` +
          (dirtyMore > 0 ? ` … and ${dirtyMore} more` : ''),
      );
    }
    return mnFinding(`mn-clean-state: ${parts.join('; ')}`, details);
  });
}
