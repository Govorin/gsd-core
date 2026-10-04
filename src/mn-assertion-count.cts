/**
 * Assertion count — the one definition of "a live check" that the assertion
 * ratchet reads and `gsd-tools mn assertion-baseline` records.
 *
 * The ratchet catches the failure nothing else catches: a test that no longer
 * fails because its check was deleted. Deleting an assertion makes the suite
 * greener and no green run reports it; coverage stays silent too, the line
 * still runs, nobody compares its result any more. The invariant is that the
 * count does not drop WITHOUT a record — a deliberate drop (a refactor, merged
 * duplicates) is legitimate once the baseline is re-recorded on purpose.
 *
 * What counts: `expect(`, `assert(`, `assert.`, `.toThrow`, `should.`; and, as
 * a separate metric, skip markers (`it.skip` does not fail and does not check
 * — the quiet equivalent of a deletion).
 *
 * The count is static, over sources: `vitest list` resolves the whole
 * workspace and costs minutes in a hundred-project monorepo; a tree walk gives
 * the same answer in seconds. The price — commented-out assertions count too —
 * is acceptable for a ratchet that only compares the number with itself. The
 * walk is our own (no ripgrep): a missing tool must not look like a defect.
 *
 * The walk is anchored on the REPOSITORY root, not the cwd: GSD runs from a
 * project directory (apps/rpg) while the monorepo's code sits above it. From
 * the sub-project, `libs`/`apps` are invisible, the walk finds zero specs, and
 * recording that would arm a ratchet that never fires again — so zero spec
 * files is a refusal, never a baseline.
 *
 * Ported from `capabilities/mn-verify-gate/scripts/assertion-ratchet.mjs`
 * (its `--update` half; the comparison is the verify:pre gate's).
 *
 * ADR-457 build-at-publish: source in src/mn-assertion-count.cts, compiled to
 * gsd-core/bin/lib/mn-assertion-count.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';

export const ASSERTION_PATTERN = /expect\(|\bassert\(|\bassert\.|\.toThrow|\bshould\./g;
export const SKIP_PATTERN = /\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(/g;
export const SPEC_FILE = /\.(spec|test)\.tsx?$/;
const PRUNE: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', '.git', '.nx', 'coverage', '.venv', '__pycache__']);

/** Repo-relative path of the baseline the ratchet reads. Fixed: the gate and this writer must agree. */
export const BASELINE_PATH = '.planning/assertion-baseline.json';

/** Roots walked when none are given. A missing root is not an error: not every repo has `apps/`. */
export const DEFAULT_ROOTS: readonly string[] = Object.freeze(['libs', 'apps']);

export interface AssertionCounts {
  assertions: number;
  skipped: number;
  files: number;
}

/** Every spec file under `dir` (hidden directories and build output pruned). */
function* specFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) yield* specFiles(p);
    } else if (SPEC_FILE.test(e.name)) {
      yield p;
    }
  }
}

/** Count one file's text. */
export function countText(text: string): { assertions: number; skipped: number } {
  return {
    assertions: (text.match(ASSERTION_PATTERN) ?? []).length,
    skipped: (text.match(SKIP_PATTERN) ?? []).length,
  };
}

/** Totals over every spec file under the given absolute roots. */
export function countAssertions(roots: readonly string[]): AssertionCounts {
  const total: AssertionCounts = { assertions: 0, skipped: 0, files: 0 };
  for (const root of roots) {
    for (const file of specFiles(root)) {
      const c = countText(fs.readFileSync(file, 'utf-8'));
      total.files += 1;
      total.assertions += c.assertions;
      total.skipped += c.skipped;
    }
  }
  return total;
}

/** The repository top level for `cwd`, or `cwd` itself outside git (the zero-spec refusal still catches a miss). */
export function resolveRepoRoot(cwd: string, git: (args: string[], cwd: string) => string | null = defaultGit): string {
  return git(['rev-parse', '--show-toplevel'], cwd) || cwd;
}

function defaultGit(args: string[], cwd: string): string | null {
  const r = execGit(args, { cwd });
  return r.exitCode === 0 ? r.stdout : null;
}

export interface BaselineRecord extends AssertionCounts {
  updated: string;
}

export interface RecordBaselineOptions {
  /** Absolute repository root (resolved by the caller). */
  repoRoot: string;
  /** Absolute roots to walk. */
  roots: readonly string[];
  now?: () => Date;
}

export type RecordBaselineResult =
  | { ok: true; path: string; baseline: BaselineRecord }
  | { ok: false; reason: 'no_specs'; message: string; roots: string[] }
  | { ok: false; reason: 'write_failed'; message: string };

/**
 * Record the current counts as the baseline. Zero spec files is refused:
 * that is almost always a walk that missed (wrong root, renamed folder), not
 * a repository without tests, and recording it would zero the ratchet.
 */
export function recordAssertionBaseline(opts: RecordBaselineOptions): RecordBaselineResult {
  const counts = countAssertions(opts.roots);
  if (counts.files === 0) {
    return {
      ok: false,
      reason: 'no_specs',
      roots: [...opts.roots],
      message: `no spec files found under [${opts.roots.join(', ')}] (repo root: ${opts.repoRoot}) — refusing to record an empty baseline; a zeroed ratchet never fires again`,
    };
  }
  const baseline: BaselineRecord = { ...counts, updated: (opts.now ?? (() => new Date()))().toISOString() };
  const target = path.join(opts.repoRoot, BASELINE_PATH);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(baseline, null, 2)}\n`);
  } catch (e) {
    return { ok: false, reason: 'write_failed', message: `cannot write ${target}: ${(e as Error).message}` };
  }
  return { ok: true, path: target, baseline };
}
