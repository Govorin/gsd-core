'use strict';

/**
 * Unit tests for arch-survey.cjs (built from src/arch-survey.cts) — the deterministic glue between
 * the model steps of `/gsd:arch-survey` (pocock-practices design, D1).
 *
 * The properties pinned here:
 *   - a candidate's id depends only on its kind and its normalised file set;
 *   - a path that is absolute or climbs out of the root is a problem, never normalised away;
 *   - a Strong card without a deletion test that concentrates complexity is demoted, visibly;
 *   - a card naming a missing file fails the check before any refuter is asked;
 *   - a rejected id is excluded; an accepted one stays, marked; two zones proposing the same id
 *     merge; the order is strength, then zone, then the surveyor's own order;
 *   - a zone's verdict is computed from its surviving cards, and a contradicting claim is flagged;
 *   - malformed cards and files are reported, not dropped;
 *   - refuter replies map back by number and title; a missing or mismatched reply is never
 *     treated as a verdict;
 *   - the decision journal round-trips, replaces a block in place, and keeps blocks it cannot parse;
 *   - the report data: verdict, top recommendation, and diagrams drawn from the metrics only
 *     (every diagram parses with the mermaid subset parser).
 *
 * Assertions read typed values (the candidate set, the journal entries, the `SurveyDoc` IR and
 * its flowchart specs) — never the rendered markdown.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const as = require('../gsd-core/bin/lib/arch-survey.cjs');
const { flowchart, DEFECT_LINK_STYLE } = require('../gsd-core/bin/lib/mermaid.cjs');
const { parseMermaid } = require('../gsd-core/bin/lib/mermaid-parse.cjs');

const DATE = '2026-10-05';

let root;
beforeEach(() => {
  root = createTempDir('gsd-archsurvey-');
  for (const f of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), 'export {};\n');
  }
});
afterEach(() => {
  cleanup(root);
});

function card(over = {}) {
  return {
    title: 'Deepen the order intake',
    kind: 'shallow-module',
    files: ['src/a.ts', 'src/b.ts'],
    problem: 'Understanding intake means reading both modules.',
    solution: 'Merge them behind one interface.',
    benefits: 'Locality: one place to change.',
    tests: 'Tests cross one seam.',
    strength: 'worth-exploring',
    deletionTest: { result: 'concentrates', evidence: 'three callers would re-implement validation' },
    adrConflict: null,
    ...over,
  };
}

const ZONES = [{ id: 'z1' }, { id: 'z2' }, { id: 'z3' }];

function source(zone, doc) {
  return { source: `cards-${zone}.json`, zone, content: doc, parseError: null };
}

function collect(sources, decisions = []) {
  return as.collectCandidates({ root, date: DATE, zones: ZONES, sources, decisions });
}

describe('arch-survey: files and ids', () => {
  test('files are normalised, deduplicated and sorted', () => {
    assert.deepEqual(as.normalizeFiles(['./src/b.ts', 'src\\a.ts', 'src/b.ts', 'src/x/../a.ts']).files, ['src/a.ts', 'src/b.ts']);
  });

  test('absolute paths, `..` and empty lists are problems', () => {
    assert.equal(as.normalizeFiles(['/etc/passwd', '../up.ts', 'C:/x.ts', 'ok.ts']).problems.length, 3);
    assert.equal(as.normalizeFiles([]).problems.length, 1);
    assert.equal(as.normalizeFiles('src/a.ts').problems.length, 1);
  });

  test('the id depends on the kind and the file set only', () => {
    const id = as.candidateId('shallow-module', ['src/b.ts', './src/a.ts']);
    assert.match(id, /^arch-[0-9a-f]{12}$/);
    assert.equal(as.candidateId('shallow-module', ['src/a.ts', 'src/b.ts']), id);
    assert.notEqual(as.candidateId('pass-through', ['src/a.ts', 'src/b.ts']), id);
    assert.notEqual(as.candidateId('shallow-module', ['src/a.ts']), id);
  });
});

describe('arch-survey: collecting cards', () => {
  test('a Strong card without a concentrating deletion test is demoted, and says so', () => {
    const set = collect([source('z1', { cards: [
      card({ title: 'moves', strength: 'strong', deletionTest: { result: 'moves', evidence: 'x' } }),
      card({ title: 'no evidence', files: ['src/c.ts'], strength: 'strong', deletionTest: { result: 'concentrates', evidence: '' } }),
      card({ title: 'kept', files: ['src/d.ts'], strength: 'strong' }),
    ] })]);
    assert.deepEqual(set.candidates.map((c) => [c.title, c.strength, c.demoted]), [
      ['kept', 'strong', null],
      ['moves', 'worth-exploring', 'strong-without-deletion-test'],
      ['no evidence', 'worth-exploring', 'strong-without-deletion-test'],
    ]);
  });

  test('a card naming a missing file fails the check', () => {
    const set = collect([source('z1', { cards: [card({ files: ['src/a.ts', 'src/ghost.ts'] })] })]);
    assert.deepEqual(set.candidates, []);
    assert.deepEqual(set.failedCheck.map((f) => [f.reason, f.files]), [['missing-files', ['src/ghost.ts']]]);
  });

  test('a rejected id is excluded; an accepted one stays, marked', () => {
    const rejected = as.candidateId('shallow-module', ['src/a.ts', 'src/b.ts']);
    const accepted = as.candidateId('cycle', ['src/c.ts', 'src/d.ts']);
    const decisions = [
      { id: rejected, disposition: 'rejected', title: 't', kind: 'shallow-module', files: [], date: DATE, survey: null, reason: 'the split is deliberate', route: null },
      { id: accepted, disposition: 'accepted', title: 't', kind: 'cycle', files: [], date: DATE, survey: null, reason: null, route: 'phase 4' },
    ];
    const set = collect([source('z1', { cards: [card(), card({ kind: 'cycle', files: ['src/d.ts', 'src/c.ts'] })] })], decisions);
    assert.deepEqual(set.excludedByDecision.map((e) => [e.id, e.reason]), [[rejected, 'the split is deliberate']]);
    assert.deepEqual(set.candidates.map((c) => [c.id, c.priorDecision]), [[accepted, 'accepted']]);
  });

  test('the same id from two zones merges; order is strength, then zone, then card order', () => {
    const set = collect([
      source('z1', { cards: [card({ title: 'z1-spec', files: ['src/c.ts'], strength: 'speculative' }), card({ title: 'z1-worth' })] }),
      source('z2', { cards: [card({ title: 'z2-strong', files: ['src/d.ts'], strength: 'strong' }), card({ title: 'z2-dup' })] }),
    ]);
    assert.deepEqual(set.candidates.map((c) => c.title), ['z2-strong', 'z1-worth', 'z1-spec']);
    assert.deepEqual(set.candidates[1].alsoFrom, ['z2']);
  });

  test('a zone verdict is computed from surviving cards; a contradicting claim is flagged', () => {
    const set = collect([
      source('z1', { verdict: 'candidates', cards: [card({ strength: 'strong', deletionTest: { result: 'moves', evidence: 'e' } })] }),
      source('z2', { verdict: 'candidates', cards: [card({ files: ['src/d.ts'], strength: 'strong' })] }),
    ]);
    assert.deepEqual(set.zones, [
      { id: 'z1', status: 'reported', verdict: 'no-strong-candidates', verdictMismatch: true },
      { id: 'z2', status: 'reported', verdict: 'candidates', verdictMismatch: false },
      { id: 'z3', status: 'missing', verdict: null, verdictMismatch: false },
    ]);
  });

  test('malformed cards and files are reported with their problems', () => {
    const set = collect([
      source('z1', { cards: [card({ kind: 'vibes' }), card({ files: ['../out.ts'] }), 'nope'] }),
      { source: 'cards-z2.json', zone: 'z2', content: null, parseError: 'Unexpected token' },
      source('z3', { zone: 'z1', cards: [] }),
      source('z9', { cards: [] }),
    ]);
    assert.deepEqual(set.invalid.map((i) => [i.source, i.index]), [
      ['cards-z1.json', 0], ['cards-z1.json', 1], ['cards-z1.json', 2], ['cards-z2.json', null], ['cards-z3.json', null], ['cards-z9.json', null],
    ]);
    assert.deepEqual(set.zones.map((z) => z.status), ['reported', 'invalid', 'invalid']);
  });

  test('cards files are read in zone order; other files are ignored', () => {
    const dir = path.join(root, 'survey');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'cards-z10.json'), '{"cards":[]}');
    fs.writeFileSync(path.join(dir, 'cards-z2.json'), '{"cards":[]}');
    fs.writeFileSync(path.join(dir, 'cards-z1.json'), '{broken');
    fs.writeFileSync(path.join(dir, 'notes.json'), '{}');
    const sources = as.readCardSources(dir);
    assert.deepEqual(sources.map((s) => [s.zone, s.parseError === null]), [['z1', false], ['z2', true], ['z10', true]]);
    assert.deepEqual(as.readCardSources(path.join(root, 'absent')), []);
  });
});

describe('arch-survey: refutation', () => {
  function twoCandidates() {
    return collect([source('z1', { cards: [card({ title: 'First', strength: 'strong' }), card({ title: 'Second', files: ['src/c.ts'] })] })]);
  }

  test('replies map back by number and title', () => {
    const reply = [
      '## REFUTATION COMPLETE', '', 'upheld: 1', 'refuted: 1', '',
      '### Finding 1: First', 'verdict: UPHELD', 'evidence: src/a.ts:1 and src/b.ts:1 both validate',
      '  the order before intake.', '',
      '### Finding 2: Second', 'verdict: REFUTED', 'evidence: src/c.ts has one caller', '',
      'One more thing outside the block.',
    ].join('\n');
    const v = as.verifyCandidates(twoCandidates(), reply);
    assert.deepEqual(v, [
      { verdict: 'upheld', evidence: 'src/a.ts:1 and src/b.ts:1 both validate the order before intake.' },
      { verdict: 'refuted', evidence: 'src/c.ts has one caller' },
    ]);
  });

  test('a missing reply is unverified and a mismatched title is unmatched — neither is a verdict', () => {
    const reply = '### Finding 1: Something else\nverdict: REFUTED\nevidence: x\n';
    assert.deepEqual(as.verifyCandidates(twoCandidates(), reply).map((v) => v.verdict), ['unmatched', 'unverified']);
    assert.deepEqual(as.verifyCandidates(twoCandidates(), null).map((v) => v.verdict), ['unverified', 'unverified']);
  });
});

describe('arch-survey: decision journal', () => {
  const entry = (over = {}) => ({
    id: as.candidateId('shallow-module', ['src/a.ts']), disposition: 'rejected', title: 'Merge a', kind: 'shallow-module',
    files: ['src/a.ts'], date: DATE, survey: DATE, reason: 'kept apart\non purpose', route: null, ...over,
  });

  test('a first decision creates the journal; the entry round-trips with one-line fields', () => {
    const text = as.upsertDecision(null, entry());
    const { entries, unparsed } = as.parseDecisions(text);
    assert.equal(unparsed, 0);
    assert.deepEqual(entries, [{ ...entry(), reason: 'kept apart on purpose' }]);
  });

  test('a re-decision replaces its block in place; other entries keep their order', () => {
    const other = entry({ id: as.candidateId('cycle', ['src/b.ts']), title: 'Cycle b', kind: 'cycle', files: ['src/b.ts'], disposition: 'deferred', reason: null });
    let text = as.upsertDecision(null, entry());
    text = as.upsertDecision(text, other);
    text = as.upsertDecision(text, entry({ disposition: 'accepted', reason: null, route: 'phase 7' }));
    const { entries } = as.parseDecisions(text);
    assert.deepEqual(entries.map((e) => [e.title, e.disposition, e.route]), [['Merge a', 'accepted', 'phase 7'], ['Cycle b', 'deferred', null]]);
  });

  test('a block the parser does not understand is kept', () => {
    const hand = '# Architecture decisions\n\n### A note written by hand\nWe keep the adapters thin.\n';
    const text = as.upsertDecision(hand, entry());
    assert.deepEqual([as.parseDecisions(text).entries.length, as.parseDecisions(text).unparsed], [1, 1]);
    assert.deepEqual(as.parseDecisions(as.upsertDecision(text, entry({ disposition: 'deferred' }))).unparsed, 1);
  });

  test('a malformed id is refused', () => {
    assert.throws(() => as.renderDecisionBlock(entry({ id: 'arch-xyz' })), TypeError);
  });
});

// ─── Report data ─────────────────────────────────────────────────────────────

function metricsFixture() {
  return {
    schema: 1, date: DATE, scope: { paths: null, window: '90d', range: {} }, status: 'resolved', reasons: [],
    history: { status: 'resolved', reason: null, commits: 12 }, hotspotBasis: 'churn-x-complexity',
    hotspots: [{ file: 'src/a.ts', churn: 4, complexity: 3, score: 12 }],
    cycles: [{ members: ['src/a.ts', 'src/b.ts'], runtime: true }],
    coChange: [{ a: 'src/c.ts', b: 'src/d.ts', support: 3, confidence: 1, importLinked: false }],
    edges: [['src/a.ts', 'src/b.ts'], ['src/b.ts', 'src/a.ts'], ['src/b.ts', 'src/c.ts']],
    zones: [{ id: 'z1', seed: 'src/a.ts', label: 'src', score: 12, files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], signals: {} }],
  };
}

describe('arch-survey: report data', () => {
  test('diagrams are drawn from the metrics: cycle edges red, co-change without import dotted, hot spots marked', () => {
    const spec = as.structureSpec(metricsFixture(), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    const label = new Map(spec.nodes.map((n) => [n.id, n.label]));
    assert.deepEqual(spec.nodes.filter((n) => n.className === 'hot').map((n) => n.label), ['src/a.ts']);
    assert.deepEqual(spec.edges.map((e) => [label.get(e.from), label.get(e.to), e.line ?? 'solid', e.linkStyle ?? null]), [
      ['src/a.ts', 'src/b.ts', 'solid', DEFECT_LINK_STYLE],
      ['src/b.ts', 'src/a.ts', 'solid', DEFECT_LINK_STYLE],
      ['src/b.ts', 'src/c.ts', 'solid', null],
      ['src/c.ts', 'src/d.ts', 'dotted', null],
    ]);
    assert.equal(parseMermaid(flowchart(spec)).ok, true);
  });

  test('context neighbours are drawn greyed; edges never leave the drawn set', () => {
    const spec = as.structureSpec(metricsFixture(), ['src/c.ts'], ['src/b.ts']);
    assert.deepEqual(spec.nodes.map((n) => [n.label, n.className ?? null]), [['src/c.ts', null], ['src/b.ts', 'ctx']]);
    assert.equal(spec.edges.length, 1);
  });

  test('verdict and top recommendation follow verification', () => {
    const set = collect([source('z1', { cards: [card({ title: 'Strong one', strength: 'strong' }), card({ title: 'Weak one', files: ['src/c.ts'] })] })]);
    const refutedStrong = as.buildSurvey({ metrics: metricsFixture(), set, verification: [{ verdict: 'refuted', evidence: 'no' }, { verdict: 'upheld', evidence: 'yes' }] });
    assert.equal(refutedStrong.verdict, 'no-strong-candidates');
    assert.equal(refutedStrong.top, set.candidates[1].id);
    assert.deepEqual(refutedStrong.rejected.map((r) => [r.title, r.reason]), [['Strong one', 'refuted']]);
    assert.deepEqual(refutedStrong.kept.map((k) => k.candidate.title), ['Weak one']);

    const unverified = as.buildSurvey({ metrics: metricsFixture(), set, verification: as.verifyCandidates(set, null) });
    assert.deepEqual([unverified.verdict, unverified.top], ['candidates', set.candidates[0].id]);

    const noneUpheld = as.buildSurvey({ metrics: metricsFixture(), set, verification: [{ verdict: 'unmatched', evidence: null }, { verdict: 'unverified', evidence: null }] });
    assert.equal(noneUpheld.top, null);
  });

  test('every diagram of the report parses, and zone outcomes come from the candidate set', () => {
    const set = collect([source('z1', { cards: [card({ strength: 'strong' })] })]);
    const doc = as.buildSurvey({ metrics: metricsFixture(), set, verification: as.verifyCandidates(set, null) });
    assert.deepEqual(doc.zones.map((z) => [z.id, z.outcome]), [['z1', 'candidates']]);
    for (const spec of [...doc.zones.map((z) => z.diagram), ...doc.kept.map((k) => k.diagram)]) {
      assert.equal(parseMermaid(flowchart(spec)).ok, true);
    }
  });

  test('a verification list of the wrong length is refused', () => {
    const set = collect([source('z1', { cards: [card()] })]);
    assert.throws(() => as.buildSurvey({ metrics: metricsFixture(), set, verification: [] }), TypeError);
  });
});
