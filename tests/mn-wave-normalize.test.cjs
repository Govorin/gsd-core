'use strict';

/**
 * `gsd_run check mn-wave-collision`, expand mode — wave collision with its sight back
 * (src/gate-mn-waves.cts over src/files-modified-normalize.cts; replaces
 * capabilities/mn-verify-gate/scripts/wave-normalize.mjs).
 *
 * Literal comparison sees only entries with a dot in the basename. Measured across 55 reachable
 * phase directories: 2 collisions caught, 17 phases with entries skipped. On
 * `legion-app/08.2-heimdall-runtime` it reported "no shared files" while `08.2-01-PLAN.md` and
 * `08.2-01b-PLAN.md` both declared the directory `libs/modules/heimdall/testing` (40 files). The
 * first fixtures below rebuild that exact shape.
 *
 * Expand mode is switched on by `workflow.wave_normalize: true` (the config the capability gate
 * keys on) — every test here runs with it, except the one pinning the manual `--expand` flag. The
 * four findings (D-65, D-66) stay separately observable in typed payload fields; the full
 * per-plan resolution is pinned through `analyzeWaveCollision`, the in-process surface.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, writeFiles, writeWorkflowConfig, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const { evaluateMnWaveCollision, analyzeWaveCollision, MAX_LISTED, MAX_SHARED_LISTED } = require('../gsd-core/bin/lib/gate-mn-waves.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** A PLAN.md carrying a block-form `files_modified:` list (empty list → the bare key). */
function plan(name, wave, entries) {
  const list = entries.map((e) => `  - ${e}`).join('\n');
  const block = entries.length > 0 ? `files_modified:\n${list}\n` : 'files_modified:\n';
  return `---\nphase: 01-x\nplan: ${name}\nwave: ${wave}\n${block}autonomous: true\n---\n\n# ${name}\n`;
}

describe('check mn-wave-collision (expand mode)', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-wave-normalize-');
    writeWorkflowConfig(projectDir, { wave_normalize: true });
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  /** Files in the project tree the entries resolve against. */
  function tree(...rels) {
    writeFiles(projectDir, Object.fromEntries(rels.map((r) => [r, 'x\n'])));
  }

  function phase(files) {
    return makePhase(projectDir, files);
  }

  function gateOn(files, extra = []) {
    const { phaseNumber } = phase(files);
    return evaluateMnWaveCollision({ projectDir, args: [phaseNumber, ...extra] }).payload;
  }

  function analyze(files) {
    const { phaseDir } = phase(files);
    return analyzeWaveCollision(projectDir, phaseDir, 'expand');
  }

  // ── the mode switch ───────────────────────────────────────────────────────

  test('workflow.wave_normalize switches the verb to expand mode', () => {
    tree('libs/m/testing/a.ts');
    const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-01b-PLAN.md': plan('b', 1, ['libs/m/testing']) });
    assert.equal(v.mode, 'expand');
    assert.equal(v.block, true);
  });

  test('without the config key, --expand switches it by hand', () => {
    writeWorkflowConfig(projectDir, { wave_normalize: false });
    tree('libs/m/testing/a.ts');
    const files = { '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-01b-PLAN.md': plan('b', 1, ['libs/m/testing']) };
    const literal = gateOn(files);
    assert.equal(literal.mode, 'literal');
    assert.equal(literal.block, false, 'literal mode cannot see a directory collision — the measured false negative');
    const expanded = gateOn(files, ['--expand']);
    assert.equal(expanded.mode, 'expand');
    assert.equal(expanded.block, true);
  });

  // ── the payload stays readable by the dispatcher ──────────────────────────

  describe('a collision over a large directory', () => {
    /**
     * The script's `--json` on 08.2 was 109741 bytes and was cut at the 65536-byte pipe buffer.
     * gsd-tools swaps any payload over ~50 KB for an `@file:` pointer, which the dispatcher's jq
     * cannot read — an oversized verdict would read as "no block". So the payload lists at most
     * MAX_SHARED_LISTED shared files and carries the true count.
     */
    test('yields a compact verdict the dispatcher can parse, with the true shared count', () => {
      for (let i = 0; i < 1200; i++) tree(`libs/gen/module-${String(i).padStart(5, '0')}.ts`);
      const { phaseDir } = phase({ '01-01-PLAN.md': plan('a', 1, ['libs/gen']), '01-02-PLAN.md': plan('b', 1, ['libs/gen']) });
      const payload = runMnCheck(projectDir, 'mn-wave-collision', [phaseDir]);
      assert.equal(payload.block, true);
      assert.equal(payload.collisions.length, 1);
      assert.equal(payload.collisions[0].sharedCount, 1200);
      assert.equal(payload.collisions[0].shared.length, MAX_SHARED_LISTED);
    });

    test('shared files are listed whole up to the cap, and capped one past it', () => {
      for (const n of [MAX_SHARED_LISTED - 1, MAX_SHARED_LISTED, MAX_SHARED_LISTED + 1]) {
        const dir = `libs/cap${n}`;
        for (let i = 0; i < n; i++) tree(`${dir}/f${String(i).padStart(3, '0')}.ts`);
        const v = gateOn({ '01-01-PLAN.md': plan('a', 1, [dir]), '01-02-PLAN.md': plan('b', 1, [dir]) });
        assert.equal(v.collisions[0].sharedCount, n);
        assert.equal(v.collisions[0].shared.length, Math.min(n, MAX_SHARED_LISTED), `n=${n}`);
      }
    });

    test('colliding pairs are listed up to MAX_LISTED, counted beyond it', () => {
      // MAX_LISTED + 1 pairs from plans sharing one file in one wave: k plans make k(k-1)/2 pairs.
      let k = 2;
      while ((k * (k - 1)) / 2 <= MAX_LISTED) k++;
      const files = {};
      for (let i = 0; i < k; i++) files[`01-${String(i).padStart(2, '0')}-PLAN.md`] = plan(String(i), 1, ['src/shared.ts']);
      const v = gateOn(files);
      assert.equal(v.counts.collisions, (k * (k - 1)) / 2);
      assert.ok(v.counts.collisions > MAX_LISTED);
      assert.equal(v.collisions.length, MAX_LISTED);
    });
  });

  // ── criterion 1: the measured false negative becomes a named finding ──────

  describe('the 08.2 shape — a directory entry declared by two same-wave plans', () => {
    beforeEach(() => {
      tree('libs/m/testing/a.ts', 'libs/m/testing/b.ts');
    });

    test('reports the collision, naming both plans and the shared resolved files', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-01b-PLAN.md': plan('b', 1, ['libs/m/testing']) });
      assert.equal(v.block, true);
      assert.deepEqual(v.collisions, [
        { wave: 1, a: '01-01-PLAN.md', b: '01-01b-PLAN.md', shared: ['libs/m/testing/a.ts', 'libs/m/testing/b.ts'], sharedCount: 2 },
      ]);
    });

    test('the same two plans in DIFFERENT waves do not collide', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-01b-PLAN.md': plan('b', 2, ['libs/m/testing']) });
      assert.equal(v.block, false);
    });

    test('a directory against a file INSIDE it collides — the case literal mode cannot see', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-02-PLAN.md': plan('b', 1, ['libs/m/testing/a.ts']) });
      assert.equal(v.block, true);
      // b.ts is in the directory but not in the other plan — not shared.
      assert.deepEqual(v.collisions[0].shared, ['libs/m/testing/a.ts']);
    });

    test('two same-wave plans declaring DISJOINT directories are clean', () => {
      tree('libs/other/c.ts');
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-02-PLAN.md': plan('b', 1, ['libs/other']) });
      assert.equal(v.block, false);
    });

    test('a glob and a file it matches collide once resolved', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/**']), '01-02-PLAN.md': plan('b', 1, ['libs/m/testing/b.ts']) });
      assert.deepEqual(v.collisions[0].shared, ['libs/m/testing/b.ts']);
    });
  });

  // ── reading the plan: the quirks paid for once already ────────────────────

  test('a blank line inside the files_modified block does not close it', () => {
    // 17 of 96 plans in one project are written this way; "end of list" would hide the collision.
    tree('libs/m/testing/a.ts');
    const v = gateOn({
      '01-01-PLAN.md': '---\nphase: 01-x\nwave: 1\nfiles_modified:\n\n  - libs/m/testing\n\nautonomous: true\n---\n\n# a\n',
      '01-02-PLAN.md': plan('b', 1, ['libs/m/testing']),
    });
    assert.deepEqual(v.collisions[0].shared, ['libs/m/testing/a.ts']);
  });

  test('a YAML comment inside the files_modified block does not close it', () => {
    // legion-app/08.3-gates/08.3-05-PLAN.md declares four files after three `#` lines; a parser
    // breaking there filed a plan that DID declare under "refused to declare" (D-65).
    tree('tools/verify-all.sh');
    const a = analyze({
      '01-01-PLAN.md':
        '---\nphase: 01-x\nwave: 1\nfiles_modified:\n' +
        '  # ⚠️ verify-all.sh — the branch may not be taken; declared anyway\n' +
        '  # because an undeclared edit to a shared file breaks this very check\n' +
        '  - tools/verify-all.sh\nautonomous: true\n---\n\n# a\n',
    });
    assert.equal(a.plans[0].declaredNothing, false, 'a commented list is not an empty declaration');
    assert.deepEqual(a.plans[0].entries.map((e) => e.declared), ['tools/verify-all.sh']);
  });

  test('a comment is not mistaken for a declared entry', () => {
    tree('tools/a.sh');
    const a = analyze({ '01-01-PLAN.md': '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  # a note\n  - tools/a.sh\n---\n\n# a\n' });
    assert.equal(a.plans[0].entries.length, 1);
    assert.deepEqual(a.unparseable, []);
  });

  test('a trailing comment on an entry is stripped, not read as prose', () => {
    // mn-konung/05-09-PLAN.md: `- apps/.../use-websocket.ts    # DELETED in this commit`.
    tree('src/keep.ts', 'src/other.ts');
    const files = {
      '01-01-PLAN.md': '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  - src/keep.ts    # NEW (task 3)\n  - src/other.ts # DELETED in this commit\n---\n\n# a\n',
      '01-02-PLAN.md': plan('b', 1, ['src/keep.ts']),
    };
    const { phaseDir, phaseNumber } = phase(files);
    const a = analyzeWaveCollision(projectDir, phaseDir, 'expand');
    assert.deepEqual(a.unparseable, [], 'an annotated path is not prose');
    assert.deepEqual(a.plans[0].entries.map((e) => e.declared), ['src/keep.ts', 'src/other.ts']);
    const v = evaluateMnWaveCollision({ projectDir, args: [phaseNumber] }).payload;
    assert.equal(v.block, true);
    assert.deepEqual(v.collisions[0].shared, ['src/keep.ts']);
  });

  test('a # inside a quoted entry is NOT treated as a comment', () => {
    const a = analyze({ '01-01-PLAN.md': '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  - "src/od#d.ts"\n---\n\n# a\n' });
    assert.deepEqual(a.plans[0].entries.map((e) => e.declared), ['src/od#d.ts']);
  });

  test('the LAST frontmatter line is not lost', () => {
    tree('libs/m/last.ts');
    const v = gateOn({
      '01-01-PLAN.md': '---\nphase: 01-x\nwave: 1\nfiles_modified:\n  - libs/m/last.ts\n---\n\n# a\n',
      '01-02-PLAN.md': plan('b', 1, ['libs/m/last.ts']),
    });
    assert.deepEqual(v.collisions[0].shared, ['libs/m/last.ts']);
  });

  test('the inline form files_modified: [a, b] is read', () => {
    tree('libs/m/x.ts');
    const v = gateOn({
      '01-01-PLAN.md': '---\nphase: 01-x\nwave: 1\nfiles_modified: [libs/m/x.ts, "libs/m/y.ts"]\nautonomous: true\n---\n\n# a\n',
      '01-02-PLAN.md': plan('b', 1, ['libs/m/x.ts']),
    });
    assert.deepEqual(v.collisions[0].shared, ['libs/m/x.ts']);
  });

  // ── criterion 2 & 4: the four verdicts stay four ──────────────────────────

  describe('the four verdicts do not collapse', () => {
    test('a plan declaring no files lands under declaredNothing and never reads as non-overlapping', () => {
      // D-65: an empty declaration is a refusal to make, not "shares nothing".
      tree('libs/m/a.ts');
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, []), '01-02-PLAN.md': plan('b', 1, ['libs/m/a.ts']) });
      assert.equal(v.block, true);
      assert.deepEqual(v.declaredNothing, ['01-01-PLAN.md']);
      assert.deepEqual(v.collisions, []);
    });

    test('a glob resolving to nothing lands under resolvedToNothing', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['does-not-exist/**']) });
      assert.equal(v.block, true);
      assert.deepEqual(v.resolvedToNothing, [{ plan: '01-01-PLAN.md', declared: 'does-not-exist/**', kind: 'glob' }]);
    });

    test('a declared-nothing plan is ABSENT from resolvedToNothing, and the stale glob from declaredNothing', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, []), '01-02-PLAN.md': plan('b', 1, ['gone/**']) });
      assert.deepEqual(v.declaredNothing, ['01-01-PLAN.md']);
      assert.deepEqual(v.resolvedToNothing.map((r) => r.plan), ['01-02-PLAN.md']);
    });

    test('a prose entry lands under unparseable, distinct from both', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['"apps/x (9 files) — exact list from live scan"']) });
      assert.equal(v.block, true);
      assert.deepEqual(v.unparseable.map((u) => u.plan), ['01-01-PLAN.md']);
      assert.deepEqual([v.declaredNothing, v.resolvedToNothing], [[], []]);
    });

    test('an empty directory lands under resolvedToNothing as a directory', () => {
      fs.mkdirSync(path.join(projectDir, 'libs/empty'), { recursive: true });
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/empty']) });
      assert.deepEqual(v.resolvedToNothing, [{ plan: '01-01-PLAN.md', declared: 'libs/empty', kind: 'directory' }]);
    });

    test('a file that does not exist yet is NOT unresolved — the plan intends to create it', () => {
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['src/brand-new.ts']) });
      assert.equal(v.block, false);
    });
  });

  // ── boundary coverage on the pair loop: 0, 1, 2, 3 plans ──────────────────

  describe('plan-count boundaries — where the nested pair loop silently does nothing', () => {
    test('a phase with zero plans passes', () => {
      const v = gateOn({});
      assert.equal(v.block, false);
      assert.equal(v.pairsChecked, 0);
    });

    test('a phase with one plan passes — zero pairs to check', () => {
      tree('libs/m/a.ts');
      const v = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/a.ts']) });
      assert.equal(v.block, false);
      assert.equal(v.pairsChecked, 0);
    });

    test('a wave holding exactly one plan checks zero pairs; a second plan makes one', () => {
      tree('libs/m/a.ts', 'libs/m/b.ts');
      assert.equal(gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/a.ts']), '01-02-PLAN.md': plan('b', 2, ['libs/m/b.ts']) }).pairsChecked, 0);
      const both = gateOn({ '01-01-PLAN.md': plan('a', 1, ['libs/m/a.ts']), '01-02-PLAN.md': plan('b', 1, ['libs/m/b.ts']) });
      assert.equal(both.block, false);
      assert.equal(both.pairsChecked, 1);
    });

    test('three same-wave plans check three pairs', () => {
      tree('libs/m/a.ts', 'libs/m/b.ts', 'libs/m/c.ts');
      const v = gateOn({
        '01-01-PLAN.md': plan('a', 1, ['libs/m/a.ts']),
        '01-02-PLAN.md': plan('b', 1, ['libs/m/b.ts']),
        '01-03-PLAN.md': plan('c', 1, ['libs/m/c.ts']),
      });
      assert.equal(v.pairsChecked, 3);
    });
  });

  // ── could not check, never mistaken for a finding ─────────────────────────

  describe('unresolvable — could not check', () => {
    test('a phase that does not exist is unresolvable', () => {
      const v = evaluateMnWaveCollision({ projectDir, args: ['77'] }).payload;
      assert.equal(v.status, 'unresolvable');
      assert.equal(v.block, true);
    });

    test('a path naming a FILE rather than a phase directory is unresolvable', () => {
      fs.writeFileSync(path.join(projectDir, 'a-file'), 'x');
      assert.equal(evaluateMnWaveCollision({ projectDir, args: ['./a-file'] }).payload.status, 'unresolvable');
    });

    test('a PLAN.md that is a directory is unresolvable rather than silently skipped', () => {
      const { phaseDir, phaseNumber } = phase({});
      fs.mkdirSync(path.join(phaseDir, '01-01-PLAN.md'));
      const v = evaluateMnWaveCollision({ projectDir, args: [phaseNumber] }).payload;
      assert.equal(v.status, 'unresolvable');
    });

    test('no phase argument is a usage failure', () => {
      assert.ok(evaluateMnWaveCollision({ projectDir, args: [] }).failure);
    });
  });

  // ── the in-process analysis: per-plan entries ─────────────────────────────

  describe('analyzeWaveCollision', () => {
    test('carries per-plan declared entries, their kinds and resolutions', () => {
      tree('libs/m/testing/a.ts');
      const a = analyze({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-02-PLAN.md': plan('b', 1, ['libs/m/testing/a.ts']) });
      const first = a.plans.find((p) => p.plan === '01-01-PLAN.md');
      assert.equal(first.wave, 1);
      assert.equal(first.declaredNothing, false);
      assert.deepEqual(
        first.entries.map((e) => [e.declared, e.kind, [...e.resolved]]),
        [['libs/m/testing', 'directory', ['libs/m/testing/a.ts']]],
      );
      assert.equal(a.plans.find((p) => p.plan === '01-02-PLAN.md').entries[0].kind, 'file');
      assert.deepEqual(a.collisions, [{ wave: 1, a: '01-01-PLAN.md', b: '01-02-PLAN.md', shared: ['libs/m/testing/a.ts'] }]);
    });

    test('separates declaredNothing from unresolved', () => {
      const a = analyze({ '01-01-PLAN.md': plan('a', 1, []), '01-02-PLAN.md': plan('b', 1, ['gone/**']) });
      const nothing = a.plans.find((p) => p.plan === '01-01-PLAN.md');
      const stale = a.plans.find((p) => p.plan === '01-02-PLAN.md');
      assert.equal(nothing.declaredNothing, true);
      assert.equal(nothing.entries.length, 0);
      assert.equal(stale.declaredNothing, false);
      assert.equal(stale.entries[0].kind, 'glob');
      assert.equal(stale.entries[0].unresolved, true);
    });
  });

  // ── determinism (criterion 3), and its trap ───────────────────────────────

  describe('determinism', () => {
    test('two runs on unchanged input produce identical verdicts', () => {
      tree('libs/m/testing/a.ts', 'libs/m/testing/z.ts', 'libs/m/testing/nested/b.ts');
      const { phaseNumber } = phase({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']), '01-02-PLAN.md': plan('b', 1, ['libs/m/testing/z.ts']) });
      const first = evaluateMnWaveCollision({ projectDir, args: [phaseNumber] }).payload;
      const second = evaluateMnWaveCollision({ projectDir, args: [phaseNumber] }).payload;
      assert.deepEqual(first, second);
    });

    test('and the answer CHANGES with the input — determinism is not a constant', () => {
      tree('libs/m/testing/a.ts');
      const { phaseDir } = phase({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']) });
      const before = analyzeWaveCollision(projectDir, phaseDir, 'expand').plans[0].files;
      tree('libs/m/testing/added.ts');
      const after = analyzeWaveCollision(projectDir, phaseDir, 'expand').plans[0].files;
      assert.notDeepEqual(before, after, 'a new file under the declared directory must change the answer');
    });

    test('resolved file lists are sorted regardless of creation order', () => {
      tree('libs/m/testing/z.ts', 'libs/m/testing/a.ts', 'libs/m/testing/m.ts');
      const resolved = [...analyze({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']) }).plans[0].entries[0].resolved];
      assert.deepEqual(resolved, ['libs/m/testing/a.ts', 'libs/m/testing/m.ts', 'libs/m/testing/z.ts']);
    });
  });

  // ── T-03-01: the walk stays inside the project ────────────────────────────

  describe('containment', () => {
    test('a symlinked directory is not followed out of the tree', { skip: process.platform === 'win32' }, (t) => {
      const outside = path.join(projectDir, '..', `escape-${path.basename(projectDir)}`);
      fs.mkdirSync(outside, { recursive: true });
      t.after(() => cleanup(outside));
      fs.writeFileSync(path.join(outside, 'secret.ts'), 'x');
      tree('libs/m/testing/a.ts');
      fs.symlinkSync(outside, path.join(projectDir, 'libs/m/testing/link'));
      const resolved = [...analyze({ '01-01-PLAN.md': plan('a', 1, ['libs/m/testing']) }).plans[0].entries[0].resolved];
      assert.deepEqual(resolved, ['libs/m/testing/a.ts'], 'the walk must not follow a symlink out of the repository');
    });

    test('an entry escaping the root via .. is refused rather than resolved', () => {
      const a = analyze({ '01-01-PLAN.md': plan('a', 1, ['../outside/x.ts']) });
      assert.equal(a.plans[0].entries[0].kind, 'malformed');
    });

    test('an absolute entry is refused rather than resolved', () => {
      const a = analyze({ '01-01-PLAN.md': plan('a', 1, ['/etc/passwd']) });
      assert.equal(a.plans[0].entries[0].kind, 'malformed');
    });
  });

  // ── registration ──────────────────────────────────────────────────────────

  describe('registration in capability.json', () => {
    test('the wave_normalize gate queries mn-wave-collision at plan:post, blocking, halting on error', () => {
      const gate = CAPABILITY.gates.find((g) => g.when === 'workflow.wave_normalize');
      assert.ok(gate);
      assert.equal(gate.point, 'plan:post');
      assert.deepEqual(gate.check, { query: 'mn-wave-collision' });
      assert.equal(gate.blocking, true);
      assert.equal(gate.onError, 'halt');
    });

    test('the config key defaults to false — enabling it is a choice', () => {
      assert.equal(CAPABILITY.config['workflow.wave_normalize'].type, 'boolean');
      assert.equal(CAPABILITY.config['workflow.wave_normalize'].default, false);
    });
  });
});
