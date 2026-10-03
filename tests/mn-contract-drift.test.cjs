'use strict';

/**
 * contract-drift.mjs — the gate that compares a signature DECLARED in
 * DESIGN.md `## Contracts` against the one actually in the code.
 *
 * The defect it exists for is one the system admits in its own words
 * (capabilities/mn-verify-gate/fragments/plan-pre-design.md): "Nothing in the
 * pipeline typechecks across plans". Wave 1 declares a port returning
 * `EitherAsync<RepoError, Book>`, wave 2 calls it as `Promise<Book | null>`,
 * both waves verify green in isolated worktrees, and the mismatch surfaces at
 * integration with no single commit to blame.
 *
 * The tests below pin two things in equal measure: that a real drift is caught,
 * and that the gate stays SILENT everywhere it has nothing to compare. The
 * second half is what keeps it switched on — measured on the live project, nine
 * of nine DESIGN.md files carry no `## Contracts` section at all, so a gate
 * demanding one would block every phase on the day it shipped.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'contract-drift.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

/** Exit codes are the gate's contract: 0 pass, 1 drift, 2 could-not-look. */
const PASS = 0;
const DRIFT = 1;
const CANNOT_LOOK = 2;

describe('contract-drift gate', () => {
  let tmp;
  let phaseDir;
  let srcDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-contract-drift-'));
    phaseDir = path.join(tmp, 'phase');
    srcDir = path.join(tmp, 'src');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmp);
  });

  function writeDesign(body) {
    fs.writeFileSync(path.join(phaseDir, 'DESIGN.md'), body);
  }

  function writeSource(name, body) {
    fs.writeFileSync(path.join(srcDir, name), body);
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, '--root', srcDir, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
  }

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

  // ── the defect the gate exists for ────────────────────────────────────────

  test('catches a return type that drifted from the declared contract', () => {
    writeDesign(CONTRACT_FIND_BY_ID);
    // The exact cross-wave shape: Either dropped, bare Promise written instead.
    writeSource(
      'book.repository.ts',
      'export interface IBookRepository {\n' +
        '  findById(id: BookId): Promise<Book | null>;\n' +
        '}\n',
    );

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, DRIFT, `expected a drift exit, got ${r.exitCode}: ${r.stderr}`);
    assert.match(r.stderr, /DRIFT\s+findById/);
    // Both sides must be reported — naming only one leaves the reader guessing
    // which of the two is wrong.
    assert.match(r.stderr, /declared:.*Either<RepositoryError,Book\|null>/);
    assert.match(r.stderr, /actual:.*Promise<Book\|null>/);
  });

  test('accepts a matching signature regardless of parameter names', () => {
    writeDesign(CONTRACT_FIND_BY_ID);
    // `bookId` vs the declared `id`: the same contract. A parameter name is not
    // part of what crosses a plan boundary; the type is.
    writeSource(
      'book.repository.ts',
      'export interface IBookRepository {\n' +
        '  findById(bookId: BookId): Promise<Either<RepositoryError, Book | null>>;\n' +
        '}\n',
    );

    const r = run();
    assert.equal(r.exitCode, PASS, `expected a pass, got ${r.exitCode}: ${r.stderr}`);
    assert.match(r.stdout, /1 declared signature\(s\) match/);
  });

  test('accepts a matching signature across whitespace and line breaks', () => {
    writeDesign(CONTRACT_FIND_BY_ID);
    writeSource(
      'book.repository.ts',
      'export interface IBookRepository {\n' +
        '  findById( id : BookId ) : Promise< Either< RepositoryError , Book | null > >;\n' +
        '}\n',
    );

    const r = run();
    assert.equal(r.exitCode, PASS, `formatting must not read as drift: ${r.stderr}`);
  });

  test('reports a declared symbol that exists nowhere in the sources', () => {
    writeDesign(CONTRACT_FIND_BY_ID);
    writeSource('unrelated.ts', 'export const x = 1;\n');

    const r = run();
    assert.equal(r.exitCode, DRIFT);
    assert.match(r.stderr, /MISSING\s+findById/);
  });

  // ── silence where there is nothing to compare ─────────────────────────────
  //
  // Each of these is a real shape on the live project. If any of them blocked,
  // the gate would be switched off within a day and would then protect nothing.

  test('passes a DESIGN.md with no Contracts section', () => {
    writeDesign('---\nphase: x\n---\n# DESIGN\n\nFree-form prose. No contracts declared.\n');

    const r = run(['--verbose']);
    assert.equal(r.exitCode, PASS, `a section-less DESIGN.md must not block: ${r.stderr}`);
    assert.match(r.stdout, /nothing to check/);
  });

  test('passes a phase with no DESIGN.md at all', () => {
    const r = run(['--verbose']);
    assert.equal(r.exitCode, PASS);
    assert.match(r.stdout, /no DESIGN\.md/);
  });

  test('finds the design file under the name the architect actually writes', () => {
    // Regression, and the reason this gate had never fired on a real phase:
    // the script looked for a bare `DESIGN.md`, while the producer writes
    // `{phase_dir}/{padded_phase}-DESIGN.md` (gsd-system-architect.md:24,
    // capabilities/architecture/fragments/plan-pre.md:12). A phase-numbered
    // file therefore hit the "no DESIGN.md" branch and exited 0 — so even with
    // workflow.architecture_design AND workflow.contract_drift both on, the
    // gate read a file nobody creates and passed everything.
    //
    // Measured on two live projects: every phase-level design file found was
    // named 07.1-DESIGN.md / 09.1-DESIGN.md; not one bare DESIGN.md existed in
    // a phase directory. Suffix matching mirrors check-frontmatter.mjs:58, so
    // two scripts in one capability cannot disagree about what a phase
    // artifact is called.
    fs.writeFileSync(
      path.join(phaseDir, '09.1-DESIGN.md'),
      [
        '---',
        'phase: 09.1',
        '---',
        '',
        '## Contracts',
        '',
        '```typescript',
        'export interface IOrderPort {',
        '  findPending(): EitherAsync<OrderError, Order[]>;',
        '}',
        '```',
        '',
      ].join('\n')
    );
    writeSource(
      'order.port.ts',
      'export interface IOrderPort {\n  findPending(): Promise<Order[] | null>;\n}\n'
    );

    const r = run();
    assert.notEqual(
      r.exitCode,
      PASS,
      `a phase-numbered DESIGN.md must be read, not skipped: ${r.stdout}${r.stderr}`
    );
    assert.match(`${r.stdout}${r.stderr}`, /findPending/);
  });

  test('passes once contracts_superseded is set', () => {
    // After execution the code IS the contract and the section is a historical
    // snapshot — the template says so. Comparing against it would report drift
    // for every legitimate refactor that followed.
    writeDesign(
      '---\nphase: x\ncontracts_superseded: true\n---\n\n' +
        '## Contracts\n\n```typescript\nfindById(id: BookId): Promise<Nothing>;\n```\n',
    );
    writeSource('book.repository.ts', 'export const nothing = 1;\n');

    const r = run(['--verbose']);
    assert.equal(r.exitCode, PASS, `a superseded contract must not block: ${r.stderr}`);
    assert.match(r.stdout, /superseded/);
  });

  test('reads only ## Contracts when the template\'s other sections surround it', () => {
    // DESIGN.md carries User Route, Screen States, API Surface and Error Contract
    // alongside Contracts, several of them containing tables and a mermaid block.
    // The parser must stop at the next `##` and not drag any of it in.
    writeDesign([
      '---', 'phase: 01', '---',
      '',
      '## User Route',
      '',
      '```mermaid',
      'stateDiagram-v2',
      '  [*] --> DeckList',
      '  DeckList --> AddWord: tap «Add»',
      '```',
      '',
      '## Screen States',
      '',
      '| Screen | Loading | Empty |',
      '|--------|---------|-------|',
      '| DeckList | spinner | "No decks yet" |',
      '',
      '## Contracts',
      '',
      '```typescript',
      'findById(id: BookId): Promise<Either<RepositoryError, Book | null>>;',
      '```',
      '',
      '## API Surface',
      '',
      '| Method | Path | Request DTO |',
      '|--------|------|-------------|',
      '| `POST` | `/things` | `CreateThingDto` |',
      '',
      '## Error Contract',
      '',
      '| Code | HTTP |',
      '|------|------|',
      '| `ThingNotFound` | 404 |',
      '',
    ].join('\n'));
    writeSource(
      'book.repository.ts',
      'export interface IBookRepository {\n' +
        '  findById(id: BookId): Promise<Either<RepositoryError, Book | null>>;\n' +
        '}\n',
    );

    const r = run();
    assert.equal(r.exitCode, PASS, `surrounding sections must not confuse the parser: ${r.stderr}`);
    assert.match(r.stdout, /1 declared signature\(s\) match/,
      'exactly one signature comes from ## Contracts — not the DTO names in API Surface');
  });

  test('ignores prose and headings outside the Contracts section', () => {
    // A signature quoted in a Notes section is an illustration, not a contract.
    writeDesign(
      '---\nphase: x\n---\n\n## Notes\n\n```typescript\nghostMethod(a: A): B;\n```\n',
    );

    const r = run();
    assert.equal(r.exitCode, PASS, `only ## Contracts is authoritative: ${r.stderr}`);
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('exits 2 when the phase directory does not exist', () => {
    const r = runNode(
      [SCRIPT, '--dir', path.join(tmp, 'no-such-phase'), '--root', srcDir],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
    assert.equal(r.exitCode, CANNOT_LOOK, '"could not look" must be distinct from "found nothing"');
  });

  test('exits 2 when --dir is omitted', () => {
    const r = runNode([SCRIPT, '--root', srcDir], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK);
  });

  test('exits 2 when the source root holds no TypeScript at all', () => {
    // Declared contracts with nothing to compare them against is a broken
    // invocation, not a clean bill of health.
    writeDesign(CONTRACT_FIND_BY_ID);
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty, { recursive: true });

    const r = runNode([SCRIPT, '--dir', phaseDir, '--root', empty], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK, `an unverifiable run must not report success: ${r.stdout}`);
  });

  // ── the gate is declared, not just present on disk ────────────────────────

  test('the capability registers the gate against workflow.contract_drift', () => {
    // A capability manifest IS the deployed contract — the runtime reads this
    // JSON to decide what runs. A script nothing dispatches is the exact defect
    // class this fork exists to close.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'capability.json'),
        'utf8',
      ),
    );

    const gate = (manifest.gates || []).find((g) => g.when === 'workflow.contract_drift');
    assert.ok(gate, 'a gate keyed on workflow.contract_drift must be declared');
    assert.equal(gate.point, 'verify:pre');
    assert.equal(gate.blocking, true, 'a drift that does not block is a report, not a gate');
    assert.equal(gate.check.predicate.kind, 'command-exit-zero');
    assert.match(gate.check.predicate.command, /contract-drift\.mjs/);

    const cfg = manifest.config['workflow.contract_drift'];
    assert.ok(cfg, 'the gate must own a config key so it can be switched off');
    assert.equal(cfg.type, 'boolean');
    assert.equal(cfg.default, false, 'a new blocking gate ships off and is opted into');
  });
});
