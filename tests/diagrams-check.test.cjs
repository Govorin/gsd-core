'use strict';

/**
 * `gsd-tools diagrams check` — the deterministic UML check behind
 * gsd-doc-verifier and the architecture plan:post gate (phase 5.7).
 *
 * Every assertion reads the CLI's JSON result (findings with severity,
 * category, reason and line; per-diagram identifier verdicts) and exit codes —
 * never message text. Projects are real temp git repos, so the declaration
 * index runs over the same file set it would in a user's project.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
const { HOST_COMMAND_ROUTERS } = require('../gsd-core/bin/gsd-tools.cjs');

const fence = (...body) => ['```mermaid', ...body, '```'].join('\n');

describe('gsd-tools diagrams check', () => {
  let root;
  beforeEach(() => {
    root = createTempGitProject('gsd-diagrams-');
    write('src/thing.ts', [
      'export interface IThingRepository {',
      '  findById(id: string): Promise<Thing | null>;',
      '}',
      'export class DrizzleThingRepository implements IThingRepository {',
      '  findById(id: string) { return null; }',
      '}',
      'export class Unrelated {}',
      "export enum OrderStatus { Pending = 'pending', Paid = 'paid' }",
      "export const users = pgTable('users', { id: serial('id'), email: text('email') });",
    ].join('\n'));
    write('app/thing_service.py', 'class ThingService:\n    def create(self, dto):\n        pass\n');
  });
  afterEach(() => {
    cleanup(root);
  });

  function write(rel, text) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  function check(rel, ...extra) {
    const r = runGsdTools(['diagrams', 'check', '--file', rel, ...extra], root);
    assert.equal(r.success, true, r.error);
    return JSON.parse(r.output);
  }
  const verdicts = (json, i = 0) => json.diagrams[i].ids.map((x) => [x.kind, x.owner ? `${x.owner}.${x.id}` : x.id, x.verdict]);
  const brief = (json) => json.findings.map((f) => [f.line, f.severity, f.category, f.reason, f.claim]);

  test('is registered as a host command', () => {
    assert.equal(typeof HOST_COMMAND_ROUTERS.diagrams, 'function');
  });

  test('classDiagram: an invented class or method is a BLOCKER, a missing implements is relation_absent', () => {
    write('docs/arch.md', ['# Arch', '', fence(
      'classDiagram',
      '  class IThingRepository {',
      '    <<interface>>',
      '    +findById(id) Thing',
      '    +deleteAll() void',
      '  }',
      '  class DrizzleThingRepository',
      '  class FakeThingRepository',
      '  class Unrelated',
      '  IThingRepository <|.. DrizzleThingRepository',
      '  IThingRepository <|.. Unrelated',
    )].join('\n'));
    const json = check('docs/arch.md');
    assert.equal(json.ok, true);
    assert.equal(json.mode, 'docs');
    assert.deepEqual(verdicts(json), [
      ['class', 'IThingRepository', 'declared'],
      ['method', 'IThingRepository.findById', 'declared'],
      ['method', 'IThingRepository.deleteAll', 'absent'],
      ['class', 'DrizzleThingRepository', 'declared'],
      ['class', 'FakeThingRepository', 'absent'],
      ['class', 'Unrelated', 'declared'],
    ]);
    assert.deepEqual(brief(json), [
      [8, 'BLOCKER', 'diagram_identifier', 'absent', 'IThingRepository.deleteAll'],
      [11, 'BLOCKER', 'diagram_identifier', 'absent', 'FakeThingRepository'],
      [14, 'BLOCKER', 'diagram_identifier', 'relation_absent', 'Unrelated implements IThingRepository'],
    ]);
    assert.deepEqual([json.blocker_count, json.warning_count, json.strict_failed], [3, 0, false]);
  });

  test('sequenceDiagram: participants by label, calls on the receiver, replies and externals skipped', () => {
    write('docs/seq.md', fence(
      'sequenceDiagram',
      '  %% gsd:external C',
      '  participant C as Client',
      '  participant S as ThingService',
      '  participant R as IThingRepository',
      '  participant X as Payment Provider',
      '  C->>S: create(dto)',
      '  S->>R: findById(id)',
      '  S->>R: purge(id)',
      '  R-->>S: thing',
      '  S->>X: charge(amount)',
    ));
    const json = check('docs/seq.md');
    assert.deepEqual(verdicts(json), [
      ['participant', 'Client', 'external'],
      ['participant', 'ThingService', 'declared'],
      ['participant', 'IThingRepository', 'declared'],
      ['call', 'ThingService.create', 'declared'],
      ['call', 'IThingRepository.findById', 'declared'],
      ['call', 'IThingRepository.purge', 'absent'],
    ]);
    assert.deepEqual(brief(json), [
      [7, 'WARNING', 'diagram_identifier', 'unverifiable', 'Payment Provider'],
      [10, 'BLOCKER', 'diagram_identifier', 'absent', 'IThingRepository.purge'],
    ]);
  });

  test('erDiagram: exact table declared, loose spelling ambiguous, a missing column absent', () => {
    write('docs/er.md', fence(
      'erDiagram',
      '  users {',
      '    serial id PK',
      '    text email',
      '    text phone',
      '  }',
      '  USER',
      '  INVOICE',
    ));
    const json = check('docs/er.md');
    assert.deepEqual(verdicts(json), [
      ['entity', 'users', 'declared'],
      ['attribute', 'users.id', 'declared'],
      ['attribute', 'users.email', 'declared'],
      ['attribute', 'users.phone', 'absent'],
      ['entity', 'USER', 'ambiguous'],
      ['entity', 'INVOICE', 'absent'],
    ]);
  });

  test('stateDiagram: states are checked against %% gsd:source; without it the diagram is one unverifiable warning', () => {
    write('docs/state.md', [
      fence('stateDiagram-v2', '  %% gsd:source src/thing.ts#OrderStatus', '  Pending : waiting', '  state "Paid" as paid', '  Shipped : sent', '  [*] --> Pending'),
      '',
      fence('stateDiagram-v2', '  state "A" as A'),
      '',
      fence('stateDiagram-v2', '  %% gsd:source src/thing.ts#NoSuchEnum', '  state "A" as A'),
    ].join('\n'));
    const json = check('docs/state.md');
    assert.deepEqual(verdicts(json, 0), [
      ['source', 'src/thing.ts#OrderStatus', 'declared'],
      ['state', 'Pending', 'declared'],
      ['state', 'paid', 'declared'],
      ['state', 'Shipped', 'absent'],
    ]);
    assert.deepEqual(verdicts(json, 2), [['source', 'src/thing.ts#NoSuchEnum', 'absent']]);
    assert.deepEqual(brief(json).map((f) => f.slice(0, 4)), [
      [6, 'BLOCKER', 'diagram_identifier', 'absent'],
      [11, 'WARNING', 'diagram_identifier', 'unverifiable'],
      [17, 'BLOCKER', 'diagram_identifier', 'absent'],
    ]);
  });

  test('a block outside the subset is a WARNING at its document line in docs mode; flowcharts are not id-checked', () => {
    write('docs/mixed.md', [
      '# Mixed',
      fence('flowchart LR', '  A --> B & C'),
      fence('flowchart LR', '  Ghost --> Phantom'),
      fence('pie', '  "a": 1'),
    ].join('\n'));
    const json = check('docs/mixed.md');
    assert.deepEqual(json.diagrams.map((d) => [d.line, d.type, d.derived, d.syntax, d.ids.length]), [
      [2, null, false, 'unsupported_construct', 0],
      [6, 'flowchart', false, 'ok', 0],
      [10, null, false, 'unsupported_type', 0],
    ]);
    assert.deepEqual(brief(json).map((f) => f.slice(0, 4)), [
      [4, 'WARNING', 'diagram_syntax', 'unsupported_construct'],
      [11, 'WARNING', 'diagram_syntax', 'unsupported_type'],
    ]);
    assert.equal(json.blocker_count, 0);
  });

  test('a derived marker governs its section (a field table may sit between); a heading ends it; a marker on line 1 covers the document', () => {
    write('docs/er.md', [
      '## Schema',
      '<!-- gsd:derived source=zod-fieldtable — regenerated, do not hand-edit -->',
      '| Field | Type |',
      '|---|---|',
      '| a | string |',
      '',
      fence('erDiagram', '  users'),
      '## Hand-drawn',
      fence('classDiagram', '  class HandInvented'),
    ].join('\n'));
    const json = check('docs/er.md');
    assert.deepEqual(json.diagrams.map((d) => [d.type, d.derived, d.freshness]), [['erDiagram', true, 'unverifiable'], ['classDiagram', false, undefined]]);
    write('docs/gen.md', ['<!-- gsd:derived source=x — regenerated, do not hand-edit -->', '# Generated', fence('flowchart LR', '  A --> B')].join('\n'));
    assert.deepEqual(check('docs/gen.md').diagrams.map((d) => d.derived), [true]);
  });

  // Review M5: a marker is text the checked author can write. It grants
  // nothing unless the block can be regenerated: the names are looked up as
  // written AND the marker is itself a BLOCKER — in docs mode too.
  test('M5: a derived marker that nothing can regenerate is a BLOCKER and its names are still checked', () => {
    write('docs/c.md', [
      '<!-- gsd:derived -->',
      fence('classDiagram', '  class TotallyInventedClass'),
      '## Second',
      '<!-- DERIVED. trust me -->',
      fence('classDiagram', '  class AnotherInvention', '  class Unrelated'),
      '## Third',
      '<!-- gsd:derived source=plan-graph — regenerated, do not hand-edit -->',
      fence('classDiagram', '  class Unrelated'),
      '## Layer graph from a project command',
      '<!-- DERIVED. Regenerate, do not edit. -->',
      fence('flowchart TD', '  ui --> services'),
    ].join('\n'));
    const json = check('docs/c.md');
    assert.deepEqual(json.diagrams.map((d) => [d.type, d.derived, d.freshness]), [
      ['classDiagram', true, 'unverifiable'],
      ['classDiagram', true, 'unverifiable'],
      ['classDiagram', true, 'unverifiable'],
      ['flowchart', true, 'unverifiable'],
    ]);
    assert.deepEqual(json.findings.map((f) => [f.severity, f.category, f.reason, f.claim]), [
      ['BLOCKER', 'diagram_derived', 'derived_unverifiable', 'derived marker'],
      ['BLOCKER', 'diagram_identifier', 'absent', 'TotallyInventedClass'],
      ['BLOCKER', 'diagram_derived', 'derived_unverifiable', 'derived marker'],
      ['BLOCKER', 'diagram_identifier', 'absent', 'AnotherInvention'],
      ['BLOCKER', 'diagram_derived', 'derived_unverifiable', 'source=plan-graph'],
    ]);
    assert.deepEqual(verdicts(json, 2), [['class', 'Unrelated', 'declared']], 'a real name under an unverifiable marker still resolves');
  });

  // Plan 5.7b: a derived block whose marker records its inputs is regenerated
  // and compared. The JSON Schema form of zod-fieldtable runs no project
  // runtime, so the round trip is the real command's own output.
  test('5.7b: a zod-fieldtable block is regenerated from the source its marker records — fresh passes, a stale or hand-edited one is a BLOCKER', () => {
    const schema = (extra) => JSON.stringify({
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'object', properties: { city: { type: 'string' }, ...extra }, required: ['city'] },
      },
      required: ['name', 'address'],
    });
    write('schemas/thing.json', schema({}));
    const gen = runGsdTools(['mn', 'zod-fieldtable', '--json-schema', 'schemas/thing.json', '--export', 'Thing'], root);
    assert.equal(gen.success, true, gen.error);
    const emitted = JSON.parse(gen.output).markdown;
    write('docs/thing.md', `# Thing\n\n${emitted}`);
    const fresh = check('docs/thing.md');
    assert.deepEqual(fresh.diagrams.map((d) => [d.type, d.derived, d.freshness]), [['erDiagram', true, 'fresh']]);
    assert.deepEqual(fresh.findings, [], 'generated entity ids are not looked up in the code once the block is proven fresh');

    write('schemas/thing.json', schema({ zip: { type: 'string' } }));
    const stale = check('docs/thing.md');
    assert.deepEqual(stale.diagrams.map((d) => d.freshness), ['stale']);
    assert.deepEqual(stale.findings.map((f) => [f.severity, f.category, f.reason]), [['BLOCKER', 'diagram_derived', 'derived_stale']]);

    write('schemas/thing.json', schema({}));
    write('docs/thing.md', `# Thing\n\n${emitted.replace('erDiagram', 'erDiagram\n  Invented')}`);
    assert.deepEqual(check('docs/thing.md').findings.map((f) => f.reason), ['derived_stale'], 'a hand edit is caught the same way');

    write('docs/thing.md', `# Thing\n\n${emitted.replace(/source=zod-fieldtable [^—]+—/, 'source=zod-fieldtable —')}`);
    const bare = check('docs/thing.md');
    assert.deepEqual(bare.diagrams.map((d) => d.freshness), ['unverifiable']);
    assert.ok(bare.findings.some((f) => f.reason === 'derived_unverifiable'), JSON.stringify(bare.findings));
  });

  test('5.7b: a derived stateDiagram with %% gsd:source must draw exactly its source\'s members; an authored one may draw a subset', () => {
    const marker = '<!-- gsd:derived source=state-vocabulary — regenerated, do not hand-edit -->';
    write('docs/s.md', [
      '## Complete', marker, fence('stateDiagram-v2', '  %% gsd:source src/thing.ts#OrderStatus', '  [*] --> Pending', '  Pending --> Paid'),
      '## Missing a member', marker, fence('stateDiagram-v2', '  %% gsd:source src/thing.ts#OrderStatus', '  [*] --> Pending'),
      '## Authored subset', fence('stateDiagram-v2', '  %% gsd:source src/thing.ts#OrderStatus', '  [*] --> Pending'),
    ].join('\n'));
    const json = check('docs/s.md');
    assert.deepEqual(json.diagrams.map((d) => [d.derived, d.freshness]), [[true, 'fresh'], [true, 'stale'], [false, undefined]]);
    assert.deepEqual(json.findings.map((f) => [f.severity, f.reason, f.claim]), [['BLOCKER', 'derived_stale', 'Paid']]);
  });

  // Review M4: the probe — implicit states with one that is not in the enum.
  test('M4: implicit states are looked up — an invented one is absent', () => {
    write('docs/m4.md', fence('stateDiagram-v2', '  %% gsd:source src/thing.ts#OrderStatus', '  [*] --> Pending', '  Pending --> Deleted'));
    const json = check('docs/m4.md');
    assert.deepEqual(json.findings.map((f) => [f.severity, f.reason, f.claim]), [['BLOCKER', 'absent', 'Deleted']]);
  });

  test('M4: in design mode a block outside the subset, a stateDiagram without a source and a non-identifier participant are BLOCKERs', () => {
    write('.planning/phases/01-x/01-DESIGN.md', [
      '---', 'contracts_superseded: false', '---',
      '# Design',
      fence('flowchart LR', '  A --> B & C'),
      fence('stateDiagram-v2', '  [*] --> Draft'),
      fence('sequenceDiagram', '  participant X as Payment Provider'),
      '```mermaid',
      'classDiagram',
    ].join('\n'));
    const json = check('.planning/phases/01-x/01-DESIGN.md');
    assert.equal(json.mode, 'design');
    assert.deepEqual(json.findings.map((f) => [f.severity, f.reason]), [
      ['BLOCKER', 'unsupported_construct'],
      ['BLOCKER', 'unverifiable'],
      ['BLOCKER', 'unverifiable'],
      ['BLOCKER', 'unterminated'],
    ]);
  });

  test('design mode: a name the DESIGN.md introduces is planned — until contracts_superseded', () => {
    const design = (superseded) => [
      '---',
      'phase: 01-x',
      `contracts_superseded: ${superseded}`,
      '---',
      '# Phase 1 — Design',
      '## Layer Placement',
      '| What | Layer | NX project | Why not the neighbour |',
      '|------|-------|-----------|----------------------|',
      '| `ThingCache` | services | @x/services | reason |',
      '## Contracts',
      '```typescript',
      'export interface IThingCache {',
      '  warm(id: string): Promise<void>;',
      '}',
      '```',
      '| Schema | Module | Inferred type |',
      '|--------|--------|---------------|',
      '| `CreateThingDto` | `@x/dtos` | `CreateThingDto` |',
      '## Ports & Implementations',
      fence('classDiagram', '  class IThingCache {', '    +warm(id) void', '  }', '  class ThingCache', '  class CreateThingDto', '  class Invented'),
    ].join('\n');
    write('.planning/phases/01-x/01-DESIGN.md', design(false));
    const planned = check('.planning/phases/01-x/01-DESIGN.md');
    assert.equal(planned.mode, 'design');
    assert.deepEqual(verdicts(planned), [
      ['class', 'IThingCache', 'planned'],
      ['method', 'IThingCache.warm', 'planned'],
      ['class', 'ThingCache', 'planned'],
      ['class', 'CreateThingDto', 'planned'],
      ['class', 'Invented', 'absent'],
    ]);
    write('.planning/phases/01-x/01-DESIGN.md', design(true));
    const superseded = check('.planning/phases/01-x/01-DESIGN.md');
    assert.deepEqual(verdicts(superseded).map((v) => v[2]), ['absent', 'absent', 'absent', 'absent']);
    assert.equal(superseded.blocker_count, 4);
    const asDocs = check('.planning/phases/01-x/01-DESIGN.md', '--mode', 'docs');
    assert.equal(asDocs.mode, 'docs');
  });

  test('--strict fails the process on a BLOCKER (after printing the result); warnings alone never do', () => {
    write('docs/bad.md', fence('classDiagram', '  class NotInCode'));
    write('docs/warn.md', fence('flowchart LR', '  A --> B & C'));
    const bad = runGsdTools(['diagrams', 'check', '--file', 'docs/bad.md', '--strict'], root);
    assert.equal(bad.success, false);
    assert.equal(bad.exitCode, 1);
    const warn = runGsdTools(['diagrams', 'check', '--file', 'docs/warn.md', '--strict'], root);
    assert.equal(warn.success, true, warn.error);
    assert.equal(JSON.parse(warn.output).warning_count, 1);
  });

  test('usage and could-not-look failures', () => {
    write('docs/a.md', '# nothing\n');
    for (const args of [
      ['diagrams', 'check'],
      ['diagrams', 'check', '--file'],
      ['diagrams', 'check', '--file', '../outside.md'],
      ['diagrams', 'check', '--file', 'docs/a.md', '--root', '../..'],
      ['diagrams', 'check', '--file', 'docs/a.md', '--mode', 'other'],
      ['diagrams', 'check', '--file', 'docs/missing.md'],
      ['diagrams', 'nope'],
    ]) {
      const r = runGsdTools(args, root);
      assert.equal(r.success, false, args.join(' '));
    }
    // Review L5: a document that cannot be read is not a missing phase — the JSON error names
    // what actually happened.
    const missing = runGsdTools(['--json-errors', 'diagrams', 'check', '--file', 'docs/missing.md'], root);
    assert.equal(missing.success, false);
    assert.equal(JSON.parse(missing.error).reason, 'diagrams_source_unavailable');
    const empty = check('docs/a.md');
    assert.deepEqual([empty.diagram_count, empty.blocker_count, empty.scanned], [0, 0, 0], 'no diagram, no index walk');
  });
});
