'use strict';

/**
 * The "one import" pin: `check mn-wave-collision` (expand mode) classifies and resolves entries
 * through src/files-modified-normalize.cts and nothing else.
 *
 * ── What this file used to guard, and what is left ────────────────────────
 *
 * `wave-normalize.mjs` carried a second copy of the four-way classification because a script run
 * from `$HOME` could not import `src/`; this file ran both copies on one corpus and failed on the
 * first disagreement. The gate now imports the module (src/gate-mn-waves.cts), so a second
 * classifier no longer exists to drift.
 *
 * What CAN still drift is the step in front of it: the gate reads `files_modified` out of a PLAN.md
 * through the Plan Document Module (`parsePlanDocument`) before normalising. A reader that drops,
 * splits, unquotes or reorders entries would make the gate classify something other than what the
 * plan declared. So for every corpus shape — each one the live trees actually contain — the gate's
 * view of a one-plan phase must equal `normalizePlanFiles` applied directly to the declared list:
 * same entries in the same order, same kind, same resolved files, same `declaredNothing`.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, writeFiles } = require('./helpers/mn-gate-fixture.cjs');
const { normalizePlanFiles } = require('../gsd-core/bin/lib/files-modified-normalize.cjs');
const { analyzeWaveCollision } = require('../gsd-core/bin/lib/gate-mn-waves.cjs');

/**
 * The corpus. Each shape is one the live trees actually contain, so a disagreement here is a
 * disagreement about real input.
 */
const CORPUS = [
  // ── plain files ──
  ['libs/m/testing/a.ts'],
  ['libs/m/does-not-exist-yet.ts'], // greenfield: a file the plan will CREATE
  ['./libs/m/testing/a.ts'], // leading ./ normalised away
  ['libs/m/testing/'], // trailing slash normalised away
  // ── directories, the case the shipped detector cannot see ──
  ['libs/m/testing'],
  ['libs/m'],
  ['libs/m/empty-dir'],
  // ── globs ──
  ['libs/m/**'],
  ['libs/m/*.ts'],
  ['libs/m/testing/*'],
  ['libs/**/*.ts'],
  ['does-not-exist/**'], // stale glob: the files moved
  ['libs/m/no-such-*.ts'],
  // ── prose, which must NOT be read as a glob ──
  ['apps/x (9 files) — exact list from live scan'],
  ['libs/** (19 prefer-zod-validate files + 7 use-either-async files)'],
  ['two words'],
  // ── multi-entry plans, exercising the union and its sort ──
  ['libs/m/testing', 'libs/m/testing/a.ts'],
  ['libs/m/**', 'tsconfig.base.json', 'CLAUDE.md'],
  ['libs/m/testing', 'does-not-exist/**', 'prose here (n)'],
  // ── boundaries ──
  [],
  [''],
];

describe('the waves gate reads files_modified through the one normalizer', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-wave-drift-');
    // Mixed depth, so a walker that stops at the first level disagrees with one that recurses.
    writeFiles(projectDir, Object.fromEntries([
      'libs/m/testing/a.ts',
      'libs/m/testing/b.ts',
      'libs/m/testing/README.md',
      'libs/m/testing/src/factories/index.ts',
      'libs/m/testing/src/factories/token.factory.ts',
      'libs/m/top.ts',
      'tsconfig.base.json',
      'CLAUDE.md',
    ].map((rel) => [rel, 'x\n'])));
    fs.mkdirSync(path.join(projectDir, 'libs/m/empty-dir'), { recursive: true });
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  /** The three-method FsProbe of the reference call, over the same tree. */
  function probe() {
    const abs = (p) => (p === '' ? projectDir : path.join(projectDir, p));
    return {
      exists: (p) => fs.existsSync(abs(p)),
      isDirectory: (p) => {
        try {
          return fs.lstatSync(abs(p)).isDirectory();
        } catch {
          return false;
        }
      },
      readDir: (p) => fs.readdirSync(abs(p)),
    };
  }

  /** The gate's view of a one-plan phase declaring `entries`. */
  function gateView(entries) {
    const list = entries.map((e) => `  - ${JSON.stringify(e)}`).join('\n');
    const { phaseDir } = makePhase(projectDir, {
      '01-01-PLAN.md': `---\nphase: 01-x\nwave: 1\nfiles_modified:\n${list}\n---\n\n# a\n`,
    });
    const analysis = analyzeWaveCollision(projectDir, phaseDir, 'expand');
    assert.ok(analysis.plans, `the gate could not check: ${JSON.stringify(analysis)}`);
    return analysis.plans[0];
  }

  for (const entries of CORPUS) {
    const label = entries.length === 0 ? '(no entries)' : entries.join(' + ');

    test(`the gate's view equals normalizePlanFiles for: ${label}`, () => {
      const reference = normalizePlanFiles(entries, probe());
      const gate = gateView(entries);

      assert.deepEqual(
        gate.entries.map((e) => [e.declared, e.kind, [...e.resolved], e.unresolved]),
        reference.entries.map((e) => [e.declared, e.kind, [...e.resolved], e.unresolved]),
        `the plan reader changed what the normalizer saw for ${label}`,
      );
      // D-65: the refusal-to-declare flag is derived from the declared list, as read.
      assert.equal(gate.declaredNothing, reference.declaredNothing, `declaredNothing drifted for ${label}`);
      assert.deepEqual([...gate.files], [...reference.files], `the union drifted for ${label}`);
    });
  }

  test('a stale glob and an empty declaration stay distinguishable through the plan reader', () => {
    // D-66 is a property of the semantics, not of one report: a stale glob has empty `files` while
    // keeping `declaredNothing` false.
    const stale = gateView(['does-not-exist/**']);
    assert.deepEqual([...stale.files], []);
    assert.equal(stale.declaredNothing, false);
    assert.equal(stale.entries[0].unresolved, true);

    const empty = gateView([]);
    assert.deepEqual([...empty.files], []);
    assert.equal(empty.declaredNothing, true);
  });
});
