**If `workflow.spec_phase` is true and no `*-SPEC.md` exists in `PHASE_DIR`:**

```
Skill(skill="gsd-spec-phase", args="${PHASE_NUM} --auto")
```

`spec-phase` is reachable from no route in this workflow or in `next.md`, so unless someone types it by hand, SPEC.md is never written — and every downstream consumer that reads it silently gets nothing. It locks *what* the phase delivers as falsifiable criteria before discuss argues about *how*, which is the difference between a verifier checking "book list works" and checking "`GET /books?cursor=X` returns 20 items and `nextCursor`".

`--auto` keeps it non-interactive: the ambiguity score decides whether questions are needed, and unattended runs take the recommended answer. If it produces no SPEC.md, do not block — continue to discuss. A phase can be well-specified by its roadmap entry alone, and forcing an interview onto a migration or a config change buys nothing.
