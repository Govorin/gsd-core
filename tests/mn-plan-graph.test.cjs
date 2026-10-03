'use strict';

/**
 * plan-graph.mjs — mermaid for a phase's plans, built from `wave` and `depends_on`.
 *
 * The reason this is code and not a model's drawing: a model-drawn graph invents
 * nodes and edges, and valid mermaid syntax makes the invention read as fact.
 * So every node here must be a *-PLAN.md file and every edge a `depends_on`
 * entry, and the tests below pin that in both directions — nothing missing,
 * nothing added.
 *
 * Defects are drawn, not hidden and not judged: an unknown dependency, a wave
 * that is not strictly later than its dependency, a cycle. The exit code stays 0
 * unless `--strict`, because a renderer that fails on bad news is a renderer
 * people stop running.
 *
 * The output is mermaid text, so the tests parse it into a model (nodes, edges,
 * red edges) and compare models, rather than matching substrings of text the
 * script produced.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const SCRIPT = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'plan-graph.mjs');

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

const OK = 0;
const DEFECTS_STRICT = 1;
const CANNOT_LOOK = 2;

/** Parse the mermaid block into { subgraphs, nodes, edges, red }. */
function parseGraph(stdout) {
  const block = extractFencedBlock(stdout, 'mermaid');
  assert.ok(block !== null, `no mermaid block in output:\n${stdout}`);
  const nodes = new Map();
  const edges = [];
  const red = [];
  const subgraphs = [];
  let current = null;
  for (const line of splitLines(block)) {
    let m;
    if ((m = line.match(/^\s+subgraph \w+\["(.*)"\]$/))) {
      current = m[1];
      subgraphs.push(current);
    } else if (/^\s+end$/.test(line)) {
      current = null;
    } else if ((m = line.match(/^\s+(p_\w+)\["(.*)"\]:::(\w+)$/))) {
      nodes.set(m[1], { label: m[2], cls: m[3], wave: current });
    } else if ((m = line.match(/^\s+(p_\w+) (-->|-\.->) (p_\w+)$/))) {
      edges.push({ from: m[1], to: m[3], dashed: m[2] === '-.->' });
    } else if ((m = line.match(/^\s+linkStyle (\d+) stroke:#d33/))) {
      red.push(Number(m[1]));
    }
  }
  return { subgraphs, nodes, edges, red };
}

describe('plan-graph', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plan-graph-'));
  });
  afterEach(() => {
    cleanup(dir);
  });

  function plan(id, front = {}, name = `${id}-PLAN.md`) {
    const body = Object.entries(front)
      .map(([k, v]) => (v === undefined ? '' : `${k}: ${v}`))
      .filter(Boolean)
      .join('\n');
    fs.writeFileSync(path.join(dir, name), `---\nphase: 01\n${body}\n---\n\n# ${id}\n`);
  }
  function summary(id) {
    fs.writeFileSync(path.join(dir, `${id}-SUMMARY.md`), '---\nphase: 01\n---\n\n# done\n');
  }
  function run(extra = []) {
    return runNode([SCRIPT, '--dir', dir, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
  }
  const graph = (r) => parseGraph(r.stdout);
  const edgePairs = (g) => g.edges.map((e) => `${e.from}>${e.to}${e.dashed ? '?' : ''}`);

  // ── nothing missing, nothing added ────────────────────────────────────────

  test('one node per plan file and one edge per depends_on entry — nothing else', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    plan('01-03', { wave: 3, depends_on: '["01-01", "01-02"]' });

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, OK, r.stderr);
    const g = graph(r);
    assert.deepEqual([...g.nodes.keys()].sort(), ['p_01_01', 'p_01_02', 'p_01_03']);
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02', 'p_01_01>p_01_03', 'p_01_02>p_01_03']);
    assert.deepEqual(g.red, [], 'a clean graph has no red edges');
  });

  test('groups plans into one subgraph per wave, in wave order', () => {
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    plan('01-01', { wave: 1, depends_on: '[]' });

    const g = graph(run());
    assert.deepEqual(g.subgraphs, ['wave 1', 'wave 2']);
    assert.equal(g.nodes.get('p_01_01').wave, 'wave 1');
    assert.equal(g.nodes.get('p_01_02').wave, 'wave 2');
  });

  test('ignores files that are not plans', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    fs.writeFileSync(path.join(dir, 'notes.md'), '---\nwave: 9\n---\n');
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '---\n---\n');

    const g = graph(run());
    assert.deepEqual([...g.nodes.keys()], ['p_01_01']);
  });

  test('puts the derived marker first, so a reader knows not to hand-edit', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    assert.equal(run().stdout.split('\n')[0], '<!-- gsd:derived source=plan-graph — regenerated, do not hand-edit -->');
  });

  // ── the three legal spellings of depends_on ───────────────────────────────

  test('reads depends_on as an inline list, a block list, and an empty list alike', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    // Block list with a blank line inside — legal YAML, and it must not close the list.
    fs.writeFileSync(
      path.join(dir, '01-03-PLAN.md'),
      '---\nphase: 01\nwave: 3\ndepends_on:\n  - 01-01\n\n  - "01-02"\n---\n\n# 01-03\n',
    );

    const g = graph(run());
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02', 'p_01_01>p_01_03', 'p_01_02>p_01_03']);
  });

  test('a plan with no depends_on key at all has no incoming edges', () => {
    plan('01-01', { wave: 1 });
    const g = graph(run());
    assert.deepEqual(g.edges, []);
    assert.equal(g.nodes.size, 1);
  });

  test('keeps decimal-phase ids distinct once sanitised for mermaid', () => {
    plan('02-01', { wave: 1, depends_on: '[]' });
    plan('02.1-01', { wave: 2, depends_on: '["02-01"]' });

    const g = graph(run());
    assert.deepEqual([...g.nodes.keys()].sort(), ['p_02_01', 'p_02_1_01']);
    assert.deepEqual(edgePairs(g), ['p_02_01>p_02_1_01']);
  });

  // ── what the colour means: only what is on disk ───────────────────────────

  test('colours a node by what is recorded: SUMMARY, status, or neither', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    summary('01-01');
    plan('01-02', { wave: 1, depends_on: '[]', status: 'in_progress' });
    plan('01-03', { wave: 1, depends_on: '[]', status: 'superseded' });
    plan('01-04', { wave: 1, depends_on: '[]' });

    const g = graph(run());
    const cls = Object.fromEntries([...g.nodes].map(([k, v]) => [k, v.cls]));
    assert.deepEqual(cls, {
      p_01_01: 'done',
      p_01_02: 'running',
      p_01_03: 'superseded',
      p_01_04: 'pending',
    });
  });

  test('a SUMMARY wins over a leftover in_progress status', () => {
    // Executing and finishing is the normal path; the status stays behind as a
    // record of the run, not as a sign the plan is still going.
    plan('01-01', { wave: 1, depends_on: '[]', status: 'in_progress' });
    summary('01-01');
    assert.equal(graph(run()).nodes.get('p_01_01').cls, 'done');
  });

  // ── defects are drawn, not hidden and not judged ──────────────────────────

  test('draws a dependency on a missing plan as a dashed edge to a marked node', () => {
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });

    const r = run();
    assert.equal(r.exitCode, OK, 'a renderer does not fail on bad news by default');
    const g = graph(r);
    assert.equal(g.nodes.get('p_01_01').cls, 'missing');
    assert.deepEqual(edgePairs(g), ['p_01_01>p_01_02?']);
    assert.deepEqual(g.red, [0]);
    assert.match(r.stdout, /такого плана в каталоге нет/);
  });

  test('draws a wave that is not strictly later than its dependency as a red edge', () => {
    plan('01-01', { wave: 2, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });

    const r = run();
    const g = graph(r);
    assert.deepEqual(g.red, [0]);
    assert.match(r.stdout, /волна должна быть строго позже/);
  });

  test('a dependency on an EARLIER wave is not a defect (boundary: wave 1 → wave 2)', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    assert.deepEqual(graph(run()).red, []);
  });

  test('draws a cycle in red, and names it', () => {
    // No waves here on purpose: with waves a cycle always also breaks the wave
    // rule, and the wave message would hide the cycle. Without them, only the
    // cycle is left to find.
    plan('01-01', { depends_on: '["01-02"]' });
    plan('01-02', { depends_on: '["01-01"]' });

    const r = run();
    const g = graph(r);
    assert.deepEqual(g.red, [0, 1]);
    assert.match(r.stdout, /лежит на цикле/);
  });

  test('does not call an acyclic diamond a cycle', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    plan('01-03', { wave: 2, depends_on: '["01-01"]' });
    plan('01-04', { wave: 3, depends_on: '["01-02", "01-03"]' });
    assert.deepEqual(graph(run()).red, []);
  });

  test('puts a plan with no wave into its own group instead of dropping it', () => {
    plan('01-01', { depends_on: '[]' });
    const g = graph(run());
    assert.deepEqual(g.subgraphs, ['wave не задана']);
    assert.ok(g.nodes.has('p_01_01'));
  });

  // ── exit codes ────────────────────────────────────────────────────────────

  test('--strict exits 1 on a defect and 0 on a clean graph', () => {
    plan('01-02', { wave: 2, depends_on: '["01-09"]' });
    assert.equal(run(['--strict']).exitCode, DEFECTS_STRICT);

    cleanup(dir);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plan-graph-'));
    plan('01-01', { wave: 1, depends_on: '[]' });
    assert.equal(run(['--strict']).exitCode, OK);
  });

  test('--out writes the file and prints a one-line summary instead of the graph', () => {
    plan('01-01', { wave: 1, depends_on: '[]' });
    plan('01-02', { wave: 2, depends_on: '["01-01"]' });
    const target = path.join(dir, 'PLAN-GRAPH.md');

    const r = run(['--out', target]);
    assert.equal(r.exitCode, OK, r.stderr);
    assert.match(r.stdout, /^OK: 2 plan\(s\), 1 edge\(s\), 0 defect\(s\)/);
    assert.deepEqual([...parseGraph(fs.readFileSync(target, 'utf8')).nodes.keys()], ['p_01_01', 'p_01_02']);
  });

  test('exits 2, not 0, when there is nothing to draw', () => {
    // An empty directory is "could not look", not "an empty graph": drawing
    // nothing and reporting success would pass a phase whose plans vanished.
    const r = run();
    assert.equal(r.exitCode, CANNOT_LOOK);
    assert.match(r.stderr, /no \*-PLAN\.md files/);
  });

  test('exits 2 for a missing directory and for a missing --dir argument', () => {
    const gone = runNode([SCRIPT, '--dir', path.join(dir, 'nope')], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(gone.exitCode, CANNOT_LOOK);
    assert.match(gone.stderr, /not found/);

    const bare = runNode([SCRIPT], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(bare.exitCode, CANNOT_LOOK);
    assert.match(bare.stderr, /usage/);
  });
});
