# Plan: mn fork — pipeline repair and remaining work

Branch `sync/upstream-2026-10` (upstream 1.15 + the fork; becomes local `next`,
the old one kept as `next-pre-sync`). Earlier work was on `feat/mn-verify-gate`.
Fork of `open-gsd/gsd-core`, tracking `next`. **Local only** (owner, 2026-10-04):
no push to `origin`, no upstream issues or PRs; `git fetch upstream` is fine.

`$gsd` = `/Users/govorin/forks/gsd-core` — this repository, exported from `~/.zshrc` alongside `$mn`, so `cd $gsd` works from any shell. Every path below is
relative to it unless prefixed. The installed runtime that actually executes is
`~/.claude/gsd-core/` (workflows, templates, `bin/lib/*.cjs`); **an edit here
runs only after `bin/install.js` is re-run**. Since the 1.15 sync `mn-verify-gate`
has no scripts: its gates are `gsd_run check mn-*` verbs and its tools
`gsd_run mn …` (`src/*.cts`), so `~/.gsd/mn-verify-gate/` is no longer needed and
nothing is hand-mirrored. Script names in the sections below are historical; the
script → verb map is `.plans/mn-verify-gate-to-cli.md`. Command namespace differs:
`/gsd:` here, `/gsd-` installed.

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
| `gsd-pin-invariants` | SessionStart (incl. `source: compact`) | nothing — restates prohibitions, must-haves and open blockers a rewrite dropped | `pin_invariants` (on) |

**Correction (1.15 sync, `498df8846`): the pin never injected anything until then.** It
printed a top-level `additionalContext`, which Claude Code ignores — SessionStart
context is read only from `hookSpecificOutput.additionalContext`. And PostCompact,
the event it was mainly registered for, is observational and cannot add context at
all; after a compaction Claude Code re-fires SessionStart with `source: "compact"`,
the documented re-injection point. The pin now emits the SessionStart shape and is
registered on SessionStart alone. A PostCompact entry an older install left is
removed on the next install: the installer reconciles managed hook registrations
against the current build's set (`9f2e1f706`, `SETTINGS-HOOKS.RECONCILE` in
CONTEXT.md) — found live, when the 1.15 install left that entry beside the
SessionStart one. Its 5 s budget is deliberate (advisory, `726d82334`). It also
delivers worktree-provision warnings (below).

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

**Correction (1.15 sync): as written above the hook could not run, and never did.**
WorktreeCreate *replaces* `git worktree add` — the hook must create the checkout
and print its path; this one only equipped an existing checkout and printed
nothing, so registering it would have broken every worktree creation. It was
therefore registered nowhere, and "equip on create" did not exist. Rebuilt to the
contract (`.plans/worktree-provision-contract.md`):

- **Creates the worktree itself** (`9f674ee2e`): reads `name` from stdin,
  `<main checkout>/.claude/worktrees/<name>` on branch `worktree-<name>` from the
  invoking checkout's **local HEAD**; copies `.worktreeinclude` (the harness stops
  doing it once a hook exists). **stdout is the path and nothing else**, every
  diagnostic on stderr. Exit codes from the ADR-3889 registry; no fail-open path —
  printing no path is failure on this event. Stale base refuses before anything
  exists; equipment failure warns, or refuses and rolls back under
  `workflow.worktree_provision_strict`.
- **Paired WorktreeRemove** (same script): removes only worktrees under
  `.claude/worktrees`, deletes the branch only when its tip is reachable from
  another ref; a vanished directory drops only its own registration, never a
  repository-wide `prune`; a rollback that cannot finish says what it left
  (review L1/L2, `d5ffc3f7a`).
  **Observed live (2026-10-04, Claude Code 2.1.288):** a finished `isolation:
  "worktree"` subagent did NOT fire WorktreeRemove (a logging probe registered
  beside the hook stayed empty over a full subagent run), although the hooks
  reference says it fires "when a subagent finishes" and that Claude Code never
  deletes hook-created worktrees itself. Likely because a finished background
  agent stays resumable. Effect: agent worktrees under `.claude/worktrees`
  accumulate within a session. Still to check: whether session exit fires it;
  if not, `mn worktree-gc` is the cleanup path, not this hook.
- **Registered by the installer in `settings.json`** (`6c45ae800`; WorktreeCreate
  900 s, WorktreeRemove 180 s), not the plugin manifest; claims neither event when
  a foreign WorktreeCreate hook exists in the layer being written or its sibling.
  `findWorktreeCreateHook` (#4588) does not count GSD's own hook, so
  `worktree.baseRef: head` stays trusted and parallel waves stay on.
- **Uninstall removes the registration** (`a93dc1980`, below).
- **One creator per name** (`34efdfcc6`, review M2): a global and a local install
  registered it twice and Claude Code ran both, racing on `worktree add -b`. A
  local install now defers to a user-layer registration; the hook takes a per-name
  lock in the git common dir — a second creator waits and reuses, a dead holder's
  lock is taken over, a wait past the budget refuses (`create-locked`). Copied
  settings whose `$CLAUDE_PROJECT_DIR/.claude/hooks/*` are gitignored (absent in
  the worktree) are pointed at the source checkout (review L7).
- **Equipment only in GSD projects** (`d5ffc3f7a`, 3.13a): `.planning/config.json`
  inside the repository; elsewhere only create from local HEAD — "absent =
  enabled" must not spread to projects without `.planning/`.
- **PR bases** (3.13b): Claude Code turns `--worktree "#123"` / a PR URL into
  `pr-123` before the hook runs; the hook bases it on `pull/<n>/head` (GitHub),
  `merge-requests/<n>/head` (GitLab) or the first that fetches, refusing when the
  fetch fails. Names validated as the harness does; `/` → `+` in path and branch.
- **Warnings reach the session** (3.13c): a creation that succeeds with warnings
  records them in the worktree's git dir (`hooks/lib/worktree-notice.js`);
  `gsd-pin-invariants` hands them to the first SessionStart there and stamps them
  delivered. Before, they were visible only in Claude Code's debug log.

Side finding: **the built-in mechanism bases agent worktrees on `origin/HEAD`.**
Here `origin` is the owner's GitHub fork, ~900 commits behind, so every
`isolation: "worktree"` agent got base `d2ae7fe39`. The hook's local HEAD removes
that. Tests: `tests/mn-worktree-provision.test.cjs`, 52 cases.

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
- **Blocking fork guards at 120s** (`prohibition-guard`, `test-tamper-guard`). At the time the
  installer did not register fork hooks (hand-registered in `~/.claude/settings.json`).
  *Superseded by the sync:* the installer registers all five on Claude (`be78c0ad8`,
  `6c45ae800`), migrates the guards off 5 s via `FORK_BLOCKING_GUARD_NAMES` (`726d82334`)
  and removes them on uninstall (`a93dc1980`).
- **mn-verify-gate scripts moved to `~/.gsd/mn-verify-gate/scripts/`.** The copy under
  `~/.gsd/capabilities/` collided with the built-in registry entry and printed a load
  warning on every `gsd` call. *Superseded by the sync (3.12):* the scripts are now
  `gsd_run` verbs and the `scripts/` dir is gone (`e862aa285`, `2691af8b9`).
- **The `.pen` design contract lives in the repo now** (`gsd-ui-auditor`, `gsd-ui-checker`,
  `gsd-ui-researcher`, `templates/UI-SPEC.md`). It was only in the installed copy, and every
  reinstall moved it to `gsd-local-patches/`. Open: the checker still says "6 dimensions" in
  its frontmatter and table and `workflows/ui-phase.md` says "All 6"; `ls **/*.contract.json`
  needs globstar in bash; project-specific paths (`bun tools/ui-system/...`) are hard-coded.
- **Known failing before any of this:** 6 tests on the hooks manifest, 7 in
  `research-agent-profiles` (fork MCP tools in `tools:`), `gsd-executor` over the LARGE cap.

### The upstream 1.15 sync (2026-10-03..04)

Plan `.plans/upstream-sync-plan.md`; per-file conflict decisions
`.plans/sync-conflict-decisions.md`; script → verb map `.plans/mn-verify-gate-to-cli.md`;
briefs, reviews and logs in `/Users/govorin/forks/gsd-sync-backups/2026-10-03/`.
Base `81cb6f8f3` (v1.15.0, the merge-base with `upstream/next`). Waves 1–2 by file
zone, fix wave 2.5 (F1–F3, L9), wave 3 (mn gates and tools as `gsd_run` verbs,
worktree provision, mermaid diagrams/maps), follow-ups FU-A..D. Rollback tags
`sync-pre-msgfix`, `sync-pre-fu`. Each wave was reviewed by an independent
read-only agent: `review-wave2.md` 4 high / 11 medium / 9 low, `review-wave3.md`
2 high / 8 medium / 9 low.

**Fork defects the sync surfaced** — wrong before the sync, not merge damage:

| Defect | Fix | Commit |
|---|---|---|
| `gsd-worktree-provision` would break WorktreeCreate (no checkout, no path on stdout), so it was registered nowhere | rebuilt to the contract — see "A worktree is a checkout" | `9f674ee2e` |
| `gsd-pin-invariants` never injected: top-level `additionalContext`, and PostCompact cannot inject | SessionStart (`source: compact`) + `hookSpecificOutput` | `498df8846` |
| autonomous fork steps (spec-phase, blocking-gates, human-needed, gaps-found) had no `gsd:section` markers, so upstream's section manifest never included them | `when="always"` sections | `1ee725fca` |
| `MAX_PHASES` read through `gsd_run` in the arg-parsing fence, before the launcher defines `gsd_run` — always the empty default | read after the init fetch, then a lazy step file under the 40960-char cap | `32d12908d`, `3c6ef2540` |
| feature-vocabulary `--check` vacuous in CI: the source ROADMAP is gitignored, the absent-roadmap path returned ok, `--write` failed on every clone | without a roadmap the committed manifest must exist and agree | `9e394f41f` |
| three gate tests passed `runNode` a `timeout` key the seam ignores — every bound ran on the 60 s default | `timeoutMs`, named constants | `04b146494` |
| executor's eager `@`-include of `executor-worktree-capture.md` failed worktree-cleanup #1297 | upstream's inline `<worktree_metadata_capture>` back, orphan removed | `31139f2f9` |
| `worktree-gc` failed open: an uncountable branch read as 0 commits, blind fallback to `master` — every `worktree-*` branch reapable in a repo without origin/HEAD, main or master | fail closed in the `gsd_run mn worktree-gc` port | `0a77c0c80` |
| prohibition guard inlined an older, narrower copy of the Kimi #2304 block (H4) | canonical block verbatim, parity-bound | `880833778` |
| fork write guards outside `BLOCKING_GUARD_NAMES`: the 5→120 s migration skipped them, a 5 s install stayed 5 s (a timed-out guard does not block) (M11) | own `FORK_BLOCKING_GUARD_NAMES` joined to the migration | `726d82334` |
| uninstall deleted the fork hooks but kept their registrations — after it, every worktree creation failed on a dangling WorktreeCreate; the test was vacuous (read `settings.json`, install wrote `settings.local.json`) (w3 H1/M1/M8) | fork hooks in the managed sets, current-scope settings file, every event swept; test treats a missing file as failure | `a93dc1980` |
| `--help` lacked five families (mn, refactor, claude-orchestration, scan-sessions, write-profile) | listed + two parity tests against `commandFamilies` | `605a2431f` |
| literal `~/.claude/hooks/` in a doc comment survived tsc into `worktree-base-ref.cjs` and shipped to Cline | named through the `<userClaudeDir>` parameter | `4a1e230df` |
| line-keyed `PROSE_ALLOWLIST` entries went stale with each insertion above them (executor 828→842, execute-plan 421) | entries moved | `3c0184c4a`, `f0e235266` |
| upstream workflow text, found by the map generator, fixed in the fork only: `execute-phase` `initialize` never closed (`safe_resume_gate` inside); `plan-phase` / `quick` checker prompt — outer ` ```markdown ` closed by nested ` ```json `; `docs-update` jumped to a nonexistent `detect_runtime_capabilities`; Pattern A spawn in prose in `execute-plan.md` | closed step, 4-backtick fence, real targets, code block | `7efb4cde4`, `d507afee2` |
| diagram identifiers indexed from the git root (M6) but `%% gsd:source` / `source=` confined to the project root — a monorepo package could not cite `../libs/…` (FU-E) | one `projectRoots` seam: paths written against the project, bounded by the repo; `resolveRepoRoot` duplicate removed | `4c5d70a79`, `89e6a0346` |
| health judged VERIFICATION reports of the current milestone only while `audit-open` read every phase and archive — health said 0, audit crashed (found repairing live projects) | one report enumeration for readers and health; W031 repair reaches archives | `abff09a78` |
| `validate health --repair` applied every non-destructive remedy at once (config keys, MILESTONES backfill) — no way to fix only a status | `--repair --only <codes>` | `482cecdd2` |
| broken frontmatter YAML read as `{}` — a report's status vanished and the phase silently read as `missing` | `parseFrontmatterStrict`; readers refuse (`VerificationReportUnparseableError`), health W032 | `abff09a78` |
| the install left managed hook registrations the build no longer makes (an old PostCompact pin beside the SessionStart one) — the class of the dangling-WorktreeCreate defect, on install | install reconciles managed registrations against the build's set; one filter for install and uninstall | `9f2e1f706` |
| an install test read the real `~/.claude` | user layer sandboxed | `d52b311bd` |
| `workflow.verify_gates` unsettable: declared `string`, read as a map — `config-set` parsed the JSON then the type check refused; a broken roster read as "not configured" | `string-map` capability config type; `invalid_checks_config` (exit 69) | `560b14ae9`, `5896b58b5` |

`clean-state` `--git-path` is not a sync finding: the original script already
resolved it from the cwd (the first-draft defect under "A clean tree at ship");
the port `4e9cae33c` keeps that and the test pins it in a linked worktree.

**Wave-3 port defects** (new code, `review-wave3.md`): mutation step left the mutant
on SIGTERM because `spawnSync` blocks the handler — async process group + write-ahead
restore journal in the git dir (H2, `0cbc2df81`); erDiagram attribute regex 2^n
(24 keys = 1 s) on the blocking gate — one-pass tokenizer (M3, `82b63d638`); plain
mermaid and implicit states bypassed identifier checks as WARNINGs — declared at
first use, BLOCKER in design mode (M4, `82b63d638`, `2be88f7fc`); a `gsd:derived`
marker the checked model could write switched checks off — derived blocks are
regenerated and compared, `derived_stale` / `derived_unverifiable` (M5/5.7b,
`2be88f7fc`); declaration index from the project dir gave false `absent` in a
monorepo — git top level; missing phase dir now unresolvable (M6/L4, `cf2f7a784`);
blast radius trusted the executor's own SUMMARY commit list — unlisted commits
attributed, `via: unlisted-commit` (M7, `194d4d167`); optional predicate with an
empty phase dir passed — fails closed (L3, `68352294f`); L5 `071bde7f3`, L6 `eb62c3e97`.

**Merge regressions caught by review wave 2:** the planner lost "Every threat has a
Severity" to a size trim — upstream text restored (H2, `b1b7c8401`); `template fill
verification` still wrote `status: pending` (M9, `9a739ca3b`); the iterate step
printed all of STATE.md per phase again (L2, `461ecb018`); bare
`references/honest-verifier.md` cite (M2, `8f280ffcf`).

**Decisions:**

- **H3:** upstream's `live-dom-uat` executor-surface test refused every MCP family
  beyond context7. Narrowed to its meaning — browser/DOM families refused by prefix,
  the three code-navigation families (atlas, serena, codebase-memory) a named
  allowlist, any unreviewed family still fails (`cd8f7615c`). Tools stay on agents.
- **3.4c:** old plans without `<fails_when>` and `checkpoint:decision` without
  `auto_select` are **not migrated** — the `<fails_when>` gate fires only at
  planning (written plans execute), and a decision without `auto_select`
  escalates to the owner safely.
- **Capability version is not bumped separately** (3.12c): a native capability's
  `version` is stamped in lockstep with the package (ADR-1244 D6, guarded by
  `manifest-version-sync` B2); `engines.gsd >=1.15.0` already names the host
  surface the `mn` family uses (`605a2431f`).
- **health W031 repairs only `verified`** (3.4a, `ecad6ca73`): the one legacy status
  with a single meaning (old spelling of `passed`). Every other out-of-set value
  stays W030 advisory with a proposed replacement; `--repair` never guesses.
- **`.plans/` is allowlisted in `lint:retired-runtime-name`** like `docs/research/`
  (`c34356829`): dated working records, never installed; per-line markers would
  fork the copy on every carry. `docs/plans/` stays scanned.

### Phase 4 of the sync plan (2026-10-04)

Merged into `next` as `fix-test-count`, `p4-a`..`p4-d` (`775ba19bd`..`9f74cfbb6`),
derived artifacts `b00ce28bc`. New keys are all on `mn-verify-gate` unless noted;
absent = enabled applies, so the defaults below are the effective ones.

- **4.3 check statuses** (`13a81aec2`): every `verify gates` check lands in
  `pass | fail | stale | timeout` (one rule table, `CHECK_OUTCOME_RULES`): exit
  127/126, a spawn error or a bare signal is `stale`, `ETIMEDOUT` is `timeout`.
  The record carries `{name}_status` / `{name}_cause` and per-status counts; a
  dead roster no longer reads as a red suite.
- **4.1 baseline gate** (`73c11f22b`): `execute-phase.md` gains
  `execute_pre_hooks` — `render-hooks execute:pre`, steps per
  `loop-hook-dispatch.md`, gates per `execute-phase/steps/execute-pre-gate-hooks.md`;
  a blocking gate halts before the first wave. Step `verify baseline` writes
  `{N}-BASELINE.md`, gate `check mn-baseline` judges it, `--accept <why>` starts
  on a known red base. Key `workflow.verify_gates_baseline` (default **off**: it
  blocks and costs one full check run per execute). Closes Remaining §7's
  `execute:pre` paragraph. Integration fix `8f4957136`: the gate query was
  unquoted (SC2086) and the step file was only mentioned, not dispatched
  (response-language coverage).
- **4.2 failure paths** (`ad94ca92a`): `<failure_paths>` in PLAN.md, each path an
  `<invariant>` plus a `<check>` in the `<automated>`/`<fails_when>` grammar,
  required when `files_modified` names a migration or `user_setup` is non-empty.
  `check mn-failure-paths` reports `paths_without_check / paths`. Keys
  `workflow.failure_paths` (on, a planner instruction) and
  `workflow.failure_paths_enforce` (off, halts `plan:post`).
- **4.6 restatement** (`f315b9dab`): `workflow.restate_goal` (on) — three lines at
  the end of every `<objective>` (Restated / Not doing / Sources); plan-checker
  Dimension 1b treats a contradiction as a blocker.
- **4.5 grill mode** (`bc7012aed`, `8ff4adabb`): `src/decision-tree.cts`,
  `gsd_run discuss tree`, `discuss-phase/modes/grill.md`; `--grill` or core key
  `workflow.discuss_mode: grill`, depth capped by `workflow.max_discuss_passes`
  (both validated on set).
- **4.7 graphs** (`b60d0dae7`): `/gsd-progress --graph` — a `flag:--graph`
  section `graphs` (`progress/steps/graphs.md`); a plain report draws nothing.
- **4.4 writing-for-agents pilot** (`2f9e3d3a1`): `agents/gsd-executor.md`
  48 466 → 41 803 B with no behavior change; method and measurements in
  `.plans/writing-for-agents-pilot.md`.
- **Test-count fixes** (`283cf2df1`, `c7589b952`, `ab8dd6255`): FU-F/G suites
  folded into their module test files, example CONTEXT-INDEX regenerated, SC2086
  in `health.md`.
- **Integration follow-ups** — each branch passed its own suites, the merged tree
  failed ten files they did not run: `cb8212a69` (failure-paths fragment cited
  `~/.claude/...`, which the verbatim registry leaks to other runtimes; plan:pre
  all-off fixture; Dimension 1b in `docs/AGENTS.md`), `8c0578db9` (execute:pre
  registry guard now pins the baseline pair; retired `/gsd-` slash form;
  compact-content benchmark baseline), `0b5256b2a` / `065a640a3` (`GSD_WS` in the
  grill and graphs fences, #4772; `--grill` / `--graph` in full help, #2954 —
  kept inside its 846-line budget by `a34b98d69`),
  `55ccdbdc2` (pre-existing: `BACKLOG.md` in the #2269 call-site sweep). **Lesson:**
  a branch's own test list is not enough for shipped-markdown or registry
  changes — run `test:affected` before handing a branch over.
- **Ack lifecycle** (`73292af83`): `emitted-attribution` against `upstream/next`
  reported the `Emitted-Drift-Ack-Growth: gsd-executor.md` trailer of `b1b7c8401`
  as stale — 4.4 shrank the executor below upstream — and the only remedy was
  amending that commit. **A long-lived fork's range is its whole history**, cited
  by hash here and in tags, so an ack needs a lifecycle, not an amend: a later
  commit carries `Emitted-Drift-Ack-Withdraw-<Kind>: <key> — <reason>`. Strict —
  only an earlier, still-live ack of the same kind and key can be withdrawn; a
  withdrawal acknowledges nothing. Rules: ADR-3942 fork amendment, CONTEXT.md
  `RULESET.EMITTED_ATTRIBUTION.withdraw`. The executor ack is withdrawn by the
  commit that records this entry (`dffd79c59`).
- **`fix-git-locale` merged** (`562a7c2ae`): git's locale pinned in `execGit`,
  `ls-remote --symref` for the base branch. Full `npm test` afterwards: 44 823 tests,
  only the four stale-`origin/next` failures remain (sync plan, "Эталон 0.5");
  `742f419bd` fixed the one failure the integration had added.
- **Retired config keys** (`fix-legacy-config`, `42ebe957f`): upstream #4974 took
  `safety` and six `gates.*` toggles out of `templates/config.json`, but projects
  made from the older template kept them, the loader called `safety` "unknown" on
  every command and `migrate-config` reported "already canonical".
  `RETIRED_CONFIG_KEYS` in `configuration.cts`: `migrate-config` drops them
  (`retired` in its report), the loader names them as retired and points at the
  command. Owner configs cleaned with it (mn `94c6ea95a`, get_your_look_up
  `f91737ca`); the other stray keys there (`version`, `project_name`,
  `planning_root`, `milestone_*`, `agents`, `profile`) were never GSD's and were
  removed by hand. Backups: `gsd-sync-backups/2026-10-04-install/config-repair/`.
- **4.9 report A/B** (`4fd3c5cf3`): `scripts/experiments/report-ab/` — 8 generated
  phases (18 seeded defects, 2 controls), variants A text / B + neutral mermaid /
  C + shipped `plan graph`, isolated `claude -p` runs (`--tools ""`,
  `--setting-sources ""`, stdin only), 96 runs per model. Sonnet sits at the
  ceiling (recall A 95.8%, B 100%, C 97.2%) and gets noisier with a diagram
  (precision 100 → 97 / 95%). Haiku: B 76.4% vs A 80.6% (CI [−11, +4] pp);
  C equal overall, but text-only defects 21/24 → 15/24 (4 of 6 worse, none better,
  sign test p=0.125) — the marks pull attention from what they do not mark.
  **Decision:** no diagram/HTML reports as a defect-finding aid for LLM
  verifiers; `--graph` stays a picture for humans, not an input to the verifier
  or plan-checker. Human readers were not measured. The ceiling showed up first
  on ~35-line plans (100% everywhere), so the fixtures use realistic plan length.

### Pocock practices, wave 0 (2026-10-04)

Design `.plans/pocock-practices-design.md`; tag `pre-pk0` marks `next` before it.
Three foundation branches merged with no conflicts (the `.gitignore` /
`eslint.config.mjs` list tails auto-merged): `pk-z1` `f71b91067`, `pk-z2`
`8d56ad0d2`, `pk-z3` `afdd4a2d6`, then inventory `ddd1bfa62`, config key `6d2cb1cbc`, derived
artifacts `8b49455a7`.

- **Z1** (`bc2c2e397`, `d4ff22b83`): `src/code-graph.cts` — import graph on the
  `symbol-index` lexer with tsconfig `paths`, typed `unresolved` reasons,
  fan-in/out, SCC, `moduleStats`; `src/git-history.cts` — churn and co-change from
  one `git log --numstat`, degraded `commit-cap:N` / `empty-window`; `execGit`
  gained `maxBuffer` (`git-output-overflow`).
- **Z2** (`3dc04bd0e`..`9b36f4f53`): `src/session-transcript.cts` (the one transcript
  reader; `excerpt()` is the only text egress, redacted via the new
  `secrets.redactSecretText`), `profile-pipeline` moved onto it,
  `src/retro-signals.cts`, `src/retro-inventory.cts`.
- **Z3** (`db7d7a26a`..`eeffd1a1e`): ScopeUnit `window` in
  `gate-evaluation-scope`, `--since/--until/--lens` in `code-review-flags`,
  ADR-5208 (amends ADR-5057 §4).
- **Config keys.** `code_review.window_lenses` (string, default
  `correctness,standards,spec,simplify`) is declared on the existing code-review
  capability and documented in `docs/CONFIGURATION.md`; nothing reads it yet (Z4
  will, for an empty `--lens`). The `retro.*` keys (`signal_threshold`, the
  `*_min` thresholds, `excerpt_window`, `max_signals`, `excerpt_chars`) are NOT
  registered: capability keys live in a `capability.json`, and the `retro`
  capability is wave 1's (Z6). Until then `resolveRetroThresholds` reads them
  with defaults and names bad values in `problems`, but `config-set retro.*`
  rejects them as unknown — Z6 must declare them.
- **Checks:** `lint`, `lint:generated-sync`, `lint-test-file-count`,
  emitted-attribution (140/140), `lint:ci` step by step (only
  `removed-but-needed`). `test:affected` from `pre-pk0`: 21 083 tests, 11 failures,
  all `tests/refactor-trigger-cli.test.cjs` — environmental: the owner's
  `~/.gsd/defaults.json` makes `gsd-tools` print a #3532 warning on stderr, which
  the test parses as JSON. `run-tests.cjs` sandboxes `GSD_HOME` and the file passes
  44/44 there (on `pre-pk0` too); `affected-tests-lib.runNodeTestFiles` spawns
  `node --test` directly without that sandbox. Open: route affected files through
  `run-tests.cjs --files`, or give the runner the same `GSD_HOME` sandbox.

### Pocock practices, wave 1 + lifecycle stages (2026-10-05)

Tag `pre-pk1` marks `next` before it. Merged in order: `fix-affected` `fbc9f6927`
(closes the wave 0 open item: `scripts/hermetic-env.cjs`, applied by run-tests,
test:affected and Stryker), `pk-z4` `bf154df4e`, `pk-z6` `408b98aba`, `pk-z5` `e6b1e1c4e`.
Conflicts only in list tails (`.gitignore`, `eslint.config.mjs`, `src/io.cts` +
`tests/io.test.cjs` ERROR_REASON, `docs/json-errors.md`) — union; the codex widening-role
count was recomputed from the tree (21/20 → 23, retro analyst added). Integration
`cb741b44b`, derived `f29cf0598`.

- **Wiring.** Refuter `<modes>`: `plan`, `review` (Z4), `arch`, `retro` (patches of Z5/Z6
  recast into the mode shape; arch-survey now sends `<mode>arch</mode>`). Architecture
  capability: survey half (`commands: arch`, `gsd-arch-surveyor`, skill `arch-survey`, the
  `architecture.survey_*` keys). Code-review capability: lens agents,
  `code_review.window_max_files_per_batch` (40). Model catalog, agent-contracts, ns-review
  router and `audit_review` cluster (arch-survey, retro), help full + compact
  (`--since`, arch-survey, retro; FULL_BUDGET 847 → 848 for the one line), TOP_LEVEL_USAGE
  (`arch`, `retro`), INVENTORY rows, CONFIGURATION sections (Architecture, Retro).
  Compact variants: none — the registry does not require them for the new agents.
- **Stages (design G)** — capability steps in loop points, the workflow calls the CLI and the
  CLI decides (`97388a830`, `fe0e48248`, derived `74bc86766`):
  - New loop points **`milestone:pre` / `milestone:post`**, hosted by `complete-milestone.md`
    (loop-host step `milestone`, orchestration family): pre after `verify_readiness`, before any
    archive; post after the tag. ADR-857 amended; generator, registry schema, validator,
    resolver fallback, capability matrix and tests moved 12 → 14. Steps only (advisory; no
    gates/contributions at the boundary). A `ref.command` there gets `--milestone <v>`.
  - **Stage answer** in `loop-hook-dispatch.md`: a command step may return `decision`
    (skip/suggest/auto), `message`, `next {skill, args}`; suggest prints, auto dispatches the
    skill after an in-context charset check. `ship.md` ship:post now dispatches command steps.
  - `review stage` (code-review, `milestone:pre`, when `workflow.code_review`): window since
    `LAST-WINDOW.json`, else the previous `v*` tag merged into HEAD (not the one being closed);
    pre-pass always; `code_review.window_at_milestone` (boolean, **true**) → auto
    `/gsd-code-review --since <since>`, false → suggest. Empty window → skip; no start → suggest.
  - `arch stage` (architecture, `milestone:post`, when `architecture.metrics_at_milestone` —
    new boolean, **true**, so ADR-857's "every hook can be switched off" holds): `arch metrics
    --compare-last` over the configured scope always; `architecture.survey_at_milestone`
    (**suggest** / auto / off) decides; the survey is scoped to the grown zones' directories.
  - `retro stage` (retro, `execute:post` and `ship:post`, when `retro.enabled`): `signals
    --decide` plus `next {retro, --session <id>}`; `retro.auto` (**suggest** / auto / off).
- **Defects found and fixed** (each with its test): Z4 lenses lacked the file-writer contract
  (`f0fa0e7e2`) and a model-catalog entry — `unknown_agent` under every profile (`36349d2c0`,
  new test: every agent has a catalog entry); **`/gsd-code-review` died in every project but
  this repo** — the window dispatch required `./gsd-core/bin/lib/code-review-flags.cjs` from
  cwd and exited (the old flag parse beside it silently dropped `--fix`/`--depth`): now
  `gsd_run review invocation -- <args>` (`5cf6eb31a`, the shipped-bash test runs outside the
  repo); window-scope.md launcher + colon syntax (`e76db4e72`); bare `gsd-tools` in the
  command help (`6374587e7`); a consumer path in agent-contracts (`253deb3f3`); the
  standards lens is an agent_skills consumer (`12e363f81`); `scripts/test-env.cjs` matched
  the push-gate test pattern → `scripts/hermetic-env.cjs` (`3368c4c2a`); retro selection
  quoting (`e8f60e31b`).
- **"Red on next too" (task 3), checked on `pre-pk1`:** `docs-parity (/gsd-retro)` — wave 0's
  INVENTORY rows named `/gsd-retro` before the command existed; resolved by merging Z6, no
  code change. `phase-id (retro-signals)` — the drift scanner read retro's Unicode word-end
  class `(?![\p{L}\p{N}])` as a phase-name check; sanctioned with the dedicated
  `// phase-id-owner:` line (`6fea2ca1e`).
- **Checks (final tree):** `lint:generated-sync`, `lint`, `lint-test-file-count`,
  `check:alias-drift`, emitted-attribution against `merge-base(HEAD, upstream/next)` 140/140,
  `test:mermaid-real` 150/150, `lint:ci` step by step — only `removed-but-needed`. Full
  `npm test`: 45 367 tests, 4 failures, exactly the reference set (differential attribution,
  quick-batch byte-identical, removed-but-needed vs origin/next, compact-content partition
  guard). The compact-content benchmark baseline was refreshed for the complete-milestone growth.
- **Agents' decisions kept:** the refuter belongs to mn-verify-gate (without it findings are
  `unverified`); `LAST-WINDOW.json` is written only after the window's REVIEW.md, never by the
  stage; retro candidates are never applied, `auto` only spawns the analyst.
- **Not done / open:** other `require('./gsd-core/bin/lib/…')` sites in `code-review.md`
  (`code-review-depth`, `fallow-runner`) and `code-review/steps/structural-pre-pass.md` are the
  same upstream class (silently degrade outside the repo) — need CLI verbs like `review
  invocation`. `code-review.md` sits at ~50 000 normalized chars, just under the
  prompt-stuffing threshold. The stage answer is prose-dispatched like every step: no runtime
  check that a host honoured `next`. From design wave 2, `audit-fix --source` (a window review
  as an audit-fix source) is not done; no `tests/emitted-drift-acks/` fragment was needed —
  the one growth (complete-milestone.md) carries an `Emitted-Drift-Ack-Growth` trailer. Wave 3
  (evals on `report-ab`) remains.

### Post-merge fixes after fix-cr-cwd and pk-eval (2026-10-05)

The acceptance run on `next` after the `fix-cr-cwd` (`pre-fixcr`) and `pk-eval`
(`pre-pkeval`) merges failed outside the reference set. Each cause, with its fix:

- `runtime-launcher-parity (B)`: `39e10f843` made step 1 of
  `code-review/steps/structural-pre-pass.md` call `gsd_run`, but the preamble stayed in
  step 3's block. Moved to the first `gsd_run` block (`f583b6127`).
  `sync-runtime-launcher.cjs` keeps an existing placement (#3146), so it could not fix this.
- `slash-command namespace (#3443)`: `3afbaaca9` wrote `/gsd-code-review --since` in the
  audit-fix command and workflow; now colon form (`7cddbf3ef`). In colon form,
  lint-skill-deps sees the reference, so `requires:` now lists `code-review` (`616a8f56e`).
- `#2517 model-omit guard`: arch-survey's inline rule matched only by accident (`model=`
  read case-insensitively inside `REFUTER_MODEL=` within 200 chars of "Omit").
  `83a9dc34e` put a paragraph between them. Now the marker block (`2769f328d`).
- `emitted-attribution` against `merge-base(HEAD, upstream/next)`: the
  `Emitted-Drift-Ack-Growth: arch-survey.md` trailer of `83a9dc34e` was stale from
  birth. Growth keys on files that exist upstream, and arch-survey is fork-new. The
  commit recording this entry withdraws it.
- `lint-fix-has-regression-tests`, `lint-example-parser-parity`, `lint-no-adhoc-regex-escape`
  were listed as failing too: an artifact of the step loop (`tr '\x01'` mangled the
  script names). Each exits 0 on `62cfcf0bf` and after. No change.
- **Checks:** emitted-attribution vs `merge-base(HEAD, upstream/next)` 140/140,
  `regen:derived` (no drift) + `lint:generated-sync`, `lint`, the 50 `lint:ci` steps one by
  one (only `removed-but-needed` fails), `test:mermaid-real` 150/150. Full `npm test`: 45 551
  tests, 4 failures, exactly the reference set.

### Retro on a schedule (2026-10-25)

Branch `feat/retro-cadence` from `3c4a32d3d`. The owner asked for retros once a milestone is
planned and every two or three phases, not only when a session's friction crosses
`retro.signal_threshold`. ADR-5209 §9 (amends §6; §5 "never applied" unchanged), ADR-857
amendment 2026-10-25.

- **Triggers.** `retro stage` names `trigger` (`signals` | `milestone-start` | `cadence`) and
  `triggers`. `milestone-start`: ROADMAP phases, none started (`executed`/`complete`/`partial`),
  not shipped, no retro journaled in this milestone (`retro.at_milestone_start`, default true).
  `cadence`: ≥ `retro.cadence_phases` (default 2 by the owner's decision of 2026-10-25, first written as 3; 0 off) phases of the milestone *executed*
  since the last retro in it. Executed, not complete: `execute:post` runs before the verifier,
  so the phase that just ran would otherwise count one stage late. Friction wins and keeps its
  answer byte-for-byte. A scheduled command adds `--since <last run>`.
- **Journal, not inference.** `retro prepare` appends to `.planning/retro/RUNS.json` (stem, ISO
  instant, planning dir, milestone, executed phase numbers). RETRO stems are date-only, mtimes
  reset on clone, and "Nothing to retro" writes no report. An invalid or partly malformed
  journal is never rewritten. Pre-§9 retros have no run, so the first count runs from the
  milestone start.
- **`gsd-tools retro due`** — read-only JSON for `gsd-deck`; one shape whatever the config
  (`due`, `trigger`, `triggers`, `reason`, counts, `lastRetro`, `latestReport`, `journal`).
- **Loop point `roadmap:post`** — step `roadmap` hosted by `new-milestone.md`, `new-project.md`
  as an auxiliary host (first milestone). Not `new-milestone:post`: `CALL_SITE_RE` in
  `gen-loop-host-contract.cjs` is `[a-z:]+`, and `milestone` already names the boundary. First
  in pipeline order; 14 → 15 points across the generator, registry schema, validator, resolver
  fallback, capability matrix and tests. The retro step there has `when: retro.at_milestone_start`.
- **Emitted attribution depends on the base.** Against `merge-base(HEAD, upstream/next)` 140/140:
  `new-milestone.md` already carried a fork growth trailer, so `8faf94d7e` withdraws it and
  re-declares one reason covering both; `retro.md` is fork-new, so no growth trailer. Against
  local `next` the same trailers fail (the withdrawal has no earlier ack in range, and
  `retro.md` growth is unacknowledged). No set of trailers satisfies both bases. The fork's
  standard (this file) is the upstream merge-base. `tests/emitted-drift-acks/` no longer exists
  (ADR-3942 §6); the project CLAUDE.md still names it.
- **Checks:** `build:lib`, `regen:derived` + `lint:generated-sync` clean, eslint on every
  changed source/test file. Unit suite (`test:affected` widened to it): 44 543 tests, 5
  failures. Four are the reference set (differential attribution and removed-but-needed vs the
  stale `origin/next`, compact-content partition guard, quick-batch byte-identical). The fifth,
  the compact-content benchmark, was this branch's `new-project.md` growth; the baseline was
  refreshed (`c8dd14702`). Integration 59/59, security 384/384. New tests:
  `tests/retro-cadence.test.cjs` (38), 18 more in `tests/retro-command-router.test.cjs`.
- **Not done:** no `roadmap:pre`; no runtime check that a host honoured the stage's `next`
  (same as every stage).
- **Review fixes** (independent review, merge after fixes; new commits on the branch):
  - `--ws` was lost at `roadmap:post`: step 10 deleted `.planning/.gsd-ws-arg` before step
    10.6 ran, so the stage read the root roadmap and the retro it proposed journaled
    `.planning`. The file now lives until 10.6, which passes `--ws` to `render-hooks` and to the
    `ref.command`; every command the stage proposes carries `--ws <name>`; `/gsd-retro` passes
    it to `prepare`. `new-project` takes no workstream. Integration test
    `tests/retro-cadence-workstream.integration.test.cjs` (`--ws` and `GSD_WORKSTREAM`).
  - A `RUNS.json` that cannot be read whole read as "no retro yet": a suggestion on every stage
    that the held retro could not clear. Now `journal-invalid` (fail closed: no trigger, counts
    and `lastRetro` null, `baseline: unknown`; the stage answers `suggest` with a warning, no
    command, no `next`; journal problems in the top-level `problems`).
  - `RUNS.json` and, boy scout, `CHECKS.json` are edited under `.planning/retro/.<NAME>.lock`
    (shared `capability-lock`, injectable `JournalLock` seam; tests drive contention, no real race).
  - `ship:post` runs `retro stage signals` (friction only): no phase executes between a phase's
    `execute:post` and its `ship:post`. The reminder at the next phase's `execute:post` while a
    retro stays due is intentional (ADR-5209 §9).
  - `--since <ISO instant>` is in the usage, the argument-hint and `retro.md`; a test runs the
    stage's `next.args` through `prepare`.
  - The project CLAUDE.md is untracked (`6e68e19b3`, `.gitignore`), so its stale
    `tests/emitted-drift-acks/` paragraph cannot be fixed by a commit; see the note below.
  - Owner decision: `retro.cadence_phases` defaults to 2 (`2ee90daa4`).
  - **Checks after the fixes:** `build:lib`, `regen:derived` + `lint:generated-sync` clean, eslint
    on every touched source/test file, the retro + loop test files 1283/1283,
    `GSD_EMITTED_BASE=upstream/next` emitted attribution 140/140. Unit suite (`test:affected`):
    44 593 tests, 4 failures, exactly the reference set. Integration 62/62, security 391/391.

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

**Closed for `verify:pre` by the 1.15 sync** (`5c6d43b21`): upstream's
`verify_pre_hooks` dispatches every hook kind through
`references/loop-hook-dispatch.md`, and the fork's step declares `verify gates`
so it matches the dispatcher's pattern. **`execute:pre` closed by phase 4.1**
(`73c11f22b`): `execute-phase.md` now renders and dispatches it (steps, then
gates). Nothing of §7 remains open. Original finding below.

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
`execute-phase.md` is 94 575 bytes, at the budget ratchet. Deferred. *(Since
done — see "Phase 4 of the sync plan": a step records, a gate blocks.)*

---

## Known dead ends

Recorded so they are not rediscovered.

- **`.phase-manifest.json`** — `undo.md` reads it; nothing writes it. Phase-scoped undo always falls back to conventional-commit scope matching, so a commit without the phase scope is invisible to the revert. Documented in `undo.md`, not fixed: writing a producer duplicates what git already records.
- **`plan-milestone-gaps.md`** — deleted upstream (#2790), but `tests/phase.test.cjs:5673` asserts the file exists. Left in place with a `<status>` block.
- **`BACKLOG.md` / `THREADS.md`** — in `CANONICAL_EXACT`, produced by nothing. Real homes are `ROADMAP.md ## Backlog` (999.x) and the `.planning/threads/` directory. Registry entries kept (harmless); the docs claiming a producer were corrected.
- **`intel` capability** — its export extractor does not parse `export type` or `export interface`. In a Zod-first codebase it is blind to most types.
- **`artifact-frontmatter-equals`** — documented on `next`, absent from published 1.9.1. Any gate declaring it halts instead of checking. Recheck after an upstream release.

## What not to repeat

Lessons from the 1.15 sync, each paid for by a defect above.

- **Never trust `origin/*` as a base.** `origin` is the stale GitHub fork; Claude
  Code's built-in worktree creation uses `origin/HEAD` and gave agents a base ~900
  commits old. Create from local HEAD; measure against `upstream/next`.
- **Read the event's output contract before registering a hook.** PostCompact
  cannot inject; SessionStart reads only `hookSpecificOutput`; WorktreeCreate must
  create and print a path. A test has to consume the shape the harness reads, not
  "it printed something".
- **No guard outside the canonical block or list.** An inlined copy of a shared
  block drifts (Kimi normalization); a guard outside `BLOCKING_GUARD_NAMES` misses
  every migration keyed off it. Join the canonical source and let parity bind it.
- **A check that passes on absence is not a check.** Wrong settings file read as
  "removed, fine"; absent roadmap read as ok; an ignored `timeout` key. Treat a
  missing input as failure and keep a control that must survive.
- **Fail closed on what cannot be counted** — an unknown commit count, an empty
  phase dir, an unresolvable main ref.
- **No marker the checked agent can write may exempt it from the check**
  (`gsd:derived`).
- **No line-keyed allowlists in files the fork edits** — every insertion above
  moves them.
- **Do not trim upstream text to fit a size budget.** It costs upstream bytes and
  silently drops pinned items; move fork text into a reference instead.
- **`spawnSync` and a signal-restore handler do not mix** — the handler never runs
  while the child does.

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

**Emitted attribution: run it against `upstream/next`.** A bare `node --test
tests/emitted-attribution.test.cjs` tries `origin/next` first (then `next`). `origin/next` is
the stale fork on GitHub: the trailer read over its merge-base range overflows the git buffer
(`outcome=buffer_overflow`), and local `next` is the wrong base for the fork's trailers. Run
`git fetch upstream && GSD_EMITTED_BASE=upstream/next node --test tests/emitted-attribution.test.cjs`.
Acknowledgments are commit trailers (`Emitted-Drift-Ack-Growth` / `-Hash`, ADR-3942). The
`tests/emitted-drift-acks/` directory is gone (ADR-3942 §6), whatever the untracked project
CLAUDE.md still says.

**Tests need `npm ci`, not just a build.** The earlier `MODULE_NOT_FOUND` on
`gsd-core/bin/lib/*.cjs` was `@types/node` missing, so `tsc` emitted nothing and
`build:lib` exited 0 while producing no artifacts. After `npm ci`, `build:lib` is
clean and `tests/artifacts.test.cjs` + `phase.test.cjs` run in-tree: 314 tests,
0 failures. Verifying registry logic against the installed build is no longer
necessary.

**Pushing requires `gh auth refresh -s workflow`** — upstream touches
`.github/workflows`, and the current token lacks that scope. Moot while the fork
is local-only (since 2026-10-04).

**`rg` is a shell function here, not a binary.** In any subshell or script it is
absent, and `rg pattern` returns empty with exit 0 — which reads as "not found".
Every script in this fork uses `grep` or a Node walk, and distinguishes "found
nothing" (exit 1) from "could not look" (exit 2).
