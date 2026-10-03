// allow-test-rule: source-text-is-the-product (#1190) — the reviewer agent and
// the reference it reads ARE the shipped artifact; their wording is what a model
// loads, so the contract below can only be asserted against that text.
'use strict';

/**
 * "What guards this?" — provenance on every review finding.
 *
 * Seams: agents/gsd-code-reviewer.md (the requirement) and
 * gsd-core/references/enforcement-provenance.md (the rule and its rationale).
 *
 * Where this comes from: the author's own mn/docs/architecture/enforcement.md
 * makes it a MANDATORY review step — "для каждой находки сказал, чем она
 * стережётся — линтом или только ревью" — with the reason stated plainly: the
 * verdict "violation" and the verdict "CI will catch this" are different
 * claims, and the second is usually wrong.
 *
 * Why it is worth a test rather than a paragraph: the failure it prevents is
 * silent by construction. A reviewer who says "the linter has this" when it
 * does not produces a silence that reads as safety — nobody re-examines the
 * boundary, and the next violation is invisible until someone happens to look.
 * The defect is not the missing rule; it is the false claim that one exists.
 * If this requirement erodes back into prose, nothing fails — which is exactly
 * why the assertions below pin it.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const REVIEWER = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-code-reviewer.md'), 'utf8');
const REFERENCE = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'references', 'enforcement-provenance.md'),
  'utf8'
);
const CAPABILITY = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'capabilities', 'mn-verify-gate', 'capability.json'), 'utf8')
);

describe('enforcement provenance — the reviewer requirement', () => {
  test('every finding must name what guards it, in one of two forms', () => {
    assert.match(REVIEWER, /guarded by:/);
    assert.match(
      REVIEWER,
      /review only/i,
      'the "nothing guards this" case is the one that matters — without it the field collapses to naming a rule when one happens to exist'
    );
  });

  test('the two claims are stated as distinct', () => {
    // If these merge back into one, the requirement becomes decorative: a
    // reviewer will write the name of whatever rule sounds related.
    assert.match(REVIEWER, /two different claims/i);
    assert.match(REVIEWER, /wrong more often than expected/i);
  });

  test('the reviewer is told to check scope and severity, not to recall them', () => {
    // The specific trap: rules that read as general but are hardcoded to one
    // domain, and rules at `warn` in a project whose lint step tolerates
    // warnings. Both are real in the codebase this came from.
    assert.match(REVIEWER, /severity and scope|scope and severity/i);
    assert.match(REVIEWER, /hardcoded to one domain/i);
  });

  test('it says what the distinction changes — otherwise it is a label', () => {
    assert.match(
      REVIEWER,
      /recurs the moment nobody is looking|ships with a mechanism|knowingly accepted/i
    );
  });
});

describe('enforcement provenance — the rule itself', () => {
  test('a check counts as a mechanism only with an execution point', () => {
    assert.match(REFERENCE, /only once it has an assigned execution point/i);
    assert.match(
      REFERENCE,
      /worse than none/i,
      'the sharp half of the rule: an uninvoked script removes the question from review while checking nothing'
    );
  });

  test('all three conditions for "CI will catch this" are listed', () => {
    // A rule existing is not enough; it must be invoked, and the invoker must
    // run on this change. Dropping any one of the three is how a repository
    // accumulates apparent coverage.
    assert.match(REFERENCE, /a rule or script exists/i);
    assert.match(REFERENCE, /something invokes it/i);
    assert.match(REFERENCE, /actually runs on the change/i);
  });

  test('adding a check is defined as three steps, not one', () => {
    assert.match(REFERENCE, /three steps, not one/i);
    assert.match(
      REFERENCE,
      /enlarges the illusion of coverage/i,
      'the consequence of stopping after step one'
    );
  });

  test('the asymmetry is stated, so the rule is not read as pedantry', () => {
    // Naming a redundant mechanism costs a line; claiming a mechanism that
    // does not exist costs the invariant.
    assert.match(REFERENCE, /inverse costs little/i);
  });
});

describe('enforcement provenance — registration', () => {
  test('the capability declares the key the reviewer reads', () => {
    const key = CAPABILITY.config['workflow.enforcement_provenance'];
    assert.ok(key, 'the agent references workflow.enforcement_provenance; the capability must declare it');
    assert.equal(key.type, 'boolean');
    assert.equal(key.default, false);
  });

  test('the description records where the discipline came from', () => {
    // Provenance for the provenance rule: it is not invented here, it is
    // lifted from a working doctrine, and knowing that is what stops it being
    // "simplified" by someone who has not seen it fail.
    assert.match(CAPABILITY.config['workflow.enforcement_provenance'].description, /enforcement\.md/);
  });
});
