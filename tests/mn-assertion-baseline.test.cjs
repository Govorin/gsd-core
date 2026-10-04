'use strict';

/**
 * `gsd-tools mn assertion-baseline` — records the live-assertion count the
 * verify:pre ratchet compares against (src/mn-assertion-count.cts, routed by
 * src/mn-command-router.cts).
 *
 * The counter is pinned on strings; the writer on a temp tree with an
 * injected clock; the command end to end through the typed JSON result and
 * the baseline file it writes (parsed, never grepped).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');

const ac = require('../gsd-core/bin/lib/mn-assertion-count.cjs');

describe('mn assertion-baseline: counting', () => {
  test('counts every assertion form and every skip marker, separately', () => {
    const text = [
      "it('a', () => { expect(x).toBe(1); assert(y); assert.equal(1, 1); x.should.equal(2); });",
      "it('b', () => { expect(() => f()).toThrow(); });",
      "it.skip('c', () => {}); test.todo('d'); xit('e'); xdescribe('f'); describe.skip('g');",
    ].join('\n');
    assert.deepEqual(ac.countText(text), { assertions: 6, skipped: 5 });
  });

  test('only TypeScript spec/test files count; build output and hidden directories are pruned', () => {
    const root = createTempDir('gsd-assert-count-');
    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };
    write('libs/a/a.spec.ts', 'expect(1);');
    write('libs/a/b.test.tsx', 'expect(1); expect(2);');
    write('libs/a/c.spec.js', 'expect(1);');
    write('libs/a/node_modules/d.spec.ts', 'expect(1);');
    write('libs/a/dist/e.spec.ts', 'expect(1);');
    write('libs/.cache/f.spec.ts', 'expect(1);');
    const counts = ac.countAssertions([path.join(root, 'libs'), path.join(root, 'apps')]);
    cleanup(root);
    assert.deepEqual(counts, { assertions: 3, skipped: 0, files: 2 });
  });
});

describe('mn assertion-baseline: recording', () => {
  let root;
  beforeEach(() => {
    root = createTempDir('gsd-assert-base-');
  });
  afterEach(() => cleanup(root));

  test('writes the counts and the time to the fixed baseline path', () => {
    fs.mkdirSync(path.join(root, 'libs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'libs', 'a.spec.ts'), 'expect(1); it.skip("x");');
    const r = ac.recordAssertionBaseline({ repoRoot: root, roots: [path.join(root, 'libs')], now: () => new Date('2026-10-04T00:00:00Z') });
    assert.equal(r.ok, true);
    const written = JSON.parse(fs.readFileSync(path.join(root, ac.BASELINE_PATH), 'utf-8'));
    assert.deepEqual(written, { assertions: 1, skipped: 1, files: 1, updated: '2026-10-04T00:00:00.000Z' });
    assert.deepEqual(r.baseline, written);
  });

  test('zero spec files is refused and writes nothing (boundary: 0 files refused, 1 file recorded)', () => {
    const r = ac.recordAssertionBaseline({ repoRoot: root, roots: [path.join(root, 'libs')] });
    assert.deepEqual([r.ok, r.reason], [false, 'no_specs']);
    assert.equal(fs.existsSync(path.join(root, ac.BASELINE_PATH)), false);
    fs.mkdirSync(path.join(root, 'libs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'libs', 'only.spec.ts'), '');
    assert.equal(ac.recordAssertionBaseline({ repoRoot: root, roots: [path.join(root, 'libs')] }).ok, true);
  });
});

describe('gsd-tools mn assertion-baseline', () => {
  let repo;
  beforeEach(() => {
    repo = createTempGitProject('gsd-assert-cli-');
  });
  afterEach(() => cleanup(repo));

  const reasonOf = (r) => JSON.parse(r.error.trim().split('\n').at(-1));

  test('records the default roots (libs, apps) into .planning/assertion-baseline.json', () => {
    fs.mkdirSync(path.join(repo, 'libs', 'x'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'apps', 'y'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'libs', 'x', 'a.spec.ts'), 'expect(1); expect(2);');
    fs.writeFileSync(path.join(repo, 'apps', 'y', 'b.test.ts'), 'assert.ok(1);');
    const r = runGsdTools(['mn', 'assertion-baseline'], repo);
    assert.equal(r.success, true, r.error);
    const result = JSON.parse(r.output);
    const written = JSON.parse(fs.readFileSync(path.join(repo, '.planning', 'assertion-baseline.json'), 'utf-8'));
    assert.deepEqual([written.assertions, written.skipped, written.files], [3, 0, 2]);
    assert.deepEqual(result.baseline, written);
  });

  test('--paths narrows the walk; an entry outside the repository is refused', () => {
    fs.mkdirSync(path.join(repo, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'pkg', 'a.spec.ts'), 'expect(1);');
    const r = runGsdTools(['mn', 'assertion-baseline', '--paths', 'pkg'], repo);
    assert.equal(JSON.parse(r.output).baseline.files, 1);
    const outside = runGsdTools(['mn', 'assertion-baseline', '--paths', '../..', '--json-errors'], repo);
    assert.equal(reasonOf(outside).reason, 'usage');
    const dangling = runGsdTools(['mn', 'assertion-baseline', '--paths', '--json-errors'], repo);
    assert.equal(reasonOf(dangling).reason, 'usage');
  });

  test('no spec files is a failure, not an empty baseline', () => {
    const r = runGsdTools(['mn', 'assertion-baseline', '--json-errors'], repo);
    assert.equal(r.success, false);
    assert.equal(reasonOf(r).cause, 'no_specs');
    assert.equal(fs.existsSync(path.join(repo, '.planning', 'assertion-baseline.json')), false);
  });
});
