/**
 * Roadmap Graph Module — ROADMAP.md's phases as a mermaid flowchart (dependencies,
 * status, milestone) and, when completion dates are recorded, a gantt of them.
 *
 * Built from data, never drawn from memory (the rules of plan-graph.cts):
 *
 *   - a node is a phase `roadmap analyze` reports — the SAME collection
 *     (`analyzeRoadmap`), so the graph cannot show a phase set analyze would not;
 *     an edge is a phase reference inside the phase's `**Depends on:**` value,
 *     read through the PlanningDoc seam and matched by phase-id.cts's
 *     `phaseDepRefs`, or `extractPhaseDependencyTokens` under the bracket
 *     convention (no local grammar: dates, shas and ledger ids are not
 *     references);
 *   - defects are DRAWN, not hidden and not judged: a reference to a phase that
 *     exists nowhere (red dashed edge to a `missing` node), a cycle, a complete
 *     phase whose dependency is not (red), a dependency on a later-numbered
 *     phase (amber — legal after a decimal insertion, so a warning), a
 *     `Depends on` that names no phase (an `unparsed` note), a ROADMAP checkbox
 *     that disagrees with disk (red outline). Failing on them is a gate's job;
 *     the renderer fails only on request (`strict`, errors only);
 *   - a node's colour says what is on disk (`DISK_STATUS` via analyze). A
 *     closed milestone's phase whose directory was archived away is drawn as
 *     archived, not as empty;
 *   - the gantt has only what is recorded: the `Completed` column of the
 *     Progress table. There is no start date anywhere, so there are no bars —
 *     each phase is a point on its completion day (`1d` is the size of the
 *     point, not a claim about duration). A start date from git history is NOT
 *     used: it moves on rebase, and the same ROADMAP would give other bytes.
 *
 * Shape (as plan-graph): pure `build*` → `*Spec` (the data handed to the
 * mermaid builders — what tests assert on) → `render*` (marker + fences +
 * defect list) → `run*` (I/O, discriminated union).
 *
 * ADR-457 build-at-publish: source in src/roadmap-graph.cts, compiled to
 * gsd-core/bin/lib/roadmap-graph.cjs (gitignored).
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
  gantt,
} from './mermaid.cjs';
import type { ClassDef, FlowEdge, FlowNode, FlowSubgraph, FlowchartSpec, GanttSection, GanttSpec } from './mermaid.cjs';
import { DISK_STATUS } from './phase-status.cjs';
import { locateRoadmapProgress } from './roadmap-progress.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap.cjs is an export= CommonJS module
import roadmapMod = require('./roadmap.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- roadmap-parser.cjs is an export= CommonJS module
import roadmapParser = require('./roadmap-parser.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
import phaseIdMod = require('./phase-id.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-locator.cjs is an export= CommonJS module
import phaseLocator = require('./phase-locator.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');

const { phaseDepRefs, extractPhaseDependencyTokens, parsePhaseId, phaseKeyFromToken, phaseKeyFromProse, phaseKeyFromDir, comparePhaseNum } = phaseIdMod;

// ─── Input ───────────────────────────────────────────────────────────────────

export interface RoadmapPhaseInput {
  /** Unique within one graph: milestone ordinal + phase key (numbers may restart per milestone). */
  key: string;
  /** The phase token as ROADMAP writes it (`3`, `02.1`). */
  id: string;
  name: string;
  /** The milestone heading the phase sits under, or null when ROADMAP has none. */
  milestone: string | null;
  milestoneVersion: string | null;
  milestoneClosed: boolean;
  /** A `DISK_STATUS` value, as `roadmap analyze` reports it. */
  status: string;
  /** The ROADMAP checkbox disagrees with the disk status (analyze's `checkbox_conflict`). */
  checkboxConflict: boolean;
  /** The `**Depends on:**` value, or null when the phase has none. */
  dependsRaw: string | null;
  /** The raw `Completed` cell of the Progress table, or null when the phase has no row. */
  completed: string | null;
}

/** A phase that exists outside the drawn set — another milestone's, or only a directory. */
export interface KnownPhase {
  id: string;
  name: string | null;
  milestone: string | null;
}

export interface RoadmapGraphInput {
  phases: RoadmapPhaseInput[];
  /** A reference to one of these is not missing: it is drawn as an outside node. */
  known: KnownPhase[];
  /** Phase fields the PlanningDoc seam could not read. */
  unreadable: Array<{ phase: string; field: string; reason: string }>;
  /**
   * The project's `phase_id_convention`. Under `bracket`, a reference may name its milestone
   * (`Phase [GSD.02] 01`); absent or anything else, only legacy references are read.
   */
  convention?: string | null;
}

// ─── The graph ───────────────────────────────────────────────────────────────

export type RoadmapEdgeDefect = 'missing' | 'cycle' | 'done-before-dep' | 'forward';

export interface RoadmapEdge {
  /** The dependency: a phase key, an outside key or a missing key. */
  from: string;
  /** The phase that depends on it (a phase key). */
  to: string;
  /** The reference as written in `Depends on`. */
  ref: string;
  defect: RoadmapEdgeDefect | null;
}

export interface OutsideNode {
  key: string;
  id: string;
  name: string | null;
  milestone: string | null;
}

export type RoadmapDefectType = RoadmapEdgeDefect | 'unparsed' | 'checkbox_conflict' | 'bad-date' | 'unreadable';

export interface RoadmapDefect {
  type: RoadmapDefectType;
  /** `warning` never fails `--strict`: a forward reference is legal after a decimal insertion. */
  severity: 'error' | 'warning';
  /** The phase the defect is about (its id as written). */
  phase: string;
  /** For an edge defect: the dependency as written. */
  ref?: string;
  /** The human-readable line printed under the diagram. */
  message: string;
}

export interface RoadmapGraph {
  /** Input order (document order, as analyze reports them). */
  phases: RoadmapPhaseInput[];
  /** In phase order, then `Depends on` order. */
  edges: RoadmapEdge[];
  /** References that resolve to nothing, as written, one per phase key, in phase-number order. */
  missing: string[];
  outside: OutsideNode[];
  unparsed: Array<{ phase: string; raw: string }>;
  /** Phase keys whose Progress-table completion date is a real `YYYY-MM-DD` date. */
  dates: Map<string, string>;
  defects: RoadmapDefect[];
}

const MISSING_PREFIX = 'missing:';
const OUTSIDE_PREFIX = 'outside:';

/** "Nothing", "None", "N/A", a dash: the phase declares no dependency. */
const NO_DEPENDENCY_RE = /^(?:nothing|none|n\/a|no dependencies|-|—)(?=$|[\s(.,;:])/i;

/** A `Completed` cell that says "not yet" rather than giving a date. */
const NO_DATE_RE = /^(?:-|—|–|n\/a)?$/i;

const DATE_SHAPE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in `YYYY-MM-DD` (`2026-02-30` is not one). */
export function isCalendarDate(value: string): boolean {
  const m = DATE_SHAPE_RE.exec(value);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

const phaseNumOrder = (a: string, b: string): number => comparePhaseNum(a, b) || a.localeCompare(b);

/** A bracket phase directory's milestone (`GSD.02-05-x` → `[GSD.02]`), or null when it is not one. */
function bracketOfDir(dir: string): string | null {
  try {
    const id = parsePhaseId(dir);
    return `[${id.project}.${id.milestone}]`;
  } catch {
    return null;
  }
}

/**
 * A reference's phase key, and the bracket milestone it names (`[GSD.02]`) when it is
 * qualified (`[GSD.02] 01`); a legacy reference (`01`) names none.
 */
function referenceTarget(ref: string): { key: string; bracket: string | null; nodeKey: string } {
  try {
    const id = parsePhaseId(ref);
    const token = id.subphase ? `${id.phase}.${id.subphase}` : id.phase;
    const key = phaseKeyFromToken(token);
    // `nodeKey` becomes a diagram node id, so it carries no bracket punctuation.
    return { key, bracket: `[${id.project}.${id.milestone}]`, nodeKey: `${id.project}_${id.milestone}_${key}` };
  } catch {
    const key = phaseKeyFromToken(ref);
    return { key, bracket: null, nodeKey: key };
  }
}

/** Edges, missing and outside nodes, and every defect, from the phases' own declarations. Pure. */
export function buildRoadmapGraph(input: RoadmapGraphInput): RoadmapGraph {
  const phases = [...input.phases];
  const byPhaseKey = new Map<string, RoadmapPhaseInput[]>();
  for (const p of phases) {
    const k = phaseKeyFromToken(p.id);
    const list = byPhaseKey.get(k) ?? [];
    list.push(p);
    byPhaseKey.set(k, list);
  }
  const knownByKey = new Map<string, KnownPhase>();
  for (const k of input.known) {
    const pk = phaseKeyFromToken(k.id);
    // A ROADMAP entry (it has a name) wins over a bare directory with the same number.
    const prev = knownByKey.get(pk);
    if (prev === undefined || (prev.name === null && k.name !== null)) knownByKey.set(pk, k);
  }

  const edges: RoadmapEdge[] = [];
  const missing = new Map<string, string>();
  const outside = new Map<string, OutsideNode>();
  const unparsed: Array<{ phase: string; raw: string }> = [];
  const defects: RoadmapDefect[] = [];

  for (const p of phases) {
    if (p.dependsRaw === null || NO_DEPENDENCY_RE.test(p.dependsRaw.trim())) continue;
    // The same reader split init.manager uses: bracket-aware under the bracket convention.
    const refs = input.convention === 'bracket'
      ? extractPhaseDependencyTokens(p.dependsRaw, 'bracket')
      : phaseDepRefs(p.dependsRaw);
    if (refs.length === 0) {
      unparsed.push({ phase: p.key, raw: p.dependsRaw });
      continue;
    }
    for (const ref of refs) {
      const { key: phaseKey, bracket, nodeKey: rk } = referenceTarget(ref);
      // A qualified reference names its milestone: only a phase under that milestone's
      // heading can satisfy it — never the same number in another milestone.
      const inBracket = (milestone: string | null): boolean => bracket === null || (milestone ?? '').includes(bracket);
      const candidates = (byPhaseKey.get(phaseKey) ?? []).filter((c) => inBracket(c.milestone));
      // Numbers may restart per milestone: a reference means the phase of the
      // SAME milestone first, then any drawn phase with that number.
      const target = candidates.find((c) => c.milestone === p.milestone) ?? candidates[0];
      if (target !== undefined) {
        edges.push({ from: target.key, to: p.key, ref, defect: null });
        continue;
      }
      const sameKey = (k: KnownPhase): boolean => phaseKeyFromToken(k.id) === phaseKey;
      // Under a qualified reference: a ROADMAP entry under that milestone, else a phase
      // directory of that milestone (a directory with no readable milestone still exists).
      const known = bracket === null
        ? knownByKey.get(phaseKey)
        : input.known.find((k) => sameKey(k) && k.milestone !== null && inBracket(k.milestone))
          ?? input.known.find((k) => sameKey(k) && k.milestone === null);
      if (known !== undefined) {
        const key = `${OUTSIDE_PREFIX}${rk}`;
        if (!outside.has(key)) outside.set(key, { key, id: known.id, name: known.name, milestone: known.milestone });
        edges.push({ from: key, to: p.key, ref, defect: null });
        continue;
      }
      if (!missing.has(rk)) missing.set(rk, ref);
      edges.push({ from: `${MISSING_PREFIX}${rk}`, to: p.key, ref, defect: 'missing' });
    }
  }

  // An edge dep→phase lies on a cycle when phase can reach dep (a self-reference is a cycle of one).
  const byKey = new Map(phases.map((p) => [p.key, p]));
  const adj = new Map<string, string[]>(phases.map((p) => [p.key, []]));
  for (const e of edges) if (byKey.has(e.from)) adj.get(e.from)?.push(e.to);
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (cur === goal) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
    }
    return false;
  };
  for (const e of edges) {
    if (e.defect !== null) continue;
    const dep = byKey.get(e.from);
    const ph = byKey.get(e.to) as RoadmapPhaseInput;
    if (dep === undefined) continue; // an outside dependency: its status and order are not drawn
    if (reaches(e.to, e.from)) e.defect = 'cycle';
    else if (ph.status === DISK_STATUS.COMPLETE && dep.status !== DISK_STATUS.COMPLETE) e.defect = 'done-before-dep';
    else if (dep.milestone === ph.milestone && comparePhaseNum(dep.id, ph.id) > 0) e.defect = 'forward';
  }

  const label = (key: string): string => {
    const p = byKey.get(key);
    if (p !== undefined) return p.id;
    if (key.startsWith(OUTSIDE_PREFIX)) return outside.get(key)?.id ?? key;
    return missing.get(key.slice(MISSING_PREFIX.length)) ?? key;
  };
  for (const e of edges) {
    if (e.defect === null) continue;
    const to = byKey.get(e.to) as RoadmapPhaseInput;
    const message =
      e.defect === 'missing'
        ? `${to.id} зависит от фазы ${e.ref}, а такой фазы нет ни в ROADMAP, ни среди каталогов фаз`
        : e.defect === 'cycle'
          ? `${label(e.from)} → ${to.id} лежит на цикле зависимостей`
          : e.defect === 'done-before-dep'
            ? `${to.id} завершена, а её зависимость ${label(e.from)} — нет (${byKey.get(e.from)?.status})`
            : `${to.id} зависит от более поздней фазы ${label(e.from)} — проверьте порядок`;
    defects.push({ type: e.defect, severity: e.defect === 'forward' ? 'warning' : 'error', phase: to.id, ref: e.ref, message });
  }
  for (const u of unparsed) {
    const p = byKey.get(u.phase) as RoadmapPhaseInput;
    defects.push({ type: 'unparsed', severity: 'error', phase: p.id, message: `${p.id}: в «Depends on» нет ни одной ссылки на фазу: ${u.raw}` });
  }
  for (const p of phases) {
    if (!p.checkboxConflict) continue;
    defects.push({
      type: 'checkbox_conflict',
      severity: 'error',
      phase: p.id,
      message: `${p.id}: чекбокс ROADMAP расходится со статусом на диске (${p.status})`,
    });
  }
  const dates = new Map<string, string>();
  for (const p of phases) {
    if (p.completed === null) continue;
    const v = p.completed.trim();
    if (NO_DATE_RE.test(v)) continue;
    if (isCalendarDate(v)) {
      dates.set(p.key, v);
      continue;
    }
    defects.push({
      type: 'bad-date',
      severity: 'error',
      phase: p.id,
      message: `${p.id}: дата завершения «${v}» не в формате YYYY-MM-DD — на gantt не попала`,
    });
  }
  for (const u of input.unreadable) {
    defects.push({ type: 'unreadable', severity: 'error', phase: u.phase, message: `${u.phase}: поле «${u.field}» не прочитано (${u.reason})` });
  }

  return {
    phases,
    edges,
    missing: [...missing.values()].sort(phaseNumOrder),
    outside: [...outside.values()],
    unparsed,
    dates,
    defects,
  };
}

// ─── Drawing ─────────────────────────────────────────────────────────────────

export type RoadmapNodeState = 'done' | 'running' | 'pending' | 'empty' | 'archived';

/**
 * Every `DISK_STATUS` value → its colour. Checked at load against the owner's
 * vocabulary, so a new disk status fails here instead of drawing nothing.
 */
const STATE_BY_DISK: Readonly<Record<string, RoadmapNodeState>> = Object.freeze({
  [DISK_STATUS.COMPLETE]: 'done',
  [DISK_STATUS.EXECUTED]: 'running',
  [DISK_STATUS.PARTIAL]: 'running',
  [DISK_STATUS.PLANNED]: 'pending',
  [DISK_STATUS.RESEARCHED]: 'pending',
  [DISK_STATUS.DISCUSSED]: 'pending',
  [DISK_STATUS.EMPTY]: 'empty',
  [DISK_STATUS.NO_DIRECTORY]: 'empty',
});
{
  const owned = Object.values(DISK_STATUS).sort();
  const mapped = Object.keys(STATE_BY_DISK).sort();
  if (owned.join('\0') !== mapped.join('\0')) {
    throw new TypeError(`roadmap-graph: STATE_BY_DISK covers [${mapped.join(', ')}] but DISK_STATUS is [${owned.join(', ')}]`);
  }
}

/** What the node's colour says. A closed milestone's phase with no directory was archived, not abandoned. */
export function roadmapNodeState(p: Pick<RoadmapPhaseInput, 'status' | 'milestoneClosed'>): RoadmapNodeState {
  if (!Object.prototype.hasOwnProperty.call(STATE_BY_DISK, p.status)) {
    throw new TypeError(`roadmap-graph: ${JSON.stringify(p.status)} is not a DISK_STATUS value`);
  }
  if (p.milestoneClosed && p.status === DISK_STATUS.NO_DIRECTORY) return 'archived';
  return STATE_BY_DISK[p.status];
}

const GLYPH: Readonly<Record<RoadmapNodeState, string>> = Object.freeze({
  done: '✓',
  running: '▶',
  pending: '○',
  empty: '◌',
  archived: '▣',
});

const ROADMAP_CLASS_DEFS: readonly ClassDef[] = Object.freeze([
  { name: 'done', style: 'fill:#e6f4ea,stroke:#2e7d32' },
  { name: 'running', style: 'fill:#fff4e5,stroke:#ef6c00' },
  { name: 'pending', style: 'fill:#fff,stroke:#555' },
  { name: 'empty', style: 'fill:#fafafa,stroke:#bbbbbb,color:#777' },
  { name: 'archived', style: 'fill:#eee,stroke:#999999,color:#777' },
  { name: 'outside', style: 'fill:#f5f5f5,stroke:#999999,stroke-dasharray:2 2,color:#555' },
  DEFECT_CLASS_DEFS.missing,
  DEFECT_CLASS_DEFS.unparsed,
  DEFECT_CLASS_DEFS.conflict,
]);

/** The source name in the derived marker; `gsd-tools roadmap graph` regenerates it. */
export const ROADMAP_GRAPH_SOURCE = 'roadmap-graph';

/** The flowchart spec handed to `flowchart()` — the data tests assert on. */
export function roadmapGraphSpec(graph: RoadmapGraph): FlowchartSpec {
  const ids = createIdRegistry('ph_');
  const msIds = createIdRegistry('milestone_');
  const nodes: FlowNode[] = [];
  const members = new Map<string, string[]>();
  const order: string[] = [];
  const notes = new Map(graph.unparsed.map((u) => [u.phase, u.raw]));
  const edges: FlowEdge[] = [];

  for (const p of graph.phases) {
    const st = roadmapNodeState(p);
    const id = ids.id(p.key);
    nodes.push({
      id,
      label: `${GLYPH[st]} ${p.id}. ${p.name}${p.checkboxConflict ? ' ⚠ чекбокс ≠ диск' : ''}`,
      className: p.checkboxConflict ? 'conflict' : st,
    });
    const placed = [id];
    const raw = notes.get(p.key);
    if (raw !== undefined) {
      const noteId = ids.id(`note:${p.key}`);
      nodes.push({ id: noteId, label: `Depends on: ${raw}`, className: 'unparsed' });
      placed.push(noteId);
    }
    if (p.milestone !== null) {
      if (!members.has(p.milestone)) {
        members.set(p.milestone, []);
        order.push(p.milestone);
      }
      members.get(p.milestone)?.push(...placed);
    }
  }
  for (const o of graph.outside) {
    const where = o.milestone !== null ? o.milestone : o.name === null ? 'только каталог фазы' : 'вне milestone';
    nodes.push({ id: ids.id(o.key), label: `${o.id}${o.name !== null ? `. ${o.name}` : ''} — ${where}`, className: 'outside' });
  }
  for (const m of graph.missing) {
    nodes.push({ id: ids.id(`${MISSING_PREFIX}${referenceTarget(m).nodeKey}`), label: `${m} — нет такой фазы`, className: 'missing' });
  }
  for (const e of graph.edges) {
    const linkStyle = e.defect === null ? undefined : e.defect === 'forward' ? WARNING_LINK_STYLE : DEFECT_LINK_STYLE;
    edges.push({
      from: ids.id(e.from),
      to: ids.id(e.to),
      line: e.defect === 'missing' ? 'dotted' : 'solid',
      ...(linkStyle !== undefined ? { linkStyle } : {}),
    });
  }
  // A note hangs off its phase on an arrowless dotted line, after the dependency edges.
  for (const u of graph.unparsed) {
    edges.push({ from: ids.id(u.phase), to: ids.id(`note:${u.phase}`), line: 'dotted', arrow: false });
  }
  // Subgraph ids are ordinals: a milestone heading is free text, and spelling it as an id only makes it long.
  const subgraphs: FlowSubgraph[] = order.map((m, i) => ({ id: msIds.id(String(i + 1)), title: m, nodes: members.get(m) ?? [] }));
  return { direction: 'LR', nodes, subgraphs, edges, classDefs: [...ROADMAP_CLASS_DEFS] };
}

/** The mermaid flowchart text (no fence) for a built graph. */
export function roadmapGraphDiagram(graph: RoadmapGraph): string {
  return flowchart(roadmapGraphSpec(graph));
}

/**
 * The gantt spec, or null when no phase has a completion date. One section per
 * milestone, one point per dated phase on its completion day — no bars, since
 * no start date is recorded anywhere.
 */
export function roadmapGanttSpec(graph: RoadmapGraph): GanttSpec | null {
  const ids = createIdRegistry('g_');
  const sections: GanttSection[] = [];
  const byName = new Map<string, GanttSection>();
  for (const p of graph.phases) {
    const date = graph.dates.get(p.key);
    if (date === undefined) continue;
    const name = p.milestone ?? 'Фазы';
    let section = byName.get(name);
    if (section === undefined) {
      section = { name, tasks: [] };
      byName.set(name, section);
      sections.push(section);
    }
    section.tasks.push({ id: ids.id(p.key), label: `${p.id}. ${p.name}`, start: date, duration: '1d', tags: ['milestone'] });
  }
  if (sections.length === 0) return null;
  return { title: 'Завершение фаз', axisFormat: '%Y-%m-%d', sections };
}

/** The gantt text (no fence), or null when there is nothing dated to draw. */
export function roadmapGantt(graph: RoadmapGraph): string | null {
  const spec = roadmapGanttSpec(graph);
  return spec === null ? null : gantt(spec);
}

/** The line under the gantt that says what its points are — and are not. */
export const GANTT_NOTE =
  'Точка — день завершения фазы из колонки `Completed` таблицы Progress. Даты начала нигде не записаны, поэтому длительностей на схеме нет.';

/** The whole derived document: marker, fenced flowchart, the gantt when dated, and the defect list. */
export function renderRoadmapGraph(graph: RoadmapGraph, opts: { gantt: boolean } = { gantt: true }): string {
  const doc = [derivedMarker(ROADMAP_GRAPH_SOURCE), '', fence(roadmapGraphDiagram(graph)), ''];
  const ganttText = opts.gantt ? roadmapGantt(graph) : null;
  if (ganttText !== null) doc.push(GANTT_NOTE, '', fence(ganttText), '');
  if (graph.defects.length > 0) {
    doc.push('Дефекты графа:', ...graph.defects.map((d) => `- ${d.message}`), '');
  }
  return doc.join('\n');
}

// ─── Reading the project ─────────────────────────────────────────────────────

export type RoadmapGraphScope = 'current' | 'all';

export type ReadRoadmapGraphResult =
  | { ok: true; input: RoadmapGraphInput }
  | { ok: false; reason: 'not_found' | 'unreadable' | 'no_phases'; message: string };

/**
 * Collect the graph's input from the project: the current milestone's phases
 * from `analyzeRoadmap` (exactly analyze's set), every milestone section's
 * phases from `analyzeMilestoneSections` (drawn with `scope: 'all'`, otherwise
 * only what a reference may point at), phase directories (a reference to one is
 * not missing), and completion dates from the Progress table.
 */
export function readRoadmapGraphInput(cwd: string, scope: RoadmapGraphScope): ReadRoadmapGraphResult {
  const analyzed = roadmapMod.analyzeRoadmap(cwd);
  if (!analyzed.ok) return { ok: false, reason: 'not_found', message: 'ROADMAP.md not found' };
  if (analyzed.statusError) return { ok: false, reason: 'unreadable', message: analyzed.statusError.message };
  const sections = roadmapMod.analyzeMilestoneSections(cwd);
  if (!sections.ok) return { ok: false, reason: 'not_found', message: 'ROADMAP.md not found' };
  if (sections.statusError) return { ok: false, reason: 'unreadable', message: sections.statusError.message };

  const info = roadmapParser.getMilestoneInfo(cwd).value;
  const currentSection =
    info === null ? undefined : sections.milestones.find((s) => s.version === info.version && !s.closed);
  const currentLabel = currentSection?.heading ?? (info !== null ? [info.version, info.name].filter(Boolean).join(' ') : null);
  const currentVersion = currentSection?.version ?? info?.version ?? null;

  const roadmapPath = planningWorkspace.planningPaths(cwd).roadmap;
  let text: string;
  try {
    text = fs.readFileSync(roadmapPath, 'utf8');
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: `cannot read ROADMAP.md: ${(e as Error).message}` };
  }
  const completedFor = completionDates(text);

  const conflicts = new Set(analyzed.analysis.checkbox_conflict.map((c) => c.number));
  const phases: RoadmapPhaseInput[] = [];
  const add = (
    p: { number: string; name: string; disk_status: string; depends_on: string | null },
    ordinal: number,
    milestone: string | null,
    version: string | null,
    closed: boolean,
    conflict: boolean,
  ): void => {
    const pk = phaseKeyFromToken(p.number);
    phases.push({
      // The milestone's ordinal (0 = current) keeps the key — and the diagram id — short.
      key: `m${ordinal}_${pk}`,
      id: p.number,
      name: p.name,
      milestone,
      milestoneVersion: version,
      milestoneClosed: closed,
      status: p.disk_status,
      checkboxConflict: conflict,
      dependsRaw: p.depends_on,
      completed: completedFor(pk, version),
    });
  };
  for (const p of analyzed.analysis.phases) add(p, 0, currentLabel, currentVersion, false, conflicts.has(p.number));
  if (phases.length === 0) {
    return { ok: false, reason: 'no_phases', message: 'ROADMAP.md declares no phases in the current milestone' };
  }
  const unreadable = analyzed.fieldErrors.map((f) => ({ phase: f.phase, field: f.field, reason: f.reason }));
  const known: KnownPhase[] = [];
  // The same number AND name is the same phase: when the current window could
  // not be matched to a section, its phases must not be drawn a second time.
  const current = new Set(analyzed.analysis.phases.map((p) => `${phaseKeyFromToken(p.number)}\0${p.name}`));
  for (const [i, s] of sections.milestones.entries()) {
    if (s === currentSection) continue;
    for (const p of s.phases) {
      if (current.has(`${phaseKeyFromToken(p.number)}\0${p.name}`)) continue;
      if (scope === 'all') add(p, i + 1, s.heading, s.version, s.closed, false);
      else known.push({ id: p.number, name: p.name, milestone: s.heading });
    }
  }
  if (scope === 'all') {
    for (const f of sections.fieldErrors) unreadable.push({ phase: f.phase, field: f.field, reason: f.reason });
  }
  const phasesDir = planningWorkspace.planningPaths(cwd).phases;
  const convention = planningWorkspace.resolvePhaseIdConvention(cwd);
  for (const dir of phaseLocator.listAllPhaseDirs(phasesDir, { includeSentinels: false }).value) {
    known.push({ id: phaseKeyFromDir(dir, convention), name: null, milestone: convention === 'bracket' ? bracketOfDir(dir) : null });
  }
  return { ok: true, input: { phases, known, unreadable, convention } };
}

/**
 * The Progress table's `Completed` cells, by phase key — and by milestone
 * version too when the table has a `Milestone` column, so restarted numbering
 * cannot hand one milestone's date to another's phase.
 */
function completionDates(roadmapText: string): (phaseKey: string, version: string | null) => string | null {
  // #5761: the one owner of which table is the Progress table.
  const { table } = locateRoadmapProgress(roadmapText);
  const byKey = new Map<string, string>();
  if (table !== null) {
    for (const row of table.rows) {
      const pk = phaseKeyFromProse(row['Phase'] ?? null);
      if (pk === null) continue;
      const ms = (row['Milestone'] ?? '').trim();
      const k = ms !== '' ? `${ms}|${pk}` : pk;
      if (!byKey.has(k)) byKey.set(k, row['Completed'] ?? '');
    }
  }
  return (phaseKey, version) => {
    if (version !== null && byKey.has(`${version}|${phaseKey}`)) return byKey.get(`${version}|${phaseKey}`) as string;
    return byKey.get(phaseKey) ?? null;
  };
}

// ─── Command core ────────────────────────────────────────────────────────────

export interface RoadmapGraphCommandOptions {
  cwd: string;
  /** Absolute output file (the router confines it), or null to return the document. */
  out: string | null;
  strict: boolean;
  scope: RoadmapGraphScope;
  gantt: boolean;
}

export type RoadmapGraphCommandResult =
  | {
      ok: true;
      scope: RoadmapGraphScope;
      phase_count: number;
      edge_count: number;
      defect_count: number;
      error_count: number;
      defects: RoadmapDefect[];
      /** True when the document carries a gantt (some phase has a completion date). */
      gantt: boolean;
      /** Absolute path written, or null. */
      written: string | null;
      markdown: string;
      /** True when `strict` was asked and there is an error-severity defect: the caller fails the process. */
      strict_failed: boolean;
    }
  | { ok: false; reason: 'not_found' | 'unreadable' | 'no_phases' | 'write_failed'; message: string };

/**
 * Everything `gsd-tools roadmap graph` does except argv parsing, path
 * confinement and process exit — so tests drive it directly.
 */
export function runRoadmapGraph(opts: RoadmapGraphCommandOptions): RoadmapGraphCommandResult {
  const read = readRoadmapGraphInput(opts.cwd, opts.scope);
  if (!read.ok) return read;
  const graph = buildRoadmapGraph(read.input);
  const markdown = renderRoadmapGraph(graph, { gantt: opts.gantt });
  if (opts.out !== null) {
    try {
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, markdown);
    } catch (e) {
      return { ok: false, reason: 'write_failed', message: `cannot write ${opts.out}: ${(e as Error).message}` };
    }
  }
  const errorCount = graph.defects.filter((d) => d.severity === 'error').length;
  return {
    ok: true,
    scope: opts.scope,
    phase_count: graph.phases.length,
    edge_count: graph.edges.length,
    defect_count: graph.defects.length,
    error_count: errorCount,
    defects: graph.defects,
    gantt: opts.gantt && graph.dates.size > 0,
    written: opts.out,
    markdown,
    strict_failed: opts.strict && errorCount > 0,
  };
}

/** The one-line summary printed instead of the document when it was written to a file. */
export function summaryLine(r: { phase_count: number; edge_count: number; defect_count: number }, out: string): string {
  return `OK: ${r.phase_count} phase(s), ${r.edge_count} edge(s), ${r.defect_count} defect(s) → ${out}`;
}
