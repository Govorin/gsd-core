// source-text-is-the-product (CONTRIBUTING.md): the planner fragment, the PLAN template and the
// reference are the shipped artifact; the "contract text" block below reads only markdown and JSON
// and judges the template through the gate itself, so the no-source-grep rule has nothing for a
// marker to suppress.
'use strict';

/**
 * `gsd_run check mn-failure-paths` — the pre-mortem as an artifact (src/gate-mn-failure-paths.cts;
 * upstream-sync plan, phase 4.2; contract gsd-core/references/failure-paths.md).
 *
 * A plan names its failure paths in `<failure_paths>`: each `<failure_path>` carries an
 * `<invariant>` and a `<check>` whose `<automated>`/`<fails_when>` pair is judged by the #3172
 * recognizer (`extractFailingDirections` / `resolveFailingDirection`), reused rather than copied.
 * A plan whose `files_modified` names a migration, or whose `user_setup` is non-empty, must
 * declare one. The verdict reports `paths_without_check / paths`.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck, runMnCheckFailure } = require('./helpers/mn-gate-fixture.cjs');
const {
  evaluateMnFailurePaths,
  analyzePlanFailurePaths,
  failurePathTriggers,
  FAILURE_PATH_SEVERITY,
} = require('../gsd-core/bin/lib/gate-mn-failure-paths.cjs');
const { MAX_LISTED } = require('../gsd-core/bin/lib/gate-mn-waves.cjs');
const { isMnCheckVerb } = require('../gsd-core/bin/lib/gate-mn-dispatch.cjs');

const ROOT = path.join(__dirname, '..');
const CAPABILITY = JSON.parse(fs.readFileSync(path.join(ROOT, 'capabilities', 'mn-verify-gate', 'capability.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** A plan in the shape the planner emits: frontmatter, then the body. */
function plan({ files = [], userSetup = null, body = '' } = {}) {
  const fileLines = files.length === 0 ? ' []' : `\n${files.map((f) => `  - "${f}"`).join('\n')}`;
  const setup = userSetup === null ? '' : `user_setup:${userSetup}\n`;
  return `---\nphase: 01-gate\nplan: 01\nwave: 1\nfiles_modified:${fileLines}\n${setup}---\n\n<objective>\nx\n</objective>\n\n${body}\n`;
}

/** One `<failure_path>`; pass `null` to omit a part. */
function failurePath({ name = 'rows lose their id', invariant = 'every row keeps a non-null id', command = 'psql -tAc "select count(*) from t where id is null"', failsWhen = 'the count is not 0', check = undefined } = {}) {
  const parts = ['<failure_path>'];
  if (name !== null) parts.push(`  <name>${name}</name>`);
  if (invariant !== null) parts.push(`  <invariant>${invariant}</invariant>`);
  if (check !== undefined) {
    if (check !== null) parts.push(check);
  } else {
    const inner = [];
    if (command !== null) inner.push(`    <automated>${command}</automated>`);
    if (failsWhen !== null) inner.push(`    <fails_when>${failsWhen}</fails_when>`);
    parts.push(`  <check>\n${inner.join('\n')}\n  </check>`);
  }
  parts.push('</failure_path>');
  return parts.join('\n');
}

const block = (...paths) => `<failure_paths>\n${paths.join('\n')}\n</failure_paths>`;
const MIGRATION = 'apps/api/drizzle/0007_add_ignored_at.sql';
const kinds = (findings) => findings.map((f) => [f.kind, f.severity]);

describe('check mn-failure-paths — when a plan must declare failure paths', () => {
  test('a migration in files_modified requires the block', () => {
    assert.deepEqual(failurePathTriggers(plan({ files: [MIGRATION] })), [`migration ${MIGRATION}`]);
    const judged = analyzePlanFailurePaths('01-01-PLAN.md', plan({ files: [MIGRATION] }));
    assert.deepEqual(kinds(judged.findings), [['required-absent', 'blocker']]);
  });

  test('a non-empty user_setup requires the block', () => {
    const text = plan({ userSetup: '\n  - service: stripe\n    why: "payments"' });
    assert.deepEqual(failurePathTriggers(text), ['user_setup']);
    assert.deepEqual(kinds(analyzePlanFailurePaths('p', text).findings), [['required-absent', 'blocker']]);
  });

  test('an empty user_setup, a migration journal and ordinary source files require nothing', () => {
    // The journal under meta/ is not a migration (isMigrationPath, shared with mn-migration-safety),
    // and `user_setup: []` declares no service — small plans must pay nothing.
    const text = plan({ files: ['apps/api/drizzle/meta/_journal.json', 'src/main.ts'], userSetup: ' []' });
    assert.deepEqual(failurePathTriggers(text), []);
    assert.deepEqual(analyzePlanFailurePaths('p', text).findings, []);
  });

  test('a required plan with an empty block is still required-absent, not merely empty', () => {
    const judged = analyzePlanFailurePaths('p', plan({ files: [MIGRATION], body: '<failure_paths>\n</failure_paths>' }));
    assert.deepEqual(kinds(judged.findings), [['required-absent', 'blocker']]);
  });

  test('an empty block on a plan nothing requires it of is a warning', () => {
    const judged = analyzePlanFailurePaths('p', plan({ body: '<failure_paths>\n</failure_paths>' }));
    assert.deepEqual(kinds(judged.findings), [['empty-block', 'warning']]);
  });
});

describe('check mn-failure-paths — judging one path', () => {
  const judge = (pathXml) => analyzePlanFailurePaths('p', plan({ files: [MIGRATION], body: block(pathXml) }));

  test('a path with an invariant and a stated check raises nothing and counts as checked', () => {
    const judged = judge(failurePath());
    assert.deepEqual(judged.findings, []);
    assert.equal(judged.paths[0].checked, true);
    assert.equal(judged.paths[0].name, 'rows lose their id');
    assert.equal(judged.paths[0].checks[0].status, 'ok');
  });

  test('a path with no <check> block is no-check', () => {
    const judged = judge(failurePath({ check: null }));
    assert.deepEqual(kinds(judged.findings), [['no-check', 'blocker']]);
    assert.equal(judged.paths[0].checked, false);
  });

  test('a <check> holding no <automated> is no-check', () => {
    const judged = judge(failurePath({ check: '  <check>\n    the dashboard looks right\n  </check>' }));
    assert.deepEqual(kinds(judged.findings), [['no-check', 'blocker']]);
  });

  for (const [label, failsWhen, status] of [
    ['missing', null, 'missing'],
    ['empty', '   ', 'empty'],
    ['placeholder', 'TBD', 'placeholder'],
  ]) {
    test(`a check command whose <fails_when> is ${label} cannot fail`, () => {
      const judged = judge(failurePath({ failsWhen }));
      assert.deepEqual(kinds(judged.findings), [['check-unstated', 'blocker']]);
      assert.equal(judged.paths[0].checks[0].status, status);
      assert.equal(judged.paths[0].checked, false);
    });
  }

  test('placeholder matching is whole-value, the #3172 rule — real prose containing TBD passes', () => {
    assert.deepEqual(judge(failurePath({ failsWhen: 'TBD appears in the migrate log' })).findings, []);
  });

  for (const [label, invariant, status] of [
    ['missing', null, 'missing'],
    ['empty', '', 'empty'],
    ['placeholder', 'n/a', 'placeholder'],
  ]) {
    test(`an invariant that is ${label} is invariant-unstated`, () => {
      const judged = judge(failurePath({ invariant }));
      assert.deepEqual(kinds(judged.findings), [['invariant-unstated', 'blocker']]);
      assert.equal(judged.paths[0].invariantStatus, status);
      assert.equal(judged.paths[0].checked, true, 'the check is judged on its own');
    });
  }

  test('the Wave-0 MISSING sentinel is a check (8a/8d own it), not a finding', () => {
    const judged = judge(failurePath({ command: 'MISSING — Wave 0 must create tests/backfill.spec.ts', failsWhen: null }));
    assert.deepEqual(judged.findings, []);
    assert.equal(judged.paths[0].checked, true);
  });

  test('one stated command keeps the path checked; the unstated one is still a blocker', () => {
    const check = '  <check>\n    <automated>npm test</automated>\n    <fails_when>non-zero exit</fails_when>\n    <automated>psql -c x</automated>\n  </check>';
    const judged = judge(failurePath({ check }));
    assert.deepEqual(kinds(judged.findings), [['check-unstated', 'blocker']]);
    assert.equal(judged.paths[0].checked, true);
  });

  test('a <fails_when> before every command is an orphan warning; the command after it is judged alone', () => {
    const check = '  <check>\n    <fails_when>stray</fails_when>\n    <automated>npm test</automated>\n    <fails_when>non-zero exit</fails_when>\n  </check>';
    const judged = judge(failurePath({ check }));
    assert.deepEqual(kinds(judged.findings), [['orphan-statement', 'warning']]);
    assert.equal(judged.paths[0].checked, true);
  });

  test('a path without a name is labelled by position', () => {
    const judged = judge(failurePath({ name: null, check: null }));
    assert.equal(judged.paths[0].name, null);
    assert.match(judged.findings[0].detail, /^path 1:/);
  });
});

describe('check mn-failure-paths — the phase verdict', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-failure-paths-');
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function gateOn(files) {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnFailurePaths({ projectDir, args: [phaseNumber] }).payload;
  }

  test('no plan requires or declares a path: pass, and the ratio is null — 0/0 is not 0', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ files: ['src/a.ts'] }) });
    assert.equal(v.block, false);
    assert.equal(v.status, 'pass');
    assert.deepEqual(v.metrics, {
      plans: 1,
      plans_required: 0,
      plans_required_absent: 0,
      paths: 0,
      paths_without_check: 0,
      paths_without_check_ratio: null,
    });
  });

  test('the metric is the share of declared paths nothing would notice', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ files: [MIGRATION], body: block(failurePath(), failurePath({ check: null })) }),
    });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.equal(v.metrics.paths, 2);
    assert.equal(v.metrics.paths_without_check, 1);
    assert.equal(v.metrics.paths_without_check_ratio, 0.5);
    assert.deepEqual(v.counts, { blocker: 1, warning: 0 });
    assert.match(v.summary, /2 path\(s\) in 1 plan\(s\), 1 without a check/);
  });

  test('a required plan that declares nothing blocks and is counted as required-absent', () => {
    const v = gateOn({
      '01-01-PLAN.md': plan({ files: [MIGRATION] }),
      '01-02-PLAN.md': plan({ files: ['src/b.ts'] }),
    });
    assert.equal(v.block, true);
    assert.equal(v.metrics.plans_required, 1);
    assert.equal(v.metrics.plans_required_absent, 1);
    assert.deepEqual(v.findings.map((f) => [f.plan, f.kind]), [['01-01-PLAN.md', 'required-absent']]);
  });

  test('warnings alone ride in a passing verdict', () => {
    const v = gateOn({ '01-01-PLAN.md': plan({ body: '<failure_paths>\n</failure_paths>' }) });
    assert.equal(v.block, false);
    assert.deepEqual(v.counts, { blocker: 0, warning: 1 });
  });

  test('a PLAN.md that is a directory is unresolvable and blocks — could not look is not clean', () => {
    const { phaseDir, phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': plan() });
    fs.mkdirSync(path.join(phaseDir, '01-02-PLAN.md'));
    const v = evaluateMnFailurePaths({ projectDir, args: [phaseNumber] }).payload;
    assert.equal(v.block, true);
    assert.equal(v.status, 'unresolvable');
  });

  test('an unknown phase is unresolvable; no phase at all is a usage failure', () => {
    assert.equal(evaluateMnFailurePaths({ projectDir, args: ['99'] }).payload.status, 'unresolvable');
    assert.ok(evaluateMnFailurePaths({ projectDir, args: [] }).failure);
  });

  // Payload cap (the `@file:` threshold rule): a list at, below and above MAX_LISTED.
  for (const count of [MAX_LISTED - 1, MAX_LISTED, MAX_LISTED + 1]) {
    test(`${count} findings: the list is capped at ${MAX_LISTED} and the true count rides beside it`, () => {
      const paths = Array.from({ length: count }, () => failurePath({ check: null }));
      const v = gateOn({ '01-01-PLAN.md': plan({ files: [MIGRATION], body: block(...paths) }) });
      assert.equal(v.findingsTotal, count);
      assert.equal(v.findings.length, Math.min(count, MAX_LISTED));
      assert.equal(v.pathsTotal, count);
      assert.equal(v.paths.length, Math.min(count, MAX_LISTED));
      assert.equal(v.metrics.paths_without_check, count, 'the metric counts every path, not the listed ones');
    });
  }

  test('gsd_run check mn-failure-paths --phase N prints the verdict', () => {
    const { phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': plan({ files: [MIGRATION] }) });
    const payload = runMnCheck(projectDir, 'mn-failure-paths', ['--phase', phaseNumber]);
    assert.equal(payload.block, true);
    assert.equal(payload.findings[0].kind, 'required-absent');
  });

  test('gsd_run check mn-failure-paths with no phase fails its invocation', () => {
    runMnCheckFailure(projectDir, 'mn-failure-paths');
  });
});

describe('check mn-failure-paths — wiring', () => {
  test('the verb is registered in the mn dispatch table', () => {
    assert.equal(isMnCheckVerb('mn-failure-paths'), true);
  });

  test('plan:post halts on the verdict only when opted in; the planner instruction ships on', () => {
    const gates = CAPABILITY.gates.filter((g) => g.check.query === 'mn-failure-paths');
    assert.deepEqual(
      gates.map((g) => [g.point, g.when, g.blocking, g.onError]),
      [['plan:post', 'workflow.failure_paths_enforce', true, 'halt']],
    );
    assert.equal(CAPABILITY.config['workflow.failure_paths'].default, true, 'an instruction that blocks nothing — absent = enabled');
    assert.equal(CAPABILITY.config['workflow.failure_paths_enforce'].default, false, 'a new blocking gate ships off');
  });

  test('the planner is asked for the block through a plan:pre fragment, not the frozen agent file', () => {
    const contribution = CAPABILITY.contributions.find((c) => c.when === 'workflow.failure_paths');
    assert.ok(contribution, 'a contribution keyed on workflow.failure_paths must be declared');
    assert.equal(contribution.point, 'plan:pre');
    assert.equal(contribution.into, 'planner');
    const fragment = read(path.join('capabilities', 'mn-verify-gate', contribution.fragment.path));
    assert.match(fragment, /check mn-failure-paths/, 'the planner self-checks with the same verdict');
    assert.match(fragment, /failure-paths\.md/);
  });
});

describe('check mn-failure-paths — the contract text', () => {
  test('the PLAN template skeleton is itself a clean failure path under the gate', () => {
    // The template is what planners copy: if its skeleton tripped the gate, every plan built from
    // it would start with a blocker. Judge it with the gate rather than matching its text.
    const template = read('gsd-core/templates/plan.md');
    const judged = analyzePlanFailurePaths('template', plan({ files: [MIGRATION], body: template }));
    assert.equal(judged.paths.length, 1, 'the template carries exactly one skeleton path');
    assert.deepEqual(judged.findings, []);
  });

  test('the reference documents every verdict kind the gate can emit, at its severity', () => {
    const reference = read('gsd-core/references/failure-paths.md');
    for (const [kind, severity] of Object.entries(FAILURE_PATH_SEVERITY)) {
      assert.match(reference, new RegExp(`\\| \`${kind}\` \\| ${severity} \\|`), `failure-paths.md must document ${kind} as ${severity}`);
    }
  });
});
