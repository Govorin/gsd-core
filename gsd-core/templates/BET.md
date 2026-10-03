---
# gsd-template: registry metadata about THIS TEMPLATE FILE.
# Not part of the artifact this template produces. Agents: ignore this block.
gsd-template:
  level: milestone
  lifecycle: experimental
  required: false
  author: human
  readers: []
---

# Milestone Bet Template

Template for `.planning/BET.md` — the falsifiable claim this milestone is testing, written before the roadmap and settled after it ships.

**Purpose:** Force one sentence of the form *"we believe X, and if we're wrong we will see Y"* before phases are scheduled, then check it against reality at milestone close. A milestone without a bet is a list of features that cannot fail — it can only be finished.

**Not to be confused with** `ROADMAP.md` (how the work is sequenced) or `REQUIREMENTS.md` (what must be true for the work to be done). Both answer *did we build it*. BET.md answers *should we have built it*. A milestone can score 100% on requirements and still lose its bet — that outcome is the single most valuable thing this file produces.

**One file, rewritten per milestone.** Not versioned copies. The settled bet moves into `MILESTONES.md` at close and this file is overwritten by the next `/gsd:new-milestone`. Keeping `v1.2-BET.md`, `v1.3-BET.md` accumulates files nobody reads; the history belongs in the milestone log.

**Downstream consumers:**
- `gsd-roadmapper` — reads `## The Bet` and `## Kill Criteria`; a phase that serves neither the bet nor a constraint is flagged as scope creep before it is scheduled
- `gsd-planner` — reads `## Evidence` to turn the "how we'll know" row into an instrumentation task when the signal is not yet measurable
- `/gsd:complete-milestone` — reads the whole file and writes `## Outcome`; this is the only place GSD asks whether the work was worth doing
- `/gsd:new-milestone` — reads the *previous* `## Outcome` (via MILESTONES.md) so the next bet inherits what was learned

---

## File Template

```markdown
---
milestone: v{X.Y}
created: {date}
status: open          # open | won | lost | inconclusive
settled: {date or "—"}
---

# Bet: v{X.Y} {Milestone Name}

## The Bet

**We believe** {specific claim about what will be true once this ships}
**for** {which segment from PRODUCT.md — name it}
**and we'll know we're right when** {the observable change, with a number or a clear binary}.

<!-- If the "know we're right when" clause is not falsifiable, the bet is a wish.
     Bad:  "...when the app feels faster."
     Good: "...when I stop reaching for the old CLI — zero invocations of it in a week." -->

## Why Now

{2-3 sentences. What changed to make this the next thing rather than something else?
A milestone that could equally have been done six months ago or six months from now
usually has no forcing function — say so if that's the case.}

## Kill Criteria

<!-- What would make you stop mid-milestone. Written BEFORE starting, when you are
     still honest. 1-3 rows. "Nothing would stop me" is a legitimate answer for a
     personal project — write that instead of inventing criteria you won't honour. -->

| If this happens | Then | Checkpoint |
|-----------------|------|------------|
| {observable failure} | {abandon / descope to X / rethink} | {after phase N} |

## Evidence

<!-- How the bet gets settled. Each row must be checkable without asking anyone. -->

| Question | How answered | Available after |
|----------|--------------|-----------------|
| {the question the bet turns on} | {query, log line, usage count, or "personal judgement — no instrumentation"} | {phase N / milestone close} |

**Instrumentation needed:** {what must be built to answer the above, or "none — already measurable"}

## Assumptions

<!-- What must hold for the bet to make sense. These are the things that, if false,
     make the milestone pointless even if every phase succeeds. -->

- {assumption} — {how it would show up as false}

---

## Outcome

<!-- EMPTY until /gsd:complete-milestone. Do not pre-fill. -->

**Status:** {won | lost | inconclusive}
**Settled:** {date}

**What actually happened:** {2-4 sentences — the evidence, not the narrative}

**The bet was wrong about:** {what you believed that turned out false, or "nothing — it held"}

**Changes the next milestone:** {concrete: a phase added, dropped, or reordered — or "no change"}

---
*Bet opened: {date} · Settled: {date}*
```

---

## Guidelines

**The Bet:**
- The three clauses are mandatory and load-bearing. `We believe` without `for {segment}` produces features with no user; without `we'll know when` it produces a claim that cannot lose.
- **Falsifiability is the whole point.** Ask: *what result would make me say this was a mistake?* If no result would, rewrite it. "Users will like the new editor" fails. "I will draft the weekly deck in the new editor instead of Google Docs, three weeks running" passes — it can be checked and it can fail.
- For personal projects the segment is `Me` and the evidence is usually behavioural: what you stop doing, what you stop reaching for. This is legitimate evidence and often better than a metric.
- One bet per milestone. Two bets means two milestones.

**Why Now:**
- The honest answer is sometimes "no forcing function, I just want to". Write that. It is useful information at close, when the milestone took three times longer than expected.

**Kill Criteria:**
- Written before starting, because that is the only moment you are not yet invested. Their value is entirely in being pre-committed.
- The `Checkpoint` column matters: a kill criterion with no checkpoint is never evaluated. Attach it to a phase boundary.
- Solo projects rarely honour kill criteria. Writing "nothing would stop me — this is a hobby milestone" is more honest and more useful than three criteria that will be ignored, and tells `gsd-roadmapper` not to schedule a checkpoint gate.

**Evidence:**
- `personal judgement — no instrumentation` is an acceptable row. What is not acceptable is claiming a metric exists when nothing writes it.
- **`Instrumentation needed` becomes real work.** `gsd-planner` reads it and adds a task; a bet that depends on a number nobody records will otherwise settle as `inconclusive` every time.

**Assumptions:**
- These are the silent killers. "The API I'm wrapping stays free", "I'll still care about this in two months", "the data I need is actually in the export". Each needs a visible failure mode.

**Outcome:**
- Filled only at close. Pre-filling turns the bet into a prediction you will unconsciously satisfy.
- **`lost` and `inconclusive` are successes for this file.** A bet log with five straight wins means the bets were too safe to be informative — the file is measuring nothing. Record losses plainly; they are the reason the file exists.
- `Changes the next milestone` must be concrete. "Be more careful about scope" changes nothing. "Drop the sync phase, it served an assumption that proved false" changes the roadmap.

---

## When to skip this file entirely

Skip when the milestone is maintenance, refactoring, or infrastructure with no user-facing claim — "migrate to the new build system" is not a bet, it is a chore, and forcing a hypothesis onto it produces theatre.

Write one when the milestone commits real time to something that might not be worth it. That is precisely when a solo developer, with nobody to challenge the plan, most needs a pre-committed statement of what failure looks like.

---

## Evolution

**During the milestone:** `## Outcome` stays empty. Kill criteria are evaluated at their checkpoints; if one triggers, that is a `/gsd:new-milestone` conversation, not a silent edit.

**At `/gsd:complete-milestone`:**
1. Fill `## Outcome` from evidence, not memory
2. Set `status` in frontmatter
3. Copy the settled bet + outcome into `MILESTONES.md`
4. Leave the file for `/gsd:new-milestone` to overwrite

**At `/gsd:new-milestone`:** Read the previous outcome first. A new bet that ignores the last one's `The bet was wrong about` line is how the same mistake gets made twice.

