#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Planning Delete Guard — PreToolUse hook (Bash), mn fork
//
// Problem: `.planning/` is the project's whole GSD state, and part of it is
// routinely uncommitted (config.json, state files, a phase in progress). A
// recorded run lost exactly that: a gsd-code-fixer's `ls` failed, the `cd`
// chain it was in broke, and the `rm -rf .planning` meant for a worktree ran in
// the main checkout. Prose ("never rm -rf by relative path") cannot stop an
// improvised command; a PreToolUse denial can, and Claude Code runs plugin
// hooks for a subagent's tool calls too.
//
// What is denied (each with a reason that says what to do instead):
//   • removing or moving the `.planning` directory itself, by any spelling the
//     scan resolves: `.planning`, `./.planning/`, an absolute path, a path in
//     another tree (`/x/wt/.planning`, `"$WT/.planning"`), a glob or brace that
//     selects it (`.plan*`, `.*`, `{a,.planning}`) — code planning-dir;
//   • a recursive removal (rm -r, git clean, find -delete) of a directory that
//     contains a `.planning/` — the root or an ancestor of the project found
//     from the session cwd or from a `cd` in the command, or any existing
//     directory with a direct `.planning` child (another checkout:
//     `rm -rf ../main` from a worktree, `git -C /x/main clean -fdx`) — code
//     planning-ancestor. `git clean` whose directory cannot be resolved at all
//     (`git -C "$X" clean`) is denied too unless `-e .planning` spares it;
//   • a recursive removal of a directory inside `.planning/`
//     (`rm -rf .planning/phases`) — or of a path there that does not exist under
//     one of the possible cwds (fail closed: it may exist under another) —
//     except the two GSD regenerates:
//     `.planning/codebase` (map-codebase "Refresh" deletes it) and
//     `.planning/tmp` — code planning-subtree;
//   • removing a core state file (config.json, STATE.md, ROADMAP.md,
//     PROJECT.md, MILESTONES.md) — code planning-state-file. REQUIREMENTS.md is
//     not one: complete-milestone deletes it for the next milestone;
//   • moving a directory or a core state file from inside `.planning/` to a
//     place outside it — code planning-move-out.
// Commands judged: rm, unlink, shred, rmdir (the directory itself or an
// ancestor only — rmdir removes nothing but empty directories), mv (its
// sources), find with -delete or -exec/-execdir/-ok rm|unlink|rmdir|shred,
// `git clean` (not with -n/--dry-run; a `-e .planning` exclude spares an
// ancestor pathspec), `git rm -f` (plain `git rm` refuses to drop uncommitted
// changes, and `--cached` keeps the files), and `… | xargs rm`.
//
// What stays allowed, because GSD's own workflows do it: removing a single
// non-state file under `.planning/` (`rm -f .planning/current-agent-id.txt`,
// a checkpoint, a scratch file), moving files and directories within
// `.planning/` (`mv .planning/debug/x.md .planning/debug/resolved/`, the phase
// archive in /gsd:cleanup), moving a file into `.planning/`, removing
// `.planning/codebase` or `.planning/tmp`, removing REQUIREMENTS.md
// (complete-milestone), and `rm -rf "$WORKSPACE_PATH"` (/gsd:remove-workspace:
// a path known only at run time is never probed for a `.planning` child, so a
// workspace removal passes; the same path written literally is denied).
// Names that only look similar are not `.planning`: `.planning-old`,
// `docs/.planning.md`.
//
// How a target is resolved: the command is read by the secret read guard's
// scanner (`tokenize` + `resolveCommand`, exported by gsd-secret-read-guard.js
// for this purpose — one shell reader, not two), so quoting, `$( )` /
// backticks (scanned as nested commands), wrappers (`sudo`, `env`, `command`,
// `timeout`, `/bin/rm`), `bash -c '…'`, `eval` and heredocs fed to a shell are
// all seen. Relative targets are resolved against every POSSIBLE cwd: the
// payload's cwd, moved by `cd X` / `pushd X` in earlier segments. A cd can fail,
// so only the segments joined to it by `&&` are sure to run in X; past a `;`,
// a newline, `||` or `|` the old cwd is possible again, and the target is
// judged under each (`cd /missing; git clean -fdx` is judged in the project).
// A `( … )` subshell restores the set at its end; `git -C X` changes it for
// one git command, and a `:/` pathspec means the repository root. A glob in the last path segment is expanded
// against the directory, as bash would without dotglob (`*` never selects
// `.planning`; `.*` and `.plan*` do).
//
// Lexical-guard limits — stated, not hidden; an OS-level permission or sandbox
// is the place for a hard guarantee:
//   • a target whose value is computed at run time is judged by its literal
//     text only: `rm -rf "$DIR"` with DIR=.planning, `rm -rf "$(cat f)"`, and a
//     relative target after `cd "$X"` (the cwd becomes unknown) pass unless the
//     text itself names `.planning` (`"$WT/.planning"` is still denied);
//   • whether a `cd` succeeds is not known, so both outcomes are judged where
//     both can run (see above); `cd X || exit` is read as possibly continuing;
//   • an ancestor is recognised for the projects named above and for a
//     directory with a direct `.planning` child, not for a tree that holds a
//     project several levels down (`rm -rf ~/work`), and a run-time path
//     (`rm -rf "$DIR"`) is never probed;
//   • nesting is followed three levels deep (`bash -c` inside `bash -c` …,
//     the shared scanner's MAX_NESTING_DEPTH); a fourth level is not read,
//     and a command over 1 MiB is allowed unscanned (the secret read guard
//     already denies those on the same Bash call);
//   • other ways to destroy files are out of scope: interpreters
//     (`node -e "fs.rmSync('.planning', …)"`, `python -c`), scripts the agent
//     runs, `rsync --delete`, `truncate`, an output redirect onto a state file
//     (`> .planning/config.json`), `git checkout`/`git reset --hard`/
//     `git stash -u` (the stash keeps the files), aliases and shell functions
//     that shadow a command name, and a glob in a directory segment
//     (`rm -rf */phases`) unless it names `.planning` literally.
//
// Config: `workflow.planning_delete_guard` (boolean, absent = on) in the
// session project's `.planning/config.json`; false turns the guard off.
//
// Triggers on: Bash tool calls (Claude Code)
// Action: BLOCK (permissionDecision deny, exit 2) — codes planning-dir |
//         planning-ancestor | planning-subtree | planning-state-file |
//         planning-move-out
// No-op: other tools, guard off, commands that touch nothing above, hook errors
//        (fail open — a parser bug in a hook that runs on every Bash call must
//        never brick a session).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { lastSegment } = require('./lib/filename-classification.js');

const ON_CRASH = HOOK_ON_CRASH.ALLOW;

// The shared shell scanner. A sibling that fails to load (missing, or broken
// by a bad install) must not wedge every Bash call: the guard then falls open
// under its declared crash policy, like any other internal error.
let scanner = null;
try {
  scanner = require('./gsd-secret-read-guard.js');
} catch {
  scanner = null;
}
const tokenize = (...a) => scanner.tokenize(...a);
const resolveCommand = (...a) => scanner.resolveCommand(...a);
const expandBraces = (...a) => scanner.expandBraces(...a);
const globAltToRegex = (...a) => scanner.globAltToRegex(...a);
const MAX_NESTING_DEPTH = scanner ? scanner.MAX_NESTING_DEPTH : 0;

// Commands longer than this are allowed unscanned (fail open, like a crash).
const MAX_COMMAND_LENGTH = 1024 * 1024;

const PLANNING_DIR_NAME = '.planning';

// Core state files: losing one loses the project's position, not a scratch
// artifact. Compared case-insensitively (macOS and Windows filesystems).
const STATE_FILES = new Set([
  'config.json', 'state.md', 'roadmap.md', 'project.md', 'milestones.md',
]);

// Directories directly under `.planning/` that GSD regenerates and its own
// workflows delete whole: map-codebase "Refresh" deletes `.planning/codebase/`;
// `.planning/tmp/` holds scratch output (docs-update's verify-*.json).
const REGENERATED_DIRS = new Set(['codebase', 'tmp']);

// Single-target removers: each removes the named file (shred only with -u,
// treated as removing either way — overwriting a state file loses it too).
const FILE_REMOVERS = new Set(['rm', 'unlink', 'shred']);
// Command names that delete when find -exec / xargs runs them.
const EXEC_REMOVERS = new Set(['rm', 'unlink', 'rmdir', 'shred']);
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const DASH_C_RE = /^-[A-Za-z]*c$/;

// find tests whose pattern restricts which files a deletion reaches.
const FIND_NAME_TESTS = new Set([
  '-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex', '-iregex',
]);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
// find options that precede the start paths; -D and -O take a value.
const FIND_LEADING_FLAGS = new Set(['-H', '-L', '-P']);

// git global options that take a separate value word.
const GIT_VALUE_GLOBALS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source',
  '--shallow-file',
]);

// xargs options that take a value: as the next word, or attached (`-n1`).
const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-L', '-P', '-s', '-d', '-E', '-a']);

// mv options that take a separate value word.
const MV_VALUE_FLAGS = new Set(['-t', '--target-directory', '-S', '--suffix']);

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function isPlanningSegment(seg) {
  return seg.toLowerCase() === PLANNING_DIR_NAME;
}

function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function compareKey(p) {
  const s = path.resolve(p);
  return CASE_INSENSITIVE_FS ? s.toLowerCase() : s;
}

/** Is `child` strictly inside `parent` (both absolute)? */
function isStrictlyWithin(child, parent) {
  const rel = path.relative(compareKey(parent), compareKey(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function findPlanningRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(path.join(dir, PLANNING_DIR_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function guardEnabled(planningRoot) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(planningRoot, PLANNING_DIR_NAME, 'config.json'), 'utf8'));
    return !(cfg && cfg.workflow && cfg.workflow.planning_delete_guard === false);
  } catch {
    // Absent = enabled: a missing or unreadable config cannot have opted out.
    return true;
  }
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a path sits relative to `.planning`, from its segments alone:
 *   { kind: 'planning-dir' }                 the directory itself
 *   { kind: 'inside', planningDir, rest }    something under it
 *   null                                     no `.planning` segment
 * `segments` is the path split on `/` (a lexical path) or path.sep.
 */
function planningPosition(segments, join) {
  const i = segments.findIndex(isPlanningSegment);
  if (i === -1) return null;
  if (i === segments.length - 1) return { kind: 'planning-dir', planningDir: join(segments) };
  return { kind: 'inside', planningDir: join(segments.slice(0, i + 1)), rest: segments.slice(i + 1) };
}

/** Is this position inside one of the directories GSD regenerates? */
function isRegenerated(position) {
  return position.kind === 'inside' && REGENERATED_DIRS.has(position.rest[0].toLowerCase());
}

/**
 * A resolved target: `{ abs, display }` when the path is known, or
 * `{ lexical, display }` when only its text is (a run-time value, or a relative
 * path under an unknown cwd).
 */
function classifyTarget(target, ctx, { probeChild = false } = {}) {
  if (target.lexical !== undefined) {
    const segs = path.posix.normalize(target.lexical).split('/').filter((s) => s !== '' && s !== '.');
    const pos = planningPosition(segs, (s) => s.join('/'));
    return pos || { kind: 'unknown' };
  }
  const abs = target.abs;
  const segs = abs.split(path.sep).filter((s) => s !== '');
  const pos = planningPosition(segs, (s) => path.sep + s.join(path.sep));
  if (pos) return pos;
  // A symlinked spelling of a .planning path (`/tmp` → `/private/tmp` is the
  // benign case; a link named `state` → `.planning` is the one that matters).
  const real = canonical(abs);
  if (real !== abs) {
    const realPos = planningPosition(real.split(path.sep).filter((s) => s !== ''), (s) => path.sep + s.join(path.sep));
    if (realPos) return realPos;
  }
  for (const root of ctx.roots) {
    const rootReal = canonical(root);
    if (compareKey(rootReal) === compareKey(real) || isStrictlyWithin(rootReal, real)) {
      return { kind: 'ancestor', root };
    }
  }
  // Another checkout (`rm -rf ../main` from a worktree): only for a removal,
  // and only for a path known before run time.
  if (probeChild && isDirectory(abs) && fs.existsSync(path.join(abs, PLANNING_DIR_NAME))) {
    return { kind: 'ancestor', root: abs };
  }
  return { kind: 'outside', abs };
}

function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function homeDir() {
  return os.homedir();
}

/**
 * Expand one operand word into the paths it names. A glob in the last path
 * segment is matched against that directory's entries as bash would without
 * dotglob; a glob earlier in the path, or a run-time value, leaves only the
 * text to judge.
 */
function expandOperand(word, cwd) {
  const dynamic = word.procsub !== undefined
    || (word.expands && (word.text.includes('$') || !(word.globbed || word.brace || word.group)));
  if (dynamic) return [{ lexical: word.text, display: word.text }];
  const alts = word.brace ? (expandBraces(word.text, true) || [word.text]) : [word.text];
  const out = [];
  for (const alt0 of alts) {
    let alt = alt0;
    if (word.quoted === 'none' && (alt === '~' || alt.startsWith('~/'))) alt = homeDir() + alt.slice(1);
    if (!path.isAbsolute(alt) && cwd === null) {
      out.push({ lexical: alt, display: alt0 });
      continue;
    }
    const abs = path.resolve(cwd || '/', alt);
    if (!(word.globbed && /[*?[]/.test(alt))) {
      out.push({ abs, display: alt0 });
      continue;
    }
    const dir = path.dirname(abs);
    const pattern = path.basename(abs);
    if (/[*?[]/.test(dir)) {
      out.push({ lexical: alt, display: alt0 });
      continue;
    }
    const re = globAltToRegex(pattern);
    let entries = [];
    try {
      entries = fs.readdirSync(dir).sort();
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (name.startsWith('.') && !pattern.startsWith('.')) continue;
      if (re.test(name)) out.push({ abs: path.join(dir, name), display: alt0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-command checks — each returns a hit `{ code, target, command }` or null
// ---------------------------------------------------------------------------

function hit(code, target, command) {
  return { code, target: target.display, command };
}

/** rm / unlink / shred / git rm -f: removal of each operand. */
function checkRemoval(targets, recursive, ctx, command) {
  for (const target of targets) {
    const c = classifyTarget(target, ctx, { probeChild: recursive });
    if (c.kind === 'planning-dir') return hit('planning-dir', target, command);
    if (c.kind === 'ancestor' && recursive) return hit('planning-ancestor', target, command);
    if (c.kind !== 'inside' || isRegenerated(c)) continue;
    const base = c.rest[c.rest.length - 1].toLowerCase();
    if (recursive) {
      // `rm -rf` on a single file is common reflex, so an existing regular file
      // is judged as a file. Anything else fails closed: a directory, a run-time
      // path, and a path absent under this cwd that may exist under another.
      if (target.abs === undefined || !isRegularFile(target.abs)) return hit('planning-subtree', target, command);
    }
    if (STATE_FILES.has(base)) return hit('planning-state-file', target, command);
  }
  return null;
}

function splitOptions(operands) {
  const options = [];
  const rest = [];
  let ended = false;
  for (const w of operands) {
    if (!ended && w.text === '--') {
      ended = true;
      continue;
    }
    if (!ended && w.text.length > 1 && w.text.startsWith('-')) options.push(w.text);
    else rest.push(w);
  }
  return { options, rest };
}

function rmIsRecursive(options) {
  return options.some((o) => o === '--recursive' || (/^-[A-Za-z]+$/.test(o) && /[rR]/.test(o)));
}

function targetsOf(words, cwd) {
  const out = [];
  for (const w of words) out.push(...expandOperand(w, cwd));
  return out;
}

function checkRm(base, operands, ctx) {
  const { options, rest } = splitOptions(operands);
  const recursive = base === 'rm' && rmIsRecursive(options);
  return checkRemoval(targetsOf(rest, ctx.cwd), recursive, ctx, base);
}

function checkRmdir(operands, ctx) {
  const { rest } = splitOptions(operands);
  for (const target of targetsOf(rest, ctx.cwd)) {
    const c = classifyTarget(target, ctx);
    if (c.kind === 'planning-dir') return hit('planning-dir', target, 'rmdir');
    if (c.kind === 'ancestor') return hit('planning-ancestor', target, 'rmdir');
  }
  return null;
}

function checkMv(operands, ctx) {
  const words = [];
  let targetDir = null;
  let ended = false;
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (!ended && t === '--') { ended = true; continue; }
    if (!ended && t.length > 1 && t.startsWith('-')) {
      if (MV_VALUE_FLAGS.has(t)) {
        if (t === '-t' || t === '--target-directory') targetDir = operands[k + 1] || null;
        k++;
      } else if (t.startsWith('--target-directory=')) {
        targetDir = { ...operands[k], text: t.slice('--target-directory='.length) };
      }
      continue;
    }
    words.push(operands[k]);
  }
  const destWord = targetDir || (words.length > 1 ? words[words.length - 1] : null);
  const sourceWords = targetDir ? words : words.slice(0, -1);
  if (!destWord) return null;
  const dest = expandOperand(destWord, ctx.cwd)[0];
  const destPos = dest ? classifyTarget(dest, ctx) : { kind: 'unknown' };
  for (const source of targetsOf(sourceWords, ctx.cwd)) {
    const c = classifyTarget(source, ctx);
    if (c.kind === 'planning-dir') return hit('planning-dir', source, 'mv');
    if (c.kind === 'ancestor') return hit('planning-ancestor', source, 'mv');
    if (c.kind !== 'inside' || isRegenerated(c)) continue;
    // Within .planning (the debug/resolved and phase-archive moves) or to a
    // destination the scan cannot place: allowed.
    if ((destPos.kind === 'inside' || destPos.kind === 'planning-dir')
      && compareKey(destPos.planningDir) === compareKey(c.planningDir)) continue;
    if (destPos.kind === 'unknown') continue;
    const base = c.rest[c.rest.length - 1].toLowerCase();
    if (STATE_FILES.has(base) || source.abs === undefined || isDirectory(source.abs)) {
      return hit('planning-move-out', source, 'mv');
    }
  }
  return null;
}

// find's fnmatch: `*` and `?` match any character, `/` and a leading dot
// included (-path matches the whole path, -name has no `/` to cross).
function fnmatchRegex(pattern, insensitive) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      const j = pattern.indexOf(']', i + 1);
      if (j === -1) out += '\\[';
      else {
        const body = pattern.slice(i + 1, j);
        out += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body).replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else if (ch === '\\' && i + 1 < pattern.length) {
      i++;
      out += (/[.+^${}()|[\]\\*?]/.test(pattern[i]) ? '\\' : '') + pattern[i];
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(out + '$', insensitive ? 'i' : '');
}

const STATE_FILE_PROBES = ['config.json', 'STATE.md', 'ROADMAP.md', 'PROJECT.md', 'MILESTONES.md'];

/**
 * What find test `test` with `pattern` selects of a project's planning state:
 * 'dir' (a `.planning` directory by name — under any start), 'content' (a
 * state file by name, or a path under `.planning` — matters where the start
 * holds a project), or null. Probed by name for -name; by the paths under each
 * start (and under `.`) for -path and -regex.
 */
function findTestSelectsPlanning(test, pattern, starts) {
  const insensitive = test.startsWith('-i');
  if (test === '-name' || test === '-iname') {
    const re = fnmatchRegex(pattern, insensitive);
    if (re.test(PLANNING_DIR_NAME)) return 'dir';
    return STATE_FILE_PROBES.some((p) => re.test(p)) ? 'content' : null;
  }
  const prefixes = ['.', ...starts.map((s) => s.display.replace(/\/+$/, '') || '/')];
  const probes = [];
  for (const prefix of prefixes) {
    probes.push(`${prefix}/${PLANNING_DIR_NAME}`);
    for (const f of STATE_FILE_PROBES) probes.push(`${prefix}/${PLANNING_DIR_NAME}/${f}`);
    probes.push(`${prefix}/${PLANNING_DIR_NAME}/phases/01-x/01-01-PLAN.md`);
  }
  let re;
  if (test === '-regex' || test === '-iregex') {
    try {
      re = new RegExp(`^(?:${pattern})$`, insensitive ? 'i' : '');
    } catch {
      return 'content'; // a regex this scan cannot read is assumed to reach it
    }
  } else {
    re = fnmatchRegex(pattern, insensitive);
  }
  return probes.some((p) => re.test(p)) ? 'content' : null;
}

function checkFindExpression(starts, expression, deleting, ctx, command) {
  if (!deleting) return null;
  let names = 0;
  let selectsDir = false;
  let selectsContent = false;
  let prunesPlanning = false;
  for (let k = 0; k < expression.length; k++) {
    const t = expression[k];
    if (FIND_NAME_TESTS.has(t) && k + 1 < expression.length) {
      names++;
      const selects = findTestSelectsPlanning(t, expression[k + 1], starts);
      if (selects !== null && expression[k + 2] === '-prune') prunesPlanning = true;
      else if (selects === 'dir') selectsDir = true;
      else if (selects === 'content') selectsContent = true;
      k++;
    }
  }
  for (const start of starts) {
    const c = classifyTarget(start, ctx, { probeChild: true });
    if (isRegenerated(c)) continue;
    if (c.kind === 'planning-dir' || c.kind === 'inside') return hit('planning-subtree', start, command);
    // A test that selects `.planning` by name deletes it under any start
    // (`find ~/work -name .planning -exec rm -rf {} +`).
    if (selectsDir) return hit('planning-dir', start, command);
    if (c.kind === 'outside') continue;
    if (selectsContent) return hit('planning-subtree', start, command);
    if (c.kind === 'ancestor' && names === 0 && !prunesPlanning) return hit('planning-ancestor', start, command);
  }
  return null;
}

function parseFind(operands, cwd) {
  let k = 0;
  while (k < operands.length) {
    const t = operands[k].text;
    if (FIND_LEADING_FLAGS.has(t)) { k++; continue; }
    if (t === '-D' || t === '-O' || /^-O\d+$/.test(t)) { k += t === '-D' ? 2 : 1; continue; }
    break;
  }
  const startWords = [];
  while (k < operands.length) {
    const t = operands[k].text;
    if (t.startsWith('-') || t === '(' || t === '!' || t === ')' || t === ',') break;
    startWords.push(operands[k]);
    k++;
  }
  const expression = operands.slice(k).map((w) => w.text);
  let deleting = expression.includes('-delete');
  for (let e = 0; e < expression.length - 1; e++) {
    if (FIND_EXEC_ACTIONS.has(expression[e]) && EXEC_REMOVERS.has(lastSegment(expression[e + 1]).toLowerCase())) {
      deleting = true;
    }
  }
  const starts = startWords.length ? targetsOf(startWords, cwd) : targetsOf([{ text: '.', quoted: 'none' }], cwd);
  return { starts, expression, deleting };
}

function checkFind(operands, ctx) {
  const { starts, expression, deleting } = parseFind(operands, ctx.cwd);
  return checkFindExpression(starts, expression, deleting, ctx, 'find');
}

function checkGit(operands, ctx) {
  let k = 0;
  let gitCwd = ctx.cwd;
  while (k < operands.length && operands[k].text.startsWith('-')) {
    const t = operands[k].text;
    if (t === '-C') {
      const dirWord = operands[k + 1];
      if (dirWord) {
        const d = expandOperand(dirWord, gitCwd)[0];
        gitCwd = d && d.abs !== undefined ? d.abs : null;
      }
      k += 2;
      continue;
    }
    k += GIT_VALUE_GLOBALS.has(t) ? 2 : 1;
  }
  const sub = operands[k] ? operands[k].text : '';
  const args = operands.slice(k + 1);
  const gctx = { cwd: gitCwd, roots: ctx.roots };

  if (sub === 'clean') {
    const pathspecs = [];
    const excludes = [];
    let dryRun = false;
    let ended = false;
    for (let a = 0; a < args.length; a++) {
      const t = args[a].text;
      if (!ended && t === '--') { ended = true; continue; }
      if (!ended && t.startsWith('--')) {
        if (t === '--dry-run') dryRun = true;
        else if (t === '--exclude') { if (args[a + 1]) excludes.push(args[a + 1].text); a++; }
        else if (t.startsWith('--exclude=')) excludes.push(t.slice('--exclude='.length));
        continue;
      }
      if (!ended && t.length > 1 && t.startsWith('-')) {
        const e = t.indexOf('e');
        const flags = e === -1 ? t.slice(1) : t.slice(1, e);
        if (flags.includes('n')) dryRun = true;
        if (e !== -1) {
          if (e < t.length - 1) excludes.push(t.slice(e + 1));
          else { if (args[a + 1]) excludes.push(args[a + 1].text); a++; }
        }
        continue;
      }
      pathspecs.push(args[a]);
    }
    if (dryRun) return null;
    // `:!x` / `:^x` / `:(exclude)x` pathspecs exclude like `-e`.
    const included = [];
    for (const spec of pathspecs) {
      const m = /^:(?:!|\^|\(exclude\))(.*)$/.exec(spec.text);
      if (m) excludes.push(m[1]);
      else included.push(spec);
    }
    const excludesPlanning = excludes.some((x) => /^(?:\.\/|\/)?\.planning\/?$/i.test(x));
    const specs = (included.length ? included : [{ text: '.', quoted: 'none' }]).map((spec) => {
      // `:/` and `:(top)` are the repository root, whatever the cwd.
      const top = /^:(?:\/|\(top\))(.*)$/.exec(spec.text);
      if (!top) return spec;
      const root = gitCwd === null ? null : findGitRoot(gitCwd);
      return root === null ? { text: spec.text, expands: true, quoted: 'single' } : { ...spec, text: path.join(root, top[1] || '.') };
    });
    for (const target of targetsOf(specs, gitCwd)) {
      const c = classifyTarget(target, gctx, { probeChild: true });
      // A directory the scan cannot place: the whole of it fails closed
      // (`git -C "$X" clean -fdx`), a narrower pathspec does not.
      if (c.kind === 'unknown' && !excludesPlanning && /^(?:\.|\.\.|\.\/|\.\.\/|:.*)$/.test(target.lexical)) {
        return hit('planning-ancestor', target, 'git clean');
      }
      if (isRegenerated(c)) continue;
      if (c.kind === 'planning-dir' || c.kind === 'inside') return hit(c.kind === 'inside' ? 'planning-subtree' : 'planning-dir', target, 'git clean');
      if (c.kind === 'ancestor' && !excludesPlanning) return hit('planning-ancestor', target, 'git clean');
    }
    return null;
  }

  if (sub === 'rm') {
    const { options, rest } = splitOptions(args);
    if (options.includes('--cached')) return null;
    const force = options.some((o) => o === '--force' || (/^-[A-Za-z]+$/.test(o) && o.includes('f')));
    if (!force) return null;
    return checkRemoval(targetsOf(rest, gitCwd), rmIsRecursive(options), gctx, 'git rm');
  }
  return null;
}

/** `upstream | xargs rm …`: the upstream segment's operands become targets. */
function checkXargs(operands, upstreamWords, ctx) {
  let k = 0;
  while (k < operands.length && operands[k].text.startsWith('-')) {
    const t = operands[k].text;
    k += XARGS_VALUE_FLAGS.has(t) ? 2 : 1;
  }
  const subWords = operands.slice(k);
  const sub = resolveCommand(subWords);
  if (!sub || !EXEC_REMOVERS.has(sub.base)) return null;
  if (!upstreamWords) return null;
  const up = resolveCommand(upstreamWords);
  if (!up) return null;
  if (up.base === 'find') {
    const { starts, expression } = parseFind(up.operands, ctx.cwd);
    return checkFindExpression(starts, expression, true, ctx, `find | xargs ${sub.base}`);
  }
  const { options } = splitOptions(sub.operands);
  const recursive = sub.base === 'rm' && rmIsRecursive(options);
  const { rest } = splitOptions(up.operands);
  if (sub.base === 'rmdir') return checkRmdir(rest, ctx);
  return checkRemoval(targetsOf(rest, ctx.cwd), recursive, ctx, `xargs ${sub.base}`);
}

function findGitRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function nextCwd(operands, cwd) {
  const { rest } = splitOptions(operands);
  if (rest.length === 0) return homeDir();
  const w = rest[0];
  if (w.text === '-' || /^[+-]\d+$/.test(w.text)) return null;
  const t = expandOperand(w, cwd)[0];
  return t && t.abs !== undefined ? t.abs : null;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

function uniq(values) {
  return [...new Set(values)];
}

/** One segment's command under one cwd. */
function checkSegment(cmd, local, seg, depth) {
  const { base, operands } = cmd;
  if (FILE_REMOVERS.has(base)) return checkRm(base, operands, local);
  if (base === 'rmdir') return checkRmdir(operands, local);
  if (base === 'mv') return checkMv(operands, local);
  if (base === 'find') return checkFind(operands, local);
  if (base === 'git') return checkGit(operands, local);
  if (base === 'xargs') return checkXargs(operands, seg.pipedFrom, local);
  const nestedCtx = { cwds: [local.cwd], roots: local.roots };
  if (base === 'eval') {
    return depth < MAX_NESTING_DEPTH ? scanCommand(operands.map((w) => w.text).join(' '), nestedCtx, depth + 1) : null;
  }
  if (SHELL_INTERPRETERS.has(base) && depth < MAX_NESTING_DEPTH) {
    const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
    const scripts = cIdx !== -1
      ? (operands[cIdx + 1] ? [operands[cIdx + 1].text] : [])
      : [...seg.heredocs.map((h) => h.text), ...seg.hereStrings];
    for (const script of scripts) {
      const found = scanCommand(script, nestedCtx, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Scan a command under a set of possible cwds (`ctx.cwds`; null = unknown).
 * A `cd` narrows the set for the segments chained to it by `&&` only: past any
 * other separator the cwds from before it — where a failed cd leaves the
 * shell — are possible again.
 */
function scanCommand(command, ctx, depth) {
  const { tokens, nested } = tokenize(command);
  for (const sub of nested) {
    if (depth < MAX_NESTING_DEPTH) {
      const found = scanCommand(sub, { cwds: ctx.cwds, roots: ctx.roots }, depth + 1);
      if (found) return found;
    }
  }

  const bySeg = new Map();
  const heredocsBySeg = new Map();
  const sepAfter = new Map();
  let maxSeg = 0;
  for (const t of tokens) {
    if (t.seg > maxSeg) maxSeg = t.seg;
    if (t.kind === 'sep') sepAfter.set(t.seg, t.text);
    else if (t.kind === 'heredoc') {
      if (!heredocsBySeg.has(t.seg)) heredocsBySeg.set(t.seg, []);
      heredocsBySeg.get(t.seg).push(t);
    } else {
      if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
      bySeg.get(t.seg).push(t);
    }
  }

  let cwds = ctx.cwds;
  // The cwds a failed `cd` in the current `&&` chain would leave behind.
  let ifCdFailed = [];
  const subshells = [];
  let previousWords = null;
  for (let s = 0; s <= maxSeg; s++) {
    const segTokens = bySeg.get(s) || [];
    const words = [];
    const hereStrings = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        if (t.dup) continue;
        const target = segTokens[k + 1];
        if (target && target.kind === 'word') {
          k++;
          if (t.text.endsWith('<<<')) hereStrings.push(target.text);
        }
        continue;
      }
      words.push(t);
    }
    const cmd = words.length ? resolveCommand(words) : null;
    if (cmd && (cmd.base === 'cd' || cmd.base === 'pushd')) {
      ifCdFailed = uniq([...ifCdFailed, ...cwds]);
      cwds = uniq(cwds.map((c) => nextCwd(cmd.operands, c)));
      for (const c of cwds) {
        const root = c === null ? null : findPlanningRoot(c);
        if (root) ctx.roots.add(root);
      }
    } else if (cmd && cmd.base === 'popd') {
      ifCdFailed = uniq([...ifCdFailed, ...cwds]);
      cwds = [null];
    } else if (cmd) {
      const piped = s > 0 && (sepAfter.get(s - 1) === '|' || sepAfter.get(s - 1) === '|&');
      const seg = { pipedFrom: piped ? previousWords : null, heredocs: heredocsBySeg.get(s) || [], hereStrings };
      for (const cwd of cwds) {
        const found = checkSegment(cmd, { cwd, roots: ctx.roots }, seg, depth);
        if (found) return found;
      }
    }
    previousWords = words;
    const sep = sepAfter.get(s);
    if (sep === '(') {
      subshells.push({ cwds, ifCdFailed });
      ifCdFailed = [];
    } else if (sep === ')' && subshells.length) {
      ({ cwds, ifCdFailed } = subshells.pop());
    } else if (sep !== undefined && sep !== '&&') {
      cwds = uniq([...cwds, ...ifCdFailed]);
      ifCdFailed = [];
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

const WHAT = {
  'planning-dir': (t) => `would remove or move '${t}', a .planning/ directory`,
  'planning-ancestor': (t) => `would remove '${t}', a directory that contains a project's .planning/`,
  'planning-subtree': (t) => `would recursively remove '${t}', which is inside .planning/`,
  'planning-state-file': (t) => `would remove '${t}', a planning state file`,
  'planning-move-out': (t) => `would move '${t}' out of .planning/`,
};

function reasonFor(found) {
  return `Planning delete guard: \`${found.command}\` ${WHAT[found.code](found.target)}. ` +
    '.planning/ holds the project\'s GSD state, part of it usually not committed yet (config.json, ' +
    'STATE.md, the phase in progress), and a deletion there cannot be undone — a run lost its config ' +
    'this way when a failed `cd` left the shell in the main checkout. Do not retry with another spelling. ' +
    'Instead: delete only the specific file you created, by absolute path, after checking where you are ' +
    'with `pwd`; remove a phase with `gsd_run phase remove <N>`; archive finished phases with ' +
    '/gsd:cleanup; remove a worktree with `git worktree remove <path>`. If the user wants this deletion, ' +
    'ask them to run it themselves, or to turn the guard off for the project with ' +
    '`gsd_run config-set workflow.planning_delete_guard false`.';
}

/**
 * Decide one PreToolUse payload. Pure apart from filesystem reads; the
 * testable core. Returns `{ action: 'allow' }` or
 * `{ action: 'deny', code, target, command, reason }`.
 */
function evaluateCommand(data, options = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow' };
  if (data.tool_name !== 'Bash') return { action: 'allow' };
  const toolInput = data.tool_input;
  const command = toolInput && typeof toolInput === 'object' && typeof toolInput.command === 'string'
    ? toolInput.command : '';
  if (command === '' || command.length > MAX_COMMAND_LENGTH) return { action: 'allow' };
  if (scanner === null) return { action: 'allow' };

  const cwdRaw = options.cwd || (typeof data.cwd === 'string' && data.cwd) || process.cwd();
  const cwd = path.resolve(cwdRaw);
  const root = findPlanningRoot(cwd);
  if (root && !guardEnabled(root)) return { action: 'allow' };

  const ctx = { cwds: [cwd], roots: new Set(root ? [root] : []) };
  const found = scanCommand(command, ctx, 0);
  if (!found) return { action: 'allow' };
  return { action: 'deny', ...found, reason: reasonFor(found) };
}

/* istanbul ignore next -- stdin adapter, exercised via the process seam in tests */
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => allow(undefined), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    // The shared scanner did not load: nothing can be judged, so the declared
    // crash policy (allow) answers.
    if (scanner === null) crash(ON_CRASH, undefined);
    let decision;
    try {
      decision = evaluateCommand(JSON.parse(input));
    } catch {
      crash(ON_CRASH, undefined);
    }
    if (!decision || decision.action !== 'deny') allow(undefined);
    deny({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
      decision: 'block',
      code: decision.code,
      target: decision.target,
      reason: decision.reason,
    }, decision.reason);
  });
}

if (require.main === module) {
  main();
}

module.exports = { evaluateCommand, scanCommand, STATE_FILES };
