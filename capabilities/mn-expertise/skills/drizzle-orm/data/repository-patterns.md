# Repository Pattern with Either

## RxJS + Either Pattern

```typescript
import { inject, Scopes } from 'dioma';
import { from, firstValueFrom } from 'rxjs';
import { eitherify, mapLeft, chain, chainAsync, right, left } from '@workspace/shared/common/rxmonads';
import { eq, and } from 'drizzle-orm';
import { InternalServerError, NotFoundError } from '@workspace/shared/errors';

export class UserRepository {
  static scope = Scopes.Singleton();
  private db = inject(DatabaseToken);

  // Create with validation chain
  async create(data: NewUser): Promise<Either<Error, User>> {
    return firstValueFrom(
      from([validateUserInsert(data)]).pipe(
        chainAsync((validData) =>
          from(this.db.insert(users).values(validData).returning()).pipe(
            eitherify(),
            mapLeft((error) => new InternalServerError('Insert failed', { data }, error))
          )
        ),
        chain(([result]) => UserMapper.toDomain(result))
      )
    );
  }

  // Find by ID with null handling
  async findById(id: string): Promise<Either<Error, User | null>> {
    return firstValueFrom(
      from(this.db.select().from(users).where(eq(users.id, id))).pipe(
        eitherify(),
        mapLeft((error) => new InternalServerError('Query failed', { id }, error)),
        chain(([result]) => result ? UserMapper.toDomain(result) : right(null))
      )
    );
  }

  // Update with conditional logic
  async update(id: string, data: Partial<NewUser>): Promise<Either<Error, User>> {
    return firstValueFrom(
      from(this.db.update(users)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning()
      ).pipe(
        eitherify(),
        mapLeft((error) => new InternalServerError('Update failed', { id, data }, error)),
        chain(([result]) => {
          if (!result) {
            return left(new NotFoundError('User not found', { id }));
          }
          return UserMapper.toDomain(result);
        })
      )
    );
  }
}
```

## Simple Either Pattern (without RxJS)

```typescript
import { Either, left, right } from '@workspace/shared/common/rxmonads';

export class SimpleUserRepository {
  constructor(private db: Database) {}

  async findById(id: string): Promise<Either<Error, User | null>> {
    try {
      const [user] = await this.db.select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      return right(user ?? null);
    } catch (error) {
      return left(new Error('Failed to fetch user', { cause: error }));
    }
  }

  async create(data: NewUser): Promise<Either<Error, User>> {
    try {
      const [user] = await this.db.insert(users)
        .values(data)
        .returning();
      return right(user);
    } catch (error) {
      return left(new Error('Failed to create user', { cause: error }));
    }
  }
}
```

## Pagination Helper

```typescript
export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function paginate<T>(
  query: PgSelect,
  countQuery: Promise<{ count: number }[]>,
  params: PaginationParams
): Promise<PaginatedResult<T>> {
  const [items, [{ count: total }]] = await Promise.all([
    query
      .limit(params.pageSize)
      .offset((params.page - 1) * params.pageSize),
    countQuery,
  ]);

  return {
    items: items as T[],
    total,
    page: params.page,
    pageSize: params.pageSize,
    totalPages: Math.ceil(total / params.pageSize),
  };
}
```

## Repository with Pagination

```typescript
export class WeightRepository {
  static scope = Scopes.Singleton();
  private db = inject(DatabaseToken);

  async findByCatId(
    catId: string,
    options: PaginationOptions
  ): Promise<Either<Error, PaginatedResponse<WeightMeasurement>>> {
    const offset = (options.page - 1) * options.limit;

    return firstValueFrom(
      from([
        this.db.select().from(weightMeasurements)
          .where(eq(weightMeasurements.catId, catId))
          .limit(options.limit)
          .offset(offset),
        this.db.select({ count: count() }).from(weightMeasurements)
          .where(eq(weightMeasurements.catId, catId))
      ]).pipe(
        chain(([items, [{ count: total }]]) =>
          merge(items.map(WeightMapper.toDomain)).mapRight((mappedItems) => ({
            items: mappedItems,
            total,
            page: options.page,
            limit: options.limit
          }))
        ),
        mapLeft((error) => new InternalServerError('Query failed', { catId }, error))
      )
    );
  }
}
```

## Validation Helper

```typescript
import { createInsertSchema } from 'drizzle-zod';
import { z } from 'zod';

function validateUserInsert(data: unknown): Either<Error, NewUser> {
  const schema = createInsertSchema(users, {
    email: z.string().email(),
    name: z.string().min(2).max(100),
  });

  try {
    const validated = schema.parse(data);
    return right(validated);
  } catch (error) {
    return left(new ValidationError('Invalid user data', { data }, error));
  }
}
```
