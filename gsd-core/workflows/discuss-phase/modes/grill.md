Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

# Grill mode — one question at a time down the decision tree

> **Lazy-loaded.** Read this file from `workflows/discuss-phase.md` when
> `--grill` is in $ARGUMENTS or `workflow.discuss_mode` is `grill`. It
> replaces `present_gray_areas` and `discuss_areas`. Every other step of the
> parent runs as usual; `write_context` and `git_commit` take the additions at
> the end of this file.

Instead of a questionnaire per area, grill walks the dependency tree of the
phase's decisions. Each round asks ONE question — the earliest open decision
that other decisions depend on — together with a recommended answer and why.
What the code or the docs already answer is looked up by a subagent and never
asked. The tree is data in the checkpoint, and `gsd_run discuss tree` — not
you — picks the next question, applies the pass cap, finds defects, and draws
the graph.

## Combination rules

- `--power`, `--auto`: take precedence; grill is not used. (Auto answers every
  question itself, so no decision could be attributed to the user.)
- `--text`: applies — render each round's question as a plain-text numbered list.
- `--analyze`: applies — show the trade-off table above the round's question.
- `--chain`: applies — auto-advance once CONTEXT.md is written.
- `--batch`, `--all`: ignored — grill asks one question per round, and the
  tree, not area selection, decides what is asked.
- `ADVISOR_MODE`: grill's flow replaces advisor's table-first selection; the
  advisor researcher is still the agent spawned for recommendations below.

## Setup

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
ANALYZER_MODEL=$(gsd_run query resolve-model gsd-assumptions-analyzer --raw)
ADVISOR_MODEL=$(gsd_run query resolve-model gsd-advisor-researcher --raw)
AGENT_SKILLS_ANALYZER=$(gsd_run query agent-skills gsd-assumptions-analyzer ${GSD_WS:+--ws=${GSD_WS##* }})
CHECKPOINT="${phase_dir}/${padded_phase}-DISCUSS-CHECKPOINT.json"
```

`AGENT_SKILLS_ADVISOR` was resolved by the parent's `initialize` step.

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** Before dispatching on a built-in-only runtime (kimi-code), resolve each role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`; on named-dispatch runtimes the role is returned unchanged. See @gsd-core/references/runtime-aware-dispatch.md.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`ANALYZER_MODEL`, `ADVISOR_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

## grill_seed (replaces present_gray_areas)

**Resuming?** If the checkpoint the parent's `check_existing` step resumed
from has a `decision_tree`, skip to `grill_rounds`.

1. **Facts first.** Spawn the assumptions analyzer once for the whole phase:

   ```
   Agent(
     prompt="<phase>{PHASE}: {phase_name}</phase>
     <phase_goal>{phase description from ROADMAP.md}</phase_goal>
     <prior_decisions>{prior_decisions summary}</prior_decisions>
     <codebase_hints>{codebase_context summary}</codebase_hints>
     <calibration_tier>standard</calibration_tier>

     Return structured assumptions with evidence in your output format.
     ${AGENT_SKILLS_ANALYZER}",
     subagent_type="gsd-assumptions-analyzer",
     model="{ANALYZER_MODEL}",
     description="Assumptions: Phase {PHASE}"
   )
   ```

   > **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, do not read files or analyze the codebase yourself while the subagent is active. Wait for its result.

2. **Build the tree** — one node per decision:
   - every gray area from `analyze_phase` → an open node; its `question` is
     the concrete decision, not the area's name;
   - every analyzer assumption: `Confident` → a decided node,
     `decided_by: "codebase"`, `answer` = the assumption, `evidence` = the
     cited path. `Likely` / `Unclear` → an open node with `recommendation` =
     the assumption and `rationale` = its "Why this way" and "If wrong".
     Merge an assumption into the gray-area node it answers rather than adding
     a second node for the same decision;
   - `depends_on`: B depends on A when A's answer changes B's options or makes
     B moot. Only real dependencies — never an edge just to set an order;
   - ids `D-01`, `D-02`, … in creation order, never renumbered: they are what
     `depends_on` refers to, and they reach CONTEXT.md unchanged;
   - leave out what is already locked (prior phases, SPEC.md — shown as
     "Carrying forward" as usual) and anything outside the phase boundary.

   Node shape:

   ```json
   {"id": "D-02", "area": "API", "question": "Pagination style?",
    "status": "open", "depends_on": ["D-01"],
    "recommendation": "Cursor-based", "rationale": "…",
    "answer": null, "decided_by": null, "evidence": null}
   ```

   `status` is `open`, `decided` or `discretion`; `decided_by` is `user` (the
   user's own answer), `recommendation` (the user accepted the recommended
   answer) or `codebase` (a fact, never asked).

3. **Write the checkpoint** — the fields of
   `workflows/discuss-phase/templates/checkpoint.json` (`areas_completed` and
   `areas_remaining` empty, `decisions` `{}`) plus
   `"decision_tree": {"nodes": [...]}` — to `$CHECKPOINT`.

4. **Present** the domain boundary and "Carrying forward" exactly as
   `present_gray_areas` does, then one line from `gsd_run discuss tree --file
   "$CHECKPOINT"`: `{node_count} decisions — {decided_by.codebase} settled
   from the code, {counts.open} to decide.` No area selection.

## grill_rounds (replaces discuss_areas)

Repeat:

1. `TREE=$(gsd_run discuss tree --file "$CHECKPOINT")` — read `next`,
   `stopped`, `defects`, `beyond_cap`.
2. **Defects first.** If `defects` is non-empty, repair the checkpoint and run
   the command again — never ask from a defective tree: `missing` → add the
   node or drop the edge; `cycle` → drop the edge that is not a real
   dependency; `unattributed` → record who decided; `invalid_node` → fix the
   entry.
3. **No `next`** → leave the loop (`stopped`: `complete`, `pass_cap`, or
   `blocked` — the last only if the repair failed; say which nodes and why).
4. **A question of fact is not asked.** If `next` asks what already exists —
   which library, which pattern, whether something is already built — spawn
   the advisor researcher on it instead:

   ```
   Agent(
     prompt="<gray_area>{next.id}: {next.label}</gray_area>
     <phase_context>{phase goal and description from ROADMAP.md}</phase_context>
     <project_context>{project name and description from PROJECT.md}</project_context>
     <calibration_tier>minimal_decisive</calibration_tier>

     This is a question of fact about the existing project. Answer it from the
     codebase and docs. If the evidence supports exactly one answer, return it
     as the only option and cite the file path in the rationale.
     ${AGENT_SKILLS_ADVISOR}",
     subagent_type="gsd-advisor-researcher",
     model="{ADVISOR_MODEL}",
     description="Fact: {next.id}"
   )
   ```

   One option with a cited path → set the node `decided`,
   `decided_by: "codebase"`, `answer`, `evidence`; write the checkpoint and
   start the next round. Several options → it is a real decision; go on with
   that table as its recommendation source.
5. **A decision without a recommendation** → spawn the same agent without the
   question-of-fact paragraph (`minimal_decisive` gives one decisive
   recommendation). Rewrite its rationale with what the agent did not see:
   the answers already in the tree.
6. **Ask ONE question** (AskUserQuestion):
   - header: the node's `area` (max 12 chars);
   - question: `{next.label}`, a blank line, then
     `Recommended: {recommendation} — {rationale in 1-2 sentences}`; when
     `next.unblocks` > 0 add `(settles {unblocks} later decision(s))`;
   - options: `{recommendation} (Recommended)` first, then 1-2 real
     alternatives. No "You decide" — accepting the recommendation is how the
     user delegates.
7. **Record the answer** on the node and write the checkpoint:
   - the recommended option → `decided_by: "recommendation"`;
   - another option or free text → `decided_by: "user"`, `answer` in the
     user's words (reflect free text back first);
   - an answer that reveals a new decision → add a node (next free id) with
     its `depends_on`; one that makes a node moot → decide that node too,
     `answer: "Not applicable — {id} chose {answer}"`, same `decided_by`;
   - the user revises an earlier decision → set it back to `open` (the
     command then warns about decisions taken on top of it — revisit them);
   - scope creep → deferred ideas, never a node;
   - "enough" / "write it up" → leave the loop.

   Accumulate for the discussion log: id, question, options, recommendation,
   selection, `decided_by`.

**On leaving the loop**, set every node still `open` to `discretion` (it keeps
its recommendation) and write the checkpoint: the planner must see that the
user did not settle it.

**Pass cap.** `workflow.max_discuss_passes` (default 3) caps how deep the tree
is grilled. A pass is one level of the tree: pass 1 asks the roots, pass 2 the
decisions whose deepest dependency is a root, and so on. The command applies
the cap — `stopped: "pass_cap"` and `beyond_cap` list what it held back. Tell
the user how many decisions were left to the planner and that raising
`workflow.max_discuss_passes` puts them to the user next time.

## write_context additions

In `<decisions>`, one bullet per decided node under `### {area}`, ids unchanged:

```
- **D-01 [informational]:** Postgres via Drizzle (`src/db/index.ts`) — **Decided by:** codebase
- **D-02:** Cursor-based pagination — **Decided by:** recommendation — **Depends on:** D-01
```

- `**Decided by:**` on every grill decision; `**Depends on:**` only when the
  node has dependencies; both before any `**Reversibility:**` field.
- Facts from the code carry `[informational]`: they record what exists, so
  plans need not cover them.
- `discretion` nodes go under `### Claude's Discretion`:
  `- **D-07:** {question} — recommended: {recommendation} — **Depends on:** D-02`.

Then check the written file against the tree and draw it:

```bash
gsd_run discuss tree --file "${phase_dir}/${padded_phase}-CONTEXT.md" --strict --raw
```

A non-zero exit means the decisions block lost an id or a `Depends on` points
nowhere — fix CONTEXT.md and run it again. Keep the output for the log.

## git_commit additions

DISCUSSION-LOG.md records one entry per round (question, recommendation,
options, selection, `decided_by`) instead of per-area tables, and ends with a
`## Decision Tree` section holding the output of the command above. It is a
derived block — regenerate it, never edit it by hand.
