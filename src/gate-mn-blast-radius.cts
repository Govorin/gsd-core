/**
 * `gsd_run check mn-blast-radius` — compares what a phase CHANGED against what it DECLARED
 * (mn-verify-gate; replaces capabilities/mn-verify-gate/scripts/blast-radius.mjs).
 *
 * ── Why divergence, not an absolute number ──────────────────────────────
 *
 * An absolute file count carries no information about correctness: a foundation phase legitimately
 * touches 180 files, a ports phase 40, and no single threshold separates a healthy large phase from
 * an agent that wandered off. A threshold that fires falsely teaches people to ignore blocks.
 *
 * Divergence does carry information. `files_modified` in a PLAN.md is the planner's declaration of
 * intent, made BEFORE the work and checked by the plan-checker. A file changed but declared by no
 * plan of the phase means either the executor left the task's boundary, or the plan was incomplete
 * and nobody noticed. Both need a human, and neither is visible to tests, lint or types — an
 * undeclared edit compiles exactly like a declared one.
 *
 * Hence the contract: divergence BLOCKS, volume only REPORTS. `--max-files` / `--max-lines` (by hand
 * only — the gate dispatch passes no flags) are reported as `overBudget` and block only with
 * `--strict-budget`.
 *
 * Asymmetry: a file declared but not changed is NOT a finding (`undelivered`, reported). The
 * executor may legitimately discover an edit is unnecessary.
 *
 * ── Which commits are the phase: the evaluation-scope resolver ──────────
 *
 * The phase's commits come from the one resolver every gate shares (`resolveEvaluationScope`,
 * src/gate-evaluation-scope.cts; ADR-5057 §4, #5164): the commits its SUMMARYs list under
 * `## Task Commits`, reachable from HEAD. That answers the same question the script answered with a
 * path anchor plus subject-scope siblings (`git log --all`), without guessing from commit subjects —
 * so another project's interleaved commit in a monorepo never enters the radius (the resolver names
 * it in `outsideUnion` instead), and neither does a commit on another branch.
 *
 * When the phase lists no task commits yet, the resolver falls back to the phase window (from the
 * commit that first added the phase directory to HEAD) and says so: `scopeStatus: 'degraded'`. The
 * gate still judges that wider evidence, and the payload carries the status, its reason and its
 * source, so a reader can tell a clean scope from a wide one. When the phase directory has never been
 * committed, the radius is the working tree. `--base <ref>` (by hand) evaluates only what came after
 * `<ref>` (the resolver's `since`) plus the uncommitted tree — the "phase in progress" question.
 *
 * Uncommitted work joins the radius only in those last two modes: for a committed phase a dirty tree
 * belongs to someone else — measured, it put the same 5-7 "undeclared" files into all nine phases of
 * one project at once.
 *
 * ── The rest ─────────────────────────────────────────────────────────────
 *
 * - The scope is resolved from the git ROOT, and paths compare from it: the gate runs from a project
 *   inside a monorepo, and `files_modified` are written from the repository root.
 * - No plans, or plans that declare nothing, is "could not check" — not a pass: an empty declaration
 *   compared against anything reads green while nothing was compared.
 * - Planning artifacts (`.planning/**`, at any depth) and lockfiles are excluded — GSD writes the
 *   first, the resolver excludes both from every scope, and no plan declares them.
 * - Not a git repository, a scope the resolver cannot read, an unresolvable `--base`, or a git
 *   command that fails: "could not check".
 *
 * `files_modified` is read through the shared frontmatter parser (block list, inline list, blank
 * lines inside the block, inline comments), the plan files through plan-scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { resolveEvaluationScope, SCOPE_EXCLUSION_PATHSPECS } from './gate-evaluation-scope.cjs';
import type { EvaluationScope, GitRunner } from './gate-evaluation-scope.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;

/** The git seam — the resolver's own runner type, so its exit-code reading (1 = "no") holds. */
export type RunGit = GitRunner;

/** A git command whose failure means the gate could not look. */
class GitFailure extends Error {}

export interface BlastRadiusOptions {
  base?: string;
  maxFiles: number;
  maxLines: number;
  strictBudget: boolean;
}

export interface ChangeStat {
  added: number;
  deleted: number;
}

/**
 * The resolver's reason suffix for a phase directory no commit ever added: there is no phase window,
 * because the phase has committed nothing — its radius is the working tree.
 */
const NO_PHASE_START_ANCHOR = ':no-phase-start-anchor';

/** `files_modified` (or `files-modified`) of one plan, as declared strings. */
function declaredFilesOf(text: string): string[] {
  const fm = extractFrontmatter(text) as Record<string, unknown>;
  const raw = fm['files_modified'] ?? fm['files-modified'];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (typeof raw === 'string' && raw.trim() !== '') return [raw.trim()];
  return [];
}

function normalizeDeclared(entry: string): string {
  return entry.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Parse `git --numstat` lines into `into` (path → stat), keeping a rename's TARGET path. */
export function foldNumstat(text: string, into: Map<string, ChangeStat>): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let file = m[3];
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(file);
    if (brace) file = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/');
    else if (file.includes(' => ')) file = file.split(' => ')[1];
    const added = m[1] === '-' ? 0 : Number(m[1]);
    const deleted = m[2] === '-' ? 0 : Number(m[2]);
    const prev = into.get(file) ?? { added: 0, deleted: 0 };
    into.set(file, { added: prev.added + added, deleted: prev.deleted + deleted });
  }
}

const isPlanningArtifact = (p: string): boolean => p.includes('/.planning/') || p.startsWith('.planning/');

/** Line counts for the resolved scope: per task commit, or over the degraded phase window. */
function scopeNumstat(scope: EvaluationScope, git: (args: string[]) => string): Map<string, ChangeStat> {
  const stats = new Map<string, ChangeStat>();
  if (scope.source === 'task-commits') {
    for (const commit of scope.commits) {
      foldNumstat(git(['-c', 'core.quotepath=off', 'show', '--first-parent', '--pretty=format:', '--numstat', commit.sha, '--', '.', ...SCOPE_EXCLUSION_PATHSPECS]), stats);
    }
  } else if (scope.source === 'phase-range' && scope.rangeBase !== null) {
    foldNumstat(git(['-c', 'core.quotepath=off', 'diff', '--numstat', scope.rangeBase, 'HEAD', '--', '.', ...SCOPE_EXCLUSION_PATHSPECS]), stats);
  }
  return stats;
}

/** The gate's body against a resolved phase directory, with git injected. */
export function computeBlastRadius(projectDir: string, phaseDir: string, options: BlastRadiusOptions, runGit: RunGit = execGitSeam): GateResult {
  const top = runGit(['rev-parse', '--show-toplevel'], { cwd: projectDir });
  if (top.exitCode !== 0 || top.timedOut) {
    return mnUnresolvable('mn-blast-radius: not a git repository — blast radius is undefined without history', { phaseDir });
  }
  const repoRoot = top.stdout.trim();
  const git = (args: string[]): string => {
    const r = runGit(args, { cwd: repoRoot });
    if (r.exitCode !== 0 || r.timedOut) throw new GitFailure(`git ${args[0] === '-c' ? args[2] : args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };

  // git prints the realpath of the root; compare against the realpath of the phase.
  const realPhaseDir = fs.realpathSync(phaseDir);
  const phaseRel = path.relative(fs.realpathSync(repoRoot), realPhaseDir).split(path.sep).join('/');

  const scan = scanPhasePlans(phaseDir);
  const planFiles = [...scan.allPlanFiles].sort();
  if (planFiles.length === 0) {
    return mnUnresolvable(`mn-blast-radius: no PLAN.md in ${phaseRel} — the phase declared nothing to compare against`, { phaseDir, plans: 0 });
  }

  const declared = new Map<string, string[]>();
  for (const plan of planFiles) {
    for (const entry of declaredFilesOf(fs.readFileSync(path.join(phaseDir, plan), 'utf8'))) {
      const norm = normalizeDeclared(entry);
      const owners = declared.get(norm) ?? [];
      owners.push(plan);
      declared.set(norm, owners);
    }
  }
  if (declared.size === 0) {
    return mnUnresolvable(
      `mn-blast-radius: ${planFiles.length} PLAN.md file(s) in ${phaseRel}, none carrying files_modified — ` +
        'refusing to report "no drift" against an empty declaration',
      { phaseDir, plans: planFiles.length, declared: 0 },
    );
  }

  // Resolved from the git root: the scope's paths, like `files_modified`, are repository-relative.
  const scope = resolveEvaluationScope(
    repoRoot,
    { kind: 'phase', phase: path.basename(phaseDir), phaseDir: realPhaseDir },
    { execGit: runGit, includeFiles: true, ...(options.base !== undefined ? { since: options.base } : {}) },
  );
  const neverCommitted =
    scope.status === 'unresolvable' && options.base === undefined && (scope.reason ?? '').endsWith(NO_PHASE_START_ANCHOR);
  if (scope.status === 'unresolvable' && !neverCommitted) {
    return mnUnresolvable(`mn-blast-radius: the phase's commits could not be resolved (${scope.reason ?? 'unknown'})`, {
      phaseDir,
      scopeStatus: scope.status,
      scopeReason: scope.reason,
    });
  }

  const includeDirty = options.base !== undefined || neverCommitted;
  const changed = new Map<string, ChangeStat>();
  try {
    if (!neverCommitted) {
      const stats = scopeNumstat(scope, git);
      for (const file of scope.changedFiles) changed.set(file, stats.get(file) ?? { added: 0, deleted: 0 });
    }
    if (includeDirty) {
      // An empty tree or no HEAD yet simply has no uncommitted edits.
      const dirty = runGit(['diff', '--numstat', 'HEAD'], { cwd: repoRoot });
      if (dirty.exitCode === 0) foldNumstat(dirty.stdout, changed);
    }
  } catch (err) {
    if (err instanceof GitFailure) return mnUnresolvable(`mn-blast-radius: ${err.message}`, { phaseDir });
    throw err;
  }

  const undeclared: Array<{ path: string } & ChangeStat> = [];
  let matched = 0;
  let changedLines = 0;
  for (const [file, stat] of changed) {
    if (isPlanningArtifact(file)) continue;
    changedLines += stat.added + stat.deleted;
    if (declared.has(file)) matched++;
    else undeclared.push({ path: file, ...stat });
  }
  undeclared.sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
  const undelivered = [...declared.keys()].filter((p) => !changed.has(p));
  const changedFiles = matched + undeclared.length;
  const overBudget = {
    files: options.maxFiles > 0 && changedFiles > options.maxFiles,
    lines: options.maxLines > 0 && changedLines > options.maxLines,
  };

  const details = {
    phaseDir,
    phaseRel,
    scopeStatus: neverCommitted ? 'working-tree' : scope.status,
    scopeSource: neverCommitted ? 'working-tree' : scope.source,
    scopeReason: scope.reason,
    commits: neverCommitted ? 0 : scope.commits.length,
    outsideUnion: neverCommitted ? [] : scope.outsideUnion,
    unreachable: neverCommitted ? [] : scope.unreachable,
    workingTreeIncluded: includeDirty,
    plans: planFiles.length,
    declared: declared.size,
    changedFiles,
    changedLines,
    matched,
    undeclared,
    undelivered,
    overBudget,
  };

  const widened = !neverCommitted && scope.status === 'degraded' ? ` (scope degraded: ${scope.reason ?? 'unknown'})` : '';
  if (undeclared.length > 0) {
    return mnFinding(
      `mn-blast-radius: ${undeclared.length} file(s) changed that no plan in this phase declared${widened} ` +
        `(${undeclared.slice(0, 10).map((u) => u.path).join(', ')}${undeclared.length > 10 ? ', …' : ''}) — ` +
        'either the executor went outside the task, or the plan was incomplete. Add the paths to the owning ' +
        'PLAN.md files_modified, or revert the stray change.',
      details,
    );
  }
  if (options.strictBudget && (overBudget.files || overBudget.lines)) {
    return mnFinding(`mn-blast-radius: over budget with --strict-budget (${changedFiles} files, ${changedLines} lines)${widened}`, details);
  }
  return mnPass(`mn-blast-radius: OK — every changed file (${changedFiles}) was declared by a plan in this phase${widened}`, details);
}

const BOOLEAN_FLAGS = new Set(['--strict-budget', '--json']);

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  const v = i === -1 ? undefined : args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

/**
 * `gsd_run check mn-blast-radius <phase> [--base <ref>] [--max-files N] [--max-lines N] [--strict-budget]`
 * (the flags are for a person; the gate dispatch passes only the phase).
 */
export function evaluateMnBlastRadius(input: MnGateInput, runGit: RunGit = execGitSeam): GateResult {
  const options: BlastRadiusOptions = {
    base: flagValue(input.args, '--base'),
    maxFiles: Number(flagValue(input.args, '--max-files') ?? '0') || 0,
    maxLines: Number(flagValue(input.args, '--max-lines') ?? '0') || 0,
    strictBudget: input.args.includes('--strict-budget'),
  };
  // A bare boolean flag is removed before the phase is parsed: `--strict-budget 3` must not read `3` as its value.
  const args = input.args.filter((a) => !BOOLEAN_FLAGS.has(a));
  return withMnPhase('mn-blast-radius', { projectDir: input.projectDir, args }, ({ phaseDir }) =>
    computeBlastRadius(input.projectDir, phaseDir, options, runGit),
  );
}
