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
const { milestoneWindowStart } = require('../gsd-core/bin/lib/milestone-review.cjs');

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

// ─── Where the milestone starts: one base for the gate and the stage ─────────

describe('milestone-review base', () => {
  let dir;
  beforeEach(() => { dir = createTempGitProject('milestone-review-base-'); });
  afterEach(() => { cleanup(dir); });

  function archive(version) {
    return commit(dir, `.planning/milestones/${version}-ROADMAP.md`, `# ${version}\n`, `chore: archive ${version}`);
  }

  test('get_your_look_up shape: create_tag off, one stale v1.3 tag, archives up to v1.12 → base is the v1.12 archive commit', () => {
    put(dir, '.planning/config.json', JSON.stringify({ git: { create_tag: false } }));
    codeCommit(dir);
    git(dir, ['tag', 'v1.3']);
    for (const v of ['v1.4', 'v1.11']) { codeCommit(dir); archive(v); }
    codeCommit(dir, 'feat: last change of v1.12');
    const closedAt = archive('v1.12');
    const current = codeCommit(dir, 'feat: v1.13 work');
    const v = evaluate(dir, 'v1.13');
    assert.equal(v.payload.baseFrom, 'archive');
    assert.equal(v.payload.base, closedAt);
    assert.equal(v.payload.previous, 'v1.12');
    assert.equal(v.payload.codeCommits, 1, 'only the code after the previous close, never v1.4–v1.12');
    assert.deepEqual(v.payload.uncoveredCommits.map((c) => c.sha), [current]);
    assert.equal(v.payload.reviewSince, closedAt);
  });

  test('the previous milestone tagged after its archive under a prefix scheme (polyglot-v4.4) → that tag is nearer', () => {
    codeCommit(dir);
    archive('v4.4');
    commit(dir, '.planning/MILESTONES.md', '# v4.4\n', 'docs: close v4.4');
    git(dir, ['tag', 'polyglot-v4.4']);
    codeCommit(dir);
    const v = evaluate(dir, 'v4.5');
    assert.equal(v.payload.baseFrom, 'tag');
    assert.equal(v.payload.baseTag, 'polyglot-v4.4');
    assert.equal(v.payload.codeCommits, 1);
  });

  test('the milestone being closed is excluded from the archive candidates (a re-run after archiving)', () => {
    const prev = archive('v1.0');
    codeCommit(dir);
    archive('v1.1');
    assert.equal(evaluate(dir, 'v1.1').payload.base, prev);
  });

  test('nothing archived, repo_tagging per_repo: a v* tag here is not the milestone base', () => {
    put(dir, '.planning/config.json', JSON.stringify({ git: { repo_tagging: 'per_repo' } }));
    codeCommit(dir);
    git(dir, ['tag', 'v0.9']);
    codeCommit(dir);
    assert.notEqual(evaluate(dir, 'v1.0').payload.baseFrom, 'tag');
  });

  test('a shallow clone could not look at the history → unreadable, never "the whole history"', (t) => {
    codeCommit(dir);
    codeCommit(dir);
    const shallow = createTempDir('milestone-review-shallow-');
    t.after(() => cleanup(shallow));
    gitOrThrow(['clone', '-q', '--depth', '1', `file://${dir}`, path.join(shallow, 'c')], { cwd: shallow });
    const v = evaluate(path.join(shallow, 'c'));
    assert.equal(v.outcome, 'unreadable');
    assert.match(v.payload.message, /shallow/);
  });
});

describe('milestone-review in a monorepo with a nested project', () => {
  let root;
  beforeEach(() => { root = createTempGitProject('milestone-review-mono-'); });
  afterEach(() => { cleanup(root); });

  test('a nested .planning has its own history; other projects\' planning commits are not code', () => {
    const app = path.join(root, 'apps', 'polyglot');
    commit(root, 'apps/polyglot/src/old.js', 'old\n', 'feat: before gsd in polyglot');
    git(root, ['tag', 'v9.0']);
    const before = commit(root, 'apps/polyglot/src/older.js', 'older\n', 'feat: still before gsd');
    commit(root, 'apps/polyglot/.planning/PROJECT.md', '# polyglot\n', 'docs: start planning polyglot');
    const work = commit(root, 'apps/polyglot/src/new.js', 'new\n', 'feat: planned work');
    commit(root, 'apps/polyglot/.planning/phases/01-a/01-01-SUMMARY.md', 'x\n', 'docs: summary');
    commit(root, 'apps/other/.planning/STATE.md', 'x\n', 'docs: another project');
    const v = evaluate(app, 'v1.0');
    assert.equal(v.payload.baseFrom, 'planning-start');
    assert.equal(v.payload.base, before);
    assert.deepEqual(v.payload.uncoveredCommits.map((c) => c.sha), [work]);
  });

  test('at the repository root, commits that only touch a nested .planning are not code', () => {
    git(root, ['tag', 'v1.0']);
    commit(root, 'apps/polyglot/.planning/STATE.md', 'x\n', 'docs: nested planning only');
    const v = evaluate(root, 'v1.1');
    assert.equal(v.payload.status, 'no-change');
  });
});

// ─── Fail closed on what a REVIEW.md claims ──────────────────────────────────

describe('milestone-review trusts only a composed review', () => {
  let dir;
  beforeEach(() => { dir = createTempGitProject('milestone-review-trust-'); });
  afterEach(() => { cleanup(dir); });

  test('a tip that is not a full sha covers nothing', () => {
    const tip = codeCommit(dir);
    windowReview(dir, '2026-10-20', { base: null, tip: tip.slice(0, 12), status: 'clean' });
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.match(v.payload.ignoredReviews[0].reason, /full commit sha/);
  });

  for (const status of ['partial', 'pending', '']) {
    test(`status ${JSON.stringify(status)} covers nothing`, () => {
      const tip = codeCommit(dir);
      windowReview(dir, '2026-10-20', { base: null, tip, status });
      assert.equal(evaluate(dir).block, true);
    });
  }

  test('a review with no lens section covers nothing', () => {
    const tip = codeCommit(dir);
    put(dir, '.planning/reviews/2026-10-20-window/REVIEW.md', `---\ntip: "${tip}"\nbase: null\nstatus: clean\n---\n\n# Window Review\n`);
    const v = evaluate(dir);
    assert.equal(v.block, true);
    assert.match(v.payload.ignoredReviews[0].reason, /lens/);
  });

  test('a REVIEW-FIX.md commit counts only when it descends from the tip; every sha on the line counts', () => {
    const early = codeCommit(dir, 'feat: before the window');
    const base = codeCommit(dir, 'feat: window base');
    const tip = codeCommit(dir, 'feat: reviewed');
    const fixA = codeCommit(dir, 'fix: CR-01 part a');
    const fixB = codeCommit(dir, 'fix: CR-01 part b');
    windowReview(dir, '2026-10-20', { base, tip, status: 'clean', fixed: ['CR-01'], fixCommits: [`${fixA.slice(0, 7)}, ${fixB.slice(0, 7)}`, early] });
    windowReview(dir, '2026-10-19', { base: null, tip: base, status: 'clean' });
    const v = evaluate(dir);
    assert.deepEqual(v.payload.uncoveredCommits.map((c) => c.sha), [], JSON.stringify(v.payload.uncoveredCommits));
    // `early` is named on a Commit line but precedes the tip: it is covered only by the earlier window.
    windowReview(dir, '2026-10-19', { base: early, tip: base, status: 'clean' });
    assert.deepEqual(evaluate(dir).payload.uncoveredCommits.map((c) => c.sha), [early]);
  });
});

describe('milestoneWindowStart', () => {
  test('a git failure is no start, not an exception', (t) => {
    const dir = createTempDir('milestone-window-start-');
    t.after(() => cleanup(dir));
    const failing = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null, timedOut: false });
    assert.equal(milestoneWindowStart(dir, 'v1.0', failing), null);
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
