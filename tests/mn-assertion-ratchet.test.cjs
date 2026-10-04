'use strict';

/**
 * The assertion ratchet — `gsd_run check mn-assertion-ratchet` (src/gate-mn-assertion-ratchet.cts)
 * over the shared counter src/mn-assertion-count.cts. Replaces scripts/assertion-ratchet.mjs.
 *
 * It catches a failure nothing else does: a test that stops failing because the assertion was
 * removed from it. Deleting an assert makes the suite greener, and no green run reports it.
 *
 * The invariant is one-directional by design. A drop is allowed, but only when declared — the
 * baseline is re-recorded. The gate itself NEVER writes: the script created the baseline on its
 * first run, which let a gate be satisfied by deleting the file it judges against. Recording is
 * the baseline tool's job — `gsd_run mn assertion-baseline [--update]`, owned by the `mn` tool
 * family, which records through `recordAssertionBaseline` of the same module the gate counts and
 * reads with (its own tests pin the write path). Fixtures here record through that function, so
 * the gate is judged against exactly what the tool writes.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnAssertionRatchet } = require('../gsd-core/bin/lib/gate-mn-assertion-ratchet.cjs');
const { compareAssertionCounts } = require('../gsd-core/bin/lib/gate-mn-assertion-ratchet.cjs');
const { countAssertions, recordAssertionBaseline, BASELINE_PATH, DEFAULT_ROOTS } = require('../gsd-core/bin/lib/mn-assertion-count.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

describe('assertion ratchet', () => {
  let repo;
  /** Not a git work tree: the repository root falls back to the project directory. */
  const deps = { git: () => null };
  const baselineFile = () => path.join(repo, BASELINE_PATH);

  beforeEach(() => {
    repo = createMnProject('gsd-mn-assertion-ratchet-');
    fs.mkdirSync(path.join(repo, 'libs'), { recursive: true });
  });

  afterEach(() => {
    cleanup(repo);
  });

  /** Write a spec carrying a known number of assertions. */
  function writeSpec(name, assertionCount, extra = '') {
    const body = Array.from({ length: assertionCount }, (_, i) => `  expect(value${i}).toBe(${i});`).join('\n');
    fs.writeFileSync(path.join(repo, 'libs', name), `describe('suite', () => {\n  it('checks things', () => {\n${body}\n  });\n${extra}});\n`);
  }

  /** What `mn assertion-baseline --update` records: measure, then write. */
  function recordBaseline() {
    const written = recordAssertionBaseline({ repoRoot: repo, roots: DEFAULT_ROOTS.map((r) => path.join(repo, r)) });
    assert.equal(written.ok, true, JSON.stringify(written));
    return written.baseline;
  }

  const gate = () => evaluateMnAssertionRatchet({ projectDir: repo, args: [] }, deps).payload;

  // ── the gate ──────────────────────────────────────────────────────────────

  test('with no baseline the gate is unresolvable and names how to record one', () => {
    // A read-only gate cannot establish its own floor; blocking says so instead of passing blind.
    writeSpec('a.spec.ts', 5);
    const v = gate();
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.baselineProblem, 'missing');
    assert.equal(fs.existsSync(baselineFile()), false, 'the gate must never write the baseline');
  });

  test('holds when the assertion count is unchanged', () => {
    writeSpec('a.spec.ts', 5);
    recordBaseline();
    const v = gate();
    assert.equal(v.block, false);
    assert.equal(v.assertionDelta, 0);
  });

  test('holds when assertions are added', () => {
    // The ratchet is one-directional: growth is always fine.
    writeSpec('a.spec.ts', 5);
    recordBaseline();
    writeSpec('a.spec.ts', 9);
    const v = gate();
    assert.equal(v.block, false);
    assert.equal(v.assertionDelta, 4);
  });

  test('blocks when one assertion disappears — the smallest drop', () => {
    writeSpec('a.spec.ts', 8);
    recordBaseline();
    writeSpec('a.spec.ts', 7);
    const v = gate();
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual([v.baseline.assertions, v.current.assertions, v.assertionDelta], [8, 7, -1]);
  });

  test('blocks when assertions disappear without a record, reporting both counts', () => {
    // The numbers must appear, or the reader cannot tell a refactor from a gutting.
    writeSpec('a.spec.ts', 8);
    recordBaseline();
    writeSpec('a.spec.ts', 3);
    const v = gate();
    assert.equal(v.block, true);
    assert.deepEqual([v.baseline.assertions, v.current.assertions], [8, 3]);
  });

  test('blocks when a whole spec file is deleted', () => {
    writeSpec('a.spec.ts', 4);
    writeSpec('b.spec.ts', 4);
    recordBaseline();
    fs.unlinkSync(path.join(repo, 'libs', 'b.spec.ts'));
    assert.equal(gate().block, true);
  });

  test('blocks when a test is newly skipped, even with the assertion count intact', () => {
    // `it.skip` neither fails nor checks — the quiet equivalent of deletion.
    writeSpec('a.spec.ts', 4);
    recordBaseline();
    writeSpec('a.spec.ts', 4, "  it.skip('later', () => {});\n");
    const v = gate();
    assert.equal(v.block, true);
    assert.equal(v.skippedDelta, 1);
  });

  test('counts assertions across several files — the total, not per file', () => {
    writeSpec('a.spec.ts', 3);
    writeSpec('b.spec.ts', 4);
    recordBaseline();
    writeSpec('a.spec.ts', 1);
    writeSpec('b.spec.ts', 9);
    assert.equal(gate().block, false);
  });

  test('a re-recorded baseline lets an intended drop proceed', () => {
    // The escape hatch that keeps the gate honest: a legitimate refactor is declared, not tolerated.
    writeSpec('a.spec.ts', 8);
    recordBaseline();
    writeSpec('a.spec.ts', 3);
    assert.equal(gate().block, true);
    recordBaseline();
    assert.equal(gate().block, false, 'the recorded count becomes the new floor');
  });

  test('zero spec files is unresolvable, not a pass', () => {
    writeSpec('a.spec.ts', 3);
    recordBaseline();
    cleanup(path.join(repo, 'libs'));
    const v = gate();
    assert.equal(v.status, 'unresolvable');
  });

  test('a malformed baseline is unresolvable', () => {
    writeSpec('a.spec.ts', 3);
    fs.writeFileSync(baselineFile(), '{ not json');
    assert.equal(gate().status, 'unresolvable');
    assert.equal(gate().baselineProblem, 'unreadable');
    fs.writeFileSync(baselineFile(), JSON.stringify({ assertions: -1, skipped: 0, files: 1 }));
    assert.equal(gate().baselineProblem, 'unreadable');
  });

  test('baseline and spec roots are anchored at the repository root, not the project directory', () => {
    // GSD may run from a sub-project while the monorepo's specs — and the recorded baseline — live
    // above it. The gate must read where `mn assertion-baseline` writes.
    const project = path.join(repo, 'apps', 'rpg');
    fs.mkdirSync(path.join(project, '.planning'), { recursive: true });
    writeSpec('a.spec.ts', 2);
    recordBaseline();
    writeSpec('a.spec.ts', 1);
    const v = evaluateMnAssertionRatchet({ projectDir: project, args: [] }, { git: () => repo }).payload;
    assert.equal(v.status, 'finding');
    assert.equal(v.baselineFile, baselineFile());
  });

  test('the phase the dispatcher appends is ignored', () => {
    writeSpec('a.spec.ts', 2);
    recordBaseline();
    const v = evaluateMnAssertionRatchet({ projectDir: repo, args: ['.planning/phases/09-x', 'REQ-1'] }, deps).payload;
    assert.equal(v.block, false);
  });

  // ── the shared counter and the comparison rule ────────────────────────────

  test('countAssertions counts every assertion shape and prunes vendored trees', () => {
    fs.writeFileSync(
      path.join(repo, 'libs', 'shapes.spec.ts'),
      "expect(a).toBe(1);\nassert(b);\nassert.equal(c, 1);\nexpect(() => f()).toThrow();\nx.should.equal(1);\nxit('a');\ndescribe.todo('b');\n",
    );
    fs.mkdirSync(path.join(repo, 'libs', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'libs', 'node_modules', 'vendored.spec.ts'), 'expect(1);\n');
    fs.writeFileSync(path.join(repo, 'libs', 'not-a-spec.ts'), 'expect(1);\n');
    assert.deepEqual(countAssertions([path.join(repo, 'libs')]), { assertions: 6, skipped: 2, files: 1 });
  });

  test('compareAssertionCounts: equal, -1 and +1 at both metrics', () => {
    const base = { assertions: 10, skipped: 2, files: 1 };
    assert.deepEqual(compareAssertionCounts(base, { assertions: 10, skipped: 2, files: 1 }).problems, []);
    assert.equal(compareAssertionCounts(base, { assertions: 9, skipped: 2, files: 1 }).problems.length, 1);
    assert.deepEqual(compareAssertionCounts(base, { assertions: 11, skipped: 2, files: 1 }).problems, []);
    assert.deepEqual(compareAssertionCounts(base, { assertions: 10, skipped: 1, files: 1 }).problems, []);
    assert.equal(compareAssertionCounts(base, { assertions: 10, skipped: 3, files: 1 }).problems.length, 1);
  });

  // ── wiring ────────────────────────────────────────────────────────────────

  test('the capability declares the gate as check mn-assertion-ratchet at verify:pre', () => {
    const gateDecl = CAPABILITY.gates.find((g) => g.when === 'workflow.assertion_ratchet');
    assert.equal(gateDecl.point, 'verify:pre');
    assert.deepEqual(gateDecl.check, { query: 'mn-assertion-ratchet' });
  });

  test('gsd_run check mn-assertion-ratchet prints the verdict (CLI)', () => {
    writeSpec('a.spec.ts', 3);
    fs.writeFileSync(baselineFile(), JSON.stringify({ assertions: 5, skipped: 0, files: 1, updated: '' }));
    const payload = runMnCheck(repo, 'mn-assertion-ratchet', ['.planning/phases/01-x']);
    assert.equal(payload.block, true);
    assert.equal(payload.status, 'finding');
  });
});
