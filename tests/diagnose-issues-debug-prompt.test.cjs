'use strict';

/**
 * diagnose-issues spawns gsd-debugger with a prompt that is defined IN the workflow.
 *
 * The prompt used to live in `templates/debug-subagent-prompt.md`. Upstream removed that
 * template as unreachable (#4139) but left `diagnose-issues.md` saying "fill the
 * debug-subagent-prompt template" — a dangling instruction an agent cannot follow, missed
 * because the reachability audit searched for the template's PATH and the workflow named it
 * without one (upstream issue #5203). The fix inlines the prompt. This suite pins the parts
 * that make it usable:
 *
 *   1. the workflow names no template file that does not ship (by path or by
 *      "fill the <name> template" phrasing);
 *   2. the variable the `Agent()` call sends is the prompt the workflow defines;
 *   3. the prompt keeps its UAT contract — symptoms are prefilled, the session file is
 *      `.planning/debug/{slug}.md`;
 *   4. every placeholder in the prompt is documented, so nothing reaches the agent unfilled.
 *
 * The unit under test is the shipped markdown itself (CONTRIBUTING.md —
 * `source-text-is-the-product`); assertions run on parsed records, not raw substrings.
 * No `allow-test-rule` marker: `no-source-grep` only inspects reads of code files, so a
 * marker on a `.md` read suppresses nothing (see tests/ui-spec-inventory-provenance.test.cjs).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'diagnose-issues.md');
const TEMPLATES_DIR = path.join(ROOT, 'gsd-core', 'templates');

const lf = (s) => s.replace(/\r\n/g, '\n');
const text = lf(fs.readFileSync(WORKFLOW, 'utf8'));

/** Fenced blocks as { lang, body }. */
function fencedBlocks(src) {
  const out = [];
  let cur = null;
  for (const line of src.split('\n')) {
    const open = /^```(\S*)\s*$/.exec(line);
    if (!cur && open) { cur = { lang: open[1], lines: [] }; continue; }
    if (cur && /^```\s*$/.test(line)) { out.push({ lang: cur.lang, body: cur.lines.join('\n') }); cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  return out;
}

/** `<tag>…</tag>` sections of a prompt body, as { tag: [lines] }. */
function promptSections(body) {
  const out = {};
  for (const m of body.matchAll(/<([a-z_]+)>\n([\s\S]*?)\n<\/\1>/g)) {
    out[m[1]] = m[2].split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return out;
}

/** `key: value` lines → object. */
function keyValues(lines) {
  const out = {};
  for (const l of lines) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Template files the workflow refers to, by path or by "fill the <name> template". */
function referencedTemplates(src) {
  const refs = new Set();
  for (const m of src.matchAll(/templates\/([A-Za-z0-9_./-]+\.md)/g)) refs.add(m[1]);
  for (const m of src.matchAll(/\bfill (?:the |this )?`?([a-z0-9-]+)`? template\b/gi)) refs.add(`${m[1]}.md`);
  return [...refs];
}

const debugPrompt = fencedBlocks(text).find((b) => b.lang === 'markdown' && /<debug_file>/.test(b.body));

describe('diagnose-issues — inlined debugger prompt (#5203)', () => {
  test('every template the workflow names actually ships', () => {
    const missing = referencedTemplates(text).filter((rel) => !fs.existsSync(path.join(TEMPLATES_DIR, rel)));
    assert.deepEqual(missing, []);
  });

  test('the workflow defines the debugger prompt it spawns with', () => {
    assert.ok(debugPrompt, 'no fenced markdown prompt with a <debug_file> section');
    const agentCall = /Agent\(\s*\n\s*prompt=([a-z_]+)\s*\+/.exec(text);
    assert.ok(agentCall, 'no Agent() call with a prompt variable');
    assert.equal(agentCall[1], 'filled_debug_prompt');
    // the variable is introduced next to the prompt, not left to the reader's imagination
    assert.ok(/`filled_debug_prompt`/.test(text), 'filled_debug_prompt is never introduced');
  });

  test('the prompt keeps the UAT contract: symptoms prefilled, session file under .planning/debug/', () => {
    const s = promptSections(debugPrompt.body);
    assert.deepEqual(Object.keys(s).sort(), ['debug_file', 'mode', 'objective', 'symptoms']);
    assert.equal(keyValues(s.mode).symptoms_prefilled, 'true');
    assert.deepEqual(s.debug_file, ['Create: .planning/debug/{slug}.md']);
    assert.deepEqual(Object.keys(keyValues(s.symptoms)).sort(),
      ['actual', 'errors', 'expected', 'reproduction', 'timeline']);
  });

  test('every placeholder in the prompt is documented in the placeholder list', () => {
    const used = new Set([...debugPrompt.body.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]));
    const listStart = text.indexOf('Prompt placeholders');
    assert.ok(listStart !== -1, 'no "Prompt placeholders" list');
    const listEnd = text.indexOf('</step>', listStart);
    const documented = new Set(
      [...text.slice(listStart, listEnd).matchAll(/^- `\{([a-z_]+)\}`:/gm)].map((m) => m[1]),
    );
    const undocumented = [...used].filter((p) => !documented.has(p));
    assert.deepEqual(undocumented, []);
  });
});

describe('diagnose-issues — reference scanner is not vacuous', () => {
  test('a path reference and a by-name reference are both picked up', () => {
    assert.deepEqual(
      referencedTemplates('use templates/UAT.md, then fill the debug-subagent-prompt template').sort(),
      ['UAT.md', 'debug-subagent-prompt.md'],
    );
  });

  test('the removed template is reported missing when named', () => {
    const missing = referencedTemplates('fill the debug-subagent-prompt template')
      .filter((rel) => !fs.existsSync(path.join(TEMPLATES_DIR, rel)));
    assert.deepEqual(missing, ['debug-subagent-prompt.md']);
  });
});
