---
# gsd-template: registry metadata about THIS TEMPLATE FILE.
# Not part of the artifact this template produces. Agents: ignore this block.
gsd-template:
  level: project
  lifecycle: experimental
  required: false
  author: human
  readers: []
---

# Product Context Template

Template for `.planning/PRODUCT.md` — who this is for, what "working" means as a number, and which constraints are non-negotiable.

**Purpose:** Carry the three business facts that change technical decisions — the user whose route must exist, the metric that makes a phase falsifiable, and the constraint that blocks a phase from shipping. Everything else about the business belongs in the user's head, not in a file.

**Not to be confused with** `PROJECT.md` — that answers *what this is* and *what we're building next* (identity + requirement ledger). PRODUCT.md answers *for whom*, *measured how*, and *forbidden what*. PROJECT.md's optional `## Business Context` block is the four-line summary; PRODUCT.md is where those lines get enough structure to be consumed by an agent. When both exist, PROJECT.md's block should be deleted and its `Strategy notes` line replaced with `See PRODUCT.md` — two copies of the revenue model will diverge with no reconciler.

**Not a business plan.** No market sizing, no TAM, no positioning statement, no go-to-market. Those change faster than they inform code and have no downstream consumer in GSD. If a section here is not read by a named agent below, it should not exist.

**Optional by default.** Personal projects with one user (the author) should create only `## Segments` with a single row and skip the rest, or skip the file entirely. The file earns its cost when there is a user who is *not* the author, a number that decides whether to keep building, or a legal constraint that can block a release.

**Downstream consumers:**
- `gsd-roadmapper` — reads `## Segments` to check every phase serves a named segment; reads `## Constraints` to refuse to schedule a phase whose blocking constraint is unresolved
- `gsd-ui-researcher` — reads the `Primary` segment row to fill UI-SPEC.md's copywriting and empty-state decisions; a segment with no route in the roadmap is a flagged gap
- `gsd-planner` — reads `## Constraints` rows scoped to the phase and lifts each into `must_haves.truths` as a negative truth (the thing that must NOT appear)
- `gsd-verifier` — verifies constraint truths like any other truth; a `blocking` constraint that no phase addressed fails verification rather than passing silently
- `/gsd:complete-milestone` — reads `## Signals` and asks the one question that matters: did the number move, and does that change the next milestone

---

## File Template

```markdown
---
created: {date}
updated: {date}
commercial: {true | false}     # false = personal project; skips Signals/Constraints review at milestone close
---

# Product Context: {Project Name}

## Segments

<!-- Who uses this. One row per distinct user with a distinct job. Most projects have ONE.
     "Me" is a legitimate and common segment — write it rather than inventing a fictional user. -->

| Segment | Job to be done | Entry route | Priority |
|---------|----------------|-------------|----------|
| {Me / role name} | {what they are trying to accomplish, in their words} | {the screen/command they start from, or "not built"} | Primary |
| {Second role} | {their job} | {route} | Secondary |

**Not for:** {who this explicitly does not serve — prevents feature requests from imagined users}

## Signals

<!-- The numbers that tell you to keep going or stop. 1-3 rows. Each must be observable
     without asking anyone. A signal you cannot query today gets "not instrumented" as
     Current — that is honest and useful; a made-up baseline is neither. -->

| Signal | Current | Target | How measured | Decides |
|--------|---------|--------|--------------|---------|
| {name} | {value or "not instrumented"} | {value + by when} | {query, log, or manual count — be specific} | {what you do differently if it misses} |

**Anti-signal:** {the number that looks like success but isn't — e.g. "sessions started" when what matters is sessions finished}

## Constraints

<!-- Non-negotiables that can block a release: legal, platform policy, contractual, ethical.
     ONLY things that would stop a ship. Preferences and quality bars are not constraints. -->

| Constraint | Source | Scope | Severity | Resolution |
|------------|--------|-------|----------|------------|
| {what is forbidden or required} | {law, store policy, contract — name it} | {phase N / all UI / payments only} | blocking \| advisory | {what satisfying it looks like, concretely} |

## Open Questions

<!-- Business unknowns that will change technical decisions once answered.
     Delete a row when answered — this list should shrink. -->

- {question} — blocks: {what decision waits on it}

---
*Last updated: {date} after {trigger}*
```

---

## Guidelines

**Segments:**
- One row per user with a *different job*, not a different demographic. Two personas who do the same thing are one segment.
- `Me` is the correct answer for personal projects. Writing a fictional "power user" persona for a tool you built for yourself produces requirements nobody asked for.
- **Entry route is the load-bearing column.** It names the screen, command, or endpoint where this segment starts. A segment whose Entry route is "not built" while its Priority is `Primary` is a roadmap gap — `gsd-roadmapper` surfaces this. This column is what makes a segment reach code rather than decorating a document.
- `Not for` prevents scope creep more reliably than the segment rows themselves.

**Signals:**
- Must be observable *by the author, today or after a named instrumentation task*. "User satisfaction" is not a signal; "decks reviewed per week, from the reviews table" is.
- **The `Decides` column is what separates a signal from a vanity metric.** If the answer is "nothing, I'd keep building anyway", delete the row — it is not a signal, it is a statistic.
- `Current: not instrumented` is a valid and common state. It tells `gsd-roadmapper` that measuring is itself unscheduled work.
- Cap at 3. A dashboard of nine numbers decides nothing.

**Constraints:**
- The bar is: *would this stop a release?* Alcohol advertising rules, app-store policy, GDPR/data-residency, a licence that forbids commercial use. Not "should be fast" or "should look good".
- **Severity `blocking` is a hard gate.** `gsd-planner` lifts it into the phase's `must_haves` as a negative truth ("no alcohol promotion is shown to unverified-age users"), and `gsd-verifier` checks it like any other truth. This is the mechanism by which a legal fact becomes a failing test rather than a remembered worry.
- `advisory` constraints are recorded but do not gate — they inform planning without blocking.
- Scope must be narrow enough to attach to a phase. A constraint scoped to "the whole product" is unverifiable and will be skipped.

**Open Questions:**
- Only questions whose answer changes a *technical* decision. "What should pricing be" belongs here only if a phase is blocked on knowing.
- If a question sits unanswered across two milestones, it was never blocking — delete it.

---

## When to skip this file entirely

Create PRODUCT.md only if at least one is true:

- There is a user who is not the author
- There is a number that would make you stop building
- There is a legal or platform constraint that could block a release

If none hold, the four-line `## Business Context` block in PROJECT.md is sufficient and this file is ceremony. A personal habit tracker with one user, no metrics, and no compliance surface should not have a PRODUCT.md — it will be written once and never read.

---

## Evolution

**During phases:** Do not edit. Segments and constraints are inputs to planning; changing them mid-phase invalidates plans already written.

**At milestone close (`/gsd:complete-milestone`), when `commercial: true`:**
1. Signals — did the numbers move? A signal that missed its target and did not change the next milestone's scope was not a real signal; delete or fix it.
2. Constraints — did any `blocking` row get resolved? Move resolved rows out; add rows discovered during the milestone.
3. Segments — did a Secondary segment produce zero usage? Demote or remove it.
4. Open Questions — delete answered rows.

**When `commercial: false`:** milestone close skips steps 1-3 and only prunes Open Questions. Personal projects should not be made to review a revenue model they do not have.

