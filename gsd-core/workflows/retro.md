@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Retrospective on a coding session: propose changes to the agent's ENVIRONMENT — checks, reviewer rules, settings, navigation pointers — that remove the friction the session hit. Code counts the friction and checks every claim; the `gsd-retro-analyst` agent supplies only the judgement in between. Nothing is applied by this workflow (ADR-5209).
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-retro-analyst — turns friction signals and the check inventory into environment candidates
- gsd-finding-refuter — tries to refute each mechanical candidate (`retro` mode)
</available_agent_types>

<process>

<step name="parse_arguments">
Read the `<arguments>` block:

- `--session <id>` / `--last` (default: newest session), `--since <12h|7d|2w|YYYY-MM-DD|ISO instant>` (an ISO instant carries its offset, `2026-10-20T10:00:00.000Z` — the form a scheduled retro passes) and `--ws <name>` (the workstream whose schedule this retro restarts) — passed to `retro prepare` unchanged: set `SELECTION_ARGS` to them, one array element per word (`SELECTION_ARGS=(--session abc --since 7d --ws auth)`, or `SELECTION_ARGS=()` when none).
- `--apply <cand-id>` (optionally `--retro <stem>`) — go to `apply_candidate` and stop there.
- `--checks` — go to `show_checks` and stop there.
- `--lessons` (optionally `--layer user|gsd|host` and `--status open|fixed|wontfix`, kept as `LAYER` and `STATUS`) — go to `show_lessons` and stop there.

Anything else is a usage error: show the command's `argument-hint` and stop.
</step>

<step name="prepare">
The deterministic pass: signals for the session, the inventory of existing checks, the journal state, and this retro's artifact paths. It writes the analyst's input bundle under `.planning/retro/.work/` (self-ignoring) and prints a summary.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
PREP=$(gsd_run retro prepare "${SELECTION_ARGS[@]}")
```

- `{"disabled": true}` → print its `message` and stop.
- A usage error (unknown `--session`, malformed `--since`) → show it and stop.
- `signals`, `inventoryFindings` and `removalCandidates` all `0` → print "Nothing to retro: no friction signals, no missing or unwired checks, no stale checks." and stop. A model pass with no evidence can only invent advice.
- `status: "degraded"` → keep going, and tell the user which sources were not read (the bundle's `report.reasons`). On a runtime other than Claude Code the retro works from git, `.planning` and the inventory only.
- `suggest: false` with signals present → say the friction score is below `retro.signal_threshold` and continue: the user asked for this retro explicitly.

`lessons.reason: "lessons-invalid"` → tell the user the cross-repository lessons journal (`~/.gsd/lessons/LESSONS.json`) cannot be read and continue without it. `recurring` counts this project's earlier candidates whose friction came back; the analyst reports on each.

`prepare` also journals this retro in `.planning/retro/RUNS.json` (`run` in `PREP`): the schedule (`retro.cadence_phases`, every 2 executed phases by default, `0` off; `retro.at_milestone_start`) counts from it whatever the analyst finds, so "Nothing to retro" still restarts the count. `run.recorded: false` → show `run.problems` and continue.

Keep `stem`, `bundle`, `report`, `candidates`, `patches` from `PREP`.
</step>

<step name="analyze">
```bash
ANALYST_MODEL=$(gsd_run query resolve-model gsd-retro-analyst --raw)
```

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`ANALYST_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

Spawn one fresh analyst (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze). Do not read the bundle into this context: the agent reads it.

```
Agent(subagent_type="gsd-retro-analyst", model="{ANALYST_MODEL}", prompt=<<
<required_reading>
- {bundle}
</required_reading>

<bundle>{bundle}</bundle>
<report>{report}</report>
<candidates>{candidates}</candidates>
<patches>{patches}</patches>
>>)
```

Wait for `## RETRO COMPLETE`. If the agent returns without it, report the failure and stop; never write the report yourself.
</step>

<step name="validate">
Every candidate must cite evidence the bundle carried, a judgement rule must not target a steering file, a mechanical candidate must carry a `verify` command, its target must fit its `layer` (a `gsd` file must exist in the installed GSD, a `host` target must name the runtime and version the session ran, a `user` target sits under `~` outside the project), and a candidate whose friction an earlier proposal already answered must cite it. Code checks this, not the orchestrator:

```bash
CANDS=$(gsd_run retro candidates --retro "${STEM}")
```

`valid` survives, each with its `layer` and `route`; `dropped` lists each removed candidate with its `reasons` and their `codes`. Never re-add a dropped candidate.
</step>

<step name="refute">
For the `valid` candidates whose `route` is `quick` (a `mechanical` or `retire-check` candidate of this project), spawn `gsd-finding-refuter` in `retro` mode. It confirms each cited pointer is real and runs each `verify` command: a proposed check must **fire on the incident and stay silent on clean code**.

```
Agent(subagent_type="gsd-finding-refuter", prompt=<<
<mode>retro</mode>
<required_reading>
- {report}
- {candidates}
</required_reading>
<findings>
{the valid mechanical and retire-check candidates from CANDS, verbatim}
</findings>
>>)
```

A candidate the refuter marks REFUTED is shown with its evidence under "Refuted", not among the candidates.
</step>

<step name="present">
Show, in this order:

1. The header: session, friction score and threshold, status, and any degraded reasons.
2. The surviving candidates by severity: `id · severity · category · layer — title`, the route (`quick`, `capture`, `user`, `lesson`), the target, the verify command, `related` ids, and any `notes` (`host-version-unknown`: the runtime version was not recorded).
3. "Proposed before": each `recurring` item from the bundle — applied or not, `countThen → countNow`, escalated or not.
4. Dropped and refuted candidates, one line each with the reason.
5. The paths: report, candidates, patches.
6. "Nothing has been applied. To act on one: `/gsd:retro --apply <cand-id>`."
</step>

<step name="apply_candidate">
A human chose a candidate. Route it; never apply it from here.

```bash
CAND=$(gsd_run retro candidates --id "${CAND_ID}" ${RETRO_STEM:+--retro "$RETRO_STEM"})
```

A usage error (dropped or unknown id) → show it and stop.

The route follows the candidate's `layer` (ADR-5209 §10):

- `route: "quick"` (a `project` `mechanical` or `retire-check`) → `Skill(skill="gsd-quick", args="<title>: <change>. Target: <target>. Patch: <patch or none>. Done when: <verify> fails on the incident and passes on clean code.")`.
- `route: "capture"` (a `project` `judgement`, `navigation`, `environment`, `steering`) → `Skill(skill="gsd-capture", args="<title>: <change> (target: <target>; from <report>)")`.
- `route: "user"` (the user's own setup, outside the project) → show the target, the change and the patch, and say the retro edits no file of theirs. Ask (AskUserQuestion; under `TEXT_MODE` a plain-text yes/no) whether they applied it. Only on an explicit yes: `gsd_run retro lessons record --retro "${STEM}" --candidate "${CAND_ID}"`, so the next retro in any repository knows.
- `route: "lesson"` (`gsd`, `host`) → `LESSON=$(gsd_run retro lessons record --retro "${STEM}" --candidate "${CAND_ID}")`. The project is not touched. Show `outcome` (`created`, `appended`, `duplicate`; `regression` — a fixed lesson came back: say so first), the lesson id, `journal` and `draft` (the issue text; filing it is the user's call — nothing is sent). A `retro_lessons_invalid` error → show it: the journal must be fixed or moved first.

Then name the candidate's `related` ids: a project stopgap for a lesson, or the lesson behind a stopgap, is applied with its own `--apply`.

After `/gsd:quick` or `/gsd:capture` returns with the change made, journal that it was applied, so a later retro that sees the same friction can tell an ignored proposal from one that did not work:

```bash
gsd_run retro applied --retro "${STEM}" --candidate "${CAND_ID}"
```

`recorded: false` with a `refusal` (`no-run`, `journal-invalid`, `locked`) → show its `problems`.

After `/gsd:quick` lands a `mechanical` check, ask the user (AskUserQuestion; when `TEXT_MODE` is active — `--text` in the arguments or `workflow.text_mode: true` — ask the same yes/no as a plain-text question instead) whether to journal it, so a check that stops firing becomes a removal candidate later. On yes, with the literal the check prints when it fires:

```bash
gsd_run retro checks record --id "${CHECK_ID}" --kind "${KIND}" --match "${MATCH}" --retro "${STEM}" --candidate "${CAND_ID}" --signal "${FIRST_SIGNAL}"
```

After `/gsd:quick` removes a `retire-check` candidate's check, retire its entry: `gsd_run retro checks retire --id "${CHECK_ID}"`.
</step>

<step name="show_lessons">
```bash
gsd_run retro lessons ${LAYER:+--layer "$LAYER"} ${STATUS:+--status "$STATUS"}
```

`status: "invalid"` → say the journal cannot be read (`problems`) and stop. Otherwise show each lesson: `id · layer · status — title`, the target, occurrences and projects, `fixedIn`, regressions, and for `gsd`/`host` the draft path (`~/.gsd/lessons/drafts/<id>.md`). Closing is the user's call: `gsd_run retro lessons close --id <id> --status fixed|wontfix [--fixed-in <version>]`.
</step>

<step name="show_checks">
```bash
gsd_run retro checks
```

Show each journaled check with its state (`fired`, `silent`, `removal-candidate`, `unknown`) and note. A `removal-candidate` has not fired across `retro.check_stale_days`; removing it is the user's call — a later retro proposes it as a `retire-check` candidate.
</step>

</process>

<success_criteria>
- [ ] The analyst ran only when the deterministic pass found evidence
- [ ] Every presented candidate passed `retro candidates`; dropped ones are listed with reasons
- [ ] No project file was changed by the retro itself; `--apply` routed a project candidate through `/gsd:quick` or `/gsd:capture`, a gsd or host one to the lessons journal, and a user one only after the user's yes
</success_criteria>
