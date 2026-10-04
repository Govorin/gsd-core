/**
 * Decision Tree Module — the decisions of a discuss-phase session as a
 * dependency graph: which question grill mode asks next (the frontier) and the
 * mermaid picture of the tree, both computed from data, never from a model's
 * memory.
 *
 * Two sources, one graph:
 *
 *   - the grill checkpoint (`*-DISCUSS-CHECKPOINT.json`, key `decision_tree`)
 *     while the session runs — open questions included;
 *   - the written `*-CONTEXT.md` afterwards — decisions read through the one
 *     `<decisions>` parser (`decisions.cts`), with the two inline fields grill
 *     writes, `— **Decided by:** user|recommendation|codebase` and
 *     `— **Depends on:** D-01, D-02`. A CONTEXT.md from another mode has
 *     neither field and still draws (decided, unattributed, no edges).
 *
 * The rules (the ones of plan-graph.cts and roadmap-graph.cts):
 *
 *   - a node is a declared decision, an edge is a `depends_on` entry, and
 *     nothing else is drawn; defects are DRAWN, never dropped — a dependency on
 *     an id that is not in the tree (dashed edge to a marked node), a
 *     dependency cycle, a duplicate id, a malformed checkpoint entry, a decided
 *     node with no valid `decided_by`. Failing on them is the caller's choice
 *     (`strict`);
 *   - the frontier is every open node whose dependencies are all closed
 *     (decided, or left to discretion). The next question is the EARLIEST
 *     frontier node (declaration order) that other open decisions depend on;
 *     when none has dependents, the earliest frontier node;
 *   - a pass is one level of the tree: roots are level 1, a node is one level
 *     below its deepest dependency. `workflow.max_discuss_passes` caps the
 *     level put to the user — an open node deeper than the cap is never asked
 *     (`beyond_cap`), and the session stops with `stopped: 'pass_cap'` when
 *     only such nodes remain on the frontier.
 *
 * Shape (as plan-graph): read → pure `build*` → `render*` (marker + fence +
 * legend + defect list) → `run*` (I/O, discriminated union).
 *
 * ADR-457 build-at-publish: source in src/decision-tree.cts, compiled to
 * gsd-core/bin/lib/decision-tree.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFECT_CLASS_DEFS,
  DEFECT_LINK_STYLE,
  WARNING_LINK_STYLE,
  createIdRegistry,
  derivedMarker,
  fence,
  flowchart,
} from './mermaid.cjs';
import type { ClassDef, FlowEdge, FlowNode, FlowSubgraph } from './mermaid.cjs';
import { DECISION_ID_SOURCE, extractDecisions, isDiscretionHeading } from './decisions.cjs';
import { readWorkflowConfigValue } from './gate-config.cjs';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** Who closed a decision: the user's own answer, the user accepting the recommended answer, or a fact read from the code. */
export const DECIDED_BY: readonly DecidedBy[] = Object.freeze(['user', 'recommendation', 'codebase']);
export type DecidedBy = 'user' | 'recommendation' | 'codebase';

/** `discretion` — closed without the user: left to the planner with its recommendation (pass cap, or the user stopped). */
export const NODE_STATUSES: readonly NodeStatus[] = Object.freeze(['open', 'decided', 'discretion']);
export type NodeStatus = 'open' | 'decided' | 'discretion';

/** `workflow.max_discuss_passes` when the key is absent or not a positive integer — the default in config-defaults.manifest.json. */
export const DEFAULT_MAX_DISCUSS_PASSES = 3;

const ID_RE = new RegExp(`^${DECISION_ID_SOURCE}$`);
const ID_TOKEN_RE = new RegExp(`\\b${DECISION_ID_SOURCE}`, 'g');

export interface DecisionNodeInput {
  id: string;
  /** The question while open; the decision once closed. */
  label: string;
  status: NodeStatus;
  /** Null when no valid attribution was recorded. */
  decidedBy: DecidedBy | null;
  dependsOn: string[];
  /** The gray area / CONTEXT.md category, or '' when none. */
  area: string;
}

export type TreeDefectType = 'invalid_node' | 'unattributed' | 'duplicate' | 'missing' | 'cycle';

export interface TreeDefect {
  type: TreeDefectType;
  /** The node the defect is about; null for an entry with no readable id. */
  id: string | null;
  /** The other end — the dependency of a `missing` / `cycle` edge. */
  ref?: string;
  message: string;
}

function isDecidedBy(v: unknown): v is DecidedBy {
  return typeof v === 'string' && (DECIDED_BY as readonly string[]).includes(v);
}

function isNodeStatus(v: unknown): v is NodeStatus {
  return typeof v === 'string' && (NODE_STATUSES as readonly string[]).includes(v);
}

/** A positive integer (or its decimal string), else the default. */
export function resolveMaxPasses(value: unknown): number {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : DEFAULT_MAX_DISCUSS_PASSES;
}

/** `workflow.max_discuss_passes` as `config-get` resolves it (workstream config first). */
export function readMaxDiscussPasses(projectDir: string): number {
  const resolved = readWorkflowConfigValue(projectDir, 'workflow.max_discuss_passes');
  return resolveMaxPasses(resolved.found ? resolved.value : undefined);
}

// ─── Reading: the grill checkpoint ───────────────────────────────────────────

export interface ReadTree {
  nodes: DecisionNodeInput[];
  /** Entry-level defects found while reading (`invalid_node`, `unattributed`). */
  defects: TreeDefect[];
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * The `decision_tree.nodes` array of a checkpoint object, or null when the
 * object carries no tree. Entry shape:
 * `{ id, question, answer?, status, decided_by?, depends_on?, area? }`.
 * A malformed entry is a defect and is left out of the graph; a decided entry
 * without a valid `decided_by` stays in, unattributed, and is a defect too —
 * grill must say who decided.
 */
export function readCheckpointTree(checkpoint: unknown): ReadTree | null {
  if (checkpoint === null || typeof checkpoint !== 'object') return null;
  const tree = (checkpoint as Record<string, unknown>).decision_tree;
  if (tree === null || typeof tree !== 'object') return null;
  const entries = (tree as Record<string, unknown>).nodes;
  if (!Array.isArray(entries)) return null;

  const nodes: DecisionNodeInput[] = [];
  const defects: TreeDefect[] = [];
  entries.forEach((raw: unknown, index: number) => {
    const where = `decision_tree.nodes[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      defects.push({ type: 'invalid_node', id: null, message: `${where} не объект` });
      return;
    }
    const e = raw as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!ID_RE.test(id)) {
      defects.push({ type: 'invalid_node', id: null, message: `${where}: id ${JSON.stringify(e.id)} не в формате D-NN` });
      return;
    }
    if (!isNodeStatus(e.status)) {
      defects.push({ type: 'invalid_node', id, message: `${id}: status ${JSON.stringify(e.status)} — ожидается ${NODE_STATUSES.join(' | ')}` });
      return;
    }
    const deps = e.depends_on === undefined ? [] : e.depends_on;
    if (!Array.isArray(deps) || !deps.every((d) => typeof d === 'string')) {
      defects.push({ type: 'invalid_node', id, message: `${id}: depends_on должен быть массивом id` });
      return;
    }
    const label = e.status === 'decided' && nonEmpty(e.answer) ? e.answer : e.question;
    if (!nonEmpty(label)) {
      defects.push({ type: 'invalid_node', id, message: `${id}: нет текста — ни question, ни answer` });
      return;
    }
    let decidedBy: DecidedBy | null = null;
    if (e.status === 'decided') {
      if (isDecidedBy(e.decided_by)) decidedBy = e.decided_by;
      else {
        defects.push({
          type: 'unattributed',
          id,
          message: `${id}: решение без decided_by (${DECIDED_BY.join(' | ')}), получено ${JSON.stringify(e.decided_by)}`,
        });
      }
    }
    nodes.push({
      id,
      label: label.trim(),
      status: e.status,
      decidedBy,
      dependsOn: deps.map((d) => d.trim()).filter(Boolean),
      area: nonEmpty(e.area) ? e.area.trim() : '',
    });
  });
  return { nodes, defects };
}

// ─── Reading: CONTEXT.md ─────────────────────────────────────────────────────

/**
 * Splits a decision's text at each ` — **Field:** ` lead-in. The lookahead is
 * bounded, so the split is linear; a dash followed by ordinary prose (the
 * rationale after `**Reversibility:** one-way —`) is not a field boundary.
 */
const FIELD_SPLIT_RE = /\s[—–]\s(?=\*\*[A-Za-z][A-Za-z ]{0,30}:\*\*)/;
const FIELD_RE = /^\*\*([A-Za-z][A-Za-z ]{0,30}):\*\*\s*(.*)$/s;

/** The decision statement and its inline `**Field:** value` pairs (keys lower-cased). */
export function splitDecisionFields(text: string): { statement: string; fields: Map<string, string> } {
  const [statement, ...rest] = text.split(FIELD_SPLIT_RE);
  const fields = new Map<string, string>();
  for (const seg of rest) {
    const m = seg.match(FIELD_RE);
    if (m !== null && !fields.has(m[1].toLowerCase())) fields.set(m[1].toLowerCase(), m[2].trim());
  }
  return { statement: statement.trim(), fields };
}

/** Every decision id named in a `Depends on` value, in order, without repeats. */
export function parseDependsOnField(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(ID_TOKEN_RE)) if (!out.includes(m[0])) out.push(m[0]);
  return out;
}

export type ReadContextResult =
  | { ok: true; tree: ReadTree }
  | { ok: false; reason: 'no_tree' | 'unreadable'; message: string };

/** The decisions of a CONTEXT.md as tree nodes. */
export function readContextTree(content: string): ReadContextResult {
  const extraction = extractDecisions(content);
  if (extraction.outcome === 'could-not-parse') {
    const ids = extraction.unreadableIds ?? [];
    return {
      ok: false,
      reason: 'unreadable',
      message: `CONTEXT.md decisions could not be parsed${ids.length > 0 ? ` (${ids.join(', ')})` : ''}`,
    };
  }
  if (extraction.decisions.length === 0) {
    return { ok: false, reason: 'no_tree', message: 'CONTEXT.md has no decisions' };
  }
  const nodes: DecisionNodeInput[] = [];
  const defects: TreeDefect[] = [];
  for (const d of extraction.decisions) {
    const { statement, fields } = splitDecisionFields(d.text);
    const discretion = isDiscretionHeading(d.category);
    let decidedBy: DecidedBy | null = null;
    const by = fields.get('decided by');
    if (by !== undefined) {
      const word = by.toLowerCase().match(/^[a-z]+/)?.[0] ?? '';
      if (isDecidedBy(word)) decidedBy = word;
      else defects.push({ type: 'unattributed', id: d.id, message: `${d.id}: Decided by ${JSON.stringify(by)} — ожидается ${DECIDED_BY.join(' | ')}` });
    }
    nodes.push({
      id: d.id,
      label: statement === '' ? d.text.trim() : statement,
      status: discretion ? 'discretion' : 'decided',
      decidedBy: discretion ? null : decidedBy,
      dependsOn: parseDependsOnField(fields.get('depends on') ?? ''),
      area: discretion ? '' : d.category,
    });
  }
  return { ok: true, tree: { nodes, defects } };
}

export type ReadTreeFileResult =
  | { ok: true; source: 'checkpoint' | 'context'; tree: ReadTree }
  | { ok: false; reason: 'not_found' | 'unreadable' | 'no_tree'; message: string };

/** A `.json` file is a checkpoint; anything else is read as CONTEXT.md. */
export function readTreeFile(file: string): ReadTreeFileResult {
  if (!fs.existsSync(file)) return { ok: false, reason: 'not_found', message: `file not found: ${file}` };
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: `cannot read ${file}: ${(e as Error).message}` };
  }
  if (path.extname(file).toLowerCase() === '.json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'unreadable', message: `${file} is not JSON: ${(e as Error).message}` };
    }
    const tree = readCheckpointTree(parsed);
    if (tree === null) return { ok: false, reason: 'no_tree', message: `${file} has no decision_tree.nodes array` };
    return { ok: true, source: 'checkpoint', tree };
  }
  const ctx = readContextTree(text);
  return ctx.ok ? { ok: true, source: 'context', tree: ctx.tree } : ctx;
}

// ─── The graph ───────────────────────────────────────────────────────────────

export type EdgeDefect = 'missing' | 'cycle';

export interface TreeEdge {
  /** The dependency. */
  from: string;
  /** The decision that depends on it. */
  to: string;
  defect: EdgeDefect | null;
  /** The dependent is decided while its dependency is still open — its answer may have to be revisited. */
  warning: 'decided_before_dep' | null;
}

export interface TreeNode extends DecisionNodeInput {
  /** Pass the node belongs to (1 = roots); counted over non-defect edges only. */
  level: number;
  /** Distinct open decisions that transitively wait on this one. */
  unblocks: number;
}

export interface DecisionTree {
  /** Declaration order (first occurrence of a duplicated id wins). */
  nodes: TreeNode[];
  edges: TreeEdge[];
  /** Ids named in `depends_on` that are not nodes, sorted. */
  missing: string[];
  maxPasses: number;
  /** Open nodes whose dependencies are all closed, in declaration order. */
  frontier: string[];
  /** The question to ask now, or null. */
  next: string | null;
  stopped: 'complete' | 'pass_cap' | 'blocked' | null;
  /** Open nodes deeper than the pass cap — never put to the user. */
  beyondCap: string[];
  /** Open nodes off the frontier and what each waits on (open or defective dependencies). */
  blocked: Array<{ id: string; waiting_on: string[] }>;
  defects: TreeDefect[];
}

const byNumericId = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

/** Edges, levels, frontier and defects from the nodes' own declarations. Pure. */
export function buildDecisionTree(
  input: readonly DecisionNodeInput[],
  opts: { maxPasses?: number; readDefects?: readonly TreeDefect[] } = {},
): DecisionTree {
  const maxPasses = resolveMaxPasses(opts.maxPasses);
  const defects: TreeDefect[] = [...(opts.readDefects ?? [])];

  const nodes: DecisionNodeInput[] = [];
  const byId = new Map<string, DecisionNodeInput>();
  for (const n of input) {
    if (byId.has(n.id)) {
      defects.push({ type: 'duplicate', id: n.id, message: `${n.id} объявлен повторно — учтено первое объявление` });
      continue;
    }
    byId.set(n.id, n);
    nodes.push(n);
  }

  const edges: TreeEdge[] = [];
  const missing = new Set<string>();
  for (const n of nodes) {
    for (const dep of n.dependsOn) {
      const defect: EdgeDefect | null = byId.has(dep) ? null : 'missing';
      if (defect === 'missing') missing.add(dep);
      edges.push({ from: dep, to: n.id, defect, warning: null });
    }
  }

  // An edge dep→id lies on a cycle when id can reach dep. Marking every such
  // edge leaves the rest acyclic, so levels below are well-defined.
  const out = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) if (e.defect === null) out.get(e.from)?.push(e.to);
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === goal) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of out.get(cur) ?? []) stack.push(nxt);
    }
    return false;
  };
  for (const e of edges) if (e.defect === null && reaches(e.to, e.from)) e.defect = 'cycle';

  const sound = edges.filter((e) => e.defect === null);
  const depsOf = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  const dependentsOf = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of sound) {
    depsOf.get(e.to)?.push(e.from);
    dependentsOf.get(e.from)?.push(e.to);
  }

  const levels = new Map<string, number>();
  const levelOf = (id: string): number => {
    const known = levels.get(id);
    if (known !== undefined) return known;
    const lvl = 1 + Math.max(0, ...(depsOf.get(id) ?? []).map(levelOf));
    levels.set(id, lvl);
    return lvl;
  };

  const isOpen = (id: string): boolean => byId.get(id)?.status === 'open';
  const unblocksOf = (id: string): number => {
    const seen = new Set<string>();
    const stack = [...(dependentsOf.get(id) ?? [])];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(dependentsOf.get(cur) ?? []));
    }
    return [...seen].filter(isOpen).length;
  };

  const treeNodes: TreeNode[] = nodes.map((n) => ({ ...n, level: levelOf(n.id), unblocks: unblocksOf(n.id) }));

  for (const e of sound) {
    if (byId.get(e.to)?.status === 'decided' && isOpen(e.from)) e.warning = 'decided_before_dep';
  }

  const frontier: string[] = [];
  const blocked: Array<{ id: string; waiting_on: string[] }> = [];
  for (const n of treeNodes) {
    if (n.status !== 'open') continue;
    const waiting = edges
      .filter((e) => e.to === n.id && (e.defect !== null || isOpen(e.from)))
      .map((e) => e.from);
    if (waiting.length === 0) frontier.push(n.id);
    else blocked.push({ id: n.id, waiting_on: [...new Set(waiting)] });
  }

  const levelById = new Map(treeNodes.map((n) => [n.id, n]));
  const askable = frontier.filter((id) => (levelById.get(id) as TreeNode).level <= maxPasses);
  const next = askable.find((id) => (levelById.get(id) as TreeNode).unblocks > 0) ?? askable[0] ?? null;
  const openCount = treeNodes.filter((n) => n.status === 'open').length;
  let stopped: DecisionTree['stopped'] = null;
  if (next === null) stopped = openCount === 0 ? 'complete' : frontier.length > 0 ? 'pass_cap' : 'blocked';

  for (const e of edges) {
    if (e.defect === 'missing') {
      defects.push({ type: 'missing', id: e.to, ref: e.from, message: `${e.to} зависит от ${e.from}, такого решения в дереве нет` });
    } else if (e.defect === 'cycle') {
      defects.push({ type: 'cycle', id: e.to, ref: e.from, message: `${e.from} → ${e.to} лежит на цикле зависимостей` });
    }
  }

  return {
    nodes: treeNodes,
    edges,
    missing: [...missing].sort(byNumericId),
    maxPasses,
    frontier,
    next,
    stopped,
    beyondCap: treeNodes.filter((n) => n.status === 'open' && n.level > maxPasses).map((n) => n.id),
    blocked,
    defects,
  };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export type TreeNodeState = 'by_user' | 'by_recommendation' | 'by_codebase' | 'decided' | 'next_q' | 'open_q' | 'discretion';

/** What the node's colour says. */
export function treeNodeState(n: Pick<TreeNode, 'id' | 'status' | 'decidedBy'>, next: string | null): TreeNodeState {
  if (n.status === 'open') return n.id === next ? 'next_q' : 'open_q';
  if (n.status === 'discretion') return 'discretion';
  return n.decidedBy === null ? 'decided' : `by_${n.decidedBy}`;
}

const GLYPH: Readonly<Record<TreeNodeState, string>> = Object.freeze({
  by_user: '✓',
  by_recommendation: '★',
  by_codebase: '⌂',
  decided: '•',
  next_q: '▶',
  open_q: '?',
  discretion: '~',
});

const TREE_CLASS_DEFS: readonly ClassDef[] = Object.freeze([
  { name: 'by_user', style: 'fill:#e6f4ea,stroke:#2e7d32' },
  { name: 'by_recommendation', style: 'fill:#e8f0fe,stroke:#1a73e8' },
  { name: 'by_codebase', style: 'fill:#f1f3f4,stroke:#5f6368' },
  { name: 'decided', style: 'fill:#fff,stroke:#2e7d32' },
  { name: 'next_q', style: 'fill:#fff4e5,stroke:#ef6c00,stroke-width:3px' },
  { name: 'open_q', style: 'fill:#fff,stroke:#ef6c00,stroke-dasharray:4 3' },
  { name: 'discretion', style: 'fill:#fafafa,stroke:#999999,stroke-dasharray:2 2,color:#555' },
  DEFECT_CLASS_DEFS.missing,
]);

/** Long decision texts are cut at a fixed width so the drawing stays readable; the full text is in CONTEXT.md. */
const LABEL_WIDTH = 60;

function shortLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return [...flat].length <= LABEL_WIDTH ? flat : `${[...flat].slice(0, LABEL_WIDTH - 1).join('')}…`;
}

/** The source name in the derived marker; `gsd-tools discuss tree` regenerates it. */
export const DECISION_TREE_SOURCE = 'decision-tree';

export const DECISION_TREE_LEGEND =
  'Легенда: ✓ решил человек · ★ принята рекомендация · ⌂ факт из кода · • решено (кто — не указано) · ' +
  '▶ следующий вопрос · ? открыт · ~ на усмотрение планировщика (не спрошено)';

/** The mermaid flowchart text (no fence) for a built tree. */
export function decisionTreeDiagram(tree: DecisionTree): string {
  const ids = createIdRegistry('d_');
  const nodes: FlowNode[] = tree.nodes.map((n) => {
    const st = treeNodeState(n, tree.next);
    return { id: ids.id(n.id), label: `${GLYPH[st]} ${n.id}\n${shortLabel(n.label)}`, className: st };
  });
  for (const m of tree.missing) nodes.push({ id: ids.id(m), label: `${m} — нет такого решения`, className: 'missing' });

  const areas = [...new Set(tree.nodes.map((n) => n.area).filter(Boolean))];
  const subgraphs: FlowSubgraph[] = areas.map((area, i) => ({
    id: `A${i + 1}`,
    title: area,
    nodes: tree.nodes.filter((n) => n.area === area).map((n) => ids.id(n.id)),
  }));

  const edges: FlowEdge[] = tree.edges.map((e) => {
    const linkStyle = e.defect !== null ? DEFECT_LINK_STYLE : e.warning !== null ? WARNING_LINK_STYLE : undefined;
    return {
      from: ids.id(e.from),
      to: ids.id(e.to),
      line: e.defect === 'missing' ? 'dotted' : 'solid',
      ...(linkStyle !== undefined ? { linkStyle } : {}),
    };
  });
  return flowchart({ direction: 'TD', nodes, subgraphs, edges, classDefs: [...TREE_CLASS_DEFS] });
}

/** One line per defect, then one per warning edge. */
export function describeDefects(tree: DecisionTree): string[] {
  const warnings = tree.edges
    .filter((e) => e.warning === 'decided_before_dep')
    .map((e) => `${e.to} решено раньше, чем ${e.from}, от которого оно зависит (предупреждение)`);
  return [...tree.defects.map((d) => d.message), ...warnings];
}

/** The whole derived document: marker, fenced diagram, legend, and the defect list when there is one. */
export function renderDecisionTree(tree: DecisionTree): string {
  const doc = [derivedMarker(DECISION_TREE_SOURCE), '', fence(decisionTreeDiagram(tree)), '', DECISION_TREE_LEGEND, ''];
  const lines = describeDefects(tree);
  if (lines.length > 0) doc.push('Дефекты дерева:', ...lines.map((d) => `- ${d}`), '');
  return doc.join('\n');
}

// ─── Command core ────────────────────────────────────────────────────────────

export interface DecisionTreeCommandOptions {
  /** Absolute checkpoint (.json) or CONTEXT.md path (the router resolves and confines it). */
  file: string;
  /** Absolute output file, or null to return the document. */
  out: string | null;
  strict: boolean;
  maxPasses: number;
}

export type DecisionTreeCommandResult =
  | {
      ok: true;
      source: 'checkpoint' | 'context';
      max_passes: number;
      node_count: number;
      edge_count: number;
      counts: Record<NodeStatus, number>;
      decided_by: Record<DecidedBy | 'unattributed', number>;
      /** The question to ask now. */
      next: { id: string; label: string; area: string; level: number; unblocks: number } | null;
      /** Why there is no next question: every node closed, only nodes past the pass cap left, or defects block the rest. */
      stopped: 'complete' | 'pass_cap' | 'blocked' | null;
      frontier: string[];
      beyond_cap: string[];
      blocked: Array<{ id: string; waiting_on: string[] }>;
      defect_count: number;
      defects: TreeDefect[];
      warnings: Array<{ from: string; to: string; type: 'decided_before_dep' }>;
      written: string | null;
      markdown: string;
      /** True when `strict` was asked and there are defects: the caller fails the process. */
      strict_failed: boolean;
    }
  | { ok: false; reason: 'not_found' | 'unreadable' | 'no_tree' | 'write_failed'; message: string };

/**
 * Everything `gsd-tools discuss tree` does except argv parsing, path
 * confinement, config lookup and process exit — so tests drive it directly.
 */
export function runDecisionTree(opts: DecisionTreeCommandOptions): DecisionTreeCommandResult {
  const read = readTreeFile(opts.file);
  if (!read.ok) return read;
  const tree = buildDecisionTree(read.tree.nodes, { maxPasses: opts.maxPasses, readDefects: read.tree.defects });
  const markdown = renderDecisionTree(tree);
  if (opts.out !== null) {
    try {
      fs.writeFileSync(opts.out, markdown);
    } catch (e) {
      return { ok: false, reason: 'write_failed', message: `cannot write ${opts.out}: ${(e as Error).message}` };
    }
  }
  const count = (pred: (n: TreeNode) => boolean): number => tree.nodes.filter(pred).length;
  const decided = (n: TreeNode): boolean => n.status === 'decided';
  const nextNode = tree.next === null ? null : (tree.nodes.find((n) => n.id === tree.next) as TreeNode);
  return {
    ok: true,
    source: read.source,
    max_passes: tree.maxPasses,
    node_count: tree.nodes.length,
    edge_count: tree.edges.length,
    counts: {
      open: count((n) => n.status === 'open'),
      decided: count(decided),
      discretion: count((n) => n.status === 'discretion'),
    },
    decided_by: {
      user: count((n) => decided(n) && n.decidedBy === 'user'),
      recommendation: count((n) => decided(n) && n.decidedBy === 'recommendation'),
      codebase: count((n) => decided(n) && n.decidedBy === 'codebase'),
      unattributed: count((n) => decided(n) && n.decidedBy === null),
    },
    next:
      nextNode === null
        ? null
        : { id: nextNode.id, label: nextNode.label, area: nextNode.area, level: nextNode.level, unblocks: nextNode.unblocks },
    stopped: tree.stopped,
    frontier: tree.frontier,
    beyond_cap: tree.beyondCap,
    blocked: tree.blocked,
    defect_count: tree.defects.length,
    defects: tree.defects,
    warnings: tree.edges
      .filter((e) => e.warning !== null)
      .map((e) => ({ from: e.from, to: e.to, type: 'decided_before_dep' as const })),
    written: opts.out,
    markdown,
    strict_failed: opts.strict && tree.defects.length > 0,
  };
}

/** The one-line `--raw` summary when `--out` wrote the document. */
export function summaryLine(r: { node_count: number; counts: Record<NodeStatus, number>; defect_count: number }, out: string): string {
  return `OK: ${out} — ${r.node_count} decision(s), ${r.counts.open} open, ${r.defect_count} defect(s)`;
}
