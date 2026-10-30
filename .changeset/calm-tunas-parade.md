---
type: Fixed
pr: 0
---
**A closed milestone reads as closed** — closing a milestone writes `<version> milestone complete` and then resets `## Current Position` to `Status: Awaiting next milestone`; in the shipped STATE.md template that second value is the one the frontmatter keeps. `/gsd-progress`'s smart entry did not know it and answered "Unsure of state — showing progress"; it now classifies the milestone as complete and recommends `/gsd-new-milestone`, also when archiving left no phase counts. Workstream inventory no longer lists such a workstream as active, and health W026 checks it too. One predicate, `isMilestoneClosedStatus` (`src/state-md-schema.cts`), recognizes both closing values.
