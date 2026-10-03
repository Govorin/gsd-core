'use strict';

/**
 * `gsd-tools plan graph` — the CLI surface over plan-graph.cjs (phase 5.3).
 *
 * The graph rules themselves are pinned in tests/plan-graph.test.cjs; this file
 * pins only what the router adds: argv parsing, the JSON / --raw output
 * contract, project confinement of --dir/--out, and the failure mapping
 * (usage vs could-not-look vs --strict defects). Assertions read the JSON
 * result (a typed surface) and exit codes, never free-form message text.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const { HOST_COMMAND_ROUTERS } = require('../gsd-core/bin/gsd-tools.cjs');

describe('gsd-tools plan graph', () => {
  let project;
  let phaseDir;

  beforeEach(() => {
    project = createTempProject('gsd-plan-cli-');
    phaseDir = path.join(project, '.planning', 'phases', '01-demo');
    fs.mkdirSync(phaseDir, { recursive: true });
  });
  afterEach(() => {
    cleanup(project);
  });

  function plan(id, front) {
    const body = Object.entries(front).map(([k, v]) => `${k}: ${v}`).join('\n');
    fs.writeFileSync(path.join(phaseDir, `${id}-PLAN.md`), `---\nphase: 01\n${body}\n---\n\n# ${id}\n`);
  }
  const rel = '.planning/phases/01-demo';

  test('is registered as a host command', () => {
    assert.equal(typeof HOST_COMMAND_ROUTERS.plan, 'function');
  });

  test('prints the JSON result: counts, defects, and the markdown document', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01", "01-09"]' });

    const r = runGsdTools(['plan', 'graph', '--dir', rel], project);
    assert.equal(r.success, true, r.error);
    const json = JSON.parse(r.output);
    assert.equal(json.ok, true);
    assert.deepEqual([json.plan_count, json.edge_count, json.defect_count], [2, 2, 1]);
    assert.deepEqual(json.defects, [{ from: '01-09', to: '01-02', defect: 'missing' }]);
    assert.equal(json.written, null);
    assert.equal(json.strict_failed, false, 'defects alone never fail the command');
    assert.equal(json.markdown.split('\n')[0], '<!-- gsd:derived source=plan-graph — regenerated, do not hand-edit -->');
  });

  test('--raw prints the document; with --out it writes the file and prints the summary line', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });

    const raw = runGsdTools(['plan', 'graph', '--dir', rel, '--raw'], project);
    assert.equal(raw.success, true, raw.error);
    const viaJson = JSON.parse(runGsdTools(['plan', 'graph', '--dir', rel], project).output).markdown;
    assert.equal(raw.output, viaJson.trim());

    const out = runGsdTools(['plan', 'graph', '--dir', rel, '--out', `${rel}/PLAN-GRAPH.md`], project);
    assert.equal(out.success, true, out.error);
    const json = JSON.parse(out.output);
    assert.equal(json.written, path.join(fs.realpathSync(phaseDir), 'PLAN-GRAPH.md'));
    assert.equal(fs.readFileSync(path.join(phaseDir, 'PLAN-GRAPH.md'), 'utf8'), json.markdown);
  });

  test('--strict fails the process on a defect and not on a clean graph', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    assert.equal(runGsdTools(['plan', 'graph', '--dir', rel, '--strict'], project).success, true);
    plan('01-02', { wave: 1, depends_on: '["01-01"]' });
    const r = runGsdTools(['plan', 'graph', '--dir', rel, '--strict'], project);
    assert.equal(r.success, false);
    assert.equal(r.exitCode, 1);
  });

  test('missing --dir, an outside path, and an empty directory all fail', () => {
    for (const args of [
      ['plan', 'graph'],
      ['plan', 'graph', '--dir'],
      ['plan', 'graph', '--dir', '../..'],
      ['plan', 'graph', '--dir', rel],
    ]) {
      const r = runGsdTools([...args, '--json-errors'], project);
      assert.equal(r.success, false, args.join(' '));
      const reason = JSON.parse(r.error.trim().split('\n').at(-1)).reason;
      const expected = args.length === 4 && args[3] === rel ? 'phase_not_found' : 'usage';
      assert.equal(reason, expected, args.join(' '));
    }
  });

  test('an absolute --out outside the project is refused', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    const outside = createTempDir('gsd-plan-cli-outside-');
    const r = runGsdTools(['plan', 'graph', '--dir', rel, '--out', path.join(outside, 'G.md'), '--json-errors'], project);
    const exists = fs.existsSync(path.join(outside, 'G.md'));
    cleanup(outside);
    assert.equal(r.success, false);
    assert.equal(exists, false);
  });

  test('an unknown subcommand is a usage error', () => {
    assert.equal(runGsdTools(['plan', 'frobnicate'], project).success, false);
  });
});
