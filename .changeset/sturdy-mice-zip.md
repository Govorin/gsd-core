---
type: Fixed
pr: 0
---
**`/gsd:autonomous` no longer executes a phase twice, and its auto-mode hold cannot outlive the person at the keyboard** — under autonomous, plan-phase saw the run's hold as an `--auto` chain and launched execute-phase itself before autonomous ran it again. Autonomous now marks its nested discuss/plan/execute calls `--in-autonomous`; only an `--auto`/`--chain` record advances to the next step. A discuss/plan/execute started by hand releases a hold an interrupted autonomous run left, and says so. A hold is not active for a different session, when its timestamp is more than 5 minutes in the future, or through a symlinked `.gsd`. Guard hooks resolve the active workstream pointer the same way the CLI does, and `/gsd:progress --next` no longer routes back to a phase whose UAT session is already complete.
