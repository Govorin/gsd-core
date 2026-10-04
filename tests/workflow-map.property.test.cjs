'use strict';

/**
 * workflow-map over the real tree — the acceptance of phase 5.5: "every node is
 * an existing step or agent".
 *
 * For every shipped workflow in `gsd-core/workflows/` the map is built from the
 * same committed inputs the generator reads, and each node of each diagram is
 * checked against an independent source:
 *
 *   - a step unit ↔ a `<step name=…>` block (`extractTaggedBlocks` count, names
 *     from the blocks' opening tags); a section unit ↔ an explicit
 *     `parseWorkflowSections` id; a heading unit ↔ an H2 from `tokenizeHeadings`;
 *   - an agent node ↔ `agents/<name>.md` on disk, a runtime built-in, or a
 *     capability agent (`byAgent`) — and an agent that is none of these MUST
 *     carry an `unknown-agent` defect (a nonexistent name is a defect, never a
 *     silent node);
 *   - a loop-point node ↔ `LOOP_HOST_CONTRACT`; a capability node ↔ a step of
 *     `byLoopPoint`; a red "no such step" node ↔ a `dangling-jump` defect.
 *
 * The rendered documents are read back structurally: each mermaid block parsed
 * into node declarations and edges, compared with the spec the builder got.
 *
 * Reading the workflows is reading shipped markdown — the product itself
 * (`source-text-is-the-product`, CONTRIBUTING.md); nothing here greps code.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const wm = require('../gsd-core/bin/lib/workflow-map.cjs');
const m = require('../gsd-core/bin/lib/mermaid.cjs');
const ms = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { parseWorkflowSections } = require('../gsd-core/bin/lib/workflow-fragments.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { LOOP_HOST_CONTRACT } = require('../gsd-core/bin/lib/loop-host-contract.cjs');
const gen = require('../scripts/gen-workflow-maps.cjs');

const ROOT = path.join(__dirname, '..');
const FENCE = '`'.repeat(3);

const sources = gen.loadSources();
const { maps } = gen.renderWorkflowMaps(sources);
const textOf = new Map(sources.workflows.map((w) => [w.name, w.text]));
const contractPoints = new Set(LOOP_HOST_CONTRACT.flatMap((s) => s.points));

function stepNames(text) {
  return ms.scanTaggedBlocks(text, 'step', true).map((b) => (/\bname="([^"]{1,200})"/.exec(b.attributes) ?? [null, ''])[1]);
}

/** Mermaid blocks of a document → [{ nodes: Map<id,label>, edges: [from,to] }], line-based. */
function readDiagrams(markdown) {
  const blocks = [];
  let cur = null;
  for (const line of splitLines(markdown)) {
    if (cur === null && line.trim() === `${FENCE}mermaid`) cur = { nodes: new Map(), edges: [] };
    else if (cur !== null && line.trim() === FENCE) {
      blocks.push(cur);
      cur = null;
    } else if (cur !== null) {
      let mm;
      if ((mm = line.match(/^ +(\w+)(?:\[\[|\{\{|\(\[|\[|\()"(.*)"(?:\]\]|\}\}|\]\)|\]|\))(?::::\w+)?$/))) cur.nodes.set(mm[1], m.unescapeLabel(mm[2]));
      else if ((mm = line.match(/^ +(\w+) (?:-->|-\.->)(?:\|"(?:.*)"\|)? (\w+)$/))) cur.edges.push([mm[1], mm[2]]);
      else if (!/^(?:flowchart \w+| +subgraph \w+\[".*"\]| +end| +direction \w+| +linkStyle \d+ .+| +classDef \w+ .+)$/.test(line)) {
        assert.fail(`unrecognised mermaid line: ${JSON.stringify(line)}`);
      }
    }
  }
  return blocks;
}

describe('workflow maps over the real tree: every node exists', () => {
  test('the tree has maps (sanity: the loader read the workflows)', () => {
    assert.ok(maps.length > 50, `only ${maps.length} maps`);
  });

  for (const map of maps) {
    describe(map.workflow, () => {
      const text = textOf.get(map.workflow);
      const d = wm.workflowMapDiagrams(map, sources.loopHooks);
      const nodes = [...d.flow.nodes, ...(d.calls ? d.calls.nodes : [])];

      test('step units are exactly the <step> blocks; an unclosed opener is a malformed unit with a defect', () => {
        const wellFormed = map.units.filter((u) => u.kind === 'step' && !u.malformed).map((u) => u.name);
        assert.equal(wellFormed.length, ms.extractTaggedBlocks(text, 'step', true).length);
        assert.deepEqual(wellFormed, stepNames(text));
        for (const u of map.units.filter((x) => x.malformed)) {
          assert.ok(map.defects.some((x) => x.kind === 'nested-step' && x.subject === u.name), `no nested-step defect for ${u.name}`);
        }
      });

      test('section units are the explicit gsd:section ids; heading units are real H2 headings', () => {
        const ids = parseWorkflowSections(text).filter((s) => s.explicit).map((s) => s.id);
        assert.deepEqual(map.units.filter((u) => u.kind === 'section').map((u) => u.name), ids);
        const h2 = new Set(ms.tokenizeHeadings(text).filter((h) => h.level === 2).map((h) => h.text));
        for (const u of map.units.filter((x) => x.kind === 'heading')) assert.ok(h2.has(u.name), `no H2 "${u.name}"`);
      });

      test('every agent node is an agents/*.md, a built-in or a capability agent — or carries an unknown-agent defect', () => {
        for (const n of nodes.filter((x) => x.kind === 'agent')) {
          if (n.registry === 'agents') assert.ok(fs.existsSync(path.join(ROOT, 'agents', `${n.name}.md`)), n.name);
          else if (n.registry === 'builtin') assert.ok(wm.BUILTIN_AGENTS.includes(n.name), n.name);
          else if (n.registry === 'capability') assert.ok(Object.hasOwn(registry.byAgent, n.name), n.name);
          else assert.ok(map.defects.some((x) => x.kind === 'unknown-agent' && x.subject === n.name), `unknown ${n.name} is not a defect`);
        }
      });

      test('every unit node is a unit of the map; loop points are in the contract; capability nodes are registry steps', () => {
        const keys = new Set(map.units.map((u) => u.key));
        for (const n of nodes) {
          if (n.kind === 'unit') assert.ok(keys.has(n.unit), n.unit);
          if (n.kind === 'point') assert.equal(n.known, contractPoints.has(n.point), n.point);
          if (n.kind === 'capability-step') {
            const steps = registry.byLoopPoint[n.point].steps;
            assert.ok(steps.some((s) => s.capId === n.capId), `${n.point} ${n.capId}`);
          }
          if (n.kind === 'missing-step') {
            assert.ok(map.defects.some((x) => x.kind === 'dangling-jump' && x.subject === n.token), n.token);
            assert.ok(!map.units.some((u) => u.name === n.token), `${n.token} IS a unit`);
          }
        }
      });

      test('the rendered document reads back into the nodes and edges of the specs', () => {
        const doc = wm.renderWorkflowMapDoc(map, sources.loopHooks);
        const blocks = readDiagrams(doc);
        const specs = [d.flow.spec, ...(d.calls ? [d.calls.spec] : [])];
        assert.equal(blocks.length, specs.length);
        specs.forEach((spec, i) => {
          assert.deepEqual(
            [...blocks[i].nodes].sort(),
            spec.nodes.map((n) => [n.id, m.unescapeLabel(m.escapeLabel(n.label ?? n.id))]).sort(),
          );
          assert.deepEqual(blocks[i].edges, spec.edges.map((e) => [e.from, e.to]));
        });
      });
    });
  }
});

describe('workflow maps over the real tree: counts', () => {
  test('unresolvedJumps counts exactly the jumps that name no unit', () => {
    for (const map of maps) {
      assert.equal(map.unresolvedJumps, map.jumps.filter((j) => j.to === null).length, map.workflow);
    }
  });

  test('every Agent( spawn of a fragment is attributed to a unit that reads that fragment (or to the workflow root)', () => {
    for (const map of maps) {
      for (const s of map.spawns.filter((x) => x.file !== map.path)) {
        assert.ok(
          map.includes.some((i) => i.unit === s.unit) || s.unit === null,
          `${map.workflow}: ${s.file}:${s.line} attributed to ${s.unit}, which reads nothing`,
        );
      }
    }
  });
});
