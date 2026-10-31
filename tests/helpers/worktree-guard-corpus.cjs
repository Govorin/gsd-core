'use strict';

/**
 * The worktree-guard corpus (ADR-5211) — the commands and branches the guards
 * were driven against while they were bash, kept as DATA. Until wave 4 it also
 * drove a differential run against frozen bash snapshots; each row's verdict is
 * the one that run settled.
 *
 * AUTOMATED_* rows came verbatim from tests/executor-mvp-tdd-section.test.cjs's
 * #4767 suite (every round of that guard's adversarial review is in them).
 * A row's command is a string or a function of the fixture's real paths
 * `{ main, wt }`; the array a row sits in is its verdict: halt or pass.
 */

const fs = require('node:fs');
const path = require('node:path');
const { createTempDir } = require('../helpers.cjs');
const { gitOrThrow } = require('./git-fixture.cjs');

const GIT_IDENTITY_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'x',
  GIT_AUTHOR_EMAIL: 'x@x',
  GIT_COMMITTER_NAME: 'x',
  GIT_COMMITTER_EMAIL: 'x@x',
};

/**
 * The #4767 fixture: a main checkout, a linked worktree beside it, and the
 * symlinks the corpus walks through (in-worktree links that land in main,
 * names carrying quotes and `=`). Returns real paths; the caller cleans `tmp`.
 */
function buildAutomatedFixture(prefix = 'gsd-wt-guard-0c-') {
  const tmp = createTempDir(prefix);
  const main = path.join(tmp, 'main');
  const wt = path.join(tmp, 'wt');
  const env = { ...process.env, ...GIT_IDENTITY_ENV };
  gitOrThrow(['init', '-q', main], { cwd: tmp, env });
  gitOrThrow(['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: main, env });
  gitOrThrow(['worktree', 'add', '-q', wt, '-b', 'wt'], { cwd: main, env });
  fs.mkdirSync(path.join(wt, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(wt, 'scripts dir'), { recursive: true });
  fs.mkdirSync(path.join(main, 'scripts'), { recursive: true });
  fs.symlinkSync(main, path.join(wt, 'main-link'));
  fs.symlinkSync(main, path.join(wt, 'scripts copy'));
  fs.symlinkSync(main, path.join(wt, "O'Reilly"));
  fs.symlinkSync(main, path.join(wt, 'a"b'));
  fs.symlinkSync(main, path.join(wt, 'release=main'));
  fs.symlinkSync(path.join(main, '.git', 'HEAD'), path.join(wt, 'main-head'));
  fs.writeFileSync(path.join(wt, 'README.md'), 'x\n');
  fs.writeFileSync(path.join(main, 'secret.txt'), 'SECRET\n');
  return { tmp, main: fs.realpathSync(main), wt: fs.realpathSync(wt) };
}

/** Rows the bash step 0c guard HALTED on. */
const AUTOMATED_HALT_ROWS = [
    ['a cd into the main checkout (the #4767 shape)', (c) => `cd ${c.main}/scripts/verify && python3 -m pytest -q`],

    ['npm --prefix <outside>', 'npm --prefix /srv/other run lint'],
    ['npm --prefix=<outside>', 'npm --prefix=/srv/other run lint'],
    ['npm run … --prefix <outside>', 'npm run lint --prefix /srv/other'],
    ['a subshell-wrapped cd', '(cd /srv/other && make)'],
    ['a path carrying ERE metacharacters', 'cd /srv/c++/a(b)/[1] && make'],
    ['a backslash-escaped space', 'cd /srv/other/path\\ with\\ space && ls'],
    ['cd followed by `;`', 'cd /srv/other; B=x; test -f "$B"'],
    ['builtin cd', 'builtin cd /srv/other && ls'],
    ['command cd', 'command cd /srv/other && ls'],
    ['pushd', 'pushd /srv/other && ls'],
    ['cd --', 'cd -- /srv/other && ls'],
    ['an env-prefixed cd', 'FOO=1 cd /srv/other && ls'],
    ['a target containing `=`', 'cd /srv/other/a=/x && ls'],
    ['a relative hop out of the worktree', 'cd ../main && ls'],
    ['a symlink inside the worktree that resolves to main', (c) => `cd ${c.wt}/main-link && ls`],
    ['an in-worktree `..` path that resolves to main', (c) => `cd ${c.wt}/../main && ls`],
    ['a bare absolute file argument under main', (c) => `python3 -m pytest ${c.main}/scripts -q`],
    ['a double-quoted target with a space that resolves to main', (c) => `cd "${c.wt}/scripts copy" && ls`],
    ['a single-quoted outside target with a space', "cd '/srv/other/my dir' && ls"],
    ['a file read through an in-worktree symlink into main', (c) => `cat ${c.wt}/main-link/.git/HEAD`],
    ['a relative cd through the symlink', 'cd main-link && ls'],
    ['a quoted prefix with an unquoted suffix', (c) => `cd "${c.wt}"/main-link && ls`],
    ['an escaped single quote in the path', (c) => `cd ${c.wt}/O\\'Reilly && ls`],
    ['an escaped double quote in the path', (c) => `cd ${c.wt}/a\\"b && ls`],
    ['a symlinked FILE whose target is in main', (c) => `cat ${c.wt}/main-head`],
    ['a chained cd whose second hop leaves the worktree', 'cd scripts && cd ../.. && ls'],
    ['a chained cd that reaches main relatively', 'cd scripts && cd ../../main && ls'],
    ['an interpreter after a backgrounded cd starts from the parent cwd', "cd scripts & bash -c 'cd ..'"],
    ['an interpreter after a piped cd starts from the parent cwd', "cd scripts | bash -c 'cd ..'"],
    ['an unrecognized command after a backgrounded cd does not consume the cwd reset', "cd scripts & echo x && bash -c 'cd ..'"],
    ['an unrecognized command after a piped cd does not consume the cwd reset', "cd scripts | cat && bash -c 'cd ..'"],
    ['an earlier interpreter payload is not contaminated by a later outer cd', "cd scripts && bash -c 'cd ../.. && test -d main' && cd deeper"],
    ['a subprocess interpreter cannot relocate its parent shell', "bash -c 'cd scripts' && cd .."],
    ['a launcher cannot turn eval into a cwd-persistent shell builtin', "env eval 'cd scripts'; cd .."],
    ['env -C outside is not hidden by its wrapped interpreter', "env -C ../main bash -c 'echo ok'"],
    ['env --chdir= outside is not hidden by its wrapped interpreter', "env --chdir=../main sh -c 'echo ok'"],
    ['a timeout wrapper cannot hide env -C outside', "timeout 5 env -C ../main bash -c 'echo ok'"],
    ['a later env -C cannot hide an earlier outside launcher relocation', "env -C ../main env -C ../wt bash -c 'echo ok'"],
    ['a quoted env -C launcher target still exposes its payload', "env -C 'scripts dir' bash -c 'cd ../..'"],
    ['a quoted env --chdir launcher target still exposes its payload', "env --chdir 'scripts dir' sh -c 'cd ../..'"],
    ['an equals-form quoted env --chdir target still exposes its payload', "env --chdir='scripts dir' sh -c 'cd ../..'"],
    ['npm --prefix ../.. after a cd (resolved from the reached cwd)', 'cd scripts && npm --prefix ../.. test'],
    ['a double-quoted name containing an apostrophe', `cd "O'Reilly" && ls`],
    ['a path containing a literal =', (c) => `cd ${c.wt}/release=main && ls`],
    ['an env assignment whose value is a main-checkout path', (c) => `FOO=${c.main}/x env | cat`],
    // #4767 round 2 — command-string interpreters. `eval`/`sh -c`/`bash -c` bury the relocating verb
    // inside ONE opaque quoted token, which defeats BOTH scans at once: the verb never sits at a
    // boundary the relocating-verb scan recognizes, and the catch-all tokenizer swallows the whole
    // quoted span, which after unquoting does not begin with `/`. Every row below exits 0 against the
    // round-1 guard (verified as a negative control) and halts against this one.
    ['eval wrapping a cd into main', (c) => `eval "cd ${c.main} && ls"`],
    ['eval wrapping a RELATIVE cd out of the worktree', "eval 'cd ../main && ls'"],
    ['sh -c wrapping a cd into main', (c) => `sh -c "cd ${c.main} && ls"`],
    ['bash -c wrapping a cd into main', (c) => `bash -c 'cd ${c.main} && ls'`],
    ['eval wrapping an absolute FILE argument under main', (c) => `eval "cat ${c.main}/secret.txt"`],
    ['sh -c wrapping an absolute FILE argument under main', (c) => `sh -c "cat ${c.main}/secret.txt"`],
    ['zsh -c wrapping a cd into main', (c) => `zsh -c "cd ${c.main} && ls"`],
    ['a clustered short flag (sh -ec)', (c) => `sh -ec "cd ${c.main} && ls"`],
    ['python3 -c relocating via os.chdir', (c) => `python3 -c "import os;os.chdir('${c.main}')"`],
    ['node -e relocating via process.chdir', (c) => `node -e "process.chdir('${c.main}')"`],
    // The rest of `_EXEC`'s set, pinned because worktree-path-safety.md now STATES the ten it
    // recognizes and a stated coverage claim with no row is prose. The guard never executes the
    // command — it scans text — so none of these needs its interpreter installed.
    ['perl -e relocating via chdir', (c) => `perl -e 'chdir "${c.main}"'`],
    ['ksh -c wrapping a cd into main', (c) => `ksh -c "cd ${c.main} && ls"`],
    ['a digit-less python -c relocating via os.chdir', (c) => `python -c "import os;os.chdir('${c.main}')"`],
    ['a wrapper nested inside a wrapper', (c) => `eval "sh -c 'cd ${c.main} && ls'"`],
    ['an interpreter reached after &&', (c) => `echo hi && eval "cd ${c.main} && ls"`],
    // …and the launcher forms a planner actually writes in front of one. `timeout` in particular is
    // ordinary in a verify command, and a wrapper is no less a wrapper for having a launcher ahead of it.
    ['a launcher (timeout) ahead of the interpreter', (c) => `timeout 60 bash -c "cd ${c.main} && ls"`],
    ['env ahead of the interpreter', (c) => `env bash -c "cd ${c.main} && ls"`],
    ['nohup ahead of the interpreter', (c) => `nohup sh -c "cd ${c.main} && ls"`],
    // …and the forms the round-2 adversarial pass found still open: an interpreter named by absolute
    // path or carrying its own options, a recognised tool behind a launcher, and a shell CONTROL
    // keyword as the command boundary.
    ['an interpreter named by absolute path', (c) => `/bin/bash -c 'cd ${c.main} && ls'`],
    ['an interpreter carrying its own long option', (c) => `bash --noprofile -c 'cd ${c.main} && ls'`],
    ['a recognised tool behind a launcher', 'env npm --prefix ../main test'],
    // …a launcher named by absolute path, or carrying an option with a SEPARATE operand.
    ['a launcher named by absolute path', (c) => `/usr/bin/env bash -c "cd ${c.main} && ls"`],
    ['a launcher option with a separate operand', (c) => `env -u FOO bash -c "cd ${c.main} && ls"`],
    ['a long launcher option with an operand', (c) => `timeout --signal TERM 60 bash -c "cd ${c.main} && ls"`],
    ['stdbuf with an operand', (c) => `stdbuf -o L sh -c "cd ${c.main} && ls"`],
    // `env` is not only a launcher: --chdir / -C make it a relocating verb in its own right.
    ['env --chdir, which relocates env itself', 'env --chdir=../main npm test'],
    ['env -C, the same flag spelled short', 'env -C ../main npm test'],
    ['env -C reached through a launcher', 'timeout 60 env -C ../main npm test'],
    // A separate-operand option before the directory flag must not hide it: `-u FOO` consumed `FOO`
    // generically and left `-C ../main` unseen. The env option grammar is scoped per consumer.
    ['env -u before -C, which used to hide the flag', 'env -u FOO -C ../main npm test'],
    ['the same, behind a launcher', 'timeout 60 env -u FOO -C ../main npm test'],
    ['the long spellings of both', 'env --unset FOO --chdir=../main npm test'],
    // `env -C <dir>` relocates AND launches: its payload must still be unwrapped.
    ['a payload behind a relocating launcher', "env -C scripts bash -c 'cd ../../main && ls'"],
    // Operand-taking options INTERLEAVED with ordinary ones. A grammar that allows only one contiguous
    // run of them lets a generic option in the middle hide everything after it — including the `-C`.
    ['interleaved env options hiding a -C', 'env -u FOO --debug -u BAR -C ../main npm test'],
    ['interleaved env options before an interpreter', "env -u FOO --debug -u BAR bash -c 'cd ../main && ls'"],
    ['interleaved timeout options', (c) => `timeout -k 5 --signal TERM 60 bash -c "cd ${c.main} && ls"`],
    ['interleaved stdbuf options', (c) => `stdbuf -o L -e L sh -c "cd ${c.main} && ls"`],
    // #4767 round 2 — a tool's own directory flag with a RELATIVE argument. The absolute form was
    // already caught by the catch-all absolute-word scan; the relative form was invisible to both.
    ['make -C relative, out of the worktree', 'make -C ../main/scripts test'],
    ['git -C relative, out of the worktree', 'git -C ../main status'],
    ['yarn --cwd relative, out of the worktree', 'yarn --cwd ../main test'],
    ['pnpm -C relative, out of the worktree', 'pnpm -C ../main test'],
    ['npx --prefix relative, out of the worktree', 'npx --prefix ../main tsc'],
    // #4767 round 2 — a single `&` is a command boundary too; only `&&` was recognized.
    ['a relative cd after a background operator', 'ls & cd ../main && ls'],
    // The interpreter-list controls of the #4785 test: an absolute-path shell is
  // unwrapped, and the option is a short-option CLUSTER, not a literal -c.
  ['an absolute-path shell', (c) => `/bin/bash -c "cd ${c.main} && ls"`],
  ['an option cluster on python', (c) => `python -abc "cd ${c.main} && ls"`],
  ...['sh', 'bash', 'zsh', 'dash', 'ksh', 'python3', 'python', 'node', 'perl', 'ruby'].map((n) => (
    [`the recognised interpreter ${n} -c`, (c) => `${n} -c "cd ${c.main} && ls"`]
  )),
  ['the recognised interpreter eval', (c) => `eval "cd ${c.main} && ls"`],
];

/** Rows the bash step 0c guard PASSED, silently. */
const AUTOMATED_PASS_ROWS = [

    ['a relative cd', 'cd scripts && ls 2>/dev/null'],
    ['a relative cd into a directory that does not exist yet (Wave-0 scaffold)', 'cd future-scaffold && npm test'],
    ['a relative cd into a nested not-yet-existing directory', 'cd scripts/new/deep && ls'],
    ['a relative hop that lands back inside the worktree', 'cd ../wt/scripts && ls'],
    ['absolute arguments under /tmp and $HOME that are not under main', 'ls /tmp /home 2>/dev/null; cd scripts'],
    ['a trailing slash and a ./ prefix', 'cd scripts/ && cd ./scripts && ls'],
    ['a cd onto an existing FILE inside the worktree', 'cd README.md'],
    ['a glob in an absolute argument (no expansion during normalization)', 'ls /missing/*/deep; cd scripts'],
    ['a quoted apostrophe in an ordinary argument', `grep -q 'x' README.md && echo "it's fine"`],
    ['a chained cd that returns to the worktree root', 'cd scripts && cd .. && ls'],
    ['a chained cd through not-yet-existing directories', 'cd future && cd deeper && ls'],
    ['a chained cd followed by npm --prefix .', 'cd scripts && npm --prefix . test'],
    ['a dynamic target the shell would expand (the probe owns these as dynamic_path)', 'cd "$(git rev-parse --show-toplevel)/scripts" && ls'],
    ['an ordinary argument containing =', 'echo a=b=c && cd scripts'],
    ['npm --prefix . and make -C inside the worktree', 'npm --prefix . run test && make -C scripts'],
    ['npm --prefix .. after a cd (npm does not move the cwd)', 'cd scripts && npm --prefix .. test && cd .. && ls'],
    ['an absolute cd inside the worktree', (c) => `cd ${c.wt}/scripts && ls`],
    ['--prefix= inside the worktree', (c) => `npm run lint --prefix=${c.wt}/scripts`],
    ['a system path that is not a relocating target', 'cat /etc/hosts | grep -c x'],
    ['an absolute file argument outside both checkouts', 'ls /srv/other/plain && cd scripts'],
    ['a redirect to /dev/null', 'test -f /usr/bin/env && echo ok'],
    // #4767 round 2 — the interpreter class is UNWRAPPED and re-scanned, not rejected wholesale, so an
    // ordinary portability wrapper whose payload stays inside the worktree must remain silent.
    ['bash -c wrapping an in-worktree command', "bash -c 'npm test'"],
    ['sh -c wrapping a relative cd that stays inside', "sh -c 'cd scripts && ls'"],
    ['an eval payload whose cd relocates the current shell', "eval 'cd scripts' && cd .."],
    ['nested in-worktree env -C launchers resolve sequentially', "env -C scripts env -C .. bash -c 'echo ok'"],
    ['a quoted in-worktree env -C target with a safe payload', "env -C 'scripts dir' bash -c 'cd ..'"],
    ['make -C inside the worktree', 'make -C scripts test'],
    ['git -C inside the worktree', 'git -C scripts status'],
    ['an interpreter payload the shell would build at run time (dynamic_path)', 'eval "cd $TARGET && ls"'],
    ['node -e naming no path at all', "node -e 'console.log(1)'"],
    ['a launcher ahead of an interpreter whose payload stays inside', "timeout 60 bash -c 'npm test'"],
    // Two false positives the round-2 adversarial pass found and this round fixed. `--prefix` on `git`
    // names archive MEMBERS, not a directory, so the flag set is tool-scoped; and interpreter text that
    // is merely an ARGUMENT executes nothing, so the launcher set is named rather than a catch-all run.
    ['git archive --prefix, which is not a directory flag', 'git archive --prefix=../main/ HEAD'],
    ['interpreter text passed as an argument, not executed', "echo bash -c 'cd ../main && ls'"],
    // Two more false positives the round-2 pass found. Control keywords are NOT in `_OPEN` precisely
    // because these operators match raw text with no quote-awareness, and `command -v` is a name probe
    // that executes nothing. Both rows fail if either widening is re-introduced.
    ['a control keyword inside a quoted grep argument', "grep -F 'if cd ../main; then' README.md"],
    ['command -v, a name probe that executes nothing', "command -v bash -c 'cd ../main && ls'"],
    // A launcher option that takes NO operand must not swallow the command after it: `env -i echo …`
    // runs echo, not the interpreter text it prints. Which options take an operand is tool-scoped.
    ['an operandless launcher option before a harmless command', "env -i echo bash -c 'cd ../main && ls'"],
    ['a launcher -- separator before a harmless command', "nohup -- echo bash -c 'cd ../main && ls'"],
    ['a directory-flag spelling that is pass-through data', 'env printf -C ../main'],
    // The #4785 controls: `eval` has no absolute-path form; awk and php are not interpreters it unwraps.
  ['eval named by absolute path', (c) => `/bin/eval "cd ${c.main} && ls"`],
  ['an unrecognised interpreter (awk)', (c) => `awk -c "cd ${c.main} && ls"`],
  ['an unrecognised interpreter (php)', (c) => `php -c "cd ${c.main} && ls"`],
];

/** Materialise a row's command against a built fixture. */
function commandOf(row, fixture) {
  const cmd = row[1];
  return typeof cmd === 'function' ? cmd(fixture) : cmd;
}

/**
 * Branch-check / pre-commit branch corpus: names on both sides of the
 * protected list and of the agent namespace, at the regex edges.
 */
const BRANCH_ROWS = [
  'main', 'master', 'develop', 'trunk', 'release/1.0', 'releases/x', 'mainline',
  'agent-', 'agent-x', 'agent-a1/b.c_d-e', 'xagent-1', 'worktree-agent-7', 'worktree-agent-',
  'worktree-wf_', 'worktree-wf_abc', 'worktree-wf_run-1', 'feature/phase-48', 'phase/2-1', 'agent-x+y',
];

module.exports = {
  GIT_IDENTITY_ENV,
  buildAutomatedFixture,
  AUTOMATED_HALT_ROWS,
  AUTOMATED_PASS_ROWS,
  BRANCH_ROWS,
  commandOf,
};
