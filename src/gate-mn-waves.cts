/**
 * `gsd_run check mn-wave-collision` and `gsd_run check mn-wave-solve` — the wave gates of
 * mn-verify-gate (replace scripts/wave-collision.mjs, wave-normalize.mjs and wave-solve.mjs).
 *
 * ── The one parallelism rule ─────────────────────────────────────────────
 *
 * Same-wave plans run at once in separate worktrees and commit in sequence, so two of them
 * declaring one file means the second commit overwrites the first or conflicts; and a plan must
 * run strictly after every plan it depends on. The rule lives as pseudocode in the planner prompt;
 * measured across 13 planning roots, 38 of 283 phases (13.4%) violate it, stable while data
 * quality doubled. These gates are the mechanism that checks it.
 *
 * ── mn-wave-collision: one verb, two modes ───────────────────────────────
 *
 *   literal  only concrete files (basename with a dot, no wildcard) are compared; directories and
 *            globs are counted as `skipped`, never guessed at. The only finding is a colliding pair.
 *   expand   (config `workflow.wave_normalize: true`, or `--expand` by hand) every entry is resolved
 *            against the live tree (src/files-modified-normalize.cts, root = the project) BEFORE
 *            comparing — the measured false negative was two same-wave plans declaring one
 *            40-file directory. Four findings that never collapse (D-65, D-66): COLLIDING PAIRS,
 *            DECLARED NOTHING (a refusal to declare, never "overlaps nobody"), RESOLVED TO NOTHING
 *            (the files moved), UNPARSEABLE ENTRIES (prose where a path belongs).
 *
 * The two capability gates (`wave_collision`, `wave_normalize`) both query this verb; the mode is
 * a config parameter, not part of the query (decision 4), and with both keys on the stronger mode
 * runs twice with the same answer.
 *
 * ── mn-wave-solve: computed, not trusted ─────────────────────────────────
 *
 * Composition of upstream functions, not a second solver: depends_on levels and cycles come from
 * `computeDependencyLevels` (src/phase.cts, the phase-plan-index pass) with its own token
 * resolver; inside a level, `partitionByFileOverlap` (src/file-overlap-partitioner.cts) separates
 * plans sharing a file — on NORMALIZED entries (the same comparable set as mn-wave-collision). The
 * computed assignment numbers waves from the phase's own base (0 or 1, both exist in live data).
 *
 * The verdict judges the DECLARED assignment against the invariant, not against one particular
 * greedy answer: a plan running at or before a dependency's wave, or sharing a wave and a file with
 * another plan, is a violation. A plan that declares no wave runs where phase-plan-index puts it —
 * its depends_on level from the phase base — and is judged there. A plan scheduled later than the computed wave is safe
 * (`conservative`, reported, never blocking). A cycle has no assignment → unresolvable.
 *
 * ── Payload size ─────────────────────────────────────────────────────────
 *
 * The dispatcher reads `block` with jq from stdout, and gsd-tools swaps a payload over ~50 KB for
 * an `@file:` pointer — which jq cannot read, so an oversized verdict would read as "no block".
 * Every list in a payload is therefore capped (`MAX_LISTED`, `MAX_SHARED_LISTED`) with the true
 * count beside it; `analyzeWaveCollision` / `analyzeWaveSolve` return the full detail in-process.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { readWorkflowConfigValue } from './gate-config.cjs';
import { normalizePlanFiles } from './files-modified-normalize.cjs';
import type { FsProbe, NormalizedEntry } from './files-modified-normalize.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-document.cjs is an export= CommonJS module
import planDocumentMod = require('./plan-document.cjs');
const { parsePlanDocument, planIdFromFile } = planDocumentMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-scope.cjs is an export= CommonJS module
import planningScope = require('./planning-scope.cjs');
const { SCOPE } = planningScope;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase.cjs is an export= CommonJS module
import phaseMod = require('./phase.cjs');
const { computeDependencyLevels, buildShortFormToId, normalizeDependencyToken, resolveDependencyId } = phaseMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- core-utils.cjs is an export= CommonJS module
import coreUtils = require('./core-utils.cjs');
const { extractCanonicalPlanId } = coreUtils;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- file-overlap-partitioner.cjs is an export= CommonJS module
import overlapMod = require('./file-overlap-partitioner.cjs');
const { partitionByFileOverlap } = overlapMod;

/** Most items any list in a payload carries; the true count rides beside it. */
export const MAX_LISTED = 50;
/** Most shared files a colliding pair lists in a payload; `sharedCount` carries the rest. */
export const MAX_SHARED_LISTED = 20;

export type WaveMode = 'literal' | 'expand';

type RawPlan = Parameters<typeof computeDependencyLevels>[0][number];

/** One plan of the phase as the wave gates read it. */
interface WavePlan {
  /** File name relative to the phase directory (`plans/…` for the nested layout). */
  plan: string;
  id: string;
  wave: number | null;
  dependsOn: string[];
  declared: string[];
  raw: RawPlan;
}

/** A plan with its declared entries normalised and its comparable file set. */
export interface ComparedPlan {
  plan: string;
  wave: number | null;
  declaredNothing: boolean;
  entries: readonly NormalizedEntry[];
  /** The files this plan is compared on: resolved (expand) or concrete declared files (literal). */
  files: readonly string[];
  /** Literal mode: entries not compared (directories, globs, prose). */
  skipped: number;
}

export interface Collision {
  wave: number;
  a: string;
  b: string;
  shared: string[];
}

// ─── reading ───────────────────────────────────────────────────────────────

/** The phase's executable plans (superseded ones never run, so they cannot race), sorted. */
function readPhasePlans(phaseDir: string): WavePlan[] | { unreadable: string } {
  const scan = scanPhasePlans(phaseDir);
  if (scan.scope !== SCOPE.COMPLETE) return { unreadable: `could not list every plan in ${phaseDir} (scope: ${scan.scope})` };
  const plans: WavePlan[] = [];
  for (const plan of [...scan.planFiles].sort()) {
    const full = path.join(phaseDir, plan);
    let text: string;
    try {
      // A PLAN.md that is a directory is "could not look": skipping it silently would read as clean.
      if (!fs.statSync(full).isFile()) return { unreadable: `${plan} is not a readable file` };
      text = fs.readFileSync(full, 'utf8');
    } catch (err) {
      return { unreadable: `cannot read ${plan}: ${(err as Error).message}` };
    }
    const doc = parsePlanDocument(text, full);
    const id = planIdFromFile(plan);
    plans.push({
      plan,
      id,
      wave: doc.declaredWave,
      dependsOn: doc.dependsOn,
      declared: doc.filesModified,
      raw: { ...doc, id, hasSummary: false, halted: false },
    });
  }
  return plans;
}

/** Expand mode is on by config (`workflow.wave_normalize`) or by hand (`--expand`). */
function readMode(projectDir: string, args: readonly string[]): WaveMode {
  if (args.includes('--expand')) return 'expand';
  const resolved = readWorkflowConfigValue(projectDir, 'workflow.wave_normalize');
  const value = resolved.found ? resolved.value : undefined;
  return value === true || (typeof value === 'string' && value.toLowerCase() === 'true') ? 'expand' : 'literal';
}

/**
 * The live tree under `root`, read without following symlinks (T-03-01): a symlinked directory
 * is neither walked nor counted, so a link pointing outside contributes nothing.
 */
function treeProbe(root: string): FsProbe {
  const abs = (p: string): string => (p === '' ? root : path.join(root, p));
  const lstat = (p: string): fs.Stats | null => {
    try {
      return fs.lstatSync(abs(p));
    } catch {
      return null;
    }
  };
  return {
    exists: (p) => lstat(p) !== null,
    isDirectory: (p) => lstat(p)?.isDirectory() === true,
    isSymbolicLink: (p) => lstat(p)?.isSymbolicLink() === true,
    readDir: (p) => fs.readdirSync(abs(p)),
  };
}

/** Literal mode looks at nothing on disk: every non-prose, non-wildcard entry stays a `file`. */
const NO_TREE: FsProbe = { exists: () => false, isDirectory: () => false, readDir: () => [] };

/** A concrete file: a basename with a dot. Directories and globs cannot be compared literally. */
function isConcreteFile(entry: NormalizedEntry): boolean {
  if (entry.kind !== 'file') return false;
  const p = entry.resolved[0] ?? '';
  return p.slice(p.lastIndexOf('/') + 1).includes('.');
}

function comparePlan(plan: WavePlan, mode: WaveMode, probe: FsProbe): ComparedPlan {
  const normalized = normalizePlanFiles(plan.declared, mode === 'expand' ? probe : NO_TREE);
  if (mode === 'expand') {
    return { plan: plan.plan, wave: plan.wave, declaredNothing: normalized.declaredNothing, entries: normalized.entries, files: normalized.files, skipped: 0 };
  }
  const concrete = normalized.entries.filter(isConcreteFile);
  const files = [...new Set(concrete.map((e) => e.resolved[0]))];
  return {
    plan: plan.plan,
    wave: plan.wave,
    declaredNothing: normalized.declaredNothing,
    entries: normalized.entries,
    files,
    skipped: normalized.entries.length - concrete.length,
  };
}

/** Every same-wave pair sharing a file, waves ascending, pairs in plan order. */
function findCollisions(plans: readonly ComparedPlan[]): { collisions: Collision[]; pairsChecked: number; waves: number } {
  const byWave = new Map<number, ComparedPlan[]>();
  for (const p of plans) {
    if (p.wave === null) continue;
    const group = byWave.get(p.wave) ?? [];
    group.push(p);
    byWave.set(p.wave, group);
  }
  const collisions: Collision[] = [];
  let pairsChecked = 0;
  for (const [wave, group] of [...byWave.entries()].sort((x, y) => x[0] - y[0])) {
    for (let i = 0; i < group.length; i++) {
      const left = new Set(group[i].files);
      for (let j = i + 1; j < group.length; j++) {
        pairsChecked++;
        const shared = group[j].files.filter((f) => left.has(f));
        if (shared.length > 0) collisions.push({ wave, a: group[i].plan, b: group[j].plan, shared });
      }
    }
  }
  return { collisions, pairsChecked, waves: byWave.size };
}

function capCollisions(collisions: readonly Collision[]): Array<Collision & { sharedCount: number }> {
  return collisions.slice(0, MAX_LISTED).map((c) => ({ ...c, shared: c.shared.slice(0, MAX_SHARED_LISTED), sharedCount: c.shared.length }));
}

// ─── mn-wave-collision ─────────────────────────────────────────────────────

export interface WaveCollisionAnalysis {
  mode: WaveMode;
  /** Plans carrying a wave — the only ones that run in parallel. */
  plans: ComparedPlan[];
  waves: number;
  pairsChecked: number;
  collisions: Collision[];
  declaredNothing: string[];
  resolvedToNothing: Array<{ plan: string; declared: string; kind: string }>;
  unparseable: Array<{ plan: string; declared: string }>;
  skipped: number;
}

/** The full collision analysis of one phase (in-process surface; the verdict caps its lists). */
export function analyzeWaveCollision(projectDir: string, phaseDir: string, mode: WaveMode): WaveCollisionAnalysis | { unreadable: string } {
  const read = readPhasePlans(phaseDir);
  if ('unreadable' in read) return read;
  const probe = treeProbe(projectDir);
  // A plan with no wave is not parallelised, so it cannot collide and has nothing to declare here.
  const plans = read.filter((p) => p.wave !== null).map((p) => comparePlan(p, mode, probe));
  const { collisions, pairsChecked, waves } = findCollisions(plans);
  const analysis: WaveCollisionAnalysis = {
    mode,
    plans,
    waves,
    pairsChecked,
    collisions,
    declaredNothing: [],
    resolvedToNothing: [],
    unparseable: [],
    skipped: plans.reduce((n, p) => n + p.skipped, 0),
  };
  if (mode === 'expand') {
    for (const p of plans) {
      if (p.declaredNothing) analysis.declaredNothing.push(p.plan);
      for (const e of p.entries) {
        if (e.kind === 'malformed') analysis.unparseable.push({ plan: p.plan, declared: e.declared });
        else if (e.unresolved && (e.kind === 'glob' || e.kind === 'directory')) {
          analysis.resolvedToNothing.push({ plan: p.plan, declared: e.declared, kind: e.kind });
        }
      }
    }
  }
  return analysis;
}

/** `gsd_run check mn-wave-collision <phase> [--expand]` */
export function evaluateMnWaveCollision(input: MnGateInput): GateResult {
  const mode = readMode(input.projectDir, input.args);
  const args = input.args.filter((a) => a !== '--expand');
  return withMnPhase('mn-wave-collision', { projectDir: input.projectDir, args }, ({ phaseDir }) => {
    const analysis = analyzeWaveCollision(input.projectDir, phaseDir, mode);
    if ('unreadable' in analysis) return mnUnresolvable(`mn-wave-collision: ${analysis.unreadable}`, { phaseDir, mode });
    const counts = {
      collisions: analysis.collisions.length,
      declaredNothing: analysis.declaredNothing.length,
      resolvedToNothing: analysis.resolvedToNothing.length,
      unparseable: analysis.unparseable.length,
    };
    const details = {
      phaseDir,
      mode,
      plans: analysis.plans.length,
      waves: analysis.waves,
      pairsChecked: analysis.pairsChecked,
      skipped: analysis.skipped,
      counts,
      collisions: capCollisions(analysis.collisions),
      declaredNothing: analysis.declaredNothing.slice(0, MAX_LISTED),
      resolvedToNothing: analysis.resolvedToNothing.slice(0, MAX_LISTED),
      unparseable: analysis.unparseable.slice(0, MAX_LISTED),
    };
    const findings = counts.collisions + counts.declaredNothing + counts.resolvedToNothing + counts.unparseable;
    if (findings === 0) {
      return mnPass(
        analysis.plans.length === 0
          ? 'mn-wave-collision: no wave-tagged plans — nothing to check'
          : `mn-wave-collision: OK — ${analysis.plans.length} plan(s) across ${analysis.waves} wave(s), ` +
              `${analysis.pairsChecked} pair(s) checked, no shared files` +
              (analysis.skipped > 0 ? `; ${analysis.skipped} directory/glob entr(ies) not compared (literal mode)` : ''),
        details,
      );
    }
    const parts: string[] = [];
    if (counts.collisions > 0) {
      parts.push(
        `COLLIDING PAIRS ${counts.collisions} (${analysis.collisions.slice(0, 5).map((c) => `wave ${c.wave}: ${c.a} × ${c.b}`).join('; ')}) — ` +
          'same-wave plans commit in sequence from separate worktrees, so the second overwrites the first or conflicts; ' +
          'move one plan to a later wave or split the shared file out',
      );
    }
    if (counts.declaredNothing > 0) parts.push(`DECLARED NOTHING ${counts.declaredNothing} — the planner must declare files; an empty list cannot be checked`);
    if (counts.resolvedToNothing > 0) parts.push(`RESOLVED TO NOTHING ${counts.resolvedToNothing} — the files moved; re-point or drop the entry`);
    if (counts.unparseable > 0) parts.push(`UNPARSEABLE ENTRIES ${counts.unparseable} — replace the prose with the paths it describes`);
    return mnFinding(`mn-wave-collision: ${findings} finding(s): ${parts.join('. ')}`, details);
  });
}

// ─── mn-wave-solve ─────────────────────────────────────────────────────────

export interface SolvedPlan {
  plan: string;
  id: string;
  declared: number | null;
  computed: number;
}

/**
 * `wave` is the wave the plan runs in: its declared wave, or — when it declares none — the wave
 * phase-plan-index gives it (its depends_on level from the phase base). `declared` is what the plan
 * wrote, `null` for none.
 */
export type WaveViolation =
  | { plan: string; kind: 'before-dependency'; wave: number; declared: number | null; dependency: string; dependencyWave: number }
  | { plan: string; kind: 'shares-file-in-wave'; wave: number; declared: number | null; with: string; shared: string[] };

export interface WaveSolveAnalysis {
  mode: WaveMode;
  base: number;
  waves: number;
  plans: SolvedPlan[];
  violations: WaveViolation[];
  conservative: SolvedPlan[];
  matched: number;
  undeclared: number;
  unresolvedDependencies: Array<{ plan: string; token: string }>;
}

/** The full solve of one phase, or why there is none (unreadable plans, a dependency cycle). */
export function analyzeWaveSolve(
  projectDir: string,
  phaseDir: string,
  mode: WaveMode,
): WaveSolveAnalysis | { unreadable: string } | { cycle: string[] } {
  const read = readPhasePlans(phaseDir);
  if ('unreadable' in read) return read;
  const plans = [...read].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const probe = treeProbe(projectDir);
  const compared = new Map(plans.map((p) => [p.id, comparePlan(p, mode, probe)]));

  const rawPlans = plans.map((p) => p.raw);
  const planMap = new Map(rawPlans.map((p) => [normalizeDependencyToken(p.id), p]));
  const canonicalToId = new Map(rawPlans.map((p) => [normalizeDependencyToken(extractCanonicalPlanId(p.id)), p.id]));
  const shortFormToId = buildShortFormToId(rawPlans);
  const { level, visited, unresolved } = computeDependencyLevels(rawPlans, planMap, canonicalToId, shortFormToId);
  if (visited < rawPlans.length) return { cycle: plans.filter((p) => !level.has(p.id)).map((p) => p.plan) };

  // The phase's own numbering base: some phases start at 0, others at 1.
  const declaredWaves = plans.map((p) => p.wave).filter((w): w is number => w !== null);
  const base = declaredWaves.length > 0 ? Math.min(...declaredWaves, 1) : 1;

  // Computed assignment: levels in order; inside a level, file-overlap stages; each stage a wave.
  const computed = new Map<string, number>();
  const maxLevel = Math.max(-1, ...level.values());
  let cursor = base;
  for (let l = 0; l <= maxLevel; l++) {
    const items = plans.filter((p) => level.get(p.id) === l).map((p) => ({ id: p.id, files: [...(compared.get(p.id)?.files ?? [])] }));
    if (items.length === 0) continue;
    const stages = partitionByFileOverlap(items);
    stages.forEach((stage, i) => {
      for (const id of stage) computed.set(id, cursor + i);
    });
    cursor += stages.length;
  }

  // The wave each plan runs in: declared, or the DAG level phase-plan-index assigns an undeclared one.
  const effective = new Map(plans.map((p) => [p.id, p.wave ?? (level.get(p.id) ?? 0) + base]));
  const byId = new Map(plans.map((p) => [p.id, p]));
  const byPlan = new Map(plans.map((p) => [p.plan, p]));
  const violations: WaveViolation[] = [];
  for (const p of plans) {
    const wave = effective.get(p.id) as number;
    for (const token of p.dependsOn) {
      const depId = resolveDependencyId(token, planMap, canonicalToId, shortFormToId);
      const dep = depId === null ? undefined : byId.get(depId);
      if (dep === undefined) continue;
      const dependencyWave = effective.get(dep.id) as number;
      if (wave <= dependencyWave) {
        violations.push({ plan: p.plan, kind: 'before-dependency', wave, declared: p.wave, dependency: dep.plan, dependencyWave });
      }
    }
  }
  const running = plans.map((p) => ({ ...(compared.get(p.id) as ComparedPlan), wave: effective.get(p.id) as number }));
  for (const c of findCollisions(running).collisions) {
    violations.push({ plan: c.b, kind: 'shares-file-in-wave', wave: c.wave, declared: byPlan.get(c.b)?.wave ?? null, with: c.a, shared: c.shared });
  }

  const solved: SolvedPlan[] = plans.map((p) => ({ plan: p.plan, id: p.id, declared: p.wave, computed: computed.get(p.id) ?? base }));
  return {
    mode,
    base,
    waves: new Set(solved.map((s) => s.computed)).size,
    plans: solved,
    violations,
    conservative: solved.filter((s) => s.declared !== null && s.declared > s.computed),
    matched: solved.filter((s) => s.declared === s.computed).length,
    undeclared: solved.filter((s) => s.declared === null).length,
    unresolvedDependencies: unresolved.map((u) => ({ plan: byId.get(u.plan)?.plan ?? u.plan, token: u.token })),
  };
}

/** `gsd_run check mn-wave-solve <phase> [--expand]` */
export function evaluateMnWaveSolve(input: MnGateInput): GateResult {
  const mode = readMode(input.projectDir, input.args);
  const args = input.args.filter((a) => a !== '--expand');
  return withMnPhase('mn-wave-solve', { projectDir: input.projectDir, args }, ({ phaseDir }) => {
    const analysis = analyzeWaveSolve(input.projectDir, phaseDir, mode);
    if ('unreadable' in analysis) return mnUnresolvable(`mn-wave-solve: ${analysis.unreadable}`, { phaseDir, mode });
    if ('cycle' in analysis) {
      return mnUnresolvable(
        `mn-wave-solve: dependency cycle among ${analysis.cycle.join(', ')} — a cyclic graph has no wave assignment, and inventing one would be worse than none`,
        { phaseDir, mode, cycle: analysis.cycle },
      );
    }
    const details = {
      phaseDir,
      mode,
      base: analysis.base,
      waves: analysis.waves,
      matched: analysis.matched,
      undeclared: analysis.undeclared,
      counts: { plans: analysis.plans.length, violations: analysis.violations.length, conservative: analysis.conservative.length },
      plans: analysis.plans.slice(0, MAX_LISTED),
      violations: analysis.violations.slice(0, MAX_LISTED).map((v) =>
        v.kind === 'shares-file-in-wave' ? { ...v, shared: v.shared.slice(0, MAX_SHARED_LISTED), sharedCount: v.shared.length } : v,
      ),
      conservative: analysis.conservative.slice(0, MAX_LISTED),
      unresolvedDependencies: analysis.unresolvedDependencies.slice(0, MAX_LISTED),
    };
    if (analysis.violations.length === 0) {
      return mnPass(
        analysis.plans.length === 0
          ? 'mn-wave-solve: no plans here — nothing to solve'
          : `mn-wave-solve: OK — ${analysis.matched} plan(s) match the computed assignment` +
              (analysis.conservative.length > 0 ? `, ${analysis.conservative.length} scheduled later than necessary (safe, only slower)` : '') +
              (analysis.undeclared > 0 ? `, ${analysis.undeclared} declare no wave` : '') +
              `, ${analysis.waves} wave(s) computed`,
        details,
      );
    }
    return mnFinding(
      `mn-wave-solve: ${analysis.violations.length} declared wave(s) break the invariant (` +
        analysis.violations.slice(0, 5).map((v) => (v.kind === 'before-dependency' ? `${v.plan} runs no later than its dependency ${v.dependency}` : `${v.plan} shares wave ${v.wave} and a file with ${v.with}`)).join('; ') +
        ') — a plan scheduled before its dependency runs against work that does not exist yet; one sharing a wave with a plan ' +
        'touching the same file races it in a separate worktree. Renumber the waves (see plans[].computed), or fix depends_on.',
      details,
    );
  });
}
