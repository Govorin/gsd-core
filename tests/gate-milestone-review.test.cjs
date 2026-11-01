'use strict';

/**
 * `check milestone-review` — the code-review capability's blocking gate at `milestone:pre` — and
 * the owner's recorded override `review milestone-accept`.
 *
 * Every scenario is a real git repository: coverage is a set of commits, and only git can say
 * which commits a review's `base..tip` holds. The verdicts are read from the gate's typed result
 * (and, for the CLI contract, from the JSON it prints), never from its message text.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { gateControl } = require('./helpers/gate-positive-control.cjs');

const gate = require('../gsd-core/bin/lib/gate-milestone-review.cjs');
const { evaluateMilestoneReview, MILESTONE_REVIEW_NAMED_MAX } = gate;

const MILESTONE = 'v1.1';

// ─── Fixture helpers ─────────────────────────────────────────────────────────

function git(dir, args) {
  return gitOrThrow(args, { cwd: dir }).trim();
}

function put(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** Commit one file; returns the new HEAD's full sha. */
function commit(dir, rel, content, message) {
  put(dir, rel, content);
  git(dir, ['add', '--', rel]);
  git(dir, ['commit', '-q', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']);
}

let counter = 0;
function codeCommit(dir, message = 'feat: change') {
  counter++;
  return commit(dir, `src/file-${counter}.js`, `module.exports = ${counter};\n`, message);
}

function fingerprint(n) {
  return `wr:${String(n).padStart(10, '0')}`;
}

/**
 * A composed window REVIEW.md (src/window-review.cts composeWindowReview's shape) under
 * `.planning/reviews/<date>-window/`. `findings`: `{ id, title, fp }`; `fixed`: ids listed in
 * REVIEW-FIX.md; `fixCommits`: shas on its `**Commit:**` lines.
 */
function windowReview(dir, date, { base, tip, status = 'issues_found', findings = [], fixed = [], fixCommits = [], refuted = [] }) {
  const winDir = path.join('.planning', 'reviews', `${date}-window`);
  const fm = [
    '---',
    `window: "${base ?? 'root'}..HEAD"`,
    `since: "${base ?? 'root'}"`,
    'until: "HEAD"',
    `tip: "${tip}"`,
    `base: ${base === null ? 'null' : `"${base}"`}`,
    'reviewed: 2026-10-20T10:00:00.000Z',
    `status: ${status}`,
    '---',
  ].join('\n');
  const body = findings.map((f) => [
    `### ${f.id}: ${f.title}`,
    `_Lens: correctness ${f.id} · verification: upheld · id: ${f.fp}_`,
    '',
    `**File:** \`src/file-1.js:1\``,
    '',
    'Something is wrong here.',
  ].join('\n'));
  const refutedLines = refuted.map((r) => `- correctness ${r}: refuted title — evidence`);
  const text = [fm, '', '# Window Review', '', '## Lens: correctness', '', body.length === 0 ? 'No findings.' : body.join('\n\n'), '',
    ...(refutedLines.length > 0 ? ['## Refuted on verification', '', ...refutedLines, ''] : [])].join('\n');
  put(dir, path.join(winDir, 'REVIEW.md'), text);
  if (fixed.length > 0 || fixCommits.length > 0) {
    const entries = fixed.map((id, i) => [`### ${id}: fixed`, '', '**Files modified:** `src/file-1.js`', `**Commit:** ${fixCommits[i] ?? 'none'}`, ''].join('\n'));
    const extra = fixCommits.slice(fixed.length).map((sha) => `**Commit:** \`${sha}\``);
    put(dir, path.join(winDir, 'REVIEW-FIX.md'), ['---', 'status: partial', '---', '', '# Review Fix Report', '', '## Fixed Issues', '', ...entries, ...extra, ''].join('\n'));
  }
  return path.join(winDir, 'REVIEW.md');
}

function evaluate(dir, milestone = MILESTONE) {
  return evaluateMilestoneReview({ projectDir: dir, args: ['--milestone', milestone] });
}

function tools(dir, args) {
  const r = runGsdTools(args, dir);
  return { ...r, json: r.success ? JSON.parse(r.output) : null };
}

// ─── Positive control (#5204) ────────────────────────────────────────────────

gateControl({
  gate: 'milestone-review',
  module: require('../gsd-core/bin/lib/gate-milestone-review.cjs'),
  fn: 'evaluateMilestoneReview',
  red: 'block',
  expectRed: { status: 'finding', reasons: ['no-review'] },
  // A code commit no window review ever saw.
  redScenario: { git: true, setup: (dir) => { codeCommit(dir); }, args: ['--milestone', MILESTONE] },
  // The same commit, reviewed.
  greenScenario: {
    git: true,
    setup: (dir) => {
      const tip = codeCommit(dir);
      windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean' });
    },
    args: ['--milestone', MILESTONE],
  },
});

// ─── Verdict matrix ──────────────────────────────────────────────────────────

describe('milestone-review verdicts', () => {
  let dir;
  beforeEach(() => { dir = createTempGitProject('milestone-review-'); });
  afterEach(() => { cleanup(dir); });

  test('no window review at all → block, reason no-review', () => {
    codeCommit(dir);
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.equal(v.payload.status, 'finding');
    assert.deepEqual(v.payload.reasons, ['no-review']);
    assert.equal(v.payload.uncovered, 1);
    assert.equal(v.payload.baseFrom, 'root');
  });

  test('a review older than the milestone base covers nothing of the milestone → block, no-review', () => {
    const old = codeCommit(dir);
    windowReview(dir, '2026-09-01', { base: null, tip: old, status: 'clean' });
    git(dir, ['tag', 'v1.0']);
    codeCommit(dir);
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.deepEqual(v.payload.reasons, ['no-review']);
    assert.equal(v.payload.baseFrom, 'tag');
    assert.equal(v.payload.baseTag, 'v1.0');
    assert.equal(v.payload.codeCommits, 1);
  });

  test('the milestone being closed is never its own base (a re-run after tagging)', () => {
    codeCommit(dir);
    git(dir, ['tag', 'v1.0']);
    const tip = codeCommit(dir);
    git(dir, ['tag', MILESTONE]);
    windowReview(dir, '2026-10-20', { base: git(dir, ['rev-parse', 'v1.0']), tip, status: 'clean' });
    const v = evaluate(dir);
    assert.equal(v.payload.baseTag, 'v1.0');
    assert.equal(v.block, false);
    assert.equal(v.payload.status, 'pass');
  });

  test('a review covering part of the window → block, uncovered names exactly the rest', () => {
    const first = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip: first, status: 'clean' });
    const second = codeCommit(dir, 'feat: after the review');
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.deepEqual(v.payload.reasons, ['uncovered']);
    assert.deepEqual(v.payload.uncoveredCommits.map((c) => c.sha), [second]);
    assert.equal(v.payload.reviews.length, 1);
  });

  test('two chained windows together cover the milestone → pass', () => {
    const first = codeCommit(dir);
    windowReview(dir, '2026-10-10', { base: null, tip: first, status: 'clean' });
    const second = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: first, tip: second, status: 'clean' });
    const v = evaluate(dir);
    assert.equal(v.block, false);
    assert.equal(v.payload.status, 'pass');
    assert.equal(v.payload.reviews.length, 2);
  });

  test('commits that only touch .planning/ need no review', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean' });
    commit(dir, '.planning/reviews/2026-10-20-window/REVIEW.md', 'docs only\n', 'docs(review): window review 2026-10-20-window');
    // The commit replaced the review text; re-write the review so the assessment reads the real one.
    windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean' });
    commit(dir, '.planning/STATE.md', 'state\n', 'docs: state');
    assert.equal(evaluate(dir).payload.status, 'pass');
  });

  test('a milestone that changed no code → pass, no-change', () => {
    git(dir, ['tag', 'v1.0']);
    commit(dir, '.planning/ROADMAP.md', '# roadmap\n', 'docs: roadmap');
    const v = evaluate(dir);
    assert.equal(v.block, false);
    assert.equal(v.payload.status, 'no-change');
  });

  test('covered, with an open Critical → block, open-critical', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, findings: [{ id: 'CR-01', title: 'sql injection', fp: fingerprint(1) }] });
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.deepEqual(v.payload.reasons, ['open-critical']);
    assert.deepEqual(v.payload.openCriticalFindings.map((f) => [f.id, f.key]), [['CR-01', fingerprint(1)]]);
  });

  test('uncovered commits and an open Critical → both reasons', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, findings: [{ id: 'CR-01', title: 'x', fp: fingerprint(1) }] });
    codeCommit(dir);
    assert.deepEqual(evaluate(dir).payload.reasons, ['uncovered', 'open-critical']);
  });

  test('the Critical fixed by the fix pass (REVIEW-FIX.md), its fix commit counted as covered → pass', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, findings: [{ id: 'CR-01', title: 'x', fp: fingerprint(1) }] });
    const fix = commit(dir, 'src/file-1.js', 'module.exports = "fixed";\n', 'fix(02): CR-01 fix it');
    windowReview(dir, '2026-10-20', { base: null, tip, findings: [{ id: 'CR-01', title: 'x', fp: fingerprint(1) }], fixed: ['CR-01'], fixCommits: [fix.slice(0, 7)] });
    const v = evaluate(dir);
    assert.equal(v.block, false, JSON.stringify(v.payload));
    assert.equal(v.payload.status, 'pass');
    assert.equal(v.payload.uncovered, 0);
  });

  test('a commit after the tip that the fix report does not name stays uncovered', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean' });
    const fix = codeCommit(dir, 'fix: by hand');
    windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean', fixCommits: [] });
    assert.deepEqual(evaluate(dir).payload.uncoveredCommits.map((c) => c.sha), [fix]);
  });

  test('a Critical the refuter disproved is not open → pass', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean', refuted: ['CR-01'] });
    assert.equal(evaluate(dir).payload.status, 'pass');
  });

  test('a Critical whose broken-window entry is waived (accepted with a reason) or fixed is not open', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', {
      base: null,
      tip,
      findings: [{ id: 'CR-01', title: 'a', fp: fingerprint(1) }, { id: 'CR-02', title: 'b', fp: fingerprint(2) }],
    });
    for (const n of [1, 2]) {
      const r = tools(dir, ['windows', 'append', '--kind', 'deviation', '--phase', '2026-10-20-window', '--description', `window review correctness CR-0${n}: t [${fingerprint(n)}]`]);
      assert.equal(r.success, true, r.error);
    }
    assert.deepEqual(evaluate(dir).payload.reasons, ['open-critical']);
    assert.equal(tools(dir, ['windows', 'waive', '1', 'accepted: tracked in the next milestone']).success, true);
    assert.equal(evaluate(dir).payload.openCritical, 1, 'one waived, one still open');
    assert.equal(tools(dir, ['windows', 'fixed', '2']).success, true);
    assert.equal(evaluate(dir).payload.status, 'pass');
  });

  test('warnings never block; they are counted', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, findings: [{ id: 'WR-01', title: 'a', fp: fingerprint(1) }, { id: 'WR-02', title: 'b', fp: fingerprint(2) }] });
    const v = evaluate(dir);
    assert.equal(v.block, false);
    assert.equal(v.payload.status, 'pass');
    assert.equal(v.payload.openWarnings, 2);
  });

  test('an incomplete review covers nothing and is listed as ignored', () => {
    const tip = codeCommit(dir);
    const review = windowReview(dir, '2026-10-20', { base: null, tip, status: 'incomplete' });
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.deepEqual(v.payload.ignoredReviews.map((r) => r.review), [review]);
  });

  test('a review whose tip is not in the repository covers nothing', () => {
    codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip: 'f'.repeat(40), status: 'clean' });
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.equal(v.payload.ignoredReviews.length, 1);
  });

  test('workflow.code_review off → skip, no review owed', () => {
    codeCommit(dir);
    put(dir, '.planning/config.json', JSON.stringify({ workflow: { code_review: false } }));
    const v = evaluate(dir);
    assert.equal(v.outcome, 'skip');
    assert.equal(v.block, false);
  });

  test('a REVIEW.md that cannot be read → unreadable, never a pass', () => {
    codeCommit(dir);
    fs.mkdirSync(path.join(dir, '.planning', 'reviews', '2026-10-20-window', 'REVIEW.md'), { recursive: true });
    const v = evaluate(dir);
    assert.equal(v.outcome, 'unreadable');
    assert.equal(v.block, true);
  });

  test('a missing or malformed --milestone is a usage failure', () => {
    assert.equal(evaluateMilestoneReview({ projectDir: dir, args: [] }).failure.code, 'sdk_missing_arg');
    assert.equal(evaluateMilestoneReview({ projectDir: dir, args: ['--milestone', '../x'] }).failure.code, 'usage');
    assert.equal(evaluateMilestoneReview({ projectDir: dir, args: [dir] }).failure.code, 'usage', 'a path is not a version');
  });

  test('the version may come as the first positional', () => {
    codeCommit(dir);
    const v = evaluateMilestoneReview({ projectDir: dir, args: [MILESTONE] });
    assert.equal(v.payload.milestone, MILESTONE);
    assert.equal(v.block, true);
  });
});

describe('milestone-review outside a repository', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('milestone-review-nogit-'); });
  afterEach(() => { cleanup(dir); });

  test('not a git repository → skip', () => {
    const v = evaluate(dir);
    assert.equal(v.outcome, 'skip');
    assert.equal(v.block, false);
  });
});

// ─── Boundaries: the named list (MILESTONE_REVIEW_NAMED_MAX) ─────────────────

describe('milestone-review names at most MILESTONE_REVIEW_NAMED_MAX uncovered commits', () => {
  let dir;
  beforeEach(() => { dir = createTempGitProject('milestone-review-max-'); });
  afterEach(() => { cleanup(dir); });

  for (const n of [MILESTONE_REVIEW_NAMED_MAX - 1, MILESTONE_REVIEW_NAMED_MAX, MILESTONE_REVIEW_NAMED_MAX + 1]) {
    test(`${n} uncovered commit(s)`, () => {
      for (let i = 0; i < n; i++) codeCommit(dir);
      const v = evaluate(dir);
      assert.equal(v.payload.uncovered, n, 'the count is exact');
      assert.equal(v.payload.uncoveredCommits.length, Math.min(n, MILESTONE_REVIEW_NAMED_MAX), 'the list is capped');
    });
  }
});

// ─── The owner's override and the CLI contract ───────────────────────────────

describe('review milestone-accept and check milestone-review (CLI)', () => {
  let dir;
  beforeEach(() => { dir = createTempGitProject('milestone-accept-'); });
  afterEach(() => { cleanup(dir); });

  test('a delivered block is exit 0 with the verdict on stdout', () => {
    codeCommit(dir);
    const r = tools(dir, ['check', 'milestone-review', '--milestone', MILESTONE, '--raw']);
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.block, true);
    assert.equal(r.json.status, 'finding');
    assert.deepEqual(r.json.reasons, ['no-review']);
    assert.equal(typeof r.json.message, 'string');
    assert.equal(r.json.milestone, MILESTONE);
  });

  test('could-not-check exits non-zero (69) so onError routes it', () => {
    codeCommit(dir);
    fs.mkdirSync(path.join(dir, '.planning', 'reviews', '2026-10-20-window', 'REVIEW.md'), { recursive: true });
    const r = runGsdTools(['check', 'milestone-review', '--milestone', MILESTONE, '--raw'], dir);
    assert.equal(r.success, false);
    assert.equal(r.exitCode, 69);
  });

  test('accepting records the open state with the reason, and the gate passes as accepted', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, findings: [{ id: 'CR-01', title: 'x', fp: fingerprint(1) }] });
    codeCommit(dir);
    const accepted = tools(dir, ['review', 'milestone-accept', '--milestone', MILESTONE, '--reason', 'hotfix release; reviewed in v1.2']);
    assert.equal(accepted.success, true, accepted.error);
    assert.equal(accepted.json.written, true);
    assert.equal(accepted.json.uncovered, 1);
    assert.equal(accepted.json.openCritical, 1);
    const v = evaluate(dir);
    assert.equal(v.block, false);
    assert.equal(v.payload.status, 'accepted');
    assert.equal(v.payload.accept.reason, 'hotfix release; reviewed in v1.2');
  });

  test('the acceptance is self-invalidating: exactly what was accepted passes, one more commit blocks', () => {
    codeCommit(dir);
    assert.equal(tools(dir, ['review', 'milestone-accept', '--milestone', MILESTONE, '--reason', 'r']).success, true);
    assert.equal(evaluate(dir).payload.status, 'accepted');
    codeCommit(dir);
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.equal(v.payload.uncovered, 2);
  });

  test('an acceptance of another milestone does not apply', () => {
    codeCommit(dir);
    assert.equal(tools(dir, ['review', 'milestone-accept', '--milestone', 'v9.9', '--reason', 'r']).success, true);
    assert.equal(evaluate(dir).block, true);
  });

  test('nothing open → nothing written', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip, status: 'clean' });
    const r = tools(dir, ['review', 'milestone-accept', '--milestone', MILESTONE, '--reason', 'r']);
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.written, false);
    assert.equal(fs.existsSync(path.join(dir, '.planning', 'reviews', `MILESTONE-${MILESTONE}-ACCEPT.json`)), false);
  });

  test('a reason is required, one line, at most 500 characters', () => {
    codeCommit(dir);
    const run = (reason) => runGsdTools(['review', 'milestone-accept', '--milestone', MILESTONE, '--reason', reason], dir);
    assert.equal(runGsdTools(['review', 'milestone-accept', '--milestone', MILESTONE], dir).success, false);
    assert.equal(run('   ').success, false);
    assert.equal(run('two\nlines').success, false);
    assert.equal(run('x'.repeat(501)).success, false);
    assert.equal(run('x'.repeat(500)).success, true);
  });
});
