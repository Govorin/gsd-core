# Plan: mn fork — pipeline repair and remaining work

Branch `feat/mn-verify-gate`. Fork of `open-gsd/gsd-core`, tracking `next`.

`$gsd` = `/Users/govorin/forks/gsd-core` — this repository, exported from `~/.zshrc` alongside `$mn`, so `cd $gsd` works from any shell. Every path below is
relative to it unless prefixed. The installed runtime that actually executes is
`~/.claude/gsd-core/` (workflows, templates, `bin/lib/*.cjs`) and
`~/.gsd/mn-verify-gate/scripts/` (gate scripts); **every edit here must
be mirrored there or it does not run**. The manifest and fragments of
`mn-verify-gate` are compiled into the first-party registry and reach the runtime
through the installer, not through a copy. The scripts deliberately live outside
`~/.gsd/capabilities/`: the overlay loader scans that directory, and a copy of
`mn-verify-gate` there collides with the built-in capability ID and prints a
load error on every `gsd` command. Two differences to watch when mirroring:
paths (`$gsd/gsd-core/workflows/` ↔ `~/.claude/gsd-core/workflows/`) and command
namespace (`/gsd:` here, `/gsd-` installed).

---

## The defect class this work addresses

Nearly everything found follows one shape: **a mechanism is written in full and
wired to nothing**. Not badly built — built and never connected. The symptom is
always the same and always invisible: a consumer reads a file that is never
produced, or a producer writes a file no one reads, and both sides skip silently
because absence is indistinguishable from "nothing to report".

Measured instances, each verified by grep or file count rather than inference:

| Mechanism | State when found |
|---|---|
| `spec-phase` | reachable from no route in `next.md` or `autonomous.md` |
| `extract-learnings` | invoked from nowhere — 0 LEARNINGS.md across 280 phase dirs |
| `WAITING.json` | writer, reader and CLI complete since #1034; zero callers |
| Blocking gates in autonomous | never dispatched — that mode takes only `kind == "step"` |
| Milestone inheritance | `grep RETROSPECTIVE\|LEARNINGS\|MILESTONE-AUDIT new-milestone.md` → 0/0/0 |
| `DESIGN-SYSTEM.md` | 1052 lines produced under `quality-design`, unknown to GSD |
| `requires:` in SUMMARY | present only in the `complex` variant; selector defaults to `standard` |
| `deferred-items.md` | 64 files in live trees, no template, no registry entry |

---

## Done

17 commits. Grouped by what they fix, not by order.

### Reconnected producers and consumers

- `spec-phase` runs from both routes (`next.md` Route 1b, `autonomous` before discuss)
- `extract-learnings` called from `transition`, ahead of the `graduation_scan` that consumes it
- `SPEC.md` reaches `gsd-planner` (5-source audit, AC-n lift), `gsd-verifier` (`spec_truths`), `gsd-ui-researcher` (read first, ahead of CONTEXT)
- `WAITING.json` raised before a blocker question, cleared after the answer
- `new-milestone` step 2.7 reads retrospective, known gaps, deferred items, last audit
- `ship` calls `pr-branch` before push

### Made claims checkable

- `truths_unproven` emitted as a number — `score: "6/7"` is a string no predicate can compare
- Status vocabulary anchored: `/status:\s*passed/i` matched `passed-degraded` as success
- `requires:` in all three SUMMARY variants — the dependency graph was a function of a size heuristic
- `audit-milestone` handles `human_needed` and `stale`, with a catch-all for anything outside the vocabulary

### Capability `mn-verify-gate` — 8 gates, 8 scripts, 5 fragments

Gates (all `command-exit-zero`; `artifact-frontmatter-equals` is documented on
`next` but absent from the published 1.9.1 evaluator, so core's `security` and
`broken-windows` gates halt with "unknown predicate kind" rather than checking
anything — ours replace them):

| Point | Gate | Catches |
|---|---|---|
| `verify:pre` | assertion-ratchet | a check deleted rather than fixed |
| `verify:pre` | blast-radius | files changed that no plan declared |
| `execute:wave:post` | migration-safety ×2 | undeclared `DROP`, journal drift |
| `ship:pre` | verify / nyquist / security / windows | unproven truths, open threats, debt |

Scripts: `assertion-ratchet` · `blast-radius` · `check-frontmatter` ·
`design-registry` · `migration-safety` · `run-log-report` · `worktree-gc` ·
`zod-fieldtable`.

Fragments at `plan:pre`: field table from Zod · user route with failure
branches · migration safety · design registry · design decisions.

### Enforcement at the write, not at verification — four hooks

Every gate above answers its question at `verify:pre` or later, where the only
remedy left is a revert. These four ask the same questions while the work is
happening. Research behind the choice is in `.plans/harness-research-2026-08.md`;
the load-bearing finding is that hooks enforce and prose does not — the same
reason `gsd-agent-isolation-guard` exists.

| Hook | Event | Refuses | Config (default) |
|---|---|---|---|
| `gsd-prohibition-guard` | PreToolUse | a write outside the running plan's `files_modified` | `prohibition_guard` (`off`/`ask`/`deny`) |
| `gsd-test-tamper-guard` | PreToolUse | a write that drops assertions or newly skips tests | `test_tamper_guard` (`off`/`ask`/`deny`) |
| `gsd-exit-gate` | SubagentStop | an executor stopping while the project's own checks are red | `exit_gate` (empty = inert) |
| `gsd-pin-invariants` | PostCompact, SessionStart | nothing — restates prohibitions, must-haves and open blockers a rewrite dropped | `pin_invariants` (on) |

Each is the live-fire half of a gate that already exists: prohibition ↔
`blast_radius`, tamper ↔ `assertion_ratchet`, exit-gate ↔ the verifier. They
share the after-the-fact half's vocabulary deliberately, so the two halves
cannot disagree about what they measured.

Three shapes are inert by construction, and each was a decision rather than an
oversight: a phase whose plans declare nothing (that is `blast_radius`'s refusal
to make, and reading it as "declares nothing, allows everything" would disarm
the guard exactly where the planner was sloppiest); several plans in flight at
once (their union is not a scope); and any project that has not armed the key.
The exit gate is the one that fails OPEN on a read error — unlike a PreToolUse
guard it can strand a session with no way forward, and the verifier still
reports a red tree.

`workflow.exit_gate` deliberately runs the project's OWN command
(`lefthook run pre-commit`, `nx affected -t lint,typecheck`) rather than
inventing a check: in `mn` those are 99 custom oxlint rules and 40+ self-testing
scripts, and a gate that judged by any other standard would be both weaker and
in conflict with the pre-commit hook. It scopes to `git rev-parse --show-toplevel`
from the stopping agent's cwd, not the project root — `mn/.claude/hooks/quality-gate.sh`
records what the other choice costs: 19 untouched files across 9 projects
reported as one agent's failure.

Retry budget (`exit_gate_max_retries`, 3): past it the gate reports instead of
blocking, because looping an executor against pre-existing debt burns a session
and records nothing. The command still RUNS past the budget — an earlier
revision returned early without running it, which meant the ledger (cleared only
by a green run) could never clear, and one red phase disarmed the gate
permanently for that worktree. Pinned by a named regression test.

Tests: `tests/mn-enforcement-hooks.test.cjs`, 41 cases — inertness, each
legitimate shape that must not block, the fail direction of each guard, the
retry ledger at limit−1/limit/limit+1, the pin's budget at fits/drops-one/drops-all,
and the exit-code contract through the process seam for the two hooks that block.

### Evidence a gate can read — `gsd_run verify gates`

VERIFICATION.md's "Automated checks: 2 passed, 8 failed" is a line the
verifying agent typed. Nothing downstream could tell a verifier that ran the
suite from one that described running it, and the predicate built to consume
such evidence — `artifact-frontmatter-equals`, ADR-2008 — had nothing to read.

`verify gates <phase-dir>` runs the commands named in `workflow.verify_gates`
and writes what they returned into the phase's VERIFICATION.md frontmatter:

```yaml
gates:
  ran_at: 2026-08-20T11:47:58Z
  all_passed: true
  failed: 0
  ran: [tests, typecheck]
  tests_passed: true          # the verdict
  tests_exit_code: 0
  tests_passed_count: 41      # the parsed count, beside it, never instead of it
```

This is `norn/13-01-SUMMARY.md`'s hand-written `## Gates` line ("typecheck 5/5 ·
tests 204 · oxlint 0 errors") turned into a mechanism. The commands are the
project's own — `nx affected -t test`, `lefthook run pre-commit` — because a
gate judging by any other standard would be both weaker and in conflict with
the pre-commit hook the author already trusts.

Four decisions worth keeping straight:

- **The tool runs the checks, not the agent.** The cheapest possible judge is
  one that is not a model: a typecheck exit code cannot be optimistic. The
  verifier still reasons about the phase goal; it no longer supplies the
  numbers it is judged on.
- **The exit code answers "was it recorded", not "was it green."** A red check
  records and exits 0; `--strict` is there for callers who want the failure to
  propagate. A recording step that fails when the news is bad is a step people
  route around.
- **An empty roster refuses (exit 2) rather than recording `all_passed: true`.**
  "No checks configured" written as green is a field that proves nothing, and a
  gate reading it would report success for a project that ran nothing.
- **A check that could not run is not a check that failed.** It records a null
  exit code plus `_unrunnable`, so "your config names a missing command" stays
  distinguishable from "your code is broken" — conflating them is how a gate
  earns the reputation that gets it disabled.

Two constraints found by running it, both now pinned by tests:

- `spliceFrontmatter` refuses nested object-lists outright, so the obvious
  shape (`gates.checks.tests.exit_code`) cannot be written at all. The block is
  flat, which is also what the reader wants: `artifact-frontmatter-equals`
  addresses a field by name, so `gates.tests_exit_code` is directly gateable.
- A parsed count named `passed` collided with the boolean verdict `tests_passed`
  and silently replaced it — `gates.tests_passed == true`, the natural gate to
  write, came to mean "41". Counts now carry a `_count` suffix.

Both readers of frontmatter learned the same dotted path so they cannot
disagree: `src/gate-predicate-evaluator.cts` (top-level key first, so a literal
dotted key still wins; `hasOwnProperty` at each step so `constructor` cannot
resolve to a function) and `scripts/check-frontmatter.mjs`, which the shipped
gates use because they must work against the installed 1.9.1 runtime where the
predicate is absent.

Wired as `workflow.verify_gates_record` (a verify:pre step, so the verifier
reads numbers it did not produce) and `workflow.verify_gates_enforce` (a
ship:pre gate on `gates.all_passed`). Both default off. Tests:
`tests/mn-verify-gates.test.cjs`, 20 cases, ending with the round trip that is
the entire point — record, then gate on the recording.

### A reader for the checks nobody ran, and a stop the run chooses

**`uat-open.mjs` (`workflow.uat_enforce`, ship:pre).** The verifier already
writes checks it could not confirm by reading code into `{phase}-UAT.md` — the
single sink for them — and `audit-uat` already finds them. Nothing read that,
so a phase whose own report said "nobody checked this" shipped anyway. The
`ucars` retrospective records the workaround: a per-phase `NN-HUMAN-UAT.md`
invented by hand, because otherwise the items "got silently dropped".

The gate deliberately does not add that second artifact. A second sink for
something that already has one is how two records begin to disagree; what was
missing was a reader. Three boundaries, each the opposite of the obvious one:

- **No UAT file passes.** Most phases defer nothing, and requiring the artifact
  would block them for having nothing to check. This is the inverse of
  `blast-radius`, where an empty declaration IS the defect — there the planner
  was supposed to declare something.
- **A FAILED item passes.** A failed manual check is a known defect whose
  verdict (`gaps_found` / `human_needed`) belongs to the verifier. This gate
  asks one question: did anything go unrun.
- **Scoped by directory name, not phase number.** In a monorepo the number
  repeats across projects — the same collision that makes commit-scope
  selection unusable in blast-radius. The path is unique by construction.

**Phase budget (`workflow.autonomous_max_phases`, `--max-phases N`).** An
unattended run that ends because it chose to, at a boundary where work is
committed and verified, is reviewable. One that ends because the context filled
is not. Measured long-run failure in agentic coding is dominated by exhaustion
(MAX_TURNS, wall clock) rather than by a wrong decision at the end, and the
harness that stops cleanly costs far less per unit of work delivered. Default 0
keeps the prior behaviour.

Also fixed here: an unnecessary type assertion in `src/init.cts` that had been
failing `npm run lint` — and therefore halting the whole `lint:ci` chain before
any of its other ~16 checks could run. The remaining chain is clean; six
`allow-test-rule` offenders it then surfaced are inherited from `127b7ebb` and
are not touched by this work.

Tests: `tests/mn-uat-gate.test.cjs`, 7 cases through the process seam, since
the exit code is the gate.

### A worktree is a checkout, not an environment

`gsd-worktree-provision.js` (WorktreeCreate, `workflow.worktree_provision`).
The `ucars` retrospective names worktree isolation "the #1 recurring
operational failure across multiple milestones", and the specifics are all the
same shape — the environment differs from the one the agent just had, and it
finds out by failing at something unrelated to its task:

- `mcp__pencil__*` and atlas unavailable in every worktree agent, because
  `.mcp.json` lives in the main checkout (`ideas/atlas-mcp-backlog.md §B-2`),
- `node_modules` missing, or symlinked to a tree that has moved,
- a base 380 commits behind main, discovered mid-phase.

The hook makes the environment part of creating the worktree: copies
`.mcp.json` and `.claude/settings*.json` (never clobbering one the worktree
already carries — that is a deliberate statement), links or installs
dependencies, and measures the base.

Failure policy is split, and the split is the design. A **stale base blocks**:
plans written against code that has already moved have to be redone, so
refusing costs one command and proceeding costs the phase. **Everything else
warns** — a missing `.mcp.json` or a failed install may not matter to this
phase at all, and refusing to create a worktree over an optional convenience is
how people come to distrust isolation and turn it off. An *unmeasurable* base
(shallow clone, unrelated histories) also warns rather than blocking: unlike a
gate, refusing here strands the phase, and the executor's own first build
surfaces it anyway.

Tests: `tests/mn-worktree-provision.test.cjs`, 12 cases — the decision function
with each step injected, plus the blocking path end-to-end over two real git
repositories, because the exit code is what the runtime consumes.

### Evals from what actually burned us, and the hole the first one found

`tests/qa/enforcement-cases.json` — 14 situations drawn from the retrospectives
rather than invented for a test, each with one verdict the harness must reach.
A unit test asks "does this function return deny for this input"; these ask
"given the situation that burned us, does the harness refuse".

That distinction is not academic. Every failure in the file happened while the
surrounding code was correct and passing its own tests: the gap was never in
whether a function worked, but in whether the situation was wired to anything.
blast-radius could always detect an undeclared file — nothing asked it at the
write. audit-uat could always find an unrun check — nothing read it before ship.

Five of the fourteen expect `allow`, and they carry their weight: a guard that
blocks a legitimate shape is what gets guards disabled, so the false-positive
behaviour is pinned as deliberately as the blocking behaviour. A suite-level
test keeps that balance from eroding into an all-`block` set.

The suite earned itself immediately. `assertion-commented-out` — the obvious
evasion of a line-count check — failed: only `//` was being stripped, so
commenting an assertion out with a block comment left it counted as live and
the deletion went through disguised as a comment. The unit file had been green
throughout, because it was written from the implementation rather than from the
evasion.

### Mutation as a step, not a technique someone remembers

`mutation-spot-check.mjs` (`workflow.mutation_spot_check`, verify:pre). The
assertion ratchet catches a check that was deleted. It cannot catch one that
never checked anything — `expect(true).toBe(true)` counts the same as a real
assertion. `norn/13-01-SUMMARY.md` records the case: "⚠ My own test was a false
green, caught by mutation", found by hand.

The script changes declared source in one place (`>=`→`>`, `===`→`!==`,
`true`→`false`), runs the project's own test command, and fails when the suite
stays green. Choices worth keeping straight:

- **The project's runner, not Stryker.** Neither `mn` nor `awesome-projects`
  installs it, and a gate that first requires installing a tool does not get
  switched on.
- **An already-red suite refuses rather than reporting kills** — on a red tree
  "the mutant was killed" cannot be told from "the tests were already failing".
- **Tests are never mutated.** Mutating a test checks a test with a test.
- **The file is always restored**, including on a signal: a script that leaves
  a mutation in the working tree is worse than no script.
- **It reads its command from config, not from the gate declaration** —
  predicate interpolation covers only `PHASE_NUMBER` / `PHASE_DIR` /
  `PHASE_REQ_IDS`, so a `${WORKFLOW_…}` there would arrive as a literal string.

Tests: `tests/mn-mutation-spot-check.test.cjs`, 10 cases, including the one
that matters — a test asserting nothing lets the mutant survive and the check
fails.

### An adversarial pass over the checker's findings

`gsd-finding-refuter` (`workflow.refute_findings`, plan-phase step 11b). A
reviewer whose findings are never challenged drifts toward reporting more of
them: an unreported real issue is visibly a miss, a reported non-issue costs the
reviewer nothing. The cost lands on the planner, rewriting plans to satisfy
findings that were never true.

Self-critique by the reviewer is the wrong fix and measurably worse — recall
27%→33% while signal-to-noise collapses 5.11→1.95 (arXiv 2603.11078). What
raises precision is an adversarial pass by something that is *not* the reviewer,
with the burden of proof on the finding.

The asymmetry is the design, and it is deliberately not symmetric: an upheld
false positive costs one revision, a refuted true positive ships a defect into
execution. So the refuter defaults to UPHELD and may only move a finding with a
file, a line, or a command's output. Three arguments are named as *not*
evidence, because a model told to "try to refute" reaches for them: severity is
not truth, cost is not truth, and any argument that would read the same way
without having opened a file.

Two routing rules carry the safety:

- A refutation whose verdict count does not match the finding count is
  **discarded whole**. A partial one silently drops whichever findings it forgot.
- The checker is **never re-run** against it. Two agents disputing each other
  converge on the more stubborn one rather than on the truth.

One refuter, not a panel — five critics per plan is the ceremony the workflows
guidance warns about. Expect it to change nothing most of the time; a refuter
that regularly refutes half the findings is disputing on argument, which its own
evidence lines will show.

Registered in the four rosters a fork-added agent has to enter (model catalog,
INVENTORY.md, INVENTORY-MANIFEST.json, the capability's `agents`) — the lesson
from `8e8aac1e`. Tests: `tests/mn-finding-refuter.test.cjs`, 14 cases pinning
the asymmetry, the closed verdict vocabulary, the step order, and the routing
rules — not the prose.

### A clean tree at ship, and a picture of the plans

- **`clean-state.mjs`** (`workflow.clean_state_enforce`, ship:pre, default off).
  `ship.md` already asked the model to read `git status --short` and stop; this is
  the same check as an exit code, plus the case status cannot show — a stopped
  rebase/cherry-pick/merge/revert leaves the tree clean while history is
  mid-operation. Ignores `.planning/`, and does **not** count a leftover
  `.continue-here.md`: `resume-project` deletes `HANDOFF.json` but not it, so its
  presence is not a signal and the gate would fire on healthy phases. The tests
  caught two real defects in the first draft — `git rev-parse --git-path` prints
  a path relative to the cwd, not the repo root, and a rename is two records in
  `status -z`. 16 cases in `tests/mn-clean-state.test.cjs`.
- **`plan-graph.mjs`** — mermaid of a phase's plans from `wave` and `depends_on`,
  every node a `*-PLAN.md`, every edge a `depends_on` entry, nothing else.
  Defects (unknown dependency, wave not strictly later, cycle) are drawn in red,
  not judged; exit 0 unless `--strict`. **Deliberately not registered as a gate
  or step:** detection is already covered (`wave-solve` finds cycles,
  `wave-normalize` is wired at `plan:post`), so its value is the picture, and a
  second detector would be a mechanism with no new question to answer. Run by
  hand: `node capabilities/mn-verify-gate/scripts/plan-graph.mjs --dir <phase> --out <file>`.
  Output verified against the real mermaid parser (`flowchart-v2`) on a fixture
  with all three defect classes; 19 cases in `tests/mn-plan-graph.test.cjs`,
  two mutations confirmed to fail it.
- `mn-wave-normalize.test.cjs` pinned its gate as "the LAST entry in gates"; any
  gate registered after it broke it. Now pinned at index 16, count a floor.

### Pre-sync fixes (2026-10-03), ahead of the upstream 1.15 sync

Plan: `.plans/upstream-sync-plan.md`; analysis: `.plans/upstream-1.15-what-to-take.md`.

- **No `status: pending` in the VERIFICATION.md seed** (`verify-gates.cts`). Upstream's
  closed VerificationStatus (`src/verification.cts`, `reportStatusOf`) accepts only
  passed | gaps_found | human_needed in a report and throws on anything else; an absent
  status routes to `missing`. Upstream's own `scaffold verification` (`commands.cts`)
  still writes `pending` and trips its own reader — fix ours on the sync branch, report theirs.
- **Blocking fork guards at 120s** (`prohibition-guard`, `test-tamper-guard`). The installer
  does NOT register fork hooks: they are hand-registered in `~/.claude/settings.json`, so the
  installer neither updates nor verifies them. `hooks/hooks.json` is the plugin manifest.
- **mn-verify-gate scripts moved to `~/.gsd/mn-verify-gate/scripts/`.** The copy under
  `~/.gsd/capabilities/` collided with the built-in registry entry and printed a load
  warning on every `gsd` call; a dir without `capability.json` warns too. Upstream keeps no
  scripts inside capabilities at all (logic lives in `gsd_run` verbs) — the long-term target.
- **The `.pen` design contract lives in the repo now** (`gsd-ui-auditor`, `gsd-ui-checker`,
  `gsd-ui-researcher`, `templates/UI-SPEC.md`). It was only in the installed copy, and every
  reinstall moved it to `gsd-local-patches/`. Open: the checker still says "6 dimensions" in
  its frontmatter and table and `workflows/ui-phase.md` says "All 6"; `ls **/*.contract.json`
  needs globstar in bash; project-specific paths (`bun tools/ui-system/...`) are hard-coded.
- **Known failing before any of this:** 6 tests on the hooks manifest, 7 in
  `research-agent-profiles` (fork MCP tools in `tools:`), `gsd-executor` over the LARGE cap.

### Long-lived state

- `LEARNINGS-DIGEST.md` — the recency window is three phases wide regardless of project length
- `CROSS-DOMAIN.md` — sibling projects in one repository had no channel at all
- Wave manifest moved from `$TMPDIR` to `.planning/.worktrees/`, self-ignoring
- `deferred-items.md` templated, with a `deferred_open` count a gate can read

---

## Remaining

Ordered by cost of the failure they prevent, not by effort.

### 1. Compute waves in code

**Measured:** 26 phases of 174 violate the invariant that same-wave plans share
no files. Worst is 30 overlapping pairs in one phase.

The rule lives as pseudocode inside the planner prompt — an LLM computes it and
nothing verifies the result. `blast_radius` covers the after-the-fact half; the
missing half is computing wave assignment from `depends_on` and `files_modified`
deterministically at plan time.

Blocked on data quality first: 10% of `files_modified` entries are directories
or globs rather than files, and 14% of plans declare none. A solver over that
input produces confident nonsense. Normalise, then solve.

### 2. Task lifecycle as an explicit status

Today a task's state is inferred from whether a SUMMARY.md exists. One tree
carries 22 plans with no summary — indistinguishable from work never started.

Design (`.plans/core-model-redesign.md`): four states — `in_progress`, `done`,
`blocked`, `superseded` — in the **plan's** frontmatter, not STATE.md, so each
file has exactly one writer and races cannot occur by construction. `cancelled`
and `failed` were dropped: neither changes what happens next.

### 3. Template layout

From the documentation matrix, in descending value:

- `requires:` in all variants — **done**, listed here because the rest of the matrix work follows from it
- rename `phase-prompt.md` → `plan.md`: 21KB, the most-written artifact in the system, **zero references by filename** — the only path to it is a README table
- merge three SUMMARY variants into one file with internal variants; `cmdTemplateSelect` returns `{template, variant}` instead of a path (~5 lines in `template.cjs`)
- delete `planner-subagent-prompt.md` and `debug-subagent-prompt.md` — zero references, superseded by `agents/`
- move `claude-md.md`, `copilot-instructions.md`, `dev-preferences.md`, `user-profile.md` to `templates/host/` — they are not `.planning/` artifacts
- add a `gsd-template:` frontmatter block (level / lifecycle / required / author / readers) and generate `artifacts.cjs` from it, collapsing three unsynchronised registries into one

### 4. Feature as a tag, not an artifact

Verdict from the matrix: do **not** introduce `FEATURE.md`. A cross-phase entity
maintained by hand against 174 directories, by one person working unattended,
will drift and no one will catch it.

Instead: `feature:` as a frontmatter field drawn from a closed list in
ROADMAP.md, and the feature view derived by `graphify` as a query. Derived views
cannot drift. Note the precedent — `affects:` is free text and already has.

### 5. Duplicate detectors into the commit path

`tools/scripts/find-duplicate-tokens.mjs` and `find-duplicate-shapes.mjs` exist
and run: 18 real token duplicates of 826 declarations, 19 shape groups of 500.
Ratchet against `dup-baseline.json` works. Not wired to pre-commit.

Highest-value single case: `Timeframe` / `BacktestTimeFrame` — same library,
eight identical values, differing only in key style. The comment justifying the
split ("extended to include 1m, 5m, 15m") was false on the day it was written.

### 6. `unifier`

Agent written (`~/.claude/agents/unifier.md`). Investigates *why* two copies
exist before proposing anything — lineage, drift, semantics — and either fixes
the whitelisted safe class or files a question in
`.planning/UNIFICATION-QUESTIONS.md`.

Validated by hand against one case, not empirically tuned. Its own finding on
that case is instructive: it declined to merge the cleanest-looking duplicate in
the repository, because `Timeframe` feeds a Postgres enum through a helper
function — a coupling invisible to any search for the type name.

### 7. `verify:pre` steps have no dispatcher

Found while wiring `plan-graph`, by reading — **not** confirmed against a live
`/gsd-verify-work` run. `workflow.verify_gates_record` is registered as a
`verify:pre` **step** whose `ref` is `{"command": "gsd_run verify gates ..."}`,
and the "Evidence a gate can read" section above records it as wired. But:

- `src/loop-resolver.cts:360` only *renders* a step as text
  (`JSON.stringify(hook.ref)` for a command ref); it executes nothing.
- `gsd-core/workflows/verify-work.md` (`verify_pre_hooks`) dispatches only
  `kind == "gate"` at `verify:pre`. The one step dispatch in that file is
  `ref.skill == "secure-phase"` at `verify:post`.
- No workflow, agent or fragment mentions `verify gates`.
- `tests/mn-verify-gates.test.cjs` calls the command directly, so it cannot see
  a missing caller.

If that holds, the `verify_gates_enforce` gate on `gates.all_passed` has nothing
to read unless someone runs the command by hand — the defect class this file
opens with. Fix options: dispatch command-ref steps at `verify:pre` in
`verify-work.md` (core edit; mind the ADR-1610 size budget — extract to
`verify-work/steps/`), or fold the recording into a gate that is already
dispatched. Needs a live run to confirm before either.

Related, same shape: `execute:pre` is a declared point with no dispatch at all
in `execute-phase.md` (no `EXECUTE_PRE_HOOKS_JSON`), and steps "never halt the
host workflow on their own" (`docs/reference/capability-manifest.md`), so a
baseline check on entry cannot be a step and needs a gate dispatch added there.
`execute-phase.md` is 94 575 bytes, at the budget ratchet. Deferred.

---

## Known dead ends

Recorded so they are not rediscovered.

- **`.phase-manifest.json`** — `undo.md` reads it; nothing writes it. Phase-scoped undo always falls back to conventional-commit scope matching, so a commit without the phase scope is invisible to the revert. Documented in `undo.md`, not fixed: writing a producer duplicates what git already records.
- **`plan-milestone-gaps.md`** — deleted upstream (#2790), but `tests/phase.test.cjs:5673` asserts the file exists. Left in place with a `<status>` block.
- **`BACKLOG.md` / `THREADS.md`** — in `CANONICAL_EXACT`, produced by nothing. Real homes are `ROADMAP.md ## Backlog` (999.x) and the `.planning/threads/` directory. Registry entries kept (harmless); the docs claiming a producer were corrected.
- **`intel` capability** — its export extractor does not parse `export type` or `export interface`. In a Zod-first codebase it is blind to most types.
- **`artifact-frontmatter-equals`** — documented on `next`, absent from published 1.9.1. Any gate declaring it halts instead of checking. Recheck after an upstream release.

---

## Notes on working in this fork

**Upstream moves fast** — 672 commits in 30 days. Rebasing regularly is cheaper
than a large merge later. Rebased onto `upstream/next` on 2026-08-08: 19 commits
ahead, 0 behind, no conflicts.

**Measure the gap against `upstream/next`, never `origin/next`.** `origin` is
`Govorin/gsd-core` — this fork on GitHub — and its `next` trails upstream by
hundreds of commits, so a count against it reports a gap that does not exist
(762 vs the real 3). `git fetch upstream && git rev-list --left-right --count
upstream/next...HEAD`.

**Tests need `npm ci`, not just a build.** The earlier `MODULE_NOT_FOUND` on
`gsd-core/bin/lib/*.cjs` was `@types/node` missing, so `tsc` emitted nothing and
`build:lib` exited 0 while producing no artifacts. After `npm ci`, `build:lib` is
clean and `tests/artifacts.test.cjs` + `phase.test.cjs` run in-tree: 314 tests,
0 failures. Verifying registry logic against the installed build is no longer
necessary.

**Pushing requires `gh auth refresh -s workflow`** — upstream touches
`.github/workflows`, and the current token lacks that scope.

**`rg` is a shell function here, not a binary.** In any subshell or script it is
absent, and `rg pattern` returns empty with exit 0 — which reads as "not found".
Every script in this fork uses `grep` or a Node walk, and distinguishes "found
nothing" (exit 1) from "could not look" (exit 2).
