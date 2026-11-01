**If `human_needed`:**

Read `human_verification` items. In text mode (`--text` or init `text_mode=true`), replace AskUserQuestion with a plain-text numbered list. Otherwise ask whether to validate now or continue without validation. If validating now, present items, then ask `Validation result?` with `All good — continue` / `Found issues`.

On "All good — continue": record the human's acceptance as UAT, then let the shared UAT predicate flip the report — never write `status: passed` yourself; a pass with no UAT record is exactly what leaves the phase's UAT open for good.

1. `${PHASE_DIR}/${padded_phase}-UAT.md` holds one `### N.` test per `human_verification` item, written by execute-phase's human_needed branch; if it is absent, create it in that format first. Under each test the human just accepted, set `result: pass` and add `source: human` (an additive marker, like verify-work's `source: automated`); update `## Summary`.
2. Close the session and canonicalize exactly as verify-work does:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { set -- "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}" "$HOME/.gemini/antigravity-ide" "$HOME/.gemini/antigravity-cli" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}" "${CLINE_CONFIG_DIR:-$HOME/.cline}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}" "${CODEX_HOME:-$HOME/.codex}" "${COPILOT_CONFIG_DIR:-${COPILOT_HOME:-$HOME/.copilot}}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}" "${HERMES_HOME:-$HOME/.hermes}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}" "${KIMI_CONFIG_DIR:-$HOME/.config/agents}" "$HOME/.agents" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}" "${TRAE_CONFIG_DIR:-$HOME/.trae}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}" "${ZCODE_CONFIG_DIR:-$HOME/.zcode}" "${GROK_AGENTS_HOME:-$HOME/.agents}"; for _h; do _gsd_at "$_h/gsd-core/bin/${_GSD_SHIM_NAME}" && return 0; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
gsd_run query uat.complete-session "${PHASE_DIR}/${padded_phase}-UAT.md" --message "test(${PHASE_NUM}): record human validation from autonomous"
# exit 0 / exit 1 with "false" are verdicts; any other exit, or exit 1 with no answer, means it could not run
UAT_PASSED=$(gsd_run phase uat-passed "${PHASE_NUM}" --uat-only --pick passed) && UAT_EXIT=0 || UAT_EXIT=$?
if [ "$UAT_EXIT" -eq 0 ] && [ "$UAT_PASSED" = "true" ]; then
  gsd_run query frontmatter.set "$(gsd_run query verification.resolve-file "${PHASE_DIR}" --raw)" --field status --value passed
fi
```

If `UAT_PASSED` is `true`: display `Phase ${PHASE_NUM} ✅ Human validation passed`, run `@~/.claude/gsd-core/workflows/transition.md`, then iterate. Otherwise the report stays `human_needed`: handle_blocker with the `blockers` of `gsd_run phase uat-passed "${PHASE_NUM}" --uat-only` (or the error above when it could not run).

On "Found issues": Go to handle_blocker with the user's reported issues as the description.

On **"Continue without validation"**: record an explicit deferred state and stop autonomous mode:

```markdown
## Deferred Verification

| Phase | State | Resume |
|-------|-------|--------|
| ${PHASE_NUM} | verification_deferred_human | /gsd:verify-work ${PHASE_NUM} |
```

Append/update this STATE.md section, display `Phase ${PHASE_NUM} ⏭ verification_deferred_human — resume with /gsd:verify-work ${PHASE_NUM}`, then handle_blocker: "Human verification deferred for phase ${PHASE_NUM}."
