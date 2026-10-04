'use strict';

/**
 * TRANSITIONAL golden test: `wave-collision.mjs` / `wave-normalize.mjs` / `wave-solve.mjs` ↔
 * `check mn-wave-collision` (literal / expand) and `check mn-wave-solve`, on shared fixtures
 * (decision 6 of .plans/mn-verify-gate-to-cli.md). Requires "script exited non-zero" to equal
 * "verdict blocks", and "script exited 2" to equal `status: unresolvable`. Deleted with the scripts.
 *
 * Fixtures deliberately LEFT OUT, because the verbs intentionally differ (each is pinned in the
 * verb's own test file):
 *   - wave-solve: a valid assignment that differs from the greedy order (01-01 wave 2, 01-02 wave
 *     1, sharing a file). The script flagged it (declared 1 < computed 2); the verb judges the
 *     declared waves against the invariant and passes it. (mn-wave-solve.test.cjs, "beyond the script")
 *   - wave-solve: a plan in the same wave as a dependency that a file clash pushed back. The script
 *     computed the dependent's wave before the shift and matched it; the verb flags it.
 *   - wave-collision (literal): a superseded plan (never runs, so the verb leaves it out), a
 *     PLAN.md that is a directory (the script skipped it, the verb cannot check), a scalar
 *     `files_modified: a.ts` (the script read nothing, the Plan Document Module reads one entry),
 *     a trailing `# comment` on an entry and the inline `files_modified: [a, b]` form — the literal
 *     script's own parser kept the comment in the path and never read the inline list, so it
 *     missed those collisions; the verbs read every plan through the one Plan Document Module.
 *     These two fixtures run against wave-normalize only (whose parser handled them).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, writeFiles } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnWaveCollision, evaluateMnWaveSolve } = require('../gsd-core/bin/lib/gate-mn-waves.cjs');

const SCRIPTS = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts');
const RUN_TIMEOUT_MS = 30000;

function plan(wave, files, deps) {
  const waveLine = wave === null ? '' : `wave: ${wave}\n`;
  const depLine = deps ? `depends_on: [${deps.map((d) => `"${d}"`).join(', ')}]\n` : '';
  const block = files.length > 0 ? `files_modified:\n${files.map((f) => `  - ${f}`).join('\n')}\n` : 'files_modified:\n';
  return `---\nphase: 01\n${waveLine}${depLine}${block}autonomous: true\n---\n\n# plan\n`;
}

/** [label, phase files, project tree files] */
const COLLISION_FIXTURES = [
  ['empty phase', {}, []],
  ['one plan', { '01-01-PLAN.md': plan(1, ['src/a.ts']) }, []],
  ['same file same wave', { '01-01-PLAN.md': plan(1, ['src/a.ts']), '01-02-PLAN.md': plan(1, ['src/a.ts']) }, []],
  ['same file different waves', { '01-01-PLAN.md': plan(1, ['src/a.ts']), '01-02-PLAN.md': plan(2, ['src/a.ts']) }, []],
  ['disjoint files', { '01-01-PLAN.md': plan(1, ['src/a.ts']), '01-02-PLAN.md': plan(1, ['src/b.ts']) }, []],
  ['./ and trailing slash', { '01-01-PLAN.md': plan(1, ['./src/a.ts']), '01-02-PLAN.md': plan(1, ['src/a.ts']) }, []],
  ['three over one file', { 'a-PLAN.md': plan(1, ['s.ts']), 'b-PLAN.md': plan(1, ['s.ts']), 'c-PLAN.md': plan(1, ['s.ts']) }, []],
  ['no wave tags', { 'x-PLAN.md': plan(null, ['src/a.ts']), 'y-PLAN.md': plan(null, ['src/a.ts']) }, []],
  ['declared nothing', { '01-01-PLAN.md': plan(1, []), '01-02-PLAN.md': plan(1, ['src/a.ts']) }, []],
  ['directory twice', { '01-01-PLAN.md': plan(1, ['libs/m/testing']), '01-02-PLAN.md': plan(1, ['libs/m/testing']) }, ['libs/m/testing/a.ts', 'libs/m/testing/b.ts']],
  ['directory vs file inside', { '01-01-PLAN.md': plan(1, ['libs/m/testing']), '01-02-PLAN.md': plan(1, ['libs/m/testing/a.ts']) }, ['libs/m/testing/a.ts']],
  ['disjoint directories', { '01-01-PLAN.md': plan(1, ['libs/m/testing']), '01-02-PLAN.md': plan(1, ['libs/other']) }, ['libs/m/testing/a.ts', 'libs/other/c.ts']],
  ['glob vs match', { '01-01-PLAN.md': plan(1, ['libs/m/**']), '01-02-PLAN.md': plan(1, ['libs/m/testing/b.ts']) }, ['libs/m/testing/b.ts']],
  ['stale glob', { '01-01-PLAN.md': plan(1, ['gone/**']) }, []],
  ['prose entry', { '01-01-PLAN.md': plan(1, ['"apps/x (9 files) — exact list"']) }, []],
  ['greenfield file', { '01-01-PLAN.md': plan(1, ['src/brand-new.ts']) }, []],
  ['escaping entry', { '01-01-PLAN.md': plan(1, ['../outside/x.ts']) }, []],
  ['blank line in block', { '01-01-PLAN.md': '---\nwave: 1\nfiles_modified:\n\n  - libs/m/testing\n\n---\n', '01-02-PLAN.md': plan(1, ['libs/m/testing']) }, ['libs/m/testing/a.ts']],
  ['comment in block', { '01-01-PLAN.md': '---\nwave: 1\nfiles_modified:\n  # note\n  - tools/a.sh\n---\n' }, ['tools/a.sh']],
  ['trailing comment', { '01-01-PLAN.md': '---\nwave: 1\nfiles_modified:\n  - src/keep.ts    # NEW\n---\n', '01-02-PLAN.md': plan(1, ['src/keep.ts']) }, ['src/keep.ts']],
  ['inline list', { '01-01-PLAN.md': '---\nwave: 1\nfiles_modified: [libs/m/x.ts, "libs/m/y.ts"]\n---\n', '01-02-PLAN.md': plan(1, ['libs/m/x.ts']) }, ['libs/m/x.ts']],
];

const SOLVE_FIXTURES = [
  ['empty phase', {}],
  ['single plan', { '01-01-PLAN.md': plan(1, ['src/a.ts'], []) }],
  ['file clash same wave', { '01-01-PLAN.md': plan(1, ['src/main.ts'], []), '01-02-PLAN.md': plan(1, ['src/main.ts'], []) }],
  ['before dependency', { '01-01-PLAN.md': plan(2, ['src/a.ts'], []), '01-02-PLAN.md': plan(1, ['src/b.ts'], ['01-01']) }],
  ['same wave as dependency', { '01-01-PLAN.md': plan(1, ['src/a.ts'], []), '01-02-PLAN.md': plan(1, ['src/b.ts'], ['01-01']) }],
  ['later than necessary', { '01-01-PLAN.md': plan(1, ['src/a.ts'], []), '01-02-PLAN.md': plan(5, ['src/b.ts'], []) }],
  ['zero base', { '01-01-PLAN.md': plan(0, ['src/a.ts'], []), '01-02-PLAN.md': plan(1, ['src/b.ts'], ['01-01']) }],
  ['correct chain', { '01-01-PLAN.md': plan(1, ['a.ts'], []), '01-02-PLAN.md': plan(2, ['b.ts'], ['01-01']), '01-03-PLAN.md': plan(3, ['c.ts'], ['01-02']) }],
  ['glob not compared', { '01-01-PLAN.md': plan(1, ['libs/shared/**'], []), '01-02-PLAN.md': plan(1, ['libs/shared/**'], []) }],
  ['cycle', { '01-01-PLAN.md': plan(1, ['a.ts'], ['01-02']), '01-02-PLAN.md': plan(2, ['b.ts'], ['01-01']) }],
  ['dependency outside phase', { '01-01-PLAN.md': plan(1, ['a.ts'], ['07-03']) }],
  ['undeclared wave', { '01-01-PLAN.md': plan(null, ['a.ts'], []), '01-02-PLAN.md': plan(1, ['a.ts'], []) }],
];

describe('wave scripts ↔ check verbs (transitional)', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-eq-waves-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function compare(script, evaluate, extraArgs, files, tree) {
    writeFiles(projectDir, Object.fromEntries(tree.map((t) => [t, 'x\n'])));
    const { phaseDir, phaseNumber } = makePhase(projectDir, files);
    const r = runNode([path.join(SCRIPTS, script), '--dir', phaseDir], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    const v = evaluate({ projectDir, args: [phaseNumber, ...extraArgs] }).payload;
    assert.equal(v.block, r.exitCode !== 0, `${script}: exit ${r.exitCode} vs block ${v.block} (${v.message})`);
    assert.equal(v.status === 'unresolvable', r.exitCode === 2, `${script}: exit ${r.exitCode} vs status ${v.status}`);
  }

  const LITERAL_PARSER_GAPS = new Set(['trailing comment', 'inline list']);

  for (const [label, files, tree] of COLLISION_FIXTURES) {
    if (!LITERAL_PARSER_GAPS.has(label)) {
      test(`wave-collision ↔ literal: ${label}`, () => compare('wave-collision.mjs', evaluateMnWaveCollision, [], files, tree));
    }
    test(`wave-normalize ↔ expand: ${label}`, () => compare('wave-normalize.mjs', evaluateMnWaveCollision, ['--expand'], files, tree));
  }

  for (const [label, files] of SOLVE_FIXTURES) {
    test(`wave-solve: ${label}`, () => compare('wave-solve.mjs', evaluateMnWaveSolve, [], files, []));
  }
});
