# Anthropic harness guidance — state as of 2026-08-20

Research report. Sources: anthropic.com/engineering, claude.com/blog, code.claude.com/docs, platform.claude.com/docs, anthropic.com/news. Every item lists status (GA / beta / experimental / research preview) as stated by the source.

---

## 1. Anthropic engineering / Claude blog posts (Sep 2025 → Aug 2026)

Chronological index (verified against the engineering archive page):

| Date | Title | URL |
|---|---|---|
| 2025-09-11 | Writing effective tools for agents — with agents | https://www.anthropic.com/engineering/writing-tools-for-agents |
| 2025-09-29 | Effective context engineering for AI agents | https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents |
| 2025-10-16 | Equipping agents for the real world with Agent Skills | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills |
| 2025-10-20 | Beyond permission prompts: Claude Code sandboxing | https://www.anthropic.com/engineering/claude-code-sandboxing |
| 2025-11-04 | Code execution with MCP | https://www.anthropic.com/engineering/code-execution-with-mcp |
| 2025-11-24 | Advanced tool use on the Claude Developer Platform | https://www.anthropic.com/engineering/advanced-tool-use |
| 2025-11-26 | Effective harnesses for long-running agents | https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents |
| 2026-01-09 | Demystifying evals for AI agents | https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents |
| 2026-01-21 | Designing AI-resistant technical evaluations | https://www.anthropic.com/engineering/AI-resistant-technical-evaluations |
| 2026-02-05 | Building a C compiler with a team of parallel Claudes | https://www.anthropic.com/engineering/building-c-compiler |
| 2026-02-05 | Quantifying infrastructure noise in agentic coding evals | https://www.anthropic.com/engineering/infrastructure-noise |
| 2026-03-06 | Eval awareness in Opus 4.6's BrowseComp performance | https://www.anthropic.com/engineering/eval-awareness-browsecomp |
| 2026-03-24 | Harness design for long-running application development | https://www.anthropic.com/engineering/harness-design-long-running-apps |
| 2026-03-25 | How we built Claude Code auto mode | https://www.anthropic.com/engineering/claude-code-auto-mode |
| 2026-04-08 | Scaling Managed Agents: decoupling the brain from the hands | https://www.anthropic.com/engineering/managed-agents |
| 2026-04-10 | Seeing like an agent: how we design tools in Claude Code | https://claude.com/blog/seeing-like-an-agent |
| 2026-04-23 | An update on recent Claude Code quality reports (postmortem) | https://www.anthropic.com/engineering/april-23-postmortem |
| 2026-04-30 | Lessons from building Claude Code: Prompt caching is everything | https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything |
| 2026-05-25 | How we contain Claude across products | https://www.anthropic.com/engineering/how-we-contain-claude |
| 2026-06-02 | A harness for every task: dynamic workflows in Claude Code | https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code |
| 2026-06-03 | Lessons from building Claude Code: How we use skills | https://claude.com/blog/lessons-from-building-claude-code-how-we-use-skills |
| 2026-07-07 | Choosing a Claude model and effort level in Claude Code | https://claude.com/blog/claude-model-and-effort-level-in-claude-code |

### 1.1 Effective harnesses for long-running agents (2025-11-26)
- **Initializer / coding-agent split.** First session sets up environment; later sessions make incremental progress. *Why:* each session starts with no memory.
- **`claude-progress.txt` + git log as institutional memory**; startup routine = read progress file → read git log → read feature list → run basic e2e smoke → then work.
- **Feature list in JSON, not Markdown.** "The model is less likely to inappropriately change or overwrite JSON files compared to Markdown files." 200+ features initially marked `failing`.
- **One feature at a time**; counters the tendency to "one-shot the app" and declare premature completion.
- **Mandatory e2e test (browser automation/Puppeteer MCP) before marking a feature passing**; agents previously marked features complete "without proper testing".
- **`init.sh`** for deterministic dev-server start. Git commits with descriptive messages; revert is a first-class recovery path.

### 1.2 Harness design for long-running application development (2026-03-24)
- **Planner → Generator → Evaluator** (three agents). Evaluator drives the running app with **Playwright MCP**, not static screenshots.
- **Separate evaluator beats self-evaluation.** "Tuning a standalone evaluator to be skeptical is far more tractable than making a generator critical of its own work." Generators "confidently praise" mediocre work.
- **Sprint contracts**: generator & evaluator negotiate success criteria *before* implementation.
- **Context resets > compaction** to avoid "context anxiety" (premature wrap-up as the window fills). Crucial on Sonnet 4.5, less so on Opus 4.6.
- **Files as the inter-agent bus** (structured handoff artifacts), not context passing.
- **Subjective → gradable**: four frontend criteria (design quality, originality, craft, functionality).
- **Stress-test every harness component against new models.** "Every component in a harness encodes an assumption about what the model can't do on its own." Sprint decomposition was removed for Opus 4.6.
- Numbers: solo agent 20 min/$9 (broken) vs harness 6 h/$200 (working); DAW build 3h50m, $124.70.

### 1.3 Scaling Managed Agents: brain / hands / session (2026-04-08)
- Three independently swappable components: **harness (brain, stateless)**, **sandbox (hands, `execute(name,input)→string`)**, **session (append-only event log)**.
- Harness recovers via `wake(sessionId)`/`getSession(id)`; every step persisted with `emitEvent`. Container failures surface as **tool-call errors Claude handles natively**.
- **Credential vaults**: tokens never reachable from generated code; OAuth via MCP proxy.
- Decoupling provisioning from inference: TTFT −60% p50, −90%+ p95.
- Guidance: "Design interfaces around Claude's capabilities… Expect models to outgrow assumptions encoded in harnesses."

### 1.4 Building a C compiler with parallel Claudes (2026-02-05)
- 16 agents, Docker containers, **lock-file task claiming in `current_tasks/`** with git as the mutex.
- "**It's important that the task verifier is nearly perfect, otherwise Claude will solve the wrong problem.**"
- Grep-friendly error output + summary stats to avoid context pollution; READMEs/progress files as shared memory.
- Use an **oracle** (GCC) to split a monolithic task into parallelizable sub-problems.
- 100k LOC Rust, ~2,000 sessions, $20k, 2B input / 140M output tokens, 99% test pass.

### 1.5 Demystifying evals for AI agents (2026-01-09)
- Vocabulary: task, trial, grader, transcript/trajectory, outcome. Grader types: code-based, model-based, human.
- **Start with 20–50 tasks drawn from real failures.** "A good task is one where two domain experts would independently reach the same pass/fail verdict."
- **Grade outcomes, not paths.** Balanced sets (should-do / should-not-do). Clean isolated environments per trial.
- **pass@k vs pass^k** — use pass^k when consistency matters.
- Coding agents: deterministic "tests pass?" + transcript rubric (tool-usage quality).
- Companion: *Quantifying infrastructure noise in agentic coding evals* (2026-02-05) — infra flakiness is a real confound; *AI-resistant technical evaluations* (2026-01-21).

### 1.6 Effective context engineering (2025-09-29)
- "Smallest set of high-signal tokens that maximize the likelihood of your desired outcome."
- System prompt at the right **altitude**; **just-in-time retrieval** via lightweight identifiers; **compaction** (lightest touch = clear old tool results); **structured note-taking** outside context; **sub-agents with clean windows returning condensed summaries**; few canonical examples over exhaustive edge cases.

### 1.7 Writing tools for agents (2025-09-11) + Seeing like an agent (2026-04-10)
- Don't wrap APIs 1:1; build few, intentional, namespaced tools; return semantic context (names not UUIDs); `response_format: concise|detailed`; pagination/truncation with helpful errors; descriptions as onboarding docs; **agent-driven eval loop** to refine descriptions ("even small refinements … dramatic improvements").
- Claude Code has ~20 tools; "the bar to add a new tool is high". Shape tools to observed model ability (AskUserQuestion, TodoWrite→Tasks, deferred tool loading/ToolSearch, progressive disclosure instead of new tools). Admitted mistakes: bundling incompatible requests, fragile output parsing, over-reliance on system reminders.

### 1.8 Agent Skills (2025-10-16; open standard 2025-12-18) + How we use skills (2026-06-03)
- `SKILL.md` + **three-level progressive disclosure** (metadata → body → referenced files).
- Name/description drive triggering; "descriptions should trigger agent recognition, not explain for humans"; include trigger words.
- "**The highest-signal content in any skill is the Gotchas section.**" Don't state the obvious; avoid railroading; one skill = one job (nine categories); persist state via `${CLAUDE_PLUGIN_DATA}`.
- Security: audit bundled code; beware instructions that fetch untrusted network sources.

### 1.9 Auto mode (2026-03-25) + How we contain Claude (2026-05-25)
- Auto mode: server-side prompt-injection probe on tool outputs + two-stage transcript classifier; **assistant text stripped** so the agent can't argue the classifier into approving. FP 0.4%, FN 17% on real over-eager actions. Prompts reduced 84%.
- Containment: environment layer (sandbox/VM/egress) is primary; model-layer defenses are probabilistic. "Allow reads, require approval for write, bash, and network." Defer all config/hook execution until after workspace trust. Treat every external input (connectors, tool output, remote MCP) as attack surface.

### 1.10 April 23 postmortem (2026-04-23) — harness-level lessons
- Root causes: default effort silently moved high→medium (Mar 4, reverted Apr 7); a cache/"clear idle reasoning" optimization that fired **every turn** instead of once (context loss); a "≤25 words between tool calls" prompt constraint that degraded coding.
- Lessons: broader eval suite + **ablation tests for every system-prompt change**, soak periods, staff dogfooding the exact public build, audit trail for prompt edits.

### 1.11 Prompt caching is everything (2026-04-30)
- Static prefix first (system, tools), dynamic last. **Updates go in messages, never in the system prompt.** Never add/remove tools mid-conversation → use `defer_loading` stubs; model state transitions (plan mode) with tools/messages. Cache-safe compaction: summarization request reuses the identical prefix.

### 1.12 A harness for every task: dynamic workflows (2026-06-02)
- Long single-context runs suffer premature abandonment, self-preference bias, loss of objective fidelity. Workflows = Claude writes a JS harness per task. Quality patterns: **adversarial verification, judge panel, loop-until-dry, pipeline vs barrier**. Caveat: "most traditional coding tasks do not need a panel of 5 reviewers."

### 1.13 Model & effort choice (2026-07-07)
- "Model choice determines capability; effort level controls thoroughness." Effort controls "how many files it reads; how much it verifies; how far it pushes". Diagnostic: wrong answer → knowledge gap (bigger model) vs effort gap (raise effort). Use the model default effort for most work.

---

## 2. Claude Code features (2026) — status and citations

Docs root: https://code.claude.com/docs ; changelog: https://code.claude.com/docs/en/changelog

### 2.1 Hooks — 31 events (GA)
Source: https://code.claude.com/docs/en/hooks
Events: SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Stop, SubagentStart, SubagentStop, TeammateIdle, TaskCreated, TaskCompleted, StopFailure, Notification, MessageDisplay, ConfigChange, CwdChanged, DirectoryAdded (v2.1.214), FileChanged, InstructionsLoaded, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd.
Hook types: `command`, `http`, `prompt`, `agent`, `mcp_tool`. Control fields: `permissionDecision allow|deny|escalate`, `updatedInput`, `additionalContext`, `continue:false`, `retry` (PermissionDenied). Exit 2 = block. Hook payload now carries `effort.level` and `permission_mode`. Hooks can be declared in skill/agent frontmatter (`once` option). Docs: "To block an action regardless of what Claude decides, use a PreToolUse hook" — CLAUDE.md is context, hooks are enforcement.

### 2.2 Subagents (GA) — https://code.claude.com/docs/en/sub-agents
- Frontmatter: `model` (incl. `fable`), `effort`, `tools`/`disallowedTools`, `permissionMode`, `maxTurns`, `memory: user|project|local`, `isolation: worktree`, `skills` (preloaded), `mcpServers`, `hooks`, `background`, `initialPrompt`.
- **Fork subagent** (`Agent(fork)`, `/subtask` v2.1.212) inherits full conversation + **shares parent prompt cache**; on by default in interactive sessions since v2.1.232.
- Caps: 200 spawns/session (`CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`), 20 concurrent (v2.1.217), nesting depth 3 (v2.1.219). Output scanning of subagent results (v2.1.210). Resume via `SendMessage`. `--append-subagent-system-prompt` (v2.1.205).
- Non-fork subagents get CLAUDE.md + git snapshot + preloaded skills; **not** conversation history or parent auto-memory.

### 2.3 Skills (GA) — https://code.claude.com/docs/en/skills
- Commands merged into skills. Frontmatter: `context: fork`, `agent`, `background` (v2.1.218), `effort`, `model`, `allowed-tools`, `paths`, `disable-model-invocation`, `user-invocable`, `hooks`, `argument-hint`, `shell`.
- Bundled skills: `/doctor` (v2.1.205+; proposes CLAUDE.md trims, flags slow hooks), `/code-review`, `/batch` (5–30 units in worktrees), `/debug`, `/loop`, `/verify` (invoke-only since v2.1.215), `/claude-api`.
- **Evals**: documented path is the official `skill-creator` plugin — `evals/evals.json`, subagent per case, `grading.json`, `benchmark.json` (with/without-skill), blind A/B, should/should-not-trigger description tuning, HTML review viewer. Blog: https://claude.com/blog/improving-skill-creator-test-measure-and-refine-agent-skills
- **`claude plugin eval` / `/skill-doctor`**: referenced in-product (the built-in `claude-code-guide` agent lists "`claude plugin eval` … sandbox, CI, early-access enablement" and "the `/skill-doctor` report"), but **no public doc page found on code.claude.com as of 2026-08-20**; `/skill-doctor` is shipped via `anthropics/claude-plugins-community`. Treat as **early access / community**, not GA. `claude plugin validate [--strict]` (v2.1.233) *is* documented.

### 2.4 Plugins (GA) — https://code.claude.com/docs/en/plugins-reference
Component types: skills, agents, hooks, MCP servers, LSP servers, **workflows**, monitors (experimental), themes (experimental). Plugin skills/agents/hooks append after the cached prefix (cache-safe); MCP servers only cache-safe when deferred.

### 2.5 Worktrees & isolation (GA)
`isolation: worktree` for subagents; `EnterWorktree`/`ExitWorktree` tools (v2.1.224); `/fork` creates a worktree (v2.1.221); v2.1.222 fixed isolated sessions running destructive git against main checkout. `WorktreeCreate/Remove` hooks let you replace git worktree creation. `/batch` uses worktrees per unit.

### 2.6 `/loop`, `/goal`, scheduling (GA) — https://code.claude.com/docs/en/scheduled-tasks , https://code.claude.com/docs/en/goal
- `/loop [interval] [prompt]`: fixed cron or **self-paced** via `ScheduleWakeup` (1 min–1 h, `stop:true`, `noop` collapsing, 20-min fallback wakeup). Bare `/loop` runs a maintenance prompt or `.claude/loop.md`. 7-day expiry, 50 tasks/session, jitter. `CronCreate/List/Delete`.
- `/goal <condition>`: **a session-scoped prompt-based Stop hook**; a small fast model (Haiku) judges met / not-yet / impossible after every turn; "completion is decided by a fresh model rather than the one doing the work." Background work defers evaluation; 30-min check-ins (v2.1.234). Works with `-p`.
- Cloud **Routines** (`/schedule`), Desktop scheduled tasks, **Channels** (push events into a session) exist as alternatives.

### 2.7 Workflow tool / dynamic workflows / ultracode (GA on paid plans; v2.1.154+) — https://code.claude.com/docs/en/workflows
- Claude writes a JS script; runtime executes it in background; primitives `agent()` (with `schema` for structured output), `pipeline()`, `parallel()`, `phase()`, `budget`, `workflow()` nesting, `args`. Caps: 16 concurrent, 1,000 agents/run; size guideline `small|medium|large|unrestricted` (default `medium` <15 agents since v2.1.219). Resumable via journal. Bundled `/deep-research` (v2.1.218).
- Opt-in: keyword `ultracode` (human-originated input only since v2.1.210), "use a workflow", or `/effort ultracode` (= xhigh + auto-orchestration; v2.1.203). Subagents always run `acceptEdits`. **Fan-out prompt-cache stagger** (`CLAUDE_CODE_WORKFLOW_PREFIX_STAGGER_MS`, 5 s). `/ultraplan` removed v2.1.222.

### 2.8 Background agents, tasks, remote control
- Non-teammate subagents run in background by default (v2.1.232); `/tasks`, `/fork` background sessions (v2.1.212) that commit/push (v2.1.221); MCP calls >2 min auto-background.
- **Remote Control** (`claude rc`): research preview, all plans, rolled out Feb 2026 (Max first); Trusted Devices beta June 2026; cross-session `SendMessage`/`ListAgents` (v2.1.224), `@session` mentions (v2.1.232). https://code.claude.com/docs/en/remote-control
- **Agent teams**: experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); shared task list with file-lock claiming; quality gates via `TeammateIdle`/`TaskCreated`/`TaskCompleted` hooks (exit 2 = send feedback, keep working). https://code.claude.com/docs/en/agent-teams

### 2.9 Checkpoints / rewind (GA) — https://code.claude.com/docs/en/checkpointing
Per-prompt snapshots (100 most recent); `/rewind` or Esc-Esc: restore code / conversation / both, **Summarize from here / up to here** (targeted compaction). Not tracked: Bash-made changes, most subagent edits, symlinks/hardlinks. Rewind is cache-friendly (truncates to a cached prefix).

### 2.10 Auto memory (GA) — https://code.claude.com/docs/en/memory
`~/.claude/projects/<project>/memory/MEMORY.md` index (first 200 lines / 25 KB loaded) + topic files on demand; shared across worktrees; `modified` frontmatter timestamp (v2.1.214); subagent memory via `memory:` field; disable with `autoMemoryEnabled:false` / `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. CLAUDE.md: target <200 lines, `.claude/rules/*.md` with `paths:` globs, `claudeMdExcludes`, `@imports`; project-root CLAUDE.md is re-injected after `/compact`, nested/path-scoped rules are not.

### 2.11 Models, effort, fast mode — https://code.claude.com/docs/en/model-config
- **Claude Fable 5 + Mythos 5**: announced 2026-06-09; Fable 5 GA ($10/$50 per Mtok), Mythos 5 limited access. Fable requires CC v2.1.170+, `/model fable` or `best` alias; bills to usage credits on some plans; automatic classifier fallback (bio→Opus 5, cyber→Opus 4.8). Memory access improved Fable's long-task performance "3× more than for Opus 4.8".
- **Claude Opus 5**: 2026-07-24, $5/$25, default in CC v2.1.219; **fast mode** ≈2.5× speed at 2× price (Opus 5 only; $10/$50). Sonnet 5 exists (auto-mode classifier default).
- **Effort**: `low|medium|high|xhigh|max` on Fable 5 / Opus 5 / Sonnet 5 / Opus 4.8 / 4.7; default `high` (Opus 4.7: `xhigh`). `max` session-only, "prone to overthinking". `ultracode` is a CC setting, not a model level. `ultrathink` keyword = in-context nudge only. Effort changes invalidate the cache (confirmation dialog). Org effort limits supported.
- **Advisor** tool (`/advisor`): consult a second model (e.g. Fable) for hard decisions; cache-safe (after breakpoint).
- Fallback model chains (`--fallback-model a,b`, max 3).

### 2.12 Prompt caching in Claude Code — https://code.claude.com/docs/en/prompt-caching
Invalidators: model switch, effort change, enabling fast mode, MCP connect/disconnect when tools not deferred, `alwaysLoad`, bare tool deny rules, compaction, upgrade. Safe: file edits, CLAUDE.md edits (don't apply until restart/compact), permission-mode change, skills/commands (appended), `/recap`, `/rewind`, subagents (own cache, **5-min TTL even on subscription**; forks share parent's). 1-h TTL automatic on subscriptions, `ENABLE_PROMPT_CACHING_1H=1` for API; drops to 5 min on usage credits. Cache scoped per machine+directory (worktrees don't share); SDK can suppress per-machine sections to share across fleets. Tip: "Pick your model and effort level at the top of a session, then save `/compact` for natural breaks."

---

## 3. Claude Agent SDK & Managed Agents

### 3.1 Agent SDK (GA; TS + Python) — https://code.claude.com/docs/en/agent-sdk/overview
- Same loop/tools/context management as Claude Code as a library: `query()`, hooks, subagents, MCP, permissions (`canUseTool`, permission modes), **sessions (resume / fork)**, skills/commands/memory loaded from `.claude/`, plugins by path, Workflow tool, `origin: {kind:"human"}` stamping (gates `ultracode` keyword), `applyFlagSettings()` (`effortLevel:"ultracode"`).
- **Structured outputs**: `outputFormat: {type:"json_schema"}` (draft-07; Zod `target:"draft-7"`/Pydantic); validated with retry; `error_max_structured_output_retries`; invalid schema fails at startup (v2.1.205). https://code.claude.com/docs/en/agent-sdk/structured-outputs
- Cost tracking exposes `cache_read_input_tokens` / `cache_creation_input_tokens`; guidance to share cache across machines. Other languages: `claude -p --output-format json`.

### 3.2 Managed Agents (beta, launched 2026-04; header `managed-agents-2026-04-01`) — https://platform.claude.com/docs/en/managed-agents/overview
- Primitives: **Agent** (model, prompt, tools, MCP, skills), **Environment** (cloud sandbox or **self-hosted sandbox** worker — Blaxel, E2B, GCP, Namespace, Superserve, Cloudflare, Daytona, Vercel guides), **Session** (durable event log, steer/interrupt, SSE), **Events** (`user.*`, `agent.*`, `session.*`, `span.*`, `system.message` mid-conversation privileged context), **Vaults** (per-user creds), **Budgets** (`session.usage`), **scheduled deployments**, **multiagent orchestration** (threads, coordinator).
- **Outcomes** (`user.define_outcome`: description + markdown rubric + `max_iterations` default 3 / max 20): harness provisions a **grader in a separate context window**; loop `needs_revision` → revise → `satisfied | max_iterations_reached | failed | interrupted`. Rubric tip: "explicit, gradeable criteria… vague criteria produce noisy evaluations." https://platform.claude.com/docs/en/managed-agents/define-outcomes
- **Memory stores** (header `agent-memory-2026-07-22`): mounted at `/mnt/memory/<slug>/`, ≤2,000 memories × 100 kB, ≤8 stores/session, `read_only|read_write`, immutable versions (30-day audit, redact), optimistic concurrency via `content_sha256`; **"dreaming"** consolidation sessions (research preview). Warning: read-write stores + untrusted input = prompt-injection persistence. https://platform.claude.com/docs/en/managed-agents/memory
- Built-in compaction and prompt caching; not ZDR/HIPAA-eligible (stateful).

---

## 4. Verification gates, "evidence over claims", evals, caching for long loops

| Practice | Where it is codified | Status |
|---|---|---|
| Separate grader/evaluator context, never self-grade | Harness design post (03/2026); Managed Agents Outcomes grader; `/goal` evaluator ("a fresh model rather than the one doing the work") | GA (CC), beta (MA) |
| Verifier quality is the ceiling — "nearly perfect" task verifier | C-compiler post (02/2026) | guidance |
| Gradable rubrics; two experts would agree | Evals post (01/2026); Outcomes rubric tips | guidance |
| Deterministic gates in hooks, not prose | Memory docs ("hooks execute … regardless of what Claude decides"); `TaskCompleted`/`TeammateIdle` exit-2 gates; `PreToolUse` deny | GA |
| E2E test before marking done | Long-running harness post (11/2025) | guidance |
| Adversarial verify / judge panel / loop-until-dry | Workflows docs + "harness for every task" | GA |
| Typed outputs instead of parsing prose | SDK structured outputs; `agent({schema})` in workflows | GA |
| Ablate and soak-test every prompt/harness change; eval on the public build | April 23 postmortem | guidance |
| Noise-aware evals (pass^k, infra noise, eval-awareness) | Jan–Mar 2026 eval posts | guidance |
| Stable prefix, updates-as-messages, deferred tools, cache-safe compaction, 1-h TTL, no mid-task model/effort switches, fork subagents to share cache, staggered fan-outs | Prompt-caching blog + CC caching docs + workflows docs | GA |
| Context resets over compaction for multi-hour work; files as handoff | Harness design post; Managed Agents sessions | guidance/beta |
| JSON for machine-owned state, Markdown for humans | Long-running harness post | guidance |

---

## 5. Top 15 harness practices by impact (mid-2026)

1. **Put the judge in a different context than the worker.** Standalone evaluator/grader (harness post, MA Outcomes, `/goal`). Self-evaluation is the documented #1 failure mode.
2. **Make the verifier near-perfect before scaling autonomy** — the agent will optimize for whatever the gate measures (C-compiler post).
3. **Enforce with hooks, instruct with CLAUDE.md.** `PreToolUse` deny/`updatedInput`, `TaskCompleted`/`TeammateIdle`/`Stop` exit-2 gates, `SubagentStop`. CLAUDE.md is "context, not enforced configuration".
4. **Design for prompt-cache stability**: fixed model+effort per session, deferred tools, updates as messages, skills appended not prepended, compaction at natural breaks, 1-h TTL, fork subagents / staggered fan-outs to share prefix.
5. **Fresh context per unit of work + file-based handoff** (progress file, JSON feature list, git log, `init.sh`); prefer **context reset** to compaction for multi-hour runs.
6. **One feature at a time, e2e-tested before marked done**; commit per feature; revert as recovery.
7. **Gradable rubrics with explicit per-criterion checks**; start with 20–50 real-failure tasks; grade outcomes not paths; use pass^k when reliability matters.
8. **Move orchestration into code when it exceeds one context** — Workflow scripts (`pipeline`/`parallel`/`schema`), with adversarial verify and loop-until-dry; keep workflows for high-value tasks only.
9. **Subagents with clean windows returning condensed, typed results**; cap tool access; `isolation: worktree` for parallel edits; nested depth ≤3.
10. **Progressive disclosure everywhere**: skills (3 levels), `.claude/rules` with `paths:`, MEMORY.md index ≤200 lines + topic files, ToolSearch/deferred tools, CLAUDE.md <200 lines.
11. **Few, intentional, well-described tools**; refine descriptions with an agent-driven eval loop; semantic returns; `response_format`; grep-friendly errors.
12. **Re-validate every harness assumption on each new model** (remove scaffolding the model no longer needs; Opus 4.6 dropped sprints; Fable 5 gets more from memory than Opus 4.8).
13. **Environment-layer containment first**: sandbox + egress control + credential vaults + defer hook/config execution until trust; treat tool outputs, MCP, connectors, teammate messages as untrusted; read-only memory stores for reference material.
14. **Ablate, soak, and dogfood every prompt/harness change** with a broad eval suite; log effort level and cache metrics (OTel) so regressions are observable.
15. **Bound autonomy explicitly**: `/goal` with measurable condition + turn/time clause, `max_iterations` on outcomes, subagent/workflow caps, 7-day loop expiry, budgets — and self-paced `/loop` (`ScheduleWakeup`) or Monitor instead of tight polling.
