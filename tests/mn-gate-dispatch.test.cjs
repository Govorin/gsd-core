'use strict';

/**
 * `gsd_run check mn-*` — the dispatch table and the phase argument every mn gate shares
 * (src/gate-mn-dispatch.cts, src/gate-mn-support.cts).
 *
 * The dispatchers name a gate's phase in several shapes: `"${PHASE_DIR}"` (ship, verify-work,
 * plan-phase — which appends `"${PHASE_REQ_IDS}"`), `"${PHASE_NUMBER}"` (execute-phase wave-post,
 * verify-phase-goal) and `--phase N` (the shared step dispatcher). A parsing mistake turns EVERY
 * mn gate into "could not check", and a blocking gate that cannot check halts the run — so the
 * matrix below runs every registered verb against every shape (risk 4 of the 3.12 design).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck, runMnCheckFailure } = require('./helpers/mn-gate-fixture.cjs');
const { isMnCheckVerb, evaluateMnCheck, listMnCheckVerbs } = require('../gsd-core/bin/lib/gate-mn-dispatch.cjs');
const { resolveMnPhase, mnPass, mnFinding, mnUnresolvable, withMnPhase, MN_GATE_STATUS } = require('../gsd-core/bin/lib/gate-mn-support.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

describe('mn gate dispatch table', () => {
  test('every check.query the capability declares is a registered mn verb', () => {
    const queries = CAPABILITY.gates.filter((g) => g.check.query).map((g) => g.check.query);
    for (const query of queries) {
      assert.ok(isMnCheckVerb(query), `capability.json declares check.query "${query}" with no mn verb behind it`);
    }
  });

  test('verb names pass the gate-dispatch query regex and carry the mn- prefix', () => {
    for (const verb of listMnCheckVerbs()) {
      assert.match(verb, /^mn-[a-z0-9-]+$/);
      assert.match(verb, /^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/);
    }
  });

  test('every verb is either phase- or project-scoped', () => {
    assert.deepEqual(
      [...listMnCheckVerbs('phase'), ...listMnCheckVerbs('project')].sort(),
      listMnCheckVerbs(),
    );
  });

  test('prototype keys are not verbs', () => {
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.equal(isMnCheckVerb(key), false, key);
    }
    assert.equal(isMnCheckVerb(undefined), false);
    assert.throws(() => evaluateMnCheck('mn-no-such-gate', { projectDir: '/', args: [] }), /not an mn gate/);
  });
});

describe('mn gate verdict builders', () => {
  test('pass, finding and unresolvable carry block, status and message', () => {
    assert.deepEqual(
      [mnPass('a'), mnFinding('b'), mnUnresolvable('c')].map((v) => [v.outcome, v.block, v.payload.block, v.payload.status, v.payload.message]),
      [
        ['pass', false, false, MN_GATE_STATUS.PASS, 'a'],
        ['block', true, true, MN_GATE_STATUS.FINDING, 'b'],
        ['block', true, true, MN_GATE_STATUS.UNRESOLVABLE, 'c'],
      ],
    );
  });

  test('a gate body that throws is unresolvable, never a pass or a finding', () => {
    const projectDir = createMnProject('gsd-mn-throw-');
    const { phaseNumber } = makePhase(projectDir);
    const v = withMnPhase('mn-test', { projectDir, args: [phaseNumber] }, () => {
      throw new Error('boom');
    });
    cleanup(projectDir);
    assert.equal(v.block, true);
    assert.equal(v.payload.status, MN_GATE_STATUS.UNRESOLVABLE);
  });
});

describe('mn gate phase argument', () => {
  let projectDir;
  let phaseDir;
  let phaseNumber;

  beforeEach(() => {
    projectDir = createMnProject('gsd-mn-dispatch-');
    ({ phaseDir, phaseNumber } = makePhase(projectDir, {}, 'ports'));
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  /** Every shape a dispatcher or a person uses to name the phase. */
  function shapes() {
    const relative = path.relative(projectDir, phaseDir);
    return [
      ['padded number', [phaseNumber]],
      ['bare number', [String(Number(phaseNumber))]],
      ['directory basename', [path.basename(phaseDir)]],
      ['relative directory', [relative]],
      ['absolute directory', [phaseDir]],
      ['directory plus requirement ids', [relative, 'REQ-01,REQ-02']],
      ['--phase N', ['--phase', phaseNumber]],
      ['--phase-dir', ['--phase-dir', relative]],
    ];
  }

  test('resolveMnPhase finds the same directory for every shape', () => {
    const expected = require('node:fs').realpathSync(phaseDir);
    for (const [label, args] of shapes()) {
      const resolved = resolveMnPhase(projectDir, args);
      assert.ok(resolved.phaseDir, `${label}: ${JSON.stringify(resolved)}`);
      assert.equal(require('node:fs').realpathSync(resolved.phaseDir), expected, label);
    }
  });

  test('no phase argument is a usage failure, not a verdict', () => {
    assert.ok(resolveMnPhase(projectDir, []).failure);
    assert.ok(resolveMnPhase(projectDir, ['--raw-ish']).failure);
  });

  test('a path escaping the project is a usage failure', () => {
    assert.ok(resolveMnPhase(projectDir, ['../../etc']).failure);
    assert.ok(resolveMnPhase(projectDir, ['--phase-dir', '/etc']).failure);
  });

  test('a phase that does not exist is unresolved, not a usage failure', () => {
    assert.ok(resolveMnPhase(projectDir, ['99']).unresolved);
    assert.ok(resolveMnPhase(projectDir, ['.planning/phases/99-nope']).unresolved);
  });

  test('--phase-dir wins over --phase, which wins over a positional', () => {
    const other = makePhase(projectDir, {}, 'other');
    const pick = (args) => require('node:fs').realpathSync(resolveMnPhase(projectDir, args).phaseDir);
    assert.equal(pick([other.phaseNumber, '--phase', phaseNumber]), require('node:fs').realpathSync(phaseDir));
    assert.equal(pick(['--phase', phaseNumber, '--phase-dir', path.relative(projectDir, other.phaseDir)]), require('node:fs').realpathSync(other.phaseDir));
  });

  test('every phase-scoped verb resolves the phase from every shape (CLI)', () => {
    for (const verb of listMnCheckVerbs('phase')) {
      for (const [label, args] of shapes()) {
        const payload = runMnCheck(projectDir, verb, args);
        assert.notEqual(payload.phaseResolved, false, `${verb} with ${label}: ${payload.message}`);
      }
    }
  });

  test('every phase-scoped verb reports a missing phase as unresolvable and blocks (CLI)', () => {
    for (const verb of listMnCheckVerbs('phase')) {
      const payload = runMnCheck(projectDir, verb, ['99']);
      assert.equal(payload.block, true, verb);
      assert.equal(payload.status, MN_GATE_STATUS.UNRESOLVABLE, verb);
      assert.equal(payload.phaseResolved, false, verb);
    }
  });

  test('every phase-scoped verb fails its invocation when no phase is named (CLI)', () => {
    for (const verb of listMnCheckVerbs('phase')) {
      runMnCheckFailure(projectDir, verb, []);
    }
  });

  test('every project-scoped verb answers with or without a phase, and ignores which one (CLI)', () => {
    // A project gate ignores the phase the dispatcher appends: neither a missing nor an unknown
    // phase may turn it into a usage failure, a "phase not found" verdict, or a different verdict.
    for (const verb of listMnCheckVerbs('project')) {
      const verdicts = [[], ...shapes().map(([, args]) => args), ['99']].map((args) => runMnCheck(projectDir, verb, args));
      for (const payload of verdicts) {
        assert.notEqual(payload.phaseResolved, false, `${verb} must not resolve a phase at all`);
        assert.deepEqual([payload.block, payload.status], [verdicts[0].block, verdicts[0].status], `${verb}: the phase must not change the verdict`);
      }
    }
  });
});
