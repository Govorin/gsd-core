<!-- gsd:derived source=scripts/gen-state-machines.cjs — regenerated, do not hand-edit -->

# State machines

Lifecycle diagrams of the closed status vocabularies, generated from the code constants that own
them. Regenerate with `node scripts/gen-state-machines.cjs --write`; `--check` (part of
`npm run lint:generated-sync`) fails when a vocabulary changes without regeneration.

## Plan status

Source: `PLAN_STATUSES` and `PLAN_STATUS_TRANSITIONS` in `src/plan-status.cts`. The code defines the
transitions as a table, so they are drawn. `(no status)` is the table's `none` origin — a plan whose
frontmatter declares no `status` (not started, which is valid).

```mermaid
stateDiagram-v2
  direction LR
  state "(no status)" as none
  state "in_progress" as in_progress
  state "done" as done_
  state "blocked" as blocked
  state "superseded" as superseded
  none --> in_progress
  none --> superseded
  in_progress --> done_
  in_progress --> blocked
  in_progress --> superseded
  done_ --> superseded
  blocked --> in_progress
  blocked --> superseded
  note right of superseded : terminal#58; no transitions out
```

| From | Allowed next |
|------|--------------|
| (no status) | `in_progress`, `superseded` |
| `in_progress` | `done`, `blocked`, `superseded` |
| `done` | `superseded` |
| `blocked` | `in_progress`, `superseded` |
| `superseded` | — |

## VerificationStatus

Source: `VERIFICATION_STATUS`, `VERIFIER_STATUSES` and `VERIFICATION_ROUTES` in `src/verification.cts`.
**The code defines no transitions between these values** — a status is read from a report (writer
set) or derived by the reader (reader-only) — so only the states are drawn, grouped by who may produce
them. A note is the routing table's next command, not a transition.

```mermaid
stateDiagram-v2
  state "writer set — a report may carry it" as writer_set {
    state "passed" as passed
    state "gaps_found" as gaps_found
    state "human_needed" as human_needed
    note right of gaps_found : route#58; plan-phase #45;#45;gaps
    note right of human_needed : route#58; verify-work
  }
  state "reader-only — derived by the reader, never written" as reader_only {
    state "stale" as stale
    state "missing" as missing
    state "unparseable" as unparseable
    state "phase_dir_not_found" as phase_dir_not_found
    note right of stale : route#58; execute-phase
    note right of missing : route#58; execute-phase
  }
```

| Value | Produced by | Route (`VERIFICATION_ROUTES`) |
|-------|-------------|-------------------------------|
| `passed` | writer set | — |
| `gaps_found` | writer set | `plan-phase --gaps` |
| `human_needed` | writer set | `verify-work` |
| `stale` | reader-only | `execute-phase` |
| `missing` | reader-only | `execute-phase` |
| `unparseable` | reader-only | — |
| `phase_dir_not_found` | reader-only | — |

## PhaseStatus

Source: `PHASE_STATUS` in `src/phase-status.cts`, in declaration order. **The code defines no
transitions**: a phase status is not stored, it is computed from facts (plan/summary counts, the
completion verdict, the verification status) by `phaseStatusFromFacts`, and nothing in the code
constrains how it changes from one reading to the next. Only the states are drawn.

```mermaid
stateDiagram-v2
  direction LR
  state "NOT_STARTED" as NOT_STARTED
  state "PLANNED" as PLANNED
  state "IN_PROGRESS" as IN_PROGRESS
  state "EXECUTED" as EXECUTED
  state "NEEDS_REVIEW" as NEEDS_REVIEW
  state "COMPLETE" as COMPLETE
```

| Value |
|-------|
| `NOT_STARTED` |
| `PLANNED` |
| `IN_PROGRESS` |
| `EXECUTED` |
| `NEEDS_REVIEW` |
| `COMPLETE` |
