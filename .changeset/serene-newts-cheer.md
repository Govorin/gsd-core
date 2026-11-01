---
type: Added
pr: 0
---
**`gsd-tools config-advise [--json]` recommends existing knobs your project's artifacts ask for** — a phase with 6+ plans → `workflow.plan_chunked` + `planning.chunked_parallel`; a phase-end review with 5+ critical/warning findings → `workflow.code_review_point: execute:wave:post`; 2+ phases waiting on human verification → `/gsd-verify-work` and `/gsd-audit-uat`; 2+ VERIFICATION reports citing hand-run checks → `workflow.verify_gates` (with the cited commands) + `verify_gates_record`; plans naming tools the executor lacks → `agent_tools` + reinstall. Each comes with a one-line reason and the exact command; knobs already on are not recommended and nothing is written. `/gsd-progress` shows the summary under Config Advice and `/gsd-health` reports it as info I011.
