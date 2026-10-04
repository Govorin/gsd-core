/**
 * Plan Graph Module — a phase's plans as a mermaid flowchart, built from each
 * plan's `wave` and `depends_on`, never from a model's memory.
 *
 * Ported from the retired `capabilities/mn-verify-gate/scripts/plan-graph.mjs`;
 * the rules are the same:
 *
 *   - a node is a `*-PLAN.md` file, an edge is a `depends_on` entry, and
 *     nothing else is drawn (mermaid.cts refuses an edge to an undeclared node);
 *   - defects are DRAWN, not hidden and not judged: a dependency on a plan that
 *     is not in the directory (dashed edge to a marked node), a wave that is not
 *     strictly later than its dependency's, a `depends_on` cycle — all red.
 *     Deciding about them is a gate's job; the renderer fails only on request
 *     (`strict`);
 *   - a node's colour says only what is on disk: a `<id>-…SUMMARY.md` → done;
 *     otherwise the plan's own `status` (`in_progress` → running, `blocked`,
 *     `superseded`); otherwise pending. "Pending" is not "not started": several
 *     different situations read the same, and the graph does not pretend to
 *     tell them apart.
 *
 * Status words come from `plan-status.cts` (normalised the way `plan-scan`
 * reads them), so the graph and the validator cannot disagree about a value.
 * `blocked` is the one addition over the script: it is in the closed
 * vocabulary, and drawing it as pending would hide it.
 *
 * ADR-457 build-at-publish: source in src/plan-graph.cts, compiled to
 * gsd-core/bin/lib/plan-graph.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFECT_CLASS_DEFS, DEFECT_LINK_STYLE, createIdRegistry, derivedMarker, fence, flowchart } from './mermaid.cjs';
import { locateFrontmatterFence } from './frontmatter-fence.cjs';
import { normalizeEol, splitLines } from './text-lines.cjs';
import type { ClassDef, FlowEdge, FlowNode, FlowSubgraph } from './mermaid.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planStatus = require('./plan-status.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScan = require('./plan-scan.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is a CommonJS module
import coreUtils = require('./core-utils.cjs');

// ─── Reading plans ───────────────────────────────────────────────────────────

/**
 * A plan's id — the file-name prefix: `01-02-PLAN.md` → `01-02`. Whether a
 * file IS a plan, and which summary completes it, are not decided here:
 * plan-scan's `isRootPlanFile`/`isRootSummaryFile` and core-utils'
 * `countMatchedSummaries` own that grammar (ADR-3180, lint-plan-count-drift).
 */
const PLAN_FILE = /^(\d+(?:\.\d+)?-\d+)-?.*PLAN\.md$/;

export interface PlanInput {
  id: string;
  file: string;
  wave: number | null;
  /** Normalised status word, or null when the plan declares none. */
  status: string | null;
  dependsOn: string[];
  /** The plan's paired SUMMARY.md (`01-02-PLAN.md` ↔ `01-02-SUMMARY.md`) sits next to it. */
  done: boolean;
}

function stripQuotes(s: string): string {
  return s.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * `depends_on` comes in three legal YAML spellings — `[]`, an inline
 * `["01-01", "01-02"]`, and a block of `- 01-01` items — and all three must
 * give the same answer. A blank line inside a block does not close the list
 * (the same reading as `wave-collision`).
 */
export function parseDependsOn(front: string): string[] {
  const lines = splitLines(front);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^depends_on:\s*(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]\s*(#.*)?$/, '');
      return inner.split(',').map(stripQuotes).filter(Boolean);
    }
    if (rest !== '' && !rest.startsWith('#')) return [stripQuotes(rest)];
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const item = lines[j].match(/^[ \t]+-[ \t]*(.*)$/);
      if (item === null) break;
      items.push(stripQuotes(item[1].replace(/\s+#.*$/, '')));
    }
    return items.filter(Boolean);
  }
  return [];
}

/** Read one plan's frontmatter fields from its text. */
export function parsePlanFront(text: string): { wave: number | null; status: string | null; dependsOn: string[] } {
  // The fence is located by its one owner (frontmatter-fence.cts: BOM, CRLF,
  // `----` closers); an unclosed block reads as no frontmatter, as before.
  const fm = locateFrontmatterFence(text);
  const front = fm !== null && fm.closed ? normalizeEol(text.slice(fm.openEnd, fm.bodyEnd)) : '';
  const waveM = front.match(/^wave:\s*["']?(\d+)["']?\s*(?:#.*)?$/m);
  const statusM = front.match(/^status:\s*["']?([\w-]+)["']?\s*(?:#.*)?$/m);
  return {
    wave: waveM ? Number(waveM[1]) : null,
    status: statusM ? planStatus.normalizePlanStatus(statusM[1]) : null,
    dependsOn: parseDependsOn(front),
  };
}

export type ReadPlansResult =
  | { ok: true; plans: PlanInput[] }
  | { ok: false; reason: 'not_found' | 'unreadable' | 'no_plans'; message: string };

/** Collect every plan in `phaseDir`. "Nothing to draw" is a failure to look, never an empty graph. */
export function readPhasePlans(phaseDir: string): ReadPlansResult {
  if (!fs.existsSync(phaseDir)) {
    return { ok: false, reason: 'not_found', message: `phase directory not found: ${phaseDir}` };
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(phaseDir, { withFileTypes: true });
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: `cannot list ${phaseDir}: ${(e as Error).message}` };
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  const summaries = files.filter(planScan.isRootSummaryFile);
  const plans: PlanInput[] = [];
  for (const name of files) {
    if (!planScan.isRootPlanFile(name)) continue;
    const idm = name.match(PLAN_FILE);
    if (!idm) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(phaseDir, name), 'utf8');
    } catch (e) {
      return { ok: false, reason: 'unreadable', message: `cannot read ${name}: ${(e as Error).message}` };
    }
    const id = idm[1];
    plans.push({
      id,
      file: name,
      ...parsePlanFront(text),
      done: coreUtils.countMatchedSummaries([name], summaries) > 0,
    });
  }
  if (plans.length === 0) {
    return { ok: false, reason: 'no_plans', message: `no *-PLAN.md files in ${phaseDir}` };
  }
  return { ok: true, plans };
}

// ─── The graph ───────────────────────────────────────────────────────────────

export type EdgeDefect = 'missing' | 'wave' | 'cycle';

export interface PlanEdge {
  /** The dependency. */
  from: string;
  /** The plan that depends on it. */
  to: string;
  defect: EdgeDefect | null;
}

export interface PlanGraph {
  /** Sorted by wave (no wave last), then by id with numeric collation. */
  plans: PlanInput[];
  /** In plan order, then `depends_on` order. */
  edges: PlanEdge[];
  /** Ids named in `depends_on` that are not plans in the directory, sorted. */
  missing: string[];
  defects: PlanEdge[];
}

const waveKey = (w: number | null): number => (w === null ? Number.POSITIVE_INFINITY : w);

/** Edges and defects from the plans' own declarations. Pure. */
export function buildPlanGraph(input: readonly PlanInput[]): PlanGraph {
  const plans = [...input].sort(
    (a, b) => waveKey(a.wave) - waveKey(b.wave) || a.id.localeCompare(b.id, 'en', { numeric: true }),
  );
  const byId = new Map(plans.map((p) => [p.id, p]));
  const edges: PlanEdge[] = [];
  const missing = new Set<string>();
  for (const p of plans) {
    for (const dep of p.dependsOn) {
      const target = byId.get(dep);
      let defect: EdgeDefect | null = null;
      if (!target) {
        defect = 'missing';
        missing.add(dep);
      } else if (p.wave !== null && target.wave !== null && p.wave <= target.wave) {
        defect = 'wave';
      }
      edges.push({ from: dep, to: p.id, defect });
    }
  }

  // An edge dep→id lies on a cycle when id can reach dep.
  const adj = new Map<string, string[]>(plans.map((p) => [p.id, []]));
  for (const e of edges) if (byId.has(e.from) && byId.has(e.to)) adj.get(e.from)?.push(e.to);
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
    if (e.defect === null && byId.has(e.from) && byId.has(e.to) && reaches(e.to, e.from)) e.defect = 'cycle';
  }

  return {
    plans,
    edges,
    missing: [...missing].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    defects: edges.filter((e) => e.defect !== null),
  };
}

export type PlanNodeState = 'done' | 'running' | 'blocked' | 'superseded' | 'pending';

/** What the node's colour says — only what is recorded on disk. A SUMMARY wins over a leftover status. */
export function planNodeState(p: Pick<PlanInput, 'done' | 'status'>): PlanNodeState {
  if (p.done) return 'done';
  if (p.status !== null && Object.prototype.hasOwnProperty.call(STATE_BY_STATUS, p.status)) {
    return STATE_BY_STATUS[p.status];
  }
  return 'pending';
}

/**
 * The statuses that change a node's colour. `done` is deliberately absent: a
 * plan that says `done` without a SUMMARY has not proven it, so it stays pending.
 * Every key must be in the closed vocabulary — checked at load, so a renamed
 * status fails here instead of silently colouring nothing.
 */
const STATE_BY_STATUS: Readonly<Record<string, PlanNodeState>> = Object.freeze({
  in_progress: 'running',
  blocked: 'blocked',
  superseded: 'superseded',
});
for (const status of Object.keys(STATE_BY_STATUS)) {
  if (!planStatus.isPlanStatus(status)) {
    throw new TypeError(`plan-graph: ${JSON.stringify(status)} is not in plan-status PLAN_STATUSES`);
  }
}

const GLYPH: Readonly<Record<PlanNodeState, string>> = Object.freeze({
  done: '✓',
  running: '▶',
  blocked: '⛔',
  superseded: '⊘',
  pending: '○',
});

const PLAN_CLASS_DEFS: readonly ClassDef[] = Object.freeze([
  { name: 'done', style: 'fill:#e6f4ea,stroke:#2e7d32' },
  { name: 'running', style: 'fill:#fff4e5,stroke:#ef6c00' },
  { name: 'blocked', style: 'fill:#fdecea,stroke:#b71c1c' },
  { name: 'superseded', style: 'fill:#eee,stroke:#999999,stroke-dasharray:4 3,color:#777' },
  { name: 'pending', style: 'fill:#fff,stroke:#555' },
  DEFECT_CLASS_DEFS.missing,
]);

/** The source name in the derived marker; `gsd-tools plan graph` regenerates it. */
export const PLAN_GRAPH_SOURCE = 'plan-graph';

/** The mermaid flowchart text (no fence) for a built graph. */
export function planGraphDiagram(graph: PlanGraph): string {
  const ids = createIdRegistry('p_');
  const nodes: FlowNode[] = [];
  const subgraphs: FlowSubgraph[] = [];
  const waves = [...new Set(graph.plans.map((p) => p.wave))].sort((a, b) => waveKey(a) - waveKey(b));
  for (const w of waves) {
    const members = graph.plans.filter((p) => p.wave === w);
    subgraphs.push({
      id: w === null ? 'W_none' : `W${w}`,
      title: w === null ? 'wave не задана' : `wave ${w}`,
      nodes: members.map((p) => ids.id(p.id)),
    });
    for (const p of members) {
      const st = planNodeState(p);
      nodes.push({ id: ids.id(p.id), label: `${GLYPH[st]} ${p.id}`, className: st });
    }
  }
  for (const m of graph.missing) {
    nodes.push({ id: ids.id(m), label: `${m} — нет такого плана`, className: 'missing' });
  }
  const edges: FlowEdge[] = graph.edges.map((e) => ({
    from: ids.id(e.from),
    to: ids.id(e.to),
    line: e.defect === 'missing' ? 'dotted' : 'solid',
    ...(e.defect !== null ? { linkStyle: DEFECT_LINK_STYLE } : {}),
  }));
  return flowchart({ direction: 'LR', nodes, subgraphs, edges, classDefs: [...PLAN_CLASS_DEFS] });
}

/** One line per defect, in edge order. */
export function describeDefects(graph: PlanGraph): string[] {
  const byId = new Map(graph.plans.map((p) => [p.id, p]));
  return graph.defects.map((e) => {
    if (e.defect === 'missing') return `${e.to} зависит от ${e.from}, такого плана в каталоге нет`;
    if (e.defect === 'wave') {
      return `${e.to} (wave ${byId.get(e.to)?.wave}) зависит от ${e.from} (wave ${byId.get(e.from)?.wave}) — волна должна быть строго позже`;
    }
    return `${e.from} → ${e.to} лежит на цикле`;
  });
}

/** The whole derived document: marker, fenced diagram, and the defect list when there is one. */
export function renderPlanGraph(graph: PlanGraph): string {
  const doc = [derivedMarker(PLAN_GRAPH_SOURCE), '', fence(planGraphDiagram(graph)), ''];
  const defects = describeDefects(graph);
  if (defects.length > 0) {
    doc.push('Дефекты графа:', ...defects.map((d) => `- ${d}`), '');
  }
  return doc.join('\n');
}

// ─── Command core ────────────────────────────────────────────────────────────

export interface PlanGraphCommandOptions {
  /** Absolute phase directory (the router resolves and confines it). */
  dir: string;
  /** Absolute output file, or null to return the document. */
  out: string | null;
  strict: boolean;
}

export type PlanGraphCommandResult =
  | {
      ok: true;
      plan_count: number;
      edge_count: number;
      defect_count: number;
      defects: Array<{ from: string; to: string; defect: EdgeDefect }>;
      /** Absolute path written, or null. */
      written: string | null;
      markdown: string;
      /** True when `strict` was asked and there are defects: the caller fails the process. */
      strict_failed: boolean;
    }
  | { ok: false; reason: 'not_found' | 'unreadable' | 'no_plans' | 'write_failed'; message: string };

/**
 * Everything `gsd-tools plan graph` does except argv parsing, path confinement
 * and process exit — so tests drive it directly.
 */
export function runPlanGraph(opts: PlanGraphCommandOptions): PlanGraphCommandResult {
  const read = readPhasePlans(opts.dir);
  if (!read.ok) return read;
  const graph = buildPlanGraph(read.plans);
  const markdown = renderPlanGraph(graph);
  if (opts.out !== null) {
    try {
      fs.writeFileSync(opts.out, markdown);
    } catch (e) {
      return { ok: false, reason: 'write_failed', message: `cannot write ${opts.out}: ${(e as Error).message}` };
    }
  }
  return {
    ok: true,
    plan_count: graph.plans.length,
    edge_count: graph.edges.length,
    defect_count: graph.defects.length,
    defects: graph.defects.map((e) => ({ from: e.from, to: e.to, defect: e.defect as EdgeDefect })),
    written: opts.out,
    markdown,
    strict_failed: opts.strict && graph.defects.length > 0,
  };
}

/** The one-line summary printed instead of the graph when it was written to a file. */
export function summaryLine(r: { plan_count: number; edge_count: number; defect_count: number }, out: string): string {
  return `OK: ${r.plan_count} plan(s), ${r.edge_count} edge(s), ${r.defect_count} defect(s) → ${out}`;
}
