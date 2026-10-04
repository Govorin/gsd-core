'use strict';

/**
 * Unit tests for git-history.cjs (built from src/git-history.cts) — churn and co-change behind
 * `arch metrics` and the window review pre-pass (pocock-practices design, D1 acceptance).
 *
 * The properties pinned here:
 *   - churn counts commits and lines per file, follows renames to the current name, and leaves
 *     planning artefacts and lockfiles out;
 *   - co-change thresholds are inclusive and exact: `minSupport` at -1 / = / +1, `minConfidence`
 *     exactly on the threshold; `maxFilesPerCommit` and `maxCommits` at -1 / = / +1;
 *   - an empty window is `degraded` with a reason, never an empty success; a git failure is
 *     `unresolvable` with a reason; the git-call budget does not grow with the window.
 *
 * Fixtures are real commits in a temp git repository; assertions read the typed results.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const gh = require('../gsd-core/bin/lib/git-history.cjs');
const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};

let dir;
let serial = 0;

function git(args, extraEnv = {}) {
  return gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY, ...extraEnv } }).trim();
}

/**
 * One commit changing every file in `files` (each gets a new line, so every change is real).
 * `date` pins both author and committer dates. Returns the sha.
 */
function commit(files, date) {
  for (const rel of files) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, `change ${++serial}\n`);
  }
  git(['add', '-A']);
  git(['commit', '-q', '-m', `change ${serial}`], date === undefined ? {} : { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(['rev-parse', 'HEAD']);
}

beforeEach(() => {
  dir = createTempDir('gsd-githistory-');
  git(['init', '-q', '--initial-branch=main']);
  git(['config', 'commit.gpgsign', 'false']);
});
afterEach(() => {
  cleanup(dir);
});

describe('git-history: churn', () => {
  test('commits and lines per file, most-changed first; planning artefacts and lockfiles are out', () => {
    commit(['src/a.ts', 'src/b.ts', '.planning/STATE.md', 'package-lock.json']);
    commit(['src/a.ts']);
    commit(['src/a.ts', 'src/c.ts']);
    const c = gh.churn(dir);
    assert.equal(c.status, 'resolved');
    assert.equal(c.reason, null);
    assert.equal(c.commits, 3);
    assert.deepEqual(c.files, [
      { file: 'src/a.ts', commits: 3, added: 3, removed: 0 },
      { file: 'src/b.ts', commits: 1, added: 1, removed: 0 },
      { file: 'src/c.ts', commits: 1, added: 1, removed: 0 },
    ]);
  });

  test('changes made under an old name count for the current name', () => {
    commit(['src/old.ts']);
    commit(['src/old.ts']);
    git(['mv', 'src/old.ts', 'src/new.ts']);
    git(['commit', '-q', '-m', 'rename']);
    commit(['src/new.ts']);
    const c = gh.churn(dir);
    assert.deepEqual(c.files.map((f) => [f.file, f.commits]), [['src/new.ts', 4]]);
  });

  test('a binary change counts as a commit, not as lines', () => {
    fs.writeFileSync(path.join(dir, 'img.bin'), Buffer.from([0, 1, 2, 0, 255]));
    commit(['src/a.ts']);
    const c = gh.churn(dir);
    assert.deepEqual(c.files.find((f) => f.file === 'img.bin'), { file: 'img.bin', commits: 1, added: 0, removed: 0 });
    const h = gh.readHistory(dir);
    assert.deepEqual(h.commits[0].changes.find((ch) => ch.file === 'img.bin'), { file: 'img.bin', added: null, removed: null });
  });

  test('`paths` limits the counted files; a path outside the root is unresolvable, not widened', () => {
    commit(['libs/a/x.ts', 'libs/b/y.ts']);
    assert.deepEqual(gh.churn(dir, { paths: ['libs/a'] }).files.map((f) => f.file), ['libs/a/x.ts']);
    const out = gh.churn(dir, { paths: ['../elsewhere'] });
    assert.equal(out.status, 'unresolvable');
    assert.equal(out.reason, 'path-outside-root:../elsewhere');
    assert.equal(out.gitCalls, 0);
  });
});

describe('git-history: windows', () => {
  test('an empty window is degraded with a reason, not an empty success', () => {
    commit(['src/a.ts'], '2020-01-01T00:00:00Z');
    const c = gh.churn(dir, { since: '30 days ago' });
    assert.equal(c.status, 'degraded');
    assert.equal(c.reason, 'empty-window');
    assert.deepEqual(c.files, []);
    const cc = gh.coChange(dir, { base: 'HEAD' });
    assert.equal(cc.status, 'degraded');
    assert.equal(cc.reason, 'empty-window');
  });

  test('`since` bounds by committer date; `base` excludes what it reaches', () => {
    commit(['src/old.ts'], '2020-01-01T00:00:00Z');
    const mid = commit(['src/mid.ts']);
    commit(['src/new.ts']);
    assert.deepEqual(gh.churn(dir, { since: '30 days ago' }).files.map((f) => f.file), ['src/mid.ts', 'src/new.ts']);
    assert.deepEqual(gh.churn(dir, { base: mid }).files.map((f) => f.file), ['src/new.ts']);
  });

  test('maxCommits at window-1 / window / window+1: only the cap below the window degrades', () => {
    for (let i = 0; i < 3; i++) commit([`src/f${i}.ts`]);
    const at = (n) => gh.readHistory(dir, {}, { maxCommits: n });
    assert.deepEqual([at(4).status, at(4).commits.length], ['resolved', 3]);
    assert.deepEqual([at(3).status, at(3).commits.length], ['resolved', 3]);
    const capped = at(2);
    assert.deepEqual([capped.status, capped.reason, capped.commits.length], ['degraded', 'commit-cap:2', 2]);
    assert.deepEqual(gh.churnOf(capped).files.map((f) => f.file), ['src/f1.ts', 'src/f2.ts'], 'the newest commits are kept');
  });

  test('parseWindow: relative spans and ISO dates are date bounds, a ref is a base, anything else is refused', () => {
    assert.deepEqual(gh.parseWindow('90d'), { since: '90 days ago' });
    assert.deepEqual(gh.parseWindow('12w'), { since: '12 weeks ago' });
    assert.deepEqual(gh.parseWindow('6m'), { since: '6 months ago' });
    assert.deepEqual(gh.parseWindow('1y'), { since: '1 years ago' });
    assert.deepEqual(gh.parseWindow('2026-09-27'), { since: '2026-09-27' });
    assert.deepEqual(gh.parseWindow('v1.2.0'), { base: 'v1.2.0' });
    assert.equal(gh.parseWindow('--all'), null);
    assert.equal(gh.parseWindow('a b'), null);
  });
});

describe('git-history: co-change thresholds', () => {
  test('minSupport is inclusive: support-1 and support report the pair, support+1 does not', () => {
    for (let i = 0; i < 3; i++) commit(['src/a.ts', 'src/b.ts']);
    const h = gh.readHistory(dir);
    const pairsAt = (minSupport) => gh.coChangeOf(h, { minSupport, minConfidence: 0 }).pairs.map((p) => `${p.a}+${p.b}:${p.support}`);
    assert.deepEqual(pairsAt(2), ['src/a.ts+src/b.ts:3']);
    assert.deepEqual(pairsAt(3), ['src/a.ts+src/b.ts:3']);
    assert.deepEqual(pairsAt(4), []);
  });

  test('minConfidence is inclusive: a pair exactly on the threshold is reported, just above it is not', () => {
    // a and b each change in 5 commits, together in 3: confidence 3/5 = 0.6 both ways.
    for (let i = 0; i < 3; i++) commit(['src/a.ts', 'src/b.ts']);
    for (let i = 0; i < 2; i++) commit(['src/a.ts']);
    for (let i = 0; i < 2; i++) commit(['src/b.ts']);
    const h = gh.readHistory(dir);
    const at = (minConfidence) => gh.coChangeOf(h, { minSupport: 3, minConfidence }).pairs;
    assert.deepEqual(at(0.6), [{ a: 'src/a.ts', b: 'src/b.ts', support: 3, aToB: 0.6, bToA: 0.6, confidence: 0.6 }]);
    assert.equal(at(0.59).length, 1);
    assert.deepEqual(at(0.61), []);
  });

  test('confidence is the larger direction: a satellite always changing with its hub is coupled', () => {
    for (let i = 0; i < 3; i++) commit(['src/hub.ts', 'src/satellite.ts']);
    for (let i = 0; i < 7; i++) commit(['src/hub.ts']);
    const [pair] = gh.coChange(dir, {}, { minSupport: 3, minConfidence: 0.9 }).pairs;
    assert.deepEqual(pair, { a: 'src/hub.ts', b: 'src/satellite.ts', support: 3, aToB: 0.3, bToA: 1, confidence: 1 });
  });

  test('maxFilesPerCommit at N-1 / N / N+1: only the commit over the limit is left out, by sha', () => {
    commit(['p/1.ts', 'p/2.ts', 'p/3.ts']);
    commit(['q/1.ts', 'q/2.ts', 'q/3.ts', 'q/4.ts']);
    const large = commit(['r/1.ts', 'r/2.ts', 'r/3.ts', 'r/4.ts', 'r/5.ts']);
    const cc = gh.coChangeOf(gh.readHistory(dir), { minSupport: 1, minConfidence: 0, maxFilesPerCommit: 4 });
    assert.deepEqual(cc.largeCommits, [large]);
    const groups = new Set(cc.pairs.map((p) => p.a.split('/')[0]));
    assert.deepEqual([...groups].sort(), ['p', 'q']);
    assert.equal(cc.pairs.length, 3 + 6);
  });

  test('out-of-range options are refused, not clamped', () => {
    const h = { status: 'resolved', reason: null, range: {}, commits: [], gitCalls: 0 };
    assert.throws(() => gh.coChangeOf(h, { minSupport: 0 }), RangeError);
    assert.throws(() => gh.coChangeOf(h, { minConfidence: 1.01 }), RangeError);
    assert.throws(() => gh.coChangeOf(h, { maxFilesPerCommit: 1 }), RangeError);
    assert.throws(() => gh.readHistory(dir, {}, { maxCommits: 0 }), RangeError);
  });
});

describe('git-history: git budget and failures', () => {
  test('the window is read in a fixed number of git calls, whatever its size', () => {
    const calls = [];
    const counting = (args, opts) => {
      calls.push(args.find((a) => !a.startsWith('-') && !a.includes('=')));
      return execGit(args, opts);
    };
    const first = commit(['src/a.ts']);
    const small = gh.readHistory(dir, {}, { execGit: counting });
    for (let i = 0; i < 12; i++) commit([`src/f${i}.ts`, 'src/a.ts']);
    const large = gh.readHistory(dir, {}, { execGit: counting });
    const based = gh.readHistory(dir, { base: first }, { execGit: counting });
    assert.deepEqual([small.gitCalls, large.gitCalls, based.gitCalls], [2, 2, 3]);
    assert.equal(calls.length, 7);
    assert.deepEqual([small.commits.length, large.commits.length, based.commits.length], [1, 13, 12]);
  });

  test('git failures are unresolvable with a reason', () => {
    commit(['src/a.ts']);
    const fake = (result) => () => ({ exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false, ...result });
    assert.equal(gh.readHistory(dir, {}, { execGit: fake({ exitCode: 127 }) }).reason, 'git-unavailable');
    assert.equal(gh.readHistory(dir, {}, { execGit: fake({ exitCode: 1, timedOut: true }) }).reason, 'git-timeout');
    const overflow = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
    assert.equal(gh.readHistory(dir, {}, { execGit: fake({ exitCode: 1, error: overflow }) }).reason, 'git-output-overflow');
    const unknown = gh.readHistory(dir, { tip: 'no-such-branch' });
    assert.deepEqual([unknown.status, unknown.reason, unknown.commits], ['unresolvable', 'unknown-tip:no-such-branch', []]);
    const unsafe = gh.readHistory(dir, { tip: '--all' });
    assert.deepEqual([unsafe.reason, unsafe.gitCalls], ['unsafe-tip', 0]);
    assert.equal(gh.readHistory(dir, { since: '1 day ago; rm' }).reason, 'unsafe-since');
  });

  test('outside a git repository: unresolvable, not an empty window', () => {
    const plain = createTempDir('gsd-githistory-plain-');
    const h = gh.readHistory(plain);
    cleanup(plain);
    assert.deepEqual([h.status, h.reason], ['unresolvable', 'git-failed:rev-parse']);
  });
});
