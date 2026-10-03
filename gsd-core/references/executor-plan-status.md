# Executor: plan status lifecycle and STATE.md merge rule

Read by `gsd-executor` on demand — when a status write or a STATE.md update raises a question the
agent's one-line rules do not answer, and always before declaring a plan `blocked`. The agent keeps
the commands; this file keeps the reasons and the full key list.

## The plan's own `status` field: `in_progress` → `done` | `blocked`

The executor is the only writer of its PLAN file's `status` — one writer, no races. Every write is
`gsd_run frontmatter set ... 2>/dev/null || true`: it never blocks, because the flag is a record,
not a lock. `frontmatter set` takes one field per call, and the writer refuses nested object-lists,
so every field stays flat.

### `in_progress` at `record_start_time`

Without it, a plan you begin and never finish is indistinguishable from one never started, so the
next pass re-runs it over its own uncommitted work.

`status_at` records WHEN the status was written. Nothing reads it yet; writing it now spares a later
migration across every plan on disk.

### `done` after SUMMARY.md

`record_start_time` set the flag; before this write existed nothing removed it, so the flag outlived
the work — measured: 5 plans still "running" with a SUMMARY each, 5 phases later. Two readers act on
it, and the prohibition guard goes inert when several plans claim to run at once, so finished plans
disarmed it permanently.

**`status: done` is NOT the completion signal — never teach anything to read it as one.** Completion
comes from the PRESENCE of the SUMMARY file and nothing else; the `done` write only disarms the
in-progress flag. A reader that derives completion from `status` gives the two signals the ability
to disagree, after which neither can be trusted. Pinned by
`tests/plan-status-readers-regression.test.cjs`.

### `blocked` when you genuinely cannot proceed

An abandoned plan sits at `in_progress` forever, reads to every later pass as "still running", and
invites a re-run on top of your uncommitted work. So a plan you cannot finish is DECLARED, beside the
`state.add-blocker` call:

```bash
gsd_run frontmatter set "${PLAN_FILE}" --field status --value blocked 2>/dev/null || true
gsd_run frontmatter set "${PLAN_FILE}" --field blocked_reason --value "<one line, what is missing>" 2>/dev/null || true
gsd_run frontmatter set "${PLAN_FILE}" --field status_at --value "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" 2>/dev/null || true
```

`blocked_reason` is REQUIRED and must be non-empty — `blocked` without one fails validation, and an
unexplained blockage counts as a stranded plan and buys you nothing. Keep it under 2048 characters:
an oversized reason FAILS rather than truncating. Name what is missing (absent credential, unbuilt
dependency, a decision only a human can make), not what you tried.

## STATE.md: merge, never overwrite

Every STATE.md write is a *field-level merge*. The `gsd-tools query state.*` handlers take a lock,
re-read the file, change only the fields the flags name, and preserve every other key. That is the
contract; do not work around it.

- **Never** `Write` a whole STATE.md, and never `Edit` it into a shape you reconstructed from memory.
  You have not read the keys another writer added since your context was built, so a whole-file
  write silently drops them. The measured failure mode is exactly this: an update that reconstructs
  the document loses the keys it did not know about.
- **Never** re-emit a field you were not asked to change. Omitting a flag preserves that field;
  passing it with a stale value overwrites it.
- These keys must survive every update, whether or not you touched them: `gsd_state_version`,
  `milestone`, `milestone_name`, `current_phase`, `current_phase_name`, `current_plan`, `status`,
  `last_updated`, `last_activity`, `last_activity_desc`, `stopped_at`, `paused_at`, `progress` (with
  `total_phases`, `completed_phases`, `total_plans`, `completed_plans`, `percent`) — plus any key you
  do not recognise. An unrecognised key belongs to a writer you cannot see; carry it forward
  untouched.
- If no handler fits what you need to record, add a blocker (`state.add-blocker`) and say so. Do
  **not** hand-edit STATE.md to route around a missing verb.
