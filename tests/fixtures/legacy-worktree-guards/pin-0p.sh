# gsd:guard=supplied-root-pin (#4254) — run before the first Edit/Write and before every commit.
PINNED_ROOT='{PINNED_ROOT}'  # orchestrator build-time substitution — the only valid source of this value
PIN_STAGE=''
PIN_DIAG=''
gsd_pin_fail() {
  echo "FATAL: executor root does not match the orchestrator-supplied PROJECT_ROOT pin (#4254)." >&2
  echo "  Pinned root: ${PINNED_ROOT:-<empty or unexpanded>}" >&2
  echo "  Actual root: ${ACTUAL_ROOT:-<none>}" >&2
  echo "  Guard stage: ${PIN_STAGE:-<unset>}" >&2
  if [ -n "$PIN_DIAG" ]; then echo "  Diagnostic: $PIN_DIAG" >&2; fi
  echo "  No writes or commits are permitted from this checkout. HALT and report; recovery is an" >&2
  echo "  orchestrator/human decision. Only the IMMEDIATE submodule of the pinned checkout is a" >&2
  echo "  legitimate other cwd — nested submodules must surface as a blocker, not self-route." >&2
  exit 1
}
# Backslash comparator, generated at runtime: a backslash written twice in this
# script does not survive the Windows spawn path into bash (the command-line
# round-trip halves the doubled form), which rejected every C:\ pin at the form
# gate on the #4254 CI Windows legs. printf's octal escape is a lone backslash,
# which does survive; the quoted expansion below is literal in a case pattern.
BS=$(printf '\134')
# Fail closed if the comparator could not be generated: an empty BS would widen
# the drive-form arm below to drive-RELATIVE pins (C:foo) — the one fail-open
# seam in this construction, closed loudly rather than trusted to the shell.
if [ -z "$BS" ]; then
  PIN_STAGE=form-gate
  PIN_DIAG='backslash comparator generation failed (printf octal escape returned empty)'
  gsd_pin_fail
fi
case "$PINNED_ROOT" in
  ''|'{PINNED_ROOT}') PIN_STAGE=pin-unbound; gsd_pin_fail ;;  # empty or unexpanded pin — fail closed, never warn-and-proceed
  /*) ;;                                                     # absolute POSIX form
  [A-Za-z]:/*|[A-Za-z]:"$BS"*) ;;                            # Windows drive form, forward- or backslash-separated
  *) PIN_STAGE=form-gate; gsd_pin_fail ;;                    # relative pin — never trustworthy across cwds
esac
ACTUAL_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$ACTUAL_ROOT" ]; then
  PIN_STAGE=actual-capture
  PIN_DIAG="git rev-parse --show-toplevel from the cwd failed: $(git rev-parse --show-toplevel 2>&1 1>/dev/null)"
  gsd_pin_fail
fi
PINNED_TL=$(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>/dev/null)
if [ -z "$PINNED_TL" ]; then
  PIN_STAGE=pinned-capture
  PIN_DIAG="git -C <pinned root> rev-parse --show-toplevel failed: $(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>&1 1>/dev/null)"
  gsd_pin_fail
fi
if [ "$ACTUAL_ROOT" != "$PINNED_TL" ]; then
  # Registered-submodule allowance: sub_repos plans legitimately commit inside an
  # immediate submodule of the pinned checkout. The superproject working tree is
  # git-emitted in the same representation as PINNED_TL, so the equality is
  # representation-safe on every platform.
  SUPER_TL=$(git rev-parse --show-superproject-working-tree 2>/dev/null)
  if [ "$SUPER_TL" != "$PINNED_TL" ]; then
    PIN_STAGE=root-mismatch
    PIN_DIAG="actual=${ACTUAL_ROOT} pinned=${PINNED_TL} superproject=${SUPER_TL:-<none>}"
    gsd_pin_fail
  fi
fi
