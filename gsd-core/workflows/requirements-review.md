@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Review a milestone's requirements before its roadmap exists (ADR-5212): one fresh lens agent each for data and migrations, client compatibility, security and testability reads REQUIREMENTS.md against the codebase, a refuter tries to refute every finding, and code composes REQUIREMENTS-REVIEW.md. A critical finding that survives and is not accepted as a known risk holds the roadmap — the `check mn-requirements-review` gate at roadmap:pre reads this review. The workflow never edits REQUIREMENTS.md.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-requirements-reviewer — reads the requirements along one lens against the codebase
- gsd-finding-refuter — tries to refute each lens finding (`requirements` mode)
</available_agent_types>

<process>

<step name="parse_arguments">
Read the `<arguments>` block: `--milestone <version>`, `--lens <list>`, `--ws <name>`, `--auto`, `--text` (or `workflow.text_mode: true` → `TEXT_MODE=true`). Anything else is a usage error: show the command's `argument-hint` and stop. Write the three values into the first line of `prepare`'s block (empty when not given).

Auto mode is `--auto`, or `AUTO_CHAIN` (printed by `prepare`) being `true`. In auto mode nothing below asks a question.
</step>

<step name="prepare">
The run record: the requirements' digest, each requirement's text digest, one report path per lens to run, and the context files that exist. Without `--milestone` the milestone is STATE.md's. A fresh run (`mode: full`) removes every report and the refutation of an earlier run; `--lens` over a run of the SAME requirements (`mode: partial`) re-runs only those lenses and keeps the other reports (`kept`) — the re-review after a lens failed or a finding was disputed.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
GSD_WS="{--ws value}"; MILESTONE="{--milestone value}"; LENS="{--lens value}"
PREP=$(gsd_run requirements-review prepare ${GSD_WS:+--ws=${GSD_WS##* }} ${MILESTONE:+--milestone "$MILESTONE"} ${LENS:+--lens "$LENS"}) || exit $?
if [[ "$PREP" == @file:* ]]; then PREP=$(cat "${PREP#@file:}"); fi
printf '%s' "$PREP" | node -e "const p = JSON.parse(require('fs').readFileSync(0, 'utf-8')); for (const r of p.reports) console.log(r.lens + '\t' + r.path + '\t' + r.focus)"
AGENT_SKILLS_REVIEWER=$(gsd_run query agent-skills gsd-requirements-reviewer ${GSD_WS:+--ws=${GSD_WS##* }} 2>/dev/null)
REVIEWER_MODEL=$(gsd_run query resolve-model gsd-requirements-reviewer --raw)
REFUTER_MODEL=$(gsd_run query resolve-model gsd-finding-refuter --raw)
COMMIT_DOCS=$(gsd_run query config-get commit_docs --raw 2>/dev/null || echo "true")
AUTO_CHAIN=$(gsd_run query check auto-mode --pick auto_chain_active 2>/dev/null); echo "AUTO_CHAIN=${AUTO_CHAIN:-false}"
```

A failure (`no-requirements`: there is nothing to review yet; an unknown lens) → show it and stop. Keep from `PREP`: `requirements`, `run`, `review`, `refutation`, `requirementCount`, `milestone`, `reports`, and `context` (`project`, `codebase`, `researchSummary`, `milestones` — each a path or null/empty).
</step>

<step name="lenses">
One `gsd-requirements-reviewer` per line printed above (in partial mode only the lenses being re-run), **all in parallel**, each in its own fresh context (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze). Do not read the codebase into this context: the agents do.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`REVIEWER_MODEL`, `REFUTER_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

```
Agent(subagent_type="gsd-requirements-reviewer", model="{REVIEWER_MODEL}", prompt="
<required_reading>
{requirements}
{run}
{context.project, context.researchSummary, context.milestones and every context.codebase path that is not null}
</required_reading>

<config>
lens: {lens}
review_path: {report path}
requirements: {requirements}
milestone: {milestone}
run: {run}
</config>

Requirements review, {lens} lens: {focus}. Read the requirements against the codebase and write findings to {report path}. Do NOT commit, do NOT edit REQUIREMENTS.md, do NOT spawn agents.
${AGENT_SKILLS_REVIEWER}")
```

A lens agent that fails is not retried: its report stays missing, `compose` names it, and the gate holds the roadmap until the review runs again — a lens that never read the requirements is not a clean lens.
</step>

<step name="refute">
When any written report — kept ones included — holds a `### CR-`/`WR-`/`IN-` finding, spawn `gsd-finding-refuter` in `requirements` mode over all of them. It is read-only: write the text it returns, verbatim, to `{refutation}` with the Write tool. If the agent type is unavailable or it fails, skip this step — every finding is then `unverified`, and an unverified critical finding still blocks.

```
Agent(subagent_type="gsd-finding-refuter", model="{REFUTER_MODEL}", prompt="
<mode>requirements</mode>

<required_reading>
{requirements}
{every written report path}
</required_reading>

Try to refute every finding in these lens reports against the requirements and the codebase. Head each verdict '### <lens> <ID>: <title>', where <lens> is the report file name without 'REVIEW-' and '.md'.")
```
</step>

<step name="compose">
```bash
COMPOSE=$(gsd_run requirements-review compose ${GSD_WS:+--ws=${GSD_WS##* }}) || exit $?
printf '%s' "$COMPOSE" | node -e "const c = JSON.parse(require('fs').readFileSync(0, 'utf-8')); console.log(JSON.stringify({ status: c.status, counts: c.counts, missing: c.missingReports, stale: c.stale })); for (const b of c.blocking) console.log('BLOCKING\t' + b.id + '\t' + b.lens + '\t' + (b.requirement || '-') + '\t' + b.title)"
if [ "$COMMIT_DOCS" = "true" ]; then
  REVIEW_DIR=$(dirname "$(printf '%s' "$PREP" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf-8')).run)")")
  COMMIT_LIST=("$(printf '%s' "$COMPOSE" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf-8')).review)")")
  for f in "$REVIEW_DIR"/*; do [ -f "$f" ] && COMMIT_LIST+=("$f"); done
  gsd_run query commit "docs: review milestone requirements${MILESTONE:+ (${MILESTONE})}" --files "${COMMIT_LIST[@]}"
fi
```

`stale: true` → REQUIREMENTS.md changed while the lenses ran: say so and run this workflow again; the gate will not accept this review.
</step>

<step name="decide">
No `BLOCKING` line → go to `present`.

**Auto mode:** ask nothing — go to `present`. The gate decides; the host stops its roadmap there.

**Otherwise** show each blocking finding (ID, lens, requirement, title, and the `**Issue:**`/`**Fix:**` lines from the review) and ask (AskUserQuestion, multiSelect; TEXT_MODE: a numbered list, the user types the numbers): "Accept any of these as known risks? The rest send the requirements back for revision." — one option per blocking finding, plus "None — revise the requirements". For a selection, ask for the reason in one line (plain text), then:

```bash
gsd_run requirements-review accept ${GSD_WS:+--ws=${GSD_WS##* }} {selected IDs} --reason "{reason}"
```

and commit the review and `ACCEPTED.json` again when `COMMIT_DOCS` is `true`. Never accept a finding the user did not pick.
</step>

<step name="present">
Print: the milestone, the requirements path and `requirementCount`, the lenses, `counts` (critical, warning, info, refuted, unverified, accepted, blocking), `missingReports`, and `Full review: {review}`. Then one line:

- blocking left → "The roadmap is held: revise REQUIREMENTS.md and review again, review the disputed lenses again as written (`/gsd:requirements-review --lens <their lenses>`), or accept a finding as a known risk (`gsd_run requirements-review accept <CR-ID> --reason \"…\"`; it covers that finding only, until the requirement's text changes or its lens runs again)."
- otherwise → "No unaccepted critical finding — the roadmap may proceed."

Return to the caller: a host at roadmap:pre continues to its gate.
</step>

</process>

<success_criteria>
- [ ] One fresh lens agent per configured lens; a lens that wrote nothing is named, never treated as clean
- [ ] The refuter ran in `requirements` mode over every written report, or every finding is marked unverified
- [ ] REQUIREMENTS-REVIEW.md was composed by `requirements-review compose`, not written by hand
- [ ] Only findings the user picked were accepted, each with the user's reason; nothing was asked in auto mode
</success_criteria>
