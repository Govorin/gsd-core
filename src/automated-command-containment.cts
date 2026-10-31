/**
 * automated-command-containment.cts — step 0c, the `<automated>` command
 * containment check (#4767), as a typed function (ADR-5211).
 *
 * A plan's `<automated>` verify command is where an orchestrator-cwd absolute
 * path most often arrives: the planner saw absolute paths in its own context
 * and wrote one into the command. Run as written, `cd /abs/main-checkout/… &&
 * <test>` leaves the worktree, runs against the main tree, and PASSES on code
 * this worktree changed and the main tree did not — a green verify that
 * verified nothing. This check scans the command TEXT (it never executes it)
 * and refuses when the command would relocate outside the worktree or names a
 * path inside the main checkout. Fail loud; never rewrite the command (#3050).
 *
 * ## Provenance — a verbatim port, not a redesign
 *
 * Until ADR-5211 this was ~16 KB of bash in
 * `gsd-core/references/worktree-path-safety.md` that every executor ran itself.
 * Claude Code ≥ 2.1.310 refuses that bash inside an `isolation: "worktree"`
 * agent, so the check moved behind `gsd-tools worktree guard automated`. The
 * expressions below are the bash guard's `_OPEN`/`_VERB`/`_ENV`/`_LOPT`/
 * `_ENVOPT`/`_ENVOPTL`/`_LAUNCH`/`_DIR`/`_EXEC`/`_EVAL`/`_TOK`, character for
 * character, evaluated by `posix-ere.cts` with grep's leftmost-longest
 * semantics; `unquote`, `resetsCwd`, `resolveLikeShell` and `normalizeLexical`
 * are the bash `_unquote`, `_resets_cwd`, `_resolve` and `_norm`. Before the
 * bash was deleted, a differential run held this module to it over the whole
 * #4767 corpus plus 300 generated commands with identical verdicts; the corpus
 * now lives in tests/helpers/worktree-guard-corpus.cjs. Every design decision the bash comments recorded (why control
 * keywords are not command boundaries, why the launcher set is named rather
 * than a catch-all, why directory flags are tool-scoped, why `command`/`exec`
 * are not launchers) carries over unchanged; the reasons are summarised at
 * each expression.
 *
 * ## Two deliberate differences from the bash
 *
 * 1. An unresolvable worktree or main root is a REFUSAL here. The bash took an
 *    empty `git rev-parse --show-toplevel` as the root, which made every
 *    absolute path "inside" — a fail-open the verb does not reproduce
 *    (ADR-3409: an unreachable answer is a refusal, never a pass).
 * 2. A command longer than MAX_COMMAND_CHARS, or one carrying a NUL, is refused
 *    rather than scanned (a bash variable cannot hold a NUL at all).
 *
 * ## What this check does NOT see — its stated boundary
 *
 * The scans recognise FIXED sets — relocating verbs, directory flags,
 * interpreters, launchers, command boundaries — so the boundary is written out
 * rather than rediscovered. The shipped reference
 * (`gsd-core/references/worktree-path-safety.md`, "What the automated stage does
 * NOT see") carries the same list for the executor and the interpreter lists a
 * test drives behaviourally. In descending order of likelihood:
 *
 * - A RELATIVE path argument to a command that is not a relocating verb
 *   (`node ../main/test.js`, `make -f ../main/Makefile`) passes. Only words
 *   beginning with `/` are resolved by the catch-all scan; resolving every
 *   relative word would halt on ordinary arguments.
 * - Spellings that hide the verb from a text scan (`cd$IFS/x`).
 * - Anything the shell builds at run time: `cd $VAR`, `cd "$(…)"`, `~`,
 *   `bash -c "$CMD"`. The plan-time probe (`check verify-command-paths`)
 *   reports these as `dynamic_path`.
 * - A `cd` the shell completes from its own state: bare `cd` (`$HOME`), `cd -`
 *   (`$OLDPWD`), `CDPATH` lookups, an alias or function defined elsewhere, a
 *   sourced script (`. ./x.sh`), or a file a tool runs (`npm test`'s script,
 *   `bash x.sh`) — the text holds no target to resolve.
 * - A command boundary outside `OPEN`'s set (`&&` `&` `;` `|` `(` `{`, line
 *   start), matched against RAW TEXT. After a boundary, `time [-p]`, `!` and the
 *   compound-command keywords (`if then else elif do while until`) are read as
 *   prefixes; anywhere else they are words, so `grep -F 'if cd ../main; then'`
 *   (no boundary before `if`) passes. The same quote-blindness makes
 *   `echo 'note; bash -c "cd ../main"'` halt — an over-halt in the loud direction.
 * - `eval` rescans every word up to the end of its simple command, joined; an
 *   `eval` reached through `exec`/`command`, or one whose words the shell builds
 *   at run time (`eval "cd $X"`), is not seen.
 * - A launcher outside `env timeout nohup stdbuf nice ionice setsid`; `command`
 *   and `exec` are excluded so `command -v bash` (a probe) does not halt.
 * - An interpreter outside `sh bash zsh dash ksh python python3 node perl ruby`
 *   and `eval` (bare word only); an interpreter option taking an operand
 *   (`bash -O extglob -c`).
 * - A payload behind a relocating launcher is scanned from the command's cwd,
 *   not the launcher's (`env -C scripts bash -c 'cd ..'` over-halts).
 * - A launcher or directory-flag spelling outside each tool's grammar; a
 *   pass-through argument spelling a directory flag over-halts
 *   (`npm run x -- --prefix=../main/`).
 * - A non-shell payload whose path is computed (`os.path.join(root, '..')`).
 * - Nothing nested deeper than MAX_UNWRAP_DEPTH is scanned: it refuses
 *   (`unwrap_too_deep`) instead.
 * - A directory flag on a tool outside npm npx pnpm yarn make git env; for such
 *   a tool only the ABSOLUTE form of the flag is caught, by the catch-all scan.
 * - POSIX paths only: the bash harness never ran on Windows, and neither do
 *   these semantics; a win32 command is scanned with the same POSIX rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { isContainedIn } from './security.cjs';
import { deleteFirstMatch, grepOnlyMatching, matchAllInLine, matchPrefix } from './posix-ere.cjs';

/** Longest command the check will scan; longer text is refused, never truncated. */
export const MAX_COMMAND_CHARS = 64 * 1024;

/**
 * Nesting bound for unwrapped interpreter and `eval` payloads (the bash `_walk`
 * depth bound). The bash stopped scanning past it and passed; here a payload
 * nested deeper than this is a refusal (`unwrap_too_deep`).
 */
export const MAX_UNWRAP_DEPTH = 4;

// ─── The bash guard's expressions, verbatim ─────────────────────────────────

/** A shell word as the planner wrote it: bare runs, "…"/'…' spans, backslash escapes. */
const TOK = String.raw`("[^"]*"|'[^']*'|\\.|[^[:space:]"';|&()])+`;
/**
 * `cd` / `pushd`, bare, `builtin`/`command`-prefixed, with their options
 * (`-L`, `-P`, `-e`, `-@`, pushd's `-n`; review finding: `cd -P ../main` took
 * `-P` for the target) and with `--`.
 */
const VERB = String.raw`((builtin|command)[[:space:]]+)?(cd|pushd)([[:space:]]+-[LPe@n]+)*([[:space:]]+--)?`;
/**
 * Prefixes that run the command after them in the same shell: `time` (with
 * `-p`), `!`, and the compound-command keywords. Matched only right AFTER a
 * command boundary, so the bash's reason for keeping keywords out of `OPEN`
 * still holds: `grep -F 'if cd ../main; then' README.md` has no boundary before
 * `if` and passes, while `if cd ../main; then …` at a boundary halts.
 */
const PREFIX = String.raw`((time([[:space:]]+-p)?|!|if|then|else|elif|do|while|until)[[:space:]]+)*`;
/** Leading `FOO=bar` assignments. */
const ENV = String.raw`([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*`;
/**
 * Command boundaries. Literal ERE operators are bracket expressions (BSD sed
 * rejected `\|`). Control keywords are NOT here: these match raw text with no
 * quote awareness, so a keyword that is also an English word would turn prose
 * inside a quoted argument into a boundary.
 */
const OPEN = String.raw`(^|&&|&|;|[|][|]|[|]|[(]|[{])[[:space:]]*`;
/** Generic launcher options: `-x`, `--flag`, `NAME=value`. */
const LOPT = String.raw`([[:space:]]+-[^[:space:]]+|[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)*`;
/**
 * env's separate-operand options, INTERLEAVED with generic ones — the shape is
 * `(<generic> <opt> <operand>)* <generic>`, so a generic option between two
 * operand-taking ones cannot end the run and hide what follows.
 */
const ENVOPT = `(${LOPT}[[:space:]]+(-u|--unset)[[:space:]]+${TOK})*${LOPT}`;
/** The wider env group for LAUNCH: it must CONSUME `-C`/`--chdir`, which DIR must leave. */
const ENVOPTL = `(${LOPT}[[:space:]]+((-u|--unset)[[:space:]]+|(-C|--chdir)([[:space:]]+|=))${TOK})*${LOPT}`;
/**
 * A NAMED launcher set, by bare word or absolute path. A catch-all also
 * unwrapped interpreter text that was merely an argument (`echo bash -c …`).
 * Which options take an operand is tool-scoped (`-i` does on stdbuf, not env).
 */
const LAUNCH = String.raw`((/[^[:space:]]*/)?((env|setsid|nohup)` + ENVOPTL
  + String.raw`|timeout(` + LOPT + String.raw`[[:space:]]+(-s|--signal|-k|--kill-after)[[:space:]]+[^[:space:]]+)*` + LOPT
  + String.raw`[[:space:]]+[0-9]+[smhd]?|(stdbuf|nice|ionice)(` + LOPT
  + String.raw`[[:space:]]+(-i|-o|-e|-n|-c)[[:space:]]+[^[:space:]]+)*` + LOPT + String.raw`)[[:space:]]+)*`;
/**
 * Tool-scoped directory flags: `git archive --prefix=` names archive members, so
 * `--prefix`/`--cwd`/`--dir`/`-C` belong to the node package managers only.
 */
const DIR = `((${LAUNCH})(npm|npx|pnpm|yarn)[[:space:]]+([^&;|]*[[:space:]]+)?(--prefix|--cwd|--dir|-C)`
  + `|(${LAUNCH})(make|git)[[:space:]]+([^&;|]*[[:space:]]+)?(-C|--directory)`
  + `|(${LAUNCH})(/[^[:space:]]*/)?env${ENVOPT}[[:space:]]+(--chdir|-C))[[:space:]=]+`;
/** Command-string interpreters whose payload is unwrapped and re-scanned. */
const EXEC = `(${LAUNCH})((/[^[:space:]]*/)?(sh|bash|zsh|dash|ksh)([[:space:]]+--[a-z-]+)*[[:space:]]+-[a-z]*c`
  + `|(/[^[:space:]]*/)?(python3?|node|perl|ruby)([[:space:]]+--[a-z-]+)*[[:space:]]+-[a-z]*[ce]|eval)[[:space:]]+`;
/** `eval` runs in the CURRENT shell: its payload's final cwd persists. */
const EVAL = String.raw`eval[[:space:]]+`;

const EVENT_RE = `${OPEN}${PREFIX}(${ENV}${EXEC}|${ENV}${VERB}[[:space:]]+|${DIR})${TOK}`;
const BOUNDARY_STRIP_RE = String.raw`^(&&|&|;|[|][|]|[|]|[(]|[{])?[[:space:]]*`;
const CLASS_EVAL_RE = `^${PREFIX}${ENV}${EVAL}`;
const CLASS_EXEC_RE = `^${PREFIX}${ENV}${EXEC}`;
const CLASS_DIR_RE = `^${PREFIX}${DIR}`;
const CLASS_VERB_RE = `^${PREFIX}${ENV}${VERB}[[:space:]]+`;
const LAUNCH_DIR_RE = `(^|[[:space:]])(-C|--chdir)([[:space:]]+|=)${TOK}`;
const LAUNCH_DIR_STRIP_RE = String.raw`^[[:space:]]*(-C|--chdir)([[:space:]]+|=)`;

// ─── Verdict ────────────────────────────────────────────────────────────────

export const CONTAINMENT_CODE = Object.freeze({
  OK: 'ok',
  RELOCATES_OUTSIDE_WORKTREE: 'relocates_outside_worktree',
  NAMES_MAIN_CHECKOUT: 'names_main_checkout',
  COMMAND_TOO_LARGE: 'command_too_large',
  COMMAND_INVALID: 'command_invalid',
  UNWRAP_TOO_DEEP: 'unwrap_too_deep',
  INTERNAL_ERROR: 'internal_error',
} as const);

export type ContainmentCode = (typeof CONTAINMENT_CODE)[keyof typeof CONTAINMENT_CODE];

export interface ContainmentVerdict {
  ok: boolean;
  code: ContainmentCode;
  /** The word as written (after unquoting), the path it resolved to, and how it was reached. */
  target?: string;
  resolved?: string;
  via?: 'cd' | 'dir-flag' | 'launcher-chdir' | 'absolute-word';
  detail?: string;
}

export interface ContainmentRoots {
  /** `git rev-parse --show-toplevel` of the worktree — git's own spelling. */
  worktreeRoot: string;
  /** Physical path of the checkout this worktree was created from. */
  mainRoot: string;
}

class Halt extends Error {
  constructor(readonly verdict: ContainmentVerdict) { super(verdict.code); }
}

// ─── Shell-text helpers (bash _unquote / _resets_cwd) ───────────────────────

/** The string the shell would pass for one word: three quoting states, backslash escapes. */
export function unquote(s: string): string {
  const c = Array.from(s);
  let out = '';
  let q = '';
  for (let i = 0; i < c.length; i += 1) {
    const ch = c[i];
    if (q === '') {
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '\\') { i += 1; out += c[i] ?? ''; }
      else out += ch;
    } else if (q === '"') {
      if (ch === '"') q = '';
      else if (ch === '\\') { i += 1; out += c[i] ?? ''; }
      else out += ch;
    } else if (ch === "'") q = '';
    else out += ch;
  }
  return out;
}

/** True when raw shell text holds an unquoted SINGLE `&` or `|` (a process boundary). */
export function resetsCwd(s: string): boolean {
  const c = Array.from(s);
  let q = '';
  for (let i = 0; i < c.length; i += 1) {
    const ch = c[i];
    if (q === '') {
      if (ch === "'" || ch === '"') q = ch;
      else if (ch === '\\') i += 1;
      else if (ch === '&' || ch === '|') {
        const p = i > 0 ? c[i - 1] : '';
        const n = i < c.length - 1 ? c[i + 1] : '';
        if (p !== ch && n !== ch) return true;
      }
    } else if (q === '"') {
      if (ch === '"') q = '';
      else if (ch === '\\') i += 1;
    } else if (ch === "'") q = '';
  }
  return false;
}

/**
 * The rest of the simple command `s` starts in: up to the first unquoted
 * `;`, `&`, `|`, `)` or newline. `eval` joins ALL of its arguments into the
 * text it runs, so its payload is every word up to here, not just the first.
 */
export function restOfSimpleCommand(s: string): string {
  const c = Array.from(s);
  let q = '';
  let out = '';
  for (let i = 0; i < c.length; i += 1) {
    const ch = c[i];
    if (q === '') {
      if (ch === ';' || ch === '&' || ch === '|' || ch === ')' || ch === '\n') break;
      if (ch === "'" || ch === '"') q = ch;
      else if (ch === '\\') { out += ch + (c[i + 1] ?? ''); i += 1; continue; }
    } else if (ch === q) q = '';
    else if (q === '"' && ch === '\\') { out += ch + (c[i + 1] ?? ''); i += 1; continue; }
    out += ch;
  }
  return out;
}

// ─── Path resolution the way the shell lands (bash _resolve / _norm) ────────

function isSearchableDir(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** POSIX dirname/basename of a string, as the coreutils commands compute them. */
function posixDirname(p: string): string {
  const s = p.replace(/\/+$/, '');
  if (s === '') return p.startsWith('/') ? '/' : '.';
  const idx = s.lastIndexOf('/');
  if (idx === -1) return '.';
  const d = s.slice(0, idx).replace(/\/+$/, '');
  return d === '' ? '/' : d;
}

function posixBasename(p: string): string {
  const s = p.replace(/\/+$/, '');
  if (s === '') return p.startsWith('/') ? '/' : '';
  return s.slice(s.lastIndexOf('/') + 1);
}

/** bash `_norm`: lexical `.`/`..` collapse of an absolute path; never touches the disk. */
export function normalizeLexical(p: string): string {
  const firstLine = p.split('\n')[0];
  const out: string[] = [];
  for (const s of firstLine.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length > 0) out.pop(); continue; }
    out.push(s);
  }
  return out.length === 0 ? '/' : out.map((s) => `/${s}`).join('');
}

/**
 * bash's logical `cd` (`cd -L`, the default outside POSIX mode) for an absolute
 * path, followed by `pwd -P`: canonicalise lexically, checking that whatever a
 * `..` backs over is a directory and that the result exists; chdir there, or to
 * the path as given when canonicalisation failed. Null when bash's cd would fail.
 */
function cdThenPwdP(p: string): string | null {
  const parts: string[] = [];
  let canon: string | null = null;
  let canonFailed = false;
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!isSearchableDirNoX(`/${parts.join('/')}`)) { canonFailed = true; break; }
      parts.pop();
      continue;
    }
    parts.push(s);
  }
  if (!canonFailed) {
    const c = `/${parts.join('/')}`;
    if (isSearchableDirNoX(c)) canon = c;
  }
  for (const candidate of canon !== null ? [canon, p] : [p]) {
    if (isSearchableDir(candidate)) {
      try {
        return fs.realpathSync.native(candidate);
      } catch {
        // fall through to the next candidate
      }
    }
  }
  return null;
}

/**
 * bash `_resolve`: where the shell would land for `target`, relative paths taken
 * from `base` (the cwd reached so far). An existing directory resolves physically;
 * a file through its directory (a symlinked file through its link target first);
 * a path that does not exist yet is normalised lexically.
 */
export function resolveLikeShell(target: string, base: string): string {
  let p = target.startsWith('/') ? target : `${base}/${target}`;
  let isLink = false;
  try { isLink = fs.lstatSync(p).isSymbolicLink(); } catch { isLink = false; }
  if (isLink && !isSearchableDirNoX(p)) {
    let t = '';
    try { t = fs.readlinkSync(p); } catch { t = ''; }
    p = t.startsWith('/') ? t : `${posixDirname(p)}/${t}`;
  }
  const direct = cdThenPwdP(p);
  if (direct !== null) return direct;
  const parent = cdThenPwdP(posixDirname(p));
  if (parent !== null) return `${parent}/${posixBasename(p)}`;
  return normalizeLexical(p);
}

/** `[ -d "$p" ]` — follows links, no search-permission requirement. */
function isSearchableDirNoX(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ─── The scan ───────────────────────────────────────────────────────────────

/**
 * Both operands are already resolved the way the shell lands (bash `_resolve`),
 * so only the comparison step is wanted — the bash `case "$R" in "$ROOT"|"$ROOT"/*`.
 */
function under(resolved: string, root: string): boolean {
  return isContainedIn(resolved, root, path.posix);
}

function outsideWorktree(resolved: string, roots: ContainmentRoots): boolean {
  return !under(resolved, roots.worktreeRoot);
}

interface ScanState { cur: string }

function relocationHalt(target: string, resolved: string, via: ContainmentVerdict['via']): Halt {
  return new Halt({ ok: false, code: CONTAINMENT_CODE.RELOCATES_OUTSIDE_WORKTREE, target, resolved, via });
}

/** One `_scan` pass over `cmd` at unwrap depth `depth`; throws Halt on the first violation. */
function scan(cmd: string, depth: number, roots: ContainmentRoots, state: ScanState): void {
  const events = grepOnlyMatching(EVENT_RE, cmd).filter((e) => e !== '');
  let rest = cmd;
  for (const raw of events) {
    // Preserve process boundaries even when an unrecognised command sits between events.
    const at = rest.indexOf(raw);
    const before = at === -1 ? rest : rest.slice(0, at);
    if (at !== -1) rest = rest.slice(at + raw.length);
    if (resetsCwd(before) || resetsCwd(raw)) state.cur = roots.worktreeRoot;

    const body = deleteFirstMatch(BOUNDARY_STRIP_RE, raw);
    let kind: 'E' | 'W' | 'N' | 'C';
    let prefix: string | null;
    if ((prefix = matchPrefix(CLASS_EVAL_RE, body)) !== null) kind = 'E';
    else if ((prefix = matchPrefix(CLASS_EXEC_RE, body)) !== null) kind = 'W';
    else if ((prefix = matchPrefix(CLASS_DIR_RE, body)) !== null) kind = 'N';
    else {
      prefix = matchPrefix(CLASS_VERB_RE, body);
      kind = 'C';
      if (prefix === null) {
        throw new Halt({ ok: false, code: CONTAINMENT_CODE.INTERNAL_ERROR, detail: `unclassifiable event: ${raw}` });
      }
    }
    const quoted = body.startsWith(prefix) ? body.slice(prefix.length) : body;
    const target = unquote(quoted);

    if ((kind === 'E' || kind === 'W') && depth >= MAX_UNWRAP_DEPTH) {
      throw new Halt({ ok: false, code: CONTAINMENT_CODE.UNWRAP_TOO_DEEP, target, detail: `payloads nested more than ${MAX_UNWRAP_DEPTH} deep` });
    }
    if (kind === 'E') {
      // `eval` runs the words it is given joined by spaces: `eval cd ../main` and
      // `eval eval 'cd ../main'` carry the target in the words AFTER the first
      // (review finding). The rest of this simple command is rescanned as one text.
      const tail = grepOnlyMatching(TOK, restOfSimpleCommand(rest.split('\n')[0])).map(unquote);
      scan([target, ...tail].filter((w) => w !== '').join(' '), depth + 1, roots, state);
    } else if (kind === 'W') {
      {
        const saved = state.cur;
        // EXEC outlives DIR in leftmost-longest, so a wrapper reached through
        // `env -C/--chdir` lands here: validate that launcher relocation, start
        // the payload there, restore the parent cwd afterwards.
        const launcherPrefix = body.endsWith(quoted) ? body.slice(0, body.length - quoted.length) : body;
        for (const m of matchAllInLine(LAUNCH_DIR_RE, launcherPrefix)) {
          const dirWord = deleteFirstMatch(LAUNCH_DIR_STRIP_RE, m.text);
          if (dirWord === '') continue;
          const ld = unquote(dirWord);
          const r = resolveLikeShell(ld, state.cur);
          if (outsideWorktree(r, roots)) throw relocationHalt(ld, r, 'launcher-chdir');
          state.cur = r;
        }
        scan(target, depth + 1, roots, state);
        state.cur = saved;
      }
    } else {
      const r = resolveLikeShell(target, state.cur);
      if (outsideWorktree(r, roots)) throw relocationHalt(target, r, kind === 'C' ? 'cd' : 'dir-flag');
      if (kind === 'C') state.cur = r;
    }
  }

  // Any other absolute word resolving under the MAIN checkout (a file argument, a
  // redirect, an include) is the same defect by a different verb; system paths pass.
  for (const word of grepOnlyMatching(TOK, cmd)) {
    if (word === '') continue;
    let p = unquote(word);
    // The bash glob `[A-Za-z_]*=*|--*=*`: FOO=/x and --flag=/x carry their path after the `=`.
    if (/^[A-Za-z_][\s\S]*=/.test(p) || /^--[\s\S]*=/.test(p)) p = p.slice(p.indexOf('=') + 1);
    if (!p.startsWith('/')) continue;
    const r = resolveLikeShell(p, roots.worktreeRoot);
    if (!outsideWorktree(r, roots)) continue;
    if (under(r, roots.mainRoot)) {
      throw new Halt({ ok: false, code: CONTAINMENT_CODE.NAMES_MAIN_CHECKOUT, target: p, resolved: r, via: 'absolute-word' });
    }
  }
}

/**
 * Check one `<automated>` command against the worktree it would run in.
 * Never throws: every fault is a refusing verdict (ADR-3409).
 */
export function checkAutomatedCommand(command: string, roots: ContainmentRoots): ContainmentVerdict {
  if (typeof command !== 'string' || command.includes('\0')) {
    return { ok: false, code: CONTAINMENT_CODE.COMMAND_INVALID, detail: 'command must be a string without NUL bytes' };
  }
  if (Array.from(command).length > MAX_COMMAND_CHARS) {
    return { ok: false, code: CONTAINMENT_CODE.COMMAND_TOO_LARGE, detail: `longer than ${MAX_COMMAND_CHARS} characters` };
  }
  if (!roots.worktreeRoot.startsWith('/') || !roots.mainRoot.startsWith('/')) {
    return { ok: false, code: CONTAINMENT_CODE.INTERNAL_ERROR, detail: 'roots must be absolute POSIX paths' };
  }
  try {
    scan(command, 0, roots, { cur: roots.worktreeRoot });
    return { ok: true, code: CONTAINMENT_CODE.OK };
  } catch (e) {
    if (e instanceof Halt) return e.verdict;
    return { ok: false, code: CONTAINMENT_CODE.INTERNAL_ERROR, detail: e instanceof Error ? e.message : String(e) };
  }
}
