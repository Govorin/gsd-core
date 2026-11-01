/**
 * Auto-chain run state (X5) — whether an `--auto` / `--chain` run, or a `/gsd:autonomous` run, is
 * in flight for the planning scope a caller resolves. Run state, not configuration: it lives in
 * `<project>/.gsd/auto-chain/<scope>/active.json`, under the tool-owned run directory
 * (`gsd-run-dir.cts`, shared with the dispatch-isolation sentinel), which is ignored locally and
 * never versioned. It used to be `workflow._auto_chain_active` in `.planning/config.json`, which
 * every chained workflow flipped through `config-set`, leaving the versioned config dirty.
 *
 * Scope mirrors `planningDir`: the project root is `.gsd/auto-chain/active.json`, workstream `x`
 * is `.gsd/auto-chain/workstreams/x/active.json` (and a `GSD_PROJECT` prefixes its own segment).
 * The workstream is resolved HERE, the same way for the CLI and for in-process readers (guard
 * hooks): `GSD_WORKSTREAM`, else the active-workstream pointer (read without mutating it). There
 * is no fallback from a workstream to the root: run state belongs to the run that set it.
 *
 * Owners. A record carries who holds it. `chain` is the `--auto` / `--chain` hand-off between
 * discuss, plan and execute. `autonomous` is `/gsd:autonomous` holding the run open for its whole
 * length; its nested discuss/plan/execute calls carry `--in-autonomous` and leave the record
 * alone. A plain `set` never downgrades an autonomous hold and a plain `clear` (transition.md's
 * boundary clear) never removes it; `clear --owner autonomous` (autonomous's own exits) and
 * `clear --manual` (a discuss/plan/execute a human started by hand) do, the latter saying so on
 * stderr. Only a `chain` record advances to the next step (`init`'s `auto_chain_owner`).
 *
 * Stale records. Hooks turn "ask a human" into "deny" while a run is active, so when in doubt a
 * record is NOT active:
 *   - it lapses RUN_STATE_TTL_MS after its last refresh (`touched_at`; any `set` by the holder
 *     refreshes, autonomous at every phase start); a missing or unparseable `touched_at`, or one
 *     more than CLOCK_SKEW_MS in the future, is lapsed;
 *   - it records the runtime process (`holder_pid`, Claude Code's CLAUDE_PID) and lapses at once
 *     when that process is gone;
 *   - it records the session (`session`, CLAUDE_CODE_SESSION_ID) and is not active for a reader
 *     that knows a different session — subagents share their parent's session id, a second
 *     terminal session does not. When either side does not know its session, pid + TTL decide.
 *
 * Linked worktrees. Run state belongs to the checkout that runs the workflow. A reader standing in
 * a linked worktree (an isolated executor's guard hook) resolves to the MAIN checkout through
 * git's common dir, mapping a monorepo subdirectory across, so it sees the run the orchestrator
 * recorded — even when the worktree carries its own committed `.planning/`.
 *
 * Legacy key: `workflow._auto_chain_active` left in a `config.json` by an earlier release is never
 * read. `set` and `clear` delete it from the scope's config and the root config, and `config-set`
 * refuses the key with a pointer to this verb.
 *
 * Surfaced as `gsd-tools auto-chain set|clear|status`; `check auto-mode` (`check-auto-mode.cts`)
 * reads `readAutoChainActive` for its `auto_chain_active` field.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureGsdRunDir, writeJsonAtomic, GSD_RUN_DIRNAME } from './gsd-run-dir.cjs';
import { platformWriteSync, execGit } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import worktreeSafety = require('./worktree-safety.cjs');
const { resolveWorktreeLinkage } = worktreeSafety;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningRoot, withPlanningLock } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import activeWorkstreamStore = require('./active-workstream-store.cjs');
const { peekActiveWorkstream } = activeWorkstreamStore;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import ioMod = require('./io.cjs');
const { output, error, ERROR_REASON } = ioMod;

export const AUTO_CHAIN_DIRNAME = 'auto-chain';
const STATE_FILENAME = 'active.json';

/** The retired config key this state replaced. */
export const LEGACY_AUTO_CHAIN_CONFIG_KEY = 'workflow._auto_chain_active';

/** Who holds the run open (see the module doc). */
export type AutoChainOwner = 'chain' | 'autonomous';
const OWNERS: readonly AutoChainOwner[] = ['chain', 'autonomous'];

/** How long a record stays active after its last refresh. */
export const RUN_STATE_TTL_MS = 24 * 60 * 60 * 1000;

/** How far in the future a `touched_at` may sit (clock skew) before it is not believed. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Env vars naming the agent runtime process / session that owns a run. */
const HOLDER_PID_ENV = ['CLAUDE_PID'] as const;
const SESSION_ENV = ['CLAUDE_CODE_SESSION_ID'] as const;

const RUN_DIR_OWNER = Object.freeze({
  label: 'auto-chain state',
  marker: 'auto-chain state',
  rules: Object.freeze([`/${AUTO_CHAIN_DIRNAME}/`]),
});

export interface AutoChainStatus {
  active: boolean;
  /** The planning scope, relative to `.planning/` (posix): `''` for the project root. */
  scope: string;
  /** The state file, relative to the checkout that holds it (posix). */
  path: string;
  /** Who holds the active record, or null when inactive. */
  owner: AutoChainOwner | null;
  /** When the run was set (ISO), or null when inactive. */
  since: string | null;
  /** When the record lapses unless refreshed (ISO), or null when inactive. */
  expires_at: string | null;
}

export interface AutoChainChange extends AutoChainStatus {
  /** Whether this call changed the recorded state. */
  changed: boolean;
  /** Set when a plain `clear` left an autonomous hold in place: who still holds it. */
  held_by: AutoChainOwner | null;
  /** Who held the record this call removed, or null. */
  released: AutoChainOwner | null;
  /** Project-relative config files the legacy key was deleted from. */
  legacy_cleaned: string[];
}

/** Injectable seams: clock, process liveness, and the env the session/pid/workstream come from. */
export interface RunStateOpts {
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  env?: NodeJS.ProcessEnv;
}

const nowOf = (opts: RunStateOpts): Date => (opts.now ?? (() => new Date()))();
const envOf = (opts: RunStateOpts): NodeJS.ProcessEnv => opts.env ?? process.env;
const toPosix = (p: string): string => p.split(path.sep).join('/');

/**
 * The checkout whose run state `projectDir` reads: itself, or — from a linked worktree — the
 * same relative directory in the main checkout. Never throws; anything git cannot answer keeps
 * `projectDir`.
 */
export function runStateRoot(projectDir: string): string {
  try {
    const linkage = resolveWorktreeLinkage(projectDir);
    if (linkage.reason !== 'linked_worktree') return projectDir;
    const top = execGit(['rev-parse', '--show-toplevel'], { cwd: projectDir, timeout: 5000 });
    const topText = String(top.stdout || '').trim();
    if (top.timedOut || top.exitCode !== 0 || topText === '') return projectDir;
    const rel = path.relative(fs.realpathSync(path.resolve(projectDir, topText)), fs.realpathSync(projectDir));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return projectDir;
    return path.join(linkage.effectiveRoot, rel);
  } catch {
    return projectDir;
  }
}

/** Where one call reads/writes: the run root, the planning scope under it, and the state file. */
interface Location { root: string; scope: string; file: string }

function locate(projectDir: string, opts: RunStateOpts): Location {
  const root = runStateRoot(projectDir);
  const envWs = envOf(opts)['GSD_WORKSTREAM']?.trim();
  let ws: string | null = envWs || null;
  if (!ws) {
    try {
      ws = peekActiveWorkstream(root) || null;
    } catch {
      ws = null;
    }
  }
  let scope = '';
  try {
    scope = toPosix(path.relative(planningRoot(root), planningDir(root, ws)));
  } catch {
    scope = ''; // an invalid workstream name: the root scope, as planningDir's callers fall back
  }
  const file = path.join(root, GSD_RUN_DIRNAME, AUTO_CHAIN_DIRNAME, ...scope.split('/').filter(Boolean), STATE_FILENAME);
  return { root, scope, file };
}

/** The planning scope this caller resolves, relative to `.planning/`. */
export function autoChainScope(projectDir: string, opts: RunStateOpts = {}): string {
  return locate(projectDir, opts).scope;
}

/** Absolute path of the scope's state file (in the main checkout when read from a linked worktree). */
export function autoChainStatePath(projectDir: string, opts: RunStateOpts = {}): string {
  return locate(projectDir, opts).file;
}

interface Held { owner: AutoChainOwner; since: string | null; touchedAt: string }

function statusFor(loc: Location, held: Held | null): AutoChainStatus {
  return {
    active: held !== null,
    scope: loc.scope,
    path: toPosix(path.relative(loc.root, loc.file)),
    owner: held?.owner ?? null,
    since: held?.since ?? null,
    expires_at: held ? new Date(Date.parse(held.touchedAt) + RUN_STATE_TTL_MS).toISOString() : null,
  };
}

/** Whether process `pid` exists (EPERM: it exists under another user). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function firstEnv(env: NodeJS.ProcessEnv, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function holderPidFromEnv(env: NodeJS.ProcessEnv): number | null {
  const pid = Number(firstEnv(env, HOLDER_PID_ENV));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** Whether the `.gsd/auto-chain/...` path below `root` crosses a symlink (then it is not ours). */
function crossesLink(root: string, file: string): boolean {
  let dir = path.join(root, GSD_RUN_DIRNAME);
  const parts = path.relative(dir, path.dirname(file)).split(path.sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i++) {
    if (fs.lstatSync(dir).isSymbolicLink()) return true;
    if (i < parts.length) dir = path.join(dir, parts[i]);
  }
  return !fs.lstatSync(file).isFile();
}

/**
 * The live record at `loc`, or null: anything unreadable or reached through a symlink, a record
 * whose `touched_at` is missing, unparseable, older than RUN_STATE_TTL_MS (`age >= ttl`) or more
 * than CLOCK_SKEW_MS in the future, whose holder process is gone, or whose session differs from
 * the reader's known session. A record without an owner field is a chain.
 */
function readHeld(loc: Location, opts: RunStateOpts): Held | null {
  try {
    if (crossesLink(loc.root, loc.file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(loc.file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (rec['active'] !== true) return null;
    const owner = rec['owner'] === undefined ? 'chain' : rec['owner'];
    if (!OWNERS.includes(owner as AutoChainOwner)) return null;
    const touchedAt = typeof rec['touched_at'] === 'string' ? rec['touched_at'] : null;
    const touched = touchedAt === null ? NaN : Date.parse(touchedAt);
    if (touchedAt === null || !Number.isFinite(touched)) return null;
    const age = nowOf(opts).getTime() - touched;
    if (age >= RUN_STATE_TTL_MS || -age > CLOCK_SKEW_MS) return null;
    const holderPid = rec['holder_pid'];
    if (Number.isSafeInteger(holderPid) && (holderPid as number) > 0
        && !(opts.isAlive ?? processAlive)(holderPid as number)) return null;
    const recSession = typeof rec['session'] === 'string' && rec['session'] ? rec['session'] : null;
    const readerSession = firstEnv(envOf(opts), SESSION_ENV);
    if (recSession !== null && readerSession !== null && recSession !== readerSession) return null;
    const since = typeof rec['since'] === 'string' ? rec['since'] : null;
    return { owner: owner as AutoChainOwner, since, touchedAt };
  } catch {
    return null; // absent or unreadable: inactive
  }
}

/** The recorded state for this caller's scope. Never throws; anything doubtful is inactive. */
export function readAutoChainState(projectDir: string, opts: RunStateOpts = {}): AutoChainStatus {
  const loc = locate(projectDir, opts);
  return statusFor(loc, readHeld(loc, opts));
}

export function readAutoChainActive(projectDir: string, opts: RunStateOpts = {}): boolean {
  return readAutoChainState(projectDir, opts).active;
}

function hasLegacyKey(config: unknown): config is { workflow: Record<string, unknown> } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  const workflow = (config as Record<string, unknown>)['workflow'];
  return Boolean(workflow) && typeof workflow === 'object' && !Array.isArray(workflow)
    && Object.prototype.hasOwnProperty.call(workflow, '_auto_chain_active');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Delete the retired `workflow._auto_chain_active` from the scope's config and the root config.
 * A config that is absent, unparseable or without the key is left untouched (a byte-identical
 * file, so a clean tree stays clean).
 */
function removeLegacyConfigKey(projectDir: string): string[] {
  const paths = [...new Set([
    path.join(planningDir(projectDir), 'config.json'),
    path.join(planningRoot(projectDir), 'config.json'),
  ])];
  const pending = paths.filter((file) => hasLegacyKey(readJson(file)));
  if (pending.length === 0) return [];
  return withPlanningLock(projectDir, () => {
    const cleaned: string[] = [];
    for (const file of pending) {
      const config = readJson(file);
      if (!hasLegacyKey(config)) continue;
      delete config.workflow['_auto_chain_active'];
      platformWriteSync(file, JSON.stringify(config, null, 2));
      cleaned.push(toPosix(path.relative(projectDir, file)));
    }
    return cleaned;
  });
}

function ensureStateDir(loc: Location): void {
  const runDir = ensureGsdRunDir(loc.root, RUN_DIR_OWNER);
  const stateDir = path.dirname(loc.file);
  fs.mkdirSync(stateDir, { recursive: true });
  // A link anywhere under .gsd/auto-chain could carry the write out of the run directory.
  const rel = path.relative(fs.realpathSync(runDir), fs.realpathSync(stateDir));
  if (rel.startsWith('..') || path.isAbsolute(rel) || toPosix(rel) !== toPosix(path.relative(runDir, stateDir))) {
    throw new Error('auto-chain state directory is a symlink or resolves outside the run directory');
  }
}

/** Who is asking: an owner, or a human who entered a chain-aware workflow by hand. */
export type AutoChainActor = AutoChainOwner | 'manual';

/**
 * Record (`active: true`) or clear (`active: false`) the run for this scope, and retire the
 * legacy config key. `actor` is who is asking (default `chain`):
 *   - set chain over a live autonomous hold changes nothing (the hold already covers it);
 *   - any other set takes the record (keeping `since` if the same owner held it) and refreshes it;
 *   - clear chain leaves a live autonomous hold in place and reports it in `held_by`;
 *   - clear autonomous and clear manual remove the record whoever holds it (`released`).
 * Throws when the run directory cannot be used safely (a symlinked `.gsd`).
 */
export function setAutoChain(
  projectDir: string,
  active: boolean,
  opts: RunStateOpts & { owner?: AutoChainActor } = {},
): AutoChainChange {
  const actor = opts.owner ?? 'chain';
  if (active && actor === 'manual') throw new Error('--manual applies to clear only');
  const loc = locate(projectDir, opts);
  const before = readHeld(loc, opts);
  let after: Held | null = before;
  let heldBy: AutoChainOwner | null = null;
  let released: AutoChainOwner | null = null;
  if (active) {
    const owner = actor as AutoChainOwner;
    if (!(before?.owner === 'autonomous' && owner === 'chain')) {
      const now = nowOf(opts).toISOString();
      const env = envOf(opts);
      after = { owner, since: before?.owner === owner && before.since ? before.since : now, touchedAt: now };
      ensureStateDir(loc);
      writeJsonAtomic(loc.file, {
        active: true, owner, since: after.since, touched_at: now,
        holder_pid: holderPidFromEnv(env), session: firstEnv(env, SESSION_ENV), scope: loc.scope,
      });
    }
  } else if (before?.owner === 'autonomous' && actor === 'chain') {
    heldBy = 'autonomous';
  } else {
    try {
      fs.unlinkSync(loc.file); // a link is removed, never followed; a lapsed record goes too
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    released = before?.owner ?? null;
    after = null;
  }
  const legacyCleaned = removeLegacyConfigKey(projectDir);
  return {
    ...statusFor(loc, after),
    changed: (before === null) !== (after === null) || before?.owner !== after?.owner,
    held_by: heldBy,
    released,
    legacy_cleaned: legacyCleaned,
  };
}

const USAGE = 'Usage: auto-chain <set|clear|status> [--owner chain|autonomous] [--manual]';

/** `gsd-tools auto-chain set|clear|status [--owner chain|autonomous] [--manual]` — `--raw` prints `true`/`false`. */
export function cmdAutoChain(cwd: string, args: string[], raw: boolean): void {
  const [subcommand, ...rest] = args;
  let actor: AutoChainActor = 'chain';
  let manual = false;
  let ownerGiven = false;
  const extra: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--raw' || arg === '--json') continue;
    if (arg === '--manual') {
      manual = true;
      continue;
    }
    if (arg === '--owner' || arg.startsWith('--owner=')) {
      const value = arg === '--owner' ? rest[++i] : arg.slice('--owner='.length);
      if (!OWNERS.includes(value as AutoChainOwner)) {
        error(`auto-chain ${subcommand ?? ''}: --owner must be chain or autonomous. ${USAGE}`, ERROR_REASON.USAGE);
        return;
      }
      actor = value as AutoChainOwner;
      ownerGiven = true;
      continue;
    }
    extra.push(arg);
  }
  if (manual) actor = 'manual';
  if (extra.length > 0 || (manual && (ownerGiven || subcommand !== 'clear'))) {
    const why = extra.length > 0 ? `unexpected argument ${extra[0]}` : '--manual applies to clear alone';
    error(`auto-chain ${subcommand ?? ''}: ${why}. ${USAGE}`, ERROR_REASON.USAGE);
    return;
  }
  if (subcommand === 'status') {
    const status = readAutoChainState(cwd);
    output(status, raw, String(status.active));
    return;
  }
  if (subcommand === 'set' || subcommand === 'clear') {
    let result: AutoChainChange;
    try {
      result = setAutoChain(cwd, subcommand === 'set', { owner: actor });
    } catch (err) {
      error(`auto-chain ${subcommand}: ${(err as Error).message}`);
      return;
    }
    if (actor === 'manual' && result.released === 'autonomous') {
      process.stderr.write('Note: released the auto-mode hold of an autonomous run that did not finish — '
        + 'this workflow was started by hand, so checkpoints and guards ask you again.\n');
    }
    output(result, raw, String(result.active));
    return;
  }
  error(subcommand ? `Unknown auto-chain subcommand: ${subcommand}. ${USAGE}` : USAGE, ERROR_REASON.USAGE);
}
