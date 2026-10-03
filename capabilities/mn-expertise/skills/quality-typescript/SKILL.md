---
name: quality-typescript
description: "Как писать TypeScript: Either/EitherAsync вместо исключений, ts-pattern вместо цепочек if, branded ID и phantom types вместо голых строк, Zod как источник типа, per-service ошибки, логирование через tap*. Применяется при написании и ревью любого TypeScript-кода, при выборе между Either и EitherAsync, при разборе цепочки, которая не типизируется, при проектировании типа ошибки сервиса и при вопросе «как это выразить в типах». Даёт форму кода; куда его положить — отдельный вопрос к скиллу раскладки проекта. Framework-agnostic."
---

# Quality TypeScript Skill

Декларативные паттерны TypeScript: как выразить отказ, ветвление и состояние в типах,
чтобы компилятор ловил то, что иначе ловил бы тест или ревьюер.

## Quick Reference

### Error Handling

| Do | Don't |
|----|-------|
| `EitherAsync.fromPromise()` / `tryAsync()` + `mapLeft()` | `try/catch` |
| `Either<Error, Value>` returns | `throw` exceptions |
| `chain()`, `mapRight()` | `isLeft()`/`isRight()` checks; `asyncChain()` — `@deprecated`, `chain()` сам различает sync/async |
| `tapRight()`, `tapLeft()` for side effects | `chain()` with side effects |
| `tap*` for logging in chains | logging in `chain()`/`map()` |
| `merge()` for combining Eithers | inline `.unwrap()` |
| `unwrapOrElse(err => { throw mapper(err); })` at HTTP boundary | `fold()` at HTTP boundary |
| `fold()` only at a terminal boundary, and only returning a plain value | **`fold()` returning Either** ← ОШИБКА: цепочка схлопнута, а тип вложен сам в себя |
| `mapLeft`/`mapRight` for transformations | `fold` + `left`/`right` wrap |
| Per-service error types (`TradeServiceError`) | Shared `ManagerError` intermediary |
| Plain factory functions: `tradeNotFound(id)` | Namespace pattern: `TradeErrors.notFound(id)` |
| Semantic error codes: `TRADE_LOOKUP_FAILED` | Generic codes: `PERSISTENCE_FAILED` |
| `mapLeft(cause => lookupFailed(id, cause))` | Mechanical `mapLeft(toManagerError)` |
| `cause?: unknown` for infra errors | Losing original error through layers |

### Pattern Matching

| Do | Don't |
|----|-------|
| `ts-pattern match().exhaustive()` | `if/else` chains |
| Discriminated unions | String unions |
| `z.enum(ConstObject)` — один источник для типа и рантайма | bare `z.enum(['a','b'])` — строки живут отдельно от const-объекта и разъезжаются |

### Type Safety

| Do | Don't |
|----|-------|
| Concrete return types | `any`, `unknown` returns |
| Branded types via `z.brand()` | Plain string IDs |
| Zod schemas for validation | Manual type guards |
| Phantom types for state machines (`Order<Draft>` → `Order<Submitted>`) | Runtime `if (status === 'draft')` gates |
| Phantom types for permissions (`Request<Authenticated>`) | Repeated runtime auth checks |
| Phantom types for units (`Price<USD>`, `Amount<BTC>`) | Raw `number` for money/quantities |
| Phantom type restored via smart constructor after `z.parse()` | `as Order<Draft>` casts outside the module |
| `z.enum(ConstObject)` | `z.nativeEnum(Obj)` — работает, но лишний: в Zod 4 `z.enum` принимает const-объект напрямую |

> **Примеры выше — целевая форма, а не опись существующего кода.** `Order<Draft>`, `Price<USD>` придуманы для этого документа. Прежде чем сослаться на такой тип как на имеющийся — проверь, что он есть в репозитории (`grep` по имени), и не выдавай образец за факт. Фантомные типы приживаются медленно: обычно в проекте есть один-два пилота, а не сплошное покрытие.

## Either vs EitherAsync

| Когда использовать | Either | EitherAsync |
|-------------------|--------|-------------|
| Sync валидация | ✅ `chain()` | ❌ |
| Один async вызов | ✅ `chain()` | ✅ |
| Цепочка async операций | ⚠️ каждое звено — свой `await` | ✅ `chain()` до `.run()` |
| Lazy execution нужен | ❌ | ✅ `.run()` |
| Retry/recovery логика | ❌ | ✅ `retry()`, `orElse()` |

**Ключевое отличие tap:**
- `Either.tap` — fire-and-forget (НЕ ждёт Promise)
- `EitherAsync.tap` — awaited (ЖДЁТ Promise)

### Logging

| Do | Don't |
|----|-------|
| `inject({Domain}{Layer}LoggerToken)` via the DI wrapper | raw `dioma` import / `inject(ConsolaLoggerToken)` |
| `.withScope('component')` | `.withScope('domain:layer:component')` |
| `tapRight()` for success logging | `chain()` for logging |
| `tapLeft()` for error logging | side effects in `mapLeft()` |
| Library-specific token per layer | Shared global token |
| `start()`, `success()`, `fail()` | generic `info()`, `error()` |

**Token naming:** `{Domain}{Layer}LoggerToken`. One token per library, not one shared global — otherwise every log line carries the same scope and you cannot mute a noisy layer without muting everything.

**Scope naming:** component only (`'order'`, `'position'`). Domain and layer are already encoded in the token, so repeating them makes `domain:layer:domain:layer:component`.

**DI note:** prefer the project's DI wrapper over importing the container library directly — the wrapper is where token definition, per-library loggers and bootstrap live, and it is the seam you would replace if the container changed. Check the project's alias table for its name.

⚠️ Whether this preference is *linted* varies by project. Verify before claiming a violation is caught by CI: read the lint config rather than assuming. A rule that exists in one repository is not evidence it exists here.

**Documentation:** Read `data/logging.md` for detailed patterns.

## Data Files

Read these files for detailed patterns:

- `data/either-patterns.md` - Either & EitherAsync patterns
- `data/rxmonads.md` - RxJS + Either operators
- `data/solid.md` - SOLID principles with examples
- `data/antipatterns.md` - Anti-patterns checklist
- `data/logging.md` - Library-specific logging patterns

## Core Rules

1. **Без `any`** — дженерик или Zod-валидация. `any` не «ослабляет тип», он **выключает проверку целиком** для всего, что от него производно: ошибка всплывёт там, где `any` уже забыт.
2. **Без `try/catch`** — `EitherAsync.fromPromise()` для промисов, `fromTry()` для синхронного броска, `tryAsync()` в цепочке. Иначе отказ исчезает из сигнатуры: вызывающий не видит, что тут может упасть, и узнаёт об этом в проде. (`eitherify()` — узкий RxJS-случай, не канон)
3. **Без `catchError` поверх Either** — он ловит *исключение*, а отказ у нас едет значением в left-канале и мимо него проходит. Получается обработчик, который не срабатывает.
4. **Без `isLeft`/`isRight`** — плоская цепочка `chain()`/`mapRight()`/`mapLeft()`. Ручная проверка возвращает ветвление, ради устранения которого Either и заведён: компилятор перестаёт следить, что обе ветки обработаны.
5. **`fold()` — только на терминальной границе, и в контроллере оно не нужно.** В контроллере канон — `result.mapRight(dto).unwrapOrElse(error => { throw mapper(error); })`: короче и не соблазняет вернуть `Either` из ветки. Внутри сервиса `fold` запрещён — он схлопывает `Either`, и вызывающий теряет право решать, что делать с отказом. Где ещё границу считают терминальной (например, проекция состояния во фронте) — смотри стандарт проекта
6. **`fold()` returning Either = ОШИБКА** - Use `mapLeft`/`mapRight`/`chain` instead
7. **Побочные эффекты — через `tap*`** (`tapRight`, `tapLeft`). В `chain`/`map` эффект смешивается с трансформацией: звено начинает делать два дела, и при отказе непонятно, что успело выполниться.
8. **Агностичность** — импорт фреймворка тянет его в бандл и в тест: агностичную либу больше нельзя ни собрать в другой платформе, ни проверить без jsdom.
9. **Класс до ~200 строк, функция до ~35** — не самоцель, а признак: переросшее говорит, что сущность взяла вторую ответственность. Числа ориентировочные, повод посмотреть — не повод механически резать.
10. **Иммутабельность** — `const`, spread. Мутация общего объекта видна всем, кто держит на него ссылку, и отлаживается тяжелее всего: место записи и место, где сломалось, не совпадают.
11. **One file = one concern** — Each type, enum, branded ID, interface gets its own file. No mixing.
12. **Prefer phantom types** — For state machines, permissions, validation stages, and units, encode state at the type level via phantom parameters (`Order<Draft>`, `Price<USD>`). Compile-time safety, zero runtime cost. Complement branded IDs and discriminated unions; don't replace them. Phantoms erase at I/O boundaries — restore via smart constructors. Pilot a single domain end-to-end before scaling.

## Error Hierarchy

```
Domain Layer (services) → Per-service error types (TradeServiceError, UserServiceError)
HTTP Layer (controllers) → HTTP Errors (NotFoundError, BadRequestError)
```

### Per-Service Error Types

Each service defines its own discriminated union error type. No shared intermediary types like `ManagerError`.

**File structure** per service:
- `trade-service-error-code.ts` — const object with PascalCase keys
- `trade-service.errors.ts` — discriminated union type + plain factory functions

**Two categories of errors:**
- **Business errors** (TradeNotFound, AccountUnauthorized) — no `cause`, payload has relevant IDs
- **Infrastructure errors** (TradeLookupFailed) — `cause: unknown` preserving original error

**mapLeft adds semantic context** — `tradeLookupFailed(id, cause)` tells WHAT failed, `cause` tells WHY.

**Controller mapping** — `ts-pattern match().exhaustive()` maps service error codes to HTTP errors (e.g. `advertServiceErrorToHttp`), then the controller unwraps with:
```typescript
return result.mapRight(toResponseDto).unwrapOrElse((error) => {
  throw advertServiceErrorToHttp(error);
});
```
The thrown `HttpError` is caught by a global error hook registered once in the app factory (in Elysia — `onError`), so the controller stays two lines and never calls `fold()`. The point is not the framework: throwing at the boundary works only if something above actually catches it — verify that hook exists before writing controllers this way.

**Details**: See `data/either-patterns.md` → "Service Error Types Convention".
