// allow-test-rule: source-text-is-the-product (see #644) — plan-phase.md's planner prompt is the deployed
// runtime contract under assertion (the workflow PROSE is the product).
//
// RED-first PROSE-PRESENCE contract for the plan-phase lift of confirmed prohibitions. plan-phase.md
// spawns the planner from its own inline <downstream_consumer> block; the load-bearing lift instruction
// must live THERE, never in a shipped template. Templates are inert artifact scaffolding — nothing
// loads one as the planner's consumer contract — so an instruction relocated into a template is
// false assurance: the test stays green while the runtime never consumes it.
//
// Guard history: this was originally pinned to templates/planner-subagent-prompt.md, a single file
// that was an orphan BY DESIGN — it existed so the guard had something to point at. Phase 4 deleted
// that file and generalized the guard to scan gsd-core/templates/ recursively, so the invariant now
// outlives any one filename and also catches relocation into plan.md, summary.md, or a template that
// does not exist yet. Do not narrow it back to a single path.
//
// ADR-550 Decision 2: resolved prohibitions lift into must_haves.PROHIBITIONS — NOT must_haves.truths.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
const TEMPLATES_DIR = path.join(__dirname, '..', 'gsd-core', 'templates');

// SPEC-artifact templates are exempt from the token scan. They are the PRODUCER side of the lift:
// spec.md authors the `## Prohibitions` / `## Edge Coverage` sections themselves and documents where
// plan-phase lifts them TO, and UI-SPEC.md cross-references the SPEC rule by name. Naming the target
// is not relocating the instruction. Measured on this tree: these are the only two templates of 49
// that carry either token, so the exemption is exactly as wide as the false positives require.
const SPEC_ARTIFACT_TEMPLATES = new Set(['spec.md', 'UI-SPEC.md']);

function readPlanPhase() {
  return fs.readFileSync(PLAN_PHASE_PATH, 'utf8');
}

// Every shipped template that could plausibly host a relocated planner instruction, as repo-relative
// paths so a failure names the offending file instead of sending the reader through 47 of them.
function scannableTemplates() {
  return fs
    .readdirSync(TEMPLATES_DIR, { recursive: true })
    .filter((entry) => entry.endsWith('.md'))
    .filter((entry) => !SPEC_ARTIFACT_TEMPLATES.has(path.basename(entry)))
    .map((entry) => ({
      rel: path.posix.join('gsd-core/templates', entry.split(path.sep).join('/')),
      abs: path.join(TEMPLATES_DIR, entry),
    }));
}

// Assert `pattern` appears in no scannable template, naming the offender when it does.
function assertAbsentFromTemplates(pattern, message) {
  const templates = scannableTemplates();
  assert.ok(
    templates.length > 0,
    'sanity: gsd-core/templates/ must contain scannable .md templates for this guard to mean anything'
  );
  const offenders = templates
    .filter(({ abs }) => pattern.test(fs.readFileSync(abs, 'utf8')))
    .map(({ rel }) => rel);
  assert.deepEqual(offenders, [], `${message} — found in: ${offenders.join(', ')}`);
}

// Extract the planner <downstream_consumer> block from plan-phase.md (the runtime planner surface).
function extractDownstreamConsumerBlock(content) {
  const start = content.indexOf('<downstream_consumer>');
  if (start === -1) return '';
  const end = content.indexOf('</downstream_consumer>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</downstream_consumer>'.length);
}

// Extract the planner <quality_gate> block (the last one in plan-phase.md, inside the planner prompt).
function extractQualityGateBlock(content) {
  const start = content.lastIndexOf('<quality_gate>');
  if (start === -1) return '';
  const end = content.indexOf('</quality_gate>', start);
  if (end === -1) return '';
  return content.slice(start, end + '</quality_gate>'.length);
}

// PROB-04 consumer: the lift instruction lives in the RUNTIME planner surface and lifts resolved
// prohibitions into must_haves.prohibitions (ADR-550 D2 — NOT truths).
test('PROB-04 consumer: downstream_consumer lifts SPEC Prohibitions into must_haves.prohibitions', () => {
  const block = extractDownstreamConsumerBlock(readPlanPhase());
  assert.ok(block.length > 0, 'sanity: plan-phase.md must contain a <downstream_consumer> block to scope this test');

  assert.match(
    block,
    /Prohibitions/,
    'plan-phase.md <downstream_consumer> must reference the SPEC Prohibitions section'
  );
  assert.match(
    block,
    /must_haves\.prohibitions/,
    'plan-phase.md <downstream_consumer> must lift resolved prohibitions into must_haves.prohibitions (ADR-550 D2 — NOT truths)'
  );

  // ADR-550 D2 GUARD: prohibitions must NOT be lifted into truths.
  assert.doesNotMatch(
    block,
    /prohibition[^.\n]*must_haves\.truths|must_haves\.truths[^.\n]*prohibition/i,
    'prohibitions must NOT be lifted into must_haves.truths — truths keeps its positive-observable semantics (ADR-550 D2)'
  );
});

// Orphan-prompt regression guard (mirror edge planner test): the lift instruction must NOT be
// relocated out of plan-phase.md into any shipped template. No template is loaded as the planner's
// consumer contract, so an instruction parked in one is inert — green test, dead runtime.
test('PROB-04 regression: the prohibitions lift lives in plan-phase.md, not in any shipped template', () => {
  assertAbsentFromTemplates(
    /must_haves\.prohibitions/,
    'no shipped template is loaded as the planner consumer contract — the prohibitions lift instruction must live in plan-phase.md <downstream_consumer>'
  );
});

// PROB-04: quality_gate covers every resolved SPEC Prohibition being represented in must_haves.prohibitions.
test('PROB-04: planner quality_gate requires every resolved SPEC Prohibition represented in must_haves.prohibitions', () => {
  const qgBlock = extractQualityGateBlock(readPlanPhase());
  assert.ok(qgBlock.length > 0, 'sanity: plan-phase.md must contain a <quality_gate> block to scope this test');

  assert.match(
    qgBlock,
    /prohibition/i,
    'planner quality_gate must contain a checklist item covering SPEC prohibitions (PROB-04)'
  );
  assert.match(
    qgBlock,
    /must_haves\.prohibitions/,
    'planner quality_gate must tie SPEC prohibitions to must_haves.prohibitions with no silent drops (PROB-04)'
  );
});
