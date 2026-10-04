'use strict';

/**
 * loop-hooks-map.cjs (built from src/loop-hooks-map.cts) — capability × loop
 * point, the data behind docs/reference/loop-hooks-map.md (phase 5.6).
 *
 * Synthetic contract + registry + declarations, asserted on typed surfaces:
 * the map `buildLoopHooksMap` returns (points, dropped, defects) and the specs
 * handed to the flowchart builder (`overviewSpec`, `artifactFlowSpec`). The
 * rendered document is read back into a model only to prove nothing is lost in
 * serialization.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const lhm = require('../gsd-core/bin/lib/loop-hooks-map.cjs');
const { DEFECT_LINK_STYLE, flowchart } = require('../gsd-core/bin/lib/mermaid.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

/** Two steps, four points: `a` makes A.md, `b` consumes it and makes B.md. */
const CONTRACT = Object.freeze([
  { step: 'a', points: ['a:pre', 'a:post'], agentRoles: ['orchestrator'], coreArtifacts: { produces: ['A.md'], consumes: [] } },
  { step: 'b', points: ['b:pre', 'b:post'], agentRoles: ['planner'], coreArtifacts: { produces: ['B.md'], consumes: ['A.md'] } },
]);
const POINTS = ['a:pre', 'a:post', 'b:pre', 'b:post'];
const ALL_KINDS = ['step', 'gate', 'contribution'];

function emptyPoints() {
  return Object.fromEntries(POINTS.map((p) => [p, { steps: [], gates: [], contributions: [] }]));
}

/**
 * A consistent input: each registered hook is also declared by its capability,
 * every point has a host covering every kind, every ref and `when` exists.
 * `over` replaces any field.
 */
function input(byLoopPoint, over = {}) {
  const declared = new Map();
  for (const [point, lists] of Object.entries(byLoopPoint)) {
    for (const [list, entries] of Object.entries(lists)) {
      for (const h of entries) {
        if (!declared.has(h.capId)) declared.set(h.capId, { capId: h.capId, role: 'feature', steps: [], gates: [], contributions: [] });
        declared.get(h.capId)[list].push({ ...h, point });
      }
    }
  }
  return {
    contract: CONTRACT,
    byLoopPoint,
    declared: [...declared.values()],
    configKeys: ['workflow.x'],
    agents: ['gsd-planner'],
    skills: ['do-thing'],
    hosts: POINTS.map((point) => ({ file: `workflows/${point.split(':')[0]}.md`, point, kinds: [...ALL_KINDS] })),
    ...over,
  };
}

const step = (capId, extra = {}) => ({ capId, ref: { skill: 'do-thing' }, produces: [], consumes: [], ...extra });
const gate = (capId, blocking, extra = {}) => ({ capId, check: { query: `${capId}.check` }, blocking, ...extra });
const contrib = (capId, into, extra = {}) => ({ capId, into, fragment: { path: `fragments/${capId}.md` }, produces: [], consumes: [], ...extra });

const types = (map) => map.defects.map((d) => `${d.type}@${d.point}${d.capId ? `:${d.capId}` : ''}${d.subject ? `:${d.subject}` : ''}`);

describe('buildLoopHooksMap — the registry, point by point', () => {
  test('points come in contract order; hooks keep the registry\'s order', () => {
    const bl = emptyPoints();
    bl['b:pre'].steps.push(step('second'), step('first'));
    const map = lhm.buildLoopHooksMap(input(bl));
    assert.deepEqual(map.points.map((p) => [p.point, p.step]), [['a:pre', 'a'], ['a:post', 'a'], ['b:pre', 'b'], ['b:post', 'b']]);
    assert.deepEqual(map.points[2].steps.map((h) => h.capId), ['second', 'first']);
    assert.deepEqual(map.defects, []);
  });

  test('a consistent registry has no defects and nothing dropped', () => {
    const bl = emptyPoints();
    bl['a:pre'].contributions.push(contrib('c1', 'orchestrator'));
    bl['b:pre'].gates.push(gate('g1', true, { when: 'workflow.x' }));
    bl['b:post'].steps.push(step('s1', { ref: { agent: 'gsd-planner' }, consumes: ['A.md'], produces: ['C.md'] }));
    const map = lhm.buildLoopHooksMap(input(bl));
    assert.deepEqual(map.defects, []);
    assert.deepEqual(map.dropped, []);
  });
});

describe('buildLoopHooksMap — every defect is reported', () => {
  test('dropped-hook: a declared hook on a point outside the contract never reached the registry', () => {
    const inp = input(emptyPoints());
    inp.declared.push({ capId: 'lost', role: 'feature', steps: [{ point: 'a:during', ref: { skill: 'do-thing' } }] });
    const map = lhm.buildLoopHooksMap(inp);
    assert.deepEqual(map.dropped.map((d) => [d.capId, d.kind, d.point]), [['lost', 'step', 'a:during']]);
    assert.match(map.dropped[0].reason, /not a loop point/);
    assert.deepEqual(types(map), ['dropped-hook@a:during:lost']);
  });

  test('dropped-hook: a non-feature capability\'s hooks are not registered', () => {
    const inp = input(emptyPoints());
    inp.declared.push({ capId: 'rt', role: 'runtime', gates: [{ point: 'b:pre', check: { query: 'q' } }] });
    const map = lhm.buildLoopHooksMap(inp);
    assert.match(map.dropped[0].reason, /runtime/);
  });

  test('undeclared-hook: the registry has a hook its capability.json no longer declares', () => {
    const bl = emptyPoints();
    bl['a:post'].steps.push(step('ghost'));
    const map = lhm.buildLoopHooksMap(input(bl, { declared: [] }));
    assert.deepEqual(types(map), ['undeclared-hook@a:post:ghost']);
  });

  test('unknown-ref: a step whose agent or skill does not exist', () => {
    const bl = emptyPoints();
    bl['a:pre'].steps.push(step('s1', { ref: { agent: 'gsd-nobody' } }), step('s2', { ref: { skill: 'no-skill' } }), step('s3', { ref: { command: 'intel x' } }));
    const map = lhm.buildLoopHooksMap(input(bl));
    assert.deepEqual(types(map), ['unknown-ref@a:pre:s1:agent:gsd-nobody', 'unknown-ref@a:pre:s2:skill:no-skill']);
    assert.deepEqual(map.points[0].steps.map((h) => h.defects), [['unknown-ref'], ['unknown-ref'], []]);
  });

  test('unknown-when-key: a hook gated on a key no configSchema declares', () => {
    const bl = emptyPoints();
    bl['b:pre'].gates.push(gate('g', false, { when: 'workflow.nope' }));
    assert.deepEqual(types(lhm.buildLoopHooksMap(input(bl))), ['unknown-when-key@b:pre:g:workflow.nope']);
  });

  test('unsatisfied-consume: at the boundary of availability', () => {
    const bl = emptyPoints();
    // A.md is core to step a, available from a:post (its last point) — not at a:pre.
    bl['a:pre'].steps.push(step('early', { consumes: ['A.md'] }));
    bl['a:post'].steps.push(step('ontime', { consumes: ['A.md'] }));
    // X.md is produced by a hook at b:pre: fine at b:pre (same point) and b:post, never before.
    bl['a:post'].steps.push(step('before', { consumes: ['X.md'] }));
    bl['b:pre'].steps.push(step('maker', { produces: ['X.md'] }), step('same', { consumes: ['X.md'] }));
    bl['b:post'].steps.push(step('later', { consumes: ['X.md', 'Z.md'] }));
    const map = lhm.buildLoopHooksMap(input(bl));
    assert.deepEqual(types(map), [
      'unsatisfied-consume@a:pre:early:A.md',
      'unsatisfied-consume@a:post:before:X.md',
      'unsatisfied-consume@b:post:later:Z.md',
    ]);
  });

  test('unhosted-point: hooks at a point no workflow renders', () => {
    const bl = emptyPoints();
    bl['b:post'].steps.push(step('s'));
    const inp = input(bl);
    inp.hosts = inp.hosts.filter((h) => h.point !== 'b:post');
    assert.deepEqual(types(lhm.buildLoopHooksMap(inp)), ['unhosted-point@b:post']);
  });

  test('an unhosted point WITHOUT hooks is not a defect', () => {
    const inp = input(emptyPoints());
    inp.hosts = [];
    assert.deepEqual(lhm.buildLoopHooksMap(inp).defects, []);
  });

  test('undispatched-kind: a host renders the point but its dispatch text skips a kind present there', () => {
    const bl = emptyPoints();
    bl['b:pre'].gates.push(gate('g', true));
    bl['b:pre'].steps.push(step('s'));
    const inp = input(bl);
    inp.hosts = inp.hosts.map((h) => (h.point === 'b:pre' ? { ...h, kinds: ['step'] } : h));
    const map = lhm.buildLoopHooksMap(inp);
    assert.deepEqual(map.defects.map((d) => `${d.type}@${d.point}:${d.kind}`), ['undispatched-kind@b:pre:gate']);
  });
});

describe('overviewSpec — what the flowchart builder is handed', () => {
  const bl = emptyPoints();
  bl['a:pre'].contributions.push(contrib('c1', 'orchestrator'));
  bl['b:pre'].gates.push(gate('hard', true), gate('soft', false));
  bl['b:post'].steps.push(step('s1'));
  const map = lhm.buildLoopHooksMap(input(bl));
  const spec = lhm.overviewSpec(map, CONTRACT);
  const byLabel = new Map(spec.nodes.map((n) => [n.label, n]));
  const idOf = (label) => byLabel.get(label).id;

  test('a subgraph per step: its points around its core node, in order', () => {
    assert.deepEqual(spec.subgraphs.map((s) => s.title), ['a', 'b']);
    const a = spec.subgraphs[0].nodes.map((id) => spec.nodes.find((n) => n.id === id).label);
    assert.deepEqual(a.slice(0, 3), ['a:pre', 'a: orchestrator → A.md', 'a:post']);
  });

  test('a blocking gate is a red diamond on a thick edge, a non-blocking one an ordinary diamond', () => {
    const hard = byLabel.get('hard: check hard.check');
    const soft = byLabel.get('soft: check soft.check');
    assert.deepEqual([hard.shape, hard.className, soft.shape, soft.className], ['rhombus', 'crit', 'rhombus', 'gate']);
    const edgeTo = (id) => spec.edges.find((e) => e.to === id);
    assert.equal(edgeTo(hard.id).line, 'thick');
    assert.equal(edgeTo(soft.id).line, 'solid');
  });

  test('a contribution points INTO its point on a dotted edge labelled with the target role', () => {
    const c = idOf('c1: into orchestrator · fragments/c1.md');
    const e = spec.edges.find((x) => x.from === c);
    assert.deepEqual([e.to, e.line, e.label], [idOf('a:pre'), 'dotted', 'orchestrator']);
  });

  test('steps are chained in pipeline order: the last point of a feeds the first point of b', () => {
    assert.ok(spec.edges.some((e) => e.from === idOf('a:post') && e.to === idOf('b:pre') && e.line === 'thick'));
  });

  test('dropped hooks get their own subgraph of missing nodes', () => {
    const inp = input(emptyPoints());
    inp.declared.push({ capId: 'lost', role: 'feature', steps: [{ point: 'zz', ref: { skill: 'do-thing' } }] });
    const s = lhm.overviewSpec(lhm.buildLoopHooksMap(inp), CONTRACT);
    const last = s.subgraphs[s.subgraphs.length - 1];
    assert.equal(last.title, 'declared, not registered');
    assert.deepEqual(last.nodes.map((id) => s.nodes.find((n) => n.id === id).className), ['missing']);
  });

  test('property: hook nodes per point = steps + gates + contributions, and no node without a hook behind it', () => {
    const hookArb = fc.record({
      point: fc.constantFrom(...POINTS),
      kind: fc.constantFrom(...ALL_KINDS),
      capId: fc.constantFrom('alpha', 'beta', 'gamma'),
      blocking: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(hookArb, { maxLength: 20 }), (hooks) => {
        const reg = emptyPoints();
        for (const h of hooks) {
          if (h.kind === 'step') reg[h.point].steps.push(step(h.capId));
          else if (h.kind === 'gate') reg[h.point].gates.push(gate(h.capId, h.blocking));
          else reg[h.point].contributions.push(contrib(h.capId, 'planner'));
        }
        const m = lhm.buildLoopHooksMap(input(reg));
        const s = lhm.overviewSpec(m, CONTRACT);
        const hookClasses = new Set(['step', 'gate', 'crit', 'contribution', 'missing', 'conflict']);
        const hookNodes = s.nodes.filter((n) => hookClasses.has(n.className));
        assert.equal(hookNodes.length, hooks.length + m.dropped.length);
        // flowchart() throws on an edge to an undeclared node.
        flowchart(s);
      }),
      { numRuns: 150 },
    );
  });
});

describe('artifactFlowSpec — producer → artifact → consumer', () => {
  test('null at a point where no hook produces or consumes anything', () => {
    const bl = emptyPoints();
    bl['a:pre'].gates.push(gate('g', false));
    assert.equal(lhm.artifactFlowSpec(lhm.buildLoopHooksMap(input(bl)), 'a:pre', CONTRACT), null);
  });

  test('a core artifact names its step, a produced one is plain, an unproduced one is missing on a red edge', () => {
    const bl = emptyPoints();
    bl['b:pre'].steps.push(step('maker', { consumes: ['A.md'], produces: ['X.md'] }), step('user', { consumes: ['X.md', 'Z.md'] }));
    const spec = lhm.artifactFlowSpec(lhm.buildLoopHooksMap(input(bl)), 'b:pre', CONTRACT);
    const artifacts = spec.nodes.filter((n) => n.shape === 'cylinder').map((n) => [n.label, n.className]);
    assert.deepEqual(artifacts, [['A.md (from a core)', 'artifact'], ['X.md', 'artifact'], ['Z.md — produced by nothing', 'missing']]);
    const zId = spec.nodes.find((n) => n.label.startsWith('Z.md')).id;
    assert.deepEqual(spec.edges.filter((e) => e.from === zId).map((e) => e.linkStyle), [DEFECT_LINK_STYLE]);
  });
});

describe('renderLoopHooksMap', () => {
  const FENCE = '`'.repeat(3);
  const blocks = (md) => {
    const out = [];
    let cur = null;
    for (const line of splitLines(md)) {
      if (cur === null && line.trim() === `${FENCE}mermaid`) cur = [];
      else if (cur !== null && line.trim() === FENCE) {
        out.push(cur);
        cur = null;
      } else if (cur !== null) cur.push(line);
    }
    return out;
  };

  test('the overview reads back with every node and edge of its spec', () => {
    const bl = emptyPoints();
    bl['b:pre'].gates.push(gate('g', true));
    bl['b:post'].steps.push(step('s', { consumes: ['A.md'] }));
    const map = lhm.buildLoopHooksMap(input(bl));
    const spec = lhm.overviewSpec(map, CONTRACT);
    const [overview, ...flows] = blocks(lhm.renderLoopHooksMap(map, CONTRACT, 'scripts/gen-loop-hooks-map.cjs'));
    const nodeIds = overview.map((l) => l.match(/^\s+(\w+)(?:\[|\(|\{)/)).filter(Boolean).map((m) => m[1]);
    const edges = overview.map((l) => l.match(/^\s+(\w+) (?:-->|==>|-\.->)(?:\|"[^"]*"\|)? (\w+)$/)).filter(Boolean).map((m) => [m[1], m[2]]);
    assert.deepEqual(nodeIds.filter((id) => !spec.subgraphs.some((s) => s.id === id)).sort(), spec.nodes.map((n) => n.id).sort());
    assert.deepEqual(edges, spec.edges.map((e) => [e.from, e.to]));
    assert.equal(flows.length, 1, 'one artifact-flow diagram: only b:post produces or consumes');
  });

  test('the table has one row per hook and escapes a pipe in a query', () => {
    const bl = emptyPoints();
    bl['a:pre'].gates.push(gate('g', false, { check: { query: 'a|b' } }));
    bl['b:post'].steps.push(step('s'));
    const rows = lhm.hooksTable(lhm.buildLoopHooksMap(input(bl)));
    assert.equal(rows.length, 2 + 2);
    // A cell's pipe is escaped, so the row still splits into the header's 7 cells.
    const cells = rows[2].split(/(?<!\\)\|/).slice(1, -1);
    assert.equal(cells.length, 7);
  });
});
