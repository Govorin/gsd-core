# ADR-5210: Fork additions to agent tools are declared by a capability and applied at install

- **Status:** Accepted — fork-local (mn fork, 2026-10-26); implemented in `capabilities/mn-code-navigation/capability.json`, `src/mn-agent-tools.cts` and two lines of `src/install-profiles.cts`.
- **Date:** 2026-10-26
- **Issue:** none — the fork files no upstream issues; the number follows ADR-5209. The open question it closes is in `.plans/mn-fork-worklog.md` (the upstream 1.18 sync, "Not done here, owner decision", option 1).
- **Amends:** nothing. Narrows how this fork reads [ADR-1244](1244-capability-ecosystem.md) D2 for first-party capabilities (§4). Builds on [ADR-857](857-capability-system.md) and [ADR-894](894-capability-declaration-format.md) (capability declaration), and on upstream #4032 (`agent_tools`, `appendAgentTools`).
- **Supersedes:** nothing.
- **Amended:** 2026-11-01 — `agentTools.reference`, a pointer line to a shipped reference (second user: `capabilities/mn-nx-tasks`); see the amendment at the end.

## Context

The fork grants three code-navigation MCP families (`mcp__atlas__*`, `mcp__plugin_serena_serena__*`, `mcp__codebase-memory-mcp__*`) to the 37 agents that read code. Until now it wrote them into the `tools:` line of each agent file: 63 files in `agents/` (37 agents and 26 `.compact` variants), plus a suffix constant in `scripts/research-profiles.cjs` for the seven generated research agents.

That cost two things:

- **A conflict on every upstream `tools:` change.** Upstream edits those lines routinely; each edit conflicts with the fork's suffix in every touched file.
- **Bytes the fork does not have.** `agents/gsd-verifier.md` is upstream's largest agent: 49 109 B against the LARGE cap of 49 152 (`tests/agent-size-budget.test.cjs`). The suffix alone is +74 B, so the fork's verifier was 50 045 B and the size test was red. Raising the cap or cutting upstream text were both refused.

Upstream already has an install-time mechanism for extra grants: `agent_tools` (#4032) in `~/.gsd/defaults.json` or `.planning/config.json`, appended by `appendAgentTools` before the runtime converter. It is user configuration, though: a fresh machine or a clean checkout would install agents without the grants, and nothing in the repository would say which agents need them.

## Decision

### 1. One declaration: `agentTools` in a first-party capability

A capability may carry

```json
"agentTools": { "grants": ["mcp__atlas__*", "..."], "agents": ["gsd-verifier", "..."] }
```

— the grant set and the agents it goes to, in one place. The fork's set lives in `capabilities/mn-code-navigation/capability.json`. The registry generator copies capability objects verbatim, so the field reaches the frozen `capability-registry.cjs` with no generator change, and `lint:generated-sync` keeps the two in step.

### 2. Applied by the staging step that already applies `agent_tools`

`stageAgentsForRuntimeWithConverter` builds the grant list for each agent file as: capability grants, then `agent_tools["*"]`, then `agent_tools[<agent>]`, and hands it to `appendAgentTools` before the runtime converter runs. Capability grants come first because that is where they sat when they were part of the frontmatter, so a user's `agent_tools` still lands after them. `appendAgentTools` skips a grant the line already has, so an upstream that adopts one of these tools does not get it twice. A `.compact` stem gets the grants of its agent.

The same function stages the agents for a fresh install and for a surface re-materialization from the installed corpus, so both carry the grants.

### 3. Runtime handling is the converter's, not the capability's

The capability declares `runtimeCompat: ["*"]` and gives no runtime list of its own. Each runtime converter already has a policy for MCP grants (see "Agent tool grants" in `docs/CONFIGURATION.md`). Claude, Copilot, Hermes, Kimi Code, Qwen and Codex's `.md` keep the names; Kilo turns them into `atlas_*: allow` permissions; ZCode, Kimi, Antigravity, Pi, OpenCode and the rules-based runtimes drop them. Those converters saw exactly these grants before, when they were in the canonical frontmatter, so every runtime's output is what it was. A second runtime list in the capability would be another copy of that policy, and the two could drift apart.

### 4. Only the frozen first-party registry is read

`src/mn-agent-tools.cts` reads `capability-registry.cjs`, never the installed overlay (`loadRegistry({ includeInstalled })`). ADR-1244 D2 rejects an overlay that claims a first-party agent, and `CONTEXT.md` (`### Live-DOM UAT Capability`) reads that as "no capability can grant tools to a first-party agent". This ADR keeps that rule for anything a user installs. It allows only grants that ship in the same reviewed tree as the agents.

### 5. One key turns it off

The capability's `activationKey`, `code_navigation.enabled` (default `true`; absent = enabled), is read the way `agent_tools` is: the nearest `.planning/config.json` first, then `$GSD_HOME/.gsd/defaults.json`, then the declared default. Only `false` disables it. As with `agent_tools`, the user re-runs the install after changing it.

### 6. The verifier's contract travels in its spawn prompt

`agents/gsd-verifier.md` still did not fit once the suffix was gone, because the fork's verifier contract (SPEC `AC-n` as truths, `truths_unproven` in the frontmatter, 862 B) was written into the agent body too. It moves to the phase-verification spawn prompt: `gsd-core/workflows/execute-phase/steps/verify-phase-goal.md` lists `gsd-core/references/verifier-spec-contract.md` in the prompt's `<required_reading>`. The agent's own `mandatory-initial-read.md` makes it read every file listed there. The agent file is now upstream's bytes. Quick and quick-batch verifications are not handed the reference: `truths_unproven` is read only by the `ship:pre` gate (`mn-verify-gate`), and only phases ship.

## Consequences

- `agents/*.md` and `scripts/research-profiles.cjs` match upstream in every `tools:` line. The seven fork-only agents lost the suffix too, so the set is declared in one place. `docs/reference/agents.md` rows follow the canonical lines (`tests/agent-classification-parity.test.cjs`).
- The installed corpus `<config>/gsd-core/agents/` now holds the canonical lines without the grants. It is staging input, not model-facing, and re-materialization re-applies the grants.
- Proof of parity: a full install of all 19 families (18 runtimes plus Claude local) before and after this change differs only in the verifier (whose body moved) and in the corpus, lib, reference, workflow and manifest files that carry the change. Every other installed agent is byte-identical, and the `tools:` set of every model-facing agent is unchanged, the verifier's included.
- Adding a grant to an agent is now an edit to `agentTools.agents`. `tests/mn-code-navigation.install.test.cjs` fails if a canonical agent declares a grant the capability owns, or if a listed agent does not exist or has no `tools:` key.
- The verifier contract is now a fork diff in `verify-phase-goal.md` (one line) instead of in `agents/gsd-verifier.md` (three blocks). A future upstream rewrite of that spawn prompt has to carry the line. `tests/mn-verifier-contract-pointer.test.cjs` fails if the line is lost.
- A Claude Code plugin install takes no agents from the package (`.claude-plugin/plugin.json` ships only skills), so no install path skips the staging step.

## Amendment (2026-11-01): a block may name the reference that says when to use its grants

A grant gives an agent a tool; it does not tell the agent when to reach for it. The code-navigation families did not need that, because the global instructions already route structural questions to them. The second capability, `mn-nx-tasks` (`mcp__nx-tasks__*`, the screens of the Nx runs the user has going in a terminal), does: an executor that never thinks to read the watcher's output gains nothing from the grant.

The obvious carriers each fail one way:

- **Inlining into `agents/*.md`** is what this ADR moved away from: a fork diff in upstream files, and bytes `gsd-verifier` (49 109 B of a 49 152 B cap) does not have.
- **A `contributions` fragment** reaches only the roles a loop point publishes (`executor`, `verifier`, …). `gsd-debugger` and `gsd-dom-verifier` are not among them, and a contribution is gated by a config key at render time, not by whether the grant was installed.
- **A line in each spawn prompt** means one edit per workflow that spawns the agent (execute-phase, quick, quick-batch, debug, …), each under its own size budget, and none of them knows whether the grant was installed.

**Decision.** `agentTools` takes an optional `reference`: a file name directly in `gsd-core/references/` (`/^[a-z0-9][a-z0-9-]*\.md$/`). Each agent that gets the block's grants also gets one line at the end of its body:

```
**Granted at install:** if your tools include `mcp__nx-tasks__*`, Read `~/.claude/gsd-core/references/nx-live-stack.md` before you start; it says when to use them.
```

- The line is rendered by `src/mn-agent-tools.cts` from the grants and the file name; a capability cannot inject free text into a first-party agent.
- It is appended in `stageAgentsForRuntimeWithConverter` right after section composition, before the path rewrites, so each runtime gets its own path (an absolute `<config>/gsd-core/references/…` for a Claude install, `__GSD_PI_ENGINE_ROOT__/…` in the Pi package). It applies on the no-`agentCtx` path too, like the grants.
- It rides the block's activation key: grant and pointer land together and are dropped together. A malformed `reference` voids the whole block, grants included, as a malformed grant does.
- Several blocks with references give several lines, in capability id order. A block without `reference` adds nothing to the body, so `mn-code-navigation`'s emitted agents are byte-identical.
- The pointer stays on runtimes whose converter drops the grant (ZCode, Pi, OpenCode, the rules-based ones). It is worded as a condition on the agent's own tool list, so there it is a no-op instruction of about 170 B; filtering it per runtime would be a second copy of each converter's MCP policy (§3).

**Consequences.** A granted agent pays one Read of the reference per spawn (`nx-live-stack.md`, 2.2 KB) when the tools are present; the reference opens with the cheapest check (`nx_running_tasks`) and says to stop when it lists no run. `tests/mn-nx-tasks.install.test.cjs` pins the declaration, the rendering, the staging order (code navigation, then nx-tasks, then the user's `agent_tools`) and the installed Claude agents with the key on and off.
