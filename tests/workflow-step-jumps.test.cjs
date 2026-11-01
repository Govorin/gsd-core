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

/** The `<step name="…">` blocks of a workflow, in document order. */
function stepsOf(text) {
  const steps = [];
  for (const m of text.matchAll(/<step name="([a-z0-9_]+)"[^>]*>([\s\S]*?)<\/step>/g)) steps.push({ name: m[1], body: m[2] });
  return steps;
}

const JUMP = /\b(?:Proceed|Continue|Skip|Go) to `?([a-z0-9_]+)`?/gi;

/** Every jump from a step past a later step that hosts a loop point: `{ from, to, skipped }`. */
function hookSkippingJumps(text) {
  const steps = stepsOf(text);
  const index = new Map(steps.map((s, i) => [s.name, i]));
  const out = [];
  steps.forEach((step, i) => {
    for (const m of step.body.matchAll(JUMP)) {
      const j = index.get(m[1]);
      if (j === undefined || j <= i + 1) continue;
      const skipped = steps.slice(i + 1, j).filter((s) => /loop render-hooks /.test(s.body)).map((s) => s.name);
      if (skipped.length > 0) out.push({ from: step.name, to: m[1], skipped });
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
});

test('complete-milestone yolo mode reaches the milestone:pre hooks', () => {
  const text = fs.readFileSync(path.join(WORKFLOWS, 'complete-milestone.md'), 'utf8');
  const steps = stepsOf(text).map((s) => s.name);
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
