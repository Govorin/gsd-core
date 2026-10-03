# TimescaleDB Time-Series Patterns

TimescaleDB extends PostgreSQL with specialized time-series capabilities. Use it for high-volume temporal data like logs, metrics, events, sensor readings, and activity tracking.

## Schema Design

```typescript
import { pgTable, uuid, timestamp, integer, decimal, varchar } from 'drizzle-orm/pg-core';

// Weight measurements over time
export const weightMeasurements = pgTable('weight_measurements', {
  id: uuid('id').primaryKey().defaultRandom(),
  catId: uuid('cat_id').references(() => cats.id).notNull(),
  weight: decimal('weight', { precision: 5, scale: 2 }).notNull(),
  unit: varchar('unit', { length: 10 }).notNull(),
  // Time column - MUST be timestamp for hypertable
  measuredAt: timestamp('measured_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull()
});

// Presence events
export const catPresences = pgTable('cat_presences', {
  id: uuid('id').primaryKey().defaultRandom(),
  catId: uuid('cat_id').references(() => cats.id).notNull(),
  podId: uuid('pod_id').references(() => pods.id).notNull(),
  enteredAt: timestamp('entered_at').notNull(),
  exitedAt: timestamp('exited_at'),
  duration: integer('duration'), // in seconds
  createdAt: timestamp('created_at').defaultNow().notNull()
});
```

## Migration Setup

```sql
-- Convert regular table to hypertable (run AFTER Drizzle generates tables)
SELECT create_hypertable('cat_presences', 'entered_at', chunk_time_interval => INTERVAL '7 days');
SELECT create_hypertable('weight_measurements', 'measured_at', chunk_time_interval => INTERVAL '1 month');

-- Composite indexes: (entity_id, time DESC) for efficient lookups
CREATE INDEX idx_cat_presences_cat_time ON cat_presences (cat_id, entered_at DESC);
CREATE INDEX idx_weight_measurements_cat_time ON weight_measurements (cat_id, measured_at DESC);

-- Retention policy: automatically drop data older than 2 years
SELECT add_retention_policy('cat_presences', INTERVAL '2 years');

-- Compression policy: compress chunks older than 30 days
ALTER TABLE cat_presences SET (timescaledb.compress, timescaledb.compress_segmentby = 'cat_id');
SELECT add_compression_policy('cat_presences', INTERVAL '30 days');
```

## Time-Series Queries

```typescript
import { sql } from 'drizzle-orm';
import { gte, lte, and, eq, desc } from 'drizzle-orm';

// Get records in time range
const presences = await db.select()
  .from(catPresences)
  .where(and(
    eq(catPresences.catId, catId),
    gte(catPresences.enteredAt, startTime),
    lte(catPresences.enteredAt, endTime)
  ))
  .orderBy(desc(catPresences.enteredAt));

// TimescaleDB time_bucket aggregation
const hourlyStats = await db.execute(sql`
  SELECT
    time_bucket('1 hour', entered_at) AS bucket,
    COUNT(*) as count
  FROM cat_presences
  WHERE pod_id = ${podId}
    AND entered_at >= ${date}::date
    AND entered_at < ${date}::date + INTERVAL '1 day'
  GROUP BY bucket
  ORDER BY bucket DESC
`);

// Average by day
const dailyAvg = await db.execute(sql`
  SELECT
    time_bucket('1 day', entered_at) AS day,
    AVG(duration) as avg_duration
  FROM cat_presences
  WHERE cat_id = ${catId}
    AND entered_at >= NOW() - INTERVAL '30 days'
  GROUP BY day
  ORDER BY day DESC
`);
```

## TimescaleDB Functions Reference

| Function | Purpose | Example |
|----------|---------|---------|
| `create_hypertable()` | Convert table to hypertable | `SELECT create_hypertable('metrics', 'time')` |
| `time_bucket()` | Aggregate by time intervals | `time_bucket('1 hour', timestamp_col)` |
| `first()` | Get first value in bucket | `first(value, time)` |
| `last()` | Get last value in bucket | `last(value, time)` |
| `add_retention_policy()` | Auto-delete old data | `add_retention_policy('metrics', INTERVAL '1 year')` |
| `add_compression_policy()` | Auto-compress old chunks | `add_compression_policy('metrics', INTERVAL '7 days')` |

## Best Practices

1. **Time Column**: Always use `timestamp` (not `integer` unix timestamps) for hypertable time column
2. **Chunk Interval**: Choose based on query patterns and data volume
   - High volume: 1 day to 7 days
   - Medium volume: 7 days to 1 month
   - Low volume: 1 month to 3 months
3. **Indexes**: Create composite indexes with `(entity_id, time DESC)` for optimal performance
4. **Compression**: Enable for data older than your active query window
5. **Retention**: Set policies to automatically drop old data
6. **time_bucket()**: Use for all time-based aggregations instead of date_trunc()
