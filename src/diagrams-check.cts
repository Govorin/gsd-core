/**
 * Diagrams Check — `gsd_run diagrams check --file <md>`: every mermaid block
 * in a document is (a) inside the subset the builders can express and (b)
 * names only things that exist in the code.
 *
 * A model draws the diagrams in user documentation and in a phase's
 * DESIGN.md. Mermaid syntax makes an invented class or call read as fact, so
 * this check is deterministic end to end: blocks are found with the shared
 * fence scanner, parsed by the strict subset parser (`mermaid-parse.cts`,
 * whose oracle is the builders in `mermaid.cts`), and every identifier the
 * diagram claims is looked up in the declaration index (`symbol-index.cts`).
 *
 * What is looked up, per diagram type:
 *   - classDiagram — each class (class/interface/type/enum/schema), each
 *     method and field by its owner, and each inheritance/realization as an
 *     `extends`/`implements` of the child where the language records it;
 *   - sequenceDiagram — each participant (its label when it has one) and each
 *     call-shaped message (`create(dto)`) as a member of its RECEIVER;
 *   - erDiagram — each entity as a table/schema/type, each attribute as a field
 *     of it; an exact spelling is `declared`, a loose one (`USER` ≈ `users`)
 *     only `ambiguous`;
 *   - stateDiagram — the states against the members of the enumeration named by
 *     `%% gsd:source path#Symbol`; without one the diagram is unverifiable;
 *   - flowchart — syntax only (its ids are arbitrary node names).
 *
 * Findings: `absent` → BLOCKER; `ambiguous`, an unverifiable diagram and a
 * block outside the subset → WARNING. A block marked derived (a
 * `<!-- gsd:derived … -->` or `<!-- DERIVED. … -->` comment before it) was
 * produced by a command, so its identifiers are not re-checked.
 *
 * DESIGN.md is written BEFORE the code. In `design` mode a name the same
 * document introduces — a `## Layer Placement` row, a declaration in a
 * `## Contracts` code block, a row of a Contracts table — is `planned`
 * (accepted), until frontmatter `contracts_superseded: true` says the code is
 * now the contract; from then on it must be `declared`.
 *
 * ADR-457 build-at-publish: source in src/diagrams-check.cts, compiled to
 * gsd-core/bin/lib/diagrams-check.cjs (gitignored).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanFencedBlocks, collectSection } from './markdown-sectionizer.cjs';
import { parseMarkdownTable } from './markdown-table.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { parseMermaid } from './mermaid-parse.cjs';
import type { DiagramType, ParseFailureReason, ParseSuccess } from './mermaid-parse.cjs';
import type { SequenceStep, SequenceMessage } from './mermaid.cjs';
import {
  buildSymbolIndex,
  lookup,
  looseMatches,
  symbolMembers,
  extractDeclarations,
} from './symbol-index.cjs';
import type { SymbolIndex, DeclKind, LookupResult, Language, Decl } from './symbol-index.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterModule = require('./frontmatter.cjs');

const { extractFrontmatter } = frontmatterModule;

// ─── Result types ────────────────────────────────────────────────────────────

export type CheckMode = 'docs' | 'design';

export type IdVerdict = 'declared' | 'planned' | 'ambiguous' | 'absent' | 'external';

export type ClaimKind = 'class' | 'method' | 'field' | 'participant' | 'call' | 'entity' | 'attribute' | 'state' | 'source' | 'relation';

export interface IdResult {
  id: string;
  kind: ClaimKind;
  owner?: string;
  verdict: IdVerdict;
  /** Document line of the claim. */
  line: number;
  at?: string;
  note?: string;
}

export interface DiagramReport {
  /** Document line of the opening fence. */
  line: number;
  type: DiagramType | null;
  derived: boolean;
  syntax: 'ok' | ParseFailureReason;
  ids: IdResult[];
}

export type Severity = 'BLOCKER' | 'WARNING';

export interface Finding {
  line: number;
  severity: Severity;
  category: 'diagram_syntax' | 'diagram_identifier';
  claim: string;
  reason: ParseFailureReason | 'absent' | 'ambiguous' | 'unverifiable' | 'relation_absent' | 'unterminated';
  message: string;
}

export interface CheckReport {
  mode: CheckMode;
  diagram_count: number;
  blocker_count: number;
  warning_count: number;
  diagrams: DiagramReport[];
  findings: Finding[];
}

/** Built on first need: a document whose blocks are all flowcharts or derived never walks the tree. */
export type IndexProvider = () => SymbolIndex;

export interface CheckOptions {
  mode: CheckMode;
  root: string;
  index: IndexProvider;
}

// ─── Planned names (DESIGN.md) ───────────────────────────────────────────────

const CODE_LANG: Readonly<Record<string, Language>> = Object.freeze({
  ts: 'ts', typescript: 'ts', tsx: 'ts', js: 'ts', javascript: 'ts', jsx: 'ts',
  py: 'py', python: 'py', go: 'go', golang: 'go', prisma: 'prisma', sql: 'sql',
});

interface Planned {
  names: Set<string>;
  /** `Owner.member` for members a contract declares. */
  qualified: Set<string>;
}

/** Identifiers in a table cell: backticked spans first, else the whole cell when it is one word. */
function cellNames(cell: string): string[] {
  const ticks = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const pool = ticks.length > 0 ? ticks : [cell.trim()];
  return pool.map((s) => s.trim()).filter((s) => /^[A-Za-z_$][\w$]*$/.test(s));
}

function plannedNames(markdown: string): Planned {
  const planned: Planned = { names: new Set(), qualified: new Set() };
  const section = (title: RegExp): string => collectSection(markdown, (h) => h.level === 2 && title.test(h.text))?.body ?? '';
  const firstColumn = (body: string): void => {
    // A section may hold several tables; each is parsed from its own header row.
    const blocks = body.split(/\n(?=\|[^\n]*\|\s*\n\|[\s:|-]+\|)/);
    for (const chunk of blocks) {
      const t = parseMarkdownTable(chunk.slice(chunk.indexOf('|')));
      if (!t.ok) continue;
      const col = t.value.columns[0];
      for (const row of t.value.rows) for (const n of cellNames(row[col] ?? '')) planned.names.add(n);
    }
  };
  firstColumn(section(/^Layer Placement$/i));
  const contracts = section(/^Contracts$/i);
  firstColumn(contracts);
  const lines = contracts.split('\n');
  for (const b of scanFencedBlocks(lines)) {
    const lang = CODE_LANG[b.infoString.split(/\s/)[0].toLowerCase()];
    if (lang === undefined || b.closeLineIdx === -1) continue;
    const text = lines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n');
    for (const d of extractDeclarations('DESIGN.md', text, lang)) {
      planned.names.add(d.name);
      if (d.owner !== undefined) planned.qualified.add(`${d.owner}.${d.name}`);
    }
  }
  return planned;
}

// ─── Claims per diagram type ─────────────────────────────────────────────────

interface Claim {
  id: string;
  kind: ClaimKind;
  owner?: string;
  /** Line within the block (1-based). */
  line: number;
  kinds: readonly DeclKind[];
  owners?: readonly string[];
}

const TYPE_KINDS: readonly DeclKind[] = ['class', 'interface', 'type', 'enum', 'schema'];
const MEMBER_KINDS: readonly DeclKind[] = ['method', 'field'];
const PARTICIPANT_KINDS: readonly DeclKind[] = ['class', 'interface', 'type', 'enum', 'schema', 'function', 'const', 'module', 'export', 'table'];
const ENTITY_KINDS: readonly DeclKind[] = ['table', 'schema', 'class', 'interface', 'type'];

/** `+findById(id) Thing` → `findById`. */
function methodName(text: string): string | null {
  const m = /^[+\-#~]?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text.trim());
  return m === null ? null : m[1];
}

/** `+string name` / `-name: string` / `+List~T~ items` → the field name. */
function fieldName(text: string): string | null {
  const t = text.trim().replace(/^[+\-#~]\s*/, '').replace(/[$*]$/, '');
  if (t.includes(':')) {
    const m = /^([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(t);
    return m === null ? null : m[1];
  }
  const parts = t.split(/\s+/);
  const last = parts[parts.length - 1];
  return /^[A-Za-z_$][\w$]*$/.test(last) ? last : null;
}

/** `create(dto)`, `await repo.save(x)` → the called name. */
function callName(text: string): string | null {
  const m = /^\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*)\s*\(/.exec(text);
  return m === null ? null : m[1];
}

function walkSteps(steps: readonly SequenceStep[], path: string, visit: (m: SequenceMessage, path: string) => void): void {
  steps.forEach((s, i) => {
    const p = `${path}${i}`;
    if (s.kind === 'message') visit(s, p);
    else if (s.kind !== 'note') {
      walkSteps(s.steps, `${p}.`, visit);
      (s.else ?? []).forEach((b, k) => walkSteps(b.steps, `${p}.else${k}.`, visit));
    }
  });
}

interface DiagramContext {
  parsed: ParseSuccess;
  external: Set<string>;
  /** Document line of the block's first content line, minus one. */
  offset: number;
  opts: CheckOptions;
  planned: Planned | null;
  ids: IdResult[];
  findings: Finding[];
}

/** A lookup answer widened with the two verdicts only this module gives (`planned`, `external`). */
interface Resolved {
  verdict: IdVerdict;
  at?: string;
  note?: string;
}

function record(ctx: DiagramContext, claim: Claim, result: Resolved): void {
  const line = ctx.offset + claim.line;
  const r: IdResult = { id: claim.id, kind: claim.kind, verdict: result.verdict, line };
  if (claim.owner !== undefined) r.owner = claim.owner;
  if (result.at !== undefined) r.at = result.at;
  if (result.note !== undefined) r.note = result.note;
  ctx.ids.push(r);
  const label = claim.owner !== undefined ? `${claim.owner}.${claim.id}` : claim.id;
  if (result.verdict === 'absent') {
    ctx.findings.push({
      line, severity: 'BLOCKER', category: 'diagram_identifier', claim: label, reason: 'absent',
      message: `${claim.kind} ${label} ${result.note ?? 'is not declared anywhere in the code'}`,
    });
  } else if (result.verdict === 'ambiguous') {
    ctx.findings.push({
      line, severity: 'WARNING', category: 'diagram_identifier', claim: label, reason: 'ambiguous',
      message: `${claim.kind} ${label}: ${result.note ?? 'not resolved to one declaration'}`,
    });
  }
}

function isPlanned(ctx: DiagramContext, claim: Claim): boolean {
  if (ctx.planned === null) return false;
  if (claim.owner !== undefined) return ctx.planned.qualified.has(`${claim.owner}.${claim.id}`) || ctx.planned.names.has(claim.owner);
  return ctx.planned.names.has(claim.id);
}

function check(ctx: DiagramContext, claim: Claim): Resolved {
  if (ctx.external.has(claim.id) || (claim.owner !== undefined && ctx.external.has(claim.owner))) {
    return { verdict: 'external' };
  }
  const res: LookupResult = lookup(ctx.opts.index(), claim.id, { kinds: claim.kinds, ...(claim.owners !== undefined ? { owners: claim.owners } : {}) });
  if (res.verdict !== 'declared' && isPlanned(ctx, claim)) return { verdict: 'planned' };
  return res;
}

function checkClassDiagram(ctx: DiagramContext): void {
  if (ctx.parsed.diagram.type !== 'classDiagram') return;
  const { spec } = ctx.parsed.diagram;
  const { lines } = ctx.parsed;
  const classVerdict = new Map<string, IdVerdict>();
  for (const c of spec.classes) {
    const claim: Claim = { id: c.id, kind: 'class', line: lines[`class:${c.id}`], kinds: TYPE_KINDS };
    const res = check(ctx, claim);
    classVerdict.set(c.id, res.verdict);
    record(ctx, claim, res);
    if (res.verdict === 'absent' || res.verdict === 'external') continue;
    (c.methods ?? []).forEach((text, i) => {
      const name = methodName(text);
      if (name === null) return;
      const mc: Claim = { id: name, kind: 'method', owner: c.id, line: lines[`method:${c.id}:${i}`], kinds: MEMBER_KINDS, owners: [c.id] };
      record(ctx, mc, check(ctx, mc));
    });
    (c.members ?? []).forEach((text, i) => {
      const name = fieldName(text);
      if (name === null) return;
      const fc: Claim = { id: name, kind: 'field', owner: c.id, line: lines[`member:${c.id}:${i}`], kinds: MEMBER_KINDS, owners: [c.id] };
      record(ctx, fc, check(ctx, fc));
    });
  }
  (spec.relations ?? []).forEach((r, i) => {
    if (r.kind !== 'inheritance' && r.kind !== 'realization') return;
    if (classVerdict.get(r.from) !== 'declared' || classVerdict.get(r.to) === 'absent' || classVerdict.get(r.to) === 'external') return;
    const child = (ctx.opts.index().decls.get(r.from) ?? []).filter((d: Decl) => d.heritage !== undefined);
    if (child.length === 0) return; // the language records no heritage clause (Go, a type alias): unverifiable, not wrong
    if (child.some((d) => (d.heritage ?? []).includes(r.to))) return;
    const line = ctx.offset + lines[`relation:${i}`];
    const verb = r.kind === 'inheritance' ? 'extends' : 'implements';
    ctx.findings.push({
      line, severity: 'BLOCKER', category: 'diagram_identifier', claim: `${r.from} ${verb} ${r.to}`, reason: 'relation_absent',
      message: `${r.from} is declared at ${child[0].file}:${child[0].line} without ${r.to} in its extends/implements clause`,
    });
  });
}

function checkSequenceDiagram(ctx: DiagramContext): void {
  if (ctx.parsed.diagram.type !== 'sequenceDiagram') return;
  const { spec } = ctx.parsed.diagram;
  const { lines } = ctx.parsed;
  const nameOf = new Map<string, string | null>();
  for (const p of spec.participants) {
    const name = p.label ?? p.id;
    const line = lines[`participant:${p.id}`];
    if (ctx.external.has(p.id)) {
      nameOf.set(p.id, null);
      ctx.ids.push({ id: name, kind: 'participant', verdict: 'external', line: ctx.offset + line });
      continue;
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      nameOf.set(p.id, null);
      ctx.findings.push({
        line: ctx.offset + line, severity: 'WARNING', category: 'diagram_identifier', claim: name, reason: 'unverifiable',
        message: `participant ${JSON.stringify(name)} is not an identifier — label it with the class/module name, or mark it %% gsd:external ${p.id}`,
      });
      continue;
    }
    nameOf.set(p.id, name);
    const claim: Claim = { id: name, kind: 'participant', line, kinds: PARTICIPANT_KINDS };
    const res = check(ctx, claim);
    record(ctx, claim, res);
    if (res.verdict === 'absent') nameOf.set(p.id, null);
  }
  walkSteps(spec.steps ?? [], '', (m, p) => {
    if (m.arrow === 'dotted' || m.arrow === 'dotted-cross') return; // a reply carries a value, not a call
    const receiver = nameOf.get(m.to);
    if (receiver === null || receiver === undefined) return;
    const name = callName(m.text);
    if (name === null) return;
    const claim: Claim = { id: name, kind: 'call', owner: receiver, line: lines[`step:${p}`], kinds: ['method', 'field', 'function'], owners: [receiver] };
    const res = check(ctx, claim);
    if (res.verdict === 'ambiguous') {
      // A module participant: a function declared in that module is the call it names.
      const inModule = (ctx.opts.index().decls.get(name) ?? []).find(
        (d: Decl) => d.kind === 'function' && path.basename(d.file).replace(/\.[^.]+$/, '') === receiver,
      );
      if (inModule !== undefined) {
        record(ctx, claim, { verdict: 'declared', at: `${inModule.file}:${inModule.line}` });
        return;
      }
    }
    record(ctx, claim, res);
  });
}

function checkErDiagram(ctx: DiagramContext): void {
  if (ctx.parsed.diagram.type !== 'erDiagram') return;
  const { spec } = ctx.parsed.diagram;
  const { lines } = ctx.parsed;
  const index = ctx.opts.index();
  for (const e of spec.entities) {
    const claim: Claim = { id: e.id, kind: 'entity', line: lines[`entity:${e.id}`], kinds: ENTITY_KINDS };
    let res = check(ctx, claim);
    let owners: string[] = [e.id];
    if (res.verdict !== 'declared' && res.verdict !== 'planned' && res.verdict !== 'external') {
      const loose = looseMatches(index, e.id, ENTITY_KINDS);
      if (loose.length > 0) {
        res = { verdict: 'ambiguous', at: `${loose[0].file}:${loose[0].line}`, note: `matches ${loose[0].name} by spelling only` };
        owners = [...new Set(loose.map((d) => d.name))];
      }
    }
    record(ctx, claim, res);
    if (res.verdict === 'absent' || res.verdict === 'external' || (res.verdict === 'ambiguous' && res.at === undefined)) continue;
    (e.attributes ?? []).forEach((a, i) => {
      const ac: Claim = { id: a.name, kind: 'attribute', owner: e.id, line: lines[`attr:${e.id}:${i}`], kinds: ['field'], owners };
      let ar = check(ctx, ac);
      if (ar.verdict !== 'declared' && ar.verdict !== 'planned' && ar.verdict !== 'external') {
        const loose = looseMatches(index, a.name, ['field']).filter((d) => d.owner !== undefined && owners.includes(d.owner));
        if (loose.length > 0) ar = { verdict: 'ambiguous', at: `${loose[0].file}:${loose[0].line}`, note: `matches ${loose[0].owner}.${loose[0].name} by spelling only` };
      }
      record(ctx, ac, ar);
    });
  }
}

const SOURCE_FAILURE: Readonly<Record<'file_missing' | 'symbol_absent' | 'unsupported_language', string>> = Object.freeze({
  file_missing: 'names a file that is not in the project',
  symbol_absent: 'names no enum, literal union, const object or z.enum in that file',
  unsupported_language: 'names a file in a language the recognizer does not parse',
});

function checkStateDiagram(ctx: DiagramContext): void {
  if (ctx.parsed.diagram.type !== 'stateDiagram') return;
  const { spec } = ctx.parsed.diagram;
  const { lines, directives } = ctx.parsed;
  if (directives.sources.length === 0) {
    ctx.findings.push({
      line: ctx.offset + ctx.parsed.line, severity: 'WARNING', category: 'diagram_identifier', claim: 'stateDiagram', reason: 'unverifiable',
      message: 'state names are not checked: add %% gsd:source <path>#<Enum> naming where the states are defined',
    });
    return;
  }
  const members = new Set<string>();
  for (const src of directives.sources) {
    const claim: Claim = { id: `${src.path}#${src.symbol}`, kind: 'source', line: src.line, kinds: [] };
    const contained = tryWithinRoot(src.path, ctx.opts.root, PathAcceptance.RelativeOnly);
    const res = contained === null ? ({ ok: false, reason: 'file_missing' } as const) : symbolMembers(ctx.opts.root, path.relative(ctx.opts.root, contained), src.symbol);
    if (!res.ok) {
      record(ctx, claim, { verdict: 'absent', note: SOURCE_FAILURE[res.reason] });
      continue;
    }
    record(ctx, claim, { verdict: 'declared', at: res.at });
    for (const m of res.members) members.add(m);
  }
  if (members.size === 0) return;
  for (const s of spec.states) {
    const claim: Claim = { id: s.id, kind: 'state', line: lines[`state:${s.id}`], kinds: [] };
    const known = members.has(s.id) || (s.label !== undefined && members.has(s.label));
    record(ctx, claim, known ? { verdict: 'declared' } : { verdict: 'absent', note: `is not a member of ${directives.sources.map((x) => x.symbol).join(' / ')}` });
  }
}

// ─── Document ────────────────────────────────────────────────────────────────

const DERIVED_RE = /^<!--\s*(?:gsd:derived\b|DERIVED\.)/;

/**
 * True when a derived marker governs the fence: the marker sits above it in the
 * same section, with no heading and no other code block in between (a
 * generator may put a `Command:` line or a field table between its marker and
 * its diagram — `gsd_run mn zod-fieldtable` does). A document whose first line
 * is the marker is derived as a whole.
 */
function isDerived(lines: string[], fenceIdx: number): boolean {
  const first = lines.find((l) => l.trim() !== '');
  if (first !== undefined && /^<!--\s*gsd:derived\b/.test(first.trim())) return true;
  for (let k = fenceIdx - 1; k >= 0; k--) {
    const t = lines[k].trim();
    if (DERIVED_RE.test(t)) return true;
    if (/^#{1,6}\s/.test(t) || /^(?:```|~~~)/.test(t)) return false;
  }
  return false;
}

export function modeFor(file: string): CheckMode {
  return /(^|[-_.])DESIGN\.md$/i.test(path.basename(file)) ? 'design' : 'docs';
}

/** Check every mermaid block of `markdown`. Pure apart from the index provider and gsd:source reads. */
export function checkDiagrams(markdown: string, opts: CheckOptions): CheckReport {
  const docLines = markdown.split('\n');
  const diagrams: DiagramReport[] = [];
  const findings: Finding[] = [];
  let planned: Planned | null = null;
  if (opts.mode === 'design') {
    const fm = extractFrontmatter(markdown) as Record<string, unknown>;
    const superseded = fm['contracts_superseded'] === true || fm['contracts_superseded'] === 'true';
    planned = superseded ? null : plannedNames(markdown);
  }
  for (const b of scanFencedBlocks(docLines)) {
    if (b.infoString.split(/\s/)[0].toLowerCase() !== 'mermaid') continue;
    const fenceLine = b.openLineIdx + 1;
    if (b.closeLineIdx === -1) {
      diagrams.push({ line: fenceLine, type: null, derived: false, syntax: 'syntax', ids: [] });
      findings.push({ line: fenceLine, severity: 'WARNING', category: 'diagram_syntax', claim: 'mermaid', reason: 'unterminated', message: 'the mermaid fence is never closed' });
      continue;
    }
    const derived = isDerived(docLines, b.openLineIdx);
    const text = docLines.slice(b.openLineIdx + 1, b.closeLineIdx).join('\n');
    const parsed = parseMermaid(text);
    if (!parsed.ok) {
      const line = fenceLine + parsed.line;
      diagrams.push({ line: fenceLine, type: null, derived, syntax: parsed.reason, ids: [] });
      findings.push({
        line, severity: 'WARNING', category: 'diagram_syntax', claim: docLines[line - 1]?.trim() ?? '', reason: parsed.reason,
        message: `${parsed.message} (column ${parsed.col}) — keep to the subset or rewrite the block`,
      });
      continue;
    }
    const report: DiagramReport = { line: fenceLine, type: parsed.diagram.type, derived, syntax: 'ok', ids: [] };
    diagrams.push(report);
    if (derived) continue;
    const ctx: DiagramContext = {
      parsed, external: new Set(parsed.directives.external), offset: fenceLine, opts, planned, ids: report.ids, findings,
    };
    checkClassDiagram(ctx);
    checkSequenceDiagram(ctx);
    checkErDiagram(ctx);
    checkStateDiagram(ctx);
  }
  findings.sort((a, b) => a.line - b.line);
  return {
    mode: opts.mode,
    diagram_count: diagrams.length,
    blocker_count: findings.filter((f) => f.severity === 'BLOCKER').length,
    warning_count: findings.filter((f) => f.severity === 'WARNING').length,
    diagrams,
    findings,
  };
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

export type RunResult =
  | ({ ok: true; file: string; root: string; scanned: number; skipped: number; strict_failed: boolean } & CheckReport)
  | { ok: false; reason: 'file_unreadable' | 'root_missing'; message: string };

export interface RunOptions {
  /** Absolute path of the markdown file (already confined by the caller). */
  file: string;
  /** Absolute project root the identifiers are looked up in. */
  root: string;
  mode?: CheckMode;
  strict?: boolean;
  /** Test seam: replaces the index builder. */
  buildIndex?: (root: string) => SymbolIndex;
}

export function runDiagramsCheck(opts: RunOptions): RunResult {
  let markdown: string;
  try {
    markdown = fs.readFileSync(opts.file, 'utf-8');
  } catch (err) {
    return { ok: false, reason: 'file_unreadable', message: `cannot read ${opts.file}: ${(err as Error).message}` };
  }
  try {
    if (!fs.statSync(opts.root).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, reason: 'root_missing', message: `root ${opts.root} is not a directory` };
  }
  let built: SymbolIndex | null = null;
  const index: IndexProvider = () => {
    if (built === null) built = (opts.buildIndex ?? buildSymbolIndex)(opts.root);
    return built;
  };
  const report = checkDiagrams(markdown, { mode: opts.mode ?? modeFor(opts.file), root: opts.root, index });
  const usedIndex = built as SymbolIndex | null;
  return {
    ok: true,
    file: path.relative(opts.root, opts.file).split(path.sep).join('/') || path.basename(opts.file),
    root: opts.root,
    scanned: usedIndex?.scanned ?? 0,
    skipped: usedIndex?.skipped.length ?? 0,
    strict_failed: opts.strict === true && report.blocker_count > 0,
    ...report,
  };
}

/** One line per finding plus a header — the `--raw` rendering. */
export function summaryText(result: Extract<RunResult, { ok: true }>): string {
  const head = `${result.blocker_count === 0 ? 'OK' : 'FAIL'}: ${result.file} — ${result.diagram_count} diagram(s), ${result.blocker_count} blocker(s), ${result.warning_count} warning(s)`;
  return [head, ...result.findings.map((f) => `${f.severity} line ${f.line} [${f.reason}] ${f.message}`)].join('\n');
}
