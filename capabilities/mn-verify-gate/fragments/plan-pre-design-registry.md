<design_registry_for_ui>
**If this phase builds frontend, read the project's `DESIGN-SYSTEM.md` before planning any screen, and put the component registry in the plan before the UI work is scheduled.**

There is a document that already answers "which components exist, with which node ids, in which states" — and nothing in this pipeline reads it. `apps/polyglot/DESIGN-SYSTEM.md` is 1052 lines of exactly that: zone map, component ids, states per component, screen registry. It is produced under the `quality-design` skill and consumed by no one. UI-SPEC.md carries palette, spacing and typography, and not one component. So the planner schedules "build the journal screen" without knowing that 39 masters exist in the design file, that 15 of them are already written, and that `IconButton` has five states drawn. It invents the list, and the invention diverges from the file the designer is actually working in.

## Read the design system first

```bash
cat apps/<domain>/DESIGN-SYSTEM.md      # zones, component ids, states, screen registry
```

If the project has no `DESIGN-SYSTEM.md`, say so in the plan and propose creating one — that is the `quality-design` convention, and its absence is a finding, not a detail. Do not substitute a screenshot: **the design file's node properties are the source, screenshots are for visual regression tests only.**

## Then derive what is already built

The registry says what should exist. The disk says what does. Only the second half can be generated:

```bash
# canonical — HTML export from Pencil (requires the Pencil app running)
node "$HOME/.gsd/mn-verify-gate/scripts/design-registry.mjs" \
  --html <export-dir> --code libs/<domain>

# without Pencil — parse the registry table in DESIGN-SYSTEM.md
node "$HOME/.gsd/mn-verify-gate/scripts/design-registry.mjs" \
  --registry apps/<domain>/DESIGN-SYSTEM.md --code libs/<domain>
```

It emits node id · component · states from the design · code path · implemented yes/no, plus drift in both directions. Output is marked `gsd:derived` — regenerate it, never hand-edit it.

Exit codes: `0` checked and clean · `1` checked, components unimplemented (under `--check`) · `2` could not check at all. Treat `2` as a blocked task, not a pass — a missing export and a complete implementation both produce "no missing components" if you only read the summary line.

## What the registry does not decide

The script reports whether a file exists. It cannot report whether that file is *right*, and it must not be read as though it could:

- **`todo` / `in-progress` / `done`** — a file existing is not a component being finished. Status is a human judgement; its home is `DESIGN-SYSTEM.md`, not the generated table.
- **Deliberate divergence** — where code intentionally departs from the mockup, and why. An undocumented divergence is indistinguishable from a bug.
- **Which states are mandatory** — the design showing five states does not make five states required for this phase. `happy · loading · empty · no-results · error · offline` is the canon to reason against; which apply to *this* data is a decision.
- **Breakpoints and responsive behaviour** — mobile artboards are one width. What happens at tablet and desktop is usually not drawn at all, and inventing it silently is how layouts diverge.
- **Name mismatches** — matching is exact by design. `RecDrinkRow` will not match `DrinkRow`, and that is deliberate: a false "already built" closes a task nobody did. Record intentional renames in a `--map` file, which makes the mapping a recorded decision rather than a guess.

State these in the plan. An improvised choice is invisible at review time, because nothing records that a choice was made.

## Direction of truth

Per `quality-design`: **the design is the source of truth, not the code.** Code aligns to the design, not the reverse. A component in code with no node in the design is either the design lagging or a component that was never meant to be drawn — both are decisions for the owner. And `DESIGN-SYSTEM.md` itself is authoritative only while it matches the live design file; where they disagree, the file wins and the document gets fixed.
</design_registry_for_ui>
