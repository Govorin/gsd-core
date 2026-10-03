# RxMonads Operators (@common/rxmonads)

> **Ниша, а не канон.** RxJS-обвязка над Either применима там, где у вас **уже есть поток** —
> подписка, сокет, интервал. Обычный сервис пишется на `async/await` + `EitherAsync`, и RxJS
> в нём не нужен. Берись за `eitherify()`/`chainAsync()`, только когда работаешь с
> `Observable`-based source (a websocket stream, an existing RxJS pipeline) — don't introduce RxJS to a
> new async/await service just to use these operators. For new code, default to `EitherAsync` chains
> (see `data/either-patterns.md` → "EitherAsync — Lazy Async Either").

## Available Operators

| Operator | Purpose | When to Use |
|----------|---------|-------------|
| `eitherify()` | Catch errors → Either | Wrap any Promise/Observable |
| `mapRight(fn)` | Transform success | Pure transformations |
| `mapLeft(fn)` | Transform error | Enrich error context |
| `chain(fn)` | Sync flatMap | Validation, sync transforms |
| `chainAsync(fn)` | Async flatMap | DB calls, API calls |
| `tapRight(fn)` | Side effect on success | Logging, notifications |
| `tapLeft(fn)` | Side effect on error | Error logging |
| `fold(left, right)` | Extract value | Final result handling |
| `retryEither(n, ms)` | Retry on Left | Flaky operations |

## Standard Repository Pattern

```typescript
create(data: EntityInsert): Promise<Either<HttpError, Entity>> {
  return firstValueFrom(
    from([checkEntityInsert(data)]).pipe(
      chainAsync((validEntity) =>
        from(this.db.insert(schema).values(validEntity).returning()).pipe(
          eitherify(),
          mapLeft((error) => new InternalServerError(
            'Failed to create entity',
            { operation: 'insert', table: 'entities', data },
            error
          )),
        ),
      ),
      chain(([result]) => EntityMapper.toDomain(result)),
    ),
  );
}
```

## NEVER Use catchError with Either

```typescript
// FORBIDDEN - conflicts with Either
return observable$.pipe(
  map(data => right(data)),
  catchError(error => of(left(error)))  // NEVER!
);

// CORRECT - use eitherify()
return from(asyncOperation()).pipe(
  eitherify(),
  mapLeft(error => new InternalServerError(error.message))
);
```

## When RxJS is NOT Needed

For simple flows, use pure Either chains:

```typescript
// Simple async/await with Either
async function process(payload: SomeDto): Promise<Either<HttpError, Result>> {
  const validResult = await validateSomething(payload);
  if (validResult.isLeft()) {
    return left(validResult.value);
  }
  return processSomething(validResult.value);
}

// Chained Either
const result = await (await catRepo.findOne({ id: catId, userId }))
  .chain(cat => cat ? right(cat) : left(new NotFoundError('Cat not found')))
  .asyncChain(() => alertsRepo.findByCatId(catId, options));
```
