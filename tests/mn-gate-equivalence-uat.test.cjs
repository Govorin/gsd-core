'use strict';

/**
 * TRANSITIONAL golden test: `uat-open.mjs` ↔ `check mn-uat-open`, on the same fixtures
 * (decision 6 of .plans/mn-verify-gate-to-cli.md).
 *
 * Requires "script exited non-zero" to equal "verdict blocks", and "script exited 2" to equal
 * `status: unresolvable`. The script spawns `gsd-tools audit-uat` found on fixed paths, the first
 * being `$HOME/.claude/gsd-core/bin/gsd-tools.cjs`; the script side runs with HOME pointed at a
 * sandbox whose `.claude/gsd-core` links to THIS checkout, so both sides read the same audit.
 * Deleted with the script.
 */

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { createMnProject } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnUatOpen } = require('../gsd-core/bin/lib/gate-mn-uat-open.cjs');

const SCRIPT = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'uat-open.mjs');
const RUN_TIMEOUT_MS = 90000;

const uat = (results, status = 'testing') =>
  `---\nstatus: ${status}\nphase: 03\n---\n\n## Tests\n\n` +
  results.map((r, i) => `### ${i + 1}. Check ${i + 1}\nexpected: works\nresult: ${r}\n`).join('\n');

/** [label, files in 03-ports, files in 04-api, extra args] */
const FIXTURES = [
  ['no UAT file', {}, {}, []],
  ['one pending', { '03-UAT.md': uat(['pending']) }, {}, []],
  ['one pass', { '03-UAT.md': uat(['pass']) }, {}, []],
  ['one fail', { '03-UAT.md': uat(['fail']) }, {}, []],
  ['mixed pass and pending', { '03-UAT.md': uat(['pass', 'pending', 'fail']) }, {}, []],
  ['skipped item', { '03-UAT.md': uat(['skipped']) }, {}, []],
  ['blocked item', { '03-UAT.md': uat(['blocked']) }, {}, []],
  ['complete status, pending row', { '03-UAT.md': uat(['pending'], 'complete') }, {}, []],
  ['other phase pending', { '03-UAT.md': uat(['pass']) }, { '04-UAT.md': uat(['pending']) }, []],
  ['other phase pending, --all', { '03-UAT.md': uat(['pass']) }, { '04-UAT.md': uat(['pending']) }, ['--all']],
  ['human_needed verification', { '03-VERIFICATION.md': '---\nphase: 03\nstatus: human_needed\n---\n\n## Human Verification\n\n- [ ] Check the login page renders\n' }, {}, []],
  ['bogus verification status', { '03-VERIFICATION.md': '---\nphase: 03\nstatus: bogus\n---\n\n# r\n' }, {}, []],
];

describe('uat-open.mjs ↔ check mn-uat-open (transitional)', () => {
  let home;
  let projectDir;

  before(() => {
    home = createTempDir('gsd-mn-eq-uat-home-');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(__dirname, '..', 'gsd-core'), path.join(home, '.claude', 'gsd-core'), 'dir');
  });

  after(() => {
    cleanup(home);
  });

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-eq-uat-');
    for (const name of ['03-ports', '04-api']) fs.mkdirSync(path.join(projectDir, '.planning', 'phases', name), { recursive: true });
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  for (const [label, files3, files4, extra] of FIXTURES) {
    test(label, () => {
      const phase3 = path.join(projectDir, '.planning', 'phases', '03-ports');
      const phase4 = path.join(projectDir, '.planning', 'phases', '04-api');
      for (const [name, content] of Object.entries(files3)) fs.writeFileSync(path.join(phase3, name), content);
      for (const [name, content] of Object.entries(files4)) fs.writeFileSync(path.join(phase4, name), content);

      const r = runNode([SCRIPT, '--dir', phase3, ...extra], {
        timeoutMs: RUN_TIMEOUT_MS,
        env: { ...process.env, HOME: home },
      });
      assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
      const v = evaluateMnUatOpen({ projectDir, args: [phase3, ...extra] }).payload;
      assert.equal(v.block, r.exitCode !== 0, `exit ${r.exitCode} (${r.stderr.trim()}) vs block ${v.block} (${v.message})`);
      assert.equal(v.status === 'unresolvable', r.exitCode === 2, `exit ${r.exitCode} vs status ${v.status}`);
    });
  }
});
