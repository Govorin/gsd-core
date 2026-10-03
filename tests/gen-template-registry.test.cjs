'use strict';

/**
 * Tests for scripts/gen-template-registry.cjs — the template registry generator.
 *
 * The paired proof (criterion 1, Plan 04.1-02): "every template carries a
 * `gsd-template:` block, and a missing block fails a check" is trivially
 * satisfied by a check that never runs. So this ONE file proves BOTH halves —
 * that a complete fixture set passes AND that removing exactly one block fails
 * — so an edit that disables the check reds a test that also asserts the
 * positive case.
 *
 * Every assertion on a failure mode reads the typed `reason` code from the
 * frozen REASON enum in the `--check --json` report, never the human prose the
 * CLI also prints (CONTRIBUTING.md, "Prohibited: Raw Text Matching on Test
 * Outputs").
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GENERATOR = path.join(REPO_ROOT, 'scripts', 'gen-template-registry.cjs');

const gen = require('../scripts/gen-template-registry.cjs');
const { REASON } = gen;

// ─── Fixture authoring ────────────────────────────────────────────────────────

/**
 * Render a well-formed `gsd-template:` block exactly as the spec defines it —
 * a frontmatter block whose sole top-level key is `gsd-template:`, headed by the
 * two-line ignore comment.
 */
function block(fields = {}) {
  const f = {
    level: 'phase',
    lifecycle: 'active',
    required: false,
    author: 'agent',
    readers: ['gsd-planner'],
    ...fields,
  };
  return [
    '---',
    '# gsd-template: registry metadata about THIS TEMPLATE FILE.',
    '# Not part of the artifact this template produces. Agents: ignore this block.',
    'gsd-template:',
    `  level: ${f.level}`,
    `  lifecycle: ${f.lifecycle}`,
    `  required: ${f.required}`,
    `  author: ${f.author}`,
    `  readers: [${f.readers.join(', ')}]`,
    '---',
    '',
  ].join('\n');
}

/** Shape C — no artifact frontmatter; the registry block is at byte 0. */
function shapeC(fields) {
  return `${block(fields)}\n# A Heading\n\nSome prose.\n`;
}

/** Shape B — artifact frontmatter inside a fence, registry block still at byte 0. */
function shapeB(fields) {
  return `${block(fields)}
Produce a file with this frontmatter:

\`\`\`markdown
---
phase: {N}
status: draft
---
\`\`\`

# A Heading
`;
}

/** Shape A — artifact frontmatter at byte 0, registry block is the SECOND block. */
function shapeA(fields) {
  return `---
phase: {N}
slug: {phase-slug}
status: draft
---

${block(fields)}
# A Heading
`;
}

/** Shape A with `gsd-template:` illegally MERGED into the artifact block. */
function shapeAMerged() {
  return `---
phase: {N}
status: draft
gsd-template:
  level: phase
  lifecycle: active
  required: false
  author: agent
  readers: [gsd-planner]
---

# A Heading
`;
}

function write(root, rel, contents) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents, 'utf8');
  return abs;
}

/** A README carrying the marker pair the generator owns. */
function readmeWith(regionBody = '\n') {
  return `# Header

Prose above the region.

<!-- gsd:template-registry -->${regionBody}<!-- /gsd:template-registry -->

## Hand-written section

| File | Purpose |
|------|---------|
| \`PROJECT.md\` | identity |
`;
}

/**
 * Build the standard multi-template fixture: three shapes plus one template
 * nested two directories deep, so the recursive walk is proven rather than
 * assumed.
 */
function buildFixtureSet(templatesDir) {
  write(templatesDir, 'alpha.md', shapeC({ level: 'project', readers: ['gsd-planner', 'gsd-executor'] }));
  write(templatesDir, 'beta.md', shapeB({ level: 'milestone', required: true }));
  write(templatesDir, 'gamma.md', shapeA({ level: 'phase', author: 'human' }));
  write(templatesDir, 'host/delta.md', shapeC({ level: 'host', lifecycle: 'deprecated', readers: [] }));
  write(templatesDir, 'nested/deeper/epsilon.md', shapeC({ author: 'generated' }));
}

/** Run the real CLI, asserting it exited cleanly enough to inspect. */
function runCli(args) {
  const result = runNode([GENERATOR, ...args], { cwd: REPO_ROOT });
  assert.equal(
    result.outcome,
    OUTCOME.EXITED,
    `generator did not exit normally: ${result.outcome} / ${result.stderr}`,
  );
  return result;
}

/** Run `--check --json` and return the parsed typed report plus the exit code. */
function checkJson(args) {
  const result = runCli(['--check', '--json', ...args]);
  const report = JSON.parse(result.stdout);
  return { report, exitCode: result.exitCode };
}

// ─── Task 1: tracer — parse, emit, determinism, absent source ─────────────────

describe('gen-template-registry: tracer', () => {
  let root;
  let templatesDir;

  beforeEach(() => {
    root = createTempDir('gen-template-registry-tracer-');
    templatesDir = path.join(root, 'templates');
    fs.mkdirSync(templatesDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(root);
  });

  test('one template with a complete block yields one registry entry carrying its five fields', () => {
    write(templatesDir, 'solo.md', shapeC({
      level: 'phase',
      lifecycle: 'active',
      required: true,
      author: 'agent',
      readers: ['gsd-planner', 'gsd-executor'],
    }));

    const registry = gen.buildRegistry(templatesDir);

    assert.equal(registry.count, 1);
    assert.deepEqual(registry.templates, [{
      path: 'solo.md',
      level: 'phase',
      lifecycle: 'active',
      required: true,
      author: 'agent',
      readers: ['gsd-planner', 'gsd-executor'],
    }]);
  });

  test('`required` is a real boolean, not the string "true"', () => {
    write(templatesDir, 'solo.md', shapeC({ required: true }));
    const [entry] = gen.buildRegistry(templatesDir).templates;
    assert.equal(entry.required, true);
    assert.notEqual(entry.required, 'true');
  });

  test('two runs over unchanged input produce byte-identical serialized output', () => {
    buildFixtureSet(templatesDir);
    const first = gen.serializeManifest(gen.buildRegistry(templatesDir));
    const second = gen.serializeManifest(gen.buildRegistry(templatesDir));
    assert.equal(first, second);
  });

  test('entries are sorted by relative path regardless of directory-read order', () => {
    write(templatesDir, 'zeta.md', shapeC());
    write(templatesDir, 'alpha.md', shapeC());
    write(templatesDir, 'sub/beta.md', shapeC());
    write(templatesDir, 'middle.md', shapeC());

    const paths = gen.buildRegistry(templatesDir).templates.map((t) => t.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.deepEqual(paths, ['alpha.md', 'middle.md', 'sub/beta.md', 'zeta.md']);
  });

  test('the walk recurses into subdirectories two levels deep', () => {
    buildFixtureSet(templatesDir);
    const paths = gen.buildRegistry(templatesDir).templates.map((t) => t.path);
    assert.ok(paths.includes('nested/deeper/epsilon.md'), `two-deep template missing from ${paths.join(', ')}`);
    assert.ok(paths.includes('host/delta.md'));
  });

  test('emitted paths are repo-relative POSIX, never absolute', () => {
    buildFixtureSet(templatesDir);
    for (const entry of gen.buildRegistry(templatesDir).templates) {
      assert.ok(!path.isAbsolute(entry.path), `absolute path leaked: ${entry.path}`);
      assert.ok(!entry.path.includes('\\'), `backslash leaked: ${entry.path}`);
    }
  });

  test('--check with an absent templates directory exits 0 with its own reason code', () => {
    const { report, exitCode } = checkJson(['--templates-dir', path.join(root, 'does-not-exist')]);
    assert.equal(exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.reason, REASON.OK_TEMPLATES_ABSENT);
  });

  test('the absent-source reason is distinct from every staleness reason', () => {
    assert.notEqual(REASON.OK_TEMPLATES_ABSENT, REASON.FAIL_STALE_MANIFEST);
    assert.notEqual(REASON.OK_TEMPLATES_ABSENT, REASON.FAIL_MANIFEST_MISSING);
    assert.notEqual(REASON.OK_TEMPLATES_ABSENT, REASON.OK_UP_TO_DATE);
  });

  test('REASON carries the documented closed set of codes', () => {
    assert.deepEqual(Object.keys(REASON).sort(), [
      'FAIL_BLOCK_IN_ARTIFACT_BLOCK',
      'FAIL_BLOCK_MALFORMED',
      'FAIL_BLOCK_MISSING',
      'FAIL_MANIFEST_MISSING',
      'FAIL_MANIFEST_UNPARSEABLE',
      'FAIL_MISSING_KEY',
      'FAIL_README_MARKERS_INVERTED',
      'FAIL_README_MARKERS_MISSING',
      'FAIL_README_MISSING',
      'FAIL_STALE_MANIFEST',
      'FAIL_STALE_README',
      'FAIL_TEMPLATES_UNREADABLE',
      'FAIL_UNKNOWN_KEY',
      'OK_TEMPLATES_ABSENT',
      'OK_UP_TO_DATE',
    ]);
    assert.ok(Object.isFrozen(REASON));
  });

  test('--check and --write together collapse to the usage-error path', () => {
    const result = runNode([GENERATOR, '--check', '--write'], { cwd: REPO_ROOT });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);
    const opts = gen.parseArgs(['--check', '--write']);
    assert.equal(opts.mode, 'unknown');
  });

  test('a path flag with no value is a usage error, not a swallowed next flag', () => {
    const opts = gen.parseArgs(['--templates-dir', '--json']);
    assert.equal(opts.mode, 'unknown');
    assert.equal(opts.unknownArg, '--templates-dir');
  });
});

// ─── Task 2: the paired proof ────────────────────────────────────────────────

describe('gen-template-registry: paired pass/fail proof', () => {
  let root;
  let templatesDir;
  let manifestPath;
  let readmePath;

  /** Regenerate both artifacts so the fixture starts in a known-synced state. */
  function sync() {
    return runCli([
      '--write',
      '--templates-dir', templatesDir,
      '--manifest-path', manifestPath,
      '--readme-path', readmePath,
    ]);
  }

  function check() {
    return checkJson([
      '--templates-dir', templatesDir,
      '--manifest-path', manifestPath,
      '--readme-path', readmePath,
    ]);
  }

  beforeEach(() => {
    root = createTempDir('gen-template-registry-paired-');
    templatesDir = path.join(root, 'templates');
    manifestPath = path.join(root, 'docs', 'TEMPLATE-REGISTRY.json');
    readmePath = path.join(templatesDir, 'README.md');
    fs.mkdirSync(templatesDir, { recursive: true });
    buildFixtureSet(templatesDir);
    fs.writeFileSync(readmePath, readmeWith(), 'utf8');
    sync();
  });

  afterEach(() => {
    cleanup(root);
  });

  // ── The positive half. Without this, the negative half below could be
  // satisfied by a check that fails unconditionally, or never runs at all.
  test('PASS: the complete block set reports ok and covers every template', () => {
    const { report, exitCode } = check();
    assert.equal(exitCode, 0);
    assert.equal(report.ok, true);
    assert.equal(report.reason, REASON.OK_UP_TO_DATE);
    assert.equal(report.count, 5);
  });

  // ── The negative half, over the SAME fixture set.
  test('FAIL: removing exactly one block reports FAIL_BLOCK_MISSING naming the file', () => {
    fs.writeFileSync(path.join(templatesDir, 'beta.md'), '# No block here\n\nprose\n', 'utf8');

    const { report, exitCode } = check();
    assert.notEqual(exitCode, 0);
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_BLOCK_MISSING);
    // The offending path is DATA in the report, not prose to be regex-matched.
    assert.equal(report.offendingPath, 'beta.md');
  });

  test('FAIL: a merged block reports FAIL_BLOCK_IN_ARTIFACT_BLOCK naming the file', () => {
    fs.writeFileSync(path.join(templatesDir, 'gamma.md'), shapeAMerged(), 'utf8');

    const { report, exitCode } = check();
    assert.notEqual(exitCode, 0);
    assert.equal(report.reason, REASON.FAIL_BLOCK_IN_ARTIFACT_BLOCK);
    assert.equal(report.offendingPath, 'gamma.md');
  });

  test('FAIL: an unknown key reports FAIL_UNKNOWN_KEY naming the key and the file', () => {
    const bad = shapeC().replace('gsd-template:\n', 'gsd-template:\n  owner: nobody\n');
    fs.writeFileSync(path.join(templatesDir, 'alpha.md'), bad, 'utf8');

    const { report, exitCode } = check();
    assert.notEqual(exitCode, 0);
    assert.equal(report.reason, REASON.FAIL_UNKNOWN_KEY);
    assert.equal(report.offendingPath, 'alpha.md');
    assert.equal(report.offendingKey, 'owner');
  });

  test('FAIL: an omitted key reports FAIL_MISSING_KEY naming the key and the file', () => {
    const bad = shapeC().split('\n').filter((l) => !l.startsWith('  author:')).join('\n');
    fs.writeFileSync(path.join(templatesDir, 'alpha.md'), bad, 'utf8');

    const { report } = check();
    assert.equal(report.reason, REASON.FAIL_MISSING_KEY);
    assert.equal(report.offendingPath, 'alpha.md');
    assert.equal(report.offendingKey, 'author');
  });

  test('FAIL: an out-of-vocabulary value reports FAIL_BLOCK_MALFORMED naming the file', () => {
    const bad = shapeC().replace('  level: phase', '  level: galaxy');
    fs.writeFileSync(path.join(templatesDir, 'alpha.md'), bad, 'utf8');

    const { report } = check();
    assert.equal(report.reason, REASON.FAIL_BLOCK_MALFORMED);
    assert.equal(report.offendingPath, 'alpha.md');
  });

  test('FAIL: a stale manifest exits non-zero and carries a runnable fix command as data', () => {
    const stale = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    stale.templates = stale.templates.slice(1);
    stale.count = stale.templates.length;
    fs.writeFileSync(manifestPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

    const { report, exitCode } = check();
    assert.notEqual(exitCode, 0);
    assert.equal(report.reason, REASON.FAIL_STALE_MANIFEST);
    assert.equal(typeof report.fixCommand, 'string');
    assert.ok(report.fixCommand.length > 0, 'a gate that stops work must name the command that fixes it');
  });

  test('FAIL: a missing manifest exits non-zero carrying the fix command', () => {
    const absent = path.join(root, 'docs', 'NEVER-WRITTEN.json');
    const { report, exitCode } = checkJson([
      '--templates-dir', templatesDir,
      '--manifest-path', absent,
      '--readme-path', readmePath,
    ]);
    assert.notEqual(exitCode, 0);
    assert.equal(report.reason, REASON.FAIL_MANIFEST_MISSING);
    assert.ok(report.fixCommand.length > 0);
  });

  test('FAIL: an unparseable manifest is distinguished from a stale one', () => {
    fs.writeFileSync(manifestPath, '{ not json', 'utf8');
    const { report } = check();
    assert.equal(report.reason, REASON.FAIL_MANIFEST_UNPARSEABLE);
  });

  test('FAIL: a stale README region is reported separately from the manifest', () => {
    const readme = fs.readFileSync(readmePath, 'utf8');
    fs.writeFileSync(
      readmePath,
      readme.replace('<!-- /gsd:template-registry -->', 'hand edit\n<!-- /gsd:template-registry -->'),
      'utf8',
    );
    const { report, exitCode } = check();
    assert.notEqual(exitCode, 0);
    assert.equal(report.reason, REASON.FAIL_STALE_README);
  });
});

// ─── Task 3: the write path ──────────────────────────────────────────────────

describe('gen-template-registry: write path', () => {
  let root;
  let templatesDir;
  let manifestPath;
  let readmePath;

  function writeRun() {
    return runCli([
      '--write',
      '--templates-dir', templatesDir,
      '--manifest-path', manifestPath,
      '--readme-path', readmePath,
    ]);
  }

  /**
   * Write a manifest that already matches live state, at a path of its own, so
   * `checkReport` advances past the manifest stage and reaches the README
   * stage. Without this the manifest failure masks the marker failure and the
   * marker reason codes are never observed.
   */
  function writeSyncedManifest() {
    const synced = path.join(root, 'docs', 'SYNCED.json');
    fs.mkdirSync(path.dirname(synced), { recursive: true });
    fs.writeFileSync(synced, gen.serializeManifest(gen.buildRegistry(templatesDir)), 'utf8');
    return synced;
  }

  beforeEach(() => {
    root = createTempDir('gen-template-registry-write-');
    templatesDir = path.join(root, 'templates');
    manifestPath = path.join(root, 'docs', 'TEMPLATE-REGISTRY.json');
    readmePath = path.join(templatesDir, 'README.md');
    fs.mkdirSync(templatesDir, { recursive: true });
    buildFixtureSet(templatesDir);
    fs.writeFileSync(readmePath, readmeWith(), 'utf8');
  });

  afterEach(() => {
    cleanup(root);
  });

  test('--write is idempotent: the second run changes no byte of either artifact', () => {
    writeRun();
    const manifestOnce = fs.readFileSync(manifestPath, 'utf8');
    const readmeOnce = fs.readFileSync(readmePath, 'utf8');

    writeRun();
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), manifestOnce);
    assert.equal(fs.readFileSync(readmePath, 'utf8'), readmeOnce);
  });

  test('--write preserves every byte outside the marker pair', () => {
    const before = fs.readFileSync(readmePath, 'utf8');
    writeRun();
    const after = fs.readFileSync(readmePath, 'utf8');

    const head = (s) => s.slice(0, s.indexOf(gen.OPEN_MARKER) + gen.OPEN_MARKER.length);
    const tail = (s) => s.slice(s.indexOf(gen.CLOSE_MARKER));

    assert.equal(head(after), head(before));
    assert.equal(tail(after), tail(before));
    assert.notEqual(after, before, 'the region itself must have been filled');
  });

  test('--write renders one table row per template, keyed by path', () => {
    writeRun();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.count, 5);
    assert.deepEqual(manifest.templates.map((t) => t.path), [
      'alpha.md', 'beta.md', 'gamma.md', 'host/delta.md', 'nested/deeper/epsilon.md',
    ]);
  });

  test('the README is excluded from the registry — it is the output, not an input', () => {
    writeRun();
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(!manifest.templates.some((t) => t.path === 'README.md'));
  });

  test('--write against a README with absent markers is a hard error, not an append', () => {
    fs.writeFileSync(readmePath, '# No markers here\n', 'utf8');
    const result = runNode(
      [GENERATOR, '--write', '--templates-dir', templatesDir, '--manifest-path', manifestPath, '--readme-path', readmePath],
      { cwd: REPO_ROOT },
    );
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);
    assert.equal(fs.readFileSync(readmePath, 'utf8'), '# No markers here\n');
  });

  test('--write against inverted markers is a hard error, leaving the file untouched', () => {
    const inverted = `# H\n\n${gen.CLOSE_MARKER}\n\n${gen.OPEN_MARKER}\n`;
    fs.writeFileSync(readmePath, inverted, 'utf8');

    const result = runNode(
      [GENERATOR, '--write', '--templates-dir', templatesDir, '--manifest-path', manifestPath, '--readme-path', readmePath],
      { cwd: REPO_ROOT },
    );
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);
    assert.equal(fs.readFileSync(readmePath, 'utf8'), inverted);

    // The typed surface says WHICH marker fault it was — the exit code alone
    // cannot distinguish inverted markers from absent ones.
    const report = gen.checkReport({ templatesDir, manifestPath: writeSyncedManifest(), readmePath });
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_README_MARKERS_INVERTED);
  });

  test('--write against a duplicated marker pair is a hard error', () => {
    fs.writeFileSync(readmePath, `${readmeWith()}\n${readmeWith()}`, 'utf8');

    const result = runNode(
      [GENERATOR, '--write', '--templates-dir', templatesDir, '--manifest-path', manifestPath, '--readme-path', readmePath],
      { cwd: REPO_ROOT },
    );
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);

    const report = gen.checkReport({ templatesDir, manifestPath: writeSyncedManifest(), readmePath });
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_README_MARKERS_MISSING);
  });

  test('a CRLF README region is not misreported as drift', () => {
    writeRun();
    const lf = fs.readFileSync(readmePath, 'utf8');
    // This test MANUFACTURES the CRLF condition rather than tolerating it. The
    // `\r?` is what keeps the conversion idempotent: on a CRLF checkout a bare
    // `\n` pattern would produce `\r\r\n` and test nothing.
    fs.writeFileSync(readmePath, lf.replace(/\r?\n/g, '\r\n'), 'utf8');
    const report = gen.checkReport({ templatesDir, manifestPath, readmePath });
    assert.equal(report.reason, REASON.OK_UP_TO_DATE);
  });

  test('--write does not run on the absent-source tolerance: it is a hard error', () => {
    const result = runNode(
      [GENERATOR, '--write', '--templates-dir', path.join(root, 'nope'), '--manifest-path', manifestPath, '--readme-path', readmePath],
      { cwd: REPO_ROOT },
    );
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 1);
    assert.equal(fs.existsSync(manifestPath), false);
  });

  test('an empty templates directory is an error, never an empty registry', () => {
    const empty = path.join(root, 'empty-templates');
    fs.mkdirSync(empty, { recursive: true });
    const report = gen.checkReport({ templatesDir: empty, manifestPath, readmePath });
    assert.equal(report.ok, false);
    assert.equal(report.reason, REASON.FAIL_BLOCK_MISSING);
  });
});

// ─── The real repository ─────────────────────────────────────────────────────

describe('gen-template-registry: the shipped tree', () => {
  test('--check against the repository exits with a typed reason from the frozen enum', () => {
    const result = runNode([GENERATOR, '--check', '--json'], { cwd: REPO_ROOT });
    assert.equal(result.outcome, OUTCOME.EXITED);
    const report = JSON.parse(result.stdout);
    assert.ok(
      Object.values(REASON).includes(report.reason),
      `reason ${report.reason} is not a member of the frozen enum`,
    );
    assert.equal(report.ok, result.exitCode === 0);
  });
});

// The leading-block scanner reads each block through the one fence owner
// (locateFrontmatterFence, ADR-5057) instead of its own `---` comparison, so it
// inherits the owner's CRLF / BOM / trailing-space rules.
describe('gen-template-registry: leading-block scanner', () => {
  test('a registry block followed by artifact frontmatter yields two blocks, in order', () => {
    const text = '---\ngsd-template:\n  kind: x\n---\n\n---\nphase: 1\n---\n# Body\n';
    assert.deepEqual(gen.scanLeadingBlocks(text), [
      { lines: ['gsd-template:', '  kind: x'] },
      { lines: ['phase: 1'] },
    ]);
  });

  test('blank lines before the first block are skipped', () => {
    assert.deepEqual(gen.scanLeadingBlocks('\n  \n---\na: 1\n---\n'), [{ lines: ['a: 1'] }]);
  });

  test('a block shown inside a code fence is not file-level', () => {
    const text = '```markdown\n---\nphase: {N}\n---\n```\n';
    assert.deepEqual(gen.scanLeadingBlocks(text), []);
  });

  test('scanning stops at prose: a later `---` block is not read', () => {
    assert.deepEqual(gen.scanLeadingBlocks('# Title\n\n---\na: 1\n---\n'), []);
  });

  test('an unterminated block yields nothing', () => {
    assert.deepEqual(gen.scanLeadingBlocks('---\na: 1\n'), []);
  });

  test('CRLF and a closer with trailing spaces read the same as LF', () => {
    assert.deepEqual(gen.scanLeadingBlocks('---\r\na: 1\r\n---  \r\n# Body\r\n'), [{ lines: ['a: 1'] }]);
  });

  test('an adjacent empty block yields an empty line list', () => {
    assert.deepEqual(gen.scanLeadingBlocks('---\n---\n'), [{ lines: [] }]);
  });
});
