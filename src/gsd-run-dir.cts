/**
 * The project's tool-owned run directory, `<project>/.gsd/` — where gsd-tools keeps state that
 * belongs to ONE run of a workflow and must never reach version control: the dispatch-isolation
 * sentinel (#3045, ADR-4630) and the auto-chain flag (`auto-chain-state.cts`).
 *
 * Run state is not configuration. `.planning/config.json` is versioned project configuration; a
 * flag a workflow flips on and off while it runs dirties the tree there (the X5 finding: every
 * `--auto` run left `workflow._auto_chain_active` changed in all three projects reviewed).
 *
 * One owner prepares the directory, so every run-state writer gets the same guarantees:
 *   - the directory is created inside the project and is never a symlink, nor resolves outside it
 *     (#5086), so a project-supplied `.gsd` link cannot redirect a write;
 *   - it is ignored LOCALLY: user projects do not inherit gsd-core's root `.gitignore`, so the
 *     first writer seeds `.gsd/.gitignore` with `*`; an existing ignore file is kept and gains
 *     only the owner's root-anchored rules, once, under its `# gsd-core <marker>` line, replaced
 *     by rename (never appended through a path a link could swap);
 *   - an ignore file that cannot be read or updated does not stop the write — ignoring is
 *     best-effort, a symlinked ignore file is a refusal.
 *
 * `writeJsonAtomic` is the matching write: a unique temp file renamed over the target, so a
 * concurrent reader (a guard hook, another gsd-tools call) never sees a partial document.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { retryRenameSync } from './shell-command-projection.cjs';

export const GSD_RUN_DIRNAME = '.gsd';

/** One writer of run state under `.gsd/`. */
export interface RunDirOwner {
  /** Names the owner in refusals: `<label> directory is a symlink…`, `<label> ignore file is a symlink`. */
  readonly label: string;
  /** Tags this owner's rules in a pre-existing ignore file: `# gsd-core <marker>`. */
  readonly marker: string;
  /** Root-anchored ignore rules this owner's files need when the ignore file does not ignore `*`. */
  readonly rules: readonly string[];
}

function symlinkedIgnoreError(owner: RunDirOwner): Error {
  return new Error(`${owner.label} ignore file is a symlink`);
}

/**
 * Keep a pre-existing `.gsd/.gitignore`, adding `owner`'s rules unless they are already there or
 * a bare `*` already ignores everything. Throws only for a symlinked ignore file; every other
 * failure leaves the file as it was.
 */
function extendExistingIgnore(ignorePath: string, owner: RunDirOwner): void {
  const markerLine = `# gsd-core ${owner.marker}`;
  let fd: number | undefined;
  let tmpPath: string | null = null;
  try {
    if (fs.lstatSync(ignorePath).isSymbolicLink()) throw symlinkedIgnoreError(owner);
    // Read through an fd opened without following links where the platform supports it.
    fd = fs.openSync(ignorePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${owner.label} ignore file is not a regular file`);
    const current = fs.readFileSync(fd, 'utf8');
    fs.closeSync(fd);
    fd = undefined;
    if (current.includes(markerLine) || /^\*\r?$/m.test(current)) return;
    const added = `${current.endsWith('\n') || current === '' ? '' : '\n'}${markerLine}\n${owner.rules.join('\n')}\n/.gitignore\n`;
    tmpPath = `${ignorePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    fs.writeFileSync(tmpPath, current + added, { flag: 'wx' });
    if (fs.lstatSync(ignorePath).isSymbolicLink()) throw symlinkedIgnoreError(owner);
    retryRenameSync(tmpPath, ignorePath);
    tmpPath = null;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ELOOP' || e.message === symlinkedIgnoreError(owner).message) throw symlinkedIgnoreError(owner);
    // Ignore seeding is best-effort: the run state is still useful when this file cannot be updated.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    }
  }
}

/**
 * Create (if needed) and validate `<projectRoot>/.gsd/`, seed or extend its local ignore file for
 * `owner`, and return the directory's path. Throws when the directory is a symlink or resolves
 * outside the project, or when the ignore file is a symlink.
 */
export function ensureGsdRunDir(projectRoot: string, owner: RunDirOwner): string {
  const dir = path.join(projectRoot, GSD_RUN_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  // Resolve the directory as well, so an ancestor redirect cannot escape this project.
  if (fs.lstatSync(dir).isSymbolicLink() ||
      path.relative(fs.realpathSync(projectRoot), fs.realpathSync(dir)) !== GSD_RUN_DIRNAME) {
    throw new Error(`${owner.label} directory is a symlink or resolves outside the project`);
  }
  const ignorePath = path.join(dir, '.gitignore');
  try {
    fs.writeFileSync(ignorePath, '*\n', { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') extendExistingIgnore(ignorePath, owner);
    // Any other failure (an ignore path that is a directory, a read-only fs) is best-effort too.
  }
  return dir;
}

/** Write `payload` as JSON to `filePath` through a unique temp file renamed over the target. */
export function writeJsonAtomic(filePath: string, payload: unknown): void {
  const tmpPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload), { flag: 'wx' });
  try {
    retryRenameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}
