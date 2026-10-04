/**
 * Mermaid Subset Parser — reads a mermaid diagram written by a person or a
 * model back into the SAME spec types the builders in `mermaid.cts` take, and
 * refuses everything else.
 *
 * ── Why a closed subset, not "valid mermaid" ──
 *
 * The core ships no dependencies, and mermaid's own parser needs a DOM. More
 * to the point, "mermaid accepts it" is not the property that matters: a
 * diagram is checked so that every node it draws can be traced to something
 * real. That needs the diagram as STRUCTURE (classes, participants, calls,
 * states, entities), and only a grammar we own yields structure we can trust.
 * So the grammar here is exactly what the builders can express — plus the
 * shorthand people write in flowcharts (unquoted labels, a node declared by
 * the edge that first names it) — and every other construct is reported, with
 * line and column, as `unsupported_construct`: "leave the subset or rewrite".
 *
 * ── The builders are the oracle ──
 *
 * After a block parses, its spec is handed to the matching builder. The
 * builder already refuses an edge to an undeclared id, an unknown class, a
 * transition that crosses a group; so the rule "a diagram does not invent
 * nodes" is checked by the very code that generates GSD's own diagrams. The
 * parser validates the same things earlier, with a position; the builder
 * call is the backstop that keeps the two from drifting. And because every
 * builder's output parses back to its input (tests/mermaid-parse.test.cjs,
 * property-tested), this parser is also the test oracle for every generator
 * built on `mermaid.cts`.
 *
 * ── Directives ──
 *
 * Own-line comments `%% gsd:external A, B` (participants/classes that live
 * outside the repository) and `%% gsd:source path#Symbol` (where a state
 * diagram's states are defined) are returned to the caller; mermaid treats
 * them as comments. Any other `%% gsd:` word is refused, so a typo cannot
 * silently switch a check off.
 *
 * Imports only `mermaid.cts` and the frontmatter-fence locator. Pure — no I/O.
 *
 * ADR-457 build-at-publish: source in src/mermaid-parse.cts, compiled to
 * gsd-core/bin/lib/mermaid-parse.cjs (gitignored).
 */

import {
  flowchart,
  stateDiagram,
  classDiagram,
  erDiagram,
  sequenceDiagram,
  isSafeId,
  isPlainStyle,
  isSequenceKeyword,
  STATE_TERMINAL,
  SEQUENCE_MAX_DEPTH,
} from './mermaid.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';
import type {
  FlowchartSpec,
  FlowDirection,
  FlowShape,
  FlowNode,
  FlowEdge,
  FlowEdgeStyle,
  FlowSubgraph,
  ClassDef,
  StateDiagramSpec,
  StateNode,
  StateGroup,
  StateTransition,
  StateNote,
  ClassDiagramSpec,
  ClassNode,
  ClassRelation,
  ClassRelationKind,
  ErDiagramSpec,
  ErEntity,
  ErAttribute,
  ErRelationship,
  ErCardinality,
  ErKey,
  SequenceDiagramSpec,
  SequenceParticipant,
  SequenceStep,
  SequenceArrow,
  SequenceBlock,
} from './mermaid.cjs';

// ─── Result types ────────────────────────────────────────────────────────────

export type ParsedDiagram =
  | { type: 'flowchart'; spec: FlowchartSpec }
  | { type: 'stateDiagram'; spec: StateDiagramSpec }
  | { type: 'classDiagram'; spec: ClassDiagramSpec }
  | { type: 'erDiagram'; spec: ErDiagramSpec }
  | { type: 'sequenceDiagram'; spec: SequenceDiagramSpec };

export type DiagramType = ParsedDiagram['type'];

export type ParseFailureReason = 'unsupported_type' | 'unsupported_construct' | 'syntax' | 'undeclared_id';

export interface SourceDirective {
  path: string;
  symbol: string;
  line: number;
}

export interface ParseDirectives {
  /** Ids named by `%% gsd:external` — outside the repository, never looked up. */
  external: string[];
  /** `%% gsd:source path#Symbol` — where a state diagram's states are defined. */
  sources: SourceDirective[];
}

export interface ParseSuccess {
  ok: true;
  diagram: ParsedDiagram;
  /** 1-based line of the header (`flowchart LR`, `classDiagram`, …) within the text. */
  line: number;
  directives: ParseDirectives;
  /**
   * 1-based line of each element, keyed `class:<id>`, `method:<id>:<i>`,
   * `member:<id>:<i>`, `relation:<i>`, `participant:<id>`, `step:<path>`,
   * `state:<id>`, `entity:<id>`, `attr:<id>:<i>`, `node:<id>`.
   */
  lines: Record<string, number>;
  /** Ids the diagram declared only by naming them in an edge/message (flowchart, ER, sequence). */
  implicit: string[];
}

export interface ParseFailure {
  ok: false;
  reason: ParseFailureReason;
  line: number;
  col: number;
  message: string;
}

export type ParseResult = ParseSuccess | ParseFailure;

class Refusal extends Error {
  constructor(
    readonly reason: ParseFailureReason,
    readonly line: number,
    readonly col: number,
    message: string,
  ) {
    super(message);
  }
}

function refuse(reason: ParseFailureReason, line: number, col: number, message: string): never {
  throw new Refusal(reason, line, col, message);
}

// ─── Shared lexical helpers ──────────────────────────────────────────────────

interface Line {
  /** 1-based line number within the diagram text. */
  no: number;
  /** The line without trailing whitespace. */
  text: string;
  /** Column (1-based) of the first non-blank character. */
  col: number;
  /** `text` without leading whitespace. */
  body: string;
}

const DIRECTIONS: ReadonlySet<string> = new Set(['LR', 'RL', 'TB', 'TD', 'BT']);

const NAMED_ENTITY: Readonly<Record<string, string>> = Object.freeze({ quot: '"', lt: '<', gt: '>' });

/**
 * Decode what `escapeLabel` encodes — and any other numeric entity mermaid
 * would render — in ONE pass (a second pass would decode the `#59;` that a
 * label spelled literally as `#35;59#59;`). `escapeLabel`'s own codes are code
 * points, so this agrees with `unescapeLabel` on everything it produced.
 */
function decodeText(raw: string): string {
  return raw
    .split(/<br\s*\/?>/i)
    .map((part) =>
      part.replace(/#(quot|lt|gt|\d{1,7});/g, (code, name: string) => {
        if (NAMED_ENTITY[name] !== undefined) return NAMED_ENTITY[name];
        const cp = Number(name);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : code;
      }),
    )
    .join('\n');
}

/**
 * Refuse label text that mermaid reads as markup: HTML other than a line
 * break, or a markdown string (a label opening with a backtick).
 */
function checkLabelText(raw: string, line: number, col: number): void {
  if (/<(?!br\s*\/?>)/i.test(raw)) {
    refuse('unsupported_construct', line, col, 'HTML in a label is outside the subset (only <br/> is allowed)');
  }
  if (raw.startsWith('`')) {
    refuse('unsupported_construct', line, col, 'a markdown-string label is outside the subset');
  }
}

/**
 * Text that runs to the end of a statement (sequence messages, notes, block
 * labels, state transition labels): a raw `;` would end the statement and a
 * raw `#` that is not an entity code starts a comment in some grammars.
 */
function checkRestOfLine(raw: string, line: number, col: number): void {
  checkLabelText(raw, line, col);
  const bare = raw.replace(/#(?:[A-Za-z]+|\d+);/g, '');
  if (/[;#]/.test(bare)) {
    refuse('unsupported_construct', line, col, 'a raw ";" or "#" in text is outside the subset — write #59; / #35;');
  }
}

function checkId(id: string, line: number, col: number, what: string): void {
  if (!isSafeId(id)) {
    refuse('unsupported_construct', line, col, `${what} ${JSON.stringify(id)} is outside the subset (an ASCII identifier that is not a keyword)`);
  }
}

function lineOf(text: string): Line[] {
  return text.split(/\r?\n/).map((raw, i) => {
    const t = raw.replace(/\s+$/, '');
    const lead = t.length - t.replace(/^\s+/, '').length;
    return { no: i + 1, text: t, col: lead + 1, body: t.slice(lead) };
  });
}

/** Strip a single trailing `;` statement terminator (outside an entity code). */
function stripTerminator(body: string): string {
  return /;$/.test(body) && !/#(?:[A-Za-z]+|\d+);$/.test(body) ? body.slice(0, -1).replace(/\s+$/, '') : body;
}

// ─── Directives and header ───────────────────────────────────────────────────

const HEADER_TYPES: ReadonlyArray<[RegExp, DiagramType]> = [
  [/^(?:flowchart|graph)(?:\s+(\S+))?$/, 'flowchart'],
  [/^stateDiagram(?:-v2)?$/, 'stateDiagram'],
  [/^classDiagram(?:-v2)?$/, 'classDiagram'],
  [/^erDiagram$/, 'erDiagram'],
  [/^sequenceDiagram$/, 'sequenceDiagram'],
];

/**
 * Split directives and comments off the body lines. Returns the statement
 * lines (header first) and the directives found anywhere in the block.
 */
function preprocess(lines: Line[]): { statements: Line[]; directives: ParseDirectives } {
  const directives: ParseDirectives = { external: [], sources: [] };
  const statements: Line[] = [];
  for (const ln of lines) {
    if (ln.body === '') continue;
    if (ln.body.startsWith('%%{')) {
      refuse('unsupported_construct', ln.no, ln.col, 'a %%{init}%% directive is outside the subset');
    }
    if (ln.body.startsWith('%%')) {
      const m = /^%%\s*gsd:([A-Za-z-]+)\s*(.*)$/.exec(ln.body);
      if (m === null) continue;
      const [, word, arg] = m;
      if (word === 'external') {
        const ids = arg.split(',').map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) refuse('syntax', ln.no, ln.col, '%% gsd:external names no id');
        for (const id of ids) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) refuse('syntax', ln.no, ln.col, `%% gsd:external: ${JSON.stringify(id)} is not an id`);
          directives.external.push(id);
        }
      } else if (word === 'source') {
        const sm = /^([^\s#]+)#([A-Za-z_$][\w$]*)$/.exec(arg.trim());
        if (sm === null) refuse('syntax', ln.no, ln.col, '%% gsd:source takes <path>#<Symbol>');
        directives.sources.push({ path: sm[1], symbol: sm[2], line: ln.no });
      } else {
        refuse('unsupported_construct', ln.no, ln.col, `unknown directive "%% gsd:${word}" (known: external, source)`);
      }
      continue;
    }
    statements.push(ln);
  }
  return { statements, directives };
}

/**
 * Statements every grammar refuses outright: interaction, styling and
 * accessibility statements the builders never emit.
 */
const ALWAYS_UNSUPPORTED = /^(click|style|accTitle|accDescr|call|href|callback|link|cssClass)\b/;

// ─── Entry point ─────────────────────────────────────────────────────────────

export function parseMermaid(text: string): ParseResult {
  try {
    if (locateFrontmatterFence(text) !== null) {
      refuse('unsupported_construct', 1, 1, 'front-matter configuration is outside the subset');
    }
    const { statements, directives } = preprocess(lineOf(text));
    if (statements.length === 0) refuse('syntax', 1, 1, 'empty diagram');
    const [header, ...body] = statements;
    let type: DiagramType | null = null;
    let headerMatch: RegExpExecArray | null = null;
    for (const [re, t] of HEADER_TYPES) {
      const m = re.exec(header.body);
      if (m !== null) {
        type = t;
        headerMatch = m;
        break;
      }
    }
    if (type === null || headerMatch === null) {
      const word = header.body.split(/\s/)[0];
      refuse('unsupported_type', header.no, header.col, `diagram type ${JSON.stringify(word)} is outside the subset (flowchart, stateDiagram-v2, classDiagram, erDiagram, sequenceDiagram)`);
    }
    for (const ln of body) {
      if (ALWAYS_UNSUPPORTED.test(ln.body)) {
        refuse('unsupported_construct', ln.no, ln.col, `"${ln.body.split(/\s/)[0]}" statements are outside the subset`);
      }
    }
    const lines: Record<string, number> = {};
    const implicit: string[] = [];
    let diagram: ParsedDiagram;
    switch (type) {
      case 'flowchart':
        diagram = { type, spec: parseFlowchart(header, headerMatch[1], body, lines, implicit) };
        break;
      case 'stateDiagram':
        diagram = { type, spec: parseStateDiagram(body, lines) };
        break;
      case 'classDiagram':
        diagram = { type, spec: parseClassDiagram(body, lines) };
        break;
      case 'erDiagram':
        diagram = { type, spec: parseErDiagram(body, lines, implicit) };
        break;
      default:
        diagram = { type: 'sequenceDiagram', spec: parseSequenceDiagram(body, lines, implicit) };
    }
    rebuild(diagram, header);
    return { ok: true, diagram, line: header.no, directives, lines, implicit };
  } catch (err) {
    if (err instanceof Refusal) {
      return { ok: false, reason: err.reason, line: err.line, col: err.col, message: err.message };
    }
    throw err;
  }
}

/**
 * The oracle: the spec must build. A builder refusal here means the parser
 * let through something the builders cannot express — reported against the
 * header, since the builder does not know lines.
 */
function rebuild(diagram: ParsedDiagram, header: Line): void {
  try {
    switch (diagram.type) {
      case 'flowchart':
        flowchart(diagram.spec);
        break;
      case 'stateDiagram':
        stateDiagram(diagram.spec);
        break;
      case 'classDiagram':
        classDiagram(diagram.spec);
        break;
      case 'erDiagram':
        erDiagram(diagram.spec);
        break;
      default:
        sequenceDiagram(diagram.spec);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    refuse(/never declared/.test(message) ? 'undeclared_id' : 'unsupported_construct', header.no, header.col, message);
  }
}

/** The builder's rendering of a parsed diagram — identical structure, canonical spelling. */
export function renderParsed(diagram: ParsedDiagram): string {
  switch (diagram.type) {
    case 'flowchart':
      return flowchart(diagram.spec);
    case 'stateDiagram':
      return stateDiagram(diagram.spec);
    case 'classDiagram':
      return classDiagram(diagram.spec);
    case 'erDiagram':
      return erDiagram(diagram.spec);
    default:
      return sequenceDiagram(diagram.spec);
  }
}

// ─── classDef / class statements (flowchart and state) ───────────────────────

function parseClassDef(ln: Line, classDefs: ClassDef[]): void {
  const m = /^classDef\s+(\S+)\s+(.+)$/.exec(ln.body);
  if (m === null) refuse('syntax', ln.no, ln.col, 'classDef takes <name> <style>');
  const [, name, style] = m;
  if (name.includes(',')) refuse('unsupported_construct', ln.no, ln.col, 'classDef with several names is outside the subset');
  checkId(name, ln.no, ln.col, 'class name');
  if (!isPlainStyle(style.trim())) refuse('unsupported_construct', ln.no, ln.col, `style ${JSON.stringify(style)} is outside the subset`);
  if (classDefs.some((c) => c.name === name)) refuse('syntax', ln.no, ln.col, `classDef ${name} is defined twice`);
  classDefs.push({ name, style: style.trim() });
}

/** `class a,b name` → pending assignments, applied once every id is known. */
function parseClassAssign(ln: Line): { ids: string[]; name: string } {
  const m = /^class\s+([A-Za-z0-9_,\s]+?)\s+([A-Za-z_]\w*)$/.exec(ln.body);
  if (m === null) refuse('syntax', ln.no, ln.col, 'class takes <id>[,<id>…] <classDef name>');
  return { ids: m[1].split(',').map((s) => s.trim()), name: m[2] };
}

// ─── flowchart ───────────────────────────────────────────────────────────────

interface FlowNodeRef {
  id: string;
  col: number;
  shape?: FlowShape;
  label?: string;
  className?: string;
}

interface FlowLinkRef {
  line: FlowEdgeStyle;
  arrow: boolean;
  label?: string;
}

const FLOW_OPENERS: ReadonlyArray<[string, FlowShape | null, string]> = [
  ['(((', null, ''],
  ['@{', null, ''],
  ['([', 'stadium', '])'],
  ['[[', 'subroutine', ']]'],
  ['[(', 'cylinder', ')]'],
  ['((', 'circle', '))'],
  ['{{', 'hexagon', '}}'],
  ['[/', null, ''],
  ['[\\', null, ''],
  ['[', 'rect', ']'],
  ['(', 'round', ')'],
  ['{', 'rhombus', '}'],
  ['>', null, ''],
];

const FLOW_LINKS: Readonly<Record<string, FlowLinkRef>> = Object.freeze({
  '-->': { line: 'solid', arrow: true },
  '---': { line: 'solid', arrow: false },
  '-.->': { line: 'dotted', arrow: true },
  '-.-': { line: 'dotted', arrow: false },
  '==>': { line: 'thick', arrow: true },
  '===': { line: 'thick', arrow: false },
});

/** `-- text -->` style: the opener and the closers that end its text. */
const FLOW_TEXT_LINKS: ReadonlyArray<[string, ReadonlyArray<[string, string]>]> = [
  ['--', [[' -->', '-->'], [' ---', '---']]],
  ['-.', [[' .->', '-.->'], [' .-', '-.-']]],
  ['==', [[' ==>', '==>'], [' ===', '===']]],
];

/** One statement line: `node (link node)*`. */
function parseFlowStatement(ln: Line): { nodes: FlowNodeRef[]; links: FlowLinkRef[] } {
  const s = ln.text;
  let i = ln.col - 1;
  // Annotated so a call narrows like `refuse` does (TS narrows only on annotated never-returning consts).
  const fail: (reason: ParseFailureReason, message: string) => never = (reason, message) => refuse(reason, ln.no, i + 1, message);
  const skipWs = (): void => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };

  const readLabel = (close: string, quotedAllowed: boolean): string => {
    if (quotedAllowed && s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      if (end === -1) fail('syntax', 'unterminated quoted label');
      const raw = s.slice(i + 1, end);
      checkLabelText(raw, ln.no, i + 2);
      i = end + 1;
      if (!s.startsWith(close, i)) fail('syntax', `expected ${JSON.stringify(close)} after the label`);
      i += close.length;
      return decodeText(raw);
    }
    const end = s.indexOf(close, i);
    if (end === -1) fail('syntax', `expected ${JSON.stringify(close)} to close the label`);
    const raw = s.slice(i, end);
    if (/["[\](){}|;]/.test(raw)) fail('syntax', `unquoted label ${JSON.stringify(raw)} holds a bracket, quote, "|" or ";" — quote it`);
    checkLabelText(raw, ln.no, i + 1);
    i = end + close.length;
    return decodeText(raw.trim());
  };

  const readNode = (): FlowNodeRef => {
    const col = i + 1;
    const m = /^[A-Za-z0-9_]+/.exec(s.slice(i));
    if (m === null) fail('syntax', 'expected a node id');
    const id = m[0];
    i += id.length;
    if (/^[-.][A-Za-z0-9_]/.test(s.slice(i)) && !/^-[.-]/.test(s.slice(i))) {
      fail('unsupported_construct', `node id ${JSON.stringify(id + s.slice(i).split(/[\s[({>]/)[0])} is outside the subset (an ASCII identifier)`);
    }
    checkId(id, ln.no, col, 'node id');
    const ref: FlowNodeRef = { id, col };
    for (const [open, shape, close] of FLOW_OPENERS) {
      if (!s.startsWith(open, i)) continue;
      if (shape === null) return fail('unsupported_construct', `node shape "${open}…" is outside the subset`);
      i += open.length;
      ref.shape = shape;
      ref.label = readLabel(close, true);
      break;
    }
    const cm = /^:::([A-Za-z_]\w*)/.exec(s.slice(i));
    if (cm !== null) {
      ref.className = cm[1];
      i += cm[0].length;
    }
    return ref;
  };

  const readLink = (): FlowLinkRef => {
    const rest = s.slice(i);
    if (/^[<ox][-=.]/.test(rest)) fail('unsupported_construct', 'a bidirectional, circle or cross link is outside the subset');
    const tm = /^[-=.]+>?/.exec(rest);
    if (tm === null) {
      if (rest.startsWith('&')) fail('unsupported_construct', '"&" node chaining is outside the subset');
      if (rest.startsWith(';')) fail('unsupported_construct', 'several statements on one line are outside the subset');
      fail('syntax', `expected a link, found ${JSON.stringify(rest.slice(0, 12))}`);
    }
    const tok = tm[0];
    const after = s[i + tok.length];
    if ((after === 'o' || after === 'x') && !/[A-Za-z0-9_]/.test(s[i + tok.length + 1] ?? ' ')) {
      fail('unsupported_construct', 'a circle or cross link end is outside the subset');
    }
    let link: FlowLinkRef;
    if (FLOW_LINKS[tok] !== undefined) {
      link = { ...FLOW_LINKS[tok] };
      i += tok.length;
    } else {
      const textForm = FLOW_TEXT_LINKS.find(([open]) => open === tok);
      if (textForm === undefined || !/\s/.test(after ?? '')) {
        fail('unsupported_construct', `link ${JSON.stringify(tok)} is outside the subset (-->, ---, -.->, -.-, ==>, ===)`);
      }
      const start = i + tok.length;
      let found: { at: number; closer: string; link: string } | null = null;
      for (const [closer, linkTok] of textForm[1]) {
        const at = s.indexOf(closer, start);
        if (at !== -1 && (found === null || at < found.at)) found = { at, closer, link: linkTok };
      }
      if (found === null) fail('syntax', `link text after ${JSON.stringify(tok)} is never closed`);
      let raw = s.slice(start, found.at).trim();
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
      else if (/["|;]/.test(raw)) fail('syntax', 'unquoted link text holds a quote, "|" or ";"');
      checkLabelText(raw, ln.no, start + 1);
      link = { ...FLOW_LINKS[found.link], label: decodeText(raw) };
      i = found.at + found.closer.length;
    }
    if (s[i] === '|') {
      if (link.label !== undefined) fail('syntax', 'a link has two labels');
      const end = s.indexOf('|', i + 1);
      if (end === -1) fail('syntax', 'unterminated |link label|');
      let raw = s.slice(i + 1, end);
      if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
      else if (/["]/.test(raw)) fail('syntax', 'a link label with a quote must be fully quoted');
      checkLabelText(raw, ln.no, i + 2);
      link.label = decodeText(raw.trim());
      i = end + 1;
    }
    return link;
  };

  const nodes: FlowNodeRef[] = [readNode()];
  const links: FlowLinkRef[] = [];
  for (;;) {
    skipWs();
    if (i >= s.length) break;
    links.push(readLink());
    skipWs();
    if (i >= s.length) fail('syntax', 'a link needs a target node');
    nodes.push(readNode());
  }
  return { nodes, links };
}

function parseFlowchart(header: Line, dirWord: string | undefined, body: Line[], lines: Record<string, number>, implicit: string[]): FlowchartSpec {
  let direction: FlowDirection = 'TB';
  if (dirWord !== undefined) {
    if (!DIRECTIONS.has(dirWord)) refuse('syntax', header.no, header.col, `unknown direction ${JSON.stringify(dirWord)}`);
    direction = dirWord as FlowDirection;
  }
  const nodes = new Map<string, FlowNode & { declared: boolean }>();
  const edges: FlowEdge[] = [];
  const subgraphs: FlowSubgraph[] = [];
  const subgraphIds = new Set<string>();
  const classDefs: ClassDef[] = [];
  const assigns: Array<{ ln: Line; ids: string[]; name: string }> = [];
  const linkStyles: Array<{ ln: Line; index: number; style: string }> = [];
  let current: FlowSubgraph | null = null;

  const touch = (ref: FlowNodeRef, ln: Line): void => {
    if (subgraphIds.has(ref.id)) refuse('unsupported_construct', ln.no, ref.col, `an edge to subgraph ${ref.id} is outside the subset`);
    let node = nodes.get(ref.id);
    if (node === undefined) {
      node = { id: ref.id, shape: 'rect', declared: false };
      nodes.set(ref.id, node);
      lines[`node:${ref.id}`] = ln.no;
      if (current !== null) current.nodes.push(ref.id);
    }
    if (ref.shape !== undefined) {
      const label = ref.label === ref.id ? undefined : ref.label;
      if (node.declared && (node.shape !== ref.shape || node.label !== label)) {
        refuse('unsupported_construct', ln.no, ref.col, `node ${ref.id} is declared twice with a different shape or label`);
      }
      node.declared = true;
      node.shape = ref.shape;
      node.label = label;
    }
    if (ref.className !== undefined) {
      if (node.className !== undefined && node.className !== ref.className) {
        refuse('unsupported_construct', ln.no, ref.col, `node ${ref.id} is given two classes`);
      }
      node.className = ref.className;
    }
  };

  for (const ln of body) {
    const b = stripTerminator(ln.body);
    let m: RegExpExecArray | null;
    if ((m = /^subgraph\b\s*(.*)$/.exec(b)) !== null) {
      if (current !== null) refuse('unsupported_construct', ln.no, ln.col, 'a nested subgraph is outside the subset');
      const sm = /^([A-Za-z0-9_]+)(?:\s*\[(.*)\])?$/.exec(m[1]);
      if (sm === null) refuse('unsupported_construct', ln.no, ln.col, 'a subgraph needs an id: subgraph <id>["title"]');
      const id = sm[1];
      checkId(id, ln.no, ln.col, 'subgraph id');
      if (subgraphIds.has(id) || nodes.has(id)) refuse('syntax', ln.no, ln.col, `id ${id} is used twice`);
      let title: string | undefined;
      if (sm[2] !== undefined) {
        let raw = sm[2];
        if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) raw = raw.slice(1, -1);
        else if (/["[\]]/.test(raw)) refuse('syntax', ln.no, ln.col, 'unquoted subgraph title holds a quote or bracket');
        checkLabelText(raw, ln.no, ln.col);
        title = decodeText(raw);
        if (title === id) title = undefined;
      }
      current = { id, nodes: [], ...(title !== undefined ? { title } : {}) };
      subgraphs.push(current);
      subgraphIds.add(id);
      continue;
    }
    if (b === 'end') {
      if (current === null) refuse('syntax', ln.no, ln.col, '"end" without an open subgraph');
      current = null;
      continue;
    }
    if ((m = /^direction\s+(\S+)$/.exec(b)) !== null) {
      if (current === null) refuse('unsupported_construct', ln.no, ln.col, 'a top-level direction statement is outside the subset (put it in the header)');
      if (!DIRECTIONS.has(m[1])) refuse('syntax', ln.no, ln.col, `unknown direction ${JSON.stringify(m[1])}`);
      current.direction = m[1] as FlowDirection;
      continue;
    }
    if (/^classDef\b/.test(b)) {
      parseClassDef({ ...ln, body: b }, classDefs);
      continue;
    }
    if (/^class\b/.test(b)) {
      assigns.push({ ln, ...parseClassAssign({ ...ln, body: b }) });
      continue;
    }
    if ((m = /^linkStyle\s+(\S+)\s+(.+)$/.exec(b)) !== null) {
      if (!/^\d+(,\d+)*$/.test(m[1])) refuse('unsupported_construct', ln.no, ln.col, `linkStyle ${m[1]} is outside the subset (edge indexes only)`);
      if (!isPlainStyle(m[2])) refuse('unsupported_construct', ln.no, ln.col, `style ${JSON.stringify(m[2])} is outside the subset`);
      for (const n of m[1].split(',')) linkStyles.push({ ln, index: Number(n), style: m[2] });
      continue;
    }
    const { nodes: refs, links } = parseFlowStatement({ ...ln, text: ln.text.slice(0, ln.col - 1) + b });
    refs.forEach((r) => touch(r, ln));
    links.forEach((l, k) => {
      const edge: FlowEdge = { from: refs[k].id, to: refs[k + 1].id };
      if (l.label !== undefined) edge.label = l.label;
      if (l.line !== 'solid') edge.line = l.line;
      if (!l.arrow) edge.arrow = false;
      edges.push(edge);
    });
  }
  if (current !== null) refuse('syntax', body.at(-1)?.no ?? header.no, 1, `subgraph ${current.id} is never closed with "end"`);

  for (const { ln, ids, name } of assigns) {
    for (const id of ids) {
      const node = nodes.get(id);
      if (node === undefined) refuse('undeclared_id', ln.no, ln.col, `class statement names ${id}, which no statement declares`);
      if (node.className !== undefined && node.className !== name) refuse('unsupported_construct', ln.no, ln.col, `node ${id} is given two classes`);
      node.className = name;
    }
  }
  for (const node of nodes.values()) {
    if (node.className !== undefined && !classDefs.some((c) => c.name === node.className)) {
      refuse('undeclared_id', lines[`node:${node.id}`], 1, `node ${node.id} uses class ${node.className}, which has no classDef`);
    }
  }
  for (const { ln, index, style } of linkStyles) {
    if (index >= edges.length) refuse('syntax', ln.no, ln.col, `linkStyle ${index} names an edge that does not exist (${edges.length} edges)`);
    if (edges[index].linkStyle !== undefined) refuse('syntax', ln.no, ln.col, `edge ${index} is styled twice`);
    edges[index].linkStyle = style;
  }
  const specNodes: FlowNode[] = [];
  for (const n of nodes.values()) {
    if (!n.declared) implicit.push(n.id);
    const node: FlowNode = { id: n.id, shape: n.shape ?? 'rect' };
    if (n.label !== undefined) node.label = n.label;
    if (n.className !== undefined) node.className = n.className;
    specNodes.push(node);
  }
  const spec: FlowchartSpec = { direction, nodes: specNodes, edges };
  if (subgraphs.length > 0) spec.subgraphs = subgraphs;
  if (classDefs.length > 0) spec.classDefs = classDefs;
  return spec;
}

// ─── stateDiagram-v2 ─────────────────────────────────────────────────────────

const STATE_REF = String.raw`([A-Za-z0-9_]+|\[\*\])`;
const STATE_TRANSITION_RE = new RegExp(String.raw`^${STATE_REF}\s*-->\s*${STATE_REF}(?:\s*:\s*(.*))?$`);

function parseStateDiagram(body: Line[], lines: Record<string, number>): StateDiagramSpec {
  let direction: FlowDirection | undefined;
  const states = new Map<string, StateNode & { block: string }>();
  const groups: StateGroup[] = [];
  const groupIds = new Set<string>();
  const classDefs: ClassDef[] = [];
  const pending: Array<
    | { kind: 'transition'; ln: Line; block: string; from: string; to: string; label?: string }
    | { kind: 'note'; ln: Line; block: string; state: string; side: 'left' | 'right'; text: string }
    | { kind: 'class'; ln: Line; block: string; ids: string[]; name: string }
  > = [];
  let block = '';

  const declare = (ln: Line, id: string, label: string | undefined): void => {
    checkId(id, ln.no, ln.col, 'state id');
    if (groupIds.has(id)) refuse('syntax', ln.no, ln.col, `id ${id} is both a group and a state`);
    const norm = label === id ? undefined : label;
    const prev = states.get(id);
    if (prev !== undefined) {
      if (prev.block !== block || prev.label !== norm) {
        refuse('unsupported_construct', ln.no, ln.col, `state ${id} is declared twice with a different label or group`);
      }
      return;
    }
    states.set(id, { id, block, ...(norm !== undefined ? { label: norm } : {}) });
    lines[`state:${id}`] = ln.no;
    if (block !== '') groups.find((g) => g.id === block)?.states.push(id);
  };
  const quoted = (raw: string, ln: Line): string => {
    checkLabelText(raw, ln.no, ln.col);
    return decodeText(raw);
  };

  for (const ln of body) {
    const b = stripTerminator(ln.body);
    let m: RegExpExecArray | null;
    if ((m = /^direction\s+(\S+)$/.exec(b)) !== null) {
      if (block !== '') refuse('unsupported_construct', ln.no, ln.col, 'a direction inside a composite state is outside the subset');
      if (!DIRECTIONS.has(m[1])) refuse('syntax', ln.no, ln.col, `unknown direction ${JSON.stringify(m[1])}`);
      direction = m[1] as FlowDirection;
    } else if (/^classDef\b/.test(b)) {
      parseClassDef({ ...ln, body: b }, classDefs);
    } else if (/^class\b/.test(b)) {
      pending.push({ kind: 'class', ln, block, ...parseClassAssign({ ...ln, body: b }) });
    } else if ((m = /^state\s+(?:"([^"]*)"\s+as\s+)?([A-Za-z0-9_]+)\s*\{$/.exec(b)) !== null) {
      if (block !== '') refuse('unsupported_construct', ln.no, ln.col, 'a nested composite state is outside the subset');
      const id = m[2];
      checkId(id, ln.no, ln.col, 'group id');
      if (groupIds.has(id) || states.has(id)) refuse('syntax', ln.no, ln.col, `id ${id} is used twice`);
      const label = m[1] !== undefined ? quoted(m[1], ln) : undefined;
      groups.push({ id, states: [], ...(label !== undefined && label !== id ? { label } : {}) });
      groupIds.add(id);
      lines[`state:${id}`] = ln.no;
      block = id;
    } else if (b === '}') {
      if (block === '') refuse('syntax', ln.no, ln.col, '"}" without an open composite state');
      block = '';
    } else if (/^state\s+.*<<\w+>>/.test(b) || b === '--') {
      refuse('unsupported_construct', ln.no, ln.col, 'choice/fork/join pseudo-states and concurrency regions are outside the subset');
    } else if ((m = /^state\s+"([^"]*)"\s+as\s+([A-Za-z0-9_]+)$/.exec(b)) !== null) {
      declare(ln, m[2], quoted(m[1], ln));
    } else if (/^state\s+[A-Za-z0-9_]+$/.test(b)) {
      // The real parser reads a bare `state Id` on to the next `{`, swallowing a
      // later composite state's opener (found by tools/mermaid-check).
      refuse('unsupported_construct', ln.no, ln.col, 'a bare "state Id" is outside the subset — write state "Label" as Id, or Id : Label');
    } else if ((m = STATE_TRANSITION_RE.exec(b)) !== null) {
      let label: string | undefined;
      if (m[3] !== undefined && m[3].trim() !== '') {
        checkRestOfLine(m[3], ln.no, ln.col);
        label = decodeText(m[3].trim());
      }
      pending.push({ kind: 'transition', ln, block, from: m[1], to: m[2], ...(label !== undefined ? { label } : {}) });
    } else if ((m = /^note\s+(left|right)\s+of\s+([A-Za-z0-9_]+)\s*:\s*(.+)$/i.exec(b)) !== null) {
      checkRestOfLine(m[3], ln.no, ln.col);
      pending.push({ kind: 'note', ln, block, state: m[2], side: m[1].toLowerCase() as 'left' | 'right', text: decodeText(m[3].trim()) });
    } else if (/^note\b/i.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, 'a multi-line or floating note is outside the subset (note left|right of <id> : text)');
    } else if ((m = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(b)) !== null) {
      checkRestOfLine(m[2], ln.no, ln.col);
      declare(ln, m[1], decodeText(m[2].trim()));
    } else if (/:::/.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, '":::" class shorthand is outside the subset (use a class statement)');
    } else {
      refuse('syntax', ln.no, ln.col, `unrecognised stateDiagram statement ${JSON.stringify(b)}`);
    }
  }
  if (block !== '') refuse('syntax', body.at(-1)?.no ?? 1, 1, `composite state ${block} is never closed with "}"`);

  /** A state named on a line must be declared, and declared in the block that line is written in. */
  const inBlock = (id: string, p: { ln: Line; block: string }): void => {
    const st = states.get(id);
    if (st === undefined) {
      refuse('undeclared_id', p.ln.no, p.ln.col, `state ${id} is used but never declared (declare it: state "label" as ${id})`);
    }
    if (st.block !== p.block) {
      refuse('unsupported_construct', p.ln.no, p.ln.col, `state ${id} belongs to ${st.block === '' ? 'the top level' : `group ${st.block}`}; a line naming it must be written there`);
    }
  };
  const transitions: StateTransition[] = [];
  const notes: StateNote[] = [];
  for (const p of pending) {
    if (p.kind === 'transition') {
      for (const end of [p.from, p.to]) if (end !== STATE_TERMINAL) inBlock(end, p);
      transitions.push({ from: p.from, to: p.to, ...(p.label !== undefined ? { label: p.label } : {}) });
    } else if (p.kind === 'note') {
      inBlock(p.state, p);
      notes.push({ state: p.state, side: p.side, text: p.text });
    } else {
      for (const id of p.ids) {
        inBlock(id, p);
        const st = states.get(id) as StateNode;
        if (st.className !== undefined && st.className !== p.name) refuse('unsupported_construct', p.ln.no, p.ln.col, `state ${id} is given two classes`);
        if (!classDefs.some((c) => c.name === p.name)) refuse('undeclared_id', p.ln.no, p.ln.col, `class ${p.name} has no classDef`);
        st.className = p.name;
      }
    }
  }
  const spec: StateDiagramSpec = {
    states: [...states.values()].map(({ block: _block, ...s }) => s),
    transitions,
  };
  if (direction !== undefined) spec.direction = direction;
  if (groups.length > 0) spec.groups = groups;
  if (notes.length > 0) spec.notes = notes;
  if (classDefs.length > 0) spec.classDefs = classDefs;
  return spec;
}

// ─── classDiagram ────────────────────────────────────────────────────────────

/** Forward arrows, as the builder writes them: `from <arrow> to`. */
const CLASS_FORWARD: Readonly<Record<string, ClassRelationKind>> = Object.freeze({
  '--|>': 'inheritance',
  '..|>': 'realization',
  '--*': 'composition',
  '--o': 'aggregation',
  '-->': 'association',
  '..>': 'dependency',
  '--': 'link',
});

/** Reversed arrows people write (`Animal <|-- Dog`): same relation, ends swapped. */
const CLASS_REVERSED: Readonly<Record<string, ClassRelationKind>> = Object.freeze({
  '<|--': 'inheritance',
  '<|..': 'realization',
  '*--': 'composition',
  'o--': 'aggregation',
  '<--': 'association',
  '<..': 'dependency',
});

/** `A ["card"] <arrow> ["card"] B [: label]` — the arrow is set off by whitespace, as mermaid writes it. */
const CLASS_ARROW_RE = /^([A-Za-z0-9_]+)(?:\s+"([^"]*)")?\s+([<|*o.\-]*(?:--|\.\.)[|>*o.\-]*)\s+(?:"([^"]*)"\s+)?([A-Za-z0-9_]+)(?:\s*:\s*(.*))?$/;

const MEMBER_FORBIDDEN = /[{}"`;<>]/;

function parseClassDiagram(body: Line[], lines: Record<string, number>): ClassDiagramSpec {
  let direction: FlowDirection | undefined;
  const classes = new Map<string, ClassNode & { members: string[]; methods: string[] }>();
  const relations: Array<{ ln: Line; rel: ClassRelation }> = [];
  const later: Array<{ ln: Line; id: string; apply: (c: ClassNode & { members: string[]; methods: string[] }) => void }> = [];
  let open: (ClassNode & { members: string[]; methods: string[] }) | null = null;

  const addMember = (c: ClassNode & { members: string[]; methods: string[] }, raw: string, ln: Line): void => {
    const text = raw.trim();
    if (MEMBER_FORBIDDEN.test(text)) {
      refuse('unsupported_construct', ln.no, ln.col, `member ${JSON.stringify(text)} holds a brace, quote, ";" or "<>" — write generics as ~T~`);
    }
    if (text.includes('(')) {
      lines[`method:${c.id}:${c.methods.length}`] = ln.no;
      c.methods.push(text);
    } else {
      lines[`member:${c.id}:${c.members.length}`] = ln.no;
      c.members.push(text);
    }
  };
  const setAnnotation = (c: ClassNode, raw: string, ln: Line): void => {
    if (!/^[A-Za-z]\w*$/.test(raw)) refuse('unsupported_construct', ln.no, ln.col, `annotation <<${raw}>> is outside the subset (one word)`);
    if (c.annotation !== undefined && c.annotation !== raw) refuse('unsupported_construct', ln.no, ln.col, `class ${c.id} has two annotations`);
    c.annotation = raw;
  };

  for (const ln of body) {
    const b = stripTerminator(ln.body);
    let m: RegExpExecArray | null;
    if (open !== null) {
      if (b === '}') {
        open = null;
      } else if ((m = /^<<(.+)>>$/.exec(b)) !== null) {
        setAnnotation(open, m[1].trim(), ln);
      } else {
        addMember(open, b, ln);
      }
      continue;
    }
    if ((m = /^direction\s+(\S+)$/.exec(b)) !== null) {
      if (!DIRECTIONS.has(m[1])) refuse('syntax', ln.no, ln.col, `unknown direction ${JSON.stringify(m[1])}`);
      direction = m[1] as FlowDirection;
    } else if ((m = /^class\s+([A-Za-z0-9_]+)(.*?)\s*(\{)?$/.exec(b)) !== null) {
      const id = m[1];
      checkId(id, ln.no, ln.col, 'class id');
      let label: string | undefined;
      if (m[2] !== '') {
        const lm = /^\["([^"]*)"\]$/.exec(m[2]);
        if (lm === null) refuse('unsupported_construct', ln.no, ln.col, `class ${id}${m[2]} is outside the subset (generics, ":::" and unquoted labels are not allowed)`);
        checkLabelText(lm[1], ln.no, ln.col);
        label = decodeText(lm[1]);
        if (label === id) label = undefined;
      }
      let c = classes.get(id);
      if (c === undefined) {
        c = { id, members: [], methods: [], ...(label !== undefined ? { label } : {}) };
        classes.set(id, c);
        lines[`class:${id}`] = ln.no;
      } else if (label !== undefined && c.label !== label) {
        refuse('unsupported_construct', ln.no, ln.col, `class ${id} is declared twice with different labels`);
      }
      if (m[3] === '{') open = c;
    } else if ((m = /^<<(.+)>>\s+([A-Za-z0-9_]+)$/.exec(b)) !== null) {
      const raw = m[1].trim();
      later.push({ ln, id: m[2], apply: (c) => setAnnotation(c, raw, ln) });
    } else if (/^(namespace|note|classDef)\b/.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, `"${b.split(/\s/)[0]}" is outside the subset`);
    } else if ((m = /^([A-Za-z0-9_]+)\s*:\s*(.+)$/.exec(b)) !== null) {
      const raw = m[2];
      later.push({ ln, id: m[1], apply: (c) => addMember(c, raw, ln) });
    } else if ((m = CLASS_ARROW_RE.exec(b)) !== null) {
      const [, left, leftCard, arrow, rightCard, right, label] = m;
      let rel: ClassRelation;
      if (CLASS_FORWARD[arrow] !== undefined) {
        rel = { from: left, to: right, kind: CLASS_FORWARD[arrow] };
        if (leftCard !== undefined) rel.fromCardinality = leftCard;
        if (rightCard !== undefined) rel.toCardinality = rightCard;
      } else if (CLASS_REVERSED[arrow] !== undefined) {
        rel = { from: right, to: left, kind: CLASS_REVERSED[arrow] };
        if (rightCard !== undefined) rel.fromCardinality = rightCard;
        if (leftCard !== undefined) rel.toCardinality = leftCard;
      } else {
        refuse('unsupported_construct', ln.no, ln.col, `relation arrow ${JSON.stringify(arrow)} is outside the subset`);
      }
      for (const card of [rel.fromCardinality, rel.toCardinality]) {
        if (card !== undefined && !/^[A-Za-z0-9.*]+$/.test(card)) refuse('unsupported_construct', ln.no, ln.col, `cardinality ${JSON.stringify(card)} is outside the subset`);
      }
      if (label !== undefined && label.trim() !== '') {
        checkRestOfLine(label, ln.no, ln.col);
        rel.label = decodeText(label.trim());
      }
      relations.push({ ln, rel });
    } else {
      refuse('syntax', ln.no, ln.col, `unrecognised classDiagram statement ${JSON.stringify(b)}`);
    }
  }
  if (open !== null) refuse('syntax', body.at(-1)?.no ?? 1, 1, `class ${open.id} body is never closed with "}"`);

  for (const { ln, id, apply } of later) {
    const c = classes.get(id);
    if (c === undefined) refuse('undeclared_id', ln.no, ln.col, `class ${id} is used but never declared (class ${id})`);
    apply(c);
  }
  for (const { ln, rel } of relations) {
    for (const end of [rel.from, rel.to]) {
      if (!classes.has(end)) refuse('undeclared_id', ln.no, ln.col, `class ${end} is related but never declared (class ${end})`);
    }
  }
  relations.forEach(({ ln }, i) => {
    lines[`relation:${i}`] = ln.no;
  });
  const spec: ClassDiagramSpec = {
    classes: [...classes.values()].map((c) => {
      const out: ClassNode = { id: c.id };
      if (c.label !== undefined) out.label = c.label;
      if (c.annotation !== undefined) out.annotation = c.annotation;
      if (c.members.length > 0) out.members = c.members;
      if (c.methods.length > 0) out.methods = c.methods;
      return out;
    }),
    relations: relations.map((r) => r.rel),
  };
  if (direction !== undefined) spec.direction = direction;
  return spec;
}

// ─── erDiagram ───────────────────────────────────────────────────────────────

const ER_LEFT_MARK: Readonly<Record<string, ErCardinality>> = Object.freeze({
  '|o': 'zero-or-one',
  '||': 'exactly-one',
  '}o': 'zero-or-more',
  '}|': 'one-or-more',
});

const ER_RIGHT_MARK: Readonly<Record<string, ErCardinality>> = Object.freeze({
  'o|': 'zero-or-one',
  '||': 'exactly-one',
  'o{': 'zero-or-more',
  '|{': 'one-or-more',
});

const ER_REL_RE = /^([A-Za-z0-9_]+)\s*(\S{2})(--|\.\.)(\S{2})\s*([A-Za-z0-9_]+)\s*:\s*(.+)$/;
const ER_WORD = /^[A-Za-z_][A-Za-z0-9_()[\]]*$/;

function parseErDiagram(body: Line[], lines: Record<string, number>, implicit: string[]): ErDiagramSpec {
  const entities = new Map<string, ErEntity & { attributes: ErAttribute[]; declared: boolean }>();
  const relationships: ErRelationship[] = [];
  let open: (ErEntity & { attributes: ErAttribute[]; declared: boolean }) | null = null;

  const entity = (id: string, ln: Line, declare: boolean): ErEntity & { attributes: ErAttribute[]; declared: boolean } => {
    checkId(id, ln.no, ln.col, 'entity id');
    let e = entities.get(id);
    if (e === undefined) {
      e = { id, attributes: [], declared: declare };
      entities.set(id, e);
      lines[`entity:${id}`] = ln.no;
    } else if (declare) {
      e.declared = true;
    }
    return e;
  };

  for (const ln of body) {
    const b = stripTerminator(ln.body);
    let m: RegExpExecArray | null;
    if (open !== null) {
      if (b === '}') {
        open = null;
        continue;
      }
      m = /^(\S+)\s+(\S+)((?:\s+(?:PK|FK|UK)\s*,?)*)\s*(?:"([^"]*)")?$/.exec(b);
      if (m === null) refuse('syntax', ln.no, ln.col, `attribute ${JSON.stringify(b)} is outside the subset (<type> <name> [PK|FK|UK] ["comment"])`);
      const [, type, name, keyText, comment] = m;
      for (const [word, what] of [[type, 'type'], [name, 'name']] as const) {
        if (!ER_WORD.test(word)) refuse('unsupported_construct', ln.no, ln.col, `attribute ${what} ${JSON.stringify(word)} is outside the subset`);
      }
      const keys = keyText.split(/[\s,]+/).filter(Boolean) as ErKey[];
      const attr: ErAttribute = { type, name };
      if (keys.length > 0) attr.keys = keys;
      if (comment !== undefined && comment.trim() !== '') attr.comment = comment;
      lines[`attr:${open.id}:${open.attributes.length}`] = ln.no;
      open.attributes.push(attr);
      continue;
    }
    if ((m = /^([A-Za-z0-9_]+)\s*\{$/.exec(b)) !== null) {
      const e = entity(m[1], ln, true);
      if (e.attributes.length > 0) refuse('unsupported_construct', ln.no, ln.col, `entity ${e.id} has two attribute blocks`);
      open = e;
    } else if ((m = /^([A-Za-z0-9_]+)$/.exec(b)) !== null) {
      entity(m[1], ln, true);
    } else if (/^[A-Za-z0-9_]+\s*\[/.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, 'an entity alias is outside the subset');
    } else if ((m = ER_REL_RE.exec(b)) !== null) {
      const [, left, lmark, line, rmark, right, rawLabel] = m;
      const lc = ER_LEFT_MARK[lmark];
      const rc = ER_RIGHT_MARK[rmark];
      if (lc === undefined || rc === undefined) refuse('unsupported_construct', ln.no, ln.col, `cardinality ${lmark}${line}${rmark} is outside the subset`);
      const label = rawLabel.trim();
      let text: string;
      if (label.startsWith('"') && label.endsWith('"') && label.length >= 2) text = label.slice(1, -1);
      else if (/^[A-Za-z0-9_-]+$/.test(label)) text = label;
      else refuse('syntax', ln.no, ln.col, 'a relationship label must be one word or "quoted"');
      entity(left, ln, false);
      entity(right, ln, false);
      const rel: ErRelationship = { left, right, leftCardinality: lc, rightCardinality: rc, label: text };
      if (line === '..') rel.identifying = false;
      relationships.push(rel);
    } else {
      refuse('syntax', ln.no, ln.col, `unrecognised erDiagram statement ${JSON.stringify(b)}`);
    }
  }
  if (open !== null) refuse('syntax', body.at(-1)?.no ?? 1, 1, `entity ${open.id} body is never closed with "}"`);
  const out: ErEntity[] = [];
  for (const e of entities.values()) {
    if (!e.declared) implicit.push(e.id);
    out.push(e.attributes.length > 0 ? { id: e.id, attributes: e.attributes } : { id: e.id });
  }
  return { entities: out, relationships };
}

// ─── sequenceDiagram ─────────────────────────────────────────────────────────

const SEQ_ARROWS: Readonly<Record<string, SequenceArrow>> = Object.freeze({
  '->>': 'solid',
  '-->>': 'dotted',
  '-x': 'solid-cross',
  '--x': 'dotted-cross',
});

const SEQ_MESSAGE_RE = /^([A-Za-z0-9_]+)\s*(<<-->>|<<->>|-->>|->>|--x|-x|--\)|-\)|-->|->)\s*([+-]?)\s*([A-Za-z0-9_]+)\s*:(.*)$/;

const SEQ_UNSUPPORTED = /^(create|destroy|box|rect|activate|deactivate|par|and|critical|option|break|links|link|properties|details|title)\b/i;

function parseSequenceDiagram(body: Line[], lines: Record<string, number>, implicit: string[]): SequenceDiagramSpec {
  const participants = new Map<string, SequenceParticipant>();
  const used = new Set<string>();
  let autonumber = false;
  const root: SequenceStep[] = [];
  /** `blockPath` is the open block's own step path; `path` prefixes the steps written inside it. */
  const stack: Array<{ steps: SequenceStep[]; block: SequenceBlock | null; blockPath: string; path: string; count: number }> = [
    { steps: root, block: null, blockPath: '', path: '', count: 0 },
  ];

  const participant = (id: string, ln: Line): void => {
    checkId(id, ln.no, ln.col, 'participant id');
    if (isSequenceKeyword(id)) refuse('unsupported_construct', ln.no, ln.col, `participant id ${JSON.stringify(id)} is a sequenceDiagram keyword`);
    if (!participants.has(id)) {
      participants.set(id, { id });
      implicit.push(id);
      lines[`participant:${id}`] = ln.no;
    }
    used.add(id);
  };
  const push = (step: SequenceStep, ln: Line): string => {
    const top = stack[stack.length - 1];
    const path = `${top.path}${top.count++}`;
    top.steps.push(step);
    lines[`step:${path}`] = ln.no;
    return path;
  };
  const restText = (raw: string, ln: Line, what: string): string => {
    const t = raw.trim();
    if (t === '') refuse('syntax', ln.no, ln.col, `${what} needs text`);
    checkRestOfLine(t, ln.no, ln.col);
    return decodeText(t);
  };
  const optionalLabel = (raw: string | undefined, ln: Line): string | undefined => {
    if (raw === undefined || raw.trim() === '') return undefined;
    checkRestOfLine(raw.trim(), ln.no, ln.col);
    return decodeText(raw.trim());
  };

  for (const ln of body) {
    const b = stripTerminator(ln.body);
    let m: RegExpExecArray | null;
    if (/^autonumber$/i.test(b)) {
      autonumber = true;
    } else if (/^autonumber\b/i.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, 'autonumber with arguments is outside the subset');
    } else if ((m = /^(participant|actor)\s+([A-Za-z0-9_]+)(?:\s+as\s+(.+))?$/i.exec(b)) !== null) {
      const id = m[2];
      checkId(id, ln.no, ln.col, 'participant id');
      if (isSequenceKeyword(id)) refuse('unsupported_construct', ln.no, ln.col, `participant id ${JSON.stringify(id)} is a sequenceDiagram keyword`);
      if (participants.has(id)) {
        refuse('unsupported_construct', ln.no, ln.col, used.has(id) ? `declare participant ${id} before its first message` : `participant ${id} is declared twice`);
      }
      const p: SequenceParticipant = { id };
      if (m[1].toLowerCase() === 'actor') p.kind = 'actor';
      const label = optionalLabel(m[3], ln);
      if (label !== undefined && label !== id) p.label = label;
      participants.set(id, p);
      lines[`participant:${id}`] = ln.no;
    } else if (/^(participant|actor)\b/i.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, 'a participant id must be an ASCII identifier (use "participant X as Any Label")');
    } else if (SEQ_UNSUPPORTED.test(b)) {
      refuse('unsupported_construct', ln.no, ln.col, `"${b.split(/\s/)[0]}" is outside the subset`);
    } else if ((m = /^note\s+(over|left of|right of)\s+([A-Za-z0-9_]+(?:\s*,\s*[A-Za-z0-9_]+)?)\s*:(.*)$/i.exec(b)) !== null) {
      const place = m[1].toLowerCase();
      const ids = m[2].split(',').map((s) => s.trim());
      if (place !== 'over' && ids.length > 1) refuse('syntax', ln.no, ln.col, `a note ${place} names one participant`);
      ids.forEach((id) => participant(id, ln));
      const side = place === 'over' ? 'over' : place === 'left of' ? 'left' : 'right';
      push({ kind: 'note', ...(side !== 'over' ? { side } : {}), participants: ids, text: restText(m[3], ln, 'a note') }, ln);
    } else if (/^note\b/i.test(b)) {
      refuse('syntax', ln.no, ln.col, 'a note is: Note over|left of|right of <id>[,<id>]: text');
    } else if ((m = /^(alt|opt|loop)(?:\s+(.*))?$/i.exec(b)) !== null) {
      if (stack.length > SEQUENCE_MAX_DEPTH) refuse('unsupported_construct', ln.no, ln.col, `blocks nest deeper than ${SEQUENCE_MAX_DEPTH}`);
      const label = optionalLabel(m[2], ln);
      const block: SequenceBlock = { kind: m[1].toLowerCase() as 'alt' | 'opt' | 'loop', steps: [], ...(label !== undefined ? { label } : {}) };
      const path = push(block, ln);
      stack.push({ steps: block.steps, block, blockPath: path, path: `${path}.`, count: 0 });
    } else if ((m = /^else(?:\s+(.*))?$/i.exec(b)) !== null) {
      const top = stack[stack.length - 1];
      if (top.block === null || top.block.kind !== 'alt') refuse('syntax', ln.no, ln.col, '"else" outside an alt block');
      const label = optionalLabel(m[1], ln);
      const branch = { steps: [] as SequenceStep[], ...(label !== undefined ? { label } : {}) };
      const blk = top.block;
      blk.else = [...(blk.else ?? []), branch];
      stack.pop();
      stack.push({ steps: branch.steps, block: blk, blockPath: top.blockPath, path: `${top.blockPath}.else${blk.else.length - 1}.`, count: 0 });
    } else if (/^end$/i.test(b)) {
      if (stack.length === 1) refuse('syntax', ln.no, ln.col, '"end" without an open block');
      stack.pop();
    } else if ((m = SEQ_MESSAGE_RE.exec(b)) !== null) {
      const [, from, arrowTok, activation, to, text] = m;
      const arrow = SEQ_ARROWS[arrowTok];
      if (arrow === undefined) refuse('unsupported_construct', ln.no, ln.col, `arrow ${JSON.stringify(arrowTok)} is outside the subset (->>, -->>, -x, --x)`);
      if (activation !== '') refuse('unsupported_construct', ln.no, ln.col, 'activation shorthand (+/-) is outside the subset');
      participant(from, ln);
      participant(to, ln);
      push({ kind: 'message', from, to, ...(arrow !== 'solid' ? { arrow } : {}), text: restText(text, ln, 'a message') }, ln);
    } else {
      refuse('syntax', ln.no, ln.col, `unrecognised sequenceDiagram statement ${JSON.stringify(b)}`);
    }
  }
  if (stack.length > 1) refuse('syntax', body.at(-1)?.no ?? 1, 1, 'a block is never closed with "end"');
  const spec: SequenceDiagramSpec = { participants: [...participants.values()], steps: root };
  if (autonumber) spec.autonumber = true;
  return spec;
}
