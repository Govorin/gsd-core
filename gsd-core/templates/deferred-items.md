---
# gsd-template: registry metadata about THIS TEMPLATE FILE.
# Not part of the artifact this template produces. Agents: ignore this block.
gsd-template:
  level: phase
  lifecycle: active
  required: false
  author: agent
  readers: [gsd-executor, gsd-audit-uat]
---

# Deferred Items Template

Template for `.planning/phases/XX-name/deferred-items.md` — defects and debt an executor found but deliberately did not fix.

**Purpose:** an executor working a phase constantly trips over things that are wrong but not its business — a pre-existing type error, a build target that was already broken, a dependency clash. Fixing them silently inflates the phase and hides the cause; ignoring them loses the finding entirely, because the only place it was ever written down is a terminal that scrolled away.

**Why this file exists at all:** it was invented in practice before it was specified. It is the third most common phase artifact in real trees, ahead of RESEARCH.md, and until now had no template, no registry entry and no defined shape — so every one of them is a slightly different document, and `audit-uat`, which reads them, reads prose.

**Downstream consumers:**
- `gsd-audit-uat` — collects deferred items across phases at milestone close, which is the moment they stop being someone's future problem
- `gsd-planner` — a deferred item naming a file the next phase touches is a known trap, not a surprise
- `broken-windows` — an item that keeps reappearing is a window, not a deferral

---

## File Template

```markdown
---
phase: XX-name
deferred_open: 0      # items still unresolved; audit-uat reads this, so it must be a number
created: YYYY-MM-DD
---

# Deferred Items — Phase XX name

Findings from execution that are **out of scope for this phase**, recorded so they survive the session that found them.

## {Short title of the finding}

**What:** {the defect, concretely — the error text, the failing command, the wrong behaviour}

**Why it is not this phase's work:** {pre-existing on HEAD before this phase / different domain / needs its own plan}. State the evidence — "reproduces on HEAD" is a claim someone can check; "unrelated" is not.

**Blast radius:** {what it does and does not block. A finding that blocks nothing today is worth less attention than one blocking the next phase — say which.}

**Recommended action:** {the smallest thing that would fix it, and where it belongs — a chore commit, a follow-up phase, a backlog entry}

**Status:** deferred | fixed in phase {N} | promoted to backlog | no longer reproduces

---

## {Next finding}

...
```

---

## Guidelines

**One finding per section.** Two defects under one heading get resolved as one and the smaller of them quietly survives.

**Record evidence, not judgement.** "Pre-existing" is the load-bearing claim in the whole file — everything downstream trusts it. Write what proves it: the command, the error, the fact that it reproduces before the phase's first commit. An executor that defers its own breakage while labelling it pre-existing has laundered a regression into documentation.

**`deferred_open` is a count, not a mood.** It is the number of sections whose Status is still `deferred`. Keep it accurate; a gate can compare a number, and no gate can compare a paragraph.

**Deferring is legitimate; deferring silently is not.** The scope boundary exists for good reason — an executor that fixes everything it notices produces a phase nobody can review. This file is what makes the boundary honest rather than convenient.

**When the same item appears in three phases, it is not deferred — it is accepted.** Promote it to the backlog or fix it. A finding that has been re-deferred repeatedly is being decided by inertia.
