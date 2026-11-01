---
type: Added
pr: 0
---
complete-milestone now blocks the close while code the milestone changed was never window-reviewed or a window review of it holds an open Critical finding (code-review gate `check milestone-review` at `milestone:pre`, `code_review.milestone_gate`, default on). The owner's way past is a recorded, self-invalidating acceptance: `gsd_run review milestone-accept --milestone vX.Y --reason ...`. The milestone stage now starts a first milestone's window where planning began.
