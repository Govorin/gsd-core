'use strict';

/**
 * The mn fork's enforcement hooks — four guards that move a check the pipeline
 * already performs from AFTER the work to DURING it.
 *
 * Seams (all four are PreToolUse/SubagentStop/PostCompact hooks, driven here
 * through their exported decision functions, and — for the two that can block
 * a tool call — also through the real stdin/exit-code contract via the process
 * seam, because the exit code IS the enforcement):
 *
 *   hooks/gsd-prohibition-guard.js   write outside the running plan's scope
 *   hooks/gsd-test-tamper-guard.js   write that deletes assertions or skips tests
 *   hooks/gsd-exit-gate.js           executor stopping on a red tree
 *   hooks/gsd-pin-invariants.js      constraints lost to a context rewrite
 *
 * Why these exist at all: each one's after-the-fact counterpart already ships
 * (blast-radius, assertion-ratchet, the verifier, PreCompact warnings) and each
 * answers its question at a point where the only available remedy is a revert.
 * The tests below therefore concentrate on the properties that make an
 * enforcement hook safe to leave armed: it is silent unless configured; it is
 * silent when it cannot identify what governs the write; it does not block the
 * legitimate shapes of the thing it guards; and where it must fail, it fails in
 * the stated direction.
 *
 * Boundary coverage is deliberate on the two counters that carry budgets: the
 * exit gate's retry ledger is tested at limit-1, limit and limit+1, and the
 * pin's character budget at "fits", "drops a block" and "drops everything".
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const prohibition = require(path.join(HOOKS_DIR, 'gsd-prohibition-guard.js'));
const tamper = require(path.join(HOOKS_DIR, 'gsd-test-tamper-guard.js'));
const exitGate = require(path.join(HOOKS_DIR, 'gsd-exit-gate.js'));
const pin = require(path.join(HOOKS_DIR, 'gsd-pin-invariants.js'));

/** Build a minimal GSD project: `.planning/` plus whatever the test needs. */
function makeProject(dir, { workflow = {}, state = null } = {}) {
  fs.mkdirSync(path.join(dir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ workflow }, null, 2)
  );
  if (state !== null) {
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), `---\ncurrent_phase: ${state}\n---\n`);
  }
  return dir;
}

/** Write a PLAN.md with the frontmatter fields the guards read. */
function writePlan(dir, phaseName, planName, fields = {}) {
  const phaseDir = path.join(dir, '.planning', 'phases', phaseName);
  fs.mkdirSync(phaseDir, { recursive: true });
  const {
    status = 'in_progress',
    filesModified = [],
    prohibitions = [],
    mustHaves = [],
  } = fields;
  const list = (name, items) =>
    items.length ? `${name}:\n${items.map((i) => `  - ${i}`).join('\n')}\n` : `${name}: []\n`;
  const body =
    '---\n' +
    `phase: ${phaseName.split('-')[0]}\n` +
    `plan: ${planName}\n` +
    `status: ${status}\n` +
    list('files_modified', filesModified) +
    list('prohibitions', prohibitions) +
    list('must_haves', mustHaves) +
    '---\n\n# Plan\n';
  const file = path.join(phaseDir, `${planName}-PLAN.md`);
  fs.writeFileSync(file, body);
  return file;
}

const writePayload = (dir, filePath, tool = 'Write', extra = {}) => ({
  tool_name: tool,
  tool_input: { file_path: filePath, content: 'x', ...extra },
  cwd: dir,
});

describe('mn enforcement hooks — prohibition guard', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('is inert when the config does not arm it (absent = off, not absent = on)', () => {
    makeProject(dir);
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/undeclared.ts')).action, 'allow');
  });

  test('escalates an undeclared write in "ask" mode rather than deciding for the user', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'ask' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    const decision = prohibition.evaluateWrite(writePayload(dir, 'libs/undeclared.ts'));
    assert.equal(decision.action, 'ask');
    assert.equal(decision.declaredCount, 1);
    assert.equal(decision.targetPath, 'libs/undeclared.ts');
  });

  test('blocks an undeclared write in "deny" mode', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/undeclared.ts')).action, 'deny');
  });

  test('allows a declared path, a declared directory and a declared glob', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', {
      filesModified: ['libs/exact.ts', 'libs/dir', `libs/globbed/${'**'}`],
    });
    for (const target of ['libs/exact.ts', 'libs/dir/inner.ts', 'libs/globbed/deep/file.ts']) {
      assert.equal(
        prohibition.evaluateWrite(writePayload(dir, target)).action,
        'allow',
        `expected ${target} to be permitted by its declaration`
      );
    }
  });

  test('a blank line between the key and the first item does not end the list', () => {
    // Regression, found by running the installed guard against a real project:
    // 17 of 96 plans there put an empty line after `files_modified:`. YAML
    // ignores it; the parser treated it as the end of the block, so those
    // plans parsed as declaring nothing — and by the empty-declaration rule
    // that silently turned the guard OFF for exactly those phases. A guard
    // that disables itself on a legal file shape is worse than one that is
    // simply absent, because its silence reads as approval.
    const withBlankLine = [
      '---',
      'phase: 03',
      'plan: 01',
      'status: in_progress',
      'files_modified:',
      '',
      '  - libs/declared.ts',
      '  - libs/second.ts',
      '',
      'autonomous: true',
      '---',
      '',
      '# Plan',
      '',
    ].join('\n');
    assert.deepEqual(prohibition.declaredFiles(withBlankLine), [
      'libs/declared.ts',
      'libs/second.ts',
    ]);

    // The block still ends at the first non-item line, blank lines aside —
    // otherwise the parser would swallow the rest of the frontmatter.
    assert.ok(!prohibition.declaredFiles(withBlankLine).some((f) => f.includes('autonomous')));

    // And end to end: with the blank-line shape on disk, a declared write is
    // permitted and an undeclared one is not.
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    const phaseDir = path.join(dir, '.planning', 'phases', '03-ports');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), withBlankLine);
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/declared.ts')).action, 'allow');
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/other.ts')).action, 'deny');
  });

  test('never guards .planning/ — the harness writes its own bookkeeping', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    const summary = path.join(dir, '.planning', 'phases', '03-ports', '03-01-SUMMARY.md');
    assert.equal(prohibition.evaluateWrite(writePayload(dir, summary)).action, 'allow');
  });

  test('is inert when no plan is running, even with the guard armed', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { status: 'done', filesModified: ['libs/declared.ts'] });
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/undeclared.ts')).action, 'allow');
  });

  test('falls back to STATE.md when no plan carries a status', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' }, state: '03' });
    writePlan(dir, '03-ports', '03-01', { status: 'done', filesModified: ['libs/declared.ts'] });
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/undeclared.ts')).action, 'deny');
  });

  test('is inert while several plans run at once — no single scope governs', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/a.ts'] });
    writePlan(dir, '04-api', '04-01', { filesModified: ['libs/b.ts'] });
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/undeclared.ts')).action, 'allow');
  });

  test('is inert when the phase declares nothing — that is blast-radius\'s refusal to make', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: [] });
    assert.equal(prohibition.evaluateWrite(writePayload(dir, 'libs/anything.ts')).action, 'allow');
  });

  test('fails closed when armed and the phase directory cannot be read', () => {
    // A file where the phases directory belongs: readdirSync then fails with a
    // real, deterministic ENOTDIR on every platform — not a permission trick,
    // which CLAUDE.md rules out as a cross-platform IO injection.
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { prohibition_guard: 'deny' } })
    );
    fs.writeFileSync(path.join(dir, '.planning', 'phases'), 'not a directory');
    const decision = prohibition.evaluateWrite(writePayload(dir, 'libs/anything.ts'));
    assert.equal(decision.action, 'deny');
    assert.ok(decision.readError, 'the unreadable-state denial must carry a typed error code');
  });

  test('ignores tools that do not write and paths outside the project', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    const read = { ...writePayload(dir, 'libs/undeclared.ts'), tool_name: 'Read' };
    assert.equal(prohibition.evaluateWrite(read).action, 'allow');
    const outside = writePayload(dir, path.join(path.dirname(dir), 'elsewhere.ts'));
    assert.equal(prohibition.evaluateWrite(outside).action, 'allow');
  });

  test('judges a Kimi payload by its authoritative path, not a decoy file_path', () => {
    // The guard carries the canonical #2304 normalization block. Kimi's file
    // tools execute on `path`; a model-supplied `file_path` must not shadow it,
    // in either direction.
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    const kimi = (kimiTool, target, decoy) => ({
      tool_name: kimiTool,
      tool_input: { path: path.join(dir, target), file_path: path.join(dir, decoy), content: 'x' },
      cwd: dir,
    });
    for (const kimiTool of ['WriteFile', 'kimi_cli.tools.file:StrReplaceFile']) {
      assert.equal(
        prohibition.evaluateWrite(kimi(kimiTool, 'libs/undeclared.ts', 'libs/declared.ts')).action,
        'deny',
        `${kimiTool}: an undeclared path hidden behind a declared file_path must still be denied`
      );
      assert.equal(
        prohibition.evaluateWrite(kimi(kimiTool, 'libs/declared.ts', 'libs/undeclared.ts')).action,
        'allow',
        `${kimiTool}: a declared path must not be denied because of a decoy file_path`
      );
    }
    // Kimi's read and shell tools are not writes, so the guard stays out of them.
    for (const kimiTool of ['ReadFile', 'Shell']) {
      assert.equal(
        prohibition.evaluateWrite(kimi(kimiTool, 'libs/undeclared.ts', 'libs/undeclared.ts')).action,
        'allow'
      );
    }
  });

  test('a malformed payload never blocks a tool call', () => {
    assert.equal(prohibition.evaluateWrite(null).action, 'allow');
    assert.equal(prohibition.evaluateWrite({ tool_name: 'Write' }).action, 'allow');
  });

  test('denial reaches the runtime as exit 2 with a typed payload', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    const result = runNode(
      [path.join(HOOKS_DIR, 'gsd-prohibition-guard.js')],
      { input: JSON.stringify(writePayload(dir, 'libs/undeclared.ts')), cwd: dir }
    );
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 2, 'exit 2 is what blocks the call; anything else is advisory');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(payload.targetPath, 'libs/undeclared.ts');
  });

  test('an allowed write exits 0 and says nothing', () => {
    makeProject(dir, { workflow: { prohibition_guard: 'deny' } });
    writePlan(dir, '03-ports', '03-01', { filesModified: ['libs/declared.ts'] });
    const result = runNode(
      [path.join(HOOKS_DIR, 'gsd-prohibition-guard.js')],
      { input: JSON.stringify(writePayload(dir, 'libs/declared.ts')), cwd: dir }
    );
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), '');
  });
});

describe('mn enforcement hooks — test tamper guard', () => {
  let dir;
  const THREE_ASSERTIONS = [
    "describe('order', () => {",
    "  it('a', () => { expect(1).toBe(1); });",
    "  it('b', () => { expect(2).toBe(2); });",
    "  it('c', () => { expect(3).toBe(3); });",
    '});',
    '',
  ].join('\n');

  beforeEach(() => {
    dir = createTempDir();
    makeProject(dir, { workflow: { test_tamper_guard: 'deny' } });
    fs.mkdirSync(path.join(dir, 'libs'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'libs', 'order.spec.ts'), THREE_ASSERTIONS);
  });
  afterEach(() => {
    cleanup(dir);
  });

  const spec = () => path.join(dir, 'libs', 'order.spec.ts');

  test('blocks a write that removes an assertion', () => {
    const shorter = THREE_ASSERTIONS.replace("  it('c', () => { expect(3).toBe(3); });\n", '');
    const decision = tamper.evaluateTestWrite(writePayload(dir, spec(), 'Write', { content: shorter }));
    assert.equal(decision.action, 'deny');
    assert.equal(decision.assertionsBefore, 3);
    assert.equal(decision.assertionsAfter, 2);
  });

  test('blocks a write that newly skips a test without removing it', () => {
    const skipped = THREE_ASSERTIONS.replace("it('c'", "it.skip('c'");
    const decision = tamper.evaluateTestWrite(writePayload(dir, spec(), 'Write', { content: skipped }));
    assert.equal(decision.action, 'deny');
    assert.equal(decision.skipsAfter, decision.skipsBefore + 1);
  });

  test('treats a commented-out assertion as a removed one', () => {
    const commented = THREE_ASSERTIONS.replace('expect(3).toBe(3);', '// expect(3).toBe(3);');
    assert.equal(
      tamper.evaluateTestWrite(writePayload(dir, spec(), 'Write', { content: commented })).action,
      'deny'
    );
  });

  test('allows adding assertions, and allows restructuring that keeps the count', () => {
    const more = THREE_ASSERTIONS.replace(
      '});\n',
      "  it('d', () => { expect(4).toBe(4); });\n});\n"
    );
    assert.equal(
      tamper.evaluateTestWrite(writePayload(dir, spec(), 'Write', { content: more })).action,
      'allow'
    );
    const renamed = THREE_ASSERTIONS.replace("it('a'", "it('a, renamed'");
    assert.equal(
      tamper.evaluateTestWrite(writePayload(dir, spec(), 'Write', { content: renamed })).action,
      'allow'
    );
  });

  test('projects an Edit onto the file on disk instead of judging the fragment', () => {
    const removing = {
      tool_name: 'Edit',
      tool_input: {
        file_path: spec(),
        old_string: "  it('c', () => { expect(3).toBe(3); });\n",
        new_string: '',
      },
      cwd: dir,
    };
    assert.equal(tamper.evaluateTestWrite(removing).action, 'deny');

    const renaming = {
      tool_name: 'Edit',
      tool_input: { file_path: spec(), old_string: "it('a'", new_string: "it('renamed'" },
      cwd: dir,
    };
    assert.equal(
      tamper.evaluateTestWrite(renaming).action,
      'allow',
      'an Edit that changes no assertion must not read as a mass deletion'
    );
  });

  test('applies MultiEdit replacements in order before judging', () => {
    const decision = tamper.evaluateTestWrite({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: spec(),
        edits: [
          { old_string: "  it('b', () => { expect(2).toBe(2); });\n", new_string: '' },
          { old_string: "  it('c', () => { expect(3).toBe(3); });\n", new_string: '' },
        ],
      },
      cwd: dir,
    });
    assert.equal(decision.action, 'deny');
    assert.equal(decision.assertionsAfter, 1);
  });

  test('ignores non-test files and brand-new test files', () => {
    fs.writeFileSync(path.join(dir, 'libs', 'order.ts'), 'export const x = 1;\n');
    assert.equal(
      tamper.evaluateTestWrite(
        writePayload(dir, path.join(dir, 'libs', 'order.ts'), 'Write', { content: '' })
      ).action,
      'allow'
    );
    assert.equal(
      tamper.evaluateTestWrite(
        writePayload(dir, path.join(dir, 'libs', 'brand-new.spec.ts'), 'Write', { content: '' })
      ).action,
      'allow',
      'a test that does not exist yet cannot be weakened'
    );
  });

  test('recognises the tests/ directory convention, not only the .spec suffix', () => {
    const file = path.join(dir, 'tests', 'thing.cjs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'assert.equal(1, 1);\nassert.equal(2, 2);\n');
    assert.equal(
      tamper.evaluateTestWrite(
        writePayload(dir, file, 'Write', { content: 'assert.equal(1, 1);\n' })
      ).action,
      'deny'
    );
  });

  test('is inert when the config does not arm it', () => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: {} }));
    const shorter = THREE_ASSERTIONS.replace("  it('c', () => { expect(3).toBe(3); });\n", '');
    assert.equal(
      tamper.evaluateTestWrite(writePayload(dir, spec(), 'Write', { content: shorter })).action,
      'allow'
    );
  });

  test('a block comment hides an assertion as effectively as a line comment', () => {
    // Regression, found by tests/mn-enforcement-evals.test.cjs after this
    // file's own cases were green: only `//` was stripped, so commenting a
    // check out with `/* … */` left it counted as live and the deletion went
    // through disguised as a comment. The eval case existed because it is the
    // obvious evasion of a line-count check; the unit test did not, because
    // the unit test was written from the implementation.
    const inline = "  it('c', () => { /* expect(3).toBe(3); */ });";
    assert.equal(tamper.countAssertions(inline), 0);
    assert.equal(tamper.countAssertions('  /* expect(3).toBe(3); */'), 0);
    assert.equal(tamper.countAssertions('   * expect(3).toBe(3);'), 0, 'a block continuation line');
    assert.equal(tamper.countAssertions('  /* start of an unterminated block'), 0);
    assert.equal(
      tamper.countAssertions('  expect(a).toBe(1); // was expect(b).toBe(2)'),
      1,
      'live code before a comment still counts once'
    );
    assert.equal(tamper.countSkips('  /* it.skip("x") */'), 0);
  });

  test('counts one assertion per matcher chain, not per token', () => {
    // expect(x).toBe(y) is ONE assertion. Counting the head and the matcher
    // separately doubles every Jest-style file and makes the before/after
    // numbers in the block message meaningless.
    assert.equal(tamper.countAssertions('expect(1).toBe(1);'), 1);
    assert.equal(tamper.countAssertions('assert.equal(1, 1);'), 1);
    assert.equal(tamper.countAssertions('// expect(1).toBe(1);'), 0);
    assert.equal(tamper.countAssertions('  x.toBe(1);'), 1);
  });

  test('denial reaches the runtime as exit 2', () => {
    const shorter = THREE_ASSERTIONS.replace("  it('c', () => { expect(3).toBe(3); });\n", '');
    const result = runNode([path.join(HOOKS_DIR, 'gsd-test-tamper-guard.js')], {
      input: JSON.stringify(writePayload(dir, spec(), 'Write', { content: shorter })),
      cwd: dir,
    });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.assertionsBefore, 3);
    assert.equal(payload.assertionsAfter, 2);
  });
});

describe('mn enforcement hooks — executor exit gate', () => {
  let dir;
  const green = () => ({ status: 0, stdout: '', stderr: '', error: null, signal: null });
  const red = () => ({ status: 1, stdout: 'tsc: 3 errors', stderr: '', error: null, signal: null });
  const stopping = (type = 'gsd-executor') => ({ subagent_type: type, cwd: dir });

  beforeEach(() => {
    dir = createTempDir();
    makeProject(dir, { workflow: { exit_gate: 'check' } }, );
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '---\ncurrent_phase: 03\n---\n');
  });
  afterEach(() => {
    cleanup(dir);
  });

  const arm = (workflow) =>
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow }));

  test('is inert until a command is configured — only the project knows what green means', () => {
    arm({});
    assert.equal(exitGate.evaluateStop(stopping(), { runner: red }).action, 'allow');
  });

  test('refuses the stop while the project\'s own checks are red', () => {
    const decision = exitGate.evaluateStop(stopping(), { runner: red });
    assert.equal(decision.action, 'block');
    assert.equal(decision.exitCode, 1);
    assert.ok(
      decision.output.includes('tsc: 3 errors'),
      'the command\'s own output must reach the agent — a paraphrase is not actionable'
    );
  });

  test('allows the stop when the checks pass', () => {
    assert.equal(exitGate.evaluateStop(stopping(), { runner: green }).action, 'allow');
  });

  test('only applies to the configured agents, declared as a list or a string', () => {
    assert.equal(exitGate.evaluateStop(stopping('gsd-verifier'), { runner: red }).action, 'allow');
    // The capability schema declares a comma-separated string…
    arm({ exit_gate: 'check', exit_gate_agents: 'gsd-verifier, gsd-executor' });
    assert.equal(exitGate.evaluateStop(stopping('gsd-verifier'), { runner: red }).action, 'block');
    // …and a hand-written JSON list must not silently make the gate inert.
    arm({ exit_gate: 'check', exit_gate_agents: ['gsd-verifier'] });
    assert.equal(exitGate.evaluateStop(stopping('gsd-verifier'), { runner: red }).action, 'block');
    assert.equal(exitGate.evaluateStop(stopping('gsd-executor'), { runner: red }).action, 'allow');
  });

  test('retry budget: blocks below the limit, reports at and past it', () => {
    arm({ exit_gate: 'check', exit_gate_max_retries: 2 });
    // limit - 1
    assert.equal(exitGate.evaluateStop(stopping(), { runner: red }).attempt, 1);
    // limit
    const atLimit = exitGate.evaluateStop(stopping(), { runner: red });
    assert.equal(atLimit.action, 'block');
    assert.equal(atLimit.attempt, 2);
    // limit + 1 — reports instead of looping the executor against debt
    const past = exitGate.evaluateStop(stopping(), { runner: red });
    assert.equal(past.action, 'allow');
    assert.equal(past.exhausted, true);
    assert.equal(past.exitCode, 1, 'stepping aside must still report the failure, not hide it');
  });

  test('a spent budget does not disarm the gate — a green tree re-arms it', () => {
    // Regression: an earlier revision returned early once the budget was spent,
    // WITHOUT running the command. Only a green run clears the ledger, so no
    // run meant the ledger could never clear: one red phase disabled the gate
    // permanently for that worktree, silently.
    arm({ exit_gate: 'check', exit_gate_max_retries: 1 });
    assert.equal(exitGate.evaluateStop(stopping(), { runner: red }).action, 'block');
    assert.equal(exitGate.evaluateStop(stopping(), { runner: red }).exhausted, true);
    assert.equal(exitGate.evaluateStop(stopping(), { runner: green }).action, 'allow');
    assert.equal(
      exitGate.evaluateStop(stopping(), { runner: red }).action,
      'block',
      'after a green run the gate must guard again'
    );
  });

  test('a gate that cannot run is not a gate that failed', () => {
    const missing = () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT' }, signal: null });
    const timedOut = () => ({ status: null, stdout: '', stderr: '', error: null, signal: 'SIGTERM' });
    const threw = () => {
      throw Object.assign(new Error('spawn failed'), { code: 'EACCES' });
    };
    for (const [label, runner, code] of [
      ['missing command', missing, 'ENOENT'],
      ['timeout', timedOut, 'SIGTERM'],
      ['spawn throws', threw, 'EACCES'],
    ]) {
      const decision = exitGate.evaluateStop(stopping(), { runner });
      assert.equal(decision.action, 'allow', `${label} must not strand the session`);
      assert.equal(decision.spawnError, code, `${label} must be reported as a config problem`);
    }
  });

  test('is inert outside a GSD project and on a malformed payload', () => {
    const bare = createTempDir();
    try {
      assert.equal(
        exitGate.evaluateStop({ subagent_type: 'gsd-executor', cwd: bare }, { runner: red }).action,
        'allow'
      );
    } finally {
      cleanup(bare);
    }
    assert.equal(exitGate.evaluateStop(null).action, 'allow');
  });
});

describe('mn enforcement hooks — invariant pin', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir();
    makeProject(dir);
  });
  afterEach(() => {
    cleanup(dir);
  });

  test('says nothing when there is nothing to pin', () => {
    assert.equal(pin.buildPin(dir), null);
  });

  test('restates the running plan\'s prohibitions and must-haves', () => {
    writePlan(dir, '05-alerts', '05-01', {
      prohibitions: ['do not touch the auth module'],
      mustHaves: ['alerts survive a restart'],
    });
    const built = pin.buildPin(dir);
    assert.ok(built.context.includes('do not touch the auth module'));
    assert.ok(built.context.includes('alerts survive a restart'));
    assert.ok(built.context.includes('05-alerts'), 'the pin must name what it is pinning for');
  });

  test('puts an open blocker first, and ignores a resolved one', () => {
    writePlan(dir, '05-alerts', '05-01', { prohibitions: ['no new dependencies'] });
    const waiting = path.join(dir, '.planning', 'WAITING.json');
    fs.writeFileSync(waiting, JSON.stringify({ type: 'blocker', question: 'Which retention window?' }));
    const built = pin.buildPin(dir);
    assert.ok(
      built.context.indexOf('Which retention window?') < built.context.indexOf('no new dependencies'),
      'a question already asked of the user outranks a standing rule'
    );

    fs.writeFileSync(waiting, JSON.stringify({ type: 'blocker', question: 'answered', resolved: true }));
    assert.ok(!pin.buildPin(dir).context.includes('answered'));
  });

  test('pins only the delimited block of CLAUDE.md, not the whole file', () => {
    fs.writeFileSync(
      path.join(dir, 'CLAUDE.md'),
      `# Project\n\nprose that must not be pinned\n\n${pin.PIN_OPEN}\nEither only; never isLeft.\n${pin.PIN_CLOSE}\n\nmore prose\n`
    );
    const built = pin.buildPin(dir);
    assert.ok(built.context.includes('Either only; never isLeft.'));
    assert.ok(!built.context.includes('prose that must not be pinned'));
    assert.ok(!built.context.includes('more prose'));
  });

  test('budget: fits, drops a block at a boundary, drops everything', () => {
    writePlan(dir, '05-alerts', '05-01', {
      prohibitions: ['do not touch the auth module'],
      mustHaves: ['alerts survive a restart'],
    });
    const armBudget = (budget) =>
      fs.writeFileSync(
        path.join(dir, '.planning', 'config.json'),
        JSON.stringify({ workflow: { pin_invariants_budget: budget } })
      );

    armBudget(4000);
    const roomy = pin.buildPin(dir);
    assert.equal(roomy.dropped, 0);
    assert.ok(roomy.context.includes('alerts survive a restart'));

    armBudget(200);
    const tight = pin.buildPin(dir);
    assert.ok(tight.dropped > 0);
    assert.ok(
      tight.context.includes('omitted'),
      'an omission must be stated — a silently shortened pin looks complete'
    );

    armBudget(1);
    const none = pin.buildPin(dir);
    assert.equal(none.dropped, 2);
    assert.ok(
      none.context.includes('omitted'),
      'a mis-set budget must be visible rather than silently disabling the pin'
    );
  });

  test('pins nothing from plans while several run at once', () => {
    writePlan(dir, '05-alerts', '05-01', { prohibitions: ['rule A'] });
    writePlan(dir, '06-api', '06-01', { prohibitions: ['rule B'] });
    assert.equal(pin.buildPin(dir), null, 'no single plan speaks for the session');
  });

  test('can be switched off explicitly (absent = enabled)', () => {
    writePlan(dir, '05-alerts', '05-01', { prohibitions: ['rule A'] });
    assert.ok(pin.buildPin(dir));
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { pin_invariants: false } })
    );
    assert.equal(pin.buildPin(dir), null);
  });

  test('emits additionalContext and never blocks', () => {
    writePlan(dir, '05-alerts', '05-01', { prohibitions: ['rule A'] });
    const result = runNode([path.join(HOOKS_DIR, 'gsd-pin-invariants.js')], {
      input: JSON.stringify({ cwd: dir }),
      cwd: dir,
    });
    assert.equal(result.outcome, OUTCOME.EXITED);
    assert.equal(result.exitCode, 0, 'a context hook must never fail a session');
    assert.ok(JSON.parse(result.stdout).additionalContext.includes('rule A'));
  });
});
