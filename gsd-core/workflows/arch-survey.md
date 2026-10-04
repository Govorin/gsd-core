@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Survey the codebase for deepening opportunities — modules whose interface is nearly as complex as their implementation, seams that leak, behaviour smeared across files — and let the user decide, per candidate, what happens to it.

The third part of the `architecture` capability: design (`plan:pre`) fixes structure before a phase, review (`verify:pre`) checks the phase kept it, and the survey finds the drift that lives outside any phase's promises. Run periodically, by a person, or proposed by `complete-milestone` when the hot spots grew.

Adapted from the `improve-codebase-architecture` skill of mattpocock/skills (MIT), with three changes: everything countable is counted by `gsd-tools arch` instead of eyeballed; candidates are refuted before the user sees them; a rejected candidate is journalled and never proposed again. Grilling is off by default (`--grill` turns it on).
</purpose>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-arch-surveyor — Surveys one zone and writes candidate cards
- gsd-finding-refuter — Tries to refute each candidate with evidence (mode `arch`)
</available_agent_types>

<process>

<step name="parse_arguments">
Arguments: see the `<arguments>` block of the command.

- `--paths p1,p2` — scope the survey to these repository paths.
- `--since <90d|ISO date|ref>` — the history window (default `architecture.survey_window`, `90d`).
- `--top N` — number of zones, one surveyor each (default `architecture.survey_top_zones`, `5`).
- `--grill` — after the user picks a candidate to explore, go straight into `/gsd:explore` with it.
- Any other word is the user's **direction** (a module, a subsystem, a pain point). A word that names an existing directory or file joins `--paths`; the rest is passed to every surveyor as the direction to weigh first.

Set `TEXT_MODE=true` if `--text` is present or `gsd_run query config-get workflow.text_mode --raw` prints `true`; in text mode replace every `AskUserQuestion` with a numbered plain-text list.
</step>

<step name="metrics">
Count before reading. One CLI call computes the import graph, churn and co-change over the window, complexity, hot spots and zones, and writes `.planning/architecture/metrics-<date>.json`:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
METRICS=$(gsd_run arch metrics ${PATHS:+--paths "$PATHS"} ${SINCE:+--since "$SINCE"} ${TOP:+--top "$TOP"} --compare-last)
```

If the output starts with `@file:`, read the JSON from that path. Keep from it: `date`, `status`, `reasons`, `hotspotBasis`, `zones` (each with `id`, `seed`, `label`, `files`, `signals`), `comparison`. Set `DATE` to its `date`; every later step passes `--date "$DATE"`, so a survey that runs past midnight stays one survey.

- `zones` empty → there is nothing to survey (no modules in scope). Say so, show `graph.modules`, and stop.
- `status: degraded` → show `reasons` in one line and continue: a degraded input is named, not hidden (`hotspot-basis:complexity` means the window had no readable history, so zones come from complexity alone).
- `configProblems` non-empty → show them in one line; the defaults were used.
</step>

<step name="spawn_surveyors">
Resolve the models and the skills once:

```bash
GSD_WS=$(echo " $ARGUMENTS" | sed -nE 's/.* --ws +([A-Za-z0-9][A-Za-z0-9._-]*).*/--ws \1/p' | head -n 1)
SURVEYOR_MODEL=$(gsd_run query resolve-model gsd-arch-surveyor --raw)
REFUTER_MODEL=$(gsd_run query resolve-model gsd-finding-refuter --raw)
AGENT_SKILLS_SURVEYOR=$(gsd_run query agent-skills gsd-arch-surveyor ${GSD_WS:+--ws=${GSD_WS##* }})
```

Omit the `model` parameter when a resolved value is `inherit` or empty (#2517). Spawn **one `gsd-arch-surveyor` per zone, all in one message, `run_in_background=true`**. Each runs in a fresh context; the orchestrator never reads the zones' code itself.

Print: "Spawning {N} architecture surveyors, one per zone (each runs in a subagent — no output until they return)."

```text
Agent(
  subagent_type="gsd-arch-surveyor",
  model="{SURVEYOR_MODEL}",
  run_in_background=true,
  description="Survey zone {zone.id}",
  prompt="Zone: {zone.id} — {zone.label}
Survey date: {date}
Seed: {zone.seed}
Files: {zone.files, one per line}
<signals>
{zone.signals as JSON}
</signals>
Per-module rows (loc, fanIn, testFanIn, fanOut, churn, complexity): .planning/architecture/metrics-{date}.json, `modules`
Direction from the user: {direction, or 'none'}
Write your cards to: .planning/architecture/survey-{date}/cards-{zone.id}.json

<required_reading>
- ~/.claude/gsd-core/references/codebase-design.md
- {CONTEXT.md and/or GLOSSARY.md, when present}
- {.planning/codebase/CONCERNS.md, when present}
</required_reading>
${AGENT_SKILLS_SURVEYOR}"
)
```

Wait for every surveyor. A surveyor that fails leaves no cards file; the report names its zone as `no cards file` rather than pretending it found nothing.
</step>

<step name="collect_cards">
Merge the cards with fixed rules — no agent synthesises them:

```bash
CARDS=$(gsd_run arch cards --date "$DATE")
```

The result lists `candidates` (numbered, ordered by strength), `failedCheck` (cards naming files that do not exist), `excludedByDecision` (rejected before, same files and kind), `invalid` (malformed cards) and `refuterInputPath`.

No candidates → skip `refute` and go to `report`.
</step>

<step name="refute">
Spawn one `gsd-finding-refuter` in **mode `arch`** over the candidates. It checks that each candidate's files play the role the problem claims and that the deletion test holds against the callers; it may only refute with evidence.

```text
Agent(
  subagent_type="gsd-finding-refuter",
  model="{REFUTER_MODEL}",
  description="Refute architecture candidates",
  prompt="Mode: arch
<required_reading>
- {refuterInputPath}
- ~/.claude/gsd-core/references/codebase-design.md
</required_reading>
Refute each finding in the file, in order, using the output format of your mode."
)
```

Write the refuter's reply **verbatim** to `.planning/architecture/survey-{date}/refutation.md` with the Write tool. Do not edit it: `arch report` maps verdicts back by number and title.
</step>

<step name="report">
```bash
REPORT=$(gsd_run arch report --date "$DATE")
```

This writes `.planning/architecture/SURVEY-{date}.md` — hot spots, zones with diagrams drawn from the metrics, the surviving cards, the top recommendation, and everything rejected on the way, with the reason. Diagrams come from data; never draw or edit them.

Show the user: the verdict, then one line per candidate — `n. [Strength] title — verification (zone)` — and the report path. If `comparison` has a baseline, add one line: what grew since that survey.

`verdict: no-strong-candidates` with no surviving candidate → say plainly that the surveyed zones hold, point at the report, commit (below) and stop. That is a result, not a failure.
</step>

<step name="decide">
Ask which candidate to act on:

```text
AskUserQuestion(
  header: "Architecture survey",
  question: "Which candidate do you want to act on?",
  options: [one per surviving candidate: "{n}. {title} ({strength})", "None for now"]
)
```

For the chosen candidate, ask what happens to it:

| Choice | Action | Record |
|---|---|---|
| Explore it | `/gsd:explore` with the card's problem, files and deletion test as the topic | `--disposition accepted --route explore` |
| Make it a phase | `/gsd:phase` with a description built from the card | `--disposition accepted --route "phase {N}"` |
| Park it in the backlog | `/gsd:capture --backlog` with the card's title | `--disposition deferred --route "backlog {999.x}"` |
| Reject it | ask for the reason in one sentence | `--disposition rejected --reason "{reason}"` |

```bash
gsd_run arch decide --id "{id}" --disposition {disposition} ${REASON:+--reason "$REASON"} ${ROUTE:+--route "$ROUTE"} --date "$DATE"
```

A rejection needs a reason that a future survey would need — the journal excludes the candidate from every later run because of it. When the result has `adrSuggested: true`, offer: "Record this as an ADR so future surveys and designs know why?" Offer it only for a lasting reason ("the split is the plugin seam"), not a passing one ("not now").

Without `--grill`, print the `/gsd:explore` command for an explored candidate and let the user run it. With `--grill`, hand the candidate to `/gsd:explore` now.

The user may decide on more than one candidate; loop until they choose "None for now".
</step>

<step name="commit">
```bash
gsd_run query commit "docs(arch): architecture survey ${DATE}" --files .planning/architecture/
```
</step>

</process>

<success_criteria>
- [ ] Metrics computed and written before any agent ran; degraded inputs named
- [ ] One surveyor per zone, in parallel, each in a fresh context
- [ ] Cards merged by `arch cards`, not by the orchestrator
- [ ] Candidates refuted before the user saw them; the reply saved verbatim
- [ ] `SURVEY-{date}.md` written by `arch report`; "no strong candidates" reported as a result
- [ ] Every user decision recorded with `arch decide`; a rejection carries its reason
</success_criteria>
