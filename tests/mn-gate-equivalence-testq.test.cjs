'use strict';

/**
 * TRANSITIONAL golden test: `assertion-ratchet.mjs` ↔ `check mn-assertion-ratchet`, and
 * `mutation-spot-check.mjs` ↔ `verify mutation` + `check mn-mutation-spot-check`, on shared
 * fixtures (decision 6 of .plans/mn-verify-gate-to-cli.md). "Script exited non-zero" must equal
 * "verdict blocks". Deleted with the scripts.
 *
 * Intentional divergences, excluded from the comparison and pinned in the family tests instead:
 *   - no baseline: the script CREATED one and passed; the read-only gate is unresolvable (a gate
 *     that writes the floor it judges against can be satisfied by deleting the file).
 *   - every mutant run failing to complete: the script read "nothing to spot-check" (pass); the
 *     step records `unrunnable` and the gate blocks — nothing was measured.
 *   - a stale record (code changed after the step ran): the script had no record to go stale.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup, runGsdTools } = require('./helpers.cjs');
const { createMnProject, makePhase, writeWorkflowConfig, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');

const SCRIPTS = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts');
const RUN_TIMEOUT_MS = 120000;

describe('assertion-ratchet.mjs ↔ check mn-assertion-ratchet (transitional)', () => {
  let repo;

  beforeEach(() => {
    repo = createMnProject('gsd-mn-eq-ratchet-');
    fs.mkdirSync(path.join(repo, 'libs'), { recursive: true });
  });

  afterEach(() => {
    cleanup(repo);
  });

  function spec(name, n, extra = '') {
    const body = Array.from({ length: n }, (_, i) => `expect(v${i}).toBe(${i});`).join('\n');
    fs.writeFileSync(path.join(repo, 'libs', name), `${body}\n${extra}`);
  }

  const CASES = [
    ['unchanged', { assertions: 5, skipped: 0 }, () => spec('a.spec.ts', 5)],
    ['grown', { assertions: 5, skipped: 0 }, () => spec('a.spec.ts', 9)],
    ['dropped by one', { assertions: 5, skipped: 0 }, () => spec('a.spec.ts', 4)],
    ['newly skipped', { assertions: 5, skipped: 0 }, () => spec('a.spec.ts', 5, "it.skip('x');\n")],
    ['skip removed', { assertions: 5, skipped: 1 }, () => spec('a.spec.ts', 5)],
    ['net growth across files', { assertions: 7, skipped: 0 }, () => { spec('a.spec.ts', 1); spec('b.spec.ts', 9); }],
    ['zero spec files', { assertions: 5, skipped: 0 }, () => {}],
  ];

  for (const [label, baseline, arrange] of CASES) {
    test(label, () => {
      arrange();
      const baselineFile = path.join(repo, '.planning', 'assertion-baseline.json');
      fs.writeFileSync(baselineFile, JSON.stringify({ ...baseline, files: 1 }));
      const script = runNode([path.join(SCRIPTS, 'assertion-ratchet.mjs'), '--baseline', baselineFile, '--paths', 'libs'], {
        cwd: repo,
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(script.outcome, OUTCOME.EXITED, script.stderr);
      const payload = runMnCheck(repo, 'mn-assertion-ratchet', ['1']);
      assert.equal(payload.block, script.exitCode !== 0, `script exit ${script.exitCode} vs ${payload.status}: ${payload.message}`);
    });
  }
});

describe('mutation-spot-check.mjs ↔ verify mutation + check mn-mutation-spot-check (transitional)', () => {
  let projectDir;
  let phaseDir;

  const SOURCE = 'function isAdult(age) {\n  return age >= 18;\n}\nmodule.exports = { isAdult };\n';
  const REAL = "const assert = require('node:assert');\nconst { isAdult } = require('./src.js');\nassert.equal(isAdult(18), true);\nassert.equal(isAdult(17), false);\n";
  const HOLLOW = "const { isAdult } = require('./src.js');\nisAdult(18);\n";

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-eq-mutation-');
    fs.writeFileSync(path.join(projectDir, 'src.js'), SOURCE);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  const CASES = [
    ['pinning test', REAL, ['src.js'], 'node check.js'],
    ['hollow test', HOLLOW, ['src.js'], 'node check.js'],
    ['red suite', 'process.exit(1);\n', ['src.js'], 'node check.js'],
    ['nothing mutable declared', REAL, ['libs/**', 'src.spec.js', 'tests/helper.js'], 'node check.js'],
    ['no command configured', REAL, ['src.js'], ''],
    ['command that cannot run', REAL, ['src.js'], 'this-command-does-not-exist-xyz'],
  ];

  for (const [label, testBody, declared, command] of CASES) {
    test(label, () => {
      ({ phaseDir } = makePhase(projectDir, {
        '01-01-PLAN.md': `---\nphase: 01\nplan: 01\nfiles_modified:\n${declared.map((f) => `  - ${f}`).join('\n')}\n---\n`,
      }));
      fs.writeFileSync(path.join(projectDir, 'check.js'), testBody);
      writeWorkflowConfig(projectDir, { mutation_test_command: command });

      const script = runNode([path.join(SCRIPTS, 'mutation-spot-check.mjs'), '--dir', phaseDir], { timeoutMs: RUN_TIMEOUT_MS });
      assert.equal(script.outcome, OUTCOME.EXITED, script.stderr);

      const stepRun = runGsdTools(['verify', 'mutation', '--phase', '1', '--raw'], projectDir);
      assert.equal(stepRun.success, true, stepRun.error);
      const payload = runMnCheck(projectDir, 'mn-mutation-spot-check', ['1']);

      assert.equal(payload.block, script.exitCode !== 0, `script exit ${script.exitCode} vs ${payload.status}: ${payload.message}`);
      assert.equal(payload.status === 'unresolvable', script.exitCode === 2, `script exit ${script.exitCode} vs ${payload.status}`);
      assert.equal(fs.readFileSync(path.join(projectDir, 'src.js'), 'utf8'), SOURCE);
    });
  }
});
