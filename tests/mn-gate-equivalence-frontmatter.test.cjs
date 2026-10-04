'use strict';

/**
 * TRANSITIONAL golden test: `check-frontmatter.mjs` ↔ the built-in `artifact-frontmatter-equals`
 * predicate, on the same fixtures (decision 6 of .plans/mn-verify-gate-to-cli.md).
 *
 * The five frontmatter gates moved from the script to the predicate. This test runs both on every
 * fixture and requires "script exited non-zero" to equal "predicate blocked". It is deleted in the
 * same commit that deletes the script — after that there is nothing left to compare against.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempProject, cleanup } = require('./helpers.cjs');
const { evaluateCheckPredicate } = require('../gsd-core/bin/lib/gate-predicate.cjs');

const SCRIPT = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'check-frontmatter.mjs');
const RUN_TIMEOUT_MS = 30000;

/** [label, files in the phase dir, artifact, field, equals (as the script's flag), optional] */
const CASES = [
  ['zero matches', { '01-VERIFICATION.md': 'truths_unproven: 0' }, 'VERIFICATION.md', 'truths_unproven', '0', false],
  ['one mismatches', { '01-VERIFICATION.md': 'truths_unproven: 1' }, 'VERIFICATION.md', 'truths_unproven', '0', false],
  ['inline comment', { '01-VERIFICATION.md': 'truths_unproven: 0 # count' }, 'VERIFICATION.md', 'truths_unproven', '0', false],
  ['quoted zero', { '01-VERIFICATION.md': 'truths_unproven: "0"' }, 'VERIFICATION.md', 'truths_unproven', '0', false],
  ['true matches', { '01-VALIDATION.md': 'nyquist_compliant: true' }, 'VALIDATION.md', 'nyquist_compliant', 'true', false],
  ['false mismatches', { '01-VALIDATION.md': 'nyquist_compliant: false' }, 'VALIDATION.md', 'nyquist_compliant', 'true', false],
  ['nested true', { '01-VERIFICATION.md': 'gates:\n  all_passed: true\n  failed: 0' }, 'VERIFICATION.md', 'gates.all_passed', 'true', false],
  ['nested false', { '01-VERIFICATION.md': 'gates:\n  all_passed: false' }, 'VERIFICATION.md', 'gates.all_passed', 'true', false],
  ['field absent', { '01-VERIFICATION.md': 'other: 0' }, 'VERIFICATION.md', 'truths_unproven', '0', false],
  ['required artifact absent', {}, 'VERIFICATION.md', 'truths_unproven', '0', false],
  ['optional artifact absent', {}, 'SECURITY.md', 'threats_open', '0', true],
  ['optional artifact contradicts', { '01-SECURITY.md': 'threats_open: 2' }, 'SECURITY.md', 'threats_open', '0', true],
  ['optional artifact matches', { '01-WINDOWS.md': 'open_count: 0' }, 'WINDOWS.md', 'open_count', '0', true],
  ['unprefixed artifact name', { 'VERIFICATION.md': 'truths_unproven: 0' }, 'VERIFICATION.md', 'truths_unproven', '0', false],
];

/** The capability's own conversion of `--equals <flag>` into a JSON value. */
function equalsValue(flag) {
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return /^\d+$/.test(flag) ? Number(flag) : flag;
}

describe('check-frontmatter.mjs ↔ artifact-frontmatter-equals (transitional)', () => {
  let projectDir;
  let phaseDir;

  beforeEach(() => {
    projectDir = createTempProject('gsd-mn-eq-frontmatter-');
    phaseDir = path.join(projectDir, '.planning', 'phases', '01-gate');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  for (const [label, files, artifact, field, equals, optional] of CASES) {
    test(label, () => {
      for (const [name, frontmatter] of Object.entries(files)) {
        fs.writeFileSync(path.join(phaseDir, name), `---\nphase: 01\n${frontmatter}\n---\n\n# report\n`);
      }

      const script = runNode(
        [SCRIPT, '--dir', phaseDir, '--artifact', artifact, '--field', field, '--equals', equals, ...(optional ? ['--optional'] : [])],
        { timeoutMs: RUN_TIMEOUT_MS },
      );
      assert.equal(script.outcome, OUTCOME.EXITED, script.stderr);

      const predicate = { kind: 'artifact-frontmatter-equals', artifact, field, equals: equalsValue(equals) };
      if (optional) predicate.optional = true;
      const verdict = evaluateCheckPredicate({
        projectDir,
        args: ['--predicate', JSON.stringify(predicate), '--phase-dir', phaseDir],
      });

      assert.equal(verdict.block, script.exitCode !== 0, `script exit ${script.exitCode} vs block ${verdict.block}`);
    });
  }
});
