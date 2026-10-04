'use strict';

/**
 * `validate health --repair --only <CODE[,CODE…]>` (fork FU-F, found while
 * repairing live projects): `--repair` applied every non-destructive remedy
 * at once, so normalizing one report's `status` (W031) also rewrote
 * config.json (W008/W016) and backfilled MILESTONES.md (W018). `--only`
 * narrows which diagnostics' remedies a run may apply; reporting is never
 * narrowed. Without `--only` the run is unchanged.
 *
 * Fixture provenance: STRUCTURAL ABSENCE for the config/MILESTONES findings
 * (a `workflow` block without its two keys, an archived roadmap snapshot with
 * no MILESTONES.md entry) and MECHANICAL MUTATION of a passing report
 * (`status: passed` -> `verified`) for W031.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, captureConsole, runGsdTools } = require('./helpers.cjs');
const { cmdValidateHealth } = require('../gsd-core/bin/lib/verify.cjs');

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** Three independent repairable findings: W008 + W016 (config.json), W018 (MILESTONES.md), W031 (a report). */
function writeProject(root) {
  writeFile(root, '.planning/PROJECT.md', '# Project\n\n## What This Is\n\nx\n\n## Core Value\n\nx\n\n## Requirements\n\nx\n');
  writeFile(root, '.planning/config.json', JSON.stringify({ model_profile: 'balanced', workflow: {} }, null, 2));
  writeFile(root, '.planning/ROADMAP.md', ['# Roadmap', '', '## v2.0 Current', '', '### Phase 1: Foo', '**Goal:** Foo', ''].join('\n'));
  writeFile(root, '.planning/STATE.md', '---\nmilestone: v2.0\n---\n# State\n');
  writeFile(root, '.planning/MILESTONES.md', '# Milestones\n\n');
  writeFile(root, '.planning/milestones/v1.0-ROADMAP.md', '# Milestone v1.0 Alpha\n');
  writeFile(root, '.planning/phases/01-foo/01-01-PLAN.md', '# Plan\n');
  writeFile(root, '.planning/phases/01-foo/01-01-SUMMARY.md', '# Summary\n');
  writeFile(root, '.planning/phases/01-foo/01-VERIFICATION.md', '---\nstatus: verified\n---\n');
}

function run(root, options) {
  let result;
  captureConsole(() => { result = cmdValidateHealth(root, options, true); });
  return result;
}

const repairedCodes = (result) => (result.repairs_performed ?? []).filter((r) => r.success).map((r) => r.action).sort();

function planningBytes(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(path.join(root, '.planning'));
  return out;
}

/** The structured `--json-errors` envelope: the last stderr line that parses as `{ ok: false }`. */
function errorEnvelope(stderr) {
  const lines = String(stderr || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.ok === false) return parsed;
    } catch {
      // not the envelope line
    }
  }
  return null;
}

describe('validate health --only — which remedies a repair run applies', () => {
  test('fixture sanity: W008, W016, W018 and W031 are all reported repairable', (t) => {
    const root = createTempProject('gsd-fuf-only-sanity-');
    t.after(() => cleanup(root));
    writeProject(root);
    const codes = run(root, {}).warnings.filter((w) => w.repairable).map((w) => w.code).sort();
    assert.deepEqual(codes, ['W008', 'W016', 'W018', 'W031']);
  });

  test('`--repair --only W031` rewrites the report and nothing else — config.json and MILESTONES.md byte-identical', (t) => {
    const root = createTempProject('gsd-fuf-only-w031-');
    t.after(() => cleanup(root));
    writeProject(root);
    const before = planningBytes(root);

    const result = run(root, { repair: true, only: 'W031' });
    assert.deepEqual(repairedCodes(result), ['normalizeVerificationStatus']);
    const after = planningBytes(root);
    const changed = Object.keys(after).filter((rel) => after[rel] !== before[rel]);
    assert.deepEqual(changed, [path.join('.planning', 'phases', '01-foo', '01-VERIFICATION.md')]);
    // Reporting is not narrowed: the other findings are still listed.
    assert.deepEqual(result.warnings.filter((w) => w.repairable).map((w) => w.code).sort(), ['W008', 'W016', 'W018', 'W031']);
  });

  test('without --only, --repair is unchanged: every non-destructive remedy runs', (t) => {
    const root = createTempProject('gsd-fuf-only-none-');
    t.after(() => cleanup(root));
    writeProject(root);
    assert.deepEqual(
      repairedCodes(run(root, { repair: true })),
      ['addAiIntegrationPhaseKey', 'addNyquistKey', 'backfillMilestones', 'normalizeVerificationStatus'],
    );
  });

  test('boundary: one code, two codes, and every repairable code (= bare --repair)', (t) => {
    const cases = [
      ['W008', ['addNyquistKey']],
      ['W008,W016', ['addAiIntegrationPhaseKey', 'addNyquistKey']],
      ['W008,W016,W018,W031', ['addAiIntegrationPhaseKey', 'addNyquistKey', 'backfillMilestones', 'normalizeVerificationStatus']],
    ];
    for (const [only, expected] of cases) {
      const root = createTempProject('gsd-fuf-only-boundary-');
      t.after(() => cleanup(root));
      writeProject(root);
      assert.deepEqual(repairedCodes(run(root, { repair: true, only })), expected, only);
    }
  });

  test('codes are case-insensitive and may name a finding that has no repair (W030) — it is simply not applied', (t) => {
    const root = createTempProject('gsd-fuf-only-case-');
    t.after(() => cleanup(root));
    writeProject(root);
    assert.deepEqual(repairedCodes(run(root, { repair: true, only: ' w031 , W030 ' })), ['normalizeVerificationStatus']);
  });

  test('--backfill honours --only too: W018 backfills, any other code leaves MILESTONES.md alone', (t) => {
    const yes = createTempProject('gsd-fuf-only-backfill-');
    t.after(() => cleanup(yes));
    writeProject(yes);
    assert.deepEqual(repairedCodes(run(yes, { backfill: true, only: 'W018' })), ['backfillMilestones']);

    const no = createTempProject('gsd-fuf-only-backfill-neg-');
    t.after(() => cleanup(no));
    writeProject(no);
    const before = planningBytes(no);
    assert.deepEqual(repairedCodes(run(no, { backfill: true, only: 'W031' })), []);
    assert.deepEqual(planningBytes(no), before);
  });
});

describe('validate health --only — usage errors exit with the registry USAGE reason and write nothing', () => {
  const CASES = [
    ['an unknown code', ['--repair', '--only', 'W999']],
    ['one unknown code among known ones', ['--repair', '--only', 'W031,W999']],
    ['a bare --only (no list)', ['--repair', '--only']],
    ['an empty entry (trailing comma)', ['--repair', '--only', 'W031,']],
    ['--only with neither --repair nor --backfill', ['--only', 'W031']],
  ];
  for (const [name, args] of CASES) {
    test(name, (t) => {
      const root = createTempProject('gsd-fuf-only-usage-');
      t.after(() => cleanup(root));
      writeProject(root);
      const before = planningBytes(root);

      const res = runGsdTools(['--json-errors', 'validate', 'health', ...args], root);
      assert.notEqual(res.exitCode, 0, res.output);
      assert.equal(res.output, '');
      assert.equal(errorEnvelope(res.error)?.reason, 'usage', res.error);
      assert.deepEqual(planningBytes(root), before, 'nothing written');
    });
  }

  test('control: the same project with a valid --only exits 0 and repairs', (t) => {
    const root = createTempProject('gsd-fuf-only-usage-ok-');
    t.after(() => cleanup(root));
    writeProject(root);
    const res = runGsdTools(['validate', 'health', '--repair', '--only', 'W031'], root);
    assert.equal(res.exitCode, 0, res.error);
    assert.deepEqual(JSON.parse(res.output).repairs_performed.map((r) => r.action), ['normalizeVerificationStatus']);
  });
});
