---
type: Added
pr: 0
---
**`/gsd-autonomous` warns when a write guard is set to `ask`** — at startup it prints one line per `workflow.prohibition_guard` / `workflow.test_tamper_guard` set to `ask`, with the `config-set … deny` that keeps an unattended run from waiting on an approval.
