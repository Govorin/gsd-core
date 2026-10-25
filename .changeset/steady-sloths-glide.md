---
type: Added
pr: 0
---
**Retro on a schedule, not only on friction** — the retro capability now makes a retro due once a milestone is planned and before its first phase runs (`retro.at_milestone_start`, default `true`), and every `retro.cadence_phases` executed phases since the last retro (default `3`, `0` off), whatever the session's friction score. `retro stage` names the trigger that fired (`signals`, `milestone-start`, `cadence`); `retro.auto` still decides between suggest, auto and off, and nothing is applied. Held retros are journaled in `.planning/retro/RUNS.json` by `retro prepare`; the new read-only `gsd-tools retro due` reports the schedule as JSON. A new loop point, `roadmap:post`, hosted by `/gsd-new-milestone` and `/gsd-new-project`, runs the stage once the roadmap is committed (ADR-5209 §9, ADR-857 amendment 2026-10-25).
