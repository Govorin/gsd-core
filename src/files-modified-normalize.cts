/**
 * files-modified-normalize — resolve declared `files_modified` entries against a
 * real tree, keeping four outcomes distinguishable.
 *
 * ── The blind spot this closes ──────────────────────────────────────────────
 *
 * `capabilities/mn-verify-gate/scripts/wave-collision.mjs` ships today, runs at
 * `plan:post`, and already implements criterion 1: it names the colliding pair
 * and the shared file and exits 1. What it cannot do is compare an entry whose
 * basename has no dot. Its own `--verbose` output on the live tree
 * `legion-app/08.2-heimdall-runtime`:
 *
 *   "OK — 9 plan(s) across 8 wave(s), 1 pair(s) checked, no shared files"
 *   "13 non-file entr(ies) (directories or globs) were not compared"
 *
 * That phase holds a genuine overlap: `08.2-01-PLAN.md` and `08.2-01b-PLAN.md`
 * both declare `libs/modules/heimdall/testing`, a directory. The gate declines
 * to guess and says so honestly. Measured across all 55 reachable phase
 * directories: 2 collisions caught, 17 phases where entries are skipped.
 *
 * So the gate is not wrong — it is blind on 17 of 55 phases, and this module is
 * what restores its sight. It feeds the existing checker; it does not replace it.
 *
 * ── D-63c: resolve, do not string-match ─────────────────────────────────────
 *
 * A crude detector that treats `libs/modules/heimdall/testing` as a file and
 * compares strings would manufacture a collision between a directory and a file
 * inside it that no worktree would ever conflict over. This module instead
 * resolves such an entry to the files it actually covers, turning a skipped
 * comparison into a real one.
 *
 * ── The four outcomes, which never collapse (D-66, criterion 4) ─────────────
 *
 *   1. `file`      → compared as declared
 *   2. `directory`/`glob` resolving to N>0 → those N files are compared
 *   3. `directory`/`glob` resolving to 0   → `unresolved: true`, "the files moved"
 *   4. plan declared no entries at all      → `declaredNothing: true` (D-65)
 *
 * 3 and 4 are different breakages with different remedies: a stale glob means
 * the files moved; an empty declaration means nobody wrote one. `declaredNothing`
 * is therefore derived STRICTLY from `declared.length === 0` and never inferred
 * from `files.length === 0`, because outcome 3 also yields an empty `files`.
 * Collapsing the two is how a gate earns the reputation that gets it disabled.
 *
 * ── Determinism (criterion 3) ───────────────────────────────────────────────
 *
 * No wall-clock, no `Math.random`, no `path.resolve` (which would bind output to
 * `process.cwd()` and make it machine-dependent). Every `readDir` result is
 * explicitly sorted before iteration at EVERY level of the walk, because
 * `readdirSync` order is not guaranteed. Same input, byte-identical output.
 *
 * LEAF MODULE — its only import is the pure regex-escape seam (`./pattern.cjs`,
 * ADR-3212). The filesystem enters only through the injected `FsProbe`, so the
 * module is exercisable with no temp tree and a test can hand it a deliberately
 * reversed listing to prove the sort is load-bearing.
 */

import { escapeRegex } from './pattern.cjs';

/**
 * One of four kinds.
 *
 * `malformed` is an entry that is neither a resolvable path nor a glob — the
 * prose entries measured in the live trees, e.g.
 * `apps/ucars/api (9 files), ... — exact list from live scan`.
 */
export type EntryKind = 'file' | 'directory' | 'glob' | 'malformed';

export interface NormalizedEntry {
  /** The entry exactly as the plan declared it, before any rewriting. */
  readonly declared: string;
  readonly kind: EntryKind;
  /**
   * Files this entry stands for, sorted. Empty is a real answer, not a missing
   * one: an unresolved glob and a directory that is gone both land here as [].
   */
  readonly resolved: readonly string[];
  /**
   * True when the entry stands for no files. Kept separate from `resolved` so a
   * caller cannot confuse "expanded to nothing" with "not expanded".
   */
  readonly unresolved: boolean;
}

export interface NormalizedPlanFiles {
  readonly entries: readonly NormalizedEntry[];
  /** Union of every entry's resolved files, deduplicated and sorted. */
  readonly files: readonly string[];
  /**
   * True only when the plan declared zero entries. D-65: this is a refusal to
   * make, and callers MUST NOT treat it as an empty overlap set.
   */
  readonly declaredNothing: boolean;
}

/**
 * Filesystem seam. Injected so tests need no temp tree and so listing order can
 * be shuffled in a test to prove the sort is real (criterion 3).
 */
export interface FsProbe {
  readonly exists: (path: string) => boolean;
  readonly isDirectory: (path: string) => boolean;
  /** Paths relative to root, one level. Order is NOT guaranteed by the caller. */
  readonly readDir: (path: string) => readonly string[];
  /**
   * Optional: is the path a symbolic link? When provided, a walk neither descends into nor counts
   * a symlink (T-03-01) — it is not what a plan intends to write, and following it leaves the tree.
   */
  readonly isSymbolicLink?: (path: string) => boolean;
}

/**
 * Depth ceiling for the recursive walk.
 *
 * A `readDir` backed by a real filesystem can be handed a symlink loop, and an
 * unbounded walk would not terminate. The gate's contract is that it either
 * answers or says it could not look — never that it hangs. 64 is far beyond any
 * repo depth measured (deepest live entry: 8 segments) while still being finite.
 */
const MAX_WALK_DEPTH = 64;

/**
 * Normalise a declared path to a comparable form WITHOUT changing its meaning.
 *
 * Deliberately does not collapse `..` and does not call `path.resolve`: entries
 * are repo-relative by convention, and resolving them against `process.cwd()`
 * would make the output machine-dependent and break criterion 3.
 */
function normalizePath(declared: string): string {
  return declared
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** Does this text carry prose rather than a path? */
function looksLikeProse(text: string): boolean {
  // Measured in the live trees: 25 entries contain `(`, 26 contain whitespace,
  // and 16 of those ALSO contain `*`. A path never contains a space in this
  // corpus; a parenthetical always introduces a count or an aside.
  return /\s/.test(text) || text.includes('(');
}

/**
 * Does the path leave the root? An absolute path, or `..` climbing above the start (T-03-01), is
 * not a file the plan will create but an entry this module refuses to resolve.
 */
function escapesRoot(p: string): boolean {
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return true;
  let depth = 0;
  for (const seg of p.split('/')) {
    if (seg === '..') {
      depth--;
      if (depth < 0) return true;
    } else if (seg !== '.' && seg !== '') {
      depth++;
    }
  }
  return false;
}

/**
 * Classify a declared entry into exactly one of four kinds.
 *
 * Order of decision is load-bearing:
 *
 *   1. Prose → `malformed`. This is checked BEFORE the wildcard test, and the
 *      measurement is why: 16 of the 45 wildcard-bearing entries in the live
 *      trees are prose wrapped around a glob, e.g.
 *      `libs/** (19 prefer-zod-validate files + 7 use-either-async files — exact
 *      list from live scan)`. Reading that as a glob compiles the whole sentence
 *      into a RegExp, matches nothing, and reports "stale glob — the files
 *      moved". Nothing moved; the planner wrote a sentence. Two different
 *      failures with two different remedies, which D-66 forbids merging. The
 *      plan's stated order put the wildcard test first; the measurement
 *      overturned it.
 *   1b. An entry escaping the root (absolute, or `..` above it) → `malformed`
 *      (T-03-01): never resolved against a tree outside the project.
 *   2. Wildcard → `glob`.
 *   3. Existing directory → `directory`.
 *   4. Otherwise → `file`. A non-existent concrete path stays `file` with
 *      `resolved: [normalized]`: the plan is declaring a file it intends to
 *      CREATE, and treating that as unresolved would flag every greenfield plan.
 */
export function classifyEntry(declared: string, fs: FsProbe): EntryKind {
  const p = normalizePath(declared);
  if (p === '') return 'malformed';
  if (looksLikeProse(p)) return 'malformed';
  if (escapesRoot(p)) return 'malformed';
  if (p.includes('*') || p.includes('?')) return 'glob';
  if (fs.exists(p) && fs.isDirectory(p)) return 'directory';
  return 'file';
}

/** Sorted listing. Every level of every walk goes through here — see criterion 3. */
function sortedChildren(fs: FsProbe, dir: string): string[] {
  let names: readonly string[];
  try {
    names = fs.readDir(dir);
  } catch {
    // A directory that cannot be listed contributes nothing rather than
    // aborting the whole normalisation. The caller still sees `unresolved`.
    return [];
  }
  return [...names].sort();
}

/** Every regular file at or beneath `dir`, sorted, depth-first. */
function walkDirectory(fs: FsProbe, dir: string, depth = 0): string[] {
  if (depth >= MAX_WALK_DEPTH) return [];
  const out: string[] = [];
  for (const name of sortedChildren(fs, dir)) {
    const child = dir === '' ? name : `${dir}/${name}`;
    if (fs.isSymbolicLink?.(child) === true) continue;
    if (fs.isDirectory(child)) out.push(...walkDirectory(fs, child, depth + 1));
    else out.push(child);
  }
  return out;
}

/**
 * Compile a glob to an anchored RegExp.
 *
 * Vocabulary is exactly what the measured trees contain: `*` (one segment) and
 * `**` (any depth). Every regex metacharacter except `*` is escaped, so a
 * pattern containing `.` or `+` matches literally rather than as a wildcard.
 */
function globToRegExp(pattern: string): RegExp {
  // Scanned left to right rather than by chained `replace` calls: a chain has to
  // park intermediate results in sentinel characters, and any sentinel that can
  // also appear in a real path silently corrupts the pattern.
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      body += '(?:.*/)?'; // `libs/**/x` matches `libs/x` as well as `libs/a/x`
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      body += '.*'; // trailing `**`: any depth
      i += 2;
    } else if (pattern[i] === '*') {
      body += '[^/]*'; // lone `*`: within one segment
      i += 1;
    } else {
      // Everything else is literal, including `?`, `.` and `+`.
      body += escapeRegex(pattern[i]);
      i += 1;
    }
  }
  return new RegExp(`^${body}$`);
}

/**
 * The longest literal directory prefix of a pattern — the substring before the
 * first wildcard, truncated at the last separator.
 *
 * Walking from here rather than from the repo root means an unrelated subtree is
 * never listed: `libs/x/**` never touches `apps/`.
 */
function literalPrefix(pattern: string): string {
  const star = pattern.search(/[*?]/);
  const head = star === -1 ? pattern : pattern.slice(0, star);
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '' : head.slice(0, cut);
}

/** Files matching a glob, sorted. Empty when the prefix is gone — never throws. */
function resolveGlob(fs: FsProbe, pattern: string): string[] {
  const prefix = literalPrefix(pattern);
  // A prefix that no longer exists is the stale-glob case (outcome 3): return
  // empty and let the caller mark it unresolved, rather than raising.
  if (prefix !== '' && !fs.exists(prefix)) return [];
  const re = globToRegExp(pattern);
  return walkDirectory(fs, prefix).filter((f) => re.test(f));
}

/** Resolve one declared entry to the files it stands for, tagged by kind. */
function normalizeOne(declared: string, fs: FsProbe): NormalizedEntry {
  const kind = classifyEntry(declared, fs);
  const p = normalizePath(declared);

  let resolved: string[];
  switch (kind) {
    case 'malformed':
      // Deliberately contributes nothing. A prose entry that resolved to
      // something would let a sentence collide with a file.
      resolved = [];
      break;
    case 'glob':
      resolved = resolveGlob(fs, p);
      break;
    case 'directory':
      resolved = walkDirectory(fs, p);
      break;
    case 'file':
      // Includes paths that do not exist yet: the plan intends to create them.
      resolved = [p];
      break;
  }

  return Object.freeze({
    declared,
    kind,
    resolved: Object.freeze(resolved),
    unresolved: resolved.length === 0,
  });
}

/**
 * Normalise each declared entry, preserving declaration order.
 *
 * Order follows the plan, not the tree, so a gate can quote an entry back to its
 * author in the order they wrote it.
 */
export function normalizeEntries(
  declared: readonly string[],
  fs: FsProbe,
): readonly NormalizedEntry[] {
  return Object.freeze(
    declared
      // A blank list item is a YAML artefact, not a declaration. Dropping it is
      // not the same as the plan declaring nothing — see `declaredNothing`.
      .filter((d) => normalizePath(d) !== '')
      .map((d) => normalizeOne(d, fs)),
  );
}

/**
 * Normalise a plan's whole `files_modified` list.
 *
 * `declaredNothing` is set STRICTLY from `declared.length === 0` and is never
 * inferred from `files.length === 0` — outcome 3 (a stale glob) also produces an
 * empty `files`, and D-66 requires the two to stay independently observable.
 */
export function normalizePlanFiles(
  declared: readonly string[],
  fs: FsProbe,
): NormalizedPlanFiles {
  const entries = normalizeEntries(declared, fs);
  const union = new Set<string>();
  for (const entry of entries) for (const f of entry.resolved) union.add(f);

  return Object.freeze({
    entries,
    files: Object.freeze([...union].sort()),
    declaredNothing: declared.length === 0,
  });
}
