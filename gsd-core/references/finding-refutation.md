# Finding refutation — an adversarial pass over checker findings

Read by `/gsd:plan-phase` step 11b when `workflow.refute_findings` is on and
`gsd-plan-checker` returned `## ISSUES FOUND`.

## What it is for

A reviewer whose findings are never challenged drifts toward reporting more of
them: an unreported real issue is visibly a miss, while a reported non-issue
costs the reviewer nothing. The cost lands on the planner, which rewrites plans
to satisfy findings that were never true, and on whoever is watching a revision
loop turn without converging.

Adding a self-critique pass to the reviewer does not fix this and measurably
makes it worse — recall 27% → 33%, signal-to-noise 5.11 → 1.95 (arXiv
2603.11078). What raises precision is an adversarial pass by something that is
*not* the reviewer, with the burden of proof on the finding.

This is deliberately not a panel. Five critics on every plan is the shape the
workflows guidance warns about ("most traditional coding tasks do not need a
panel of 5 reviewers"); one refuter that must produce evidence is the cheap
version of the same idea.

## Dispatch

Spawn `gsd-finding-refuter` with the checker's findings verbatim, the phase
directory, and the same `agent_skills` block the checker received — it has to
read the same codebase with the same lenses to dispute anything about it.

```
Agent(subagent_type="gsd-finding-refuter", prompt=<<
<required_reading>
- {PHASE_DIR}/*-PLAN.md
- {context_path}
- {design_path}   (if present)
</required_reading>

${AGENT_SKILLS_CHECKER}

<findings>
{the checker's ## ISSUES FOUND block, verbatim — do not summarise or renumber}
</findings>
>>)
```

Nothing about the findings is edited on the way in. A summarised finding is a
different finding, and the refuter would then be disputing your paraphrase.

## Routing the result

The refuter returns `## REFUTATION COMPLETE` with one verdict per finding.

- **Every finding UPHELD** → proceed to the revision loop exactly as before.
  This is the common case and costs one subagent.
- **Some REFUTED** → drop those from the revision prompt, keep the rest, and
  show the user what was dropped and why:

  ```
  ◆ Refuted {M} of {N} checker findings — not sent to the planner:
    - {finding title}: {evidence}
  ```

  The evidence line is not decoration. A refutation nobody can check is the
  same defect as the false finding it removed, one level up.
- **Every finding REFUTED** → treat the checker round as passed and proceed to
  step 13, with the same display. Do not re-run the checker: it would return
  the same findings, and a loop between a reviewer and its refuter converges on
  whichever one is more stubborn rather than on the truth.
- **No `## REFUTATION COMPLETE` marker, or the verdict count does not match the
  finding count** → discard the refutation entirely and use the checker's
  findings unchanged. A partial refutation is worse than none: it silently
  drops whichever findings the refuter forgot to mention.

## The asymmetry, and why it is not symmetric

An upheld false positive costs one revision. A refuted true positive ships a
defect into execution. The refuter therefore defaults to UPHELD and may only
move a finding to REFUTED with a file, a line, or a command's output —
never with an argument about plausibility, cost, or severity.

That means the pass is expected to change nothing most of the time. A refuter
that regularly refutes half the findings is not saving work; it is either
disputing on argument (read its evidence lines — that is what they are for) or
the checker is misconfigured, and the second is worth knowing about.
