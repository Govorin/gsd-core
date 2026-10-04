/**
 * Loop Hooks Map Module — which capability hooks into which loop point, and in
 * what order: the data behind `docs/reference/loop-hooks-map.md`.
 *
 * Sources, all committed data (so the document regenerates the same on every
 * machine): the Loop Host Contract (the five steps, their twelve points, their
 * core artifacts), the capability registry's `byLoopPoint` (steps and
 * contributions already topologically sorted by produces/consumes, gates by
 * capability id), the RAW `capabilities/<id>/capability.json` declarations, and
 * the `loop render-hooks <point>` call sites of the host workflows.
 *
 * The raw declarations are there because the registry cannot show what it
 * lost: `gen-capability-registry` registers a hook only when its point is a
 * valid loop point and its capability is a `feature`, and skips anything else
 * in silence. Comparing declared with registered is the only place the loss
 * becomes visible — so it is drawn (`dropped-hook`), like every other defect:
 * a ref to no agent or skill, a `when` key no capability owns, a consumed
 * artifact nothing produces earlier, a point with hooks that no workflow
 * renders, a hook kind a host renders but does not dispatch.
 *
 * Shape (as plan-graph / roadmap-graph): pure `buildLoopHooksMap` → `*Spec`
 * (what the mermaid builders are handed — what tests assert on) → `render*`.
 * The generator (`scripts/gen-loop-hooks-map.cjs`) does the I/O.
 *
 * ADR-457 build-at-publish: source in src/loop-hooks-map.cts, compiled to
 * gsd-core/bin/lib/loop-hooks-map.cjs (gitignored).
 */

import { DEFECT_CLASS_DEFS, DEFECT_LINK_STYLE, createIdRegistry, derivedMarker, fence, flowchart } from './mermaid.cjs';
import type { ClassDef, FlowEdge, FlowNode, FlowSubgraph, FlowchartSpec } from './mermaid.cjs';

// ─── Input ───────────────────────────────────────────────────────────────────

export interface LoopStepContract {
  step: string;
  points: string[];
  agentRoles: string[];
  coreArtifacts: { produces: string[]; consumes: string[] };
}

export type HookKind = 'step' | 'gate' | 'contribution';

/** One hook entry as the registry (or a capability.json) spells it. Only these fields are read. */
export interface RawHook {
  capId?: string;
  point?: unknown;
  ref?: { skill?: string; agent?: string; command?: string };
  check?: { query?: string };
  into?: string;
  fragment?: unknown;
  blocking?: boolean;
  when?: string;
  onError?: string;
  produces?: string[];
  consumes?: string[];
}

export interface DeclaredCapability {
  capId: string;
  role: string;
  steps?: RawHook[];
  gates?: RawHook[];
  contributions?: RawHook[];
}

/** One `loop render-hooks <point>` host: the workflow file and the hook kinds its dispatch text covers. */
export interface LoopHost {
  file: string;
  point: string;
  kinds: HookKind[];
}

export interface LoopHooksMapInput {
  contract: LoopStepContract[];
  byLoopPoint: Record<string, { steps: RawHook[]; gates: RawHook[]; contributions: RawHook[] }>;
  declared: DeclaredCapability[];
  /** Keys of the registry's `configSchema`. */
  configKeys: string[];
  /** `agents/*.md` names. */
  agents: string[];
  /** Capability skills and `commands/gsd/*.md` names. */
  skills: string[];
  hosts: LoopHost[];
}

// ─── The map ─────────────────────────────────────────────────────────────────

export interface Hook {
  capId: string;
  kind: HookKind;
  /** `skill:<name>` / `agent:<name>` / `command:<text>` for a step. */
  ref?: string;
  /** A gate's check query. */
  check?: string;
  /** A contribution's target role. */
  into?: string;
  /** A contribution's fragment file (`fragments/plan-pre.md`), or `inline`. */
  fragment?: string;
  blocking?: boolean;
  when?: string;
  onError?: string;
  produces: string[];
  consumes: string[];
  /** Defect types on this hook (`unknown-ref`, `unknown-when-key`, `unsatisfied-consume`). */
  defects: string[];
}

export interface PointView {
  point: string;
  /** The loop step that owns the point. */
  step: string;
  hostedBy: Array<{ file: string; kinds: HookKind[] }>;
  steps: Hook[];
  gates: Hook[];
  contributions: Hook[];
}

export type LoopHookDefectType =
  | 'dropped-hook'
  | 'undeclared-hook'
  | 'unknown-ref'
  | 'unknown-when-key'
  | 'unsatisfied-consume'
  | 'unhosted-point'
  | 'undispatched-kind';

export interface LoopHookDefect {
  type: LoopHookDefectType;
  point: string;
  capId?: string;
  kind?: HookKind;
  /** The artifact, ref, `when` key or file the defect is about. */
  subject?: string;
  message: string;
}

export interface DroppedHook {
  capId: string;
  kind: HookKind;
  /** The point as declared — possibly not a loop point at all. */
  point: string;
  reason: string;
}

export interface LoopHooksMap {
  /** In contract order. */
  points: PointView[];
  dropped: DroppedHook[];
  defects: LoopHookDefect[];
}

const KIND_LIST: Readonly<Record<HookKind, 'steps' | 'gates' | 'contributions'>> = Object.freeze({
  step: 'steps',
  gate: 'gates',
  contribution: 'contributions',
});
const KINDS: readonly HookKind[] = Object.freeze(['step', 'gate', 'contribution']);

function refText(ref: RawHook['ref']): string | undefined {
  if (ref === undefined) return undefined;
  if (typeof ref.skill === 'string') return `skill:${ref.skill}`;
  if (typeof ref.agent === 'string') return `agent:${ref.agent}`;
  if (typeof ref.command === 'string') return `command:${ref.command}`;
  return undefined;
}

function fragmentText(fragment: unknown): string | undefined {
  if (typeof fragment === 'string') return fragment;
  if (fragment !== null && typeof fragment === 'object') {
    const f = fragment as { path?: unknown; inline?: unknown };
    if (typeof f.path === 'string') return f.path;
    if (typeof f.inline === 'string') return 'inline';
  }
  return undefined;
}

function toHook(raw: RawHook, kind: HookKind): Hook {
  return {
    capId: String(raw.capId),
    kind,
    ...(kind === 'step' && refText(raw.ref) !== undefined ? { ref: refText(raw.ref) } : {}),
    ...(kind === 'gate' && typeof raw.check?.query === 'string' ? { check: raw.check.query } : {}),
    ...(kind === 'contribution' && typeof raw.into === 'string' ? { into: raw.into } : {}),
    ...(kind === 'contribution' && fragmentText(raw.fragment) !== undefined ? { fragment: fragmentText(raw.fragment) } : {}),
    ...(kind === 'gate' ? { blocking: raw.blocking === true } : {}),
    ...(typeof raw.when === 'string' ? { when: raw.when } : {}),
    ...(typeof raw.onError === 'string' ? { onError: raw.onError } : {}),
    produces: Array.isArray(raw.produces) ? [...raw.produces] : [],
    consumes: Array.isArray(raw.consumes) ? [...raw.consumes] : [],
    defects: [],
  };
}

/** The map, every defect included. Pure. */
export function buildLoopHooksMap(input: LoopHooksMapInput): LoopHooksMap {
  const order: string[] = input.contract.flatMap((c) => c.points);
  const index = new Map(order.map((p, i) => [p, i]));
  const stepOf = new Map<string, LoopStepContract>();
  for (const c of input.contract) for (const p of c.points) stepOf.set(p, c);
  const configKeys = new Set(input.configKeys);
  const agents = new Set(input.agents);
  const skills = new Set(input.skills);
  const defects: LoopHookDefect[] = [];

  // A core artifact is available from the LAST point of the step that produces
  // it (the validator's HOST_ARTIFACT_EARLIEST_POINT_IDX rule).
  const coreFrom = new Map<string, number>();
  for (const c of input.contract) {
    const last = index.get(c.points[c.points.length - 1]) as number;
    for (const a of c.coreArtifacts.produces) if (!coreFrom.has(a)) coreFrom.set(a, last);
  }

  const points: PointView[] = order.map((point) => {
    const reg = input.byLoopPoint[point] ?? { steps: [], gates: [], contributions: [] };
    return {
      point,
      step: (stepOf.get(point) as LoopStepContract).step,
      hostedBy: input.hosts.filter((h) => h.point === point).map((h) => ({ file: h.file, kinds: [...h.kinds] })),
      steps: (reg.steps ?? []).map((h) => toHook(h, 'step')),
      gates: (reg.gates ?? []).map((h) => toHook(h, 'gate')),
      contributions: (reg.contributions ?? []).map((h) => toHook(h, 'contribution')),
    };
  });

  // The earliest point index at which a hook produces each artifact.
  const producedFrom = new Map<string, number>();
  for (const [i, pv] of points.entries()) {
    for (const h of [...pv.steps, ...pv.contributions]) {
      for (const a of h.produces) if (!producedFrom.has(a)) producedFrom.set(a, i);
    }
  }

  for (const [i, pv] of points.entries()) {
    for (const h of [...pv.steps, ...pv.gates, ...pv.contributions]) {
      if (h.ref !== undefined) {
        const [type, name] = [h.ref.slice(0, h.ref.indexOf(':')), h.ref.slice(h.ref.indexOf(':') + 1)];
        const unknown = (type === 'agent' && !agents.has(name)) || (type === 'skill' && !skills.has(name));
        if (unknown) {
          h.defects.push('unknown-ref');
          defects.push({
            type: 'unknown-ref', point: pv.point, capId: h.capId, kind: h.kind, subject: h.ref,
            message: `${pv.point}: ${h.capId} ${h.kind} refers to ${type} \`${name}\`, which does not exist`,
          });
        }
      }
      if (h.when !== undefined && !configKeys.has(h.when)) {
        h.defects.push('unknown-when-key');
        defects.push({
          type: 'unknown-when-key', point: pv.point, capId: h.capId, kind: h.kind, subject: h.when,
          message: `${pv.point}: ${h.capId} ${h.kind} is gated on \`${h.when}\`, which no capability's config declares`,
        });
      }
      for (const a of h.consumes) {
        const fromCore = coreFrom.get(a);
        const fromHook = producedFrom.get(a);
        if ((fromCore !== undefined && fromCore <= i) || (fromHook !== undefined && fromHook <= i)) continue;
        if (!h.defects.includes('unsatisfied-consume')) h.defects.push('unsatisfied-consume');
        defects.push({
          type: 'unsatisfied-consume', point: pv.point, capId: h.capId, kind: h.kind, subject: a,
          message: `${pv.point}: ${h.capId} ${h.kind} consumes \`${a}\`, which nothing produces at or before this point`,
        });
      }
    }
    const present = KINDS.filter((k) => pv[KIND_LIST[k]].length > 0);
    if (present.length > 0 && pv.hostedBy.length === 0) {
      defects.push({ type: 'unhosted-point', point: pv.point, message: `${pv.point}: has hooks, but no workflow calls \`loop render-hooks ${pv.point}\`` });
    } else {
      const covered = new Set(pv.hostedBy.flatMap((h) => h.kinds));
      for (const k of present) {
        if (covered.has(k)) continue;
        defects.push({
          type: 'undispatched-kind', point: pv.point, kind: k,
          message: `${pv.point}: ${pv[KIND_LIST[k]].length} ${k} hook(s) are rendered but no host's dispatch text covers kind \`${k}\``,
        });
      }
    }
  }

  // Declared vs registered, per (capability, point, kind): the registry never
  // says what it skipped, so the count difference is the only witness.
  const dropped: DroppedHook[] = [];
  const declaredCount = new Map<string, number>();
  const registeredCount = new Map<string, number>();
  const keyOf = (capId: string, point: string, kind: HookKind): string => JSON.stringify([capId, point, kind]);
  for (const cap of input.declared) {
    for (const kind of KINDS) {
      for (const raw of cap[KIND_LIST[kind]] ?? []) {
        const point = String(raw.point);
        const k = keyOf(cap.capId, point, kind);
        declaredCount.set(k, (declaredCount.get(k) ?? 0) + 1);
        const registeredHere = (input.byLoopPoint[point]?.[KIND_LIST[kind]] ?? []).filter((h) => h.capId === cap.capId).length;
        if ((declaredCount.get(k) as number) <= registeredHere) continue;
        const reason = !index.has(point)
          ? `\`${point}\` is not a loop point`
          : cap.role !== 'feature'
            ? `a \`${cap.role}\` capability's hooks are not registered`
            : 'not in the registry (regenerate it)';
        dropped.push({ capId: cap.capId, kind, point, reason });
        defects.push({ type: 'dropped-hook', point, capId: cap.capId, kind, message: `${cap.capId} declares a ${kind} at ${point}: ${reason}` });
      }
    }
  }
  for (const pv of points) {
    for (const kind of KINDS) {
      for (const h of pv[KIND_LIST[kind]]) {
        const k = keyOf(h.capId, pv.point, kind);
        registeredCount.set(k, (registeredCount.get(k) ?? 0) + 1);
        if ((registeredCount.get(k) as number) <= (declaredCount.get(k) ?? 0)) continue;
        defects.push({
          type: 'undeclared-hook', point: pv.point, capId: h.capId, kind,
          message: `${pv.point}: the registry has a ${kind} of ${h.capId} that its capability.json no longer declares (regenerate the registry)`,
        });
      }
    }
  }

  return { points, dropped, defects };
}

// ─── Diagrams ────────────────────────────────────────────────────────────────

const MAP_CLASS_DEFS: readonly ClassDef[] = Object.freeze([
  { name: 'point', style: 'fill:#e8f0fe,stroke:#1a73e8' },
  { name: 'core', style: 'fill:#fff,stroke:#555,stroke-width:2px' },
  { name: 'step', style: 'fill:#fff,stroke:#2e7d32' },
  { name: 'gate', style: 'fill:#fff,stroke:#ef6c00' },
  { name: 'crit', style: 'fill:#fdecea,stroke:#b71c1c,stroke-width:2px' },
  { name: 'contribution', style: 'fill:#f5f5f5,stroke:#999999,stroke-dasharray:3 3' },
  { name: 'artifact', style: 'fill:#fffde7,stroke:#9e9d24' },
  DEFECT_CLASS_DEFS.missing,
  DEFECT_CLASS_DEFS.conflict,
]);

function hookLabel(h: Hook): string {
  const what =
    h.kind === 'step'
      ? h.ref ?? 'step'
      : h.kind === 'gate'
        ? `check ${h.check ?? '?'}`
        : `into ${h.into ?? '?'}${h.fragment !== undefined ? ` · ${h.fragment}` : ''}`;
  return `${h.capId}: ${what}`;
}

function hookClass(h: Hook): string {
  if (h.defects.includes('unknown-ref')) return 'missing';
  if (h.defects.includes('unknown-when-key')) return 'conflict';
  if (h.kind === 'gate') return h.blocking === true ? 'crit' : 'gate';
  return h.kind;
}

/**
 * The overview: a subgraph per loop step, its points chained through the step's
 * core work, the steps chained in pipeline order, and every registered hook
 * attached to its point — a step as a box, a gate as a diamond (blocking: red,
 * thick edge), a contribution on a dotted edge labelled with its target role.
 * Declared-but-dropped hooks sit in their own subgraph.
 */
export function overviewSpec(map: LoopHooksMap, contract: readonly LoopStepContract[]): FlowchartSpec {
  const ids = createIdRegistry('n_');
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const subgraphs: FlowSubgraph[] = [];
  const byPoint = new Map(map.points.map((p) => [p.point, p]));
  const unhosted = new Set(map.defects.filter((d) => d.type === 'unhosted-point').map((d) => d.point));
  let previousTail: string | null = null;

  for (const c of contract) {
    const members: string[] = [];
    const chain: string[] = [];
    const coreAt = Math.floor(c.points.length / 2);
    c.points.forEach((point, i) => {
      if (i === coreAt) {
        const coreId = ids.id(`core:${c.step}`);
        const made = c.coreArtifacts.produces.length > 0 ? ` → ${c.coreArtifacts.produces.join(', ')}` : '';
        nodes.push({ id: coreId, label: `${c.step}: ${c.agentRoles.join(', ')}${made}`, shape: 'round', className: 'core' });
        members.push(coreId);
        chain.push(coreId);
      }
      const pid = ids.id(`point:${point}`);
      nodes.push({ id: pid, label: point, shape: 'stadium', className: unhosted.has(point) ? 'missing' : 'point' });
      members.push(pid);
      chain.push(pid);
    });
    for (let i = 1; i < chain.length; i++) edges.push({ from: chain[i - 1], to: chain[i] });
    if (previousTail !== null) edges.push({ from: previousTail, to: chain[0], line: 'thick' });
    previousTail = chain[chain.length - 1];

    for (const point of c.points) {
      const pv = byPoint.get(point);
      if (pv === undefined) continue;
      const pid = ids.id(`point:${point}`);
      const all = [...pv.steps, ...pv.gates, ...pv.contributions];
      all.forEach((h, n) => {
        const hid = ids.id(`hook:${point}:${h.kind}:${h.capId}:${n}`);
        nodes.push({ id: hid, label: hookLabel(h), shape: h.kind === 'gate' ? 'rhombus' : 'rect', className: hookClass(h) });
        members.push(hid);
        if (h.kind === 'contribution') edges.push({ from: hid, to: pid, line: 'dotted', label: h.into ?? '?' });
        else edges.push({ from: pid, to: hid, line: h.kind === 'gate' && h.blocking === true ? 'thick' : 'solid' });
      });
    }
    subgraphs.push({ id: ids.id(`step:${c.step}`), title: c.step, nodes: members });
  }

  if (map.dropped.length > 0) {
    const members: string[] = [];
    map.dropped.forEach((d, n) => {
      const id = ids.id(`dropped:${n}`);
      nodes.push({ id, label: `${d.capId}: ${d.kind} at ${d.point} — ${d.reason}`, className: 'missing' });
      members.push(id);
    });
    subgraphs.push({ id: ids.id('dropped'), title: 'declared, not registered', nodes: members });
  }
  return { direction: 'LR', nodes, edges, subgraphs, classDefs: [...MAP_CLASS_DEFS] };
}

/**
 * The artifact flow at one point (`flowchart TB`), or null when no hook there
 * produces or consumes anything: producer → artifact → consumer, the order the
 * registry's topological sort already fixed. A consumed artifact that comes
 * from an earlier point or a step's core work is drawn as its source; one that
 * comes from nowhere is a `missing` node on a red edge.
 */
export function artifactFlowSpec(map: LoopHooksMap, point: string, contract: readonly LoopStepContract[]): FlowchartSpec | null {
  const pv = map.points.find((p) => p.point === point);
  if (pv === undefined) return null;
  const hooks = [...pv.steps, ...pv.contributions].filter((h) => h.produces.length > 0 || h.consumes.length > 0);
  if (hooks.length === 0) return null;
  const order = contract.flatMap((c) => c.points);
  const here = order.indexOf(point);
  const coreSource = new Map<string, string>();
  for (const c of contract) {
    if (order.indexOf(c.points[c.points.length - 1]) > here) continue;
    for (const a of c.coreArtifacts.produces) if (!coreSource.has(a)) coreSource.set(a, `${c.step} core`);
  }
  const earlierSource = new Map<string, string>();
  for (const p of map.points.slice(0, here)) {
    for (const h of [...p.steps, ...p.contributions]) for (const a of h.produces) if (!earlierSource.has(a)) earlierSource.set(a, p.point);
  }

  const ids = createIdRegistry('f_');
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const declaredArtifacts = new Set<string>();
  const artifact = (a: string): string => {
    const id = ids.id(`artifact:${a}`);
    if (!declaredArtifacts.has(a)) {
      declaredArtifacts.add(a);
      const producedHere = hooks.some((h) => h.produces.includes(a));
      const source = producedHere ? null : coreSource.get(a) ?? earlierSource.get(a) ?? null;
      const missing = !producedHere && source === null;
      nodes.push({
        id,
        label: missing ? `${a} — produced by nothing` : source !== null ? `${a} (from ${source})` : a,
        shape: 'cylinder',
        className: missing ? 'missing' : 'artifact',
      });
    }
    return id;
  };
  hooks.forEach((h, n) => {
    const hid = ids.id(`hook:${h.kind}:${h.capId}:${n}`);
    nodes.push({ id: hid, label: hookLabel(h), className: hookClass(h) });
    for (const a of h.consumes) {
      const aid = artifact(a);
      const unsatisfied = nodes.find((x) => x.id === aid)?.className === 'missing';
      edges.push({ from: aid, to: hid, ...(unsatisfied ? { linkStyle: DEFECT_LINK_STYLE } : {}) });
    }
    for (const a of h.produces) edges.push({ from: hid, to: artifact(a) });
  });
  return { direction: 'TB', nodes, edges, classDefs: [...MAP_CLASS_DEFS] };
}

// ─── Document ────────────────────────────────────────────────────────────────

/** A table cell: escaped so a `|` in a query cannot break the row. */
function cell(text: string | undefined): string {
  if (text === undefined || text === '') return '';
  return `\`${text.replace(/\|/g, '\\|')}\``;
}

/** The point × capability table, in loop order then registry order. */
export function hooksTable(map: LoopHooksMap): string[] {
  const rows = ['| Point | Capability | Kind | What | `when` | `onError` | Blocking |', '|---|---|---|---|---|---|---|'];
  for (const pv of map.points) {
    for (const h of [...pv.steps, ...pv.gates, ...pv.contributions]) {
      const what = h.kind === 'step' ? h.ref : h.kind === 'gate' ? h.check : `${h.into ?? '?'}${h.fragment !== undefined ? ` · ${h.fragment}` : ''}`;
      const blocking = h.kind === 'gate' ? (h.blocking === true ? 'yes' : 'no') : '';
      rows.push(`| \`${pv.point}\` | ${h.capId} | ${h.kind} | ${cell(what)} | ${cell(h.when)} | ${cell(h.onError)} | ${blocking} |`);
    }
  }
  return rows;
}

/** The whole derived document. `source` is the generator to rerun. */
export function renderLoopHooksMap(map: LoopHooksMap, contract: readonly LoopStepContract[], source: string): string {
  const total = map.points.reduce((n, p) => n + p.steps.length + p.gates.length + p.contributions.length, 0);
  const doc: string[] = [
    derivedMarker(source),
    '',
    '# Loop hooks map',
    '',
    'Which capability hooks into which loop point, and in what order — generated from the Loop Host Contract',
    '(`gsd-core/bin/lib/loop-host-contract.cjs`), the capability registry\'s `byLoopPoint`, the raw',
    '`capabilities/*/capability.json` declarations and the `loop render-hooks` call sites of the host workflows.',
    `Regenerate with \`node ${source} --write\`; \`--check\` (part of \`npm run lint:generated-sync\`) fails when`,
    'any of them changes without regeneration.',
    '',
    'This map answers "what happens at a point, and in what order". Where a capability attaches is the',
    '`capability-matrix.md` question; this document does not repeat it.',
    '',
    `${total} registered hook(s) at ${map.points.filter((p) => p.steps.length + p.gates.length + p.contributions.length > 0).length} of ${map.points.length} points.`,
    '',
    '## Overview',
    '',
    'A box is a step hook, a diamond a gate (red and on a thick edge when blocking), a dotted edge a',
    'contribution into the named agent role. A red dashed node is a defect (see the list at the end).',
    '',
    fence(flowchart(overviewSpec(map, contract))),
    '',
  ];
  const flows: string[] = [];
  for (const pv of map.points) {
    const spec = artifactFlowSpec(map, pv.point, contract);
    if (spec === null) continue;
    flows.push(`### \`${pv.point}\``, '', fence(flowchart(spec)), '');
  }
  if (flows.length > 0) {
    doc.push(
      '## Artifact flow per point',
      '',
      'Producer → artifact → consumer at each point where a hook produces or consumes something. An',
      'artifact made earlier — by a step\'s core work or a hook at an earlier point — names its source.',
      '',
      ...flows,
    );
  }
  doc.push('## Hooks by point', '', ...hooksTable(map), '');
  doc.push('## Hosts', '', '| Point | Workflow | Kinds dispatched |', '|---|---|---|');
  for (const pv of map.points) {
    for (const h of pv.hostedBy) doc.push(`| \`${pv.point}\` | \`${h.file}\` | ${h.kinds.length > 0 ? h.kinds.join(', ') : '—'} |`);
  }
  doc.push('');
  doc.push('## Defects', '');
  if (map.defects.length === 0) doc.push('None.');
  else doc.push(...map.defects.map((d) => `- \`${d.type}\` — ${d.message}`));
  doc.push('');
  return doc.join('\n');
}
