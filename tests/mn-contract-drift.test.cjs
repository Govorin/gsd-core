'use strict';

/**
 * `gsd_run check mn-contract-drift` — compares a signature DECLARED in the phase DESIGN.md
 * `## Contracts` against the one actually in the code (src/gate-mn-contract-drift.cts; replaces
 * capabilities/mn-verify-gate/scripts/contract-drift.mjs).
 *
 * The defect is one the system admits in its own words (fragments/plan-pre-design.md): "Nothing in
 * the pipeline typechecks across plans". Wave 1 declares a port returning
 * `EitherAsync<RepositoryError, Book>`, wave 2 calls it as `Promise<Book | null>`, both verify green
 * in isolated worktrees, and the mismatch surfaces at integration with no commit to blame.
 *
 * The tests pin, in equal measure, that a real drift is caught and that the gate stays SILENT where
 * it has nothing to compare — nine of nine live DESIGN.md files carry no `## Contracts` section, so a
 * gate demanding one would block every phase. The source root is the project directory.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, writeFiles, runMnCheck } = require('./helpers/mn-gate-fixture.cjs');
const {
  evaluateMnContractDrift,
  normalizeSignature,
  extractDeclaredSignatures,
} = require('../gsd-core/bin/lib/gate-mn-contract-drift.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

const CONTRACT_FIND_BY_ID = [
  '---',
  'phase: 01-ports',
  '---',
  '# DESIGN',
  '',
  '## Contracts',
  '',
  '```typescript',
  'export interface IBookRepository {',
  '  findById(id: BookId): Promise<Either<RepositoryError, Book | null>>;',
  '}',
  '```',
  '',
  '## Notes',
  'prose that must not be parsed for contracts',
  '',
].join('\n');

const DECLARED_FIND_BY_ID = 'findById(BookId):Promise<Either<RepositoryError,Book|null>>';

describe('check mn-contract-drift', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-contract-drift-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function source(name, body) {
    writeFiles(path.join(projectDir, 'src'), { [name]: body });
  }

  /** Evaluate on a fresh phase holding `files` (e.g. `{ 'DESIGN.md': ... }`). */
  function gateOn(files) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnContractDrift({ projectDir, args: [phaseNumber] }).payload;
  }

  // ── the defect the gate exists for ────────────────────────────────────────

  test('catches a return type that drifted from the declared contract, reporting both sides', () => {
    source('book.repository.ts', 'export interface IBookRepository {\n  findById(id: BookId): Promise<Book | null>;\n}\n');
    const v = gateOn({ 'DESIGN.md': CONTRACT_FIND_BY_ID });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.deepEqual(v.drift, [
      { name: 'findById', declared: DECLARED_FIND_BY_ID, actual: 'findById(BookId):Promise<Book|null>', file: 'src/book.repository.ts' },
    ]);
  });

  test('accepts a matching signature regardless of parameter names', () => {
    source('book.repository.ts', 'export interface IBookRepository {\n  findById(bookId: BookId): Promise<Either<RepositoryError, Book | null>>;\n}\n');
    const v = gateOn({ 'DESIGN.md': CONTRACT_FIND_BY_ID });
    assert.equal(v.block, false);
    assert.equal(v.matched, 1);
  });

  test('accepts a matching signature across whitespace and line breaks', () => {
    source('book.repository.ts', 'export interface IBookRepository {\n  findById( id : BookId ) : Promise< Either< RepositoryError , Book | null > >;\n}\n');
    assert.equal(gateOn({ 'DESIGN.md': CONTRACT_FIND_BY_ID }).block, false);
  });

  test('reports a declared symbol that exists nowhere in the sources', () => {
    source('unrelated.ts', 'export const x = 1;\n');
    const v = gateOn({ 'DESIGN.md': CONTRACT_FIND_BY_ID });
    assert.equal(v.block, true);
    assert.deepEqual(v.missing, [{ name: 'findById', declared: DECLARED_FIND_BY_ID }]);
  });

  // ── silence where there is nothing to compare ─────────────────────────────

  test('passes a DESIGN.md with no Contracts section', () => {
    const v = gateOn({ 'DESIGN.md': '---\nphase: x\n---\n# DESIGN\n\nFree-form prose. No contracts declared.\n' });
    assert.equal(v.block, false);
    assert.equal(v.skipped, 'no-contracts');
  });

  test('passes a phase with no DESIGN.md at all', () => {
    const v = gateOn({});
    assert.equal(v.block, false);
    assert.equal(v.skipped, 'no-design');
  });

  test('finds the design file under the name the architect actually writes (NN-DESIGN.md)', () => {
    // Regression: looking for a bare DESIGN.md made the gate read a file nobody creates and pass
    // everything — every live phase design file is named 07.1-DESIGN.md / 09.1-DESIGN.md.
    source('order.port.ts', 'export interface IOrderPort {\n  findPending(): Promise<Order[] | null>;\n}\n');
    const v = gateOn({
      '09.1-DESIGN.md': [
        '---', 'phase: 09.1', '---', '', '## Contracts', '', '```typescript',
        'export interface IOrderPort {', '  findPending(): EitherAsync<OrderError, Order[]>;', '}', '```', '',
      ].join('\n'),
    });
    assert.equal(v.block, true, 'a phase-numbered DESIGN.md must be read, not skipped');
    assert.equal(v.designFile, '09.1-DESIGN.md');
    assert.deepEqual(v.drift.map((d) => d.name), ['findPending']);
  });

  test('passes once contracts_superseded is set', () => {
    source('book.repository.ts', 'export const nothing = 1;\n');
    const v = gateOn({
      'DESIGN.md': '---\nphase: x\ncontracts_superseded: true\n---\n\n## Contracts\n\n```typescript\nfindById(id: BookId): Promise<Nothing>;\n```\n',
    });
    assert.equal(v.block, false);
    assert.equal(v.skipped, 'superseded');
  });

  test('reads only ## Contracts when the template\'s other sections surround it', () => {
    source('book.repository.ts', 'export interface IBookRepository {\n  findById(id: BookId): Promise<Either<RepositoryError, Book | null>>;\n}\n');
    const v = gateOn({
      'DESIGN.md': [
        '---', 'phase: 01', '---', '',
        '## User Route', '', '```mermaid', 'stateDiagram-v2', '  [*] --> DeckList', '  DeckList --> AddWord: tap «Add»', '```', '',
        '## Screen States', '', '| Screen | Loading | Empty |', '|--------|---------|-------|', '| DeckList | spinner | "No decks yet" |', '',
        '## Contracts', '', '```typescript', 'findById(id: BookId): Promise<Either<RepositoryError, Book | null>>;', '```', '',
        '## API Surface', '', '| Method | Path | Request DTO |', '|--------|------|-------------|', '| `POST` | `/things` | `CreateThingDto` |', '',
        '## Error Contract', '', '| Code | HTTP |', '|------|------|', '| `ThingNotFound` | 404 |', '',
      ].join('\n'),
    });
    assert.equal(v.block, false);
    assert.equal(v.declared, 1, 'exactly one signature comes from ## Contracts');
    assert.equal(v.matched, 1);
  });

  test('ignores prose and headings outside the Contracts section', () => {
    const v = gateOn({ 'DESIGN.md': '---\nphase: x\n---\n\n## Notes\n\n```typescript\nghostMethod(a: A): B;\n```\n' });
    assert.equal(v.block, false);
    assert.equal(v.skipped, 'no-contracts');
  });

  test('sources under skipped directories are not read', () => {
    writeFiles(path.join(projectDir, 'node_modules', 'pkg'), {
      'index.ts': 'export interface IBookRepository {\n  findById(id: BookId): Promise<Either<RepositoryError, Book | null>>;\n}\n',
    });
    source('other.ts', 'export const x = 1;\n');
    const v = gateOn({ 'DESIGN.md': CONTRACT_FIND_BY_ID });
    assert.deepEqual(v.missing.map((m) => m.name), ['findById']);
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('a phase that does not exist is unresolvable', () => {
    const v = evaluateMnContractDrift({ projectDir, args: ['42'] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('no phase argument is a usage failure', () => {
    assert.ok(evaluateMnContractDrift({ projectDir, args: [] }).failure);
  });

  test('declared contracts with no TypeScript anywhere in the project are unresolvable', () => {
    const v = gateOn({ 'DESIGN.md': CONTRACT_FIND_BY_ID });
    assert.equal(v.status, 'unresolvable');
    assert.equal(v.declared, 1);
  });

  test('a DESIGN.md that exists but cannot be read is unresolvable', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    source('a.ts', 'export const a = 1;\n');
    const { phaseDir, phaseNumber } = makePhase(projectDir, { 'DESIGN.md': CONTRACT_FIND_BY_ID });
    fs.chmodSync(path.join(phaseDir, 'DESIGN.md'), 0o000);
    const v = evaluateMnContractDrift({ projectDir, args: [phaseNumber] }).payload;
    fs.chmodSync(path.join(phaseDir, 'DESIGN.md'), 0o644);
    assert.equal(v.status, 'unresolvable');
  });

  // ── the normaliser and the extractor ──────────────────────────────────────

  test('normalizeSignature drops names, modifiers, comments and spacing; keeps types', () => {
    assert.equal(
      normalizeSignature('export readonly find( id : Id, /* why */ opts?: Opts ) : Promise< A | B > ; // tail'),
      'find(Id,Opts):Promise<A|B>',
    );
    assert.equal(normalizeSignature('f(a: Map<K, V>, b: [X, Y]): "x"'), "f(Map<K,V>,[X,Y]):'x'");
  });

  test('extractDeclaredSignatures skips structure lines and members without a return type', () => {
    const sigs = extractDeclaredSignatures('## Contracts\n```ts\ninterface X {\n  run();\n  go(a: A): B;\n}\n```\n');
    assert.deepEqual(sigs, [{ name: 'go', signature: 'go(A):B' }]);
  });

  // ── wiring and the CLI ────────────────────────────────────────────────────

  test('the capability registers the gate against workflow.contract_drift through check mn-contract-drift', () => {
    const gate = CAPABILITY.gates.find((g) => g.when === 'workflow.contract_drift');
    assert.ok(gate, 'a gate keyed on workflow.contract_drift must be declared');
    assert.equal(gate.point, 'verify:pre');
    assert.equal(gate.blocking, true, 'a drift that does not block is a report, not a gate');
    assert.deepEqual(gate.check, { query: 'mn-contract-drift' });
    const cfg = CAPABILITY.config['workflow.contract_drift'];
    assert.ok(cfg);
    assert.equal(cfg.type, 'boolean');
    assert.equal(cfg.default, false, 'a new blocking gate ships off and is opted into');
  });

  test('gsd_run check mn-contract-drift "${PHASE_DIR}" prints the verdict', () => {
    source('book.repository.ts', 'export interface IBookRepository {\n  findById(id: BookId): Promise<Book | null>;\n}\n');
    const { phaseDir } = makePhase(projectDir, { 'DESIGN.md': CONTRACT_FIND_BY_ID });
    const payload = runMnCheck(projectDir, 'mn-contract-drift', [path.relative(projectDir, phaseDir)]);
    assert.equal(payload.block, true);
    assert.deepEqual(payload.drift.map((d) => d.name), ['findById']);
  });
});
