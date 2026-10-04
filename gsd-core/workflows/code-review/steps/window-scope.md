<step name="window_scope">
A window review (ADR-5208) reviews the work that landed on `until` since `since` — a week, the tip of the previous window review (`--since last`), a milestone's range — instead of one phase. One fresh agent per lens, in parallel; lenses never see each other's findings and are never merged or re-ranked. A deterministic pre-pass measures what one change at a time cannot show and every lens gets it as data, together with the explicit list of what it checked and the instruction that everything else is the lens's to find.

Inputs from `initialize`: `INVOCATION_JSON`, `FIX_FLAG`, `FIX_ALL`, `FIX_AUTO`, `DEPTH_OVERRIDE`, `AGENT_SKILLS_REVIEWER`, `REVIEWER_MODEL`.

**1. Pre-pass.** `review window-prepass` resolves the window, measures it, writes `prepass.json` and names every lens report path. No `--lens` → `code_review.window_lenses`; correctness batches → `code_review.window_max_files_per_batch`.

```bash
W_FIELD() { printf '%s' "$INVOCATION_JSON" | node -e "const r = JSON.parse(require('fs').readFileSync(0, 'utf-8')); const v = r[process.argv[1]]; process.stdout.write(Array.isArray(v) ? v.join(',') : String(v))" "$1"; }
W_SINCE=$(W_FIELD since)
W_UNTIL=$(W_FIELD until)
W_LENSES=$(W_FIELD lenses)
PREPASS_JSON=$(gsd_run review window-prepass --since "$W_SINCE" --until "$W_UNTIL" ${W_LENSES:+--lens "$W_LENSES"})
PREPASS_EXIT=$?
if [ "$PREPASS_EXIT" -ne 0 ]; then
  echo "Window review stopped: --since ${W_SINCE} --until ${W_UNTIL} did not resolve (reason above)."
  exit "$PREPASS_EXIT"
fi
if [[ "$PREPASS_JSON" == @file:* ]]; then PREPASS_JSON=$(cat "${PREPASS_JSON#@file:}"); fi
P_FIELD() { printf '%s' "$PREPASS_JSON" | node -e "const p = JSON.parse(require('fs').readFileSync(0, 'utf-8')); const v = process.argv[1].split('.').reduce((o, k) => (o == null ? o : o[k]), p); process.stdout.write(v == null ? '' : Array.isArray(v) ? String(v.length) : String(v))" "$1"; }
WINDOW_DIR=$(P_FIELD dir)
REVIEW_PATH=$(P_FIELD review)
PREPASS_PATH=$(P_FIELD prepass)
W_FILE_COUNT=$(P_FIELD files)
W_TIP=$(P_FIELD window.tip)
W_BASE=$(P_FIELD window.base)
COMMIT_DOCS=$(gsd_run query config-get commit_docs --raw 2>/dev/null || echo "true")
REVIEW_DEPTH="${DEPTH_OVERRIDE:-$(gsd_run query config-get workflow.code_review_depth --raw 2>/dev/null || echo standard)}"
case "$REVIEW_DEPTH" in quick|standard|deep) ;; *) REVIEW_DEPTH=standard ;; esac
W_REVIEWED=$(P_FIELD reviewedAlready)
if [ "$W_FILE_COUNT" -eq 0 ]; then
  echo "No source files landed in the window --since ${W_SINCE} ($(P_FIELD reason)). Nothing to review."
  exit 0
fi
```

**`--fix` recovery:** when `FIX_FLAG` is `true` and `W_REVIEWED` is `true`, today's REVIEW.md already covers exactly this window (same base, same tip): skip steps 2–5 and go to step 6 — it is fixed as it stands, not reviewed again.

**2. What the pre-pass checked.** Every lens prompt carries this block verbatim — the classes that ran, the ones that could not, and that the rest is unchecked:

```bash
PREPASS_BRIEF=$(printf '%s' "$PREPASS_JSON" | node -e "
  const p = JSON.parse(require('fs').readFileSync(0, 'utf-8'));
  const meaning = {
    'loc-growth': 'net lines added per file across the window',
    'complexity-delta': 'functions whose decision-point complexity jumped, or crossed the threshold, between base and tip',
    'unconsumed-exports': 'exports no module imports by name: new in the window, or orphaned by a window edit',
    'churn': 'commits per file inside the window',
    'review-only-recurrence': 'files that collected guarded-by-review-only findings in earlier reviews',
  };
  const out = ['The deterministic pre-pass (' + process.argv[1] + ') checked ONLY these classes:'];
  for (const c of p.classes.filter((x) => x.status === 'checked')) out.push('- ' + c.class + ': ' + meaning[c.class] + (c.reason ? ' (partial: ' + c.reason + ')' : ''));
  const skipped = p.classes.filter((x) => x.status === 'skipped');
  if (skipped.length > 0) out.push('It could NOT check: ' + skipped.map((x) => x.class + ' (' + x.reason + ')').join(', ') + '.');
  out.push('Its results are hints, not verdicts, and not the list of what is wrong. It did NOT check bugs, security, duplication, dead or half-migrated code, naming, design or spec drift: find those yourself.');
  process.stdout.write(out.join('\n'));
" "$PREPASS_PATH")
printf '%s' "$PREPASS_JSON" | node -e "for (const r of JSON.parse(require('fs').readFileSync(0, 'utf-8')).reports) console.log(r.label + '\t' + r.lens + '\t' + r.path)"
```

**3. Lens agents — one per report line above, all in parallel, each in its own fresh context.** Apply `spawn_reviewer`'s runtime-aware dispatch (#2508) and model-omission (#2517) rules. Resolve each model with `gsd_run query resolve-model <agent> --raw`.

| lens | agent | prompt focus |
|---|---|---|
| correctness (one report per batch) | `gsd-code-reviewer` | bugs and security in the batch's `files` |
| standards | `gsd-standards-reviewer` | `lens: standards` |
| simplify | `gsd-standards-reviewer` | `lens: simplify` |
| spec | `gsd-spec-reviewer` | the window's phases against their plans |

```
Agent(subagent_type="gsd-code-reviewer", model="{REVIEWER_MODEL}", prompt="
<required_reading>
${PREPASS_PATH}
</required_reading>

<window_prepass>
${PREPASS_BRIEF}
</window_prepass>

<config>
depth: ${REVIEW_DEPTH}
phase_dir: ${WINDOW_DIR}
review_path: {report path}
${W_BASE:+diff_base: ${W_BASE}}
files:
{the report's files, one '  - path' line each}
</config>

Window review, correctness lens: these files changed across ${W_BASE:-the root}..${W_TIP}. Review each as it is now and its cumulative change (git diff ${W_BASE} ${W_TIP} -- <file>). Write findings to {report path}. Do NOT commit, do NOT spawn agents, do NOT run /gsd-code-review.
${AGENT_SKILLS_REVIEWER}")

Agent(subagent_type="gsd-standards-reviewer" | "gsd-spec-reviewer", model="{resolved model}", prompt="
<required_reading>
${PREPASS_PATH}
</required_reading>

<window_prepass>
${PREPASS_BRIEF}
</window_prepass>

<config>
lens: {standards | simplify | spec}
review_path: {report path}
base: ${W_BASE}
tip: ${W_TIP}
prepass: ${PREPASS_PATH}
</config>

Window review, {lens} lens over ${W_BASE:-the root}..${W_TIP}; the files are `files` in the pre-pass. Write findings to {report path}. Do NOT commit, do NOT spawn agents, do NOT run /gsd-code-review.
${AGENT_SKILLS_REVIEWER}")
```

A lens agent that fails is not retried here: its report stays missing, and `window-compose` names it — with no findings the review is `incomplete`, never `clean`.

**4. Verification.** When any written lens report holds a `### CR-`/`WR-`/`IN-`/`BL-` finding, spawn `gsd-finding-refuter` in review mode. It is read-only: write the text it returns, verbatim, to `${WINDOW_DIR}/REFUTATION.md`. If the agent type is unavailable (its capability is not installed) or it fails, skip this step — every finding is then reported `unverified`.

```
Agent(subagent_type="gsd-finding-refuter", model="{resolved model}", prompt="
<mode>review</mode>

<required_reading>
{every written lens report path}
</required_reading>

<config>
base: ${W_BASE}
tip: ${W_TIP}
</config>

Try to refute every finding in these lens reports against the code at ${W_TIP}. Head each verdict '### <label> <ID>: <title>', where <label> is the report file name without 'REVIEW-' and '.md'.")
```

**5. Compose, mark, commit.** The marker that `--since last` starts from is written only once REVIEW.md exists, and not for an `incomplete` review — a lens that never ran must not be skipped next time.

```bash
COMPOSE_JSON=$(gsd_run review window-compose --dir "$WINDOW_DIR") || exit $?
W_STATUS=$(printf '%s' "$COMPOSE_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf-8')).status)")
MARK_PATH=""
if [ "$W_STATUS" != "incomplete" ]; then
  MARK_PATH=$(gsd_run review window-mark --dir "$WINDOW_DIR" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf-8')).marker)")
fi
if [ "$COMMIT_DOCS" = "true" ]; then
  COMMIT_LIST=("$PREPASS_PATH" "$REVIEW_PATH")
  for f in "$WINDOW_DIR"/REVIEW-*.md "$WINDOW_DIR/REFUTATION.md" "$MARK_PATH"; do
    if [ -n "$f" ] && [ -f "$f" ]; then COMMIT_LIST+=("$f"); fi
  done
  gsd_run query commit "docs(review): window review ${WINDOW_DIR##*/}" --files "${COMMIT_LIST[@]}"
fi
```

**6. Fix.** With `--fix` and a REVIEW.md holding findings (`W_STATUS` = `issues_found`, or the recovered review), delegate to `code-review-fix.md` with the window's REVIEW.md. `--auto` is not forwarded: re-reviewing a window is a new window review (every lens again), so a window gets one fix pass — rerun `/gsd:code-review --since …` to re-review.

```
FIX_ARGS="--review ${REVIEW_PATH}"
if [ "$FIX_ALL" = "true" ]; then FIX_ARGS="${FIX_ARGS} --all"; fi
Workflow(workflow="gsd-core/workflows/code-review-fix.md", args="${FIX_ARGS}")
```

**7. Broken windows.** Surviving Critical/Warning findings that no fix pass fixed are recorded in `.planning/WINDOWS.md` as `deviation` entries, once (each carries the finding's fingerprint); entries of this review that the fix pass did fix are closed. Best-effort, like the executor's ledger population — never blocks.

```bash
gsd_run review window-deferred --dir "$WINDOW_DIR" --raw | while IFS=$'\t' read -r W_ACTION W_A W_B W_C W_D; do
  case "$W_ACTION" in
    append)
      W_ARGS=(--kind deviation --phase "$W_A" --description "$W_D")
      if [ "$W_B" != "-" ]; then W_ARGS+=(--file "$W_B"); fi
      if [ "$W_C" != "-" ]; then W_ARGS+=(--line "$W_C"); fi
      gsd_run windows append "${W_ARGS[@]}" >/dev/null || true ;;
    fixed)
      gsd_run windows fixed "$W_A" >/dev/null || true ;;
  esac
done
```

**8. Present and exit.** Print the window (`W_SINCE..W_UNTIL`, `W_TIP`, file count), the lenses, `COMPOSE_JSON`'s `counts` (critical, warning, info, refuted, unverified) and `missingReports`, and `Full report: ${REVIEW_PATH}`. Next steps: `/gsd:code-review --since ${W_BASE} --until ${W_TIP} --fix` fixes these findings today without reviewing again; `/gsd:code-review --since last` reviews what lands next (schedule it with `/loop 7d /gsd:code-review --since last`). Exit the workflow — the phase-review steps below do not apply.
</step>
