# Project Structure Conventions

## Library Organization

```
libs/
├── {domain}/                  # Domain boundary (catpod, polyglot, trade, shared)
│   ├── domain/               # Core business entities
│   ├── dtos/                 # Data Transfer Objects
│   ├── repositories/         # Data access layer
│   ├── mappers/              # Entity ↔ DTO conversion
│   ├── controllers/          # API controllers (Elysia)
│   ├── services/             # Business logic (framework-agnostic!)
│   ├── validators/           # Validation logic
│   ├── types/                # TypeScript types
│   ├── ui/                   # UI components (framework-specific)
│   │   ├── react/
│   │   └── angular/
│   └── docs/                 # Documentation
```

## Multi-Language Structure

```
libs/
├── shared/                    # TypeScript (no prefix)
├── gleam-shared/              # Gleam (gleam- prefix)
├── rust-shared/               # Rust (rust- prefix)
├── go-shared/                 # Go (go- prefix)
├── py-trade/                  # Python (py- prefix)
├── protocols/                 # Cross-language contracts (protobuf)
└── schemas/                   # JSON schemas
```

## Barrel Exports

Every library MUST have explicit exports (avoid `export *`):

```typescript
// libs/catpod/domain/src/index.ts
export { Cat } from './lib/cat.entity';
export { CatRepository } from './lib/cat.repository';
export type { CatId } from './lib/cat.types';
```

## Biome Targets (MANDATORY for JS/TS)

```json
{
  "targets": {
    "format": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx @biomejs/biome format --write {projectRoot}"
      }
    },
    "format-check": {
      "executor": "nx:run-commands",
      "options": {
        "command": "bunx @biomejs/biome check {projectRoot}"
      }
    }
  }
}
```
