'use strict';
/**
 * Architecture metrics — the deterministic half of `/gsd:arch-survey`
 * (pocock-practices design, D1; adapted from mattpocock/skills
 * `improve-codebase-architecture`, MIT).
 *
 * Pocock's skill tells the model to "walk back the commit history and find the
 * hot spots" before exploring. Everything in that sentence can be counted, so
 * it is counted here and handed to the surveyor agents as data:
 *
 *   - the import graph of the scope (`code-graph`): LOC, exports, fan-in from
 *     production code and from tests, fan-out, cycles (runtime vs type-only);
 *   - the change history of a window (`git-history`, one `git log`): churn per
 *     file and co-change pairs, marked by whether an import links them;
 *   - per-file complexity (`complexity-trigger`'s decision-point analyzer);
 *   - hot spots = churn × complexity, falling back to complexity alone — named
 *     in `hotspotBasis` — when the window has no readable history;
 *   - search signals: small modules (`loc <= smallModuleLoc`), directories with
 *     a cluster of them, pass-through modules (one production importer, one
 *     import, small), co-change pairs;
 *   - zones: the units the survey fans out over, one surveyor each. A zone is
 *     seeded by the hottest module not already in a zone and holds its import
 *     neighbourhood and co-change partners not taken by an earlier zone,
 *     capped at `zoneMaxFiles`.
 *
 * These are SIGNALS FOR WHERE TO LOOK, never verdicts. In particular there is
 * no "depth" number: implementation-lines over interface-lines rewards padding
 * the implementation (codebase-design, "Rejected framings"); `exportsPerLoc` is
 * carried per module as a search hint only.
 *
 * Test files (`*.test.*`, `*.spec.*`, `tests/`, `__tests__/`, `fixtures/`, …)
 * are kept in the graph — they are how `testFanIn` is known — but are never a
 * module row, a hot spot, a signal or a zone member.
 *
 * ── Comparison ──
 *
 * `compareMetrics` compares a run with the latest earlier run over the same
 * scope and window (`findBaseline`): hot spots whose score grew by MORE than
 * the threshold (relative), hot spots that entered the list, and cycles that
 * did not exist. `milestoneDecision` turns that into the action the
 * `complete-milestone` stage takes under `architecture.survey_at_milestone`
 * (`suggest` | `auto` | `off`): no signal is `none`, never a nag.
 *
 * ADR-457 build-at-publish: source in src/arch-metrics.cts, compiled to
 * gsd-core/bin/lib/arch-metrics.cjs (gitignored).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildImportGraph, stronglyConnected } from './code-graph.cjs';
import type { ImportGraph, AliasConfig } from './code-graph.cjs';
import { parseWindow, readHistory, churnOf, coChangeOf } from './git-history.cjs';
import type { HistoryOptions, HistoryRange, HistoryStatus } from './git-history.cjs';
import { analyzeSource, ANALYZABLE_EXTENSIONS } from './complexity-trigger.cjs';
import { tryWithinRootLexical } from './security.cjs';
import type { ListFiles } from './symbol-index.cjs';

// ─── Constants ───────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;

/** Defaults of the `architecture.*` config keys plus the fixed caps. */
export const DEFAULTS = Object.freeze({
  window: '90d',
  topZones: 5,
  smallModuleLoc: 40,
  cochangeMinSupport: 3,
  cochangeMinConfidence: 0.6,
  growthThreshold: 0.25,
  /** Hot spots listed (and compared). */
  hotspotLimit: 20,
  /** Files per zone, seed included. */
  zoneMaxFiles: 12,
  /** Small modules in one directory that make a cluster. */
  clusterMinModules: 3,
});

/** Zones are one surveyor each; past this a survey is a fleet, not a look. */
export const MAX_TOP_ZONES = 50;

export const MILESTONE_MODES = Object.freeze(['suggest', 'auto', 'off'] as const);
export type MilestoneMode = (typeof MILESTONE_MODES)[number];
/** Default of `architecture.survey_at_milestone`: propose a survey, never start one unasked. */
export const DEFAULT_MILESTONE_MODE: MilestoneMode = 'suggest';

/** Directory segments and file suffixes that mark a test or fixture file. */
const TEST_DIR_RE = /(^|\/)(tests?|__tests__|__mocks__|fixtures|spec)\//;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export const METRICS_FILE_RE = /^metrics-(\d{4}-\d{2}-\d{2})\.json$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ArchConfig {
  window: string;
  topZones: number;
  smallModuleLoc: number;
  cochangeMinSupport: number;
  cochangeMinConfidence: number;
  growthThreshold: number;
  atMilestone: MilestoneMode;
}

export interface ModuleRow {
  file: string;
  loc: number;
  exports: number;
  /** Search hint only — never a depth verdict. Null for an empty module. */
  exportsPerLoc: number | null;
  /** Distinct production importers (tests excluded, self excluded). */
  fanIn: number;
  /** Distinct test importers. */
  testFanIn: number;
  fanOut: number;
  inCycle: boolean;
  /** Commits of the window touching the file. */
  churn: number;
  /** Sum of per-function decision-point scores; null when not analyzable. */
  complexity: number | null;
  maxFunctionComplexity: number | null;
  /** churn × complexity (or complexity alone, see `hotspotBasis`); null when unknown. */
  hotspot: number | null;
  small: boolean;
}

export type HotspotBasis = 'churn-x-complexity' | 'complexity';

export interface Hotspot {
  file: string;
  churn: number;
  complexity: number;
  score: number;
}

export interface PassThrough {
  file: string;
  importer: string;
  target: string;
  loc: number;
}

export interface Cycle {
  members: string[];
  /** True when the cycle exists at runtime, not only through `import type`. */
  runtime: boolean;
}

export interface CoChangeRow {
  a: string;
  b: string;
  support: number;
  confidence: number;
  /** True when either file imports the other: co-change WITHOUT an import is the smeared-behaviour signal. */
  importLinked: boolean;
}

export interface ZoneSignals {
  hotspots: string[];
  /** Indexes into `cycles`. */
  cycles: number[];
  passThrough: string[];
  smallClusters: string[];
  coChange: Array<[string, string]>;
}

export interface Zone {
  id: string;
  seed: string;
  /** Longest common directory of the zone's files ('.' at the root). */
  label: string;
  /** Sum of the files' hot spot scores. */
  score: number;
  files: string[];
  signals: ZoneSignals;
}

export interface ArchMetrics {
  schema: number;
  date: string;
  scope: { paths: string[] | null; window: string; range: HistoryRange };
  thresholds: {
    smallModuleLoc: number;
    cochangeMinSupport: number;
    cochangeMinConfidence: number;
    topZones: number;
    hotspotLimit: number;
    zoneMaxFiles: number;
    clusterMinModules: number;
  };
  /** `degraded` when any input was partial; `reasons` names each one. */
  status: 'resolved' | 'degraded';
  reasons: string[];
  history: { status: HistoryStatus; reason: string | null; commits: number };
  graph: {
    modules: number;
    testModules: number;
    edges: number;
    unresolved: Record<string, number>;
    skipped: number;
    aliasWarnings: string[];
  };
  hotspotBasis: HotspotBasis;
  modules: ModuleRow[];
  hotspots: Hotspot[];
  smallModules: string[];
  smallClusters: Array<{ dir: string; modules: string[] }>;
  passThrough: PassThrough[];
  cycles: Cycle[];
  coChange: CoChangeRow[];
  zones: Zone[];
  /** Production import edges among module rows, `[from, to]` — the diagrams are drawn from these. */
  edges: Array<[string, string]>;
}

export interface MetricsOptions {
  date: string;
  /** Root-relative scope; omitted = the whole root. */
  paths?: readonly string[];
  config?: Partial<ArchConfig>;
  /** Seams for tests. */
  listFiles?: ListFiles;
  aliases?: AliasConfig;
  history?: HistoryOptions;
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG_KEYS: ReadonlyArray<[keyof ArchConfig, string]> = Object.freeze([
  ['window', 'survey_window'],
  ['topZones', 'survey_top_zones'],
  ['smallModuleLoc', 'small_module_loc'],
  ['cochangeMinSupport', 'cochange_min_support'],
  ['cochangeMinConfidence', 'cochange_min_confidence'],
  ['growthThreshold', 'survey_growth_threshold'],
  ['atMilestone', 'survey_at_milestone'],
]);

function configProblem(key: string, want: string, raw: unknown, fallback: unknown): string {
  return `architecture.${key} must be ${want}, got ${JSON.stringify(raw)} — using ${JSON.stringify(fallback)}`;
}

/**
 * The `architecture.*` keys of a loaded config (nested or dotted), each checked; a bad value
 * falls back to its default and is named in `problems` instead of failing the run.
 */
export function resolveArchConfig(config: Record<string, unknown> | null | undefined): { config: ArchConfig; problems: string[] } {
  const out: ArchConfig = {
    window: DEFAULTS.window,
    topZones: DEFAULTS.topZones,
    smallModuleLoc: DEFAULTS.smallModuleLoc,
    cochangeMinSupport: DEFAULTS.cochangeMinSupport,
    cochangeMinConfidence: DEFAULTS.cochangeMinConfidence,
    growthThreshold: DEFAULTS.growthThreshold,
    atMilestone: DEFAULT_MILESTONE_MODE,
  };
  const problems: string[] = [];
  const nested = config && typeof config['architecture'] === 'object' && config['architecture'] !== null
    ? (config['architecture'] as Record<string, unknown>)
    : {};
  for (const [field, key] of CONFIG_KEYS) {
    const raw = nested[key] !== undefined ? nested[key] : config?.[`architecture.${key}`];
    if (raw === undefined || raw === null) continue;
    switch (field) {
      case 'window':
        if (typeof raw !== 'string' || parseWindow(raw) === null) problems.push(configProblem(key, 'a window (90d, 12w, 6m, 1y, an ISO date or a ref)', raw, out.window));
        else out.window = raw;
        break;
      case 'topZones':
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_TOP_ZONES) {
          problems.push(configProblem(key, `an integer from 1 to ${MAX_TOP_ZONES}`, raw, out.topZones));
        } else out.topZones = raw;
        break;
      case 'smallModuleLoc':
      case 'cochangeMinSupport':
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) problems.push(configProblem(key, 'an integer >= 1', raw, out[field]));
        else out[field] = raw;
        break;
      case 'cochangeMinConfidence':
        if (typeof raw !== 'number' || !(raw > 0 && raw <= 1)) problems.push(configProblem(key, 'a number in (0, 1]', raw, out[field]));
        else out[field] = raw;
        break;
      case 'growthThreshold':
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) problems.push(configProblem(key, 'a number >= 0', raw, out[field]));
        else out[field] = raw;
        break;
      case 'atMilestone':
        if (typeof raw !== 'string' || !(MILESTONE_MODES as readonly string[]).includes(raw)) {
          problems.push(configProblem(key, MILESTONE_MODES.join(' | '), raw, out.atMilestone));
        } else out.atMilestone = raw as MilestoneMode;
        break;
    }
  }
  return { config: out, problems };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isTestFile(file: string): boolean {
  return TEST_DIR_RE.test(file) || TEST_FILE_RE.test(file);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dirOf(file: string): string {
  const d = path.posix.dirname(file);
  return d === '' ? '.' : d;
}

function commonDir(files: readonly string[]): string {
  if (files.length === 0) return '.';
  let parts = dirOf(files[0]).split('/');
  for (const f of files.slice(1)) {
    const other = dirOf(f).split('/');
    let i = 0;
    while (i < parts.length && i < other.length && parts[i] === other[i]) i++;
    parts = parts.slice(0, i);
  }
  const joined = parts.join('/');
  return joined === '' ? '.' : joined;
}

/** Complexity of one module file; null when the file is not analyzable or cannot be read safely. */
function fileComplexity(root: string, file: string): { total: number; max: number } | null {
  if (!ANALYZABLE_EXTENSIONS.includes(path.posix.extname(file))) return null;
  // Lexical containment plus lstat: a committed symlink is refused, never followed out of the root.
  const abs = tryWithinRootLexical(file, root);
  if (abs === null) return null;
  let source: string;
  try {
    if (!fs.lstatSync(abs).isFile()) return null;
    source = fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
  const analyzed = analyzeSource(source);
  if (!analyzed.ok) return null;
  let total = 0;
  let max = 0;
  for (const fn of analyzed.functions) {
    total += fn.score;
    if (fn.score > max) max = fn.score;
  }
  return { total, max };
}

// ─── Metrics ─────────────────────────────────────────────────────────────────

/** The architecture metrics of `root` (the git top level) over `opts.paths` and the configured window. */
export function computeMetrics(root: string, opts: MetricsOptions): ArchMetrics {
  if (!DATE_RE.test(opts.date)) throw new TypeError(`arch-metrics: date must be YYYY-MM-DD, got ${JSON.stringify(opts.date)}`);
  const cfg: ArchConfig = { ...resolveArchConfig(null).config, ...(opts.config ?? {}) };
  const range = parseWindow(cfg.window);
  if (range === null) throw new TypeError(`arch-metrics: unreadable window ${JSON.stringify(cfg.window)}`);
  const paths = opts.paths !== undefined && opts.paths.length > 0 ? [...opts.paths] : undefined;
  const reasons: string[] = [];

  const graph: ImportGraph = buildImportGraph(root, {
    ...(paths !== undefined ? { paths } : {}),
    ...(opts.aliases !== undefined ? { aliases: opts.aliases } : {}),
    ...(opts.listFiles !== undefined ? { listFiles: opts.listFiles } : {}),
  });
  const history = readHistory(root, { ...range, ...(paths !== undefined ? { paths } : {}) }, opts.history ?? {});
  if (history.status !== 'resolved') reasons.push(`history:${history.reason ?? history.status}`);
  if (graph.skipped.length > 0) reasons.push(`graph-skipped:${graph.skipped.length}`);
  if (graph.unresolved.length > 0) reasons.push(`graph-unresolved:${graph.unresolved.length}`);

  const rowsFiles = graph.nodes.filter((n) => n.scanned && !isTestFile(n.file)).map((n) => n.file);
  const isRow = new Set(rowsFiles);

  // Production adjacency among module rows; test importers are counted apart.
  const importers = new Map<string, Set<string>>();
  const testImporters = new Map<string, Set<string>>();
  const imports = new Map<string, Set<string>>();
  for (const f of rowsFiles) {
    importers.set(f, new Set());
    testImporters.set(f, new Set());
    imports.set(f, new Set());
  }
  const edgeKeys = new Set<string>();
  for (const e of graph.edges) {
    if (e.from === e.to || !isRow.has(e.to)) continue;
    if (isTestFile(e.from)) {
      testImporters.get(e.to)?.add(e.from);
      continue;
    }
    if (!isRow.has(e.from)) continue;
    importers.get(e.to)?.add(e.from);
    imports.get(e.from)?.add(e.to);
    edgeKeys.add(`${e.from}\n${e.to}`);
  }
  const edges = [...edgeKeys].map((k) => k.split('\n') as [string, string]).sort((x, y) => cmp(x[0], y[0]) || cmp(x[1], y[1]));
  const linked = (a: string, b: string): boolean => edgeKeys.has(`${a}\n${b}`) || edgeKeys.has(`${b}\n${a}`);

  // Cycles among production modules; `runtime` when an all-runtime cycle lives inside it.
  const prodOnly = (members: string[]): string[] => members.filter((m) => isRow.has(m));
  const runtimeSccs = stronglyConnected(graph, { includeTypeOnly: false }).map(prodOnly).filter((c) => c.length > 1);
  const cycles: Cycle[] = stronglyConnected(graph)
    .map(prodOnly)
    .filter((c) => c.length > 1)
    .map((members) => ({ members, runtime: runtimeSccs.some((r) => r.every((m) => members.includes(m))) }));
  const inCycle = new Set(cycles.flatMap((c) => c.members));

  // History: churn per file and co-change among module rows.
  const churn = new Map<string, number>();
  for (const f of churnOf(history).files) churn.set(f.file, f.commits);
  const hasHistory = history.commits.length > 0;
  const hotspotBasis: HotspotBasis = hasHistory ? 'churn-x-complexity' : 'complexity';
  if (!hasHistory) reasons.push('hotspot-basis:complexity');
  const coChange: CoChangeRow[] = coChangeOf(history, { minSupport: cfg.cochangeMinSupport, minConfidence: cfg.cochangeMinConfidence })
    .pairs.filter((p) => isRow.has(p.a) && isRow.has(p.b))
    .map((p) => ({ a: p.a, b: p.b, support: p.support, confidence: p.confidence, importLinked: linked(p.a, p.b) }));

  const nodeByFile = new Map(graph.nodes.map((n) => [n.file, n]));
  const modules: ModuleRow[] = rowsFiles.map((file) => {
    const node = nodeByFile.get(file);
    const loc = node?.loc ?? 0;
    const exportsCount = node?.exports ?? 0;
    const cx = fileComplexity(root, file);
    const commits = churn.get(file) ?? 0;
    let hotspot: number | null = null;
    if (cx !== null) hotspot = hasHistory ? commits * cx.total : cx.total;
    return {
      file,
      loc,
      exports: exportsCount,
      exportsPerLoc: loc > 0 ? Math.round((exportsCount / loc) * 1000) / 1000 : null,
      fanIn: importers.get(file)?.size ?? 0,
      testFanIn: testImporters.get(file)?.size ?? 0,
      fanOut: imports.get(file)?.size ?? 0,
      inCycle: inCycle.has(file),
      churn: commits,
      complexity: cx?.total ?? null,
      maxFunctionComplexity: cx?.max ?? null,
      hotspot,
      small: loc <= cfg.smallModuleLoc,
    };
  });
  const rowByFile = new Map(modules.map((m) => [m.file, m]));

  const hotspots: Hotspot[] = modules
    .filter((m) => m.hotspot !== null && m.hotspot > 0)
    .map((m) => ({ file: m.file, churn: m.churn, complexity: m.complexity as number, score: m.hotspot as number }))
    .sort((a, b) => b.score - a.score || cmp(a.file, b.file))
    .slice(0, DEFAULTS.hotspotLimit);

  const smallModules = modules.filter((m) => m.small).map((m) => m.file);
  const byDir = new Map<string, string[]>();
  for (const f of smallModules) byDir.set(dirOf(f), [...(byDir.get(dirOf(f)) ?? []), f]);
  const smallClusters = [...byDir.entries()]
    .filter(([, mods]) => mods.length >= DEFAULTS.clusterMinModules)
    .map(([dir, mods]) => ({ dir, modules: mods }))
    .sort((a, b) => b.modules.length - a.modules.length || cmp(a.dir, b.dir));

  const passThrough: PassThrough[] = modules
    .filter((m) => m.small && m.fanIn === 1 && m.fanOut === 1)
    .map((m) => ({
      file: m.file,
      importer: [...(importers.get(m.file) ?? [])][0],
      target: [...(imports.get(m.file) ?? [])][0],
      loc: m.loc,
    }));

  const zones = buildZones({
    cfg, modules, hotspots, importers, imports, coChange, cycles, passThrough, smallClusters, rowByFile,
  });

  const unresolved: Record<string, number> = {};
  for (const u of graph.unresolved) unresolved[u.reason] = (unresolved[u.reason] ?? 0) + 1;

  return {
    schema: SCHEMA_VERSION,
    date: opts.date,
    scope: { paths: graph.scope, window: cfg.window, range },
    thresholds: {
      smallModuleLoc: cfg.smallModuleLoc,
      cochangeMinSupport: cfg.cochangeMinSupport,
      cochangeMinConfidence: cfg.cochangeMinConfidence,
      topZones: cfg.topZones,
      hotspotLimit: DEFAULTS.hotspotLimit,
      zoneMaxFiles: DEFAULTS.zoneMaxFiles,
      clusterMinModules: DEFAULTS.clusterMinModules,
    },
    status: reasons.length === 0 ? 'resolved' : 'degraded',
    reasons,
    history: { status: history.status, reason: history.reason, commits: history.commits.length },
    graph: {
      modules: modules.length,
      testModules: graph.nodes.filter((n) => n.scanned && isTestFile(n.file)).length,
      edges: edges.length,
      unresolved,
      skipped: graph.skipped.length,
      aliasWarnings: [...graph.aliases.warnings],
    },
    hotspotBasis,
    modules,
    hotspots,
    smallModules,
    smallClusters,
    passThrough,
    cycles,
    coChange,
    zones,
    edges,
  };
}

// ─── Zones ───────────────────────────────────────────────────────────────────

interface ZoneInput {
  cfg: ArchConfig;
  modules: ModuleRow[];
  hotspots: Hotspot[];
  importers: Map<string, Set<string>>;
  imports: Map<string, Set<string>>;
  coChange: CoChangeRow[];
  cycles: Cycle[];
  passThrough: PassThrough[];
  smallClusters: Array<{ dir: string; modules: string[] }>;
  rowByFile: Map<string, ModuleRow>;
}

/**
 * Seeds are the hot spots, hottest first (with no hot spot at all: the most coupled modules).
 * A seed already inside an earlier zone does not open one. The zone takes the seed's co-change
 * partners (by support), then its importers and imports (hottest first), up to `zoneMaxFiles`.
 * Zones are disjoint: a file belongs to the first zone that reaches it, so a hub every module
 * imports is surveyed once, not by every surveyor.
 */
function buildZones(z: ZoneInput): Zone[] {
  const score = (f: string): number => z.rowByFile.get(f)?.hotspot ?? 0;
  const byHeat = (a: string, b: string): number => score(b) - score(a) || cmp(a, b);
  const seeds = z.hotspots.length > 0
    ? z.hotspots.map((h) => h.file)
    : z.modules
      .filter((m) => m.fanIn + m.fanOut > 0)
      .sort((a, b) => b.fanIn + b.fanOut - (a.fanIn + a.fanOut) || cmp(a.file, b.file))
      .map((m) => m.file);
  const covered = new Set<string>();
  const zones: Zone[] = [];
  for (const seed of seeds) {
    if (zones.length >= z.cfg.topZones) break;
    if (covered.has(seed)) continue;
    const partners = z.coChange
      .filter((p) => p.a === seed || p.b === seed)
      .sort((x, y) => y.support - x.support || y.confidence - x.confidence || cmp(x.a + x.b, y.a + y.b))
      .map((p) => (p.a === seed ? p.b : p.a));
    const neighbours = [...new Set([...(z.importers.get(seed) ?? []), ...(z.imports.get(seed) ?? [])])].sort(byHeat);
    const files = [seed];
    for (const f of [...partners, ...neighbours]) {
      if (files.length >= DEFAULTS.zoneMaxFiles) break;
      if (!files.includes(f) && !covered.has(f)) files.push(f);
    }
    const sorted = [...files].sort(cmp);
    const inZone = new Set(sorted);
    for (const f of sorted) covered.add(f);
    zones.push({
      id: `z${zones.length + 1}`,
      seed,
      label: commonDir(sorted),
      score: sorted.reduce((s, f) => s + score(f), 0),
      files: sorted,
      signals: {
        hotspots: z.hotspots.filter((h) => inZone.has(h.file)).map((h) => h.file),
        cycles: z.cycles.map((c, i) => (c.members.some((m) => inZone.has(m)) ? i : -1)).filter((i) => i >= 0),
        passThrough: z.passThrough.filter((p) => inZone.has(p.file)).map((p) => p.file),
        smallClusters: z.smallClusters.filter((c) => c.modules.some((m) => inZone.has(m))).map((c) => c.dir),
        coChange: z.coChange.filter((p) => inZone.has(p.a) && inZone.has(p.b)).map((p) => [p.a, p.b] as [string, string]),
      },
    });
  }
  return zones;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

export function metricsFileName(date: string): string {
  if (!DATE_RE.test(date)) throw new TypeError(`arch-metrics: date must be YYYY-MM-DD, got ${JSON.stringify(date)}`);
  return `metrics-${date}.json`;
}

/** The `metrics-<date>.json` files of `dir`, newest first. A missing directory has none. */
export function listMetricsFiles(dir: string): Array<{ date: string; file: string }> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ name, m: METRICS_FILE_RE.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .map((x) => ({ date: x.m[1], file: path.join(dir, x.name) }))
    .sort((a, b) => cmp(b.date, a.date));
}

/** A parsed metrics file, or null when it is unreadable or not this schema. */
export function readMetricsFile(file: string): ArchMetrics | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return null;
    const m = parsed as Partial<ArchMetrics>;
    if (m.schema !== SCHEMA_VERSION || !Array.isArray(m.hotspots) || !Array.isArray(m.zones) || !Array.isArray(m.cycles)) return null;
    return m as ArchMetrics;
  } catch {
    return null;
  }
}

function comparable(a: ArchMetrics, b: ArchMetrics): boolean {
  return a.scope.window === b.scope.window
    && JSON.stringify(a.scope.paths) === JSON.stringify(b.scope.paths)
    && a.hotspotBasis === b.hotspotBasis;
}

/**
 * The latest metrics in `dir` dated strictly before `current.date` over the same scope, window
 * and hot spot basis. Any other run is not a baseline: its scores are not in the same units.
 */
export function findBaseline(dir: string, current: ArchMetrics): { date: string; file: string; metrics: ArchMetrics } | null {
  for (const entry of listMetricsFiles(dir)) {
    if (entry.date >= current.date) continue;
    const metrics = readMetricsFile(entry.file);
    if (metrics !== null && comparable(metrics, current)) return { ...entry, metrics };
  }
  return null;
}

// ─── Comparison and the milestone decision ───────────────────────────────────

export interface Comparison {
  baseline: string | null;
  threshold: number;
  /** Hot spots in both runs whose score grew by more than `threshold` (relative). */
  grown: Array<{ file: string; before: number; after: number; growth: number }>;
  /** Hot spots of this run that were not hot spots of the baseline. */
  entered: Array<{ file: string; score: number }>;
  /** Cycles (by members) the baseline did not have. */
  newCycles: string[][];
  /** Ids of this run's zones holding any of the above. */
  zones: string[];
  signal: boolean;
}

/** Compare a run with its baseline; with no baseline there is nothing to compare and no signal. */
export function compareMetrics(baseline: ArchMetrics | null, current: ArchMetrics, threshold: number): Comparison {
  if (baseline === null) {
    return { baseline: null, threshold, grown: [], entered: [], newCycles: [], zones: [], signal: false };
  }
  const before = new Map(baseline.hotspots.map((h) => [h.file, h.score]));
  const grown: Comparison['grown'] = [];
  const entered: Comparison['entered'] = [];
  for (const h of current.hotspots) {
    const prev = before.get(h.file);
    if (prev === undefined) {
      entered.push({ file: h.file, score: h.score });
      continue;
    }
    const growth = prev > 0 ? (h.score - prev) / prev : 0;
    if (growth > threshold) grown.push({ file: h.file, before: prev, after: h.score, growth: Math.round(growth * 1000) / 1000 });
  }
  const known = new Set(baseline.cycles.map((c) => c.members.join('\n')));
  const newCycles = current.cycles.filter((c) => !known.has(c.members.join('\n'))).map((c) => c.members);
  const flagged = new Set([...grown.map((g) => g.file), ...entered.map((e) => e.file), ...newCycles.flat()]);
  const zones = current.zones.filter((z) => z.files.some((f) => flagged.has(f))).map((z) => z.id);
  return {
    baseline: baseline.date,
    threshold,
    grown,
    entered,
    newCycles,
    zones,
    signal: grown.length + entered.length + newCycles.length > 0,
  };
}

export interface MilestoneDecision {
  mode: MilestoneMode;
  action: 'none' | 'suggest' | 'auto' | 'off';
  reason: 'disabled' | 'no-baseline' | 'no-growth' | 'growth';
  zones: string[];
}

/** What the `complete-milestone` stage does with a comparison. Only a real signal proposes a survey. */
export function milestoneDecision(comparison: Comparison, mode: MilestoneMode): MilestoneDecision {
  if (mode === 'off') return { mode, action: 'off', reason: 'disabled', zones: [] };
  if (comparison.baseline === null) return { mode, action: 'none', reason: 'no-baseline', zones: [] };
  if (!comparison.signal) return { mode, action: 'none', reason: 'no-growth', zones: [] };
  return { mode, action: mode, reason: 'growth', zones: comparison.zones };
}

/**
 * The stage answer of `arch stage` (loop-hook-dispatch.md): what `complete-milestone` does at
 * `milestone:post` with a milestone decision. The survey is scoped to the directories of the
 * zones that grew (`--paths`); a zone labelled `.` covers the root, so the survey runs unscoped.
 */
export interface MilestoneStageAnswer {
  decision: 'skip' | 'suggest' | 'auto';
  message: string | null;
  next: { skill: 'arch-survey'; args: string } | null;
}

export function milestoneStageAnswer(decision: MilestoneDecision, zones: readonly Zone[], slash = '/gsd-arch-survey'): MilestoneStageAnswer {
  if (decision.action !== 'suggest' && decision.action !== 'auto') return { decision: 'skip', message: null, next: null };
  const flagged = zones.filter((z) => decision.zones.includes(z.id));
  const labels = [...new Set(flagged.map((z) => z.label))].sort(cmp);
  const args = labels.length === 0 || labels.includes('.') ? '' : `--paths ${labels.join(',')}`;
  const command = args === '' ? slash : `${slash} ${args}`;
  const where = labels.length === 0 ? '' : ` in ${labels.join(', ')}`;
  return {
    decision: decision.action,
    message: decision.action === 'suggest' ? `Hot spots grew since the last architecture survey${where}: run ${command}` : null,
    next: { skill: 'arch-survey', args },
  };
}
