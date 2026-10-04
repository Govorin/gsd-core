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

  test('the capability declares the gate at plan:post behind an opt-in config key, like its other switches', () => {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
    const gates = manifest.gates.filter((g) => g.check.query === 'architecture.diagrams');
    assert.deepEqual(gates, [{ point: 'plan:post', check: { query: 'architecture.diagrams' }, when: 'workflow.architecture_diagrams_gate', blocking: true, onError: 'halt' }]);
    assert.equal(manifest.config['workflow.architecture_diagrams_gate'].default, false);
  });
});
