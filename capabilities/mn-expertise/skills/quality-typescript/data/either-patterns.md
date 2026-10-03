# Either Error Handling Patterns

## Philosophy: Rust/Gleam-like Error Handling

Either в TypeScript — это аналог `Result<T, E>` из Rust и Gleam. Ключевая идея:

**Ошибки — это значения, а не исключения.**

| Язык | Тип | Success | Failure |
|------|-----|---------|---------|
| Rust | `Result<T, E>` | `Ok(value)` | `Err(error)` |
| Gleam | `Result(value, error)` | `Ok(value)` | `Error(error)` |
| TypeScript | `Either<L, R>` | `right(value)` | `left(error)` |

**Почему это лучше exceptions:**
- **Явность**: Сигнатура функции показывает что может пойти не так
- **Exhaustiveness**: Компилятор заставляет обработать оба случая
- **Композиция**: Цепочка операций без try/catch блоков
- **Type safety**: Ошибки типизированы, не `unknown`

```typescript
// Rust
fn get_user(id: &str) -> Result<User, UserError> { ... }
let user = get_user(id)?;  // ? propagates error

// TypeScript Either — тот же паттерн
function getUser(id: string): Either<UserError, User> { ... }
return getUser(id)
  .chain(user => validatePermissions(user))  // auto-propagates Left
  .mapRight(user => user.profile);
```

**Правило**: Думай о `chain`/`asyncChain` как о `?` операторе в Rust — ошибка автоматически всплывает наверх.

### Mapping как в Rust/Gleam

**НИКОГДА не разворачиваем Either для работы со значением** — используем map/chain:

```rust
// Rust — работаем через map, не через unwrap
let name = get_user(id)
    .map(|user| user.name)
    .map(|name| name.to_uppercase());
```

```typescript
// TypeScript Either — ТОЧНО ТАК ЖЕ
const name = getUser(id)
  .mapRight(user => user.name)
  .mapRight(name => name.toUpperCase());

// ❌ НИКОГДА так:
const result = getUser(id);
if (result.isRight()) {
  const user = result.value;  // unwrap — ПЛОХО!
  return user.name;
}
```

**Ключевой принцип**: Either остаётся "запечатанным" на всём пути. Разворачиваем только на границе системы (HTTP response) — и делаем это через `unwrapOrElse(error => { throw mapper(error); })`, НЕ через `fold`. См. "Pattern 3" ниже. Замечание про распространённость: `fold()` в контроллерах встречается — это легаси, а не образец; новый код пишется через `unwrapOrElse`.

## Standard Return Types

Methods MUST return one of:
- `Either<Error, Value>`
- `Promise<Either<Error, Value>>`
- `Observable<Either<Error, Value>>`

## Service Error Types Convention

Each service defines its **own** discriminated union error type. No shared intermediary types.

### File Structure

```
libs/<domain>/services/src/lib/<feature>/
├── trade.service.ts
├── trade-service.error-code.ts    # Const object with PascalCase keys
└── trade-service.errors.ts        # Union type + plain factory functions
```

Имя файла несёт точку перед `error-code`/`errors`: `{service}-service.error-code.ts` и
`{service}-service.errors.ts`. Два файла, а не один, потому что коды — это перечень, который
читают и на границе транспорта при маппинге в HTTP, а тип с фабриками нужен только владельцу.

### Error Code Definition

```typescript
// trade-service-error-code.ts
export const TradeServiceErrorCode = {
  TradeNotFound: 'TRADE_NOT_FOUND',
  TradeLookupFailed: 'TRADE_LOOKUP_FAILED',
  AccountUnauthorized: 'ACCOUNT_UNAUTHORIZED',
} as const;
```

### Error Type + Factory Functions

```typescript
// trade-service.errors.ts
export type TradeServiceError =
  | { code: typeof TradeServiceErrorCode.TradeNotFound; message: string; payload: { tradeId: TradeId } }
  | { code: typeof TradeServiceErrorCode.TradeLookupFailed; message: string; payload: { tradeId: TradeId }; cause: unknown }
  | { code: typeof TradeServiceErrorCode.AccountUnauthorized; message: string; payload: { accountId: string; userId: UserId } };

// Plain factory functions — NOT namespace pattern
export const tradeNotFound = (tradeId: TradeId): TradeServiceError => ({
  code: TradeServiceErrorCode.TradeNotFound,
  message: `Trade ${tradeId} not found`,
  payload: { tradeId },
});

export const tradeLookupFailed = (tradeId: TradeId, cause: unknown): TradeServiceError => ({
  code: TradeServiceErrorCode.TradeLookupFailed,
  message: `Failed to look up trade ${tradeId}`,
  payload: { tradeId },
  cause,
});
```

### Two Error Categories

- **Business errors** (TradeNotFound, AccountUnauthorized) — no `cause`, payload has relevant IDs
- **Infrastructure errors** (TradeLookupFailed) — `cause: unknown` preserving original error

### Service Usage — mapLeft for Semantic Context

```typescript
async getById(userId: UserId, id: TradeId): Promise<Either<TradeServiceError, Trade>> {
  return (await this.tradeRepository.findOne({ userId, id }))
    .mapLeft(cause => tradeLookupFailed(id, cause))       // WHAT failed + WHY
    .chain(trade => trade ? right(trade) : left(tradeNotFound(id)));
}
```

### Controller Error Mapper — exhaustive matching

```typescript
const tradeServiceErrorToHttp = (error: TradeServiceError): HttpError =>
  match(error)
    .with({ code: TradeServiceErrorCode.TradeNotFound }, e => new NotFoundError(e.message, e.payload, e))
    .with({ code: TradeServiceErrorCode.TradeLookupFailed }, e => new InternalServerError(e.message, e.payload, e))
    .with({ code: TradeServiceErrorCode.AccountUnauthorized }, e => new ForbiddenError(e.message, e.payload, e))
    .exhaustive();
```

## Core Principle: Flat Chaining

**The essence of Either is flat chaining** — composing operations without intermediate variables or imperative checks. Left (error) propagates automatically through the chain.

```typescript
// IDEAL: Flat chaining — один flow без промежуточных переменных
return getCredentials()
  .mapLeft(err => CredentialErrors.notFound(err.message))
  .asyncChain(creds => connectToExchange(creds))
  .mapLeft(err => ({ ...err, context: 'connection' }))
  .asyncChain(client => placeOrder(client, params))
  .mapRight(order => ({ orderId: order.id, status: 'placed' }));
```

**Why it works:**
- `chain`/`asyncChain` — if current is Left, skip function and propagate Left
- `mapRight` — transform Right value, pass Left through unchanged
- `mapLeft` — transform/enrich error, pass Right through unchanged
- No need for explicit error checking — it's automatic

## Principle: One Action Per Chain Link

**Каждое звено цепочки должно выполнять ОДНО действие.** Это улучшает:
- **Читаемость** — понятно что делает каждый шаг
- **Отладку** — легко найти где сломалось
- **Тестируемость** — можно тестировать каждую функцию отдельно

```typescript
// ✅ ПРАВИЛЬНО: Одно действие на звено
return getUser(id)
  .chain(user => validatePermissions(user))
  .chain(user => enrichWithProfile(user))
  .asyncChain(user => saveToDatabase(user))
  .mapRight(user => toResponseDto(user));

// ❌ НЕПРАВИЛЬНО: Несколько действий в одном звене
return getUser(id)
  .chain(user => {
    const validated = validatePermissions(user);
    if (validated.isLeft()) return validated;
    const enriched = enrichWithProfile(validated.value);
    return enriched;
  })
  .asyncChain(user => saveToDatabase(user));

// ❌ НЕПРАВИЛЬНО: Вложенные цепочки внутри chain
return getUser(id)
  .chain(user =>
    validatePermissions(user)
      .chain(u => enrichWithProfile(u))  // вложенная цепочка — плохо
  )
  .asyncChain(user => saveToDatabase(user));

// ✅ ПРАВИЛЬНО: Плоская цепочка вместо вложенной
return getUser(id)
  .chain(user => validatePermissions(user))
  .chain(user => enrichWithProfile(user))
  .asyncChain(user => saveToDatabase(user));
```

### Когда нужно передать несколько значений

```typescript
// ✅ ПРАВИЛЬНО: Compose в tuple/object для передачи контекста
return getUser(id)
  .chain(user => validatePermissions(user).mapRight(perms => ({ user, perms })))
  .chain(({ user, perms }) => applyPermissions(user, perms))
  .asyncChain(user => saveToDatabase(user));

// ✅ ПРАВИЛЬНО: Или вынести в отдельную функцию
const validateAndEnrich = (user: User): Either<Error, EnrichedUser> =>
  validatePermissions(user)
    .chain(u => enrichWithProfile(u));

return getUser(id)
  .chain(validateAndEnrich)
  .asyncChain(user => saveToDatabase(user));
```

**Правило**: Если в `chain`/`asyncChain` больше одной строки логики — выноси в отдельную функцию или разбивай на несколько звеньев.

## Either Operators (by preference)

**Primary operators** (use most often):
| Operator | Purpose | When to Use |
|----------|---------|-------------|
| `chain(fn)` | Sync flatMap (fn returns Either) | Validation, sync transformation |
| `asyncChain(fn)` | Async flatMap (fn returns Promise<Either>) | Async operations |
| `mapRight(fn)` | Transform success value | Data transformation |
| `mapLeft(fn)` | Transform/enrich error | Error context enrichment |
| `tapRight(fn)` / `tap(fn)` | Side effect on Right (fire-and-forget) | Logging success |
| `tapLeft(fn)` | Side effect on Left (fire-and-forget) | Logging errors |
| `tapBoth(onLeft, onRight)` | Side effect on both | Metrics, tracing |
| `merge([...])` | Combine multiple Eithers | Parallel operations |

**HTTP boundary** (the actual canonical unwrap — not `fold`):
| Operator | Purpose | When to use |
|----------|---------|-------------|
| `unwrapOrElse(err => { throw mapper(err); })` | Final extraction, throws mapped `HttpError` | At every HTTP controller boundary; caught by the app's global error hook |

**Legacy / rare** (avoid in new code — no `fold()` call sites survive in production controllers; the only remaining hits are in test spec files):
| Operator | Purpose | When to use |
|----------|---------|-------------|
| `fold(onLeft, onRight)` | Final extraction to a plain value | Essentially never in controllers — use `unwrapOrElse` + throw instead |

## Correct Patterns

### Pattern 1: Pure Flat Chain
```typescript
// PERFECT — full chain, no intermediate variables
return validateInput(data)
  .chain(input => parseRequest(input))
  .asyncChain(parsed => repository.save(parsed))
  .mapRight(saved => ({ id: saved.id }))
  .mapLeft(err => ({ ...err, requestId }));
```

### Pattern 2: Side Effects with tap* (PREFERRED)
```typescript
// BEST — tap for fire-and-forget side effects
return fetchData(id)
  .tapRight(data => this.logger.info('Fetched data', { id }))
  .tapLeft(err => this.logger.error('Fetch failed', { id, error: err }))
  .asyncChain(data => processData(data));

// tap is fire-and-forget — doesn't wait for async completion
return saveData(data)
  .tapRight(saved => analytics.track('data_saved', saved.id))  // async, not awaited
  .mapRight(saved => ({ success: true, id: saved.id }));
```

### Pattern 2b: Side Effects with mapLeft (when transforming error)
```typescript
// GOOD — when you need to BOTH log AND transform error
return fetchData(id)
  .mapLeft(err => {
    this.logger.error('Fetch failed', { id, error: err });
    return { ...err, context: 'data_fetch' };  // transform error
  })
  .asyncChain(data => processData(data));
```

### Pattern 3: `unwrapOrElse` + throw at HTTP Boundaries (canonical — NOT `fold`)

Рабочий паттерн в Elysia-контроллерах (
`libs/<domain>/transport/http/provider/**`): map to the response DTO with `mapRight`, then
unwrap with `unwrapOrElse`, whose callback **throws** a mapped `HttpError` instead of returning a value.
A global framework error hook catches the throw and serializes it to the HTTP response —
controllers never call `fold()`.

```typescript
// CANONICAL — mapRight + unwrapOrElse(throw), never fold()
export const accountGroup = new Elysia({ prefix: 'account' })
  .use(requireAuthWithSchema(authPayloadSchema))
  .error({ HttpError })
  .delete('', async ({ payload }) => {
    const result = await inject(accountServiceToken).deleteAccount(payload.user.id);
    result.unwrapOrElse((error) => {
      throw accountServiceErrorToHttp(error); // ts-pattern match().exhaustive() mapper
    });
    return { deleted: true } satisfies AccountDeleteResponseDto;
  });

// With a response DTO transform first:
return result.mapRight(toResponseDto).unwrapOrElse((error) => {
  throw advertServiceErrorToHttp(error);
});
```

```typescript
// app factory — registered ONCE, catches every thrown HttpError from every route
.use(httpErrorPlugin({ includeStack: false }))
// httpErrorPlugin internally does: app.onError(({ error, set }) => {
//   if (error instanceof HttpError) { set.status = error.statusCode; return error.toJSON(); }
//   return error;
// });
```

**Why not `fold()`:** `fold(onLeft, onRight)` forces you to build the *entire* HTTP response object inline
in the success branch, duplicating what `mapRight(toResponseDto)` already does, and gives no natural way to
`throw` instead of `return` from the error branch without an awkward IIFE. `unwrapOrElse` composes with
`mapRight` in a flat chain and lets the error branch simply `throw`.

### Pattern 4: Chain for Sequential Validation
```typescript
return validateUser(input)
  .chain(user => user.isActive ? right(user) : left(UserErrors.inactive(user.id)))
  .chain(user => user.hasPermission ? right(user) : left(UserErrors.forbidden()))
  .asyncChain(user => repository.update(user));
```

### Pattern 5: Merge for Parallel Operations
```typescript
import { merge } from '@monads';

const results = await Promise.all([
  serviceA.getData(),
  serviceB.getData(),
]);

return merge(results).mapRight(([dataA, dataB]) => ({
  combined: { ...dataA, ...dataB }
}));
```

### Pattern 6: Semantic Error Context via Typed Factories
```typescript
// ✅ CORRECT: Factory function creates typed error with payload
.mapLeft(cause => orderCreationFailed(orderId, cause))

// ❌ OLD: Spread with ad-hoc fields — untyped, no discriminant
.mapLeft(error => ({ ...error, context: 'order_creation', timestamp: Date.now() }))
```

## Anti-Patterns

### AVOID: fold() in Controllers — use unwrapOrElse + throw

`fold()` is not the HTTP-boundary canon (see Pattern 3 above). Prefer `mapRight(dto).unwrapOrElse(error => { throw mapper(error); })`:

```typescript
// AVOID — builds the whole response inline, no natural throw path
return result.fold(
  error => { throw new NotFoundError(error.message); },
  user => ({ success: true, data: user })
);

// PREFERRED — flat chain, mapper does the exhaustive match, httpErrorPlugin catches the throw
return result.mapRight(toResponseDto).unwrapOrElse((error) => {
  throw userServiceErrorToHttp(error);
});
```

### NEVER: fold() Returning Either

`fold()` is for **final extraction** to a plain value. If you return Either from fold, you're doing it wrong — use `mapLeft`/`mapRight`/`chain` instead.

```typescript
// WRONG: fold returning Either is an anti-pattern!
return result.fold(
  err => left(transformError(err)),
  value => right(transformValue(value))
);

// RIGHT: Use mapLeft + mapRight
return result
  .mapLeft(err => transformError(err))
  .mapRight(value => transformValue(value));

// WRONG: fold to extract value then wrap again
const token = tokenResult.fold(
  () => null,
  (t) => t
);
if (!token) return left(Error.failed());
return doSomethingWith(token);

// RIGHT: Keep the chain going
return tokenResult
  .mapLeft(() => Error.failed())
  .asyncChain(token => doSomethingWith(token));
```

**Правило**: `fold(onLeft, onRight)` должен возвращать **plain value** (string, object, Response), НЕ Either.

### NEVER: Side Effects in chain()
```typescript
// WRONG: chain is for transformations, not side effects!
return getData()
  .chain(data => {
    logger.info('Got data');  // side effect!
    return right(data);
  });

// RIGHT: Use tap for side effects
return getData()
  .tapRight(data => logger.info('Got data'))
  .mapRight(data => transform(data));
```

### NEVER: Imperative isLeft/isRight Checks
```typescript
// WRONG: Breaks functional flow
const result = await service.doSomething();
if (result.isLeft()) {
  return left(result.value);
}
const value = result.value;
```

### NEVER: await in the Middle of Chain
```typescript
// WRONG: Breaks flat chaining, forces intermediate variable
const result = await getUser(id).asyncChain(u => fetchOrders(u.id));
return result.mapRight(orders => ({ orders }));  // Broken chain!

// WRONG: Parentheses around await — still broken
return (await getUser(id).asyncChain(u => fetchOrders(u.id)))
  .mapRight(orders => ({ orders }));  // Ugly and error-prone

// RIGHT: Use EitherAsync for async chains
return EitherAsync.from(() => getUser(id))
  .chain(user => EitherAsync.from(() => fetchOrders(user.id)))
  .map(orders => ({ orders }))
  .run();

// RIGHT: Or keep full chain with asyncChain
return getUser(id)
  .asyncChain(user => fetchOrders(user.id))
  .then(result => result.mapRight(orders => ({ orders })));
```

**Правило**: Если видишь `(await ...)` в середине цепочки — используй `EitherAsync`.

### NEVER: fold + null + if (Imperative Disguised as Functional)
```typescript
// WRONG: This is still imperative thinking
const error = either.fold(err => err, () => null);
if (error) {
  return left(error);
}
const value = either.fold(() => null!, val => val);
```

### NEVER: try/catch
```typescript
// WRONG: Exception-based
try {
  await service.create(data);
} catch (e) {
  return left(e);
}
```

### NEVER: catchError in RxJS with Either
```typescript
// WRONG: catchError conflicts with Either pattern
observable$.pipe(catchError(e => of(left(e))))

// RIGHT: Use eitherify from @common/rxmonads
observable$.pipe(eitherify(), mapLeft(err => new CustomError(err)))
```

### NEVER: Inline Unwrap
```typescript
// WRONG: Swallows error silently!
return right({ weight: weightResult.unwrap() });
```

### NEVER: Hardcoded Method Names in Messages
```typescript
// WRONG: Couples message to implementation
mapLeft(() => new Error('AccountRepository.create: Insert failed'))

// RIGHT: Describe WHAT failed, not WHERE
mapLeft(() => new Error('Failed to create account'))
```

## When You Think You Need Intermediate Variables

If you feel like you need the value in multiple places:

```typescript
// SEEMS NEEDED: creds used in two places
const creds = ???
await connect(creds);
await logConnection(creds);
```

**Solution: Restructure as chain that passes data through:**
```typescript
return getCredentials()
  .asyncChain(creds =>
    connect(creds).mapRight(client => ({ creds, client }))
  )
  .asyncChain(({ creds, client }) =>
    logConnection(creds).mapRight(() => client)
  );
```

Or use merge for parallel:
```typescript
return getCredentials()
  .asyncChain(creds =>
    merge([connect(creds), logConnection(creds)])
      .mapRight(([client, _]) => client)
  );
```

---

## EitherAsync — Lazy Async Either

`EitherAsync<L, R>` — обёртка для отложенных async операций. Вычисление происходит только при `.run()`.

### Когда использовать EitherAsync

| Ситуация | Either | EitherAsync |
|----------|--------|-------------|
| Sync валидация | ✅ `chain()` | ❌ |
| Один async вызов | ✅ `asyncChain()` | ✅ |
| Цепочка async операций | ⚠️ много `asyncChain` | ✅ `chain()` |
| Нужен `(await ...).map()` | ❌ анти-паттерн | ✅ |
| Lazy execution | ❌ | ✅ `.run()` |
| Retry/recovery | ❌ | ✅ `retry()`, `orElse()` |

### Создание EitherAsync

```typescript
import { EitherAsync } from '@monads';

// Из функции возвращающей Promise<Either>
EitherAsync.from(() => fetchUser(id))

// Из Promise с маппингом ошибки
EitherAsync.fromPromise(
  () => fetch(url).then(r => r.json()),
  err => NetworkError.fromUnknown(err)
)

// Из существующего Either
EitherAsync.fromEither(either)

// Прямые значения
EitherAsync.right(value)
EitherAsync.left(error)
```

### Ключевые отличия от Either

| Аспект | Either | EitherAsync |
|--------|--------|-------------|
| Выполнение | Немедленное | Ленивое (при `.run()`) |
| tap методы | Fire-and-forget | **Awaited** |
| chain принимает | `(R) => Either<L, R2>` | `(R) => EitherAsync<L, R2>` |
| asyncChain | Для async операций | Не нужен (chain уже async) |

### Паттерны использования

```typescript
// Pattern 1: Цепочка async операций
return EitherAsync.from(() => getUser(id))
  .chain(user => EitherAsync.from(() => fetchOrders(user.id)))
  .chain(orders => EitherAsync.from(() => calculateTotal(orders)))
  .map(total => ({ userId: id, total }))
  .run();

// Pattern 2: chainPromise — для Promise без Either
return EitherAsync.from(() => getUser(id))
  .chainPromise(user => fetchExternalApi(user.email))
  .mapLeft(err => ApiError.fromUnknown(err))
  .run();

// Pattern 3: chainEither — для sync Either в async цепочке
return EitherAsync.from(() => fetchData(id))
  .chainEither(data => validateSync(data))  // Either<E, T>
  .chain(valid => EitherAsync.from(() => save(valid)))
  .run();

// Pattern 4: retry — повторные попытки
return EitherAsync.from(() => unreliableApi.call())
  .retry(3, 1000)  // 3 попытки, 1s между ними
  .run();

// Pattern 5: orElse — fallback при ошибке
return EitherAsync.from(() => primaryService.get(id))
  .orElse(() => EitherAsync.from(() => fallbackService.get(id)))
  .run();

// Pattern 6: tap (ВНИМАНИЕ: awaited в EitherAsync!)
return EitherAsync.from(() => saveOrder(order))
  .tap(saved => sendNotification(saved.id))  // ЖДЁТ завершения!
  .tapLeft(err => logError(err))             // ЖДЁТ завершения!
  .run();
```

### Конвертация между Either и EitherAsync

```typescript
// Either → EitherAsync
const ea = EitherAsync.fromEither(either);

// Promise<Either> → EitherAsync
const ea = EitherAsync.from(() => promiseReturningEither);

// EitherAsync → Promise<Either>
const either = await ea.run();
```
