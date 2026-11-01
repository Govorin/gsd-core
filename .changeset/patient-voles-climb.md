---
type: Fixed
pr: 0
---
**`/gsd:autonomous` stays in auto mode for its whole run** — it runs plan-phase and execute-phase without `--auto`, and their "manual invocation clears the chain" guard switched auto mode off mid-run, so `check auto-mode` read inactive during autonomous runs. Autonomous now holds an `autonomous`-owned auto-chain record from start to every exit (`gsd-tools auto-chain set|clear --owner autonomous`); a plain `auto-chain clear` leaves it in place. The hold is refreshed at each phase and lapses 24 hours after the last refresh, so a run that died does not leave later sessions in auto mode.
