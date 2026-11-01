# ADR-5212: Requirements are reviewed at roadmap:pre, and a surviving critical finding holds the roadmap

- **Status:** Accepted — fork-local (mn fork, 2026-11-01); implemented in `capabilities/mn-requirements-review/`, `src/requirements-review.cts`, `src/requirements-review-command-router.cts`, `src/gate-mn-requirements-review.cts`, `agents/gsd-requirements-reviewer.md`, the `requirements` mode of `agents/gsd-finding-refuter.md`, `gsd-core/workflows/requirements-review.md`, and the `roadmap:pre` call sites of `gsd-core/workflows/new-milestone.md` (step 9.5) and `new-project.md`.
- **Date:** 2026-11-01
- **Issue:** none — the fork files no upstream issues; the number follows ADR-5211. Evidence: `.plans/gsd-usage-review-2026-10/` in the main checkout (item N1, finding GYL-4).
- **Builds on:** [ADR-857](857-capability-system.md) (loop points; its 2026-11-01 amendment adds `roadmap:pre`), [ADR-5208](5208-window-review-unit.md) (lenses in fresh contexts, never merged; a refuter before reporting), [ADR-5057](5057-one-owner-per-workflow-verdict.md) (a gate returns a verdict; could-not-look is not a pass).
- **Amends / supersedes:** amends ADR-857 (one loop point).

## Context

In one project, all three milestones of October 2026 had their requirements reviewed by hand, after the requirements were written and before planning: four general-purpose agents named "migrations and data / compatibility / security / completeness", or "reqs vs codebase / vs specs / quality". Every time the review found critical defects that would otherwise have reached the plans. Two examples: migrations from parallel branches that would silently not apply, and a newly closed gate that would break every already-released client. GSD had no such step. new-milestone goes requirements → commit → roadmapper, and the only loop point there, `roadmap:post`, fires after the roadmap is approved — too late to change requirements cheaply.

## Decision

1. **A loop point `roadmap:pre`.** ADR-857's 2026-10-25 amendment left this name open. The point belongs to loop-host step `roadmap`, is hosted by new-milestone (step 9.5) and by new-project as an auxiliary host, and fires once REQUIREMENTS.md is committed and before the roadmapper runs. That is the same position `plan:pre` has after research and before the planner. It dispatches steps and gates. A blocking gate that blocks holds the roadmap: interactively the host offers "Revise requirements", which goes back to scoping, commits, and runs the point again, or "Stop". In auto mode the host stops; it never waits for a person. The name is not `requirements:post`: requirements are not a loop-host step, and two names for one position would split capabilities between them.

2. **A fork capability `mn-requirements-review`** with one step and one gate at `roadmap:pre`, both under `workflow.requirements_review`:
   - The **step** is the skill `/gsd:requirements-review`. `requirements-review prepare` records the run: the requirements' digest and REQ-IDs, plus one report path per lens, and it removes an earlier run's reports. Then one fresh `gsd-requirements-reviewer` runs per lens, in parallel. The lenses are `data` (data and migrations), `compat` (client compatibility), `security` and `testability`, configurable through `workflow.requirements_review_lenses`. Next, `gsd-finding-refuter` runs in its new `requirements` mode. Finally, `requirements-review compose` writes `REQUIREMENTS-REVIEW.md`. Interactively the skill offers to accept a blocking finding as a known risk, with the user's reason (`requirements-review accept`). In auto mode it asks nothing.
   - The **gate**, `check mn-requirements-review` (registered in the fork's `gate-mn-dispatch`), is deterministic. It blocks in these cases:
     - a critical finding the refuter did not refute (upheld, or unverified because no refutation ran) and nobody accepted for this milestone;
     - a lens that wrote no report;
     - no review, or a review of other requirements (an EOL-normalised digest mismatch).

     The first is a finding. The others are delivered `unresolvable` blocks that name `/gsd:requirements-review`. An unreadable file is outcome `unreadable` (exit 69, `onError: halt`).

3. **One new agent, not the window review's lenses.** `gsd-spec-reviewer` and `gsd-standards-reviewer` take a window of commits (`base`, `tip`, pre-pass) and cite hunks. Requirements review runs before there is code to diff, and it judges the spec against the codebase — the opposite direction from the spec lens. Their contract does not fit. `gsd-requirements-reviewer` reuses their shape: one `lens` parameter, one report per lens, cite or drop, `CR-`/`WR-`/`IN-`. The refuter gains a mode rather than a sibling agent. Composition, refutation and the fingerprint follow ADR-5208's window review: lenses keep their own sections, IDs are renumbered, and a finding's identity is lens + requirement + normalised title.

4. **What an acceptance binds to, and how a held roadmap moves again.** An acceptance binds to the lens, the requirement IDs the finding names and the text of each requirement as the run read it — not to the title, which a fresh agent words differently on every run, and not to the renumbered ID. It survives a re-run over the same requirement and is released when that requirement's text changes. A blocked host offers "Review again" besides "Revise requirements" and "Stop": the gate's payload names the lenses to re-run (`rerun` — the blocking lenses and those that wrote no report; all of them when the review is stale), and `prepare --lens` over unchanged requirements re-runs only those, keeping the other reports. A stopped or auto-stopped roadmap resumes without asking again: `/gsd-new-milestone --from-roadmap` (step 7, then step 9.5), and `/gsd-new-project`, whose interrupted-bootstrap resume now re-enters at the requirements hooks.

5. **A lens with nothing to check is clean.** Nothing released → compat clean; no persisted schema → data clean; a high-level v1 requirement is never a critical testability finding — critical is reserved for contradiction or a requirement no environment could show. Without these rules a greenfield `/gsd-new-project --auto` would stop on noise. The refuter may refute a "cannot be verified" claim by naming the observable outcome.

6. **On by default.** The review runs once per milestone, not per phase: four lens agents and one refuter, about 5–15M tokens in the review that motivated it. Three of three hand-run reviews caught critical defects at the point where a fix is a sentence in REQUIREMENTS.md, not a re-plan. `workflow.requirements_review: false` removes both the step and the gate.

## Consequences

- A milestone whose requirements carry an unaccepted critical finding gets no roadmap until the requirements change or a person accepts the risk. The acceptance and its reason are recorded in `requirements-review/ACCEPTED.json` and shown under the finding; two findings of one lens about one requirement share one acceptance.
- A lens agent that fails holds the roadmap, as the gate's message says. A lens that never read the requirements is not a clean lens. The way out is to run the review again or narrow the lenses.
- The refuter ships with `mn-verify-gate`, and capabilities own their agents exclusively. Without that capability every finding stays `unverified`, and an unverified critical finding still blocks.
- REQUIREMENTS-REVIEW.md lives beside REQUIREMENTS.md. The roadmapper does not read it yet: warnings reach the roadmap only through the requirements they cause to be revised.

## Alternatives rejected

- **Inline review prose in new-milestone.md.** It would bypass the capability gate and its `when` key, and it would grow a byte-budgeted workflow. Logic belongs in `gsd-tools` and the capability.
- **A step without a gate.** A step is advisory by construction (`loop-hook-dispatch.md`), so it cannot hold the roadmap.
- **Accepting from the host's question.** The host would have to know the capability's command. Acceptance lives in the skill, which owns the review; the host only revises or stops.
