'use strict';

/**
 * `gsd-tools discuss tree` — the CLI surface of src/decision-tree.cts: argv
 * parsing, path confinement, the workflow.max_discuss_passes lookup, the JSON
 * vs --raw output convention, and the exit behaviour of --strict. The tree
 * logic itself is pinned in tests/decision-tree.test.cjs.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const { HOST_COMMAND_ROUTERS } = require('../gsd-core/bin/gsd-tools.cjs');

describe('gsd-tools discuss tree', () => {
  let project;
  const rel = '.planning/phases/01-demo/01-DISCUSS-CHECKPOINT.json';

  beforeEach(() => {
    project = createTempProject('gsd-discuss-cli-');
    fs.mkdirSync(path.join(project, '.planning', 'phases', '01-demo'), { recursive: true });
  });
  afterEach(() => {
    cleanup(project);
  });

  function checkpoint(nodes) {
    fs.writeFileSync(path.join(project, rel), JSON.stringify({ phase: '01', decisions: {}, decision_tree: { nodes } }));
  }
  function setConfig(workflow) {
    fs.writeFileSync(path.join(project, '.planning', 'config.json'), JSON.stringify({ workflow }));
  }
  /** A three-level chain: decided root, open level 2, open level 3. */
  const chain = [
    { id: 'D-01', question: 'q1', answer: 'a1', status: 'decided', decided_by: 'user' },
    { id: 'D-02', question: 'q2', answer: 'a2', status: 'decided', decided_by: 'recommendation', depends_on: ['D-01'] },
    { id: 'D-03', question: 'q3', status: 'open', depends_on: ['D-02'] },
  ];

  test('is registered as a host command', () => {
    assert.equal(typeof HOST_COMMAND_ROUTERS.discuss, 'function');
  });

  test('prints the JSON result with the next question', () => {
    checkpoint(chain);
    const r = runGsdTools(['discuss', 'tree', '--file', rel], project);
    assert.equal(r.success, true, r.error);
    const json = JSON.parse(r.output);
    assert.equal(json.ok, true);
    assert.equal(json.max_passes, 3, 'absent key → default');
    assert.deepEqual(json.next, { id: 'D-03', label: 'q3', area: '', level: 3, unblocks: 0 });
    assert.deepEqual(json.decided_by, { user: 1, recommendation: 1, codebase: 0, unattributed: 0 });
  });

  // The open node is at level 3: workflow.max_discuss_passes at limit-1 / limit / limit+1.
  for (const [cap, expectNext] of [[2, null], [3, 'D-03'], [4, 'D-03']]) {
    test(`honours workflow.max_discuss_passes=${cap}`, () => {
      checkpoint(chain);
      setConfig({ max_discuss_passes: cap });
      const json = JSON.parse(runGsdTools(['discuss', 'tree', '--file', rel], project).output);
      assert.equal(json.max_passes, cap);
      assert.equal(json.next === null ? null : json.next.id, expectNext);
      assert.equal(json.stopped, expectNext === null ? 'pass_cap' : null);
    });
  }

  test('--raw prints the derived document; --out writes it and prints the summary', () => {
    checkpoint(chain);
    const raw = runGsdTools(['discuss', 'tree', '--file', rel, '--raw'], project);
    assert.equal(raw.success, true, raw.error);
    assert.equal(raw.output.split('\n')[0], '<!-- gsd:derived source=decision-tree — regenerated, do not hand-edit -->');

    const json = JSON.parse(runGsdTools(['discuss', 'tree', '--file', rel, '--out', 'tree.md'], project).output);
    assert.equal(json.written, path.join(fs.realpathSync(project), 'tree.md'));
    assert.equal(fs.readFileSync(path.join(project, 'tree.md'), 'utf8'), json.markdown);
  });

  test('--strict fails after printing when the tree has defects, passes when clean', () => {
    checkpoint([{ id: 'D-01', question: 'q', status: 'open', depends_on: ['D-09'] }]);
    const bad = runGsdTools(['discuss', 'tree', '--file', rel, '--strict'], project);
    assert.equal(bad.success, false);
    assert.equal(JSON.parse(bad.output).defect_count, 1, 'the result is printed before the failure');

    checkpoint(chain);
    assert.equal(runGsdTools(['discuss', 'tree', '--file', rel, '--strict'], project).success, true);
  });

  test('defects alone never fail the command', () => {
    checkpoint([{ id: 'D-01', question: 'q', status: 'open', depends_on: ['D-09'] }]);
    const r = runGsdTools(['discuss', 'tree', '--file', rel], project);
    assert.equal(r.success, true, r.error);
    assert.equal(JSON.parse(r.output).strict_failed, false);
  });

  test('usage errors: no --file, --out without a value, unknown subcommand', () => {
    for (const argv of [['discuss', 'tree'], ['discuss', 'tree', '--file', rel, '--out'], ['discuss', 'nope']]) {
      assert.equal(runGsdTools(argv, project).success, false, argv.join(' '));
    }
  });

  test('paths outside the project are refused', (t) => {
    const outside = createTempDir('gsd-discuss-outside-');
    t.after(() => cleanup(outside));
    const file = path.join(outside, 'cp.json');
    fs.writeFileSync(file, JSON.stringify({ decision_tree: { nodes: [] } }));
    assert.equal(runGsdTools(['discuss', 'tree', '--file', file], project).success, false);
    checkpoint(chain);
    assert.equal(runGsdTools(['discuss', 'tree', '--file', rel, '--out', path.join(outside, 'x.md')], project).success, false);
    assert.equal(fs.existsSync(path.join(outside, 'x.md')), false);
  });

  test('a missing file is a failure to look, not an empty tree', () => {
    assert.equal(runGsdTools(['discuss', 'tree', '--file', rel], project).success, false);
  });

  test('reads a written CONTEXT.md as well', () => {
    const ctx = '.planning/phases/01-demo/01-CONTEXT.md';
    fs.writeFileSync(path.join(project, ctx), [
      '<decisions>', '### API',
      '- **D-01:** Cursor paging — **Decided by:** recommendation',
      '- **D-02:** Page size 50 — **Decided by:** user — **Depends on:** D-01',
      '</decisions>', '',
    ].join('\n'));
    const json = JSON.parse(runGsdTools(['discuss', 'tree', '--file', ctx, '--strict'], project).output);
    assert.equal(json.source, 'context');
    assert.deepEqual([json.node_count, json.edge_count, json.defect_count], [2, 1, 0]);
    assert.equal(json.stopped, 'complete');
  });
});
