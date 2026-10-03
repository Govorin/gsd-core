# SOLID Principles

## S — Single Responsibility

Each class/module has ONE reason to change.

```typescript
// WRONG — Multiple responsibilities
class UserService {
  createUser() { ... }
  sendWelcomeEmail() { ... }     // Email responsibility
  generateReport() { ... }        // Reporting responsibility
}

// CORRECT — Single responsibility each
class UserService {
  create(data: CreateUserDto): Promise<Either<HttpError, User>> { ... }
  findById(id: UserId): Promise<Either<HttpError, User>> { ... }
}

class UserNotificationService {
  sendWelcomeEmail(user: User): Promise<Either<HttpError, void>> { ... }
}
```

## O — Open/Closed

Open for extension, closed for modification.

```typescript
// CORRECT — Extend via new implementations
interface PaymentProcessor {
  process(payment: Payment): Promise<Either<HttpError, Receipt>>;
}

class StripeProcessor implements PaymentProcessor { ... }
class PayPalProcessor implements PaymentProcessor { ... }
class CryptoProcessor implements PaymentProcessor { ... }
```

## L — Liskov Substitution

Subtypes must be substitutable for their base types.

```typescript
// WRONG — Violates LSP
class Penguin extends Bird {
  fly(): void { throw new Error("Penguins can't fly!"); }
}

// CORRECT — Proper hierarchy
interface Bird { move(): void; }
interface FlyingBird extends Bird { fly(): void; }

class Sparrow implements FlyingBird { ... }
class Penguin implements Bird { ... }
```

## I — Interface Segregation

Many specific interfaces > one general-purpose interface.

```typescript
// WRONG — Fat interface
interface Worker {
  work(): void;
  eat(): void;
  sleep(): void;
}

// CORRECT — Segregated
interface Workable { work(): void; }
interface Eatable { eat(): void; }

class Human implements Workable, Eatable { ... }
class Robot implements Workable { ... }
```

## D — Dependency Inversion

Depend on abstractions, not concretions.

```typescript
// WRONG — Tight coupling
class UserService {
  private repo = new PostgresUserRepository();
}

// CORRECT — Depends on abstraction via DI
interface IUserRepository {
  findById(id: UserId): Promise<Either<HttpError, User | null>>;
}

class UserService {
  private repo = inject(userRepositoryToken);  // IUserRepository
}

// Registration in di.ts
globalContainer.register({ token: userRepositoryToken, class: PostgresUserRepository });
```
