'use strict';

/**
 * workflow-map.cjs (built from src/workflow-map.cts) — the logic of a workflow
 * as data (units, spawns, loop points, jumps, includes, defects) and the
 * flowchart specs built from it (phase 5.5).
 *
 * Every case is a string fixture with an injected context — no filesystem.
 * Assertions read the typed model (`parseWorkflow`) and the specs handed to
 * the mermaid builders with their node metadata (`workflowMapDiagrams`);
 * rendered mermaid text is never substring-matched.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const wm = require('../gsd-core/bin/lib/workflow-map.cjs');
const m = require('../gsd-core/bin/lib/mermaid.cjs');

const FENCE = '`'.repeat(3);
const TICK = '`';

/** A context with a small agent roster; `files` backs `readFile`. */
function ctx(over = {}) {
  const files = over.files ?? {};
  return {
    agents: new Set(['gsd-planner', 'gsd-executor', 'gsd-plan-checker']),
    capabilityAgents: new Set(['gsd-system-architect']),
    loopPoints: new Set(['plan:pre', 'plan:post', 'execute:post']),
    loopHooks: {
      'plan:pre': {
        steps: [
          { capId: 'architecture', ref: { agent: 'gsd-system-architect' } },
          { capId: 'ui', ref: { skill: 'ui-phase' } },
        ],
        gates: 2,
        contributions: 1,
      },
    },
    manifest: over.manifest ?? [],
    readFile: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
    ...over,
  };
}

function parse(text, over = {}) {
  return wm.parseWorkflow({ name: 'demo', path: 'gsd-core/workflows/demo.md', text }, ctx(over));
}

const kinds = (map) => map.defects.map((d) => d.kind);
const agentCall = (agent) => [`${FENCE}`, 'Agent(', '  prompt=p,', `  subagent_type="${agent}",`, ')', FENCE].join('\n');

describe('units', () => {
  test('steps are the units, in document order, with their attributes', () => {
    const map = parse(
      [
        '<process>',
        '<step name="init" priority="first">',
        'a',
        '</step>',
        '<step name="spawn" condition="Task tool is available">',
        'b',
        '</step>',
        '## Not a unit when steps exist',
        '</process>',
      ].join('\n'),
    );
    assert.deepEqual(
      map.units.map((u) => [u.kind, u.name, u.attrs, u.startLine, u.endLine]),
      [
        ['step', 'init', { priority: 'first' }, 2, 4],
        ['step', 'spawn', { condition: 'Task tool is available' }, 5, 7],
      ],
    );
    assert.deepEqual(map.defects, []);
  });

  test('a step-less workflow uses the H2 headings of <process>, not those of other blocks', () => {
    const map = parse(['<process>', '## 1. Init', 'x', '## 2. Plan', '</process>', '<offer_next>', '## Next Up', '</offer_next>'].join('\n'));
    assert.deepEqual(
      map.units.map((u) => [u.kind, u.name, u.number]),
      [
        ['heading', '1. Init', '1'],
        ['heading', '2. Plan', '2'],
      ],
    );
  });

  test('without <process> every H2 is a unit; H3 never is', () => {
    const map = parse(['## A', '### a1', '## B'].join('\n'));
    assert.deepEqual(map.units.map((u) => u.name), ['A', 'B']);
  });

  test('gsd:section fragments are units too, interleaved by line, with their `when`', () => {
    const map = parse(
      [
        '<step name="one">',
        '</step>',
        '<!-- gsd:section id="partial" when="flag:--wave" -->',
        'read it',
        '<!-- /gsd:section -->',
        '<step name="two">',
        '</step>',
      ].join('\n'),
      { manifest: [{ id: 'partial', when: 'flag:--wave', read: 'gsd-core/workflows/demo/steps/partial.md' }], files: { 'gsd-core/workflows/demo/steps/partial.md': 'body' } },
    );
    assert.deepEqual(
      map.units.map((u) => [u.key, u.attrs.when ?? null]),
      [
        ['step:one', null],
        ['section:partial', 'flag:--wave'],
        ['step:two', null],
      ],
    );
    assert.deepEqual(map.defects, []);
  });

  test('a step that never closes is a malformed unit and a nested-step defect', () => {
    const map = parse(['<step name="a">', 'x', '<step name="b">', 'y', '</step>', '</step>'].join('\n'));
    assert.deepEqual(
      map.units.map((u) => [u.name, u.malformed]),
      [
        ['a', true],
        ['b', false],
      ],
    );
    assert.deepEqual(kinds(map), ['nested-step']);
  });

  test('a section marker missing from the manifest, and a manifest entry with no marker, are orphan-fragment defects', () => {
    const map = parse(['<!-- gsd:section id="here" when="always" -->', 'x', '<!-- /gsd:section -->'].join('\n'), {
      manifest: [{ id: 'gone', when: 'always', read: 'gsd-core/workflows/demo/steps/gone.md' }],
    });
    assert.deepEqual(map.defects.map((d) => [d.kind, d.subject]).sort(), [
      ['orphan-fragment', 'gone'],
      ['orphan-fragment', 'here'],
    ]);
  });

  test('a malformed section grammar is a defect, not a crash', () => {
    const map = parse(['<!-- gsd:section id="x" when="always" -->', 'never closed'].join('\n'));
    assert.deepEqual(kinds(map), ['section-grammar']);
  });
});

describe('spawns', () => {
  test('Agent( in a fence is a spawn; Agent() named in prose is not', () => {
    const map = parse(['<step name="s">', agentCall('gsd-planner'), 'After calling Agent() above, wait.', '</step>'].join('\n'));
    assert.deepEqual(
      map.spawns.map((s) => [s.unit, s.target, s.location]),
      [['step:s', { kind: 'agent', name: 'gsd-planner', registry: 'agents' }, 'fence']],
    );
  });

  test('Agent( in inline code is a spawn; one written in prose is a spawn AND a spawn-in-prose defect', () => {
    const map = parse(
      ['<step name="s">', `Use ${TICK}Agent(subagent_type="gsd-planner")${TICK}.`, 'spawn Agent(subagent_type="gsd-executor", model=m) now', '</step>'].join('\n'),
    );
    assert.deepEqual(map.spawns.map((s) => [s.target.name, s.location]), [
      ['gsd-planner', 'inline'],
      ['gsd-executor', 'prose'],
    ]);
    assert.deepEqual(map.defects.map((d) => [d.kind, d.subject]), [['spawn-in-prose', 'gsd-executor']]);
  });

  test('an unknown agent is a defect; built-in and capability agents are not', () => {
    const map = parse(['<step name="s">', agentCall('gsd-nope'), agentCall('general-purpose'), agentCall('gsd-system-architect'), '</step>'].join('\n'));
    assert.deepEqual(map.spawns.map((s) => s.target), [
      { kind: 'agent', name: 'gsd-nope', registry: null },
      { kind: 'builtin', name: 'general-purpose' },
      { kind: 'agent', name: 'gsd-system-architect', registry: 'capability' },
    ]);
    assert.deepEqual(map.defects.map((d) => [d.kind, d.subject]), [['unknown-agent', 'gsd-nope']]);
  });

  test('{VAR}: candidates only when every assignment is a literal', () => {
    const literal = parse(
      ['<step name="s">', FENCE, 'EXEC="gsd-executor"', 'EXEC=gsd-planner', FENCE, agentCall('{EXEC}'), '</step>'].join('\n'),
    );
    assert.deepEqual(literal.spawns[0].target, {
      kind: 'dynamic',
      expr: 'EXEC',
      candidates: [
        { name: 'gsd-executor', registry: 'agents' },
        { name: 'gsd-planner', registry: 'agents' },
      ],
    });
    const computed = parse(
      ['<step name="s">', FENCE, 'EXEC="gsd-executor"', 'EXEC=$(gsd_run query resolve-agent --raw)', FENCE, agentCall('{EXEC}'), '</step>'].join('\n'),
    );
    assert.deepEqual(computed.spawns[0].target, { kind: 'dynamic', expr: 'EXEC', candidates: [] });
  });

  test('a literal candidate that is no agent is an unknown-agent defect', () => {
    const map = parse(['<step name="s">', FENCE, 'EXEC="gsd-ghost"', FENCE, agentCall('{EXEC}'), '</step>'].join('\n'));
    assert.deepEqual(map.defects.map((d) => [d.kind, d.subject]), [['unknown-agent', 'gsd-ghost']]);
  });

  test('ref.agent resolves through the loop points the same unit renders', () => {
    const map = parse(
      [
        '<step name="hooks">',
        FENCE,
        'HOOKS=$(gsd_run loop render-hooks plan:pre --raw)',
        FENCE,
        `Dispatch ${TICK}Agent(prompt=f, subagent_type=ref.agent)${TICK}.`,
        '</step>',
        '<step name="lonely">',
        `${TICK}Agent(subagent_type=hook.ref.agent)${TICK}`,
        '</step>',
      ].join('\n'),
    );
    assert.deepEqual(map.spawns.map((s) => [s.unit, s.target]), [
      ['step:hooks', { kind: 'capability-hook', expr: 'ref.agent', points: ['plan:pre'] }],
      ['step:lonely', { kind: 'capability-hook', expr: 'hook.ref.agent', points: [] }],
    ]);
  });

  test('a spawn outside every unit belongs to the workflow itself (unit null)', () => {
    const map = parse([agentCall('gsd-planner'), '<step name="s">', '</step>'].join('\n'));
    assert.equal(map.spawns[0].unit, null);
  });

  // Boundary: the `subagent_type` argument must sit inside the first MAX_CALL_CHARS of the call.
  for (const [what, pad, found] of [
    ['limit-1', wm.MAX_CALL_CHARS - 1, true],
    ['limit', wm.MAX_CALL_CHARS, true],
    ['limit+1', wm.MAX_CALL_CHARS + 1, false],
  ]) {
    test(`an Agent( call whose subagent_type ends at ${what} of MAX_CALL_CHARS is ${found ? '' : 'not '}a spawn`, () => {
      const arg = 'subagent_type="gsd-planner"';
      const filler = `${'x'.repeat(pad - arg.length - 2)}, `;
      const map = parse(['<step name="s">', FENCE, `Agent(${filler}${arg})`, FENCE, '</step>'].join('\n'));
      assert.equal(map.spawns.length, found ? 1 : 0);
    });
  }
});

describe('loop points and includes', () => {
  test('render-hooks in code is a loop point; outside the contract it is an unknown-point defect; in prose it is ignored', () => {
    const map = parse(
      [
        '<step name="s">',
        FENCE,
        'gsd_run loop render-hooks plan:pre --raw',
        'gsd_run loop render-hooks plan:middle --raw',
        FENCE,
        'In prose: loop render-hooks execute:post is described here.',
        '</step>',
      ].join('\n'),
    );
    assert.deepEqual(map.loopPoints.map((p) => [p.unit, p.point, p.known]), [
      ['step:s', 'plan:pre', true],
      ['step:s', 'plan:middle', false],
    ]);
    assert.deepEqual(map.defects.map((d) => [d.kind, d.subject]), [['unknown-point', 'plan:middle']]);
  });

  test('spawns and points inside a fragment the unit reads are attributed to that unit', () => {
    const frag = 'gsd-core/workflows/demo/steps/go.md';
    const map = parse(['<step name="s">', `Read and execute ${TICK}${frag}${TICK}.`, '</step>'].join('\n'), {
      files: { [frag]: [agentCall('gsd-executor'), FENCE, 'gsd_run loop render-hooks execute:post', FENCE].join('\n') },
    });
    assert.deepEqual(map.spawns.map((s) => [s.unit, s.target.name, s.file]), [['step:s', 'gsd-executor', frag]]);
    assert.deepEqual(map.loopPoints.map((p) => [p.unit, p.point, p.file]), [['step:s', 'execute:post', frag]]);
    assert.deepEqual(map.includes.map((i) => [i.unit, i.path, i.kind, i.exists]), [['step:s', frag, 'fragment', true]]);
  });

  test('a fragment read twice by one unit counts its spawn once', () => {
    const frag = 'gsd-core/workflows/demo/steps/go.md';
    const map = parse(['<step name="s">', `read ${frag}`, `and again ${frag}`, '</step>'].join('\n'), { files: { [frag]: agentCall('gsd-executor') } });
    assert.equal(map.spawns.length, 1);
  });

  test('another top-level workflow is a workflow include, not followed; a missing file is a missing-include defect', () => {
    const map = parse(['<step name="s">', 'then gsd-core/workflows/transition.md', 'and gsd-core/workflows/demo/steps/absent.md', '</step>'].join('\n'), {
      files: { 'gsd-core/workflows/transition.md': agentCall('gsd-planner') },
    });
    assert.deepEqual(map.includes.map((i) => [i.path, i.kind, i.exists]), [
      ['gsd-core/workflows/transition.md', 'workflow', true],
      ['gsd-core/workflows/demo/steps/absent.md', 'fragment', false],
    ]);
    assert.deepEqual(map.spawns, [], 'the other workflow has its own map');
    assert.deepEqual(kinds(map), ['missing-include']);
  });

  test('a section reads its manifest fragment even when the body does not name it', () => {
    const frag = 'gsd-core/workflows/demo/steps/sec.md';
    const map = parse(['<!-- gsd:section id="sec" when="flag:--auto" -->', 'conditional text', '<!-- /gsd:section -->'].join('\n'), {
      manifest: [{ id: 'sec', when: 'flag:--auto', read: frag }],
      files: { [frag]: agentCall('gsd-planner') },
    });
    assert.deepEqual(map.spawns.map((s) => [s.unit, s.target.name]), [['section:sec', 'gsd-planner']]);
    assert.equal(map.includes.length, 1);
  });

  // Boundary: fragment chains are followed MAX_INCLUDE_DEPTH deep.
  for (const [what, depth] of [
    ['limit-1', wm.MAX_INCLUDE_DEPTH - 1],
    ['limit', wm.MAX_INCLUDE_DEPTH],
    ['limit+1', wm.MAX_INCLUDE_DEPTH + 1],
  ]) {
    test(`a fragment chain ${depth} deep (${what}) is followed to depth ${Math.min(depth, wm.MAX_INCLUDE_DEPTH)}`, () => {
      const files = {};
      const agents = [];
      for (let i = 1; i <= depth; i++) {
        const next = i < depth ? `next: gsd-core/workflows/demo/steps/f${i + 1}.md` : '';
        files[`gsd-core/workflows/demo/steps/f${i}.md`] = [agentCall(`gsd-a${i}`), next].join('\n');
        agents.push(`gsd-a${i}`);
      }
      const map = wm.parseWorkflow(
        { name: 'demo', path: 'gsd-core/workflows/demo.md', text: ['<step name="s">', 'gsd-core/workflows/demo/steps/f1.md', '</step>'].join('\n') },
        { ...ctx({ files }), agents: new Set(agents) },
      );
      assert.deepEqual(
        map.spawns.map((s) => s.target.name),
        agents.slice(0, wm.MAX_INCLUDE_DEPTH),
      );
    });
  }
});

describe('jumps', () => {
  const steps = [
    '<step name="first">',
    'If done, skip to `last_step`. Otherwise go to step 5 and then proceed to the next step.',
    'On failure, go to retry_loop.',
    '</step>',
    '<step name="last_step">',
    '</step>',
  ].join('\n');

  test('a phrase naming a real step resolves; "step 5" and "the next step" are counted, not drawn', () => {
    const map = parse(steps);
    assert.deepEqual(map.jumps.map((j) => [j.token, j.to]), [
      ['last_step', 'step:last_step'],
      ['5', null],
      [null, null],
      ['retry_loop', null],
    ]);
    assert.equal(map.unresolvedJumps, 3);
  });

  test('a snake_case target no unit carries is a dangling-jump defect; numeric refs are not', () => {
    const map = parse(steps);
    assert.deepEqual(map.defects.map((d) => [d.kind, d.subject]), [['dangling-jump', 'retry_loop']]);
  });

  test('a step declared in a fragment the workflow reads is not dangling', () => {
    const frag = 'gsd-core/workflows/demo/steps/r.md';
    const map = parse(steps.replace('</step>\n<step name="last_step">', `read ${frag}\n</step>\n<step name="last_step">`), {
      files: { [frag]: '<step name="retry_loop">\n</step>' },
    });
    assert.deepEqual(kinds(map), []);
  });

  test('"step 5.5" resolves to a numbered heading; jumps inside fences are ignored', () => {
    const map = parse(['## 5. Research', 'Proceed to step 5.5.', FENCE, '# go to step 5', FENCE, '## 5.5. Validate', '## 6. Done'].join('\n'));
    assert.deepEqual(map.jumps.map((j) => [j.unit, j.to]), [['heading:5. Research', 'heading:5.5. Validate']]);
  });

  test('Russian phrasing is recognised', () => {
    const map = parse(['<step name="a">', 'Перейди к `b`.', '</step>', '<step name="b">', '</step>'].join('\n'));
    assert.deepEqual(map.jumps.map((j) => j.to), ['step:b']);
  });
});

describe('diagrams', () => {
  const text = [
    '<step name="init">',
    'If x, skip to `ship`. Else go to missing_step.',
    '</step>',
    '<step name="spawn" condition="Agent tool is available">',
    agentCall('gsd-planner'),
    agentCall('gsd-ghost'),
    FENCE,
    'gsd_run loop render-hooks plan:pre',
    FENCE,
    '</step>',
    '<step name="ship">',
    '</step>',
  ].join('\n');
  const map = parse(text);
  const d = wm.workflowMapDiagrams(map, ctx().loopHooks);

  test('flow: root, then every unit in order; the condition labels the edge into its step', () => {
    const units = d.flow.nodes.filter((n) => n.kind === 'unit').map((n) => n.unit);
    assert.deepEqual(units, ['step:init', 'step:spawn', 'step:ship']);
    const idOf = new Map(d.flow.nodes.map((n) => [n.kind === 'unit' ? n.unit : n.kind, n.id]));
    const solid = d.flow.spec.edges.filter((e) => e.line === undefined);
    assert.deepEqual(
      solid.map((e) => [e.from, e.to, e.label ?? null]),
      [
        [idOf.get('root'), idOf.get('step:init'), null],
        [idOf.get('step:init'), idOf.get('step:spawn'), 'если: Agent tool is available'],
        [idOf.get('step:spawn'), idOf.get('step:ship'), null],
      ],
    );
  });

  test('flow: a resolved jump is a dotted goto; a dangling one points at a red missing node', () => {
    const missing = d.flow.nodes.filter((n) => n.kind === 'missing-step');
    assert.deepEqual(missing.map((n) => n.token), ['missing_step']);
    const dotted = d.flow.spec.edges.filter((e) => e.line === 'dotted');
    assert.equal(dotted.length, 2);
    assert.deepEqual(dotted.map((e) => e.linkStyle ?? null), [null, m.DEFECT_LINK_STYLE]);
  });

  test('calls: agents are checked nodes, the unknown one red; the loop point carries its capability steps', () => {
    const agents = d.calls.nodes.filter((n) => n.kind === 'agent').map((n) => [n.name, n.registry]);
    assert.deepEqual(agents, [
      ['gsd-planner', 'agents'],
      ['gsd-ghost', null],
    ]);
    const caps = d.calls.nodes.filter((n) => n.kind === 'capability-step').map((n) => [n.point, n.capId, n.ref]);
    assert.deepEqual(caps, [
      ['plan:pre', 'architecture', 'agent gsd-system-architect'],
      ['plan:pre', 'ui', 'skill ui-phase'],
    ]);
    const ghost = d.calls.nodes.find((n) => n.kind === 'agent' && n.name === 'gsd-ghost').id;
    const edge = d.calls.spec.edges.find((e) => e.to === ghost);
    assert.equal(edge.linkStyle, m.DEFECT_LINK_STYLE);
  });

  test('specs build: every edge endpoint is declared (the builder refuses an invented node)', () => {
    assert.doesNotThrow(() => m.flowchart(d.flow.spec));
    assert.doesNotThrow(() => m.flowchart(d.calls.spec));
  });

  test('calls is null for a workflow with nothing to call', () => {
    assert.equal(wm.workflowMapDiagrams(parse('<step name="a">\n</step>')).calls, null);
  });

  // Boundary: a heading flow is split into subgraphs only above SUBGRAPH_THRESHOLD units.
  for (const [what, count, grouped] of [
    ['limit-1', wm.SUBGRAPH_THRESHOLD - 1, false],
    ['limit', wm.SUBGRAPH_THRESHOLD, false],
    ['limit+1', wm.SUBGRAPH_THRESHOLD + 1, true],
  ]) {
    test(`${count} numbered headings (${what}) are ${grouped ? '' : 'not '}grouped by major number`, () => {
      // Pairs N and N.5 share a group, so grouping always has fewer groups than units.
      const lines = [];
      for (let i = 0; i < count; i++) lines.push(`## ${Math.floor(i / 2)}${i % 2 === 1 ? '.5' : ''}. Part ${i}`);
      const flow = wm.workflowMapDiagrams(parse(lines.join('\n'))).flow;
      if (!grouped) {
        assert.deepEqual(flow.spec.subgraphs, []);
        return;
      }
      assert.deepEqual(
        flow.spec.subgraphs.map((s) => [s.title, s.nodes.length]),
        Array.from({ length: Math.ceil(count / 2) }, (_, g) => [`${g}. Part ${g * 2}`, Math.min(2, count - g * 2)]),
      );
    });
  }

  test('unnumbered headings are never grouped, however many', () => {
    const lines = Array.from({ length: wm.SUBGRAPH_THRESHOLD + 5 }, (_, i) => `## Part ${i}`);
    assert.deepEqual(wm.workflowMapDiagrams(parse(lines.join('\n'))).flow.spec.subgraphs, []);
  });
});

describe('documents', () => {
  test('a workflow with no unit and no spawn has no map', () => {
    assert.equal(wm.hasMap(parse('just prose')), false);
    assert.equal(wm.hasMap(parse('<step name="a">\n</step>')), true);
  });

  test('the map document starts with the derived marker', () => {
    const doc = wm.renderWorkflowMapDoc(parse('<step name="a">\n</step>'));
    assert.equal(doc.split('\n')[0], m.derivedMarker(wm.WORKFLOW_MAPS_SOURCE));
  });
});
