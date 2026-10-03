'use strict';

/**
 * wave-normalize.mjs — the gate that gives wave-collision its sight back.
 *
 * ── What is being pinned, and why the fixtures look like this ─────────────
 *
 * `wave-collision.mjs` compares only entries whose basename holds a dot. Every
 * directory and every glob is skipped, honestly reported, and never compared.
 * Measured across the 55 reachable phase directories: 2 collisions caught,
 * 17 phases where entries are skipped. The phase
 * `legion-app/08.2-heimdall-runtime` is the measured false negative — its own
 * `--verbose` line reads
 *
 *   "OK — 9 plan(s) across 8 wave(s), 1 pair(s) checked, no shared files"
 *   "13 non-file entr(ies) (directories or globs) were not compared"
 *
 * while `08.2-01-PLAN.md` and `08.2-01b-PLAN.md` both declare the directory
 * `libs/modules/heimdall/testing`. The first fixture below reconstructs that
 * exact shape — two same-wave plans, one directory entry, real files beneath
 * it — because a gate that only passes on synthesised input has not been shown
 * to close the defect it was written for.
 *
 * ── Why the heading assertions are not cosmetic ───────────────────────────
 *
 * All four verdicts exit 1. So the exit code proves nothing about whether a
 * declared-nothing plan and a stale glob stayed distinguishable — the property
 * D-66 demands, on the grounds that collapsing them is how a gate earns the
 * reputation that gets it disabled. The only observable that separates them is
 * WHICH heading a plan lands under, so the tests assert the pairing directly:
 * present under its own heading AND absent from the neighbouring one.
 *
 * ── Typed surfaces only ───────────────────────────────────────────────────
 *
 * Nothing here reads the gate's source text. The process's exit code, its
 * `--json` object, and `capability.json` parsed through `require` are the typed
 * surfaces (local/no-source-grep). The human-readable stderr headings are
 * asserted because they ARE the operator-facing contract of criterion 1 —
 * "names the overlapping pair and the shared file" is a claim about output.
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
  'wave-normalize.mjs',
);

/** 0 clean · 1 finding · 2 could not check. The distinction is the point. */
const CLEAN = 0;
const FINDING = 1;
const CANNOT_CHECK = 2;

const RUN_TIMEOUT_MS = 30000;

describe('wave-normalize gate', () => {
  let root;
  let phaseDir;

  beforeEach(() => {
    root = createTempDir('gsd-wave-normalize-');
    phaseDir = path.join(root, '.planning', 'phases', '01-x');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(root);
  });

  /** Write a PLAN.md carrying a block-form `files_modified:` list. */
  function writePlan(name, wave, entries) {
    const list = entries.map((e) => `  - ${e}`).join('\n');
    const block = entries.length > 0 ? `files_modified:\n${list}\n` : 'files_modified:\n';
    fs.writeFileSync(
      path.join(phaseDir, name),
      `---\nphase: 01-x\nplan: ${name}\nwave: ${wave}\n${block}autonomous: true\n---\n\n# ${name}\n`,
    );
  }

  /** Write a file inside the temp repo root, creating parents. */
  function writeTree(relPath, content = 'x\n') {
    const abs = path.join(root, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, '--root', root, ...extra], {
      timeoutMs: RUN_TIMEOUT_MS,
    });
  }

  // ── the payload must survive a pipe, not just a file ─────────────────────

  describe('a --json payload larger than the pipe buffer', () => {
    /**
     * Found by the plan-03-03 run against the real trees.
     *
     * On `legion-app/08.2-heimdall-runtime` this gate's `--json` is 109741
     * bytes. Redirected to a FILE it arrived whole; read through a PIPE it was
     * cut at exactly 65536 — `process.exit()` discards the unflushed tail of an
     * async pipe write. Every programmatic reader (the survey driver, the gate
     * runner) gets a pipe, so the truncation was invisible to a human running
     * the gate by hand and total for anything consuming it.
     *
     * The damage is worse than a short read: truncated JSON does not parse, and
     * a caller that treats an unparseable payload as "no findings" converts a
     * 40-file collision into a clean verdict. That is the false-negative class
     * this whole gate exists to close, reintroduced one layer up.
     */
    test('survives being read through a pipe, not merely written to a file', () => {
      // ~1200 files under one directory, declared by two same-wave plans:
      // past 64 KB of JSON once each path appears in both resolved lists.
      for (let i = 0; i < 1200; i++) {
        writeTree(`libs/gen/module-${String(i).padStart(5, '0')}.ts`);
      }
      writePlan('01-01-PLAN.md', 1, ['libs/gen']);
      writePlan('01-02-PLAN.md', 1, ['libs/gen']);

      const r = run(['--json']);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING);
      assert.ok(
        r.stdout.length > 65536,
        `payload was truncated at the pipe buffer: ${r.stdout.length} bytes`,
      );

      // Parses whole — the property truncation destroys.
      const out = JSON.parse(r.stdout);
      assert.equal(out.collisions.length, 1);
      assert.equal(out.collisions[0].shared.length, 1200);
    });
  });

  // ── criterion 1: the measured false negative becomes a named finding ──────

  describe('the 08.2 shape — a directory entry declared by two same-wave plans', () => {
    beforeEach(() => {
      writeTree('libs/m/testing/a.ts');
      writeTree('libs/m/testing/b.ts');
    });

    test('reports the collision, naming both plans and the shared resolved file', () => {
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      writePlan('01-01b-PLAN.md', 1, ['libs/m/testing']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(
        r.exitCode,
        FINDING,
        `the directory overlap wave-collision calls clean must be a finding: ${r.stdout}${r.stderr}`,
      );
      // Criterion 1 verbatim: "names the overlapping pair and the shared file".
      assert.match(r.stderr, /01-01-PLAN\.md/);
      assert.match(r.stderr, /01-01b-PLAN\.md/);
      assert.match(r.stderr, /libs\/m\/testing\/a\.ts/);
      assert.match(r.stderr, /COLLIDING PAIRS/);
    });

    test('the same two plans in DIFFERENT waves do not collide', () => {
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      writePlan('01-01b-PLAN.md', 2, ['libs/m/testing']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CLEAN, `${r.stdout}${r.stderr}`);
    });

    test('a directory against a file INSIDE it collides — the case the shipped gate cannot see at all', () => {
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      writePlan('01-02-PLAN.md', 1, ['libs/m/testing/a.ts']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /libs\/m\/testing\/a\.ts/);
      // b.ts is in the directory but not in the other plan — not shared.
      assert.doesNotMatch(r.stderr, /libs\/m\/testing\/b\.ts/);
    });

    test('two same-wave plans declaring DISJOINT directories are clean', () => {
      writeTree('libs/other/c.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      writePlan('01-02-PLAN.md', 1, ['libs/other']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CLEAN, `${r.stdout}${r.stderr}`);
    });

    test('a glob and a file it matches collide once resolved', () => {
      writePlan('01-01-PLAN.md', 1, ['libs/m/**']);
      writePlan('01-02-PLAN.md', 1, ['libs/m/testing/b.ts']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /libs\/m\/testing\/b\.ts/);
    });
  });

  // ── the blank-line quirk, paid for once already in wave-collision.mjs ─────

  test('a blank line inside the files_modified block does not close it', () => {
    // 08.2-01b-PLAN.md in the live tree is written exactly this way, and so are
    // 17 of 96 plans in one project. Reading the blank line as "end of list"
    // turns the plan into "declared nothing" and hides the real collision.
    writeTree('libs/m/testing/a.ts');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified:\n\n  - libs/m/testing\n\nautonomous: true\n---\n\n# a\n',
    );
    writePlan('01-02-PLAN.md', 1, ['libs/m/testing']);

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /libs\/m\/testing\/a\.ts/);
  });

  test('a YAML comment inside the files_modified block does not close it', () => {
    // Found by running the gate across all 55 reachable phase directories:
    // legion-app/08.3-gates/08.3-05-PLAN.md declares four files after three
    // `#` comment lines, and a parser that breaks on the first non-item line
    // reported it as DECLARED NOTHING. That is the exact miscategorisation
    // D-65 exists to prevent — a plan that DID declare, filed under "refused to
    // declare" — so the false positive is worse than the miss it replaced.
    writeTree('tools/verify-all.sh');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified:\n' +
        '  # ⚠️ verify-all.sh — the branch may not be taken; declared anyway\n' +
        '  # because an undeclared edit to a shared file breaks this very check\n' +
        '  - tools/verify-all.sh\nautonomous: true\n---\n\n# a\n',
    );

    const r = run(['--json']);
    assert.equal(r.outcome, OUTCOME.EXITED);
    const plan = JSON.parse(r.stdout).plans[0];
    assert.equal(plan.declaredNothing, false, 'a commented list is not an empty declaration');
    assert.deepEqual(
      plan.entries.map((e) => e.declared),
      ['tools/verify-all.sh'],
    );
  });

  test('a comment is not mistaken for a declared entry', () => {
    // The complementary error: skipping the comment must not ADD it as a path.
    writeTree('tools/a.sh');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  # a note\n  - tools/a.sh\n---\n\n# a\n',
    );

    const out = JSON.parse(run(['--json']).stdout);
    assert.equal(out.plans[0].entries.length, 1);
    assert.equal(out.plans[0].unparseable, undefined);
    assert.deepEqual(out.unparseable, []);
  });

  test('a trailing comment on an entry is stripped, not read as prose', () => {
    // Second finding of the 55-phase corpus run, same family as the leading-#
    // case: mn-konung/05-09-PLAN.md writes
    //   - apps/.../use-websocket.ts    # DELETED in this commit
    // Both paths are real. Keeping the comment makes the entry contain a space,
    // which the prose rule then files under UNPARSEABLE — the gate blaming the
    // planner for annotating a path correctly.
    writeTree('src/keep.ts');
    writeTree('src/other.ts');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified:\n' +
        '  - src/keep.ts    # NEW (task 3)\n' +
        '  - src/other.ts # DELETED in this commit\n---\n\n# a\n',
    );
    writePlan('01-02-PLAN.md', 1, ['src/keep.ts']);

    const r = run(['--json']);
    assert.equal(r.outcome, OUTCOME.EXITED);
    const out = JSON.parse(r.stdout);

    assert.deepEqual(out.unparseable, [], 'an annotated path is not prose');
    assert.deepEqual(
      out.plans[0].entries.map((e) => e.declared),
      ['src/keep.ts', 'src/other.ts'],
    );
    // And the stripped entry still participates in the comparison.
    assert.equal(r.exitCode, FINDING);
    assert.deepEqual(out.collisions[0].shared, ['src/keep.ts']);
  });

  test('a # inside a quoted entry is NOT treated as a comment', () => {
    // The boundary of the strip: a path may legitimately contain a hash.
    // Cutting at the first # regardless of quoting would corrupt it silently.
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  - "src/od#d.ts"\n---\n\n# a\n',
    );

    const out = JSON.parse(run(['--json']).stdout);
    assert.deepEqual(
      out.plans[0].entries.map((e) => e.declared),
      ['src/od#d.ts'],
    );
  });

  test('the LAST frontmatter line is not lost', () => {
    // A regex requiring `\n` after every list item drops the final entry: its
    // newline was eaten by the closing `---`. wave-collision.mjs records this
    // defect in a comment; the line-based parse here inherits the fix.
    writeTree('libs/m/last.ts');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  - libs/m/last.ts\n---\n\n# a\n',
    );
    writePlan('01-02-PLAN.md', 1, ['libs/m/last.ts']);

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /libs\/m\/last\.ts/);
  });

  test('the inline form files_modified: [a, b] is read', () => {
    writeTree('libs/m/x.ts');
    fs.writeFileSync(
      path.join(phaseDir, '01-01-PLAN.md'),
      '---\nphase: 01-x\nwave: 1\nfiles_modified: [libs/m/x.ts, "libs/m/y.ts"]\nautonomous: true\n---\n\n# a\n',
    );
    writePlan('01-02-PLAN.md', 1, ['libs/m/x.ts']);

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /libs\/m\/x\.ts/);
  });

  // ── criterion 2 & 4: the four verdicts stay four ──────────────────────────

  describe('the four verdicts do not collapse', () => {
    test('a plan declaring no files lands under DECLARED NOTHING and never reads as non-overlapping', () => {
      // D-65: an empty declaration is a refusal to make, not "shares nothing".
      writeTree('libs/m/a.ts');
      writePlan('01-01-PLAN.md', 1, []);
      writePlan('01-02-PLAN.md', 1, ['libs/m/a.ts']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /DECLARED NOTHING/);
      assert.match(r.stderr, /01-01-PLAN\.md/);
    });

    test('a glob resolving to nothing lands under RESOLVED TO NOTHING', () => {
      writePlan('01-01-PLAN.md', 1, ['does-not-exist/**']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /RESOLVED TO NOTHING/);
      assert.match(r.stderr, /does-not-exist/);
    });

    test('a declared-nothing plan is ABSENT from the RESOLVED TO NOTHING section', () => {
      // The exit code is 1 for both, so it proves nothing about the split.
      // Section membership is the only observable that does (D-66).
      writePlan('01-01-PLAN.md', 1, []);
      writePlan('01-02-PLAN.md', 1, ['gone/**']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);

      const declaredNothing = sectionOf(r.stderr, 'DECLARED NOTHING');
      const resolvedNothing = sectionOf(r.stderr, 'RESOLVED TO NOTHING');

      assert.match(declaredNothing, /01-01-PLAN\.md/);
      assert.doesNotMatch(declaredNothing, /01-02-PLAN\.md/);
      assert.match(resolvedNothing, /01-02-PLAN\.md/);
      assert.doesNotMatch(resolvedNothing, /01-01-PLAN\.md/);
    });

    test('a prose entry lands under UNPARSEABLE ENTRIES, distinct from both', () => {
      writePlan('01-01-PLAN.md', 1, ['"apps/x (9 files) — exact list from live scan"']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);

      const unparseable = sectionOf(r.stderr, 'UNPARSEABLE ENTRIES');
      assert.match(unparseable, /01-01-PLAN\.md/);
      assert.doesNotMatch(sectionOf(r.stderr, 'DECLARED NOTHING'), /01-01-PLAN\.md/);
      assert.doesNotMatch(sectionOf(r.stderr, 'RESOLVED TO NOTHING'), /01-01-PLAN\.md/);
    });

    test('a file that does not exist yet is NOT unresolved — the plan intends to create it', () => {
      // Treating a greenfield declaration as a stale glob would flag every new
      // plan and get the gate switched off on day one.
      writePlan('01-01-PLAN.md', 1, ['src/brand-new.ts']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CLEAN, `${r.stdout}${r.stderr}`);
    });
  });

  // ── boundary coverage on the pair loop: 0, 1, 2 plans ─────────────────────

  describe('plan-count boundaries — where the nested pair loop silently does nothing', () => {
    test('a phase with zero plans exits 0', () => {
      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CLEAN, `${r.stdout}${r.stderr}`);
    });

    test('a phase with one plan exits 0 — zero pairs to check', () => {
      writeTree('libs/m/a.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/a.ts']);

      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CLEAN, `${r.stdout}${r.stderr}`);
    });

    test('a wave holding exactly one plan checks zero pairs; a second plan makes one', () => {
      writeTree('libs/m/a.ts');
      writeTree('libs/m/b.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/a.ts']);
      writePlan('01-02-PLAN.md', 2, ['libs/m/b.ts']);

      const oneEach = run(['--json']);
      assert.equal(oneEach.outcome, OUTCOME.EXITED);
      assert.equal(oneEach.exitCode, CLEAN, `${oneEach.stdout}${oneEach.stderr}`);
      assert.equal(JSON.parse(oneEach.stdout).pairsChecked, 0);

      writePlan('01-02-PLAN.md', 1, ['libs/m/b.ts']);
      const bothInOne = run(['--json']);
      assert.equal(bothInOne.outcome, OUTCOME.EXITED);
      assert.equal(bothInOne.exitCode, CLEAN, `${bothInOne.stdout}${bothInOne.stderr}`);
      assert.equal(JSON.parse(bothInOne.stdout).pairsChecked, 1);
    });

    test('three same-wave plans check three pairs', () => {
      for (const n of ['a', 'b', 'c']) writeTree(`libs/m/${n}.ts`);
      writePlan('01-01-PLAN.md', 1, ['libs/m/a.ts']);
      writePlan('01-02-PLAN.md', 1, ['libs/m/b.ts']);
      writePlan('01-03-PLAN.md', 1, ['libs/m/c.ts']);

      const r = run(['--json']);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(JSON.parse(r.stdout).pairsChecked, 3);
    });
  });

  // ── the could-not-check contract ──────────────────────────────────────────

  describe('exit 2 — could not check, never mistaken for a finding', () => {
    test('a missing --dir exits 2', () => {
      const r = runNode([SCRIPT], { timeoutMs: RUN_TIMEOUT_MS });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CANNOT_CHECK, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /UNKNOWN:/);
    });

    test('a phase directory that does not exist exits 2', () => {
      const r = runNode([SCRIPT, '--dir', path.join(root, 'nope'), '--root', root], {
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CANNOT_CHECK, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /UNKNOWN:/);
    });

    test('a --dir pointing at a FILE exits 2, not 0', () => {
      const asFile = path.join(root, 'a-file');
      fs.writeFileSync(asFile, 'x');
      const r = runNode([SCRIPT, '--dir', asFile, '--root', root], { timeoutMs: RUN_TIMEOUT_MS });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CANNOT_CHECK, `${r.stdout}${r.stderr}`);
    });

    test('a PLAN.md that is a directory exits 2 rather than being silently skipped', () => {
      // An unreadable plan is "could not look", which must not read as clean.
      fs.mkdirSync(path.join(phaseDir, '01-01-PLAN.md'), { recursive: true });
      const r = run();
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CANNOT_CHECK, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /UNKNOWN:/);
    });

    test('an UNCAUGHT throw exits 2, not Node default 1', () => {
      // The whole reason the script has a single exit point. Node exits 1 on an
      // uncaught exception, which a gate runner reads as "found a collision" —
      // indistinguishable from a real finding, and a false halt is worse than a
      // miss. Proven by running a copy with a throw injected into main(), since
      // no legitimate input reaches that branch.
      const src = fs.readFileSync(SCRIPT, 'utf8');
      assert.ok(src.includes('function main() {'), 'anchor must exist for the injection');
      const broken = path.join(root, 'wave-normalize-throwing.mjs');
      fs.writeFileSync(
        broken,
        src.replace('function main() {', "function main() {\n  throw new Error('injected');"),
      );

      const r = runNode([broken, '--dir', phaseDir, '--root', root], {
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CANNOT_CHECK, 'an uncaught throw must be could-not-check');
      assert.notEqual(r.exitCode, FINDING, 'a crash must never read as a finding');
      assert.match(r.stderr, /UNKNOWN:/);
    });

    test('a --root that does not exist exits 2', () => {
      writePlan('01-01-PLAN.md', 1, ['libs/m/a.ts']);
      const r = runNode([SCRIPT, '--dir', phaseDir, '--root', path.join(root, 'absent-root')], {
        timeoutMs: RUN_TIMEOUT_MS,
      });
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CANNOT_CHECK, `${r.stdout}${r.stderr}`);
    });
  });

  // ── --json is the machine surface ─────────────────────────────────────────

  describe('--json', () => {
    test('carries per-plan declared entries and their kinds, and exits like the human path', () => {
      writeTree('libs/m/testing/a.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      writePlan('01-02-PLAN.md', 1, ['libs/m/testing/a.ts']);

      const r = run(['--json']);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, FINDING, `${r.stdout}${r.stderr}`);

      const out = JSON.parse(r.stdout);
      assert.equal(out.exitCode, FINDING);

      const first = out.plans.find((p) => p.name === '01-01-PLAN.md');
      assert.ok(first, 'the plan must appear in the json');
      assert.equal(first.wave, 1);
      assert.equal(first.declaredNothing, false);
      assert.equal(first.entries[0].declared, 'libs/m/testing');
      assert.equal(first.entries[0].kind, 'directory');
      assert.deepEqual(first.entries[0].resolved, ['libs/m/testing/a.ts']);

      const second = out.plans.find((p) => p.name === '01-02-PLAN.md');
      assert.equal(second.entries[0].kind, 'file');

      assert.equal(out.collisions.length, 1);
      assert.equal(out.collisions[0].wave, 1);
      assert.deepEqual(out.collisions[0].shared, ['libs/m/testing/a.ts']);
    });

    test('separates declaredNothing from unresolved in the parsed object', () => {
      writePlan('01-01-PLAN.md', 1, []);
      writePlan('01-02-PLAN.md', 1, ['gone/**']);

      const r = run(['--json']);
      assert.equal(r.outcome, OUTCOME.EXITED);
      const out = JSON.parse(r.stdout);

      const nothing = out.plans.find((p) => p.name === '01-01-PLAN.md');
      const stale = out.plans.find((p) => p.name === '01-02-PLAN.md');

      assert.equal(nothing.declaredNothing, true);
      assert.equal(nothing.entries.length, 0);

      // The stale glob DID declare something; only its resolution is empty.
      assert.equal(stale.declaredNothing, false);
      assert.equal(stale.entries[0].kind, 'glob');
      assert.equal(stale.entries[0].unresolved, true);
    });

    test('a clean phase emits json and exits 0', () => {
      writeTree('libs/m/a.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/a.ts']);

      const r = run(['--json']);
      assert.equal(r.outcome, OUTCOME.EXITED);
      assert.equal(r.exitCode, CLEAN, `${r.stdout}${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.exitCode, CLEAN);
      assert.equal(out.collisions.length, 0);
    });
  });

  // ── determinism (criterion 3), and its trap ───────────────────────────────

  describe('determinism', () => {
    test('two runs on unchanged input produce byte-identical json', () => {
      writeTree('libs/m/testing/a.ts');
      writeTree('libs/m/testing/z.ts');
      writeTree('libs/m/testing/nested/b.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      writePlan('01-02-PLAN.md', 1, ['libs/m/testing/z.ts']);

      const first = run(['--json']);
      const second = run(['--json']);
      assert.equal(first.outcome, OUTCOME.EXITED);
      assert.equal(second.outcome, OUTCOME.EXITED);
      assert.equal(first.stdout, second.stdout);
    });

    test('and the output CHANGES with the input — determinism is not a constant', () => {
      // Criterion 3's trap: a gate that always answers the same thing is
      // trivially deterministic and worthless. Stability must be shown next to
      // sensitivity, or it proves only that nothing is being computed.
      writeTree('libs/m/testing/a.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);
      const before = run(['--json']).stdout;

      writeTree('libs/m/testing/added.ts');
      const after = run(['--json']).stdout;

      assert.notEqual(before, after, 'a new file under the declared directory must change the answer');
    });

    test('resolved file lists are sorted regardless of creation order', () => {
      // readdirSync order is not guaranteed; the sort must be explicit.
      writeTree('libs/m/testing/z.ts');
      writeTree('libs/m/testing/a.ts');
      writeTree('libs/m/testing/m.ts');
      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);

      const out = JSON.parse(run(['--json']).stdout);
      const resolved = out.plans[0].entries[0].resolved;
      assert.deepEqual(resolved, [...resolved].sort());
      assert.deepEqual(resolved, [
        'libs/m/testing/a.ts',
        'libs/m/testing/m.ts',
        'libs/m/testing/z.ts',
      ]);
    });
  });

  // ── T-03-01: the walk stays inside --root ─────────────────────────────────

  describe('containment', () => {
    test('a symlinked directory is not followed out of the tree', () => {
      const outside = path.join(root, '..', `escape-${path.basename(root)}`);
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'secret.ts'), 'x');

      fs.mkdirSync(path.join(root, 'libs/m/testing'), { recursive: true });
      fs.symlinkSync(outside, path.join(root, 'libs/m/testing/link'));
      writeTree('libs/m/testing/a.ts');

      writePlan('01-01-PLAN.md', 1, ['libs/m/testing']);

      const r = run(['--json']);
      cleanup(outside);

      assert.equal(r.outcome, OUTCOME.EXITED);
      const resolved = JSON.parse(r.stdout).plans[0].entries[0].resolved;
      assert.deepEqual(resolved, ['libs/m/testing/a.ts']);
      assert.ok(
        !resolved.some((f) => f.includes('secret.ts')),
        'the walk must not follow a symlink out of the repository',
      );
    });

    test('an entry escaping the root via .. is refused rather than resolved', () => {
      writePlan('01-01-PLAN.md', 1, ['../outside/x.ts']);

      const r = run(['--json']);
      assert.equal(r.outcome, OUTCOME.EXITED);
      const entry = JSON.parse(r.stdout).plans[0].entries[0];
      assert.equal(entry.kind, 'malformed');
    });
  });

  // ── registration (task 3) ─────────────────────────────────────────────────

  describe('registration in capability.json', () => {
    const capability = require('../capabilities/mn-verify-gate/capability.json');

    test('the gate sits at index 16 — the array position is execution order', () => {
      // Pinned by index, not "last": gates registered after this one append at
      // the end and must not move it. What matters is that it was appended after
      // the sixteen already verified, and that nothing has been inserted before it.
      assert.equal(capability.gates[16].when, 'workflow.wave_normalize');
    });

    test('it is a command-exit-zero predicate at plan:post, blocking, halting on error', () => {
      const last = capability.gates[16];
      assert.equal(last.point, 'plan:post');
      assert.equal(last.check.predicate.kind, 'command-exit-zero');
      assert.equal(last.check.predicate.timeout, 60);
      assert.equal(last.blocking, true);
      assert.equal(last.onError, 'halt');
      assert.match(last.check.predicate.command, /wave-normalize\.mjs/);
      assert.match(last.check.predicate.command, /\$\{PHASE_DIR\}/);
    });

    test('the config key defaults to false — enabling it is a choice', () => {
      assert.equal(capability.config['workflow.wave_normalize'].type, 'boolean');
      assert.equal(capability.config['workflow.wave_normalize'].default, false);
    });

    test('appending did not disturb the sixteen gates already verified', () => {
      // A floor, not an exact count: gates registered after this one append at
      // the end (the same convention this test pins), and each of them would
      // otherwise have to edit this line.
      assert.ok(capability.gates.length >= 17, `expected at least 17 gates, got ${capability.gates.length}`);
      assert.deepEqual(
        capability.gates.slice(0, 16).map((g) => g.when),
        [
          'workflow.nyquist_enforce',
          'workflow.verify_enforce',
          'workflow.verify_gates_enforce',
          'workflow.uat_enforce',
          'workflow.mutation_spot_check',
          'workflow.mn_security_enforce',
          'workflow.mn_windows_enforce',
          'workflow.assertion_ratchet',
          'workflow.migration_safety',
          'workflow.migration_safety_strict',
          'workflow.blast_radius',
          'workflow.contract_drift',
          'workflow.wave_collision',
          'workflow.orphan_plans',
          'workflow.wave_solve',
          'workflow.plan_status_enforce',
        ],
      );
    });
  });
});

/**
 * The text under a heading, up to the next ALL-CAPS heading or the end.
 *
 * Section membership is the ONLY observable separating a declared-nothing plan
 * from a stale glob — both exit 1 — so the split is asserted here rather than
 * inferred from an exit code that is identical for both (D-66).
 */
function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start + heading.length);
  const next = rest.search(/\n(?:COLLIDING PAIRS|DECLARED NOTHING|RESOLVED TO NOTHING|UNPARSEABLE ENTRIES)\b/);
  return next === -1 ? rest : rest.slice(0, next);
}
