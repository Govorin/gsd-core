#!/usr/bin/env node
/**
 * Real-parser conformance for GSD's mermaid subset (phase 5.7, decision 1).
 *
 * The core ships no dependencies, so its own oracle is the builders in
 * src/mermaid.cts and the strict subset parser in src/mermaid-parse.cts. This
 * isolated suite closes the remaining gap — "our grammar accepts it, would
 * mermaid?" — with the real parser (mermaid + jsdom, pinned in this
 * directory's own package.json/lock, never in the core's dependencies and
 * never in `npm test`). It parses:
 *
 *   1. every builder's output for specs whose labels hold every character
 *      escapeLabel must neutralise (the builders' escaping, end to end);
 *   2. every fixture of the subset corpus, tests/fixtures/mermaid-subset/*.mmd
 *      (which the unit suite pins as accepted by our parser);
 *   3. every mermaid block under docs/reference/**.md — and flags DRIFT when
 *      our parser accepts a block the real parser rejects.
 *
 * Run from the repository root: `npm run test:mermaid-real` (builds lib, installs
 * this directory with `npm ci`, then runs this script). Exit 1 on any failure.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const lib = (name) => require(path.join(ROOT, 'gsd-core', 'bin', 'lib', `${name}.cjs`));

const builders = lib('mermaid');
const { parseMermaid } = lib('mermaid-parse');
const { scanFencedBlocks } = lib('markdown-sectionizer');

// mermaid sanitizes labels with DOMPurify, which needs a window.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;
globalThis.Element = dom.window.Element;
globalThis.HTMLElement = dom.window.HTMLElement;
const { default: mermaid } = await import('mermaid');
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

const NASTY = [
  'He said "hi"; then left',
  '#1 <b>bold</b> | pipe `tick` a:b {brace} [sq] (round)',
  'a -- b --> c --- d - e',
  'literal entity text #59; and #quot; stays literal',
  'line one\nline two',
  'unicode ✓ фаза 漢字 🚀 — em dash',
  'end',
];

/** Builder outputs over hostile labels — one per builder, plus a minimal one each. */
function builderCorpus() {
  const out = [];
  const add = (name, fn) => {
    out.push({ source: `builder:${name}`, text: fn() });
  };
  add('flowchart', () => builders.flowchart({
    direction: 'LR',
    nodes: NASTY.map((label, i) => ({ id: `n${i}`, label, shape: ['rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'rhombus', 'hexagon'][i % 8], className: i === 0 ? 'hot' : undefined })),
    edges: NASTY.slice(1).map((label, i) => ({ from: 'n0', to: `n${i + 1}`, label, line: ['solid', 'dotted', 'thick'][i % 3], arrow: i % 2 === 0, linkStyle: i === 0 ? 'stroke:#d33,stroke-width:2px' : undefined })),
    subgraphs: [{ id: 'g0', title: NASTY[0], nodes: ['n1', 'n2'], direction: 'TB' }],
    classDefs: [{ name: 'hot', style: 'fill:#fee,stroke:#d33' }],
  }));
  add('stateDiagram', () => builders.stateDiagram({
    direction: 'LR',
    states: NASTY.map((label, i) => ({ id: `s${i}`, label, className: i === 1 ? 'bad' : undefined })),
    groups: [{ id: 'grp', label: NASTY[1], states: ['s5', 's6'] }],
    transitions: [
      { from: '[*]', to: 's0', label: NASTY[2] }, { from: 's0', to: 's1', label: NASTY[0] }, { from: 's5', to: 's6', label: NASTY[3] }, { from: 's4', to: '[*]' },
    ],
    notes: [{ state: 's1', side: 'left', text: NASTY[1] }, { state: 's6', text: NASTY[4] }],
    classDefs: [{ name: 'bad', style: 'fill:#fee' }],
  }));
  add('classDiagram', () => builders.classDiagram({
    direction: 'TB',
    classes: [
      { id: 'Animal', label: NASTY[0], annotation: 'abstract', members: ['+string name', '-int age'], methods: ['+speak(loud) string', '+List~T~ items()'] },
      { id: 'Dog' }, { id: 'Owner', label: NASTY[5] },
    ],
    relations: [
      { from: 'Dog', to: 'Animal', kind: 'inheritance' },
      { from: 'Owner', to: 'Dog', kind: 'aggregation', label: NASTY[1], fromCardinality: '1', toCardinality: '0..*' },
      { from: 'Dog', to: 'Owner', kind: 'dependency' }, { from: 'Dog', to: 'Animal', kind: 'realization' },
      { from: 'Owner', to: 'Animal', kind: 'composition' }, { from: 'Owner', to: 'Dog', kind: 'association' }, { from: 'Owner', to: 'Dog', kind: 'link' },
    ],
  }));
  add('erDiagram', () => builders.erDiagram({
    entities: [
      { id: 'USER', attributes: [{ type: 'string', name: 'id', keys: ['PK'], comment: NASTY[0] }, { type: 'varchar(255)', name: 'email', keys: ['UK'] }, { type: 'int[]', name: 'tags' }] },
      { id: 'ORDER', attributes: [{ type: 'string', name: 'user_id', keys: ['FK', 'UK'] }] },
      { id: 'EMPTY' },
    ],
    relationships: [
      { left: 'USER', right: 'ORDER', leftCardinality: 'exactly-one', rightCardinality: 'zero-or-more', label: NASTY[0] },
      { left: 'ORDER', right: 'EMPTY', leftCardinality: 'one-or-more', rightCardinality: 'zero-or-one', identifying: false, label: 'x' },
    ],
  }));
  add('sequenceDiagram', () => builders.sequenceDiagram({
    autonumber: true,
    participants: [{ id: 'C', label: NASTY[5], kind: 'actor' }, { id: 'S', label: NASTY[1] }, { id: 'P' }],
    steps: [
      ...NASTY.map((text, i) => ({ kind: 'message', from: 'C', to: 'S', arrow: ['solid', 'dotted', 'solid-cross', 'dotted-cross'][i % 4], text })),
      {
        kind: 'alt', label: NASTY[0],
        steps: [{ kind: 'loop', label: NASTY[3], steps: [{ kind: 'opt', steps: [{ kind: 'message', from: 'S', to: 'P', text: 'charge(amount)' }] }] }],
        else: [{ label: NASTY[6], steps: [{ kind: 'note', participants: ['S', 'P'], text: NASTY[1] }] }],
      },
      { kind: 'note', side: 'left', participants: ['C'], text: NASTY[2] },
    ],
  }));
  add('gantt', () => builders.gantt({
    title: NASTY[1],
    sections: [{ name: NASTY[0], tasks: [{ id: 't1', label: NASTY[2], start: '2026-01-01', duration: '3d', tags: ['done'] }, { id: 't2', label: NASTY[3], duration: '1d' }] }],
  }));
  return out;
}

function fixtureCorpus() {
  const dir = path.join(ROOT, 'tests', 'fixtures', 'mermaid-subset');
  return readdirSync(dir).filter((f) => f.endsWith('.mmd')).sort().map((f) => ({
    source: `fixture:${f}`,
    text: readFileSync(path.join(dir, f), 'utf-8'),
  }));
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

function docsCorpus() {
  const out = [];
  for (const file of walk(path.join(ROOT, 'docs', 'reference'))) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    for (const b of scanFencedBlocks(lines)) {
      if (b.closeLineIdx === -1 || b.infoString.split(/\s/)[0].toLowerCase() !== 'mermaid') continue;
      out.push({
        source: `${path.relative(ROOT, file)}:${b.openLineIdx + 1}`,
        text: lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n'),
        doc: true,
      });
    }
  }
  return out;
}

let failures = 0;
let drift = 0;
const corpus = [...builderCorpus(), ...fixtureCorpus(), ...docsCorpus()];
for (const item of corpus) {
  let real = 'ok';
  try {
    await mermaid.parse(item.text);
  } catch (err) {
    real = String(err?.message ?? err).split('\n').slice(0, 3).join(' | ');
  }
  const ours = item.doc ? parseMermaid(item.text) : null;
  if (real !== 'ok') {
    failures++;
    const isDrift = ours !== null && ours.ok;
    if (isDrift) drift++;
    console.log(`FAIL ${item.source}${isDrift ? ' (DRIFT: the subset parser accepts it)' : ''}\n     ${real}`);
  } else {
    console.log(`ok   ${item.source}${ours !== null && !ours.ok ? ` (outside the subset: ${ours.reason})` : ''}`);
  }
}
console.log(`\n${corpus.length} block(s): ${corpus.length - failures} accepted by mermaid, ${failures} rejected (${drift} drift)`);
process.exit(failures === 0 ? 0 : 1);
