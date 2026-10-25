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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
VERIFY_ERROR=""  # reset every loop iteration — a prior phase's refusal must not leak into this one
VERIFY_STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status) || VERIFY_ERROR=1
```

If `VERIFY_ERROR` is set: handle_blocker with the error printed above (#5118).

If `passed` or `human_needed`: route normally.

Any status other than `passed`/`human_needed`/`gaps_found`: handle_blocker with the owner's `next_action` (`--pick next_action`).

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
