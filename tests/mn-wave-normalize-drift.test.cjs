'use strict';

/**
 * The drift pin holding wave-normalize.mjs's classification equal to src/.
 *
 * ── Why the logic is duplicated at all ────────────────────────────────────
 *
 * `capabilities/mn-verify-gate/scripts/wave-normalize.mjs` re-expresses the
 * classification proven in `src/files-modified-normalize.cts`. It cannot import
 * it: capability scripts are installed to `~/.gsd/capabilities/.../scripts/` and
 * run as separate node processes, where `src/` does not exist. The established
 * convention in this fork is to duplicate the shape under a comment naming the
 * source (cf. `contract-drift.mjs:322`, `orphan-plans.mjs`'s status literals).
 *
 * A comment is not enforcement. Two independent implementations of the same
 * four-way classification that can drift apart is precisely the failure this
 * fork has already paid for once. So this file runs BOTH on identical inputs
 * and fails on the first disagreement.
 *
 * ── Why it runs the gate instead of importing it ──────────────────────────
 *
 * wave-normalize.mjs executes at module top level and reaches `process.exit`
 * before any export would be reachable, exactly like orphan-plans.mjs. A
 * dynamic `import()` of it would terminate the test process. So the gate's side
 * is observed through its `--json` output — a typed surface, `JSON.parse`d, not
 * grepped (local/no-source-grep) — while the reference side is called directly
 * as a function.
 *
 * Observing behaviour is also the stronger claim: an exported constant would
 * prove the gate *declares* the same rules; running it proves the gate *acts*
 * on them.
 *
 * ── What is compared ──────────────────────────────────────────────────────
 *
 * For each input entry, both implementations must agree on `kind` AND on the
 * sorted `resolved` list. Agreement on kind alone would let the two disagree
 * about which files a directory covers — the very thing normalisation exists to
 * decide.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  normalizePlanFiles,
} = require('../gsd-core/bin/lib/files-modified-normalize.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'wave-normalize.mjs',
);

const RUN_TIMEOUT_MS = 30000;

/**
 * The corpus. Each shape is one the live trees actually contain, so a
 * disagreement here is a disagreement about real input rather than about a
 * case neither implementation will ever meet.
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

describe('wave-normalize classification does not drift from src/', () => {
  let root;
  let phaseDir;

  beforeEach(() => {
    root = createTempDir('gsd-wave-drift-');
    phaseDir = path.join(root, '.planning', 'phases', '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });

    // One tree, shared by both implementations. Deliberately mixed depth so a
    // walker that stops at the first level disagrees with one that recurses.
    for (const rel of [
      'libs/m/testing/a.ts',
      'libs/m/testing/b.ts',
      'libs/m/testing/README.md',
      'libs/m/testing/src/factories/index.ts',
      'libs/m/testing/src/factories/token.factory.ts',
      'libs/m/top.ts',
      'tsconfig.base.json',
      'CLAUDE.md',
    ]) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, 'x\n');
    }
    fs.mkdirSync(path.join(root, 'libs/m/empty-dir'), { recursive: true });
  });

  afterEach(() => {
    cleanup(root);
  });

  /** The three-method FsProbe the reference implementation takes. */
  function probe() {
    const abs = (p) => (p === '' ? root : path.join(root, p));
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

  /** Run the gate over a one-plan phase and return its parsed view of it. */
  function gateView(entries) {
    const list = entries.map((e) => `  - ${JSON.stringify(e)}`).join('\n');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      `---\nphase: 01-x\nwave: 1\nfiles_modified:\n${list}\n---\n\n# a\n`,
    );

    const r = runNode([SCRIPT, '--dir', phaseDir, '--root', root, '--json'], {
      timeoutMs: RUN_TIMEOUT_MS,
    });
    assert.equal(r.outcome, OUTCOME.EXITED, 'the gate must run to completion');
    assert.notEqual(r.exitCode, 2, `the gate could not check: ${r.stderr}`);

    const out = JSON.parse(r.stdout);
    // A plan with no parseable entries still appears; an empty corpus entry
    // yields a plan with zero entries rather than no plan.
    return out.plans[0];
  }

  for (const entries of CORPUS) {
    const label = entries.length === 0 ? '(no entries)' : entries.join(' + ');

    test(`both implementations agree on: ${label}`, () => {
      const reference = normalizePlanFiles(entries, probe());
      const gate = gateView(entries);

      assert.equal(
        gate.entries.length,
        reference.entries.length,
        'the two must keep the same number of entries after dropping blanks',
      );

      for (let i = 0; i < reference.entries.length; i++) {
        const ref = reference.entries[i];
        const got = gate.entries[i];

        assert.equal(
          got.declared,
          ref.declared,
          `entry ${i} declared text drifted for ${label}`,
        );
        assert.equal(
          got.kind,
          ref.kind,
          `entry ${i} ("${ref.declared}") classified as ${got.kind} by the gate but ` +
            `${ref.kind} by src/files-modified-normalize.cts`,
        );
        // Agreement on kind alone would let the two disagree about WHICH files a
        // directory covers — the decision normalisation exists to make.
        assert.deepEqual(
          got.resolved,
          [...ref.resolved],
          `entry ${i} ("${ref.declared}") resolved differently`,
        );
        assert.equal(got.unresolved, ref.unresolved, `entry ${i} unresolved flag drifted`);
      }

      // D-65: the refusal-to-declare flag is derived the same way on both sides.
      assert.equal(
        gate.declaredNothing,
        reference.declaredNothing,
        `declaredNothing drifted for ${label}`,
      );
      assert.deepEqual(gate.files, [...reference.files], `the union drifted for ${label}`);
    });
  }

  test('a stale glob and an empty declaration stay distinguishable on BOTH sides', () => {
    // D-66 is a property of the semantics, not of one implementation's report.
    // Both sides must produce empty `files` for a stale glob while keeping
    // `declaredNothing` false — otherwise the split exists only in the printer.
    const staleRef = normalizePlanFiles(['does-not-exist/**'], probe());
    const emptyRef = normalizePlanFiles([], probe());

    assert.deepEqual([...staleRef.files], []);
    assert.equal(staleRef.declaredNothing, false);
    assert.deepEqual([...emptyRef.files], []);
    assert.equal(emptyRef.declaredNothing, true);

    const staleGate = gateView(['does-not-exist/**']);
    assert.deepEqual(staleGate.files, []);
    assert.equal(staleGate.declaredNothing, false);
    assert.equal(staleGate.entries[0].unresolved, true);
  });
});
