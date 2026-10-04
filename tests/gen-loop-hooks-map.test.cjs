'use strict';

/**
 * gen-loop-hooks-map.cjs — docs/reference/loop-hooks-map.md is generated from
 * the Loop Host Contract, the capability registry, the raw capability.json
 * declarations and the host workflows' `loop render-hooks` call sites (phase 5.6).
 *
 * The acceptance criterion is "regeneration equals the sync check": a document
 * rendered from MODIFIED sources (what the committed file looks like when a
 * capability.json moved and nobody reran the generator) is written to a temp
 * target, and the real `--check` against the real sources must fail.
 *
 * The real-data assertions compare the generator's sources with the registry
 * they come from (counts, order, hosts), never substrings of the document.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const gen = require('../scripts/gen-loop-hooks-map.cjs');
const lhm = require('../gsd-core/bin/lib/loop-hooks-map.cjs');
const { derivedMarker } = require('../gsd-core/bin/lib/mermaid.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');
const { getWiredKinds } = require('../scripts/gen-loop-host-contract.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gen-loop-hooks-map.cjs');

function runGen(args) {
  return runNode([SCRIPT, ...args], { timeoutMs: GENERATOR_SCRIPT_TIMEOUT_MS });
}

describe('gen-loop-hooks-map: the sources are the registry\'s own data', () => {
  const sources = gen.loadSources();
  const map = lhm.buildLoopHooksMap(sources);

  test('the document starts with the derived marker naming this generator', () => {
    const doc = gen.renderLoopHooksMapDoc(sources);
    assert.equal(doc.split('\n')[0], derivedMarker('scripts/gen-loop-hooks-map.cjs'));
  });

  test('every loop point of the contract, in order, with exactly the registry\'s hooks in the registry\'s order', () => {
    assert.deepEqual(map.points.map((p) => p.point), LOOP_HOST_CONTRACT.flatMap((c) => c.points));
    for (const pv of map.points) {
      const reg = registry.byLoopPoint[pv.point];
      assert.deepEqual(pv.steps.map((h) => h.capId), reg.steps.map((h) => h.capId), `${pv.point} steps`);
      assert.deepEqual(pv.gates.map((h) => h.capId), reg.gates.map((h) => h.capId), `${pv.point} gates`);
      assert.deepEqual(pv.contributions.map((h) => h.capId), reg.contributions.map((h) => h.capId), `${pv.point} contributions`);
    }
  });

  test('every capability.json is read raw, and the hosts are the wiring gate\'s own scan', () => {
    const capDirs = fs.readdirSync(path.join(__dirname, '..', 'capabilities'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(__dirname, '..', 'capabilities', e.name, 'capability.json')));
    assert.equal(sources.declared.length, capDirs.length);
    const wired = getWiredKinds();
    const hosted = new Map();
    for (const h of sources.hosts) {
      if (!hosted.has(h.point)) hosted.set(h.point, new Set());
      for (const k of h.kinds) hosted.get(h.point).add(k);
    }
    assert.deepEqual([...hosted.keys()].sort(), [...wired.keys()].sort());
    for (const [point, kinds] of wired) assert.deepEqual([...hosted.get(point)].sort(), [...kinds].sort(), point);
  });

  test('the overview has one hook node per registered hook plus one per dropped declaration', () => {
    const spec = lhm.overviewSpec(map, sources.contract);
    const total = Object.values(registry.byLoopPoint).reduce((n, v) => n + v.steps.length + v.gates.length + v.contributions.length, 0);
    const hookClasses = new Set(['step', 'gate', 'crit', 'contribution', 'missing', 'conflict']);
    // A point is a stadium (red when unhosted); everything else of a hook class is a hook.
    const hookNodes = spec.nodes.filter((n) => hookClasses.has(n.className) && n.shape !== 'stadium');
    assert.equal(hookNodes.length, total + map.dropped.length);
  });
});

describe('gen-loop-hooks-map --check / --write (CLI, --target fixture)', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir('gsd-loop-hooks-map-');
  });
  afterEach(() => {
    cleanup(dir);
  });

  const expectExit = (r, code) => {
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, code, r.stderr);
  };

  test('--write then --check passes', () => {
    const target = path.join(dir, 'loop-hooks-map.md');
    expectExit(runGen(['--write', '--target', target]), 0);
    expectExit(runGen(['--check', '--target', target]), 0);
  });

  for (const [what, mutate] of [
    ['a capability.json declares a hook the registry has not seen', (s) => {
      s.declared.push({ capId: 'fixture', role: 'feature', steps: [{ point: 'plan:pre', ref: { skill: 'x' } }] });
    }],
    ['a capability.json drops a registered gate', (s) => {
      const cap = s.declared.find((c) => (c.gates ?? []).length > 0);
      cap.gates = cap.gates.slice(1);
    }],
    ['a host workflow stops rendering a point', (s) => {
      s.hosts = s.hosts.slice(1);
    }],
    ['an agent file is removed', (s) => {
      s.agents = s.agents.filter((a) => a !== 'gsd-phase-researcher');
    }],
  ]) {
    test(`--check fails when the committed doc predates a source change (${what})`, () => {
      const src = gen.loadSources();
      mutate(src);
      const target = path.join(dir, 'loop-hooks-map.md');
      fs.writeFileSync(target, gen.renderLoopHooksMapDoc(src));
      expectExit(runGen(['--check', '--target', target]), 1);
      expectExit(runGen(['--write', '--target', target]), 0);
      expectExit(runGen(['--check', '--target', target]), 0);
    });
  }

  test('--check fails on a missing document', () => {
    expectExit(runGen(['--check', '--target', path.join(dir, 'absent.md')]), 1);
  });

  test('an unknown flag exits 1 instead of silently printing', () => {
    expectExit(runGen(['--frobnicate']), 1);
  });

  test('the committed docs/reference/loop-hooks-map.md is up to date', () => {
    expectExit(runGen(['--check']), 0);
  });
});
