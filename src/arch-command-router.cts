'use strict';
/**
 * Architecture command router — `gsd-tools arch <subcommand>`, the CLI of
 * `/gsd:arch-survey` (capability `architecture`; pocock-practices design, D1).
 *
 *   arch metrics [--paths p1,p2] [--since 90d|<date>|<ref>] [--top N] [--date YYYY-MM-DD] [--compare-last] [--json]
 *   arch cards   [--date YYYY-MM-DD]
 *   arch report  [--date YYYY-MM-DD] [--refutation <file>]
 *   arch decide  --id arch-<hash> --disposition accepted|rejected|deferred [--reason <text>] [--route <text>] [--date YYYY-MM-DD]
 *   arch status
 *   arch stage   [--milestone vX.Y] [--date YYYY-MM-DD]
 *
 * Each subcommand is one deterministic step of the survey; the workflow runs
 * the model steps (surveyors, refuter, the user's choice) between them:
 *
 *   metrics → surveyors write survey-<date>/cards-<zone>.json → cards →
 *   refuter writes survey-<date>/refutation.md → report → user → decide
 *
 * `metrics` writes `.planning/architecture/metrics-<date>.json` and prints a
 * summary (hot spots, zones with their signals). `--compare-last` adds the
 * comparison with the latest earlier run over the same scope and the
 * `complete-milestone` decision under `architecture.survey_at_milestone`.
 * `--date` on the later steps defaults to the latest metrics run.
 *
 * `stage` is the architecture capability's `milestone:post` command step: `metrics
 * --compare-last` over the configured scope, always, plus the stage answer of
 * loop-hook-dispatch.md (`decision`, `message`, `next`) from that decision —
 * the survey itself is model work and only follows on `auto`.
 *
 * Paths: `--paths` and `--refutation` are typed by a user, so they are
 * confined to the project (`tryWithinRoot`, AbsoluteInsideRoot); the code
 * root is the git top level (`projectRoots().content`), the base both
 * `code-graph` and `git-history` report paths in. Without `--paths` a
 * project inside a larger repository is scoped to its own directory.
 *
 * Failure mapping (ADR-3889, through io.error's reason → outcome): bad flags
 * and paths outside the project → `usage`; a step run before the step that
 * writes its input → `arch_input_unavailable` (UNAVAILABLE).
 *
 * Dates (file names, decision dates) are the host-local calendar day: the
 * person who ran the survey at 01:00 reads it as today's.
 *
 * Seams: `_output` (captures output), `_clock` (the day), `_execGit` (git
 * runner for `metrics`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { platformWriteSync } from './shell-command-projection.cjs';
import { projectRoots } from './project-root.cjs';
import { formatGsdSlashFor } from './runtime-slash.cjs';
import { realClock } from './clock.cjs';
import type { Clock } from './clock.cjs';
import type { GitRunner } from './git-history.cjs';
import { parseWindow } from './git-history.cjs';
import * as archMetrics from './arch-metrics.cjs';
import type { ArchMetrics, ArchConfig } from './arch-metrics.cjs';
import * as archSurvey from './arch-survey.cjs';
import type { CandidateSet, Disposition } from './arch-survey.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import cjsCommandRouterAdapter = require('./cjs-command-router-adapter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import capabilityActivationMod = require('./capability-activation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import configLoaderMod = require('./config-loader.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceMod = require('./planning-workspace.cjs');

const { output, ERROR_REASON } = io;
const { routeHubCommandFamily } = cjsCommandRouterAdapter;
const { resolveConfigKey } = capabilityActivationMod;
const { loadConfig } = configLoaderMod;
const { planningDir } = planningWorkspaceMod;

/** Where a project keeps its ADRs: a rejection there is offered as an ADR. */
export const ADR_DIRECTORY = path.join('docs', 'adr');

export const ARCH_SUBCOMMANDS: readonly string[] = Object.freeze(['cards', 'decide', 'metrics', 'report', 'stage', 'status']);

const USAGE = Object.freeze({
  metrics: 'Usage: gsd-tools arch metrics [--paths p1,p2] [--since 90d|<date>|<ref>] [--top N] [--date YYYY-MM-DD] [--compare-last] [--json]',
  cards: 'Usage: gsd-tools arch cards [--date YYYY-MM-DD]',
  report: 'Usage: gsd-tools arch report [--date YYYY-MM-DD] [--refutation <file>]',
  decide: 'Usage: gsd-tools arch decide --id arch-<hash> --disposition accepted|rejected|deferred [--reason <text>] [--route <text>] [--date YYYY-MM-DD]',
  stage: 'Usage: gsd-tools arch stage [--milestone vX.Y] [--date YYYY-MM-DD]',
});

const CONFIG_KEYS = Object.freeze([
  'survey_window', 'survey_top_zones', 'small_module_loc', 'cochange_min_support',
  'cochange_min_confidence', 'survey_growth_threshold', 'survey_at_milestone',
]);

type OutputFn = (value: unknown, raw: boolean, rawValue?: unknown) => void;

interface RouteArchCommandOptions {
  args: string[];
  cwd: string;
  raw: boolean;
  error: (message: string, reason?: string) => void;
  _output?: OutputFn;
  _clock?: Pick<Clock, 'localToday'>;
  _execGit?: GitRunner;
}

// ─── Arguments ───────────────────────────────────────────────────────────────

/** The value after `--name` (or `--name=value`); null when absent; `undefined` when present without a value or repeated. */
function flagValue(args: string[], name: string): string | null | undefined {
  const flag = `--${name}`;
  let found: string | null | undefined = null;
  let count = 0;
  args.forEach((a, i) => {
    if (a === flag) {
      count++;
      const v = args[i + 1];
      found = v === undefined || v.startsWith('--') ? undefined : v;
    } else if (a.startsWith(`${flag}=`)) {
      count++;
      const v = a.slice(flag.length + 1);
      found = v === '' ? undefined : v;
    }
  });
  return count > 1 ? undefined : found;
}

/** Bad flags or a path outside the project → `usage`. */
class UsageError extends Error {}
/** A step run before the step that writes its input → `arch_input_unavailable`. */
class InputError extends Error {}

function requireDate(value: string | null | undefined, usage: string): string | null {
  if (value === undefined) throw new UsageError(usage);
  if (value === null) return null;
  if (!archMetrics.DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new UsageError(`--date must be YYYY-MM-DD, got ${JSON.stringify(value)}. ${usage}`);
  }
  return value;
}

// ─── Context ─────────────────────────────────────────────────────────────────

interface Ctx {
  cwd: string;
  /** The git top level — the base code-graph and git-history paths are in. */
  root: string;
  /** The project directory relative to `root` ('' when they are the same). */
  projectRel: string;
  archDir: string;
  today: string;
}

function makeCtx(cwd: string, clock: Pick<Clock, 'localToday'>): Ctx {
  const roots = projectRoots(cwd);
  const rel = path.relative(roots.content, roots.project).split(path.sep).join('/');
  return {
    cwd,
    root: roots.content,
    projectRel: rel.startsWith('..') ? '' : rel,
    archDir: path.join(planningDir(cwd), 'architecture'),
    today: clock.localToday(),
  };
}

function readConfig(cwd: string): { config: ArchConfig; problems: string[] } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const registry = require('./capability-registry.cjs') as Record<string, unknown>;
  const loaded = loadConfig(cwd);
  const dotted: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const r = resolveConfigKey(`architecture.${key}`, { config: loaded, cwd, registry, quiet: true });
    if (r.found) dotted[`architecture.${key}`] = r.value;
  }
  return archMetrics.resolveArchConfig(dotted);
}

function relToCwd(ctx: Ctx, abs: string): string {
  return path.relative(ctx.cwd, abs).split(path.sep).join('/');
}

function surveyDir(ctx: Ctx, date: string): string {
  return path.join(ctx.archDir, `survey-${date}`);
}

function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/** The metrics of `date`, or of the latest run when no date is given. */
function loadMetrics(ctx: Ctx, date: string | null): ArchMetrics {
  const file = date !== null
    ? path.join(ctx.archDir, archMetrics.metricsFileName(date))
    : archMetrics.listMetricsFiles(ctx.archDir)[0]?.file;
  const metrics = file === undefined ? null : archMetrics.readMetricsFile(file);
  if (metrics === null) {
    throw new InputError(date !== null
      ? `no readable metrics for ${date} in ${relToCwd(ctx, ctx.archDir)} — run: gsd-tools arch metrics --date ${date}`
      : `no metrics in ${relToCwd(ctx, ctx.archDir)} — run: gsd-tools arch metrics`);
  }
  return metrics;
}

function loadCandidates(ctx: Ctx, date: string): CandidateSet {
  const file = path.join(surveyDir(ctx, date), 'candidates.json');
  const text = readTextOrNull(file);
  if (text === null) throw new InputError(`no candidates for ${date} — run: gsd-tools arch cards --date ${date}`);
  return JSON.parse(text) as CandidateSet;
}

// ─── Handlers ────────────────────────────────────────────────────────────────

interface MetricsRun {
  summary: Record<string, unknown>;
  text: string;
  metrics: ArchMetrics;
  milestone: archMetrics.MilestoneDecision | undefined;
}

function handleMetrics(args: string[], ctx: Ctx, out: (v: unknown, rawText: string) => void, execGit: GitRunner | undefined): void {
  const run = runMetrics(args, ctx, execGit, args.includes('--compare-last'));
  out(run.summary, run.text);
}

function handleStage(args: string[], ctx: Ctx, out: (v: unknown, rawText: string) => void, execGit: GitRunner | undefined): void {
  // A loop-point command step: the configured scope and window, never the user's flags.
  const date = requireDate(flagValue(args, 'date'), USAGE.stage) ?? ctx.today;
  const run = runMetrics(['arch', 'stage', '--date', date], ctx, execGit, true);
  const slash = formatGsdSlashFor(ctx.cwd, 'arch-survey');
  const answer = archMetrics.milestoneStageAnswer(
    run.milestone as archMetrics.MilestoneDecision,
    run.metrics.zones,
    typeof slash === 'string' ? slash : undefined,
  );
  // `--raw` is how a loop point runs a command step, and the host reads the stage answer from
  // JSON (loop-hook-dispatch.md), so the raw form of `stage` is the JSON itself.
  const result = { ...run.summary, ...answer };
  out(result, `${JSON.stringify(result, null, 2)}\n`);
}

function runMetrics(args: string[], ctx: Ctx, execGit: GitRunner | undefined, compareLast: boolean): MetricsRun {
  const pathsArg = flagValue(args, 'paths');
  const sinceArg = flagValue(args, 'since');
  const topArg = flagValue(args, 'top');
  if (pathsArg === undefined || sinceArg === undefined || topArg === undefined) throw new UsageError(USAGE.metrics);
  const date = requireDate(flagValue(args, 'date'), USAGE.metrics) ?? ctx.today;
  const { config, problems } = readConfig(ctx.cwd);
  if (sinceArg !== null) {
    if (parseWindow(sinceArg) === null) throw new UsageError(`--since must be 90d, 12w, 6m, 1y, an ISO date or a ref, got ${JSON.stringify(sinceArg)}`);
    config.window = sinceArg;
  }
  if (topArg !== null) {
    if (!/^[1-9]\d*$/.test(topArg) || Number(topArg) > archMetrics.MAX_TOP_ZONES) {
      throw new UsageError(`--top must be an integer from 1 to ${archMetrics.MAX_TOP_ZONES}, got ${JSON.stringify(topArg)}`);
    }
    config.topZones = Number(topArg);
  }
  let paths: string[] = [];
  if (pathsArg !== null) {
    for (const p of pathsArg.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
      const abs = tryWithinRoot(p, ctx.cwd, PathAcceptance.AbsoluteInsideRoot);
      if (abs === null) throw new UsageError(`--paths ${JSON.stringify(p)} is outside the project`);
      paths.push(path.relative(ctx.root, abs).split(path.sep).join('/') || '.');
    }
    if (paths.length === 0) throw new UsageError(USAGE.metrics);
  } else if (ctx.projectRel !== '') {
    paths = [ctx.projectRel];
  }
  if (paths.includes('.')) paths = [];

  const metrics = archMetrics.computeMetrics(ctx.root, {
    date,
    config,
    ...(paths.length > 0 ? { paths } : {}),
    ...(execGit !== undefined ? { history: { execGit } } : {}),
  });
  let comparison: archMetrics.Comparison | undefined;
  let milestone: archMetrics.MilestoneDecision | undefined;
  if (compareLast) {
    const baseline = archMetrics.findBaseline(ctx.archDir, metrics);
    comparison = archMetrics.compareMetrics(baseline?.metrics ?? null, metrics, config.growthThreshold);
    milestone = archMetrics.milestoneDecision(comparison, config.atMilestone);
  }
  const file = path.join(ctx.archDir, archMetrics.metricsFileName(date));
  platformWriteSync(file, `${JSON.stringify({ ...metrics, ...(comparison !== undefined ? { comparison } : {}) }, null, 2)}\n`);

  const summary = {
    path: relToCwd(ctx, file),
    date,
    status: metrics.status,
    reasons: metrics.reasons,
    configProblems: problems,
    scope: metrics.scope,
    history: metrics.history,
    graph: metrics.graph,
    hotspotBasis: metrics.hotspotBasis,
    hotspots: metrics.hotspots.slice(0, 10),
    cycles: metrics.cycles.length,
    coChange: metrics.coChange.length,
    passThrough: metrics.passThrough.length,
    smallModules: metrics.smallModules.length,
    zones: metrics.zones,
    ...(comparison !== undefined ? { comparison, milestone } : {}),
  };
  const text = [
    `arch metrics ${date}: ${metrics.status}${metrics.reasons.length > 0 ? ` (${metrics.reasons.join(', ')})` : ''} → ${summary.path}`,
    ...metrics.zones.map((z) => `${z.id} ${z.label} seed=${z.seed} files=${z.files.length} score=${z.score}`),
    ...(milestone !== undefined ? [`milestone: ${milestone.action} (${milestone.reason})${milestone.zones.length > 0 ? ` zones=${milestone.zones.join(',')}` : ''}`] : []),
  ].join('\n');
  return { summary, text: `${text}\n`, metrics, milestone };
}

function handleCards(args: string[], ctx: Ctx, out: (v: unknown, rawText: string) => void): void {
  const metrics = loadMetrics(ctx, requireDate(flagValue(args, 'date'), USAGE.cards));
  const dir = surveyDir(ctx, metrics.date);
  const decisions = archSurvey.parseDecisions(readTextOrNull(path.join(ctx.archDir, 'DECISIONS.md'))).entries;
  const set = archSurvey.collectCandidates({
    root: ctx.root,
    date: metrics.date,
    zones: metrics.zones,
    sources: archSurvey.readCardSources(dir),
    decisions,
  });
  const candidatesFile = path.join(dir, 'candidates.json');
  const refuterFile = path.join(dir, 'refuter-input.md');
  platformWriteSync(candidatesFile, `${JSON.stringify(set, null, 2)}\n`);
  platformWriteSync(refuterFile, archSurvey.renderRefuterInput(set));
  const result = {
    date: metrics.date,
    candidatesPath: relToCwd(ctx, candidatesFile),
    refuterInputPath: relToCwd(ctx, refuterFile),
    candidates: set.candidates.map((c, i) => ({ n: i + 1, id: c.id, title: c.title, strength: c.strength, kind: c.kind, zone: c.zone, demoted: c.demoted })),
    zones: set.zones,
    invalid: set.invalid,
    failedCheck: set.failedCheck,
    excludedByDecision: set.excludedByDecision,
  };
  out(result, `arch cards ${metrics.date}: ${set.candidates.length} candidate(s), ${set.invalid.length} malformed, ${set.failedCheck.length} failed check, ${set.excludedByDecision.length} excluded\n`);
}

function handleReport(args: string[], ctx: Ctx, out: (v: unknown, rawText: string) => void): void {
  const refArg = flagValue(args, 'refutation');
  if (refArg === undefined) throw new UsageError(USAGE.report);
  const metrics = loadMetrics(ctx, requireDate(flagValue(args, 'date'), USAGE.report));
  const set = loadCandidates(ctx, metrics.date);
  let refutationFile = path.join(surveyDir(ctx, metrics.date), 'refutation.md');
  if (refArg !== null) {
    const abs = tryWithinRoot(refArg, ctx.cwd, PathAcceptance.AbsoluteInsideRoot);
    if (abs === null) throw new UsageError(`--refutation ${JSON.stringify(refArg)} is outside the project`);
    refutationFile = abs;
  }
  const refutation = readTextOrNull(refutationFile);
  if (refArg !== null && refutation === null) throw new InputError(`cannot read --refutation ${JSON.stringify(refArg)}`);
  const verification = archSurvey.verifyCandidates(set, refutation);
  const doc = archSurvey.buildSurvey({ metrics, set, verification });
  const file = path.join(ctx.archDir, `SURVEY-${metrics.date}.md`);
  platformWriteSync(file, archSurvey.renderSurvey(doc));
  const result = {
    path: relToCwd(ctx, file),
    date: metrics.date,
    verdict: doc.verdict,
    refutation: refutation === null ? null : relToCwd(ctx, refutationFile),
    top: doc.top,
    candidates: set.candidates.map((c, i) => ({
      n: i + 1, id: c.id, title: c.title, strength: c.strength, kind: c.kind, zone: c.zone, verification: verification[i].verdict,
    })),
    adrDirectory: fs.existsSync(path.join(ctx.cwd, ADR_DIRECTORY)),
  };
  out(result, `arch report ${metrics.date}: ${doc.verdict}, top=${doc.top ?? 'none'} → ${result.path}\n`);
}

function handleDecide(args: string[], ctx: Ctx, out: (v: unknown, rawText: string) => void): void {
  const id = flagValue(args, 'id');
  const disposition = flagValue(args, 'disposition');
  const reason = flagValue(args, 'reason');
  const route = flagValue(args, 'route');
  if (typeof id !== 'string' || typeof disposition !== 'string' || reason === undefined || route === undefined) throw new UsageError(USAGE.decide);
  if (!/^arch-[0-9a-f]{12}$/.test(id)) throw new UsageError(`--id must look like arch-<12 hex>, got ${JSON.stringify(id)}`);
  if (!(archSurvey.DISPOSITIONS as readonly string[]).includes(disposition)) {
    throw new UsageError(`--disposition must be one of ${archSurvey.DISPOSITIONS.join(', ')}, got ${JSON.stringify(disposition)}`);
  }
  if (disposition === 'rejected' && (reason === null || reason.trim() === '')) {
    throw new UsageError('a rejection needs --reason: the next survey excludes this candidate because of it');
  }
  const dateArg = requireDate(flagValue(args, 'date'), USAGE.decide);
  const journalFile = path.join(ctx.archDir, 'DECISIONS.md');
  const journal = readTextOrNull(journalFile);
  const prior = archSurvey.parseDecisions(journal).entries.find((e) => e.id === id) ?? null;

  let surveyDate: string | null = null;
  let candidate: { title: string; kind: string; files: string[] } | null = null;
  const surveyMetrics = dateArg !== null ? dateArg : archMetrics.listMetricsFiles(ctx.archDir)[0]?.date ?? null;
  if (surveyMetrics !== null) {
    const text = readTextOrNull(path.join(surveyDir(ctx, surveyMetrics), 'candidates.json'));
    const found = text === null ? undefined : (JSON.parse(text) as CandidateSet).candidates.find((c) => c.id === id);
    if (found !== undefined) {
      candidate = { title: found.title, kind: found.kind, files: found.files };
      surveyDate = surveyMetrics;
    }
  }
  if (candidate === null && prior !== null) {
    candidate = { title: prior.title, kind: prior.kind, files: prior.files };
    surveyDate = prior.survey;
  }
  if (candidate === null) {
    throw new InputError(`${id} is neither a candidate of the survey${surveyMetrics !== null ? ` of ${surveyMetrics}` : ''} nor in DECISIONS.md`);
  }
  const entry = {
    id,
    disposition: disposition as Disposition,
    ...candidate,
    date: ctx.today,
    survey: surveyDate,
    reason: reason !== null && reason.trim() !== '' ? reason : null,
    route: route !== null && route.trim() !== '' ? route : null,
  };
  platformWriteSync(journalFile, archSurvey.upsertDecision(journal, entry));
  const result = {
    id,
    disposition,
    path: relToCwd(ctx, journalFile),
    replaced: prior?.disposition ?? null,
    adrSuggested: disposition === 'rejected' && fs.existsSync(path.join(ctx.cwd, ADR_DIRECTORY)),
  };
  out(result, `arch decide: ${id} ${disposition}${prior !== null ? ` (was ${prior.disposition})` : ''}\n`);
}

function handleStatus(ctx: Ctx, out: (v: unknown, rawText: string) => void): void {
  const runs = archMetrics.listMetricsFiles(ctx.archDir);
  let surveys: string[] = [];
  try {
    surveys = fs.readdirSync(ctx.archDir)
      .map((n) => /^SURVEY-(\d{4}-\d{2}-\d{2})\.md$/.exec(n)?.[1])
      .filter((d): d is string => d !== undefined)
      .sort()
      .reverse();
  } catch { /* no architecture directory yet */ }
  const { entries, unparsed } = archSurvey.parseDecisions(readTextOrNull(path.join(ctx.archDir, 'DECISIONS.md')));
  const counts: Record<Disposition, number> = { accepted: 0, rejected: 0, deferred: 0 };
  for (const e of entries) counts[e.disposition]++;
  const { config, problems } = readConfig(ctx.cwd);
  const latest = runs[0] !== undefined ? archMetrics.readMetricsFile(runs[0].file) : null;
  const result = {
    architectureDir: relToCwd(ctx, ctx.archDir),
    metrics: { runs: runs.length, latest: runs[0]?.date ?? null, zones: latest?.zones.length ?? null, status: latest?.status ?? null },
    survey: { reports: surveys.length, latest: surveys[0] ?? null },
    decisions: { ...counts, unparsed },
    config,
    configProblems: problems,
  };
  out(result, `arch status: ${runs.length} metrics run(s), latest ${result.metrics.latest ?? 'none'}; ${surveys.length} survey(s); decisions ${counts.accepted}/${counts.rejected}/${counts.deferred} (accepted/rejected/deferred)\n`);
}

// ─── Router ──────────────────────────────────────────────────────────────────

function routeArchCommand({ args, cwd, raw, error, _output, _clock, _execGit }: RouteArchCommandOptions): void {
  const emit: OutputFn = _output ?? output;
  const out = (value: unknown, rawText: string): void => emit(value, raw, rawText);
  const run = (fn: (ctx: Ctx) => void): (() => void) => () => {
    try {
      fn(makeCtx(cwd, _clock ?? realClock));
    } catch (e) {
      if (e instanceof UsageError) error(e.message, ERROR_REASON.USAGE);
      else if (e instanceof InputError) error(e.message, ERROR_REASON.ARCH_INPUT_UNAVAILABLE);
      else throw e;
    }
  };
  routeHubCommandFamily({
    family: 'arch',
    args,
    subcommands: [...ARCH_SUBCOMMANDS],
    handlers: {
      metrics: run((ctx) => handleMetrics(args, ctx, out, _execGit)),
      cards: run((ctx) => handleCards(args, ctx, out)),
      report: run((ctx) => handleReport(args, ctx, out)),
      decide: run((ctx) => handleDecide(args, ctx, out)),
      stage: run((ctx) => handleStage(args, ctx, out, _execGit)),
      status: run((ctx) => handleStatus(ctx, out)),
    },
    unknownMessage: (_subcommand: string, available: string[]) =>
      `Unknown arch subcommand. Available: ${available.join(', ')}`,
    error,
    cwd,
    raw,
  });
}

export { routeArchCommand };
