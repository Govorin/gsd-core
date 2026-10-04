/**
 * `gsd_run check mn-migration-safety` — the gate on database migrations a phase adds
 * (mn-verify-gate; replaces scripts/migration-safety.mjs).
 *
 * ── Why apart from schema-gate and drift ─────────────────────────────────
 *
 * Both existing gates look at the SCHEMA: schema-gate requires the push to be applied, drift
 * catches schema-vs-tree divergence. Neither looks at DATA or reversibility. A migration that
 * drops a column is green in both — schema and code agree precisely because the column is gone
 * everywhere. Data loss is not a schema divergence; it is a consequence of a consistent schema,
 * and only reading the SQL shows it.
 *
 * What is checked:
 *  1. Operations irreversible without data loss in the new `.sql` files (DROP COLUMN/TABLE,
 *     incompatible ALTER TYPE, ADD COLUMN NOT NULL without DEFAULT, SET NOT NULL, TRUNCATE,
 *     DELETE without WHERE; DROP CONSTRAINT as information).
 *  2. `meta/_journal.json` out of step with the `.sql` on disk. A file outside the journal was
 *     written by hand; drizzle-kit neither applies it nor accounts for it in the hash.
 *
 * The contract is a WARNING one, not a prohibition. A DROP COLUMN is often exactly right; the
 * defect is an UNDECLARED one. A finding is silenced by a declaration in the `.sql` itself, or by
 * the phase's own artifacts discussing rollback/backfill — the gate demands that someone thought
 * about it, not that the operation is absent:
 *
 *   -- gsd:irreversible   the data loss is understood and accepted
 *   -- gsd:backfill       existing rows are filled here
 *   -- gsd:reverse: <SQL> the way back is written down
 *   -- gsd:manual         the file was deliberately written outside drizzle-kit
 *
 * Strict mode (`workflow.migration_safety_strict`, or `--strict` by hand) ignores the phase-artifact
 * excuse for a `high` finding not declared in the SQL, and turns every warning into a block.
 *
 * Scope: the `.sql` migrations that differ between a comparison base and the working tree, plus
 * untracked ones. The base is `--base <ref>` when given by hand, else the first of origin/main,
 * main, origin/master, master that differs from HEAD, else HEAD~1. No base is "could not check":
 * an empty file list from a base that does not exist is indistinguishable from a clean phase.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { gateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { readWorkflowConfigValue } from './gate-config.cjs';
import { escapeRegex } from './pattern.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';

/** The git seam — injected so tests can drive failures without a broken git on the host. */
export interface MigrationSafetyDeps {
  runGit(args: string[], cwd: string): SpawnResultOutput;
}

const DEFAULT_DEPS: MigrationSafetyDeps = {
  runGit: (args, cwd) => execGit(args, { cwd, timeout: 30_000 }),
};

export type MigrationSeverity = 'high' | 'warn' | 'info';

export interface MigrationFinding {
  sev: MigrationSeverity;
  kind: string;
  file: string;
  detail: string;
}

interface LocalFinding {
  sev: MigrationSeverity;
  kind: string;
  detail: string;
}

const BASE_CANDIDATES = ['origin/main', 'main', 'origin/master', 'master', 'HEAD~1'];

const DECLARATIONS = {
  irreversible: /--\s*gsd:irreversible/i,
  backfill: /--\s*gsd:backfill/i,
  reverse: /--\s*gsd:reverse:/i,
  manual: /--\s*gsd:manual/i,
};

type Declarations = Record<keyof typeof DECLARATIONS, boolean>;

/** A path git reported names a migration: `.sql` under drizzle/ or migration(s)/, not in meta/. */
export function isMigrationPath(p: string): boolean {
  const norm = p.split(path.sep).join('/');
  return /\.sql$/i.test(norm) && /(^|\/)(drizzle|migrations?)(-[\w-]+)?\//i.test(norm) && !/\/meta\//.test(norm);
}

/**
 * Remove comments, dollar-quoted bodies and string literals before looking for DDL. Rollback
 * paths are customarily written as comments (`-- Reverse: ALTER TABLE ... DROP COLUMN`), and a
 * naive match reports exactly the file whose author thought it through (measured: 18 "DROP"
 * before stripping, 15 after — three were rollback documentation).
 */
export function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' $BODY$ ')
    .replace(/\$([A-Za-z_]\w*)\$[\s\S]*?\$\1\$/g, ' $BODY$ ')
    .replace(/'(?:[^']|'')*'/g, "'S'");
}

function statements(stripped: string): string[] {
  return stripped
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function declarationsIn(raw: string): Declarations {
  return {
    irreversible: DECLARATIONS.irreversible.test(raw),
    backfill: DECLARATIONS.backfill.test(raw),
    reverse: DECLARATIONS.reverse.test(raw),
    manual: DECLARATIONS.manual.test(raw),
  };
}

/** Widening a type keeps the data; a cast or a family change may not. */
function typeChangeSeverity(stmt: string): { sev: MigrationSeverity; why: string } | null {
  const m = /ALTER\s+COLUMN\s+"?(\w+)"?\s+(?:SET\s+DATA\s+)?TYPE\s+([\w".()[\]]+)/i.exec(stmt);
  if (!m) return null;
  const target = (m[2] ?? '').toLowerCase().replace(/"/g, '');
  const hasUsing = /\bUSING\b/i.test(stmt);
  const widening = /^(text|varchar|character varying|jsonb|bigint|numeric|double precision)/.test(target);
  if (widening && !hasUsing) return { sev: 'info', why: `type widened to ${target} — data is kept` };
  if (hasUsing) return { sev: 'warn', why: `cast through USING to ${target} — rows that fail the cast are lost or fail the migration` };
  return { sev: 'warn', why: `type changed to ${target} without USING — PostgreSQL refuses or casts implicitly` };
}

/**
 * SQLite cannot ALTER most things, so drizzle-kit rebuilds: CREATE `__new_x` → INSERT INTO
 * `__new_x` SELECT … → DROP TABLE `x` → RENAME `__new_x` TO `x`. The rows move, and the DROP is
 * the middle of a safe sequence. The full sequence is required: a bare DROP next to an unrelated
 * `__new_y` is not excused.
 */
function sqliteRebuildTables(stmts: string[]): Set<string> {
  const rebuilt = new Set<string>();
  for (const s of stmts) {
    const m = /ALTER\s+TABLE\s+[`"']?__new_(\w+)[`"']?\s+RENAME\s+TO\s+[`"']?(\w+)[`"']?/i.exec(s);
    if (m && m[1] === m[2]) {
      const name = m[2] ?? '';
      const copied = stmts.some((x) => new RegExp(`INSERT\\s+INTO\\s+[\`"']?__new_${escapeRegex(name)}[\`"']?`, 'i').test(x));
      if (copied) rebuilt.add(name);
    }
  }
  return rebuilt;
}

/** `DROP TABLE IF EXISTS x` before `CREATE TABLE x` — an idempotent bootstrap. */
function isBootstrapDrop(stmt: string, stmts: string[]): boolean {
  if (!/\bDROP\s+TABLE\s+IF\s+EXISTS\b/i.test(stmt)) return false;
  const m = /DROP\s+TABLE\s+IF\s+EXISTS\s+([\w."`]+)/i.exec(stmt);
  if (!m) return false;
  const name = (m[1] ?? '').replace(/["`]/g, '');
  return stmts.some((x) => new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${escapeRegex(name)}["\`]?`, 'i').test(x));
}

interface SqlAnalysis {
  decl: Declarations;
  local: LocalFinding[];
  hasBackfill: boolean;
  statementCount: number;
}

/** The operations one migration performs, before any declaration silences them. */
export function analyzeSql(raw: string): SqlAnalysis {
  const decl = declarationsIn(raw);
  const stripped = stripNoise(raw);
  const stmts = statements(stripped);
  const local: LocalFinding[] = [];
  const rebuilt = sqliteRebuildTables(stmts);

  for (const s of stmts) {
    if (/\bDROP\s+TABLE\b/i.test(s)) {
      const m = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."`]+)/i.exec(s);
      const name = m ? (m[1] ?? '').replace(/["`]/g, '') : '';
      if (rebuilt.has(name)) {
        local.push({ sev: 'info', kind: 'sqlite-table-rebuild', detail: `table ${name} rebuilt: rows moved through __new_${name}` });
        continue;
      }
      if (isBootstrapDrop(s, stmts)) {
        local.push({ sev: 'info', kind: 'bootstrap-drop', detail: `DROP TABLE IF EXISTS + CREATE TABLE ${name} — idempotent bootstrap` });
        continue;
      }
      local.push({ sev: 'high', kind: 'drop-table', detail: s.slice(0, 160) });
    }
    if (/\bDROP\s+COLUMN\b/i.test(s)) local.push({ sev: 'high', kind: 'drop-column', detail: s.slice(0, 160) });
    if (/\bTRUNCATE\b/i.test(s)) local.push({ sev: 'high', kind: 'truncate', detail: s.slice(0, 160) });
    if (/\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) local.push({ sev: 'high', kind: 'delete-all', detail: s.slice(0, 160) });
    // ADD COLUMN ... NOT NULL without DEFAULT: safe on an empty table, fails on a populated one.
    // The excuse is a table CREATED in the same file (no rows by definition), never a file number.
    if (/\bADD\s+COLUMN\b/i.test(s) && /\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s) && !/\bGENERATED\b/i.test(s)) {
      const tm = /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w."`]+)/i.exec(s);
      const tbl = tm ? ((tm[1] ?? '').replace(/["`]/g, '').split('.').pop() ?? '') : '';
      const createdHere =
        tbl !== '' &&
        stmts.some((x) => new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?(\\w+\\.)?["\`]?${escapeRegex(tbl)}["\`]?\\s*\\(`, 'i').test(x));
      local.push({ sev: createdHere ? 'info' : 'high', kind: 'notnull-no-default', detail: s.slice(0, 160) });
    }
    if (/\bSET\s+NOT\s+NULL\b/i.test(s)) local.push({ sev: 'high', kind: 'set-not-null', detail: s.slice(0, 160) });
    const tc = typeChangeSeverity(s);
    if (tc) local.push({ sev: tc.sev, kind: 'type-change', detail: `${tc.why} :: ${s.slice(0, 120)}` });
    if (/\bDROP\s+CONSTRAINT\b/i.test(s)) local.push({ sev: 'info', kind: 'drop-constraint', detail: s.slice(0, 140) });
  }

  const hasBackfill = /\bUPDATE\b[\s\S]{0,4000}?\bSET\b/i.test(stripped) || /\bINSERT\s+INTO\b/i.test(stripped);
  return { decl, local, hasBackfill, statementCount: stmts.length };
}

/**
 * Collapse repeats of one kind into one finding per file: a migration dropping six columns in one
 * author decision is one decision, and six identical lines teach readers to scroll past the gate.
 */
function collapse(local: LocalFinding[]): Array<LocalFinding & { count: number }> {
  const collapsed: Array<LocalFinding & { count: number }> = [];
  for (const f of local) {
    const prev = collapsed.find((c) => c.kind === f.kind && c.sev === f.sev);
    if (prev) {
      prev.count += 1;
      if (prev.count <= 3) prev.detail += `\n      + ${f.detail}`;
    } else {
      collapsed.push({ ...f, count: 1 });
    }
  }
  for (const c of collapsed) if (c.count > 3) c.detail += `\n      … ${c.count - 3} more of the same kind`;
  return collapsed;
}

/** The journal checks for one migrations directory. */
function checkJournal(repoRoot: string, migDir: string, findings: MigrationFinding[], notes: string[]): void {
  const jp = path.join(migDir, 'meta', '_journal.json');
  const relDir = path.relative(repoRoot, migDir).split(path.sep).join('/');
  if (!fs.existsSync(jp)) {
    notes.push(`no meta/_journal.json in ${relDir} — the directory is not managed by drizzle-kit`);
    return;
  }
  let journal: unknown;
  try {
    journal = JSON.parse(fs.readFileSync(jp, 'utf8'));
  } catch (e) {
    findings.push({ sev: 'high', kind: 'journal-unreadable', file: `${relDir}/meta/_journal.json`, detail: String((e as Error).message).slice(0, 120) });
    return;
  }
  const rawEntries = (journal as { entries?: unknown } | null)?.entries;
  const entries: unknown[] = Array.isArray(rawEntries) ? rawEntries : [];
  const tags = new Set(entries.map((e) => (e as { tag?: unknown } | null)?.tag).filter((t): t is string => typeof t === 'string'));
  let disk: string[];
  try {
    disk = fs.readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return;
  }

  const orphans = disk.filter((f) => !tags.has(f.replace(/\.sql$/, '')));
  const missing = [...tags].filter((t) => !disk.includes(`${t}.sql`));
  // Two files with one numeric prefix: numbering run in parallel by two branches or two hands.
  // drizzle sorts by prefix, so the order between them is undefined.
  const byPrefix = new Map<string, string[]>();
  for (const f of disk) {
    const p = f.slice(0, 4);
    byPrefix.set(p, [...(byPrefix.get(p) ?? []), f]);
  }
  const dupPrefix = [...byPrefix.entries()].filter(([, v]) => v.length > 1);

  if (orphans.length > 0) {
    const undeclared = orphans.filter((f) => {
      try {
        return !DECLARATIONS.manual.test(fs.readFileSync(path.join(migDir, f), 'utf8'));
      } catch {
        return true;
      }
    });
    if (undeclared.length > 0) {
      findings.push({
        sev: 'high',
        kind: 'journal-desync',
        file: relDir,
        detail:
          `${undeclared.length} .sql on disk missing from _journal.json (journal knows ${entries.length}, disk holds ${disk.length}): ` +
          `${undeclared.slice(0, 6).join(', ')}${undeclared.length > 6 ? ` …+${undeclared.length - 6}` : ''}`,
      });
    }
  }
  if (missing.length > 0) {
    findings.push({ sev: 'high', kind: 'journal-missing-file', file: relDir, detail: `the journal names files that do not exist: ${missing.join(', ')}` });
  }
  if (dupPrefix.length > 0) {
    findings.push({
      sev: 'warn',
      kind: 'duplicate-index',
      file: relDir,
      detail: `duplicate migration numbers (apply order undefined): ${dupPrefix.map(([k, v]) => `${k}×${v.length}`).join(', ')}`,
    });
  }
}

/**
 * Did the phase justify the operation in its own artifacts rather than in the SQL? A deliberately
 * wide match: the gate's aim is to make someone think, not to impose a wording.
 */
function phaseDiscussesMigration(phaseDir: string): boolean {
  let files: string[];
  try {
    files = fs.readdirSync(phaseDir).filter((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
  const re = /(backfill|бэкфилл|обратим|необратим|rollback|откат миграц|reverse migration|down-миграц)/i;
  return files.some((f) => {
    try {
      return re.test(fs.readFileSync(path.join(phaseDir, f), 'utf8'));
    } catch {
      return false;
    }
  });
}

function gitOk(deps: MigrationSafetyDeps, args: string[], cwd: string): string | null {
  const r = deps.runGit(args, cwd);
  return r.exitCode === 0 && !r.timedOut ? r.stdout : null;
}

function resolveBase(deps: MigrationSafetyDeps, cwd: string, explicit: string | undefined, notes: string[]): string | null {
  if (explicit !== undefined) {
    if (gitOk(deps, ['rev-parse', '--verify', `${explicit}^{commit}`], cwd) !== null) return explicit;
    notes.push(`--base "${explicit}" does not resolve to a commit`);
    return null;
  }
  const head = gitOk(deps, ['rev-parse', 'HEAD'], cwd);
  for (const candidate of BASE_CANDIDATES) {
    const sha = gitOk(deps, ['rev-parse', '--verify', `${candidate}^{commit}`], cwd);
    if (sha === null) continue;
    if (sha.trim() !== (head ?? '').trim() || candidate === 'HEAD~1') return candidate;
  }
  return null;
}

/** Split `-z` output; execGit trims the ends, which never removes a NUL. */
function splitNul(out: string): string[] {
  return out.split('\0').map((s) => s.trim()).filter(Boolean);
}

interface ParsedArgs {
  strictFlag: boolean;
  base: string | undefined;
  rest: string[];
}

/** Strip the manual flags before the phase is parsed: `--strict 3` must not read 3 as a value. */
function parseOwnArgs(args: readonly string[]): ParsedArgs | string {
  const rest: string[] = [];
  let base: string | undefined;
  let strictFlag = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--strict') {
      strictFlag = true;
    } else if (a === '--base') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return '--base requires a git ref';
      base = value;
      i++;
    } else {
      rest.push(a);
    }
  }
  return { strictFlag, base, rest };
}

function isStrictByConfig(projectDir: string): boolean {
  const resolved = readWorkflowConfigValue(projectDir, 'workflow.migration_safety_strict');
  return resolved.found && (resolved.value === true || resolved.value === 'true');
}

/** `gsd_run check mn-migration-safety <phase> [--strict] [--base <ref>]` */
export function evaluateMnMigrationSafety(input: MnGateInput, deps: MigrationSafetyDeps = DEFAULT_DEPS): GateResult {
  const parsed = parseOwnArgs(input.args);
  if (typeof parsed === 'string') return gateUsageFailure(GATE_FAILURE_CODE.USAGE, `mn-migration-safety: ${parsed}`);
  return withMnPhase('mn-migration-safety', { projectDir: input.projectDir, args: parsed.rest }, ({ phaseDir }) => {
    const strict = parsed.strictFlag || isStrictByConfig(input.projectDir);
    const cwd = input.projectDir;
    const notes: string[] = [];

    const top = gitOk(deps, ['rev-parse', '--show-toplevel'], cwd);
    if (top === null) {
      return mnUnresolvable('mn-migration-safety: git is unavailable or this is not a repository — there is no way to find the phase\'s migrations', { phaseDir, strict });
    }
    const repoRoot = top.trim();
    const base = resolveBase(deps, cwd, parsed.base, notes);
    if (base === null) {
      return mnUnresolvable(
        'mn-migration-safety: no comparison base — an empty change list from a base that does not exist is indistinguishable from a clean phase',
        { phaseDir, strict, notes },
      );
    }
    const diff = gitOk(deps, ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, '--'], cwd);
    if (diff === null) return mnUnresolvable(`mn-migration-safety: git diff against ${base} did not run`, { phaseDir, strict, base });
    const changed = new Set(splitNul(diff));
    const untracked = gitOk(deps, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], cwd);
    if (untracked !== null) for (const f of splitNul(untracked)) changed.add(f);
    const files = [...changed].filter(isMigrationPath).sort();
    notes.push(`comparison base: ${base}`);

    if (files.length === 0) {
      return mnPass('mn-migration-safety: no migrations in the phase\'s scope — nothing to check', { phaseDir, strict, base, files, findings: [], notes, planCovers: false });
    }

    const planCovers = phaseDiscussesMigration(phaseDir);
    const findings: MigrationFinding[] = [];
    for (const rel of files) {
      const abs = path.join(repoRoot, rel);
      let raw: string;
      try {
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
        raw = fs.readFileSync(abs, 'utf8');
      } catch (e) {
        findings.push({ sev: 'warn', kind: 'unreadable', file: rel, detail: String((e as Error).message).slice(0, 100) });
        continue;
      }
      const a = analyzeSql(raw);
      if (a.statementCount === 0) {
        findings.push({ sev: 'warn', kind: 'empty-migration', file: rel, detail: 'no statement left once comments are stripped' });
        continue;
      }
      for (const f of collapse(a.local)) {
        // Different operations are silenced by different declarations: NOT NULL by a backfill
        // (declared or present), a DROP by accepted irreversibility or a written way back.
        const silencedByBackfill = (f.kind === 'notnull-no-default' || f.kind === 'set-not-null') && (a.decl.backfill || a.hasBackfill);
        const silencedByReverse = a.decl.irreversible || a.decl.reverse;
        const silenced = f.sev === 'info' || silencedByBackfill || silencedByReverse || (planCovers && !strict);
        if (!silenced) {
          findings.push({ sev: f.sev, kind: f.count > 1 ? `${f.kind}×${f.count}` : f.kind, file: rel, detail: f.detail });
        } else if (strict && f.sev === 'high' && !(a.decl.irreversible || a.decl.reverse || a.decl.backfill)) {
          findings.push({ sev: 'warn', kind: `${f.kind}(undeclared-in-sql)`, file: rel, detail: f.detail });
        }
      }
    }

    const journalDirs = [...new Set(files.map((f) => path.dirname(path.join(repoRoot, f))))];
    for (const d of journalDirs) checkJournal(repoRoot, d, findings, notes);

    const high = findings.filter((f) => f.sev === 'high').length;
    const warn = findings.filter((f) => f.sev === 'warn').length;
    const details = { phaseDir, strict, base, files, findings, notes, planCovers, high, warn };
    const unblock =
      'Declare the decision in the .sql itself — `-- gsd:irreversible`, `-- gsd:backfill`, `-- gsd:reverse: <SQL>`, ' +
      '`-- gsd:manual` — or describe rollback and backfill in the phase\'s PLAN.md. The gate demands not the absence ' +
      'of the operation but that someone answers for it.';
    if (high > 0) {
      return mnFinding(`mn-migration-safety: ${high} operation(s) irreversible without data loss or outside the journal (${files.length} .sql checked). ${unblock}`, details);
    }
    if (strict && warn > 0) {
      return mnFinding(`mn-migration-safety: ${warn} warning(s) need an explicit declaration under strict mode. ${unblock}`, details);
    }
    return mnPass(
      `mn-migration-safety: no undeclared irreversible operation in ${files.length} .sql${warn > 0 ? ` (${warn} warning(s))` : ''}`,
      details,
    );
  });
}
