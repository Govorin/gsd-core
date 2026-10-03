# Library-Specific Logging Patterns

## Library Token Pattern

Each library has its own LoggerToken for maximum isolation. This enables:
- Independent mocking per library in tests
- Granular log level control per layer
- Easy disable/enable of logs for specific layers

### Token Definition

```typescript
// libs/trade/services/src/tokens.ts
import type { IConsolaLogger } from '@common/logger';
import { Token } from 'dioma';

export const TradeServicesLoggerToken = new Token<IConsolaLogger>('TradeServicesLogger');

// libs/trade/domain/src/tokens.ts
export const TradeDomainLoggerToken = new Token<IConsolaLogger>('TradeDomainLogger');

// libs/trade/adapters/src/tokens.ts
export const TradeAdaptersLoggerToken = new Token<IConsolaLogger>('TradeAdaptersLogger');
```

**Token naming:** `{Domain}{Layer}LoggerToken`
- TradeServicesLoggerToken
- TradeDomainLoggerToken
- HeimdallCoreLoggerToken
- HeimdallServicesLoggerToken

### Token Registration (Setup)

```typescript
// libs/trade/services/src/di.ts
import { globalContainer } from 'dioma';
import { loggerFactory } from '@common/logger';
import { TradeServicesLoggerToken } from './tokens';

const logger = loggerFactory.createConsolaLogger({ scope: 'trade:services' });
globalContainer.register({ token: TradeServicesLoggerToken, value: logger });
```

### Service Usage

```typescript
// libs/trade/services/src/order.service.ts
import { inject, Scopes } from 'dioma';
import { TradeServicesLoggerToken } from '../tokens';

export class OrderService {
  static scope = Scopes.Singleton();

  // withScope adds component context (token already has domain:layer)
  private logger = inject(TradeServicesLoggerToken).withScope('order');

  async createOrder(params: CreateOrderParams) {
    this.logger.start('Creating order', { userId: params.userId });
    // ... implementation
  }
}
```

## Scope Naming

**Pattern:** Component only (NOT domain:layer:component)

The token already contains `domain:layer` information (TradeServicesLoggerToken = trade:services).
Use `.withScope()` only for component context:

| Component | Scope |
|-----------|-------|
| OrderService | `'order'` |
| PositionService | `'position'` |
| RiskCalculator | `'risk'` |
| SessionManager | `'session:manager'` |
| TokenStorage | `'token-storage'` |
| AuthRoutes | `'routes:auth'` |

**Anti-pattern:**
```typescript
// DON'T - domain:layer is already in the token
private logger = inject(TradeServicesLoggerToken).withScope('trade:services:order');

// DO - only component
private logger = inject(TradeServicesLoggerToken).withScope('order');
```

## Semantic Methods

Use semantic methods instead of generic `info()`/`error()`:

| Method | When to Use |
|--------|-------------|
| `start(message, meta)` | Beginning of async operation |
| `success(message, meta)` | Successful completion |
| `fail(message, meta)` | Operation failed (recoverable) |
| `ready(message, meta)` | Service/component initialized |
| `info(message, meta)` | Informational messages |
| `warn(message, meta)` | Warnings |
| `debug(message, meta)` | Debug info (disabled in production) |
| `error(message, meta)` | Critical errors |
| `time(label)` / `timeEnd(label)` | Performance measurement |

```typescript
// Good - semantic methods
this.logger.start('Creating trade', { userId, symbol });
this.logger.success('Trade created', { tradeId: trade.id });
this.logger.fail('Trade creation failed', { error: err.message });
this.logger.ready('OrderService initialized');

// Avoid - generic methods lose context
this.logger.info('Creating trade');
this.logger.error('Failed');
```

## Either Chain Integration

**Use `tap*` methods for logging, NOT `chain()` or `map()`:**

```typescript
// CORRECT - tapRight/tapLeft for logging
return EitherAsync.from(() => this.repository.findById(id))
  .tapRight(entity => this.logger.success('Entity found', { id: entity.id }))
  .tapLeft(error => this.logger.fail('Entity not found', { error: error.message }))
  .chain(entity => this.validateEntity(entity))
  .tapRight(valid => this.logger.debug('Entity validated'))
  .run();

// WRONG - chain() for side effects
return EitherAsync.from(() => this.repository.findById(id))
  .chain(entity => {
    this.logger.info('Found entity'); // WRONG: chain is for transformations
    return right(entity);
  });
```

**Key difference:**
- `Either.tap` — fire-and-forget (does NOT wait for async)
- `EitherAsync.tap` — awaited (WAITS for completion)

## Timer Labels

**Pattern:** `scope:operation`

```typescript
this.logger.time('trade:create');
// ... operation
this.logger.timeEnd('trade:create');

// Labels examples
'trade:create'
'trade:update'
'ws:connect:binance'
'candle:process'
'binance:market-order'
'db:query'
'api:request'
```

## Message Format

| Situation | Format |
|-----------|--------|
| Action start | Imperative: `'Creating trade'`, `'Connecting to exchange'` |
| Action success | Past tense: `'Trade created'`, `'Connection established'` |
| Action failed | Past tense: `'Account lookup failed'`, `'Connection timeout'` |

**DON'T add manual prefix** — scope handles it:
```typescript
// WRONG - manual prefix
this.logger.info('[OrderService] Creating order');

// CORRECT - scope adds context
private logger = inject(TradeServicesLoggerToken).withScope('order');
this.logger.info('Creating order'); // Logs as: [trade:services:order] Creating order
```

## Metadata

Always include relevant identifiers and context:

```typescript
// Identifiers
this.logger.start('Creating trade', { userId, symbol, accountId });
this.logger.success('Order placed', { orderId, tradeId });

// Errors
this.logger.fail('Operation failed', {
  error: error.message,
  code: error.code,
  stack: error.stack, // for debugging
  userId, tradeId     // context
});

// Metrics
this.logger.info('Positions synced', {
  positions: 15,
  stops: 3,
  triggered: 1,
  skipped: 2,
  duration: 150
});
```

## Testing Pattern

### Mock Logger

```typescript
// libs/trade/services/tests/mocks/mock-logger.ts
export class MockLogger implements IConsolaLogger {
  private calls: Map<string, Array<{ message: string; meta?: object }>> = new Map();

  private log(level: string, message: string, meta?: object) {
    if (!this.calls.has(level)) this.calls.set(level, []);
    this.calls.get(level)!.push({ message, meta });
  }

  start(message: string, meta?: object) { this.log('start', message, meta); }
  success(message: string, meta?: object) { this.log('success', message, meta); }
  fail(message: string, meta?: object) { this.log('fail', message, meta); }
  info(message: string, meta?: object) { this.log('info', message, meta); }
  // ... other methods

  withScope(_scope: string) { return this; }
  withTag(_tag: string) { return this; }

  // Test assertions
  hasLoggedMessage(level: string, substring: string): boolean {
    return this.calls.get(level)?.some(c => c.message.includes(substring)) ?? false;
  }

  getLastCall(level: string) { return this.calls.get(level)?.at(-1); }
  getCalls(level: string) { return this.calls.get(level) ?? []; }
  clear() { this.calls.clear(); }
}
```

### Test Setup

```typescript
// In vitest.setup.ts or beforeEach
import { globalContainer } from 'dioma';
import { TradeServicesLoggerToken } from '@trade/services';
import { MockLogger } from '@trade/services/tests';

const mockLogger = new MockLogger();
globalContainer.register({ token: TradeServicesLoggerToken, value: mockLogger });

// In test
expect(mockLogger.hasLoggedMessage('success', 'Trade created')).toBe(true);
expect(mockLogger.getLastCall('fail')?.meta).toEqual({ error: 'Not found' });
```

## Best Practices

### 1. Structured Logging (JSON in production)

```typescript
const logger = loggerFactory.createConsolaLogger({
  scope: 'trade:services',
  formatters: process.env.NODE_ENV === 'production'
    ? { json: true }
    : { pretty: true }
});
```

### 2. Correlation ID

```typescript
// In HTTP middleware
const requestLogger = inject(TradeServicesLoggerToken)
  .withTag(request.headers['x-correlation-id'] || crypto.randomUUID());
```

### 3. Log Levels by Environment

```typescript
import { match } from 'ts-pattern';

const logLevel = match(process.env.NODE_ENV)
  .with('production', () => 'info')
  .with('development', () => 'debug')
  .with('test', () => 'silent')
  .otherwise(() => 'info');
```

### 4. Sensitive Data Masking

**NEVER log:** apiKey, apiSecret, password, token, secret, creditCard, SSN

```typescript
const maskSensitive = (data: Record<string, unknown>) => {
  const sensitive = ['apiKey', 'password', 'token', 'secret'];
  return Object.fromEntries(
    Object.entries(data).map(([k, v]) =>
      sensitive.includes(k) ? [k, '***MASKED***'] : [k, v]
    )
  );
};

this.logger.info('Request', maskSensitive(body));
```

### 5. Performance Logging

```typescript
this.logger.time('db:query:orders');
const orders = await this.repository.findByUser(userId);
const duration = this.logger.timeEnd('db:query:orders');

if (duration > 1000) {
  this.logger.warn('Slow query', { duration, query: 'findByUser' });
}
```

### 6. Log Sampling for High-Volume

```typescript
// For high-throughput endpoints - sample 10%
if (Math.random() < 0.1) {
  this.logger.debug('WebSocket message', { type, payload });
}
```

### 7. NoOp Logger for Optional Dependencies

```typescript
export class NoOpLogger implements IConsolaLogger {
  debug() {}
  info() {}
  warn() {}
  error() {}
  start() {}
  success() {}
  fail() {}
  ready() {}
  time() {}
  timeEnd() { return 0; }
  withScope() { return this; }
  withTag() { return this; }
}
```

## Anti-Patterns

1. **Never use `console.log/error/warn`** - always use logger
2. **Don't log sensitive data** (apiKey, password, token)
3. **Don't over-log** with debug for every variable
4. **Don't add manual `[ServiceName]` prefix** - scope handles it
5. **Don't use `chain()` for logging** - use `tap*()`
6. **Don't use shared ConsolaLoggerToken** - use library-specific token

## Current State

Один токен на библиотеку — рабочий паттерн, а не план миграции. Проверить в своём проекте: поискать `LoggerToken` и посмотреть, один он на всё или по одному на либу.
