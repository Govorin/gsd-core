---
type: Fixed
pr: 0
---
**Open human UAT is no longer routed past or silently passed** — `/gsd:progress --next` (and `/gsd:next` through it) knew nothing about phases waiting for human verification and moved on to the next phase; it now routes to `/gsd:verify-work <phase>` first, from the new `audit-uat` field `summary.verify_work_phases` (pending UAT rows and `human_needed` reports in the current milestone). `/gsd:next` also offers that verify-work on its complete and idle menus. In `/gsd:autonomous`, "All good — continue" used to write `status: passed` with no UAT record, leaving the phase's UAT file open; it now records the acceptance in the UAT file, closes the session, and flips the report only when `phase uat-passed --uat-only` agrees.
