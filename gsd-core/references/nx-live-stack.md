# Live Nx stack (`mcp__nx-tasks__*`)

The user may have part of an Nx monorepo running in a terminal: `nx serve`, `nx run-many -t serve`, `nx run`. The `nx-tasks` server reads those runs' screens. It is for observing the user's stack, never for driving it.

First call `nx_running_tasks`. If the tools are absent or it lists no run, nothing below applies.

## Tools

- `nx_running_tasks` — runs by nx pid, each task with its status.
- `nx_task_output(task, pid?, tail?, grep?)` — a task's screen, lines numbered. `task` is the id or any part of it (`api:serve`, `api`); `grep` is a case-insensitive regex.
- `nx_wait_for(task, pattern?, timeoutMs?)` — blocks until a NEW line matches `pattern`, the task's status changes, or the run ends. Lines already on screen never fire. Default 60 s, at most 600 s.

## When

- **Executor.** You edited a project whose task is running, so its watcher rebuilds it. Before you report the task done, read `nx_task_output(task, tail: 40)` and `nx_task_output(task, grep: "error|ERR|failed")`. An error line numbered after the last compiled/ready line is a build failure you caused: fix it inside the task. Do not start a second copy to check.
- **Debugger.** Read the live output before you reproduce anything: `nx_task_output(task, grep: "<symptom>|error|warn")`. That is your first evidence, not a restart. After a fix, `nx_wait_for(task, pattern: "compiled|ready|error")` shows how the rebuild went.
- **Verifier, DOM verifier.** Before a live check against a running service (curl, a browser), find its task with `nx_running_tasks`; if it is still building, `nx_wait_for(task, pattern: "compiled|ready|listening|running on", timeoutMs: 120000)`. A failed task, or an error after the last ready line, is evidence: quote the numbered lines.

## Limits

- Runs started before the server came up are not listed. Nor is an `nx` run you start yourself: Nx turns its TUI off under an AI agent unless the run passes `--tui`. A task missing from the list may still be running.
- Never start, restart or stop the user's services, and never `kill` or `pkill` an nx process. If a restart is needed, ask for it (a checkpoint, or a human-verification item), then `nx_wait_for` the new run.
