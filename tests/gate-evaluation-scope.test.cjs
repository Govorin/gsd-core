'use strict';

/**
 * Evaluation-scope resolver (#5164, epic #5056, ADR-5057 §4 second bullet).
 *
 * Behavioral tests against real git fixtures: the scope is the UNION of the unit's own commits'
 * file sets (never a range), only branch-reachable commits count, an empty union degrades loudly,
 * and everything the union drops is named by path. Git failure is injected through the resolver's
 * `execGit` seam (never a mode-bit trick).
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const {
  resolveEvaluationScope,
  evaluateEvaluationScope,
  extractTaskCommitRefs,
  planSubjectPattern,
  isSafeRefArgument,
  SCOPE_EXCLUSION_PATHSPECS,
  parseWindowSince,
  parseLastWindowMarker,
  formatLastWindowMarker,
  lastWindowMarkerPath,
  UNATTRIBUTED,
} = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const PHASE_DIR = '.planning/phases/03-scope';

const dirs = [];
afterEach(() => { while (dirs.length > 0) cleanup(dirs.pop()); });

function write(dir, rel, content) {
  const target = path.join(dir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-'));
  dirs.push(dir);
  const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', '{}');
  write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
  git('add', '.');
  git('commit', '-m', 'docs(03): scaffold phase');
  return { dir, git };
}

/** Commit one real file; returns the full sha. */
function commit(repo, rel, message, content = `${rel}\n`) {
  write(repo.dir, rel, content);
  repo.git('add', rel);
  repo.git('commit', '-m', message);
  return repo.git('rev-parse', 'HEAD');
}

/** Write a SUMMARY whose `## Task Commits` rows name `shas`, and commit it. */
function summarize(repo, shas, name = '03-01-SUMMARY.md') {
  const rows = shas.map((sha, i) => `${i + 1}. **Task ${i + 1}: work** - \`${sha}\``).join('\n');
  commit(repo, `${PHASE_DIR}/${name}`, 'docs(03-01): summary', `# Summary\n\n## Task Commits\n\n${rows}\n\n## Next\n`);
}

describe('resolveEvaluationScope — phase unit', () => {
  test('[happy] scope is the union of the task commits\' own file sets', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'task-commits');
    assert.equal(scope.reason, null);
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.commits.map((c) => c.sha), [a, b]);
    assert.deepEqual(scope.commits[0].files, ['src/a.js']);
    assert.deepEqual(scope.unreachable, []);
  });

  test('[regression #3926] interleaved non-phase commits stay out of scope and are named', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'other/quick-task.js', 'fix(quick): unrelated work');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js', 'src/b.js']);
    assert.deepEqual(scope.outsideUnion, ['other/quick-task.js']);
  });

  test('[regression #3926] post-phase work landed after the last task commit is not in scope', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    commit(repo, 'src/later-phase.js', 'feat(04-01): next phase');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[hostile] a task commit that lives only on another branch is named and excluded', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    repo.git('checkout', '-b', 'side');
    const side = commit(repo, 'src/side.js', 'feat(03-01): side only');
    repo.git('checkout', 'main');
    summarize(repo, [a, side]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.deepEqual(scope.unreachable, [side]);
  });

  test('[negative] no SUMMARY degrades to the phase range and says why', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-summary');
    assert.equal(scope.source, 'phase-range');
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.notEqual(scope.rangeBase, null);
  });

  test('[negative] a SUMMARY with no task rows degrades', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, `${PHASE_DIR}/03-01-SUMMARY.md`, 'docs(03-01): summary', '# Summary\n\n## Task Commits\n\nnone\n\n## Next\n');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-task-commit-rows');
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[negative] ids no object answers to degrade, named, never an empty resolved scope', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const ghost = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    summarize(repo, [ghost]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-reachable-task-commits');
    assert.deepEqual(scope.unreachable, [ghost]);
    assert.deepEqual(scope.files, ['src/a.js']);
  });

  test('[negative] a planning-only phase never becomes an empty scope that reviews nothing', () => {
    const repo = makeRepo();
    const planning = commit(repo, `${PHASE_DIR}/03-01-NOTES.md`, 'docs(03-01): notes');
    summarize(repo, [planning]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'empty-after-exclusions');
    assert.equal(scope.source, 'phase-range');
  });

  test('[negative] a phase directory git never saw has no anchor: unresolvable, not empty', () => {
    const repo = makeRepo();
    write(repo.dir, '.planning/phases/04-fresh/04-CONTEXT.md', 'untracked\n');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '4' });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /no-phase-start-anchor$/);
    assert.deepEqual(scope.files, []);
  });

  test('[negative] an unknown phase is unresolvable', () => {
    const repo = makeRepo();
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '9' });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'phase-dir-not-found');
  });

  test('[negative] scoped paths deleted later are named, not silently counted', () => {
    const repo = makeRepo();
    const keep = commit(repo, 'src/keep.js', 'feat(03-01): keep');
    const gone = commit(repo, 'src/gone.js', 'feat(03-01): gone');
    repo.git('rm', 'src/gone.js');
    repo.git('commit', '-m', 'chore: later removal');
    summarize(repo, [keep, gone]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.changedFiles, ['src/gone.js', 'src/keep.js']);
    assert.deepEqual(scope.files, ['src/keep.js']);
    assert.deepEqual(scope.missingOnDisk, ['src/gone.js']);
  });

  test('[boundary] a merge commit contributes its diff against the first parent', () => {
    const repo = makeRepo();
    repo.git('checkout', '-b', 'side');
    commit(repo, 'src/merged.js', 'feat(03-01): on side');
    repo.git('checkout', 'main');
    commit(repo, 'src/main-only.js', 'feat(03-01): on main');
    repo.git('merge', '--no-ff', 'side', '-m', 'feat(03-01): merge side');
    const merge = repo.git('rev-parse', 'HEAD');
    summarize(repo, [merge]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/merged.js']);
  });

  test('[boundary] `since` drops that commit and its ancestors (wave scoping)', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    summarize(repo, [a, b]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { since: a });
    assert.deepEqual(scope.files, ['src/b.js']);
    assert.equal(scope.rangeBase, a);
  });

  test('[independence] exclusions never reach the scope', () => {
    const repo = makeRepo();
    write(repo.dir, 'package-lock.json', '{}\n');
    repo.git('add', 'package-lock.json');
    write(repo.dir, 'src/a.js', 'a\n');
    repo.git('add', 'src/a.js');
    repo.git('commit', '-m', 'feat(03-01): a and lockfile');
    summarize(repo, [repo.git('rev-parse', 'HEAD')]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' });
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.ok(SCOPE_EXCLUSION_PATHSPECS.includes(':!package-lock.json'));
  });
});

describe('extractTaskCommitRefs', () => {
  test('[hostile] a sha in prose, on the metadata line or outside the section is not a task commit', () => {
    const doc = [
      '`1111111` quoted before the section',
      '## Task Commits',
      '',
      'Prose quoting `2222222` is not a row.',
      '**Plan metadata:** `3333333`',
      '1. **Task 1: real** - `4444444`',
      '- **Task 2: two commits** - `5555555` `6666666`',
      '## Next',
      '1. **Task 3: after the section** - `7777777`',
    ].join('\n');
    assert.deepEqual(extractTaskCommitRefs(doc), ['4444444', '5555555', '6666666']);
  });

  test('[property] only hex tokens on task rows inside the section contribute', () => {
    const hex = fc.stringMatching(/^[0-9a-f]{7,40}$/);
    const line = fc.oneof(
      fc.record({ kind: fc.constant('row'), hashes: fc.array(hex, { minLength: 1, maxLength: 3 }) }),
      fc.record({ kind: fc.constant('prose'), hashes: fc.array(hex, { minLength: 1, maxLength: 2 }) }),
      fc.record({ kind: fc.constant('meta'), hashes: fc.array(hex, { minLength: 1, maxLength: 1 }) }),
    );
    fc.assert(fc.property(fc.array(line, { maxLength: 12 }), fc.array(hex, { maxLength: 3 }), (lines, outside) => {
      const body = lines.map((entry, i) => {
        const ticks = entry.hashes.map((h) => `\`${h}\``).join(' ');
        if (entry.kind === 'row') return `${i + 1}. **Task ${i + 1}: t** - ${ticks}`;
        if (entry.kind === 'prose') return `see ${ticks}`;
        return `**Plan metadata:** ${ticks}`;
      });
      const before = outside.map((h, i) => `${i + 1}. **Task ${i + 1}: before** - \`${h}\``);
      const doc = [...before, '## Task Commits', ...body, '## End'].join('\n');
      const expected = lines.filter((e) => e.kind === 'row').flatMap((e) => e.hashes);
      assert.deepEqual(extractTaskCommitRefs(doc), expected);
    }), { seed: 5164, numRuns: 100 });
  });

  test('[property positive control] a document with only prose shas yields none', () => {
    assert.deepEqual(extractTaskCommitRefs('## Task Commits\nsee `abcdef1`\n## End\n'), []);
  });
});

describe('resolveEvaluationScope — plan and quick units', () => {
  test('[happy] subjects match anchored, tolerant of zero padding, `!` and any type', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'tests/a.test.js', 'test(3-1): red');
    commit(repo, 'src/c.js', 'fix(03-01)!: breaking');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'plan-subjects');
    assert.deepEqual(scope.commits.map((c) => c.subject).sort(), ['feat(03-01): a', 'fix(03-01)!: breaking', 'test(3-1): red']);
  });

  test('[boundary] the id boundary: 03-010 and 03-02 and a body line do not match 03-01', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'src/b.js', 'feat(03-010): not this plan');
    commit(repo, 'src/c.js', 'feat(03-02): not this plan');
    commit(repo, 'src/d.js', 'chore: body mention\n\nfeat(03-01): quoted in a body line');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['feat(03-01): a']);
  });

  test('[hostile] ERE metacharacters in a plan id cannot widen the pattern', () => {
    // An id that is not `<phase>-<plan>` is matched LITERALLY, never as a pattern.
    const wildcard = new RegExp(planSubjectPattern('x.*'));
    assert.ok(wildcard.test('test(x.*): red'));
    assert.ok(!wildcard.test('test(xyz): red'), 'a plan named `x.*` is not satisfied by unrelated commits');
    const bracket = new RegExp(planSubjectPattern('a[b]'));
    assert.ok(bracket.test('feat(a[b]): g'));
    assert.ok(!bracket.test('feat(ab): g'));
    const dotted = new RegExp(planSubjectPattern('3.1-2'));
    assert.ok(dotted.test('feat(3.1-2): x'));
    assert.ok(!dotted.test('feat(3x1-2): x'));
    // An empty, over-long or whitespace-bearing id is refused outright.
    assert.equal(planSubjectPattern(''), null);
    assert.equal(planSubjectPattern('a b'), null);
    assert.equal(planSubjectPattern('x'.repeat(201)), null);
    assert.notEqual(planSubjectPattern('x'.repeat(200)), null);
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(abc-1): unrelated');
    const literal = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '.*-1' });
    assert.equal(literal.status, 'resolved');
    assert.deepEqual(literal.commits, [], '`.*-1` must not match feat(abc-1)');
    assert.equal(resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '' }).reason, 'invalid-plan-id');
  });

  test('[regression] a plan commit that lives only on another branch is not returned', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): green');
    repo.git('checkout', '-b', 'side');
    commit(repo, 'tests/red.test.js', 'test(03-01): red on a side branch');
    repo.git('checkout', 'main');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['feat(03-01): green']);
  });

  test('[boundary] maxCommits at limit-1, limit and limit+1', () => {
    const repo = makeRepo();
    for (const n of ['a', 'b', 'c']) commit(repo, `src/${n}.js`, `feat(03-01): ${n}`);
    const count = (maxCommits) => resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { maxCommits }).commits.length;
    assert.deepEqual([count(2), count(3), count(4)], [2, 3, 3]);
  });

  test('[happy] pathspecs restrict to commits touching them (the RED-commit lookup)', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): impl');
    commit(repo, 'tests/a.test.js', 'test(03-01): red');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { pathspecs: ['tests/'] });
    assert.deepEqual(scope.commits.map((c) => c.subject), ['test(03-01): red']);
  });

  test('[boundary] milestoneBound drops commits older than the latest tag', () => {
    const repo = makeRepo();
    commit(repo, 'src/old.js', 'feat(03-01): before the tag');
    repo.git('tag', 'v1.0.0');
    commit(repo, 'src/new.js', 'feat(03-01): after the tag');
    const unbounded = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    const bounded = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { milestoneBound: true });
    assert.equal(unbounded.commits.length, 2);
    assert.deepEqual(bounded.commits.map((c) => c.subject), ['feat(03-01): after the tag']);
  });

  test('[happy] a quick unit is the union of the commits naming its id', () => {
    const repo = makeRepo();
    commit(repo, 'src/q1.js', 'fix(quick-260101-abc): one');
    commit(repo, 'other/n.js', 'fix: unrelated');
    commit(repo, 'src/q2.js', 'docs(quick-260101-abc): two');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'quick', id: '260101-abc' });
    assert.equal(scope.source, 'quick-subjects');
    assert.deepEqual(scope.files, ['src/q1.js', 'src/q2.js']);
  });
});

describe('resolveEvaluationScope — failure is never an empty scope', () => {
  const fail = (result) => () => result;

  test('[negative] git missing is unresolvable, with the reason', () => {
    const scope = resolveEvaluationScope('/nonexistent', { kind: 'plan', planId: '03-01' },
      { execGit: fail({ exitCode: 127, stdout: '', stderr: 'git: not found', signal: null, error: null, timedOut: false }) });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-unavailable');
    assert.deepEqual(scope.files, []);
  });

  test('[negative] a git timeout is unresolvable, not a throw', () => {
    const scope = resolveEvaluationScope('/nonexistent', { kind: 'plan', planId: '03-01' },
      { execGit: fail({ exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true }) });
    assert.equal(scope.reason, 'git-timeout');
  });

  test('[negative] a directory that is not a repository is unresolvable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-nogit-'));
    dirs.push(dir);
    const scope = resolveEvaluationScope(dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'unresolvable');
    assert.match(scope.reason, /^git-failed:/);
  });

  test('[hostile] option-shaped or whitespace refs are refused before any git call', () => {
    const calls = [];
    const spy = (args) => { calls.push(args); return { exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false }; };
    assert.equal(resolveEvaluationScope('/x', { kind: 'plan', planId: '03-01' }, { ref: '--output=x', execGit: spy }).reason, 'unsafe-ref');
    assert.equal(resolveEvaluationScope('/x', { kind: 'plan', planId: '03-01' }, { since: 'a b', execGit: spy }).reason, 'unsafe-since');
    assert.deepEqual(calls, []);
    assert.ok(!isSafeRefArgument('-x'));
    assert.ok(isSafeRefArgument('HEAD~2'));
  });
});

describe('evaluateEvaluationScope — the check verb', () => {
  test('[negative] argv validation returns a usage failure naming the problem', () => {
    const messageOf = (args) => evaluateEvaluationScope({ projectDir: '/x', args }).failure.message;
    assert.match(messageOf([]), /exactly one of --phase/);
    assert.match(messageOf(['--phase', '3', '--plan', '03-01']), /exactly one of --phase/);
    assert.match(messageOf(['--bogus']), /unknown argument: --bogus/);
    assert.match(messageOf(['--phase']), /--phase requires a value/);
  });

  test('[happy] a verdict carries the scope payload in a pinned key order; outcome follows status', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const resolved = evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '3'] });
    assert.deepEqual(Object.keys(resolved.payload), [
      'unit', 'status', 'source', 'reason', 'commits', 'changedFiles', 'files',
      'missingOnDisk', 'outsideUnion', 'unreachable', 'rangeBase',
    ]);
    assert.equal(resolved.outcome, 'pass');
    assert.equal(resolved.block, false);
    assert.equal(evaluateEvaluationScope({ projectDir: repo.dir, args: ['--phase', '9'] }).outcome, 'skip');
    const bare = makeRepo();
    commit(bare, 'src/z.js', 'feat(03-01): z');
    assert.equal(evaluateEvaluationScope({ projectDir: bare.dir, args: ['--phase', '3'] }).outcome, 'advisory');
    // An empty-but-resolved plan scope carries a reason and is advisory, never a clean pass.
    assert.equal(evaluateEvaluationScope({ projectDir: bare.dir, args: ['--plan', '09-09'] }).outcome, 'advisory');
  });

  test('[boundary] --max-commits accepts 1 and the 1000 ceiling, refuses 0 and 1001', () => {
    const verdict = (value) => evaluateEvaluationScope({ projectDir: '/x', args: ['--plan', '03-01', '--max-commits', value] });
    assert.match(verdict('0').failure.message, /--max-commits must be an integer from 1 to 1000/);
    assert.match(verdict('1001').failure.message, /--max-commits must be an integer from 1 to 1000/);
    assert.equal(verdict('1').failure, undefined);
    assert.equal(verdict('1000').failure, undefined);
  });
});

// ─── Seams driven through an injected git runner ──────────────────────────────

const { execGit: realExecGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const TIMED_OUT = { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true };

/** A git runner that records every argv and delegates to the real git unless `force` answers. */
function spyGit(force) {
  const calls = [];
  const run = (args, opts) => {
    calls.push(args);
    const forced = force ? force(args) : undefined;
    return forced ?? realExecGit(args, opts);
  };
  run.calls = calls;
  return run;
}

describe('resolveEvaluationScope — limits at limit-1, limit and limit+1', () => {
  test('[boundary] the sha chunk size never changes the answer (chunk 2/3/4 over 3 task commits; 1 is clamped to 2)', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    commit(repo, 'other/noise.js', 'fix: noise');
    const b = commit(repo, 'src/b.js', 'feat(03-01): b');
    const c = commit(repo, 'src/c.js', 'feat(03-01): c');
    summarize(repo, [a, b, c]);
    const at = (shaChunk) => {
      const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { shaChunk });
      return { files: scope.files, outside: scope.outsideUnion, shas: scope.commits.map((x) => x.sha) };
    };
    const expected = { files: ['src/a.js', 'src/b.js', 'src/c.js'], outside: ['other/noise.js'], shas: [a, b, c] };
    assert.deepEqual(at(2), expected, 'limit-1: the task commits span two chunks');
    assert.deepEqual(at(3), expected, 'limit: exactly one chunk');
    assert.deepEqual(at(4), expected, 'limit+1: one chunk with room to spare');
    assert.deepEqual(at(1), expected, 'a chunk of one is clamped to two — it would never shrink the tip reduction');
  });

  test('[boundary] the pathspec cap: 19 and 20 pass through; 21 is refused, not truncated', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const run = (count) => {
      const git = spyGit();
      const specs = Array.from({ length: count }, (_, i) => `src/p${i}/`);
      const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { pathspecs: specs, commitsOnly: true, execGit: git });
      const log = git.calls.find((args) => args[0] === 'log');
      return { scope, sent: log ? log.length - 1 - log.indexOf('--') : null };
    };
    assert.equal(run(19).sent, 19);
    assert.equal(run(20).sent, 20);
    const over = run(21);
    assert.equal(over.scope.status, 'unresolvable');
    assert.equal(over.scope.reason, 'too-many-pathspecs');
    assert.equal(over.sent, null, 'no git log was issued with a truncated pathspec list');
  });

  test('[boundary] maxCommits is clamped at the 1000 ceiling by one helper (git is asked for twice that many)', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const asked = (maxCommits) => {
      const git = spyGit();
      resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, { maxCommits, commitsOnly: true, execGit: git });
      const log = git.calls.find((args) => args[0] === 'log');
      return Number(log[log.indexOf('-n') + 1]);
    };
    assert.deepEqual([asked(999), asked(1000), asked(1001), asked(5000), asked(0)], [1998, 2000, 2000, 2000, 2]);
  });
});

describe('resolveEvaluationScope — a hung git is unresolvable on EVERY call path, never "unreachable"', () => {
  test('[negative] a timeout in the ancestor check', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, {
      execGit: spyGit((args) => (args[0] === 'merge-base' ? TIMED_OUT : undefined)),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-timeout');
    assert.deepEqual(scope.unreachable, []);
  });

  test('[negative] a timeout resolving a task commit id', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, {
      execGit: spyGit((args) => (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith(a)) ? TIMED_OUT : undefined)),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-timeout');
    assert.deepEqual(scope.unreachable, []);
  });

  test('[negative] a timeout finding the milestone tag', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(03-01): a');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, {
      milestoneBound: true,
      execGit: spyGit((args) => (args[0] === 'describe' ? TIMED_OUT : undefined)),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-timeout');
  });

  test('[control] a plain "not an ancestor" is still named unreachable, so the distinction can fail', () => {
    const repo = makeRepo();
    repo.git('checkout', '-b', 'side');
    const side = commit(repo, 'src/side.js', 'feat(03-01): side only');
    repo.git('checkout', 'main');
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a, side]);
    assert.deepEqual(resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }).unreachable, [side]);
  });

  test('[negative] an ambiguous short id is named unreachable, and does not poison the phase', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const ambiguous = 'abcdef0'; // git answers `rev-parse --verify` with exit 128 for an ambiguous or malformed short id
    const git = spyGit((args) => (args[0] === 'rev-parse' && args.some((arg) => arg.startsWith(ambiguous))
      ? { exitCode: 128, stdout: '', stderr: 'fatal: ambiguous argument', signal: null, error: null, timedOut: false }
      : undefined));
    write(repo.dir, `${PHASE_DIR}/03-02-SUMMARY.md`, `## Task Commits\n\n1. **Task 1: x** - \`${ambiguous}\`\n\n## Next\n`);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { execGit: git });
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(scope.unreachable, [ambiguous]);
    assert.deepEqual(scope.files, ['src/a.js']);
  });
});

describe('resolveEvaluationScope — what a scope says when it finds little', () => {
  test('[negative] no matching commits is a resolved "none" with a reason, not an unread scope', () => {
    const repo = makeRepo();
    commit(repo, 'src/a.js', 'feat(09-09): another plan');
    for (const options of [{}, { commitsOnly: true }]) {
      const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' }, options);
      assert.equal(scope.status, 'resolved');
      assert.equal(scope.reason, 'no-matching-commits');
      assert.deepEqual(scope.commits, []);
    }
    assert.equal(resolveEvaluationScope(repo.dir, { kind: 'quick', id: 'nope-123' }).reason, 'no-matching-commits');
  });

  test('[negative] commits whose every path is excluded are an empty scope that says so', () => {
    const repo = makeRepo();
    commit(repo, `${PHASE_DIR}/03-01-NOTES.md`, 'docs(03-01): notes only');
    const scope = resolveEvaluationScope(repo.dir, { kind: 'plan', planId: '03-01' });
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.reason, 'empty-after-exclusions');
    assert.equal(scope.commits.length, 1);
    assert.deepEqual(scope.files, []);
  });

  test('[negative] `since` removing every task commit is not "unreachable"', () => {
    const repo = makeRepo();
    const a = commit(repo, 'src/a.js', 'feat(03-01): a');
    summarize(repo, [a]);
    const scope = resolveEvaluationScope(repo.dir, { kind: 'phase', phase: '3' }, { since: a });
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'no-task-commits-since');
  });

  test('[boundary] a phase directory that arrived with the root commit still includes the root commit\'s files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-root-'));
    dirs.push(dir);
    const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@test.io');
    git('config', 'user.name', 'Test');
    write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
    write(dir, 'src/root.js', 'root\n');
    git('add', '.');
    git('commit', '-m', 'feat(03-01): everything in the root commit');
    const scope = resolveEvaluationScope(dir, { kind: 'phase', phase: '3' });
    assert.equal(scope.status, 'degraded');
    assert.deepEqual(scope.files, ['src/root.js']);
  });
});

// ─── The window unit (ADR-5208, extending ADR-5057 §4) ───────────────────────

/** 2026-09-27T00:00:00Z — the boundary every dated window test measures against. */
const BOUNDARY = Date.UTC(2026, 8, 27) / 1000;
const DAY = 86400;

/** A repository whose every commit carries an explicit committer (and author) date. */
function makeDatedRepo(scaffoldAt = BOUNDARY - 30 * DAY) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-scope-window-'));
  dirs.push(dir);
  const run = (args, at) => {
    const dated = at === undefined ? {} : { GIT_COMMITTER_DATE: `@${at} +0000`, GIT_AUTHOR_DATE: `@${at} +0000` };
    return gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY, ...dated } }).trim();
  };
  const git = (...args) => run(args);
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', '{}');
  write(dir, `${PHASE_DIR}/03-CONTEXT.md`, 'context\n');
  git('add', '.');
  run(['commit', '-m', 'docs(03): scaffold phase'], scaffoldAt);
  return { dir, git, run };
}

/** Commit one file at `at` (epoch seconds); returns the full sha. */
function commitAt(repo, rel, message, at, content = `${rel} ${at}\n`) {
  write(repo.dir, rel, content);
  repo.git('add', rel);
  repo.run(['commit', '-m', message], at);
  return repo.git('rev-parse', 'HEAD');
}

function windowScope(repo, since, options = {}, until) {
  const unit = until === undefined ? { kind: 'window', since } : { kind: 'window', since, until };
  return resolveEvaluationScope(repo.dir, unit, options);
}

function writeMarker(repo, tip) {
  write(repo.dir, '.planning/reviews/LAST-WINDOW.json', formatLastWindowMarker({
    tip, since: '7d', until: 'HEAD', reviewedAt: '2026-09-27T00:00:00.000Z', review: '.planning/reviews/2026-09-27-window/REVIEW.md',
  }));
}

describe('resolveEvaluationScope — window unit', () => {
  test('[boundary] a commit exactly on the date boundary is inside; one second earlier is outside', () => {
    for (const [offset, inside] of [[-1, false], [0, true], [1, true]]) {
      const repo = makeDatedRepo();
      const edge = commitAt(repo, 'src/edge.js', 'feat: edge', BOUNDARY + offset);
      const later = commitAt(repo, 'src/later.js', 'feat: later', BOUNDARY + 3600);
      for (const since of ['2026-09-27', '2026-09-27T00:00:00Z', '2026-09-27T03:00:00+03:00']) {
        const scope = windowScope(repo, since);
        assert.equal(scope.status, 'resolved', `${since} offset ${offset}`);
        assert.deepEqual(scope.commits.map((c) => c.sha), inside ? [later, edge] : [later], `${since} offset ${offset}`);
        assert.deepEqual(scope.files, inside ? ['src/edge.js', 'src/later.js'] : ['src/later.js']);
        assert.equal(scope.window.boundary, '2026-09-27T00:00:00.000Z');
        assert.equal(scope.window.sinceKind, 'date');
      }
    }
  });

  test('[boundary] a duration is measured back from the injected clock, with the same inclusive edge', () => {
    for (const [offset, inside] of [[-1, false], [0, true], [1, true]]) {
      const repo = makeDatedRepo();
      const edge = commitAt(repo, 'src/edge.js', 'feat: edge', BOUNDARY + offset);
      const clock = { now: () => (BOUNDARY + 7 * DAY) * 1000 };
      const scope = windowScope(repo, '7d', { clock });
      assert.equal(scope.window.sinceKind, 'duration');
      assert.equal(scope.window.boundary, '2026-09-27T00:00:00.000Z');
      assert.deepEqual(scope.commits.map((c) => c.sha), inside ? [edge] : [], `offset ${offset}`);
    }
  });

  test('[happy] the scope is the union of each window commit\'s own files; each commit names its phase or `unattributed`', () => {
    const repo = makeDatedRepo();
    const a = commitAt(repo, 'src/a.js', 'feat(03-01): a', BOUNDARY + 10);
    const loose = commitAt(repo, 'src/loose.js', 'fix: unrelated', BOUNDARY + 20);
    // A short (7-char) id on the task row still attributes the full sha.
    const summary = commitAt(repo, `${PHASE_DIR}/03-01-SUMMARY.md`, 'docs(03-01): summary', BOUNDARY + 30,
      `# Summary\n\n## Task Commits\n\n1. **Task 1: a** - \`${a.slice(0, 7)}\`\n`);
    const scope = windowScope(repo, '2026-09-27');
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.source, 'window-commits');
    assert.deepEqual(scope.files, ['src/a.js', 'src/loose.js']);
    assert.deepEqual(scope.commits.map((c) => [c.sha, c.phase]), [[summary, UNATTRIBUTED], [loose, UNATTRIBUTED], [a, '03']]);
    assert.deepEqual(scope.window.phases, { '03': { dir: PHASE_DIR, commits: [a] } });
    assert.deepEqual(scope.window.unattributed, [summary, loose]);
    assert.deepEqual(scope.window.unreadablePhaseDirs, []);
    assert.deepEqual(scope.commits.find((c) => c.sha === summary).files, [], 'planning paths stay excluded');
  });

  test('[happy] a commit named by an archived milestone phase is attributed `<milestone>/<phase>`', () => {
    const repo = makeDatedRepo();
    const old = commitAt(repo, 'src/old.js', 'feat(01-01): old', BOUNDARY + 10);
    commitAt(repo, '.planning/milestones/v1.0-phases/01-old/01-01-SUMMARY.md', 'docs: archive', BOUNDARY + 20,
      `## Task Commits\n\n1. **Task 1: old** - \`${old}\`\n`);
    const scope = windowScope(repo, '2026-09-27');
    assert.deepEqual(scope.window.phases, { 'v1.0/01': { dir: '.planning/milestones/v1.0-phases/01-old', commits: [old] } });
  });

  test('[boundary] merges: merged-in commits count when they LAND in the window; the merge adds only its own edits', () => {
    const repo = makeDatedRepo();
    repo.git('checkout', '-b', 'side');
    // Authored and committed BEFORE the boundary, but it lands on main through a merge inside it.
    const sideOld = commitAt(repo, 'src/side.js', 'feat: side work', BOUNDARY - 5 * DAY);
    repo.git('checkout', 'main');
    const mainNew = commitAt(repo, 'src/main.js', 'feat: main work', BOUNDARY + 10);
    repo.git('merge', '--no-ff', '--no-commit', 'side');
    write(repo.dir, 'src/evil.js', 'an edit only the merge commit carries\n');
    repo.git('add', 'src/evil.js');
    repo.run(['commit', '-m', 'merge side'], BOUNDARY + 20);
    const merge = repo.git('rev-parse', 'HEAD');
    const scope = windowScope(repo, '2026-09-27');
    assert.equal(scope.status, 'resolved');
    assert.deepEqual(new Set(scope.commits.map((c) => c.sha)), new Set([merge, mainNew, sideOld]));
    assert.deepEqual(scope.commits.find((c) => c.sha === merge).files, ['src/evil.js']);
    assert.deepEqual(scope.files, ['src/evil.js', 'src/main.js', 'src/side.js']);
    assert.deepEqual(scope.outsideUnion, []);
    assert.equal(scope.window.base, repo.git('rev-parse', 'HEAD~1~1'), 'base is the newest first-parent commit before the boundary');
  });

  test('[hostile] a commit inside the window that lives only on another branch is not in scope', () => {
    const repo = makeDatedRepo();
    const onMain = commitAt(repo, 'src/main.js', 'feat: main', BOUNDARY + 10);
    repo.git('checkout', '-b', 'side');
    commitAt(repo, 'src/side-only.js', 'feat: side only', BOUNDARY + 20);
    repo.git('checkout', 'main');
    const scope = windowScope(repo, '2026-09-27');
    assert.deepEqual(scope.commits.map((c) => c.sha), [onMain]);
    assert.deepEqual(scope.files, ['src/main.js']);
    // ...and `until` selects the tip: the same window evaluated on `side` holds both.
    assert.equal(windowScope(repo, '2026-09-27', {}, 'side').commits.length, 2);
  });

  test('[happy] a ref form is the commit set `<ref>..until`, not a diff', () => {
    const repo = makeDatedRepo();
    const from = commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY + 10);
    const b = commitAt(repo, 'src/b.js', 'feat: b', BOUNDARY + 20);
    const c = commitAt(repo, 'src/c.js', 'feat: c', BOUNDARY + 30);
    const scope = windowScope(repo, from);
    assert.equal(scope.window.sinceKind, 'ref');
    assert.equal(scope.window.base, from);
    assert.equal(scope.rangeBase, from);
    assert.deepEqual(scope.commits.map((x) => x.sha), [c, b]);
    assert.deepEqual(scope.files, ['src/b.js', 'src/c.js']);
  });

  test('[negative] an empty window degrades and says why — never a clean, empty `resolved`', () => {
    const repo = makeDatedRepo();
    commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY - DAY);
    const scope = windowScope(repo, '2026-09-27');
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'empty-window');
    assert.deepEqual(scope.files, []);
    assert.deepEqual(scope.commits, []);
    const atTip = windowScope(repo, 'HEAD');
    assert.equal(atTip.status, 'degraded');
    assert.equal(atTip.reason, 'empty-window');
  });

  test('[negative] a window of planning-only commits is an empty scope that says so', () => {
    const repo = makeDatedRepo();
    commitAt(repo, `${PHASE_DIR}/03-01-PLAN.md`, 'docs(03-01): plan', BOUNDARY + 10);
    const scope = windowScope(repo, '2026-09-27');
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'empty-after-exclusions');
    assert.equal(scope.commits.length, 1);
    assert.deepEqual(scope.files, []);
  });

  test('[boundary] a window that reaches past the root commit has no base: the root commit is inside', () => {
    const repo = makeDatedRepo(BOUNDARY + 1);
    const root = repo.git('rev-parse', 'HEAD');
    const a = commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY + 2);
    const scope = windowScope(repo, '2026-09-27');
    assert.equal(scope.window.base, null);
    assert.equal(scope.rangeBase, null);
    assert.deepEqual(scope.commits.map((c) => c.sha), [a, root]);
    assert.deepEqual(scope.files, ['src/a.js']);
    assert.deepEqual(scope.outsideUnion, []);
    assert.equal(windowScope(repo, '9999w', { clock: { now: () => BOUNDARY * 1000 } }).window.base, null, 'a boundary before the epoch');
  });

  test('[negative] `last` with no recorded window is unresolvable with a reason that says so', () => {
    const repo = makeDatedRepo();
    commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY + 10);
    const scope = windowScope(repo, 'last');
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'no-last-window-marker');
    assert.deepEqual(scope.files, []);
  });

  test('[happy] `last` starts at the recorded tip: only what landed since the previous window review', () => {
    const repo = makeDatedRepo();
    const reviewed = commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY + 10);
    const next = commitAt(repo, 'src/b.js', 'feat: b', BOUNDARY + 20);
    writeMarker(repo, reviewed);
    const scope = windowScope(repo, 'last');
    assert.equal(scope.status, 'resolved');
    assert.equal(scope.window.sinceKind, 'last');
    assert.equal(scope.window.base, reviewed);
    assert.deepEqual(scope.commits.map((c) => c.sha), [next]);
  });

  test('[negative] `last` whose tip was rewritten away degrades and names the tip', () => {
    const repo = makeDatedRepo();
    const base = repo.git('rev-parse', 'HEAD');
    const reviewed = commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY + 10);
    repo.git('reset', '--hard', base);
    commitAt(repo, 'src/b.js', 'feat: b rewritten', BOUNDARY + 20);
    writeMarker(repo, reviewed);
    const scope = windowScope(repo, 'last');
    assert.equal(scope.status, 'degraded');
    assert.equal(scope.reason, 'last-window-tip-not-ancestor');
    assert.deepEqual(scope.unreachable, [reviewed]);
    assert.deepEqual(scope.files, ['src/b.js']);
  });

  test('[negative] a malformed marker and a marker naming no object are unresolvable, each with its own reason', () => {
    const repo = makeDatedRepo();
    write(repo.dir, '.planning/reviews/LAST-WINDOW.json', '{"version":1,"tip":"HEAD"}');
    assert.equal(windowScope(repo, 'last').reason, 'last-window-marker-invalid');
    writeMarker(repo, 'f'.repeat(40));
    assert.equal(windowScope(repo, 'last').reason, 'last-window-tip-missing');
  });

  test('[negative] an unknown ref, a malformed since and a second lower bound are unresolvable', () => {
    const repo = makeDatedRepo();
    assert.equal(windowScope(repo, 'no-such-branch').reason, 'window-since-not-found');
    assert.equal(windowScope(repo, '2026-02-30').reason, 'invalid-window-since');
    assert.equal(windowScope(repo, '7d', { since: 'HEAD' }).reason, 'window-with-since-option');
    assert.equal(windowScope(repo, '7d', { ref: 'HEAD' }, 'HEAD').reason, 'window-until-with-ref-option');
  });

  test('[negative] git missing is unresolvable for a window too', () => {
    const scope = resolveEvaluationScope('/nowhere', { kind: 'window', since: '7d' }, {
      execGit: () => ({ exitCode: 127, stdout: '', stderr: '', timedOut: false }),
    });
    assert.equal(scope.status, 'unresolvable');
    assert.equal(scope.reason, 'git-unavailable');
  });

  test('[boundary] the sha chunk size never changes a window\'s answer', () => {
    const repo = makeDatedRepo();
    for (let i = 0; i < 4; i += 1) commitAt(repo, `src/f${i}.js`, `feat: f${i}`, BOUNDARY + i);
    const expected = windowScope(repo, '2026-09-27');
    for (const shaChunk of [2, 3, 4, 5]) {
      const scope = windowScope(repo, '2026-09-27', { shaChunk });
      assert.deepEqual(scope.files, expected.files, `chunk ${shaChunk}`);
      assert.deepEqual(scope.commits, expected.commits, `chunk ${shaChunk}`);
    }
  });
});

describe('parseWindowSince and the LAST-WINDOW marker', () => {
  test('[happy] each form is recognised, in precedence order', () => {
    assert.deepEqual(parseWindowSince('last'), { kind: 'last', value: 'last' });
    assert.deepEqual(parseWindowSince('7d'), { kind: 'duration', value: '7d', seconds: 7 * DAY });
    assert.deepEqual(parseWindowSince('12h'), { kind: 'duration', value: '12h', seconds: 12 * 3600 });
    assert.deepEqual(parseWindowSince('2w'), { kind: 'duration', value: '2w', seconds: 14 * DAY });
    assert.deepEqual(parseWindowSince('2026-09-27'), { kind: 'date', value: '2026-09-27', epochSeconds: BOUNDARY });
    assert.equal(parseWindowSince('2026-09-27T03:00+03:00').epochSeconds, BOUNDARY);
    assert.deepEqual(parseWindowSince('refs/heads/7d'), { kind: 'ref', value: 'refs/heads/7d' });
    assert.deepEqual(parseWindowSince('HEAD~3'), { kind: 'ref', value: 'HEAD~3' });
  });

  test('[hostile] malformed dates, out-of-range durations and option-shaped values are refused, never read as refs', () => {
    for (const raw of ['', '0d', '10000d', '07d', '2026-02-30', '2026-13-01', '2026-9-1', '2026-09-27T10:00', '2026-09-27T24:00Z', '-7d', '--all', 'a b']) {
      assert.equal(parseWindowSince(raw), null, JSON.stringify(raw));
    }
  });

  test('[happy] a formatted marker parses back; a wrong version or a short tip does not', () => {
    const tip = 'a'.repeat(40);
    const marker = { tip, since: 'last', until: 'main', reviewedAt: '2026-09-27T00:00:00.000Z', review: null };
    assert.deepEqual(parseLastWindowMarker(formatLastWindowMarker(marker)), { version: 1, ...marker });
    assert.equal(parseLastWindowMarker(JSON.stringify({ ...marker, version: 2 })), null);
    assert.equal(parseLastWindowMarker(JSON.stringify({ ...marker, version: 1, tip: 'abc1234' })), null);
    assert.equal(parseLastWindowMarker('not json'), null);
  });

  test('[happy] the marker lives under the planning dir', () => {
    assert.equal(lastWindowMarkerPath('/repo'), path.join('/repo', '.planning', 'reviews', 'LAST-WINDOW.json'));
  });
});

describe('evaluateEvaluationScope — the --window verb', () => {
  const messageOf = (args) => evaluateEvaluationScope({ projectDir: '/x', args }).failure.message;

  test('[negative] --window argv conflicts are usage failures naming the problem', () => {
    assert.match(messageOf(['--window', '7d', '--phase', '3']), /exactly one of/);
    assert.match(messageOf(['--phase', '3', '--until', 'main']), /--until <ref> requires --window/);
    assert.match(messageOf(['--window', '7d', '--since', 'HEAD']), /carries its own lower bound/);
    assert.match(messageOf(['--window', '7d', '--ref', 'HEAD']), /use --until/);
    assert.match(messageOf(['--window', '0d']), /--window must be last, a duration/);
  });

  test('[happy] a window verdict carries the window last in the payload; an empty window is advisory', () => {
    const repo = makeDatedRepo();
    commitAt(repo, 'src/a.js', 'feat: a', BOUNDARY + 10);
    const verdict = evaluateEvaluationScope({ projectDir: repo.dir, args: ['--window', '2026-09-27', '--until', 'main'] });
    assert.equal(verdict.outcome, 'pass');
    assert.deepEqual(Object.keys(verdict.payload), [
      'unit', 'status', 'source', 'reason', 'commits', 'changedFiles', 'files',
      'missingOnDisk', 'outsideUnion', 'unreachable', 'rangeBase', 'window',
    ]);
    assert.deepEqual(verdict.payload.unit, { kind: 'window', since: '2026-09-27', until: 'main' });
    assert.equal(evaluateEvaluationScope({ projectDir: repo.dir, args: ['--window', 'HEAD'] }).outcome, 'advisory');
    assert.equal(evaluateEvaluationScope({ projectDir: repo.dir, args: ['--window', 'last'] }).outcome, 'skip');
  });
});
