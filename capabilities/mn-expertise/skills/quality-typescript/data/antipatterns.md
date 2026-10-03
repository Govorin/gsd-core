# Anti-Patterns Checklist

Before completing any code, verify:

| Check | Bad | Good |
|-------|-----|------|
| Error handling | `try/catch` | `eitherify()` + `mapLeft()` |
| RxJS errors | `catchError` | `eitherify()` |
| Conditionals | `if/else` chains | `ts-pattern match()` |
| Null checks | `if (!x) return` | `chain()` with Either |
| Combining Eithers | `.unwrap()` inline | `merge()` from `@monads` |
| Loops for transform | `for` loop | `map()`, `reduce()`, `merge()` |
| Side effects in Either | `chain()` with logging | `tapRight()`, `tapLeft()` |
| **Logging in chains** | logging in `chain()`/`map()` | **only `tap*` methods** |
| `fold()` mid-flow or at HTTP boundary | extract then continue / build response inline | flat chaining; at the boundary use `mapRight(dto).unwrapOrElse(err => { throw mapper(err); })` |
| **`fold()` returns Either** | `fold(e => left(x), v => right(y))` | `mapLeft()`/`mapRight()`/`chain()` |
| `isLeft()`/`isRight()` | imperative checks | flat chaining operators |
| **Multi-action chain link** | `chain(x => { a(); b(); c() })` | one action per `.chain()` |
| **Nested chains** | `.chain(x => fn(x).chain(...))` | flat: `.chain(fn).chain(...)` |
| Error messages | `'Class.method: failed'` | `'Failed to X'` + context object |
| **Error namespace pattern** | `TradeErrors.notFound(id)` | `tradeNotFound(id)` plain function |
| **Shared error intermediary** | `ManagerError`, `RepositoryError` | Per-service type: `TradeServiceError` |
| **Mechanical error conversion** | `.mapLeft(toManagerError)` | `.mapLeft(cause => lookupFailed(id, cause))` |
| **Generic error codes** | `PERSISTENCE_FAILED`, `NOT_FOUND` | `TRADE_LOOKUP_FAILED`, `TRADE_NOT_FOUND` |
| **Untyped error payload** | `{ ...error, context: 'x' }` | Typed `payload: { tradeId }` per variant |
| **Lost original error** | `mapLeft(() => new Error('failed'))` | `mapLeft(cause => lookupFailed(id, cause))` |
| Type safety | `any`, raw `unknown` | Zod schemas → inferred types |
| Branded types | manual `& { __brand }` | `z.string().brand<'X'>()` |
| Async flow | nested callbacks | `asyncChain()` pipes |
| `(await ...)` mid-chain | `(await x.asyncChain(...)).map()` | `EitherAsync` |
| Variables | `let`, mutations | `const`, spread |

## Size Limits

| Element | Optimal | Warning | Error |
|---------|---------|---------|-------|
| Class | 100-200 lines | 200-400 | >400 |
| Method/Function | 25-35 lines | 40-60 | >60 |
| React Component | 35-60 lines | 60-100 | >100 |

## Type Safety Rules

```typescript
// NO `any` — Ever
function process(data: any) { ... }  // FORBIDDEN
const result = value as any;         // FORBIDDEN

// USE generics or unknown with validation
function process<T extends BaseDto>(data: T) { ... }
function handle(input: unknown): Either<ValidationError, Account> {
  return validateAccount(input);
}

// NO `unknown` in Returns
interface IService {
  getData(): Promise<Either<Error, unknown>>;  // WRONG
  getData(): Promise<Either<HttpError, UserResponseDto>>;  // CORRECT
}
```

## Const Objects via Zod

```typescript
// WRONG — Manual string union
export type StatusCode = 'PENDING' | 'SUCCESS' | 'ERROR';

// WRONG — z.nativeEnum() is deprecated in Zod 4
export const StatusCodeSchema = z.nativeEnum(StatusCode);

// CORRECT — Const object + z.enum() (Zod 4)
export const StatusCode = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  ERROR: 'ERROR',
} as const;

export const StatusCodeSchema = z.enum(StatusCode);
export type StatusCode = z.infer<typeof StatusCodeSchema>;
```

## Dependency Injection

```typescript
// WRONG
@Injectable()
class UserService {
  constructor(private repo: UserRepository) {}
}

// CORRECT
class UserService {
  static scope = Scopes.Singleton();
  private repo = inject(userRepositoryToken);
}
```

## Framework Coupling Check

No framework imports in libs/ (except libs/*/ui/):

```bash
grep -r "from 'react'" libs/ --exclude-dir=ui
grep -r "from '@angular/core'" libs/ --exclude-dir=ui
grep -r "from 'vue'" libs/ --exclude-dir=ui
```
