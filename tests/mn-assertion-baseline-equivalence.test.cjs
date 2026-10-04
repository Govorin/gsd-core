'use strict';

/**
 * TRANSITIONAL — deleted together with
 * capabilities/mn-verify-gate/scripts/assertion-ratchet.mjs (the gate script
 * is migrated by the check-family work; its `--update` half is
 * `gsd-tools mn assertion-baseline`).
 *
 * The baseline the script's `--update` writes and the one the command writes
 * must be the same record (counts and file count; `updated` is a timestamp),
 * because the ratchet that reads it does not know which wrote it. Also pins
 * the shared refusal: zero spec files records nothing.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');

const LEGACY = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'assertion-ratchet.mjs');
const BASELINE = path.join('.planning', 'assertion-baseline.json');

describe('assertion baseline: assertion-ratchet.mjs --update ↔ gsd-tools mn assertion-baseline', () => {
  let a;
  let b;
  const populate = (repo) => {
    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), body);
    };
    write('libs/x/a.spec.ts', "it('a', () => { expect(1).toBe(1); assert.ok(2); });\nit.skip('b', () => {});\n");
    write('libs/x/node_modules/dep.spec.ts', 'expect(9);');
    write('apps/y/b.test.tsx', "test('c', () => { expect(() => f()).toThrow(); x.should.equal(1); });\nxit('d');\n");
    write('apps/y/c.spec.js', 'expect(1);');
  };
  beforeEach(() => {
    a = createTempGitProject('gsd-assert-eq-a-');
    b = createTempGitProject('gsd-assert-eq-b-');
  });
  afterEach(() => {
    cleanup(a);
    cleanup(b);
  });

  const record = (file) => {
    const { updated, ...counts } = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(typeof updated, 'string');
    return counts;
  };

  test('the same baseline record for the same tree', () => {
    populate(a);
    populate(b);
    const old = runNode([LEGACY, '--baseline', BASELINE, '--update'], { cwd: a, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(old.outcome, OUTCOME.EXITED);
    assert.equal(old.exitCode, 0, old.stderr);
    assert.equal(runGsdTools(['mn', 'assertion-baseline'], b).success, true);
    const was = record(path.join(a, BASELINE));
    assert.deepEqual(was, { assertions: 5, skipped: 2, files: 2 });
    assert.deepEqual(record(path.join(b, BASELINE)), was);
  });

  test('both refuse an empty tree and write nothing', () => {
    assert.equal(runNode([LEGACY, '--baseline', BASELINE, '--update'], { cwd: a, timeoutMs: PROBE_TIMEOUT_MS }).exitCode, 1);
    assert.equal(runGsdTools(['mn', 'assertion-baseline'], b).success, false);
    assert.equal(fs.existsSync(path.join(a, BASELINE)), false);
    assert.equal(fs.existsSync(path.join(b, BASELINE)), false);
  });
});
