# Query Patterns

## Select Queries

```typescript
import { eq, and, or, gt, lt, gte, lte, ne, like, ilike, inArray, isNull, between, sql, asc, desc } from 'drizzle-orm';

// Basic select
const allUsers = await db.select().from(users);

// Select with specific columns
const userEmails = await db.select({
  id: users.id,
  email: users.email
}).from(users);

// Where clause with operators
const activeUsers = await db.select().from(users)
  .where(and(
    eq(users.isActive, true),
    gt(users.age, 18),
    like(users.email, '%@gmail.com')
  ));

// Order by and pagination
const paginatedUsers = await db.select().from(users)
  .orderBy(asc(users.createdAt))
  .limit(10)
  .offset(20);

// Joins
const usersWithPosts = await db.select({
  userId: users.id,
  userName: users.name,
  postId: posts.id,
  postTitle: posts.title,
}).from(users)
  .leftJoin(posts, eq(users.id, posts.authorId));

// Relational queries (requires schema passed to drizzle)
const usersWithRelations = await db.query.users.findMany({
  with: {
    posts: {
      with: { comments: true },
      orderBy: (posts, { desc }) => [desc(posts.createdAt)],
      limit: 5,
    },
  },
  where: (users, { eq }) => eq(users.isActive, true),
});
```

## Insert Patterns

```typescript
// Single insert
const newUser = await db.insert(users)
  .values({ name: 'John', email: 'john@example.com' })
  .returning();

// Bulk insert
await db.insert(users).values([
  { name: 'Alice', email: 'alice@example.com' },
  { name: 'Bob', email: 'bob@example.com' },
]);

// Upsert - PostgreSQL
await db.insert(users)
  .values({ id: 1, name: 'John', email: 'john@example.com' })
  .onConflictDoUpdate({
    target: users.email,
    set: { name: 'John Updated' },
  });

// Upsert - ignore conflict
await db.insert(users)
  .values({ email: 'john@example.com', name: 'John' })
  .onConflictDoNothing();
```

## Update Patterns

```typescript
// Basic update
await db.update(users)
  .set({ name: 'New Name' })
  .where(eq(users.id, 1));

// Update with returning
const updated = await db.update(users)
  .set({ isActive: false })
  .where(eq(users.email, 'john@example.com'))
  .returning();

// Increment value
await db.update(posts)
  .set({
    viewCount: sql`${posts.viewCount} + 1`
  })
  .where(eq(posts.id, postId));
```

## Delete Patterns

```typescript
// Basic delete
await db.delete(users).where(eq(users.id, 1));

// Delete with returning
const deleted = await db.delete(users)
  .where(eq(users.email, 'old@example.com'))
  .returning();

// Soft delete (update pattern)
await db.update(users)
  .set({ deletedAt: new Date() })
  .where(eq(users.id, 1));
```

## Transactions

```typescript
// Basic transaction
await db.transaction(async (tx) => {
  const [user] = await tx.insert(users)
    .values({ name: 'John', email: 'john@example.com' })
    .returning();

  await tx.insert(profiles)
    .values({ userId: user.id, bio: 'Hello world' });
});

// Transaction with isolation level (PostgreSQL)
await db.transaction(async (tx) => {
  // ...
}, {
  isolationLevel: 'serializable',
  accessMode: 'read write',
});
```

## Dynamic Query Building

```typescript
import { PgSelect } from 'drizzle-orm/pg-core';

// Reusable pagination helper
function withPagination<T extends PgSelect>(
  qb: T,
  page: number = 1,
  pageSize: number = 10,
) {
  return qb.limit(pageSize).offset((page - 1) * pageSize);
}

// Usage with $dynamic()
const query = db.select().from(users).$dynamic();
const results = await withPagination(query, 2, 20);
```

## Prepared Statements

```typescript
// Prepare a parameterized query
const prepared = db.select()
  .from(users)
  .where(eq(users.id, sql.placeholder('userId')))
  .prepare('get_user_by_id');

// Execute with different params
const user1 = await prepared.execute({ userId: 1 });
const user2 = await prepared.execute({ userId: 2 });
```

## Query Operators Reference

| Operator | SQL | Example |
|----------|-----|---------|
| `eq` | `=` | `eq(users.id, 1)` |
| `ne` | `<>` | `ne(users.status, 'deleted')` |
| `gt` | `>` | `gt(users.age, 18)` |
| `gte` | `>=` | `gte(posts.views, 100)` |
| `lt` | `<` | `lt(users.createdAt, date)` |
| `lte` | `<=` | `lte(orders.total, 1000)` |
| `like` | `LIKE` | `like(users.name, '%john%')` |
| `ilike` | `ILIKE` | `ilike(users.email, '%@GMAIL%')` |
| `inArray` | `IN` | `inArray(users.id, [1, 2, 3])` |
| `isNull` | `IS NULL` | `isNull(users.deletedAt)` |
| `between` | `BETWEEN` | `between(orders.total, 100, 500)` |
| `and` | `AND` | `and(cond1, cond2)` |
| `or` | `OR` | `or(cond1, cond2)` |
