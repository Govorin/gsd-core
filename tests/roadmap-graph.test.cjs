'use strict';

/**
 * roadmap-graph.cjs (built from src/roadmap-graph.cts) — ROADMAP.md's phases as
 * a mermaid flowchart (dependencies, status, milestone) plus a gantt of
 * recorded completion dates, and `gsd-tools roadmap graph`.
 *
 * Asserted on typed surfaces: the graph `buildRoadmapGraph` returns, the specs
 * handed to the mermaid builders (`roadmapGraphSpec` / `roadmapGanttSpec`), the
 * command's JSON result. The rendered document is checked only by reading it
 * back into a model (nodes, edges, red edges) and comparing models — never by
 * substring.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const rg = require('../gsd-core/bin/lib/roadmap-graph.cjs');
const { DISK_STATUS } = require('../gsd-core/bin/lib/phase-status.cjs');
const { DEFECT_LINK_STYLE, WARNING_LINK_STYLE, unescapeLabel } = require('../gsd-core/bin/lib/mermaid.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

// ─── Pure-graph fixtures ─────────────────────────────────────────────────────

/** A drawn phase of the current milestone; `over` sets any field. */
function ph(id, over = {}) {
  return {
    key: `m0_${id}`,
    id,
    name: `Phase ${id}`,
    milestone: 'v1.1 Growth',
    milestoneVersion: 'v1.1',
    milestoneClosed: false,
    status: DISK_STATUS.PLANNED,
    checkboxConflict: false,
    dependsRaw: null,
    completed: null,
    ...over,
  };
}

function build(phases, known = [], unreadable = []) {
  return rg.buildRoadmapGraph({ phases, known, unreadable });
}

/** `from->to:defect` per edge, in edge order. */
function edgeList(graph) {
  return graph.edges.map((e) => `${e.from}->${e.to}:${e.defect ?? '-'}`);
}

function defectTypes(graph) {
  return graph.defects.map((d) => `${d.type}@${d.phase}`);
}

describe('buildRoadmapGraph — edges from Depends on', () => {
  test('a single reference is one edge from the dependency to the phase', () => {
    const g = build([ph('1'), ph('2', { dependsRaw: 'Phase 1' })]);
    assert.deepEqual(edgeList(g), ['m0_1->m0_2:-']);
    assert.deepEqual(g.defects, []);
  });

  test('"Phases 1 and 2" is two edges; a range gives only its endpoints', () => {
    const g = build([
      ph('1'), ph('2'), ph('3'), ph('4', { dependsRaw: 'Phases 1 and 2' }), ph('5', { dependsRaw: 'Phase 1-3' }),
    ]);
    assert.deepEqual(edgeList(g), ['m0_1->m0_4:-', 'm0_2->m0_4:-', 'm0_1->m0_5:-', 'm0_3->m0_5:-']);
  });

  test('a decimal phase is referenced by its decimal id, and padding does not matter', () => {
    const g = build([ph('02'), ph('02.1', { dependsRaw: 'Phase 2' }), ph('03', { dependsRaw: 'Phase 02.1' })]);
    assert.deepEqual(edgeList(g), ['m0_02->m0_02.1:-', 'm0_02.1->m0_03:-']);
  });

  test('a date, a sha or a ledger id in the prose is not a reference', () => {
    const g = build([ph('1'), ph('2', { dependsRaw: 'Phase 1, reviewed 2026-09-14 at 8bf403100d (WINDOWS #1843)' })]);
    assert.deepEqual(edgeList(g), ['m0_1->m0_2:-']);
  });

  test('"Nothing (first phase)" / "None" / a dash declare no dependency and no defect', () => {
    const g = build([
      ph('1', { dependsRaw: 'Nothing (first phase)' }), ph('2', { dependsRaw: 'None' }), ph('3', { dependsRaw: '-' }),
    ]);
    assert.deepEqual(g.edges, []);
    assert.deepEqual(g.defects, []);
  });

  test('a reference resolves within the phase\'s own milestone first (numbering may restart)', () => {
    const other = { milestone: 'v1.0 MVP', milestoneVersion: 'v1.0', milestoneClosed: true };
    const g = build([ph('1', { key: 'm1_1', ...other }), ph('1'), ph('2', { dependsRaw: 'Phase 1' })]);
    assert.deepEqual(edgeList(g), ['m0_1->m0_2:-']);
  });
});

describe('buildRoadmapGraph — defects are drawn, not dropped', () => {
  test('a reference to a phase that exists nowhere is a missing edge and a missing node', () => {
    const g = build([ph('1'), ph('2', { dependsRaw: 'Phases 1 and 9' })]);
    assert.deepEqual(edgeList(g), ['m0_1->m0_2:-', 'missing:09->m0_2:missing']);
    assert.deepEqual(g.missing, ['9']);
    assert.deepEqual(defectTypes(g), ['missing@2']);
    assert.equal(g.defects[0].severity, 'error');
  });

  test('a reference to another milestone\'s phase or a bare phase directory is outside, not missing', () => {
    const g = build(
      [ph('3', { dependsRaw: 'Phase 2' }), ph('4', { dependsRaw: 'Phase 7' })],
      [{ id: '2', name: 'API', milestone: 'v1.0 MVP' }, { id: '07', name: null, milestone: null }],
    );
    assert.deepEqual(edgeList(g), ['outside:02->m0_3:-', 'outside:07->m0_4:-']);
    assert.deepEqual(g.missing, []);
    assert.deepEqual(g.outside.map((o) => o.id), ['2', '07']);
    assert.deepEqual(g.defects, []);
  });

  test('every edge of a cycle is a cycle defect', () => {
    const g = build([ph('5', { dependsRaw: 'Phase 6' }), ph('6', { dependsRaw: 'Phase 5' })]);
    assert.deepEqual(edgeList(g), ['m0_6->m0_5:cycle', 'm0_5->m0_6:cycle']);
  });

  test('a phase that depends on itself is a cycle of length one', () => {
    const g = build([ph('3', { dependsRaw: 'Phase 3' })]);
    assert.deepEqual(edgeList(g), ['m0_3->m0_3:cycle']);
    assert.doesNotThrow(() => rg.roadmapGraphDiagram(g));
  });

  test('a complete phase whose dependency is not complete is done-before-dep', () => {
    const g = build([ph('1', { status: DISK_STATUS.PARTIAL }), ph('2', { status: DISK_STATUS.COMPLETE, dependsRaw: 'Phase 1' })]);
    assert.deepEqual(edgeList(g), ['m0_1->m0_2:done-before-dep']);
    assert.equal(g.defects[0].severity, 'error');
  });

  test('a dependency on a later-numbered phase is a forward warning, which strict does not count', () => {
    const g = build([ph('3', { dependsRaw: 'Phase 4' }), ph('4')]);
    assert.deepEqual(edgeList(g), ['m0_4->m0_3:forward']);
    assert.equal(g.defects[0].severity, 'warning');
  });

  test('a Depends on that names no phase is unparsed, with its raw text', () => {
    const g = build([ph('7', { dependsRaw: 'the billing work' })]);
    assert.deepEqual(g.edges, []);
    assert.deepEqual(g.unparsed, [{ phase: 'm0_7', raw: 'the billing work' }]);
    assert.deepEqual(defectTypes(g), ['unparsed@7']);
  });

  test('a checkbox that disagrees with disk is a defect and a conflict-class node', () => {
    const g = build([ph('2', { checkboxConflict: true })]);
    assert.deepEqual(defectTypes(g), ['checkbox_conflict@2']);
    const spec = rg.roadmapGraphSpec(g);
    assert.equal(spec.nodes[0].className, 'conflict');
  });

  test('an unreadable field is reported, never read as "no dependency"', () => {
    const g = build([ph('1')], [], [{ phase: '1', field: 'Depends on', reason: 'no frontmatter terminator' }]);
    assert.deepEqual(defectTypes(g), ['unreadable@1']);
  });
});

describe('roadmapNodeState', () => {
  test('every DISK_STATUS value has a colour', () => {
    const states = Object.values(DISK_STATUS).map((status) => rg.roadmapNodeState({ status, milestoneClosed: false }));
    assert.deepEqual(states, ['done', 'running', 'running', 'pending', 'pending', 'pending', 'empty', 'empty']);
  });

  test('a closed milestone\'s phase without a directory is archived, with one it keeps its disk colour', () => {
    assert.equal(rg.roadmapNodeState({ status: DISK_STATUS.NO_DIRECTORY, milestoneClosed: true }), 'archived');
    assert.equal(rg.roadmapNodeState({ status: DISK_STATUS.COMPLETE, milestoneClosed: true }), 'done');
  });

  test('a status outside the vocabulary throws instead of colouring nothing', () => {
    assert.throws(() => rg.roadmapNodeState({ status: 'shipped', milestoneClosed: false }), /not a DISK_STATUS/);
  });
});

describe('roadmapGraphSpec — what the flowchart builder is handed', () => {
  test('a subgraph per milestone holds its phases; outside and missing nodes sit outside any', () => {
    const other = { key: 'm1_1', milestone: 'v1.0 MVP', milestoneVersion: 'v1.0', milestoneClosed: true };
    const g = build(
      [ph('1', other), ph('3', { dependsRaw: 'Phases 1, 2 and 9' })],
      [{ id: '2', name: 'API', milestone: 'v0.9' }],
    );
    const spec = rg.roadmapGraphSpec(g);
    assert.deepEqual(spec.subgraphs.map((s) => [s.title, s.nodes.length]), [['v1.0 MVP', 1], ['v1.1 Growth', 1]]);
    const classes = spec.nodes.map((n) => n.className);
    assert.deepEqual(classes, ['pending', 'pending', 'outside', 'missing']);
  });

  test('a defect edge is red, a missing edge is also dotted, a forward edge is amber', () => {
    const g = build([ph('2', { dependsRaw: 'Phases 3 and 9' }), ph('3'), ph('4', { dependsRaw: 'Phase 2' })]);
    const spec = rg.roadmapGraphSpec(g);
    assert.deepEqual(
      spec.edges.map((e) => [e.line, e.linkStyle ?? null]),
      [['solid', WARNING_LINK_STYLE], ['dotted', DEFECT_LINK_STYLE], ['solid', null]],
    );
  });

  test('an unparsed note hangs off its phase on an arrowless dotted line', () => {
    const spec = rg.roadmapGraphSpec(build([ph('7', { dependsRaw: 'later' })]));
    assert.deepEqual(spec.nodes.map((n) => n.className), ['pending', 'unparsed']);
    assert.deepEqual(spec.edges, [{ from: spec.nodes[0].id, to: spec.nodes[1].id, line: 'dotted', arrow: false }]);
    assert.deepEqual(spec.subgraphs[0].nodes, [spec.nodes[0].id, spec.nodes[1].id]);
  });

  test('property: one missing node per missing reference, and every edge end is declared', () => {
    const ids = ['1', '2', '3', '4', '5'];
    const phaseArb = fc.uniqueArray(fc.constantFrom(...ids), { minLength: 1, maxLength: 5 }).chain((present) =>
      fc.tuple(
        fc.constant(present),
        fc.array(fc.array(fc.constantFrom(...ids, '8', '9'), { maxLength: 3 }), { minLength: present.length, maxLength: present.length }),
      ),
    );
    fc.assert(
      fc.property(phaseArb, ([present, deps]) => {
        const phases = present.map((id, i) => ph(id, { dependsRaw: deps[i].length ? `Phases ${deps[i].join(' and ')}` : null }));
        const g = build(phases);
        const spec = rg.roadmapGraphSpec(g);
        const missingNodes = spec.nodes.filter((n) => n.className === 'missing').length;
        assert.equal(missingNodes, g.missing.length);
        // flowchart() throws on an edge to an undeclared node — so this IS the "both ends declared" check.
        rg.roadmapGraphDiagram(g);
      }),
      { numRuns: 200 },
    );
  });
});

describe('gantt — only recorded completion dates, as points', () => {
  test('no dated phase → no gantt at all', () => {
    const g = build([ph('1'), ph('2', { completed: '-' })]);
    assert.equal(rg.roadmapGanttSpec(g), null);
    assert.equal(rg.roadmapGantt(g), null);
  });

  test('a dated phase is a one-day milestone point on its completion day; undated phases are left out', () => {
    const g = build([ph('1', { completed: '2026-01-05' }), ph('2', { completed: '' }), ph('3', { completed: '2026-01-10' })]);
    const spec = rg.roadmapGanttSpec(g);
    assert.deepEqual(spec.sections.map((s) => s.name), ['v1.1 Growth']);
    assert.deepEqual(
      spec.sections[0].tasks.map((t) => [t.label, t.start, t.duration, t.tags, t.after]),
      [['1. Phase 1', '2026-01-05', '1d', ['milestone'], undefined], ['3. Phase 3', '2026-01-10', '1d', ['milestone'], undefined]],
    );
  });

  test('a date that is not a real YYYY-MM-DD day is a bad-date defect and stays off the gantt', () => {
    const g = build([ph('1', { completed: '2026-02-30' }), ph('2', { completed: 'last week' }), ph('3', { completed: '2026-02-28' })]);
    assert.deepEqual(defectTypes(g), ['bad-date@1', 'bad-date@2']);
    assert.deepEqual(rg.roadmapGanttSpec(g).sections[0].tasks.map((t) => t.start), ['2026-02-28']);
  });

  test('isCalendarDate at the month and leap-year boundaries', () => {
    assert.equal(rg.isCalendarDate('2026-02-28'), true);
    assert.equal(rg.isCalendarDate('2026-02-29'), false);
    assert.equal(rg.isCalendarDate('2028-02-29'), true);
    assert.equal(rg.isCalendarDate('2026-12-31'), true);
    assert.equal(rg.isCalendarDate('2026-13-01'), false);
    assert.equal(rg.isCalendarDate('2026-1-05'), false);
  });
});

// ─── Reading the rendered document back ──────────────────────────────────────

const FENCE = '`'.repeat(3);

/** The body of every ```mermaid fence, in order. */
function mermaidBlocks(markdown) {
  const blocks = [];
  let cur = null;
  for (const line of splitLines(markdown)) {
    if (cur === null && line.trim() === `${FENCE}mermaid`) cur = [];
    else if (cur !== null && line.trim() === FENCE) {
      blocks.push(cur);
      cur = null;
    } else if (cur !== null) cur.push(line);
  }
  return blocks;
}

/** The flowchart's nodes (id → { label, cls }) and edges, read back from its text. */
function readFlowchart(lines) {
  const nodes = new Map();
  const edges = [];
  const red = [];
  for (const line of lines) {
    let m;
    if ((m = line.match(/^\s+(\w+)\["(.*)"\]:::(\w+)$/))) nodes.set(m[1], { label: unescapeLabel(m[2]), cls: m[3] });
    else if ((m = line.match(/^\s+(\w+) (-->|-\.->|-\.-) (\w+)$/))) edges.push({ from: m[1], to: m[3] });
    else if ((m = line.match(/^\s+linkStyle (\d+) (.*)$/))) red.push([Number(m[1]), m[2]]);
  }
  return { nodes, edges, red };
}

describe('renderRoadmapGraph — the document reads back into the same graph', () => {
  test('nodes, edges and defect strokes survive serialization', () => {
    const g = build([ph('1', { completed: '2026-01-05' }), ph('2', { dependsRaw: 'Phases 1 and 9' }), ph('3', { dependsRaw: 'soon' })]);
    const spec = rg.roadmapGraphSpec(g);
    const md = rg.renderRoadmapGraph(g);
    const blocks = mermaidBlocks(md);
    assert.equal(blocks.length, 2, 'flowchart + gantt');
    const back = readFlowchart(blocks[0]);
    assert.deepEqual([...back.nodes.keys()], spec.nodes.map((n) => n.id));
    assert.deepEqual([...back.nodes.values()].map((n) => n.label), spec.nodes.map((n) => n.label));
    assert.deepEqual(back.edges, spec.edges.map((e) => ({ from: e.from, to: e.to })));
    assert.deepEqual(back.red, spec.edges.flatMap((e, i) => (e.linkStyle ? [[i, e.linkStyle]] : [])));
  });

  test('without a date or with gantt off, the document has the flowchart only', () => {
    const dated = build([ph('1', { completed: '2026-01-05' })]);
    assert.equal(mermaidBlocks(rg.renderRoadmapGraph(dated, { gantt: false })).length, 1);
    assert.equal(mermaidBlocks(rg.renderRoadmapGraph(build([ph('1')]))).length, 1);
  });
});

// ─── The command, on a real project ──────────────────────────────────────────

const ROADMAP = `# Roadmap

## Phases

<details>
<summary>✅ v1.0 MVP (Phases 1-2) — SHIPPED 2026-01-10</summary>

### Phase 1: Foundation
**Goal:** base
**Depends on:** Nothing (first phase)

### Phase 2: API
**Goal:** api
**Depends on:** Phase 1

</details>

### 🚧 v1.1 Growth (In Progress)

#### Phase 3: Billing
**Goal:** pay
**Depends on:** Phase 2

#### Phase 4: Reports
**Goal:** rep
**Depends on:** Phases 3 and 9

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 1/1 | Complete | 2026-01-05 |
| 2. API | v1.0 | 1/1 | Complete | 2026-01-10 |
| 3. Billing | v1.1 | 0/1 | Not started | - |
| 4. Reports | v1.1 | 0/1 | Not started | - |
`;

const STATE = `---
milestone: v1.1
milestone_name: Growth
---
# State
`;

describe('runRoadmapGraph', () => {
  let dir;
  beforeEach(() => {
    dir = createTempProject();
  });
  afterEach(() => cleanup(dir));

  const write = (roadmap) => {
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), STATE);
  };
  const run = (over = {}) => rg.runRoadmapGraph({ cwd: dir, out: null, strict: false, scope: 'current', gantt: true, ...over });

  test('no ROADMAP.md is a failure to look, not an empty graph', () => {
    const r = run();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_found');
  });

  test('a ROADMAP with no phases is no_phases', () => {
    write('# Roadmap\n\nNothing planned yet.\n');
    const r = run();
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_phases');
  });

  test('one phase, no dependencies: one node, no edges, no defects', () => {
    write('# Roadmap\n\n### Phase 1: Solo\n**Goal:** g\n**Depends on:** Nothing\n');
    const r = run();
    assert.equal(r.ok, true);
    assert.deepEqual([r.phase_count, r.edge_count, r.defect_count, r.strict_failed], [1, 0, 0, false]);
  });

  test('current scope: the current milestone is drawn, a closed milestone\'s phase is an outside node', () => {
    write(ROADMAP);
    const r = run();
    assert.equal(r.ok, true);
    assert.equal(r.phase_count, 2);
    assert.deepEqual(r.defects.map((d) => `${d.type}@${d.phase}:${d.ref}`), ['missing@4:9']);
    assert.equal(r.gantt, false, 'no current phase has a completion date');
    const back = readFlowchart(mermaidBlocks(r.markdown)[0]);
    assert.deepEqual([...back.nodes.values()].map((n) => n.cls), ['empty', 'empty', 'outside', 'missing']);
  });

  test('--all draws every milestone and its dates; the closed milestone\'s archived phases read as archived', () => {
    write(ROADMAP);
    const r = run({ scope: 'all' });
    assert.equal(r.phase_count, 4);
    assert.equal(r.gantt, true);
    const [flow, chart] = mermaidBlocks(r.markdown);
    const back = readFlowchart(flow);
    assert.deepEqual([...back.nodes.values()].map((n) => n.cls), ['empty', 'empty', 'archived', 'archived', 'missing']);
    assert.ok(chart !== undefined);
  });

  test('--strict with a missing reference fails; a warning alone does not', () => {
    write(ROADMAP);
    assert.equal(run({ strict: true }).strict_failed, true);
    write('# Roadmap\n\n### Phase 1: A\n**Depends on:** Phase 2\n\n### Phase 2: B\n**Depends on:** Nothing\n');
    const r = run({ strict: true });
    assert.deepEqual([r.defect_count, r.error_count, r.strict_failed], [1, 0, false]);
  });

  test('--out writes the same document it returns', () => {
    write(ROADMAP);
    const out = path.join(dir, '.planning', 'diagrams', 'roadmap.md');
    const r = run({ out });
    assert.equal(r.written, out);
    assert.equal(fs.readFileSync(out, 'utf8'), r.markdown);
  });
});

describe('gsd-tools roadmap graph', () => {
  let dir;
  beforeEach(() => {
    dir = createTempProject();
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), ROADMAP);
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), STATE);
  });
  afterEach(() => cleanup(dir));

  test('prints the JSON result, reachable as roadmap graph and as query roadmap.graph', () => {
    const direct = runGsdTools(['roadmap', 'graph'], dir);
    assert.ok(direct.success, direct.error);
    const dotted = runGsdTools(['query', 'roadmap.graph'], dir);
    assert.ok(dotted.success, dotted.error);
    assert.deepEqual(JSON.parse(dotted.output), JSON.parse(direct.output));
    assert.equal(JSON.parse(direct.output).defect_count, 1);
  });

  test('--strict prints the result and then fails', () => {
    const r = runGsdTools(['roadmap', 'graph', '--strict'], dir);
    assert.equal(r.success, false);
    assert.equal(JSON.parse(r.output).strict_failed, true);
  });

  test('--out outside the project and an unknown flag are usage errors', () => {
    assert.equal(runGsdTools(['roadmap', 'graph', '--out', '../x.md'], dir).success, false);
    assert.equal(runGsdTools(['roadmap', 'graph', '--bogus'], dir).success, false);
    assert.equal(runGsdTools(['roadmap', 'graph', '--out'], dir).success, false);
    assert.equal(fs.existsSync(path.join(dir, '..', 'x.md')), false);
  });
});
