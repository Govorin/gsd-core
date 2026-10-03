**If `gaps_found`:**

Read gap score/items from VERIFICATION.md. Display:
```
⚠ Phase ${PHASE_NUM}: ${PHASE_NAME} — Gaps Found
Score: {N}/{M} must-haves verified
```

Ask how to proceed: `Run gap closure` / `Continue without fixing` / `Stop autonomous mode`.

On **"Run gap closure"**: one gap-closure attempt:

```
Skill(skill="gsd-plan-phase", args="${PHASE_NUM} --gaps")
```

Re-run `init phase-op ${PHASE_NUM}`; if `has_plans` is false, handle_blocker: "Gap closure planning for phase ${PHASE_NUM} did not produce plans."

Re-execute:
```
Skill(skill="gsd-execute-phase", args="${PHASE_NUM} --no-transition")
```

Re-read verification status:
```bash
VERIFY_STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status 2>/dev/null || true)
```

If `passed` or `human_needed`: route normally.

If `stale`: handle_blocker: "Stale verification for phase ${PHASE_NUM}."

If still `gaps_found` after this retry, display `Gaps persist after closure attempt.` and ask `Continue anyway` / `Stop autonomous mode`.

On "Continue anyway": record `verification_deferred_gaps` using the table below, display `Phase ${PHASE_NUM} ⏭ verification_deferred_gaps — resume with /gsd:plan-phase ${PHASE_NUM} --gaps`, then handle_blocker: "Verification gaps deferred for phase ${PHASE_NUM}."
On "Stop autonomous mode": Go to handle_blocker.

This limits gap closure to 1 retry.

On **"Continue without fixing"**: record an explicit deferred state and stop autonomous mode:

```markdown
## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| ${PHASE_NUM} | verification_deferred_gaps | /gsd:plan-phase ${PHASE_NUM} --gaps |
```

Append/update this STATE.md section, display `Phase ${PHASE_NUM} ⏭ verification_deferred_gaps — resume with /gsd:plan-phase ${PHASE_NUM} --gaps`, then handle_blocker: "Verification gaps deferred for phase ${PHASE_NUM}."

On **"Stop autonomous mode"**: Go to handle_blocker with "User stopped — gaps remain in phase ${PHASE_NUM}".
