'use strict';

/**
 * ADR-5211 decision 5 — every mandatory block a worktree sub-agent runs, after the
 * orchestrator's build-time substitution, must be in a form Claude Code's isolation
 * check accepts: no `$(…)` or backticks, no computed git/node/sed arguments, no
 * `cd … &&`, no `git -C`, no placeholder left unbound. The classifier is a
 * conservative model of the probe table (tests/helpers/isolation-shell-form.cjs);
 * lines of the bash these blocks replaced are its positive control.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { classifyIsolationShellForm } = require('./helpers/isolation-shell-form.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The orchestrator's and executor's substitutions, with awkward literal values. */
const SUBSTITUTIONS = [
  ['{GSD_TOOLS_CMD}', "node '/opt/gsd tools/gsd-tools.cjs'"],
  ['{EXPECTED_BASE_ALTERNATE}', ''],
  ['{EXPECTED_BASE}', 'a'.repeat(40)],
  ['{PINNED_ROOT}', "'/srv/the root'"],
  ['{phase}', '3'],
  ['{plan}', '01'],
];
const substitute = (text) => SUBSTITUTIONS.reduce((t, [k, v]) => t.split(k).join(v), text);

/** The first fenced bash block after `marker` in `src`. */
function bashAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  const open = src.indexOf('```bash\n', at);
  assert.notEqual(open, -1, `no bash block after: ${marker}`);
  return src.slice(open + 8, src.indexOf('\n```', open + 8));
}

/** The first bash block after `marker` whose fences are backslash-escaped (inside a JS template). */
function escapedBashAfter(src, marker) {
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  const fence = '\\`\\`\\`';
  const open = src.indexOf(`${fence}bash\n`, at);
  assert.notEqual(open, -1, `no escaped bash block after: ${marker}`);
  const body = open + fence.length + 5;
  return src.slice(body, src.indexOf(`\n${fence}`, body));
}

/** Every fenced bash block in `src`. */
function allBash(src) {
  const out = [];
  let at = src.indexOf('```bash\n');
  while (at !== -1) {
    const end = src.indexOf('\n```', at + 8);
    out.push(src.slice(at + 8, end));
    at = src.indexOf('```bash\n', end + 4);
  }
  return out;
}

const executor = read('agents/gsd-executor.md');
const quick = read('gsd-core/workflows/quick.md');
const MANDATORY = [
  ['worktree_branch_check', bashAfter(read('gsd-core/references/worktree-branch-check.md'), '<worktree_branch_check>')],
  ...allBash(read('gsd-core/references/worktree-path-safety.md')).map((b, i) => [`worktree-path-safety.md block ${i + 1}`, b]),
  ...[
    '<worktree_metadata_capture>',
    '## MVP+TDD Gate',
    '**0a. cwd-drift sentinel',
    '**0b. absolute-path safety',
    '**0. Pre-commit HEAD safety assertion',
    '**0c. Plan commit ledger',
    '**`commits:` is measured, never narrated',
  ].map((m) => [`gsd-executor.md ${m}`, bashAfter(executor, m)]),
  // quick.md's isolated preamble, with the orchestrator's template values bound.
  ['quick.md plan materialisation', escapedBashAfter(quick, 'FIRST ACTION after the worktree branch check')
    .replace(/\$\{(DISCUSS|RESEARCH)_MODE \? `[^`]{0,200}` : ''\}/g, '')
    .split('${gsd_tools_cmd}').join('{GSD_TOOLS_CMD}')
    .split('${QUICK_PLAN_COMMIT}').join('b'.repeat(40))
    .split('${QUICK_DIR}').join('/srv/repo/.planning/quick/260101-x')
    .split('${quick_id}').join('260101-x')],
];

describe('every mandatory worktree block passes the isolation shell-form model after substitution', () => {
  test('the set is not empty and covers the path-safety stages', () => {
    assert.ok(MANDATORY.length >= 12, `only ${MANDATORY.length} blocks collected`);
  });
  for (const [label, block] of MANDATORY) {
    test(label, () => {
      const verdict = classifyIsolationShellForm(substitute(block));
      assert.deepEqual(verdict.violations, [], `${label} would be refused inside an isolated agent`);
    });
  }
});

describe('the launcher block exists only where a dispatch fills it (review: tag collision)', () => {
  // A block is the tag on a line of its own; a backticked mention in prose is not one.
  const blocks = (src) => splitLines(src).filter((l) => l.trim() === '<gsd_tools_launcher>').length;
  test('the executor role names the block but carries none of its own, so "no block → gsd_run" can fire', () => {
    assert.equal(blocks(executor), 0);
    assert.equal(splitLines(executor).filter((l) => l.trim() === '<gsd_tools_launcher_rule>').length, 1);
  });
  test('the dispatches that fill it carry exactly one block, around the placeholder', () => {
    for (const [rel, filled] of [
      ['gsd-core/workflows/execute-phase.md', '{GSD_TOOLS_CMD}'],
      ['gsd-core/workflows/quick.md', '${gsd_tools_cmd}'],
      ['gsd-core/workflows/quick-batch/steps/worktree-dispatch.md', '${gsd_tools_cmd}'],
    ]) {
      const src = read(rel);
      assert.equal(blocks(src), 1, rel);
      const inner = src.slice(src.indexOf('<gsd_tools_launcher>') + '<gsd_tools_launcher>'.length, src.indexOf('</gsd_tools_launcher>')).trim();
      assert.equal(inner, filled, rel);
    }
  });
});

describe('quick.md plan materialisation survives a path with spaces (review: unquoted --path)', { skip: process.platform === 'win32' ? 'bash round trip is POSIX-only here' : false }, () => {
  test('the composed block, run through bash in a linked worktree, exits 0', (t) => {
    const { createTempDir, cleanup, TOOLS_PATH } = require('./helpers.cjs');
    const { gitOrThrow } = require('./helpers/git-fixture.cjs');
    const { runHook } = require('./helpers/process-seam.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    const { GIT_IDENTITY_ENV } = require('./helpers/worktree-guard-corpus.cjs');
    const env = { ...process.env, ...GIT_IDENTITY_ENV };
    const tmp = createTempDir('gsd-quick-quoted-');
    t.after(() => cleanup(tmp));
    const main = path.join(tmp, 'main repo');
    gitOrThrow(['init', '-q', main], { cwd: tmp, env });
    const quickDir = path.join(main, '.planning', 'quick', '260101-a b');
    fs.mkdirSync(quickDir, { recursive: true });
    fs.writeFileSync(path.join(quickDir, '260101-x-PLAN.md'), 'plan\n');
    gitOrThrow(['add', '.'], { cwd: main, env });
    gitOrThrow(['commit', '-q', '-m', 'plan'], { cwd: main, env });
    const commit = gitOrThrow(['rev-parse', 'HEAD'], { cwd: main, env }).trim();
    const wt = path.join(tmp, 'wt');
    gitOrThrow(['worktree', 'add', '-q', '--detach', wt, 'HEAD~0'], { cwd: main, env });
    cleanup(path.join(wt, '.planning'));
    const block = escapedBashAfter(quick, 'FIRST ACTION after the worktree branch check')
      .replace(/\$\{(DISCUSS|RESEARCH)_MODE \? `[^`]{0,200}` : ''\}/g, '')
      .split('${gsd_tools_cmd}').join(`node '${TOOLS_PATH.split(path.sep).join('/')}'`)
      .split('${QUICK_PLAN_COMMIT}').join(commit)
      .split('${QUICK_DIR}').join(quickDir)
      .split('${quick_id}').join('260101-x');
    const r = runHook('-c', [block], { interpreter: 'bash', cwd: wt, timeoutMs: PROBE_TIMEOUT_MS, env });
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).detail.written, [path.join(quickDir, '260101-x-PLAN.md')]);
  });
});

describe('positive control: the bash these blocks replaced is refused by the model', () => {
  // One line from each guard as it shipped before ADR-5211 (5794b63a9).
  for (const [guardName, line, rule] of [
    ['worktree_branch_check', 'HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")', 'command-substitution'],
    ['step 0a sentinel', 'WT_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)', 'command-substitution'],
    ['step 0b abs-path', 'WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)', 'command-substitution'],
    ['step 0 pre-commit', 'IS_PROTECTED=$(gsd_run query git.base-branch --is-protected "$ACTUAL_BRANCH" 2>/dev/null) || IS_PROTECTED="__GSD_RUN_UNAVAILABLE__"', 'command-substitution'],
    ['step 0c ledger', '_GSD_LEDGER="$(git rev-parse --git-dir)/gsd-plan-head-before-3-01"', 'command-substitution'],
    ['step 0p pin', 'PINNED_TL=$(git -C "$PINNED_ROOT" rev-parse --show-toplevel 2>/dev/null)', 'command-substitution'],
    ['quick plan materialisation', 'git show "${QUICK_PLAN_COMMIT}:${QUICK_PLAN_PATH}" > "$QUICK_PLAN_PATH"', 'computed-argument'],
  ]) {
    test(`the old ${guardName} is refused (${rule})`, () => {
      const verdict = classifyIsolationShellForm(line);
      assert.equal(verdict.ok, false);
      assert.ok(verdict.violations.some((v) => v.rule === rule), JSON.stringify(verdict.violations));
    });
  }

  for (const [label, line, rule] of [
    ['cd chained to git', 'cd /srv/main && git status', 'cd-chain'],
    ['git -C into the shared checkout', 'git -C /srv/main status', 'git-dash-C'],
    ['a variable in a node argument', 'node "$HOME/gsd-tools.cjs" query x', 'computed-argument'],
    ['a variable in a sed argument', 'sed -n 1,2p $S/README.md', 'computed-argument'],
    ['an unbound placeholder', '{GSD_TOOLS_CMD} worktree guard sentinel', 'unbound-placeholder'],
  ]) {
    test(`${label} is refused (${rule})`, () => {
      assert.ok(classifyIsolationShellForm(line).violations.some((v) => v.rule === rule));
    });
  }

  for (const line of ["git rev-parse --show-toplevel", "node '/abs/gsd-tools.cjs' worktree guard branch --expected-base x || exit 42", "sed -n 1,3p README.md"]) {
    test(`a form the probes accepted passes: ${line}`, () => {
      assert.equal(classifyIsolationShellForm(line).ok, true);
    });
  }
});
