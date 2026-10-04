/**
 * Symbol Index — which names a project DECLARES, read from its source without
 * a compiler, a language server or a graph (none of them exist in a user's
 * runtime).
 *
 * ── A recognizer, not an interpreter ──
 *
 * The question a diagram check asks is "is `FakeThingRepository` a thing in
 * this code?". A text search answers a different question — "does the string
 * occur?" — and is wrong in exactly the ways that matter: it finds the name in
 * a comment, a docblock, a log string, a build artefact. So each file is first
 * LEXED (comments, strings and template literals blanked, line numbers kept),
 * and only then do line-anchored declaration patterns run over what is left:
 * `class X`, `interface X`, `type X =`, `function X`, `const X =`, class and
 * interface members, `export { X }`; Python `class`/`def`; Go `type X struct`,
 * `func (r T) X`; Drizzle `pgTable('x', …)`, Zod `z.object({…})`, Prisma
 * `model X`, SQL `CREATE TABLE x`.
 *
 * ── Refuse to guess ──
 *
 * `lookup` answers in three words, and the asymmetry is the design:
 *
 *   - `declared`  — a declaration of the right kind (and owner) was recognised;
 *   - `ambiguous` — the name exists but not as asked (another kind/owner), or it
 *                   only occurs in code the recognizer does not understand (a
 *                   re-export it cannot follow, an unsupported language, a file
 *                   over the size limit);
 *   - `absent`    — no declaration and no occurrence anywhere in the code.
 *
 * `absent` is the only blocking answer, and by construction it can only be
 * given when NOTHING in the tree — parsed or not — spells the name. A false
 * `absent` would need the name to be declared without ever appearing as an
 * identifier token, which no supported or unsupported language allows.
 *
 * File set: `git ls-files -co --exclude-standard` (so `.gitignore` is
 * honoured); outside a git work tree, a walk that skips dependency, build and
 * planning directories. Files over `MAX_FILE_BYTES` are not lexed.
 *
 * ADR-457 build-at-publish: source in src/symbol-index.cts, compiled to
 * gsd-core/bin/lib/symbol-index.cjs (gitignored).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit } from './shell-command-projection.cjs';
import { escapeRegex } from './pattern.cjs';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DeclKind =
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'function'
  | 'method'
  | 'const'
  | 'table'
  | 'schema'
  | 'field'
  | 'export'
  | 'module';

export interface Decl {
  name: string;
  kind: DeclKind;
  /** Project-relative, `/`-separated. */
  file: string;
  /** 1-based. */
  line: number;
  /** The class/interface/struct/table/schema a method or field belongs to. */
  owner?: string;
  /** Words of an `extends`/`implements` clause (classes and interfaces in TS/JS/Python). */
  heritage?: string[];
}

export type Language = 'ts' | 'py' | 'go' | 'prisma' | 'sql';

export interface SkippedFile {
  file: string;
  reason: 'too_large' | 'unreadable';
}

export interface SymbolIndex {
  root: string;
  decls: Map<string, Decl[]>;
  /** Every identifier token in lexed code (comments and strings excluded). */
  mentioned: Set<string>;
  /** Identifier tokens of source files in languages the recognizer does not parse. */
  foreignWords: Set<string>;
  /** Supported-language files not lexed (size limit / unreadable); searched only on demand. */
  skipped: SkippedFile[];
  scanned: number;
}

export type Verdict = 'declared' | 'ambiguous' | 'absent';

export interface LookupResult {
  verdict: Verdict;
  /** `file:line` of the declaration that decided the verdict, when there is one. */
  at?: string;
  note?: string;
}

/** A file is lexed only up to this size; larger files are `skipped` (searched as raw text on demand). */
export const MAX_FILE_BYTES = 1024 * 1024;

const LANGUAGE_BY_EXT: Readonly<Record<string, Language>> = Object.freeze({
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.py': 'py', '.pyi': 'py',
  '.go': 'go',
  '.prisma': 'prisma',
  '.sql': 'sql',
});

/** Source code the recognizer does not parse: it can make a name `ambiguous`, never `declared` or `absent`. */
const FOREIGN_EXT: ReadonlySet<string> = new Set([
  '.java', '.kt', '.kts', '.scala', '.groovy', '.cs', '.fs', '.vb', '.rs', '.swift', '.m', '.mm',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.rb', '.php', '.dart', '.ex', '.exs', '.erl',
  '.hrl', '.clj', '.cljs', '.lua', '.vue', '.svelte', '.astro', '.graphql', '.gql', '.proto',
]);

/** Directories never walked when the root is not a git work tree. */
const WALK_EXCLUDES: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage', '.planning', 'docs', '.git',
  'vendor', 'target', '__pycache__', '.venv', 'venv', '.turbo', '.cache',
]);

export function languageOf(file: string): Language | null {
  return LANGUAGE_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

// ─── Lexers ──────────────────────────────────────────────────────────────────

export interface Lexed {
  /** Comments AND strings blanked to spaces; newlines kept. Same length as the input. */
  code: string;
  /** Comments blanked, strings kept. Same length as the input. */
  codeWithStrings: string;
}

/** Characters a C-like regex literal may follow (anything else makes `/` a division). */
const REGEX_PRECEDER = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_KEYWORD_PRECEDER = /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * One lexer per family. Each walks the text once and records [start, end)
 * spans of comments and strings; `code` blanks both, `codeWithStrings` blanks
 * comments only. Offsets are preserved, so a match position in `code` reads
 * the same characters in `codeWithStrings`.
 */
export function lex(text: string, lang: Language): Lexed {
  const comments: Array<[number, number]> = [];
  const strings: Array<[number, number]> = [];
  if (lang === 'ts' || lang === 'go' || lang === 'prisma') lexCLike(text, lang, comments, strings);
  else if (lang === 'py') lexPython(text, comments, strings);
  else lexSql(text, comments, strings);
  const apply = (spans: Array<[number, number]>, base: string): string => {
    if (spans.length === 0) return base;
    let out = '';
    let at = 0;
    for (const [s, e] of spans) {
      out += base.slice(at, s) + blank(base.slice(s, e));
      at = e;
    }
    return out + base.slice(at);
  };
  const codeWithStrings = apply(comments, text);
  const all = [...comments, ...strings].sort((a, b) => a[0] - b[0]);
  return { code: apply(all, text), codeWithStrings };
}

function lexCLike(text: string, lang: Language, comments: Array<[number, number]>, strings: Array<[number, number]>): void {
  const n = text.length;
  let i = 0;
  /** Brace depth of each open `${` inside a template literal (TS only). */
  const templateStack: number[] = [];
  let braceDepth = 0;
  let lastSignificant = '';
  let lastWordEnd = 0;

  const scanTemplate = (start: number): void => {
    // `start` is just after the opening backtick or a closing `}` of `${…}`.
    let j = start;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        strings.push([start, j]);
        i = j + 1;
        lastSignificant = '`';
        return;
      }
      if (lang === 'ts' && c === '$' && text[j + 1] === '{') {
        strings.push([start, j]);
        templateStack.push(braceDepth);
        braceDepth++;
        i = j + 2;
        lastSignificant = '{';
        return;
      }
      j++;
    }
    strings.push([start, n]);
    i = n;
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '"' || (c === "'" && lang !== 'prisma')) {
      if (lang === 'go' && c === "'") {
        // rune literal
        let j = i + 1;
        while (j < n && text[j] !== "'" && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
        strings.push([i + 1, Math.min(j, n)]);
        i = j + 1;
        lastSignificant = "'";
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      strings.push([i + 1, Math.min(j, n)]);
      i = j + 1;
      lastSignificant = c;
      continue;
    }
    if (c === '`') {
      if (lang === 'go') {
        const end = text.indexOf('`', i + 1);
        const stop = end === -1 ? n : end;
        strings.push([i + 1, stop]);
        i = stop + 1;
        lastSignificant = '`';
        continue;
      }
      if (lang === 'ts') {
        scanTemplate(i + 1);
        continue;
      }
    }
    if (lang === 'ts' && c === '/') {
      const before = text.slice(Math.max(0, i - 12), i).replace(/\s+$/, '');
      const prevChar = lastSignificant;
      const isRegex =
        prevChar === '' ||
        REGEX_PRECEDER.test(prevChar) ||
        (lastWordEnd > 0 && REGEX_KEYWORD_PRECEDER.test(before));
      if (isRegex) {
        let j = i + 1;
        let inClass = false;
        while (j < n && text[j] !== '\n') {
          const d = text[j];
          if (d === '\\') {
            j += 2;
            continue;
          }
          if (d === '[') inClass = true;
          else if (d === ']') inClass = false;
          else if (d === '/' && !inClass) break;
          j++;
        }
        if (j < n && text[j] === '/') {
          strings.push([i + 1, j]);
          i = j + 1;
          while (i < n && /[a-z]/i.test(text[i])) i++;
          lastSignificant = '/';
          continue;
        }
      }
    }
    if (lang === 'ts' && c === '{') braceDepth++;
    if (lang === 'ts' && c === '}') {
      if (templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth - 1) {
        braceDepth--;
        templateStack.pop();
        scanTemplate(i + 1);
        continue;
      }
      braceDepth--;
    }
    if (!/\s/.test(c)) {
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j++;
        lastSignificant = text[j - 1];
        lastWordEnd = j;
        i = j;
        continue;
      }
      lastSignificant = c;
      lastWordEnd = 0;
    }
    i++;
  }
}

function lexPython(text: string, comments: Array<[number, number]>, strings: Array<[number, number]>): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '#') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = text.startsWith(c.repeat(3), i);
      if (triple) {
        const end = text.indexOf(c.repeat(3), i + 3);
        const stop = end === -1 ? n : end;
        strings.push([i + 3, stop]);
        i = stop + 3;
        continue;
      }
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      strings.push([i + 1, Math.min(j, n)]);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(c)) {
      // Skip a whole word so a string prefix (r"", f'') is not read as its own token.
      while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
      continue;
    }
    i++;
  }
}

function lexSql(text: string, comments: Array<[number, number]>, strings: Array<[number, number]>): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      comments.push([i, stop]);
      i = stop;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (text[j] === "'") break;
        j++;
      }
      strings.push([i + 1, Math.min(j, n)]);
      i = j + 1;
      continue;
    }
    i++;
  }
}

// ─── Body scanning helpers ───────────────────────────────────────────────────

const OPEN_BRACKET: Readonly<Record<string, string>> = Object.freeze({ '{': '}', '(': ')', '[': ']' });

/** Index of the bracket closing the one at `open` (in blanked code), or -1. */
function matchBracket(code: string, open: number): number {
  const opener = code[open];
  const closer = OPEN_BRACKET[opener];
  if (closer === undefined) return -1;
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    const c = code[j];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return c === closer ? j : -1;
    }
  }
  return -1;
}

/**
 * Start offsets of the depth-1 "segments" of a bracketed body: right after the
 * opening bracket and after every newline, `;` or `,` that sits at depth 1.
 */
function segmentStarts(code: string, open: number, close: number): number[] {
  const starts = [open + 1];
  let depth = 0;
  for (let j = open + 1; j < close; j++) {
    const c = code[j];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0 && (c === '\n' || c === ';' || c === ',')) starts.push(j + 1);
  }
  // A start is where its segment's first non-blank character sits; a blank-only
  // run between two separators would otherwise yield the same segment twice.
  const seen = new Set<number>();
  const out: number[] = [];
  for (const s of starts) {
    let k = s;
    while (k < close && /\s/.test(code[k])) k++;
    if (k < close && !seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

const WORD_RE = /[A-Za-z_$][\w$]*/g;

function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

/** The first string literal in `withStrings` between `from` and `to` (offsets shared with `code`). */
function firstString(withStrings: string, from: number, to: number): string | null {
  const m = /(['"`])([^'"`\n]*)\1/.exec(withStrings.slice(from, to));
  return m === null ? null : m[2];
}

// ─── Declaration extraction ──────────────────────────────────────────────────

interface Extracted {
  decls: Decl[];
}

const TS_PREFIX = String.raw`^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?`;
const TS_CLASS = new RegExp(`${TS_PREFIX}(?:abstract[ \\t]+)?class[ \\t]+([A-Za-z_$][\\w$]*)`, 'gm');
const TS_INTERFACE = new RegExp(`${TS_PREFIX}interface[ \\t]+([A-Za-z_$][\\w$]*)`, 'gm');
const TS_ENUM = new RegExp(`${TS_PREFIX}(?:const[ \\t]+)?enum[ \\t]+([A-Za-z_$][\\w$]*)`, 'gm');
const TS_TYPE = new RegExp(`${TS_PREFIX}type[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*(?:<[^=\\n]*>)?[ \\t]*=`, 'gm');
const TS_FUNCTION = new RegExp(`${TS_PREFIX}(?:async[ \\t]+)?function[ \\t]*\\*?[ \\t]*([A-Za-z_$][\\w$]*)`, 'gm');
const TS_VAR = new RegExp(`${TS_PREFIX}(?:const|let|var)[ \\t]+([A-Za-z_$][\\w$]*)[ \\t]*(?::[^=\\n]+)?=[ \\t]*`, 'gm');
const TS_EXPORT_LIST = /^[ \t]*export[ \t]+(?:type[ \t]+)?\{([^}]*)\}/gm;
const TS_EXPORT_STAR_AS = /^[ \t]*export[ \t]+\*[ \t]+as[ \t]+([A-Za-z_$][\w$]*)/gm;
const CJS_EXPORT_NAMED = /^[ \t]*(?:module\.)?exports\.([A-Za-z_$][\w$]*)[ \t]*=/gm;
const CJS_EXPORT_OBJECT = /^[ \t]*module\.exports[ \t]*=[ \t]*\{/gm;
const TS_MEMBER = /^\s*(?:(?:public|private|protected|static|readonly|abstract|override|declare|async|get|set|accessor)\s+)*(?:\*\s*)?#?([A-Za-z_$][\w$]*)\s*[?!]?\s*([(<:=;]|$)/;
const OBJECT_KEY = /^\s*(?:\.\.\.)?(?:(['"])([^'"\n]+)\1|([A-Za-z_$][\w$]*))\s*([:(,]|$)/;
const ARROW_OR_FUNCTION = /^(?:async\s+)?(?:function\b|\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/;

function heritageAfter(code: string, from: number): { words: string[]; brace: number } {
  const brace = code.indexOf('{', from);
  const clause = code.slice(from, brace === -1 ? Math.min(code.length, from + 400) : brace);
  return { words: words(clause).filter((w) => w !== 'extends' && w !== 'implements'), brace };
}

function extractTs(file: string, lx: Lexed, starts: number[]): Extracted {
  const { code, codeWithStrings } = lx;
  const decls: Decl[] = [];
  const add = (name: string, kind: DeclKind, offset: number, extra: Partial<Decl> = {}): void => {
    decls.push({ name, kind, file, line: lineAt(starts, offset), ...extra });
  };
  /** Members of a class/interface/object body. */
  const members = (owner: string, open: number, mode: 'class' | 'object'): void => {
    const close = matchBracket(code, open);
    if (close === -1) return;
    for (const s of segmentStarts(code, open, close)) {
      const seg = code.slice(s, close);
      if (mode === 'class') {
        const m = TS_MEMBER.exec(seg);
        if (m === null || /^(?:if|for|while|return|const|let|var|new|this|super)$/.test(m[1])) continue;
        add(m[1], m[2] === '(' || m[2] === '<' ? 'method' : 'field', s + seg.indexOf(m[1]), { owner });
      } else {
        const m = OBJECT_KEY.exec(codeWithStrings.slice(s, close));
        if (m === null) continue;
        const name = m[2] ?? m[3];
        add(name, m[4] === '(' ? 'method' : 'field', s, { owner });
      }
    }
  };

  for (const m of code.matchAll(TS_CLASS)) {
    const end = (m.index ?? 0) + m[0].length;
    const h = heritageAfter(code, end);
    add(m[1], 'class', m.index ?? 0, { heritage: h.words });
    if (h.brace !== -1) members(m[1], h.brace, 'class');
  }
  for (const m of code.matchAll(TS_INTERFACE)) {
    const end = (m.index ?? 0) + m[0].length;
    const h = heritageAfter(code, end);
    add(m[1], 'interface', m.index ?? 0, { heritage: h.words });
    if (h.brace !== -1) members(m[1], h.brace, 'class');
  }
  for (const m of code.matchAll(TS_ENUM)) {
    add(m[1], 'enum', m.index ?? 0);
    const brace = code.indexOf('{', (m.index ?? 0) + m[0].length);
    if (brace !== -1) members(m[1], brace, 'object');
  }
  for (const m of code.matchAll(TS_TYPE)) {
    add(m[1], 'type', m.index ?? 0);
    const after = (m.index ?? 0) + m[0].length;
    const rest = code.slice(after);
    const lead = rest.length - rest.replace(/^\s+/, '').length;
    if (rest[lead] === '{') members(m[1], after + lead, 'class');
  }
  for (const m of code.matchAll(TS_FUNCTION)) add(m[1], 'function', m.index ?? 0);
  for (const m of code.matchAll(TS_VAR)) {
    const rhsAt = (m.index ?? 0) + m[0].length;
    const rhs = codeWithStrings.slice(rhsAt, rhsAt + 300);
    const name = m[1];
    const at = m.index ?? 0;
    let mm: RegExpExecArray | null;
    if ((mm = /^z\s*\.\s*(?:strictObject|looseObject|object)\s*\(\s*\{/.exec(rhs)) !== null) {
      add(name, 'schema', at);
      members(name, rhsAt + mm[0].length - 1, 'object');
    } else if (/^z\s*\.\s*\w+/.test(rhs)) {
      add(name, 'schema', at);
    } else if ((mm = /^(?:pg|sqlite|mysql|singlestore)Table\s*\(/.exec(rhs)) !== null) {
      const open = rhsAt + mm[0].length - 1;
      const close = matchBracket(code, open);
      const tableName = firstString(codeWithStrings, open, close === -1 ? open + 200 : close);
      add(name, 'table', at);
      if (tableName !== null && tableName !== name) add(tableName, 'table', at);
      const brace = code.indexOf('{', open);
      if (brace !== -1 && (close === -1 || brace < close)) {
        const owners = tableName !== null && tableName !== name ? [name, tableName] : [name];
        const bclose = matchBracket(code, brace);
        for (const owner of owners) members(owner, brace, 'object');
        if (bclose !== -1) {
          // Column names as stored: the first string argument of each column builder.
          for (const s of segmentStarts(code, brace, bclose)) {
            const seg = codeWithStrings.slice(s, bclose);
            const cm = /^\s*[A-Za-z_$][\w$]*\s*:\s*[A-Za-z_$][\w$]*\s*\(\s*(['"])([^'"\n]+)\1/.exec(seg);
            if (cm !== null) for (const owner of owners) add(cm[2], 'field', s, { owner });
          }
        }
      }
    } else if (ARROW_OR_FUNCTION.test(rhs)) {
      add(name, 'function', at);
    } else if (rhs.startsWith('{')) {
      add(name, 'const', at);
      members(name, rhsAt, 'object');
    } else {
      add(name, 'const', at);
    }
  }
  for (const m of code.matchAll(TS_EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const w = part.trim().split(/\s+as\s+/);
      const exported = (w[1] ?? w[0]).replace(/^type\s+/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exported) && exported !== 'default') add(exported, 'export', m.index ?? 0);
    }
  }
  for (const m of code.matchAll(TS_EXPORT_STAR_AS)) add(m[1], 'export', m.index ?? 0);
  for (const m of code.matchAll(CJS_EXPORT_NAMED)) add(m[1], 'export', m.index ?? 0);
  for (const m of code.matchAll(CJS_EXPORT_OBJECT)) {
    const brace = (m.index ?? 0) + m[0].length - 1;
    const close = matchBracket(code, brace);
    if (close === -1) continue;
    for (const s of segmentStarts(code, brace, close)) {
      const k = OBJECT_KEY.exec(codeWithStrings.slice(s, close));
      if (k !== null) add(k[2] ?? k[3], 'export', s);
    }
  }
  return { decls };
}

function extractPython(file: string, lx: Lexed): Extracted {
  const { code, codeWithStrings } = lx;
  const decls: Decl[] = [];
  const lines = code.split('\n');
  const withStr = codeWithStrings.split('\n');
  const indentOf = (s: string): number => s.length - s.replace(/^[ \t]+/, '').length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^([ \t]*)class[ \t]+([A-Za-z_]\w*)[ \t]*(?:\(([^)]*)\))?[ \t]*:/.exec(line)) !== null) {
      const owner = m[2];
      const base = m[1].length;
      decls.push({ name: owner, kind: 'class', file, line: i + 1, heritage: words(m[3] ?? '') });
      let bodyIndent = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '') continue;
        const ind = indentOf(l);
        if (ind <= base) break;
        if (bodyIndent === -1) bodyIndent = ind;
        if (ind !== bodyIndent) continue;
        let mm: RegExpExecArray | null;
        if ((mm = /^\s*(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/.exec(l)) !== null) {
          decls.push({ name: mm[1], kind: 'method', file, line: j + 1, owner });
        } else if ((mm = /^\s*([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=/.exec(l)) !== null || (mm = /^\s*([A-Za-z_]\w*)[ \t]*:[ \t]*\S/.exec(l)) !== null) {
          decls.push({ name: mm[1], kind: 'field', file, line: j + 1, owner });
          if (mm[1] === '__tablename__') {
            const t = /=\s*(['"])([^'"]+)\1/.exec(withStr[j]);
            if (t !== null) decls.push({ name: t[2], kind: 'table', file, line: j + 1 });
          }
        }
      }
      continue;
    }
    if ((m = /^(?:async[ \t]+)?def[ \t]+([A-Za-z_]\w*)/.exec(line)) !== null) {
      decls.push({ name: m[1], kind: 'function', file, line: i + 1 });
    } else if ((m = /^([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=[ \t]*(.*)$/.exec(line)) !== null) {
      const rhs = withStr[i].slice(withStr[i].indexOf('=') + 1).trim();
      const t = /^(?:sa\.|sqlalchemy\.)?Table\(\s*(['"])([^'"]+)\1/.exec(rhs);
      if (t !== null) {
        decls.push({ name: m[1], kind: 'table', file, line: i + 1 });
        decls.push({ name: t[2], kind: 'table', file, line: i + 1 });
      } else {
        decls.push({ name: m[1], kind: 'const', file, line: i + 1 });
      }
    }
  }
  return { decls };
}

function extractGo(file: string, lx: Lexed, starts: number[]): Extracted {
  const { code } = lx;
  const decls: Decl[] = [];
  const add = (name: string, kind: DeclKind, offset: number, extra: Partial<Decl> = {}): void => {
    decls.push({ name, kind, file, line: lineAt(starts, offset), ...extra });
  };
  for (const m of code.matchAll(/^type[ \t]+([A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]+(struct|interface)[ \t]*\{/gm)) {
    const owner = m[1];
    const at = m.index ?? 0;
    add(owner, m[2] === 'struct' ? 'class' : 'interface', at);
    const brace = at + m[0].length - 1;
    const close = matchBracket(code, brace);
    if (close === -1) continue;
    // `A, B string` is one line: split at newlines only, so each field is seen once.
    let offset = brace + 1;
    for (const seg of code.slice(brace + 1, close).split('\n')) {
      let mm: RegExpExecArray | null;
      if (m[2] === 'interface' && (mm = /^\s*([A-Za-z_]\w*)\s*\(/.exec(seg)) !== null) add(mm[1], 'method', offset, { owner });
      else if (m[2] === 'struct' && (mm = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s+[^\s,]/.exec(seg)) !== null) {
        for (const f of mm[1].split(',')) add(f.trim(), 'field', offset, { owner });
      }
      offset += seg.length + 1;
    }
  }
  for (const m of code.matchAll(/^type[ \t]+([A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]+(?!struct\b|interface\b)\S/gm)) add(m[1], 'type', m.index ?? 0);
  for (const m of code.matchAll(/^func[ \t]*\([ \t]*\w*[ \t]*\*?[ \t]*([A-Za-z_]\w*)(?:\[[^\]\n]*\])?[ \t]*\)[ \t]*([A-Za-z_]\w*)/gm)) {
    add(m[2], 'method', m.index ?? 0, { owner: m[1] });
  }
  for (const m of code.matchAll(/^func[ \t]+([A-Za-z_]\w*)/gm)) add(m[1], 'function', m.index ?? 0);
  for (const m of code.matchAll(/^(?:const|var)[ \t]+([A-Za-z_]\w*)/gm)) add(m[1], 'const', m.index ?? 0);
  for (const m of code.matchAll(/^(?:const|var|type)[ \t]*\(/gm)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matchBracket(code, open);
    if (close === -1) continue;
    const kind: DeclKind = m[0].startsWith('type') ? 'type' : 'const';
    for (const s of segmentStarts(code, open, close)) {
      const mm = /^[ \t]*([A-Za-z_]\w*)\b/.exec(code.slice(s, close));
      if (mm !== null) add(mm[1], kind, s);
    }
  }
  return { decls };
}

function extractPrisma(file: string, lx: Lexed, starts: number[]): Extracted {
  const { code, codeWithStrings } = lx;
  const decls: Decl[] = [];
  for (const m of code.matchAll(/^(model|enum|type|view)[ \t]+([A-Za-z_]\w*)[ \t]*\{/gm)) {
    const at = m.index ?? 0;
    const owner = m[2];
    const kind: DeclKind = m[1] === 'enum' ? 'enum' : m[1] === 'type' ? 'type' : 'table';
    decls.push({ name: owner, kind, file, line: lineAt(starts, at) });
    const brace = at + m[0].length - 1;
    const close = matchBracket(code, brace);
    if (close === -1) continue;
    const body = code.slice(brace + 1, close);
    const fields: Decl[] = [];
    let mapped: string | null = null;
    let offset = brace + 1;
    for (const l of body.split('\n')) {
      const mm = /^[ \t]*([A-Za-z_]\w*)\b/.exec(l);
      if (mm !== null) fields.push({ name: mm[1], kind: 'field', file, line: lineAt(starts, offset), owner });
      const map = /@@map\(\s*"([^"]+)"/.exec(codeWithStrings.slice(offset, offset + l.length));
      if (map !== null) {
        mapped = map[1];
        decls.push({ name: mapped, kind: 'table', file, line: lineAt(starts, offset) });
      }
      offset += l.length + 1;
    }
    decls.push(...fields);
    // `@@map("app_user")` names the stored table: its columns are the model's fields.
    const storedAs = mapped;
    if (storedAs !== null) decls.push(...fields.map((f) => ({ ...f, owner: storedAs })));
  }
  return { decls };
}

const SQL_NOT_COLUMN = /^(?:constraint|primary|foreign|unique|check|key|index|exclude|like)$/i;

function extractSql(file: string, lx: Lexed, starts: number[]): Extracted {
  const { code } = lx;
  const decls: Decl[] = [];
  const re = /create[ \t\n]+(?:or[ \t\n]+replace[ \t\n]+)?(?:(?:global|local)[ \t\n]+)?(?:temporary[ \t\n]+|temp[ \t\n]+|unlogged[ \t\n]+)?table[ \t\n]+(?:if[ \t\n]+not[ \t\n]+exists[ \t\n]+)?((?:[`"[]?[\w]+[`"\]]?\.)?[`"[]?([\w]+)[`"\]]?)[ \t\n]*\(/gi;
  for (const m of code.matchAll(re)) {
    const at = m.index ?? 0;
    const owner = m[2];
    decls.push({ name: owner, kind: 'table', file, line: lineAt(starts, at) });
    const open = at + m[0].length - 1;
    const close = matchBracket(code, open);
    if (close === -1) continue;
    for (const s of segmentStarts(code, open, close)) {
      const mm = /^\s*[`"[]?([A-Za-z_]\w*)[`"\]]?\s+\w/.exec(code.slice(s, close));
      if (mm !== null && !SQL_NOT_COLUMN.test(mm[1])) decls.push({ name: mm[1], kind: 'field', file, line: lineAt(starts, s), owner });
    }
  }
  for (const m of code.matchAll(/create[ \t\n]+type[ \t\n]+(?:[\w"]+\.)?"?([\w]+)"?[ \t\n]+as[ \t\n]+enum/gi)) {
    decls.push({ name: m[1], kind: 'enum', file, line: lineAt(starts, m.index ?? 0) });
  }
  return { decls };
}

/** Declarations in one file's text. Exported for DESIGN.md `## Contracts` blocks, which are code without a file. */
export function extractDeclarations(file: string, text: string, lang: Language): Decl[] {
  const lx = lex(text, lang);
  const starts = lineStarts(text);
  switch (lang) {
    case 'ts':
      return extractTs(file, lx, starts).decls;
    case 'py':
      return extractPython(file, lx).decls;
    case 'go':
      return extractGo(file, lx, starts).decls;
    case 'prisma':
      return extractPrisma(file, lx, starts).decls;
    default:
      return extractSql(file, lx, starts).decls;
  }
}

// ─── File set ────────────────────────────────────────────────────────────────

export type ListFiles = (root: string) => string[];

/** `git ls-files -co --exclude-standard`, or a walk with fixed exclusions outside a work tree. */
export function listProjectFiles(root: string): string[] {
  const r = execGit(['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, timeout: 30_000 });
  if (r.exitCode === 0 && r.error === null) {
    return r.stdout.split('\0').filter((f) => f !== '');
  }
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!WALK_EXCLUDES.has(e.name)) walk(path.join(dir, e.name), rel === '' ? e.name : `${rel}/${e.name}`);
      } else if (e.isFile()) {
        out.push(rel === '' ? e.name : `${rel}/${e.name}`);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

// ─── Index ───────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Restrict to these project-relative files (tests); default: every project file. */
  files?: string[];
  /** File lister seam (tests); default `listProjectFiles`. */
  listFiles?: ListFiles;
}

/**
 * The root a project's declaration index is built from: the git work tree's top level, else the
 * project directory itself. A monorepo keeps `.planning/` in a sub-project (apps/rpg) while the
 * code a design names lives beside it (libs/…); an index rooted at the sub-project marks every
 * such identifier `absent` — a false BLOCKER (review M6). The assertion ratchet anchors at the
 * git root for the same reason (mn-assertion-count.cts resolveRepoRoot).
 */
export function indexRootFor(projectDir: string): string {
  const r = execGit(['rev-parse', '--show-toplevel'], { cwd: projectDir, timeout: 10_000 });
  return r.exitCode === 0 && r.error === null && r.stdout !== '' ? r.stdout : projectDir;
}

/** `buildSymbolIndex` over the project's whole repository (see `indexRootFor`). */
export function buildProjectSymbolIndex(projectDir: string): SymbolIndex {
  return buildSymbolIndex(indexRootFor(projectDir));
}

export function buildSymbolIndex(root: string, opts: BuildOptions = {}): SymbolIndex {
  const files = opts.files ?? (opts.listFiles ?? listProjectFiles)(root);
  const index: SymbolIndex = { root, decls: new Map(), mentioned: new Set(), foreignWords: new Set(), skipped: [], scanned: 0 };
  const addDecl = (d: Decl): void => {
    const list = index.decls.get(d.name);
    if (list === undefined) index.decls.set(d.name, [d]);
    else list.push(d);
  };
  for (const rel of [...files].sort()) {
    const ext = path.extname(rel).toLowerCase();
    const lang = languageOf(rel);
    const foreign = FOREIGN_EXT.has(ext);
    if (lang === null && !foreign) continue;
    const abs = path.join(root, rel);
    let size: number;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue; // listed by git but deleted in the work tree
    }
    if (size > MAX_FILE_BYTES) {
      index.skipped.push({ file: rel, reason: 'too_large' });
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch {
      index.skipped.push({ file: rel, reason: 'unreadable' });
      continue;
    }
    if (lang === null) {
      for (const w of words(text)) index.foreignWords.add(w);
      continue;
    }
    index.scanned++;
    const lx = lex(text, lang);
    for (const w of words(lx.code)) index.mentioned.add(w);
    for (const d of extractDeclarations(rel, text, lang)) addDecl(d);
    const base = path.basename(rel).replace(/\.[^.]+$/, '');
    if (/^[A-Za-z_$][\w$.-]*$/.test(base)) addDecl({ name: base, kind: 'module', file: rel, line: 1 });
  }
  return index;
}

export interface LookupOptions {
  kinds?: readonly DeclKind[];
  /** Acceptable owners (any one). */
  owners?: readonly string[];
}

function describe(d: Decl): string {
  return `${d.kind}${d.owner !== undefined ? ` of ${d.owner}` : ''} at ${d.file}:${d.line}`;
}

/** True when a file the index did not lex spells `name` as a word. */
function occursInSkipped(index: SymbolIndex, name: string): boolean {
  const re = new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`);
  for (const s of index.skipped) {
    try {
      if (re.test(fs.readFileSync(path.join(index.root, s.file), 'utf-8'))) return true;
    } catch {
      return true; // unreadable: cannot rule the name out
    }
  }
  return false;
}

export function lookup(index: SymbolIndex, name: string, opts: LookupOptions = {}): LookupResult {
  const candidates = index.decls.get(name) ?? [];
  const fits = candidates.filter(
    (d) => (opts.kinds === undefined || opts.kinds.includes(d.kind)) && (opts.owners === undefined || (d.owner !== undefined && opts.owners.includes(d.owner))),
  );
  if (fits.length > 0) return { verdict: 'declared', at: `${fits[0].file}:${fits[0].line}` };
  if (candidates.length > 0) {
    const d = candidates[0];
    return { verdict: 'ambiguous', at: `${d.file}:${d.line}`, note: `declared as ${describe(d)}, not as asked` };
  }
  if (index.mentioned.has(name)) return { verdict: 'ambiguous', note: 'named in code, but no declaration the recognizer understands (re-export, dynamic, generated)' };
  if (index.foreignWords.has(name)) return { verdict: 'ambiguous', note: 'named in a source file whose language the recognizer does not parse' };
  if (index.skipped.length > 0 && occursInSkipped(index, name)) return { verdict: 'ambiguous', note: 'named in a file over the size limit' };
  return { verdict: 'absent' };
}

/** Lowercase, separators dropped, a trailing plural `s` dropped: `user_accounts` ≈ `UserAccount`. */
export function looseName(name: string): string {
  return name.toLowerCase().replace(/[_\-$]/g, '').replace(/(?:es|s)$/, '');
}

/** Declarations whose loose spelling equals `name`'s (and that are not an exact match). */
export function looseMatches(index: SymbolIndex, name: string, kinds: readonly DeclKind[]): Decl[] {
  const want = looseName(name);
  const out: Decl[] = [];
  for (const [n, list] of index.decls) {
    if (n === name || looseName(n) !== want) continue;
    for (const d of list) if (kinds.includes(d.kind)) out.push(d);
  }
  return out;
}

// ─── Members of a named symbol (`%% gsd:source path#Symbol`) ─────────────────

export type MembersResult =
  /**
   * `members` — every spelling, flat (a state may be drawn by either);
   * `groups` — the spellings of each member (`Paid = 'paid'` → `['Paid', 'paid']`),
   * for a caller that must know which members a diagram left out.
   */
  | { ok: true; members: string[]; groups: string[][]; at: string }
  | { ok: false; reason: 'file_missing' | 'symbol_absent' | 'unsupported_language' };

function stringLiterals(text: string): string[] {
  return [...text.matchAll(/(['"`])([^'"`\n]*)\1/g)].map((m) => m[2]);
}

/**
 * The member names and string values of an enumeration-like declaration: a TS
 * `enum`, a string-literal union `type`, a `const` object, a `z.enum([...])`,
 * a Python `Enum` subclass, a Prisma/SQL enum, or Go constants of a named type.
 * `relFile` must already be confined to the project by the caller.
 */
export function symbolMembers(root: string, relFile: string, symbol: string): MembersResult {
  const lang = languageOf(relFile);
  if (lang === null) return { ok: false, reason: 'unsupported_language' };
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, relFile), 'utf-8');
  } catch {
    return { ok: false, reason: 'file_missing' };
  }
  const { code, codeWithStrings } = lex(text, lang);
  const starts = lineStarts(text);
  const sym = escapeRegex(symbol);
  const at = (offset: number): string => `${relFile}:${lineAt(starts, offset)}`;
  const found = (groups: string[][], offset: number): MembersResult => {
    const kept = groups.filter((g) => g.length > 0);
    return { ok: true, members: kept.flat(), groups: kept, at: at(offset) };
  };
  const each = (names: string[]): string[][] => names.map((n) => [n]);
  const bodyMembers = (open: number): string[][] => {
    const close = matchBracket(code, open);
    if (close === -1) return [];
    const out: string[][] = [];
    for (const s of segmentStarts(code, open, close)) {
      const seg = codeWithStrings.slice(s, close).split(/[\n,;]/)[0];
      const group: string[] = [];
      const k = /^\s*(?:(['"])([^'"\n]+)\1|([A-Za-z_$][\w$]*))/.exec(seg);
      if (k !== null) group.push(k[2] ?? k[3]);
      group.push(...stringLiterals(seg.slice(seg.search(/[=:]/) + 1 || seg.length)));
      out.push(group);
    }
    return out;
  };
  let m: RegExpExecArray | null;
  if (lang === 'ts') {
    if ((m = new RegExp(`${TS_PREFIX}(?:const[ \\t]+)?enum[ \\t]+${sym}\\b[^{]*\\{`, 'm').exec(code)) !== null) {
      return found(bodyMembers(m.index + m[0].length - 1), m.index);
    }
    if ((m = new RegExp(`${TS_PREFIX}type[ \\t]+${sym}\\b[^=]*=`, 'm').exec(code)) !== null) {
      const from = m.index + m[0].length;
      const stop = code.slice(from).search(/;|\n[ \t]*\n|\n(?=\S)(?![ \t]*\|)/);
      const rhs = codeWithStrings.slice(from, stop === -1 ? undefined : from + stop);
      return found(each(stringLiterals(rhs)), m.index);
    }
    if ((m = new RegExp(`${TS_PREFIX}(?:const|let|var)[ \\t]+${sym}\\b[^=]*=[ \\t]*`, 'm').exec(code)) !== null) {
      const rhsAt = m.index + m[0].length;
      const rhs = codeWithStrings.slice(rhsAt);
      let mm: RegExpExecArray | null;
      if ((mm = /^z\s*\.\s*enum\s*\(\s*\[/.exec(rhs)) !== null) {
        const open = rhsAt + mm[0].length - 1;
        const close = matchBracket(code, open);
        return found(each(stringLiterals(codeWithStrings.slice(open, close === -1 ? undefined : close))), m.index);
      }
      if (rhs.startsWith('{')) return found(bodyMembers(rhsAt), m.index);
      if (rhs.startsWith('[')) {
        const close = matchBracket(code, rhsAt);
        return found(each(stringLiterals(codeWithStrings.slice(rhsAt, close === -1 ? undefined : close))), m.index);
      }
    }
    return { ok: false, reason: 'symbol_absent' };
  }
  if (lang === 'py') {
    if ((m = new RegExp(`^([ \\t]*)class[ \\t]+${sym}\\b[^:\\n]*:`, 'm').exec(code)) !== null) {
      const base = m[1].length;
      const out: string[][] = [];
      const after = code.slice(m.index + m[0].length).split('\n').slice(1);
      const afterStr = codeWithStrings.slice(m.index + m[0].length).split('\n').slice(1);
      for (let j = 0; j < after.length; j++) {
        const l = after[j];
        if (l.trim() === '') continue;
        if (l.length - l.replace(/^[ \t]+/, '').length <= base) break;
        const mm = /^\s*([A-Za-z_]\w*)\s*=/.exec(l);
        if (mm !== null) out.push([mm[1], ...stringLiterals(afterStr[j].slice(afterStr[j].indexOf('=') + 1))]);
      }
      return found(out, m.index);
    }
    return { ok: false, reason: 'symbol_absent' };
  }
  if (lang === 'go') {
    const out: string[][] = [];
    let first = -1;
    for (const mm of codeWithStrings.matchAll(new RegExp(`^[ \\t]*(?:const[ \\t]+)?([A-Za-z_]\\w*)[ \\t]+${sym}[ \\t]*=[ \\t]*(.*)$`, 'gm'))) {
      if (first === -1) first = mm.index ?? 0;
      out.push([mm[1], ...stringLiterals(mm[2])]);
    }
    if (first === -1) return { ok: false, reason: 'symbol_absent' };
    return found(out, first);
  }
  if (lang === 'prisma') {
    if ((m = new RegExp(`^enum[ \\t]+${sym}[ \\t]*\\{`, 'm').exec(code)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = matchBracket(code, open);
      return found(each(words(code.slice(open + 1, close === -1 ? undefined : close))), m.index);
    }
    return { ok: false, reason: 'symbol_absent' };
  }
  if ((m = new RegExp(`create[ \\t\\n]+type[ \\t\\n]+(?:[\\w"]+\\.)?"?${sym}"?[ \\t\\n]+as[ \\t\\n]+enum[ \\t\\n]*\\(`, 'i').exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchBracket(code, open);
    return found(each(stringLiterals(codeWithStrings.slice(open, close === -1 ? undefined : close))), m.index);
  }
  return { ok: false, reason: 'symbol_absent' };
}
