# ADR-5211: Worktree guards are CLI verbs, launched by a literal invocation the orchestrator substitutes at dispatch

- **Status:** Accepted — fork-local (mn fork, 2026-10-31); implemented in `src/worktree-guard.cts`, `src/automated-command-containment.cts`, `src/posix-ere.cts`, `src/worktree-agent-branch.cts`, `src/gsd-tools-invocation.cts` and the guard blocks of `gsd-core/references/worktree-branch-check.md`, `gsd-core/references/worktree-path-safety.md` and `agents/gsd-executor.md`.
- **Date:** 2026-10-30 (proposed), 2026-10-31 (accepted)
- **Issue:** none — the fork files no upstream issues; the number follows ADR-5210. Evidence: `.plans/worktree-isolation-verifier.md`; plan and deviations: `.plans/worktree-guard-verbs.md`.
- **Builds on:** [ADR-3473](3473-enforcement-by-construction.md) (one owner per invariant), [ADR-3409](3409-unreachable-shell-guard-arms.md) (an unreachable answer is a refusal), [ADR-4630](4630-dispatch-identity-and-isolation-decision-seam.md) (dispatch isolation), [ADR-4650](4650-path-containment-and-filename-classification-seam.md) (path containment), [ADR-457](457-generated-cjs-single-source.md) (`src/*.cts` → generated `.cjs`).
- **Amends / supersedes:** nothing.

## Context

Claude Code ≥ 2.1.310 refuses Bash it cannot verify without running it inside an `isolation: "worktree"` agent: `$(git …)`, `git -C <shared checkout>`, `cd … &&`, variables in git, node or sed arguments. Every mandatory block a GSD sub-agent ran in a worktree was written in exactly those forms — the `gsd_run` resolver, `worktree_branch_check`, the cwd-drift sentinel (0a), the absolute-path check (0b), the `<automated>` containment scan (0c, 15.8 KB of bash), the supplied-root pin (0p), the pre-commit HEAD check, the plan ledger, and quick's plan materialisation. A refused guard gets improvised or skipped, and a skipped branch check is the failure it exists to prevent (#2924, #48).

Probes from a worktree-isolated agent (2026-10-30, Claude Code 2.1.314, table in the verifier note) settled the shape: a literal `node '<absolute path>' <literal args>` passes, including a path into the shared checkout (a `--local` install); git inside node is not inspected; `|| exit 42`, quoting, heredoc on stdin and `$( )` around node all pass; a bare `gsd_run` is not defined in the agent's shell.

Three non-fixes:

- **An installer-written literal path.** Breaks the portable `$HOME` and committed `--local` installs (#4377, upstream #5637), moves 150 launcher copies in every runtime's emitted bytes, and leaves the `$(git …)` inside the guard blocks.
- **PATH export** (#5465). Reached 5 of 122 sessions, has no Windows shim, and drops the launcher's identity proof.
- **Scripts by literal path.** Pass only because the host does not read the body; the next host release can.

## Decision

1. **Guards are verbs with typed results.** `gsd-tools worktree guard <branch|pre-commit|sentinel|abs-path|automated|pin>`, `worktree plan-ledger` and `worktree materialize` each print `{ok, stage, code, exit_code, applies, detail}`. The exit codes keep the old contract: a `branch` or `materialize` refusal exits 42 (#48), any other refusal 1. Any fault of the verb itself — git missing, timing out or answering empty, an unknown stage, a missing, repeated or unknown flag, an internal error — is a refusal (ADR-3409). git runs from node against the invoking cwd, never the main-worktree remap gsd-tools applies to planning commands.
2. **One owner per guard** (ADR-3473). The branch policies live in `worktree-agent-branch.cts` and `worktree-safety.cts` imports them. Step 0c is a verbatim port of the bash grammar, evaluated with grep's leftmost-longest semantics by the vendored RE2 (`LONGEST_MATCH`); JavaScript's leftmost-first RegExp would change which text the scan extracts. Path containment goes through `tryWithinRoot` (ADR-4650).
3. **`init` exposes the launch.** `init.execute-phase`, `init.quick` and `init.quick-batch` report `gsd_tools_cmd` — `node '<realpath of the gsd-tools.cjs beside the module>'`, forward slashes, POSIX-quoted — and `worktree tools-cmd` gives the same to workflows without an init. The orchestrator substitutes it for `{GSD_TOOLS_CMD}` at build time, beside `{EXPECTED_BASE}` and `{PINNED_ROOT}`, and every executor prompt carries it in a `<gsd_tools_launcher>` block. A null value halts the dispatch.
4. **In an isolated dispatch, GSD tools take literal arguments only.** The executor runs `{GSD_TOOLS_CMD} <args>` with every value written out and never the resolver line; with no launcher block (a legacy or non-isolated dispatch) `{GSD_TOOLS_CMD}` is `gsd_run`.
5. **One form for every runtime, no converter change.** The verbs and the substitution are the same on every host; only Claude Code's check made them necessary.
6. **Our own mandatory blocks are linted against the probe table** (`tests/worktree-dispatch-shell-forms.test.cjs`, a conservative model of the refused forms whose positive control is the frozen bash).

## Consequences

- The guards are tested on typed JSON. Before the bash was deleted, a differential suite ran frozen bash snapshots and the verbs over the whole corpus — the 142 rows of the #4767 suite, 300 generated commands, 60 branch-check and 84 pre-commit combinations, 15 pin, 5 sentinel, 8 absolute-path and 1 ledger case: 615 rows, identical exit codes except three recorded strengthenings (an unresolvable root refuses where the bash took an empty root as "everything inside"; an empty sentinel refuses where the bash passed forever; `abs-path` resolves `..` and symlinks where the bash compared string prefixes). `tests/worktree-guard-matrix.test.cjs` and `tests/automated-command-containment.test.cjs` keep the settled verdicts.
- About −24 KB in `worktree-path-safety.md`, which every parallel executor prompt inlines; −1.9 KB in `gsd-executor.md`; `plan-phase.md` untouched.
- `quick-batch`'s harness-worktree dispatch now carries the branch check it never had.
- The prompt depends on `init` exposing `gsd_tools_cmd`. A gsd-tools older than this ADR has no guard verbs: a mid-run version skew needs a reinstall, and a missing verb is a HALT, never a skip.
- Main-session workflows keep the `gsd_run` resolver; only sub-agent guard blocks changed.
- **Residual risk: `execute-plan.md`.** The parallel executor's prompt inlines `execute-plan.md`, which is full of `X=$(gsd_run …)` captures and `gsd_run` calls with shell variables. Inside isolation those forms are refused; the executor's launcher rule tells it to run each as `{GSD_TOOLS_CMD} <args>` with the values written out, but that is an instruction to translate, not text that already passes. The mandatory guard steps no longer depend on it; the bookkeeping steps (frontmatter status, state recording) still do. Rewriting that workflow is a separate change.
- Defence in depth stays: Claude Code's own check, the `gsd-worktree-path-guard` hook, the verbs.
- `--local` installs use the same literal: probe P2 showed the host accepts a script path inside the shared checkout.

## Alternatives rejected

- An installer-written literal path to `gsd-tools.cjs` (see Context).
- Shell scripts run by literal path.
- A bare `gsd_run` through PATH.
- A table of refused shell forms in the executor prompt: the rules belong to one host's version, change without notice, and do not apply to the other eleven runtimes.
