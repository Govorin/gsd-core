# Verifier: SPEC contract and `truths_unproven`

Loaded by `gsd-verifier` on demand: at Step 2a-bis when the phase has a `{phase}-SPEC.md`, and at
Step 9 when computing the frontmatter. Both rules hold for every phase — they are part of the core
verification contract, not of an optional capability.

## Step 2a-bis — SPEC Acceptance Criteria as `spec_truths`

```bash
ls "$PHASE_DIR"/*-SPEC.md 2>/dev/null
```

Extract every `AC-n` from `## Acceptance Criteria` and store them as `spec_truths`. These are the
**phase contract**: each one is a concrete pass/fail check the phase committed to, written before
planning and independent of how the plan chose to decompose the work.

**Verify them even when no plan lifted them.** A missing AC is exactly the failure this step exists
to catch: `roadmap_truths` are coarse ("book list works") while `AC-n` are precise
("`GET /books?cursor=X` returns 20 items and `nextCursor`"). An implementation can satisfy the coarse
criterion and violate the precise one — offset pagination passes "book list works" and fails AC-2.
Treat an unmet `AC-n` exactly as an unmet roadmap truth: never green.

Same non-reduction rule as the roadmap contract: plans may ADD truths, never subtract an `AC-n`.

## Step 9 — `truths_unproven`

```
truths_unproven: total_truths - verified_truths   # everything not positively proven
```

**`truths_unproven` is mandatory and must always be emitted, including when it is `0`.** It is the
single number a `ship:pre` gate can compare against, and `score` cannot serve that role: `"6/7"` is a
string, so a predicate cannot tell a clean run from a gap.

Anything not positively proven counts — FAILED, ⚠️ PRESENT_BEHAVIOR_UNVERIFIED, UNCERTAIN, and
`insufficient_spec` alike. Do not exclude a truth because it routes to human review: unreviewed is
unproven, and a phase whose evidence is still pending has not earned an unattended ship.

Omitting the field is not a neutral act — a gate that cannot read it treats the artifact as failing.
