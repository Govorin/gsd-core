/**
 * Code graph — which module imports which, read from source with the
 * symbol-index lexer: no compiler, no language server, no external graph
 * (none of them exist in a user's runtime). Shared by the architecture survey
 * (`arch metrics`) and the window review pre-pass.
 *
 * ── Recognised, not guessed ──
 *
 * Each JS/TS file is LEXED first (`symbol-index.lex`: comments and strings
 * blanked, offsets kept), and import sites are found in what is left: an
 * `import … from '…'`, `export … from '…'`, a bare `import '…'`, `require('…')`
 * and `import('…')`. The specifier is then read back from the
 * strings-kept twin at the same offset. An import written inside a comment, a
 * docblock or a string literal is therefore not an import.
 *
 * ── Resolution ──
 *
 * A specifier resolves to a project file (an edge), to a package (`externals`
 * of the importing module), or to nothing — and nothing is never dropped: it
 * becomes an `unresolved` row carrying the reason.
 *
 *   - relative (`./x`, `../x`): against the importer's directory, with the
 *     TypeScript probing order (exact, `.js`→`.ts` style mapping, extensions,
 *     `index.*`);
 *   - alias: `compilerOptions.paths` of the root `tsconfig.json`,
 *     `tsconfig.base.json` (Nx), `tsconfig.build.json` and `jsconfig.json`
 *     (`TSCONFIG_CANDIDATES`), following `extends`
 *     (relative files and `node_modules` packages), with TypeScript's rules —
 *     an exact key beats a wildcard, the longest prefix wins, targets are tried
 *     in order, relative to `baseUrl` when one is set, else to the config file
 *     that declared `paths`;
 *   - `baseUrl`-relative bare specifiers, when a `baseUrl` is set and the file
 *     exists; any other bare specifier is a package;
 *   - emitted files: when a config sets `outDir` and `rootDir`, a specifier
 *     naming a file under `outDir` is followed to its source under `rootDir`,
 *     and a relative `require` in a source file is also tried from where its
 *     emitted file runs (`via: 'emitted'`) — the ADR-457 layout, where tests
 *     require `gsd-core/bin/lib/x.cjs` built from `src/x.cts`.
 *
 * A target must be a file the project lists (`listProjectFiles`: git-tracked
 * or untracked-but-not-ignored). A target that exists on disk but is ignored
 * (a build artefact) is `unresolved` with `not-in-file-set`, not an edge, so
 * generated code never shows up as a module.
 *
 * ── Shape ──
 *
 * Paths are root-relative and `/`-separated; `root` is a project's content
 * boundary (`project-root.projectRoots(...).content`), the same base
 * `git-history` reports paths in, so the two join on file keys. Every list is
 * sorted, so two builds of the same tree compare equal as JSON.
 *
 * ADR-457 build-at-publish: source in src/code-graph.cts, compiled to
 * gsd-core/bin/lib/code-graph.cjs (gitignored).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { lex, languageOf, listProjectFiles, lineStarts, lineAt, MAX_FILE_BYTES } from './symbol-index.cjs';
import type { Lexed, ListFiles, SkippedFile } from './symbol-index.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';

// ─── Types ───────────────────────────────────────────────────────────────────

/** How a module reaches another: the syntactic form of the import site. */
export type ImportKind = 'import' | 'export-from' | 'side-effect' | 'require' | 'dynamic';

/** How an edge's target was found. */
export type ResolvedVia = 'relative' | 'alias' | 'base-url' | 'emitted';

export interface ImportEdge {
  from: string;
  to: string;
  specifier: string;
  /** 1-based line of the specifier. */
  line: number;
  kind: ImportKind;
  /** `import type …` / `export type … from` — no runtime coupling. */
  typeOnly: boolean;
  /**
   * The exported names the site binds (`import { a, b as c }` → `['a', 'b']`, a default import →
   * `'default'`). `null` when the whole module may be used (namespace import, `export *`,
   * `require`, `import()`); `[]` for a side-effect import.
   */
  names: string[] | null;
  via: ResolvedVia;
}

export type UnresolvedReason =
  /** Relative or alias specifier whose target file does not exist. */
  | 'missing-target'
  /** The target exists on disk but the project does not list it (ignored / generated). */
  | 'not-in-file-set'
  /** The specifier resolves outside the root. */
  | 'outside-root'
  /** `require(x)` / `import(x)` with a computed specifier. */
  | 'non-literal'
  /** `#internal` package.json subpath import — not followed. */
  | 'subpath-import'
  /** An absolute filesystem specifier (`/abs/path`). */
  | 'absolute-specifier';

export interface UnresolvedImport {
  from: string;
  /** The specifier as written; for `non-literal`, the expression's first characters. */
  specifier: string;
  line: number;
  kind: ImportKind;
  reason: UnresolvedReason;
}

export interface ModuleNode {
  file: string;
  /** True when the file was lexed; false for an edge target outside `paths`. */
  scanned: boolean;
  /** Non-blank lines once comments are removed; null when not scanned. */
  loc: number | null;
  /** Exported bindings (ESM declarations and lists, CommonJS `exports.x` / `module.exports` keys); null when not scanned. */
  exports: number | null;
  /** Distinct package specifiers the module imports (`react`, `@scope/pkg`, `node:fs`). */
  externals: string[];
}

export interface AliasRule {
  /** The `paths` key, at most one `*`. */
  pattern: string;
  /** Root-relative targets (`*` kept), in declaration order. Null entries escaped the root. */
  targets: Array<string | null>;
  /** Root-relative config file that declared it. */
  source: string;
}

/** A compile step's `outDir` ← `rootDir`: a specifier naming an emitted file is followed to its source. */
export interface EmitMapping {
  outDir: string;
  rootDir: string;
  source: string;
}

export interface AliasConfig {
  rules: AliasRule[];
  /** Root-relative `baseUrl` ('' is the root itself); null when none is set. */
  baseUrl: string | null;
  emit: EmitMapping[];
  /** Root-relative config files read, in priority order. */
  sources: string[];
  /** What could not be followed (`extends` not found, unparsable JSON, a cycle), by name. */
  warnings: string[];
}

export interface ImportGraph {
  root: string;
  /** Root-relative path prefixes the scan was restricted to; null = whole project. */
  scope: string[] | null;
  nodes: ModuleNode[];
  edges: ImportEdge[];
  unresolved: UnresolvedImport[];
  /** JS/TS files not lexed (size limit / unreadable), by name. */
  skipped: SkippedFile[];
  aliases: AliasConfig;
}

export interface GraphOptions {
  /** Restrict the lexed files to these paths (root-relative or absolute inside the root). */
  paths?: readonly string[];
  /** Alias configuration; default `loadTsconfigAliases(root)`. */
  aliases?: AliasConfig;
  /** File lister seam (tests); default `listProjectFiles`. */
  listFiles?: ListFiles;
}

export interface ModuleStats {
  file: string;
  scanned: boolean;
  loc: number | null;
  exports: number | null;
  /** Distinct project modules importing this one. */
  fanIn: number;
  /** Distinct project modules this one imports. */
  fanOut: number;
  externals: number;
  /** Member of a strongly connected component (an import cycle). */
  inCycle: boolean;
}

export interface CycleOptions {
  /** Count `import type` edges (default true: a type cycle is still a design coupling). */
  includeTypeOnly?: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Root config files whose `paths` are read, highest priority first (an earlier file wins a duplicate key). */
export const TSCONFIG_CANDIDATES: readonly string[] = Object.freeze(['tsconfig.json', 'tsconfig.base.json', 'tsconfig.build.json', 'jsconfig.json']);

/** TypeScript's probing order for an extensionless specifier. */
const PROBE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** An ESM-style specifier names the emitted file; the source carries the TS extension. */
const EMITTED_TO_SOURCE: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
});

// ─── tsconfig aliases ────────────────────────────────────────────────────────

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function realOrResolved(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Root-relative POSIX form of an absolute path inside `root` ('' for the root). */
function relTo(root: string, abs: string): string {
  return toPosix(path.relative(root, abs));
}

/**
 * JSONC (comments, trailing commas) through the same lexer the graph uses: comments are blanked
 * by `lex`, and a trailing comma is removed only where the strings-blanked view shows it outside
 * a string.
 */
export function parseJsonc(text: string): unknown {
  const lx = lex(text, 'ts');
  const drop = new Set<number>();
  const trailing = /,(\s*[}\]])/g;
  for (let m = trailing.exec(lx.code); m !== null; m = trailing.exec(lx.code)) drop.add(m.index);
  let out = '';
  for (let i = 0; i < lx.codeWithStrings.length; i++) if (!drop.has(i)) out += lx.codeWithStrings[i];
  return JSON.parse(out);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface LoadedOptions {
  /** Absolute; the config that set it decides its base. */
  baseUrl?: string;
  paths?: { entries: Record<string, string[]>; dir: string; source: string };
  /** Absolute. */
  outDir?: string;
  rootDir?: string;
}

/** Candidate files an `extends` entry may name, absolute, in TypeScript's lookup order. */
function extendsCandidates(spec: string, fromDir: string, root: string): string[] {
  const withJson = (p: string): string[] => (p.endsWith('.json') ? [p] : [p, `${p}.json`]);
  if (spec.startsWith('.') || path.isAbsolute(spec)) return withJson(path.resolve(fromDir, spec));
  const pkg = path.join(root, 'node_modules', spec);
  return [...withJson(pkg), path.join(pkg, 'tsconfig.json')];
}

/**
 * The effective options of one config file, its `extends` chain applied (a later parent overrides
 * an earlier one, the file overrides its parents). `chain` holds the files above this one, so a
 * cycle is caught on the chain while a diamond (two parents sharing a grandparent) is not.
 */
function loadConfigChain(abs: string, root: string, warnings: string[], chain: ReadonlySet<string>): LoadedOptions | null {
  const rel = relTo(root, abs);
  if (chain.has(abs)) {
    warnings.push(`extends-cycle:${rel}`);
    return null;
  }
  const below = new Set(chain).add(abs);
  let parsed: unknown;
  try {
    parsed = parseJsonc(fs.readFileSync(abs, 'utf-8'));
  } catch {
    warnings.push(`unparsable:${rel}`);
    return null;
  }
  if (!isRecord(parsed)) {
    warnings.push(`unparsable:${rel}`);
    return null;
  }
  const dir = path.dirname(abs);
  let merged: LoadedOptions = {};
  const ext = parsed.extends;
  const parents = typeof ext === 'string' ? [ext] : Array.isArray(ext) ? ext.filter((e): e is string => typeof e === 'string') : [];
  for (const spec of parents) {
    const found = extendsCandidates(spec, dir, root)
      .map((c) => tryWithinRoot(c, root, PathAcceptance.AbsoluteInsideRoot))
      .find((c): c is NonNullable<typeof c> => c !== null && fs.existsSync(c) && fs.statSync(c).isFile());
    if (found === undefined) {
      warnings.push(`extends-not-found:${rel}->${spec}`);
      continue;
    }
    const parent = loadConfigChain(found, root, warnings, below);
    if (parent !== null) merged = { ...merged, ...parent };
  }
  const co = parsed.compilerOptions;
  if (isRecord(co)) {
    if (typeof co.baseUrl === 'string') merged.baseUrl = path.resolve(dir, co.baseUrl);
    if (typeof co.outDir === 'string') merged.outDir = path.resolve(dir, co.outDir);
    if (typeof co.rootDir === 'string') merged.rootDir = path.resolve(dir, co.rootDir);
    if (isRecord(co.paths)) {
      const entries: Record<string, string[]> = {};
      for (const [key, targets] of Object.entries(co.paths)) {
        if (Array.isArray(targets)) entries[key] = targets.filter((t): t is string => typeof t === 'string');
      }
      merged.paths = { entries, dir, source: rel };
    }
  }
  return merged;
}

/**
 * The alias rules of the root config files (`TSCONFIG_CANDIDATES`, or `configs` when given),
 * each with its `extends` chain applied. A key declared by an earlier file wins.
 */
export function loadTsconfigAliases(root: string, opts: { configs?: readonly string[] } = {}): AliasConfig {
  // tryWithinRoot answers with realpaths; relative paths are taken against the real root too.
  const real = realOrResolved(root);
  const config: AliasConfig = { rules: [], baseUrl: null, emit: [], sources: [], warnings: [] };
  const byPattern = new Set<string>();
  /** Root-relative form of an absolute path, or null when it lies outside the root. */
  const inside = (abs: string): string | null => {
    const rel = path.relative(real, abs);
    return rel.startsWith('..') || path.isAbsolute(rel) ? null : toPosix(rel);
  };
  for (const candidate of opts.configs ?? TSCONFIG_CANDIDATES) {
    const abs = tryWithinRoot(path.resolve(real, candidate), real, PathAcceptance.AbsoluteInsideRoot);
    if (abs === null) {
      config.warnings.push(`outside-root:${candidate}`);
      continue;
    }
    if (!fs.existsSync(abs)) continue;
    const loaded = loadConfigChain(abs, real, config.warnings, new Set());
    if (loaded === null) continue;
    const source = relTo(real, abs);
    config.sources.push(source);
    if (config.baseUrl === null && loaded.baseUrl !== undefined) {
      const base = inside(loaded.baseUrl);
      if (base !== null) config.baseUrl = base;
      else config.warnings.push(`base-url-outside-root:${source}`);
    }
    if (loaded.outDir !== undefined && loaded.rootDir !== undefined) {
      const outDir = inside(loaded.outDir);
      const rootDir = inside(loaded.rootDir);
      if (outDir !== null && rootDir !== null && outDir !== rootDir && !config.emit.some((e) => e.outDir === outDir)) {
        config.emit.push({ outDir, rootDir, source });
      }
    }
    if (loaded.paths === undefined) continue;
    const base = loaded.baseUrl ?? loaded.paths.dir;
    for (const [pattern, targets] of Object.entries(loaded.paths.entries)) {
      if (byPattern.has(pattern) || (pattern.match(/\*/g) ?? []).length > 1) continue;
      byPattern.add(pattern);
      config.rules.push({ pattern, targets: targets.map((t) => inside(path.resolve(base, t))), source: loaded.paths.source });
    }
  }
  config.rules.sort((a, b) => (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0));
  return config;
}

/** TypeScript's choice: an exact key, else the wildcard key with the longest prefix. */
function matchAlias(rules: readonly AliasRule[], specifier: string): { rule: AliasRule; star: string } | null {
  let best: { rule: AliasRule; star: string; prefix: number } | null = null;
  for (const rule of rules) {
    const star = rule.pattern.indexOf('*');
    if (star === -1) {
      if (rule.pattern === specifier) return { rule, star: '' };
      continue;
    }
    const prefix = rule.pattern.slice(0, star);
    const suffix = rule.pattern.slice(star + 1);
    if (specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      if (best === null || prefix.length > best.prefix) {
        best = { rule, star: specifier.slice(prefix.length, specifier.length - suffix.length), prefix: prefix.length };
      }
    }
  }
  return best === null ? null : { rule: best.rule, star: best.star };
}

// ─── Import sites ────────────────────────────────────────────────────────────

interface ImportSite {
  specifier: string | null;
  /** First characters of a computed specifier (`non-literal`). */
  expression?: string;
  line: number;
  kind: ImportKind;
  typeOnly: boolean;
  names: string[] | null;
}

/** `from '`, `import '`, `require(` / `import(` — keyword not preceded by `.` or a word character. */
const SITE_RE = /(?<![\w$.])(?:(from|import)\s*(['"])|(require|import)\s*\(\s*)/g;
const STATEMENT_KEYWORD_RE = /(?<![\w$.])(import|export)(?![\w$])/g;
/**
 * `import type …` / `export type …` clause (the text between the keyword and `from`) — but not a
 * default import NAMED `type` (`import type from`), whose clause is `type` alone.
 */
const TYPE_CLAUSE_RE = /^\s*type\s+(?=\S)/;

/** The string literal opening at `quote` in `withStrings`, or null when it does not close on its line. */
function literalAt(withStrings: string, quote: number): string | null {
  const q = withStrings[quote];
  const end = withStrings.indexOf(q, quote + 1);
  if (end === -1) return null;
  const body = withStrings.slice(quote + 1, end);
  if (q !== '`' && body.includes('\n')) return null;
  if (q === '`' && body.includes('${')) return null;
  return body;
}

/** Exported names an import/export clause binds (see `ImportEdge.names`). */
function clauseNames(clause: string, statement: 'import' | 'export'): string[] | null {
  const body = clause.replace(TYPE_CLAUSE_RE, '').trim();
  if (body === '') return [];
  if (/^\*/.test(body)) return null;
  const names: string[] = [];
  const brace = body.indexOf('{');
  const head = (brace === -1 ? body : body.slice(0, brace)).replace(/,\s*$/, '').trim();
  if (head !== '') {
    if (/\*\s*as\s+[\w$]+/.test(head)) return null;
    if (statement === 'import' && /^[\w$]+$/.test(head)) names.push('default');
  }
  if (brace !== -1) {
    const close = body.indexOf('}', brace);
    const inner = body.slice(brace + 1, close === -1 ? body.length : close);
    for (const part of inner.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (name !== '') names.push(name);
    }
  }
  return [...new Set(names)].sort();
}

interface Keyword {
  at: number;
  end: number;
  word: 'import' | 'export';
}

/**
 * The `import`/`export` keyword that owns the `from` at `fromAt` — the last one before it, found by
 * binary search over every keyword of the file — and the clause between them.
 */
function owningClause(code: string, keywords: readonly Keyword[], fromAt: number): { statement: 'import' | 'export'; clause: string } | null {
  let lo = 0;
  let hi = keywords.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keywords[mid].at < fromAt) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  const kw = keywords[found];
  const clause = code.slice(kw.end, fromAt);
  if (clause.includes(';')) return null;
  return { statement: kw.word, clause };
}

/** Every import site of a lexed JS/TS text. */
export function importSites(text: string, lexed: Lexed = lex(text, 'ts')): ImportSite[] {
  const { code, codeWithStrings } = lexed;
  const starts = lineStarts(text);
  const keywords: Keyword[] = [...code.matchAll(STATEMENT_KEYWORD_RE)].map((k) => ({
    at: k.index, end: k.index + k[0].length, word: k[1] as 'import' | 'export',
  }));
  const sites: ImportSite[] = [];
  SITE_RE.lastIndex = 0;
  for (let m = SITE_RE.exec(code); m !== null; m = SITE_RE.exec(code)) {
    if (m[1] !== undefined) {
      // `from '…'` or a bare `import '…'`: the quote is the last character of the match.
      const quote = m.index + m[0].length - 1;
      const specifier = literalAt(codeWithStrings, quote);
      const line = lineAt(starts, quote);
      if (m[1] === 'import') {
        sites.push({ specifier, line, kind: 'side-effect', typeOnly: false, names: [] });
        continue;
      }
      const owner = owningClause(code, keywords, m.index);
      const statement = owner?.statement ?? 'import';
      const typeOnly = owner !== null && TYPE_CLAUSE_RE.test(owner.clause);
      sites.push({
        specifier,
        line,
        kind: statement === 'export' ? 'export-from' : 'import',
        typeOnly,
        names: owner === null ? null : clauseNames(owner.clause, statement),
      });
      continue;
    }
    const open = m.index + m[0].length;
    const kind: ImportKind = m[3] === 'require' ? 'require' : 'dynamic';
    const ch = code[open];
    const line = lineAt(starts, open);
    if (ch === "'" || ch === '"' || ch === '`') {
      const specifier = literalAt(codeWithStrings, open);
      const closes = specifier !== null && /^\s*[),]/.test(code.slice(open + specifier.length + 2, open + specifier.length + 40));
      if (specifier !== null && closes) {
        sites.push({ specifier, line, kind, typeOnly: false, names: null });
        continue;
      }
    }
    if (ch === ')') continue; // `require()` / `import()` with no argument: nothing to resolve.
    const expression = codeWithStrings.slice(open, open + 40).split('\n')[0].replace(/\s+/g, ' ').trim();
    sites.push({ specifier: null, expression, line, kind, typeOnly: false, names: null });
  }
  return sites;
}

// ─── Exports and LOC ─────────────────────────────────────────────────────────

const ESM_DECL_EXPORT_RE =
  /(?<![\w$.])export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type(?!\s*\{)|enum|namespace|module)\s+[\w$]+/g;
const ESM_LIST_EXPORT_RE = /(?<![\w$.])export\s+(?:type\s+)?\{([^}]*)\}/g;
const ESM_OTHER_EXPORT_RE = /(?<![\w$.])export\s+(?:default\b|\*)/g;
const CJS_PROP_EXPORT_RE = /(?<![\w$.])(?:module\s*\.\s*)?exports\s*\.\s*([\w$]+)\s*=(?!=)/g;
/** `module.exports = …` and TypeScript's `export = …`: an object literal counts its keys. */
const CJS_OBJECT_EXPORT_RE = /(?<![\w$.])(?:module\s*\.\s*exports|export)\s*=(?!=)\s*/g;

/** Top-level entries of the object literal opening at `open` (strings already blanked). */
function objectEntries(code: string, open: number): number {
  let depth = 0;
  let count = 0;
  let pending = false;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      if (depth > 1) pending = true;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return count + (pending ? 1 : 0);
      continue;
    }
    if (depth === 1 && c === ',') {
      if (pending) count++;
      pending = false;
    } else if (depth === 1 && !/\s/.test(c)) {
      pending = true;
    }
  }
  return count + (pending ? 1 : 0);
}

/** Exported bindings of a lexed (strings-blanked) JS/TS text. */
export function countExports(code: string): number {
  let n = 0;
  n += (code.match(ESM_DECL_EXPORT_RE) ?? []).length;
  n += (code.match(ESM_OTHER_EXPORT_RE) ?? []).length;
  for (const m of code.matchAll(ESM_LIST_EXPORT_RE)) n += m[1].split(',').filter((s) => s.trim() !== '').length;
  n += new Set([...code.matchAll(CJS_PROP_EXPORT_RE)].map((m) => m[1])).size;
  for (const m of code.matchAll(CJS_OBJECT_EXPORT_RE)) {
    const at = m.index + m[0].length;
    n += code[at] === '{' ? objectEntries(code, at) : 1;
  }
  return n;
}

function countLoc(withStrings: string): number {
  let n = 0;
  for (const line of withStrings.split('\n')) if (line.trim() !== '') n++;
  return n;
}

// ─── Resolution ──────────────────────────────────────────────────────────────

type Resolution =
  | { kind: 'internal'; to: string; via: ResolvedVia }
  | { kind: 'external'; pkg: string }
  | { kind: 'unresolved'; reason: UnresolvedReason };

/** When every candidate fails, the most informative reason is reported. */
const REASON_RANK: Readonly<Record<UnresolvedReason, number>> = Object.freeze({
  'not-in-file-set': 3, 'missing-target': 2, 'outside-root': 1, 'non-literal': 0, 'subpath-import': 0, 'absolute-specifier': 0,
});

/** `file` is `dir` or lies below it (root-relative POSIX keys; `''` is the root). */
function under(file: string, dir: string): boolean {
  return dir === '' || file === dir || file.startsWith(`${dir}/`); // allow-handrolled-containment: identity/prefix matching of root-relative keys, not a filesystem containment decision
}

class Resolver {
  constructor(
    private readonly root: string,
    private readonly files: ReadonlySet<string>,
    private readonly aliases: AliasConfig,
  ) {}

  /** TypeScript's probing order for a root-relative candidate. */
  private static tries(candidate: string): string[] {
    const tries: string[] = [candidate];
    const ext = path.posix.extname(candidate);
    for (const src of EMITTED_TO_SOURCE[ext] ?? []) tries.push(candidate.slice(0, -ext.length) + src);
    if (candidate !== '') for (const e of PROBE_EXTENSIONS) tries.push(candidate + e);
    const dir = candidate === '' ? '' : `${candidate}/`;
    for (const e of PROBE_EXTENSIONS) tries.push(`${dir}index${e}`);
    return tries;
  }

  /**
   * A listed file for a root-relative candidate — directly, else through an `outDir` → `rootDir`
   * mapping (`emitted`) — or why not.
   */
  private probe(candidate: string): { to: string; emitted: boolean } | { reason: UnresolvedReason } {
    const direct = Resolver.tries(candidate);
    for (const t of direct) if (this.files.has(t)) return { to: t, emitted: false };
    for (const e of this.aliases.emit) {
      if (!under(candidate, e.outDir)) continue;
      const mapped = path.posix.join(e.rootDir, candidate.slice(e.outDir.length));
      for (const t of Resolver.tries(mapped)) if (this.files.has(t)) return { to: t, emitted: true };
    }
    for (const t of direct) {
      const abs = tryWithinRoot(path.join(this.root, t), this.root, PathAcceptance.AbsoluteInsideRoot);
      if (abs !== null && fs.existsSync(abs) && fs.statSync(abs).isFile()) return { reason: 'not-in-file-set' };
    }
    return { reason: 'missing-target' };
  }

  /** Normalised root-relative form of `joined`, or null when it climbs above the root. */
  private inside(joined: string): string | null {
    const norm = path.posix.normalize(joined);
    if (norm === '..' || norm.startsWith('../') || path.posix.isAbsolute(norm)) return null;
    return norm === '.' ? '' : norm;
  }

  /**
   * A relative specifier, from the importer's directory and then — for a source under a `rootDir`
   * — from where its emitted file runs (a `require` of a non-compiled file is written against the
   * emitted location).
   */
  private resolveRelative(from: string, specifier: string): Resolution {
    const dirs = [path.posix.dirname(from)];
    for (const e of this.aliases.emit) {
      if (under(from, e.rootDir)) dirs.push(path.posix.dirname(path.posix.join(e.outDir, from.slice(e.rootDir.length))));
    }
    let reason: UnresolvedReason | null = null;
    for (let i = 0; i < dirs.length; i++) {
      const candidate = this.inside(path.posix.join(dirs[i], specifier));
      const hit: ReturnType<Resolver['probe']> = candidate === null ? { reason: 'outside-root' } : this.probe(candidate);
      if ('to' in hit) return { kind: 'internal', to: hit.to, via: i === 0 && !hit.emitted ? 'relative' : 'emitted' };
      if (reason === null || REASON_RANK[hit.reason] > REASON_RANK[reason]) reason = hit.reason;
    }
    return { kind: 'unresolved', reason: reason ?? 'missing-target' };
  }

  resolve(from: string, specifier: string): Resolution {
    if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) {
      return this.resolveRelative(from, specifier);
    }
    if (specifier.startsWith('/')) return { kind: 'unresolved', reason: 'absolute-specifier' };
    if (specifier.startsWith('#')) return { kind: 'unresolved', reason: 'subpath-import' };
    const alias = matchAlias(this.aliases.rules, specifier);
    if (alias !== null) {
      let reason: UnresolvedReason = 'missing-target';
      for (const target of alias.rule.targets) {
        if (target === null) {
          reason = 'outside-root';
          continue;
        }
        const candidate = this.inside(target.replace('*', alias.star));
        if (candidate === null) {
          reason = 'outside-root';
          continue;
        }
        const hit = this.probe(candidate);
        if ('to' in hit) return { kind: 'internal', to: hit.to, via: hit.emitted ? 'emitted' : 'alias' };
        if (hit.reason === 'not-in-file-set') reason = hit.reason;
      }
      return { kind: 'unresolved', reason };
    }
    if (this.aliases.baseUrl !== null) {
      const candidate = this.inside(path.posix.join(this.aliases.baseUrl, specifier));
      if (candidate !== null) {
        const hit = this.probe(candidate);
        if ('to' in hit) return { kind: 'internal', to: hit.to, via: 'base-url' };
      }
    }
    const parts = specifier.split('/');
    return { kind: 'external', pkg: specifier.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0] };
  }
}

// ─── Build ───────────────────────────────────────────────────────────────────

function normaliseScope(root: string, paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const abs = tryWithinRoot(path.resolve(root, p), root, PathAcceptance.AbsoluteInsideRoot);
    if (abs === null) throw new Error(`code-graph: path outside the root: ${p}`);
    // Containment is decided on the realpath above; the scope key is lexical, like the listed files.
    out.add(relTo(path.resolve(root), path.resolve(root, p)).replace(/\/+$/, ''));
  }
  return [...out].sort();
}

function inScope(file: string, scope: readonly string[] | null): boolean {
  if (scope === null) return true;
  return scope.some((s) => under(file, s));
}

function byKey<T>(key: (t: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

/**
 * The import graph of `root`'s JS/TS files. With `paths`, only files under those paths are lexed;
 * their targets elsewhere still resolve (as unscanned nodes), but fan-in then counts importers
 * inside the scanned set only.
 */
export function buildImportGraph(root: string, opts: GraphOptions = {}): ImportGraph {
  const listed = (opts.listFiles ?? listProjectFiles)(root).map(toPosix);
  const files = new Set(listed);
  const scope = opts.paths === undefined ? null : normaliseScope(root, opts.paths);
  const aliases = opts.aliases ?? loadTsconfigAliases(root);
  const resolver = new Resolver(root, files, aliases);

  const nodes = new Map<string, ModuleNode>();
  const edges: ImportEdge[] = [];
  const unresolved: UnresolvedImport[] = [];
  const skipped: SkippedFile[] = [];

  for (const rel of [...listed].sort()) {
    if (languageOf(rel) !== 'ts' || !inScope(rel, scope)) continue;
    const abs = path.join(root, rel);
    let text: string;
    try {
      if (fs.statSync(abs).size > MAX_FILE_BYTES) {
        skipped.push({ file: rel, reason: 'too_large' });
        continue;
      }
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      if (fs.existsSync(abs)) skipped.push({ file: rel, reason: 'unreadable' });
      continue; // listed by git but deleted in the work tree
    }
    const lx = lex(text, 'ts');
    const externals = new Set<string>();
    for (const site of importSites(text, lx)) {
      if (site.specifier === null) {
        unresolved.push({ from: rel, specifier: site.expression ?? '', line: site.line, kind: site.kind, reason: 'non-literal' });
        continue;
      }
      const r = resolver.resolve(rel, site.specifier);
      if (r.kind === 'external') externals.add(r.pkg);
      else if (r.kind === 'unresolved') {
        unresolved.push({ from: rel, specifier: site.specifier, line: site.line, kind: site.kind, reason: r.reason });
      } else {
        edges.push({
          from: rel, to: r.to, specifier: site.specifier, line: site.line,
          kind: site.kind, typeOnly: site.typeOnly, names: site.names, via: r.via,
        });
      }
    }
    nodes.set(rel, {
      file: rel, scanned: true, loc: countLoc(lx.codeWithStrings), exports: countExports(lx.code),
      externals: [...externals].sort(),
    });
  }
  for (const e of edges) {
    if (!nodes.has(e.to)) nodes.set(e.to, { file: e.to, scanned: false, loc: null, exports: null, externals: [] });
  }

  return {
    root,
    scope,
    nodes: [...nodes.values()].sort(byKey((n) => n.file)),
    edges: edges.sort((a, b) => byKey<ImportEdge>((e) => e.from)(a, b) || a.line - b.line || byKey<ImportEdge>((e) => e.to)(a, b)),
    unresolved: unresolved.sort((a, b) => byKey<UnresolvedImport>((u) => u.from)(a, b) || a.line - b.line),
    skipped,
    aliases,
  };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

function adjacency(graph: ImportGraph, reverse: boolean, includeTypeOnly = true): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const n of graph.nodes) sets.set(n.file, new Set());
  for (const e of graph.edges) {
    if (!includeTypeOnly && e.typeOnly) continue;
    const [a, b] = reverse ? [e.to, e.from] : [e.from, e.to];
    sets.get(a)?.add(b);
  }
  const out = new Map<string, string[]>();
  for (const [k, v] of sets) out.set(k, [...v].sort());
  return out;
}

/** For every node, the distinct project modules importing it (self-imports included as-is). */
export function fanIn(graph: ImportGraph): Map<string, string[]> {
  return adjacency(graph, true);
}

/** For every node, the distinct project modules it imports. */
export function fanOut(graph: ImportGraph): Map<string, string[]> {
  return adjacency(graph, false);
}

/**
 * Import cycles: strongly connected components of two or more modules, plus a module that
 * imports itself. Each component is sorted; components are ordered largest first, then by their
 * first member. Iterative Tarjan, so a deep chain cannot overflow the stack.
 */
export function stronglyConnected(graph: ImportGraph, opts: CycleOptions = {}): string[][] {
  const adj = adjacency(graph, false, opts.includeTypeOnly ?? true);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of adj.keys()) {
    if (index.has(start)) continue;
    const work: Array<{ node: string; next: number }> = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter++;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const succ = adj.get(frame.node) ?? [];
      if (frame.next < succ.length) {
        const w = succ[frame.next++];
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ node: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(w)!));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1].node;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.node);
        const selfLoop = component.length === 1 && (adj.get(frame.node) ?? []).includes(frame.node);
        if (component.length > 1 || selfLoop) components.push(component.sort());
      }
    }
  }
  return components.sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Per-module size and coupling, sorted by file. Fan counts exclude self-imports. */
export function moduleStats(graph: ImportGraph, opts: CycleOptions = {}): ModuleStats[] {
  const ins = fanIn(graph);
  const outs = fanOut(graph);
  const cyclic = new Set(stronglyConnected(graph, opts).flat());
  return graph.nodes.map((n) => ({
    file: n.file,
    scanned: n.scanned,
    loc: n.loc,
    exports: n.exports,
    fanIn: (ins.get(n.file) ?? []).filter((f) => f !== n.file).length,
    fanOut: (outs.get(n.file) ?? []).filter((f) => f !== n.file).length,
    externals: n.externals.length,
    inCycle: cyclic.has(n.file),
  }));
}
