'use strict';

/**
 * ADR-5211 — the worktree guards as typed CLI verbs (`gsd-tools worktree guard
 * <stage>`, `gsd-tools worktree plan-ledger`).
 *
 * Two layers: the stage functions with an INJECTED git runner (every fault
 * path — git missing, timing out, exiting oddly — must refuse, ADR-3409), and
 * the CLI end to end on real linked worktrees, asserting on the typed JSON
 * (`ok`, `code`, `exit_code`) and the process exit code only.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_IDENTITY_ENV, BRANCH_ROWS } = require('./helpers/worktree-guard-corpus.cjs');
const guard = require('../gsd-core/bin/lib/worktree-guard.cjs');

const { GUARD_CODE } = guard;
const ZERO_SHA = '0'.repeat(40);
const gitEnv = { ...process.env, ...GIT_IDENTITY_ENV };
const git = (args, cwd) => gitOrThrow(args, { cwd, env: gitEnv }).trim();

/** Run the CLI verb; return the parsed JSON and the process exit code. */
function verb(cwd, args) {
  const r = runGsdTools(['worktree', ...args], cwd);
  return { json: JSON.parse(r.output), exitCode: r.exitCode };
}

/** A main checkout plus a linked worktree on `branch`. Real paths. */
function makeRepo(branch = 'agent-abc') {
  const tmp = createTempDir('gsd-wt-guard-');
  const main = path.join(tmp, 'main');
  git(['init', '-q', main], tmp);
  git(['commit', '-q', '--allow-empty', '-m', 'init'], main);
  const wt = path.join(tmp, 'wt');
  git(['worktree', 'add', '-q', '-b', branch, wt], main);
  return { tmp, main: fs.realpathSync(main), wt: fs.realpathSync(wt) };
}

// ─── Fault injection: a git that cannot answer is always a refusal ──────────

const OK = (stdout) => ({ exitCode: 0, stdout: `${stdout}\n`, stderr: '', signal: null, error: null, timedOut: false });
const TIMED_OUT = { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true };
const SPAWN_FAILED = { exitCode: 1, stdout: '', stderr: '', signal: null, error: new Error('spawn git ENOENT'), timedOut: false };
const NOT_A_REPO = { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null, timedOut: false };

describe('every stage refuses when git cannot answer (ADR-3409)', () => {
  const stages = [
    ['branch', (deps) => guard.guardBranch('/x', { expectedBase: ZERO_SHA }, deps), 42],
    ['pre-commit', (deps) => guard.guardPreCommit('/x', { sequential: false, configCwd: '/x' }, deps), 1],
    ['sentinel', (deps) => guard.guardSentinel('/x', deps), 1],
    ['abs-path', (deps) => guard.guardAbsPath('/x', { paths: ['/x/a'] }, deps), 1],
    ['automated', (deps) => guard.guardAutomated('/x', { command: 'ls' }, deps), 1],
    ['pin', (deps) => guard.guardPin('/x', { root: '/x' }, deps), 1],
    ['plan-ledger', (deps) => guard.planLedger('/x', { phase: '1', plan: '01' }, deps), 1],
  ];
  for (const [name, run, exit] of stages) {
    for (const [fault, answer] of [['timed out', TIMED_OUT], ['missing', SPAWN_FAILED], ['not a repository', NOT_A_REPO]]) {
      test(`${name}: git ${fault} → refusal with exit ${exit}`, () => {
        const r = run({ execGit: () => answer });
        assert.equal(r.ok, false);
        assert.equal(r.exit_code, exit);
      });
    }
    test(`${name}: a throwing runner → refusal, never a pass`, () => {
      const r = run({ execGit: () => { throw new Error('boom'); } });
      assert.equal(r.ok, false);
      assert.equal(r.exit_code, exit);
    });
  }

  test('an empty toplevel answer (no work tree) is no answer', () => {
    const r = guard.guardAbsPath('/x', { paths: ['/x/a'] }, { execGit: () => OK('') });
    assert.equal(r.ok, false);
    assert.equal(r.code, GUARD_CODE.ROOT_UNRESOLVED);
  });

  test('pre-commit: an unreadable protected-branch answer falls back to the five names', () => {
    const answers = { 'symbolic-ref': OK('refs/heads/main'), 'rev-parse': OK('main') };
    const execGit = (args) => answers[args[0]];
    const r = guard.guardPreCommit('/x', { sequential: true, configCwd: '/x' }, {
      execGit,
      resolveProtected: () => { throw new Error('config unreadable'); },
    });
    assert.equal(r.code, GUARD_CODE.PROTECTED_BRANCH);
    assert.equal(r.detail.protection_source, 'fallback');
  });

  test('pre-commit: an unverified protected-branch answer is "protected" (fail closed, #3057)', () => {
    const answers = { 'symbolic-ref': OK('refs/heads/agent-1'), 'rev-parse': OK('agent-1') };
    const r = guard.guardPreCommit('/x', { sequential: false, configCwd: '/x' }, {
      execGit: (args) => answers[args[0]],
      resolveProtected: () => ({ isProtected: false, verified: false }),
    });
    assert.equal(r.code, GUARD_CODE.PROTECTED_BRANCH);
  });
});

// ─── CLI argument handling ──────────────────────────────────────────────────

describe('CLI: unknown stages, missing and malformed flags are refusals', () => {
  let repo;
  before(() => { repo = makeRepo(); });
  after(() => cleanup(repo.tmp));

  for (const [label, args, exit] of [
    ['no stage', ['guard'], 1],
    ['an unknown stage', ['guard', 'bogus'], 1],
    ['branch without --expected-base', ['guard', 'branch'], 42],
    ['branch with a dangling flag', ['guard', 'branch', '--expected-base'], 42],
    ['branch with an unknown flag', ['guard', 'branch', '--expected-base', ZERO_SHA, '--force'], 42],
    ['branch with a repeated flag', ['guard', 'branch', '--expected-base', ZERO_SHA, '--expected-base', ZERO_SHA], 42],
    ['abs-path without --path', ['guard', 'abs-path'], 1],
    ['automated with neither source', ['guard', 'automated'], 1],
    ['automated with --plan but no --task', ['guard', 'automated', '--plan', 'PLAN.md'], 1],
    ['automated with both sources', ['guard', 'automated', '--command', 'ls', '--plan', 'P.md', '--task', '1'], 1],
    ['automated with a task of 0', ['guard', 'automated', '--plan', 'P.md', '--task', '0'], 1],
    ['automated with a non-numeric task', ['guard', 'automated', '--plan', 'P.md', '--task', 'one'], 1],
    ['pin without --root', ['guard', 'pin'], 1],
    ['plan-ledger without --plan', ['plan-ledger', '--phase', '1'], 1],
    ['plan-ledger with a path in --plan', ['plan-ledger', '--phase', '1', '--plan', '../x'], 1],
  ]) {
    test(`${label} → exit ${exit}, not ok`, () => {
      const r = verb(repo.wt, args);
      assert.equal(r.exitCode, exit);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.exit_code, exit);
    });
  }

  test('an unknown stage names the closed stage list', () => {
    const r = verb(repo.wt, ['guard', 'bogus']);
    assert.equal(r.json.code, GUARD_CODE.UNKNOWN_STAGE);
    assert.deepEqual(r.json.detail.stages, ['branch', 'pre-commit', 'sentinel', 'abs-path', 'automated', 'pin']);
  });
});

// ─── branch ─────────────────────────────────────────────────────────────────

describe('guard branch (worktree_branch_check, exit 42)', () => {
  let repo;
  let head;
  before(() => {
    repo = makeRepo('agent-abc');
    head = git(['rev-parse', 'HEAD'], repo.wt);
  });
  after(() => cleanup(repo.tmp));

  const setBranch = (name) => {
    git(['update-ref', `refs/heads/${name}`, head], repo.wt);
    git(['symbolic-ref', 'HEAD', `refs/heads/${name}`], repo.wt);
  };

  test('passes on an agent branch at the expected base', () => {
    setBranch('agent-abc');
    const r = verb(repo.wt, ['guard', 'branch', '--expected-base', head, '--alternate-base', '']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.code, GUARD_CODE.OK);
  });

  test('passes at the declared alternate base (#1265)', () => {
    setBranch('agent-abc');
    const r = verb(repo.wt, ['guard', 'branch', '--expected-base', ZERO_SHA, '--alternate-base', head]);
    assert.equal(r.exitCode, 0);
  });

  test('refuses a base mismatch with exit 42', () => {
    setBranch('agent-abc');
    const r = verb(repo.wt, ['guard', 'branch', '--expected-base', ZERO_SHA, '--alternate-base', '']);
    assert.equal(r.exitCode, 42);
    assert.equal(r.json.code, GUARD_CODE.BASE_MISMATCH);
  });

  test('an unsubstituted expected base is refused, not compared', () => {
    setBranch('agent-abc');
    const r = verb(repo.wt, ['guard', 'branch', '--expected-base', '{EXPECTED_BASE}']);
    assert.equal(r.exitCode, 42);
    assert.equal(r.json.code, GUARD_CODE.EXPECTED_BASE_INVALID);
  });

  test('an unsubstituted alternate never matches (it is not a SHA)', () => {
    setBranch('agent-abc');
    const r = verb(repo.wt, ['guard', 'branch', '--expected-base', ZERO_SHA, '--alternate-base', '{EXPECTED_BASE_ALTERNATE}']);
    assert.equal(r.json.code, GUARD_CODE.BASE_MISMATCH);
  });

  test('refuses a detached HEAD', () => {
    git(['checkout', '-q', '--detach'], repo.wt);
    const r = verb(repo.wt, ['guard', 'branch', '--expected-base', head]);
    assert.equal(r.exitCode, 42);
    assert.equal(r.json.code, GUARD_CODE.HEAD_DETACHED);
  });

  const protectedNames = new Set(['main', 'master', 'develop', 'trunk', 'release/1.0']);
  const agentNames = new Set(['agent-x', 'agent-a1/b.c_d-e', 'worktree-agent-7', 'worktree-wf_abc', 'worktree-wf_run-1']);
  for (const name of BRANCH_ROWS) {
    const expected = protectedNames.has(name) ? GUARD_CODE.PROTECTED_BRANCH
      : agentNames.has(name) ? GUARD_CODE.OK : GUARD_CODE.NAMESPACE_MISMATCH;
    test(`branch '${name}' → ${expected}`, () => {
      setBranch(name);
      const r = verb(repo.wt, ['guard', 'branch', '--expected-base', head]);
      assert.equal(r.json.code, expected);
      assert.equal(r.exitCode, expected === GUARD_CODE.OK ? 0 : 42);
    });
  }
});

// ─── pre-commit ─────────────────────────────────────────────────────────────

describe('guard pre-commit (executor step 0, #2924/#3819/#4799)', () => {
  let repo;
  before(() => {
    repo = makeRepo('agent-1');
    fs.mkdirSync(path.join(repo.main, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(repo.main, '.planning', 'config.json'), JSON.stringify({ git: { base_branch: 'trunk-x', protected_branches: ['frozen'] } }));
  });
  after(() => cleanup(repo.tmp));

  const onBranch = (name) => {
    const head = git(['rev-parse', 'HEAD'], repo.wt);
    git(['update-ref', `refs/heads/${name}`, head], repo.wt);
    git(['symbolic-ref', 'HEAD', `refs/heads/${name}`], repo.wt);
  };

  test('an agent branch in an isolated worktree may commit', () => {
    onBranch('agent-1');
    assert.equal(verb(repo.wt, ['guard', 'pre-commit']).exitCode, 0);
  });

  test('a non-agent branch in an isolated worktree is refused', () => {
    onBranch('feature/phase-48');
    const r = verb(repo.wt, ['guard', 'pre-commit']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.code, GUARD_CODE.NAMESPACE_MISMATCH);
  });

  test('--sequential lifts only the namespace rule', () => {
    onBranch('feature/phase-48');
    assert.equal(verb(repo.wt, ['guard', 'pre-commit', '--sequential']).exitCode, 0);
  });

  test('the configured base branch is protected, sequential or not', () => {
    onBranch('trunk-x');
    const r = verb(repo.wt, ['guard', 'pre-commit', '--sequential']);
    assert.equal(r.json.code, GUARD_CODE.PROTECTED_BRANCH);
    assert.equal(r.json.detail.protection_source, 'config');
  });

  test('a configured protected_branches entry is protected', () => {
    onBranch('frozen');
    assert.equal(verb(repo.wt, ['guard', 'pre-commit', '--sequential']).json.code, GUARD_CODE.PROTECTED_BRANCH);
  });

  test('a main checkout is not subject to the agent namespace', () => {
    const r = verb(repo.main, ['guard', 'pre-commit']);
    assert.equal(r.json.detail.linked_worktree, false);
    assert.notEqual(r.json.code, GUARD_CODE.NAMESPACE_MISMATCH);
  });
});

// ─── sentinel ───────────────────────────────────────────────────────────────

describe('guard sentinel (step 0a, #3097)', () => {
  let repo;
  let sentinel;
  before(() => {
    repo = makeRepo();
    sentinel = path.join(git(['rev-parse', '--absolute-git-dir'], repo.wt), 'gsd-spawn-toplevel');
  });
  after(() => cleanup(repo.tmp));

  test('first call records the spawn toplevel; the second passes against it', () => {
    const first = verb(repo.wt, ['guard', 'sentinel']);
    assert.equal(first.exitCode, 0);
    assert.equal(first.json.detail.created, true);
    const second = verb(repo.wt, ['guard', 'sentinel']);
    assert.equal(second.exitCode, 0);
    assert.equal(second.json.detail.created, false);
  });

  test('a moved toplevel is drift', () => {
    fs.writeFileSync(sentinel, '/somewhere/else\n');
    const r = verb(repo.wt, ['guard', 'sentinel']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.code, GUARD_CODE.CWD_DRIFT);
  });

  test('an empty sentinel is corrupt, not a pass', () => {
    fs.writeFileSync(sentinel, '');
    const r = verb(repo.wt, ['guard', 'sentinel']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.code, GUARD_CODE.SENTINEL_CORRUPT);
    fs.unlinkSync(sentinel);
  });

  test('outside a linked worktree the sentinel does not apply', () => {
    const r = verb(repo.main, ['guard', 'sentinel']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.applies, false);
  });
});

// ─── abs-path ───────────────────────────────────────────────────────────────

describe('guard abs-path (step 0b, #3099) — containment boundaries', () => {
  let repo;
  before(() => {
    repo = makeRepo();
    fs.mkdirSync(`${repo.wt}-x`);
    fs.symlinkSync(repo.main, path.join(repo.wt, 'main-link'));
  });
  after(() => cleanup(repo.tmp));

  for (const [label, rel, exit] of [
    ['the root itself', (r) => r.wt, 0],
    ['the root with a trailing slash', (r) => `${r.wt}/`, 0],
    ['a file under the root', (r) => `${r.wt}/src/a.ts`, 0],
    ['a not-yet-existing nested path', (r) => `${r.wt}/a/b/c.ts`, 0],
    ['a relative path', () => 'src/a.ts', 0],
    ['the sibling <root>-x (string prefix, not containment)', (r) => `${r.wt}-x/a`, 1],
    ['the main checkout', (r) => `${r.main}/a`, 1],
    ['a `..` hop out of the root', (r) => `${r.wt}/../main/a`, 1],
    ['a symlink inside the root that lands in main', (r) => `${r.wt}/main-link/a`, 1],
    ['a relative escape', () => '../main/a', 1],
  ]) {
    test(`${label} → exit ${exit}`, () => {
      const r = verb(repo.wt, ['guard', 'abs-path', '--path', rel(repo)]);
      assert.equal(r.exitCode, exit);
      assert.equal(r.json.code, exit === 0 ? GUARD_CODE.OK : GUARD_CODE.OUTSIDE_WORKTREE);
    });
  }

  test('several --path values: one outside refuses the whole check', () => {
    const r = verb(repo.wt, ['guard', 'abs-path', '--path', `${repo.wt}/a`, '--path', `${repo.main}/b`]);
    assert.equal(r.exitCode, 1);
    assert.deepEqual(r.json.detail.outside, [`${repo.main}/b`]);
  });
});

// ─── automated ──────────────────────────────────────────────────────────────

describe('guard automated (step 0c, #4767) — the plan is read by the verb', () => {
  let repo;
  let plan;
  before(() => {
    repo = makeRepo();
    plan = path.join(repo.wt, 'PLAN.md');
    fs.writeFileSync(plan, [
      '<task type="auto"><name>Task 1: inside</name>',
      '<verify><automated>npm test</automated></verify></task>',
      '<task type="auto"><name>Task 2: leaves</name>',
      `<verify><automated>cd ${repo.main} && npm test</automated></verify></task>`,
      '<task type="auto"><name>Task 3: no command</name><done>x</done></task>',
      '',
    ].join('\n'));
  });
  after(() => cleanup(repo.tmp));

  test('a task whose command stays inside passes', () => {
    const r = verb(repo.wt, ['guard', 'automated', '--plan', plan, '--task', '1']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.detail.commands, 1);
  });

  test('a task whose command relocates into main is refused', () => {
    const r = verb(repo.wt, ['guard', 'automated', '--plan', 'PLAN.md', '--task', '2']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.code, GUARD_CODE.RELOCATES_OUTSIDE_WORKTREE);
  });

  test('a task with no <automated> passes as not applicable', () => {
    const r = verb(repo.wt, ['guard', 'automated', '--plan', plan, '--task', '3']);
    assert.equal(r.exitCode, 0);
    assert.equal(r.json.applies, false);
  });

  test('a task past the end of the plan is refused', () => {
    const r = verb(repo.wt, ['guard', 'automated', '--plan', plan, '--task', '4']);
    assert.equal(r.json.code, GUARD_CODE.TASK_NOT_FOUND);
  });

  test('a plan in the main checkout is readable (the orchestrator anchors phase_dir there)', () => {
    const mainPlan = path.join(repo.main, 'PLAN.md');
    fs.writeFileSync(mainPlan, '<task><name>T</name><verify><automated>ls</automated></verify></task>\n');
    assert.equal(verb(repo.wt, ['guard', 'automated', '--plan', mainPlan, '--task', '1']).exitCode, 0);
  });

  test('a plan outside both checkouts is refused', () => {
    const r = verb(repo.wt, ['guard', 'automated', '--plan', path.join(repo.tmp, 'PLAN.md'), '--task', '1']);
    assert.equal(r.json.code, GUARD_CODE.PLAN_OUTSIDE_PROJECT);
  });

  test('the passing task names itself in detail', () => {
    assert.equal(verb(repo.wt, ['guard', 'automated', '--plan', plan, '--task', '1']).json.detail.task_name, 'Task 1: inside');
  });

  // Review BLOCKER: an unclosed <task> made the block grammar skip it, so every later ordinal
  // shifted and the guard checked another task's command — and passed.
  test('an unclosed <task> refuses plan_malformed instead of shifting the ordinals', () => {
    const bad = path.join(repo.wt, 'BAD-TASK.md');
    fs.writeFileSync(bad, [
      `<task><name>T1</name><verify><automated>cd ${repo.main} && npm test</automated></verify>`,
      '<task><name>T2</name><verify><automated>npm test</automated></verify></task>',
      '',
    ].join('\n'));
    for (const task of ['1', '2']) {
      const r = verb(repo.wt, ['guard', 'automated', '--plan', bad, '--task', task]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.json.code, GUARD_CODE.PLAN_MALFORMED);
      assert.equal(r.json.detail.reason, 'task_unclosed');
    }
  });

  test('an unclosed <automated> refuses plan_malformed instead of passing as not applicable', () => {
    const bad = path.join(repo.wt, 'BAD-AUTOMATED.md');
    fs.writeFileSync(bad, `<task><name>T1</name><verify><automated>cd ${repo.main} && npm test</verify></task>\n`);
    const r = verb(repo.wt, ['guard', 'automated', '--plan', bad, '--task', '1']);
    assert.equal(r.json.code, GUARD_CODE.PLAN_MALFORMED);
    assert.equal(r.json.detail.reason, 'automated_unclosed');
  });

  test('called without a task (or a non-ordinal one) the stage function refuses usage, never throws', () => {
    for (const task of [undefined, 'x', '0']) {
      const r = guard.guardAutomated(repo.wt, { plan, task });
      assert.equal(r.code, GUARD_CODE.USAGE);
      assert.equal(r.exit_code, 1);
    }
  });

  test('a missing plan is unreadable, not empty', () => {
    const r = verb(repo.wt, ['guard', 'automated', '--plan', 'NOPE.md', '--task', '1']);
    assert.equal(r.json.code, GUARD_CODE.PLAN_UNREADABLE);
  });
});

// ─── pin ────────────────────────────────────────────────────────────────────

describe('guard pin (step 0p, #4254)', () => {
  let repo;
  before(() => { repo = makeRepo('phase/2-1'); });
  after(() => cleanup(repo.tmp));

  test('the pinned root itself, a trailing slash and a symlink alias all match', () => {
    const alias = path.join(repo.tmp, 'alias');
    fs.symlinkSync(repo.wt, alias);
    for (const pin of [repo.wt, `${repo.wt}/`, alias]) {
      assert.equal(verb(repo.wt, ['guard', 'pin', '--root', pin]).exitCode, 0, pin);
    }
  });

  for (const [label, pin, code] of [
    ['an unsubstituted pin', '{PINNED_ROOT}', GUARD_CODE.PIN_UNBOUND],
    ['an empty pin', '', GUARD_CODE.PIN_UNBOUND],
    ['a relative pin', 'relative/path', GUARD_CODE.PIN_NOT_ABSOLUTE],
    ['a nonexistent drive-letter pin (forward slash)', 'C:/definitely/not/a/repo', GUARD_CODE.PIN_UNRESOLVED],
    ['a nonexistent drive-letter pin (backslash)', 'C:\\definitely\\not\\a\\repo', GUARD_CODE.PIN_UNRESOLVED],
  ]) {
    test(`${label} → ${code}`, () => {
      const r = verb(repo.wt, ['guard', 'pin', '--root', pin]);
      assert.equal(r.exitCode, 1);
      assert.equal(r.json.code, code);
    });
  }

  test('an executor standing in the other checkout of the same repo is a root mismatch', () => {
    const r = verb(repo.main, ['guard', 'pin', '--root', repo.wt]);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.code, GUARD_CODE.ROOT_MISMATCH);
  });
});

// ─── plan-ledger ────────────────────────────────────────────────────────────

describe('worktree plan-ledger (#3968)', () => {
  let repo;
  before(() => { repo = makeRepo(); });
  after(() => cleanup(repo.tmp));

  test('records once, then measures commits since the recorded base', () => {
    const first = verb(repo.wt, ['plan-ledger', '--phase', '3', '--plan', '01']);
    assert.equal(first.exitCode, 0);
    assert.equal(first.json.detail.created, true);
    assert.equal(first.json.detail.commits, 0);
    git(['commit', '-q', '--allow-empty', '-m', 'a'], repo.wt);
    git(['commit', '-q', '--allow-empty', '-m', 'b'], repo.wt);
    const second = verb(repo.wt, ['plan-ledger', '--phase', '3', '--plan', '01']);
    assert.equal(second.json.detail.created, false);
    assert.equal(second.json.detail.commits, 2);
    assert.equal(second.json.detail.plan_head_before, first.json.detail.plan_head_before);
    assert.equal(second.json.detail.plan_head_after, git(['rev-parse', 'HEAD'], repo.wt));
  });

  test('ledgers are per plan', () => {
    const other = verb(repo.wt, ['plan-ledger', '--phase', '3', '--plan', '02']);
    assert.equal(other.json.detail.created, true);
    assert.equal(other.json.detail.commits, 0);
  });

  test('a ledger that does not hold a SHA is corrupt', () => {
    const gitDir = git(['rev-parse', '--absolute-git-dir'], repo.wt);
    fs.writeFileSync(path.join(gitDir, 'gsd-plan-head-before-9-01'), 'garbage\n');
    const r = verb(repo.wt, ['plan-ledger', '--phase', '9', '--plan', '01']);
    assert.equal(r.exitCode, 1);
    assert.equal(r.json.code, GUARD_CODE.LEDGER_CORRUPT);
  });
});

// ─── materialize ────────────────────────────────────────────────────────────

describe('worktree materialize (quick isolated dispatch, exit 42)', () => {
  let repo;
  let commit;
  before(() => {
    repo = makeRepo();
    fs.mkdirSync(path.join(repo.main, '.planning', 'quick', 'q1'), { recursive: true });
    fs.writeFileSync(path.join(repo.main, '.planning', 'quick', 'q1', 'q1-PLAN.md'), 'plan\n\n');
    git(['add', '.planning'], repo.main);
    git(['commit', '-q', '-m', 'plan'], repo.main);
    commit = git(['rev-parse', 'HEAD'], repo.main);
  });
  after(() => cleanup(repo.tmp));

  test('writes a missing plan byte for byte, and leaves it alone on a second run', () => {
    const args = ['materialize', '--from', commit, '--path', '.planning/quick/q1/q1-PLAN.md', '--optional-path', '.planning/quick/q1/q1-CONTEXT.md'];
    const first = verb(repo.wt, args);
    assert.equal(first.exitCode, 0);
    assert.deepEqual(first.json.detail.written, ['.planning/quick/q1/q1-PLAN.md']);
    assert.deepEqual(first.json.detail.skipped, ['.planning/quick/q1/q1-CONTEXT.md']);
    assert.equal(fs.readFileSync(path.join(repo.wt, '.planning', 'quick', 'q1', 'q1-PLAN.md'), 'utf8'), 'plan\n\n');
    const second = verb(repo.wt, args);
    assert.deepEqual(second.json.detail.present, ['.planning/quick/q1/q1-PLAN.md']);
  });

  test('an absolute path under the main checkout (init anchors quick_dir there, #2376) is rebased onto the worktree', () => {
    const wtPlan = path.join(repo.wt, '.planning', 'quick', 'q1', 'q1-PLAN.md');
    if (fs.existsSync(wtPlan)) fs.unlinkSync(wtPlan);
    const r = verb(repo.wt, ['materialize', '--from', commit, '--path', path.join(repo.main, '.planning', 'quick', 'q1', 'q1-PLAN.md')]);
    assert.equal(r.exitCode, 0);
    assert.equal(fs.readFileSync(wtPlan, 'utf8'), 'plan\n\n');
  });

  for (const [label, args, code] of [
    ['a required path the commit lacks', (c) => ['--from', c, '--path', '.planning/quick/q1/missing.md'], GUARD_CODE.NOT_IN_COMMIT],
    ['a path escaping the worktree', (c) => ['--from', c, '--path', '../main/x.md'], GUARD_CODE.PATH_OUTSIDE_WORKTREE],
    ['an absolute path outside both checkouts', (c) => ['--from', c, '--path', '/etc/x.md'], GUARD_CODE.PATH_OUTSIDE_WORKTREE],
    ['a non-SHA commit', () => ['--from', 'HEAD', '--path', 'x.md'], GUARD_CODE.USAGE],
    ['no --path', (c) => ['--from', c], GUARD_CODE.USAGE],
  ]) {
    test(`${label} → ${code}, exit 42`, () => {
      const r = verb(repo.wt, ['materialize', ...args(commit)]);
      assert.equal(r.exitCode, 42);
      assert.equal(r.json.code, code);
    });
  }
});
