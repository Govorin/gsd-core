'use strict';

/**
 * Unit tests for mermaid-parse.cjs (built from src/mermaid-parse.cts) — the
 * strict subset parser that reads a mermaid block into the builders' spec
 * types (phase 5.7).
 *
 * The parser's contract is checked on its typed output only — the spec, the
 * failure reason, line and column — never by matching text:
 *
 *   - every construct of the subset parses into the spec a builder would take;
 *   - every construct outside it is refused with `unsupported_construct` (or
 *     `unsupported_type`, `syntax`, `undeclared_id`) at the right line/column;
 *   - round trip, property-tested for all five builders: parsing a builder's
 *     output yields the spec it was built from (canonicalised the way the
 *     builder itself canonicalises — label normalisation, block order). This
 *     is what makes the parser an oracle for every generator on mermaid.cjs.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const m = require('../gsd-core/bin/lib/mermaid.cjs');
const { parseMermaid, renderParsed } = require('../gsd-core/bin/lib/mermaid-parse.cjs');

function ok(text) {
  const r = parseMermaid(text);
  assert.equal(r.ok, true, r.ok ? '' : `${r.reason} at ${r.line}:${r.col}: ${r.message}`);
  return r;
}

function refused(text) {
  const r = parseMermaid(text);
  assert.equal(r.ok, false, `expected a refusal for:\n${text}`);
  return { reason: r.reason, line: r.line, col: r.col };
}

const lines = (...l) => l.join('\n');

// ─── flowchart ───────────────────────────────────────────────────────────────

describe('flowchart', () => {
  test('shorthand people write parses into the builder spec: unquoted labels, shapes, implicit nodes, text links', () => {
    const r = ok(lines(
      'graph TD',
      '  A[Start] --> B{Ok?}',
      '  B -->|yes| C(("done"))',
      '  B -- "no way" --> A',
      '  C -.-> D([stadium]) ==> E[[sub]]',
      '  E --- F[(db)] -.- G{{hex}} === H(round)',
      '  subgraph S1["Group"]',
      '    direction LR',
      '    I',
      '  end',
      '  classDef hot fill:#f00,stroke:#d33',
      '  class I,A hot',
      '  linkStyle 0 stroke:#d33',
      '  J:::hot;',
    ));
    assert.equal(r.diagram.type, 'flowchart');
    const { spec } = r.diagram;
    assert.equal(spec.direction, 'TD');
    assert.deepEqual(spec.nodes.map((n) => [n.id, n.shape, n.label, n.className]), [
      ['A', 'rect', 'Start', 'hot'], ['B', 'rhombus', 'Ok?', undefined], ['C', 'circle', 'done', undefined],
      ['D', 'stadium', 'stadium', undefined], ['E', 'subroutine', 'sub', undefined], ['F', 'cylinder', 'db', undefined],
      ['G', 'hexagon', 'hex', undefined], ['H', 'round', 'round', undefined], ['I', 'rect', undefined, 'hot'],
      ['J', 'rect', undefined, 'hot'],
    ]);
    assert.deepEqual(spec.edges.map((e) => [e.from, e.to, e.label, e.line ?? 'solid', e.arrow ?? true, e.linkStyle]), [
      ['A', 'B', undefined, 'solid', true, 'stroke:#d33'],
      ['B', 'C', 'yes', 'solid', true, undefined],
      ['B', 'A', 'no way', 'solid', true, undefined],
      ['C', 'D', undefined, 'dotted', true, undefined],
      ['D', 'E', undefined, 'thick', true, undefined],
      ['E', 'F', undefined, 'solid', false, undefined],
      ['F', 'G', undefined, 'dotted', false, undefined],
      ['G', 'H', undefined, 'thick', false, undefined],
    ]);
    assert.deepEqual(spec.subgraphs, [{ id: 'S1', title: 'Group', nodes: ['I'], direction: 'LR' }]);
    assert.deepEqual(r.implicit, ['I', 'J'], 'nodes named only by an edge or a bare line are reported as implicit');
    assert.equal(r.lines['node:C'], 3);
  });

  test('a header without a direction is TB, the mermaid default', () => {
    assert.equal(ok('flowchart\n  A --> B').diagram.spec.direction, 'TB');
  });

  const refusals = [
    ['"&" chaining', 'flowchart LR\n  A --> B & C', 'unsupported_construct', 2, 11],
    ['click', 'flowchart LR\n  A\n  click A "https://x"', 'unsupported_construct', 3, 3],
    ['style', 'flowchart LR\n  A\n  style A fill:#f00', 'unsupported_construct', 3, 3],
    ['init directive', '%%{init: {"theme":"dark"}}%%\nflowchart LR\n  A', 'unsupported_construct', 1, 1],
    ['html in a label', 'flowchart LR\n  A["<b>bold</b>"]', 'unsupported_construct', 2, 6],
    ['a subgraph without an id', 'flowchart LR\n  subgraph My Title\n  end', 'unsupported_construct', 2, 3],
    ['a nested subgraph', 'flowchart LR\n  subgraph a\n  subgraph b\n  end\n  end', 'unsupported_construct', 3, 3],
    ['an asymmetric shape', 'flowchart LR\n  A>flag]', 'unsupported_construct', 2, 4],
    ['a long link', 'flowchart LR\n  A ---> B', 'unsupported_construct', 2, 5],
    ['a circle link end', 'flowchart LR\n  A --o B', 'unsupported_construct', 2, 5],
    ['a bidirectional link', 'flowchart LR\n  A <--> B', 'unsupported_construct', 2, 5],
    ['a hyphenated id', 'flowchart LR\n  user-service --> B', 'unsupported_construct', 2, 7],
    ['a keyword id', 'flowchart LR\n  end --> B', 'unsupported_construct', 2, 3],
    ['an edge to a subgraph', 'flowchart LR\n  subgraph g\n    A\n  end\n  A --> g', 'unsupported_construct', 5, 9],
    ['two statements on a line', 'flowchart LR\n  A --> B; B --> C', 'unsupported_construct', 2, 10],
    ['an unquoted label with parentheses', 'flowchart LR\n  A[call (x)]', 'syntax', 2, 5],
    ['a class without classDef', 'flowchart LR\n  A:::ghost', 'undeclared_id', 2, 1],
    ['a linkStyle beyond the edges', 'flowchart LR\n  A --> B\n  linkStyle 3 stroke:#d33', 'syntax', 3, 3],
    ['an unclosed subgraph', 'flowchart LR\n  subgraph g\n  A', 'syntax', 3, 1],
    ['a pie chart', 'pie\n  "a": 1', 'unsupported_type', 1, 1],
    ['a gantt chart', 'gantt\n  dateFormat YYYY-MM-DD', 'unsupported_type', 1, 1],
  ];
  for (const [name, text, reason, line, col] of refusals) {
    test(`refuses ${name} with its position`, () => {
      assert.deepEqual(refused(text), { reason, line, col });
    });
  }
});

// ─── stateDiagram-v2 ─────────────────────────────────────────────────────────

describe('stateDiagram-v2', () => {
  test('declared states, groups, notes and classes parse into the spec', () => {
    const r = ok(lines(
      'stateDiagram-v2',
      '  direction LR',
      '  classDef bad fill:#fee',
      '  state "Deck list" as DeckList',
      '  AddWord : Add a word',
      '  state "Saving" as Saving {',
      '    state "Pending" as Pending',
      '    [*] --> Pending',
      '    note left of Pending : waits',
      '  }',
      '  [*] --> DeckList',
      '  DeckList --> AddWord: tap «Add»',
      '  class AddWord bad',
    ));
    const { spec } = r.diagram;
    assert.equal(r.diagram.type, 'stateDiagram');
    assert.deepEqual(spec.states, [
      { id: 'DeckList', label: 'Deck list' }, { id: 'AddWord', label: 'Add a word', className: 'bad' }, { id: 'Pending' },
    ]);
    assert.deepEqual(spec.groups, [{ id: 'Saving', states: ['Pending'] }]);
    assert.deepEqual(spec.transitions, [
      { from: '[*]', to: 'Pending' }, { from: '[*]', to: 'DeckList' }, { from: 'DeckList', to: 'AddWord', label: 'tap «Add»' },
    ]);
    assert.deepEqual(spec.notes, [{ state: 'Pending', side: 'left', text: 'waits' }]);
    assert.equal(spec.direction, 'LR');
  });

  test('a state used by a transition but never declared is undeclared_id, not an implicit node', () => {
    assert.deepEqual(refused('stateDiagram-v2\n  [*] --> DeckList'), { reason: 'undeclared_id', line: 2, col: 3 });
  });

  test('a line naming a state of another block is refused (mermaid would duplicate the state)', () => {
    assert.deepEqual(
      refused(lines('stateDiagram-v2', '  state g {', '    A : a', '  }', '  B : b', '  A --> B')),
      { reason: 'unsupported_construct', line: 6, col: 3 },
    );
  });

  for (const [name, text, reason, line] of [
    ['a choice pseudo-state', 'stateDiagram-v2\n  state c <<choice>>', 'unsupported_construct', 2],
    ['a concurrency region', 'stateDiagram-v2\n  A : a\n  --', 'unsupported_construct', 3],
    ['a bare state declaration (mermaid swallows the next composite opener)', 'stateDiagram-v2\n  state Login\n  state g {\n  }', 'unsupported_construct', 2],
    ['a multi-line note', 'stateDiagram-v2\n  A : a\n  note right of A\n  x\n  end note', 'unsupported_construct', 3],
    ['a nested composite state', 'stateDiagram-v2\n  state a {\n    state b {\n    }\n  }', 'unsupported_construct', 3],
    ['a raw ";" in a label', 'stateDiagram-v2\n  A : a\n  B : b\n  A --> B : x;y', 'unsupported_construct', 4],
  ]) {
    test(`refuses ${name}`, () => {
      const r = refused(text);
      assert.deepEqual([r.reason, r.line], [reason, line]);
    });
  }
});

// ─── classDiagram ────────────────────────────────────────────────────────────

describe('classDiagram', () => {
  test('bodies, annotations, colon members and reversed arrows parse into the forward spec', () => {
    const r = ok(lines(
      'classDiagram',
      '  class IThingRepository {',
      '    <<interface>>',
      '    +findById(id) Thing',
      '    +int size',
      '  }',
      '  class Drizzle["Drizzle repo"]',
      '  class Fake',
      '  <<service>> Fake',
      '  Fake : +reset() void',
      '  IThingRepository <|.. Drizzle',
      '  Animal_ <|-- Fake',
      '  class Animal_',
      '  Drizzle "1" *-- "0..*" Fake : owns',
      '  Fake --> Drizzle',
    ));
    const { spec } = r.diagram;
    assert.deepEqual(spec.classes, [
      { id: 'IThingRepository', annotation: 'interface', members: ['+int size'], methods: ['+findById(id) Thing'] },
      { id: 'Drizzle', label: 'Drizzle repo' },
      { id: 'Fake', annotation: 'service', methods: ['+reset() void'] },
      { id: 'Animal_' },
    ]);
    assert.deepEqual(spec.relations, [
      { from: 'Drizzle', to: 'IThingRepository', kind: 'realization' },
      { from: 'Fake', to: 'Animal_', kind: 'inheritance' },
      { from: 'Fake', to: 'Drizzle', kind: 'composition', fromCardinality: '0..*', toCardinality: '1', label: 'owns' },
      { from: 'Fake', to: 'Drizzle', kind: 'association' },
    ]);
    assert.equal(r.lines['method:IThingRepository:0'], 4);
    assert.equal(r.lines['relation:2'], 14);
  });

  for (const [name, text, reason, line] of [
    ['a relation to an undeclared class', 'classDiagram\n  class A\n  A --> Ghost', 'undeclared_id', 3],
    ['a member of an undeclared class', 'classDiagram\n  Ghost : +x()', 'undeclared_id', 2],
    ['a generic class id', 'classDiagram\n  class List~T~', 'unsupported_construct', 2],
    ['angle-bracket generics in a member', 'classDiagram\n  class A {\n    +items() List<T>\n  }', 'unsupported_construct', 3],
    ['a namespace', 'classDiagram\n  namespace x {\n  }', 'unsupported_construct', 2],
    ['a note', 'classDiagram\n  note "hi"', 'unsupported_construct', 2],
    ['a two-headed arrow', 'classDiagram\n  class A\n  class B\n  A <|--|> B', 'unsupported_construct', 4],
    ['a dashed link', 'classDiagram\n  class A\n  class B\n  A .. B', 'unsupported_construct', 4],
    ['an unclosed body', 'classDiagram\n  class A {\n    +x', 'syntax', 3],
  ]) {
    test(`refuses ${name}`, () => {
      const r = refused(text);
      assert.deepEqual([r.reason, r.line], [reason, line]);
    });
  }
});

// ─── erDiagram ───────────────────────────────────────────────────────────────

describe('erDiagram', () => {
  test('attribute blocks, keys, comments and relationships; an entity named only by a relationship is implicit', () => {
    const r = ok(lines(
      'erDiagram',
      '  USER {',
      '    string id PK "the id"',
      '    varchar(255) email UK',
      '    string org_id FK, UK',
      '  }',
      '  USER ||--o{ ORDER : places',
      '  ORDER }|..|| PRODUCT : "contains many"',
    ));
    assert.deepEqual(r.diagram.spec, {
      entities: [
        { id: 'USER', attributes: [
          { type: 'string', name: 'id', keys: ['PK'], comment: 'the id' },
          { type: 'varchar(255)', name: 'email', keys: ['UK'] },
          { type: 'string', name: 'org_id', keys: ['FK', 'UK'] },
        ] },
        { id: 'ORDER' },
        { id: 'PRODUCT' },
      ],
      relationships: [
        { left: 'USER', right: 'ORDER', leftCardinality: 'exactly-one', rightCardinality: 'zero-or-more', label: 'places' },
        { left: 'ORDER', right: 'PRODUCT', leftCardinality: 'one-or-more', rightCardinality: 'exactly-one', label: 'contains many', identifying: false },
      ],
    });
    assert.deepEqual(r.implicit, ['ORDER', 'PRODUCT']);
  });

  for (const [name, text, reason, line] of [
    ['an entity alias', 'erDiagram\n  USER["Users"]', 'unsupported_construct', 2],
    ['word cardinalities', 'erDiagram\n  A one or more--zero or more B : x', 'syntax', 2],
    ['an unknown cardinality mark', 'erDiagram\n  A u|--o{ B : x', 'unsupported_construct', 2],
    ['a hyphenated attribute type', 'erDiagram\n  A {\n    long-text body\n  }', 'unsupported_construct', 3],
  ]) {
    test(`refuses ${name}`, () => {
      const r = refused(text);
      assert.deepEqual([r.reason, r.line], [reason, line]);
    });
  }
});

// ─── sequenceDiagram ─────────────────────────────────────────────────────────

describe('sequenceDiagram', () => {
  test('participants, the four arrows, notes, nested blocks and directives', () => {
    const r = ok(lines(
      'sequenceDiagram',
      '  %% gsd:external C, P',
      '  autonumber',
      '  actor C as Client',
      '  participant S as ThingService',
      '  participant P',
      '  C->>S: create(dto)',
      '  alt charge ok',
      '    S-xP: charge(amount)',
      '    loop retry',
      '      P-->>S: right(receipt)',
      '    end',
      '  else declined',
      '    P--xS: left(ChargeDeclined)',
      '  end',
      '  opt',
      '    Note over S,P: never persisted',
      '    note left of C: waits',
      '  end',
      '  S->>Q: audit(x)',
    ));
    const { spec } = r.diagram;
    assert.deepEqual(r.directives, { external: ['C', 'P'], sources: [] });
    assert.equal(spec.autonumber, true);
    assert.deepEqual(spec.participants, [
      { id: 'C', kind: 'actor', label: 'Client' }, { id: 'S', label: 'ThingService' }, { id: 'P' }, { id: 'Q' },
    ]);
    assert.deepEqual(r.implicit, ['Q']);
    assert.deepEqual(spec.steps, [
      { kind: 'message', from: 'C', to: 'S', text: 'create(dto)' },
      {
        kind: 'alt', label: 'charge ok',
        steps: [
          { kind: 'message', from: 'S', to: 'P', arrow: 'solid-cross', text: 'charge(amount)' },
          { kind: 'loop', label: 'retry', steps: [{ kind: 'message', from: 'P', to: 'S', arrow: 'dotted', text: 'right(receipt)' }] },
        ],
        else: [{ label: 'declined', steps: [{ kind: 'message', from: 'P', to: 'S', arrow: 'dotted-cross', text: 'left(ChargeDeclined)' }] }],
      },
      {
        kind: 'opt',
        steps: [
          { kind: 'note', participants: ['S', 'P'], text: 'never persisted' },
          { kind: 'note', side: 'left', participants: ['C'], text: 'waits' },
        ],
      },
      { kind: 'message', from: 'S', to: 'Q', text: 'audit(x)' },
    ]);
    assert.deepEqual(
      [r.lines['step:0'], r.lines['step:1.0'], r.lines['step:1.1.0'], r.lines['step:1.else0.0'], r.lines['step:3']],
      [7, 9, 11, 14, 20],
    );
  });

  for (const [name, text, reason, line] of [
    ['an open arrow', 'sequenceDiagram\n  A->B: x', 'unsupported_construct', 2],
    ['an async arrow', 'sequenceDiagram\n  A-)B: x', 'unsupported_construct', 2],
    ['activation shorthand', 'sequenceDiagram\n  A->>+B: x', 'unsupported_construct', 2],
    ['activate', 'sequenceDiagram\n  participant A\n  activate A', 'unsupported_construct', 3],
    ['par', 'sequenceDiagram\n  par x\n  end', 'unsupported_construct', 2],
    ['rect', 'sequenceDiagram\n  rect rgb(0,0,0)\n  end', 'unsupported_construct', 2],
    ['a message without text', 'sequenceDiagram\n  A->>B:', 'syntax', 2],
    ['a raw ";" in a message', 'sequenceDiagram\n  A->>B: a;b', 'unsupported_construct', 2],
    ['a participant declared after use', 'sequenceDiagram\n  A->>B: x\n  participant B', 'unsupported_construct', 3],
    ['else outside alt', 'sequenceDiagram\n  opt x\n  else y\n  end', 'syntax', 3],
    ['an unclosed block', 'sequenceDiagram\n  loop x\n  A->>B: y', 'syntax', 3],
    ['a keyword participant id', 'sequenceDiagram\n  participant loop', 'unsupported_construct', 2],
    ['an unknown gsd directive', 'sequenceDiagram\n  %% gsd:externl A\n  A->>B: x', 'unsupported_construct', 2],
  ]) {
    test(`refuses ${name}`, () => {
      const r = refused(text);
      assert.deepEqual([r.reason, r.line], [reason, line]);
    });
  }

  test('nesting: depth 3 parses, depth 4 is refused', () => {
    const nest = (d) => ['sequenceDiagram', ...Array.from({ length: d }, () => 'loop x'), 'A->>B: y', ...Array.from({ length: d }, () => 'end')].join('\n');
    ok(nest(m.SEQUENCE_MAX_DEPTH));
    assert.deepEqual(refused(nest(m.SEQUENCE_MAX_DEPTH + 1)), { reason: 'unsupported_construct', line: 5, col: 1 });
  });

  test('a %% gsd:source directive is returned with its line', () => {
    const r = ok('stateDiagram-v2\n  %% gsd:source src/order.ts#OrderStatus\n  state "A" as A');
    assert.deepEqual(r.directives.sources, [{ path: 'src/order.ts', symbol: 'OrderStatus', line: 2 }]);
  });
});

// ─── The shared corpus (also parsed by the real mermaid, tools/mermaid-check) ──

describe('subset corpus: tests/fixtures/mermaid-subset', () => {
  const dir = path.join(__dirname, 'fixtures', 'mermaid-subset');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.mmd')).sort();
  test('covers all five diagram types', () => {
    const types = new Set(files.map((f) => parseMermaid(fs.readFileSync(path.join(dir, f), 'utf-8'))).filter((r) => r.ok).map((r) => r.diagram.type));
    assert.deepEqual([...types].sort(), ['classDiagram', 'erDiagram', 'flowchart', 'sequenceDiagram', 'stateDiagram']);
  });
  for (const f of files) {
    test(`${f} is inside the subset and rebuilds through its builder`, () => {
      const r = ok(fs.readFileSync(path.join(dir, f), 'utf-8'));
      assert.equal(parseMermaid(renderParsed(r.diagram)).ok, true, 'the canonical rendering parses too');
    });
  }
});

// ─── Round trip: builder output parses back to the builder input ────────────

/** What escapeLabel keeps of a text: CRLF/CR/U+2028/U+2029→LF, tab→space, controls/bidi dropped, trimmed. */
function normalized(s) {
  return s
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim();
}

const NASTY = [
  'He said "hi"; then left', '#1 <b>bold</b> | pipe `tick` a:b {brace} [sq] (round)', 'a -- b --> c --- d - e',
  'literal entity text #59; and #quot; stays literal', 'line one\nline two', 'unicode ✓ фаза 漢字 🚀', 'end', 'x <br/> y',
];
const text = fc.oneof(fc.constantFrom(...NASTY), fc.string({ maxLength: 12 }), fc.string({ unit: 'grapheme', maxLength: 8 }));
const nonEmptyText = text.filter((t) => normalized(t) !== '');
const ids = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const labelOf = (label, id) => {
  if (label === undefined) return undefined;
  const t = normalized(label);
  return t === id ? undefined : t;
};

function canonicalFlowchart(spec) {
  const inSub = new Set((spec.subgraphs ?? []).flatMap((s) => s.nodes));
  const byId = new Map(spec.nodes.map((n) => [n.id, n]));
  const order = [...(spec.subgraphs ?? []).flatMap((s) => s.nodes), ...spec.nodes.filter((n) => !inSub.has(n.id)).map((n) => n.id)];
  const out = {
    direction: spec.direction ?? 'LR',
    nodes: order.map((id) => {
      const n = byId.get(id);
      const node = { id, shape: n.shape ?? 'rect' };
      const label = labelOf(n.label, id);
      if (label !== undefined) node.label = label;
      if (n.className !== undefined) node.className = n.className;
      return node;
    }),
    edges: (spec.edges ?? []).map((e) => {
      const edge = { from: e.from, to: e.to };
      if (e.label !== undefined) edge.label = normalized(e.label);
      if ((e.line ?? 'solid') !== 'solid') edge.line = e.line;
      if (e.arrow === false) edge.arrow = false;
      if (e.linkStyle !== undefined) edge.linkStyle = e.linkStyle;
      return edge;
    }),
  };
  if ((spec.subgraphs ?? []).length > 0) {
    out.subgraphs = spec.subgraphs.map((s) => {
      const sg = { id: s.id, nodes: s.nodes };
      const title = labelOf(s.title, s.id);
      if (title !== undefined) sg.title = title;
      if (s.direction !== undefined) sg.direction = s.direction;
      return sg;
    });
  }
  if ((spec.classDefs ?? []).length > 0) out.classDefs = spec.classDefs;
  return out;
}

const flowchartSpec = fc.integer({ min: 1, max: 6 }).chain((n) => {
  const nodeIds = ids('n', n);
  return fc.record({
    direction: fc.option(fc.constantFrom('LR', 'RL', 'TB', 'TD', 'BT'), { nil: undefined }),
    nodes: fc.tuple(...nodeIds.map((id) => fc.record({
      id: fc.constant(id),
      label: fc.option(text, { nil: undefined }),
      shape: fc.option(fc.constantFrom('rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'rhombus', 'hexagon'), { nil: undefined }),
      className: fc.option(fc.constant('hot'), { nil: undefined }),
    }, { requiredKeys: ['id'] }))),
    edges: fc.array(fc.record({
      from: fc.constantFrom(...nodeIds), to: fc.constantFrom(...nodeIds),
      label: fc.option(text, { nil: undefined }),
      line: fc.option(fc.constantFrom('solid', 'dotted', 'thick'), { nil: undefined }),
      arrow: fc.option(fc.boolean(), { nil: undefined }),
      linkStyle: fc.option(fc.constant('stroke:#d33,stroke-width:2px'), { nil: undefined }),
    }, { requiredKeys: ['from', 'to'] }), { maxLength: 6 }),
    split: fc.integer({ min: 0, max: n }),
    title: fc.option(text, { nil: undefined }),
  }).map(({ split, title, ...spec }) => ({
    ...spec,
    classDefs: [{ name: 'hot', style: 'fill:#fee,stroke:#d33' }],
    subgraphs: split > 0 ? [{ id: 'g0', nodes: nodeIds.slice(0, split), ...(title !== undefined ? { title } : {}) }] : [],
  }));
});

function canonicalState(spec) {
  const groups = spec.groups ?? [];
  const blockOf = new Map();
  for (const g of groups) for (const s of g.states) blockOf.set(s, g.id);
  const block = (t) => (t.from !== '[*]' ? blockOf.get(t.from) ?? '' : t.to !== '[*]' ? blockOf.get(t.to) ?? '' : '');
  const blockOrder = [...groups.map((g) => g.id), ''];
  const byBlock = (items, key) => blockOrder.flatMap((b) => items.filter((it) => key(it) === b));
  const byId = new Map(spec.states.map((s) => [s.id, s]));
  const stateOrder = [...groups.flatMap((g) => g.states), ...spec.states.filter((s) => !blockOf.has(s.id)).map((s) => s.id)];
  const out = {
    states: stateOrder.map((id) => {
      const s = byId.get(id);
      const st = { id };
      const label = labelOf(s.label, id);
      if (label !== undefined) st.label = label;
      if (s.className !== undefined) st.className = s.className;
      return st;
    }),
    transitions: byBlock(spec.transitions ?? [], block).map((t) => {
      const tr = { from: t.from, to: t.to };
      if (t.label !== undefined && normalized(t.label) !== '') tr.label = normalized(t.label);
      return tr;
    }),
  };
  if (spec.direction !== undefined) out.direction = spec.direction;
  if (groups.length > 0) out.groups = groups.map((g) => ({ id: g.id, states: g.states, ...(labelOf(g.label, g.id) !== undefined ? { label: labelOf(g.label, g.id) } : {}) }));
  const notes = byBlock(spec.notes ?? [], (n) => blockOf.get(n.state) ?? '');
  if (notes.length > 0) out.notes = notes.map((n) => ({ state: n.state, side: n.side ?? 'right', text: normalized(n.text) }));
  if ((spec.classDefs ?? []).length > 0) out.classDefs = spec.classDefs;
  return out;
}

const stateSpec = fc.integer({ min: 1, max: 6 }).chain((n) => {
  const stateIds = ids('s', n);
  return fc.record({
    labels: fc.tuple(...stateIds.map(() => fc.option(text, { nil: undefined }))),
    split: fc.integer({ min: 0, max: n }),
    groupLabel: fc.option(text, { nil: undefined }),
    pairs: fc.array(fc.tuple(fc.integer({ min: -1, max: n - 1 }), fc.integer({ min: -1, max: n - 1 }), fc.option(text, { nil: undefined })), { maxLength: 8 }),
    notes: fc.array(fc.tuple(fc.integer({ min: 0, max: n - 1 }), fc.option(fc.constantFrom('left', 'right'), { nil: undefined }), nonEmptyText), { maxLength: 3 }),
    direction: fc.option(fc.constantFrom('LR', 'TB'), { nil: undefined }),
  }).map(({ labels, split, groupLabel, pairs, notes, direction }) => {
    const grouped = new Set(stateIds.slice(0, split));
    const sameBlock = (a, b) => a === -1 || b === -1 || grouped.has(stateIds[a]) === grouped.has(stateIds[b]);
    const ref = (i) => (i === -1 ? '[*]' : stateIds[i]);
    const spec = {
      states: stateIds.map((id, i) => ({ id, ...(labels[i] !== undefined ? { label: labels[i] } : {}), ...(i % 3 === 2 ? { className: 'bad' } : {}) })),
      transitions: pairs.filter(([a, b]) => sameBlock(a, b) && !(a === -1 && b === -1)).map(([a, b, label]) => ({ from: ref(a), to: ref(b), ...(label !== undefined ? { label } : {}) })),
      notes: notes.map(([i, side, t]) => ({ state: stateIds[i], ...(side !== undefined ? { side } : {}), text: t })),
      classDefs: [{ name: 'bad', style: 'fill:#fee' }],
    };
    if (direction !== undefined) spec.direction = direction;
    if (split > 0) spec.groups = [{ id: 'grp', states: stateIds.slice(0, split), ...(groupLabel !== undefined ? { label: groupLabel } : {}) }];
    return spec;
  });
});

const memberText = fc.stringMatching(/^[+\-#~]?[A-Za-z_][A-Za-z0-9_]{0,6}( [A-Za-z_~][A-Za-z0-9_~]{0,6})?$/);
const methodText = fc.stringMatching(/^[+\-#~]?[A-Za-z_][A-Za-z0-9_]{0,6}\([a-z, ]{0,8}\)( [A-Za-z_~][A-Za-z0-9_~]{0,6})?$/);

function canonicalClass(spec) {
  const out = {
    classes: spec.classes.map((c) => {
      const cl = { id: c.id };
      const label = labelOf(c.label, c.id);
      if (label !== undefined) cl.label = label;
      if (c.annotation !== undefined) cl.annotation = c.annotation;
      // The builder collapses runs of spaces in a member line (sanitizeMember).
      const tidy = (list) => (list ?? []).map((t) => t.replace(/ {2,}/g, ' ').trim()).filter(Boolean);
      if (tidy(c.members).length > 0) cl.members = tidy(c.members);
      if (tidy(c.methods).length > 0) cl.methods = tidy(c.methods);
      return cl;
    }),
    relations: (spec.relations ?? []).map((r) => {
      const rel = { from: r.from, to: r.to, kind: r.kind };
      if (r.fromCardinality !== undefined) rel.fromCardinality = r.fromCardinality;
      if (r.toCardinality !== undefined) rel.toCardinality = r.toCardinality;
      if (r.label !== undefined && normalized(r.label) !== '') rel.label = normalized(r.label);
      return rel;
    }),
  };
  if (spec.direction !== undefined) out.direction = spec.direction;
  return out;
}

const classSpec = fc.integer({ min: 1, max: 5 }).chain((n) => {
  const classIds = ids('C', n);
  return fc.record({
    direction: fc.option(fc.constantFrom('LR', 'TB'), { nil: undefined }),
    classes: fc.tuple(...classIds.map((id) => fc.record({
      id: fc.constant(id),
      label: fc.option(text, { nil: undefined }),
      annotation: fc.option(fc.constantFrom('interface', 'abstract', 'service'), { nil: undefined }),
      members: fc.option(fc.array(memberText, { maxLength: 3 }), { nil: undefined }),
      methods: fc.option(fc.array(methodText, { maxLength: 3 }), { nil: undefined }),
    }, { requiredKeys: ['id'] }))),
    relations: fc.array(fc.record({
      from: fc.constantFrom(...classIds), to: fc.constantFrom(...classIds),
      kind: fc.constantFrom('inheritance', 'realization', 'composition', 'aggregation', 'association', 'dependency', 'link'),
      label: fc.option(text, { nil: undefined }),
      fromCardinality: fc.option(fc.constantFrom('1', '0..*', 'many', '*'), { nil: undefined }),
      toCardinality: fc.option(fc.constantFrom('1', '0..1', 'n'), { nil: undefined }),
    }, { requiredKeys: ['from', 'to', 'kind'] }), { maxLength: 5 }),
  }, { requiredKeys: ['classes', 'relations'] });
});

const erWord = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,6}(\(\d{1,3}\)|\[\])?$/);
const erComment = fc.stringMatching(/^[A-Za-z0-9 .,'!?-]{0,12}$/);

function canonicalEr(spec) {
  return {
    entities: spec.entities.map((e) => ((e.attributes ?? []).length > 0
      ? { id: e.id, attributes: e.attributes.map((a) => {
        const at = { type: a.type, name: a.name };
        if ((a.keys ?? []).length > 0) at.keys = a.keys;
        if (a.comment !== undefined && normalized(a.comment) !== '') at.comment = normalized(a.comment);
        return at;
      }) }
      : { id: e.id })),
    relationships: (spec.relationships ?? []).map((r) => ({
      left: r.left, right: r.right, leftCardinality: r.leftCardinality, rightCardinality: r.rightCardinality,
      label: normalized(r.label).replace(/"/g, "'").replace(/\n/g, ' '),
      ...(r.identifying === false ? { identifying: false } : {}),
    })),
  };
}

const card = fc.constantFrom('zero-or-one', 'exactly-one', 'zero-or-more', 'one-or-more');
const erSpec = fc.integer({ min: 1, max: 4 }).chain((n) => {
  const entityIds = ids('E', n);
  return fc.record({
    entities: fc.tuple(...entityIds.map((id) => fc.record({
      id: fc.constant(id),
      attributes: fc.option(fc.array(fc.record({
        type: erWord, name: erWord,
        keys: fc.option(fc.subarray(['PK', 'FK', 'UK']), { nil: undefined }),
        comment: fc.option(erComment, { nil: undefined }),
      }, { requiredKeys: ['type', 'name'] }), { maxLength: 3 }), { nil: undefined }),
    }, { requiredKeys: ['id'] }))),
    relationships: fc.array(fc.record({
      left: fc.constantFrom(...entityIds), right: fc.constantFrom(...entityIds),
      leftCardinality: card, rightCardinality: card,
      identifying: fc.option(fc.boolean(), { nil: undefined }),
      label: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,10}[A-Za-z0-9]$/),
    }, { requiredKeys: ['left', 'right', 'leftCardinality', 'rightCardinality', 'label'] }), { maxLength: 4 }),
  });
});

function canonicalSteps(steps) {
  return steps.map((s) => {
    if (s.kind === 'message') {
      return { kind: 'message', from: s.from, to: s.to, ...((s.arrow ?? 'solid') !== 'solid' ? { arrow: s.arrow } : {}), text: normalized(s.text) };
    }
    if (s.kind === 'note') {
      const side = s.side ?? 'over';
      return { kind: 'note', ...(side !== 'over' ? { side } : {}), participants: s.participants, text: normalized(s.text) };
    }
    const block = { kind: s.kind, steps: canonicalSteps(s.steps) };
    if (s.label !== undefined && normalized(s.label) !== '') block.label = normalized(s.label);
    if ((s.else ?? []).length > 0) {
      block.else = s.else.map((b) => ({ steps: canonicalSteps(b.steps), ...(b.label !== undefined && normalized(b.label) !== '' ? { label: normalized(b.label) } : {}) }));
    }
    return block;
  });
}

function canonicalSequence(spec) {
  const out = {
    participants: spec.participants.map((p) => {
      const pp = { id: p.id };
      if (p.kind === 'actor') pp.kind = 'actor';
      const label = p.label === undefined ? undefined : normalized(p.label);
      if (label !== undefined && label !== '' && label !== p.id) pp.label = label;
      return pp;
    }),
    steps: canonicalSteps(spec.steps ?? []),
  };
  if (spec.autonumber === true) out.autonumber = true;
  return out;
}

const sequenceSpec = fc.integer({ min: 1, max: 4 }).chain((n) => {
  const pids = ids('p', n);
  const message = fc.record({
    kind: fc.constant('message'), from: fc.constantFrom(...pids), to: fc.constantFrom(...pids),
    arrow: fc.option(fc.constantFrom('solid', 'dotted', 'solid-cross', 'dotted-cross'), { nil: undefined }), text: nonEmptyText,
  }, { requiredKeys: ['kind', 'from', 'to', 'text'] });
  const note = fc.oneof(
    fc.record({ kind: fc.constant('note'), participants: fc.subarray(pids, { minLength: 1, maxLength: Math.min(2, n) }), text: nonEmptyText }),
    fc.record({ kind: fc.constant('note'), side: fc.constantFrom('left', 'right'), participants: fc.constantFrom(...pids).map((p) => [p]), text: nonEmptyText }),
  );
  const { step } = fc.letrec((tie) => ({
    step: fc.oneof({ depthSize: 'small', withCrossShrink: true }, message, note, tie('block')),
    block: fc.oneof(
      fc.record({ kind: fc.constantFrom('opt', 'loop'), label: fc.option(text, { nil: undefined }), steps: fc.array(tie('step'), { maxLength: 3 }) }, { requiredKeys: ['kind', 'steps'] }),
      fc.record({
        kind: fc.constant('alt'), label: fc.option(text, { nil: undefined }), steps: fc.array(tie('step'), { maxLength: 2 }),
        else: fc.array(fc.record({ label: fc.option(text, { nil: undefined }), steps: fc.array(tie('step'), { maxLength: 2 }) }, { requiredKeys: ['steps'] }), { maxLength: 2 }),
      }, { requiredKeys: ['kind', 'steps'] }),
    ),
  }));
  const depth = (steps) => Math.max(0, ...steps.map((s) => (s.kind === 'message' || s.kind === 'note' ? 0 : 1 + Math.max(depth(s.steps), ...(s.else ?? []).map((b) => depth(b.steps))))));
  return fc.record({
    participants: fc.tuple(...pids.map((id) => fc.record({ id: fc.constant(id), label: fc.option(text, { nil: undefined }), kind: fc.option(fc.constantFrom('participant', 'actor'), { nil: undefined }) }, { requiredKeys: ['id'] }))),
    steps: fc.array(step, { maxLength: 5 }).filter((s) => depth(s) <= m.SEQUENCE_MAX_DEPTH),
    autonumber: fc.option(fc.boolean(), { nil: undefined }),
  }, { requiredKeys: ['participants', 'steps'] });
});

describe('round trip: parseMermaid(builder(spec)) is the spec, for every builder', () => {
  const cases = [
    ['flowchart', flowchartSpec, m.flowchart, canonicalFlowchart],
    ['stateDiagram', stateSpec, m.stateDiagram, canonicalState],
    ['classDiagram', classSpec, m.classDiagram, canonicalClass],
    ['erDiagram', erSpec, m.erDiagram, canonicalEr],
    ['sequenceDiagram', sequenceSpec, m.sequenceDiagram, canonicalSequence],
  ];
  for (const [type, arb, build, canonical] of cases) {
    test(`property: ${type}`, () => {
      fc.assert(
        fc.property(arb, (spec) => {
          const out = build(spec);
          const r = parseMermaid(out);
          assert.equal(r.ok, true, r.ok ? '' : `${r.reason} at ${r.line}:${r.col}: ${r.message}\n${out}`);
          assert.equal(r.diagram.type, type);
          assert.deepEqual(r.diagram.spec, canonical(spec), out);
          assert.equal(renderParsed(r.diagram), build(r.diagram.spec), 're-rendering the parsed spec is stable');
        }),
        { numRuns: 150 },
      );
    });
  }
});
