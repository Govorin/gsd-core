# Failure Paths — the Pre-Mortem as an Artifact

> Reference file for gsd-planner, loaded on demand when the mn-verify-gate `plan:pre` fragment
> (`workflow.failure_paths`) asks for the block. Judged by `gsd_run check mn-failure-paths`.

**Question:** For each way this plan can fail that the plan itself names, is there a check that
fails when it happens?

The Pre-Mortem in `thinking-models-planning.md` asks the planner to assume the plan failed and
name why. Left in the planner's head, the answer protects nothing: an executor never sees it, and
nothing can tell a named failure that some command would catch from one that nobody would notice.
`<failure_paths>` writes the answer into PLAN.md, where a deterministic check reads it.

## The contract

```xml
<failure_paths>
<failure_path>
  <name>Backfill leaves NULL in rows that predate the column</name>
  <invariant>every user_word_knowledge row has a non-null ignored_at after migrate</invariant>
  <check>
    <automated>psql "$DATABASE_URL" -tAc "select count(*) from user_word_knowledge where ignored_at is null"</automated>
    <fails_when>the printed count is not 0</fails_when>
  </check>
</failure_path>
</failure_paths>
```

- `<invariant>` — what must stay true; the failure is its violation. Not a restatement of a task.
- `<check>` — the `<automated>` / `<fails_when>` pair of `failing-direction.md`, same grammar and
  binding rule (each `<fails_when>` binds to the nearest preceding `<automated>`), judged by the
  same recognizer. A command with no stated failure signal is not a check. A Wave-0
  `MISSING — …` command is accepted: the plan-checker's 8a/8d own it.
- `<name>` — optional, one line; findings quote it.

Place the block after `<threat_model>`. One `<failure_path>` per failure, not per task.

## When the block is required

Decided from the plan's own frontmatter, so a small plan pays nothing:

| The plan… | Why it must declare failure paths |
|---|---|
| lists a migration in `files_modified` (`.sql` under `drizzle/` or `migration(s)/`, not `meta/`) | a follow-up commit cannot restore lost rows |
| has a non-empty `user_setup` | it depends on a service the executor does not control |

Any other plan **may** declare the block when it has a failure a reviewer would ask about — an
external side effect (a sent message, a published package, a deploy), a data rewrite, a cache or
queue another system reads. Never add it out of obligation: a block of vacuous paths teaches every
reader to skim the ones that matter.

## The verdict

`gsd_run check mn-failure-paths <phase> --raw` → `findings[]` rows carry `plan`, `path`, `kind`,
`severity` and `detail`; `metrics.paths_without_check` / `metrics.paths` is the share of named
failures nothing would notice (`paths_without_check_ratio`, `null` when no path is declared).

| `kind` | `severity` | Meaning |
|---|---|---|
| `required-absent` | blocker | a required plan declares no `<failure_path>` |
| `no-check` | blocker | a path with no `<check>` command |
| `check-unstated` | blocker | a check command whose `<fails_when>` is missing, empty or a placeholder |
| `invariant-unstated` | blocker | `<invariant>` missing, empty or a placeholder (`TBD`, `n/a`, …) |
| `empty-block` | warning | `<failure_paths>` with no path on a plan nothing requires it of |
| `orphan-statement` | warning | a `<fails_when>` before every command of its `<check>` |

Any blocker → `block: true`. `status: unresolvable` (a plan could not be listed or read) also
blocks — "could not look" never reads as clean.

## Where it runs

| Point | Key (default) | Effect |
|---|---|---|
| planner, after writing plans | `workflow.failure_paths` (on) | self-check: fix every blocker before returning |
| `plan:post` gate | `workflow.failure_paths_enforce` (off) | halts planning on any blocker; the payload carries the metric |

**Never write a check just to satisfy the gate.** When a named failure has no signal any command
could observe, leave its `<check>` out and name the remaining blocker in your return message: a
fabricated check hides exactly what the block exists to show.
