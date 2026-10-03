---
name: drizzle-orm
description: "Drizzle ORM specialist for schema design, migrations, queries, relations, and database operations. Handles PostgreSQL (with TimescaleDB), MySQL, SQLite with type-safe patterns."
---

# Drizzle ORM Skill

Type-safe ORM patterns for PostgreSQL, MySQL, and SQLite. Use this skill when working with Drizzle schemas, migrations, or database queries.

## Quick Reference

### Critical Rules

| Rule | Description |
|------|-------------|
| **No env vars with drizzle-kit** | Never prefix commands with `POSTGRES_USER=...` |
| **Type inference** | Always export `$inferSelect` and `$inferInsert` types |
| **Relations via `relations()`** | Use Drizzle's relations API, not foreign keys alone |
| **Transactions** | Use `db.transaction()` for multi-step operations |

### Drizzle Kit Commands

```bash
# Generate migrations (NO environment variable prefixes!)
bunx drizzle-kit generate --config=drizzle.config.ts

# Push schema directly
bunx drizzle-kit push --config=drizzle.config.ts

# Apply migrations
bunx drizzle-kit migrate --config=drizzle.config.ts

# Open studio
bunx drizzle-kit studio --config=drizzle.config.ts
```

### Schema Quick Patterns

```typescript
// PostgreSQL
import { pgTable, uuid, varchar, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  isActive: boolean('is_active').default(true),
  metadata: jsonb('metadata').$type<{ prefs: Record<string, unknown> }>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

### Query Operators

```typescript
import { eq, and, or, gt, lt, gte, lte, like, ilike, inArray, isNull, between, sql } from 'drizzle-orm';
```

## Data Files

Read these files for detailed patterns:

- `data/schema-patterns.md` - Schema definitions for PostgreSQL, MySQL, SQLite
- `data/query-patterns.md` - Select, Insert, Update, Delete patterns
- `data/migrations.md` - Drizzle Kit commands and config
- `data/timescaledb.md` - TimescaleDB time-series patterns
- `data/repository-patterns.md` - Repository pattern with Either

## Dialect Differences

| Feature | PostgreSQL | MySQL | SQLite |
|---------|------------|-------|--------|
| Auto ID | `uuid().defaultRandom()` | `serial()` | `integer().primaryKey({ autoIncrement: true })` |
| Boolean | `boolean()` | `boolean()` | `integer({ mode: 'boolean' })` |
| JSON | `jsonb()` / `json()` | `json()` | `text({ mode: 'json' })` |
| Enum | `pgEnum()` | `mysqlEnum()` | `text({ enum: [...] })` |
| Upsert | `onConflictDoUpdate()` | `onDuplicateKeyUpdate()` | `onConflictDoUpdate()` |
