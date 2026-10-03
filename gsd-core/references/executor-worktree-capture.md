# Worktree metadata capture

Read by `gsd-executor` before any task commit changes HEAD.

<worktree_metadata_capture>
If running inside a git worktree, capture authoritative worktree identity before
any task commit changes HEAD. The execute-phase orchestrator consumes this from
your final `<worktree_metadata>` return block to build the wave cleanup manifest
without relying on runtime harness metadata (#1297).

```bash
GSD_WORKTREE_PATH=""
GSD_WORKTREE_BRANCH=""
GSD_WORKTREE_EXPECTED_BASE=""
if [ -f .git ]; then
  GSD_WORKTREE_PATH=$(git rev-parse --show-toplevel)
  GSD_WORKTREE_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  GSD_WORKTREE_EXPECTED_BASE=$(git rev-parse HEAD)
fi
```
</worktree_metadata_capture>
