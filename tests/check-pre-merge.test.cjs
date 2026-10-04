'use strict';

/**
 * `npm run check:pre-merge` — the local chain run before merging a branch
 * (plan 5.7c). Development here is local and no CI runs, so the real-mermaid
 * conformance suite (`test:mermaid-real`, kept out of `npm test` because it
 * needs mermaid + jsdom installed under tools/mermaid-check) only runs if a
 * chain someone actually executes includes it. Asserted on package.json as
 * parsed JSON: the steps of each script, split on `&&`.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const steps = (name) => {
  assert.equal(typeof pkg.scripts[name], 'string', `package.json has no "${name}" script`);
  return pkg.scripts[name].split('&&').map((s) => s.trim());
};

describe('check:pre-merge — the local pre-merge chain (5.7c)', () => {
  test('runs the CI lint gate, the real-mermaid conformance suite and the full test suite, cheapest first', () => {
    assert.deepEqual(steps('check:pre-merge'), ['npm run lint:ci', 'npm run test:mermaid-real', 'npm test']);
  });

  test('test:mermaid-real builds the lib and installs its own pinned dependencies before checking', () => {
    assert.deepEqual(steps('test:mermaid-real'), [
      'npm run build:lib',
      'npm --prefix tools/mermaid-check ci --no-audit --no-fund',
      'node tools/mermaid-check/check.mjs',
    ]);
  });

  test('the mermaid dependencies stay out of the core: neither dependencies nor devDependencies name them', () => {
    for (const field of ['dependencies', 'devDependencies']) {
      const names = Object.keys(pkg[field] ?? {});
      assert.deepEqual(names.filter((n) => n === 'mermaid' || n === 'jsdom'), [], field);
    }
  });
});
