---
type: Fixed
pr: 0
---
**Worktree guards run inside Claude Code's worktree isolation** — Claude Code 2.1.310 and later refuse `$(git …)`, `git -C`, `cd … &&` and computed git/node arguments inside an `isolation="worktree"` agent, which was every mandatory block a GSD sub-agent ran there: the branch check, the cwd-drift sentinel, the absolute-path and `<automated>` containment checks, the supplied-root pin, the pre-commit HEAD check, the plan ledger and quick's plan materialisation. Each is now a `gsd-tools worktree guard <stage>` / `worktree plan-ledger` / `worktree materialize` verb with typed JSON and the old exit codes (42 for the branch check); any fault of the verb is a refusal. Orchestrators substitute the literal launch `gsd_tools_cmd` (new in `init.execute-phase`, `init.quick`, `init.quick-batch`, and `worktree tools-cmd`) for `{GSD_TOOLS_CMD}`. `/gsd-quick-batch` executors now run the branch check too. ADR-5211.
