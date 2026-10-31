# Accumulated lessons the planner reads

Read by `/gsd:plan-phase` (cross-phase context, 1M model enrichment) beside the three most recent
phases' LEARNINGS.md. Load each file that exists, regardless of recency; skip silently if absent.

- `.planning/LEARNINGS-DIGEST.md` — the accumulated distillation of earlier phases' lessons
  (`/gsd-transition` folds anything durable into it), so lessons older than the recency window
  still reach the plan.
- `<repo-root>/.planning/CROSS-DOMAIN.md` — only when this `.planning/` is nested in a larger
  repository: what sibling projects learned about shared ground (build system, shared libraries,
  tree-wide conventions).
