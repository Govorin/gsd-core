'use strict';

/**
 * gen-workflow-maps.cjs — docs/reference/workflow-maps/ is generated from the
 * shipped workflows (phase 5.5). "Regeneration = sync check": a map that no
 * longer matches its workflow, a missing map and a map left behind by a
 * deleted workflow each fail `--check`; `--write` repairs all three.
 *
 * The CLI runs against a temp `--target` directory; the "stale" fixtures are
 * documents rendered from MODIFIED sources (a renamed step, a removed agent),
 * i.e. what the committed directory looks like when a workflow changed and
 * nobody reran the generator.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const gen = require('../scripts/gen-workflow-maps.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gen-workflow-maps.cjs');

function runGen(args) {
  return runNode([SCRIPT, ...args], { timeoutMs: GENERATOR_SCRIPT_TIMEOUT_MS });
}

const expectExit = (r, code) => {
  assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
  assert.equal(r.exitCode, code, r.stderr);
};

function writeAll(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of files) fs.writeFileSync(path.join(dir, name), text);
}

describe('gen-workflow-maps: what is generated', () => {
  const sources = gen.loadSources();
  const { maps, files } = gen.renderWorkflowMaps(sources);

  test('one map per workflow with a unit or a spawn, plus the index', () => {
    assert.equal(files.size, maps.length + 1);
    assert.ok(files.has(gen.INDEX_FILE));
    for (const map of maps) assert.ok(files.has(`${map.workflow}.md`), map.workflow);
  });

  test('a renamed step changes its own workflow map and no other', () => {
    const target = sources.workflows.find((w) => w.text.includes('<step name="'));
    const renamed = {
      ...sources,
      workflows: sources.workflows.map((w) => (w === target ? { ...w, text: w.text.replace(/<step name="([^"]{1,100})"/, '<step name="$1_renamed"') } : w)),
    };
    const changed = [...gen.renderWorkflowMaps(renamed).files].filter(([name, text]) => files.get(name) !== text).map(([name]) => name);
    // The index changes too when the rename turns a resolved jump into an unresolved one.
    assert.ok(changed.includes(`${target.name}.md`), changed.join(', '));
    assert.deepEqual(changed.filter((n) => n !== `${target.name}.md` && n !== gen.INDEX_FILE), []);
  });
});

describe('gen-workflow-maps --check / --write (CLI, --target fixture)', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir('gsd-workflow-maps-');
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('--write then --check passes', () => {
    expectExit(runGen(['--write', '--target', dir]), 0);
    expectExit(runGen(['--check', '--target', dir]), 0);
  });

  for (const [what, mutate] of [
    [
      'a step renamed',
      (s) => {
        const w = s.workflows.find((x) => x.text.includes('<step name="'));
        w.text = w.text.replace(/<step name="([^"]{1,100})"/, '<step name="$1_old"');
      },
    ],
    [
      'an agent removed from agents/',
      (s) => {
        s.agents = s.agents.filter((a) => a !== 'gsd-planner');
      },
    ],
  ]) {
    test(`--check fails when the committed maps predate a change (${what}); --write repairs`, () => {
      const src = gen.loadSources();
      mutate(src);
      writeAll(dir, gen.renderWorkflowMaps(src).files);
      expectExit(runGen(['--check', '--target', dir]), 1);
      expectExit(runGen(['--write', '--target', dir]), 0);
      expectExit(runGen(['--check', '--target', dir]), 0);
    });
  }

  test('--check fails on a missing map', () => {
    expectExit(runGen(['--write', '--target', dir]), 0);
    fs.unlinkSync(path.join(dir, 'execute-phase.md'));
    expectExit(runGen(['--check', '--target', dir]), 1);
  });

  test('a map left behind by a deleted workflow fails --check and --write removes it; a hand-written file is left alone', () => {
    expectExit(runGen(['--write', '--target', dir]), 0);
    const stale = path.join(dir, 'retired-workflow.md');
    fs.copyFileSync(path.join(dir, 'execute-phase.md'), stale);
    const own = path.join(dir, 'NOTES.md');
    fs.writeFileSync(own, '# hand-written\n');
    expectExit(runGen(['--check', '--target', dir]), 1);
    expectExit(runGen(['--write', '--target', dir]), 0);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(own), true);
    expectExit(runGen(['--check', '--target', dir]), 0);
  });

  test('an unknown flag exits 1 instead of silently printing', () => {
    expectExit(runGen(['--frobnicate']), 1);
  });

  test('the committed docs/reference/workflow-maps/ is up to date', () => {
    expectExit(runGen(['--check']), 0);
  });
});
