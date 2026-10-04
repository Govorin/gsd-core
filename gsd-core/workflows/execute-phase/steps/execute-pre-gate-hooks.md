# Execute:pre Gate Hook Evaluation

Detail for the `kind == "gate"` dispatch in `execute-phase.md` step `execute_pre_hooks`, kept out of the host because it carries a frozen byte ceiling (#1168). The gates run after the point's steps — a gate may read what a step recorded (mn-verify-gate's `check mn-baseline` reads the `{N}-BASELINE.md` that its `verify baseline` step writes).

⚠ **Validate `check` before shell use** (third-party manifest input) — `gsd-core/references/loop-hook-dispatch.md` § `gate`.

**For each active entry where `kind == "gate"`** (process in array order), run its check — a `check.query` gate through the check CLI with the phase number (`hook_check_query` = the validated `hook.check.query`), a `predicate` gate through `check predicate`:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; _gsd_id_ok() { case "$("$1" runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') return 0;; *) return 1;; esac; }; _gsd_homes() { _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif _gsd_homes; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; [ -n "$_G" ] && _gsd_id_ok "$_G"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and no identity-proving gsd_run is on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; _gsd_id_ok gsd_run && GSD_IDENTITY_STATUS=ok; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
GATE_RESULT=$(gsd_run check "${hook_check_query}" "${PHASE_NUMBER}" --raw)
CHECK_EXIT=$?
# predicate form:
# GATE_RESULT=$(gsd_run check predicate --predicate '<hook.check.predicate as JSON>' --phase-dir "${PHASE_DIR}" --phase-number "${PHASE_NUMBER}" --raw)
```

**Step 1 — did the check command itself succeed?** Non-zero `CHECK_EXIT`, empty output, or unparseable JSON:
- `onError == "halt"` → stop before the first wave and surface: `⚠ Gate check command failed ({hook.capId}): command error. Resolve before executing.`
- `onError == "skip"` → log a warning and continue to the next hook. Do NOT read `GATE_RESULT.block`.

**Step 2 — read `GATE_RESULT.block` (boolean).**

- **Blocking gate (`hook.blocking == true`) AND `block == true`:** HALT — spawn no executor, start no wave, and present:

  ```
  ⚠ Execution blocked before the first wave by capability gate ({hook.capId}): {GATE_RESULT.message}
  ```

  Then offer what the message names, and nothing else: repair the base (or the check roster) and re-run `/gsd:execute-phase {PHASE_NUMBER}`; or, when the message offers an acceptance command, run it only after the user has explicitly confirmed and given the reason — never choose it on their behalf — then re-run. This halt is **not** bypassed by `onError`, which covers command errors only (step 1).
- **Non-blocking gate (`hook.blocking == false`):** never halts. With `block == true` or a non-empty `message`, print `⚠ {hook.capId} advisory: {GATE_RESULT.message}` and continue.
- **`block == false`:** continue silently.

**When all active gates are processed without a blocking halt:** continue to `cross_ai_delegation`.
