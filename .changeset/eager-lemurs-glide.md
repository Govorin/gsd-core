---
type: Added
pr: 3176
---
**Template registry generated from each template's `gsd-template:` block** — all 43 shipped templates now declare their level, lifecycle, required flag, author and readers. `scripts/gen-template-registry.cjs` compiles those blocks into `docs/TEMPLATE-REGISTRY.json` and the Template Index region of `gsd-core/templates/README.md`, and is wired into both `regen:derived` and `lint:generated-sync`, so a template that loses its block fails CI instead of drifting silently. The block is specified in `docs/reference/template-registry.md`; on the three templates whose leading frontmatter is the *artifact's* frontmatter (`VALIDATION.md`, `SECURITY.md`, `UI-SPEC.md`), it is a separate second block so no agent is ever instructed to stamp `gsd-template:` onto produced planning state.
