'use strict';

/**
 * ADR-5211 — differential: the old bash guards against the verbs that replace
 * them, over the whole corpus each guard was driven against.
 *
 * The bash lives on as frozen snapshots in tests/fixtures/legacy-worktree-guards/
 * (taken from worktree-path-safety.md, worktree-branch-check.md and
 * gsd-executor.md). For every row both run against the same real git fixture
 * and the EXIT CODES must agree. Where the verb is deliberately stricter than
 * the bash — a fail-open the bash had — the row says so and asserts the exact
 * pair, so a divergence is a recorded decision rather than drift.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runHook } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { HOOK_FANOUT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const {
  GIT_IDENTITY_ENV, buildAutomatedFixture, AUTOMATED_HALT_ROWS, AUTOMATED_PASS_ROWS, BRANCH_ROWS,
  commandOf, automatedFuzzRows,
} = require('./helpers/worktree-guard-corpus.cjs');
const guard = require('../gsd-core/bin/lib/worktree-guard.cjs');

const ROOT = path.join(__dirname, '..');
const LEGACY = path.join(__dirname, 'fixtures', 'legacy-worktree-guards');
const legacy = (name) => fs.readFileSync(path.join(LEGACY, name), 'utf8');
const gitEnv = { ...process.env, ...GIT_IDENTITY_ENV };
const git = (args, cwd) => gitOrThrow(args, { cwd, env: gitEnv }).trim();
const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
const ZERO_SHA = '0'.repeat(40);
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'the bash snapshots are POSIX-only, as their suites were' : false };

/**
 * Run a bash snapshot the way its old suite did. The step 0c suite ran under
 * `set -eu` (first statement of the body); the others ran in a plain shell, as
 * an executor's Bash call does — under `set -e` a failing `$(git …)` capture
 * exits 128 before the guard's own FATAL arm runs.
 */
function bash(script, cwd, env = {}, { strict = false } = {}) {
  const r = runHook('-c', [strict ? `set -eu; ${script}` : script], {
    interpreter: 'bash', cwd, timeoutMs: HOOK_FANOUT_TIMEOUT_MS, env: { ...gitEnv, GIT_TERMINAL_PROMPT: '0', ...env },
  });
  return r.exitCode;
}

/** The fenced ```bash block after `marker` in a shipped markdown file. */
function shippedBlock(rel, marker) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const at = src.indexOf(marker);
  assert.notEqual(at, -1, `${rel}: ${marker} not found`);
  const open = src.indexOf('```bash\n', at) + 8;
  return `${src.slice(open, src.indexOf('\n```', open))}\n`;
}

describe('the frozen snapshots are the shipped guards, byte for byte', () => {
  for (const [file, rel, marker] of [
    ['automated-0c.sh', 'gsd-core/references/worktree-path-safety.md', '## `<automated>` command guard — step 0c (#4767)'],
    ['pin-0p.sh', 'gsd-core/references/worktree-path-safety.md', '## Supplied-root pin — step 0p'],
    ['branch-check.sh', 'gsd-core/references/worktree-branch-check.md', '<worktree_branch_check>'],
    ['sentinel-0a.sh', 'agents/gsd-executor.md', '**0a. cwd-drift assertion'],
    ['abs-path-0b.sh', 'agents/gsd-executor.md', '**0b. absolute-path safety'],
    ['pre-commit-0.sh', 'agents/gsd-executor.md', '**0. Pre-commit HEAD safety assertion'],
    ['plan-ledger.sh', 'agents/gsd-executor.md', '**0c. Plan commit ledger'],
  ]) {
    test(`${file} = ${rel}`, () => assert.equal(legacy(file), shippedBlock(rel, marker)));
  }
});

describe('step 0c — <automated> containment: bash vs verb', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = buildAutomatedFixture('gsd-wt-diff-0c-'); });
  after(() => cleanup(fx.tmp));
  const script = legacy('automated-0c.sh');

  const rows = [
    ...AUTOMATED_HALT_ROWS.map((r) => [...r, 1]),
    ...AUTOMATED_PASS_ROWS.map((r) => [...r, 0]),
    ...automatedFuzzRows().map((r) => [...r, null]),
  ];
  for (const row of rows) {
    test(row[0], () => {
      const cmd = commandOf(row, fx);
      const bashExit = bash(script, fx.wt, { AUTOMATED_CMD: cmd }, { strict: true });
      const verb = guard.guardAutomated(fx.wt, { command: cmd });
      if (row[2] !== null) assert.equal(bashExit, row[2], `the bash oracle no longer gives the recorded verdict for: ${cmd}`);
      assert.equal(verb.exit_code, bashExit, `verdicts differ for: ${cmd}\nverb: ${JSON.stringify(verb)}`);
    });
  }
});

describe('step 0p — supplied-root pin: bash vs verb', POSIX_ONLY, () => {
  const script = legacy('pin-0p.sh');
  const compose = (pin) => (pin === null ? script : script.replace("PINNED_ROOT='{PINNED_ROOT}'", `PINNED_ROOT=${shellQuote(pin)}`));
  let primary;
  let lane;
  let subSource;
  let outside;
  before(() => {
    primary = createTempGitProject('gsd-wt-diff-0p-');
    lane = `${primary}-orchestrator-wt`;
    gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/2-1', lane], { cwd: primary });
    fs.symlinkSync(lane, `${primary}-alias`);
    fs.mkdirSync(path.join(lane, 'nested'));
    fs.symlinkSync(lane, path.join(primary, `q' $HOME $(touch PWNED) x`));
    subSource = createTempGitProject('gsd-wt-diff-0p-sub-');
    gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'module'], { cwd: primary });
    gitOrThrow(['commit', '-qm', 'chore: register submodule'], { cwd: primary });
    gitOrThrow(['clone', '-q', subSource, path.join(primary, 'rogue-clone')], { cwd: primary });
    outside = createTempDir('gsd-wt-diff-0p-outside-');
  });
  after(() => {
    cleanup(outside);
    cleanup(subSource);
    cleanup(lane);
    cleanup(`${primary}-alias`);
    cleanup(primary);
  });

  for (const [label, cwd, pin, exit] of [
    ['matching root', () => lane, () => lane, 0],
    ['drifted cwd: the primary checkout against a lane pin', () => primary, () => lane, 1],
    ['an unexpanded pin', () => lane, () => null, 1],
    ['an empty pin', () => lane, () => '', 1],
    ['a trailing slash', () => path.join(lane, 'nested'), () => `${lane}/`, 0],
    ['a symlink alias', () => path.join(lane, 'nested'), () => `${primary}-alias`, 0],
    ['the unresolved temp-root spelling', () => path.join(lane, 'nested'), () => fs.realpathSync(lane).replace('/private/var/', '/var/'), 0],
    ['a registered submodule of the pinned checkout', () => path.join(primary, 'module'), () => primary, 0],
    ['an unregistered nested clone', () => path.join(primary, 'rogue-clone'), () => primary, 1],
    ['a pin outside any repository', () => lane, () => outside, 1],
    ['a cwd outside any repository', () => outside, () => lane, 1],
    ['a metacharacter pin, safely quoted', () => lane, () => path.join(primary, `q' $HOME $(touch PWNED) x`), 0],
    ['a relative pin', () => lane, () => 'relative/path', 1],
    ['a forward-slash drive pin', () => lane, () => 'C:/definitely/not/a/repo', 1],
    ['a backslash drive pin', () => lane, () => 'C:\\definitely\\not\\a\\repo', 1],
  ]) {
    test(label, () => {
      const p = pin();
      const bashExit = bash(compose(p), cwd());
      const verb = guard.guardPin(cwd(), { root: p === null ? '{PINNED_ROOT}' : p });
      assert.equal(bashExit, exit, 'the bash oracle no longer gives the recorded verdict');
      assert.equal(verb.exit_code, bashExit, JSON.stringify(verb));
      assert.equal(fs.existsSync(path.join(lane, 'PWNED')), false, 'a metacharacter pin must never execute');
    });
  }
});

/** A repository whose linked worktree can be pointed at any branch name or detached. */
function branchFixture(prefix) {
  const tmp = createTempDir(prefix);
  const main = path.join(tmp, 'main');
  git(['init', '-q', main], tmp);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
  const wt = path.join(tmp, 'wt');
  git(['worktree', 'add', '-q', '-b', 'agent-seed', wt], main);
  return { tmp, main, wt, head: git(['rev-parse', 'HEAD'], wt) };
}

function pointHead(cwd, head, branch) {
  if (branch === null) {
    git(['checkout', '-q', '--detach', head], cwd);
    return;
  }
  git(['update-ref', `refs/heads/${branch}`, head], cwd);
  git(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], cwd);
}

describe('worktree_branch_check — bash vs verb', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = branchFixture('gsd-wt-diff-branch-'); });
  after(() => cleanup(fx.tmp));
  const script = legacy('branch-check.sh');
  const compose = (expected, alternate) => script
    .split('{EXPECTED_BASE_ALTERNATE}').join(alternate)
    .split('{EXPECTED_BASE}').join(expected);

  const modes = [
    ['at the expected base', (h) => [h, '']],
    ['at a mismatched base', () => [ZERO_SHA, '']],
    ['at the alternate base', (h) => [ZERO_SHA, h]],
  ];
  for (const branch of [...BRANCH_ROWS, null]) {
    for (const [mode, bases] of modes) {
      test(`${branch === null ? 'detached HEAD' : `'${branch}'`} ${mode}`, () => {
        pointHead(fx.wt, fx.head, branch);
        const [expected, alternate] = bases(fx.head);
        const bashExit = bash(compose(expected, alternate), fx.wt);
        const verb = guard.guardBranch(fx.wt, { expectedBase: expected, alternateBase: alternate });
        assert.equal(verb.exit_code, bashExit, JSON.stringify(verb));
      });
    }
  }
});

describe('executor step 0 — pre-commit HEAD safety: bash vs verb', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = branchFixture('gsd-wt-diff-precommit-'); });
  after(() => cleanup(fx.tmp));
  const script = legacy('pre-commit-0.sh');
  const STUBS = {
    true: 'gsd_run() { printf "%s\\n" true; }',
    false: 'gsd_run() { printf "%s\\n" false; }',
    unavailable: 'gsd_run() { return 1; }',
  };
  const RESOLVERS = {
    true: () => ({ isProtected: true, verified: true }),
    false: () => ({ isProtected: false, verified: true }),
    unavailable: () => { throw new Error('unavailable'); },
  };

  for (const where of ['linked', 'main']) {
    for (const branch of ['agent-x', 'worktree-wf_abc', 'feature/phase-48', 'main', 'release/1.0', 'agent-', null]) {
      for (const sequential of [false, true]) {
        for (const answer of ['true', 'false', 'unavailable']) {
          test(`${where} ${branch === null ? 'detached' : branch} sequential=${sequential} protected=${answer}`, () => {
            const cwd = where === 'linked' ? fx.wt : fx.main;
            pointHead(cwd, fx.head, branch);
            const body = sequential ? script.replace(/^SEQUENTIAL=false\b/m, 'SEQUENTIAL=true') : script;
            const bashExit = bash(`${STUBS[answer]}\n${body}`, cwd);
            const verb = guard.guardPreCommit(cwd, { sequential, configCwd: cwd }, { resolveProtected: RESOLVERS[answer] });
            assert.equal(verb.exit_code, bashExit, JSON.stringify(verb));
          });
        }
      }
    }
  }
});

describe('executor step 0a — cwd-drift sentinel: bash vs verb', POSIX_ONLY, () => {
  let fx;
  let sentinel;
  before(() => {
    fx = branchFixture('gsd-wt-diff-sentinel-');
    sentinel = path.join(git(['rev-parse', '--absolute-git-dir'], fx.wt), 'gsd-spawn-toplevel');
  });
  after(() => cleanup(fx.tmp));
  const script = legacy('sentinel-0a.sh');
  const setState = (content) => {
    if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
    if (content !== null) fs.writeFileSync(sentinel, content);
  };

  for (const [label, cwd, content, bashExit, verbExit] of [
    ['a main checkout (not a linked worktree)', () => fx.main, () => null, 0, 0],
    ['the first call in a linked worktree', () => fx.wt, () => null, 0, 0],
    ['a later call against a recorded toplevel', () => fx.wt, () => `${git(['rev-parse', '--show-toplevel'], fx.wt)}\n`, 0, 0],
    ['a recorded toplevel that is not this one', () => fx.wt, () => '/somewhere/else\n', 1, 1],
    // KNOWN STRENGTHENING: the bash read an empty sentinel (what it wrote when git failed) as
    // "nothing recorded" and passed forever; the verb refuses a sentinel it cannot read a root from.
    ['an empty sentinel (bash fail-open, verb refuses)', () => fx.wt, () => '', 0, 1],
  ]) {
    test(label, () => {
      setState(content());
      const b = bash(script, cwd());
      const bashCreated = fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : null;
      setState(content());
      const verb = guard.guardSentinel(cwd());
      const verbCreated = fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : null;
      assert.equal(b, bashExit, 'the bash oracle no longer gives the recorded verdict');
      assert.equal(verb.exit_code, verbExit, JSON.stringify(verb));
      assert.equal(verbCreated, bashCreated, 'both sides leave the same sentinel behind');
    });
  }
});

describe('executor step 0b — absolute-path safety: bash vs verb', POSIX_ONLY, () => {
  let fx;
  before(() => {
    fx = branchFixture('gsd-wt-diff-abspath-');
    fx.real = fs.realpathSync(fx.wt);
    fs.symlinkSync(fx.main, path.join(fx.wt, 'main-link'));
  });
  after(() => cleanup(fx.tmp));
  const script = legacy('abs-path-0b.sh');

  for (const [label, abs, bashExit, verbExit] of [
    ['the root itself', (f) => f.real, 0, 0],
    ['a file under the root', (f) => `${f.real}/src/a.ts`, 0, 0],
    ['a nested path that does not exist yet', (f) => `${f.real}/a/b/c.ts`, 0, 0],
    ['the sibling <root>-x', (f) => `${f.real}-x/a`, 1, 1],
    ['the main checkout', (f) => `${fs.realpathSync(f.main)}/a`, 1, 1],
    ['a path outside both', () => '/srv/other/a', 1, 1],
    // KNOWN STRENGTHENINGS: the bash compared string prefixes, so a `..` hop or an in-worktree
    // symlink that lands in the main checkout read as inside. tryWithinRoot resolves them.
    ['a `..` hop out of the root (bash passes, verb refuses)', (f) => `${f.real}/../main/a`, 0, 1],
    ['a symlink into main (bash passes, verb refuses)', (f) => `${f.real}/main-link/a`, 0, 1],
  ]) {
    test(label, () => {
      const p = abs(fx);
      assert.equal(bash(script, fx.wt, { ABS_PATH: p }), bashExit, 'the bash oracle no longer gives the recorded verdict');
      assert.equal(guard.guardAbsPath(fx.wt, { paths: [p] }).exit_code, verbExit);
    });
  }
});

describe('executor step 0c — plan commit ledger: bash vs verb', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = branchFixture('gsd-wt-diff-ledger-'); });
  after(() => cleanup(fx.tmp));

  test('both record the same base, once, in the same file', () => {
    const ledger = path.join(git(['rev-parse', '--absolute-git-dir'], fx.wt), 'gsd-plan-head-before-4-02');
    const script = legacy('plan-ledger.sh').split('{phase}').join('4').split('{plan}').join('02');
    assert.equal(bash(script, fx.wt), 0);
    const bashContent = fs.readFileSync(ledger, 'utf8');
    git(['commit', '-q', '--allow-empty', '-m', 'later'], fx.wt);
    assert.equal(bash(script, fx.wt), 0);
    assert.equal(fs.readFileSync(ledger, 'utf8'), bashContent, 'bash: a second run keeps the first base');
    fs.unlinkSync(ledger);
    git(['reset', '-q', '--hard', 'HEAD~1'], fx.wt);
    const verb = guard.planLedger(fx.wt, { phase: '4', plan: '02' });
    assert.equal(verb.ok, true);
    assert.equal(fs.readFileSync(ledger, 'utf8'), bashContent, 'the verb writes what the bash wrote');
  });
});
