'use strict';

/**
 * Feature vocabulary — generator failure modes and the vocabulary contract.
 *
 * The load-bearing cases here are the ones that would otherwise produce an EMPTY
 * vocabulary: an absent marker pair and an empty block. An empty allowed-set
 * makes every `feature:` value valid, so "could not read the list" and "the list
 * is empty" must be distinguishable — they are both hard failures, and neither
 * degrades to `[]`.
 *
 * The generator is driven as a REAL subprocess through the process seam, using
 * the `--roadmap-path` / `--module-path` / `--manifest-path` overrides to point
 * it at temp fixture trees. No fs monkeypatching, and no assertions on prose:
 * every failure is identified by the typed `reason` code in `--check --json`
 * output or by the thrown error's `.reason`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'gen-feature-vocabulary.cjs');

const gen = require('../scripts/gen-feature-vocabulary.cjs');
const { REASON, OPEN_MARKER, CLOSE_MARKER } = gen;

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/** Wrap entry lines in the marker pair, with surrounding roadmap-ish prose. */
function roadmapWith(blockBody) {
  return [
    '# Roadmap',
    '',
    '**Delivers:**',
    '',
    OPEN_MARKER,
    '',
    blockBody,
    '',
    CLOSE_MARKER,
    '',
    '**Success Criteria**:',
    '',
  ].join('\n');
}

const WELL_FORMED = roadmapWith(
  [
    '- validation — the gates that reject a malformed artifact',
    '- dispatch — how a run is routed',
    '- lifecycle — a plan state over time',
  ].join('\n'),
);

/**
 * A temp fixture tree: writes `markdown` as ROADMAP.md and returns the three
 * paths the generator's overrides take.
 */
function makeFixture(t, markdown) {
  const dir = createTempDir('feature-vocab-');
  t.after(() => cleanup(dir));
  const roadmapPath = path.join(dir, 'ROADMAP.md');
  fs.writeFileSync(roadmapPath, markdown, 'utf8');
  return {
    dir,
    roadmapPath,
    manifestPath: path.join(dir, 'FEATURE-VOCABULARY.json'),
    modulePath: path.join(dir, 'feature-vocabulary.cts'),
  };
}

/** Run the real generator CLI against a fixture. */
function runGenerator(fixture, args) {
  return runNode([
    GENERATOR,
    ...args,
    '--roadmap-path', fixture.roadmapPath,
    '--manifest-path', fixture.manifestPath,
    '--module-path', fixture.modulePath,
  ], { cwd: REPO_ROOT });
}

/**
 * Run `--check --json` and return the parsed typed report. Asserts the process
 * actually EXITED — branching on `outcome`, never on `signal`, because a timeout
 * and a maxBuffer overflow are indistinguishable by signal alone.
 */
function checkJson(fixture) {
  const result = runGenerator(fixture, ['--check', '--json']);
  assert.equal(result.outcome, OUTCOME.EXITED, `generator did not exit cleanly: ${result.outcome}`);
  return { report: JSON.parse(result.stdout), exitCode: result.exitCode };
}

/** Assert that building the vocabulary fails with the given typed reason code. */
function assertBuildReason(fixture, expectedReason) {
  assert.throws(
    () => gen.buildVocabulary(fixture.roadmapPath),
    (err) => err instanceof gen.VocabularyError && err.reason === expectedReason,
    `expected VocabularyError with reason ${expectedReason}`,
  );
  // And the same failure must reach the CLI's typed report, not just the API.
  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, expectedReason);
  assert.equal(exitCode, 1);
}

// ─── The happy path ───────────────────────────────────────────────────────────

test('a well-formed block yields sorted, deduplicated tokens', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  const result = runGenerator(fixture, ['--write']);

  assert.equal(result.outcome, OUTCOME.EXITED);
  assert.equal(result.exitCode, 0);

  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  // Authored order was validation, dispatch, lifecycle — output is sorted.
  assert.deepEqual(manifest.features, ['dispatch', 'lifecycle', 'validation']);
  assert.equal(manifest.count, 3);
  assert.equal(manifest.glosses.dispatch, 'how a run is routed');
});

test('--check passes against a freshly written pair', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);

  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, true);
  assert.equal(report.reason, REASON.OK_UP_TO_DATE);
  assert.equal(exitCode, 0);
});

// ─── The failure modes that would otherwise empty the vocabulary ──────────────

test('an absent marker pair fails loudly', (t) => {
  const fixture = makeFixture(t, '# Roadmap\n\nNo vocabulary block here at all.\n');
  assertBuildReason(fixture, REASON.FAIL_MARKERS_MISSING);
});

test('markers present but block empty fails loudly', (t) => {
  // The load-bearing case: an empty vocabulary would make EVERY feature valid.
  const fixture = makeFixture(t, roadmapWith(''));
  assertBuildReason(fixture, REASON.FAIL_BLOCK_EMPTY);
});

test('an inverted marker pair fails loudly', (t) => {
  const fixture = makeFixture(
    t,
    `# Roadmap\n\n${CLOSE_MARKER}\n\n- dispatch — routed\n\n${OPEN_MARKER}\n`,
  );
  assertBuildReason(fixture, REASON.FAIL_MARKERS_INVERTED);
});

test('a duplicate token fails loudly', (t) => {
  const fixture = makeFixture(t, roadmapWith(
    ['- dispatch — routed one way', '- dispatch — routed another way'].join('\n'),
  ));
  assertBuildReason(fixture, REASON.FAIL_DUPLICATE_TOKEN);
});

test('a malformed entry line fails loudly', (t) => {
  const fixture = makeFixture(t, roadmapWith(
    ['- dispatch — routed', 'this line is not an entry at all'].join('\n'),
  ));
  assertBuildReason(fixture, REASON.FAIL_ENTRY_MALFORMED);
});

test('an entry missing its gloss fails loudly', (t) => {
  const fixture = makeFixture(t, roadmapWith('- dispatch'));
  assertBuildReason(fixture, REASON.FAIL_ENTRY_MALFORMED);
});

test('a non-normalised token fails loudly rather than being silently fixed', (t) => {
  const fixture = makeFixture(t, roadmapWith('- Dispatch — routed'));
  assertBuildReason(fixture, REASON.FAIL_TOKEN_NOT_NORMALIZED);
});

test('a token with an illegal character fails loudly', (t) => {
  const fixture = makeFixture(t, roadmapWith('- dis_patch — routed'));
  assertBuildReason(fixture, REASON.FAIL_TOKEN_NOT_NORMALIZED);
});

test('a gloss that would close the generated module comment fails loudly (T-05-01)', (t) => {
  // The gloss lands inside a JSDoc comment in src/feature-vocabulary.cts, where
  // JSON.stringify does not protect it: `*/` would end the comment and emit code.
  const fixture = makeFixture(t, roadmapWith('- dispatch — routed */ globalThis.pwned = 1; /*'));
  assertBuildReason(fixture, REASON.FAIL_ENTRY_MALFORMED);
  const result = runGenerator(fixture, ['--write']);
  assert.equal(result.outcome, OUTCOME.EXITED);
  assert.equal(result.exitCode, 1);
  assert.equal(fs.existsSync(fixture.modulePath), false, 'nothing may be emitted for an injecting gloss');
});

test('building without a roadmap fails loudly and distinctly from an empty block', (t) => {
  const dir = createTempDir('feature-vocab-absent-');
  t.after(() => cleanup(dir));
  const roadmapPath = path.join(dir, 'nonexistent-ROADMAP.md');

  assert.throws(
    () => gen.buildVocabulary(roadmapPath),
    (err) => err instanceof gen.VocabularyError && err.reason === REASON.FAIL_ROADMAP_MISSING,
  );
  // The distinction that matters: could-not-read and empty carry DIFFERENT codes.
  assert.notEqual(REASON.FAIL_ROADMAP_MISSING, REASON.FAIL_BLOCK_EMPTY);
});

test('--write without a roadmap is a hard error, never an empty vocabulary', (t) => {
  const dir = createTempDir('feature-vocab-write-absent-');
  t.after(() => cleanup(dir));
  const fixture = {
    roadmapPath: path.join(dir, 'nonexistent-ROADMAP.md'),
    manifestPath: path.join(dir, 'FEATURE-VOCABULARY.json'),
    modulePath: path.join(dir, 'feature-vocabulary.cts'),
  };

  const result = runGenerator(fixture, ['--write']);
  assert.equal(result.outcome, OUTCOME.EXITED);
  assert.equal(result.exitCode, 1);
  // Crucially: it must not have written an empty vocabulary, which would make
  // every `feature:` value valid.
  assert.equal(fs.existsSync(fixture.manifestPath), false);
  assert.equal(fs.existsSync(fixture.modulePath), false);
});

// ─── The gitignored-source carve-out (clean clone / CI) ───────────────────────

/**
 * A clean-clone fixture: artifacts generated from a real roadmap, then the
 * roadmap removed — the shape every CI checkout has (.planning/ is gitignored).
 */
function makeCleanCloneFixture(t) {
  const fixture = makeFixture(t, WELL_FORMED);
  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);
  // Point the generator at a roadmap that does not exist, keeping the artifacts.
  return { ...fixture, roadmapPath: path.join(fixture.dir, 'absent-ROADMAP.md') };
}

test('--check skips the ROADMAP drift check when the roadmap is absent, since .planning/ is gitignored', (t) => {
  // A fresh clone and every CI checkout have the committed artifacts but not
  // .planning/ROADMAP.md. There is no ROADMAP drift to detect against a file that
  // is not there, and failing would break CI on every PR while proving nothing.
  const fixture = makeCleanCloneFixture(t);

  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, true);
  assert.equal(report.reason, REASON.OK_ROADMAP_ABSENT);
  assert.equal(exitCode, 0);
  assert.deepEqual(report.features, ['dispatch', 'lifecycle', 'validation'], 'the vocabulary is read from the committed manifest');
  // Skipped-because-absent is NOT "the vocabulary is up to date", and NOT "the
  // vocabulary is empty". All three are distinct codes.
  assert.notEqual(REASON.OK_ROADMAP_ABSENT, REASON.OK_UP_TO_DATE);
  assert.notEqual(REASON.OK_ROADMAP_ABSENT, REASON.FAIL_BLOCK_EMPTY);
});

test('the absence carve-out does not excuse a missing manifest', (t) => {
  // The committed manifest is the vocabulary's only definition in a clean clone;
  // a tree without it has no vocabulary at all, and that must not read as ok.
  const dir = createTempDir('feature-vocab-clean-clone-empty-');
  t.after(() => cleanup(dir));
  const fixture = {
    roadmapPath: path.join(dir, 'nonexistent-ROADMAP.md'),
    manifestPath: path.join(dir, 'FEATURE-VOCABULARY.json'),
    modulePath: path.join(dir, 'feature-vocabulary.cts'),
  };
  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_MANIFEST_MISSING);
  assert.equal(exitCode, 1);
});

test('the absence carve-out still catches a module hand-edited away from the manifest', (t) => {
  const fixture = makeCleanCloneFixture(t);
  fs.appendFileSync(fixture.modulePath, '// hand edit\n');
  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_STALE_MODULE);
  assert.equal(exitCode, 1);
});

test('--write without a roadmap keeps consistent committed artifacts untouched and exits 0', (t) => {
  // `npm run regen:derived` runs --write on every clone; with no ROADMAP there is
  // nothing to regenerate from, and consistent artifacts already ARE the vocabulary.
  const fixture = makeCleanCloneFixture(t);
  const manifestBefore = fs.readFileSync(fixture.manifestPath, 'utf8');
  const moduleBefore = fs.readFileSync(fixture.modulePath, 'utf8');
  const result = runGenerator(fixture, ['--write']);
  assert.equal(result.outcome, OUTCOME.EXITED);
  assert.equal(result.exitCode, 0);
  assert.equal(fs.readFileSync(fixture.manifestPath, 'utf8'), manifestBefore);
  assert.equal(fs.readFileSync(fixture.modulePath, 'utf8'), moduleBefore);
});

test('the absence carve-out does not extend to an unreadable roadmap', (t) => {
  // Absent is an expected checkout shape; unreadable is a real fault. Only the
  // former is tolerated, or the carve-out would swallow genuine failures.
  const dir = createTempDir('feature-vocab-unreadable-');
  t.after(() => cleanup(dir));
  // A directory where a file is expected: readFileSync fails with EISDIR, not
  // ENOENT, so it exercises the unreadable branch rather than the absent one.
  const roadmapPath = path.join(dir, 'ROADMAP.md');
  fs.mkdirSync(roadmapPath);

  const fixture = {
    roadmapPath,
    manifestPath: path.join(dir, 'FEATURE-VOCABULARY.json'),
    modulePath: path.join(dir, 'feature-vocabulary.cts'),
  };
  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_ROADMAP_UNREADABLE);
  assert.equal(exitCode, 1);
});

test('the absence carve-out does not weaken drift detection when the roadmap IS present', (t) => {
  // The whole point of the gate: a present-but-disagreeing ROADMAP still fails.
  const fixture = makeFixture(t, WELL_FORMED);
  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);

  fs.writeFileSync(fixture.roadmapPath, roadmapWith('- planning — a different list entirely'), 'utf8');

  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_STALE_MANIFEST);
  assert.equal(exitCode, 1);
});

// ─── Drift detection ──────────────────────────────────────────────────────────

test('--check against a stale manifest exits non-zero', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);

  const manifest = JSON.parse(fs.readFileSync(fixture.manifestPath, 'utf8'));
  manifest.features.push('smuggled-in-by-hand');
  fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_STALE_MANIFEST);
  assert.equal(exitCode, 1);
});

test('--check against a hand-edited module exits non-zero', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);

  fs.appendFileSync(fixture.modulePath, '\n// hand edit\n', 'utf8');

  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_STALE_MODULE);
  assert.equal(exitCode, 1);
});

test('--check reports a missing manifest distinctly from a stale one', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  const { report, exitCode } = checkJson(fixture);
  assert.equal(report.ok, false);
  assert.equal(report.reason, REASON.FAIL_MANIFEST_MISSING);
  assert.equal(exitCode, 1);
});

test('--check and --write together are a usage error, not a silent rewrite', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  const result = runGenerator(fixture, ['--check', '--write']);

  assert.equal(result.outcome, OUTCOME.EXITED);
  assert.equal(result.exitCode, 1);
  // The gate must not have disarmed itself by writing the artifacts it was
  // asked to check.
  assert.equal(fs.existsSync(fixture.manifestPath), false);
});

// ─── Determinism ──────────────────────────────────────────────────────────────

test('output is independent of authored entry order', (t) => {
  const entries = [
    '- validation — the gates',
    '- dispatch — how a run is routed',
    '- lifecycle — a plan state',
  ];
  const forward = makeFixture(t, roadmapWith(entries.join('\n')));
  const reversed = makeFixture(t, roadmapWith([...entries].reverse().join('\n')));

  assert.equal(runGenerator(forward, ['--write']).exitCode, 0);
  assert.equal(runGenerator(reversed, ['--write']).exitCode, 0);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(forward.manifestPath, 'utf8')),
    JSON.parse(fs.readFileSync(reversed.manifestPath, 'utf8')),
  );
  assert.equal(
    fs.readFileSync(forward.modulePath, 'utf8'),
    fs.readFileSync(reversed.modulePath, 'utf8'),
  );
});

test('two runs over unchanged input produce identical artifacts', (t) => {
  const fixture = makeFixture(t, WELL_FORMED);
  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);
  const firstManifest = fs.readFileSync(fixture.manifestPath, 'utf8');
  const firstModule = fs.readFileSync(fixture.modulePath, 'utf8');

  assert.equal(runGenerator(fixture, ['--write']).exitCode, 0);
  assert.equal(fs.readFileSync(fixture.manifestPath, 'utf8'), firstManifest);
  assert.equal(fs.readFileSync(fixture.modulePath, 'utf8'), firstModule);
});

test('REASON is a frozen enum with the documented set of codes', () => {
  assert.equal(Object.isFrozen(REASON), true);
  assert.deepEqual(Object.keys(REASON).sort(), [
    'FAIL_BLOCK_EMPTY',
    'FAIL_DUPLICATE_TOKEN',
    'FAIL_ENTRY_MALFORMED',
    'FAIL_MANIFEST_MISSING',
    'FAIL_MANIFEST_UNPARSEABLE',
    'FAIL_MARKERS_INVERTED',
    'FAIL_MARKERS_MISSING',
    'FAIL_MODULE_MISSING',
    'FAIL_ROADMAP_MISSING',
    'FAIL_ROADMAP_UNREADABLE',
    'FAIL_STALE_MANIFEST',
    'FAIL_STALE_MODULE',
    'FAIL_TOKEN_NOT_NORMALIZED',
    'OK_ROADMAP_ABSENT',
    'OK_UP_TO_DATE',
  ]);
});

// ─── The compiled vocabulary contract ─────────────────────────────────────────

test('the committed vocabulary compiles and exports a non-empty FEATURE_VALUES', () => {
  const vocab = require('../gsd-core/bin/lib/feature-vocabulary.cjs');
  assert.ok(Array.isArray(vocab.FEATURE_VALUES));
  assert.ok(vocab.FEATURE_VALUES.length > 0, 'an empty vocabulary would make every feature valid');
  // Shaped exactly like PLAN_STATUSES: every member a plain string.
  for (const value of vocab.FEATURE_VALUES) assert.equal(typeof value, 'string');
});

test('FEATURE_VALUES matches the committed manifest', () => {
  const vocab = require('../gsd-core/bin/lib/feature-vocabulary.cjs');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'docs', 'FEATURE-VOCABULARY.json'), 'utf8'),
  );
  assert.deepEqual([...vocab.FEATURE_VALUES], manifest.features);
});

test('FEATURE_VALUES is frozen', () => {
  const vocab = require('../gsd-core/bin/lib/feature-vocabulary.cjs');
  const before = [...vocab.FEATURE_VALUES];
  // Assert the array is UNCHANGED rather than that a throw occurred — a
  // non-strict-mode caller does not throw, so asserting the throw would pin the
  // wrong contract.
  try {
    vocab.FEATURE_VALUES.push('injected');
  } catch {
    // A strict-mode throw is acceptable; the contract is the value below.
  }
  assert.deepEqual([...vocab.FEATURE_VALUES], before);
});

test('isFeature accepts case and whitespace variants of a real token', () => {
  const vocab = require('../gsd-core/bin/lib/feature-vocabulary.cjs');
  const token = vocab.FEATURE_VALUES[0];
  assert.equal(vocab.isFeature(token), true);
  assert.equal(vocab.isFeature(`  ${token.toUpperCase()}  `), true);
  assert.equal(vocab.isFeature(`\t${token}\n`), true);
});

test('isFeature rejects non-members and non-strings', () => {
  const vocab = require('../gsd-core/bin/lib/feature-vocabulary.cjs');
  for (const value of ['', '   ', 'definitely-not-a-feature', null, undefined, 42, {}, [], true]) {
    assert.equal(vocab.isFeature(value), false, `expected ${JSON.stringify(value)} to be rejected`);
  }
});

test('the committed repo tree passes --check', () => {
  // Pinned to the clean-clone shape (no ROADMAP) so the answer does not depend on
  // whether this checkout happens to carry the gitignored .planning/: the
  // committed manifest and module must exist and agree with each other.
  const absentRoadmap = path.join(REPO_ROOT, '.planning', 'nonexistent-ROADMAP-for-test.md');
  const result = runNode([GENERATOR, '--check', '--json', '--roadmap-path', absentRoadmap], { cwd: REPO_ROOT });
  assert.equal(result.outcome, OUTCOME.EXITED);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true, `committed artifacts are missing or disagree: ${report.reason}`);
  assert.equal(report.reason, REASON.OK_ROADMAP_ABSENT);
  assert.ok(report.count > 0, 'the committed vocabulary is non-empty');
});

test('the committed repo tree agrees with the local ROADMAP when one is present',
  { skip: !fs.existsSync(gen.ROADMAP_PATH) && 'no .planning/ROADMAP.md in this checkout (gitignored)' },
  () => {
    const result = runNode([GENERATOR, '--check', '--json'], { cwd: REPO_ROOT });
    assert.equal(result.outcome, OUTCOME.EXITED);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true, `committed artifacts are stale: ${report.reason}`);
    assert.equal(report.reason, REASON.OK_UP_TO_DATE);
  });
