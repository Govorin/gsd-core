'use strict';

/**
 * The window review surface of /gsd-code-review (ADR-5208), as shipped text: the workflow,
 * its window-scope step, code-review-fix.md's `--review` parameter and the lens agents are what
 * a model loads, so their bytes are the product. Behaviour is exercised by running the shipped
 * bash fences verbatim (phase-or-window dispatch, the `--review` parse, the broken-windows loop);
 * the prompt contracts are pinned against the code that consumes them (the pre-pass classes,
 * the refutation heading grammar, the CLI's subcommands).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { exitCodeFor } = require('../gsd-core/bin/lib/exit-code-registry.cjs');
const { PREPASS_CLASS, parseRefutation } = require('../gsd-core/bin/lib/window-review.cjs');
const { REVIEW_SUBCOMMANDS } = require('../gsd-core/bin/lib/review-command-router.cjs');

const ROOT = path.resolve(__dirname, '..');
const HAS_BASH = process.platform !== 'win32';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8').replace(/\r\n/g, '\n');
const WORKFLOW = read('gsd-core/workflows/code-review.md');
const WINDOW_STEP = read('gsd-core/workflows/code-review/steps/window-scope.md');
const FIX_WORKFLOW = read('gsd-core/workflows/code-review-fix.md');
const STANDARDS = read('agents/gsd-standards-reviewer.md');
const SPEC = read('agents/gsd-spec-reviewer.md');
const REFUTER = read('agents/gsd-finding-refuter.md');

/** The shell fences of a markdown text, in order. */
function bashFences(text) {
  const lines = text.split('\n');
  return scanFencedBlocks(lines)
    .filter((b) => b.infoString.trim() === 'bash')
    .map((b) => lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'));
}

/** The lines of `text` from the one starting with `from` through the one starting with `through`. */
function slice(text, from, through) {
  const start = text.indexOf(from);
  const endLine = text.indexOf(through, start);
  assert.ok(start !== -1 && endLine !== -1, `cannot find ${from} … ${through}`);
  return text.slice(start, text.indexOf('\n', endLine));
}

function bash(script, args = [], options = {}) {
  return runHook('-c', [script, 'bash', ...args], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS, ...options });
}

describe('code-review.md — phase or window, decided by the invocation IR', { skip: !HAS_BASH }, () => {
  const dispatch = slice(WORKFLOW, 'INVOCATION_JSON=$(gsd_run review invocation', 'FILES_OVERRIDE=$(_ir');
  const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
  // Run from a directory that is not this repository: an installed workflow runs in the user's
  // project, where no ./gsd-core exists — the IR must come through gsd_run, not a relative require.
  let elsewhere;
  before(() => { elsewhere = createTempDir('gsd-cr-invocation-'); });
  after(() => cleanup(elsewhere));
  const run = (args) =>
    bash(`gsd_run() { node ${JSON.stringify(GSD_TOOLS)} "$@"; }\n${dispatch}\nprintf '%s|%s|%s' "$REVIEW_MODE" "$PHASE_ARG" "$FIX_FLAG"`, args, { cwd: elsewhere });

  test('[happy] a phase is the first positional wherever it sits; --since alone is a window', () => {
    for (const [args, expected] of [
      [['3'], 'phase|3|false'],
      [['--depth=deep', '03.1'], 'phase|03.1|false'],
      [['--files', 'a.js', '4', '--fix'], 'phase|4|true'],
      [['--auto', '5'], 'phase|5|true'],
      [['--since', '7d'], 'window||false'],
      [['--since', 'last', '--lens', 'standards,spec', '--fix'], 'window||true'],
    ]) {
      const r = run(args);
      assert.equal(r.exitCode, 0, `${args.join(' ')}: ${r.stderr}`);
      assert.equal(r.stdout, expected, args.join(' '));
    }
  });

  test('[unhappy] an ambiguous or malformed invocation exits with the registry USAGE code and says why', () => {
    for (const args of [['3', '--since', '7d'], ['--lens', 'standards'], ['--since', '2026-02-30'], ['--since', '7d', '--lens', 'perf'], []]) {
      const r = run(args);
      assert.equal(r.exitCode, exitCodeFor('USAGE'), args.join(' '));
      assert.equal(r.stdout, '', 'nothing past the refusal runs');
      assert.match(r.stderr, /^code-review: /m, args.join(' '));
    }
  });

  test('[happy] the window step sits between the config gate and the phase scope, and only window mode reads it', () => {
    const gate = WORKFLOW.indexOf('<step name="check_config_gate">');
    const windowStep = WORKFLOW.indexOf('<step name="window_review">');
    const scope = WORKFLOW.indexOf('<step name="compute_file_scope">');
    assert.ok(gate < windowStep && windowStep < scope, 'check_config_gate → window_review → compute_file_scope');
    const body = WORKFLOW.slice(windowStep, WORKFLOW.indexOf('</step>', windowStep));
    assert.ok(body.includes('gsd-core/workflows/code-review/steps/window-scope.md'));
    assert.ok(body.includes('`REVIEW_MODE` is `window`'));
    assert.ok(slice(WORKFLOW, 'if [ "$REVIEW_MODE" = "phase" ]; then', 'fi').includes('init.code-review'), 'init.code-review runs in phase mode only');
  });
});

describe('window-scope.md — the shipped step', () => {
  test('[happy] every bash fence parses', { skip: !HAS_BASH }, () => {
    const fences = bashFences(WINDOW_STEP);
    assert.ok(fences.length >= 4);
    for (const f of fences) {
      const r = runHook('-n', ['-c', f], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
      assert.equal(r.exitCode, 0, `${r.stderr}\n${f}`);
    }
  });

  test('[happy] every `gsd_run review` call names a subcommand the CLI has', () => {
    const called = [...WINDOW_STEP.matchAll(/gsd_run review ([a-z-]+)/g)].map((m) => m[1]);
    assert.ok(called.length >= 4);
    for (const sub of called) assert.ok(REVIEW_SUBCOMMANDS.includes(sub), sub);
  });

  test('[happy] the lens brief explains every pre-pass class and says the rest is unchecked (P3)', () => {
    const brief = slice(WINDOW_STEP, 'PREPASS_BRIEF=$(', '" "$PREPASS_PATH")');
    const keys = [...brief.matchAll(/^\s*'([a-z-]+)': '/gm)].map((m) => m[1]).sort();
    assert.deepEqual(keys, Object.values(PREPASS_CLASS).sort(), 'one meaning per class the module measures');
    assert.ok(brief.includes('checked ONLY these classes'));
    assert.ok(brief.includes('It could NOT check'));
    assert.ok(brief.includes('find those yourself'));
    assert.equal((WINDOW_STEP.match(/<window_prepass>\n\$\{PREPASS_BRIEF\}\n<\/window_prepass>/g) ?? []).length, 2, 'both lens prompt shapes carry the brief');
  });

  test('[happy] the marker is written after compose and never for an incomplete review', () => {
    const fence = bashFences(WINDOW_STEP).find((f) => f.includes('review window-compose'));
    assert.ok(fence.indexOf('review window-compose') < fence.indexOf('review window-mark'));
    assert.ok(fence.includes('if [ "$W_STATUS" != "incomplete" ]; then'));
  });

  test('[happy] the broken-windows loop appends with optional file and line and closes fixed entries', { skip: !HAS_BASH }, (t) => {
    const loop = bashFences(WINDOW_STEP).find((f) => f.includes('review window-deferred'));
    const dir = createTempDir('gsd-window-loop-');
    t.after(() => cleanup(dir));
    const log = path.join(dir, 'calls.log').replace(/\\/g, '/');
    const stub = [
      'gsd_run() {',
      '  case "$1 $2" in',
      `    "review window-deferred") printf 'append\\tw-1\\t-\\t-\\tdesc one\\nappend\\tw-1\\tsrc/a b.js\\t9\\tdesc two\\nfixed\\t7\\n' ;;`,
      `    *) printf '%s\\n' "$*" >> "${log}" ;;`,
      '  esac',
      '}',
      'WINDOW_DIR=x',
    ].join('\n');
    const r = bash(`${stub}\n${loop}`);
    const calls = splitLines(fs.readFileSync(log, 'utf-8').trim());
    assert.equal(r.exitCode, 0, r.stderr);
    assert.deepEqual(calls, [
      'windows append --kind deviation --phase w-1 --description desc one',
      'windows append --kind deviation --phase w-1 --description desc two --file src/a b.js --line 9',
      'windows fixed 7',
    ]);
  });

  test('[happy] lens prompts forbid recursion and commits', () => {
    assert.ok(WINDOW_STEP.includes('Do NOT commit, do NOT spawn agents, do NOT run /gsd:code-review.'));
    for (const agent of [STANDARDS, SPEC]) {
      assert.ok(agent.includes('Never spawn agents and never run `/gsd:code-review`'));
      assert.ok(agent.includes('Never commit'));
    }
  });
});

describe('code-review-fix.md — the `--review` path parameter', { skip: !HAS_BASH }, () => {
  const parse = slice(FIX_WORKFLOW, 'REVIEW_OVERRIDE=""', 'done');
  test('[happy] `--review <path>` and `--review=<path>` both set the override; no flag leaves it empty', () => {
    for (const [args, expected] of [
      [['--review', '.planning/reviews/2026-10-05-window/REVIEW.md', '--all'], '.planning/reviews/2026-10-05-window/REVIEW.md'],
      [['--review=.planning/reviews/w/REVIEW.md'], '.planning/reviews/w/REVIEW.md'],
      [['3', '--all'], ''],
    ]) {
      const r = bash(`${parse}\nprintf '%s' "$REVIEW_OVERRIDE"`, args);
      assert.equal(r.stdout, expected, args.join(' '));
    }
  });
  test('[happy] a window review validates its path through the CLI, skips phase init, and runs one fix pass', () => {
    assert.ok(FIX_WORKFLOW.includes('gsd_run review window-paths ${GSD_WS:+--ws=${GSD_WS##* }} --review "$REVIEW_OVERRIDE"'));
    assert.ok(slice(FIX_WORKFLOW, 'if [ -z "$REVIEW_OVERRIDE" ]; then', 'fi').includes('init.phase-op'));
    assert.ok(FIX_WORKFLOW.includes('if [ -n "$REVIEW_OVERRIDE" ] && [ "$AUTO_MODE" = "true" ]; then'));
    assert.ok(FIX_WORKFLOW.includes('**Window review (`REVIEW_OVERRIDE` set): skip this step.**'));
  });
});

describe('lens and refuter agents — contracts with the code that reads them', () => {
  test('[happy] the standards reviewer serves both lenses; the spec reviewer reports unattributed commits as unspecified', () => {
    assert.ok(STANDARDS.includes('**`standards`**') && STANDARDS.includes('**`simplify`**'));
    assert.ok(STANDARDS.includes('**Cite or drop.**') && SPEC.includes('**Cite or drop.**'));
    assert.ok(SPEC.includes('## No spec'));
  });

  test('[happy] the refuter keeps the plan mode as the default and adds review mode with a heading the parser reads', () => {
    assert.ok(REFUTER.includes('<mode name="plan">') && REFUTER.includes('<mode name="review">'));
    assert.ok(REFUTER.includes('no tag means `plan`'));
    const example = REFUTER.slice(REFUTER.indexOf('**Refuted, because the citation does not reproduce (review mode):**'));
    const block = example.slice(example.indexOf('```\n') + 4, example.indexOf('\n```', example.indexOf('```\n') + 4));
    assert.deepEqual(parseRefutation(block).map((v) => [v.label, v.id, v.verdict]), [['correctness-2', 'WR-03', 'refuted']]);
  });
});
