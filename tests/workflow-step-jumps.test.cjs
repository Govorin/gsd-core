'use strict';

/**
 * A step jump never skips a loop point.
 *
 * A workflow step that ends with "Proceed to <step>" names where the model goes next. When that
 * target sits further down than the next step, every step in between is skipped — and a skipped
 * step that hosts `gsd_run loop render-hooks <point>` silently drops every hook a capability
 * registered there. complete-milestone's yolo branch said "Proceed to gather_stats" from
 * verify_readiness, jumping over milestone_pre_hooks: under `mode: yolo` the code-review window
 * stage (and anything else at `milestone:pre`) never ran, and milestones closed unreviewed.
 *
 * The workflow text is what the model executes, so asserting on it is the
 * `source-text-is-the-product` case (CONTRIBUTING.md); nothing here reads a code file.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

/**
 * The units of a workflow, in document order: its `<step name="…">` blocks when it has any (named
 * steps, jumped to by name), else its numbered `##`/`###` headings (`## 5.6. …`, jumped to as
 * `step 5.6` or `§5.6`); an unnumbered heading belongs to the unit above it.
 */
function unitsOf(text) {
  const steps = [];
  for (const m of text.matchAll(/<step name="([a-z0-9_]+)"[^>]*>([\s\S]*?)<\/step>/g)) steps.push({ name: m[1], body: m[2] });
  if (steps.length > 0) return { kind: 'named', units: steps };
  const units = [];
  let current = null;
  for (const line of text.split('\n')) {
    const h = /^#{2,3} (\d+[a-z]?(?:\.\d+)*)\.? /.exec(line);
    if (h !== null) {
      current = { name: h[1], body: '' };
      units.push(current);
    } else if (current !== null) {
      current.body += `${line}\n`;
    }
  }
  return { kind: 'numbered', units };
}

const VERB = String.raw`\b(?:proceed|continue|skip|go|jump)\b`;
/** A named jump: the verb, a few words at most ("go from there straight to"), then the step name. */
const NAMED_JUMP = new RegExp(String.raw`${VERB}(?:[ \t]+[\w-]+){0,4}?[ \t]+to[ \t]+\x60?([a-z][a-z0-9_]*)\x60?`, 'gi');
/** A numbered jump: `skip to step 6`, `Continue to Step 5.55`, `skip to §5`. */
const NUMBERED_JUMP = new RegExp(String.raw`${VERB}(?:[ \t]+[\w-]+){0,4}?[ \t]+to[ \t]+(?:step[ \t]+|§)(\d+[a-z]?(?:\.\d+)*)`, 'gi');
/** "do not proceed to …", "never skip to …": an absence, not a jump. */
const NEGATED = /\b(?:not|never|don't|do not)[ \t]+$/i;

/** Every jump from a unit past a later unit that hosts a loop point: `{ from, to, skipped }`. */
function hookSkippingJumps(text) {
  const { kind, units } = unitsOf(text);
  const index = new Map(units.map((u, i) => [u.name, i]));
  const pattern = kind === 'named' ? NAMED_JUMP : NUMBERED_JUMP;
  const out = [];
  units.forEach((unit, i) => {
    for (const m of unit.body.matchAll(pattern)) {
      if (NEGATED.test(unit.body.slice(Math.max(0, m.index - 12), m.index))) continue;
      const j = index.get(m[1]);
      if (j === undefined || j <= i + 1) continue;
      const skipped = units.slice(i + 1, j).filter((u) => /loop render-hooks /.test(u.body)).map((u) => u.name);
      if (skipped.length > 0) out.push({ from: unit.name, to: m[1], skipped });
    }
  });
  return out;
}

test('the scan sees the defect it guards against (positive control)', () => {
  const text = [
    '<step name="verify_readiness">', '<if mode="yolo">', 'Proceed to gather_stats.', '</if>', '</step>',
    '<step name="milestone_pre_hooks">', 'gsd_run loop render-hooks milestone:pre --raw', '</step>',
    '<step name="gather_stats">', 'stats', '</step>',
  ].join('\n');
  assert.deepEqual(hookSkippingJumps(text), [{ from: 'verify_readiness', to: 'gather_stats', skipped: ['milestone_pre_hooks'] }]);
  // A jump to the very next step skips nothing.
  assert.deepEqual(hookSkippingJumps(text.replace('Proceed to gather_stats', 'Proceed to milestone_pre_hooks')), []);
  // A few words between the verb and the target still read as a jump.
  assert.equal(hookSkippingJumps(text.replace('Proceed to gather_stats', 'go from there straight to `gather_stats`')).length, 1);
});

test('numbered-heading workflows: `skip to step N` and `§N` jumps are seen; a negated one is not', () => {
  const doc = (jump) => [
    '## 5. Handle Research', jump, '### 5.1. Decision', 'decide',
    '## 5.6. Plan:Pre Dispatch', 'X=$(gsd_run loop render-hooks plan:pre --raw)',
    '## 6. Check Existing Plans', 'plans',
  ].join('\n');
  assert.deepEqual(hookSkippingJumps(doc('Use existing, skip to step 6.')), [{ from: '5', to: '6', skipped: ['5.6'] }]);
  assert.equal(hookSkippingJumps(doc('Otherwise continue to §6.')).length, 1);
  assert.deepEqual(hookSkippingJumps(doc('STOP — do not proceed to Step 6.')), []);
  assert.deepEqual(hookSkippingJumps(doc('skip to §5.6.')), []);
});

test('complete-milestone yolo mode reaches the milestone:pre hooks', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'complete-milestone.md'), 'utf8');
  const steps = unitsOf(text).units.map((s) => s.name);
  assert.equal(steps[steps.indexOf('verify_readiness') + 1], 'milestone_pre_hooks', 'milestone_pre_hooks follows verify_readiness');
  assert.deepEqual(hookSkippingJumps(text), []);
});

test('no shipped workflow jumps over a step that hosts a loop point', () => {
  const offenders = [];
  for (const file of markdownFiles(WORKFLOWS)) {
    for (const jump of hookSkippingJumps(fs.readFileSync(file, 'utf8'))) {
      offenders.push(`${path.relative(WORKFLOWS, file)}: ${jump.from} → ${jump.to} skips ${jump.skipped.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('discuss-phase routes a resumed checkpoint to present_gray_areas whether or not discuss:pre has hooks', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'discuss-phase.md'), 'utf8');
  const dispatch = unitsOf(text).units.find((u) => u.name === 'dispatch_discuss_pre_hooks');
  assert.ok(dispatch, 'dispatch_discuss_pre_hooks exists');
  // The exit must not hang off an empty-hook-list condition: with active hooks the model would otherwise fall into analyze_phase.
  assert.doesNotMatch(dispatch.body, /Empty list/);
  assert.match(dispatch.body, /then continue to `analyze_phase` \(a resumed checkpoint: to `present_gray_areas`\)/);
});
