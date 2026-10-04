'use strict';

/**
 * The `architecture` capability — a system architect before planning, an
 * architecture reviewer after execution.
 *
 * The design half is what makes the contract-drift gate meaningful. That gate
 * compares every signature declared in DESIGN.md `## Contracts` against the
 * code, and measured on the live project, nine of nine DESIGN.md files carry no
 * such section — they are written free-form because nothing produces them to a
 * contract. A checker with nothing to read is a checker that never fires.
 *
 * These tests pin the wiring rather than the prose: both agents exist, both are
 * dispatched at the point that makes them useful, and both ship off by default.
 * Timing is asserted explicitly because it is the one thing that cannot be fixed
 * later by editing the agent — a design written after planning documents the
 * split the planner already made instead of constraining it.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'capabilities', 'architecture', 'capability.json');
const AGENTS_DIR = path.join(REPO, 'agents');

// A capability manifest IS the deployed contract — the registry generator and the
// runtime both read this JSON to decide what runs and when.
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

describe('architecture capability', () => {
  test('declares its three agents, and each exists in agents/', () => {
    // Every capability agent must be present in agents/ — the installer projects
    // from there, so a declared-but-absent agent installs as a step that spawns
    // nothing.
    assert.deepEqual(
      [...manifest.agents].sort(),
      ['gsd-arch-surveyor', 'gsd-architect-reviewer', 'gsd-system-architect'],
    );

    for (const agent of manifest.agents) {
      assert.ok(
        fs.existsSync(path.join(AGENTS_DIR, `${agent}.md`)),
        `${agent} is declared but missing from agents/ — the step would spawn nothing`,
      );
    }
  });

  test('the architect runs at plan:pre, before the split it constrains', () => {
    const step = manifest.steps.find((s) => s.ref?.agent === 'gsd-system-architect');
    assert.ok(step, 'the system architect must be dispatched by a step');

    // The one property that cannot be corrected later by editing the agent: the
    // planner's split of tasks across files IS the boundary decision. Run after,
    // the design narrates it; run before, it constrains it.
    assert.equal(step.point, 'plan:pre', 'a design written after planning narrates it');
    assert.deepEqual(step.produces, ['DESIGN.md']);
    assert.equal(step.when, 'workflow.architecture_design');
  });

  test('the reviewer runs at verify:pre and reads what the architect wrote', () => {
    const step = manifest.steps.find((s) => s.ref?.agent === 'gsd-architect-reviewer');
    assert.ok(step, 'the reviewer must be dispatched by a step');
    assert.equal(step.point, 'verify:pre');
    assert.deepEqual(step.produces, ['ARCH-REVIEW.md']);
    // The pairing is the point: a reviewer with no design has no standard to
    // grade against, and its agent stops with NO_DESIGN rather than inventing one.
    assert.deepEqual(step.consumes, ['DESIGN.md']);
    assert.equal(step.when, 'workflow.architecture_review');
  });

  test('both halves ship off and are opted into separately', () => {
    for (const key of ['workflow.architecture_design', 'workflow.architecture_review']) {
      const cfg = manifest.config[key];
      assert.ok(cfg, `${key} must be declared so the step can be switched off`);
      assert.equal(cfg.type, 'boolean');
      assert.equal(cfg.default, false, `${key} must ship off — a new step is opted into`);
    }
  });

  test('the milestone stage measures at milestone:post, on by default, with no model', () => {
    // The survey half's lifecycle stage: a deterministic command step, so it needs no
    // fragment; the survey itself is model work and only follows the stage's answer.
    const step = manifest.steps.find((s) => s.point === 'milestone:post');
    assert.ok(step, 'the architecture capability must register its milestone stage');
    assert.deepEqual(step.ref, { command: 'arch stage' });
    assert.equal(step.when, 'architecture.metrics_at_milestone');
    assert.equal(manifest.config['architecture.metrics_at_milestone'].default, true);
    assert.equal(manifest.config['architecture.survey_at_milestone'].default, 'suggest');
  });

  test('every agent step points at a fragment that exists', () => {
    // A step whose fragment path is wrong dispatches an agent with no context,
    // which fails as vaguely as it sounds. A command step runs the CLI and has none.
    for (const step of manifest.steps.filter((s) => s.ref?.agent)) {
      const fragment = path.join(path.dirname(MANIFEST_PATH), step.fragment.path);
      assert.ok(
        fs.existsSync(fragment),
        `${step.ref.agent}: fragment ${step.fragment.path} does not exist`,
      );
      assert.ok(
        fs.readFileSync(fragment, 'utf8').trim().length > 0,
        `${step.ref.agent}: fragment is empty`,
      );
    }
  });

  test('the registry dispatches both agents at their declared points', () => {
    // The manifest is intent; the generated registry is what the runtime reads.
    // Eight mechanisms in this fork's original finding were written in full and
    // dispatched by nothing — this is the check that separates the two.
    const registry = require('../gsd-core/bin/lib/capability-registry.cjs');

    const atPlanPre = (registry.byLoopPoint['plan:pre']?.steps || [])
      .filter((s) => s.capId === 'architecture')
      .map((s) => s.ref?.agent);
    assert.deepEqual(atPlanPre, ['gsd-system-architect'], 'plan:pre must dispatch the architect');

    const atVerifyPre = (registry.byLoopPoint['verify:pre']?.steps || [])
      .filter((s) => s.capId === 'architecture')
      .map((s) => s.ref?.agent);
    assert.deepEqual(atVerifyPre, ['gsd-architect-reviewer'], 'verify:pre must dispatch the reviewer');
  });
});

describe('architecture agents', () => {
  for (const agent of ['gsd-system-architect', 'gsd-architect-reviewer']) {
    test(`${agent} writes exactly one artifact and never edits source`, () => {
      // An agent .md IS what the runtime loads; its text is the deployed contract.
      const src = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8');

      assert.match(src, /^tools:.*\bWrite\b/m, 'must be able to write its artifact');
      assert.match(src, /^tools:.*\bRead\b/m, 'must be able to read its inputs');
      // Both are advisory by design. An architect that edits source pre-empts the
      // executor; a reviewer that edits stops being a second opinion.
      assert.doesNotMatch(src, /^tools:.*\bEdit\b/m, `${agent} must not carry Edit`);
    });
  }

  test('the architect states the full-return-type rule', () => {
    // This single instruction is what the contract-drift gate depends on. An
    // abbreviated signature in DESIGN.md is exactly the shape that lets one wave
    // write EitherAsync while another calls a bare Promise.
    const src = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-system-architect.md'), 'utf8');
    assert.match(
      src,
      /FULL return type/i,
      'the architect must require full return types, or the drift gate grades a fiction',
    );
  });

  test('every section the architect writes has a declared reader', () => {
    // The fork exists to close one defect: a mechanism built and wired to nothing.
    // A DESIGN.md section nobody reads is that defect in miniature — the architect
    // spends tokens on it, the file carries it, and no step downstream is any
    // different for its presence. Three sections were exactly that when first
    // added, which is why this is a test and not a convention.
    const template = fs.readFileSync(
      path.join(REPO, 'gsd-core', 'templates', 'DESIGN.md'),
      'utf8',
    );

    // Sections of the artifact itself, taken from the File Template block — the
    // headings above it are the template's own documentation, not output.
    const fileTemplate = template.slice(template.indexOf('## File Template'));
    const sections = [...fileTemplate.matchAll(/^## (.+)$/gm)]
      .map((m) => m[1].trim())
      .filter((s) => s !== 'File Template' && s !== 'Anti-Patterns');

    assert.ok(sections.length >= 8, `expected the full section set, got ${sections.length}`);

    // A reader is any agent or capability that names the section, excluding the
    // architect that writes it.
    const readerFiles = [
      ...fs.readdirSync(path.join(REPO, 'agents'))
        .filter((f) => f.endsWith('.md') && f !== 'gsd-system-architect.md')
        .map((f) => path.join(REPO, 'agents', f)),
      ...fs.readdirSync(path.join(REPO, 'capabilities'))
        .map((d) => path.join(REPO, 'capabilities', d, 'capability.json'))
        .filter((p) => fs.existsSync(p)),
    ];
    const corpus = readerFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

    const orphans = sections.filter((s) => !corpus.includes(s));
    assert.deepEqual(
      orphans,
      [],
      `these DESIGN.md sections are written and read by nobody: ${orphans.join(', ')}. ` +
        'Either wire a consumer or drop the section — an artifact with no reader is the ' +
        'defect this fork exists to close.',
    );
  });

  test('the reviewer stops rather than inventing a standard', () => {
    const src = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-architect-reviewer.md'), 'utf8');
    assert.match(
      src,
      /NO_DESIGN/,
      'reviewing structure with no design means grading against an invented standard',
    );
  });
});

describe('phase 5.7a: the architect checks its own diagrams before returning', () => {
  const { beforeEach, afterEach } = require('node:test');
  const { runGsdTools, createTempGitProject, cleanup } = require('./helpers.cjs');
  const { DIAGRAMS_SUBCOMMANDS } = require('../gsd-core/bin/lib/diagrams-command-router.cjs');

  // The producer checks its output; the plan:post gate is only the backstop.
  const src = fs.readFileSync(path.join(AGENTS_DIR, 'gsd-system-architect.md'), 'utf8');
  const workflow = src.slice(src.indexOf('<workflow>'), src.indexOf('</workflow>'));
  const output = src.slice(src.indexOf('<output>'), src.indexOf('</output>'));
  const call = workflow.match(/`gsd_run diagrams (\S{1,40}) --file (\S{1,120})`/);

  test('a workflow step runs a real diagrams subcommand on the DESIGN.md the agent writes', () => {
    assert.ok(call, 'the <workflow> runs gsd_run diagrams … --file …');
    assert.ok(DIAGRAMS_SUBCOMMANDS.includes(call[1]), `${call[1]} is a diagrams subcommand`);
    assert.ok(output.includes(`Write \`${call[2]}\``), `the checked file ${call[2]} is the file <output> writes`);
  });

  describe('the finding and field the step acts on are what the command reports', () => {
    let root;
    beforeEach(() => {
      root = createTempGitProject('gsd-architect-selfcheck-');
    });
    afterEach(() => {
      cleanup(root);
    });

    function design(placementRows) {
      const rel = '.planning/phases/01-x/01-DESIGN.md';
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), [
        '---', 'phase: 01-x', 'contracts_superseded: false', '---',
        '## Layer Placement',
        '| What | Layer | NX project | Why not the neighbour |',
        '|------|-------|-----------|----------------------|',
        ...placementRows,
        '## Ports & Implementations',
        '```mermaid', 'classDiagram', '  class ThingCache', '```',
      ].join('\n'));
      const r = runGsdTools(['diagrams', call[1], '--file', rel], root);
      assert.equal(r.success, true, r.error);
      return JSON.parse(r.output);
    }

    test('an invented name is an absent BLOCKER; the Layer Placement row the step prescribes clears it', () => {
      assert.ok(workflow.includes('`absent`') && workflow.includes('`blocker_count`'), 'the step names the reason and the field');
      const invented = design([]);
      assert.equal(invented.blocker_count, 1);
      assert.deepEqual(invented.findings.map((f) => [f.severity, f.reason, f.claim]), [['BLOCKER', 'absent', 'ThingCache']]);
      const placed = design(['| `ThingCache` | services | @x/services | reason |']);
      assert.equal(placed.blocker_count, 0);
    });
  });
});
