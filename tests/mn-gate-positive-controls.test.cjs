'use strict';

/**
 * Fork (mn) — the positive controls of the fork's gate modules (#5204, ADR-5057 §4 ratchet; upstream's
 * controls are in tests/gate-positive-control.test.cjs). Each `gateControl` drives one gate through its
 * real `evaluate*` export to its FINDING arm (`expectRed` pins it, so a scenario that fails for another
 * reason — the could-not-look arm most often — does not count) and to a passing verdict.
 * `scripts/lint-gate-positive-control.cjs` fails CI on a gate module without one.
 *
 * Scenarios are the smallest red/green pairs the per-gate tests already pin (tests/mn-*.test.cjs,
 * tests/gate-architecture-diagrams.test.cjs); records a recorder would write are written through the
 * recorder's own frontmatter writer, never by hand, so the control reads what production reads.
 */

const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { gateControl, put, git } = require('./helpers/gate-positive-control.cjs');
const { createTempGitProject, cleanup, runGsdTools } = require('./helpers.cjs');

const LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const verifyGates = require(path.join(LIB, 'verify-gates.cjs'));
const { baselineDigest, baselinePathFor, BASELINE_RECORD_KEY } = require(path.join(LIB, 'verify-baseline.cjs'));
const { MUTATION_STATUS, MUTATION_RECORD_KEY, digestCandidates, mutationCandidates } = require(path.join(LIB, 'verify-mutation.cjs'));
const { recordAssertionBaseline, DEFAULT_ROOTS } = require(path.join(LIB, 'mn-assertion-count.cjs'));

const PHASE = '.planning/phases/01-gate';
const SUMMARY = '---\nphase: 01\n---\n\n# summary\n';

/** Plan frontmatter carrying only the given fields (no `status:` line unless asked). */
function plan(fields = {}) {
  const lines = ['phase: 01', 'plan: 01'];
  for (const [key, value] of Object.entries(fields)) lines.push(`${key}: ${value}`);
  return `---\n${lines.join('\n')}\n---\n\n# a plan\n`;
}

/** A plan with a wave, optional depends_on, and a files_modified list. */
function wavePlan({ wave, deps = [], files }) {
  const fileLines = files.map((f) => `  - "${f}"`).join('\n');
  return `---\nwave: ${wave}\ndepends_on: [${deps.map((d) => `"${d}"`).join(', ')}]\nfiles_modified:\n${fileLines}\n---\n\n# plan\n`;
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--no-verify', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

/** One check result in the recorder's shape. */
const checkResult = (name, passed, status = passed ? 'pass' : 'fail') => ({
  name,
  status,
  passed,
  exitCode: status === 'stale' ? null : passed ? 0 : 1,
  durationMs: 1,
  cause: status === 'stale' ? 'not_found' : '',
});

/** Record `gates:` into the phase's VERIFICATION.md the way `verify gates` does. */
function recordGates(dir, passed, status) {
  put(dir, `${PHASE}/.keep`, '');
  const gates = verifyGates.buildGatesFrontmatter([checkResult('tests', passed, status)], '2026-10-25T00:00:00.000Z');
  verifyGates.recordGates(verifyGates.verificationPathFor(path.join(dir, PHASE)), gates);
}

/** Configure one check and record its baseline the way `verify baseline` does (digest of this tree). */
function recordBaseline(dir, passed, status) {
  put(dir, '.planning/config.json', JSON.stringify({ workflow: { verify_gates: { tests: 'npm test' } } }));
  put(dir, `${PHASE}/.keep`, '');
  commitAll(dir, 'chore: base');
  const checks = [{ name: 'tests', command: 'npm test' }];
  const measured = verifyGates.buildGatesFrontmatter([checkResult('tests', passed, status)], '2026-10-25T00:00:00.000Z');
  const phaseDir = path.join(dir, PHASE);
  verifyGates.recordFrontmatterBlock(baselinePathFor(phaseDir), BASELINE_RECORD_KEY, { ...measured, digest: baselineDigest(dir, checks) }, {
    suffix: '-BASELINE.md',
    body: '# Baseline\n',
  });
}

/** A phase that declares one source file, and a `mutation:` record over it the way `verify mutation` writes it. */
function recordMutation(dir, status) {
  put(dir, 'src/a.ts', 'export const a = (x: number) => x > 1;\n');
  put(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 01\nplan: 01\nfiles_modified:\n  - src/a.ts\n---\n\n# plan\n');
  const phaseDir = path.join(dir, PHASE);
  const survived = status === MUTATION_STATUS.SURVIVORS ? 1 : 0;
  verifyGates.recordVerificationBlock(verifyGates.verificationPathFor(phaseDir), MUTATION_RECORD_KEY, {
    status,
    ran_at: '2026-10-25T00:00:00.000Z',
    attempted: 1,
    killed: 1 - survived,
    survived,
    survivors: survived ? ['src/a.ts:1 > → >='] : [],
    digest: digestCandidates(dir, mutationCandidates(dir, phaseDir)),
  });
}

/** A spec with `n` assertions under the ratchet's first root. */
function writeSpec(dir, n) {
  const body = Array.from({ length: n }, (_, i) => `  expect(v${i}).toBe(${i});`).join('\n');
  put(dir, path.join(DEFAULT_ROOTS[0], 'a.spec.ts'), `describe('s', () => {\n  it('t', () => {\n${body}\n  });\n});\n`);
}

const recordAssertions = (dir) => recordAssertionBaseline({ repoRoot: dir, roots: DEFAULT_ROOTS.map((r) => path.join(dir, r)) });

const CONTRACT = ['# DESIGN', '', '## Contracts', '', '```typescript', 'export interface IBookRepository {', '  findById(id: BookId): Promise<Book>;', '}', '```', ''].join('\n');
const bookRepository = (returns) => `export interface IBookRepository {\n  findById(id: BookId): Promise<${returns}>;\n}\n`;

/** A phase whose task commit touched `files`; the plan declares `src/declared.ts`. */
function blastRadiusPhase(files) {
  return (dir) => {
    put(dir, `${PHASE}/01-01-PLAN.md`, '---\nwave: 1\nfiles_modified:\n  - src/declared.ts\nstatus: complete\n---\n\n# plan\n');
    commitAll(dir, 'docs(01-01): plan');
    for (const [rel, body] of Object.entries(files)) put(dir, rel, body);
    const task = commitAll(dir, 'feat(01-01): work');
    put(dir, `${PHASE}/01-01-SUMMARY.md`, `---\nphase: 01\n---\n\n# Summary\n\n## Task Commits\n\n1. **Task 1: work** - \`${task}\` (feat)\n\n## Notes\n`);
    commitAll(dir, 'docs(01-01): summary');
  };
}

/** A migration committed in the phase, after a phase plan that declares it. */
function migrationPhase(sql) {
  return (dir) => {
    put(dir, `${PHASE}/01-PLAN.md`, '---\nwave: 1\nfiles_modified:\n  - drizzle/0001_change.sql\n---\n');
    commitAll(dir, 'docs(01): plan');
    put(dir, 'drizzle/0001_change.sql', sql);
    commitAll(dir, 'feat(01): migration');
  };
}

const ARCH_PHASE = '.planning/phases/03-cache';
function architectureDesign(classes) {
  return (dir) => {
    put(dir, 'src/repo.ts', 'export interface IThingRepository {\n  findById(id: string): void;\n}\n');
    put(dir, `${ARCH_PHASE}/03-DESIGN.md`, ['## Ports & Implementations', '```mermaid', 'classDiagram', ...classes.map((c) => `  class ${c}`), '```', ''].join('\n'));
  };
}

gateControl({
  gate: 'mn-plan-status',
  module: require('../gsd-core/bin/lib/gate-mn-plan-status.cjs'),
  fn: 'evaluateMnPlanStatus',
  red: 'block',
  expectRed: { status: 'finding' },
  // in_progress with no SUMMARY: the executor started and did not finish.
  redScenario: { setup: (dir) => put(dir, `${PHASE}/01-01-PLAN.md`, plan({ status: 'in_progress' })), args: ['01'] },
  // No status at all: not started, never a finding.
  greenScenario: { setup: (dir) => put(dir, `${PHASE}/01-01-PLAN.md`, plan()), args: ['01'] },
});

gateControl({
  gate: 'mn-orphan-plans',
  module: require('../gsd-core/bin/lib/gate-mn-orphan-plans.cjs'),
  fn: 'evaluateMnOrphanPlans',
  red: 'block',
  expectRed: { status: 'finding', orphaned: ['01-01-PLAN.md'] },
  redScenario: { setup: (dir) => put(dir, `${PHASE}/01-01-PLAN.md`, plan({ status: 'in_progress' })), args: ['01'] },
  // The same plan once its SUMMARY exists.
  greenScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/01-01-PLAN.md`, plan({ status: 'in_progress' }));
      put(dir, `${PHASE}/01-01-SUMMARY.md`, SUMMARY);
    },
    args: ['01'],
  },
});

gateControl({
  gate: 'mn-uat-open',
  module: require('../gsd-core/bin/lib/gate-mn-uat-open.cjs'),
  fn: 'evaluateMnUatOpen',
  red: 'block',
  expectRed: { status: 'finding' },
  // A manual check nobody ran.
  redScenario: {
    setup: (dir) => put(dir, `${PHASE}/01-UAT.md`, '---\nstatus: testing\nphase: 01\n---\n\n## Tests\n\n### 1. Login works\nexpected: dashboard appears\nresult: pending\n'),
    args: ['01'],
  },
  // A phase that deferred nothing.
  greenScenario: { setup: (dir) => put(dir, `${PHASE}/.keep`, ''), args: ['01'] },
});

gateControl({
  gate: 'mn-verify-gates',
  module: require('../gsd-core/bin/lib/gate-mn-verify-gates.cjs'),
  fn: 'evaluateMnVerifyGates',
  red: 'block',
  expectRed: { status: 'finding', red: ['tests'] },
  redScenario: { setup: (dir) => recordGates(dir, false), args: ['01'] },
  greenScenario: { setup: (dir) => recordGates(dir, true), args: ['01'] },
});

gateControl({
  gate: 'mn-baseline',
  module: require('../gsd-core/bin/lib/gate-mn-baseline.cjs'),
  fn: 'evaluateMnBaseline',
  red: 'block',
  expectRed: { status: 'finding', red: ['tests'] },
  // A red base, measured on this very tree.
  redScenario: { git: true, setup: (dir) => recordBaseline(dir, false), args: ['01'] },
  greenScenario: { git: true, setup: (dir) => recordBaseline(dir, true), args: ['01'] },
});

gateControl({
  gate: 'mn-mutation-spot-check',
  module: require('../gsd-core/bin/lib/gate-mn-mutation-spot-check.cjs'),
  fn: 'evaluateMnMutationSpotCheck',
  red: 'block',
  expectRed: { status: 'finding', survived: 1 },
  // A mutant survived: the suite stayed green with the code changed.
  redScenario: { setup: (dir) => recordMutation(dir, MUTATION_STATUS.SURVIVORS), args: ['01'] },
  greenScenario: { setup: (dir) => recordMutation(dir, MUTATION_STATUS.PASSED), args: ['01'] },
});

gateControl({
  gate: 'mn-assertion-ratchet',
  module: require('../gsd-core/bin/lib/gate-mn-assertion-ratchet.cjs'),
  fn: 'evaluateMnAssertionRatchet',
  red: 'block',
  expectRed: { status: 'finding' },
  // Two assertions dropped since the recorded baseline.
  redScenario: {
    setup: (dir) => {
      writeSpec(dir, 5);
      recordAssertions(dir);
      writeSpec(dir, 3);
    },
    args: [],
  },
  greenScenario: {
    setup: (dir) => {
      writeSpec(dir, 5);
      recordAssertions(dir);
    },
    args: [],
  },
});

gateControl({
  gate: 'mn-failure-paths',
  module: require('../gsd-core/bin/lib/gate-mn-failure-paths.cjs'),
  fn: 'evaluateMnFailurePaths',
  red: 'block',
  expectRed: { status: 'finding' },
  // A migration in files_modified requires failure paths; the plan declares none.
  redScenario: {
    setup: (dir) => put(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 01-gate\nplan: 01\nwave: 1\nfiles_modified:\n  - "apps/api/drizzle/0007_add_ignored_at.sql"\n---\n\n<objective>\nx\n</objective>\n'),
    args: ['01'],
  },
  // An ordinary source file requires nothing.
  greenScenario: {
    setup: (dir) => put(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 01-gate\nplan: 01\nwave: 1\nfiles_modified:\n  - "src/a.ts"\n---\n\n<objective>\nx\n</objective>\n'),
    args: ['01'],
  },
});

/** A plan that declares a Pencil design file in files_modified, and a project-local Claude executor with `tools`. */
function toolPreflightScenario(tools) {
  return {
    setup: (dir) => {
      put(dir, '.planning/config.json', JSON.stringify({ runtime: 'claude' }));
      put(dir, '.claude/agents/gsd-executor.md', `---\nname: gsd-executor\ntools: ${tools}\n---\n\nbody\n`);
      put(dir, `${PHASE}/01-01-PLAN.md`, '---\nphase: 01-gate\nplan: 01\nwave: 1\nfiles_modified: [design/app.pen]\n---\n\n<tasks>\n<task type="auto"><name>Draw</name><action>Draw the screen</action></task>\n</tasks>\n');
    },
    args: ['01'],
  };
}

gateControl({
  gate: 'mn-tool-preflight',
  module: require('../gsd-core/bin/lib/gate-mn-tool-preflight.cjs'),
  fn: 'evaluateMnToolPreflight',
  red: 'block',
  expectRed: { status: 'finding', checked: 1 },
  // The executor cannot drive Pencil.
  redScenario: toolPreflightScenario('Read, Write'),
  // The same plan once the executor holds the grant.
  greenScenario: toolPreflightScenario('Read, Write, mcp__pencil__*'),
});

/**
 * Requirements and a REQUIREMENTS-REVIEW.md composed by the module itself (never by hand) from one
 * compat lens report holding `criticals` critical findings and no refutation.
 */
const requirementsReview = require('../gsd-core/bin/lib/requirements-review.cjs');
const requirementsReviewGate = require('../gsd-core/bin/lib/gate-mn-requirements-review.cjs');
const REQUIREMENTS_TEXT = '# Requirements\n\n- [ ] **API-02**: Login requires a device token\n';
function writeRequirementsReview(dir, criticals) {
  const report = ['---\nlens: compat\n---', '', ...criticals.map((title, i) => `### CR-0${i + 1}: ${title}\n\n**Requirement:** \`API-02\``), ''].join('\n');
  const composed = requirementsReview.composeReview({
    run: {
      version: 1, milestone: 'v1.0', requirements: '.planning/REQUIREMENTS.md',
      requirementsSha256: requirementsReview.requirementsDigest(REQUIREMENTS_TEXT), requirementIds: ['API-02'],
      lenses: ['compat'], preparedAt: '2026-11-01T00:00:00.000Z',
    },
    reports: [{ lens: 'compat', text: report }],
    refutation: null,
    accepted: [],
    reviewedAt: '2026-11-01T00:00:00.000Z',
  });
  put(dir, '.planning/REQUIREMENTS.md', REQUIREMENTS_TEXT);
  put(dir, '.planning/REQUIREMENTS-REVIEW.md', composed.text);
}

gateControl({
  gate: 'mn-requirements-review',
  module: require('../gsd-core/bin/lib/gate-mn-requirements-review.cjs'),
  fn: 'evaluateMnRequirementsReview',
  red: 'block',
  expectRed: { status: 'finding' },
  // A critical finding nobody refuted or accepted holds the roadmap.
  redScenario: { setup: (dir) => writeRequirementsReview(dir, ['Device token gate breaks released apps']), args: [] },
  // The same requirements reviewed without a critical finding.
  greenScenario: { setup: (dir) => writeRequirementsReview(dir, []), args: [] },
});

gateControl({
  gate: 'mn-clean-state',
  module: require('../gsd-core/bin/lib/gate-mn-clean-state.cjs'),
  fn: 'evaluateMnCleanState',
  red: 'block',
  expectRed: { status: 'finding', dirty: ['stray.txt'] },
  // An untracked file outside .planning/.
  redScenario: { git: true, setup: (dir) => put(dir, 'stray.txt', 'x\n'), args: ['01'] },
  greenScenario: { git: true, args: ['01'] },
});

gateControl({
  gate: 'mn-contract-drift',
  module: require('../gsd-core/bin/lib/gate-mn-contract-drift.cjs'),
  fn: 'evaluateMnContractDrift',
  red: 'block',
  expectRed: { status: 'finding', matched: 0 },
  // The code's return type drifted from the declared contract.
  redScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/DESIGN.md`, CONTRACT);
      put(dir, 'src/book.ts', bookRepository('Book | null'));
    },
    args: ['01'],
  },
  greenScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/DESIGN.md`, CONTRACT);
      put(dir, 'src/book.ts', bookRepository('Book'));
    },
    args: ['01'],
  },
});

gateControl({
  gate: 'mn-migration-safety',
  module: require('../gsd-core/bin/lib/gate-mn-migration-safety.cjs'),
  fn: 'evaluateMnMigrationSafety',
  red: 'block',
  expectRed: { status: 'finding' },
  // An undeclared DROP COLUMN.
  redScenario: { git: true, setup: migrationPhase('ALTER TABLE books DROP COLUMN subtitle;\n'), args: ['01', '--base', 'HEAD~1'] },
  // An additive migration loses nothing.
  greenScenario: { git: true, setup: migrationPhase('ALTER TABLE books ADD COLUMN subtitle text;\n'), args: ['01', '--base', 'HEAD~1'] },
});

gateControl({
  gate: 'mn-blast-radius',
  module: require('../gsd-core/bin/lib/gate-mn-blast-radius.cjs'),
  fn: 'evaluateMnBlastRadius',
  red: 'block',
  expectRed: { status: 'finding' },
  // A task commit changed a file no plan declared.
  redScenario: { git: true, setup: blastRadiusPhase({ 'src/declared.ts': '1\n', 'src/undeclared.ts': 'a\n' }), args: ['01'] },
  greenScenario: { git: true, setup: blastRadiusPhase({ 'src/declared.ts': '1\n' }), args: ['01'] },
});

gateControl({
  gate: 'mn-waves',
  module: require('../gsd-core/bin/lib/gate-mn-waves.cjs'),
  fn: 'evaluateMnWaveCollision',
  red: 'block',
  expectRed: { status: 'finding' },
  // Two same-wave plans declaring one file.
  redScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/01-01-PLAN.md`, wavePlan({ wave: 1, files: ['src/main.ts', 'src/a.ts'] }));
      put(dir, `${PHASE}/01-02-PLAN.md`, wavePlan({ wave: 1, files: ['src/main.ts', 'src/b.ts'] }));
    },
    args: ['01'],
  },
  greenScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/01-01-PLAN.md`, wavePlan({ wave: 1, files: ['src/a.ts'] }));
      put(dir, `${PHASE}/01-02-PLAN.md`, wavePlan({ wave: 1, files: ['src/b.ts'] }));
    },
    args: ['01'],
  },
});

gateControl({
  gate: 'mn-wave-solve',
  module: require('../gsd-core/bin/lib/gate-mn-wave-solve.cjs'),
  fn: 'evaluateMnWaveSolve',
  red: 'block',
  expectRed: { status: 'finding' },
  // A plan in the same wave as its own dependency.
  redScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/01-01-PLAN.md`, wavePlan({ wave: 1, files: ['src/a.ts'] }));
      put(dir, `${PHASE}/01-02-PLAN.md`, wavePlan({ wave: 1, deps: ['01-01'], files: ['src/b.ts'] }));
    },
    args: ['01'],
  },
  // Strictly later than its dependency.
  greenScenario: {
    setup: (dir) => {
      put(dir, `${PHASE}/01-01-PLAN.md`, wavePlan({ wave: 1, files: ['src/a.ts'] }));
      put(dir, `${PHASE}/01-02-PLAN.md`, wavePlan({ wave: 2, deps: ['01-01'], files: ['src/b.ts'] }));
    },
    args: ['01'],
  },
});

gateControl({
  gate: 'architecture-diagrams',
  module: require('../gsd-core/bin/lib/gate-architecture-diagrams.cjs'),
  fn: 'evaluateArchitectureDiagrams',
  red: 'block',
  expectRed: { status: 'absent_identifiers' },
  // A diagram names an identifier neither in the code nor in the design.
  redScenario: { git: true, setup: architectureDesign(['IThingRepository', 'FakeThingRepository']), args: [ARCH_PHASE] },
  greenScenario: { git: true, setup: architectureDesign(['IThingRepository']), args: [ARCH_PHASE] },
});


// ── A fixable state is a delivered verdict, not "could not look" ────────────────────────────────────
//
// The gate hosts (execute-pre-gate-hooks.md, ship.md, wave-post-gate-hooks.md, plan-phase.md) treat a
// non-zero exit at step 1 as "command error" and never show GATE_RESULT.message. So a state the user
// fixes — no record, a stale one, a base not measured — must exit 0 with block: true and its remedy in
// the message (the accept command, for the baseline), and reach step 2. 69 is kept for a read that
// failed and a phase that cannot be found (tests/mn-gate-dispatch.test.cjs).

const baselineGate = require('../gsd-core/bin/lib/gate-mn-baseline.cjs');
const verifyGatesGate = require('../gsd-core/bin/lib/gate-mn-verify-gates.cjs');
const mutationGate = require('../gsd-core/bin/lib/gate-mn-mutation-spot-check.cjs');

const configured = (dir) => put(dir, '.planning/config.json', JSON.stringify({ workflow: { verify_gates: { tests: 'npm test' } } }));

const FIXABLE_STATES = [
  { verb: 'mn-baseline', state: 'no baseline recorded', setup: (dir) => { configured(dir); put(dir, `${PHASE}/.keep`, ''); }, remedy: baselineGate.recordStep('01') },
  { verb: 'mn-baseline', state: 'nothing configured to measure', setup: (dir) => put(dir, `${PHASE}/.keep`, ''), remedy: null },
  { verb: 'mn-baseline', state: 'a baseline of other code', setup: (dir) => { recordBaseline(dir, true); put(dir, 'src/new.ts', 'x\n'); }, remedy: baselineGate.recordStep('01'), expect: { stale: true } },
  { verb: 'mn-baseline', state: 'a base not measured', setup: (dir) => recordBaseline(dir, false, 'stale'), remedy: baselineGate.acceptHint('01'), expect: { unmeasured: ['tests'] } },
  { verb: 'mn-verify-gates', state: 'no VERIFICATION.md', setup: (dir) => put(dir, `${PHASE}/.keep`, ''), remedy: verifyGatesGate.recordStep('01') },
  { verb: 'mn-verify-gates', state: 'no gates: record', setup: (dir) => put(dir, `${PHASE}/01-VERIFICATION.md`, '---\nphase: 01\nstatus: passed\n---\n'), remedy: verifyGatesGate.recordStep('01') },
  { verb: 'mn-verify-gates', state: 'a check not measured', setup: (dir) => recordGates(dir, false, 'stale'), remedy: null, expect: { unmeasured: ['tests'] } },
  { verb: 'mn-mutation-spot-check', state: 'no VERIFICATION.md', setup: (dir) => put(dir, `${PHASE}/.keep`, ''), remedy: mutationGate.RUN_STEP },
  { verb: 'mn-mutation-spot-check', state: 'no mutation: record', setup: (dir) => put(dir, `${PHASE}/01-VERIFICATION.md`, '---\nphase: 01\n---\n'), remedy: mutationGate.RUN_STEP },
  { verb: 'mn-requirements-review', state: 'no review yet', setup: (dir) => put(dir, '.planning/REQUIREMENTS.md', REQUIREMENTS_TEXT), remedy: requirementsReviewGate.REVIEW_COMMAND },
  { verb: 'mn-requirements-review', state: 'a review of other requirements', setup: (dir) => { writeRequirementsReview(dir, []); put(dir, '.planning/REQUIREMENTS.md', `${REQUIREMENTS_TEXT}- [ ] **X-03**: more\n`); }, remedy: requirementsReviewGate.REVIEW_COMMAND },
  { verb: 'mn-mutation-spot-check', state: 'a record of other code', setup: (dir) => { recordMutation(dir, MUTATION_STATUS.PASSED); put(dir, 'src/a.ts', 'export const a = 2;\n'); }, remedy: mutationGate.RUN_STEP, expect: { stale: true } },
];

describe('fork gates: a fixable could-not-judge state is a delivered block with its remedy', () => {
  for (const c of FIXABLE_STATES) {
    test(`${c.verb}: ${c.state} exits 0, blocks, and names what to run`, (t) => {
      const dir = createTempGitProject('gsd-mn-fixable-');
      t.after(() => cleanup(dir));
      c.setup(dir);
      const r = runGsdTools(['check', c.verb, '01', '--raw'], dir);
      assert.equal(r.exitCode, 0, `a fixable state must reach the host's step 2, not its "command error": ${r.error}`);
      const payload = JSON.parse(r.output);
      assert.deepEqual([payload.block, payload.status], [true, 'unresolvable']);
      assert.equal(typeof payload.message, 'string');
      if (c.remedy !== null) assert.ok(payload.message.includes(c.remedy), `the message must name ${c.remedy}: ${payload.message}`);
      for (const [key, value] of Object.entries(c.expect || {})) assert.deepEqual(payload[key], value, key);
    });
  }
});
