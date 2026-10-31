/**
 * gsd-tools-invocation.cts — the literal command that launches THIS gsd-tools
 * (ADR-5211).
 *
 * ## Why this module exists
 *
 * A sub-agent in Claude Code's `isolation: "worktree"` (≥ 2.1.310) may only run
 * Bash the host can verify without executing it: no `$(git …)`, no variables in
 * a node or git argument. The `gsd_run` launcher every workflow defines is
 * exactly that kind of shell (it probes `$HOME`, `$(git rev-parse …)` and a dozen
 * config dirs), so an isolated sub-agent cannot use it. What it can run is a
 * literal `node '<absolute path>' <literal args>`.
 *
 * Only the orchestrator knows that path reliably: it already reached this
 * gsd-tools through the launcher's identity-checked resolution. So `init`
 * reports `gsd_tools_cmd` — the realpath of the running `gsd-tools.cjs`,
 * shell-quoted — and the orchestrator substitutes it for `{GSD_TOOLS_CMD}` in
 * the sub-agent's prompt at dispatch, the same build-time substitution it
 * performs for `{EXPECTED_BASE}` and `{PINNED_ROOT}`.
 *
 * Rejected alternatives (ADR-5211): an installer-written literal path (breaks a
 * portable `$HOME` and committed `--local` installs, #4377), PATH export
 * (#5465 reached 5 of 122 sessions and loses the identity proof), scripts by
 * literal path (pass only because the host never reads the body).
 *
 * The path is this module's own sibling, `../gsd-tools.cjs`, not
 * `process.argv[1]`: an in-process caller (a test, the SDK bridge) has a
 * different entry script, but the tool that shipped this module is always the
 * one beside it. A `--local` install resolves to the copy inside the project's
 * shared checkout, which the host check accepts (probe P2, 2026-10-30).
 */

import fs from 'node:fs';
import path from 'node:path';
import { escapeSingleQuotedShellLiteral, posixNormalize } from './shell-command-projection.cjs';

export interface GsdToolsInvocation {
  /** Realpath of the gsd-tools.cjs this module ships beside, in forward-slash form. */
  gsd_tools_path: string | null;
  /** `node '<gsd_tools_path>'`, ready to prefix literal arguments; null when unresolvable. */
  gsd_tools_cmd: string | null;
}

export interface InvocationDeps {
  /** The gsd-tools.cjs to describe; defaults to this module's sibling. */
  toolPath?: string;
  realpath?: (p: string) => string;
  isFile?: (p: string) => boolean;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Describe the literal invocation of this gsd-tools. Never throws: an
 * unresolvable tool yields nulls, which a dispatch must treat as HALT — a
 * sub-agent with no launch literal cannot run its guards.
 */
export function resolveGsdToolsInvocation(deps: InvocationDeps = {}): GsdToolsInvocation {
  const toolPath = deps.toolPath ?? path.join(__dirname, '..', 'gsd-tools.cjs');
  const realpath = deps.realpath ?? ((p: string) => fs.realpathSync.native(p));
  const isFile = deps.isFile ?? defaultIsFile;
  let resolved: string;
  try {
    resolved = realpath(toolPath);
  } catch {
    return { gsd_tools_path: null, gsd_tools_cmd: null };
  }
  if (!isFile(resolved)) return { gsd_tools_path: null, gsd_tools_cmd: null };
  // Forward slashes on every platform: git-bash, the shell Claude Code drives on
  // Windows, takes `C:/…`, and a backslash inside the quoted literal would be
  // one more transit hazard for nothing (#4254's Windows lesson).
  const forward = posixNormalize(resolved);
  return {
    gsd_tools_path: forward,
    gsd_tools_cmd: `node '${escapeSingleQuotedShellLiteral(forward)}'`,
  };
}

/** `gsd-tools worktree tools-cmd`: the invocation as JSON, or with `--raw` the command alone. */
export function cmdGsdToolsCmd(raw: boolean): GsdToolsInvocation {
  const inv = resolveGsdToolsInvocation();
  const text = raw ? `${inv.gsd_tools_cmd ?? ''}\n` : `${JSON.stringify(inv, null, 2)}\n`;
  const buf = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buf.length) offset += fs.writeSync(1, buf, offset, buf.length - offset);
  if (inv.gsd_tools_cmd === null) process.exitCode = 1;
  return inv;
}
