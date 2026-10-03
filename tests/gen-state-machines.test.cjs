'use strict';

/**
 * gen-state-machines.cjs — docs/reference/state-machines.md is generated from
 * the status constants in src/plan-status.cts, src/verification.cts and
 * src/phase-status.cts (phase 5.4).
 *
 * The acceptance criterion is "a vocabulary change without regeneration fails
 * the sync check". The CLI tests below reproduce that directly: a document
 * rendered from a MODIFIED vocabulary (what the committed file looks like when
 * the enum moved and nobody reran the generator) is written to a temp target,
 * and the real `--check` against the real compiled constants must fail.
 *
 * The document is read back structurally — its mermaid blocks parsed into
 * states and transitions — and compared with the source constants, so the test
 * also pins "transitions only where the code defines them".
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { GENERATOR_SCRIPT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');
const gen = require('../scripts/gen-state-machines.cjs');
const m = require('../gsd-core/bin/lib/mermaid.cjs');
const planStatus = require('../gsd-core/bin/lib/plan-status.cjs');
const verification = require('../gsd-core/bin/lib/verification.cjs');
const phaseStatus = require('../gsd-core/bin/lib/phase-status.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'gen-state-machines.cjs');

const FENCE = '`'.repeat(3);

/** The body of every ```mermaid fence, in order — line-based, so CRLF input reads the same. */
function mermaidBlocks(markdown) {
  const blocks = [];
  let cur = null;
  for (const line of splitLines(markdown)) {
    if (cur === null && line.trim() === `${FENCE}mermaid`) cur = [];
    else if (cur !== null && line.trim() === FENCE) {
      blocks.push(cur.join('\n'));
      cur = null;
    } else if (cur !== null) cur.push(line);
  }
  return blocks;
}

function runGen(args) {
  return runNode([SCRIPT, ...args], { timeoutMs: GENERATOR_SCRIPT_TIMEOUT_MS });
}

/** Each `## heading` section → { states: [{id,label,group}], transitions: [[from,to]], notes: [[state,text]] }. */
function readDoc(markdown) {
  const sections = new Map();
  const parts = markdown.split(/^## /m).slice(1);
  for (const part of parts) {
    const title = splitLines(part)[0].trim();
    const [block] = mermaidBlocks(part);
    assert.ok(block !== undefined, `section ${title} has no mermaid block`);
    const model = { states: [], transitions: [], notes: [] };
    let group = null;
    for (const line of splitLines(block).slice(1)) {
      let mm;
      if ((mm = line.match(/^ {2}state "(.*)" as (\w+) \{$/))) group = mm[2];
      else if (/^ {2}\}$/.test(line)) group = null;
      else if ((mm = line.match(/^ +state "(.*)" as (\w+)$/))) model.states.push({ id: mm[2], label: m.unescapeLabel(mm[1]), group });
      else if ((mm = line.match(/^ +(\w+) --> (\w+)$/))) model.transitions.push([mm[1], mm[2]]);
      else if ((mm = line.match(/^ +note right of (\w+) : (.*)$/))) model.notes.push([mm[1], m.unescapeLabel(mm[2])]);
      else if (!/^ {2}direction \w+$/.test(line)) assert.fail(`unrecognised line in ${title}: ${JSON.stringify(line)}`);
    }
    sections.set(title, model);
  }
  return sections;
}

describe('gen-state-machines: the document says what the code says', () => {
  const doc = gen.renderStateMachinesDoc(gen.loadSources());
  const sections = readDoc(doc);

  test('starts with the derived marker and has the three lifecycles', () => {
    assert.equal(doc.split('\n')[0], m.derivedMarker('scripts/gen-state-machines.cjs'));
    assert.deepEqual([...sections.keys()], ['Plan status', 'VerificationStatus', 'PhaseStatus']);
  });

  test('plan status: every value is a state and every arrow is a row of PLAN_STATUS_TRANSITIONS', () => {
    const s = sections.get('Plan status');
    const labelOf = new Map(s.states.map((st) => [st.id, st.label]));
    assert.deepEqual(s.states.map((st) => st.label), ['(no status)', ...planStatus.PLAN_STATUSES]);
    const drawn = s.transitions.map(([a, b]) => `${labelOf.get(a)}>${labelOf.get(b)}`).sort();
    const expected = Object.entries(planStatus.PLAN_STATUS_TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from === 'none' ? '(no status)' : from}>${to}`))
      .sort();
    assert.deepEqual(drawn, expected);
    // terminal = empty row in the table
    const terminal = Object.entries(planStatus.PLAN_STATUS_TRANSITIONS).filter(([, t]) => t.length === 0).map(([f]) => f);
    assert.deepEqual(s.notes.map(([id]) => labelOf.get(id)), terminal);
  });

  test('VerificationStatus: states only, split by VERIFIER_STATUSES, routes as notes', () => {
    const s = sections.get('VerificationStatus');
    assert.deepEqual(s.transitions, [], 'the code defines no transitions, so none are drawn');
    const all = Object.values(verification.VERIFICATION_STATUS);
    const writers = [...verification.VERIFIER_STATUSES];
    assert.deepEqual(s.states.filter((st) => st.group === 'writer_set').map((st) => st.label), writers);
    assert.deepEqual(
      s.states.filter((st) => st.group === 'reader_only').map((st) => st.label),
      all.filter((v) => !writers.includes(v)),
    );
    const routed = all.filter((v) => verification.VERIFICATION_ROUTES[v].command !== '');
    assert.deepEqual(
      s.notes.map(([id]) => s.states.find((st) => st.id === id).label).sort(),
      [...routed].sort(),
    );
  });

  test('PhaseStatus: states only, in PHASE_STATUS order', () => {
    const s = sections.get('PhaseStatus');
    assert.deepEqual(s.transitions, []);
    assert.deepEqual(s.states.map((st) => st.label), Object.values(phaseStatus.PHASE_STATUS));
  });

  test('a transition to a value outside the vocabulary is refused, not drawn', () => {
    const src = gen.loadSources();
    src.plan.transitions.done = ['reopened'];
    assert.throws(() => gen.renderStateMachinesDoc(src), /outside PLAN_STATUSES/);
  });
});

describe('gen-state-machines --check / --write (CLI, --target fixture)', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir('gsd-state-machines-');
  });
  afterEach(() => {
    cleanup(dir);
  });

  const expectExit = (r, code) => {
    assert.equal(r.outcome, OUTCOME.EXITED, r.stderr);
    assert.equal(r.exitCode, code, r.stderr);
  };

  test('--write then --check passes', () => {
    const target = path.join(dir, 'state-machines.md');
    expectExit(runGen(['--write', '--target', target]), 0);
    expectExit(runGen(['--check', '--target', target]), 0);
  });

  for (const [what, mutate] of [
    ['a plan status added', (s) => { s.plan.statuses.push('cancelled'); s.plan.transitions.cancelled = []; }],
    ['a plan transition removed', (s) => { s.plan.transitions.done = []; }],
    ['a verification status renamed', (s) => { s.verification.statuses[0] = 'verified'; s.verification.writerSet[0] = 'verified'; }],
    ['a PhaseStatus value dropped', (s) => { s.phase.statuses.pop(); }],
  ]) {
    test(`--check fails when the committed doc predates a vocabulary change (${what})`, () => {
      const src = gen.loadSources();
      mutate(src);
      const target = path.join(dir, 'state-machines.md');
      fs.writeFileSync(target, gen.renderStateMachinesDoc(src));
      expectExit(runGen(['--check', '--target', target]), 1);
      // and --write repairs it
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

  test('the committed docs/reference/state-machines.md is up to date', () => {
    expectExit(runGen(['--check']), 0);
  });
});
