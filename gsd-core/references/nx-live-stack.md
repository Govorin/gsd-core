# Live Nx stack (`mcp__nx-tasks__*`)

The user may have part of an Nx monorepo running in a terminal: `nx serve`, `nx run-many -t serve`, `nx run`. The `nx-tasks` server reads those runs' screens. It is for observing the user's stack, never for driving it.

First call `nx_running_tasks`. If the tools are absent or it lists no run, nothing below applies.

## Tools

- `nx_running_tasks` — runs by nx pid, each task with its status.
- `nx_task_output(task, pid?, tail?, grep?)` — a task's screen, lines numbered. `task` is the id or any part of it (`api:serve`, `api`); `grep` is a case-insensitive regex.
- `nx_wait_for(task, pattern?, timeoutMs?)` — blocks until a NEW line matches `pattern`, the task's status changes, or the run ends. Lines already on screen never fire. Default 60 s, at most 600 s.

## Whose code the runs build

The user's runs watch the user's checkout. If you work in a linked worktree (`git rev-parse --git-dir` differs from `git rev-parse --git-common-dir`; the executor's `worktree guard sentinel` reports `applies: true`), or you edit files in a worktree you added, the runs never see your edits. Their output says nothing about your change: a clean screen is not proof that it builds, and an error on it is not yours to claim or fix.

## When

- **Executor, code fixer** — only when your edits are in the checkout the run watches. The watcher rebuilds the project you edited. Before you report done, read `nx_task_output(task, tail: 40)` and `nx_task_output(task, grep: "error|failed")`. An error line numbered after the last compiled/ready line is a build failure from your edit: it is part of this task, so fix it before you report. Do not start a second copy to check.
- **Debugger.** Read the live output before you reproduce anything: `nx_task_output(task, grep: "<symptom>|error|warn")`. That is your first evidence, not a restart. After a fix, `nx_wait_for(task, pattern: "compiled|ready|error")` shows how the rebuild went.
- **Verifier, DOM verifier.** Before a live check against a running service (curl, a browser), find its task with `nx_running_tasks`; if it is still building, `nx_wait_for(task, pattern: "compiled|ready|listening|running on", timeoutMs: 120000)`. A failed task, or an error after the last ready line, is evidence: quote the numbered lines.

## Limits

- Only runs with the Nx TUI on are listed, and only those started after the server came up. Nx turns the TUI off for a single-task run (`nx serve app`) unless `NX_TUI=true`, for `--outputStyle=stream|static`, in CI, and under an AI agent unless the run passes `--tui` — so an `nx` run you start yourself is not listed either. A task missing from the list may still be running.
- Never start, restart or stop the user's services, and never `kill` or `pkill` an nx process. If a restart is needed, ask for it (a checkpoint, or a human-verification item), then `nx_wait_for` the new run.
