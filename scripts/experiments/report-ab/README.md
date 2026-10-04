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
