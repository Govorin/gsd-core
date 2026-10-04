**If `PHASES_RUN >= MAX_PHASES`:** stop here — a run that ends because it chose to is reviewable; one that ends because the context filled is not. Print:

```
 GSD ► AUTONOMOUS ▸ PHASE BUDGET REACHED

 Ran ${PHASES_RUN} phase(s) — the limit set by --max-phases / workflow.autonomous_max_phases.
 Work so far is committed and verified; nothing is half-applied.

 Resume with: /gsd:autonomous --from ${next_phase}${TO_PHASE ? " --to " + TO_PHASE : ""}
```

Then proceed to the lifecycle step as a partial completion (it skips audit/complete/cleanup), and exit cleanly.

**Otherwise:** continue the iterate step.
