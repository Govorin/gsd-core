---
type: Fixed
pr: 0
---
complete-milestone in yolo mode no longer jumps past the `milestone:pre` hooks (the window review never ran). discuss-phase: `--auto` on an existing CONTEXT.md now updates it through the full path — `load_prior_context`, `cross_reference_todos`, `scout_codebase` and the `discuss:pre` hooks — instead of jumping to `analyze_phase`; a resumed checkpoint (interactive or `--auto`) runs the same steps and then goes to `present_gray_areas` with the remaining areas. plan-phase: reusing, skipping or finishing research, and skipping the validation strategy, no longer jump past the security threat model gate and the `plan:pre` dispatch (§5.55, §5.6); "Continue without context" no longer skips §4.5–§4.6 (the context-drift `plan:pre` gate); a clean requirements-coverage check no longer skips §13a–§13e (the decision-coverage gate, STATE/ROADMAP updates, the plan commit and the `plan:post` dispatch).
