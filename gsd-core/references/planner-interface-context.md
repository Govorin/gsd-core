# Interface Context for Executors

**Key insight:** "The difference between handing a contractor blueprints versus telling them 'build me a house.'"

When creating plans that depend on existing code or create new interfaces consumed by other plans:

## Source order: the decision first, the code second

**If the phase has a `{phase}-DESIGN.md`, read its `## Contracts` section before you grep anything.** Those signatures are what was *decided*; a grep returns what currently *exists*. For a port this phase introduces, the two differ in the way that matters — the code is not written yet, so grep finds nothing and the plan is authored against a guess.

That guess is the failure this whole block exists to prevent, and it is not hypothetical: wave 1 declares `findById(id): EitherAsync<RepoError, Book>`, wave 2's plan was written when nothing existed to read and calls it as `Promise<Book | null>`. Both plans verify green — `files_modified` do not overlap, `key_links` match, each project's tests pass — and the mismatch lands on the pre-commit typecheck with both commits already in history.

So:

1. `## Contracts` in the phase's DESIGN.md — for signatures this phase introduces. Copy the declaration **verbatim**; a paraphrase is a second source of truth.
2. The codebase grep below — for everything that already exists.

When both speak about the same symbol and disagree, the DESIGN.md is the newer statement of intent and the code is the older fact. Carry the declaration, and say in the plan that it changes an existing signature — that is a consumer-breaking change, and the plans that call it need to know.

## For plans that USE existing code:
After determining `files_modified`, extract the key interfaces/types/exports from the codebase that executors will need:

```bash
# Extract type definitions, interfaces, and exports from relevant files
grep -n "export\\|interface\\|type\\|class\\|function" {relevant_source_files} 2>/dev/null | head -50
```

Embed these in the plan's `<context>` section as an `<interfaces>` block:

```xml
<interfaces>
<!-- Key types and contracts the executor needs. Extracted from codebase. -->
<!-- Executor should use these directly — no codebase exploration needed. -->

From src/types/user.ts:
```typescript
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}
```

From src/api/auth.ts:
```typescript
export function validateToken(token: string): Promise<User | null>;
export function createSession(user: User): Promise<SessionToken>;
```
</interfaces>
```

## For plans that CREATE new interfaces:
If this plan creates types/interfaces that later plans depend on, include a "Wave 0" skeleton step:

```xml
<task type="auto">
  <name>Task 0: Write interface contracts</name>
  <files>src/types/newFeature.ts</files>
  <action>Create type definitions that downstream plans will implement against. These are the contracts — implementation comes in later tasks.</action>
  <verify>File exists with exported types, no implementation</verify>
  <done>Interface file committed, types exported</done>
</task>
```

## When to include interfaces:
- Plan touches files that import from other modules → extract those module's exports
- Plan creates a new API endpoint → extract the request/response types
- Plan modifies a component → extract its props interface
- Plan depends on a previous plan's output → extract the types from that plan's files_modified

## When to skip:
- Plan is self-contained (creates everything from scratch, no imports)
- Plan is pure configuration (no code interfaces involved)
- Level 0 discovery (all patterns already established)
