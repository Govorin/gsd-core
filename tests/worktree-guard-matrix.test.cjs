'use strict';

/**
 * ADR-5211 — the worktree guards' scenario matrix, on the verbs alone.
 *
 * Until wave 4 these rows ran differentially: the frozen bash each guard replaced
 * against the verb, on the same git fixture, exit codes compared (615 rows,
 * identical apart from three recorded strengthenings — see the ADR). With the
 * bash deleted, each row keeps the verdict that run settled, so the verbs stay
 * held to it. The #4767 command corpus runs in
 * tests/automated-command-containment.test.cjs.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_IDENTITY_ENV, BRANCH_ROWS } = require('./helpers/worktree-guard-corpus.cjs');
const { AGENT_BRANCH_RE, FALLBACK_PROTECTED_BRANCH_RE } = require('../gsd-core/bin/lib/worktree-agent-branch.cjs');
const guard = require('../gsd-core/bin/lib/worktree-guard.cjs');

const gitEnv = { ...process.env, ...GIT_IDENTITY_ENV };
const git = (args, cwd) => gitOrThrow(args, { cwd, env: gitEnv }).trim();
const ZERO_SHA = '0'.repeat(40);
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'symlink and /var fixtures are POSIX-only, as the bash suites were' : false };

describe('step 0p — supplied-root pin', POSIX_ONLY, () => {
  let primary;
  let lane;
  let subSource;
  let outside;
  before(() => {
    primary = createTempGitProject('gsd-wt-matrix-0p-');
    lane = `${primary}-orchestrator-wt`;
    gitOrThrow(['worktree', 'add', '-q', '-b', 'phase/2-1', lane], { cwd: primary });
    fs.symlinkSync(lane, `${primary}-alias`);
    fs.mkdirSync(path.join(lane, 'nested'));
    fs.symlinkSync(lane, path.join(primary, `q' $HOME $(touch PWNED) x`));
    subSource = createTempGitProject('gsd-wt-matrix-0p-sub-');
    gitOrThrow(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subSource, 'module'], { cwd: primary });
    gitOrThrow(['commit', '-qm', 'chore: register submodule'], { cwd: primary });
    gitOrThrow(['clone', '-q', subSource, path.join(primary, 'rogue-clone')], { cwd: primary });
    outside = createTempDir('gsd-wt-matrix-0p-outside-');
  });
  after(() => {
    cleanup(outside);
    cleanup(subSource);
    cleanup(lane);
    cleanup(`${primary}-alias`);
    cleanup(primary);
  });

  for (const [label, cwd, pin, code] of [
    ['matching root', () => lane, () => lane, 'ok'],
    ['drifted cwd: the primary checkout against a lane pin', () => primary, () => lane, 'root_mismatch'],
    ['an unexpanded pin', () => lane, () => '{PINNED_ROOT}', 'pin_unbound'],
    ['an empty pin', () => lane, () => '', 'pin_unbound'],
    ['a trailing slash', () => path.join(lane, 'nested'), () => `${lane}/`, 'ok'],
    ['a symlink alias', () => path.join(lane, 'nested'), () => `${primary}-alias`, 'ok'],
    ['the unresolved temp-root spelling', () => path.join(lane, 'nested'), () => fs.realpathSync(lane).replace('/private/var/', '/var/'), 'ok'],
    ['a registered submodule of the pinned checkout', () => path.join(primary, 'module'), () => primary, 'ok'],
    ['an unregistered nested clone', () => path.join(primary, 'rogue-clone'), () => primary, 'root_mismatch'],
    ['a pin outside any repository', () => lane, () => outside, 'pin_unresolved'],
    ['a cwd outside any repository', () => outside, () => lane, 'root_unresolved'],
    ['a metacharacter pin', () => lane, () => path.join(primary, `q' $HOME $(touch PWNED) x`), 'ok'],
    ['a relative pin', () => lane, () => 'relative/path', 'pin_not_absolute'],
    ['a forward-slash drive pin', () => lane, () => 'C:/definitely/not/a/repo', 'pin_unresolved'],
    ['a backslash drive pin', () => lane, () => 'C:\\definitely\\not\\a\\repo', 'pin_unresolved'],
  ]) {
    test(`${label} → ${code}`, () => {
      const r = guard.guardPin(cwd(), { root: pin() });
      assert.equal(r.code, code, JSON.stringify(r));
      assert.equal(r.exit_code, code === 'ok' ? 0 : 1);
      assert.equal(fs.existsSync(path.join(lane, 'PWNED')), false);
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

describe('worktree_branch_check — every branch × base mode', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = branchFixture('gsd-wt-matrix-branch-'); });
  after(() => cleanup(fx.tmp));

  /** The verdict the bash oracle gave, in the guard's own order. */
  const expected = (branch, atBase) => {
    if (branch === null) return 'head_detached';
    if (FALLBACK_PROTECTED_BRANCH_RE.test(branch)) return 'protected_branch';
    if (!AGENT_BRANCH_RE.test(branch)) return 'namespace_mismatch';
    return atBase ? 'ok' : 'base_mismatch';
  };
  for (const branch of [...BRANCH_ROWS, null]) {
    for (const [mode, bases, atBase] of [
      ['at the expected base', (h) => [h, ''], true],
      ['at a mismatched base', () => [ZERO_SHA, ''], false],
      ['at the alternate base', (h) => [ZERO_SHA, h], true],
    ]) {
      const code = expected(branch, atBase);
      test(`${branch === null ? 'detached HEAD' : `'${branch}'`} ${mode} → ${code}`, () => {
        pointHead(fx.wt, fx.head, branch);
        const [expectedBase, alternateBase] = bases(fx.head);
        const r = guard.guardBranch(fx.wt, { expectedBase, alternateBase });
        assert.equal(r.code, code, JSON.stringify(r));
        assert.equal(r.exit_code, code === 'ok' ? 0 : 42);
      });
    }
  }
});

describe('executor step 0 — pre-commit, every branch × dispatch × protected answer', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = branchFixture('gsd-wt-matrix-precommit-'); });
  after(() => cleanup(fx.tmp));
  const RESOLVERS = {
    true: () => ({ isProtected: true, verified: true }),
    false: () => ({ isProtected: false, verified: true }),
    unavailable: () => { throw new Error('unavailable'); },
  };
  const expected = (linked, branch, sequential, answer) => {
    if (branch === null) return 'head_detached';
    const isProtected = answer === 'unavailable' ? FALLBACK_PROTECTED_BRANCH_RE.test(branch) : answer === 'true';
    if (isProtected) return 'protected_branch';
    if (linked && !sequential && !AGENT_BRANCH_RE.test(branch)) return 'namespace_mismatch';
    return 'ok';
  };

  for (const where of ['linked', 'main']) {
    for (const branch of ['agent-x', 'worktree-wf_abc', 'feature/phase-48', 'main', 'release/1.0', 'agent-', null]) {
      for (const sequential of [false, true]) {
        for (const answer of ['true', 'false', 'unavailable']) {
          const code = expected(where === 'linked', branch, sequential, answer);
          test(`${where} ${branch === null ? 'detached' : branch} sequential=${sequential} protected=${answer} → ${code}`, () => {
            const cwd = where === 'linked' ? fx.wt : fx.main;
            pointHead(cwd, fx.head, branch);
            const r = guard.guardPreCommit(cwd, { sequential, configCwd: cwd }, { resolveProtected: RESOLVERS[answer] });
            assert.equal(r.code, code, JSON.stringify(r));
            assert.equal(r.exit_code, code === 'ok' ? 0 : 1);
          });
        }
      }
    }
  }
});

describe('executor step 0a — cwd-drift sentinel', POSIX_ONLY, () => {
  let fx;
  let sentinel;
  before(() => {
    fx = branchFixture('gsd-wt-matrix-sentinel-');
    sentinel = path.join(git(['rev-parse', '--absolute-git-dir'], fx.wt), 'gsd-spawn-toplevel');
  });
  after(() => cleanup(fx.tmp));

  for (const [label, cwd, content, code, leaves] of [
    ['a main checkout (not a linked worktree)', () => fx.main, () => null, 'not_applicable', () => null],
    ['the first call in a linked worktree', () => fx.wt, () => null, 'ok', () => `${git(['rev-parse', '--show-toplevel'], fx.wt)}\n`],
    ['a later call against a recorded toplevel', () => fx.wt, () => `${git(['rev-parse', '--show-toplevel'], fx.wt)}\n`, 'ok', () => `${git(['rev-parse', '--show-toplevel'], fx.wt)}\n`],
    ['a recorded toplevel that is not this one', () => fx.wt, () => '/somewhere/else\n', 'cwd_drift', () => '/somewhere/else\n'],
    // Strengthening over the bash, which read an empty sentinel as "nothing recorded" and passed forever.
    ['an empty sentinel', () => fx.wt, () => '', 'sentinel_corrupt', () => ''],
  ]) {
    test(`${label} → ${code}`, () => {
      if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
      if (content() !== null) fs.writeFileSync(sentinel, content());
      const r = guard.guardSentinel(cwd());
      assert.equal(r.code, code, JSON.stringify(r));
      assert.equal(fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : null, leaves(), 'the sentinel left behind');
    });
  }
});

describe('executor step 0b — absolute-path safety', POSIX_ONLY, () => {
  let fx;
  before(() => {
    fx = branchFixture('gsd-wt-matrix-abspath-');
    fx.real = fs.realpathSync(fx.wt);
    fs.symlinkSync(fx.main, path.join(fx.wt, 'main-link'));
  });
  after(() => cleanup(fx.tmp));

  for (const [label, abs, exit] of [
    ['the root itself', (f) => f.real, 0],
    ['a file under the root', (f) => `${f.real}/src/a.ts`, 0],
    ['a nested path that does not exist yet', (f) => `${f.real}/a/b/c.ts`, 0],
    ['the sibling <root>-x', (f) => `${f.real}-x/a`, 1],
    ['the main checkout', (f) => `${fs.realpathSync(f.main)}/a`, 1],
    ['a path outside both', () => '/srv/other/a', 1],
    // Strengthenings over the bash's string-prefix compare.
    ['a `..` hop out of the root', (f) => `${f.real}/../main/a`, 1],
    ['a symlink into main', (f) => `${f.real}/main-link/a`, 1],
  ]) {
    test(`${label} → exit ${exit}`, () => {
      assert.equal(guard.guardAbsPath(fx.wt, { paths: [abs(fx)] }).exit_code, exit);
    });
  }
});

describe('executor step 0c — plan commit ledger', POSIX_ONLY, () => {
  let fx;
  before(() => { fx = branchFixture('gsd-wt-matrix-ledger-'); });
  after(() => cleanup(fx.tmp));

  test('records HEAD once, in the file the bash ledger used', () => {
    const ledger = path.join(git(['rev-parse', '--absolute-git-dir'], fx.wt), 'gsd-plan-head-before-4-02');
    assert.equal(guard.planLedger(fx.wt, { phase: '4', plan: '02' }).ok, true);
    assert.equal(fs.readFileSync(ledger, 'utf8'), `${fx.head}\n`);
    git(['commit', '-q', '--allow-empty', '-m', 'later'], fx.wt);
    const again = guard.planLedger(fx.wt, { phase: '4', plan: '02' });
    assert.equal(fs.readFileSync(ledger, 'utf8'), `${fx.head}\n`, 'a second run keeps the first base');
    assert.equal(again.detail.commits, 1);
  });
});
