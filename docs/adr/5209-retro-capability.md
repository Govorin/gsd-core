# ADR-5209: The retro capability — local transcript reading, Claude-first, never self-applied

- **Status:** Accepted — fork-local (mn fork, 2026-10-05); implemented in `capabilities/retro/`, `src/retro-command-router.cts`, `src/retro-artifacts.cts` over `src/session-transcript.cts`, `src/retro-signals.cts`, `src/retro-inventory.cts`; amended 2026-10-25 (§9, the schedule: `src/retro-cadence.cts`)
- **Date:** 2026-10-05
- **Issue:** none — the fork files no upstream issues; the number follows ADR-5208. The design is `.plans/pocock-practices-design.md` §D3 and §G.
- **Amends:** nothing. Builds on [ADR-857](857-capability-system.md) (capability) and [ADR-959](959-capability-command-contribution.md) (the `retro` command family).
- **Supersedes:** nothing.

## Context

Nothing in GSD answers *what in the agent's environment made this session struggle*. `/gsd-forensics` diagnoses a failed workflow from git; `/gsd-extract-learnings` records knowledge about the product. Matt Pocock's `retro` skill (`mattpocock/skills`, `skills/engineering/retro/SKILL.md`, MIT) does answer it — from the session record, by category (navigation, automated checks, coding standards, steering files, tool economy, no-ops, information access) — with one idea worth keeping above all: **a mechanical mistake gets a deterministic check; standards belong to the reviewer, not to CLAUDE.md.**

Its documented limits are the ones this capability has to close: it sees one session, so it cannot remove a check that turned noisy; after a long session the model forgets the middle and invents generic advice under each category; it has no dry run for a proposed check. And a retro reads the most private artifact on the machine — the full session transcript.

## Decision

### 1. Code counts, the model judges, code checks the model

- **Deterministic:** `gsd-tools retro signals` (friction signals with pointers and redacted excerpts, scored against `retro.signal_threshold`), `retro inventory` (what checks exist and whether anything runs them), `retro prepare` (both, plus the journal state, into one bundle).
- **Model:** a fresh `gsd-retro-analyst` reads only the bundle — never a transcript — and writes candidates.
- **Deterministic again:** `retro candidates` drops every candidate that cites no ref the bundle actually carried (`unknown-signal`, `no-signal`), every judgement rule aimed at CLAUDE.md/AGENTS.md/GEMINI.md (`judgement-in-steering-file`), every mechanical or retire-check candidate without a `verify` command (`missing-verify`), and every patch outside the retro's patches directory. Dropped candidates are listed, never repaired. This is what turns "invents generic advice" from a hope into a rule.
- `gsd-finding-refuter` in `retro` mode runs each mechanical candidate's `verify`: the check must fire on the incident and stay silent on clean code — the dry run Pocock's skill lacks.

### 2. Candidate layout

| Category | Lands in | Route |
|---|---|---|
| `mechanical` | a check: project lint rule, hook, capability gate, `workflow.verify_gates`, test | `/gsd-quick` |
| `judgement` | the reviewer: `agent_skills.gsd-code-reviewer` skills — never a steering file | `/gsd-capture` |
| `navigation` | one pointer line / CONTEXT.md predicate | `/gsd-capture` |
| `environment` | settings, permissions, log or service access | `/gsd-capture` |
| `steering` | shrinking CLAUDE.md: move a rule out, delete a no-op | `/gsd-capture` |
| `retire-check` | removing a journaled check that stopped firing | `/gsd-quick` |

An existing check that nothing runs (`unwired-check`) and a class with no guardrail at all (`missing-guardrail`) are evidence on their own.

### 3. Privacy: local, read-only, redacted, bounded

- Transcripts are read from `~/.claude/projects/<encoded-project>/` (or `--sessions-dir`) and never written. A `--session` id is shape-checked and contained in the project's session directory before it is opened.
- Only `excerpt()` text leaves the reader: whitespace-collapsed, the home directory folded to `~`, credentials redacted (`secrets.redactSecretText`), capped at `retro.excerpt_chars`. Spilled `tool-results/` files are counted, never opened.
- The analyst's bundle lives in `.planning/retro/.work/`, which ignores itself: redacted excerpts are still transcript text and must not ride along when planning docs are committed. The report and candidates in `.planning/retro/` carry pointers (`file:line`) and the analyst's own words.
- Nothing is uploaded. `retro.enabled` (default `true`, the capability's activation key) turns the whole capability off; it is on by default because every read is local and read-only and nothing it produces is applied without a human.

### 4. Claude Code first; every other runtime degrades and says so

Only Claude Code has a transcript adapter. On any other runtime (`resolveRuntime`), and when a project has no recorded sessions, the signal report is `degraded` with the reason, and signals come from git (revert commits) and `.planning` (`gaps_found` verdicts) only. A degraded report is never presented as a clean, empty session.

### 5. Never applied automatically

A retro writes a report, a candidates file and proposed patches. A human picks a candidate; `/gsd-retro --apply <cand-id>` routes it to `/gsd-quick` or `/gsd-capture`, which make their own commits. Two reasons, both binding:

1. Upstream's experience: auto-installed hooks blocked good changes.
2. The fork's rule that no marker an agent can write exempts that agent from a check: an agent does not get to write the rules that bind it without a human.

`retro.auto: auto` does not weaken this. It licenses a loop point to *spawn the analyst* without asking; the candidates still wait for a human.

### 6. The lifecycle decision is a command, not a loop step (yet)

`gsd-tools retro signals --decide` answers `skip | suggest | auto`: `skip` when the capability is off, when `retro.auto` is `off` (no transcript is read), or when the score is below `retro.signal_threshold`; otherwise `retro.auto`'s mode, with the `/gsd-retro --session <id>` command and, for `suggest`, the one line to print. A smooth session stays silent. The capability wires it into the loop as two command steps, `retro stage` at `execute:post` (the end of `execute-phase`) and at `ship:post` (`when: retro.enabled`); the step's JSON carries the stage answer of `gsd-core/references/loop-hook-dispatch.md` (`decision`, `message`, `next: {skill: retro, args: --session <id>}`), so the host prints a suggestion or, on `auto`, starts `/gsd-retro` — whose candidates are still never applied. Since §9 the same answer also proposes a retro the schedule made due, and names its `trigger`.

### 7. The removal loop: `.planning/retro/CHECKS.json`

A check a human accepted is journaled — `id`, `kind`, the literal it prints when it fires (`match`), `acceptedAt`, and the retro, candidate and signal it came from (`retro checks record`). `retro checks` counts firings in the transcripts of the last `retro.check_stale_days` days (a hook event, or a failed/blocked tool result, carrying the literal). A check is a **removal candidate** only when it has not fired, was accepted at least that many days ago, and the transcripts read reach back the whole window. When no transcript could be read, every silent check is `unknown`: "never fired" and "not looked at" are different answers. Removal is a candidate like any other — the human decides. The journal sits under the planning root, not a workstream: the environment belongs to the repository.

### 8. Signals: what each detector counts, and how a session scores (calibrated 2026-10-05)

The first version summed `weight × units` over every signal. On a real orchestration session (93 subagents, about 9,800 tool calls) that came to 997 against a threshold of 8, and on the owner's corpus it suggested a retro for 30% of sessions — 48 of the 247 sessions with no user pushback at all. Length alone crossed the threshold, and four detectors counted normal work:

- **nav-streak** counted every Read/Grep since the last Edit, through test runs, commands and spawned agents. It now counts navigation calls (Read/Grep/Glob, read-only shell, structural MCP navigation: serena, codebase-memory, atlas, indexed search) with **nothing else in between**. Any other call or a user turn ends the streak. `nav_streak_min` 12.
- **revert** fired on any `git checkout --` / `restore` / `reset --hard` (366 times in the corpus). Most were restoring regenerated files or resetting worktree bases. It now fires on `git revert` (and `Revert "…"` commits), and on the others only when they cover the agent's **own uncommitted edits**. A `git commit` makes edits no longer the agent's to lose. Heredocs and quoted prose (commit messages, echoes) are not parsed as commands. 10 left in the corpus.
- **edit-churn** counted edits of one file. It now counts edits that **rewrite lines an earlier own edit of that file wrote**: the line is in the edit's old text and gone from its new text. Edits of different places, and anchoring a new edit on a line just written, are not churn. Failed and rejected edits change nothing and count for nothing. `edit_churn_min` 4.
- **repeated-call** counted the same call anywhere in the session. ListAgents, ReadNotifications and ScheduleWakeup alone were 1,389 of its 1,812 units. It now ignores polling tools and counts a call again only when **nothing was edited since**, so re-running a check after a fix is not a repetition. **reread** keys on the file *and range*, and a compaction resets it.
- **Subagents.** Behavioural kinds (`MAIN_ONLY_KINDS`: nav-streak, reread, edit-churn, repeated-call, revert) come from the main transcript only. A subagent's navigation and edit pattern is its assignment, and an orchestration multiplies it by the number of agents. Environment kinds (hooks, denials, repeated tool errors, API errors, verdicts) count from subagents too: it is the same environment.

The session score takes each kind's units as a **rate over the session volume, saturated**:

`kind score = weight × min(kind_cap, units × min(1, reference / volume))`

Volume is user turns for the user kinds (corrections, interrupts, rejections; `volume_turns` 20), main tool calls for the behavioural kinds, and all tool calls for the rest (`volume_calls` 300). `kind_cap` is 3. Up to the reference volume a session scores its units as they are. A longer one scores the same rate, so length alone cannot cross the threshold, and one cause (a broken hook firing on every call) adds at most three weights. Per-signal `score` stays `weight × units`. The report adds `rawScore`, the old plain sum, so the effect of the rate and the cap is visible.

**Calibration.** The corpus is the owner's 315 Claude Code sessions, 292 of them with at least 5 tool calls. A session is labelled "strong friction" when the user pushed back explicitly: a correction, an interrupt or a rejected tool call (45 sessions). The detector mins sit near the 90th percentile of what each fixed detector sees. Rewrites per file: q90 4. Navigation run: q93 12. The references sit near the 90th percentile of session volume: 19 user turns, 342 main tool calls. With `signal_threshold` left at 8, a retro is suggested for 31 of 292 sessions (10.6%, down from 89, or 30.5%). That covers 30 of the 45 strong-friction sessions and 1 of the 247 without (0.4%, down from 48). The strong sessions it misses have one or two pushbacks in an otherwise smooth session, or pushbacks spread thin over a long dialogue. The orchestration session above, still growing, scores 5.78 at the last check (`rawScore` 93): below the threshold. The label uses the same user signals that the score counts, so this is a consistency check on the noise, not an independent ground truth. Recalibrate when the detectors change.

### 9. Amendment (2026-10-25): a retro is also due on a schedule

§6 proposes a retro only when a session struggled. A run of smooth phases never crosses the threshold, yet the environment drifts all the same: a journaled check goes silent (§7 needs a retro to propose its removal), a new script is never wired, a milestone starts on a kind of change no guardrail covers. The owner asked for retros at two moments regardless of friction: once a milestone is planned, before its first phase, and every two or three phases. This amends §6 and keeps §5: the schedule decides that a retro is *due*, `retro.auto` still decides what happens (suggest, auto, off), and nothing is applied.

**Triggers.** The stage answer carries `trigger` (`signals`, `milestone-start`, `cadence`; null on skip) and `triggers` (every one that fired). Friction wins when both fire, and its answer is unchanged.

- `milestone-start`: the current milestone has ROADMAP phases, none has started executing (no phase `executed`, `complete` or `partial`), it has not shipped (heading marker or `milestones/<v>-ROADMAP.md` snapshot), and no retro has been held in it. `retro.at_milestone_start` (boolean, default `true`).
- `cadence`: at least `retro.cadence_phases` phases of the current milestone finished executing since the last retro held in it (default `3`; `0` switches it off). A phase counts once every plan has a summary (`executed` or `complete`). `execute:post` runs before the verifier marks a phase complete, and the phase that just ran must count there. With no retro in the milestone the count runs from the milestone's start. A shipped milestone is never due by count: the next milestone's start covers the boundary.

**"Since the last retro" is journaled.** `retro prepare` appends a run to `.planning/retro/RUNS.json`: `stem`, `at` (ISO UTC), `planningDir`, `milestone`, and the phase numbers of that milestone executed at that moment. The count is the set difference between the phases executed now and that snapshot. Deriving it from existing artifacts was considered first and rejected. A RETRO stem carries a date and no time, and several phases finish in one day. Mtimes are reset by every clone and checkout. A retro that found nothing writes no report at all (`retro.md` stops at "Nothing to retro"), yet it was held and the count must restart from it. The run is recorded when the deterministic pass runs, so a manual `/gsd-retro` restarts the count too. A journal that is invalid, or carries a malformed entry, is never rewritten: the run is reported as not recorded, and the history the count depends on survives. Such a journal also fails closed on the read side: nothing is counted from it, neither trigger fires, the counts and `lastRetro` are null, `baseline` is `unknown`, and the reason is `journal-invalid` — never "no retro yet", which would propose a retro on every stage while the retro it proposed could not be journaled to clear it. The stage then answers `suggest` with a message naming the journal, no command and no `next`, in either mode, and the journal problems are in its top-level `problems`. The read-append-write runs under a lock (`.planning/retro/.RUNS.lock`, the shared `capability-lock` primitive, as for the broken-windows ledger): the journal is shared by every workstream, and two `retro prepare` at once would otherwise lose a run. A lock that cannot be had writes nothing and says so.

**Workstreams.** Each planning directory (workstream) keeps its own schedule. The stage reads the workstream named by `--ws`, `GSD_WORKSTREAM` or the active pointer, and every command it proposes carries `--ws <name>`, so the retro it starts journals the same planning directory and restarts that count. `new-milestone` keeps `.planning/.gsd-ws-arg` until its roadmap hooks (step 10.6) have run and passes `--ws` to `loop render-hooks roadmap:post` and to the `ref.command`; `new-project` takes no workstream.

**Where it is checked.** `retro stage` at `execute:post` (cadence) and at a new point, `roadmap:post`, hosted by `new-milestone` and, for a project's first milestone, `new-project` (milestone-start; `when: retro.at_milestone_start`; ADR-857 amendment 2026-10-25). A scheduled retro's command reaches back to the last one, `--since <at of the last run>`, so git and planning evidence cover the whole stretch, not only the newest session (`--since` takes an ISO instant with its offset, the form `at` is journaled in).

**Once per phase, not once per stage.** `ship:post` runs `retro stage signals`: friction only. No phase executes between a phase's `execute:post` and its `ship:post`, so a schedule answer there could only repeat the line `execute:post` printed for the same phase. While a retro stays due and is not held, `suggest` repeats at the next phase's `execute:post`, deliberately: the schedule says a retro is owed, and one line per phase is the reminder; holding the retro (or setting `retro.auto: off`) is what clears it. Suppressing that too would need the stage to write state and would turn a due retro into one the user saw once and never again.

**`gsd-tools retro due`** is the schedule alone: read-only, no transcript read, one stable JSON shape whatever the config. It carries `due`, `trigger`, `triggers`, `reason` (`capability-disabled`, `retro-auto-off`, `no-roadmap`, `milestone-shipped`, `journal-invalid`, `milestone-start`, `cadence-reached`, `not-due`), the counts, the last journaled run and the newest report on disk. `retro.auto: off` and a disabled capability set `due: false` and keep the counts, so a dashboard can show where the schedule stands while it is silenced.

Rejected: a timer or date-based cadence (calendar time says nothing about how much work ran); counting `complete` phases only (off by one at `execute:post`); one counter across milestones (the boundary is where the environment is cheapest to change, and has its own trigger); hosting milestone-start at the first phase's `discuss:pre` (fires per phase and needs its own first-phase test).

## Consequences

- `retro.*` keys are declared on the capability (`retro.signal_threshold`, `retro.kind_cap`, `retro.volume_calls`, `retro.volume_turns` and the `*_min` thresholds that `resolveRetroThresholds` reads, `retro.excerpt_window`, `retro.max_signals`, `retro.excerpt_chars`, `retro.auto`, `retro.check_stale_days`), so `config-set retro.*` accepts them. An invalid value in `config.json` keeps the default and is named in the report's `reasons`, never silently replaced.
- The CLI router is synchronous at the edge, as `dispatchCapabilityCommand` requires: argument and session validation run before anything is read, and the streamed transcript read finishes after the router returns (the profile-pipeline precedent).
- `gsd-finding-refuter` carries a `retro` mode (integration wave, 2026-10-05), and the lifecycle stage runs at `execute:post` and `ship:post`, and since §9 at `roadmap:post`.
- §9 adds `retro.cadence_phases` and `retro.at_milestone_start` (invalid values keep the default and are named), `.planning/retro/RUNS.json`, and `gsd-tools retro due`. A retro held before §9 has no run in the journal, so the first count after upgrading runs from the milestone's start.

## Alternatives rejected

- **Feed the transcript to the analyst.** Costs a full context, and is exactly where Pocock's skill forgets the middle of the session. The analyst gets counted signals and their context lines instead.
- **Let the analyst's candidates through on trust.** The documented failure is generic advice; a mechanical evidence check is cheap and exact.
- **Auto-apply mechanical checks.** See §5.
- **A retro on every session.** A model pass without friction is a wasted context; the deterministic decision keeps smooth sessions silent.
- **Judgement rules in CLAUDE.md.** Every agent pays for them on every turn, and the implementer — who is under the most context pressure — is the one least able to follow them.
