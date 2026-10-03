'use strict';

/**
 * assertion-ratchet.mjs — a ratchet on the number of live assertions.
 *
 * It catches a failure nothing else does: a test that stops failing because the
 * assertion was removed from it. Deleting an assert makes the suite greener, and
 * no green run reports it. Coverage stays silent too — the line still executes,
 * its result is simply no longer checked.
 *
 * The invariant is one-directional by design. A drop is allowed, but only when
 * declared: refactoring tests and merging duplicates legitimately reduce the
 * count. What the ratchet forbids is an UNDECLARED drop.
 *
 * The gate runs on the live project and had no tests. These pin the ratchet's
 * direction, its two exit codes, and the first-run behaviour — a fresh baseline
 * must be created rather than treated as a violation, or the gate would block
 * the first phase that ever ran it.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'assertion-ratchet.mjs',
);

const HELD = 0;
const DROPPED = 1;

describe('assertion-ratchet gate', () => {
  let repo;
  let baseline;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-assertion-ratchet-'));
    fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'libs'), { recursive: true });
    baseline = path.join(repo, '.planning', 'assertion-baseline.json');
  });

  afterEach(() => {
    cleanup(repo);
  });

  /** Write a spec carrying a known number of assertions. */
  function writeSpec(name, assertionCount) {
    const body = Array.from(
      { length: assertionCount },
      (_, i) => `  expect(value${i}).toBe(${i});`,
    ).join('\n');
    fs.writeFileSync(
      path.join(repo, 'libs', name),
      `describe('suite', () => {\n  it('checks things', () => {\n${body}\n  });\n});\n`,
    );
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--baseline', baseline, '--paths', 'libs', ...extra], {
      cwd: repo,
      timeoutMs: 60000,
    });
  }

  test('creates the baseline on first run instead of failing', () => {
    // Without this the gate would block the very first phase to enable it —
    // a gate that fails on day one gets switched off on day one.
    writeSpec('a.spec.ts', 5);

    const r = run();
    assert.equal(r.exitCode, HELD, `a first run must establish the baseline: ${r.stderr}`);
    assert.ok(fs.existsSync(baseline), 'the baseline file must be written');
  });

  test('holds when the assertion count is unchanged', () => {
    writeSpec('a.spec.ts', 5);
    run(); // establish

    const r = run();
    assert.equal(r.exitCode, HELD, `an unchanged count must pass: ${r.stderr}`);
  });

  test('holds when assertions are added', () => {
    // The ratchet is one-directional: growth is always fine.
    writeSpec('a.spec.ts', 5);
    run();

    writeSpec('a.spec.ts', 9);
    const r = run();
    assert.equal(r.exitCode, HELD, `adding assertions must never block: ${r.stderr}`);
  });

  test('blocks when assertions disappear without a record', () => {
    // The defect: a test that no longer checks anything, in a suite that is
    // still green.
    writeSpec('a.spec.ts', 8);
    run();

    writeSpec('a.spec.ts', 3);
    const r = run();
    assert.equal(r.exitCode, DROPPED, `an undeclared drop must block: ${r.stdout}`);
    const output = `${r.stdout}${r.stderr}`;
    // The numbers must appear, or the reader cannot tell a refactor from a gutting.
    assert.match(output, /8/, `the previous count must be reported: ${output}`);
    assert.match(output, /3/, `the current count must be reported: ${output}`);
  });

  test('blocks when a whole spec file is deleted', () => {
    // Deleting the file is the same failure as emptying it, and is easier to do
    // by accident during a refactor.
    writeSpec('a.spec.ts', 4);
    writeSpec('b.spec.ts', 4);
    run();

    fs.unlinkSync(path.join(repo, 'libs', 'b.spec.ts'));
    const r = run();
    assert.equal(r.exitCode, DROPPED, `losing a spec file must block: ${r.stdout}`);
  });

  test('--update records the new count so an intended drop can proceed', () => {
    // The escape hatch that keeps the gate honest: a legitimate refactor is
    // declared, not silently tolerated.
    writeSpec('a.spec.ts', 8);
    run();

    writeSpec('a.spec.ts', 3);
    const updated = run(['--update']);
    assert.equal(updated.exitCode, HELD, `--update must accept the new count: ${updated.stderr}`);

    const after = run();
    assert.equal(after.exitCode, HELD, 'the recorded count becomes the new floor');
  });

  test('counts assertions across several files', () => {
    writeSpec('a.spec.ts', 3);
    writeSpec('b.spec.ts', 4);
    run();

    // Removing from one file while adding more to another must net out as growth.
    writeSpec('a.spec.ts', 1);
    writeSpec('b.spec.ts', 9);
    const r = run();
    assert.equal(r.exitCode, HELD, `the ratchet compares the total, not per file: ${r.stdout}`);
  });
});
