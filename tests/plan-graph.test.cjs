'use strict';

/**
 * plan-graph.cjs (built from src/plan-graph.cts) — mermaid for a phase's plans,
 * built from `wave` and `depends_on`.
 *
 * Ported from the tests of the retired
 * capabilities/mn-verify-gate/scripts/plan-graph.mjs. Same rules, same cases,
 * driven through the module's typed surface — `runPlanGraph` returns
 * `{ ok, …counts, defects, markdown, strict_failed }` or `{ ok: false, reason }`
 * — instead of a subprocess's exit code. The CLI surface is pinned in
 * tests/plan-command-router.test.cjs.
 *
 * The markdown is parsed into a model (nodes, edges, red edges) and models are
 * compared, never substrings of the produced text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const pg = require('../gsd-core/bin/lib/plan-graph.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const FENCE = '`'.repeat(3);

/** The body of every ```mermaid fence, in order — line-based, so CRLF input reads the same. */
function mermaidBlocks(markdown) {
  const blocks = [];
  let cur = null;
  for (const line of splitLines(markdown)) {
    if (cur === null && line.trim() === `${FENCE}mermaid`) cur = [];
    else if (cur !== null && line.trim() === FENCE) {
      blocks.push(cur.join('\n'));
      cur = null;
    } else if (cur !== null) cur.push(line);
  }
  return blocks;
}

/** Parse the derived document into { marker, subgraphs, nodes, edges, red, defectLines }. */
function parseGraph(markdown) {
  const lines = splitLines(markdown);
  const [block] = mermaidBlocks(markdown);
  assert.ok(block !== undefined, `no mermaid block in output:\n${markdown}`);
  const nodes = new Map();
  const edges = [];
  const red = [];
  const subgraphs = [];
  let current = null;
  for (const line of splitLines(block)) {
    let m;
    if ((m = line.match(/^\s+subgraph \w+\["(.*)"\]$/))) {
      current = m[1];
      subgraphs.push(current);
    } else if (/^\s+end$/.test(line)) {
      current = null;
    } else if ((m = line.match(/^\s+(p_\w+)\["(.*)"\]:::(\w+)$/))) {
      nodes.set(m[1], { label: m[2], cls: m[3], wave: current });
    } else if ((m = line.match(/^\s+(p_\w+) (-->|-\.->) (p_\w+)$/))) {
      edges.push({ from: m[1], to: m[3], dashed: m[2] === '-.->' });
    } else if ((m = line.match(/^\s+linkStyle (\d+) stroke:#d33/))) {
      red.push(Number(m[1]));
    }
  }
  const defectStart = lines.indexOf('Дефекты графа:');
  const defectLines = defectStart === -1 ? [] : lines.slice(defectStart + 1).filter((l) => l.startsWith('- '));
  return { marker: lines[0], subgraphs, nodes, edges, red, defectLines };
}

describe('plan-graph module', () => {
  let dir;

  beforeEach(() => {
    dir = createTempDir('gsd-plan-graph-');
  });
  afterEach(() => {
    cleanup(dir);
  });

  function plan(id, front = {}, name = `${id}-PLAN.md`) {
    const body = Object.entries(front)
      .map(([k, v]) => (v === undefined ? '' : `${k}: ${v}`))
      .filter(Boolean)
      .join('\n');
    fs.writeFileSync(path.join(dir, name), `---\nphase: 01\n${body}\n---\n\n# ${id}\n`);
  }
  function summary(id) {
    fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), '---\nphase: 01\n---\n\n# done\n');
  }
  function run(opts = {}) {
    return pg.runPlanGraph({ dir, out: null, strict: false, ...opts });
  }
  function graph(r) {
    assert.equal(r.ok, true, r.message);
    return parseGraph(r.markdown);
  }
  const edgePairs = (g) => g.edges.map((e) => `${e.from}>${e.to}${e.dashed ? '?' : ''}`);

  // ── nothing missing, nothing added ────────────────────────────────────────

  test('one node per plan file and one edge per depends_on entry — nothing else', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    plan('01-03', { wave: 3, depends_on: '["01-01", "01-02"]' });

    const r = run();
    const g = graph(r);
    assert.deepEqual([...g.nodes.keys()].sort(), ['p_01_01', 'p_01_02', 'p_01_03']);
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02', 'p_01_01>p_01_03', 'p_01_02>p_01_03']);
    assert.deepEqual(g.red, [], 'a clean graph has no red edges');
    assert.deepEqual([r.plan_count, r.edge_count, r.defect_count, r.strict_failed], [3, 3, 0, false]);
  });

  test('groups plans into one subgraph per wave, in wave order', () => {
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    plan('01-01', { wave: 1, depends_on: '[]' });

    const g = graph(run());
    assert.deepEqual(g.subgraphs, ['wave 1', 'wave 2']);
    assert.equal(g.nodes.get('p_01_01').wave, 'wave 1');
    assert.equal(g.nodes.get('p_01_02').wave, 'wave 2');
  });

  test('ignores files that are not plans', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    fs.writeFileSync(path.join(dir, 'notes.md'), '---\nwave: 9\n---\n');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '---\n---\n');

    const g = graph(run());
    assert.deepEqual([...g.nodes.keys()], ['p_01_01']);
  });

  test('puts the derived marker first, so a reader knows not to hand-edit', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    assert.equal(graph(run()).marker, '<!-- gsd:derived source=plan-graph — regenerated, do not hand-edit -->');
  });

  // ── the three legal spellings of depends_on ───────────────────────────────

  test('reads depends_on as an inline list, a block list, and an empty list alike', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    // Block list with a blank line inside — legal YAML, and it must not close the list.
    fs.writeFileSync(
      path.join(dir, '01-03-PLAN.md'),
      '---\nphase: 01\nwave: 3\ndepends_on:\n  - 01-01\n\n  - "01-02"\n---\n\n# 01-03\n',
    );

    const g = graph(run());
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02', 'p_01_01>p_01_03', 'p_01_02>p_01_03']);
  });

  test('parseDependsOn: scalar, commented and absent forms', () => {
    assert.deepEqual(pg.parseDependsOn('depends_on: 01-01'), ['01-01']);
    assert.deepEqual(pg.parseDependsOn('depends_on: ["01-01"] # why'), ['01-01']);
    assert.deepEqual(pg.parseDependsOn('depends_on: # none yet\nwave: 1'), []);
    assert.deepEqual(pg.parseDependsOn('depends_on:\n  - 01-01 # first\nwave: 2'), ['01-01']);
    assert.deepEqual(pg.parseDependsOn('wave: 1'), []);
  });

  test('a plan with no depends_on key at all has no incoming edges', () => {
    plan('01-01', { wave: 1 });
    const g = graph(run());
    assert.deepEqual(g.edges, []);
    assert.equal(g.nodes.size, 1);
  });

  test('keeps decimal-phase ids distinct once sanitised for mermaid', () => {
    plan('02-01', { wave: 1, depends_on: '[]' });
    plan('02.1-01', { wave: 2, depends_on: '["02-01"]' });

    const g = graph(run());
    assert.deepEqual([...g.nodes.keys()].sort(), ['p_02_01', 'p_02_1_01']);
    assert.deepEqual(edgePairs(g), ['p_02_01>p_02_1_01']);
  });

  test('reads a CRLF plan the same as an LF one', () => {
    fs.writeFileSync(path.join(dir, '01-01-PLAN.md'), '---\r\nphase: 01\r\nwave: 1\r\ndepends_on: []\r\n---\r\n');
    fs.writeFileSync(path.join(dir, '01-02-PLAN.md'), '---\r\nphase: 01\r\nwave: 2\r\ndepends_on: ["01-01"]\r\n---\r\n');
    const g = graph(run());
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02']);
    assert.deepEqual(g.subgraphs, ['wave 1', 'wave 2']);
  });

  // ── what the colour means: only what is on disk ───────────────────────────

  test('colours a node by what is recorded: SUMMARY, status, or neither', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    summary('01-01');
    plan('01-02', { wave: 1, depends_on: '[]', status: 'in_progress' });
    plan('01-03', { wave: 1, depends_on: '[]', status: 'superseded' });
    plan('01-04', { wave: 1, depends_on: '[]' });
    plan('01-05', { wave: 1, depends_on: '[]', status: 'blocked' });
    plan('01-06', { wave: 1, depends_on: '[]', status: 'done' });

    const g = graph(run());
    const cls = Object.fromEntries([...g.nodes].map(([k, v]) => [k, v.cls]));
    assert.deepEqual(cls, {
      p_01_01: 'done',
      p_01_02: 'running',
      p_01_03: 'superseded',
      p_01_04: 'pending',
      p_01_05: 'blocked',
      // `status: done` without a SUMMARY has not proven anything.
      p_01_06: 'pending',
    });
  });

  test('a status is read the way plan-scan reads it: trimmed and case-folded', () => {
    plan('01-01', { wave: 1, depends_on: '[]', status: '"In_Progress"' });
    assert.equal(graph(run()).nodes.get('p_01_01').cls, 'running');
  });

  test('a SUMMARY wins over a leftover in_progress status', () => {
    // Executing and finishing is the normal path; the status stays behind as a
    // record of the run, not as a sign the plan is still going.
    plan('01-01', { wave: 1, depends_on: '[]', status: 'in_progress' });
    summary('01-01');
    assert.equal(graph(run()).nodes.get('p_01_01').cls, 'done');
  });

  test('planNodeState covers every state from plain data', () => {
    assert.equal(pg.planNodeState({ done: true, status: 'blocked' }), 'done');
    assert.equal(pg.planNodeState({ done: false, status: 'in_progress' }), 'running');
    assert.equal(pg.planNodeState({ done: false, status: 'blocked' }), 'blocked');
    assert.equal(pg.planNodeState({ done: false, status: 'superseded' }), 'superseded');
    assert.equal(pg.planNodeState({ done: false, status: 'done' }), 'pending');
    assert.equal(pg.planNodeState({ done: false, status: null }), 'pending');
    assert.equal(pg.planNodeState({ done: false, status: 'constructor' }), 'pending', 'no prototype lookups');
  });

  // ── defects are drawn, not hidden and not judged ──────────────────────────

  test('draws a dependency on a missing plan as a dashed edge to a marked node', () => {
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });

    const r = run();
    assert.equal(r.strict_failed, false, 'a renderer does not fail on bad news by default');
    const g = graph(r);
    assert.equal(g.nodes.get('p_01_01').cls, 'missing');
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02?']);
    assert.deepEqual(g.red, [0]);
    assert.deepEqual(r.defects, [{ from: '01-01', to: '01-02', defect: 'missing' }]);
    assert.equal(g.defectLines.length, 1);
  });

  test('draws a wave that is not strictly later than its dependency as a red edge', () => {
    plan('01-01', { wave: 2, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });

    const r = run();
    assert.deepEqual(graph(r).red, [0]);
    assert.deepEqual(r.defects, [{ from: '01-01', to: '01-02', defect: 'wave' }]);
  });

  test('a dependency on an EARLIER wave is not a defect (boundary: wave 1 → wave 2)', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    assert.deepEqual(graph(run()).red, []);
  });

  test('a dependency on a LATER wave is a defect too (boundary: wave 3 → wave 2)', () => {
    plan('01-01', { wave: 3, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    assert.deepEqual(run().defects.map((d) => d.defect), ['wave']);
  });

  test('draws a cycle in red, and names it', () => {
    // No waves here on purpose: with waves a cycle always also breaks the wave
    // rule, and the wave message would hide the cycle. Without them, only the
    // cycle is left to find.
    plan('01-01', { depends_on: '["01-02"]' });
    plan('01-02', { depends_on: '["01-01"]' });

    const r = run();
    assert.deepEqual(graph(r).red, [0, 1]);
    assert.deepEqual(r.defects.map((d) => d.defect), ['cycle', 'cycle']);
  });

  test('does not call an acyclic diamond a cycle', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    plan('01-03', { wave: 2, depends_on: '["01-01"]' });
    plan('01-04', { wave: 3, depends_on: '["01-02", "01-03"]' });
    assert.deepEqual(graph(run()).red, []);
  });

  test('puts a plan with no wave into its own group instead of dropping it', () => {
    plan('01-01', { depends_on: '[]' });
    const g = graph(run());
    assert.deepEqual(g.subgraphs, ['wave не задана']);
    assert.ok(g.nodes.has('p_01_01'));
  });

  test('buildPlanGraph is pure and deterministic over the input order', () => {
    const plans = [
      { id: '01-02', file: 'b', wave: 2, status: null, dependsOn: ['01-01'], done: false },
      { id: '01-01', file: 'a', wave: 1, status: null, dependsOn: [], done: true },
      { id: '01-10', file: 'c', wave: 2, status: null, dependsOn: ['01-01'], done: false },
    ];
    const a = pg.renderPlanGraph(pg.buildPlanGraph(plans));
    const b = pg.renderPlanGraph(pg.buildPlanGraph([...plans].reverse()));
    assert.equal(a, b);
    assert.deepEqual(pg.buildPlanGraph(plans).plans.map((p) => p.id), ['01-01', '01-02', '01-10'], 'numeric collation');
  });

  // ── strict, out, and the two kinds of failure ─────────────────────────────

  test('strict fails on a defect and not on a clean graph', () => {
    plan('01-02', { wave: 2, depends_on: '["01-09"]' });
    assert.equal(run({ strict: true }).strict_failed, true);
    assert.equal(run({ strict: false }).strict_failed, false);

    cleanup(dir);
    dir = createTempDir('gsd-plan-graph-');
    plan('01-01', { wave: 1, depends_on: '[]' });
    assert.equal(run({ strict: true }).strict_failed, false);
  });

  test('out writes the document and reports where', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    const target = path.join(dir, 'PLAN-GRAPH.md');

    const r = run({ out: target });
    assert.equal(r.ok, true);
    assert.equal(r.written, target);
    assert.equal(fs.readFileSync(target, 'utf8'), r.markdown);
    assert.deepEqual([...parseGraph(fs.readFileSync(target, 'utf8')).nodes.keys()], ['p_01_01', 'p_01_02']);
    assert.equal(pg.summaryLine(r, 'PLAN-GRAPH.md'), 'OK: 2 plan(s), 1 edge(s), 0 defect(s) → PLAN-GRAPH.md');
  });

  test('a write that fails is a failure to look, not a silent success', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    const r = run({ out: path.join(dir, 'no', 'such', 'dir', 'G.md') });
    assert.deepEqual([r.ok, r.reason], [false, 'write_failed']);
  });

  test('nothing to draw is a failure to look, not an empty graph', () => {
    // Drawing nothing and reporting success would pass a phase whose plans vanished.
    assert.deepEqual([run().ok, run().reason], [false, 'no_plans']);
    const gone = pg.runPlanGraph({ dir: path.join(dir, 'nope'), out: null, strict: false });
    assert.deepEqual([gone.ok, gone.reason], [false, 'not_found']);
  });
});
