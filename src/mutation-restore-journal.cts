/**
 * The restore journal of `gsd_run verify mutation` — the guarantee that a mutant never outlives the
 * process that wrote it.
 *
 * ── The defect it closes ─────────────────────────────────────────────────
 *
 * The step mutates a source file IN the working tree (the project's own test command has to see
 * it: node_modules, untracked env files, build outputs and absolute paths all live there — a copy
 * of the tree would make the suite unrunnable or, with hardlinks, let a test write through into the
 * original). Restoring "in finally and on SIGINT/SIGTERM" covered neither a signal that arrives
 * while a test run blocks the event loop (spawnSync: the handler never runs, the process dies of
 * the signal, exit 143) nor one that cannot be handled at all (SIGKILL, a host's hard timeout, a
 * power cut). Either left the mutant in the tree with nothing to say so.
 *
 * ── How ──────────────────────────────────────────────────────────────────
 *
 * Write-ahead: before a mutant is written, the journal records the file's ORIGINAL bytes and the
 * digests of both versions; once the original is back the entry is cleared. The journal is held
 * for the whole run (created exclusively, carrying the run's pid), so it is also the lock that keeps
 * two runs from mutating the same tree at once. The next run reads it first:
 *
 *   no journal                                → nothing to do.
 *   holder pid alive (not this process)       → refuse: another run is in progress.
 *   no pending mutant                         → a stale lock: remove it.
 *   file still has the mutant's digest        → write the original back, remove the journal.
 *   file already has the original's digest    → the crash fell between two writes: remove it.
 *   anything else (edited since, deleted)     → refuse and touch nothing: the original is in the
 *                                               journal, the person decides.
 *   journal unreadable                        → refuse and touch nothing.
 *
 * It lives in the git dir (`git rev-parse --git-path`), per worktree, out of sight of test runners
 * and of commits; a project that is not a git checkout falls back to `.planning/`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execGit, platformWriteSync } from './shell-command-projection.cjs';

export const RESTORE_JOURNAL_NAME = 'gsd-mutation-restore.json';
const JOURNAL_VERSION = 1;

/** A mutant on disk: where, what was changed, and the bytes that undo it. */
export interface PendingMutant {
  /** Absolute path of the mutated file. */
  file: string;
  line: number;
  label: string;
  originalSha256: string;
  mutatedSha256: string;
  /** The original content, base64 — what the recovery writes back. */
  original: string;
}

interface JournalBody {
  version: number;
  pid: number;
  pending: PendingMutant | null;
}

export interface RestoreJournal {
  readonly path: string;
  /** Record a mutant BEFORE it is written to disk. */
  arm(pending: PendingMutant): void;
  /** The original is back on disk: nothing pending. */
  disarm(): void;
  /** End of the run: remove the journal (and with it the lock). Idempotent. */
  release(): void;
}

export type JournalAcquisition =
  | { kind: 'acquired'; journal: RestoreJournal; recovered: string | null }
  | { kind: 'refused'; reason: string };

export interface JournalDeps {
  /** Whether a process with this pid is alive. Injected so a holder can be simulated. */
  isAlive: (pid: number) => boolean;
}

function sha256(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else — alive all the same.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Where the journal of runs in `projectDir` lives. */
export function restoreJournalPath(projectDir: string): string {
  const res = execGit(['rev-parse', '--git-path', RESTORE_JOURNAL_NAME], { cwd: projectDir, timeout: 10_000 });
  if (res.exitCode === 0 && res.stdout !== '') return path.resolve(projectDir, res.stdout);
  return path.join(projectDir, '.planning', `.${RESTORE_JOURNAL_NAME}`);
}

/** The journal entry for a mutant about to be written over `original`. */
export function pendingMutant(file: string, original: string, mutated: string, mutation: { line: number; label: string }): PendingMutant {
  return {
    file,
    line: mutation.line,
    label: mutation.label,
    originalSha256: sha256(Buffer.from(original, 'utf8')),
    mutatedSha256: sha256(Buffer.from(mutated, 'utf8')),
    original: Buffer.from(original, 'utf8').toString('base64'),
  };
}

function isPendingMutant(value: unknown): value is PendingMutant {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['file'] === 'string' &&
    path.isAbsolute(v['file']) &&
    typeof v['line'] === 'number' &&
    typeof v['label'] === 'string' &&
    typeof v['originalSha256'] === 'string' &&
    typeof v['mutatedSha256'] === 'string' &&
    typeof v['original'] === 'string'
  );
}

export type JournalRead =
  | { kind: 'absent' }
  | { kind: 'unreadable'; journalPath: string; why: string }
  | { kind: 'held'; journalPath: string; pid: number; pending: PendingMutant | null };

/** Read the journal without acting on it — what the gate sees. */
export function readRestoreJournal(projectDir: string): JournalRead {
  const journalPath = restoreJournalPath(projectDir);
  let text: string;
  try {
    text = fs.readFileSync(journalPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', journalPath, why: (err as Error).message };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (err) {
    return { kind: 'unreadable', journalPath, why: (err as Error).message };
  }
  const b = body as Partial<JournalBody> | null;
  if (b === null || typeof b !== 'object' || b.version !== JOURNAL_VERSION || typeof b.pid !== 'number') {
    return { kind: 'unreadable', journalPath, why: 'not a version-1 restore journal' };
  }
  if (b.pending !== null && !isPendingMutant(b.pending)) {
    return { kind: 'unreadable', journalPath, why: 'its pending entry is malformed' };
  }
  return { kind: 'held', journalPath, pid: b.pid, pending: b.pending ?? null };
}

function removeJournal(journalPath: string): void {
  try {
    fs.unlinkSync(journalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function readCurrent(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/** Act on what an earlier run left behind (see the table in the header). */
function recover(read: JournalRead, deps: JournalDeps): { ok: true; recovered: string | null } | { ok: false; reason: string } {
  if (read.kind === 'absent') return { ok: true, recovered: null };
  if (read.kind === 'unreadable') {
    return {
      ok: false,
      reason: `the restore journal ${read.journalPath} is unreadable (${read.why}) — a mutant may still be on disk; inspect it by hand, then delete the journal`,
    };
  }
  if (read.pid !== process.pid && deps.isAlive(read.pid)) {
    return { ok: false, reason: `another verify mutation run (pid ${read.pid}) holds ${read.journalPath} — wait for it to finish` };
  }
  const { pending, journalPath } = read;
  if (pending === null) {
    removeJournal(journalPath);
    return { ok: true, recovered: null };
  }
  const current = readCurrent(pending.file);
  const digest = current === null ? null : sha256(current);
  if (digest === pending.mutatedSha256) {
    fs.writeFileSync(pending.file, Buffer.from(pending.original, 'base64'));
    removeJournal(journalPath);
    return { ok: true, recovered: pending.file };
  }
  if (digest === pending.originalSha256) {
    removeJournal(journalPath);
    return { ok: true, recovered: null };
  }
  return {
    ok: false,
    reason:
      `${pending.file} was left mutated (${pending.label}, line ${pending.line}) by an interrupted run and has ` +
      `${current === null ? 'been removed' : 'changed'} since — nothing was overwritten; the original is in ${journalPath} ` +
      '(field "original", base64): restore it by hand, then delete the journal',
  };
}

/**
 * Recover whatever an interrupted run left, then take the journal for this run. Refuses — touching
 * nothing — when another run holds it or when recovery cannot be done safely.
 */
export function acquireRestoreJournal(projectDir: string, deps: JournalDeps): JournalAcquisition {
  const read = readRestoreJournal(projectDir);
  const recovered = recover(read, deps);
  if (!recovered.ok) return { kind: 'refused', reason: recovered.reason };

  const journalPath = restoreJournalPath(projectDir);
  let released = false;
  const write = (pending: PendingMutant | null) => {
    // After release nothing may recreate the journal: a signal handler releases it mid-run, and the
    // run's own finally must not then write a lock for a process that is about to die.
    if (released) return;
    const body: JournalBody = { version: JOURNAL_VERSION, pid: process.pid, pending };
    platformWriteSync(journalPath, `${JSON.stringify(body)}\n`);
  };
  try {
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const body: JournalBody = { version: JOURNAL_VERSION, pid: process.pid, pending: null };
    fs.writeFileSync(journalPath, `${JSON.stringify(body)}\n`, { flag: 'wx' });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      kind: 'refused',
      reason:
        code === 'EEXIST'
          ? `another verify mutation run took ${journalPath} at the same moment — wait for it to finish`
          : `cannot write the restore journal ${journalPath} (${(err as Error).message}) — without it a mutant could outlive an interrupted run`,
    };
  }

  return {
    kind: 'acquired',
    recovered: recovered.recovered,
    journal: {
      path: journalPath,
      arm: (pending) => write(pending),
      disarm: () => write(null),
      release: () => {
        if (released) return;
        released = true;
        removeJournal(journalPath);
      },
    },
  };
}
