# ADR-5209: The retro capability — local transcript reading, Claude-first, never self-applied

- **Status:** Accepted — fork-local (mn fork, 2026-10-05); implemented in `capabilities/retro/`, `src/retro-command-router.cts`, `src/retro-artifacts.cts` over `src/session-transcript.cts`, `src/retro-signals.cts`, `src/retro-inventory.cts`
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

`gsd-tools retro signals --decide` answers `skip | suggest | auto`: `skip` when the capability is off, when `retro.auto` is `off` (no transcript is read), or when the score is below `retro.signal_threshold`; otherwise `retro.auto`'s mode, with the `/gsd-retro --session <id>` command and, for `suggest`, the one line to print. A smooth session stays silent. The capability wires it into the loop as two command steps, `retro stage` at `execute:post` (the end of `execute-phase`) and at `ship:post` (`when: retro.enabled`); the step's JSON carries the stage answer of `gsd-core/references/loop-hook-dispatch.md` (`decision`, `message`, `next: {skill: retro, args: --session <id>}`), so the host prints a suggestion or, on `auto`, starts `/gsd-retro` — whose candidates are still never applied.

### 7. The removal loop: `.planning/retro/CHECKS.json`

A check a human accepted is journaled — `id`, `kind`, the literal it prints when it fires (`match`), `acceptedAt`, and the retro, candidate and signal it came from (`retro checks record`). `retro checks` counts firings in the transcripts of the last `retro.check_stale_days` days (a hook event, or a failed/blocked tool result, carrying the literal). A check is a **removal candidate** only when it has not fired, was accepted at least that many days ago, and the transcripts read reach back the whole window. When no transcript could be read, every silent check is `unknown`: "never fired" and "not looked at" are different answers. Removal is a candidate like any other — the human decides. The journal sits under the planning root, not a workstream: the environment belongs to the repository.

## Consequences

- `retro.*` keys are declared on the capability (`retro.signal_threshold` and the `*_min` thresholds that `resolveRetroThresholds` reads, `retro.excerpt_window`, `retro.max_signals`, `retro.excerpt_chars`, `retro.auto`, `retro.check_stale_days`), so `config-set retro.*` accepts them. An invalid value in `config.json` keeps the default and is named in the report's `reasons`, never silently replaced.
- The CLI router is synchronous at the edge, as `dispatchCapabilityCommand` requires: argument and session validation run before anything is read, and the streamed transcript read finishes after the router returns (the profile-pipeline precedent).
- `gsd-finding-refuter` carries a `retro` mode (integration wave, 2026-10-05), and the lifecycle stage runs at `execute:post` and `ship:post`.

## Alternatives rejected

- **Feed the transcript to the analyst.** Costs a full context, and is exactly where Pocock's skill forgets the middle of the session. The analyst gets counted signals and their context lines instead.
- **Let the analyst's candidates through on trust.** The documented failure is generic advice; a mechanical evidence check is cheap and exact.
- **Auto-apply mechanical checks.** See §5.
- **A retro on every session.** A model pass without friction is a wasted context; the deterministic decision keeps smooth sessions silent.
- **Judgement rules in CLAUDE.md.** Every agent pays for them on every turn, and the implementer — who is under the most context pressure — is the one least able to follow them.
