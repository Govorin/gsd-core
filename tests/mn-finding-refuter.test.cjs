// allow-test-rule: source-text-is-the-product (#1190) — the agent definition
// and the reference it dispatches through ARE the shipped artifact: their exact
// wording is what a model loads, so the contract below can only be asserted
// against that text. Nothing here greps code under test.
'use strict';

/**
 * gsd-finding-refuter — an adversarial pass over plan-checker findings.
 *
 * Seams: agents/gsd-finding-refuter.md (the agent), the step-11b block in
 * gsd-core/workflows/plan-phase.md (when it runs), and
 * gsd-core/references/finding-refutation.md (how its result is routed).
 *
 * Why an agent needs a test at all: the defect this guards against is not a
 * crash, it is drift in the ONE property that makes the pass worth running —
 * the burden of proof sits on the finding, so a finding may only be dropped
 * with evidence. Loosen that and the refuter becomes a second opinion that
 * argues findings away, which is strictly worse than not having it: the
 * checker's false positives cost one revision each, while a refuted true
 * positive ships a defect into execution.
 *
 * The assertions therefore pin the asymmetry, the closed verdict vocabulary,
 * and the routing rules that make a partial result safe — not the prose.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseFrontmatter } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const AGENT = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-finding-refuter.md'), 'utf8');
const REFERENCE = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'references', 'finding-refutation.md'),
  'utf8'
);
const WORKFLOW = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'plan-phase.md'),
  'utf8'
);
const CAPABILITY = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'capabilities', 'mn-verify-gate', 'capability.json'), 'utf8')
);

describe('finding refuter — the agent contract', () => {
  test('is declared read-only', () => {
    // A refuter that can write could "resolve" a finding by editing the plan,
    // which converts a disputed finding into a silent change nobody reviewed.
    const fm = parseFrontmatter(AGENT);
    assert.equal(fm.name, 'gsd-finding-refuter');
    const tools = String(fm.tools)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const forbidden of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      assert.ok(!tools.includes(forbidden), `refuter must not carry ${forbidden}`);
    }
    for (const required of ['Read', 'Grep', 'Bash']) {
      assert.ok(
        tools.includes(required),
        `refuting a finding requires ${required} — evidence has to come from somewhere`
      );
    }
  });

  test('states the default verdict, and states it as UPHELD', () => {
    // The whole design rests on this: unsure means the finding stands.
    assert.match(AGENT, /Default to UPHELD/i);
    assert.match(AGENT, /If you are unsure, the finding stands/i);
  });

  test('names the asymmetry that justifies the default', () => {
    // An upheld false positive costs one revision; a refuted true positive
    // ships a defect. If that sentence goes, the default looks arbitrary and
    // the next editor will "balance" it.
    assert.match(AGENT, /upheld false positive costs one revision/i);
    assert.match(AGENT, /refuted true positive ships a defect/i);
  });

  test('rules out the three arguments that are not evidence', () => {
    // Each of these reads as a refutation and is not one. They are listed
    // explicitly because a model asked to "try to refute" will reach for them.
    assert.match(AGENT, /severity is not truth/i);
    assert.match(AGENT, /cost is not truth/i);
    assert.match(
      AGENT,
      /would read the same way without you having opened a single file/i,
      'the catch-all for arguments made without looking'
    );
  });

  test('forbids the refuter from adding findings of its own', () => {
    // It is not a second reviewer. A refuter that adds findings turns a
    // precision pass into another source of revisions.
    assert.match(AGENT, /Never introduce a finding of your own/i);
    assert.match(AGENT, /revision loop must not silently grow new work/i);
  });

  test('closes the verdict vocabulary at two values', () => {
    // A third verdict ("unclear") would become the dumping ground for exactly
    // the findings that most need a decision.
    assert.match(AGENT, /there is no third verdict/i);
    assert.match(AGENT, /upheld \+ refuted. equals the number of findings/i);
  });
});

describe('finding refuter — how the workflow runs it', () => {
  test('runs only when configured, and only after ISSUES FOUND', () => {
    assert.match(WORKFLOW, /## 11b\. Refute Findings \(conditional\)/);
    assert.match(WORKFLOW, /workflow\.refute_findings/);
    assert.match(
      WORKFLOW,
      /checker returned `## ISSUES FOUND`/,
      'a refutation pass over an empty finding set is pure cost'
    );
  });

  test('sits between the checker return and the revision loop', () => {
    // Order is the point: after the findings exist, before the planner is
    // asked to act on them. Running it after a revision would refute findings
    // the planner had already addressed.
    const checkerReturn = WORKFLOW.indexOf('## 11. Handle Checker Return');
    const refute = WORKFLOW.indexOf('## 11b. Refute Findings');
    const revision = WORKFLOW.indexOf('## 12. Revision Loop');
    assert.ok(checkerReturn > 0 && refute > 0 && revision > 0, 'all three steps must exist');
    assert.ok(checkerReturn < refute, 'refutation must follow the checker');
    assert.ok(refute < revision, 'refutation must precede the revision loop');
  });

  test('the reference defines what happens to a partial or unparseable result', () => {
    // The dangerous case: a refutation missing some findings would silently
    // drop whichever ones it forgot. Discarding the whole thing is the only
    // safe reading, and it has to be written down.
    assert.match(REFERENCE, /verdict count does not match the\s+finding count/i);
    assert.match(REFERENCE, /discard the refutation entirely/i);
    assert.match(
      REFERENCE,
      /partial refutation is worse than none/i,
      'the reason, not just the rule'
    );
  });

  test('the reference forbids looping the checker against the refuter', () => {
    // Two agents disputing each other converge on the more stubborn one, not
    // on the truth.
    assert.match(REFERENCE, /Do not re-run the checker/i);
    assert.match(REFERENCE, /whichever one is more stubborn/i);
  });

  test('the reference requires the dropped findings to be shown with their evidence', () => {
    // A refutation nobody can check is the same defect as the false finding it
    // removed, one level up.
    assert.match(REFERENCE, /not sent to the planner/i);
    assert.match(REFERENCE, /evidence line is not decoration/i);
  });

  test('the reference passes the findings through verbatim', () => {
    // A summarised finding is a different finding; the refuter would then be
    // disputing the orchestrator's paraphrase.
    assert.match(REFERENCE, /verbatim — do not summarise or renumber/i);
  });
});

describe('finding refuter — registration', () => {
  test('the capability declares the agent and the key that gates it', () => {
    assert.ok(
      CAPABILITY.agents.includes('gsd-finding-refuter'),
      'an agent no capability declares is installed by nothing'
    );
    const key = CAPABILITY.config['workflow.refute_findings'];
    assert.ok(key, 'the workflow reads workflow.refute_findings; the capability must declare it');
    assert.equal(key.type, 'boolean');
    assert.equal(key.default, false, 'a pass that spawns an extra agent per revision is opt-in');
  });

  test('the config description records why self-critique was not used instead', () => {
    // The cheaper-looking alternative — have the checker critique itself — is
    // measurably worse, and without the numbers written down someone will
    // propose it again.
    assert.match(CAPABILITY.config['workflow.refute_findings'].description, /27%/);
    assert.match(CAPABILITY.config['workflow.refute_findings'].description, /5\.11/);
  });

  test('the key reaches the workflow through a hook, not an inline config read', () => {
    // ADR-857 phase 6 (#1169): the host loop must not `config-get` a
    // capability-owned key. The key gates a plan:pre contribution (into the
    // checker, which is told its findings will be challenged); render-hooks
    // resolves the `when`, and step 11b keys off that active hook.
    const hook = CAPABILITY.contributions.find(
      (c) => c.point === 'plan:pre' && c.into === 'checker' && c.when === 'workflow.refute_findings'
    );
    assert.ok(hook, 'mn-verify-gate must declare a plan:pre checker contribution gated by workflow.refute_findings');
    const fragment = fs.readFileSync(path.join(ROOT, 'capabilities', 'mn-verify-gate', hook.fragment.path), 'utf8');
    assert.match(fragment, /step 11b/);
    assert.match(WORKFLOW, /PLAN_PRE_HOOKS_JSON` has an active hook with `when == "workflow\.refute_findings"`/);
    assert.doesNotMatch(WORKFLOW, /config-get\s+workflow\.refute_findings/);
  });
});
