# Discuss Mode: Assumptions vs Interview

GSD Core's discuss-phase offers two modes for gathering implementation context before planning begins. Understanding when to use each helps you move from question-answering to a confirmed `CONTEXT.md` with less back-and-forth.

For step-by-step instructions on running either mode, see the [Discuss a phase how-to](how-to/discuss-a-phase.md).

## Modes

### `discuss` (default)

The original interview-style flow. Claude identifies grey areas in the phase, presents them for selection, then asks approximately four questions per area. Good for:

- Early phases where the codebase is new
- Phases where the user has strong opinions they want to express proactively
- Users who prefer guided, conversational context gathering

### `assumptions`

A codebase-first flow. Claude deeply analyses the codebase via a subagent (reading 5–15 relevant files), forms assumptions with evidence, and presents them for confirmation or correction. Good for:

- Established codebases with clear patterns
- Users who find the interview questions obvious
- Faster context gathering (~2–4 interactions vs ~15–20)

### `grill`

A decision-tree flow (`--grill` for one run, or the config value for every run). Claude builds the phase's decisions as a dependency tree and asks one question per round: the earliest open decision that other decisions depend on, each with a recommended answer and its rationale. Facts the code or docs already answer are looked up by a subagent and never asked. `gsd-tools discuss tree` picks each next question from the tree, so the order is computed, not improvised. Good for:

- Phases whose decisions depend on one another (an early answer changes the later questions)
- Stress-testing a plan before it is written
- Users who want a recommendation with every question and to accept it in one keystroke

Each decision in CONTEXT.md records who closed it — `**Decided by:** user`, `recommendation` (the user accepted it) or `codebase` (a fact, tagged `[informational]`) — and what it depends on (`**Depends on:** D-01`). Decisions the session did not reach land under "Claude's Discretion" with their recommendation. `workflow.max_discuss_passes` caps the depth of the tree put to the user: a pass is one level, so the default `3` asks the roots, their dependents, and one level more. DISCUSSION-LOG.md ends with the tree drawn as mermaid, regenerated from CONTEXT.md by `gsd-tools discuss tree --file <CONTEXT.md> --raw`.

## Configuration

```bash
# Enable assumptions mode
node gsd-tools.cjs config-set workflow.discuss_mode assumptions

# Enable grill mode
node gsd-tools.cjs config-set workflow.discuss_mode grill

# Switch back to interview mode
node gsd-tools.cjs config-set workflow.discuss_mode discuss
```

The setting is per-project (stored in `.planning/config.json`). See the [CONTEXT.md schema](reference/context-md.md) for the full structure of the file both modes produce.

## How Assumptions Mode Works

1. **Init** — Same as discuss mode (load prior context, scout codebase, check todos)
2. **Deep analysis** — Explore subagent reads 5–15 codebase files related to the phase
3. **Surface assumptions** — Each assumption includes:
   - What Claude would do and why (citing file paths)
   - What goes wrong if the assumption is incorrect
   - Confidence level (Confident / Likely / Unclear)
4. **Confirm or correct** — User reviews assumptions, selects any that need changing
5. **Write CONTEXT.md** — Identical output format to discuss mode

## Flag Compatibility

| Flag | `discuss` mode | `assumptions` mode | `grill` mode |
|------|----------------|-------------------|--------------|
| `--auto` | Auto-selects recommended answers | Skips confirm gate, auto-resolves Unclear items | Takes precedence — grill is not used |
| `--batch` | Groups questions in batches | N/A (corrections already batched) | Ignored (one question per round) |
| `--text` | Plain-text questions (remote sessions) | Plain-text questions (remote sessions) | Plain-text questions (remote sessions) |
| `--analyze` | Shows trade-off tables per question | N/A (assumptions include evidence) | Shows a trade-off table above each question |

## Output

All modes produce a `CONTEXT.md` with the same six sections (grill adds the `Decided by` / `Depends on` fields to each decision):

- `<domain>` — Phase boundary
- `<decisions>` — Locked implementation decisions
- `<canonical_refs>` — Specs/docs downstream agents must read
- `<code_context>` — Reusable assets, patterns, integration points
- `<specifics>` — User references and preferences
- `<deferred>` — Ideas noted for future phases

Downstream agents (researcher, planner, checker) consume this file identically regardless of which mode produced it. See the [CONTEXT.md schema](reference/context-md.md) for the full field reference.

## Related

- [Discuss a phase](how-to/discuss-a-phase.md) — step-by-step how-to for running `/gsd-discuss-phase` in either mode.
- [CONTEXT.md schema](reference/context-md.md) — full field reference for the file both modes produce.
- [The phase loop](explanation/the-phase-loop.md) — how discuss fits into the broader discuss → plan → execute → verify → ship cycle.
- [docs index](README.md) — full table of contents for GSD Core documentation.
