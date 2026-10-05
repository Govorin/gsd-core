# Report A/B: does the report's form help a reviewer find defects?

Sync plan task 4.9. This experiment has to come before any work on diagram or HTML reports.
The hypothesis is the arXiv observation that polished formatting raises a reader's trust but
not their accuracy. Results and the recommendation are in `.plans/report-ab-results.md`.

This is not a test and not a gate. Nothing here is collected by `npm test`
(`scripts/run-tests.cjs` only picks up `tests/**/*.test.cjs`). Every run costs real model calls.

## What is compared

The object is one phase's plans, the artifact that plan-checker and verifier read. Each
fixture is rendered in three forms. The plan files are the same bytes in all three:

| Variant | What the reviewer gets |
|---|---|
| **A** | the `*-PLAN.md` files verbatim, plus a directory listing (which SUMMARYs exist) |
| **B** | A plus a neutral mermaid diagram of the same `wave`/`depends_on` data: wave subgraphs, edges, status glyphs, nothing judged |
| **C** | A plus `gsd-tools plan graph` output exactly as the fork ships it: defects drawn red, plus a defect list |

C is not form-only. For three of the six defect classes it carries a detector's verdict. It
is included to measure what the shipped tool adds, and whether its marks pull attention away
from the classes it does not mark. One extra difference: C keeps plan-graph's `:::done` /
`:::running` class annotations, while B shows status only as glyphs. So any B-vs-C gap on
the status class is confounded.

## Fixtures and ground truth

`fixtures.cjs` builds eight phases deterministically from fixed seeds. Each phase has 10–11
plans over four waves and is about 42 KB of realistic PLAN.md text. Six phases carry three
seeded defects each, and two are clean controls. Each class is seeded three times:

| Class | Category | Seed |
|---|---|---|
| `cycle` | flagged by plan-graph | a wave-2 plan also depends on a wave-4 plan downstream of it |
| `missing` | flagged | `depends_on` names an id one or two past the last plan |
| `wave` | flagged | a plan depends on a plan in the same wave |
| `status` | visible in the diagram, not flagged | a wave-2 plan has a SUMMARY, but its wave-1 dependency is back in progress |
| `undeclared` | text only | a plan imports a same-wave plan's export (interfaces, key_links, task) with no `depends_on` |
| `file_conflict` | text only | two same-wave plans both modify one file, with no ordering between them |

The generator checks its own output. Every fixture goes through the real plan-graph detector,
which must report exactly the flagged defects that were seeded and none on a control. The
answer key is written to `ground-truth.json` next to the reports, together with each report's
sha256. The reviewer never sees it.

## Isolation of a run

`run.cjs` makes one headless `claude -p` call per (fixture, variant, rep):

- the cwd is a fresh `mkdtemp` directory outside the repo, holding only that report;
- the report goes in on stdin;
- `--tools ""` gives no tools at all, so the run cannot read the repo or the answer key;
- `--strict-mcp-config` loads no MCP servers;
- `--setting-sources ""` loads no user or project settings, hooks or CLAUDE.md. A probe's
  `init` event showed `tools: []` and `mcp_servers: []`, and the model reported no instruction
  files;
- a fixed `--system-prompt` replaces the default one and is the same for every variant. It
  asks for JSON findings with a closed `kind` vocabulary, padded with distractor kinds;
- `--no-session-persistence` is set, and the run writes nothing under `~/.claude`.

The variant's name appears nowhere: not in the prompt, the file name or the directory name.
Runs execute in a seeded shuffled order, a few at a time, and resume from `runs-<model>.jsonl`.

## Scoring

`score.cjs` is deterministic. A finding hits a defect when its `kind` is accepted for that
class and the plan ids it names cover the defect's plans. The ids are taken from `plans` or
from the description, because reviewers often put the second plan only in the prose. The
following count neither as a hit nor as a false positive:

- duplicates;
- the wave-order side of a seeded cycle;
- self-retracting remarks.

A structural finding that matches nothing is a false positive. Quality opinions
(`vague_task`, …) are counted separately as noise. Every unmatched structural finding is
listed for manual review, and the verdicts live in `adjudication.json`, keyed by model. The
recall CIs come from a paired cluster bootstrap over defects. A per-defect sign test is
printed next to them, because a category has only 3–6 defects.

## Reproduce

```bash
export PATH=$HOME/.nvm/versions/node/v24.11.0/bin:$PATH
npm run build:lib                                   # plan-graph.cjs / mermaid.cjs
node scripts/experiments/report-ab/fixtures.cjs     # → out/ (gitignored)
node scripts/experiments/report-ab/run.cjs --model sonnet --reps 4 --concurrency 6
node scripts/experiments/report-ab/run.cjs --model haiku  --reps 4 --concurrency 8
node scripts/experiments/report-ab/score.cjs --runs runs-sonnet.jsonl
# the committed batch:
node scripts/experiments/report-ab/score.cjs --out scripts/experiments/report-ab/results/2026-10-04 --runs runs-haiku.jsonl
```

`results/2026-10-04/` holds the batch behind the results file: the raw runs (each reviewer's
full answer), the ground truth, the adjudication and both summaries. Regenerating the fixtures
gives byte-identical reports, which the `report_sha256` values in `ground-truth.json` confirm.
The batch cost $8.02 for sonnet and $7.26 for haiku (96 runs each).

## Modes `window` and `arch` (pocock wave 3)

Wave 3 of `.plans/pocock-practices-design.md` asks whether the deterministic pre-pass should be
handed to the model, and in what form. Results: `.plans/pocock-eval-results.md`. The same
isolation, run order, resume and statistics apply; `run.cjs --mode` picks the system prompt and
the output directory, and `score.cjs` reads the mode from `ground-truth.json`.

| Mode | Generator | Artifact | Pre-pass |
|---|---|---|---|
| `window` | `fixtures-window.cjs` → `out-window/` | one window of commits: the log with files per commit, two earlier window reviews, the cumulative diff, the source at the tip | `gsd-tools review window-prepass` run in the fixture repo |
| `arch` | `fixtures-arch.cjs` → `out-arch/` | one zone (the whole small repo) in the surveyor prompt's header form, every source file | `gsd-tools arch metrics` run in the fixture repo |

Variants, the code bytes identical in all three:

| Variant | `window` | `arch` |
|---|---|---|
| **A** | no pre-pass | no metrics |
| **C** | + `prepass.json` as is | + the `<signals>` block and the metrics rows as is |
| **Cp** (C′) | + the `<window_prepass>` brief, produced by running the node snippet extracted from `gsd-core/workflows/code-review/steps/window-scope.md` at generation time | + the `<what_the_metrics_checked>` block, read verbatim from `agents/gsd-arch-surveyor.md` |

Cp is the shipped form: both prompts already say which classes the pre-pass checked and that the
rest is the model's to find. Each generator has seven (`window`) or six (`arch`) defect classes,
each seeded three times across six fixtures, plus two clean controls. Half the classes are ones the
pre-pass flags, half are ones it cannot see:

| Mode | Flagged by the pre-pass | Not flagged |
|---|---|---|
| `window` | `complexity` (a function's complexity jumps in the window), `unused_export` (a new export nobody imports), `hotspot` (one file patched in 5+ window commits), `recurring` (a review-only finding raised in both earlier reviews, still in the code) | `logic` (a logic error introduced in the window), `duplicate` (one behaviour written twice, in two modules), `contract` (a caller breaks the callee's documented contract) |
| `arch` | `cycle`, `pass_through`, `small_cluster` | `scattered` (one rule re-implemented in three modules), `leaky_seam`, `shallow_interface` (a module over the small bound whose interface is as wide as its implementation) |

Both generators check themselves against the real CLI: the pre-pass must report exactly the seeded
flagged defects, nothing on a control, and none of the unflagged ones. A finding hits a defect when
its `kind` is accepted for the class (`WINDOW_ACCEPT` / `ARCH_ACCEPT` in `score.cjs`) and the paths it
names cover `minFiles` of the defect's files. `score.cjs` also prints C′ against C.

```bash
node scripts/experiments/report-ab/fixtures-window.cjs
node scripts/experiments/report-ab/fixtures-arch.cjs
node scripts/experiments/report-ab/run.cjs --mode window --model haiku --reps 4 --concurrency 6
node scripts/experiments/report-ab/run.cjs --mode arch   --model haiku --reps 4 --concurrency 6
node scripts/experiments/report-ab/score.cjs --out scripts/experiments/report-ab/out-window --runs runs-haiku.jsonl
```
