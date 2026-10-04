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
 * ── Which commits are the phase ─────────────────────────────────────────
 *
 * `git merge-base` is useless on a single autonomous branch; GSD sets no phase tags; a bare
 * conventional-commit scope (`feat(03-xx):`) collides across projects in one monorepo (`03` was
 * both rpg and savor). What works is the PATH ANCHOR: commits that touched the phase directory.
 *
 * But the range between the first and last anchored commit is ALSO wrong — measured: 27 commits
 * between phase 03's ends, 3 of them rpg's, giving 95 "undeclared" files that had nothing to do with
 * rpg. So the radius is the UNION OF THE DIFFS of the selected commits (`git show --numstat`), and
 * interleaved work of other projects never enters the sample.
 *
 * Selection has a mandatory second step: the GSD executor commits code and planning docs
 * SEPARATELY (`feat(rpg-02-09):` touches libs/, `docs(rpg-02-09):` touches .planning/), so the path
 * anchor alone sees only the docs — measured as `changed=0` against 73 declared files, a false green
 * that looks like evidence. Commits carrying a QUALIFIED scope READ from the anchored commits (never
 * guessed; a purely numeric scope is ambiguous and dropped) are added.
 *
 * Resolution order: `--base <ref>` (range mode, for a phase in progress) → path-anchored selection →
 * working tree (the phase has committed nothing yet). Uncommitted work joins the radius only in the
 * first and last mode: for a committed phase a dirty tree belongs to someone else — measured, it put
 * the same 5-7 "undeclared" files into all nine phases of one project at once.
 *
 * ── The rest ─────────────────────────────────────────────────────────────
 *
 * - Paths are compared from the git ROOT (the gate runs from a project inside a monorepo, and
 *   `files_modified` are written from the repository root).
 * - No plans, or plans that declare nothing, is "could not check" — not a pass: an empty declaration
 *   compared against anything reads green while nothing was compared.
 * - Planning artifacts (`.planning/**`) are excluded: GSD writes them and no plan declares them.
 * - Not a git repository, an unresolvable `--base`, or a git command that fails: "could not check".
 *
 * `files_modified` is read through the shared frontmatter parser (block list, inline list, blank
 * lines inside the block, inline comments), the plan files through plan-scan.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
import planScanMod = require('./plan-scan.cjs');
const { scanPhasePlans } = planScanMod;

/** One git invocation's result: `ok` is a zero exit with no spawn error. */
export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** The git seam: argv (never a shell string) run in `cwd`. Injected so tests need no repository. */
export type RunGit = (args: readonly string[], cwd: string) => GitRun;

/** History listings (`log --all`, `show --numstat`) on a large monorepo exceed the 1 MiB default. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/** Production git: array argv, bounded in time and output, no terminal prompts. */
export const productionRunGit: RunGit = (args, cwd) => {
  const r = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return { ok: !r.error && r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** A git command whose failure means the gate could not look. */
class GitFailure extends Error {}

export interface BlastRadiusOptions {
  base?: string;
  maxFiles: number;
  maxLines: number;
  strictBudget: boolean;
}

interface ChangeStat {
  added: number;
  deleted: number;
}

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

const SCOPE_RE = /^[a-z]+\(([^)]+)\)/i;

/** Parse `git --numstat` lines into path → stat, keeping a rename's TARGET path. */
function accumulateNumstat(text: string, into: Map<string, ChangeStat>): void {
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

interface Radius {
  blocks: string[];
  how: string;
  /** null in range mode (`--base`): the range is not a commit selection. */
  commits: string[] | null;
}

function collectRadius(git: (args: readonly string[]) => string, phaseRel: string, base: string | undefined, tryGit: (args: readonly string[]) => GitRun): Radius {
  if (base !== undefined) {
    const resolved = tryGit(['rev-parse', '--verify', `${base}^{commit}`]);
    if (!resolved.ok) throw new GitFailure(`--base ${base} is not a resolvable commit`);
    const sha = resolved.stdout.trim();
    return {
      blocks: [git(['diff', '--numstat', sha, 'HEAD'])],
      how: `--base ${base} (range mode; interleaved commits from other projects are NOT filtered out)`,
      commits: null,
    };
  }

  const anchored = tryGit(['log', '--format=%H', '--all', '--', phaseRel]);
  const commits = anchored.ok ? anchored.stdout.split('\n').filter(Boolean) : [];
  if (commits.length === 0) return { blocks: [], how: 'working tree only — phase dir has no commits yet', commits: [] };

  const scopes = new Set<string>();
  for (const c of commits) {
    const m = SCOPE_RE.exec(git(['log', '-1', '--format=%s', c]).trim());
    // A qualified scope carries a letter (`rpg-02-09`); a numeric one (`03`, `3.4.12`) is ambiguous.
    if (m && /[a-z]/i.test(m[1])) scopes.add(m[1]);
  }

  const selected = new Set(commits);
  if (scopes.size > 0) {
    for (const line of git(['log', '--format=%H\t%s', '--all']).split('\n')) {
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const m = SCOPE_RE.exec(line.slice(tab + 1));
      if (m && scopes.has(m[1])) selected.add(line.slice(0, tab));
    }
  }

  // `-m --first-parent` unfolds a merge against its first parent: without it a merge yields an
  // empty numstat and its work is lost.
  const list = [...selected];
  return {
    blocks: list.map((c) => git(['show', '--format=', '--numstat', '-m', '--first-parent', c])),
    how:
      `path-anchored on ${phaseRel} (${commits.length} commit(s)) + ` +
      `${list.length - commits.length} scope-sibling(s) [${[...scopes].join(', ') || 'none'}]`,
    commits: list,
  };
}

const isPlanningArtifact = (p: string): boolean => p.includes('/.planning/') || p.startsWith('.planning/');

/** The gate's body against a resolved phase directory, with git injected. */
export function computeBlastRadius(projectDir: string, phaseDir: string, options: BlastRadiusOptions, runGit: RunGit): GateResult {
  const top = runGit(['rev-parse', '--show-toplevel'], projectDir);
  if (!top.ok) return mnUnresolvable('mn-blast-radius: not a git repository — blast radius is undefined without history', { phaseDir });
  const repoRoot = top.stdout.trim();
  const tryGit = (args: readonly string[]): GitRun => runGit(args, repoRoot);
  const git = (args: readonly string[]): string => {
    const r = tryGit(args);
    if (!r.ok) throw new GitFailure(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout;
  };

  // git prints the realpath of the root; compare against the realpath of the phase.
  const phaseRel = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(phaseDir)).split(path.sep).join('/');

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

  let radius: Radius;
  try {
    radius = collectRadius(git, phaseRel, options.base, tryGit);
  } catch (err) {
    if (err instanceof GitFailure) return mnUnresolvable(`mn-blast-radius: ${err.message}`, { phaseDir });
    throw err;
  }

  const includeDirty = options.base !== undefined || (radius.commits !== null && radius.commits.length === 0);
  const changed = new Map<string, ChangeStat>();
  for (const block of radius.blocks) accumulateNumstat(block, changed);
  if (includeDirty) {
    // An empty tree or no HEAD yet simply has no uncommitted edits.
    const dirty = tryGit(['diff', '--numstat', 'HEAD']);
    if (dirty.ok) accumulateNumstat(dirty.stdout, changed);
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
    baseStrategy: radius.how,
    commits: radius.commits === null ? null : radius.commits.length,
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

  if (undeclared.length > 0) {
    return mnFinding(
      `mn-blast-radius: ${undeclared.length} file(s) changed that no plan in this phase declared ` +
        `(${undeclared.slice(0, 10).map((u) => u.path).join(', ')}${undeclared.length > 10 ? ', …' : ''}) — ` +
        'either the executor went outside the task, or the plan was incomplete. Add the paths to the owning ' +
        'PLAN.md files_modified, or revert the stray change.',
      details,
    );
  }
  if (options.strictBudget && (overBudget.files || overBudget.lines)) {
    return mnFinding(`mn-blast-radius: over budget with --strict-budget (${changedFiles} files, ${changedLines} lines)`, details);
  }
  return mnPass(`mn-blast-radius: OK — every changed file (${changedFiles}) was declared by a plan in this phase`, details);
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
export function evaluateMnBlastRadius(input: MnGateInput, runGit: RunGit = productionRunGit): GateResult {
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
