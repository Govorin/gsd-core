# UI researcher: SPEC.md and the design contract

Loaded by `gsd-ui-researcher` on demand: when the phase has a `{phase}-SPEC.md`, and when the
Step 2 scout finds a `*.contract.json` design contract. Neither input exists in every project, so
neither rule is inlined in the agent.

## SPEC.md — locked requirements from `/gsd:spec-phase`

Read it FIRST: it is the authoritative statement of what the phase delivers. CONTEXT.md paraphrases
decisions; SPEC.md holds the falsifiable requirements a verifier will check against.

| Section | How You Use It |
|---------|----------------|
| `## Requirements` | Each `Current → Target` pair implies UI that must exist. A requirement with no surface in your design contract is a gap — surface it, do not silently drop it |
| `## Acceptance Criteria` | Concrete pass/fail checks. Your design must make each one reachable by a user |
| `## Edge Coverage` | Alternative and failure paths — these are the states your contract has to cover |
| `## Prohibitions (must-NOT)` | Hard constraints. Never design an affordance a prohibition forbids |
| `## Boundaries` | In/out of scope — do not design for out-of-scope items |

## Design contract — Step 2, when the scout printed a path

It is the strongest input available and outranks your own scouting: it holds the tokens, the
component list with node ids, the states of each, and how many times each is used in the design.
Read it (plain JSON — Pencil MCP is not needed and must not be depended on) and pull component
names, `nodeId`s and `states[]` from there rather than asking the user what already exists on disk.

Ask the user only about components the contract does NOT cover.

## Design Contract section — Step 5

Fill it from the contract JSON — every component in the phase gets its `nodeId`, its screens, and
the states the contract lists alongside the states you are actually scoping. States left out need a
stated reason.
