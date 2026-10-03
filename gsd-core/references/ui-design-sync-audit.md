# UI auditor: Design Sync Audit

Read by `gsd-ui-auditor` at Step 6, and only when the repository has an extracted design contract
(`*.contract.json`). Kept out of the agent body so repositories without a `.pen` design file — most
of them — pay nothing for it.

## Design Sync Audit (post-execution)

**Run AFTER pillar scoring, BEFORE writing UI-REVIEW.md. Only runs if the repository
has an extracted design contract** — otherwise skip silently and note nothing:

```bash
# Shell-independent (no globstar): tracked/untracked files via git, else find
{ git ls-files -co --exclude-standard '*.contract.json' 2>/dev/null \
  || find . \( -name node_modules -o -name .git \) -prune -o -name '*.contract.json' -print 2>/dev/null; } \
  | grep . || echo "NO_DESIGN_CONTRACT"
```

Most repositories have none. An audit section that appears everywhere and says
"not applicable" trains the reader to skip the whole report.

**Why this is separate from the six pillars, not a seventh:** the pillars score
*taste* on a 1–4 scale — how the UI reads to a person. This is a *correspondence*
check with a binary answer per component: the code either cites a node that exists,
or it does not. Folding it into a 1–4 average would blur a fact into an opinion.

**Where the answers come from — the repository's own gate, not a re-implementation.**
Find the repo's design-sync report and gate commands in the contract, the project docs
or its scripts (`package.json`, CI config). One repo's convention, as an example only:

```bash
bun tools/ui-system/render-report.ts --json   # design + link + flow coverage, one shot
bun tools/checks/design-sync-gate.ts          # exit 0/1/2 — the CI verdict itself
```

If the repo has no such tooling, read the contract JSON directly and say the gate is
absent. Otherwise read the gate's output rather than re-deriving it. Two independent implementations of
the same rule drift, and the one in the report is the one nobody runs.

### What to report

**Drawn but not built / built but not drawn** (`pen:code-link`) — the question no
other audit asks. From the report's link warnings (`link.warnings` in the example above):

- components present in the contract with no code file citing their `nodeId` (the
  citing convention is the repo's — e.g. a `*.ui-meta.ts` beside the component)
- components in code whose `nodeId` is absent from the contract
- contract entries with `usedInDesign: 0` — drawn, applied nowhere

**Flow coverage by level** — from the report's flow list (e.g. `flows[]`). Report the
split, not just the percentage: coverage concentrated in `e2e` is a finding even at 100%,
because the E2E budget is small — take it from the project's testing docs (one repo, for
example, caps it at 8–15 scenarios per app, hard cap 20). At 2% flake per test, 40 E2E
tests produce a red run on healthy code 55% of the time — a "fully covered" suite that nobody trusts.

**Stale contract** — a failing freshness check (e.g. `contract:fresh`, or `sourceHash`
differing from the current `.pen`) means the report describes a design that
no longer exists. Say so before quoting any other number from it.

### Score impact

- A component the spec claims to implement, whose `nodeId` is absent from the
  contract: **BLOCKER** — the implementation references a design that is not there.
- Colour or spacing literals where the contract holds token references
  (`$space-3`, `$color-surface-base`): deduct 1 from **Color** or **Spacing**
  respectively (floor at 1) — this is design-system drift, which those pillars own.
- Missing states relative to the contract's `states[]`: **WARNING**, and name the
  states — a partial component looks finished until someone hits the missing arc.

### If clean

`Design sync: {N} components in contract, {M} linked to code, flow coverage {X}/{Y}
({e2e: Z} of budget {B})` — one line, in the review body. Numbers, not "verified".
