/**
 * feature-view — the reader that makes `feature:` mean something.
 *
 * Two things are proven here, and they are not the same thing:
 *
 *   1. The DERIVATION buckets plans correctly (tagged, untagged, invalid,
 *      zero-plan vocabulary tokens) — asserted against the exported function.
 *   2. The view is DERIVED ON READ AND NEVER STORED — ROADMAP criterion 2 —
 *      asserted BEHAVIOURALLY by mutating a plan on disk between two CLI
 *      invocations with no regeneration step in between, and by comparing a
 *      recursive listing of the tree before and after. A stored or cached view
 *      cannot pass either.
 *
 * The never-stored proof is deliberately NOT "read src/feature-view.cts and
 * grep for writeFileSync". That is the local/no-source-grep prohibition, and it
 * is also weaker: a write could arrive through any alias (fs.promises, a
 * copyFile, a child process). The filesystem before/after comparison catches
 * all of them.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, createTempDir, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');

const featureView = require('../gsd-core/bin/lib/feature-view.cjs');
const { FEATURE_VALUES } = require('../gsd-core/bin/lib/feature-vocabulary.cjs');

// ── fixture builders ────────────────────────────────────────────────────────

function writePlan(cwd, phaseDir, planFile, frontmatterLines) {
  const dir = path.join(cwd, '.planning', 'phases', phaseDir);
  fs.mkdirSync(dir, { recursive: true });
  const body = ['---', ...frontmatterLines, '---', '', '<objective>x</objective>', ''].join('\n');
  fs.writeFileSync(path.join(dir, planFile), body);
  return path.join(dir, planFile);
}

/** Recursive listing of every path under `root`, relative and sorted. */
function listTree(root) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(rel);
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    }
  };
  walk(root, '');
  return out.sort();
}

/** Run the real CLI through the process seam; branch on outcome, never signal. */
function runFeatureView(cwd, extraArgs = []) {
  const result = runNode([TOOLS_PATH, '--cwd', cwd, 'feature-view', '--raw', ...extraArgs], { cwd });
  assert.equal(
    result.outcome,
    OUTCOME.EXITED,
    `feature-view must exit normally; got outcome=${result.outcome} stderr=${result.stderr}`,
  );
  return result;
}

function runFeatureViewJson(cwd, extraArgs = []) {
  const result = runFeatureView(cwd, extraArgs);
  assert.equal(result.exitCode, 0, `expected exit 0, got ${result.exitCode}; stderr=${result.stderr}`);
  return JSON.parse(result.stdout);
}

// ─────────────────────────────────────────────────────────────────────────────
describe('feature-view derivation (Plan 05-03, Task 1)', () => {
  const tmpDirs = [];
  const project = (prefix) => {
    const dir = createTempProject(prefix);
    tmpDirs.push(dir);
    return dir;
  };
  const bare = (prefix) => {
    const dir = createTempDir(prefix);
    tmpDirs.push(dir);
    return dir;
  };

  test.after(() => {
    for (const dir of tmpDirs) cleanup(dir);
  });

  test('a tagged plan lands in its vocabulary bucket', () => {
    const cwd = project('fv-tagged-');
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['phase: 01-alpha', 'plan: "01"', 'feature: lifecycle']);

    const view = featureView.deriveFeatureView(cwd);

    assert.deepEqual(
      view.features['lifecycle'].map((p) => p.plan),
      ['01-01-PLAN.md'],
      'the tagged plan must appear under its own token',
    );
    assert.equal(view.features['lifecycle'][0].phase, '01-alpha');
  });

  test('EVERY vocabulary token appears, including tokens carried by zero plans', () => {
    const cwd = project('fv-seeded-');
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: lifecycle']);

    const view = featureView.deriveFeatureView(cwd);

    assert.deepEqual(
      Object.keys(view.features).sort(),
      [...FEATURE_VALUES].sort(),
      'buckets must be seeded from the vocabulary, not from what plans happen to carry — ' +
      'otherwise a feature nobody has tagged yet is invisible rather than empty',
    );
    for (const token of FEATURE_VALUES) {
      if (token === 'lifecycle') continue;
      assert.deepEqual(view.features[token], [], `${token} must be present with an empty list`);
    }
  });

  test('a plan with no feature: lands in the untagged bucket, never dropped', () => {
    const cwd = project('fv-untagged-');
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['phase: 01-alpha', 'plan: "01"']);

    const view = featureView.deriveFeatureView(cwd);

    assert.deepEqual(view.untagged.map((p) => p.plan), ['01-01-PLAN.md']);
    for (const token of FEATURE_VALUES) {
      assert.deepEqual(view.features[token], [], 'an untagged plan must not leak into a feature bucket');
    }
  });

  test('a plan whose feature: is outside the vocabulary is reported, with its offending value', () => {
    const cwd = project('fv-invalid-');
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: frobnicated']);

    const view = featureView.deriveFeatureView(cwd);

    assert.equal(view.invalid.length, 1, 'an out-of-vocabulary value must surface, not crash and not vanish');
    assert.equal(view.invalid[0].plan, '01-01-PLAN.md');
    assert.equal(view.invalid[0].value, 'frobnicated', 'the offending value must be carried so it can be fixed');
    assert.deepEqual(view.untagged, [], 'invalid is not untagged — the plan DID declare a value');
  });

  test('matching is trim+lowercase normalised, so `  LIFECYCLE ` buckets with lifecycle', () => {
    const cwd = project('fv-normalise-');
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: "  LIFECYCLE "']);

    const view = featureView.deriveFeatureView(cwd);

    assert.deepEqual(view.features['lifecycle'].map((p) => p.plan), ['01-01-PLAN.md']);
    assert.deepEqual(view.invalid, [], 'case and whitespace are normalisation, not invalidity');
  });

  test('buckets and the plans within them are deterministically ordered', () => {
    const cwd = project('fv-order-');
    writePlan(cwd, '02-beta', '02-02-PLAN.md', ['feature: planning']);
    writePlan(cwd, '02-beta', '02-01-PLAN.md', ['feature: planning']);
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: planning']);

    const first = featureView.deriveFeatureView(cwd);
    const second = featureView.deriveFeatureView(cwd);

    assert.deepEqual(first, second, 'two reads of an unchanged tree must be deeply equal');
    assert.deepEqual(
      first.features['planning'].map((p) => `${p.phase}/${p.plan}`),
      ['01-alpha/01-01-PLAN.md', '02-beta/02-01-PLAN.md', '02-beta/02-02-PLAN.md'],
      'phase order then plan order, both stable',
    );
    assert.deepEqual(
      Object.keys(first.features),
      [...Object.keys(first.features)].sort(),
      'bucket key order must be sorted, so a JSON diff of two runs is empty',
    );
  });

  test('a missing .planning/phases directory yields a well-formed empty view, not a throw', () => {
    const cwd = bare('fv-nophases-');

    const view = featureView.deriveFeatureView(cwd);

    assert.deepEqual(Object.keys(view.features).sort(), [...FEATURE_VALUES].sort());
    assert.deepEqual(view.untagged, []);
    assert.deepEqual(view.invalid, []);
    assert.equal(view.plan_count, 0);
    assert.equal(
      view.phases_readable,
      false,
      'a tree with no phases dir must be DISTINGUISHABLE from a tree with zero tagged plans — ' +
      'collapsing "could not read" into "nothing found" is this fork\'s exit-2 lesson',
    );
  });

  test('an empty-but-present phases dir is distinguishable from a missing one', () => {
    const cwd = project('fv-emptyphases-');
    fs.mkdirSync(path.join(cwd, '.planning', 'phases'), { recursive: true });

    const view = featureView.deriveFeatureView(cwd);

    assert.equal(view.phases_readable, true, 'the dir WAS read; it simply held nothing');
    assert.equal(view.plan_count, 0);
  });

  test('a phase directory containing zero plan files contributes nothing and does not throw', () => {
    const cwd = project('fv-noplans-');
    fs.mkdirSync(path.join(cwd, '.planning', 'phases', '01-alpha'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'phases', '01-alpha', 'NOTES.md'), '# not a plan\n');

    const view = featureView.deriveFeatureView(cwd);

    assert.equal(view.plan_count, 0);
    assert.deepEqual(view.untagged, []);
  });

  test('a plan file with no frontmatter at all is untagged, not an error', () => {
    const dir = path.join(project('fv-nofm-'), '.planning', 'phases', '01-alpha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '# Just a heading, no frontmatter\n');
    const cwd = path.join(dir, '..', '..', '..');

    const view = featureView.deriveFeatureView(cwd);

    assert.deepEqual(view.untagged.map((p) => p.plan), ['01-01-PLAN.md']);
    assert.deepEqual(view.unreadable, [], 'absent frontmatter is a legitimate plan shape, not a read failure');
  });

  test('an unreadable plan file is reported in its own bucket, never silently skipped', () => {
    const cwd = project('fv-unreadable-');
    const planPath = writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: lifecycle']);
    // A directory named like a plan file is unreadable-as-a-file on every platform,
    // and needs no chmod (which is a no-op for root in CI containers).
    fs.unlinkSync(planPath);
    fs.mkdirSync(planPath);

    const view = featureView.deriveFeatureView(cwd);

    assert.equal(view.unreadable.length, 1, 'a plan that could not be read must be reported, not dropped');
    assert.equal(view.unreadable[0].plan, '01-01-PLAN.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('feature-view CLI (Plan 05-03, Task 2)', () => {
  const tmpDirs = [];
  test.after(() => {
    for (const dir of tmpDirs) cleanup(dir);
  });

  test('the command emits the derived view as JSON and exits 0', () => {
    const cwd = createTempProject('fv-cli-');
    tmpDirs.push(cwd);
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: validation']);

    const view = runFeatureViewJson(cwd);

    assert.deepEqual(view.features['validation'].map((p) => p.plan), ['01-01-PLAN.md']);
    assert.deepEqual(Object.keys(view.features).sort(), [...FEATURE_VALUES].sort());
  });

  test('a tree with no .planning/phases yields a well-formed view and a ZERO exit status', () => {
    const cwd = createTempDir('fv-cli-empty-');
    tmpDirs.push(cwd);

    const result = runFeatureView(cwd);

    assert.equal(result.exitCode, 0, 'an empty tree is not an error — it is an empty view');
    const view = JSON.parse(result.stdout);
    assert.equal(view.plan_count, 0);
    assert.equal(view.phases_readable, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP criterion 2 — "the view is derived on read and never stored".
//
// These tests are the reason this plan exists. Each one FAILS against a stored
// or cached view. Do not weaken them into assertions about the source text.
// ─────────────────────────────────────────────────────────────────────────────
describe('feature-view is derived on read and never stored (criterion 2 and 3)', () => {
  const tmpDirs = [];
  test.after(() => {
    for (const dir of tmpDirs) cleanup(dir);
  });

  test('THE CRITERION-2 PROOF: editing a plan\'s feature: changes the next read, with no regeneration between', () => {
    const cwd = createTempProject('fv-mutate-');
    tmpDirs.push(cwd);
    const planPath = writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['phase: 01-alpha', 'feature: lifecycle']);

    const before = runFeatureViewJson(cwd);
    assert.deepEqual(before.features['lifecycle'].map((p) => p.plan), ['01-01-PLAN.md']);
    assert.deepEqual(before.features['dispatch'], []);

    // The ONLY thing that happens between the two invocations. No refresh,
    // no regeneration, no index rebuild — the absence of that step IS the
    // assertion.
    fs.writeFileSync(planPath, fs.readFileSync(planPath, 'utf8').replace('feature: lifecycle', 'feature: dispatch'));

    const after = runFeatureViewJson(cwd);

    assert.deepEqual(
      after.features['dispatch'].map((p) => p.plan),
      ['01-01-PLAN.md'],
      'the plan must have moved buckets — a stored view would still report the old one',
    );
    assert.deepEqual(after.features['lifecycle'], [], 'and must have left the old bucket');
  });

  test('adding a whole new plan file between invocations changes the view — no index refresh needed', () => {
    const cwd = createTempProject('fv-add-');
    tmpDirs.push(cwd);
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: planning']);

    const before = runFeatureViewJson(cwd);
    assert.equal(before.plan_count, 1);

    writePlan(cwd, '02-beta', '02-01-PLAN.md', ['feature: planning']);

    const after = runFeatureViewJson(cwd);
    assert.equal(after.plan_count, 2);
    assert.deepEqual(after.features['planning'].map((p) => p.plan), ['01-01-PLAN.md', '02-01-PLAN.md']);
  });

  test('removing a plan file between invocations removes it from the view', () => {
    const cwd = createTempProject('fv-remove-');
    tmpDirs.push(cwd);
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: templates']);
    const doomed = writePlan(cwd, '01-alpha', '01-02-PLAN.md', ['feature: templates']);

    assert.equal(runFeatureViewJson(cwd).features['templates'].length, 2);
    fs.unlinkSync(doomed);
    assert.deepEqual(
      runFeatureViewJson(cwd).features['templates'].map((p) => p.plan),
      ['01-01-PLAN.md'],
      'a deleted plan must vanish from the view immediately',
    );
  });

  test('after repeated invocations the tree contains no new file — the command writes nothing, anywhere', () => {
    const cwd = createTempProject('fv-nowrite-');
    tmpDirs.push(cwd);
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: lifecycle']);
    writePlan(cwd, '02-beta', '02-01-PLAN.md', []);

    const before = listTree(cwd);
    runFeatureViewJson(cwd);
    runFeatureViewJson(cwd);
    runFeatureViewJson(cwd);
    const after = listTree(cwd);

    assert.deepEqual(
      after,
      before,
      'set equality of the whole tree — this catches a cache written ANYWHERE, ' +
      'which a targeted "does FEATURE.md exist" check alone would miss',
    );
  });

  test('CRITERION 3: no FEATURE.md is created anywhere in the tree', () => {
    const cwd = createTempProject('fv-nofeaturemd-');
    tmpDirs.push(cwd);
    writePlan(cwd, '01-alpha', '01-01-PLAN.md', ['feature: validation']);

    runFeatureViewJson(cwd);
    runFeatureViewJson(cwd);

    const offenders = listTree(cwd).filter((p) => path.basename(p).toUpperCase() === 'FEATURE.MD');
    assert.deepEqual(
      offenders,
      [],
      'criterion 3 gets its own named assertion rather than being implied by the broader tree check',
    );
  });
});
