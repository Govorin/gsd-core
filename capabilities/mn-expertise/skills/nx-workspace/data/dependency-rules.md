# Dependency Rules

## Valid Dependency Flow

```
apps/catpod/api
  ↓
libs/catpod/controllers
  ↓
libs/catpod/services (framework-agnostic!)
  ↓
libs/catpod/repositories
  ↓
libs/catpod/mappers
  ↓
libs/catpod/domain
  ↓
libs/shared/types
```

## Strict Rules

| Rule | Description |
|------|-------------|
| Apps → Libs | ✅ Apps MAY depend on libs |
| Libs → Apps | ❌ Libs MAY NOT depend on apps |
| Domain → Infrastructure | ❌ Domain MAY NOT depend on repositories, controllers |
| Infrastructure → Domain | ✅ Infrastructure MAY depend on domain |
| Shared → Domain-specific | ❌ Shared libs MAY NOT depend on domain-specific |

## Framework Isolation

```typescript
// ❌ WRONG - Framework in shared service
// libs/shared/services/src/lib/analytics.service.ts
import { useState } from 'react';  // Framework coupling!

// ✅ CORRECT - Framework-agnostic service
export class AnalyticsService {
  trackEvent(event: string): Promise<Either<Error, void>> { ... }
}

// ✅ React adapter in UI library
// libs/shared/ui/react/src/lib/use-analytics.ts
import { AnalyticsService } from '@workspace/shared/services';

export function useAnalytics() {
  const service = inject(AnalyticsServiceToken);
  return { trackEvent: (e) => service.trackEvent(e) };
}
```

## Cross-Language Dependencies

- ❌ Language-specific libs CANNOT depend on other languages directly
- ✅ Use Protocol Buffers or JSON schemas for contracts
- ✅ Place contracts in `libs/protocols/` or `libs/schemas/`

## Anti-Patterns

```
❌ libs/catpod/domain → libs/catpod/repositories
   (Domain should NOT depend on infrastructure)

❌ libs/catpod/services → libs/catpod/ui/react
   (Services should be framework-agnostic)

❌ libs/shared/utils → libs/catpod/domain
   (Shared cannot depend on domain-specific)

❌ libs/catpod/repositories → apps/catpod/api
   (Libraries cannot depend on apps)
```
