'use strict';

/**
 * wave-survey.mjs — the driver that runs the wave checker across many trees.
 *
 * ── Why a driver exists at all ────────────────────────────────────────────
 *
 * `wave-normalize.mjs` answers for ONE phase directory. Criterion 1 of this
 * phase is not "the checker runs" — the ROADMAP is explicit that "a fixture
 * proves the solver runs, not that it fixes anything". Closing it means
 * pointing the checker at every reachable consuming tree and recording what
 * came back, and that is a question about 55 directories, not one.
 *
 * ── The exit precedence is the load-bearing property ──────────────────────
 *
 * The natural aggregation is "worst finding wins", and the natural reading of
 * "worst" is exit 1 — a violation is a real defect, exit 2 is merely a shrug.
 * That reading is backwards and would be the whole bug. A run that could not
 * read part of the tree has NOT surveyed that part, so summarising it by the
 * part it did read reports a partial survey as a complete one. Exit 2
 * therefore outranks exit 1, and the test below pins that with a root holding
 * one of each — the only arrangement where the two orderings differ.
 *
 * ── The determinism trap, again ───────────────────────────────────────────
 *
 * Byte-equality across two runs over the same trees is satisfied by a driver
 * that prints nothing at all. So equality is asserted alongside INEQUALITY
 * against a second, different root — the same pairing plan 01 used, for the
 * same reason. One assertion without the other proves nothing.
 *
 * ── Typed surfaces only ───────────────────────────────────────────────────
 *
 * The driver's source text is never read. Its exit code, its `--json` object
 * (via `JSON.parse`) and its stdout as a whole (for byte-equality) are the
 * observed surfaces; the table's column headings are asserted because the
 * table IS the operator-facing contract (local/no-source-grep).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'wave-survey.mjs',
);

/** 0 clean · 1 finding · 2 could not check. Same contract as the checker. */
const CLEAN = 0;
const FINDING = 1;
const CANNOT_CHECK = 2;

const RUN_TIMEOUT_MS = 60000;

describe('wave-survey driver', () => {
  /** Every temp root built by a test, torn down together. */
  let roots;

  beforeEach(() => {
    roots = [];
  });

  afterEach(() => {
    for (const r of roots) cleanup(r);
  });

  /** A fresh consuming tree: `<root>/.planning/phases/`. */
  function makeRoot(prefix) {
    const root = createTempDir(prefix);
    roots.push(root);
    return root;
  }

  /** A phase directory inside a root. */
  function makePhase(root, phaseName) {
    const dir = path.join(root, '.planning', 'phases', phaseName);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** A PLAN.md with a block-form `files_modified:` list. */
  function writePlan(phaseDir, name, wave, entries) {
    const list = entries.map((e) => `  - ${e}`).join('\n');
    const block = entries.length > 0 ? `files_modified:\n${list}\n` : 'files_modified:\n';
    fs.writeFileSync(
      path.join(phaseDir, name),
      `---\nphase: x\nplan: ${name}\nwave: ${wave}\n${block}autonomous: true\n---\n\n# ${name}\n`,
    );
  }

  /** A real file inside the root, so a declared path resolves to something. */
  function writeSource(root, rel, body = 'x\n') {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }

  /**
   * A phase whose two same-wave plans share a file — the checker exits 1.
   * Both plans declare a real file so the finding is a genuine collision
   * rather than an artefact of an unresolved entry.
   */
  function seedCollidingPhase(root, phaseName) {
    const dir = makePhase(root, phaseName);
    writeSource(root, 'src/shared.ts');
    writePlan(dir, '01-01-PLAN.md', 1, ['src/shared.ts']);
    writePlan(dir, '01-02-PLAN.md', 1, ['src/shared.ts']);
    return dir;
  }

  /** A phase with no overlap at all — the checker exits 0. */
  function seedCleanPhase(root, phaseName) {
    const dir = makePhase(root, phaseName);
    writeSource(root, 'src/a.ts');
    writeSource(root, 'src/b.ts');
    writePlan(dir, '01-01-PLAN.md', 1, ['src/a.ts']);
    writePlan(dir, '01-02-PLAN.md', 1, ['src/b.ts']);
    return dir;
  }

  /**
   * A phase the checker cannot read: a `PLAN.md` that is a DIRECTORY.
   * `wave-normalize.mjs` treats that as could-not-check and exits 2 — the
   * only exit-2 shape reachable purely by arranging files on disk.
   */
  function seedUncheckablePhase(root, phaseName) {
    const dir = makePhase(root, phaseName);
    fs.mkdirSync(path.join(dir, '01-01-PLAN.md'), { recursive: true });
    return dir;
  }

  /** Run the survey over the given roots. Returns the seam result. */
  function survey(rootList, extra = []) {
    const argv = [SCRIPT];
    for (const r of rootList) argv.push('--root', r);
    return runNode([...argv, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
  }

  /** Assert the process actually ran, then hand back the result. */
  function exited(result) {
    assert.equal(
      result.outcome,
      OUTCOME.EXITED,
      `survey did not exit cleanly: outcome=${result.outcome} stderr=${result.stderr}`,
    );
    return result;
  }

  describe('verdicts across many trees', () => {
    test('a colliding phase and a clean phase yield one row each, exit 1', () => {
      const dirty = makeRoot('gsd-survey-dirty-');
      const clean = makeRoot('gsd-survey-clean-');
      seedCollidingPhase(dirty, '01-collides');
      seedCleanPhase(clean, '01-fine');

      const r = exited(survey([dirty, clean], ['--json']));
      assert.equal(r.exitCode, FINDING);

      const out = JSON.parse(r.stdout);
      assert.equal(out.rows.length, 2, 'exactly one row per phase directory');

      const verdicts = out.rows.map((row) => row.verdict).sort();
      assert.deepEqual(verdicts, ['FINDING', 'OK']);
    });

    test('only clean phases exit 0', () => {
      const root = makeRoot('gsd-survey-allclean-');
      seedCleanPhase(root, '01-fine');
      seedCleanPhase(root, '02-also-fine');

      const r = exited(survey([root], ['--json']));
      assert.equal(r.exitCode, CLEAN);

      const out = JSON.parse(r.stdout);
      assert.equal(out.rows.length, 2);
      assert.ok(
        out.rows.every((row) => row.verdict === 'OK'),
        'every row is OK when no phase has a finding',
      );
      assert.equal(out.totals.finding, 0);
      assert.equal(out.totals.error, 0);
    });

    test('a finding row carries the pair count', () => {
      const root = makeRoot('gsd-survey-paircount-');
      seedCollidingPhase(root, '01-collides');

      const out = JSON.parse(exited(survey([root], ['--json'])).stdout);
      const row = out.rows[0];
      assert.equal(row.verdict, 'FINDING');
      assert.equal(row.pairs, 1, 'the one colliding pair is counted');
    });

    test('a clean row reports zero pairs, not a missing field', () => {
      const root = makeRoot('gsd-survey-zeropairs-');
      seedCleanPhase(root, '01-fine');

      const out = JSON.parse(exited(survey([root], ['--json'])).stdout);
      assert.equal(out.rows[0].pairs, 0);
    });
  });

  describe('an absent tree is not an unreadable one', () => {
    test('a root with no .planning/phases contributes zero rows and does not error', () => {
      const empty = makeRoot('gsd-survey-empty-');
      const populated = makeRoot('gsd-survey-populated-');
      seedCleanPhase(populated, '01-fine');

      const r = exited(survey([empty, populated], ['--json']));
      assert.equal(
        r.exitCode,
        CLEAN,
        'a tree that simply has no phases is not a tree that could not be read',
      );

      const out = JSON.parse(r.stdout);
      assert.equal(out.rows.length, 1, 'only the populated root contributes');
      assert.equal(out.totals.roots, 2, 'both roots are still accounted for');
      assert.equal(out.totals.rootsWithoutPhases, 1);
    });

    test('every root being empty is still exit 0', () => {
      const a = makeRoot('gsd-survey-empty-a-');
      const b = makeRoot('gsd-survey-empty-b-');

      const r = exited(survey([a, b], ['--json']));
      assert.equal(r.exitCode, CLEAN);
      assert.equal(JSON.parse(r.stdout).rows.length, 0);
    });
  });

  describe('exit precedence: could-not-check outranks a finding', () => {
    test('a phase exiting 2 makes the survey exit 2 even beside a phase exiting 1', () => {
      const root = makeRoot('gsd-survey-precedence-');
      seedCollidingPhase(root, '01-collides');
      seedUncheckablePhase(root, '02-unreadable');

      const r = exited(survey([root], ['--json']));
      assert.equal(
        r.exitCode,
        CANNOT_CHECK,
        'a run that could not check part of the tree must not be summarised by the part it did',
      );

      const out = JSON.parse(r.stdout);
      const verdicts = out.rows.map((row) => row.verdict).sort();
      assert.deepEqual(verdicts, ['ERROR', 'FINDING'], 'both phases keep their own verdict');
      assert.equal(out.totals.error, 1);
      assert.equal(out.totals.finding, 1);
    });

    test('an uncheckable phase alone exits 2', () => {
      const root = makeRoot('gsd-survey-error-only-');
      seedUncheckablePhase(root, '01-unreadable');

      const r = exited(survey([root], ['--json']));
      assert.equal(r.exitCode, CANNOT_CHECK);
      assert.equal(JSON.parse(r.stdout).rows[0].verdict, 'ERROR');
    });

    test('an uncheckable phase beside a clean one still exits 2', () => {
      const root = makeRoot('gsd-survey-error-clean-');
      seedCleanPhase(root, '01-fine');
      seedUncheckablePhase(root, '02-unreadable');

      const r = exited(survey([root], ['--json']));
      assert.equal(r.exitCode, CANNOT_CHECK, 'a clean majority does not absolve an unread phase');
    });
  });

  describe('determinism', () => {
    test('two runs over the same trees produce byte-identical stdout', () => {
      const root = makeRoot('gsd-survey-det-');
      seedCollidingPhase(root, '01-collides');
      seedCleanPhase(root, '02-fine');

      const first = exited(survey([root]));
      const second = exited(survey([root]));

      assert.equal(first.stdout, second.stdout, 'same trees, byte-identical output');
      assert.equal(first.exitCode, second.exitCode);
    });

    test('a different tree produces different output — equality alone proves nothing', () => {
      const a = makeRoot('gsd-survey-det-a-');
      const b = makeRoot('gsd-survey-det-b-');
      seedCollidingPhase(a, '01-collides');
      seedCleanPhase(b, '77-entirely-different');

      const outA = exited(survey([a])).stdout;
      const outB = exited(survey([b])).stdout;

      assert.notEqual(
        outA,
        outB,
        'byte-equality is satisfied by a driver that prints nothing; this rules that out',
      );
    });

    test('rows are sorted by root then phase regardless of creation order', () => {
      const root = makeRoot('gsd-survey-sorted-');
      // Created out of order on purpose: readdirSync order is not guaranteed.
      seedCleanPhase(root, '30-zulu');
      seedCleanPhase(root, '10-alpha');
      seedCleanPhase(root, '20-mike');

      const out = JSON.parse(exited(survey([root], ['--json'])).stdout);
      const phases = out.rows.map((row) => row.phase);
      assert.deepEqual(phases, [...phases].sort(), 'phase names come back sorted');
      assert.deepEqual(phases, ['10-alpha', '20-mike', '30-zulu']);
    });
  });

  describe('the table and --verbose', () => {
    test('the default output is a table carrying the column headings', () => {
      const root = makeRoot('gsd-survey-table-');
      seedCollidingPhase(root, '01-collides');

      const r = exited(survey([root]));
      // The table IS the operator-facing contract, so its headings are asserted.
      assert.match(r.stdout, /ROOT/);
      assert.match(r.stdout, /PHASE/);
      assert.match(r.stdout, /VERDICT/);
      assert.match(r.stdout, /01-collides/);
    });

    test('--json emits no table', () => {
      const root = makeRoot('gsd-survey-jsononly-');
      seedCollidingPhase(root, '01-collides');

      const r = exited(survey([root], ['--json']));
      // Parses cleanly as a single JSON document — no table text wrapped around it.
      const out = JSON.parse(r.stdout);
      assert.ok(Array.isArray(out.rows));
      assert.ok(out.totals && typeof out.totals === 'object');
    });

    test('--verbose reproduces a finding phase’s own checker output', () => {
      const root = makeRoot('gsd-survey-verbose-');
      seedCollidingPhase(root, '01-collides');

      const plain = exited(survey([root]));
      const loud = exited(survey([root], ['--verbose']));

      assert.ok(
        loud.stdout.length > plain.stdout.length,
        '--verbose appends the checker detail beneath the row',
      );
      // The checker's own heading for a collision, surfaced by the driver.
      assert.match(loud.stdout, /COLLIDING PAIRS/);
    });
  });

  describe('a large payload survives the pipe', () => {
    /**
     * Found by the mandated run against the real trees, not by a fixture.
     *
     * `legion-app/08.2-heimdall-runtime` — the flagship 40-file directory
     * collision — came back through the survey as `pairs=0`, while the same
     * checker run by hand reported 1 pair. Cause: the checker's `--json` is
     * 109741 bytes there, and `process.exit()` discards whatever of an async
     * pipe write has not flushed. To a FILE the payload arrived whole; to a
     * PIPE it was cut at exactly 65536 bytes. Every programmatic caller reads
     * a pipe, so the truncation was invisible by hand and total in automation.
     *
     * The survey then parsed the truncated JSON, failed, and quietly counted
     * zero pairs — a truncated read reported as a clean count, which is the
     * one outcome the exit contract exists to forbid.
     *
     * A phase big enough to exceed 64 KB of JSON is therefore built here, and
     * the pair count is asserted through the pipe.
     */
    test('a phase whose json exceeds 64KB still reports its pairs', () => {
      const root = makeRoot('gsd-survey-bigpayload-');
      const dir = makePhase(root, '01-big');

      // ~1200 files under one directory: comfortably past 64 KB of JSON once
      // each path appears in both plans' resolved lists and in `shared`.
      const deep = 'src/generated';
      for (let i = 0; i < 1200; i++) {
        writeSource(root, `${deep}/module-${String(i).padStart(5, '0')}.ts`);
      }
      // Both same-wave plans declare the DIRECTORY — the 08.2 shape exactly.
      writePlan(dir, '01-01-PLAN.md', 1, [deep]);
      writePlan(dir, '01-02-PLAN.md', 1, [deep]);

      const r = exited(survey([root], ['--json']));
      assert.equal(r.exitCode, FINDING);

      const out = JSON.parse(r.stdout);
      const row = out.rows[0];
      assert.equal(row.verdict, 'FINDING');
      assert.equal(
        row.pairs,
        1,
        'the pair count must survive a payload larger than the pipe buffer',
      );
    });
  });

  describe('could not check the invocation itself', () => {
    test('no --root at all exits 2, never 0', () => {
      const r = exited(runNode([SCRIPT], { timeoutMs: RUN_TIMEOUT_MS }));
      assert.equal(
        r.exitCode,
        CANNOT_CHECK,
        'surveying nothing is not a clean survey',
      );
    });

    test('a --root that does not exist exits 2', () => {
      const root = makeRoot('gsd-survey-absent-');
      const r = exited(survey([path.join(root, 'no-such-tree')]));
      assert.equal(r.exitCode, CANNOT_CHECK);
    });

    test('a --root pointing at a file exits 2', () => {
      const root = makeRoot('gsd-survey-file-root-');
      const asFile = path.join(root, 'not-a-dir');
      fs.writeFileSync(asFile, 'x\n');

      const r = exited(survey([asFile]));
      assert.equal(r.exitCode, CANNOT_CHECK);
    });

    test('--root with no value exits 2 rather than surveying nothing quietly', () => {
      const r = exited(runNode([SCRIPT, '--root'], { timeoutMs: RUN_TIMEOUT_MS }));
      assert.equal(r.exitCode, CANNOT_CHECK);
    });

    test('an uncaught throw exits 2, never Node’s default 1', () => {
      const root = makeRoot('gsd-survey-throw-');
      seedCleanPhase(root, '01-fine');

      // A copy of the driver with a throw injected into main(), so the
      // catch-all is observed rather than assumed. Exit 1 here would be
      // indistinguishable from a genuine finding.
      const src = fs.readFileSync(SCRIPT, 'utf8');
      const broken = path.join(root, 'broken-survey.mjs');
      fs.writeFileSync(
        broken,
        src.replace('function main() {', 'function main() {\n  throw new Error("injected");'),
      );

      const r = exited(
        runNode([broken, '--root', root], { timeoutMs: RUN_TIMEOUT_MS }),
      );
      assert.equal(r.exitCode, CANNOT_CHECK);
    });
  });
});
