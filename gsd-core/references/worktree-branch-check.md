# Worktree branch check (spawn-time guard)

Canonical, fail-closed, **verify-only** guard embedded into every worktree sub-agent
prompt at dispatch. This is the single source of truth for the `worktree_branch_check`
block — do not inline a copy elsewhere. History of coordinated edits: #2924, #2015, #3174, #48.
The check itself is gsd-tools' `worktree guard branch` verb (ADR-5211): Claude Code ≥ 2.1.310
refuses the bash this block used to carry inside an `isolation="worktree"` agent.

**Contract for orchestrators:** before dispatch, capture `EXPECTED_BASE=$(git rev-parse HEAD)`,
then embed the block below into the sub-agent prompt verbatim, substituting `{GSD_TOOLS_CMD}`
with `gsd_tools_cmd` from the workflow's `init` JSON (already shell-quoted — paste it as is) and
`{EXPECTED_BASE}` with that captured SHA. Orchestrators that intentionally create a docs-only
pre-dispatch plan commit may also substitute `{EXPECTED_BASE_ALTERNATE}` with that commit's
immediate parent so runtimes that fork from either side of the docs-only commit pass the same
fail-closed guard (#1265). Otherwise substitute `{EXPECTED_BASE_ALTERNATE}` with an empty
string. A null `gsd_tools_cmd` means this gsd-tools cannot describe its own launch: halt the
dispatch rather than ship a guard that cannot run. The sub-agent only *verifies* and fails
closed; the orchestrator (the worktree lifecycle owner) performs any base recovery — the
sub-agent never rewrites a worktree it did not create (#48).

<worktree_branch_check>
FIRST ACTION: HEAD assertion MUST run before anything else, and this block is
VERIFY-ONLY. Worktrees spawned by Claude Code's `isolation="worktree"` use the
`agent-<id>` namespace (previously `worktree-agent-<id>`; both are accepted, as is
`worktree-wf_<id>`). The orchestrator owns this worktree's lifecycle; a sub-agent MUST NOT
hold state-correction primitives (hard-reset, update-ref, force-move, index-discard) on a
worktree it did not create (#48, #2924). Run this exact command, as one Bash call:
```bash
{GSD_TOOLS_CMD} worktree guard branch --expected-base {EXPECTED_BASE} --alternate-base '{EXPECTED_BASE_ALTERNATE}' || exit 42
```
It refuses a detached HEAD, a protected branch (main, master, develop, trunk, release/*),
a branch outside the agent namespace, and a HEAD that is not the expected (or alternate)
base. ANY non-zero exit — the guard's own refusal, or the command failing to run — means
HALT immediately: report the JSON `code` it printed, `exit 42`, and let the orchestrator
(the lifecycle owner) decide recovery. Do NOT self-recover (never `git update-ref`), do NOT
skip or rewrite the command, do NOT commit.
</worktree_branch_check>
