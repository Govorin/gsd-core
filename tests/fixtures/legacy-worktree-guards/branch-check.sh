HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")
ACTUAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$HEAD_REF" = "DETACHED" ] || echo "$ACTUAL_BRANCH" | grep -Eq '^(main|master|develop|trunk|release/.*)$'; then
  echo "FATAL: worktree HEAD on '$ACTUAL_BRANCH' (expected agent-* or worktree-agent-*); refusing to commit or self-recover via 'git update-ref' (#2924)." >&2
  exit 42
fi
if ! echo "$ACTUAL_BRANCH" | grep -Eq '^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$'; then
  echo "FATAL: worktree HEAD '$ACTUAL_BRANCH' is not in the agent-* / worktree-agent-* / worktree-wf_* namespace; refusing to commit (#2924)." >&2
  exit 42
fi
ACTUAL_BASE=$(git rev-parse HEAD)
EXPECTED_BASE_ALTERNATE="{EXPECTED_BASE_ALTERNATE}"
if [ "$ACTUAL_BASE" != "{EXPECTED_BASE}" ] && { [ -z "$EXPECTED_BASE_ALTERNATE" ] || [ "$ACTUAL_BASE" != "$EXPECTED_BASE_ALTERNATE" ]; }; then
  echo "FATAL: worktree base mismatch — HEAD is $ACTUAL_BASE, expected {EXPECTED_BASE}${EXPECTED_BASE_ALTERNATE:+ or $EXPECTED_BASE_ALTERNATE}. Orchestrator owns recovery; sub-agent refuses to rewrite the worktree (#48)." >&2
  exit 42
fi
