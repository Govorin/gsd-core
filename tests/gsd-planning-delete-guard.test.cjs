'use strict';

/**
 * gsd-planning-delete-guard.js — Bash commands that would destroy `.planning/`.
 *
 * Seam: hooks/gsd-planning-delete-guard.js, a PreToolUse hook spawned through
 * the process seam with the Claude Code payload on stdin — the exit code and
 * the typed JSON on stdout ARE the enforcement, so every matrix case runs the
 * real contract. The two budget boundaries (command length, nesting depth) go
 * through the exported `evaluateCommand`, which the stdin adapter calls.
 *
 * The incident this guards against: a fixer agent's `cd` chain broke and
 * `rm -rf .planning` ran in the main checkout, deleting uncommitted
 * config.json and state. The matrices pin what must be denied (every spelling
 * the scan can resolve), what must stay allowed (the deletions and moves GSD's
 * own workflows perform, and names that only look like `.planning`), and the
 * guard's off switch.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { QUICK_SPAWN_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOK_PATH = path.join(__dirname, '..', 'hooks', 'gsd-planning-delete-guard.js');
const guard = require(HOOK_PATH);

/**
 * <root>/proj        a GSD project (.planning with config, state, a phase,
 *                    scratch files), plus .planning-old, src/, docs/
 * <root>/wt          another checkout holding its own .planning (a worktree)
 * <root>/other       a plain directory
 */
function makeTree(root, config = {}) {
  const proj = path.join(root, 'proj');
  const planning = path.join(proj, '.planning');
  fs.mkdirSync(path.join(planning, 'phases', '01-a'), { recursive: true });
  fs.mkdirSync(path.join(planning, 'debug', 'resolved'), { recursive: true });
  fs.mkdirSync(path.join(planning, 'milestones'), { recursive: true });
  fs.writeFileSync(path.join(planning, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(planning, 'STATE.md'), '---\nstatus: executing\n---\n');
  fs.writeFileSync(path.join(planning, 'current-agent-id.txt'), 'a1\n');
  fs.writeFileSync(path.join(planning, 'debug', 'x.md'), '# debug\n');
  fs.mkdirSync(path.join(proj, '.planning-old'));
  fs.mkdirSync(path.join(proj, 'src'));
  fs.mkdirSync(path.join(proj, 'docs'));
  fs.mkdirSync(path.join(root, 'wt', '.planning'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'));
  return proj;
}

function run(command, cwd) {
  const r = runHook(HOOK_PATH, [], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }),
    timeoutMs: QUICK_SPAWN_TIMEOUT_MS,
  });
  assert.equal(r.outcome, OUTCOME.EXITED, `${command}: hook did not exit (${r.outcome})`);
  return r;
}

function assertDenied(command, cwd, code) {
  const r = run(command, cwd);
  assert.equal(r.exitCode, 2, `expected deny (exit 2) for: ${command}; stdout=${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block', command);
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny', command);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse', command);
  assert.equal(out.code, code, `${command}: code`);
  assert.equal(typeof out.reason, 'string');
  assert.ok(out.reason.length > 0, `${command}: a reason is required`);
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, out.reason, command);
  assert.equal(r.stderr, out.reason, `${command}: stderr carries the plain reason`);
}

function assertAllowed(command, cwd) {
  const r = run(command, cwd);
  assert.equal(r.exitCode, 0, `expected allow (exit 0) for: ${command}; stdout=${r.stdout}`);
  assert.equal(r.stdout, '', `${command}: an allow emits nothing`);
}

describe('gsd-planning-delete-guard: denied forms', () => {
  let root;
  let proj;
  before(() => {
    root = createTempDir('gsd-pdg-');
    proj = makeTree(root);
  });
  after(() => cleanup(root));

  const DENIED = [
    // the directory itself, by every spelling the scan resolves
    ['rm -rf .planning', 'planning-dir'],
    ['rm -rf ./.planning/', 'planning-dir'],
    ['rm -rf ".planning"', 'planning-dir'],
    ["rm -rf '.planning'", 'planning-dir'],
    ['rm -r -f .planning', 'planning-dir'],
    ['rm --recursive --force .planning', 'planning-dir'],
    ['rm -rf -- .planning', 'planning-dir'],
    ['rm -Rf src .planning', 'planning-dir'],
    ['rm -rf .PLANNING', 'planning-dir'],
    ['sudo rm -rf .planning', 'planning-dir'],
    ['/bin/rm -rf .planning', 'planning-dir'],
    ['\\rm -rf .planning', 'planning-dir'],
    ['command rm -rf .planning', 'planning-dir'],
    ['env X=1 rm -rf .planning', 'planning-dir'],
    ['timeout 5 rm -rf .planning', 'planning-dir'],
    ['rmdir .planning', 'planning-dir'],
    ['mv .planning .planning.bak', 'planning-dir'],
    ['mv -t /tmp .planning', 'planning-dir'],
    // run-time values: judged by their text
    ['rm -rf "$WT/.planning"', 'planning-dir'],
    ['rm -rf $(pwd)/.planning', 'planning-dir'],
    ['rm -rf `pwd`/.planning', 'planning-dir'],
    // globs and braces that select it
    ['rm -rf .plan*', 'planning-dir'],
    ['rm -rf .*', 'planning-dir'],
    ['rm -rf .planni?g', 'planning-dir'],
    ['rm -rf {src,.planning}', 'planning-dir'],
    // nested shells and substitutions
    ['bash -c "rm -rf .planning"', 'planning-dir'],
    ["sh -c 'cd .. && rm -rf proj'", 'planning-ancestor'],
    ['eval rm -rf .planning', 'planning-dir'],
    ['echo $(rm -rf .planning)', 'planning-dir'],
    ["bash <<'EOF'\nrm -rf .planning\nEOF", 'planning-dir'],
    // subtree and state files
    ['rm -rf .planning/phases', 'planning-subtree'],
    ['rm -rf .planning/phases/01-a', 'planning-subtree'],
    // the first match decides the code; matches are sorted as bash sorts them
    ['rm -rf .planning/*', 'planning-state-file'],
    ['rm .planning/config.json', 'planning-state-file'],
    ['rm -f .planning/STATE.md', 'planning-state-file'],
    ['rm -f .planning/*', 'planning-state-file'],
    ['unlink .planning/config.json', 'planning-state-file'],
    ['shred -u .planning/config.json', 'planning-state-file'],
    // moves out of .planning
    ['mv .planning/STATE.md /tmp/', 'planning-move-out'],
    ['mv .planning/phases/01-a src/', 'planning-move-out'],
    // find / git / xargs
    ['find .planning -name "*.md" -delete', 'planning-subtree'],
    ['find .planning -type f -exec rm {} +', 'planning-subtree'],
    ['find . -type f -delete', 'planning-ancestor'],
    ['find . -name STATE.md -delete', 'planning-subtree'],
    ['find . -name "*.md" -exec rm -f {} \\;', 'planning-subtree'],
    ['find /tmp/x -name .planning -exec rm -rf {} +', 'planning-dir'],
    ['git clean -fdx', 'planning-ancestor'],
    ['git clean -fd .planning', 'planning-dir'],
    ['git clean -f -- .planning/phases', 'planning-subtree'],
    ['git -C .planning clean -fd', 'planning-dir'],
    ['git rm -rf .planning', 'planning-dir'],
    ['git rm -f .planning/config.json', 'planning-state-file'],
    ['find .planning -type f | xargs rm -f', 'planning-subtree'],
    ['echo .planning | xargs rm -rf', 'planning-dir'],
  ];
  for (const [command, code] of DENIED) {
    test(`denies: ${command.replace(/\n/g, '\\n')}`, () => assertDenied(command, proj, code));
  }

  test('denies an absolute path to .planning, in this tree and in another', () => {
    assertDenied(`rm -rf ${path.join(proj, '.planning')}`, proj, 'planning-dir');
    assertDenied(`rm -rf "${path.join(root, 'wt', '.planning')}"`, proj, 'planning-dir');
  });

  test('denies removing the project, an ancestor of it, or a checkout holding a .planning', () => {
    assertDenied(`rm -rf "${proj}"`, proj, 'planning-ancestor');
    assertDenied('rm -rf ../proj', proj, 'planning-ancestor');
    assertDenied(`rm -rf ${root}`, proj, 'planning-ancestor');
    assertDenied('rm -rf ../wt', proj, 'planning-ancestor');
    assertDenied('rmdir ../proj', proj, 'planning-ancestor');
    assertDenied('mv ../wt /tmp/gone', proj, 'planning-ancestor');
  });
});

describe('gsd-planning-delete-guard: the effective cwd', () => {
  let root;
  let proj;
  before(() => {
    root = createTempDir('gsd-pdg-');
    proj = makeTree(root);
  });
  after(() => cleanup(root));

  test('resolves a relative target after cd X && / cd X; / pushd X', () => {
    assertDenied('cd .planning && rm -rf phases', proj, 'planning-subtree');
    assertDenied('cd .planning; rm config.json', proj, 'planning-state-file');
    assertDenied('pushd .planning >/dev/null && rm -f STATE.md', proj, 'planning-state-file');
    assertDenied('cd src && rm -rf ../.planning', proj, 'planning-dir');
    assertDenied('cd .. && rm -rf proj', proj, 'planning-ancestor');
    assertDenied(`cd ${root} && rm -rf wt`, proj, 'planning-ancestor');
  });

  test('a session that starts inside .planning resolves from there', () => {
    assertDenied('rm -rf phases', path.join(proj, '.planning'), 'planning-subtree');
    assertDenied('rm config.json', path.join(proj, '.planning'), 'planning-state-file');
    assertDenied('rm -rf ..', path.join(proj, '.planning'), 'planning-ancestor');
  });

  test('a subshell cd does not leak past its closing paren', () => {
    assertDenied('(cd .planning && rm -rf phases)', proj, 'planning-subtree');
    assertAllowed('(cd .planning && ls); rm -rf phases', proj);
  });

  test('cd to a run-time value makes the cwd unknown: only a named .planning is judged', () => {
    assertDenied('cd "$WT" && rm -rf .planning', proj, 'planning-dir');
    assertAllowed('cd "$WT" && rm -rf phases', proj);
  });

  test('git -C changes the cwd for that git command only', () => {
    assertDenied('git -C .. clean -fdx', path.join(proj, 'src'), 'planning-ancestor');
    assertAllowed('git -C src clean -fdx', proj);
  });
});

describe('gsd-planning-delete-guard: allowed forms', () => {
  let root;
  let proj;
  before(() => {
    root = createTempDir('gsd-pdg-');
    proj = makeTree(root);
  });
  after(() => cleanup(root));

  const ALLOWED = [
    // names that only look like .planning
    'rm -rf .planning-old',
    'rm -rf .planning-*',
    'rm -f docs/.planning.md',
    'rm -rf .planning-old/.planningx',
    // a quoted glob is a literal name, and `*` never selects a dotfile
    "rm -rf '.plan*'",
    'rm -rf *',
    'rm -rf src docs',
    'rm -rf ../other',
    'rm -rf "$TMPDIR/gsd-x"',
    'rm -rf /tmp/foo',
    // what GSD's own workflows do under .planning (execute-plan, new-milestone,
    // discuss-phase, debugger, check-todos, cleanup, reset-phase-safety,
    // complete-milestone, planning-config)
    'rm -f .planning/current-agent-id.txt',
    'rm -rf .planning/current-agent-id.txt',
    'rm -f .planning/.gsd-outgoing-milestone 2>/dev/null || true',
    'rm -f "${phase_dir}/${padded_phase}-DISCUSS-CHECKPOINT.json"',
    'rm -f .planning/phases/01-a/01-DISCUSS-CHECKPOINT.json',
    'mv .planning/debug/x.md .planning/debug/resolved/',
    'mv ".planning/todos/pending/a.md" ".planning/todos/completed/"',
    'mv .planning/phases/01-a .planning/milestones/v1.0-phases/',
    'find .planning/phases -mindepth 1 -maxdepth 1 -type d -exec mv {} "${phase_archive_path}/" \\;',
    'mv "$TODO_FILE" "$COMPLETED_DIR/"',
    'mv /tmp/x .planning/STATE.md',
    'git rm .planning/REQUIREMENTS.md',
    'git rm -r --cached .planning/',
    // dry runs, exclusions, narrow finds, reads
    'git clean -nfdx',
    'git clean --dry-run -fd',
    'git clean -fdx -e .planning',
    'git clean -fd src',
    'find . -name "*.tmp" -delete',
    'find . -path ./.planning -prune -o -name "*.log" -delete',
    'find .planning -name "*.md"',
    'ls .planning && cat .planning/STATE.md',
    'rmdir .planning/phases/01-a',
    // text that merely mentions the command
    'echo "rm -rf .planning"',
    'git commit -m "rm -rf .planning"',
    'cat <<EOF\nrm -rf .planning\nEOF',
  ];
  for (const command of ALLOWED) {
    test(`allows: ${command.replace(/\n/g, '\\n')}`, () => assertAllowed(command, proj));
  }

  test('other tools and empty commands are none of its business', () => {
    for (const payload of [
      { tool_name: 'Read', tool_input: { file_path: '.planning/STATE.md' } },
      { tool_name: 'Write', tool_input: { file_path: '.planning/STATE.md', content: '' } },
      { tool_name: 'Bash', tool_input: { command: '' } },
      { tool_name: 'Bash', tool_input: {} },
      { tool_name: 'Bash' },
    ]) {
      assert.equal(guard.evaluateCommand({ ...payload, cwd: proj }).action, 'allow', JSON.stringify(payload));
    }
  });

  test('an unparseable payload fails open', () => {
    const r = runHook(HOOK_PATH, [], { input: '{not json', timeoutMs: QUICK_SPAWN_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, 0);
  });
});

describe('gsd-planning-delete-guard: workflow.planning_delete_guard', () => {
  let root;
  after(() => {
    if (root) cleanup(root);
  });

  const withConfig = (config) => {
    if (root) cleanup(root);
    root = createTempDir('gsd-pdg-');
    const proj = makeTree(root);
    if (config === null) fs.rmSync(path.join(proj, '.planning', 'config.json'));
    else if (typeof config === 'string') fs.writeFileSync(path.join(proj, '.planning', 'config.json'), config);
    else fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify(config));
    return proj;
  };

  test('false turns the guard off for the project', () => {
    assertAllowed('rm -rf .planning', withConfig({ workflow: { planning_delete_guard: false } }));
  });

  test('absent, true, a non-boolean, no config.json and a malformed one all leave it on', () => {
    for (const config of [{}, { workflow: {} }, { workflow: { planning_delete_guard: true } },
      { workflow: { planning_delete_guard: 'false' } }, null, '{broken']) {
      assertDenied('rm -rf .planning', withConfig(config), 'planning-dir');
    }
  });

  test('outside any GSD project a named .planning is still denied', () => {
    if (root) cleanup(root);
    root = createTempDir('gsd-pdg-');
    assertDenied('rm -rf some/where/.planning', root, 'planning-dir');
    assertAllowed('rm -rf some/where', root);
  });
});

describe('gsd-planning-delete-guard: budgets', () => {
  let root;
  let proj;
  before(() => {
    root = createTempDir('gsd-pdg-');
    proj = makeTree(root);
  });
  after(() => cleanup(root));

  const MAX = 1024 * 1024;
  const decide = (command) => guard.evaluateCommand({ tool_name: 'Bash', tool_input: { command }, cwd: proj });
  const padded = (length) => {
    const head = 'rm -rf .planning';
    return head + ' '.repeat(length - head.length);
  };

  test('a command at the length limit is scanned; one character over is not (fail open)', () => {
    assert.equal(padded(MAX - 1).length, MAX - 1);
    assert.equal(decide(padded(MAX - 1)).action, 'deny', 'limit-1');
    assert.equal(decide(padded(MAX)).action, 'deny', 'limit');
    assert.equal(decide(padded(MAX + 1)).action, 'allow', 'limit+1');
  });

  // Each `bash -c` level is one nesting step; the scanner recurses while
  // depth < 3, so a deletion three shells deep is seen and four deep is not
  // (a stated limit of the shared scanner).
  const nestShells = (levels) => {
    let command = 'rm -rf .planning';
    for (let i = 0; i < levels; i++) command = `bash -c ${JSON.stringify(command)}`;
    return command;
  };

  test('nested shells are scanned to depth 3 and not beyond', () => {
    assert.equal(decide(nestShells(2)).action, 'deny', 'limit-1');
    assert.equal(decide(nestShells(3)).action, 'deny', 'limit');
    assert.equal(decide(nestShells(4)).action, 'allow', 'limit+1');
  });
});
