'use strict';

/**
 * `gsd_run verify gates` — measured check results recorded into
 * {phase}-VERIFICATION.md, and the gate that reads them back.
 *
 * Seams: src/verify-gates.cts (via the built gsd-core/bin/lib/verify-gates.cjs
 * and, for the CLI contract, the real `gsd-tools.cjs verify gates` through the
 * process seam) and src/gate-predicate-evaluator.cts's dotted-path field
 * resolution.
 *
 * The defect: VERIFICATION.md's "Automated checks: 2 passed, 8 failed" is a
 * line the verifying agent typed. Nothing downstream can distinguish a
 * verifier that ran the suite from one that described running it, and the
 * predicate built to consume such evidence — artifact-frontmatter-equals,
 * ADR-2008 — has had nothing to read. This command supplies it.
 *
 * The round-trip suite at the bottom is the one that matters: record, then
 * gate on the recording. Without it the rest is a nicer-looking piece of prose.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const TOOLS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const verifyGates = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'verify-gates.cjs'));
const { evaluatePredicate } = require(path.join(
  REPO_ROOT,
  'gsd-core',
  'bin',
  'lib',
  'gate-predicate-evaluator.cjs'
));
const { exitCodeFor } = require(path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'exit-code-registry.cjs'));
const { extractFrontmatter } = require(path.join(
  REPO_ROOT,
  'gsd-core',
  'bin',
  'lib',
  'frontmatter.cjs'
));

/** A project with a phase directory and a configurable check roster. */
function makeProject(dir, verifyGatesConfig) {
  const phaseDir = path.join(dir, '.planning', 'phases', '03-ports');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify(
      { workflow: verifyGatesConfig === null ? {} : { verify_gates: verifyGatesConfig } },
      null,
      2
    )
  );
  return phaseDir;
}

function runGatesCli(dir, phaseDir, extraArgs = []) {
  const result = runNode([TOOLS, 'verify', 'gates', phaseDir, ...extraArgs, '--cwd', dir], {
    cwd: dir,
  });
  let payload = null;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    /* a non-JSON stdout is itself a finding the assertions will surface */
  }
  return { ...result, payload };
}

describe('verify gates — measuring', () => {
  const green = () => ({ status: 0, stdout: '', stderr: '', error: null, signal: null });
  const red = () => ({ status: 1, stdout: 'boom', stderr: '', error: null, signal: null });

  test('runs every check even after one fails', () => {
    const seen = [];
    const results = verifyGates.runGates({
      cwd: '/nowhere',
      phaseDir: '/nowhere',
      checks: [
        { name: 'a', command: 'a' },
        { name: 'b', command: 'b' },
        { name: 'c', command: 'c' },
      ],
      runner: (command) => {
        seen.push(command);
        return command === 'a' ? red() : green();
      },
      clock: { now: () => 0 },
    });
    assert.deepEqual(seen, ['a', 'b', 'c'], 'stopping at the first red would make "no command configured" and "never reached" indistinguishable');
    assert.equal(results.length, 3);
    assert.equal(results[0].passed, false);
    assert.equal(results[2].passed, true);
  });

  test('a check that could not run is recorded as unrunnable, not as a code failure', () => {
    const cases = [
      ['missing binary', { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' }, signal: null }, 'ENOENT'],
      ['killed', { status: null, stdout: '', stderr: '', error: null, signal: 'SIGTERM' }, 'SIGTERM'],
    ];
    for (const [label, raw, expected] of cases) {
      const [result] = verifyGates.runGates({
        cwd: '/nowhere',
        phaseDir: '/nowhere',
        checks: [{ name: 'tests', command: 'x' }],
        runner: () => raw,
        clock: { now: () => 0 },
      });
      assert.equal(result.unrunnable, expected, label);
      assert.equal(result.exitCode, null, `${label}: a null exit code is what distinguishes it from a red check`);
      assert.equal(result.passed, false, `${label}: it still does not count as a pass`);
    }
  });

  test('a runner that throws is caught rather than aborting the whole recording', () => {
    const [result] = verifyGates.runGates({
      cwd: '/nowhere',
      phaseDir: '/nowhere',
      checks: [{ name: 'tests', command: 'x' }],
      runner: () => {
        throw Object.assign(new Error('nope'), { code: 'EACCES' });
      },
      clock: { now: () => 0 },
    });
    assert.equal(result.unrunnable, 'EACCES');
  });

  test('parses the count shapes this fork\'s projects actually emit', () => {
    const cases = [
      ['node:test', '# pass 41\n# fail 0\n', { passed: 41, failed: 0 }],
      ['vitest', 'Tests  2 failed | 204 passed (206)\n', { failed: 2, passed: 204 }],
      ['jest', 'Tests:       204 passed, 206 total\n', { passed: 204 }],
      ['tsc', 'Found 3 errors in 2 files.\n', { errors: 3 }],
      ['oxlint', 'Found 5700 warnings and 0 errors.\n', { warnings: 5700, errors: 0 }],
    ];
    for (const [label, output, expected] of cases) {
      const counts = verifyGates.parseCounts(output);
      for (const [key, value] of Object.entries(expected)) {
        assert.equal(counts[key], value, `${label}: ${key}`);
      }
    }
  });

  test('unrecognised output carries no counts rather than guessed ones', () => {
    // A wrong count is worse than no count: it is evidence that says something
    // false, which is the exact failure this command exists to remove.
    assert.equal(verifyGates.parseCounts('everything is fine\n'), undefined);
  });
});

describe('verify gates — recording', () => {
  test('flattens per-check detail, because the writer cannot nest', () => {
    // spliceFrontmatter refuses a nested object-list outright, so the obvious
    // shape (gates.checks.tests.exit_code) cannot be written at all.
    const block = verifyGates.buildGatesFrontmatter(
      [
        { name: 'tests', command: 't', exitCode: 0, passed: true, durationMs: 5, counts: { passed: 41 } },
        { name: 'type-check', command: 'tc', exitCode: 2, passed: false, durationMs: 7 },
      ],
      '2026-01-01T00:00:00Z'
    );
    assert.equal(block.all_passed, false);
    assert.equal(block.failed, 1);
    assert.deepEqual(block.ran, ['tests', 'type-check']);
    assert.equal(block.tests_exit_code, 0);
    assert.equal(block.type_check_exit_code, 2, 'a name with punctuation becomes a plain YAML key');
  });

  test('a parsed count never overwrites the boolean verdict of the same name', () => {
    // Regression: `tests` parsing out `passed: 41` wrote `tests_passed`, which
    // is already the boolean verdict — so `gates.tests_passed == true`, the
    // natural gate to write, silently came to mean "41".
    const block = verifyGates.buildGatesFrontmatter(
      [{ name: 'tests', command: 't', exitCode: 0, passed: true, durationMs: 1, counts: { passed: 41, failed: 0 } }],
      '2026-01-01T00:00:00Z'
    );
    assert.equal(block.tests_passed, true, 'the verdict stays a boolean');
    assert.equal(block.tests_passed_count, 41, 'the count lives beside it');
    assert.equal(block.tests_failed_count, 0);
  });

  test('an empty roster is not a pass', () => {
    const block = verifyGates.buildGatesFrontmatter([], '2026-01-01T00:00:00Z');
    assert.equal(
      block.all_passed,
      false,
      'recording "nothing ran" as green would be a field that proves nothing'
    );
  });
});

describe('verify gates — reading the roster', () => {
  // The key is a string-map, so config-set and a hand-written config.json both
  // carry a real object. A string holding the object as JSON text is what the
  // key had to be while the capability config schema admitted scalars only,
  // and a config written then must keep working.
  let dir;
  beforeEach(() => {
    dir = createTempDir();
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  });
  afterEach(() => {
    cleanup(dir);
  });
  const write = (value) =>
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { verify_gates: value } }));

  test('reads a hand-written object', () => {
    write({ tests: 'npm test' });
    assert.deepEqual(verifyGates.readChecks(dir), { ok: true, checks: [{ name: 'tests', command: 'npm test' }] });
  });

  test('reads a legacy JSON-text string', () => {
    write('{"tests":"npm test","lint":"npm run lint"}');
    const config = verifyGates.readChecks(dir);
    assert.equal(config.ok, true);
    assert.deepEqual(
      config.checks.map((c) => c.name),
      ['tests', 'lint']
    );
  });

  test('absent, null, blank and an empty object all mean nothing configured', () => {
    for (const empty of [undefined, null, '', '   ', {}, '{}']) {
      write(empty);
      assert.deepEqual(verifyGates.readChecks(dir), { ok: true, checks: [] }, `empty roster: ${JSON.stringify(empty)}`);
    }
    fs.unlinkSync(path.join(dir, '.planning', 'config.json'));
    assert.deepEqual(verifyGates.readChecks(dir), { ok: true, checks: [] }, 'no config.json at all');
  });

  test('a set but malformed value is a problem, not an empty roster', () => {
    // Collapsing these into "nothing configured" sent the user to add a setting
    // they had already written.
    for (const bad of ['not json', '{"tests":', '[1,2]', '123', 'true', '"npm test"', 'null', [1, 2], 7, false]) {
      write(bad);
      const config = verifyGates.readChecks(dir);
      assert.equal(config.ok, false, `malformed roster: ${JSON.stringify(bad)}`);
      assert.equal(config.problems.length, 1);
    }
  });

  test('one bad entry fails the whole roster and is named', () => {
    // Dropping it silently would let half a roster stand in for the whole one.
    write({ tests: 'npm test', lint: '', typecheck: 42 });
    const config = verifyGates.readChecks(dir);
    assert.equal(config.ok, false);
    assert.equal(config.problems.length, 2);
    assert.ok(config.problems.some((p) => p.startsWith('workflow.verify_gates.lint ')));
    assert.ok(config.problems.some((p) => p.startsWith('workflow.verify_gates.typecheck ')));
  });

  test('an unparseable config.json is a problem, not an empty roster', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{"workflow": {');
    assert.equal(verifyGates.readChecks(dir).ok, false);
  });
});

/**
 * The key was unsettable through the CLI in every form: it was declared a
 * `string` holding JSON, config-set parsed the JSON argument into an object,
 * and the capability validator then rejected the object as not a string. It is
 * now a `string-map`. Driven end to end through the real binary.
 */
describe('verify gates — configured through config-set', () => {
  let dir;
  let phaseDir;
  beforeEach(() => {
    dir = createTempDir();
    phaseDir = makeProject(dir, null);
  });
  afterEach(() => {
    cleanup(dir);
  });
  const configPath = () => path.join(dir, '.planning', 'config.json');
  const configSet = (value) => runNode([TOOLS, 'config-set', 'workflow.verify_gates', value, '--cwd', dir], { cwd: dir });
  const stored = () => JSON.parse(fs.readFileSync(configPath(), 'utf8')).workflow.verify_gates;

  test('config-set stores the object and verify gates runs it', () => {
    const set = configSet('{"smoke":"true"}');
    assert.equal(set.exitCode, 0, set.stderr);
    assert.deepEqual(stored(), { smoke: 'true' });

    const result = runGatesCli(dir, phaseDir);
    assert.equal(result.exitCode, 0, result.stdout + result.stderr);
    assert.equal(result.payload.allPassed, true);
  });

  test('setting the same value twice leaves the same config', () => {
    const value = '{"tests":"true","lint":"true"}';
    configSet(value);
    const first = fs.readFileSync(configPath(), 'utf8');
    const again = configSet(value);
    assert.equal(again.exitCode, 0, again.stderr);
    assert.equal(fs.readFileSync(configPath(), 'utf8'), first);
  });

  test('an empty object is accepted and reads as nothing configured', () => {
    assert.equal(configSet('{}').exitCode, 0);
    assert.deepEqual(stored(), {});
    assert.equal(runGatesCli(dir, phaseDir).payload.reason, 'no_checks_configured');
  });

  test('config-set refuses anything that is not an object of strings, and writes nothing', () => {
    // One string value (accepted above) against one non-string value, and the
    // shapes that are JSON but not a map.
    const before = fs.readFileSync(configPath(), 'utf8');
    for (const bad of ['{"tests": "npm test",}', '{"tests":1}', '{"tests":null}', '["npm test"]', '123', 'true', 'npm test', '']) {
      const set = configSet(bad);
      assert.equal(set.outcome, OUTCOME.EXITED, `config-set ${JSON.stringify(bad)}`);
      assert.notEqual(set.exitCode, 0, `config-set ${JSON.stringify(bad)} must be refused`);
      assert.equal(fs.readFileSync(configPath(), 'utf8'), before, `config-set ${JSON.stringify(bad)} must not write`);
    }
  });

  test('null still clears the key', () => {
    configSet('{"tests":"true"}');
    assert.equal(configSet('null').exitCode, 0);
    assert.equal(stored(), undefined);
    assert.equal(runGatesCli(dir, phaseDir).payload.reason, 'no_checks_configured');
  });
});

describe('verify gates — CLI contract', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('refuses when no checks are configured, and writes nothing', () => {
    const phaseDir = makeProject(dir, null);
    const result = runGatesCli(dir, phaseDir);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 2);
    assert.equal(result.payload.reason, 'no_checks_configured');
    assert.equal(
      fs.existsSync(path.join(phaseDir, '03-VERIFICATION.md')),
      false,
      'a refusal must not leave a half-written record behind'
    );
  });

  test('a malformed roster fails as UNAVAILABLE, names the problem, and writes nothing', () => {
    const phaseDir = makeProject(dir, '{"tests": "npm test",}');
    const result = runGatesCli(dir, phaseDir);
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, exitCodeFor('UNAVAILABLE'));
    assert.equal(result.payload.reason, 'invalid_checks_config');
    assert.equal(result.payload.problems.length, 1);
    assert.equal(fs.existsSync(path.join(phaseDir, '03-VERIFICATION.md')), false);
  });

  test('records a green run and exits 0', () => {
    const phaseDir = makeProject(dir, { tests: 'echo "# pass 41" && echo "# fail 0"', typecheck: 'true' });
    const result = runGatesCli(dir, phaseDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.payload.allPassed, true);
    assert.equal(result.payload.created, true);

    const fm = extractFrontmatter(
      fs.readFileSync(path.join(phaseDir, '03-VERIFICATION.md'), 'utf8')
    );
    // extractFrontmatter does not coerce types — every scalar comes back a
    // string, at the top level and inside a nested map alike. The predicate
    // compares by string representation for exactly this reason, so the gate
    // still works; the assertions below record the parser's actual contract
    // rather than an assumed one.
    assert.equal(fm.gates.all_passed, 'true');
    assert.equal(fm.gates.tests_passed_count, '41');
    assert.equal(fm.gates.typecheck_exit_code, '0');
  });

  test('a fresh record carries no status — only the verifier writes one', () => {
    // A seeded `status: pending` is outside the closed verification-status set
    // upstream reads (passed | gaps_found | human_needed): the reader throws on
    // it. An absent status reads as "the verify step never ran", which is the
    // truth at this point. Recording twice must not invent one either.
    const phaseDir = makeProject(dir, { tests: 'true' });
    runGatesCli(dir, phaseDir);
    runGatesCli(dir, phaseDir);

    const fm = extractFrontmatter(fs.readFileSync(path.join(phaseDir, '03-VERIFICATION.md'), 'utf8'));
    assert.equal(Object.prototype.hasOwnProperty.call(fm, 'status'), false, `unexpected status: ${fm.status}`);
    assert.equal(fm.gates.all_passed, 'true');
  });

  test('a red check still records, and the command still exits 0', () => {
    // The exit code of THIS command answers "was the result recorded", not
    // "were the checks green". A recording step that fails when the news is
    // bad is a step people route around.
    const phaseDir = makeProject(dir, { tests: 'exit 1' });
    const result = runGatesCli(dir, phaseDir);
    assert.equal(result.exitCode, 0);
    assert.equal(result.payload.allPassed, false);
    assert.equal(result.payload.failed, 1);
  });

  test('--strict propagates the failure to the caller', () => {
    const phaseDir = makeProject(dir, { tests: 'exit 1' });
    assert.equal(runGatesCli(dir, phaseDir, ['--strict']).exitCode, 1);

    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { verify_gates: { tests: 'true' } } })
    );
    assert.equal(runGatesCli(dir, phaseDir, ['--strict']).exitCode, 0);
  });

  test('re-recording preserves everything the verifier wrote', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    const vpath = path.join(phaseDir, '03-VERIFICATION.md');
    fs.writeFileSync(
      vpath,
      '---\nphase: 03-ports\nstatus: gaps_found\ntruths_unproven: 2\n---\n\n# Report\n\nprose the verifier wrote\n'
    );
    runGatesCli(dir, phaseDir);

    const content = fs.readFileSync(vpath, 'utf8');
    const fm = extractFrontmatter(content);
    assert.equal(fm.status, 'gaps_found');
    assert.equal(fm.truths_unproven, '2');
    assert.equal(fm.gates.all_passed, 'true');
    assert.ok(content.includes('prose the verifier wrote'), 'the body must survive a key-level splice');
  });

  test('a missing phase directory and a missing argument both refuse', () => {
    makeProject(dir, { tests: 'true' });
    assert.equal(
      runGatesCli(dir, path.join(dir, '.planning', 'phases', 'nope')).payload.reason,
      'phase_dir_not_found'
    );
    const noArg = runNode([TOOLS, 'verify', 'gates', '--cwd', dir], { cwd: dir });
    assert.equal(noArg.exitCode, 2);
  });
});

/**
 * The form the shared step dispatcher calls (references/loop-hook-dispatch.md
 * § step): `gsd_run verify gates --phase "${PHASE_NUMBER}" --raw`. It hands over
 * a phase NUMBER. Reading `3` as a directory refused with phase_dir_not_found
 * on every dispatch — and the step's onError:skip swallowed it, so the gate on
 * gates.all_passed read nothing.
 */
describe('verify gates — called with --phase, as the step dispatcher calls it', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  function runPhaseCli(args) {
    const result = runNode([TOOLS, 'verify', 'gates', ...args, '--raw', '--cwd', dir], { cwd: dir });
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      /* surfaced by the assertions */
    }
    return { ...result, payload };
  }

  for (const form of [['--phase', '3'], ['--phase', '03'], ['--phase=3']]) {
    test(`${form.join(' ')} resolves the phase directory and records there`, () => {
      const phaseDir = makeProject(dir, { tests: 'echo "# pass 12" && echo "# fail 0"' });
      const result = runPhaseCli(form);
      assert.equal(result.outcome, OUTCOME.EXITED);
      assert.equal(result.exitCode, 0, result.stdout + result.stderr);
      assert.equal(result.payload.verificationPath, path.join(phaseDir, '03-VERIFICATION.md'));
      const fm = extractFrontmatter(fs.readFileSync(path.join(phaseDir, '03-VERIFICATION.md'), 'utf8'));
      assert.equal(fm.gates.all_passed, 'true');
    });
  }

  test('--strict still propagates a red check through the --phase form', () => {
    makeProject(dir, { tests: 'exit 1' });
    assert.equal(runPhaseCli(['--phase', '3', '--strict']).exitCode, 1);
  });

  test('an unknown phase number refuses and writes nothing', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    const result = runPhaseCli(['--phase', '9']);
    assert.equal(result.exitCode, 2);
    assert.equal(result.payload.reason, 'phase_not_found');
    assert.equal(fs.existsSync(path.join(phaseDir, '03-VERIFICATION.md')), false);
  });

  test('a phase number shared by two directories refuses rather than picking one', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    fs.mkdirSync(path.join(dir, '.planning', 'phases', '03-other'), { recursive: true });
    const result = runPhaseCli(['--phase', '3']);
    assert.equal(result.exitCode, 2);
    assert.equal(result.payload.reason, 'phase_not_found');
    assert.equal(fs.existsSync(path.join(phaseDir, '03-VERIFICATION.md')), false);
  });

  test('a directory and --phase together refuse — two answers to one question', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    const result = runPhaseCli([phaseDir, '--phase', '3']);
    assert.equal(result.exitCode, 2);
    assert.equal(result.payload.reason, 'conflicting_phase_args');
  });

  test('a dangling --phase is a missing argument, not a phase called "--raw"', () => {
    makeProject(dir, { tests: 'true' });
    const result = runNode([TOOLS, 'verify', 'gates', '--phase', '--cwd', dir], { cwd: dir });
    assert.equal(result.exitCode, 2);
  });
});

describe('verify gates — the round trip a gate actually makes', () => {
  let dir;
  let phaseDir;

  const deps = () => ({
    findPhaseArtifact: (searchDir, suffix) => {
      const hit = fs.readdirSync(searchDir).find((f) => f.endsWith(suffix));
      return hit ? path.join(searchDir, hit) : null;
    },
    readFrontmatter: (file) => extractFrontmatter(fs.readFileSync(file, 'utf8')),
    // Never reached by this predicate kind; required by the evaluator's
    // dependency contract.
    runBoundedShell: () => ({ exitCode: 0, stdout: '', stderr: '', signal: null }),
  });

  const gateOn = (field, equals) =>
    evaluatePredicate(
      { kind: 'artifact-frontmatter-equals', artifact: 'VERIFICATION.md', field, equals },
      { cwd: dir, phaseDir },
      deps()
    );

  beforeEach(() => {
    dir = createTempDir();
    phaseDir = makeProject(dir, { tests: 'echo "# pass 12" && echo "# fail 0"' });
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('a green recording lets the gate through', () => {
    runGatesCli(dir, phaseDir);
    assert.equal(gateOn('gates.all_passed', true).block, false);
    assert.equal(gateOn('gates.failed', 0).block, false);
    assert.equal(gateOn('gates.tests_failed_count', 0).block, false);
  });

  test('a red recording blocks the same gate', () => {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { verify_gates: { tests: 'exit 1' } } })
    );
    runGatesCli(dir, phaseDir);
    assert.equal(
      gateOn('gates.all_passed', true).block,
      true,
      'the verdict must follow the measurement, not a narrative'
    );
  });

  test('top-level fields still resolve — existing gates are unaffected', () => {
    runGatesCli(dir, phaseDir);
    const vpath = path.join(phaseDir, '03-VERIFICATION.md');
    fs.writeFileSync(
      path.join(phaseDir, '03-VERIFICATION.md'),
      fs.readFileSync(vpath, 'utf8').replace('---\n', '---\ntruths_unproven: 0\n')
    );
    assert.equal(gateOn('truths_unproven', 0).block, false);
  });

  test('an absent path blocks rather than throwing, at either depth', () => {
    runGatesCli(dir, phaseDir);
    assert.equal(gateOn('gates.nope.deeper', true).block, true);
    assert.equal(gateOn('not_a_field', true).block, true);
  });

  test('a prototype key does not resolve to a function', () => {
    runGatesCli(dir, phaseDir);
    assert.equal(gateOn('gates.constructor', true).block, true);
    assert.equal(gateOn('gates.toString', true).block, true);
  });
});
