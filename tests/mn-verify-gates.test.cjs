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

  const runOne = (raw) =>
    verifyGates.runGates({
      cwd: '/nowhere',
      phaseDir: '/nowhere',
      checks: [{ name: 'tests', command: 'x' }],
      runner: () => raw,
      clock: { now: () => 0 },
    })[0];
  const run = (fields) => ({ status: null, stdout: '', stderr: '', error: null, signal: null, ...fields });

  test('a check that could not run is stale or timed out, never a code failure', () => {
    // Every rule of the classifier that is not "the check answered", with the cause it records.
    const cases = [
      ['spawn error', run({ error: { code: 'ENOENT' } }), 'stale', 'spawn_ENOENT', null],
      ['spawn error without a code', run({ error: {} }), 'stale', 'spawn_UNKNOWN', null],
      ['killed by a signal it did not raise', run({ signal: 'SIGKILL' }), 'stale', 'signal_SIGKILL', null],
      ['output past the capture limit', run({ error: { code: 'ENOBUFS' }, signal: 'SIGTERM' }), 'stale', 'ENOBUFS', null],
      ['killed at the time budget', run({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' }), 'timeout', 'ETIMEDOUT', null],
      ['exit 127, command not found', run({ status: 127 }), 'stale', 'exit_127', 127],
      ['exit 126, not executable', run({ status: 126 }), 'stale', 'exit_126', 126],
    ];
    for (const [label, raw, status, cause, exitCode] of cases) {
      const result = runOne(raw);
      assert.equal(result.status, status, label);
      assert.equal(result.cause, cause, label);
      assert.equal(result.exitCode, exitCode, label);
      assert.equal(result.passed, false, `${label}: it still does not count as a pass`);
    }
  });

  test('only 126 and 127 are the shell saying "could not run" — the codes either side are the check\'s answer', () => {
    // Boundary: 125 | 126 127 | 128. 128+n (a child killed by signal n) stays the check's own
    // answer: a runner may exit with any code, and excusing 137 would excuse a test that
    // crashed the process it tested.
    const cases = [
      [0, 'pass'],
      [1, 'fail'],
      [125, 'fail'],
      [126, 'stale'],
      [127, 'stale'],
      [128, 'fail'],
      [137, 'fail'],
    ];
    for (const [status, expected] of cases) {
      const result = runOne(run({ status }));
      assert.equal(result.status, expected, `exit ${status}`);
      assert.equal(result.exitCode, status, `exit ${status} keeps its exit code`);
      assert.equal(result.cause, expected === 'stale' ? `exit_${status}` : '', `exit ${status}`);
    }
  });

  test('a timeout outranks the signal it arrives with, and the cap outranks the generic spawn rule', () => {
    // Both arrive as an error WITH a signal; the order of CHECK_OUTCOME_RULES is what keeps a
    // timeout from reading as "killed by SIGTERM".
    assert.equal(verifyGates.classifyRun(run({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM' })).status, 'timeout');
    assert.equal(verifyGates.classifyRun(run({ error: { code: 'ENOBUFS' }, signal: 'SIGTERM' })).cause, 'ENOBUFS');
    const ids = verifyGates.CHECK_OUTCOME_RULES.map((r) => r.id);
    assert.equal(ids[ids.length - 1], 'exit_other', 'the catch-all must be last, or it shadows every rule after it');
  });

  test('every status is reachable and has a gate verdict', () => {
    const statuses = Object.values(verifyGates.CHECK_STATUS);
    for (const status of statuses) {
      assert.ok(verifyGates.CHECK_OUTCOME_RULES.some((r) => r.status === status), `${status} is reached by no rule`);
      assert.ok(verifyGates.CHECK_STATUS_VERDICT[status], `${status} has no verdict`);
    }
    assert.deepEqual(
      statuses.filter((s) => verifyGates.CHECK_STATUS_VERDICT[s] === 'finding'),
      ['fail'],
      'only a measured red may be called a finding about the code'
    );
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
    assert.equal(result.status, 'stale');
    assert.equal(result.cause, 'spawn_EACCES');
  });

  test('a run that did not answer carries no counts, even when it printed a summary', () => {
    const result = runOne(run({ error: { code: 'ETIMEDOUT' }, signal: 'SIGTERM', stdout: '# pass 40\n# fail 0\n' }));
    assert.equal(result.counts, undefined, 'a timed-out suite\'s partial summary is not its result');
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
        { name: 'tests', command: 't', exitCode: 0, status: 'pass', cause: '', passed: true, durationMs: 5, counts: { passed: 41 } },
        { name: 'type-check', command: 'tc', exitCode: 2, status: 'fail', cause: '', passed: false, durationMs: 7 },
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
      [{ name: 'tests', command: 't', exitCode: 0, status: 'pass', cause: '', passed: true, durationMs: 1, counts: { passed: 41, failed: 0 } }],
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

  const result = (name, status, extra = {}) => ({
    name,
    command: name,
    exitCode: status === 'pass' ? 0 : status === 'fail' ? 1 : null,
    status,
    cause: '',
    passed: status === 'pass',
    durationMs: 1,
    ...extra,
  });

  test('each status is counted under its own key — a stale check is never counted as failed', () => {
    const block = verifyGates.buildGatesFrontmatter(
      [
        result('tests', 'fail'),
        result('lint', 'stale', { exitCode: 127, cause: 'exit_127' }),
        result('e2e', 'timeout', { cause: 'ETIMEDOUT' }),
        result('types', 'pass'),
      ],
      '2026-01-01T00:00:00Z'
    );
    assert.deepEqual([block.failed, block.stale, block.timed_out], [1, 1, 1]);
    assert.equal(block.all_passed, false);
    assert.equal(block.lint_status, 'stale');
    assert.equal(block.lint_cause, 'exit_127');
    assert.equal(block.lint_exit_code, 127);
    assert.equal(block.types_status, 'pass');
    assert.equal(Object.prototype.hasOwnProperty.call(block, 'types_cause'), false, 'a measured check carries no cause');
  });

  test('a roster that is only stale is not all_passed and has no failures', () => {
    // The case 4.3 exists for: every command is gone. Green would lie; red would lie too.
    const block = verifyGates.buildGatesFrontmatter([result('lint', 'stale', { exitCode: 127, cause: 'exit_127' })], 'x');
    assert.equal(block.all_passed, false);
    assert.equal(block.failed, 0);
    assert.equal(block.stale, 1);
  });
});

describe('verify gates — reading a record back', () => {
  test('reads each check\'s status as recorded', () => {
    const checks = verifyGates.recordedChecks({
      ran: ['tests', 'lint'],
      tests_status: 'fail',
      tests_exit_code: '1',
      lint_status: 'stale',
      lint_exit_code: '127',
      lint_cause: 'exit_127',
    });
    assert.deepEqual(checks, [
      { name: 'tests', status: 'fail', cause: '', exitCode: 1 },
      { name: 'lint', status: 'stale', cause: 'exit_127', exitCode: 127 },
    ]);
  });

  test('a record written before statuses existed is still read', () => {
    const checks = verifyGates.recordedChecks({
      ran: ['tests', 'lint', 'types'],
      tests_passed: 'true',
      tests_exit_code: '0',
      lint_passed: 'false',
      lint_exit_code: 'null',
      lint_unrunnable: 'ENOENT',
      types_passed: 'false',
      types_exit_code: '2',
    });
    assert.deepEqual(
      checks.map((c) => [c.name, c.status, c.cause]),
      [
        ['tests', 'pass', ''],
        ['lint', 'stale', 'ENOENT'],
        ['types', 'fail', ''],
      ]
    );
  });

  test('a check the record names but does not describe is unreadable, not guessed', () => {
    const [check] = verifyGates.recordedChecks({ ran: ['tests'] });
    assert.equal(check.status, null);
    assert.equal(verifyGates.judgeRecordedChecks([check]).unreadable.length, 1);
  });

  test('a one-item list that frontmatter flattened to a scalar is still a list', () => {
    assert.deepEqual(verifyGates.recordedChecks({ ran: 'tests', tests_status: 'pass' }).map((c) => c.name), ['tests']);
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

  test('a command that does not exist records stale with a warning — not red, not green', () => {
    const phaseDir = makeProject(dir, { tests: 'true', lint: 'gsd-no-such-command-4-3' });
    const result = runGatesCli(dir, phaseDir);
    assert.equal(result.exitCode, 0, 'recording a stale check is still a successful recording');
    assert.equal(result.payload.allPassed, false);
    assert.equal(result.payload.failed, 0, 'a missing command is not a failed check');
    assert.equal(result.payload.stale, 1);
    const lint = result.payload.results.find((r) => r.name === 'lint');
    assert.deepEqual([lint.status, lint.cause, lint.exitCode], ['stale', 'exit_127', 127]);
    assert.equal(result.payload.warnings.length, 1);
    assert.deepEqual(
      [result.payload.warnings[0].check, result.payload.warnings[0].status, result.payload.warnings[0].setting],
      ['lint', 'stale', 'workflow.verify_gates.lint'],
      'the warning names the setting to repair'
    );

    const fm = extractFrontmatter(fs.readFileSync(path.join(phaseDir, '03-VERIFICATION.md'), 'utf8'));
    assert.equal(fm.gates.lint_status, 'stale');
    assert.equal(fm.gates.lint_cause, 'exit_127');
    assert.equal(fm.gates.stale, '1');
    assert.equal(fm.gates.failed, '0');
  });

  test('a command that is not executable records stale (exit 126)', () => {
    const phaseDir = makeProject(dir, { tests: './not-executable.sh' });
    fs.writeFileSync(path.join(dir, 'not-executable.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const result = runGatesCli(dir, phaseDir);
    const [tests] = result.payload.results;
    assert.deepEqual([tests.status, tests.cause, tests.exitCode], ['stale', 'exit_126', 126]);
  });

  test('--strict propagates a check that could not run, too', () => {
    // Nothing short of green has shown the code is fine.
    const phaseDir = makeProject(dir, { lint: 'gsd-no-such-command-4-3' });
    assert.equal(runGatesCli(dir, phaseDir, ['--strict']).exitCode, 1);
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
    // #5313: the lookup returns every candidate (more than one is ambiguous and blocks).
    findPhaseArtifact: (searchDir, suffix) =>
      fs.readdirSync(searchDir).filter((f) => f.endsWith(suffix)).map((f) => path.join(searchDir, f)),
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

/**
 * `check mn-verify-gates` — the ship:pre gate `workflow.verify_gates_enforce` declares. It
 * replaced the `artifact-frontmatter-equals` predicate on `gates.all_passed`, which blocked the
 * right cases but said the same thing for a red suite and a command that no longer exists.
 */
describe('verify gates — the enforce gate tells red from stale', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  function gate(phaseDir) {
    const result = runNode([TOOLS, 'check', 'mn-verify-gates', phaseDir, '--raw', '--cwd', dir], { cwd: dir });
    assert.equal(result.outcome, OUTCOME.EXITED, result.stderr);
    assert.equal(result.exitCode, 0, `a verdict is never an exit code: ${result.stdout}${result.stderr}`);
    return JSON.parse(result.stdout);
  }

  const record = (roster) => {
    const phaseDir = makeProject(dir, roster);
    runGatesCli(dir, phaseDir);
    return phaseDir;
  };

  test('the capability declares the enforce gate as this query', () => {
    const capability = require('../capabilities/mn-verify-gate/capability.json');
    const declared = capability.gates.find((g) => g.when === 'workflow.verify_gates_enforce');
    assert.deepEqual(declared.check, { query: 'mn-verify-gates' });
    assert.equal(declared.point, 'ship:pre');
    assert.equal(declared.blocking, true);
  });

  test('a green record passes', () => {
    const payload = gate(record({ tests: 'true', lint: 'true' }));
    assert.deepEqual([payload.block, payload.status], [false, 'pass']);
  });

  test('a red check is a finding that names it', () => {
    const payload = gate(record({ tests: 'exit 1', lint: 'true' }));
    assert.deepEqual([payload.block, payload.status], [true, 'finding']);
    assert.deepEqual(payload.red, ['tests']);
    assert.deepEqual(payload.unmeasured, []);
  });

  test('a stale check blocks as "could not check", not as a finding about the code', () => {
    const payload = gate(record({ tests: 'true', lint: 'gsd-no-such-command-4-3' }));
    assert.deepEqual([payload.block, payload.status], [true, 'unresolvable']);
    assert.deepEqual(payload.red, []);
    assert.deepEqual(payload.unmeasured, ['lint']);
  });

  test('red and stale together: the finding wins and both are named', () => {
    const payload = gate(record({ tests: 'exit 1', lint: 'gsd-no-such-command-4-3' }));
    assert.equal(payload.status, 'finding');
    assert.deepEqual([payload.red, payload.unmeasured], [['tests'], ['lint']]);
  });

  test('no record at all is unresolvable — an absent measurement is not a green one', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    const payload = gate(phaseDir);
    assert.deepEqual([payload.block, payload.status, payload.recorded], [true, 'unresolvable', false]);
  });

  test('a VERIFICATION.md without a gates: block is unresolvable', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    fs.writeFileSync(path.join(phaseDir, '03-VERIFICATION.md'), '---\nphase: 03\nstatus: passed\n---\n\n# Report\n');
    assert.deepEqual([gate(phaseDir).status, gate(phaseDir).recorded], ['unresolvable', false]);
  });

  test('a record written before statuses existed: its unrunnable check is stale, not red', () => {
    const phaseDir = makeProject(dir, { tests: 'true' });
    fs.writeFileSync(
      path.join(phaseDir, '03-VERIFICATION.md'),
      '---\nphase: 03\ngates:\n  all_passed: false\n  failed: 1\n  ran: [tests]\n  tests_passed: false\n  tests_exit_code: null\n  tests_unrunnable: ENOENT\n---\n'
    );
    const payload = gate(phaseDir);
    assert.equal(payload.status, 'unresolvable');
    assert.deepEqual(payload.unmeasured, ['tests']);
  });
});
