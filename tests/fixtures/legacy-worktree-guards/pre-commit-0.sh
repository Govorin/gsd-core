HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")
ACTUAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$HEAD_REF" = "DETACHED" ]; then
  echo "FATAL: refusing to commit — HEAD is detached." >&2
  exit 1
fi
# #3819: real default branch; override git.allow_default_branch_commits; else five-name fallback.
IS_PROTECTED=$(gsd_run query git.base-branch --is-protected "$ACTUAL_BRANCH" 2>/dev/null) || IS_PROTECTED="__GSD_RUN_UNAVAILABLE__"
if [ "$IS_PROTECTED" = "__GSD_RUN_UNAVAILABLE__" ] || [ -z "$IS_PROTECTED" ]; then
  if echo "$ACTUAL_BRANCH" | grep -Eq '^(main|master|develop|trunk|release/.*)$'; then
    IS_PROTECTED="true"
  else
    IS_PROTECTED="false"
  fi
fi
if [ "$IS_PROTECTED" != "false" ]; then
  echo "FATAL: refusing to commit — HEAD is on '$ACTUAL_BRANCH' (protected/default branch)." >&2
  echo "Re-home onto a phase/agent branch (#2924, #3819); override: git.allow_default_branch_commits:true in .planning/config.json." >&2
  exit 1
fi
# #4799: set SEQUENTIAL=true ONLY if your prompt has a `<sequential_execution>` block (the
# orchestrator dispatched you onto its own working tree, which may be a linked phase worktree on
# the configured branch). Otherwise leave it false: the allow-list below applies (fails closed).
SEQUENTIAL=false
if [ -f .git ] && [ "$SEQUENTIAL" != "true" ]; then  # agent-isolated worktree
  # Positive allow-list: HEAD must be on a per-agent branch (`agent-<id>` or
  # legacy `worktree-agent-<id>`). This catches feature/* and any other
  # arbitrary branch that the deny-list would silently allow (#2924, #1995).
  if ! echo "$ACTUAL_BRANCH" | grep -Eq '^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$'; then
    echo "FATAL: refusing to commit — worktree HEAD '$ACTUAL_BRANCH' is not in the agent-* / worktree-agent-* / worktree-wf_* namespace." >&2
    echo "Agent commits must live on per-agent branches; surface as blocker (#2924)." >&2
    exit 1
  fi
fi
