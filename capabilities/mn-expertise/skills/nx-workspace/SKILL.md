# NX Workspace Skill

NX monorepo workspace management and project orchestration.

## Quick Reference

### Multi-Language Prefixes

| Language   | Prefix   | Example                    |
|------------|----------|----------------------------|
| TypeScript | (none)   | `libs/shared/common`       |
| Gleam      | `gleam-` | `libs/gleam-shared/common` |
| Rust       | `rust-`  | `libs/rust-shared/utils`   |
| Go         | `go-`    | `libs/go-shared/api`       |
| Python     | `py-`    | `libs/py-trade/analytics`  |

### Project Tags (MANDATORY)

```json
{
  "tags": [
    "scope:{domain}",      // catpod, polyglot, trade, shared
    "type:{type}",         // app, lib, ui, api, domain, service
    "lang:{language}",     // ts, gleam, rust, go, python
    "platform:{platform}"  // web, mobile, server, cli
  ]
}
```

### Critical Rules

1. **Library-First**: ALL business logic in `libs/`, apps are thin orchestration layers
2. **Biome Targets**: MANDATORY for all JS/TS projects (`format`, `format-check`)
3. **Framework Isolation**: Services must be framework-agnostic
4. **Workspace Aliases**: Use `@workspace/{scope}/{name}` imports

### Common Commands

```bash
# Create library
npx nx generate @nx/js:library {name} --directory=libs/{domain}/{name} --tags=scope:{domain},type:lib,lang:ts

# Create API app
npx nx generate @nx/node:application {name} --directory=apps/{domain}/{name} --tags=scope:{domain},type:api,lang:ts,platform:server

# Run affected
npx nx affected -t test --base=main

# Show project graph
npx nx graph
```

## Data Files

- `data/project-structure.md` - Library structure, naming conventions, tags
- `data/project-json-examples.md` - TypeScript, React, Python project.json examples
- `data/nx-config.md` - nx.json configuration, caching, task pipelines
- `data/dependency-rules.md` - Dependency constraints and valid flow patterns
