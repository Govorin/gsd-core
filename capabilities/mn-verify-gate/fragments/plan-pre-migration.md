<migration_safety>
**If this phase changes the database schema, decide what happens to the rows that already exist — before the migration is written.**

A migration is the one artifact in a phase that cannot be fixed by a follow-up commit. Code that ships wrong is reverted; a column that ships dropped is gone, and the revert brings back the file, not the data. The existing gates do not cover this: `schema-gate` checks that the schema was pushed, `drift` checks that schema and tree agree — and a migration that drops a column passes both, because schema and code are consistent precisely *because* the column is gone everywhere. Data loss is not a schema discrepancy. It is a consequence of a consistent schema.

State four things in the plan. Not as prose — as answers, so the executor can act on them and the reviewer can check them.

**1. What existing rows contain.** Not "the table is probably empty" — say how you know. The answer differs per environment, and the one that matters is production.

| Table | Rows in prod | Rows in dev | How verified |
|-------|--------------|-------------|--------------|
| `user_word_knowledge` | ~40k | ~200 | `select count(*)` on 2026-08-07 |

An empty table makes half of this section trivial and that is a fine outcome — but write down that it is empty, because "assumed empty" is how `ADD COLUMN … NOT NULL` reaches a populated table and aborts the deploy.

**2. The order of operations for any new NOT NULL column.** A single statement adding `NOT NULL` without `DEFAULT` fails on a non-empty table — Postgres has no value to put in the existing rows. The three-step form is not ceremony, it is the only form that works:

```sql
-- 1. nullable first — always succeeds, no table rewrite
ALTER TABLE "user_word_knowledge" ADD COLUMN "ignored_at" timestamptz;
-- 2. backfill — decide the value for rows that predate the column
UPDATE "user_word_knowledge" SET "ignored_at" = "created_at" WHERE "ignored_at" IS NULL;
-- 3. only now constrain
ALTER TABLE "user_word_knowledge" ALTER COLUMN "ignored_at" SET NOT NULL;
```

The interesting step is 2, and it is the one no artifact currently asks about: **what is the right value for a row that existed before the concept did?** `created_at` says "it was always so", `now()` says "it starts today", a sentinel says "unknown". These are three different product decisions and the schema cannot express which one you meant. A `DEFAULT` shortcut is legitimate when a single constant is genuinely correct — say that it is, rather than reaching for it to avoid the question.

**3. The reverse path — and be honest when there isn't one.** For each destructive statement, write the SQL that undoes it, or state that nothing does:

| Statement | Reverse | Data recoverable? |
|-----------|---------|-------------------|
| `ADD COLUMN ignored_at` | `DROP COLUMN ignored_at` | yes — nothing existed before |
| `DROP COLUMN s3_text_key` | `ADD COLUMN s3_text_key text` | **no — values are gone** |
| `ALTER COLUMN status TYPE status_enum USING …` | cast back to text | partially — rows failing the cast are lost |

"No reverse exists" is an acceptable answer and often the correct one. What is not acceptable is not knowing. Record the decision in the `.sql` itself so the gate and the next reader see the same thing:

```sql
-- gsd:irreversible  s3_text_key superseded by object-store keys; values not needed
-- gsd:backfill      existing rows take created_at
-- gsd:reverse: ALTER TABLE book_analysis ADD COLUMN s3_text_key text
-- gsd:manual        written by hand; registered in _journal.json deliberately
```

**4. What happens if this phase is undone.** `gsd-undo` reverts commits, and a migration does not live only in a commit — it has already run against the database. The revert removes the `.sql` file while the table it created stays, and `__drizzle_migrations` keeps the hash of a file that no longer exists. The next `drizzle-kit generate` then diffs a schema-without-the-table against a database-with-the-table and emits `DROP TABLE`. Nothing fails at revert time; the loss arrives on the next unrelated migration. So state plainly: **is this phase revertible by `gsd-undo` alone, or does undoing it also require a manual database step?** If it requires one, write that step here — this is the only place it will be recorded.

Two more rules worth the line they cost:

- **Never write migration `.sql` by hand without registering it in `meta/_journal.json`.** A file outside the journal is invisible to `drizzle-kit`: it will not be applied by `migrate`, will not be counted in the hash chain, and will not be represented in the next generated snapshot. This is not hypothetical in this repo — `apps/savor/api` has 15 migrations on disk and 7 in its journal, and `trade-mind`'s archive has 40 against 27, with eight duplicated index prefixes whose apply order is undefined. Both drifted exactly this way. If a hand-written file is genuinely necessary, mark it `-- gsd:manual` and say in the plan why `drizzle-kit generate` could not produce it.
- **Separate the destructive migration from the code that stops using the column.** Ship the readers first, drop the column in a later phase. A single phase that does both cannot be rolled back at all — reverting the code restores readers for a column that no longer exists.

If the phase touches no schema files, say so in one line and skip this section. A table filled in out of obligation teaches everyone to skim the ones that matter.
</migration_safety>
