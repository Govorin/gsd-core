'use strict';

/**
 * Unit tests for mermaid.cjs (built from src/mermaid.cts).
 *
 * The builders' contract is three guarantees — nothing added, same input same
 * bytes, no input text can change structure — so the tests check exactly those:
 *
 *   - every diagram is parsed back into a model (nodes, edges, blocks, labels)
 *     by the small readers below and compared with the spec it was built from,
 *     never matched as substrings;
 *   - labels round-trip through escapeLabel/unescapeLabel, and an escaped label
 *     holds no character any mermaid grammar reads as syntax;
 *   - every way of naming something that was never declared throws.
 *
 * The real mermaid parser is not a dependency of this repo; it was run over the
 * same shapes out of tree (see the phase-5 report). The readers here pin the
 * structure the builders promise.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../gsd-core/bin/lib/mermaid.cjs');

/** Strings built to break a naive label: every syntax character, unicode, controls, entity look-alikes. */
const NASTY = [
  'He said "hi"; then left',
  '#1 <b>bold</b> | pipe `tick` a:b {brace} [sq] (round)',
  'a -- b --> c --- d - e',
  'literal entity text #59; and #quot; stays literal',
  'line one\nline two\r\nline three',
  'unicode ✓ фаза 漢字 🚀 — em dash',
  'end',
  'tab\there and a bell\u0007 and bidi\u202e flip',
];

/** What escapeLabel promises to keep: CRLF→LF, tab→space, controls/bidi dropped, trimmed. */
function normalized(s) {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim();
}

/** An escaped label with its entities and line breaks removed must be inert. */
function assertInert(escaped) {
  const bare = escaped.replace(/#(?:quot|lt|gt|\d+);/g, '').replace(/<br\/>/g, '');
  assert.doesNotMatch(bare, /[#";<>|`:{}\n\r]/, `syntax character survived escaping: ${escaped}`);
  assert.doesNotMatch(bare, /--/, `a link-forming dash run survived escaping: ${escaped}`);
}

// ─── readers: diagram text → model ───────────────────────────────────────────

function bodyLines(diagram) {
  const [header, ...rest] = diagram.split('\n');
  return { header, rest };
}

const SHAPES = [
  ['stadium', '\\(\\[', '\\]\\)'],
  ['subroutine', '\\[\\[', '\\]\\]'],
  ['cylinder', '\\[\\(', '\\)\\]'],
  ['circle', '\\(\\(', '\\)\\)'],
  ['hexagon', '\\{\\{', '\\}\\}'],
  ['rect', '\\[', '\\]'],
  ['round', '\\(', '\\)'],
  ['rhombus', '\\{', '\\}'],
];

function readFlowchart(diagram) {
  const { header, rest } = bodyLines(diagram);
  const model = { direction: header.split(' ')[1], subgraphs: [], nodes: [], edges: [], linkStyles: {}, classDefs: [] };
  let current = null;
  for (const line of rest) {
    let mm;
    if ((mm = line.match(/^ {2}subgraph (\w+)\["(.*)"\]$/))) {
      current = { id: mm[1], title: m.unescapeLabel(mm[2]), nodes: [], direction: undefined };
      model.subgraphs.push(current);
      continue;
    }
    if (current && (mm = line.match(/^ {4}direction (\w+)$/))) {
      current.direction = mm[1];
      continue;
    }
    if (/^ {2}end$/.test(line)) {
      current = null;
      continue;
    }
    if ((mm = line.match(/^ {2}classDef (\w+) (.+)$/))) {
      model.classDefs.push({ name: mm[1], style: mm[2] });
      continue;
    }
    if ((mm = line.match(/^ {2}linkStyle (\d+) (.+)$/))) {
      model.linkStyles[Number(mm[1])] = mm[2];
      continue;
    }
    if ((mm = line.match(/^ {2}(\w+) (-->|---|-\.->|-\.-|==>|===)(?:\|"(.*)"\|)? (\w+)$/))) {
      model.edges.push({ from: mm[1], link: mm[2], label: mm[3] === undefined ? undefined : m.unescapeLabel(mm[3]), to: mm[4] });
      continue;
    }
    let node = null;
    for (const [shape, open, close] of SHAPES) {
      const re = new RegExp(`^ +(\\w+)${open}"(.*)"${close}(?::::(\\w+))?$`);
      if ((mm = line.match(re))) {
        node = { id: mm[1], label: m.unescapeLabel(mm[2]), shape, className: mm[3] };
        break;
      }
    }
    assert.ok(node, `unrecognised flowchart line: ${JSON.stringify(line)}`);
    model.nodes.push(node);
    if (current) current.nodes.push(node.id);
  }
  return model;
}

function readStateDiagram(diagram) {
  const { header, rest } = bodyLines(diagram);
  assert.equal(header, 'stateDiagram-v2');
  const blocks = new Map([['', { label: null, states: [], transitions: [], notes: [], classes: [] }]]);
  const model = { direction: undefined, classDefs: [], blocks };
  let cur = blocks.get('');
  for (const line of rest) {
    let mm;
    if ((mm = line.match(/^ {2}direction (\w+)$/))) model.direction = mm[1];
    else if ((mm = line.match(/^ {2}classDef (\w+) (.+)$/))) model.classDefs.push({ name: mm[1], style: mm[2] });
    else if ((mm = line.match(/^ {2}state "(.*)" as (\w+) \{$/))) {
      cur = { label: m.unescapeLabel(mm[1]), states: [], transitions: [], notes: [], classes: [] };
      blocks.set(mm[2], cur);
    } else if (/^ {2}\}$/.test(line)) cur = blocks.get('');
    else if ((mm = line.match(/^ +state "(.*)" as (\w+)$/))) cur.states.push({ id: mm[2], label: m.unescapeLabel(mm[1]) });
    else if ((mm = line.match(/^ +(\w+|\[\*\]) --> (\w+|\[\*\])(?: : (.*))?$/))) {
      cur.transitions.push({ from: mm[1], to: mm[2], label: mm[3] === undefined ? undefined : m.unescapeLabel(mm[3]) });
    } else if ((mm = line.match(/^ +note (left|right) of (\w+) : (.*)$/))) {
      cur.notes.push({ side: mm[1], state: mm[2], text: m.unescapeLabel(mm[3]) });
    } else if ((mm = line.match(/^ +class (\w+) (\w+)$/))) cur.classes.push({ state: mm[1], className: mm[2] });
    else assert.fail(`unrecognised stateDiagram line: ${JSON.stringify(line)}`);
  }
  return model;
}

function readGantt(diagram) {
  const { header, rest } = bodyLines(diagram);
  assert.equal(header, 'gantt');
  const model = { title: undefined, dateFormat: undefined, axisFormat: undefined, sections: [] };
  for (const line of rest) {
    let mm;
    if ((mm = line.match(/^ {2}title (.*)$/))) model.title = m.unescapeLabel(mm[1]);
    else if ((mm = line.match(/^ {2}dateFormat (.*)$/))) model.dateFormat = mm[1];
    else if ((mm = line.match(/^ {2}axisFormat (.*)$/))) model.axisFormat = mm[1];
    else if ((mm = line.match(/^ {2}section (.*)$/))) model.sections.push({ name: m.unescapeLabel(mm[1]), tasks: [] });
    else if ((mm = line.match(/^ {2}([^:]*) :(.*)$/))) {
      // The label cannot contain a raw ':' — escapeLabel guarantees it — so the
      // first ' :' is the label/data boundary.
      model.sections.at(-1).tasks.push({ label: m.unescapeLabel(mm[1]), data: mm[2].split(', ') });
    } else assert.fail(`unrecognised gantt line: ${JSON.stringify(line)}`);
  }
  return model;
}

function readClassDiagram(diagram) {
  const { header, rest } = bodyLines(diagram);
  assert.equal(header, 'classDiagram');
  const model = { direction: undefined, classes: [], relations: [] };
  let cur = null;
  for (const line of rest) {
    let mm;
    if ((mm = line.match(/^ {2}direction (\w+)$/))) model.direction = mm[1];
    else if ((mm = line.match(/^ {2}class (\w+)(?:\["(.*)"\])?( \{)?$/))) {
      const c = { id: mm[1], label: mm[2] === undefined ? undefined : m.unescapeLabel(mm[2]), annotation: undefined, body: [] };
      model.classes.push(c);
      cur = mm[3] ? c : null;
    } else if (cur && /^ {2}\}$/.test(line)) cur = null;
    else if (cur && (mm = line.match(/^ {4}<<(.+)>>$/))) cur.annotation = mm[1];
    else if (cur && (mm = line.match(/^ {4}(.+)$/))) cur.body.push(mm[1]);
    else if ((mm = line.match(/^ {2}(\w+)(?: "([^"]+)")? (--\|>|\.\.\|>|--\*|--o|-->|\.\.>|--) (?:"([^"]+)" )?(\w+)(?: : (.*))?$/))) {
      model.relations.push({
        from: mm[1], fromCardinality: mm[2], arrow: mm[3], toCardinality: mm[4], to: mm[5],
        label: mm[6] === undefined ? undefined : m.unescapeLabel(mm[6]),
      });
    } else assert.fail(`unrecognised classDiagram line: ${JSON.stringify(line)}`);
  }
  return model;
}

function readErDiagram(diagram) {
  const { header, rest } = bodyLines(diagram);
  assert.equal(header, 'erDiagram');
  const model = { entities: [], relationships: [] };
  let cur = null;
  for (const line of rest) {
    let mm;
    if ((mm = line.match(/^ {2}(\w+)( \{)?$/))) {
      const e = { id: mm[1], attributes: [] };
      model.entities.push(e);
      cur = mm[2] ? e : null;
    } else if (cur && /^ {2}\}$/.test(line)) cur = null;
    else if (cur && (mm = line.match(/^ {4}(\S+) (\S+)((?: (?:PK|FK|UK),?)*)(?: "([^"]*)")?$/))) {
      cur.attributes.push({
        type: mm[1], name: mm[2], keys: mm[3].trim() === '' ? [] : mm[3].trim().split(/,\s*/), comment: mm[4],
      });
    } else if ((mm = line.match(/^ {2}(\w+) (\|o|\|\||\}o|\}\|)(--|\.\.)(o\||\|\||o\{|\|\{) (\w+) : "([^"]*)"$/))) {
      model.relationships.push({ left: mm[1], leftMark: mm[2], line: mm[3], rightMark: mm[4], right: mm[5], label: mm[6] });
    } else assert.fail(`unrecognised erDiagram line: ${JSON.stringify(line)}`);
  }
  return model;
}

// ─── escaping ────────────────────────────────────────────────────────────────

describe('escapeLabel / unescapeLabel', () => {
  for (const s of NASTY) {
    test(`round-trips and leaves nothing syntactic: ${JSON.stringify(s).slice(0, 40)}`, () => {
      const escaped = m.escapeLabel(s);
      assertInert(escaped);
      assert.equal(m.unescapeLabel(escaped), normalized(s));
    });
  }

  test('a lone hyphen stays readable; a run of two or more is escaped char by char', () => {
    assert.equal(m.escapeLabel('01-02'), '01-02');
    assert.equal(m.unescapeLabel(m.escapeLabel('a--b')), 'a--b');
    assert.equal(m.escapeLabel('a--b').split('#45;').length - 1, 2);
    assert.equal(m.escapeLabel('a---b').split('#45;').length - 1, 3);
  });

  test('escaping is one pass: an emitted entity is never re-escaped', () => {
    // `#` → `#35;` must not then have its `;` turned into `#59;` — the real
    // mermaid parser rendered exactly that as garbage before the fix.
    assert.equal(m.escapeLabel('#'), '#35;');
    assert.equal(m.escapeLabel(';'), '#59;');
    assert.equal(m.escapeLabel('#;'), '#35;#59;');
  });

  test('unicode is kept verbatim, controls and bidi overrides are dropped', () => {
    assert.equal(m.escapeLabel('фаза ✓ 🚀'), 'фаза ✓ 🚀');
    assert.equal(m.escapeLabel('a\u202eb\u0000c'), 'abc');
  });

  test('a newline becomes <br/> (CRLF and CR alike) and non-strings are stringified', () => {
    assert.equal(m.escapeLabel('a\r\nb\rc\nd'), 'a<br/>b<br/>c<br/>d');
    assert.equal(m.escapeLabel(42), '42');
    assert.equal(m.escapeLabel(null), '');
  });
});

describe('derivedMarker / fence', () => {
  test('the marker names its source and the rerun contract', () => {
    assert.equal(m.derivedMarker('plan-graph'), '<!-- gsd:derived source=plan-graph — regenerated, do not hand-edit -->');
    assert.equal(
      m.derivedMarker('scripts/gen-state-machines.cjs'),
      '<!-- gsd:derived source=scripts/gen-state-machines.cjs — regenerated, do not hand-edit -->',
    );
  });

  test('a source that could close the comment early is refused', () => {
    for (const bad of ['', '  ', 'a--b', 'a\nb', 'x>y']) {
      assert.throws(() => m.derivedMarker(bad), TypeError, JSON.stringify(bad));
    }
  });

  test('fence wraps once and refuses nested fences', () => {
    assert.deepEqual(m.fence('flowchart LR').split('\n'), ['```mermaid', 'flowchart LR', '```']);
    assert.throws(() => m.fence('a\n```\nb'), TypeError);
  });
});

// ─── identifiers ─────────────────────────────────────────────────────────────

describe('createIdRegistry / isSafeId', () => {
  test('same raw → same id; different raws that spell alike stay distinct, in request order', () => {
    const ids = m.createIdRegistry('p_');
    assert.equal(ids.id('02.1-01'), 'p_02_1_01');
    assert.equal(ids.id('02-1-01'), 'p_02_1_01_2');
    assert.equal(ids.id('02_1_01'), 'p_02_1_01_3');
    assert.equal(ids.id('02.1-01'), 'p_02_1_01');
    assert.deepEqual(ids.entries(), [
      ['02.1-01', 'p_02_1_01'],
      ['02-1-01', 'p_02_1_01_2'],
      ['02_1_01', 'p_02_1_01_3'],
    ]);
  });

  test('keywords, digit leads, empty strings and unicode all become safe ids', () => {
    const ids = m.createIdRegistry();
    assert.equal(ids.id('end'), 'end_');
    assert.equal(ids.id('7up'), 'n_7up');
    assert.equal(ids.id(''), 'n_');
    assert.equal(ids.id('фа'), 'u444u430');
    for (const [, id] of ids.entries()) assert.ok(m.isSafeId(id), id);
  });

  test('every id a registry hands out passes isSafeId, whatever the input', () => {
    const ids = m.createIdRegistry('n_');
    for (const s of NASTY) assert.ok(m.isSafeId(ids.id(s)), s);
  });

  test('isSafeId rejects keywords (any case), punctuation and non-strings', () => {
    for (const bad of ['end', 'END', 'subgraph', 'a-b', 'a b', '1a', '', 'фа', 7, null]) {
      assert.equal(m.isSafeId(bad), false, String(bad));
    }
    assert.equal(m.isSafeId('in_progress'), true);
  });

  test('a prefix must itself be an identifier', () => {
    assert.throws(() => m.createIdRegistry('1-'), TypeError);
  });
});

// ─── flowchart ───────────────────────────────────────────────────────────────

describe('flowchart', () => {
  const spec = () => ({
    direction: 'LR',
    nodes: [
      { id: 'a', label: NASTY[0], className: 'ok' },
      { id: 'b', shape: 'round' },
      { id: 'c', label: NASTY[1], shape: 'rhombus' },
      { id: 'd', shape: 'stadium' },
    ],
    subgraphs: [{ id: 'S1', title: NASTY[2], nodes: ['b', 'a'], direction: 'TB' }],
    edges: [
      { from: 'a', to: 'b', label: NASTY[4] },
      { from: 'b', to: 'c', line: 'dotted', linkStyle: 'stroke:#d33,stroke-width:2px' },
      { from: 'c', to: 'd', line: 'thick', arrow: false },
    ],
    classDefs: [{ name: 'ok', style: 'fill:#e6f4ea,stroke:#2e7d32' }],
  });

  test('reads back as exactly the spec: subgraphs, nodes, labels, edges, linkStyles, classDefs', () => {
    const model = readFlowchart(m.flowchart(spec()));
    assert.equal(model.direction, 'LR');
    assert.deepEqual(model.subgraphs, [{ id: 'S1', title: normalized(NASTY[2]), nodes: ['b', 'a'], direction: 'TB' }]);
    assert.deepEqual(
      model.nodes.map((n) => [n.id, n.label, n.shape, n.className]),
      [
        ['b', 'b', 'round', undefined],
        ['a', normalized(NASTY[0]), 'rect', 'ok'],
        ['c', normalized(NASTY[1]), 'rhombus', undefined],
        ['d', 'd', 'stadium', undefined],
      ],
      'subgraph members first, in subgraph order, then the rest in input order',
    );
    assert.deepEqual(
      model.edges.map((e) => [e.from, e.link, e.label, e.to]),
      [
        ['a', '-->', normalized(NASTY[4]), 'b'],
        ['b', '-.->', undefined, 'c'],
        ['c', '===', undefined, 'd'],
      ],
    );
    assert.deepEqual(model.linkStyles, { 1: 'stroke:#d33,stroke-width:2px' }, 'linkStyle index = edge position');
    assert.deepEqual(model.classDefs, [{ name: 'ok', style: 'fill:#e6f4ea,stroke:#2e7d32' }]);
  });

  test('every shape reads back as itself', () => {
    const shapes = ['rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'rhombus', 'hexagon'];
    const model = readFlowchart(m.flowchart({ nodes: shapes.map((shape) => ({ id: `n_${shape}`, shape })) }));
    assert.deepEqual(model.nodes.map((n) => n.shape), shapes);
  });

  test('the same spec gives the same bytes; reordering the input reorders the output', () => {
    assert.equal(m.flowchart(spec()), m.flowchart(spec()));
    const swapped = spec();
    swapped.edges.reverse();
    assert.deepEqual(
      readFlowchart(m.flowchart(swapped)).edges.map((e) => e.from),
      ['c', 'b', 'a'],
    );
  });

  test('refuses to invent: an edge or subgraph member that was never declared throws', () => {
    assert.throws(() => m.flowchart({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'ghost' }] }), /never declared/);
    assert.throws(() => m.flowchart({ nodes: [{ id: 'a' }], subgraphs: [{ id: 'S', nodes: ['ghost'] }] }), /never declared/);
  });

  test('refuses ambiguous or unsafe structure', () => {
    assert.throws(() => m.flowchart({ nodes: [{ id: 'a' }, { id: 'a' }] }), /duplicate/);
    assert.throws(() => m.flowchart({ nodes: [{ id: 'end' }] }), /not a safe mermaid id/);
    assert.throws(() => m.flowchart({ nodes: [{ id: 'a-b' }] }), /not a safe mermaid id/);
    assert.throws(() => m.flowchart({ nodes: [{ id: 'S' }], subgraphs: [{ id: 'S', nodes: [] }] }), /duplicate/);
    assert.throws(
      () => m.flowchart({ nodes: [{ id: 'a' }], subgraphs: [{ id: 'S', nodes: ['a'] }, { id: 'T', nodes: ['a'] }] }),
      /more than one subgraph/,
    );
    assert.throws(() => m.flowchart({ nodes: [{ id: 'a', className: 'nope' }] }), /no classDef/);
    assert.throws(() => m.flowchart({ nodes: [{ id: 'a', shape: 'blob' }] }), /unknown shape/);
    assert.throws(() => m.flowchart({ direction: 'XX', nodes: [] }), /unknown direction/);
  });

  test('a style list cannot smuggle a statement', () => {
    for (const style of ['fill:#fff;click a call x()', 'fill:#fff\n  a --> b', 'fill:"x"']) {
      assert.throws(() => m.flowchart({ nodes: [], classDefs: [{ name: 'k', style }] }), /plain mermaid style/, style);
      assert.throws(
        () => m.flowchart({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b', linkStyle: style }] }),
        /plain mermaid style/,
      );
    }
  });
});

// ─── stateDiagram-v2 ─────────────────────────────────────────────────────────

describe('stateDiagram', () => {
  test('declares every state, and writes transitions, notes and classes into the block that owns them', () => {
    const model = readStateDiagram(
      m.stateDiagram({
        direction: 'LR',
        states: [{ id: 'idle' }, { id: 'run', label: NASTY[0], className: 'live' }, { id: 'a' }, { id: 'b', className: 'live' }],
        groups: [{ id: 'G', label: NASTY[3], states: ['a', 'b'] }],
        transitions: [
          { from: m.STATE_TERMINAL, to: 'idle' },
          { from: 'idle', to: 'run', label: NASTY[1] },
          { from: 'a', to: 'b', label: 'inner' },
          { from: 'b', to: m.STATE_TERMINAL },
        ],
        notes: [{ state: 'run', text: NASTY[4] }, { state: 'a', side: 'left', text: 'in group' }],
        classDefs: [{ name: 'live', style: 'fill:#fff4e5' }],
      }),
    );
    assert.equal(model.direction, 'LR');
    assert.deepEqual(model.classDefs, [{ name: 'live', style: 'fill:#fff4e5' }]);
    assert.deepEqual([...model.blocks.keys()], ['', 'G']);
    const top = model.blocks.get('');
    const g = model.blocks.get('G');
    assert.equal(g.label, normalized(NASTY[3]));
    assert.deepEqual(g.states, [{ id: 'a', label: 'a' }, { id: 'b', label: 'b' }]);
    assert.deepEqual(g.transitions, [{ from: 'a', to: 'b', label: 'inner' }, { from: 'b', to: '[*]', label: undefined }]);
    assert.deepEqual(g.notes, [{ side: 'left', state: 'a', text: 'in group' }]);
    assert.deepEqual(g.classes, [{ state: 'b', className: 'live' }]);
    assert.deepEqual(top.states, [{ id: 'idle', label: 'idle' }, { id: 'run', label: normalized(NASTY[0]) }]);
    assert.deepEqual(top.transitions, [
      { from: '[*]', to: 'idle', label: undefined },
      { from: 'idle', to: 'run', label: normalized(NASTY[1]) },
    ]);
    assert.deepEqual(top.notes, [{ side: 'right', state: 'run', text: normalized(NASTY[4]) }]);
    assert.deepEqual(top.classes, [{ state: 'run', className: 'live' }]);
  });

  test('a diagram with states and no transitions draws only the states', () => {
    const model = readStateDiagram(m.stateDiagram({ states: [{ id: 'x' }, { id: 'y' }] }));
    assert.deepEqual(model.blocks.get('').transitions, []);
    assert.deepEqual(model.blocks.get('').states.map((s) => s.id), ['x', 'y']);
  });

  test('a transition across a group boundary throws instead of duplicating the state', () => {
    const base = { states: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], groups: [{ id: 'G', states: ['a'] }, { id: 'H', states: ['c'] }] };
    assert.throws(() => m.stateDiagram({ ...base, transitions: [{ from: 'a', to: 'b' }] }), /crosses a group boundary/);
    assert.throws(() => m.stateDiagram({ ...base, transitions: [{ from: 'a', to: 'c' }] }), /crosses a group boundary/);
    assert.doesNotThrow(() => m.stateDiagram({ ...base, transitions: [{ from: m.STATE_TERMINAL, to: 'a' }] }));
  });

  test('refuses to invent states, groups members or classes', () => {
    assert.throws(() => m.stateDiagram({ states: [{ id: 'a' }], transitions: [{ from: 'a', to: 'ghost' }] }), /never declared/);
    assert.throws(() => m.stateDiagram({ states: [{ id: 'a' }], groups: [{ id: 'G', states: ['ghost'] }] }), /never declared/);
    assert.throws(() => m.stateDiagram({ states: [{ id: 'a' }], notes: [{ state: 'ghost', text: 'x' }] }), /never declared/);
    assert.throws(() => m.stateDiagram({ states: [{ id: 'a', className: 'nope' }] }), /no classDef/);
    assert.throws(
      () => m.stateDiagram({ states: [{ id: 'a' }], groups: [{ id: 'G', states: ['a'] }, { id: 'H', states: ['a'] }] }),
      /more than one group/,
    );
    assert.throws(() => m.stateDiagram({ states: [{ id: 'a' }, { id: 'a' }] }), /duplicate/);
  });
});

// ─── gantt ───────────────────────────────────────────────────────────────────

describe('gantt', () => {
  test('reads back as the spec; a task without start or after follows the task before it', () => {
    const model = readGantt(
      m.gantt({
        title: NASTY[1],
        axisFormat: '%m-%d',
        sections: [
          { name: 'Build: core', tasks: [{ id: 't1', label: NASTY[1], start: '2026-01-01', end: '2026-01-05', tags: ['done', 'crit'] }] },
          {
            name: 'Ship',
            tasks: [
              { id: 't2', label: 'second', after: ['t1'], duration: '3d', tags: ['active'] },
              { id: 't3', label: 'third', duration: '1w' },
              { id: 'm1', label: 'release', after: ['t2', 't3'], duration: '1d', tags: ['milestone'] },
            ],
          },
        ],
      }),
    );
    assert.equal(model.title, normalized(NASTY[1]));
    assert.equal(model.dateFormat, 'YYYY-MM-DD');
    assert.equal(model.axisFormat, '%m-%d');
    assert.deepEqual(model.sections.map((s) => s.name), ['Build: core', 'Ship']);
    assert.deepEqual(model.sections[0].tasks, [{ label: normalized(NASTY[1]), data: ['done', 'crit', 't1', '2026-01-01', '2026-01-05'] }]);
    assert.deepEqual(model.sections[1].tasks.map((t) => t.data), [
      ['active', 't2', 'after t1', '3d'],
      ['t3', 'after t2', '1w'],
      ['milestone', 'm1', 'after t2 t3', '1d'],
    ]);
  });

  test('refuses tasks it cannot place', () => {
    const one = (task) => m.gantt({ sections: [{ name: 's', tasks: [task] }] });
    assert.throws(() => one({ id: 't', label: 'x', duration: '1d' }), /first task/);
    assert.throws(() => one({ id: 't', label: 'x', start: '2026-01-01' }), /exactly one of end \/ duration/);
    assert.throws(() => one({ id: 't', label: 'x', start: '2026-01-01', end: '2026-01-02', duration: '1d' }), /exactly one/);
    assert.throws(() => one({ id: 't', label: 'x', start: '2026-13-01', duration: '1d' }), /not YYYY-MM-DD/);
    assert.throws(() => one({ id: 't', label: 'x', start: '2026-01-01', duration: '0d' }), /not like 3d/);
    assert.throws(() => one({ id: 't', label: 'x', after: ['ghost'], duration: '1d' }), /never declared/);
    assert.throws(() => one({ id: 't', label: 'x', start: '2026-01-01', after: ['t'], duration: '1d' }), /both start and after/);
    assert.throws(() => one({ id: 't', label: 'x', start: '2026-01-01', duration: '1d', tags: ['urgent'] }), /unknown tag/);
    assert.throws(() => one({ id: 'done', label: 'x', start: '2026-01-01', duration: '1d' }), /not a safe mermaid id/);
  });
});

// ─── classDiagram ────────────────────────────────────────────────────────────

describe('classDiagram', () => {
  test('reads back as the spec, with member lines that cannot end the class body', () => {
    const model = readClassDiagram(
      m.classDiagram({
        direction: 'LR',
        classes: [
          { id: 'Animal', label: NASTY[0], annotation: 'abstract', members: ['+string name', '-int age; } drop'], methods: ['+speak(loud) string', '+List~T~ items()'] },
          { id: 'Dog' },
          { id: 'Owner' },
        ],
        relations: [
          { from: 'Dog', to: 'Animal', kind: 'inheritance' },
          { from: 'Owner', to: 'Dog', kind: 'aggregation', label: NASTY[1], fromCardinality: '1', toCardinality: '0..*' },
          { from: 'Dog', to: 'Owner', kind: 'dependency' },
          { from: 'Dog', to: 'Animal', kind: 'realization' },
          { from: 'Owner', to: 'Animal', kind: 'composition' },
          { from: 'Owner', to: 'Dog', kind: 'association' },
          { from: 'Owner', to: 'Dog', kind: 'link' },
        ],
      }),
    );
    assert.equal(model.direction, 'LR');
    assert.deepEqual(model.classes, [
      { id: 'Animal', label: normalized(NASTY[0]), annotation: 'abstract', body: ['+string name', '-int age drop', '+speak(loud) string', '+List~T~ items()'] },
      { id: 'Dog', label: undefined, annotation: undefined, body: [] },
      { id: 'Owner', label: undefined, annotation: undefined, body: [] },
    ]);
    assert.deepEqual(
      model.relations.map((r) => [r.from, r.fromCardinality, r.arrow, r.toCardinality, r.to, r.label]),
      [
        ['Dog', undefined, '--|>', undefined, 'Animal', undefined],
        ['Owner', '1', '--o', '0..*', 'Dog', normalized(NASTY[1])],
        ['Dog', undefined, '..>', undefined, 'Owner', undefined],
        ['Dog', undefined, '..|>', undefined, 'Animal', undefined],
        ['Owner', undefined, '--*', undefined, 'Animal', undefined],
        ['Owner', undefined, '-->', undefined, 'Dog', undefined],
        ['Owner', undefined, '--', undefined, 'Dog', undefined],
      ],
    );
  });

  test('refuses undeclared classes, unknown kinds and bad cardinalities', () => {
    const classes = [{ id: 'A' }, { id: 'B' }];
    assert.throws(() => m.classDiagram({ classes, relations: [{ from: 'A', to: 'Ghost', kind: 'link' }] }), /never declared/);
    assert.throws(() => m.classDiagram({ classes, relations: [{ from: 'A', to: 'B', kind: 'friend' }] }), /unknown kind/);
    assert.throws(
      () => m.classDiagram({ classes, relations: [{ from: 'A', to: 'B', kind: 'link', toCardinality: '1" B\n  x' }] }),
      /cardinality/,
    );
  });
});

// ─── erDiagram ───────────────────────────────────────────────────────────────

describe('erDiagram', () => {
  test('reads back as the spec; a comment cannot close its quotes', () => {
    const model = readErDiagram(
      m.erDiagram({
        entities: [
          {
            id: 'USER',
            attributes: [
              { type: 'string', name: 'id', keys: ['PK'], comment: 'the "primary" id\nsecond line' },
              { type: 'varchar(255)', name: 'email', keys: ['UK'] },
              { type: 'int[]', name: 'tags' },
            ],
          },
          { id: 'ORDER', attributes: [{ type: 'string', name: 'user id', keys: ['FK', 'UK'] }] },
          { id: 'EMPTY' },
        ],
        relationships: [
          { left: 'USER', right: 'ORDER', leftCardinality: 'exactly-one', rightCardinality: 'zero-or-more', label: 'places "orders"' },
          { left: 'ORDER', right: 'EMPTY', leftCardinality: 'one-or-more', rightCardinality: 'zero-or-one', identifying: false, label: 'x' },
          { left: 'EMPTY', right: 'USER', leftCardinality: 'zero-or-one', rightCardinality: 'one-or-more', label: 'y' },
        ],
      }),
    );
    assert.deepEqual(model.entities, [
      {
        id: 'USER',
        attributes: [
          { type: 'string', name: 'id', keys: ['PK'], comment: "the 'primary' id second line" },
          { type: 'varchar(255)', name: 'email', keys: ['UK'], comment: undefined },
          { type: 'int[]', name: 'tags', keys: [], comment: undefined },
        ],
      },
      { id: 'ORDER', attributes: [{ type: 'string', name: 'user_id', keys: ['FK', 'UK'], comment: undefined }] },
      { id: 'EMPTY', attributes: [] },
    ]);
    assert.deepEqual(
      model.relationships.map((r) => [r.left, r.leftMark, r.line, r.rightMark, r.right, r.label]),
      [
        ['USER', '||', '--', 'o{', 'ORDER', "places 'orders'"],
        ['ORDER', '}|', '..', 'o|', 'EMPTY', 'x'],
        ['EMPTY', '|o', '--', '|{', 'USER', 'y'],
      ],
    );
  });

  test('refuses undeclared entities, unknown keys and cardinalities', () => {
    const entities = [{ id: 'A' }, { id: 'B' }];
    const rel = { left: 'A', right: 'B', leftCardinality: 'exactly-one', rightCardinality: 'exactly-one', label: 'r' };
    assert.throws(() => m.erDiagram({ entities, relationships: [{ ...rel, right: 'Ghost' }] }), /never declared/);
    assert.throws(() => m.erDiagram({ entities, relationships: [{ ...rel, leftCardinality: 'many' }] }), /unknown cardinality/);
    assert.throws(() => m.erDiagram({ entities: [{ id: 'A', attributes: [{ type: 'int', name: 'x', keys: ['PRIMARY'] }] }] }), /unknown key/);
    assert.throws(() => m.erDiagram({ entities: [{ id: 'A', attributes: [{ type: '9int', name: 'x' }] }] }), /start with a letter/);
  });
});

describe('defect palette', () => {
  test('every defect class and link style is accepted by the flowchart builder', () => {
    const classDefs = Object.values(m.DEFECT_CLASS_DEFS);
    assert.deepEqual(classDefs.map((c) => c.name), ['missing', 'unparsed', 'conflict']);
    const nodes = classDefs.map((c) => ({ id: `n_${c.name}`, className: c.name }));
    const edges = [
      { from: 'n_missing', to: 'n_unparsed', linkStyle: m.DEFECT_LINK_STYLE },
      { from: 'n_unparsed', to: 'n_conflict', linkStyle: m.WARNING_LINK_STYLE },
    ];
    assert.doesNotThrow(() => m.flowchart({ nodes, edges, classDefs }));
  });

  test('the palette is frozen, so one builder cannot recolour another', () => {
    assert.ok(Object.isFrozen(m.DEFECT_CLASS_DEFS));
    assert.ok(Object.isFrozen(m.DEFECT_CLASS_DEFS.missing));
  });
});
