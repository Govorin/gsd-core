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
