'use strict';

/**
 * decision-tree.cjs (built from src/decision-tree.cts) — discuss-phase
 * decisions as a dependency tree: grill mode's next question, the pass cap,
 * defects, and the mermaid picture.
 *
 * Driven through the module's typed surface: `buildDecisionTree` returns the
 * tree model, `runDecisionTree` the command result. The drawing is read back
 * with mermaid-parse into a FlowchartSpec and compared as data, never as
 * substrings. The CLI surface is pinned in tests/discuss-command-router.test.cjs.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const dt = require('../gsd-core/bin/lib/decision-tree.cjs');
const { parseMermaid } = require('../gsd-core/bin/lib/mermaid-parse.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const FENCE = '`'.repeat(3);

/** An open node with sane defaults. */
function node(id, over = {}) {
  return { id, label: `question ${id}`, status: 'open', decidedBy: null, dependsOn: [], area: '', ...over };
}
const decided = (id, by, over = {}) => node(id, { status: 'decided', decidedBy: by, ...over });

/** The one mermaid block of a derived document, parsed into its FlowchartSpec. */
function drawn(markdown) {
  const lines = splitLines(markdown);
  const start = lines.findIndex((l) => l.trim() === `${FENCE}mermaid`);
  assert.notEqual(start, -1, 'no mermaid block');
  const end = lines.findIndex((l, i) => i > start && l.trim() === FENCE);
  const parsed = parseMermaid(lines.slice(start + 1, end).join('\n'));
  assert.equal(parsed.ok, true, parsed.message);
  assert.equal(parsed.diagram.type, 'flowchart');
  return parsed.diagram.spec;
}

/** Map a drawn spec back to decision ids: `d_D_01` → `D-01`. */
const declId = (mermaidId) => mermaidId.replace(/^d_/, '').replace(/_/g, '-');

describe('decision-tree: frontier and next question', () => {
  test('next is the earliest frontier node that other open decisions depend on', () => {
    const tree = dt.buildDecisionTree([
      node('D-01'),
      node('D-02'),
      node('D-03', { dependsOn: ['D-02'] }),
    ]);
    assert.deepEqual(tree.frontier, ['D-01', 'D-02']);
    assert.equal(tree.next, 'D-02', 'D-01 blocks nothing, D-02 blocks D-03');
    assert.deepEqual(tree.blocked, [{ id: 'D-03', waiting_on: ['D-02'] }]);
  });

  test('with no dependents anywhere, next is the earliest frontier node', () => {
    const tree = dt.buildDecisionTree([node('D-02'), node('D-01')]);
    assert.equal(tree.next, 'D-02', 'declaration order, not id order');
  });

  test('a decided or discretion dependency opens the dependent; an open one blocks it', () => {
    const tree = dt.buildDecisionTree([
      decided('D-01', 'codebase'),
      node('D-02', { status: 'discretion' }),
      node('D-03', { dependsOn: ['D-01', 'D-02'] }),
      node('D-04', { dependsOn: ['D-03'] }),
    ]);
    assert.deepEqual(tree.frontier, ['D-03']);
    assert.equal(tree.next, 'D-03');
    assert.deepEqual(tree.blocked, [{ id: 'D-04', waiting_on: ['D-03'] }]);
  });

  test('unblocks counts distinct transitive open dependents only', () => {
    const tree = dt.buildDecisionTree([
      node('D-01'),
      node('D-02', { dependsOn: ['D-01'] }),
      node('D-03', { dependsOn: ['D-01', 'D-02'] }),
      decided('D-04', 'user', { dependsOn: ['D-02'] }),
    ]);
    const byId = Object.fromEntries(tree.nodes.map((n) => [n.id, n]));
    assert.equal(byId['D-01'].unblocks, 2, 'D-02 and D-03, D-03 counted once; decided D-04 not counted');
    assert.equal(byId['D-02'].unblocks, 1);
    assert.equal(byId['D-03'].unblocks, 0);
  });

  test('everything closed → no next, stopped complete', () => {
    const tree = dt.buildDecisionTree([decided('D-01', 'user'), node('D-02', { status: 'discretion' })]);
    assert.equal(tree.next, null);
    assert.equal(tree.stopped, 'complete');
  });

  test('open nodes waiting only on defects → stopped blocked', () => {
    const tree = dt.buildDecisionTree([node('D-01', { dependsOn: ['D-09'] })]);
    assert.equal(tree.next, null);
    assert.equal(tree.stopped, 'blocked');
    assert.deepEqual(tree.blocked, [{ id: 'D-01', waiting_on: ['D-09'] }]);
  });
});

describe('decision-tree: pass cap (workflow.max_discuss_passes)', () => {
  /** A chain D-01 ← D-02 ← … ← D-n with every node but the last decided. */
  function chain(n) {
    const nodes = [];
    for (let i = 1; i <= n; i++) {
      const id = `D-0${i}`;
      const deps = i === 1 ? [] : [`D-0${i - 1}`];
      nodes.push(i < n ? decided(id, 'user', { dependsOn: deps }) : node(id, { dependsOn: deps }));
    }
    return nodes;
  }

  test('levels: roots are 1, a node is one below its deepest dependency', () => {
    const tree = dt.buildDecisionTree([
      node('D-01'),
      node('D-02', { dependsOn: ['D-01'] }),
      node('D-03', { dependsOn: ['D-01', 'D-02'] }),
    ]);
    assert.deepEqual(tree.nodes.map((n) => n.level), [1, 2, 3]);
  });

  // The open node sits at level 3; cap at limit-1, limit, limit+1.
  for (const [cap, asked] of [[2, false], [3, true], [4, true]]) {
    test(`a level-3 frontier node with max_passes=${cap} is ${asked ? '' : 'not '}asked`, () => {
      const tree = dt.buildDecisionTree(chain(3), { maxPasses: cap });
      assert.equal(tree.maxPasses, cap);
      assert.equal(tree.next, asked ? 'D-03' : null);
      assert.equal(tree.stopped, asked ? null : 'pass_cap');
      assert.deepEqual(tree.beyondCap, asked ? [] : ['D-03']);
    });
  }

  test('a capped deep node does not hide a shallow one', () => {
    const tree = dt.buildDecisionTree([...chain(3), node('D-09')], { maxPasses: 2 });
    assert.equal(tree.next, 'D-09');
    assert.deepEqual(tree.beyondCap, ['D-03']);
  });

  test('resolveMaxPasses: positive integers (and their strings) pass, anything else is the default', () => {
    const D = dt.DEFAULT_MAX_DISCUSS_PASSES;
    const cases = [[1, 1], [2, 2], ['5', 5], [' 7 ', 7], [0, D], [-1, D], [1.5, D], ['x', D], ['', D], [null, D], [undefined, D], [true, D]];
    for (const [input, expected] of cases) {
      assert.equal(dt.resolveMaxPasses(input), expected, `resolveMaxPasses(${JSON.stringify(input)})`);
    }
  });

  test('the default equals config-defaults.manifest.json workflow.max_discuss_passes', () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'bin', 'shared', 'config-defaults.manifest.json'), 'utf8'));
    assert.equal(dt.DEFAULT_MAX_DISCUSS_PASSES, manifest.workflow.max_discuss_passes);
  });
});

describe('decision-tree: defects are reported, never hidden', () => {
  test('a dependency on an unknown id is a missing defect and a missing node', () => {
    const tree = dt.buildDecisionTree([node('D-01', { dependsOn: ['D-07'] })]);
    assert.deepEqual(tree.missing, ['D-07']);
    assert.deepEqual(tree.defects.map((d) => [d.type, d.id, d.ref]), [['missing', 'D-01', 'D-07']]);
  });

  test('every edge of a cycle is a cycle defect, and the rest stays acyclic', () => {
    const tree = dt.buildDecisionTree([
      node('D-01', { dependsOn: ['D-02'] }),
      node('D-02', { dependsOn: ['D-01'] }),
      node('D-03'),
    ]);
    assert.deepEqual(tree.edges.map((e) => e.defect), ['cycle', 'cycle']);
    assert.deepEqual(tree.defects.map((d) => d.type), ['cycle', 'cycle']);
    assert.equal(tree.next, 'D-03', 'cycle members are never on the frontier');
    assert.deepEqual(tree.nodes.map((n) => n.level), [1, 1, 1]);
  });

  test('a duplicate id keeps the first declaration', () => {
    const tree = dt.buildDecisionTree([node('D-01', { label: 'first' }), node('D-01', { label: 'second' })]);
    assert.deepEqual(tree.nodes.map((n) => n.label), ['first']);
    assert.deepEqual(tree.defects.map((d) => [d.type, d.id]), [['duplicate', 'D-01']]);
  });

  test('a decision taken before its open dependency is a warning on the edge, not a defect', () => {
    const tree = dt.buildDecisionTree([node('D-01'), decided('D-02', 'user', { dependsOn: ['D-01'] })]);
    assert.deepEqual(tree.edges.map((e) => e.warning), ['decided_before_dep']);
    assert.deepEqual(tree.defects, []);
  });
});

describe('decision-tree: reading the grill checkpoint', () => {
  const cp = (nodes) => ({ phase: '01', decisions: {}, decision_tree: { nodes } });

  test('reads every field; a decided label is its answer, an open one its question', () => {
    const read = dt.readCheckpointTree(cp([
      { id: 'D-01', question: 'DB?', answer: 'Postgres', status: 'decided', decided_by: 'codebase', area: 'Data' },
      { id: 'D-02', question: 'Paging?', status: 'open', depends_on: ['D-01'], recommendation: 'cursor' },
    ]));
    assert.deepEqual(read.defects, []);
    assert.deepEqual(read.nodes, [
      { id: 'D-01', label: 'Postgres', status: 'decided', decidedBy: 'codebase', dependsOn: [], area: 'Data' },
      { id: 'D-02', label: 'Paging?', status: 'open', decidedBy: null, dependsOn: ['D-01'], area: '' },
    ]);
  });

  test('no decision_tree.nodes array → null (not an empty tree)', () => {
    for (const v of [null, 3, {}, { decision_tree: {} }, { decision_tree: { nodes: 'x' } }]) {
      assert.equal(dt.readCheckpointTree(v), null, JSON.stringify(v));
    }
  });

  test('malformed entries are invalid_node defects and are left out', () => {
    const read = dt.readCheckpointTree(cp([
      'nope',
      { id: 'X-1', question: 'q', status: 'open' },
      { id: 'D-01', question: 'q', status: 'pending' },
      { id: 'D-02', question: 'q', status: 'open', depends_on: 'D-01' },
      { id: 'D-03', status: 'open' },
      { id: 'D-04', question: 'ok', status: 'open' },
    ]));
    assert.deepEqual(read.nodes.map((n) => n.id), ['D-04']);
    assert.deepEqual(read.defects.map((d) => [d.type, d.id]), [
      ['invalid_node', null], ['invalid_node', null], ['invalid_node', 'D-01'], ['invalid_node', 'D-02'], ['invalid_node', 'D-03'],
    ]);
  });

  test('a decided entry without a valid decided_by stays in, unattributed, as a defect', () => {
    const read = dt.readCheckpointTree(cp([
      { id: 'D-01', question: 'q', answer: 'a', status: 'decided' },
      { id: 'D-02', question: 'q', answer: 'a', status: 'decided', decided_by: 'claude' },
    ]));
    assert.deepEqual(read.nodes.map((n) => [n.id, n.decidedBy]), [['D-01', null], ['D-02', null]]);
    assert.deepEqual(read.defects.map((d) => [d.type, d.id]), [['unattributed', 'D-01'], ['unattributed', 'D-02']]);
  });

  test('phase-prefixed and alphanumeric ids follow the decisions.cts grammar', () => {
    const read = dt.readCheckpointTree(cp([
      { id: 'D4-01', question: 'q', status: 'open' },
      { id: 'D-INFRA-01', question: 'q', status: 'open', depends_on: ['D4-01'] },
    ]));
    assert.deepEqual(read.defects, []);
    assert.deepEqual(read.nodes.map((n) => n.id), ['D4-01', 'D-INFRA-01']);
  });
});

describe('decision-tree: reading CONTEXT.md', () => {
  const context = (body) => `# Phase 1: Context\n\n<decisions>\n## Implementation Decisions\n\n${body}\n</decisions>\n`;

  test('Decided by / Depends on fields, the informational tag, and Claude\'s Discretion', () => {
    const r = dt.readContextTree(context([
      '### Data',
      '- **D-01 [informational]:** Postgres via Drizzle (`src/db.ts`) — **Decided by:** codebase',
      '### API',
      '- **D-02:** Cursor-based pagination — **Decided by:** recommendation — **Depends on:** D-01 — **Reversibility:** costly — clients store cursors',
      '- **D-03:** Page size 50 — **Decided by:** user — **Depends on:** D-01, D-02',
      "### Claude's Discretion",
      '- **D-04:** Cache headers? — recommended: none — **Depends on:** D-02',
    ].join('\n')));
    assert.equal(r.ok, true);
    assert.deepEqual(r.tree.defects, []);
    assert.deepEqual(r.tree.nodes, [
      { id: 'D-01', label: 'Postgres via Drizzle (`src/db.ts`)', status: 'decided', decidedBy: 'codebase', dependsOn: [], area: 'Data' },
      { id: 'D-02', label: 'Cursor-based pagination', status: 'decided', decidedBy: 'recommendation', dependsOn: ['D-01'], area: 'API' },
      { id: 'D-03', label: 'Page size 50', status: 'decided', decidedBy: 'user', dependsOn: ['D-01', 'D-02'], area: 'API' },
      { id: 'D-04', label: 'Cache headers? — recommended: none', status: 'discretion', decidedBy: null, dependsOn: ['D-02'], area: '' },
    ]);
  });

  test('a CONTEXT.md from another mode draws unattributed decisions with no edges', () => {
    const r = dt.readContextTree(context('### Layout\n- **D-01:** Cards reuse the Card component\n- **D-02:** Infinite scroll'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.tree.nodes.map((n) => [n.id, n.status, n.decidedBy, n.dependsOn.length]), [
      ['D-01', 'decided', null, 0], ['D-02', 'decided', null, 0],
    ]);
  });

  test('an unknown Decided by value is an unattributed defect', () => {
    const r = dt.readContextTree(context('### A\n- **D-01:** X — **Decided by:** the team'));
    assert.deepEqual(r.tree.defects.map((d) => [d.type, d.id]), [['unattributed', 'D-01']]);
  });

  test('no decisions → no_tree; unparseable decisions → unreadable', () => {
    assert.equal(dt.readContextTree('# nothing here\n').reason, 'no_tree');
    assert.equal(dt.readContextTree(context('- **D-01 broken bullet without colon')).reason, 'unreadable');
  });

  test('splitDecisionFields: a dash before plain prose is not a field boundary', () => {
    const { statement, fields } = dt.splitDecisionFields('Use X — because Y — **Reversibility:** one-way — breaks the wire format');
    assert.equal(statement, 'Use X — because Y');
    assert.deepEqual([...fields], [['reversibility', 'one-way — breaks the wire format']]);
  });

  test('parseDependsOnField: ids in order, no repeats, prose ignored', () => {
    assert.deepEqual(dt.parseDependsOnField('D-01, D4-02 and D-01 (see D-INFRA-1)'), ['D-01', 'D4-02', 'D-INFRA-1']);
    assert.deepEqual(dt.parseDependsOnField('none'), []);
  });
});

describe('decision-tree: the drawing', () => {
  test('nodes, classes, area subgraphs and edges come from the tree and nothing else', () => {
    const tree = dt.buildDecisionTree([
      decided('D-01', 'codebase', { area: 'Data' }),
      decided('D-02', 'recommendation', { area: 'API', dependsOn: ['D-01'] }),
      decided('D-03', 'user', { area: 'API', dependsOn: ['D-02'] }),
      node('D-04', { dependsOn: ['D-03'] }),
      node('D-05', { dependsOn: ['D-04'] }),
      node('D-06', { status: 'discretion' }),
      decided('D-07', null),
      node('D-08', { dependsOn: ['D-99'] }),
    ], { maxPasses: 4 }); // D-04 sits at level 4
    const spec = drawn(dt.renderDecisionTree(tree));
    assert.equal(spec.direction, 'TD');
    assert.deepEqual(
      spec.nodes.map((n) => [declId(n.id), n.className]),
      [
        ['D-01', 'by_codebase'], ['D-02', 'by_recommendation'], ['D-03', 'by_user'],
        ['D-04', 'next_q'], ['D-05', 'open_q'], ['D-06', 'discretion'], ['D-07', 'decided'], ['D-08', 'open_q'],
        ['D-99', 'missing'],
      ],
    );
    assert.deepEqual(spec.subgraphs.map((s) => [s.title, s.nodes.map(declId)]), [['Data', ['D-01']], ['API', ['D-02', 'D-03']]]);
    assert.deepEqual(
      spec.edges.map((e) => [declId(e.from), declId(e.to), e.line ?? 'solid', e.linkStyle ?? null]),
      [
        ['D-01', 'D-02', 'solid', null],
        ['D-02', 'D-03', 'solid', null],
        ['D-03', 'D-04', 'solid', null],
        ['D-04', 'D-05', 'solid', null],
        ['D-99', 'D-08', 'dotted', 'stroke:#d33,stroke-width:2px'],
      ],
    );
  });

  test('a decided-before-dependency edge is drawn amber', () => {
    const spec = drawn(dt.renderDecisionTree(dt.buildDecisionTree([node('D-01'), decided('D-02', 'user', { dependsOn: ['D-01'] })])));
    assert.deepEqual(spec.edges.map((e) => e.linkStyle), ['stroke:#ef6c00,stroke-width:2px']);
  });

  test('the same tree gives the same bytes', () => {
    const nodes = [node('D-01', { area: 'A' }), node('D-02', { dependsOn: ['D-01'], area: 'B' })];
    assert.equal(dt.renderDecisionTree(dt.buildDecisionTree(nodes)), dt.renderDecisionTree(dt.buildDecisionTree(nodes)));
  });

  test('label text cannot change the diagram structure', () => {
    const spec = drawn(dt.renderDecisionTree(dt.buildDecisionTree([node('D-01', { label: 'a --> b"; end\n%% x' })])));
    assert.equal(spec.nodes.length, 1);
    assert.equal(spec.edges.length, 0);
  });
});

describe('decision-tree: runDecisionTree', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-decision-tree-'); });
  afterEach(() => { cleanup(dir); });

  const write = (name, content) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
  };

  test('checkpoint: counts, attribution, next, and the derived document', () => {
    const file = write('01-DISCUSS-CHECKPOINT.json', {
      decision_tree: {
        nodes: [
          { id: 'D-01', question: 'DB?', answer: 'Postgres', status: 'decided', decided_by: 'codebase' },
          { id: 'D-02', question: 'Paging?', status: 'open', depends_on: ['D-01'], area: 'API' },
          { id: 'D-03', question: 'Size?', status: 'open', depends_on: ['D-02'], area: 'API' },
        ],
      },
    });
    const r = dt.runDecisionTree({ file, out: null, strict: false, maxPasses: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.source, 'checkpoint');
    assert.deepEqual([r.node_count, r.edge_count, r.defect_count], [3, 2, 0]);
    assert.deepEqual(r.counts, { open: 2, decided: 1, discretion: 0 });
    assert.deepEqual(r.decided_by, { user: 0, recommendation: 0, codebase: 1, unattributed: 0 });
    assert.deepEqual(r.next, { id: 'D-02', label: 'Paging?', area: 'API', level: 2, unblocks: 1 });
    assert.equal(r.stopped, null);
    assert.equal(r.markdown.split('\n')[0], '<!-- gsd:derived source=decision-tree — regenerated, do not hand-edit -->');
    assert.equal(r.strict_failed, false);
  });

  test('strict fails only when there are defects', () => {
    const clean = write('a.json', { decision_tree: { nodes: [{ id: 'D-01', question: 'q', status: 'open' }] } });
    const bad = write('b.json', { decision_tree: { nodes: [{ id: 'D-01', question: 'q', status: 'open', depends_on: ['D-02'] }] } });
    assert.equal(dt.runDecisionTree({ file: clean, out: null, strict: true, maxPasses: 3 }).strict_failed, false);
    assert.equal(dt.runDecisionTree({ file: bad, out: null, strict: true, maxPasses: 3 }).strict_failed, true);
    assert.equal(dt.runDecisionTree({ file: bad, out: null, strict: false, maxPasses: 3 }).strict_failed, false);
  });

  test('--out writes exactly the returned document', () => {
    const file = write('c.json', { decision_tree: { nodes: [{ id: 'D-01', question: 'q', status: 'open' }] } });
    const out = path.join(dir, 'tree.md');
    const r = dt.runDecisionTree({ file, out, strict: false, maxPasses: 3 });
    assert.equal(r.written, out);
    assert.equal(fs.readFileSync(out, 'utf8'), r.markdown);
  });

  test('nothing to look at is a failure, never an empty tree', () => {
    assert.equal(dt.runDecisionTree({ file: path.join(dir, 'none.json'), out: null, strict: false, maxPasses: 3 }).reason, 'not_found');
    assert.equal(dt.runDecisionTree({ file: write('d.json', '{oops'), out: null, strict: false, maxPasses: 3 }).reason, 'unreadable');
    assert.equal(dt.runDecisionTree({ file: write('e.json', { decisions: {} }), out: null, strict: false, maxPasses: 3 }).reason, 'no_tree');
    assert.equal(dt.runDecisionTree({ file: write('f.md', '# empty\n'), out: null, strict: false, maxPasses: 3 }).reason, 'no_tree');
  });

  test('an unwritable --out is write_failed', () => {
    const file = write('g.json', { decision_tree: { nodes: [{ id: 'D-01', question: 'q', status: 'open' }] } });
    const r = dt.runDecisionTree({ file, out: path.join(dir, 'missing-dir', 'tree.md'), strict: false, maxPasses: 3 });
    assert.equal(r.reason, 'write_failed');
  });

  test('readMaxDiscussPasses reads workflow.max_discuss_passes, default when absent', () => {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    assert.equal(dt.readMaxDiscussPasses(dir), dt.DEFAULT_MAX_DISCUSS_PASSES);
    write(path.join('.planning', 'config.json'), { workflow: { max_discuss_passes: 5 } });
    assert.equal(dt.readMaxDiscussPasses(dir), 5);
    write(path.join('.planning', 'config.json'), { workflow: { max_discuss_passes: 0 } });
    assert.equal(dt.readMaxDiscussPasses(dir), dt.DEFAULT_MAX_DISCUSS_PASSES);
  });
});
