---
type: Fixed
pr: 0
---
**`gsd-roadmapper` can revise its roadmap in place** — Step 9 told the agent to update ROADMAP.md and REQUIREMENTS.md in place with Edit, but its `tools:` had no Edit, so every revision call was refused and fell back to a whole-file Write that the write guard blocks on a shrink. The agent now carries Edit, like the other section-writer agents.
