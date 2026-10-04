/**
 * mn assertion count — the one counter behind the assertion ratchet (mn-verify-gate): the gate
 * `gsd_run check mn-assertion-ratchet` reads it, and the baseline tool `gsd_run mn
 * assertion-baseline [--update]` writes it. Replaces the counting half of
 * capabilities/mn-verify-gate/scripts/assertion-ratchet.mjs.
 *
 * ── What it catches ──────────────────────────────────────────────────────
 *
 * A test that stops failing because its assertion was removed. Deleting an assert makes the suite
 * greener and no green run reports it; coverage stays silent too — the line still executes, its
 * result is simply no longer checked. The invariant: the number of assertions does not drop, and
 * the number of skipped tests does not grow, unless the drop is declared (re-recorded).
 *
 * What counts: `expect(`, `assert(`, `assert.`, `.toThrow`, `should.`; skip markers separately
 * (`it.skip` neither fails nor checks — the quiet equivalent of deletion).
 *
 * The count is static, over sources: `vitest list` must resolve the whole workspace and costs
 * minutes on a hundred-project monorepo; a tree walk gives the same answer in seconds. The price —
 * commented-out assertions count too — is acceptable for a ratchet comparing a number with itself.
 * The walk is done in-process, not by ripgrep: `rg` is sometimes a shell function a child process
 * cannot see, and a gate failing for a missing tool reads exactly like a gate that caught a defect.
 *
 * ── Where ────────────────────────────────────────────────────────────────
 *
 * The spec roots (`libs`, `apps` by default) are anchored at the git top-level, not at the project
 * directory: GSD may run from a sub-project (apps/rpg) while the monorepo's code sits above it, and
 * a walk from there finds zero specs. The baseline itself lives in the PROJECT's planning
 * directory, `<project>/.planning/assertion-baseline.json` — the script resolved it against the
 * repository root, which pointed a sub-project at a `.planning/` that need not exist.
 *
 * Zero spec files is a refusal, never a measurement: it is almost always a missed walk (wrong root,
 * renamed folder), and recording it as a baseline would zero the ratchet forever.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';

/** The baseline file, relative to the project directory. */
export const ASSERTION_BASELINE_RELATIVE_PATH = path.join('.planning', 'assertion-baseline.json');

/** The spec roots walked when none are given, relative to the repository root. */
export const DEFAULT_ASSERTION_ROOTS: readonly string[] = Object.freeze(['libs', 'apps']);

const ASSERTIONS = /expect\(|\bassert\(|\bassert\.|\.toThrow|\bshould\./g;
const SKIPS = /\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(/g;
const SPEC = /\.(spec|test)\.tsx?$/;
const PRUNE = new Set(['node_modules', 'dist', 'build', '.git', '.nx', 'coverage', '.venv', '__pycache__']);

/** What one walk measured. */
export interface AssertionCount {
  assertions: number;
  skipped: number;
  files: number;
}

/** A recorded baseline: a count plus when it was recorded. */
export interface AssertionBaseline extends AssertionCount {
  updated?: string;
}

/** A measurement and where it was taken. */
export interface AssertionMeasurement {
  repoRoot: string;
  roots: string[];
  count: AssertionCount;
}

/** Injected for tests: how the repository root is found. */
export interface AssertionCountDeps {
  /** The git top-level of `cwd`, or null when `cwd` is not inside a work tree. */
  gitTopLevel: (cwd: string) => string | null;
}

function defaultGitTopLevel(cwd: string): string | null {
  const r = execGit(['rev-parse', '--show-toplevel'], { cwd });
  if (r.exitCode !== 0 || r.error) return null;
  const top = r.stdout.trim();
  return top === '' ? null : top;
}

/** `<project>/.planning/assertion-baseline.json` — the one baseline path the gate and the tool share. */
export function assertionBaselinePath(projectDir: string): string {
  return path.join(projectDir, ASSERTION_BASELINE_RELATIVE_PATH);
}

function* specFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A missing root is not an error: not every repository carries apps/.
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) yield* specFiles(p);
    } else if (SPEC.test(e.name)) {
      yield p;
    }
  }
}

/** Count assertions and skip markers in every spec under `roots` (absolute paths). */
export function countAssertions(roots: readonly string[]): AssertionCount {
  const count: AssertionCount = { assertions: 0, skipped: 0, files: 0 };
  for (const root of roots) {
    for (const file of specFiles(root)) {
      const text = fs.readFileSync(file, 'utf8');
      count.files += 1;
      count.assertions += (text.match(ASSERTIONS) || []).length;
      count.skipped += (text.match(SKIPS) || []).length;
    }
  }
  return count;
}

/**
 * Measure the project: find the repository root (git top-level, else the project directory), walk
 * the spec roots under it, count.
 */
export function measureAssertions(
  projectDir: string,
  options: { roots?: readonly string[]; deps?: AssertionCountDeps } = {},
): AssertionMeasurement {
  const gitTopLevel = options.deps?.gitTopLevel ?? defaultGitTopLevel;
  const repoRoot = gitTopLevel(projectDir) ?? projectDir;
  const roots = (options.roots ?? DEFAULT_ASSERTION_ROOTS).map((r) => path.resolve(repoRoot, r));
  return { repoRoot, roots, count: countAssertions(roots) };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Read a baseline file. Absent, unreadable and malformed are three different answers. */
export function readAssertionBaseline(
  file: string,
): { ok: true; baseline: AssertionBaseline } | { ok: false; reason: 'missing' | 'unreadable' | 'malformed'; detail: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') return { ok: false, reason: 'missing', detail: `no baseline at ${file}` };
    return { ok: false, reason: 'unreadable', detail: `cannot read ${file}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'malformed', detail: `${file} is not valid JSON` };
  }
  const b = parsed as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || !isCount(b['assertions']) || !isCount(b['skipped'])) {
    return { ok: false, reason: 'malformed', detail: `${file} does not record non-negative integer assertions and skipped counts` };
  }
  return {
    ok: true,
    baseline: {
      assertions: b['assertions'],
      skipped: b['skipped'],
      files: isCount(b['files']) ? b['files'] : 0,
      ...(typeof b['updated'] === 'string' ? { updated: b['updated'] } : {}),
    },
  };
}

/** How a measurement compares with its baseline. A drop in assertions or a growth in skips is a problem. */
export interface AssertionComparison {
  assertionDelta: number;
  skippedDelta: number;
  problems: string[];
}

export function compareAssertionCounts(baseline: AssertionCount, current: AssertionCount): AssertionComparison {
  const assertionDelta = current.assertions - baseline.assertions;
  const skippedDelta = current.skipped - baseline.skipped;
  const problems: string[] = [];
  if (assertionDelta < 0) problems.push(`${-assertionDelta} assertion(s) removed`);
  if (skippedDelta > 0) problems.push(`${skippedDelta} test(s) newly skipped`);
  return { assertionDelta, skippedDelta, problems };
}

/**
 * Record `count` as the baseline at `file`. Refuses a zero-spec count (see the module header) and
 * returns why instead of writing. Creates the parent directory.
 */
export function writeAssertionBaseline(
  file: string,
  count: AssertionCount,
  now: () => Date = () => new Date(),
): { ok: true; baseline: AssertionBaseline } | { ok: false; reason: 'no_specs'; detail: string } {
  if (count.files === 0) {
    return {
      ok: false,
      reason: 'no_specs',
      detail: 'no spec files were found — refusing to record an empty baseline: a zeroed ratchet never fires again',
    };
  }
  const baseline: AssertionBaseline = { ...count, updated: now().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  return { ok: true, baseline };
}
