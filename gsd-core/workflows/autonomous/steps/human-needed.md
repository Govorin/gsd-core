**If `human_needed`:**

Read `human_verification` items. In text mode (`--text` or init `text_mode=true`), replace AskUserQuestion with a plain-text numbered list. Otherwise ask whether to validate now or continue without validation. If validating now, present items, then ask `Validation result?` with `All good — continue` / `Found issues`.

On "All good — continue": set VERIFICATION frontmatter `status: passed`, display `Phase ${PHASE_NUM} ✅ Human validation passed`, run `@~/.claude/gsd-core/workflows/transition.md`, then iterate.

On "Found issues": Go to handle_blocker with the user's reported issues as the description.

On **"Continue without validation"**: record an explicit deferred state and stop autonomous mode:

```markdown
## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| ${PHASE_NUM} | verification_deferred_human | /gsd:verify-work ${PHASE_NUM} |
```

Append/update this STATE.md section, display `Phase ${PHASE_NUM} ⏭ verification_deferred_human — resume with /gsd:verify-work ${PHASE_NUM}`, then handle_blocker: "Human verification deferred for phase ${PHASE_NUM}."
