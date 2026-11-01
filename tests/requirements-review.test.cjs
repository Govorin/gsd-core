'use strict';

/**
 * Requirements review (capability mn-requirements-review, ADR-5212) — the deterministic half and
 * its roadmap:pre gate.
 *
 * Pure units (`requirements-review.cjs`): lens parsing, the lens and refuter grammars, compose and
 * the gate's judgement. CLI (`gsd-tools requirements-review …`, `check mn-requirements-review`,
 * `loop render-hooks roadmap:pre`): typed JSON output and exit codes, never stdout prose.
 *
 * The gate blocks on a count of unaccepted critical findings, so its boundary is pinned at 0 (pass)
 * and 1 (block), and at 2 with one accepted (block) and both accepted (pass).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { exitCodeFor } = require('../gsd-core/bin/lib/exit-code-registry.cjs');
const rr = require('../gsd-core/bin/lib/requirements-review.cjs');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const WORKFLOWS = path.join(ROOT, 'gsd-core', 'workflows');

const REQUIREMENTS = [
  '# Requirements',
  '',
  '## v1.2 Requirements',
  '',
  '- [ ] **MIG-01**: User data moves to the new schema',
  '- [ ] **API-02**: Login requires a device token',
  '',
].join('\n');

/** A lens report with the given findings: `[severity prefix, title, requirement]`. */
function lensReport(lens, findings) {
  const blocks = findings.map(([prefix, title, req], i) =>
    [`### ${prefix}-0${i + 1}: ${title}`, '', `**Requirement:** \`${req}\``, '**Quote:** "x"', '**Issue:** y', '**Fix:** z'].join('\n'));
  return [`---\nlens: ${lens}\n---`, '', `# Requirements Review — ${lens} lens`, '', ...blocks, ''].join('\n');
}

function run(overrides = {}) {
  return {
    version: 1,
    milestone: 'v1.2',
    requirements: '.planning/REQUIREMENTS.md',
    requirementsSha256: rr.requirementsDigest(REQUIREMENTS),
    requirementIds: ['MIG-01', 'API-02'],
    requirementDigests: {
      'MIG-01': rr.requirementTextDigest('User data moves to the new schema'),
      'API-02': rr.requirementTextDigest('Login requires a device token'),
    },
    lenses: ['data', 'compat'],
    preparedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function compose(reports, { refutation = null, accepted = [], runOverrides = {} } = {}) {
  return rr.composeReview({ run: run(runOverrides), reports, refutation, accepted, reviewedAt: '2026-11-01T00:00:00.000Z' });
}

function acceptedRisk(fingerprint, milestone = 'v1.2') {
  return { fingerprint, id: 'CR-01', lens: 'compat', title: 't', reason: 'known', milestone, acceptedAt: '2026-11-01T00:00:00.000Z' };
}

// ─── Pure units ──────────────────────────────────────────────────────────────

describe('parseLenses', () => {
  test('accepts a comma list or an array, canonical order, duplicates folded', () => {
    assert.deepEqual(rr.parseLenses('testability, data,data'), { ok: true, lenses: ['data', 'testability'] });
    assert.deepEqual(rr.parseLenses(['security', 'compat']), { ok: true, lenses: ['compat', 'security'] });
  });

  test('an unknown lens is an error, never narrowed to the known ones', () => {
    const r = rr.parseLenses('data,perf');
    assert.equal(r.ok, false);
    assert.match(r.message, /unknown lens perf/);
  });

  test('an empty list, or not a list at all, is an error', () => {
    assert.equal(rr.parseLenses(' , ').ok, false);
    assert.equal(rr.parseLenses(undefined).ok, false);
    assert.equal(rr.parseLenses(42).ok, false);
  });
});

describe('lens and refuter grammars', () => {
  test('a lens finding carries its severity, title and requirement', () => {
    const [cr, wr] = rr.parseLensFindings(lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02'], ['WR', 'Ambiguous', 'MIG-01']]));
    assert.deepEqual([cr.id, cr.severity, cr.title, cr.requirement], ['CR-01', 'critical', 'Gate breaks released apps', 'API-02']);
    assert.deepEqual([wr.id, wr.severity], ['WR-02', 'warning']);
  });

  test('a refuter heading without a readable verdict is UPHELD', () => {
    const verdicts = rr.parseRefutation('## REFUTATION COMPLETE\n\n### compat CR-01: x\nverdict: REFUTED\nevidence: v3 sends it\n\n### data WR-01: y\nevidence: none\n');
    assert.deepEqual(verdicts.map((v) => [v.lens, v.id, v.verdict]), [['compat', 'CR-01', 'refuted'], ['data', 'WR-01', 'upheld']]);
  });

  test('the fingerprint binds lens, requirement IDs and their text — never the title', () => {
    const a = rr.findingFingerprint('compat', '`API-02`', run());
    assert.equal(a, rr.findingFingerprint('compat', 'API-02 (login)', run()), 'how the reference is written does not matter');
    assert.notEqual(a, rr.findingFingerprint('data', 'API-02', run()));
    assert.notEqual(a, rr.findingFingerprint('compat', 'MIG-01', run()));
    const edited = run({ requirementDigests: { ...run().requirementDigests, 'API-02': rr.requirementTextDigest('Login requires a device token after v4') } });
    assert.notEqual(a, rr.findingFingerprint('compat', 'API-02', edited), 'a changed requirement text is a new identity');
    assert.equal(rr.findingFingerprint('compat', 'API-02', run({ requirementDigests: { ...run().requirementDigests, 'MIG-01': 'other' } })), a, 'another requirement\'s edit does not touch it');
  });

  test('a cross-cutting finding binds to the whole requirements digest', () => {
    const a = rr.findingFingerprint('security', 'cross-cutting', run());
    assert.notEqual(a, rr.findingFingerprint('security', 'cross-cutting', run({ requirementsSha256: 'other' })));
  });

  test('the requirements digest does not move with line endings', () => {
    assert.equal(rr.requirementsDigest(REQUIREMENTS.replace(/\n/g, '\r\n')), rr.requirementsDigest(REQUIREMENTS));
  });
});

describe('composeReview', () => {
  test('a refuted finding leaves the sections; an unverified critical blocks', () => {
    const reports = [
      { lens: 'data', text: lensReport('data', [['WR', 'Backfill unstated', 'MIG-01']]) },
      { lens: 'compat', text: lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02'], ['CR', 'Webhook renamed', 'API-02']]) },
    ];
    const refuted = compose(reports, { refutation: '### compat CR-02: Webhook renamed\nverdict: REFUTED\nevidence: versioned\n' });
    assert.equal(refuted.counts.refuted, 1);
    assert.equal(refuted.counts.blocking, 1);
    assert.equal(refuted.counts.unverified, 2, 'findings the refuter did not name stay unverified');
    assert.equal(refuted.findings.find((f) => f.severity === 'critical').verification, 'unverified');

    const noRefuter = compose(reports);
    assert.equal(noRefuter.counts.blocking, 2, 'without a refutation every critical finding still blocks');
    assert.equal(noRefuter.status, 'issues_found');
  });

  test('an accepted critical finding is counted, carried, and does not block — for its own milestone only', () => {
    const reports = [{ lens: 'compat', text: lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02']]) }];
    const fp = rr.findingFingerprint('compat', 'API-02', run());
    const accepted = compose(reports, { accepted: [acceptedRisk(fp)] });
    assert.deepEqual([accepted.counts.accepted, accepted.counts.blocking], [1, 0]);
    assert.match(accepted.text, /_Accepted as a known risk: known_/);
    const otherMilestone = compose(reports, { accepted: [acceptedRisk(fp, 'v1.1')] });
    assert.equal(otherMilestone.counts.blocking, 1);
  });

  test('an acceptance survives a re-run that words the finding differently, and is released when the requirement text changes', () => {
    const fp = rr.findingFingerprint('compat', 'API-02', run());
    const reworded = [{ lens: 'compat', text: lensReport('compat', [['CR', 'Released iOS 3.x clients cannot log in', 'API-02']]) }];
    assert.equal(compose(reworded, { accepted: [acceptedRisk(fp)] }).counts.blocking, 0);
    const edited = { requirementDigests: { ...run().requirementDigests, 'API-02': rr.requirementTextDigest('Login requires a device token for every client') } };
    assert.equal(compose(reworded, { accepted: [acceptedRisk(fp)], runOverrides: edited }).counts.blocking, 1);
  });

  test('a lens that wrote nothing is named, and with no findings the review is incomplete, not clean', () => {
    const r = compose([{ lens: 'data', text: lensReport('data', []) }, { lens: 'compat', text: null }]);
    assert.deepEqual([r.status, r.missingReports], ['incomplete', ['compat']]);
    assert.equal(compose([{ lens: 'data', text: lensReport('data', []) }]).status, 'clean');
  });
});

describe('judgeReview — the gate boundary', () => {
  const reportWith = (criticals) => [{ lens: 'compat', text: lensReport('compat', criticals.map((t) => ['CR', t, t === 'B' ? 'MIG-01' : 'API-02'])) }];
  // Each critical about its own requirement, so each has its own identity.
  const reqOf = (t) => (t === 'B' ? 'MIG-01' : 'API-02');
  const fp = (title) => rr.findingFingerprint('compat', reqOf(title), run());

  test('0 unaccepted critical findings pass, 1 blocks', () => {
    assert.equal(rr.judgeReview(compose(reportWith([])).text, REQUIREMENTS, []).kind, 'pass');
    const one = rr.judgeReview(compose(reportWith(['A'])).text, REQUIREMENTS, []);
    assert.deepEqual([one.kind, one.blocking.map((b) => b.id)], ['blocking', ['CR-01']]);
  });

  test('2 critical with 1 accepted still blocks; with both accepted it passes', () => {
    const text = compose(reportWith(['A', 'B'])).text;
    assert.equal(rr.judgeReview(text, REQUIREMENTS, [acceptedRisk(fp('A'))]).kind, 'blocking');
    const both = rr.judgeReview(text, REQUIREMENTS, [acceptedRisk(fp('A')), acceptedRisk(fp('B'))]);
    assert.deepEqual([both.kind, both.accepted], ['pass', 2]);
  });

  test('warnings alone never block', () => {
    const text = compose([{ lens: 'data', text: lensReport('data', [['WR', 'W', 'MIG-01'], ['IN', 'I', 'MIG-01']]) }]).text;
    assert.deepEqual(rr.judgeReview(text, REQUIREMENTS, []), { kind: 'pass', warnings: 1, total: 2, accepted: 0 });
  });

  test('a review of other requirements is stale; a document without the digest is malformed', () => {
    const text = compose(reportWith([])).text;
    assert.equal(rr.judgeReview(text, `${REQUIREMENTS}- [ ] **X-03**: more\n`, []).kind, 'stale');
    assert.equal(rr.judgeReview('# not a review\n', REQUIREMENTS, []).kind, 'malformed');
  });

  test('a missing lens report blocks as incomplete when nothing critical is open', () => {
    const text = compose([{ lens: 'data', text: lensReport('data', []) }, { lens: 'compat', text: null }]).text;
    assert.deepEqual(rr.judgeReview(text, REQUIREMENTS, []), { kind: 'incomplete', missing: ['compat'] });
  });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

function cli(dir, args) {
  const result = runNode([TOOLS, ...args, '--raw', '--json-errors', '--cwd', dir], { cwd: dir });
  assert.equal(result.outcome, OUTCOME.EXITED, result.stderr);
  return result;
}

function ok(dir, args) {
  const result = cli(dir, args);
  assert.equal(result.exitCode, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function refusal(dir, args) {
  const result = cli(dir, args);
  assert.notEqual(result.exitCode, 0, `${args.join(' ')} must fail: ${result.stdout}`);
  return JSON.parse(result.stderr.trim());
}

/** The gate: a delivered verdict exits 0; only could-not-look exits 69 (UNAVAILABLE). */
function gate(dir) {
  const result = cli(dir, ['check', 'mn-requirements-review']);
  return { exitCode: result.exitCode, payload: JSON.parse(result.stdout) };
}

function writeReports(dir, reports) {
  for (const [lens, text] of Object.entries(reports)) {
    fs.writeFileSync(path.join(dir, '.planning', 'requirements-review', `REVIEW-${lens}.md`), text);
  }
}

describe('requirements-review CLI and the mn-requirements-review gate', () => {
  let dir;
  beforeEach(() => {
    dir = createTempProject('gsd-req-review-');
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { requirements_review_lenses: 'data,compat' } }));
    fs.writeFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), REQUIREMENTS);
  });
  afterEach(() => cleanup(dir));

  test('prepare records the run with the configured lenses and removes an earlier run\'s reports', () => {
    fs.mkdirSync(path.join(dir, '.planning', 'requirements-review'));
    writeReports(dir, { security: 'old', data: 'old' });
    fs.writeFileSync(path.join(dir, '.planning', 'requirements-review', 'REFUTATION.md'), 'old');
    const prep = ok(dir, ['requirements-review', 'prepare', '--milestone', 'v1.2']);
    assert.deepEqual(prep.reports.map((r) => r.lens), ['data', 'compat']);
    assert.equal(prep.requirementCount, 2);
    assert.deepEqual(prep.removed.sort(), ['REFUTATION.md', 'REVIEW-data.md', 'REVIEW-security.md']);
    const record = JSON.parse(fs.readFileSync(path.join(dir, prep.run), 'utf8'));
    assert.deepEqual([record.milestone, record.requirementIds], ['v1.2', ['MIG-01', 'API-02']]);
  });

  test('prepare refuses an unknown lens and a missing REQUIREMENTS.md', () => {
    assert.equal(refusal(dir, ['requirements-review', 'prepare', '--lens', 'data,perf']).reason, 'usage');
    fs.unlinkSync(path.join(dir, '.planning', 'REQUIREMENTS.md'));
    assert.equal(refusal(dir, ['requirements-review', 'prepare']).cause, 'no-requirements');
  });

  test('no review yet holds the roadmap as a delivered verdict (exit 0)', () => {
    const { exitCode, payload } = gate(dir);
    assert.deepEqual([exitCode, payload.block, payload.status], [0, true, 'unresolvable']);
  });

  test('a surviving critical finding blocks; accepting it with a reason lets the roadmap proceed', () => {
    ok(dir, ['requirements-review', 'prepare', '--milestone', 'v1.2']);
    writeReports(dir, {
      data: lensReport('data', [['WR', 'Backfill unstated', 'MIG-01']]),
      compat: lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02']]),
    });
    const composed = ok(dir, ['requirements-review', 'compose']);
    assert.deepEqual(composed.blocking.map((b) => b.id), ['CR-01']);

    const blocked = gate(dir);
    assert.deepEqual([blocked.exitCode, blocked.payload.block, blocked.payload.status], [0, true, 'finding']);
    assert.deepEqual(blocked.payload.blocking.map((b) => b.id), ['CR-01']);

    assert.equal(refusal(dir, ['requirements-review', 'accept', 'CR-01']).reason, 'usage', 'no reason');
    assert.equal(refusal(dir, ['requirements-review', 'accept', 'WR-01', '--reason', 'x']).reason, 'usage', 'not critical');
    assert.equal(refusal(dir, ['requirements-review', 'accept', 'CR-09', '--reason', 'x']).cause, 'unknown-id');

    const accepted = ok(dir, ['requirements-review', 'accept', 'CR-01', '--reason', 'clients force-update']);
    assert.deepEqual([accepted.compose.counts.accepted, accepted.compose.blocking], [1, []]);
    const passed = gate(dir);
    assert.deepEqual([passed.exitCode, passed.payload.block, passed.payload.status], [0, false, 'pass']);
  });

  test('editing REQUIREMENTS.md after the review holds the roadmap again', () => {
    ok(dir, ['requirements-review', 'prepare']);
    writeReports(dir, { data: lensReport('data', []), compat: lensReport('compat', []) });
    ok(dir, ['requirements-review', 'compose']);
    assert.equal(gate(dir).payload.block, false);
    fs.appendFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), '- [ ] **X-03**: more\n');
    const stale = gate(dir).payload;
    assert.deepEqual([stale.block, stale.status], [true, 'unresolvable']);
    assert.ok(stale.currentSha256 !== stale.reviewedSha256);
  });

  // Regression (review blocker): with no milestone the review wrote `milestone: null`, which the
  // frontmatter reader returns as the string "null", so an acceptance (milestone null) never matched
  // and the gate held the roadmap forever — the path the gate's own message proposes and new-project takes.
  test('without --milestone and without STATE.md: prepare → compose → accept → check passes', () => {
    const prep = ok(dir, ['requirements-review', 'prepare']);
    assert.equal(prep.milestone, null);
    writeReports(dir, { data: lensReport('data', []), compat: lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02']]) });
    ok(dir, ['requirements-review', 'compose']);
    assert.equal(gate(dir).payload.status, 'finding');
    ok(dir, ['requirements-review', 'accept', 'CR-01', '--reason', 'no client is released']);
    const passed = gate(dir);
    assert.deepEqual([passed.exitCode, passed.payload.block, passed.payload.status], [0, false, 'pass']);
  });

  test('without --milestone the run takes the milestone STATE.md names', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\nmilestone: v1.3\nstatus: planning\n---\n\n# State\n');
    assert.equal(ok(dir, ['requirements-review', 'prepare']).milestone, 'v1.3');
  });

  test('--lens over the same requirements re-runs only that lens and keeps the other reports', () => {
    ok(dir, ['requirements-review', 'prepare', '--milestone', 'v1.2']);
    writeReports(dir, { data: lensReport('data', [['WR', 'Backfill unstated', 'MIG-01']]), compat: lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02']]) });
    fs.writeFileSync(path.join(dir, '.planning', 'requirements-review', 'REFUTATION.md'), 'old');
    const again = ok(dir, ['requirements-review', 'prepare', '--lens', 'compat']);
    assert.deepEqual([again.mode, again.milestone, again.reports.map((r) => r.lens), again.kept], ['partial', 'v1.2', ['compat'], ['data']]);
    assert.deepEqual(again.removed.sort(), ['REFUTATION.md', 'REVIEW-compat.md']);
    assert.ok(fs.existsSync(path.join(dir, '.planning', 'requirements-review', 'REVIEW-data.md')));
    writeReports(dir, { compat: lensReport('compat', []) });
    const composed = ok(dir, ['requirements-review', 'compose']);
    assert.deepEqual([composed.counts.warning, composed.missingReports, composed.blocking], [1, [], []], 'the kept data report is still composed');
  });

  test('--lens after the requirements changed is a fresh run: nothing of the old run is kept', () => {
    ok(dir, ['requirements-review', 'prepare']);
    writeReports(dir, { data: lensReport('data', []), compat: lensReport('compat', []) });
    fs.appendFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), '- [ ] **X-03**: more\n');
    const fresh = ok(dir, ['requirements-review', 'prepare', '--lens', 'compat']);
    assert.deepEqual([fresh.mode, fresh.kept], ['full', []]);
    assert.ok(!fs.existsSync(path.join(dir, '.planning', 'requirements-review', 'REVIEW-data.md')));
  });

  test('the gate names what to re-run: the blocking lenses, the missing ones, or everything', () => {
    ok(dir, ['requirements-review', 'prepare']);
    writeReports(dir, { compat: lensReport('compat', [['CR', 'Gate breaks released apps', 'API-02']]) });
    ok(dir, ['requirements-review', 'compose']);
    const blocked = gate(dir).payload;
    assert.deepEqual(blocked.rerun, ['compat', 'data'], 'the blocking lens and the lens that wrote nothing');
    assert.match(blocked.message, /--from-roadmap/);
    writeReports(dir, { compat: lensReport('compat', []) });
    ok(dir, ['requirements-review', 'compose']);
    assert.deepEqual(gate(dir).payload.rerun, ['data']);
    fs.appendFileSync(path.join(dir, '.planning', 'REQUIREMENTS.md'), '- [ ] **X-03**: more\n');
    assert.deepEqual(gate(dir).payload.rerun, [], 'stale: the whole review runs again');
  });

  // A greenfield project: nothing released, no schema. The lens rules say such a lens reports clean;
  // reports of that shape compose to a review the gate lets through, so new-project --auto proceeds.
  test('greenfield: lenses with nothing to check report clean, and the gate passes', () => {
    ok(dir, ['requirements-review', 'prepare', '--milestone', 'v1.0']);
    const clean = (lens, why) => `---\nlens: ${lens}\nstatus: clean\n---\n\n# Requirements Review — ${lens} lens\n\n${why}\n`;
    writeReports(dir, {
      data: clean('data', 'No persisted schema yet: no migrations directory, no schema files.'),
      compat: clean('compat', 'Nothing released: no tag, no client, no published contract.'),
    });
    const composed = ok(dir, ['requirements-review', 'compose']);
    assert.deepEqual([composed.status, composed.counts.total], ['clean', 0]);
    assert.deepEqual([gate(dir).payload.block, gate(dir).payload.status], [false, 'pass']);
  });

  test('a review that cannot be read is could-not-look: exit 69', () => {
    fs.mkdirSync(path.join(dir, '.planning', 'REQUIREMENTS-REVIEW.md'));
    const { exitCode, payload } = gate(dir);
    assert.deepEqual([exitCode, payload.block, payload.status], [exitCodeFor('UNAVAILABLE'), true, 'unresolvable']);
  });
});

describe('roadmap:pre rendering', () => {
  let dir;
  beforeEach(() => { dir = createTempProject('gsd-req-review-loop-'); });
  afterEach(() => cleanup(dir));

  const hooks = (d) => ok(d, ['loop', 'render-hooks', 'roadmap:pre']).activeHooks.filter((h) => h.capId === 'mn-requirements-review');

  test('absent config: the review step and its blocking gate render (on by default)', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
    const active = hooks(dir);
    assert.deepEqual(active.map((h) => h.kind), ['step', 'gate']);
    assert.deepEqual(active[0].ref, { skill: 'requirements-review' });
    assert.deepEqual([active[1].check, active[1].blocking, active[1].onError], [{ query: 'mn-requirements-review' }, true, 'halt']);
  });

  test('workflow.requirements_review false renders neither', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { requirements_review: false } }));
    assert.deepEqual(hooks(dir), []);
  });
});

// ─── The hosts and the workflow (their text is what the runtime loads) ──────

describe('hosts run roadmap:pre between the requirements commit and the roadmapper', () => {
  const read = (f) => fs.readFileSync(path.join(WORKFLOWS, f), 'utf8');

  for (const [file, commit, roadmapper] of [
    ['new-milestone.md', 'docs: define milestone v[X.Y] requirements', 'subagent_type="gsd-roadmapper"'],
    ['new-project.md', 'docs: define v1 requirements', '## 8. Create Roadmap'],
  ]) {
    test(`${file}: after the requirements commit, before the roadmapper, and auto mode stops instead of asking`, () => {
      const text = read(file);
      const at = text.indexOf('loop render-hooks roadmap:pre');
      assert.ok(at > text.indexOf(commit) && text.indexOf(commit) !== -1, 'roadmap:pre must follow the requirements commit');
      assert.ok(at < text.indexOf(roadmapper), 'roadmap:pre must precede the roadmapper');
      const region = text.slice(at, text.indexOf(roadmapper));
      assert.match(region, /In auto mode stop the workflow there/);
      assert.match(region, /"Revise requirements"/);
      assert.match(region, /"Review again"[^"]*--lens <the gate's rerun/);
      assert.match(region, /--from-roadmap` resumes|`\/gsd:new-project` resumes/, 'Stop names the resume path');
    });
  }

  test('new-milestone resumes at step 9.5 with --from-roadmap; new-project resumes a missing roadmap at the hooks', () => {
    assert.match(read('new-milestone.md'), /`--from-roadmap` flag → resume[^\n]*continue at step 9\.5/);
    assert.match(read('new-project.md'), /a missing `ROADMAP\.md` resumes at the requirements hooks/);
  });

  test('the lens agent reports clean when there is nothing to check, and high-level is never critical', () => {
    const agent = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-requirements-reviewer.md'), 'utf8');
    assert.match(agent, /\*\*`compat`\*\* — nothing released[^\n]*→ clean/);
    assert.match(agent, /\*\*`data`\*\* — no persisted schema yet[^\n]*→ clean/);
    assert.match(agent, /high level[^\n]*never a critical finding/);
    assert.match(agent, /git log --all --oneline -- <migrations dir>/);
  });

  test('the review workflow asks nothing in auto mode and accepts only what the user picked', () => {
    const text = read('requirements-review.md');
    assert.match(text, /\*\*Auto mode:\*\* ask nothing/);
    assert.match(text, /Never accept a finding the user did not pick/);
  });
});
