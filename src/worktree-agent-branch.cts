/**
 * worktree-agent-branch.cts — the two branch-name policies every worktree
 * guard shares (ADR-5211). One owner, so the spawn-time branch check, the
 * pre-commit check and the wave-cleanup manifest validation cannot drift.
 *
 * - AGENT_BRANCH_RE: the per-agent namespace a sub-agent's worktree must be on —
 *   `agent-<id>` (Claude Code's `isolation="worktree"`), the legacy
 *   `worktree-agent-<id>`, and `worktree-wf_<runid>` (#3021, the Workflow
 *   tool). Positive allow-list (#2924, #1995): a deny-list silently admits
 *   `feature/*` and every other arbitrary branch.
 * - FALLBACK_PROTECTED_BRANCH_RE: the five names treated as protected when the
 *   configured protected-branch answer cannot be read (#3819) — never the
 *   primary source, which is `resolveProtectedBranchStatus` in
 *   git-base-branch.cts.
 */

export const AGENT_BRANCH_RE = /^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$/;

export const FALLBACK_PROTECTED_BRANCH_RE = /^(main|master|develop|trunk|release\/.*)$/;
