'use strict';

/**
 * gsd-worktree-provision.js — a fresh worktree is a checkout, not an environment.
 *
 * Seam: hooks/gsd-worktree-provision.js (WorktreeCreate hook), driven through
 * its exported decision function with the git/copy/install steps injected, and
 * through the real stdin/exit-code contract for the one case that blocks.
 *
 * The defect, from the ucars retrospective, which names worktree isolation
 * "the #1 recurring operational failure across multiple milestones": the tools
 * an agent had a moment ago are gone inside a worktree (mcp__pencil__*, atlas),
 * node_modules is missing or stale, and the base can be hundreds of commits
 * behind — each discovered only by failing, mid-phase, for a reason unrelated
 * to the task.
 *
 * The split that matters and is asserted below: a stale base BLOCKS (work done
 * against it must be redone), everything else WARNS (refusing a worktree over
 * an optional convenience is how people come to distrust isolation and turn it
 * off).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, runGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');

const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-worktree-provision.js');
const provision = require(HOOK);

describe('worktree provisioning', () => {
  let main;
  let worktree;

  const arm = (workflow) =>
    fs.writeFileSync(path.join(main, '.planning', 'config.json'), JSON.stringify({ workflow }));

  const payload = () => ({ worktree_path: worktree, cwd: main });

  /** Fresh base unless a test says otherwise. */
  const fresh = () => ({ behind: 0 });

  beforeEach(() => {
    main = createTempDir();
    worktree = createTempDir();
    fs.mkdirSync(path.join(main, '.planning'), { recursive: true });
    arm({ worktree_provision: true });
  });
  afterEach(() => {
    cleanup(main);
    cleanup(worktree);
  });

  test('is inert until the project asks for it', () => {
    arm({});
    const decision = provision.provisionWorktree(payload(), { measureBaseLag: fresh });
    assert.equal(decision.action, 'allow');
    assert.deepEqual(decision.notes, [], 'an unarmed hook should not even narrate');
  });

  test('blocks a base too far behind the main checkout', () => {
    arm({ worktree_provision: true, worktree_max_base_lag: 50 });
    const decision = provision.provisionWorktree(payload(), {
      measureBaseLag: () => ({ behind: 380 }),
    });
    assert.equal(decision.action, 'block');
    assert.equal(decision.behind, 380);
    assert.ok(
      decision.reason.includes('380'),
      'the block must state the distance, not merely that there is one'
    );
  });

  test('allows a base within the limit, and says how far behind it is', () => {
    arm({ worktree_provision: true, worktree_max_base_lag: 50 });
    const decision = provision.provisionWorktree(payload(), {
      measureBaseLag: () => ({ behind: 12 }),
      provisionDeps: () => ({ mode: 'link', done: false, reason: 'disabled' }),
    });
    assert.equal(decision.action, 'allow');
    assert.ok(decision.notes.some((n) => n.includes('12 commit')));
  });

  test('an unmeasurable base warns rather than blocking', () => {
    // Cannot compare is not the same as fresh — but unlike a gate, refusing
    // here strands the phase, and the executor's own first build surfaces a
    // stale base anyway.
    const decision = provision.provisionWorktree(payload(), {
      measureBaseLag: () => ({ unknown: 'shallow clone' }),
      provisionDeps: () => ({ mode: 'link', done: false, reason: 'disabled' }),
    });
    assert.equal(decision.action, 'allow');
    assert.ok(decision.notes.some((n) => n.includes('unverified')));
  });

  test('copies the tool config an agent expects to have', () => {
    // The concrete failure: mcp__pencil__* and atlas unavailable in every
    // worktree agent, because .mcp.json lives in the main checkout.
    fs.writeFileSync(path.join(main, '.mcp.json'), '{"servers":{}}');
    fs.mkdirSync(path.join(main, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(main, '.claude', 'settings.local.json'), '{"permissions":{}}');

    provision.provisionWorktree(payload(), {
      measureBaseLag: fresh,
      provisionDeps: () => ({ mode: 'none', done: false, reason: 'disabled' }),
    });

    assert.ok(fs.existsSync(path.join(worktree, '.mcp.json')), '.mcp.json must travel');
    assert.ok(
      fs.existsSync(path.join(worktree, '.claude', 'settings.local.json')),
      'settings.local.json must travel'
    );
  });

  test('never clobbers a config the worktree already carries', () => {
    fs.writeFileSync(path.join(main, '.mcp.json'), '{"servers":{"from":"main"}}');
    fs.writeFileSync(path.join(worktree, '.mcp.json'), '{"servers":{"from":"worktree"}}');

    const decision = provision.provisionWorktree(payload(), {
      measureBaseLag: fresh,
      provisionDeps: () => ({ mode: 'none', done: false, reason: 'disabled' }),
    });

    assert.match(
      fs.readFileSync(path.join(worktree, '.mcp.json'), 'utf8'),
      /worktree/,
      'a worktree with its own settings is making a deliberate statement'
    );
    assert.ok(decision.notes.some((n) => n.includes('left existing')));
  });

  test('links node_modules by default, and reports when it cannot', () => {
    fs.mkdirSync(path.join(main, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(main, 'node_modules', '.marker'), 'x');

    const linked = provision.provisionWorktree(payload(), { measureBaseLag: fresh });
    assert.ok(
      fs.existsSync(path.join(worktree, 'node_modules', '.marker')),
      'the link must actually resolve to the main checkout'
    );
    assert.ok(linked.notes.some((n) => n.includes('linked')));

    // Nothing to link: a note, not a failure — the phase may not need deps.
    const bare = createTempDir();
    try {
      const decision = provision.provisionWorktree(
        { worktree_path: bare, cwd: main },
        { measureBaseLag: fresh, copyToolConfig: () => ({ copied: [], skipped: [] }) }
      );
      assert.equal(decision.action, 'allow');
    } finally {
      cleanup(bare);
    }
  });

  test('a failed install warns instead of refusing the worktree', () => {
    arm({
      worktree_provision: true,
      worktree_deps: 'install',
      worktree_install_command: 'exit 1',
    });
    const decision = provision.provisionWorktree(payload(), { measureBaseLag: fresh });
    assert.equal(
      decision.action,
      'allow',
      'refusing isolation over an optional convenience is how people turn isolation off'
    );
    assert.ok(decision.notes.some((n) => n.includes('not provisioned')));
  });

  test('install mode with no command configured says so', () => {
    arm({ worktree_provision: true, worktree_deps: 'install' });
    const decision = provision.provisionWorktree(payload(), { measureBaseLag: fresh });
    assert.ok(decision.notes.some((n) => n.includes('names no command')));
  });

  test('is silent about a worktree it cannot see, and about a malformed payload', () => {
    const decision = provision.provisionWorktree(
      { worktree_path: path.join(main, 'nope'), cwd: main },
      { measureBaseLag: fresh }
    );
    assert.equal(decision.action, 'allow');
    assert.deepEqual(decision.notes, []);
    assert.equal(provision.provisionWorktree(null).action, 'allow');
  });

  test('a stale base reaches the runtime as exit 2, over real git history', () => {
    // The blocking path end-to-end, with no injection: two real repositories,
    // one deliberately left behind the other, driven through the hook's actual
    // stdin/exit-code contract. Anything less would pin the decision function
    // while leaving the thing the runtime actually consumes untested.
    const repoDir = createTempGitProject();
    try {
      fs.mkdirSync(path.join(repoDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, '.planning', 'config.json'),
        JSON.stringify({ workflow: { worktree_provision: true, worktree_max_base_lag: 1 } })
      );

      // The worktree forks here…
      const forkPoint = runGit(['rev-parse', 'HEAD'], { cwd: repoDir }).stdout.trim();
      const stale = createTempDir();
      runGit(['worktree', 'add', '--detach', stale, forkPoint], { cwd: repoDir });

      // …and the main checkout then moves three commits ahead of it.
      for (const n of [1, 2, 3]) {
        fs.writeFileSync(path.join(repoDir, `moved-${n}.txt`), String(n));
        runGit(['add', '-A'], { cwd: repoDir });
        runGit(['commit', '-m', `move ${n}`], { cwd: repoDir });
      }

      const result = runNode([HOOK], {
        input: JSON.stringify({ worktree_path: stale, cwd: repoDir }),
        cwd: repoDir,
      });
      assert.equal(result.outcome, OUTCOME.EXITED);
      assert.equal(result.exitCode, 2, 'exit 2 is what refuses the creation');
      const emitted = JSON.parse(result.stdout);
      assert.equal(emitted.behind, 3, 'the distance is reported, not merely the refusal');
      assert.equal(emitted.maxBaseLag, 1);

      runGit(['worktree', 'remove', '--force', stale], { cwd: repoDir });
      cleanup(stale);
    } finally {
      cleanup(repoDir);
    }
  });

  test('a worktree within the limit is created and equipped', () => {
    const repoDir = createTempGitProject();
    try {
      fs.mkdirSync(path.join(repoDir, '.planning'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, '.planning', 'config.json'),
        JSON.stringify({ workflow: { worktree_provision: true, worktree_max_base_lag: 50 } })
      );
      fs.writeFileSync(path.join(repoDir, '.mcp.json'), '{"servers":{}}');

      const fresh_ = createTempDir();
      runGit(['worktree', 'add', '--detach', fresh_, 'HEAD'], { cwd: repoDir });

      const result = runNode([HOOK], {
        input: JSON.stringify({ worktree_path: fresh_, cwd: repoDir }),
        cwd: repoDir,
      });
      assert.equal(result.exitCode, 0);
      assert.ok(
        fs.existsSync(path.join(fresh_, '.mcp.json')),
        'the tools an agent expects must travel with the checkout'
      );

      runGit(['worktree', 'remove', '--force', fresh_], { cwd: repoDir });
      cleanup(fresh_);
    } finally {
      cleanup(repoDir);
    }
  });
});
