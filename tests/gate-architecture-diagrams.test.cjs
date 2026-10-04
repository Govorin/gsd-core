'use strict';

/**
 * `check architecture.diagrams` — the architecture capability's blocking gate
 * at plan:post (phase 5.7). The gate runs `diagrams check` in design mode over
 * the phase's DESIGN.md and blocks only on an `absent` identifier.
 *
 * Assertions read the gate payload (the JSON the plan:post dispatch reads:
 * `block`, `status`, `files`, `findings`) and the capability manifest as data.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');

const MANIFEST = path.join(__dirname, '..', 'capabilities', 'architecture', 'capability.json');

describe('check architecture.diagrams', () => {
  let root;
  const phase = '.planning/phases/03-cache';
  beforeEach(() => {
    root = createTempGitProject('gsd-arch-gate-');
    fs.mkdirSync(path.join(root, phase), { recursive: true });
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'repo.ts'), 'export interface IThingRepository {\n  findById(id: string): void;\n}\n');
  });
  afterEach(() => {
    cleanup(root);
  });

  function design(classes) {
    fs.writeFileSync(path.join(root, phase, '03-DESIGN.md'), [
      '---', 'contracts_superseded: false', '---',
      '## Layer Placement',
      '| What | Layer | NX project | Why not the neighbour |',
      '|---|---|---|---|',
      '| `ThingCache` | services | @x/s | r |',
      '## Ports & Implementations',
      '```mermaid', 'classDiagram', ...classes.map((c) => `  class ${c}`), '```',
    ].join('\n'));
  }
  function gate(...args) {
    const r = runGsdTools(['check', 'architecture.diagrams', ...args], root);
    assert.equal(r.success, true, r.error);
    return JSON.parse(r.output);
  }

  test('no DESIGN.md in the phase: skip, never a block', () => {
    const out = gate(phase);
    assert.deepEqual([out.block, out.passed, out.status, out.files], [false, true, 'no_design', []]);
  });

  test('every diagram identifier declared or planned: pass', () => {
    design(['IThingRepository', 'ThingCache']);
    const out = gate(phase, 'REQ-1');
    assert.deepEqual([out.block, out.status], [false, 'ok']);
    assert.deepEqual(out.files.map((f) => [f.file, f.diagram_count, f.blocker_count]), [[`${phase}/03-DESIGN.md`, 1, 0]]);
  });

  test('an identifier that is neither in the code nor in the design: block, with the finding', () => {
    design(['IThingRepository', 'FakeThingRepository']);
    const out = gate(phase);
    assert.deepEqual([out.block, out.passed, out.status], [true, false, 'absent_identifiers']);
    assert.deepEqual(out.findings.map((f) => [f.file, f.severity, f.reason, f.claim]), [
      [`${phase}/03-DESIGN.md`, 'BLOCKER', 'absent', 'FakeThingRepository'],
    ]);
  });

  test('a warning (a block outside the subset) does not block', () => {
    fs.writeFileSync(path.join(root, phase, '03-DESIGN.md'), '```mermaid\nflowchart LR\n  A --> B & C\n```\n');
    const out = gate(phase);
    assert.deepEqual([out.block, out.findings.map((f) => f.severity)], [false, ['WARNING']]);
  });

  test('a missing phase argument or a path outside the project is a usage failure', () => {
    assert.equal(runGsdTools(['check', 'architecture.diagrams'], root).success, false);
    assert.equal(runGsdTools(['check', 'architecture.diagrams', '../../elsewhere'], root).success, false);
  });

  // Review L4: a phase directory that is not there is not "a phase without a design".
  test('a phase directory that does not exist, or is a file: unresolvable block, never a skip', () => {
    const missing = gate('.planning/phases/99-missing');
    assert.deepEqual([missing.block, missing.passed, missing.status], [true, false, 'unresolvable']);
    fs.writeFileSync(path.join(root, '.planning', 'not-a-dir'), 'x');
    assert.equal(gate('.planning/not-a-dir').status, 'unresolvable');
  });

  test('an empty phase directory is still a skip (boundary of the case above)', () => {
    assert.equal(gate(phase).status, 'no_design');
  });

  test('the capability declares the gate at plan:post behind an opt-in config key, like its other switches', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    const gates = manifest.gates.filter((g) => g.check.query === 'architecture.diagrams');
    assert.deepEqual(gates, [{ point: 'plan:post', check: { query: 'architecture.diagrams' }, when: 'workflow.architecture_diagrams_gate', blocking: true, onError: 'halt' }]);
    assert.equal(manifest.config['workflow.architecture_diagrams_gate'].default, false);
  });
});

describe('check architecture.diagrams in a monorepo sub-project (review M6)', () => {
  // .planning lives in apps/rpg, the code a design names lives in libs/ beside it. An index rooted
  // at the sub-project marked every libs identifier absent — a false BLOCKER.
  let repo;
  let project;
  const phase = '.planning/phases/03-cache';
  beforeEach(() => {
    repo = createTempGitProject('gsd-arch-gate-mono-');
    project = path.join(repo, 'apps', 'rpg');
    fs.mkdirSync(path.join(project, phase), { recursive: true });
    fs.mkdirSync(path.join(repo, 'libs', 'core', 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'libs', 'core', 'src', 'repo.ts'), 'export interface IThingRepository {\n  findById(id: string): void;\n}\n');
    fs.writeFileSync(path.join(project, phase, '03-DESIGN.md'), [
      '## Ports & Implementations',
      '```mermaid', 'classDiagram', '  class IThingRepository', '  class InventedThing', '```',
    ].join('\n'));
  });
  afterEach(() => {
    cleanup(repo);
  });

  test('an identifier declared in libs/ outside the sub-project is found; an invented one still blocks', () => {
    const r = runGsdTools(['check', 'architecture.diagrams', phase], project);
    assert.equal(r.success, true, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.findings.filter((f) => f.severity === 'BLOCKER').map((f) => f.claim), ['InventedThing']);
  });

  test('diagrams check from the sub-project looks across the repository too', () => {
    const r = runGsdTools(['diagrams', 'check', '--file', `${phase}/03-DESIGN.md`], project);
    assert.equal(r.success, true, r.error);
    const out = JSON.parse(r.output);
    assert.deepEqual(out.findings.filter((f) => f.severity === 'BLOCKER').map((f) => f.claim), ['InventedThing']);
  });
});
