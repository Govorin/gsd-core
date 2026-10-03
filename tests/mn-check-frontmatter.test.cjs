'use strict';

/**
 * check-frontmatter.mjs — reads one frontmatter field out of one phase artifact
 * and compares it to an expected value.
 *
 * The most load-bearing script in the capability: FOUR gates run through it,
 * including every ship:pre gate.
 *
 *   nyquist_enforce      VALIDATION.md   nyquist_compliant == true
 *   verify_enforce       VERIFICATION.md truths_unproven   == 0
 *   mn_security_enforce  SECURITY.md     threats_open      == 0   --optional
 *   mn_windows_enforce   WINDOWS.md      open_count        == 0   --optional
 *
 * It exists because core GSD's equivalents declare `artifact-frontmatter-equals`,
 * a predicate absent from the published 1.9.1 evaluator — those gates halt with
 * "unknown predicate kind" instead of checking anything, which looks configured
 * and protects nothing.
 *
 * Two behaviours carry most of the weight and are pinned hardest below. `0` and
 * `false` must compare as values and not be swallowed as falsy, since three of
 * the four gates compare against exactly those. And `--optional` must
 * distinguish "the artifact does not exist" (a phase with no security review is
 * not a phase with open threats) from "the field says something else".
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'check-frontmatter.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

const MATCHED = 0;
const MISMATCHED = 1;

describe('check-frontmatter gate helper', () => {
  let phaseDir;

  beforeEach(() => {
    phaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-check-frontmatter-'));
  });

  afterEach(() => {
    cleanup(phaseDir);
  });

  function writeArtifact(name, frontmatter, body = '\n# report\n') {
    fs.writeFileSync(path.join(phaseDir, name), `---\n${frontmatter}\n---\n${body}`);
  }

  function check(artifact, field, equals, extra = []) {
    return runNode(
      [SCRIPT, '--dir', phaseDir, '--artifact', artifact, '--field', field, '--equals', equals, ...extra],
      { timeoutMs: RUN_TIMEOUT_MS },
    );
  }

  // ── the real gate shapes ──────────────────────────────────────────────────

  test('passes when truths_unproven is 0 (verify_enforce)', () => {
    writeArtifact('VERIFICATION.md', 'phase: 01\ntruths_unproven: 0');

    const r = check('VERIFICATION.md', 'truths_unproven', '0');
    assert.equal(r.exitCode, MATCHED, `0 must compare as a value: ${r.stdout}${r.stderr}`);
  });

  test('blocks when truths_unproven is non-zero', () => {
    // The defect the gate exists for: a phase reaching ship with unproven truths.
    writeArtifact('VERIFICATION.md', 'phase: 01\ntruths_unproven: 3');

    const r = check('VERIFICATION.md', 'truths_unproven', '0');
    assert.equal(r.exitCode, MISMATCHED, `unproven truths must block ship: ${r.stdout}`);
  });

  test('passes when nyquist_compliant is true (nyquist_enforce)', () => {
    writeArtifact('VALIDATION.md', 'phase: 01\nnyquist_compliant: true');

    const r = check('VALIDATION.md', 'nyquist_compliant', 'true');
    assert.equal(r.exitCode, MATCHED, `${r.stdout}${r.stderr}`);
  });

  test('blocks when nyquist_compliant is false', () => {
    // `false` must not be swallowed as "no value present".
    writeArtifact('VALIDATION.md', 'phase: 01\nnyquist_compliant: false');

    const r = check('VALIDATION.md', 'nyquist_compliant', 'true');
    assert.equal(r.exitCode, MISMATCHED, `false must compare as a value: ${r.stdout}`);
  });

  // ── absence vs. contradiction ─────────────────────────────────────────────

  test('--optional passes when the artifact does not exist', () => {
    // A phase with no security review is not a phase with open threats. Without
    // this, enabling the gate would block every phase that never produced one.
    const r = check('SECURITY.md', 'threats_open', '0', ['--optional']);
    assert.equal(
      r.exitCode,
      MATCHED,
      `a missing optional artifact is not a finding: ${r.stdout}${r.stderr}`,
    );
  });

  test('--optional still blocks when the artifact exists and contradicts', () => {
    // Optional means "may be absent", never "may be ignored".
    writeArtifact('SECURITY.md', 'phase: 01\nthreats_open: 2');

    const r = check('SECURITY.md', 'threats_open', '0', ['--optional']);
    assert.equal(r.exitCode, MISMATCHED, `an existing artifact is always read: ${r.stdout}`);
  });

  test('blocks when a required artifact is missing', () => {
    const r = check('VERIFICATION.md', 'truths_unproven', '0');
    assert.equal(
      r.exitCode,
      MISMATCHED,
      'without --optional, a missing artifact cannot be treated as compliance',
    );
  });

  test('blocks when the field is absent from an existing artifact', () => {
    // The failure mode this fork was built around: a claim nobody made reading
    // as a claim satisfied.
    writeArtifact('VERIFICATION.md', 'phase: 01\nsomething_else: 0');

    const r = check('VERIFICATION.md', 'truths_unproven', '0');
    assert.equal(r.exitCode, MISMATCHED, `an absent field is not a satisfied one: ${r.stdout}`);
  });

  // ── argument discipline ───────────────────────────────────────────────────

  test('reports usage when required arguments are missing', () => {
    const r = runNode([SCRIPT, '--dir', phaseDir], { timeoutMs: RUN_TIMEOUT_MS });
    assert.notEqual(r.exitCode, MATCHED, 'an incomplete invocation must not read as a pass');
    assert.match(`${r.stdout}${r.stderr}`, /usage:/, 'it must say how to call it');
  });
});
