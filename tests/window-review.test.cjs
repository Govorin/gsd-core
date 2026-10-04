'use strict';

/**
 * Window review pre-pass and composition (ADR-5208, design D2): behavioural tests against real
 * git fixtures for the measured classes, plus the pure pieces — batching, complexity deltas,
 * REVIEW.md parsing, review-only recurrence, refutation, composition and deferral — at their
 * boundaries. Git failure is injected through the module's `execGit` seam.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { execGit } = require('../gsd-core/bin/lib/shell-command-projection.cjs');
const {
  computeWindowPrepass,
  planBatches,
  complexityRises,
  unconsumedExports,
  parseReviewFindings,
  recurringReviewOnly,
  parseRefutation,
  composeWindowReview,
  deferredWindowEntries,
  fixedFindingIds,
  fixedWindowEntryIds,
  findingFingerprint,
  lensReports,
  milestoneReviewAnswer,
  milestoneWindowSince,
  reviewMatchesWindow,
  windowDirFor,
  windowMarkerFor,
  PREPASS_CLASS,
} = require('../gsd-core/bin/lib/window-review.cjs');
const { parseLastWindowMarker } = require('../gsd-core/bin/lib/gate-evaluation-scope.cjs');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.io',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.io',
};
const DATE = '2026-10-05';

const dirs = [];
afterEach(() => {
  while (dirs.length > 0) cleanup(dirs.pop());
});

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A function whose decision-point score is `1 + decisions`. */
function fnWith(name, decisions, exported = true) {
  return `${exported ? 'export ' : ''}function ${name}(a) {\n${'  if (a) { a++; }\n'.repeat(decisions)}  return a;\n}\n`;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-window-review-'));
  dirs.push(dir);
  const git = (...args) => gitOrThrow(args, { cwd: dir, env: { ...process.env, ...IDENTITY } }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.io');
  git('config', 'user.name', 'Test');
  write(dir, '.planning/config.json', '{}\n');
  const commit = (files, message) => {
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    git('add', '-A');
    git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

/**
 * The seeded window: `grow` jumps by 6 decision points, `old` loses its only consumer (d.js stops
 * importing it), `fresh` is exported new with no consumer, `wired` is new and consumed, and a.js
 * changes twice.
 */
function seededWindow() {
  const repo = makeRepo();
  const base = repo.commit({
    'src/a.js': fnWith('grow', 1),
    'src/c.js': 'export function old() { return 1; }\nexport function kept() { return 2; }\n',
    'src/d.js': "import { old, kept } from './c.js';\nexport function useIt() { return old() + kept(); }\n",
    'src/main.js': "import { useIt } from './d.js';\nuseIt();\n",
  }, 'chore: base');
  repo.commit({ 'src/a.js': fnWith('grow', 7) }, 'feat: grow');
  repo.commit({ 'src/d.js': "import { kept } from './c.js';\nexport function useIt() { return kept(); }\n" }, 'refactor: drop old');
  repo.commit({
    'src/b.js': 'export function fresh() { return 3; }\nexport const wired = 4;\n',
    'src/main.js': "import { useIt } from './d.js';\nimport { wired } from './b.js';\nuseIt(wired);\n",
  }, 'feat: b');
  repo.commit({ 'src/a.js': `${fnWith('grow', 7)}// tail\n` }, 'chore: touch a');
  return { ...repo, base };
}

const classOf = (prepass, name) => prepass.classes.find((c) => c.class === name);

describe('computeWindowPrepass — the measured classes', () => {
  test('[happy] a seeded window reports growth, the complexity jump, both export classes and churn', () => {
    const repo = seededWindow();
    const p = computeWindowPrepass(repo.dir, { since: repo.base, date: DATE });
    assert.equal(p.status, 'resolved');
    assert.equal(p.commits, 4);
    assert.deepEqual(p.files, ['src/a.js', 'src/b.js', 'src/d.js', 'src/main.js']);
    for (const c of Object.values(PREPASS_CLASS)) assert.equal(classOf(p, c).status, 'checked', c);
    assert.deepEqual(p.complexity.rises.map((r) => [r.file, r.name, r.base, r.tip, r.delta, r.reasons]), [['src/a.js', 'grow', 2, 8, 6, ['jump']]]);
    assert.deepEqual(p.exports, [
      { file: 'src/b.js', name: 'fresh', change: 'new' },
      { file: 'src/c.js', name: 'old', change: 'lost-last-consumer' },
    ]);
    assert.deepEqual(p.churn.find((c) => c.file === 'src/a.js').commits, 2);
    assert.deepEqual(p.locGrowth.find((g) => g.file === 'src/b.js'), { file: 'src/b.js', added: 2, removed: 0, net: 2 });
    assert.deepEqual(p.batches, [['src/a.js', 'src/b.js', 'src/d.js', 'src/main.js']]);
    assert.equal(p.dir, `.planning/reviews/${DATE}-window`);
    assert.equal(p.review, `.planning/reviews/${DATE}-window/REVIEW.md`);
    assert.deepEqual(p.reports.map((r) => r.label), ['correctness', 'standards', 'spec', 'simplify']);
  });

  test('[boundary] max-files: N-1 truncates one file and says so; N analyses every file', () => {
    const repo = seededWindow();
    const cut = computeWindowPrepass(repo.dir, { since: repo.base, date: DATE, maxFiles: 3 });
    assert.deepEqual(cut.truncated.length, 1);
    assert.equal(classOf(cut, PREPASS_CLASS.COMPLEXITY_DELTA).reason, 'max-files:3');
    const whole = computeWindowPrepass(repo.dir, { since: repo.base, date: DATE, maxFiles: 4 });
    assert.deepEqual(whole.truncated, []);
    assert.equal(classOf(whole, PREPASS_CLASS.COMPLEXITY_DELTA).reason, null);
  });

  test('[boundary] the export classes need the tip checked out; the git-read classes do not', () => {
    const repo = seededWindow();
    const p = computeWindowPrepass(repo.dir, { since: repo.base, until: 'HEAD~1', date: DATE });
    assert.equal(p.status, 'resolved');
    assert.deepEqual(classOf(p, PREPASS_CLASS.UNCONSUMED_EXPORTS), { class: 'unconsumed-exports', status: 'skipped', reason: 'tip-not-checked-out' });
    assert.equal(classOf(p, PREPASS_CLASS.COMPLEXITY_DELTA).status, 'checked');
    assert.equal(p.complexity.rises.length, 1);
  });

  test('[hostile] a git timeout on file reads skips the content classes by name and keeps the rest', () => {
    const repo = seededWindow();
    const runner = (args, opts) => (args[0] === 'show'
      ? { exitCode: 1, stdout: '', stderr: '', signal: 'SIGTERM', error: null, timedOut: true }
      : execGit(args, opts));
    const p = computeWindowPrepass(repo.dir, { since: repo.base, date: DATE, execGit: runner });
    assert.deepEqual(classOf(p, PREPASS_CLASS.COMPLEXITY_DELTA), { class: 'complexity-delta', status: 'skipped', reason: 'git-timeout' });
    assert.deepEqual(classOf(p, PREPASS_CLASS.UNCONSUMED_EXPORTS), { class: 'unconsumed-exports', status: 'skipped', reason: 'git-timeout' });
    assert.equal(classOf(p, PREPASS_CLASS.CHURN).status, 'checked');
    assert.equal(classOf(p, PREPASS_CLASS.LOC_GROWTH).status, 'checked');
  });

  test('[unhappy] `--since last` with no marker is unresolvable and checks nothing', () => {
    const repo = seededWindow();
    const p = computeWindowPrepass(repo.dir, { since: 'last', date: DATE });
    assert.equal(p.status, 'unresolvable');
    assert.equal(p.reason, 'no-last-window-marker');
    assert.ok(p.classes.every((c) => c.status === 'skipped'));
  });

  test('[boundary] an empty window degrades, names why, and checks nothing', () => {
    const repo = seededWindow();
    const p = computeWindowPrepass(repo.dir, { since: 'HEAD', date: DATE });
    assert.equal(p.status, 'degraded');
    assert.equal(p.reason, 'empty-window');
    assert.deepEqual(p.files, []);
    assert.ok(p.classes.every((c) => c.status === 'skipped' && c.reason === 'empty-window'));
  });

  test('[happy] review-only findings on one file in two earlier window reviews recur; one review does not', () => {
    const repo = seededWindow();
    const review = (id) => `# Review\n\n## Warnings\n\n### ${id}: Unchecked input\n\n**File:** \`src/a.js:3\`\n**Issue:** x\n**Guarded by:** review only\n`;
    write(repo.dir, '.planning/reviews/2026-09-01-window/REVIEW.md', review('WR-01'));
    const once = computeWindowPrepass(repo.dir, { since: repo.base, date: DATE });
    assert.deepEqual(once.reviewOnly.recurring, []);
    write(repo.dir, '.planning/reviews/2026-09-15-window/REVIEW.md', review('WR-04'));
    const twice = computeWindowPrepass(repo.dir, { since: repo.base, date: DATE });
    assert.deepEqual(twice.reviewOnly.reviewsRead, ['.planning/reviews/2026-09-01-window/REVIEW.md', '.planning/reviews/2026-09-15-window/REVIEW.md']);
    assert.deepEqual(twice.reviewOnly.recurring.map((r) => [r.file, r.reviews]), [['src/a.js', 2]]);
  });
});

describe('planBatches — window_max_files_per_batch', () => {
  const files = (n) => Array.from({ length: n }, (_, i) => `src/f${String(i).padStart(2, '0')}.js`);
  test('[boundary] size-1 / size / size+1 files give 1 / 1 / 2 batches', () => {
    assert.equal(planBatches(files(39), 40).length, 1);
    assert.equal(planBatches(files(40), 40).length, 1);
    assert.deepEqual(planBatches(files(41), 40).map((b) => b.length), [40, 1]);
  });
  test('[happy] the highest rank leads; ties fall back to path order', () => {
    const rank = new Map([['src/f02.js', 9], ['src/f00.js', 1], ['src/f01.js', 1]]);
    assert.deepEqual(planBatches(files(3), 2, rank), [['src/f02.js', 'src/f00.js'], ['src/f01.js']]);
  });
  test('[unhappy] a non-positive size is refused, never a silent single batch', () => {
    assert.throws(() => planBatches(files(3), 0), RangeError);
  });
});

describe('complexityRises — refactor.complexity_jump_delta / complexity_threshold', () => {
  const pair = (baseDecisions, tipDecisions) => ({
    file: 'src/x.js',
    base: baseDecisions === null ? null : fnWith('f', baseDecisions),
    tip: fnWith('f', tipDecisions),
  });
  test('[boundary] a delta of jumpDelta-1 and jumpDelta is quiet; jumpDelta+1 is a jump', () => {
    for (const [delta, flagged] of [[4, false], [5, false], [6, true]]) {
      const r = complexityRises([pair(1, 1 + delta)], { threshold: 50, jumpDelta: 5 });
      assert.equal(r.rises.length, flagged ? 1 : 0, `delta ${delta}`);
    }
  });
  test('[boundary] crossing the threshold inside the window counts; already above it does not', () => {
    // threshold 15: scores are 1 + decisions.
    assert.deepEqual(complexityRises([pair(14, 15)], { threshold: 15, jumpDelta: 50 }).rises.map((r) => r.reasons), [['threshold']]);
    assert.deepEqual(complexityRises([pair(13, 14)], { threshold: 15, jumpDelta: 50 }).rises, []);
    assert.deepEqual(complexityRises([pair(15, 15)], { threshold: 15, jumpDelta: 50 }).rises, [], 'above at base, unchanged');
    assert.deepEqual(complexityRises([pair(15, 21)], { threshold: 15, jumpDelta: 5 }).rises.map((r) => r.reasons), [['jump']]);
    assert.deepEqual(complexityRises([pair(null, 15)], { threshold: 15, jumpDelta: 5 }).rises.map((r) => [r.base, r.delta, r.reasons]), [[null, null, ['threshold']]]);
  });
});

describe('unconsumedExports — consumers by name', () => {
  const edge = (from, to, names) => ({ from, to, specifier: './x', line: 1, kind: 'import', typeOnly: false, names, via: 'relative' });
  const graph = (edges) => ({ root: '/r', scope: null, nodes: [], edges, unresolved: [], skipped: [], aliases: { rules: [], baseUrl: null, emit: [], sources: [], warnings: [] } });
  test('[happy] a whole-module import consumes every name; a named import only its names', () => {
    const tip = graph([edge('src/u.js', 'src/x.js', ['a']), edge('src/v.js', 'src/y.js', null)]);
    const found = unconsumedExports({
      windowFiles: [
        { file: 'src/x.js', base: null, tip: 'export const a = 1;\nexport const b = 2;\n' },
        { file: 'src/y.js', base: null, tip: 'export const c = 3;\n' },
      ],
      tipGraph: tip, tipNames: () => null, baseGraph: null, changed: new Set(),
    });
    assert.deepEqual(found, [{ file: 'src/x.js', name: 'b', change: 'new' }]);
  });
  test('[boundary] an export kept from base is not new; it is lost only when a changed module bound it at base', () => {
    const windowFiles = [{ file: 'src/x.js', base: 'export const a = 1;\n', tip: 'export const a = 1;\n' }];
    const base = graph([edge('src/u.js', 'src/x.js', ['a'])]);
    const common = { windowFiles, tipGraph: graph([]), tipNames: () => ['a'], baseGraph: base };
    assert.deepEqual(unconsumedExports({ ...common, changed: new Set() }), []);
    assert.deepEqual(unconsumedExports({ ...common, changed: new Set(['src/u.js']) }), [{ file: 'src/x.js', name: 'a', change: 'lost-last-consumer' }]);
    assert.deepEqual(unconsumedExports({ ...common, changed: new Set(['src/u.js']), tipNames: () => [] }), [], 'a name no longer exported is removed, not orphaned');
  });
});

const REVIEW_A = [
  '---', 'status: issues_found', '---', '# Review', '', '## Critical Issues', '',
  '### CR-01: Path traversal in loader', '', '**File:** `src/load.js:42`', '**Issue:** joins user input', '**Guarded by:** review only', '',
  '## Warnings', '',
  '### WR-01: Swallowed error', '', '**File:** `src/run.js:7-9`', '**Issue:** empty catch', 'guarded by: `local/no-empty-catch` (eslint, CI)', '',
  '### BL-02: Legacy blocker label', '', '**File:** `src/old.js`', '',
  '## Info', '', '### IN-01: Naming', '', '**Issue:** no file line', '',
].join('\n');

describe('parseReviewFindings / recurringReviewOnly', () => {
  test('[happy] severity, file:line and provenance are read per finding', () => {
    const f = parseReviewFindings(REVIEW_A);
    assert.deepEqual(f.map((x) => [x.id, x.severity, x.file, x.line, x.reviewOnly]), [
      ['CR-01', 'critical', 'src/load.js', 42, true],
      ['WR-01', 'warning', 'src/run.js', 7, false],
      ['BL-02', 'critical', 'src/old.js', null, false],
      ['IN-01', 'info', null, null, false],
    ]);
    assert.equal(f[1].guardedBy, 'local/no-empty-catch (eslint, CI)');
  });
  test('[boundary] recurrence counts distinct reviews: two findings in one review are one', () => {
    const one = parseReviewFindings(REVIEW_A);
    const sameReviewTwice = [{ review: 'r1', findings: [...one, ...one] }];
    assert.deepEqual(recurringReviewOnly(sameReviewTwice, 2), []);
    assert.deepEqual(recurringReviewOnly([{ review: 'r1', findings: one }, { review: 'r2', findings: one }], 2).map((r) => r.reviews), [2]);
    assert.deepEqual(recurringReviewOnly([{ review: 'r1', findings: one }, { review: 'r2', findings: one }], 3), []);
  });
});

describe('composeWindowReview — lenses side by side, refuted findings set apart', () => {
  const window = { since: 'abc', sinceKind: 'ref', until: 'HEAD', tip: 'f'.repeat(40), base: 'a'.repeat(40), boundary: null, phases: {}, unattributed: [] };
  const standards = '### WR-01: Magic number\n\n**File:** `src/a.js:3`\n**Issue:** smell\n\n### IN-01: Long name\n\n**File:** `src/a.js:9`\n';
  const correctness = '### CR-01: Null deref\n\n**File:** `src/b.js:5`\n\n### WR-01: Off by one\n\n**File:** `src/b.js:8`\n';
  const reports = [
    { label: 'correctness', lens: 'correctness', path: 'x/REVIEW-correctness.md', text: correctness },
    { label: 'standards', lens: 'standards', path: 'x/REVIEW-standards.md', text: standards },
    { label: 'spec', lens: 'spec', path: 'x/REVIEW-spec.md', text: null },
  ];
  const refutation = [
    '## REFUTATION COMPLETE', '', 'upheld: 1', 'refuted: 1', '',
    '### correctness WR-01: Off by one', 'verdict: REFUTED', 'evidence: src/b.js:8 iterates `< length`.', '',
    '### standards WR-01: Magic number', 'verdict: UPHELD', 'evidence: grep shows no constant.', '',
  ].join('\n');

  test('[happy] order is lens then report order; IDs renumber across lenses; refuted and unverified are distinguished', () => {
    const out = composeWindowReview({ window, files: ['src/a.js', 'src/b.js'], reports, refutation, reviewedAt: '2026-10-05T00:00:00.000Z' });
    const findings = parseReviewFindings(out.text);
    assert.deepEqual(findings.map((f) => [f.id, f.title]), [['CR-01', 'Null deref'], ['WR-01', 'Magic number'], ['IN-01', 'Long name']]);
    assert.deepEqual(out.counts, { critical: 1, warning: 1, info: 1, total: 3, refuted: 1, unverified: 2 });
    assert.deepEqual(out.missingReports, ['spec']);
    assert.equal(out.status, 'issues_found');
    assert.match(findings[0].block, /_Lens: correctness CR-01 · verification: unverified · id: wr:[0-9a-f]{10}_/);
    assert.match(findings[1].block, /_Lens: standards WR-01 · verification: upheld · id: wr:[0-9a-f]{10}_/);
  });

  test('[boundary] no findings with a missing report is incomplete, never clean; with every report it is clean', () => {
    const empty = reports.map((r) => ({ ...r, text: r.text === null ? null : '# none\n' }));
    assert.equal(composeWindowReview({ window, files: [], reports: empty, refutation: null, reviewedAt: 't' }).status, 'incomplete');
    const all = empty.map((r) => ({ ...r, text: '# none\n' }));
    assert.equal(composeWindowReview({ window, files: [], reports: all, refutation: null, reviewedAt: 't' }).status, 'clean');
  });

  test('[hostile] a refutation heading with no readable verdict upholds the finding', () => {
    assert.deepEqual(parseRefutation('### spec WR-02: X\nevidence: none\n'), [{ label: 'spec', id: 'WR-02', verdict: 'upheld', evidence: 'none' }]);
  });
});

describe('deferredWindowEntries — surviving findings to WINDOWS.md, once', () => {
  const window = { since: 'abc', sinceKind: 'ref', until: 'HEAD', tip: 'f'.repeat(40), base: null, boundary: null, phases: {}, unattributed: [] };
  const report = '### CR-01: Null deref\n\n**File:** `src/b.js:5`\n\n### WR-01: Off by one\n\n**File:** `src/b.js:8`\n\n### IN-01: Naming\n\n**File:** `src/b.js:1`\n';
  const composed = composeWindowReview({
    window, files: ['src/b.js'], reports: [{ label: 'correctness', lens: 'correctness', path: 'p', text: report }], refutation: null, reviewedAt: 't',
  }).text;

  test('[happy] Critical and Warning are deferred with a fingerprint; Info is not', () => {
    const entries = deferredWindowEntries(composed, null, new Set(), '2026-10-05-window');
    assert.deepEqual(entries.map((e) => [e.file, e.line]), [['src/b.js', 5], ['src/b.js', 8]]);
    assert.match(entries[0].description, /^window review correctness CR-01: Null deref \[wr:[0-9a-f]{10}\]$/);
  });
  test('[boundary] a fixed finding and an already-recorded fingerprint are both left out', () => {
    const fixed = '## Fixed Issues\n\n### CR-01: Null deref\n\n## Skipped Issues\n\n### WR-01: Off by one\n';
    assert.deepEqual([...fixedFindingIds(fixed)], ['CR-01']);
    const afterFix = deferredWindowEntries(composed, fixed, new Set(), 'w');
    assert.deepEqual(afterFix.map((e) => e.description.split(':')[0]), ['window review correctness WR-01']);
    assert.deepEqual(deferredWindowEntries(composed, fixed, new Set([afterFix[0].fingerprint]), 'w'), []);
  });
  test('[boundary] a fix closes only open entries whose fingerprint belongs to a fixed finding', () => {
    const [cr, wr] = deferredWindowEntries(composed, null, new Set(), 'w');
    const entries = [
      { id: 3, description: cr.description, status: 'open' },
      { id: 4, description: wr.description, status: 'open' },
      { id: 5, description: cr.description, status: 'waived' },
    ];
    const fixed = '## Fixed Issues\n\n### CR-01: Null deref\n';
    assert.deepEqual(fixedWindowEntryIds(composed, fixed, entries), [3]);
    assert.deepEqual(fixedWindowEntryIds(composed, null, entries), []);
  });

  test('[happy] the fingerprint ignores IDs and lines but not the lens', () => {
    const a = findingFingerprint('standards', { id: 'WR-01', file: 'src/a.js', title: 'Magic  number!' });
    assert.equal(a, findingFingerprint('standards', { id: 'WR-07', file: 'src/a.js', title: 'magic number' }));
    assert.notEqual(a, findingFingerprint('spec', { id: 'WR-01', file: 'src/a.js', title: 'Magic number' }));
  });
});

describe('reviewMatchesWindow — `--fix` recovery', () => {
  test('[boundary] the same base and tip match; another tip, another base or no frontmatter do not', () => {
    const window = { since: 'abc', sinceKind: 'ref', until: 'HEAD', tip: 'f'.repeat(40), base: 'a'.repeat(40), boundary: null, phases: {}, unattributed: [] };
    const text = composeWindowReview({ window, files: [], reports: [], refutation: null, reviewedAt: 't' }).text;
    assert.equal(reviewMatchesWindow(text, { base: 'a'.repeat(40), tip: 'f'.repeat(40) }), true);
    assert.equal(reviewMatchesWindow(text, { base: 'a'.repeat(40), tip: 'e'.repeat(40) }), false);
    assert.equal(reviewMatchesWindow(text, { base: null, tip: 'f'.repeat(40) }), false);
    assert.equal(reviewMatchesWindow('# no frontmatter\n', { base: 'a'.repeat(40), tip: 'f'.repeat(40) }), false);
  });
});

describe('layout and the LAST-WINDOW marker', () => {
  test('[boundary] the correctness lens gets one report per batch only when it has more than one batch', () => {
    assert.deepEqual(lensReports('d', ['correctness', 'spec'], [['a']]).map((r) => r.path), ['d/REVIEW-correctness.md', 'd/REVIEW-spec.md']);
    assert.deepEqual(lensReports('d', ['correctness'], [['a'], ['b']]).map((r) => [r.label, r.files]), [['correctness-1', ['a']], ['correctness-2', ['b']]]);
  });
  test('[unhappy] the marker is refused until REVIEW.md exists, then parses back as a version-1 marker', () => {
    const repo = makeRepo();
    const dir = windowDirFor(repo.dir, DATE);
    const prepass = { window: { since: '7d', until: 'HEAD', tip: 'e'.repeat(40) }, review: `${dir}/REVIEW.md` };
    assert.deepEqual(windowMarkerFor(repo.dir, prepass, '2026-10-05T00:00:00.000Z'), { ok: false, reason: 'no-review' });
    write(repo.dir, `${dir}/REVIEW.md`, '---\nstatus: clean\n---\n');
    const marker = windowMarkerFor(repo.dir, prepass, '2026-10-05T00:00:00.000Z');
    assert.equal(marker.ok, true);
    assert.deepEqual(parseLastWindowMarker(marker.text), {
      version: 1, tip: 'e'.repeat(40), since: '7d', until: 'HEAD', reviewedAt: '2026-10-05T00:00:00.000Z', review: `${dir}/REVIEW.md`,
    });
    assert.throws(() => windowDirFor(repo.dir, '2026-10-5'), RangeError);
  });
});

describe('milestone stage answer', () => {
  const prepass = (over) => ({ status: 'resolved', reason: null, files: ['a.js'], commits: 2, classes: [{ class: 'churn', status: 'checked', reason: null }], dir: '.planning/reviews/d-window', ...over });
  test('an unresolvable window is a suggest naming why, never a silent skip', () => {
    const a = milestoneReviewAnswer(prepass({ status: 'unresolvable', reason: 'unknown-ref' }), 'v1.0', true);
    assert.deepEqual([a.decision, a.next], ['suggest', null]);
    assert.match(a.message, /unknown-ref/);
  });
  test('an empty window skips whatever the switch says', () => {
    for (const on of [true, false]) assert.deepEqual(milestoneReviewAnswer(prepass({ files: [] }), 'v1.0', on), { decision: 'skip', message: null, next: null });
  });
  test('on is auto with the review as next; off is suggest; the slash form is the runtime\'s', () => {
    assert.deepEqual(milestoneReviewAnswer(prepass(), 'last', true).next, { skill: 'code-review', args: '--since last' });
    assert.match(milestoneReviewAnswer(prepass(), 'last', false, '$gsd-code-review').message, /\$gsd-code-review --since last$/);
  });
  test('a git failure while listing tags is no start, not an exception', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wr-stage-'));
    t.after(() => cleanup(dir));
    const failing = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null, timedOut: false });
    assert.equal(milestoneWindowSince(dir, 'v1.0', failing), null);
  });
});
