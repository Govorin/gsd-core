---
type: Fixed
pr: 0
---
**Auto mode from a dead run no longer lingers, and isolated executors see the live run** — an auto-chain record now lapses 24 hours after its last refresh and at once when the agent runtime process that wrote it (`CLAUDE_PID`) is gone, so hooks never treat a terminal session as unattended because of an abandoned run. A reader in a linked git worktree (an isolated executor's guard hooks) now reads the run state of the main checkout, so `check auto-mode` reports the orchestrator's run there too.
