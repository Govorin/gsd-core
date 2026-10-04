<data_contract_for_ui>
**If this phase renders a form, a list, or any screen bound to a DTO, put the field table in the plan before the UI work is scheduled.**

The visual contract (UI-SPEC.md) carries palette, spacing and typography. It carries no fields. A designer who is told "draw the check-in form" and nothing else invents the fields, and the invention diverges from the Zod schema — which is what actually validates the request. That divergence surfaces in UAT, and fixing it usually means touching the DTO, so it cascades.

The half of the contract that already exists in code should be read, not retyped:

```bash
gsd_run mn zod-fieldtable \
  --file libs/<domain>/dtos/src/<name>.dto.ts --export <schemaName> --raw
```

Run it from the project root: it loads the schema in the project's own runtime — bun when installed (it resolves tsconfig path aliases), otherwise Node with type stripping (it does not). It emits field · type · required · bounds · enum values · default, plus an `erDiagram` when the schema nests. Paste that output into the plan's context for the UI task. It is marked `gsd:derived` — regenerate it, never hand-edit it, or it becomes a second source of truth that drifts from the schema. If the schema cannot be loaded, the command fails and says why; record that in the plan instead of retyping the fields.

What the schema does **not** decide, and what the plan must therefore state explicitly:

- **which control** each field gets — an enum of three is a radio group, an enum of forty needs a combobox with search; the count is in the schema, the threshold is a judgement
- **field order and grouping** — `z.object` has no meaningful order
- **error copy** — "String must contain at least 1 character(s)" is not what a user should read
- **when validation fires** — on blur, on submit, live
- **conditional visibility** — `.refine()` states a rule, not that field B hides while A is empty
- **per-role visibility** — not expressed in a DTO at all

Do not leave these to the executor to improvise: an improvised choice is invisible at review time, because nothing records that a choice was made.
</data_contract_for_ui>
