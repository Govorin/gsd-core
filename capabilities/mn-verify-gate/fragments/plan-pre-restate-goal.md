<restate_goal>
**Restate the phase goal in your own words before any task exists** (`workflow.restate_goal`, mn-verify-gate).

A wrong reading of the goal is cheapest to catch before code: every task built on it inherits it, and the verifier finds it only after execution. So, after reading ROADMAP, CONTEXT.md and SPEC.md and before decomposing, write three lines and carry them at the end of every plan's `<objective>` — they extend the objective, they are not a second one:

```
Restated: <the phase goal in your words — not copied — and the part this plan delivers>
Not doing: <what the phase deliberately leaves out, each item with its source>
Sources: <where each claim came from: ROADMAP Phase N goal · success criterion 2 · CONTEXT D-03 · SPEC AC-1>
```

If you cannot restate the goal without copying it, or two sources disagree about what it includes, settle that first from the sources, or name the disagreement in `Not doing:` with both sources so the checker sees it. The plan-checker compares these lines with the goal (Dimension 1b): a restatement that contradicts the goal, or a `Not doing:` that drops something a requirement or a locked decision needs, is a blocker.
</restate_goal>
