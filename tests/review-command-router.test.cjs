'use strict';

/**
 * `gsd-tools review window-*` (ADR-5208) end to end on a real git fixture: the pre-pass writes
 * prepass.json and names every lens report; compose stitches REVIEW.md; deferred lists what a
 * fix left behind, once; the `--since last` marker is refused until REVIEW.md exists and then
 * makes the next window start at the recorded tip; every path argument stays inside
 * `<planning>/reviews`. Failures are asserted on the `--json-errors` reason, not on prose.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { parseLastWindowMarker } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const DIR = '.planning/reviews/2026-10-05-window';

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeRepo(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-review-router-'));
  dirs.push(dir);
  const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', `${JSON.stringify(config)}\n`);
  write(dir, 'src/a.js', 'export function a() { return 1; }\n');
  git('add', '-A');
  git('commit', '-m', 'chore: base');
  const base = git('rev-parse', 'HEAD');
  for (const n of [1, 2, 3]) {
    write(dir, `src/f${n}.js`, `import { a } from './a.js';\nexport const f${n} = a();\n`);
    git('add', '-A');
    git('commit', '-m', `feat: f${n}`);
  }
  return { dir, git, base, tip: git('rev-parse', 'HEAD') };
}

const run = (repo, args) => runGsdTools(['review', ...args, '--json-errors'], repo.dir);
const json = (r) => JSON.parse(r.output);
/** The `--json-errors` payload: the last stderr line (a config warning may precede it). */
const failure = (r) => JSON.parse(r.error.trim().split('\n').pop());
const reason = (r) => failure(r).reason;

describe('review window-prepass', () => {
  test('[happy] writes prepass.json and returns the lens report paths; lenses default to code_review.window_lenses', () => {
    const repo = makeRepo({ code_review: { window_lenses: 'spec,correctness,bogus' } });
    const r = run(repo, ['window-prepass', '--since', repo.base, '--date', '2026-10-05']);
    assert.equal(r.success, true, r.error);
    const out = json(r);
    assert.equal(out.prepass, `${DIR}/prepass.json`);
    assert.equal(out.reviewedAlready, false);
    assert.deepEqual(out.lenses, ['correctness', 'spec']);
    assert.deepEqual(out.warnings, ['code_review.window_lenses: ignored unknown lens bogus']);
    assert.deepEqual(out.reports.map((x) => x.path), [`${DIR}/REVIEW-correctness.md`, `${DIR}/REVIEW-spec.md`]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(repo.dir, out.prepass), 'utf-8')).files, ['src/f1.js', 'src/f2.js', 'src/f3.js']);
  });

  test('[boundary] --batch-size N-1 splits the correctness lens into one report per batch; N keeps one', () => {
    const repo = makeRepo();
    const split = json(run(repo, ['window-prepass', '--since', repo.base, '--date', '2026-10-05', '--lens', 'correctness', '--batch-size', '2']));
    assert.deepEqual(split.reports.map((x) => [x.label, x.files.length]), [['correctness-1', 2], ['correctness-2', 1]]);
    const one = json(run(repo, ['window-prepass', '--since', repo.base, '--date', '2026-10-05', '--lens', 'correctness', '--batch-size', '3']));
    assert.deepEqual(one.reports.map((x) => x.label), ['correctness']);
  });

  test('[unhappy] usage errors carry the usage reason; an unresolvable window carries its own', () => {
    const repo = makeRepo();
    assert.equal(reason(run(repo, ['window-prepass'])), 'usage');
    assert.equal(reason(run(repo, ['window-prepass', '--since', '2026-13-01'])), 'usage');
    assert.equal(reason(run(repo, ['window-prepass', '--since', repo.base, '--lens', 'perf'])), 'usage');
    assert.equal(reason(run(repo, ['window-prepass', '--since', repo.base, '--batch-size', '0'])), 'usage');
    const last = run(repo, ['window-prepass', '--since', 'last']);
    assert.equal(last.success, false);
    assert.equal(reason(last), 'window_review_unresolvable');
    assert.match(failure(last).message, /no-last-window-marker/);
  });
});

describe('review window-compose / window-deferred / window-mark', () => {
  function prepared() {
    const repo = makeRepo();
    const r = run(repo, ['window-prepass', '--since', repo.base, '--date', '2026-10-05', '--lens', 'correctness,standards']);
    assert.equal(r.success, true, r.error);
    write(repo.dir, `${DIR}/REVIEW-correctness.md`, '### CR-01: Null deref\n\n**File:** `src/f1.js:2`\n\n### WR-01: Unused import\n\n**File:** `src/f2.js:1`\n');
    write(repo.dir, `${DIR}/REVIEW-standards.md`, '### WR-01: Magic number\n\n**File:** `src/f3.js:2`\n');
    write(repo.dir, `${DIR}/REFUTATION.md`, '### correctness WR-01: Unused import\nverdict: REFUTED\nevidence: src/f2.js:2 calls a().\n');
    return repo;
  }

  test('[happy] compose → deferred → mark, and the next `--since last` window starts at the recorded tip', () => {
    const repo = prepared();
    assert.equal(reason(run(repo, ['window-mark', '--dir', DIR])), 'window_review_unresolvable', 'no marker before REVIEW.md exists');

    const composed = run(repo, ['window-compose', '--dir', DIR]);
    assert.equal(composed.success, true, composed.error);
    // The refuter covered only the finding it refuted, so both survivors are unverified.
    assert.deepEqual(json(composed).counts, { critical: 1, warning: 1, info: 0, total: 2, refuted: 1, unverified: 2 });

    const deferred = run(repo, ['window-deferred', '--dir', DIR]);
    assert.deepEqual(json(deferred).entries.map((e) => [e.phase, e.file, e.line]), [['2026-10-05-window', 'src/f1.js', 2], ['2026-10-05-window', 'src/f3.js', 2]]);
    const tsv = runGsdTools(['review', 'window-deferred', '--dir', DIR, '--raw'], repo.dir);
    assert.deepEqual(tsv.output.split('\n').map((l) => l.split('\t').slice(0, 4)), [
      ['append', '2026-10-05-window', 'src/f1.js', '2'], ['append', '2026-10-05-window', 'src/f3.js', '2'],
    ]);

    // An entry already in WINDOWS.md (by fingerprint) is not offered again.
    const first = json(deferred).entries[0];
    const appended = runGsdTools(['windows', 'append', '--kind', 'deviation', '--phase', first.phase, '--file', first.file, '--line', String(first.line), '--description', first.description], repo.dir);
    assert.equal(appended.success, true, appended.error);
    const again = json(run(repo, ['window-deferred', '--dir', DIR]));
    assert.deepEqual(again.entries.map((e) => e.file), ['src/f3.js']);
    assert.equal(again.alreadyRecorded, 1);
    // A fix pass that fixed the recorded finding closes its entry: `fixed\t<id>`.
    write(repo.dir, `${DIR}/REVIEW-FIX.md`, '---\nstatus: all_fixed\n---\n## Fixed Issues\n\n### CR-01: Null deref\n');
    const closing = runGsdTools(['review', 'window-deferred', '--dir', DIR, '--raw'], repo.dir);
    assert.deepEqual(closing.output.split('\n').map((l) => l.split('\t')[0]), ['append', 'fixed']);
    assert.equal(closing.output.split('\n')[1], `fixed\t${JSON.parse(appended.output).entry.id}`);

    // The same window again (any spelling of its base) is recognised as already reviewed: `--fix` recovery.
    const before = json(run(repo, ['window-prepass', '--since', repo.base, '--date', '2026-10-05', '--lens', 'correctness,standards']));
    assert.equal(before.reviewedAlready, true);
    const narrower = json(run(repo, ['window-prepass', '--since', 'HEAD~1', '--date', '2026-10-05', '--lens', 'correctness,standards']));
    assert.equal(narrower.reviewedAlready, false);

    const marked = run(repo, ['window-mark', '--dir', DIR]);
    assert.equal(marked.success, true, marked.error);
    const marker = parseLastWindowMarker(fs.readFileSync(path.join(repo.dir, '.planning/reviews/LAST-WINDOW.json'), 'utf-8'));
    assert.equal(marker.tip, repo.tip);
    assert.equal(marker.review, `${DIR}/REVIEW.md`);

    const empty = run(repo, ['window-prepass', '--since', 'last', '--date', '2026-10-06']);
    assert.equal(json(empty).status, 'degraded');
    assert.equal(json(empty).reason, 'empty-window');
  });

  test('[hostile] --dir and --review outside <planning>/reviews are refused as usage', () => {
    const repo = prepared();
    for (const args of [
      ['window-compose', '--dir', 'src'],
      ['window-mark', '--dir', '../elsewhere'],
      ['window-deferred', '--dir', '.planning/reviews'],
      ['window-paths', '--review', 'src/REVIEW.md'],
      ['window-paths', '--review', '.planning/reviews/REVIEW.md'],
      ['window-paths', '--review', `${DIR}/REVIEW-standards.md`],
    ]) {
      assert.equal(reason(run(repo, args)), 'usage', args.join(' '));
    }
  });

  test('[happy] window-paths names the fix report beside a window REVIEW.md, and refuses a missing one', () => {
    const repo = prepared();
    assert.equal(reason(run(repo, ['window-paths', '--review', `${DIR}/REVIEW.md`])), 'window_review_unresolvable');
    run(repo, ['window-compose', '--dir', DIR]);
    assert.deepEqual(json(run(repo, ['window-paths', '--review', `${DIR}/REVIEW.md`])), {
      review: `${DIR}/REVIEW.md`, fixReport: `${DIR}/REVIEW-FIX.md`, dir: DIR, label: '2026-10-05-window',
    });
  });
});

describe('review stage (milestone:pre)', () => {
  const STAGE = ['stage', '--date', '2026-10-05'];

  test('[happy] no marker: the window starts at the previous v* tag; the pre-pass is written and the review follows', () => {
    const repo = makeRepo();
    repo.git('tag', 'v1.0', repo.base);
    const r = run(repo, [...STAGE, '--milestone', 'v1.1']);
    assert.equal(r.success, true, r.error);
    const out = json(r);
    assert.deepEqual([out.since, out.files, out.decision], ['v1.0', 3, 'auto']);
    assert.deepEqual(out.next, { skill: 'code-review', args: '--since v1.0' });
    assert.equal(out.prepass, `${DIR}/prepass.json`);
    assert.ok(fs.existsSync(path.join(repo.dir, out.prepass)));
  });

  test('[happy] a recorded window wins over the tag: since is last', () => {
    const repo = makeRepo();
    repo.git('tag', 'v1.0', repo.tip);
    const marker = { tip: repo.base, since: repo.base, until: 'HEAD', reviewedAt: '2026-10-01T00:00:00.000Z', review: '.planning/reviews/2026-10-01-window/REVIEW.md' };
    write(repo.dir, '.planning/reviews/LAST-WINDOW.json', `${JSON.stringify({ version: 1, ...marker }, null, 2)}\n`);
    const out = json(run(repo, [...STAGE, '--milestone', 'v1.1']));
    assert.deepEqual([out.since, out.files, out.decision], ['last', 3, 'auto']);
  });

  test('[boundary] the tag of the milestone being closed is not its own start (a re-run after tagging)', () => {
    const repo = makeRepo();
    repo.git('tag', 'v1.0', repo.base);
    repo.git('tag', 'v1.1', repo.tip);
    assert.equal(json(run(repo, [...STAGE, '--milestone', 'v1.1'])).since, 'v1.0');
    // Without --milestone the newest tag is the start, and the window is empty.
    const empty = json(run(repo, STAGE));
    assert.deepEqual([empty.since, empty.files, empty.decision, empty.next, empty.prepass], ['v1.1', 0, 'skip', null, null]);
  });

  test('[degraded] no marker and no earlier tag: suggest a baseline review, measure nothing', () => {
    const repo = makeRepo();
    repo.git('tag', 'v1.1', repo.tip);
    const out = json(run(repo, [...STAGE, '--milestone', 'v1.1']));
    assert.deepEqual([out.since, out.window, out.decision, out.next], [null, null, 'suggest', null]);
    assert.equal(typeof out.message, 'string');
    assert.equal(fs.existsSync(path.join(repo.dir, DIR)), false);
  });

  test('[config] code_review.window_at_milestone false: the pre-pass still runs; the review is only named', () => {
    const repo = makeRepo({ code_review: { window_at_milestone: false } });
    repo.git('tag', 'v1.0', repo.base);
    const out = json(run(repo, [...STAGE, '--milestone', 'v1.1']));
    assert.deepEqual([out.decision, out.next, out.prepass], ['suggest', null, `${DIR}/prepass.json`]);
  });

  test('[unhappy] a --milestone that reads as an option, or a bad --date, is usage', () => {
    const repo = makeRepo();
    assert.equal(reason(run(repo, ['stage', '--milestone=-x'])), 'usage');
    assert.equal(reason(run(repo, ['stage', '--date', '05-10-2026'])), 'usage');
  });
});
