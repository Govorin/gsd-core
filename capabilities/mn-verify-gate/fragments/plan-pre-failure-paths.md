<failure_paths_contract>
**Write the pre-mortem down, where a check can read it** (`workflow.failure_paths`, mn-verify-gate).

When you assume a plan has failed and name why, record each failure a command could observe as a `<failure_path>` in a `<failure_paths>` block after `<threat_model>`: an `<invariant>` (what must stay true) and a `<check>` — the same `<automated>` + `<fails_when>` pair a `<verify>` uses — that fails when the invariant breaks.

**Required** when the plan's `files_modified` names a migration (`.sql` under `drizzle/` or `migration(s)/`) or its `user_setup` is non-empty. Any other plan only when it has a failure a reviewer would ask about (a sent message, a deploy, a data rewrite); otherwise omit the block. Shape, placement and the verdict: read `~/.claude/gsd-core/references/failure-paths.md`.

**Before you return,** run `gsd_run check mn-failure-paths "${PHASE}" --raw` from the project root and fix each `blocker` in `findings`. Never invent a check to clear one: a failure no command can observe stays without a `<check>`, and you name it in your return message.
</failure_paths_contract>
