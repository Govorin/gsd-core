# ADR-5208: The window review unit — evaluation scope over a period, still a union

- **Status:** Accepted — fork-local (mn fork, 2026-10-04); implemented in `src/gate-evaluation-scope.cts` and `src/code-review-flags.cts`
- **Date:** 2026-10-04
- **Issue:** none — the fork files no upstream issues; the number follows the highest issue number in this repository's history (#5207). The design is `.plans/pocock-practices-design.md` §D2.
- **Amends:** [ADR-5057](5057-one-owner-per-workflow-verdict.md) §4 "One scope resolver" — adds a fourth unit, `window`, to `resolveEvaluationScope`. Every constraint of §4 still holds.
- **Supersedes:** nothing.

## Context

`/gsd-code-review` reviews one phase. The degradation a single-change review cannot see — a duplicate written by two phases, half of a migration, the dead remnant of a replaced path — is a property of a *period* of work. Reviewing "what landed this week" or "everything since the last such review" needs a scope whose unit is a window, not a phase.

[ADR-5057](5057-one-owner-per-workflow-verdict.md) §4 made `resolveEvaluationScope(unit)` the single owner of *which commits and files does this step evaluate*, with three constraints: the scope is the **union** of each commit's own file set, never a range; only commits reachable from the evaluated ref count; an empty union degrades loudly and what it drops is named. A window computed any other way — `git diff <since>..HEAD`, `git log --since` — would be the per-consumer re-derivation §4 removed, and `scripts/lint-evaluation-scope-drift.cjs` already rejects a bespoke `..HEAD` range in a workflow or agent.

## Decision

### 1. The unit

`{ kind: 'window'; since: string; until?: string }`. `until` is the window's tip (default: the `ref` option, else `HEAD`). The scope it returns is the same `EvaluationScope` as every other unit, plus a `window` object present on window scopes only (`since`, `sinceKind`, `until`, `tip`, `base`, `boundary`, `phases`, `unattributed`, `unreadablePhaseDirs`). Each commit carries `phase`.

### 2. `since` has four forms, parsed in precedence order (`parseWindowSince`)

| Form | Example | Meaning |
|---|---|---|
| keyword | `last` | from the tip the previous window review recorded (§5) |
| duration | `7d`, `12h`, `2w` (1–9999 of `h`/`d`/`w`) | measured back from an injected clock (`ScopeOptions.clock`) |
| date | `2026-09-27`, `2026-09-27T10:00Z`, `2026-09-27T13:00+03:00` | a bare date is 00:00:00 **UTC**; a date-time must carry its offset |
| ref | `v1.2.0`, `main`, a sha | anything else that is a safe git ref |

A string that looks like a duration or a date but is malformed (`0d`, `07d`, `2026-02-30`, `2026-9-1`) is refused, never re-read as a ref. A branch literally named `7d` or `last` is reached as `refs/heads/7d`. Bare dates are UTC so the same argument names the same instant on every machine and in CI; git's own approxidate reads `2026-09-27` as that day *at the current time of day*, which is why the resolver computes the instant itself.

### 3. A window is the set of commits that LANDED on `until` inside the period

The window is the commit set `base..until` (`git log`, no pathspec, merges included) — a set, never a diff:

- **ref / `last`:** `base` is that commit.
- **duration / date:** `base` is the newest **first-parent** ancestor of `until` committed strictly before the boundary (`rev-list --first-parent -n 1 --before=@<boundary-1>`). A commit committed exactly at the boundary is inside. No such ancestor (the window reaches past the root) means `base: null` and the whole history of `until`.

The first-parent anchor is deliberate. A feature branch authored a month ago and merged on Tuesday *landed* on Tuesday: its commits are in Tuesday's window although their committer dates are old. Filtering commits by their own dates (`git log --since`) would drop them, and git's date-limited walk can stop early on clock skew. A commit that lives only on another branch is not reachable from `until` and is not in the window — choose that branch with `until`.

### 4. Each commit contributes its own files; a merge contributes only what it introduced

Files come from `git log --no-walk --cc --name-only` over the listed shas (chunked as §4's other lookups are), with the same `SCOPE_EXCLUSION_PATHSPECS`. `--cc` gives a merge only the paths it changed against **every** parent — a conflict resolution, an evil-merge edit. What it merged in is already in the window as the merged commits themselves, so the phase unit's `--first-parent` diff (which would bring the whole merged branch in through one commit) is not used here. `outsideUnion` still names range-minus-union paths, which for a window are only possible when `base` is not an ancestor of `until` (§5).

### 5. Statuses and reasons

| Situation | `status` | `reason` |
|---|---|---|
| commits whose union is non-empty | `resolved` | null |
| no commit landed in the window | `degraded` | `empty-window` |
| every commit touched only excluded paths | `degraded` | `empty-after-exclusions` |
| `last`'s recorded tip is no longer an ancestor of `until` (history rewritten) | `degraded` | `last-window-tip-not-ancestor`; the tip is named in `unreachable` |
| `last` with no recorded window | `unresolvable` | `no-last-window-marker` |
| marker present but unreadable / malformed / naming no object | `unresolvable` | `last-window-marker-unreadable` / `last-window-marker-invalid` / `last-window-tip-missing` |
| ref `since` that does not resolve | `unresolvable` | `window-since-not-found` |
| `since` in none of the four forms | `unresolvable` | `invalid-window-since` |
| a second lower bound or tip (`options.since`, or `options.ref` with `until`) | `unresolvable` | `window-with-since-option` / `window-until-with-ref-option` |

An empty window degrades with an **empty** file set: unlike a phase, a window has no wider evidence to fall back to (every path its range changes was changed by one of its own commits). It is never a clean, empty `resolved`.

### 6. Phase attribution, read from the documents that already own it

Each window commit is attributed to the phase whose SUMMARY `## Task Commits` row names it (`extractTaskCommitRefs`, the same path-anchored parse the phase unit uses; a 7–40 hex short id matches by prefix), across active **and** archived phase directories — a window can cross a milestone. An archived phase is keyed `<milestone>/<token>` (`v1.0/01`) so equal tokens of two milestones stay apart. A commit no SUMMARY names is `unattributed`; the spec lens reports "no spec" for it rather than guessing from the subject. Phase directories or SUMMARY files that cannot be read are named in `unreadablePhaseDirs`, because their commits would otherwise read as a false `unattributed`. A sha listed by two phases goes to the first in directory order.

### 7. The `last` marker: `.planning/reviews/LAST-WINDOW.json`

The tip of the previous window review lives in `<planningDir>/reviews/LAST-WINDOW.json` (`lastWindowMarkerPath`, workstream-aware through `planningDir`):

```json
{ "version": 1, "tip": "<full sha>", "since": "7d", "until": "HEAD",
  "reviewedAt": "2026-09-27T00:00:00.000Z", "review": ".planning/reviews/2026-09-27-window/REVIEW.md" }
```

- **Its own file, not `STATE.md` or `config.json`.** `STATE.md` has its own write-path owner ([ADR-3408](3408-state-write-path-preservation.md)) and describes project progress; `config.json` is user intent. A review cursor is neither.
- **Under `.planning/reviews/`,** next to the window REVIEW.md files it points at, so it is committed with the planning docs when `commit_docs` is on and a fresh clone continues from the same tip.
- **Written by the window-review step only after its REVIEW.md exists** (`formatLastWindowMarker`). A review that fails or is abandoned does not advance the window. The resolver module only reads it; it remains a gate module that writes nothing.
- The design names this file; a generic `WINDOW-STATE.json` was considered and rejected — the file records exactly one fact, and its name should say which.

### 8. The command surface: `--since`, `--until`, `--lens`, and refusing ambiguity

`resolveCodeReviewInvocation(argv)` (`src/code-review-flags.cts`) decides phase-or-window. The phase is optional when `--since` is given. These are refused with a usage error carrying the registered `USAGE` exit code ([ADR-3889](3889-process-exit-contract.md), 64) — never resolved by a silent precedence: a phase **and** `--since`; neither; `--files` with `--since` (two scope choices); `--until` or `--lens` without `--since`; a malformed `--since`/`--until`; an unknown lens (`correctness`, `standards`, `spec`, `simplify`); a value flag with no value. Whether `--since last` has a marker to start from is the resolver's answer, not argv's. Value flags accept `--flag=value` and `--flag value`; the documented `--files a,b` space form now parses instead of being read as the phase.

### 9. The milestone stage (2026-10-05)

A milestone is the accumulation point the window review exists for, so the code-review capability registers `review stage` at the `milestone:pre` loop point (ADR-857 amendment of the same date). The window starts at `last` when a marker exists, otherwise at the latest `v*` tag merged into `HEAD` that is not the milestone being closed; with neither, the stage says so rather than reviewing all of history. The pre-pass always runs and is written like `window-prepass`; `code_review.window_at_milestone` (default on) decides whether the model review follows (`auto`, `next: /gsd-code-review --since <since>`) or is only named (`suggest`). An empty window is `skip`. The marker is still written only by the review itself, after its REVIEW.md exists (§7).

### 10. The milestone gate (2026-11-01)

The stage is advisory, so nothing made its outcome binding: in get_your_look_up both closes of 2026-10 shipped and were reviewed after (1 Critical + 40 Warnings, then 53 findings, none refuted), and under `mode: yolo` complete-milestone's readiness step jumped past `milestone:pre` altogether. The code-review capability now also declares a blocking gate there, `check milestone-review --milestone <v>` (`code_review.milestone_gate`, default on; `onError: halt`), evaluated after the point's steps:

- **The milestone's code.** `base` is one answer shared with the stage's `since` (`src/milestone-review.cts`): of the previous milestone's archive commit (the newest commit adding a `milestones/<v>-ROADMAP.md` other than the one being closed) and its tag (a tag naming that version under any prefix, `polyglot-v4.5` included; with nothing archived, a bare `v*` tag only when the project is the repository root, `git.create_tag` is on and tagging is not per-repo), the one nearer to `HEAD`; with neither, the parent of the first commit under this project's own `.planning/`; then the root. A shallow clone is unreadable. The stage starts at `last` only when the recorded tip is at least as near to `HEAD`. Code commits are `base..HEAD` without merges, under this ADR's scope exclusions — which now exclude `.planning/` at any depth (a monorepo carries one per project). The first version took the newest `v*` tag regardless of the tagging scheme: in get_your_look_up (`git.create_tag: false`, one July tag) that put 1 333 commits of v1.4–v1.11 in a window no review could ever cover.
- **Covered** is a set union: a commit is covered when some composed window REVIEW.md holds it in `base..tip`, or its REVIEW-FIX.md records it as the fix of one of its findings — on a `**Commit:**` line inside a `## Fixed Issues` entry, descending from the tip, with one of the finding ids that entry's heading names in the subject (a heading may name several, `### WR-01 (correctness-1), WR-12 и WR-13 …`), as gsd-code-fixer and `/gsd-audit-fix` both write it (the review's own remedy; a feature commit the report happens to name is new work). Fail closed: only a review with full-sha `tip`/`base`, status `clean` or `issues_found` and at least one `## Lens:` section counts. Chained and overlapping windows both count; the newest review alone is never the test.
- **Open Critical**: a Critical finding of a review that covers a milestone commit, not listed fixed in its REVIEW-FIX.md and whose broken-window entry (by fingerprint, §7) is neither `fixed` nor `waived`. A refuted finding is already out of the composed review. Warnings are counted, never blocking.
- **The override** is the owner's, recorded and narrow: `review milestone-accept --milestone <v> --reason <why>` writes `<planning>/reviews/MILESTONE-<v>-ACCEPT.json` with the reason and the exact uncovered commits and open Critical keys; the gate passes as `accepted` only while everything open is something it named. Unattended runs (yolo, autonomous) stop and never accept.

Rejected: moving the review before `/gsd-audit-milestone`. The audit consumes VERIFICATION, SUMMARY and REQUIREMENTS, never a review, and its gaps become new phases whose code a review taken before it would miss; the review belongs at the close, where the gate makes it binding.

## Consequences

- One owner still answers every scope question; the window-review workflow and its lenses call `check evaluation-scope --window <since> [--until <ref>]` (or the resolver) and never compute a range.
- The window's union can be hundreds of files. Batching and ordering by churn × complexity belong to the window pre-pass and workflow, not to the resolver, which returns the whole union and drops nothing silently.
- `parseCodeReviewFlags`'s IR gains `phase`, `since`, `until` and `lens`; its permissive contract (unknown flags ignored) is unchanged.

## Alternatives rejected

- **`git diff <since>..<until>`.** A range, which §4 already rejects: it hides which commit (and so which phase) changed a path, and cannot attribute.
- **Commit-date filtering (`git log --since`).** Drops merged branches whose commits are older than the window though they landed inside it, and git's date-limited walk can stop early on skewed dates.
- **Author date.** Survives rebases unchanged, so a rebased branch landing today would read as old work.
- **`--first-parent` diff for merges (the phase unit's rule).** In a window the merged commits are already present; the first-parent diff would duplicate them and hide which commit introduced a path.
