---
type: Added
pr: 0
---
complete-milestone now blocks the close while code the milestone changed was never window-reviewed or a window review of it holds an open Critical finding (code-review gate `check milestone-review` at `milestone:pre`, `code_review.milestone_gate`, default on). The owner's way past is a recorded, self-invalidating acceptance: `gsd_run review milestone-accept --milestone vX.Y --reason ...`. The milestone starts at the previous milestone's archive commit or tag (any prefix scheme, whichever is nearer to HEAD; with `git.create_tag: false` the archive commit), else where this project's `.planning/` began; a shallow clone cannot be checked. The window review stage takes its `--since` from the same base. Code-review scopes now exclude a nested `.planning/` (monorepo projects) as well as the root one.
