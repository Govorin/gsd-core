'use strict';

/**
 * `gsd-tools mn zod-fieldtable` — the field table and erDiagram of a Zod
 * schema (src/mn-zod-fieldtable.cts, routed by src/mn-command-router.cts).
 *
 * The converter is pure over JSON Schema, so most cases hand it a JSON Schema
 * literal and assert on the typed result: the field rows, and the ErDiagramSpec
 * handed to `mermaid.erDiagram` — never substrings of rendered text. The loader
 * is driven through an injected spawner for every branch (bun missing, bun
 * crashing, each refusal), and once for real when a runtime and `zod` are
 * reachable. The CLI cases assert the JSON result and the `--json-errors`
 * reason.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const zf = require('../gsd-core/bin/lib/mn-zod-fieldtable.cjs');
const { erDiagram, derivedMarker } = require('../gsd-core/bin/lib/mermaid.cjs');

const MAX = Number.MAX_SAFE_INTEGER;

const obj = (properties, required = []) => ({ type: 'object', properties, required });

describe('mn zod-fieldtable: field table', () => {
  test('one row per property, in schema order, with type, required, bounds, values, default', () => {
    const r = zf.buildFieldTable(
      obj(
        {
          title: { type: 'string', minLength: 1, maxLength: 300 },
          email: { type: 'string', format: 'email' },
          kind: { type: 'string', enum: ['a', 'b'] },
          count: { type: 'integer', minimum: 0, default: 3 },
        },
        ['title', 'kind'],
      ),
    );
    assert.equal(r.ok, true);
    assert.equal(r.table.kind, 'object');
    assert.deepEqual(r.table.fields, [
      { name: 'title', type: 'string', required: true, bounds: 'len 1..300', values: '—', default: null },
      { name: 'email', type: 'email', required: false, bounds: '—', values: '—', default: null },
      { name: 'kind', type: 'enum(2)', required: true, bounds: '—', values: 'a \\| b', default: null },
      { name: 'count', type: 'integer', required: false, bounds: '0..∞', values: '—', default: '3' },
    ]);
    assert.equal(r.table.requiredCount, 2);
  });

  test('a word-size integer limit reads as unbounded, a real limit does not (boundary at MAX_SAFE_INTEGER)', () => {
    assert.equal(zf.boundsOf({ type: 'integer', minimum: -MAX, maximum: MAX }), '−∞..∞');
    assert.equal(zf.boundsOf({ type: 'integer', minimum: -(MAX - 1), maximum: MAX - 1 }), `${-(MAX - 1)}..${MAX - 1}`);
    assert.equal(zf.boundsOf({ type: 'array', minItems: 1 }), 'items 1..∞');
    assert.equal(zf.boundsOf({ type: 'string', pattern: '^x$' }), 'pattern');
    assert.equal(zf.boundsOf({ type: 'string', pattern: '^x$', format: 'email' }), '—');
  });

  test('enum values: shown in full up to the preview limit, summarised past it (limit-1, limit, limit+1)', () => {
    const values = (n) => Array.from({ length: n }, (_, i) => `v${i}`);
    const cellFor = (n) => zf.buildFieldTable(obj({ e: { type: 'string', enum: values(n) } })).table.fields[0].values;
    const L = zf.ENUM_PREVIEW;
    assert.equal(cellFor(L - 1), values(L - 1).join(' \\| '));
    assert.equal(cellFor(L), values(L).join(' \\| '));
    assert.equal(cellFor(L + 1), `${values(L).join(' \\| ')} \\| …+1`);
  });

  test('nullable, $ref and arrays are typed by what they hold', () => {
    const schema = {
      ...obj({
        note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        home: { $ref: '#/$defs/Address' },
        tags: { type: 'array', items: { type: 'string' } },
        ghost: { $ref: '#/$defs/Nope' },
      }),
      $defs: { Address: obj({ city: { type: 'string' } }) },
    };
    const types = zf.buildFieldTable(schema).table.fields.map((f) => [f.name, f.type]);
    assert.deepEqual(types, [
      ['note', 'string or null'],
      ['home', 'object'],
      ['tags', 'array<string>'],
      ['ghost', 'any'],
    ]);
  });

  test('an enum schema yields its value set instead of a refusal', () => {
    const r = zf.buildFieldTable({ type: 'string', enum: ['x', 'y', 'z'] });
    assert.deepEqual(r, { ok: true, table: { kind: 'enum', values: ['x', 'y', 'z'] } });
  });

  test('a schema with neither properties nor an enum is refused, not tabulated as empty', () => {
    for (const schema of [{ type: 'string' }, { type: 'object', properties: {} }, {}]) {
      const r = zf.buildFieldTable(schema);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not_an_object_or_enum');
    }
  });
});

describe('mn zod-fieldtable: erDiagram spec', () => {
  test('the root is named after the export, minus a Dto/Schema suffix', () => {
    assert.equal(zf.rootEntityName('journalEntryDto'), 'journalEntry');
    assert.equal(zf.rootEntityName('orderSchema'), 'order');
    assert.equal(zf.rootEntityName('Dto'), 'Root');
  });

  test('a nested object is a relationship whose cardinality follows `required`', () => {
    const { spec, defects } = zf.buildErSpec(
      obj(
        {
          title: { type: 'string' },
          place: obj({ lat: { type: 'number' } }),
          extra: obj({ note: { type: 'string' } }),
        },
        ['title', 'place'],
      ),
      'entryDto',
    );
    assert.deepEqual(defects, []);
    assert.deepEqual(
      spec.entities.map((e) => [e.id, e.attributes.map((a) => `${a.type} ${a.name}`)]),
      [
        ['entry', ['string title']],
        ['Place', ['number lat']],
        ['Extra', ['string note']],
      ],
    );
    assert.deepEqual(
      spec.relationships.map((r) => [r.left, r.leftCardinality, r.rightCardinality, r.right, r.label]),
      [
        ['entry', 'exactly-one', 'exactly-one', 'Place', 'place'],
        ['entry', 'exactly-one', 'zero-or-one', 'Extra', 'extra'],
      ],
    );
  });

  test('an array of objects is one-or-more only when required with minItems ≥ 1 (boundary 0 / 1)', () => {
    const card = (minItems, required) =>
      zf.buildErSpec(
        obj({ lines: { type: 'array', minItems, items: obj({ sku: { type: 'string' } }) } }, required ? ['lines'] : []),
        'orderDto',
      ).spec.relationships[0].rightCardinality;
    assert.equal(card(0, true), 'zero-or-more');
    assert.equal(card(1, true), 'one-or-more');
    assert.equal(card(1, false), 'zero-or-more');
  });

  test('a $defs entry is one shared entity however many properties point at it', () => {
    const schema = {
      ...obj({ billing: { $ref: '#/$defs/Address' }, shipping: { $ref: '#/$defs/Address' } }, ['billing']),
      $defs: { Address: obj({ city: { type: 'string' } }) },
    };
    const { spec } = zf.buildErSpec(schema, 'orderDto');
    assert.deepEqual(spec.entities.map((e) => e.id), ['order', 'Address']);
    assert.deepEqual(
      spec.relationships.map((r) => [r.right, r.rightCardinality, r.label]),
      [
        ['Address', 'exactly-one', 'billing'],
        ['Address', 'zero-or-one', 'shipping'],
      ],
    );
  });

  test('a self-reference (`#`) points back at the root instead of inventing an entity', () => {
    const { spec } = zf.buildErSpec(obj({ name: { type: 'string' }, parent: { $ref: '#' } }), 'nodeDto');
    assert.deepEqual(spec.entities.map((e) => e.id), ['node']);
    assert.deepEqual(spec.relationships.map((r) => [r.left, r.right]), [['node', 'node']]);
  });

  test('an unresolved $ref is a listed defect and a drawn attribute, never dropped', () => {
    const { spec, defects } = zf.buildErSpec(obj({ ghost: { $ref: '#/$defs/Nope' } }), 'xDto');
    assert.deepEqual(defects, [{ kind: 'unresolved-ref', path: 'ghost', ref: '#/$defs/Nope' }]);
    assert.deepEqual(spec.entities[0].attributes.map((a) => [a.type, a.name]), [['unresolved', 'ghost']]);
  });

  test('keys come only from an explicit meta key, never from a name like `id`', () => {
    const { spec } = zf.buildErSpec(
      obj({ id: { type: 'string' }, ref: { type: 'string', key: 'FK' }, code: { type: 'string', key: 'nonsense' } }),
      'xDto',
    );
    assert.deepEqual(spec.entities[0].attributes.map((a) => [a.name, a.keys ?? []]), [
      ['id', []],
      ['ref', ['FK']],
      ['code', []],
    ]);
  });

  test('a property name the ER grammar cannot spell keeps its original in the comment', () => {
    const { spec } = zf.buildErSpec(obj({ '1st': { type: 'string' }, 'a-b': { type: 'string' } }), 'xDto');
    assert.deepEqual(spec.entities[0].attributes.map((a) => [a.name, a.comment]), [
      ['f_1st', '1st'],
      ['a_b', 'a-b'],
    ]);
  });

  test('two inline objects of the same property name stay two entities', () => {
    const { spec } = zf.buildErSpec(
      obj({ a: obj({ meta: obj({ x: { type: 'string' } }) }), b: obj({ meta: obj({ y: { type: 'string' } }) }) }),
      'rootDto',
    );
    const ids = spec.entities.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids.length, 5);
  });

  test('every spec the converter builds is accepted by the mermaid builder (no invented ids)', () => {
    const schema = {
      ...obj(
        {
          title: { type: 'string' },
          place: obj({ lat: { type: 'number' }, tags: { type: 'array', items: obj({ t: { type: 'string' } }) } }),
          billing: { $ref: '#/$defs/Address' },
          ghost: { $ref: '#/$defs/Nope' },
          '9lives': { type: 'integer' },
        },
        ['title'],
      ),
      $defs: { Address: obj({ city: { type: 'string' }, back: { $ref: '#' } }) },
    };
    const { spec } = zf.buildErSpec(schema, 'catDto');
    assert.doesNotThrow(() => erDiagram(spec));
  });
});

const FENCE = '`'.repeat(3);

/** The body of every ```mermaid fence, in order — the document parsed, not searched. */
function mermaidBlocks(markdown) {
  const blocks = [];
  let cur = null;
  for (const line of markdown.split('\n')) {
    if (cur === null && line === `${FENCE}mermaid`) cur = [];
    else if (cur !== null && line === FENCE) {
      blocks.push(cur.join('\n'));
      cur = null;
    } else if (cur !== null) cur.push(line);
  }
  return blocks;
}

describe('mn zod-fieldtable: rendering', () => {
  const doc = (s) => zf.renderFieldTable('xDto', zf.buildFieldTable(s).table, zf.buildErSpec(s, 'xDto'));

  test('the derived marker sits under the heading, so a reader knows not to hand-edit', () => {
    assert.equal(doc(obj({ a: { type: 'string' } })).split('\n')[2], derivedMarker(zf.ZOD_FIELDTABLE_SOURCE));
  });

  // Plan 5.7b: the marker records what the command read, so `diagrams check`
  // can re-run it and compare instead of trusting the marker.
  test('the marker source records the input kind, project-relative target and export, and parses back', () => {
    const cwd = path.join(path.sep, 'p', 'proj');
    const cases = [
      [{ kind: 'file', target: path.join(cwd, 'src', 'thing.schema.ts') }, 'Thing', 'zod-fieldtable file=src/thing.schema.ts export=Thing'],
      [{ kind: 'json-schema', path: path.join(cwd, 'schemas', 'my thing--v2.json') }, 'Thing', 'zod-fieldtable json-schema=schemas/my%20thing%2D-v2.json export=Thing'],
      [{ kind: 'module', target: '@x/dtos' }, 'CreateDto', 'zod-fieldtable module=@x/dtos export=CreateDto'],
    ];
    for (const [source, exportName, expected] of cases) {
      const origin = zf.zodFieldtableOrigin(source, exportName, cwd);
      assert.equal(origin, expected);
      assert.doesNotThrow(() => derivedMarker(origin), 'the marker accepts it: no newline, "--" or ">"');
      const back = zf.parseZodFieldtableOrigin(origin);
      const target = source.kind === 'module' ? source.target : path.relative(cwd, source.kind === 'file' ? source.target : source.path).split(path.sep).join('/');
      assert.deepEqual(back, { kind: source.kind, target, exportName });
    }
    for (const bad of ['zod-fieldtable', 'zod-fieldtable file=a.ts', 'zod-fieldtable other=a.ts export=X', 'zod-fieldtable file=a.ts export=', 'plan-graph file=a export=X', 'zod-fieldtable file=%E0 export=X']) {
      assert.equal(zf.parseZodFieldtableOrigin(bad), null, bad);
    }
  });

  test('runZodFieldtable writes the recorded origin into the marker', (t) => {
    const dir = createTempDir('gsd-zf-origin-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, 'schemas'));
    fs.writeFileSync(path.join(dir, 'schemas', 'a.json'), JSON.stringify(obj({ a: { type: 'string' } })));
    const r = zf.runZodFieldtable({ cwd: dir, source: { kind: 'json-schema', path: path.join(dir, 'schemas', 'a.json') }, exportName: 'A' });
    assert.equal(r.ok, true);
    assert.equal(r.markdown.split('\n')[2], derivedMarker('zod-fieldtable json-schema=schemas/a.json export=A'));
  });

  test('the ER block is exactly the builder output for the spec, and appears only when the schema nests', () => {
    const flat = obj({ a: { type: 'string' } });
    const nested = obj({ a: obj({ b: { type: 'string' } }) });
    assert.deepEqual(mermaidBlocks(doc(flat)), []);
    assert.deepEqual(mermaidBlocks(doc(nested)), [erDiagram(zf.buildErSpec(nested, 'xDto').spec)]);
  });
});

describe('mn zod-fieldtable: loader', () => {
  const answer = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: '', errorCode: null });
  const enoent = { status: null, stdout: '', stderr: '', errorCode: 'ENOENT' };
  const load = (spawn) => zf.loadZodJsonSchema({ cwd: '/p', kind: 'file', target: 'x.ts', exportName: 'xDto', _spawn: spawn, _nodePath: 'node-bin' });

  test('bun is tried first; the inputs travel in the environment, not in the program text', () => {
    const calls = [];
    const r = load((program, args, opts) => {
      calls.push({ program, env: opts.env, cwd: opts.cwd });
      return answer({ ok: true, schema: obj({ a: { type: 'string' } }) });
    });
    assert.equal(r.ok, true);
    assert.equal(r.runtime, 'bun');
    assert.deepEqual(calls.map((c) => c.program), ['bun']);
    assert.deepEqual([calls[0].env.GSD_ZOD_TARGET, calls[0].env.GSD_ZOD_KIND, calls[0].env.GSD_ZOD_EXPORT, calls[0].cwd], ['x.ts', 'file', 'xDto', '/p']);
  });

  test('node takes over only when bun is not installed', () => {
    const programs = [];
    const r = load((program) => {
      programs.push(program);
      return program === 'bun' ? enoent : answer({ ok: true, schema: obj({ a: { type: 'string' } }) });
    });
    assert.deepEqual(programs, ['bun', 'node-bin']);
    assert.equal(r.runtime, 'node');
  });

  test('a bun that starts and gives no answer is reported, not retried under node', () => {
    const programs = [];
    const r = load((program) => {
      programs.push(program);
      return { status: 1, stdout: 'garbage', stderr: 'boom\nstack', errorCode: null };
    });
    assert.deepEqual(programs, ['bun']);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'loader_failed');
  });

  test('every refusal from the runtime keeps its reason; an unknown one is a loader failure', () => {
    for (const reason of ['import_failed', 'no_export', 'no_zod', 'not_zod']) {
      const r = load(() => answer({ ok: false, reason, message: 'm', available: reason === 'no_export' ? ['aDto'] : undefined }));
      assert.equal(r.reason, reason);
      if (reason === 'no_export') assert.deepEqual(r.available, ['aDto']);
    }
    assert.equal(load(() => answer({ ok: false, reason: 'weird' })).reason, 'loader_failed');
    assert.equal(load(() => answer({ ok: true, schema: 'nope' })).reason, 'not_zod');
  });

  test('no runtime at all is its own reason', () => {
    const r = load(() => enoent);
    assert.deepEqual([r.ok, r.reason, r.runtime], [false, 'no_runtime', null]);
  });

  test('the type-strip flag is passed only to a node that needs it (boundary 22.17 / 22.18)', () => {
    assert.deepEqual(zf.nodeTypeStripArgs('22.17.1'), ['--experimental-strip-types']);
    assert.deepEqual(zf.nodeTypeStripArgs('22.18.0'), []);
    assert.deepEqual(zf.nodeTypeStripArgs('24.11.0'), []);
  });
});

describe('gsd-tools mn zod-fieldtable', () => {
  let project;
  beforeEach(() => {
    project = createTempProject('gsd-mn-zod-');
  });
  afterEach(() => cleanup(project));

  const writeSchema = (name, schema) => {
    fs.writeFileSync(path.join(project, name), JSON.stringify(schema));
    return name;
  };
  const reasonOf = (r) => JSON.parse(r.error.trim().split('\n').at(-1));

  test('--json-schema prints the typed result; --raw prints the same document', () => {
    const file = writeSchema('s.json', obj({ title: { type: 'string' }, place: obj({ lat: { type: 'number' } }) }, ['title']));
    const r = runGsdTools(['mn', 'zod-fieldtable', '--json-schema', file, '--export', 'entryDto'], project);
    assert.equal(r.success, true, r.error);
    const result = JSON.parse(r.output);
    assert.deepEqual([result.ok, result.source, result.kind, result.field_count, result.required_count], [true, 'json-schema', 'object', 2, 1]);
    assert.deepEqual(result.er.relationships.map((x) => [x.left, x.right, x.rightCardinality]), [['entry', 'Place', 'zero-or-one']]);
    const raw = runGsdTools(['mn', 'zod-fieldtable', '--json-schema', file, '--export', 'entryDto', '--raw'], project);
    assert.equal(raw.output.trim(), result.markdown.trim());
  });

  test('a missing or doubled source, a missing --export, and a dangling flag are usage errors', () => {
    const file = writeSchema('s.json', obj({ a: { type: 'string' } }));
    for (const args of [
      ['--export', 'x'],
      ['--json-schema', file],
      ['--json-schema', file, '--file', 'a.ts', '--export', 'x'],
      ['--json-schema', '--export', 'x'],
      ['--json-schema', file, '--export'],
    ]) {
      const r = runGsdTools(['mn', 'zod-fieldtable', ...args, '--json-errors'], project);
      assert.equal(r.success, false, args.join(' '));
      assert.equal(reasonOf(r).reason, 'usage', args.join(' '));
    }
  });

  test('a path outside the project is refused before anything is read', () => {
    const outside = createTempDir('gsd-mn-zod-outside-');
    fs.writeFileSync(path.join(outside, 's.json'), JSON.stringify(obj({ a: { type: 'string' } })));
    const r = runGsdTools(['mn', 'zod-fieldtable', '--json-schema', path.join(outside, 's.json'), '--export', 'x', '--json-errors'], project);
    cleanup(outside);
    assert.equal(r.success, false);
    assert.equal(reasonOf(r).reason, 'usage');
  });

  test('a schema with nothing to tabulate is the caller\'s mistake; an unreadable file is a failure to look', () => {
    const file = writeSchema('s.json', { type: 'string' });
    const notTable = runGsdTools(['mn', 'zod-fieldtable', '--json-schema', file, '--export', 'x', '--json-errors'], project);
    assert.deepEqual([reasonOf(notTable).reason, reasonOf(notTable).cause], ['usage', 'not_an_object_or_enum']);
    const gone = runGsdTools(['mn', 'zod-fieldtable', '--json-schema', 'nope.json', '--export', 'x', '--json-errors'], project);
    assert.deepEqual([reasonOf(gone).reason, reasonOf(gone).cause], ['unknown', 'unreadable']);
  });

  test('an unknown mn subcommand is a usage error', () => {
    assert.equal(runGsdTools(['mn', 'frobnicate'], project).success, false);
  });
});

/**
 * The real loader, end to end, when this checkout can provide a runtime and
 * zod (a transitive dev dependency). The project gets zod through a symlinked
 * node_modules entry — the loader must resolve it from the project, never
 * from GSD.
 */
describe('gsd-tools mn zod-fieldtable: real loader', () => {
  let zodDir = null;
  try {
    zodDir = path.dirname(require.resolve('zod/package.json'));
  } catch {
    zodDir = null;
  }
  let project;
  beforeEach(() => {
    project = createTempProject('gsd-mn-zod-real-');
  });
  afterEach(() => cleanup(project));

  test('loads a TypeScript schema module from the project and tabulates it', { skip: zodDir === null && 'zod is not resolvable in this checkout' }, () => {
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.symlinkSync(zodDir, path.join(project, 'node_modules', 'zod'), 'dir');
    fs.mkdirSync(path.join(project, 'libs'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'libs', 'entry.dto.ts'),
      [
        "import { z } from 'zod';",
        "const label: string = 'typed';",
        'export const entryDto = z.object({ title: z.string().max(300), place: z.object({ lat: z.number() }).optional() });',
        'export const unrelated = label;',
        '',
      ].join('\n'),
    );
    const r = runGsdTools(['mn', 'zod-fieldtable', '--file', 'libs/entry.dto.ts', '--export', 'entryDto'], project);
    assert.equal(r.success, true, r.error);
    const result = JSON.parse(r.output);
    assert.equal(result.source, 'loader');
    assert.ok(['bun', 'node'].includes(result.runtime));
    assert.deepEqual(result.fields.map((f) => [f.name, f.type, f.required, f.bounds]), [
      ['title', 'string', true, 'len 0..300'],
      ['place', 'object', false, '—'],
    ]);
    const missing = runGsdTools(['mn', 'zod-fieldtable', '--file', 'libs/entry.dto.ts', '--export', 'nopeDto', '--json-errors'], project);
    assert.equal(JSON.parse(missing.error.trim().split('\n').at(-1)).cause, 'no_export');
  });
});
