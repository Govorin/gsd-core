// source-text-is-the-product (CONTRIBUTING.md): the planner fragment, the PLAN template, the
// plan-checker agent and the revision reference ARE the shipped artifact; their wording is what a
// model loads, so the contract can only be asserted against that text. Only markdown and JSON are
// read, so the no-source-grep rule has nothing for a marker to suppress.
'use strict';

/**
 * Restate the task before planning it (upstream-sync plan, phase 4.6; poteto: "in your own words"
 * catches false trails before code exists).
 *
 * Seams: capabilities/mn-verify-gate/fragments/plan-pre-restate-goal.md (the planner instruction,
 * injected at plan:pre under workflow.restate_goal), gsd-core/templates/plan.md (the <objective>
 * shape), agents/gsd-plan-checker.md Dimension 1b (the comparison with the phase goal), and
 * gsd-core/references/planner-revision.md (the revision strategy).
 *
 * Why the lines live inside <objective>: the plan already has a field for "what this accomplishes";
 * a second, parallel field would split the claim in two and let them drift. The restatement extends
 * the objective with the parts it lacked — the goal in the planner's words, what the phase does not
 * do, and where both came from — and the checker strengthens its reading of that one field.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractTaggedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CAPABILITY = JSON.parse(read('capabilities/mn-verify-gate/capability.json'));
const CONTRIBUTION = CAPABILITY.contributions.find((c) => c.when === 'workflow.restate_goal');
const FRAGMENT = read(path.join('capabilities', 'mn-verify-gate', CONTRIBUTION.fragment.path));
const CHECKER = read('agents/gsd-plan-checker.md');
const TEMPLATE = read('gsd-core/templates/plan.md');

/** The line labels the fragment's example block defines (`Restated:` …) — the contract's vocabulary. */
function fragmentLabels() {
  const example = FRAGMENT.split('```')[1] || '';
  return example
    .split('\n')
    .map((line) => /^([A-Z][A-Za-z ]+):/.exec(line))
    .filter(Boolean)
    .map((m) => `${m[1]}:`);
}

/** The Dimension 1b section of the checker, up to the next dimension heading. */
function dimension1b() {
  return CHECKER.split('## Dimension 1b: Restated Goal')[1]?.split('\n## ')[0];
}

describe('restated goal — registration', () => {
  test('the planner instruction is a plan:pre fragment keyed on workflow.restate_goal', () => {
    assert.ok(CONTRIBUTION, 'a contribution keyed on workflow.restate_goal must be declared');
    assert.equal(CONTRIBUTION.point, 'plan:pre');
    assert.equal(CONTRIBUTION.into, 'planner');
  });

  test('the key ships on — an instruction with no gate is absent = enabled', () => {
    const key = CAPABILITY.config['workflow.restate_goal'];
    assert.equal(key.type, 'boolean');
    assert.equal(key.default, true);
  });
});

describe('restated goal — one field, three lines, the same everywhere', () => {
  test('the fragment defines exactly the three lines', () => {
    assert.deepEqual(fragmentLabels(), ['Restated:', 'Not doing:', 'Sources:']);
  });

  test('the lines extend the existing <objective> rather than adding a second field', () => {
    assert.match(FRAGMENT, /<objective>/);
    assert.match(FRAGMENT, /not a second one/);
    const objective = extractTaggedBlocks(TEMPLATE, 'objective')[0];
    assert.ok(objective, 'the PLAN template must carry an <objective> block');
    for (const label of fragmentLabels()) {
      assert.ok(objective.split('\n').some((line) => line.startsWith(label)), `the template <objective> must carry ${label}`);
    }
  });

  test('the checker compares the same lines the planner writes', () => {
    const section = dimension1b();
    assert.ok(section, 'agents/gsd-plan-checker.md must carry Dimension 1b');
    for (const label of fragmentLabels()) {
      assert.ok(section.includes(`\`${label}\``), `Dimension 1b must name ${label}`);
    }
  });
});

describe('restated goal — what the checker does with it', () => {
  test('a contradiction or a required exclusion is a blocker; a missing or copied line a warning', () => {
    const section = dimension1b();
    assert.match(section, /\*\*BLOCKER\*\* — `Restated:` contradicts the goal/);
    assert.match(section, /`Not doing:` excludes something the goal, a phase requirement or a locked/);
    assert.match(section, /\*\*WARNING\*\* — a line missing; `Restated:` copies the ROADMAP goal verbatim/);
  });

  test('the dimension skips when the planner was not asked, instead of flagging every plan', () => {
    assert.match(dimension1b(), /\*\*Skip if\*\* no plan's `<objective>` carries `Restated:`/);
  });

  test('the revision reference gives the planner a route for the dimension', () => {
    assert.match(read('gsd-core/references/planner-revision.md'), /\| restated_goal \|/);
    assert.match(dimension1b(), /Dimension `restated_goal`/);
  });
});
