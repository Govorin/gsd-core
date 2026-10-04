/**
 * Mermaid Module — deterministic builders for the diagrams GSD derives from
 * data: flowchart, stateDiagram-v2, gantt, classDiagram, erDiagram,
 * sequenceDiagram.
 *
 * ── Why the diagram is built, never drawn ──
 *
 * A model-drawn diagram invents nodes and edges, and valid mermaid syntax makes
 * the invention read as fact (arXiv 2508.00255, 2601.20476). So every caller
 * here hands over DATA — nodes read from files, transitions read from a code
 * table — and this module only spells it. Three guarantees follow from that
 * shape and are enforced, not hoped for:
 *
 *   1. Nothing is added. An edge, transition, relation or `after` reference to
 *      an id that was not declared THROWS instead of letting mermaid invent the
 *      node implicitly. A class name used on a node must have a `classDefs`
 *      entry.
 *   2. The same input yields the same bytes. Output order is the caller's
 *      array order, everywhere; nothing iterates a hash, a Set or the clock.
 *      A caller that wants a sorted diagram sorts its arrays (the order is
 *      usually meaningful — a lifecycle ladder, a wave order).
 *   3. No input text can change the diagram's structure. Ids are checked
 *      against a strict grammar (`createIdRegistry` turns any string into one,
 *      injectively); free text goes through `escapeLabel`, which leaves no
 *      character that mermaid could read as syntax.
 *
 * ── LEAF MODULE ──
 *
 * Imports nothing, so any `src/` module (plan graphs, roadmap graphs, doc
 * generators under `scripts/`) can depend on it without joining a require
 * cycle. Node built-ins are not needed either: this is string assembly.
 *
 * ADR-457 build-at-publish: source in src/mermaid.cts, compiled to
 * gsd-core/bin/lib/mermaid.cjs (gitignored).
 */

// ─── Derived marker ──────────────────────────────────────────────────────────

const DERIVED_MARKER_PREFIX = '<!-- gsd:derived source=';
const DERIVED_MARKER_SUFFIX = ' — regenerated, do not hand-edit -->';

/**
 * The first line of every generated document: tells a reader (and a reviewer
 * of a diff) that hand edits will be overwritten, and names what to rerun.
 *
 * `source` must be a single token-ish string: a newline or a `--` would let
 * the source name end the HTML comment early and leak into the document.
 */
export function derivedMarker(source: string): string {
  if (typeof source !== 'string' || source.trim() === '') {
    throw new TypeError('derivedMarker: source must be a non-empty string');
  }
  if (/[\r\n]|--|>/.test(source)) {
    throw new TypeError(`derivedMarker: source ${JSON.stringify(source)} must not contain a newline, "--" or ">"`);
  }
  return `${DERIVED_MARKER_PREFIX}${source}${DERIVED_MARKER_SUFFIX}`;
}

/** Wrap a diagram in a ```mermaid fence. The diagram must not contain a fence itself. */
export function fence(diagram: string): string {
  if (diagram.includes('```')) {
    throw new TypeError('fence: diagram text must not contain a ``` fence');
  }
  return `\`\`\`mermaid\n${diagram}\n\`\`\``;
}

// ─── Text escaping ───────────────────────────────────────────────────────────

/**
 * Mermaid entity codes for every character that could be read as syntax in a
 * label: `"` ends a quoted label, `#` starts an entity, `;` ends a statement,
 * `<`/`>` are HTML (and `>` completes an arrow), `|` delimits an edge label,
 * a backtick opens a markdown string, `:` separates a gantt task's data, `{`
 * and `}` open and close a class/entity body, and a `-` run reads as a link
 * (`--`, `-->`, `---`). Unicode text is kept verbatim — mermaid renders it.
 */
const ENTITY: Readonly<Record<string, string>> = Object.freeze({
  '#': '#35;',
  '"': '#quot;',
  ';': '#59;',
  '<': '#lt;',
  '>': '#gt;',
  '|': '#124;',
  '`': '#96;',
  ':': '#58;',
  '{': '#123;',
  '}': '#125;',
  '-': '#45;',
});

const ENTITY_DECODE: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ENTITY).map(([ch, code]) => [code, ch])),
);

/**
 * ONE pass over the text: a `-` run of two or more, or any single character in
 * ENTITY. A second pass would re-escape the `#` and `;` of entities the first
 * pass emitted (`#` → `#35;` → `#35#59;`), which mermaid then renders as
 * garbage — the real parser caught exactly that.
 */
const ESCAPE_RE = /-{2,}|[#";<>|`:{}]/g;

/** The line-break mermaid renders inside a label. */
const LINE_BREAK = '<br/>';

/**
 * Normalise arbitrary input into one logical text: CRLF/CR and the Unicode
 * line/paragraph separators (U+2028/U+2029 — a regex `.` does not cross them,
 * so a reader would see a line end mermaid may not) → LF, tab → space,
 * every other C0/C1 control and the bidi/zero-width format characters dropped
 * (they can disguise what a label says), surrounding whitespace trimmed.
 */
function normalizeText(text: unknown): string {
  let s: string;
  if (typeof text === 'string') s = text;
  else if (typeof text === 'number' || typeof text === 'boolean' || typeof text === 'bigint') s = String(text);
  else if (text === null || text === undefined) s = '';
  else throw new TypeError(`mermaid: label text must be a string, number or boolean, got ${typeof text}`);
  return s
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .trim();
}

/**
 * Escape free text for any mermaid label position used by the builders below
 * (quoted node/state/class labels, edge and transition labels, notes, gantt
 * task names, section titles).
 *
 * Only a `-` that is part of a run of two or more is escaped: a lone hyphen
 * (`01-02`) cannot form a link and stays readable. A newline becomes `<br/>`,
 * inserted after escaping so its `<`/`>` survive.
 */
export function escapeLabel(text: unknown): string {
  const normalized = normalizeText(text);
  return normalized
    .split('\n')
    .map((line) => line.replace(ESCAPE_RE, (tok) => (tok.length > 1 ? ENTITY['-'].repeat(tok.length) : ENTITY[tok])))
    .join(LINE_BREAK);
}

/**
 * Inverse of `escapeLabel` for text that went through it: entity codes back to
 * characters, `<br/>` back to a newline. Exists so a consumer (or a test) can
 * read a generated diagram back into the data it was built from.
 */
export function unescapeLabel(text: string): string {
  return text
    .split(LINE_BREAK)
    .map((line) => line.replace(/#(?:quot|lt|gt|\d+);/g, (code) => ENTITY_DECODE[code] ?? code))
    .join('\n');
}

// ─── Identifiers ─────────────────────────────────────────────────────────────

/**
 * Words the grammars treat as statements or keywords; an id equal to one breaks
 * parsing (`end` in a flowchart — confirmed with the real parser) or changes
 * meaning (`default` is the classDef every flowchart node inherits).
 */
const RESERVED_IDS: ReadonlySet<string> = new Set([
  'end', 'graph', 'flowchart', 'subgraph', 'direction', 'style', 'linkstyle', 'classdef', 'class',
  'click', 'call', 'href', 'default', 'state', 'note', 'as', 'namespace', 'erdiagram', 'classdiagram',
  'statediagram', 'gantt',
]);

/** Gantt task ids additionally must not read as a task tag or a gantt statement. */
const GANTT_RESERVED_IDS: ReadonlySet<string> = new Set([
  'done', 'active', 'crit', 'milestone', 'after', 'until', 'section', 'title', 'dateformat', 'axisformat',
  'excludes', 'includes', 'todaymarker', 'tickinterval', 'weekday', 'weekend',
]);

/**
 * sequenceDiagram's lexer is case-insensitive and reads these as statements
 * wherever a participant id could stand (`end` and `note` are already above).
 */
const SEQUENCE_RESERVED_IDS: ReadonlySet<string> = new Set([
  'participant', 'actor', 'alt', 'else', 'opt', 'loop', 'over', 'left', 'right', 'of', 'autonumber',
  'activate', 'deactivate', 'par', 'and', 'rect', 'critical', 'option', 'break', 'box', 'title', 'create',
  'destroy', 'links', 'link', 'properties', 'details', 'sequencediagram', 'acctitle', 'accdescr',
]);

/** True when `id` is a word sequenceDiagram reads as a statement (case-insensitive). */
export function isSequenceKeyword(id: string): boolean {
  const lower = id.toLowerCase();
  return SEQUENCE_RESERVED_IDS.has(lower) || RESERVED_IDS.has(lower);
}

/** The id grammar every builder enforces: an ASCII identifier that is not a keyword. */
const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `id` can be written into a diagram as-is (gantt task ids are checked more strictly). */
export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id) && !RESERVED_IDS.has(id.toLowerCase());
}

/**
 * Spell `raw` with identifier characters only: ASCII letters, digits and `_`
 * stay; any other ASCII character becomes `_`; a non-ASCII code point becomes
 * `u<hex>`. Not injective on its own (`a.b` and `a-b` both give `a_b`) — use
 * `createIdRegistry` when distinct inputs must stay distinct.
 */
function spellId(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (/[A-Za-z0-9_]/.test(ch)) out += ch;
    else if (cp < 0x80) out += '_';
    else out += `u${cp.toString(16)}`;
  }
  return out;
}

export interface IdRegistry {
  /** The diagram id for `raw` — the same id every time for the same `raw`. */
  id(raw: string): string;
  /** Every `[raw, id]` pair handed out so far, in first-request order. */
  entries(): Array<[string, string]>;
}

/**
 * Hand out diagram ids for arbitrary strings, injectively and deterministically.
 *
 * The id is `prefix + spellId(raw)`. When that spelling is already taken by a
 * DIFFERENT raw string (`02.1-01` vs `02-1-01`), the later one gets `_2`, `_3`,
 * … — so the result depends only on the order of first requests, which the
 * caller controls. A spelling that starts with a digit (or is empty) gets an
 * `n_` lead, and one that collides with any keyword (gantt's and
 * sequenceDiagram's included, so a registry id is valid in every diagram type)
 * gets a trailing `_`.
 */
export function createIdRegistry(prefix = ''): IdRegistry {
  if (prefix !== '' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) {
    throw new TypeError(`createIdRegistry: prefix ${JSON.stringify(prefix)} is not an identifier`);
  }
  const byRaw = new Map<string, string>();
  const taken = new Set<string>();
  return {
    id(raw: string): string {
      const known = byRaw.get(raw);
      if (known !== undefined) return known;
      let base = prefix + spellId(String(raw));
      if (!/^[A-Za-z_]/.test(base)) base = `n_${base}`;
      const lower = base.toLowerCase();
      if (RESERVED_IDS.has(lower) || GANTT_RESERVED_IDS.has(lower) || SEQUENCE_RESERVED_IDS.has(lower)) base = `${base}_`;
      let candidate = base;
      for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
      taken.add(candidate);
      byRaw.set(raw, candidate);
      return candidate;
    },
    entries(): Array<[string, string]> {
      return [...byRaw.entries()];
    },
  };
}

function assertId(id: unknown, where: string): asserts id is string {
  if (!isSafeId(id)) {
    throw new TypeError(
      `${where}: ${JSON.stringify(id)} is not a safe mermaid id (ASCII identifier, not a keyword) — use createIdRegistry()`,
    );
  }
}

function assertUnique(ids: readonly string[], where: string): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new TypeError(`${where}: duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
  }
  return seen;
}

function assertKnown(id: string, known: ReadonlySet<string>, where: string): void {
  if (!known.has(id)) {
    throw new TypeError(`${where}: ${JSON.stringify(id)} was never declared — a diagram must not invent nodes`);
  }
}

// ─── Styles ──────────────────────────────────────────────────────────────────

export interface ClassDef {
  /** The class name nodes refer to (`:::name`). */
  name: string;
  /** Mermaid style list, e.g. `fill:#e6f4ea,stroke:#2e7d32`. */
  style: string;
}

/** A style list may hold only what CSS property/value pairs need — no newline, `;` or quote. */
const STYLE_RE = /^[A-Za-z0-9#:,.%\- ()]+$/;

/** True when `style` is a style list every builder accepts (`classDef` / `linkStyle`). */
export function isPlainStyle(style: unknown): style is string {
  return typeof style === 'string' && STYLE_RE.test(style);
}

function assertStyle(style: unknown, where: string): asserts style is string {
  if (!isPlainStyle(style)) {
    throw new TypeError(`${where}: style ${JSON.stringify(style)} is not a plain mermaid style list`);
  }
}

function renderClassDefs(classDefs: readonly ClassDef[], where: string): { lines: string[]; names: Set<string> } {
  const names = assertUnique(
    classDefs.map((c) => c.name),
    `${where} classDefs`,
  );
  const lines: string[] = [];
  for (const c of classDefs) {
    assertId(c.name, `${where} classDef`);
    assertStyle(c.style, `${where} classDef ${c.name}`);
    lines.push(`  classDef ${c.name} ${c.style}`);
  }
  return { lines, names };
}

// ─── flowchart ───────────────────────────────────────────────────────────────

export type FlowDirection = 'LR' | 'RL' | 'TB' | 'TD' | 'BT';

const DIRECTIONS: ReadonlySet<string> = new Set(['LR', 'RL', 'TB', 'TD', 'BT']);

export type FlowShape = 'rect' | 'round' | 'stadium' | 'subroutine' | 'cylinder' | 'circle' | 'rhombus' | 'hexagon';

const SHAPE: Readonly<Record<FlowShape, [string, string]>> = Object.freeze({
  rect: ['[', ']'],
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  rhombus: ['{', '}'],
  hexagon: ['{{', '}}'],
});

export interface FlowNode {
  id: string;
  /** Free text; defaults to the id. */
  label?: string;
  shape?: FlowShape;
  /** Name of a `classDefs` entry. */
  className?: string;
}

export type FlowEdgeStyle = 'solid' | 'dotted' | 'thick';

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  /** Line style; default `solid`. */
  line?: FlowEdgeStyle;
  /** Arrow head on `to`; default true. */
  arrow?: boolean;
  /** Extra `linkStyle` for this edge, e.g. `stroke:#d33,stroke-width:2px`. */
  linkStyle?: string;
}

export interface FlowSubgraph {
  id: string;
  title?: string;
  /** Node ids, in drawing order. A node belongs to at most one subgraph. */
  nodes: string[];
  direction?: FlowDirection;
}

export interface FlowchartSpec {
  direction?: FlowDirection;
  nodes: FlowNode[];
  edges?: FlowEdge[];
  subgraphs?: FlowSubgraph[];
  classDefs?: ClassDef[];
}

const LINK: Readonly<Record<FlowEdgeStyle, [string, string]>> = Object.freeze({
  solid: ['-->', '---'],
  dotted: ['-.->', '-.-'],
  thick: ['==>', '==='],
});

/**
 * Build a flowchart. Layout of the output, in order: the header; each subgraph
 * with its nodes; the nodes outside any subgraph; the edges; one `linkStyle`
 * per edge that asked for one (indexed by the edge's position); the classDefs.
 */
export function flowchart(spec: FlowchartSpec): string {
  const where = 'flowchart';
  const direction = spec.direction ?? 'LR';
  if (!DIRECTIONS.has(direction)) throw new TypeError(`${where}: unknown direction ${JSON.stringify(direction)}`);
  const { lines: classLines, names: classNames } = renderClassDefs(spec.classDefs ?? [], where);

  const nodes = spec.nodes;
  nodes.forEach((n) => assertId(n.id, `${where} node`));
  const nodeIds = assertUnique(
    nodes.map((n) => n.id),
    `${where} nodes`,
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const renderNode = (n: FlowNode, indent: string): string => {
    const brackets = SHAPE[n.shape ?? 'rect'];
    if (brackets === undefined) throw new TypeError(`${where}: node ${n.id} has unknown shape ${JSON.stringify(n.shape)}`);
    const [open, close] = brackets;
    let cls = '';
    if (n.className !== undefined) {
      if (!classNames.has(n.className)) {
        throw new TypeError(`${where}: node ${n.id} uses class ${JSON.stringify(n.className)} with no classDef`);
      }
      cls = `:::${n.className}`;
    }
    return `${indent}${n.id}${open}"${escapeLabel(n.label ?? n.id)}"${close}${cls}`;
  };

  const lines = [`flowchart ${direction}`];
  const placed = new Set<string>();
  const subgraphs = spec.subgraphs ?? [];
  subgraphs.forEach((s) => assertId(s.id, `${where} subgraph`));
  assertUnique(
    [...subgraphs.map((s) => s.id), ...nodeIds],
    `${where} subgraph/node ids`,
  );
  for (const s of subgraphs) {
    lines.push(`  subgraph ${s.id}["${escapeLabel(s.title ?? s.id)}"]`);
    if (s.direction !== undefined) {
      if (!DIRECTIONS.has(s.direction)) throw new TypeError(`${where}: unknown direction ${JSON.stringify(s.direction)}`);
      lines.push(`    direction ${s.direction}`);
    }
    for (const id of s.nodes) {
      assertKnown(id, nodeIds, `${where} subgraph ${s.id}`);
      if (placed.has(id)) throw new TypeError(`${where}: node ${id} is in more than one subgraph`);
      placed.add(id);
      lines.push(renderNode(byId.get(id) as FlowNode, '    '));
    }
    lines.push('  end');
  }
  for (const n of nodes) if (!placed.has(n.id)) lines.push(renderNode(n, '  '));

  const linkStyles: string[] = [];
  (spec.edges ?? []).forEach((e, i) => {
    assertKnown(e.from, nodeIds, `${where} edge ${i}`);
    assertKnown(e.to, nodeIds, `${where} edge ${i}`);
    const style = LINK[e.line ?? 'solid'];
    if (style === undefined) throw new TypeError(`${where}: edge ${i} has unknown line ${JSON.stringify(e.line)}`);
    const link = e.arrow === false ? style[1] : style[0];
    const label = e.label !== undefined ? `|"${escapeLabel(e.label)}"|` : '';
    lines.push(`  ${e.from} ${link}${label} ${e.to}`);
    if (e.linkStyle !== undefined) {
      assertStyle(e.linkStyle, `${where} edge ${i} linkStyle`);
      linkStyles.push(`  linkStyle ${i} ${e.linkStyle}`);
    }
  });
  lines.push(...linkStyles, ...classLines);
  return lines.join('\n');
}

// ─── stateDiagram-v2 ─────────────────────────────────────────────────────────

/** The start/end pseudo-state. */
export const STATE_TERMINAL = '[*]';

export interface StateNode {
  id: string;
  /** Free text; defaults to the id. */
  label?: string;
  className?: string;
}

export interface StateTransition {
  /** A declared state id or `STATE_TERMINAL`. */
  from: string;
  to: string;
  label?: string;
}

export interface StateGroup {
  /** Composite state id. */
  id: string;
  label?: string;
  /** Member state ids, in drawing order. A state belongs to at most one group. */
  states: string[];
}

export interface StateNote {
  state: string;
  side?: 'left' | 'right';
  text: string;
}

export interface StateDiagramSpec {
  direction?: FlowDirection;
  states: StateNode[];
  transitions?: StateTransition[];
  groups?: StateGroup[];
  notes?: StateNote[];
  classDefs?: ClassDef[];
}

/**
 * Build a stateDiagram-v2. Output order: header, classDefs, then each group's
 * block, then the top level. Inside every block: state declarations (always
 * explicit, `state "label" as id`), transitions, notes, class assignments.
 *
 * Every line that names a grouped state is written INSIDE that group's block —
 * the real parser showed that a top-level transition, note or `class` line for
 * a grouped state silently creates a second, top-level state of the same name
 * (an invented node). A transition whose two ends live in different blocks
 * cannot be written without that, so it THROWS (a `[*]` end takes the other
 * end's block).
 */
export function stateDiagram(spec: StateDiagramSpec): string {
  const where = 'stateDiagram';
  const { lines: classLines, names: classNames } = renderClassDefs(spec.classDefs ?? [], where);
  spec.states.forEach((s) => assertId(s.id, `${where} state`));
  const stateIds = assertUnique(
    spec.states.map((s) => s.id),
    `${where} states`,
  );
  const byId = new Map(spec.states.map((s) => [s.id, s]));
  const groups = spec.groups ?? [];
  groups.forEach((g) => assertId(g.id, `${where} group`));
  assertUnique(
    [...groups.map((g) => g.id), ...stateIds],
    `${where} group/state ids`,
  );

  const lines = ['stateDiagram-v2'];
  if (spec.direction !== undefined) {
    if (!DIRECTIONS.has(spec.direction)) throw new TypeError(`${where}: unknown direction ${JSON.stringify(spec.direction)}`);
    lines.push(`  direction ${spec.direction}`);
  }
  const declare = (s: StateNode, indent: string): string => `${indent}state "${escapeLabel(s.label ?? s.id)}" as ${s.id}`;
  const groupOf = new Map<string, string>();
  for (const g of groups) {
    for (const id of g.states) {
      assertKnown(id, stateIds, `${where} group ${g.id}`);
      if (groupOf.has(id)) throw new TypeError(`${where}: state ${id} is in more than one group`);
      groupOf.set(id, g.id);
    }
  }

  // Bucket every line by the block it must be written in ('' = top level).
  const TOP = '';
  const blockLines = new Map<string, string[]>([[TOP, []], ...groups.map((g): [string, string[]] => [g.id, []])]);
  (spec.transitions ?? []).forEach((t, i) => {
    for (const end of [t.from, t.to]) {
      if (end !== STATE_TERMINAL) assertKnown(end, stateIds, `${where} transition ${i}`);
    }
    const gFrom = t.from === STATE_TERMINAL ? undefined : (groupOf.get(t.from) ?? TOP);
    const gTo = t.to === STATE_TERMINAL ? undefined : (groupOf.get(t.to) ?? TOP);
    const block = gFrom ?? gTo ?? TOP;
    if ((gFrom ?? block) !== (gTo ?? block)) {
      throw new TypeError(
        `${where}: transition ${i} (${t.from} → ${t.to}) crosses a group boundary — mermaid would duplicate the state`,
      );
    }
    const label = t.label !== undefined && normalizeText(t.label) !== '' ? ` : ${escapeLabel(t.label)}` : '';
    blockLines.get(block)?.push(`${t.from} --> ${t.to}${label}`);
  });
  for (const n of spec.notes ?? []) {
    assertKnown(n.state, stateIds, `${where} note`);
    const side = n.side ?? 'right';
    if (side !== 'left' && side !== 'right') throw new TypeError(`${where}: note side ${JSON.stringify(side)}`);
    blockLines.get(groupOf.get(n.state) ?? TOP)?.push(`note ${side} of ${n.state} : ${escapeLabel(n.text)}`);
  }
  for (const s of spec.states) {
    if (s.className === undefined) continue;
    if (!classNames.has(s.className)) {
      throw new TypeError(`${where}: state ${s.id} uses class ${JSON.stringify(s.className)} with no classDef`);
    }
    blockLines.get(groupOf.get(s.id) ?? TOP)?.push(`class ${s.id} ${s.className}`);
  }
  lines.push(...classLines);

  for (const g of groups) {
    lines.push(`  state "${escapeLabel(g.label ?? g.id)}" as ${g.id} {`);
    for (const id of g.states) lines.push(declare(byId.get(id) as StateNode, '    '));
    for (const tl of blockLines.get(g.id) ?? []) lines.push(`    ${tl}`);
    lines.push('  }');
  }
  for (const s of spec.states) if (!groupOf.has(s.id)) lines.push(declare(s, '  '));
  for (const tl of blockLines.get(TOP) ?? []) lines.push(`  ${tl}`);
  return lines.join('\n');
}

// ─── gantt ───────────────────────────────────────────────────────────────────

export type GanttTag = 'done' | 'active' | 'crit' | 'milestone';

const GANTT_TAGS: ReadonlySet<string> = new Set(['done', 'active', 'crit', 'milestone']);

export interface GanttTask {
  id: string;
  label: string;
  /**
   * `YYYY-MM-DD`; or `after` ids below; or both omitted to follow the task
   * written just before it (spelled `after <previous>` — mermaid reads a bare
   * `id, 3d` as a start date). The first task of the chart needs one of them.
   */
  start?: string;
  /** Task ids this one starts after (declared earlier in the chart). */
  after?: string[];
  /** `YYYY-MM-DD` end date — exactly one of `end` / `duration`. */
  end?: string;
  /** e.g. `3d`, `1w`, `12h`. */
  duration?: string;
  tags?: GanttTag[];
}

export interface GanttSection {
  name: string;
  tasks: GanttTask[];
}

export interface GanttSpec {
  title?: string;
  /** Always `YYYY-MM-DD`: the builder validates dates in that form only. */
  axisFormat?: string;
  sections: GanttSection[];
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DURATION_RE = /^[1-9]\d*(ms|s|m|h|d|w)$/;
const AXIS_FORMAT_RE = /^[%A-Za-z0-9 .\-/]+$/;

/** Build a gantt chart (`dateFormat YYYY-MM-DD`). */
export function gantt(spec: GanttSpec): string {
  const where = 'gantt';
  const lines = ['gantt'];
  if (spec.title !== undefined) lines.push(`  title ${escapeLabel(spec.title)}`);
  lines.push('  dateFormat YYYY-MM-DD');
  if (spec.axisFormat !== undefined) {
    if (!AXIS_FORMAT_RE.test(spec.axisFormat)) throw new TypeError(`${where}: bad axisFormat ${JSON.stringify(spec.axisFormat)}`);
    lines.push(`  axisFormat ${spec.axisFormat}`);
  }
  const declared = new Set<string>();
  let previous: string | null = null;
  for (const section of spec.sections) {
    lines.push(`  section ${escapeLabel(section.name)}`);
    for (const t of section.tasks) {
      assertId(t.id, `${where} task`);
      if (GANTT_RESERVED_IDS.has(t.id.toLowerCase())) {
        throw new TypeError(`${where}: task id ${JSON.stringify(t.id)} is not a safe mermaid id here (a gantt keyword)`);
      }
      if (declared.has(t.id)) throw new TypeError(`${where}: duplicate task id ${JSON.stringify(t.id)}`);
      const parts: string[] = [];
      for (const tag of t.tags ?? []) {
        if (!GANTT_TAGS.has(tag)) throw new TypeError(`${where}: task ${t.id} has unknown tag ${JSON.stringify(tag)}`);
        parts.push(tag);
      }
      parts.push(t.id);
      if (t.start !== undefined && t.after !== undefined) {
        throw new TypeError(`${where}: task ${t.id} gives both start and after`);
      }
      if (t.start !== undefined) {
        if (!DATE_RE.test(t.start)) throw new TypeError(`${where}: task ${t.id} start ${JSON.stringify(t.start)} is not YYYY-MM-DD`);
        parts.push(t.start);
      } else if (t.after !== undefined) {
        if (t.after.length === 0) throw new TypeError(`${where}: task ${t.id} has an empty after list`);
        t.after.forEach((a) => assertKnown(a, declared, `${where} task ${t.id} after`));
        parts.push(`after ${t.after.join(' ')}`);
      } else {
        if (previous === null) throw new TypeError(`${where}: task ${t.id} is the first task and needs a start or after`);
        parts.push(`after ${previous}`);
      }
      if ((t.end === undefined) === (t.duration === undefined)) {
        throw new TypeError(`${where}: task ${t.id} needs exactly one of end / duration`);
      }
      if (t.end !== undefined) {
        if (!DATE_RE.test(t.end)) throw new TypeError(`${where}: task ${t.id} end ${JSON.stringify(t.end)} is not YYYY-MM-DD`);
        parts.push(t.end);
      } else {
        if (!DURATION_RE.test(t.duration as string)) {
          throw new TypeError(`${where}: task ${t.id} duration ${JSON.stringify(t.duration)} is not like 3d`);
        }
        parts.push(t.duration as string);
      }
      declared.add(t.id);
      previous = t.id;
      lines.push(`  ${escapeLabel(t.label)} :${parts.join(', ')}`);
    }
  }
  return lines.join('\n');
}

// ─── classDiagram ────────────────────────────────────────────────────────────

export type ClassRelationKind =
  | 'inheritance'
  | 'realization'
  | 'composition'
  | 'aggregation'
  | 'association'
  | 'dependency'
  | 'link';

/** `from <arrow> to`, read as "from inherits/realizes/is composed into/… to". */
const CLASS_ARROW: Readonly<Record<ClassRelationKind, string>> = Object.freeze({
  inheritance: '--|>',
  realization: '..|>',
  composition: '--*',
  aggregation: '--o',
  association: '-->',
  dependency: '..>',
  link: '--',
});

export interface ClassNode {
  id: string;
  label?: string;
  /** e.g. `interface`, rendered as `<<interface>>`. */
  annotation?: string;
  /** Attribute lines, e.g. `+string name`. */
  members?: string[];
  /** Method lines, e.g. `+run(input) Result`. */
  methods?: string[];
}

export interface ClassRelation {
  from: string;
  to: string;
  kind: ClassRelationKind;
  label?: string;
  fromCardinality?: string;
  toCardinality?: string;
}

export interface ClassDiagramSpec {
  direction?: FlowDirection;
  classes: ClassNode[];
  relations?: ClassRelation[];
}

/**
 * A member line keeps mermaid's own member syntax (visibility `+-#~`, `()`,
 * generics `~T~`, `$`/`*` classifiers) and loses only what could end the class
 * body or the line: braces, quotes, `;`, `<`/`>` and newlines become spaces.
 */
function sanitizeMember(text: string): string {
  return normalizeText(text)
    .replace(/[{}"`;<>\n]/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

const CARDINALITY_RE = /^[A-Za-z0-9.*]+$/;

/** Build a classDiagram. Every class is declared (with body when it has one) before any relation. */
export function classDiagram(spec: ClassDiagramSpec): string {
  const where = 'classDiagram';
  spec.classes.forEach((c) => assertId(c.id, `${where} class`));
  const ids = assertUnique(
    spec.classes.map((c) => c.id),
    `${where} classes`,
  );
  const lines = ['classDiagram'];
  if (spec.direction !== undefined) {
    if (!DIRECTIONS.has(spec.direction)) throw new TypeError(`${where}: unknown direction ${JSON.stringify(spec.direction)}`);
    lines.push(`  direction ${spec.direction}`);
  }
  for (const c of spec.classes) {
    const label = c.label !== undefined ? `["${escapeLabel(c.label)}"]` : '';
    const body = [...(c.members ?? []), ...(c.methods ?? [])].map(sanitizeMember).filter(Boolean);
    const annotation = c.annotation !== undefined ? sanitizeMember(c.annotation).replace(/\s+/g, '_') : '';
    if (body.length === 0 && annotation === '') {
      lines.push(`  class ${c.id}${label}`);
      continue;
    }
    lines.push(`  class ${c.id}${label} {`);
    if (annotation !== '') lines.push(`    <<${annotation}>>`);
    for (const m of body) lines.push(`    ${m}`);
    lines.push('  }');
  }
  (spec.relations ?? []).forEach((r, i) => {
    assertKnown(r.from, ids, `${where} relation ${i}`);
    assertKnown(r.to, ids, `${where} relation ${i}`);
    const arrow = CLASS_ARROW[r.kind];
    if (arrow === undefined) throw new TypeError(`${where}: relation ${i} has unknown kind ${JSON.stringify(r.kind)}`);
    const card = (c: string | undefined, side: string): string => {
      if (c === undefined) return '';
      if (!CARDINALITY_RE.test(c)) throw new TypeError(`${where}: relation ${i} ${side} cardinality ${JSON.stringify(c)} is invalid`);
      return side === 'from' ? ` "${c}"` : `"${c}" `;
    };
    const label = r.label !== undefined ? ` : ${escapeLabel(r.label)}` : '';
    lines.push(`  ${r.from}${card(r.fromCardinality, 'from')} ${arrow} ${card(r.toCardinality, 'to')}${r.to}${label}`);
  });
  return lines.join('\n');
}

// ─── erDiagram ───────────────────────────────────────────────────────────────

export type ErCardinality = 'zero-or-one' | 'exactly-one' | 'zero-or-more' | 'one-or-more';

const ER_LEFT: Readonly<Record<ErCardinality, string>> = Object.freeze({
  'zero-or-one': '|o',
  'exactly-one': '||',
  'zero-or-more': '}o',
  'one-or-more': '}|',
});

const ER_RIGHT: Readonly<Record<ErCardinality, string>> = Object.freeze({
  'zero-or-one': 'o|',
  'exactly-one': '||',
  'zero-or-more': 'o{',
  'one-or-more': '|{',
});

export type ErKey = 'PK' | 'FK' | 'UK';

const ER_KEYS: ReadonlySet<string> = new Set(['PK', 'FK', 'UK']);

export interface ErAttribute {
  /** Column type, e.g. `string`, `varchar(255)`, `int[]`. */
  type: string;
  name: string;
  keys?: ErKey[];
  comment?: string;
}

export interface ErEntity {
  id: string;
  attributes?: ErAttribute[];
}

export interface ErRelationship {
  left: string;
  right: string;
  leftCardinality: ErCardinality;
  rightCardinality: ErCardinality;
  /** Solid (`--`) when true (default), dashed (`..`) when false. */
  identifying?: boolean;
  label: string;
}

export interface ErDiagramSpec {
  entities: ErEntity[];
  relationships?: ErRelationship[];
}

/** ER attribute types/names: identifier characters plus the `()[]` a type spelling needs. */
function sanitizeErWord(text: string, where: string): string {
  const word = normalizeText(text).replace(/[^A-Za-z0-9_()[\]]/g, '_');
  if (!/^[A-Za-z_]/.test(word)) throw new TypeError(`${where}: ${JSON.stringify(text)} does not start with a letter`);
  return word;
}

/**
 * An ER comment is a double-quoted string that mermaid shows verbatim (entity
 * codes are NOT decoded there), so a `"` becomes `'` and line breaks a space.
 */
function sanitizeErComment(text: string): string {
  return normalizeText(text).replace(/"/g, "'").replace(/\n/g, ' ');
}

/** Build an erDiagram. Entities with attributes get a body; relationships follow in input order. */
export function erDiagram(spec: ErDiagramSpec): string {
  const where = 'erDiagram';
  spec.entities.forEach((e) => assertId(e.id, `${where} entity`));
  const ids = assertUnique(
    spec.entities.map((e) => e.id),
    `${where} entities`,
  );
  const lines = ['erDiagram'];
  for (const e of spec.entities) {
    const attrs = e.attributes ?? [];
    if (attrs.length === 0) {
      lines.push(`  ${e.id}`);
      continue;
    }
    lines.push(`  ${e.id} {`);
    for (const a of attrs) {
      const keys = (a.keys ?? []).map((k) => {
        if (!ER_KEYS.has(k)) throw new TypeError(`${where}: ${e.id}.${a.name} has unknown key ${JSON.stringify(k)}`);
        return k;
      });
      let line = `    ${sanitizeErWord(a.type, `${where} ${e.id} type`)} ${sanitizeErWord(a.name, `${where} ${e.id} name`)}`;
      if (keys.length > 0) line += ` ${keys.join(', ')}`;
      if (a.comment !== undefined && normalizeText(a.comment) !== '') line += ` "${sanitizeErComment(a.comment)}"`;
      lines.push(line);
    }
    lines.push('  }');
  }
  (spec.relationships ?? []).forEach((r, i) => {
    assertKnown(r.left, ids, `${where} relationship ${i}`);
    assertKnown(r.right, ids, `${where} relationship ${i}`);
    const left = ER_LEFT[r.leftCardinality];
    const right = ER_RIGHT[r.rightCardinality];
    if (left === undefined || right === undefined) {
      throw new TypeError(`${where}: relationship ${i} has an unknown cardinality`);
    }
    const line = r.identifying === false ? '..' : '--';
    lines.push(`  ${r.left} ${left}${line}${right} ${r.right} : "${sanitizeErComment(r.label)}"`);
  });
  return lines.join('\n');
}

// ─── sequenceDiagram ─────────────────────────────────────────────────────────

export type SequenceParticipantKind = 'participant' | 'actor';

export interface SequenceParticipant {
  id: string;
  /** Free text shown instead of the id (`participant S as ThingService`). */
  label?: string;
  /** Box (default) or stick figure. */
  kind?: SequenceParticipantKind;
}

/** Line and head of a message: `->>` solid, `-->>` dotted (a reply), `-x` / `--x` with a cross (lost). */
export type SequenceArrow = 'solid' | 'dotted' | 'solid-cross' | 'dotted-cross';

const SEQUENCE_ARROW: Readonly<Record<SequenceArrow, string>> = Object.freeze({
  solid: '->>',
  dotted: '-->>',
  'solid-cross': '-x',
  'dotted-cross': '--x',
});

export interface SequenceMessage {
  kind: 'message';
  from: string;
  to: string;
  /** Default `solid`. */
  arrow?: SequenceArrow;
  /** Free text; must not be empty (mermaid requires message text). */
  text: string;
}

export interface SequenceNote {
  kind: 'note';
  /** `over` (default) spans one or two participants; `left` / `right` sit beside exactly one. */
  side?: 'over' | 'left' | 'right';
  participants: string[];
  text: string;
}

export interface SequenceBranch {
  label?: string;
  steps: SequenceStep[];
}

export interface SequenceBlock {
  kind: 'alt' | 'opt' | 'loop';
  label?: string;
  steps: SequenceStep[];
  /** `alt` only: the `else` branches, in order. */
  else?: SequenceBranch[];
}

export type SequenceStep = SequenceMessage | SequenceNote | SequenceBlock;

export interface SequenceDiagramSpec {
  participants: SequenceParticipant[];
  steps?: SequenceStep[];
  autonumber?: boolean;
}

/** `alt`/`opt`/`loop` may nest this deep; deeper is a diagram nobody reads. */
export const SEQUENCE_MAX_DEPTH = 3;

/**
 * Build a sequenceDiagram. Every participant is declared, in input order,
 * before the first step — mermaid would otherwise create a participant the
 * first time a message names it (an invented node), so a message, note or
 * block that names an undeclared participant THROWS.
 */
export function sequenceDiagram(spec: SequenceDiagramSpec): string {
  const where = 'sequenceDiagram';
  for (const p of spec.participants) {
    assertId(p.id, `${where} participant`);
    if (isSequenceKeyword(p.id)) {
      throw new TypeError(`${where}: participant id ${JSON.stringify(p.id)} is a sequenceDiagram keyword`);
    }
  }
  const ids = assertUnique(
    spec.participants.map((p) => p.id),
    `${where} participants`,
  );
  const lines = ['sequenceDiagram'];
  if (spec.autonumber === true) lines.push('  autonumber');
  for (const p of spec.participants) {
    const kind = p.kind ?? 'participant';
    if (kind !== 'participant' && kind !== 'actor') {
      throw new TypeError(`${where}: participant ${p.id} has unknown kind ${JSON.stringify(kind)}`);
    }
    const label = p.label !== undefined ? escapeLabel(p.label) : '';
    lines.push(label === '' ? `  ${kind} ${p.id}` : `  ${kind} ${p.id} as ${label}`);
  }

  const text = (raw: unknown, what: string): string => {
    const t = escapeLabel(raw);
    if (t === '') throw new TypeError(`${where}: ${what} needs text`);
    return t;
  };
  const blockLabel = (raw: string | undefined): string => {
    const t = raw === undefined ? '' : escapeLabel(raw);
    return t === '' ? '' : ` ${t}`;
  };
  const renderSteps = (steps: readonly SequenceStep[], depth: number, path: string): void => {
    const indent = '  '.repeat(depth + 1);
    steps.forEach((step, i) => {
      const at = `${path}${i}`;
      if (step.kind === 'message') {
        assertKnown(step.from, ids, `${where} message ${at}`);
        assertKnown(step.to, ids, `${where} message ${at}`);
        const arrow = SEQUENCE_ARROW[step.arrow ?? 'solid'];
        if (arrow === undefined) throw new TypeError(`${where}: message ${at} has unknown arrow ${JSON.stringify(step.arrow)}`);
        lines.push(`${indent}${step.from}${arrow}${step.to}: ${text(step.text, `message ${at}`)}`);
      } else if (step.kind === 'note') {
        const side = step.side ?? 'over';
        const max = side === 'over' ? 2 : 1;
        if (step.participants.length < 1 || step.participants.length > max) {
          throw new TypeError(`${where}: note ${at} (${side}) takes 1${max === 2 ? ' or 2' : ''} participants`);
        }
        step.participants.forEach((p) => assertKnown(p, ids, `${where} note ${at}`));
        const place = side === 'over' ? 'over' : side === 'left' ? 'left of' : side === 'right' ? 'right of' : null;
        if (place === null) throw new TypeError(`${where}: note ${at} has unknown side ${JSON.stringify(side)}`);
        lines.push(`${indent}Note ${place} ${step.participants.join(',')}: ${text(step.text, `note ${at}`)}`);
      } else if (step.kind === 'alt' || step.kind === 'opt' || step.kind === 'loop') {
        if (depth + 1 > SEQUENCE_MAX_DEPTH) {
          throw new TypeError(`${where}: block ${at} nests deeper than ${SEQUENCE_MAX_DEPTH}`);
        }
        if (step.else !== undefined && step.kind !== 'alt') {
          throw new TypeError(`${where}: block ${at} is ${step.kind}; only alt has else branches`);
        }
        lines.push(`${indent}${step.kind}${blockLabel(step.label)}`);
        renderSteps(step.steps, depth + 1, `${at}.`);
        (step.else ?? []).forEach((branch, b) => {
          lines.push(`${indent}else${blockLabel(branch.label)}`);
          renderSteps(branch.steps, depth + 1, `${at}.else${b}.`);
        });
        lines.push(`${indent}end`);
      } else {
        throw new TypeError(`${where}: step ${at} has unknown kind ${JSON.stringify((step as { kind?: unknown }).kind)}`);
      }
    });
  };
  renderSteps(spec.steps ?? [], 0, '');
  return lines.join('\n');
}
