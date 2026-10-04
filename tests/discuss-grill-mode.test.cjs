// allow-test-rule: source-text-is-the-product
'use strict';

/**
 * discuss-phase grill mode (`--grill` / `workflow.discuss_mode: grill`) —
 * the shipped markdown that routes to it and the mode file the model follows.
 *
 * The markdown IS the product, so it is read as text — but every claim it makes
 * about the CLI is checked against the typed surface instead of trusted: each
 * `gsd_run discuss <sub>` it calls must be a registered subcommand, and the
 * CONTEXT.md / checkpoint examples it tells the model to copy must parse through
 * src/decision-tree.cts with no defects and the attribution they claim.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const GRILL = 'gsd-core/workflows/discuss-phase/modes/grill.md';
const FENCE = '`'.repeat(3);

const dt = require('../gsd-core/bin/lib/decision-tree.cjs');
const { DISCUSS_SUBCOMMANDS } = require('../gsd-core/bin/lib/discuss-command-router.cjs');
const { HOST_COMMAND_ROUTERS } = require('../gsd-core/bin/gsd-tools.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

/** The body of every fenced block in `markdown` with its info string, in order. */
function fencedBlocks(markdown) {
  const blocks = [];
  let cur = null;
  for (const line of splitLines(markdown)) {
    const t = line.trim();
    if (cur === null && t.startsWith(FENCE)) cur = { info: t.slice(3).trim(), lines: [] };
    else if (cur !== null && t === FENCE) {
      blocks.push({ info: cur.info, body: cur.lines.join('\n') });
      cur = null;
    } else if (cur !== null) cur.lines.push(line);
  }
  return blocks;
}

/** The `<step>`-like sections of the mode file: its `## name (…)` headings. */
function sectionNames(markdown) {
  return splitLines(markdown).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).split(' ')[0]);
}

describe('grill mode: routing', () => {
  test('the command advertises --grill and routes it (and discuss_mode grill) to discuss-phase.md', () => {
    const cmd = read('commands/gsd/discuss-phase.md');
    const hint = cmd.match(/^argument-hint: "(.*)"$/m);
    assert.ok(hint && hint[1].split(' ').includes('[--grill]'), 'argument-hint lists [--grill]');
    const process = cmd.slice(cmd.indexOf('<process>'), cmd.indexOf('</process>'));
    assert.ok(/`--grill` is not in the `<arguments>` block/.test(process), 'an explicit --grill wins over discuss_mode assumptions');
    assert.ok(/"grill"/.test(process), 'discuss_mode grill falls through to discuss-phase.md');
  });

  test('the parent workflow loads grill.md lazily for --grill or discuss_mode grill', () => {
    const parent = read('gsd-core/workflows/discuss-phase.md');
    const table = parent.slice(parent.indexOf('<progressive_disclosure>'), parent.indexOf('</progressive_disclosure>'));
    assert.ok(/--grill.*workflow\.discuss_mode: grill.*modes\/grill\.md/.test(table), 'progressive-disclosure row for grill');
    assert.ok(/DISCUSS_MODE=\$\(gsd_run query config-get workflow\.discuss_mode/.test(parent), 'parent resolves discuss_mode itself');
    const required = parent.slice(parent.indexOf('<required_reading>'), parent.indexOf('</required_reading>'));
    assert.ok(!/grill/.test(required), 'grill.md is never eagerly loaded');
  });
});

describe('grill mode: the mode file', () => {
  const grill = read(GRILL);

  test('replaces present_gray_areas and discuss_areas and extends write_context / git_commit', () => {
    assert.deepEqual(sectionNames(grill), ['Combination', 'Setup', 'grill_seed', 'grill_rounds', 'write_context', 'git_commit']);
    assert.ok(/## grill_seed \(replaces present_gray_areas\)/.test(grill));
    assert.ok(/## grill_rounds \(replaces discuss_areas\)/.test(grill));
  });

  test('every gsd_run discuss subcommand it calls is registered', () => {
    assert.equal(typeof HOST_COMMAND_ROUTERS.discuss, 'function');
    const subs = [...grill.matchAll(/gsd_run discuss ([a-z][a-z-]*)/g)].map((m) => m[1]);
    assert.ok(subs.length >= 2, 'the loop and the CONTEXT.md check both call the command');
    for (const s of subs) assert.ok(DISCUSS_SUBCOMMANDS.includes(s), `discuss ${s} is not a subcommand`);
  });

  test('reuses the existing agents and threads their models, with the #2517 omission rule', () => {
    const types = [...grill.matchAll(/subagent_type="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(types)].sort(), ['gsd-advisor-researcher', 'gsd-assumptions-analyzer']);
    for (const agent of types) assert.ok(fs.existsSync(path.join(ROOT, 'agents', `${agent}.md`)), `${agent} exists`);
    assert.ok(/ANALYZER_MODEL=\$\(gsd_run query resolve-model gsd-assumptions-analyzer --raw\)/.test(grill));
    assert.ok(/ADVISOR_MODEL=\$\(gsd_run query resolve-model gsd-advisor-researcher --raw\)/.test(grill));
    assert.ok(grill.includes('<!-- #2517 model-omit-on-inherit -->'));
  });

  test('the CONTEXT.md example parses with the attribution and dependencies it shows', () => {
    const example = fencedBlocks(grill).find((b) => b.info === '' && /\*\*Decided by:\*\*/.test(b.body));
    assert.ok(example, 'write_context shows a decisions example');
    const r = dt.readContextTree(`<decisions>\n### Example\n${example.body}\n</decisions>\n`);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.tree.defects, []);
    assert.deepEqual(r.tree.nodes.map((n) => [n.id, n.decidedBy, n.dependsOn]), [
      ['D-01', 'codebase', []],
      ['D-02', 'recommendation', ['D-01']],
    ]);
    const tree = dt.buildDecisionTree(r.tree.nodes);
    assert.deepEqual(tree.defects, []);
  });

  test('the checkpoint node example is a valid decision_tree entry', () => {
    const example = fencedBlocks(grill).find((b) => b.info === 'json');
    assert.ok(example, 'grill_seed shows the node shape');
    const read = dt.readCheckpointTree({ decision_tree: { nodes: [JSON.parse(example.body)] } });
    assert.deepEqual(read.defects, []);
    assert.equal(read.nodes[0].status, 'open');
  });

  test('names every decided_by value the parser accepts, and no other', () => {
    const named = new Set([...grill.matchAll(/decided_by: "([a-z]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...named].sort(), [...dt.DECIDED_BY].sort());
  });

  test('stays under the new-file cap for workflow markdown (ADR-1610, 32768 bytes)', () => {
    const bytes = Buffer.byteLength(grill.replace(/\r\n/g, '\n'), 'utf8');
    assert.ok(bytes < 32768, `grill.md is ${bytes} bytes`);
  });
});
