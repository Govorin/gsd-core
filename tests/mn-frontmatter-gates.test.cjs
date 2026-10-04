'use strict';

/**
 * mn-verify-gate's four frontmatter gates — the built-in `artifact-frontmatter-equals` predicate as
 * the capability DECLARES it.
 *
 *   nyquist_enforce       VALIDATION.md    nyquist_compliant == true
 *   verify_enforce        VERIFICATION.md  truths_unproven   == 0
 *   mn_security_enforce   SECURITY.md      threats_open      == 0      optional
 *   mn_windows_enforce    WINDOWS.md       open_count        == 0      optional
 *
 * verify_gates_enforce used to be a fifth, on the nested `gates.all_passed`. It is now
 * `check mn-verify-gates` (tests/mn-verify-gates.test.cjs), because the predicate could only say
 * "all_passed is false" — the same words for a red suite and a command that no longer exists. The
 * nested-field reading it relied on is still pinned below with a literal predicate: other gates
 * may declare a dotted field.
 *
 * These gates used to run `check-frontmatter.mjs` from `$HOME/.gsd` through `command-exit-zero`,
 * because the published 1.9.1 evaluator did not know `artifact-frontmatter-equals`. The built-in
 * predicate now carries both things the script added: a dotted `field` into a nested map and
 * `optional: true`. Each declared-gate test below takes the predicate object straight out of
 * capability.json, so what is pinned is the shipped declaration, not a hand-copied one.
 *
 * Two behaviours carry most of the weight. `0` and `false` must compare as values and not be
 * swallowed as falsy — three of the four gates compare against exactly those. And `optional` must
 * tell "the artifact does not exist" (a phase with no security review is not a phase with open
 * threats) from "the field says something else".
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const { evaluateCheckPredicate } = require('../gsd-core/bin/lib/gate-predicate.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

/** The predicate the capability declares for the gate switched on by `when`. */
function declaredPredicate(when) {
  const gate = CAPABILITY.gates.find((g) => g.when === when);
  assert.ok(gate, `capability.json declares no gate for ${when}`);
  assert.ok(gate.check.predicate, `${when} must be a predicate gate`);
  return gate.check.predicate;
}

describe('mn-verify-gate frontmatter gates (artifact-frontmatter-equals)', () => {
  let projectDir;
  let phaseDir;

  beforeEach(() => {
    projectDir = createTempProject('gsd-mn-frontmatter-');
    phaseDir = path.join(projectDir, '.planning', 'phases', '01-gate');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function writeArtifact(name, frontmatter, body = '\n# report\n') {
    fs.writeFileSync(path.join(phaseDir, name), `---\n${frontmatter}\n---\n${body}`);
  }

  /** Evaluate the declared gate in-process: the verdict the router would print. */
  function gate(when) {
    const result = evaluateCheckPredicate({
      projectDir,
      args: ['--predicate', JSON.stringify(declaredPredicate(when)), '--phase-dir', phaseDir],
    });
    assert.ok(!result.failure, `the declared predicate must evaluate, not fail: ${JSON.stringify(result)}`);
    return result;
  }

  // ── the declarations themselves ───────────────────────────────────────────

  test('no frontmatter gate shells out to a script under $HOME', () => {
    for (const when of [
      'workflow.nyquist_enforce',
      'workflow.verify_enforce',
      'workflow.mn_security_enforce',
      'workflow.mn_windows_enforce',
    ]) {
      assert.equal(declaredPredicate(when).kind, 'artifact-frontmatter-equals', when);
    }
  });

  // ── the real gate shapes ──────────────────────────────────────────────────

  test('passes when truths_unproven is 0 (verify_enforce)', () => {
    writeArtifact('01-VERIFICATION.md', 'phase: 01\ntruths_unproven: 0');
    const r = gate('workflow.verify_enforce');
    assert.equal(r.block, false, `0 must compare as a value: ${r.payload.message}`);
  });

  test('blocks when truths_unproven is 1 — the smallest non-zero count', () => {
    // The defect the gate exists for: a phase reaching ship with unproven truths.
    writeArtifact('01-VERIFICATION.md', 'phase: 01\ntruths_unproven: 1');
    const r = gate('workflow.verify_enforce');
    assert.equal(r.block, true, 'one unproven truth must block ship');
    assert.equal(r.payload.details.actual, '1');
  });

  test('a documenting inline comment does not change the value', () => {
    // GSD templates document fields inline (`truths_unproven: 0 # ...`); YAML reads the tail as a
    // comment. A gate failing a correct artifact teaches people to ignore blocks.
    writeArtifact('01-VERIFICATION.md', 'phase: 01\ntruths_unproven: 0 # truths the verifier could not prove');
    assert.equal(gate('workflow.verify_enforce').block, false);
  });

  test('passes when nyquist_compliant is true (nyquist_enforce)', () => {
    writeArtifact('01-VALIDATION.md', 'phase: 01\nnyquist_compliant: true');
    assert.equal(gate('workflow.nyquist_enforce').block, false);
  });

  test('blocks when nyquist_compliant is false', () => {
    // `false` must not be swallowed as "no value present".
    writeArtifact('01-VALIDATION.md', 'phase: 01\nnyquist_compliant: false');
    const r = gate('workflow.nyquist_enforce');
    assert.equal(r.block, true, 'false must compare as a value');
    assert.equal(r.payload.details.match, false);
  });

  /** A literal predicate on a nested field — the shape verify_gates_enforce declared before it became a query gate. */
  function nestedGate() {
    const predicate = { kind: 'artifact-frontmatter-equals', artifact: 'VERIFICATION.md', field: 'gates.all_passed', equals: true };
    const result = evaluateCheckPredicate({ projectDir, args: ['--predicate', JSON.stringify(predicate), '--phase-dir', phaseDir] });
    assert.ok(!result.failure, JSON.stringify(result));
    return result;
  }

  test('reads a nested field through a dotted path', () => {
    writeArtifact('01-VERIFICATION.md', 'phase: 01\ngates:\n  ran_at: 2026-10-04T00:00:00Z\n  all_passed: true\n  failed: 0');
    assert.equal(nestedGate().block, false);

    writeArtifact('01-VERIFICATION.md', 'phase: 01\ngates:\n  all_passed: false\n  failed: 1');
    assert.equal(nestedGate().block, true, 'a recorded failure must block');
  });

  test('a top-level key with the same leaf name does not satisfy the nested field', () => {
    writeArtifact('01-VERIFICATION.md', 'phase: 01\nall_passed: true\ngates:\n  all_passed: false');
    assert.equal(nestedGate().block, true);
  });

  // ── absence vs. contradiction ─────────────────────────────────────────────

  test('optional passes when the artifact does not exist (mn_security_enforce)', () => {
    // A phase with no security review is not a phase with open threats. Without this, enabling
    // the gate would block every phase that never produced one.
    const r = gate('workflow.mn_security_enforce');
    assert.equal(r.block, false, 'a missing optional artifact is not a finding');
    assert.equal(r.payload.details.artifactNotFound, true);
  });

  test('optional with no phase directory blocks — absence can only be judged within a known phase', () => {
    for (const when of ['workflow.mn_security_enforce', 'workflow.mn_windows_enforce']) {
      const r = evaluateCheckPredicate({ projectDir, args: ['--predicate', JSON.stringify(declaredPredicate(when)), '--phase-dir', ''] });
      assert.ok(!r.failure, JSON.stringify(r));
      assert.equal(r.block, true, when);
      assert.equal(r.payload.details.phaseDirMissing, true);
    }
  });

  test('optional still blocks when the artifact exists and contradicts (mn_windows_enforce)', () => {
    // Optional means "may be absent", never "may be ignored".
    writeArtifact('01-WINDOWS.md', 'phase: 01\nopen_count: 2');
    assert.equal(gate('workflow.mn_windows_enforce').block, true);
  });

  test('optional passes an existing artifact that matches', () => {
    writeArtifact('01-SECURITY.md', 'phase: 01\nthreats_open: 0');
    assert.equal(gate('workflow.mn_security_enforce').block, false);
  });

  test('blocks when a required artifact is missing', () => {
    const r = gate('workflow.verify_enforce');
    assert.equal(r.block, true, 'without optional, a missing artifact cannot be treated as compliance');
    assert.equal(r.payload.details.artifactNotFound, true);
  });

  test('blocks when the field is absent from an existing artifact', () => {
    // The failure mode this fork was built around: a claim nobody made reading as a claim satisfied.
    writeArtifact('01-VERIFICATION.md', 'phase: 01\nsomething_else: 0');
    assert.equal(gate('workflow.verify_enforce').block, true);
  });

  // ── through the CLI, the way ship:pre dispatches a predicate gate ─────────

  test('gsd_run check predicate prints the verdict with block and message', () => {
    writeArtifact('01-SECURITY.md', 'phase: 01\nthreats_open: 3');
    const r = runGsdTools(
      [
        'check', 'predicate',
        '--predicate', JSON.stringify(declaredPredicate('workflow.mn_security_enforce')),
        '--phase-dir', phaseDir,
        '--phase-number', '01',
        '--raw',
      ],
      projectDir,
    );
    assert.equal(r.success, true, r.error);
    const payload = JSON.parse(r.output);
    assert.equal(payload.block, true);
    assert.equal(typeof payload.message, 'string');
  });
});
