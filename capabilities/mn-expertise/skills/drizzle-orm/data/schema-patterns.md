# Schema Definition Patterns

## PostgreSQL Schema

```typescript
import { pgTable, serial, text, integer, timestamp, uuid, varchar, boolean, jsonb, pgEnum, index, uniqueIndex } from 'drizzle-orm/pg-core';

// Define enums
export const statusEnum = pgEnum('status', ['pending', 'active', 'archived']);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name').notNull(),
  status: statusEnum('status').default('pending'),
  metadata: jsonb('metadata').$type<{ preferences: Record<string, unknown> }>(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull()
});

// Type inference helpers - ALWAYS EXPORT
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

## MySQL Schema

```typescript
import { mysqlTable, serial, varchar, text, int, timestamp, boolean, json, mysqlEnum } from 'drizzle-orm/mysql-core';

export const users = mysqlTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  name: text('name').notNull(),
  age: int('age'),
  role: mysqlEnum('role', ['user', 'admin', 'moderator']).default('user'),
  settings: json('settings').$type<{ theme: string }>(),
  isVerified: boolean('is_verified').default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

## SQLite Schema

```typescript
import { sqliteTable, integer, text, blob } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  age: integer('age'),
  // SQLite doesn't have boolean, use integer mode
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  // SQLite doesn't have timestamp, use integer for unix timestamp
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  // JSON stored as text
  metadata: text('metadata', { mode: 'json' }).$type<{ foo: string }>(),
});
```

## Relations Definition

```typescript
import { relations } from 'drizzle-orm';

// One-to-Many: User has many posts
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
  comments: many(comments),
}));

// Many-to-One: Post belongs to User
export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, {
    fields: [posts.authorId],
    references: [users.id],
  }),
  comments: many(comments),
}));

// One-to-One: User has one profile
export const profileRelations = relations(profiles, ({ one }) => ({
  user: one(users, {
    fields: [profiles.userId],
    references: [users.id],
  }),
}));

// Many-to-Many with junction table
export const usersToGroups = pgTable('users_to_groups', {
  userId: integer('user_id').notNull().references(() => users.id),
  groupId: integer('group_id').notNull().references(() => groups.id),
}, (t) => [
  primaryKey({ columns: [t.userId, t.groupId] }),
  index('users_to_groups_user_id_idx').on(t.userId),
]);
```

## Indexes and Constraints

```typescript
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull(),
  slug: varchar('slug', { length: 255 }).notNull(),
  publishedAt: timestamp('published_at'),
}, (table) => [
  // Single column index
  index('posts_author_id_idx').on(table.authorId),
  // Unique index
  uniqueIndex('posts_slug_unique_idx').on(table.slug),
  // Composite index
  index('posts_author_published_idx').on(table.authorId, table.publishedAt),
  // Partial index (PostgreSQL)
  index('posts_published_idx')
    .on(table.publishedAt)
    .where(sql`${table.publishedAt} IS NOT NULL`),
  // Foreign key with explicit actions
  foreignKey({
    columns: [table.authorId],
    foreignColumns: [users.id],
  }).onDelete('cascade').onUpdate('cascade'),
]);
```
