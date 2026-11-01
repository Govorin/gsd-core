/**
 * Auto-chain run state (X5) — whether an `--auto` / `--chain` run is in flight for the planning
 * scope this process resolves. Run state, not configuration: it lives in
 * `<project>/.gsd/auto-chain/<scope>/active.json`, under the tool-owned run directory
 * (`gsd-run-dir.cts`, shared with the dispatch-isolation sentinel), which is ignored locally and
 * never versioned. It used to be `workflow._auto_chain_active` in `.planning/config.json`, which
 * every chained workflow flipped through `config-set`, leaving the versioned config dirty.
 *
 * Scope mirrors `planningDir`: the project root is `.gsd/auto-chain/active.json`, workstream `x`
 * is `.gsd/auto-chain/workstreams/x/active.json` (and a `GSD_PROJECT` prefixes its own segment),
 * so a chain in one workstream never reads as active in another session's workstream. There is
 * no fallback from a workstream to the root: run state belongs to the run that set it.
 *
 * Absent = inactive. A missing, unreadable, malformed or non-regular file (a symlink included)
 * reads as inactive, so a damaged record fails toward a human being asked, never toward
 * auto-approval.
 *
 * Legacy key: `workflow._auto_chain_active` left in a `config.json` by an earlier release is never
 * read — it cannot tell a live chain from a crashed one, and honouring it would keep two sources
 * that can disagree. `set` and `clear` delete it from the scope's config and the root config
 * (every chain-aware workflow calls one of them on entry), and `config-set` refuses the key with
 * a pointer to this verb.
 *
 * Owners. A record carries who holds it. `chain` is the `--auto` / `--chain` hand-off between
 * discuss, plan and execute: any of them invoked by hand (no flag) clears it. `autonomous` is
 * `/gsd:autonomous` holding the run open for its whole length: it calls plan-phase and
 * execute-phase WITHOUT `--auto`, and their "manual invocation clears the chain" guard must not
 * end the run underneath it. So a plain `set` never downgrades an autonomous hold and a plain
 * `clear` never removes it; only `clear --owner autonomous` (autonomous's own exits) does.
 * An autonomous hold is refreshed at every phase start (`set --owner autonomous`) and lapses
 * AUTONOMOUS_HOLD_TTL_MS after its last refresh, so a run that died without releasing it stops
 * reading active instead of keeping every later session unattended. A chain record has no TTL:
 * the next manual invocation clears it, as before.
 *
 * Surfaced as `gsd-tools auto-chain set|clear|status`; `check auto-mode` (`check-auto-mode.cts`)
 * reads `readAutoChainActive` for its `auto_chain_active` field.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureGsdRunDir, writeJsonAtomic, GSD_RUN_DIRNAME } from './gsd-run-dir.cjs';
import { platformWriteSync } from './shell-command-projection.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspace = require('./planning-workspace.cjs');
const { planningDir, planningRoot, withPlanningLock } = planningWorkspace;
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

/** How long an autonomous hold stays active after its last refresh (one per phase start). */
export const AUTONOMOUS_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

const RUN_DIR_OWNER = Object.freeze({
  label: 'auto-chain state',
  marker: 'auto-chain state',
  rules: Object.freeze([`/${AUTO_CHAIN_DIRNAME}/`]),
});

export interface AutoChainStatus {
  active: boolean;
  /** The planning scope, relative to `.planning/` (posix): `''` for the project root. */
  scope: string;
  /** The state file, relative to the project root (posix). */
  path: string;
  /** Who holds the active record, or null when inactive. */
  owner: AutoChainOwner | null;
  /** When the chain was set (ISO), or null when inactive. */
  since: string | null;
  /** When an autonomous hold lapses unless refreshed (ISO); null for a chain or when inactive. */
  expires_at: string | null;
}

export interface AutoChainChange extends AutoChainStatus {
  /** Whether this call changed the recorded state. */
  changed: boolean;
  /** Set when a plain `clear` left an autonomous hold in place: who still holds it. */
  held_by: AutoChainOwner | null;
  /** Project-relative config files the legacy key was deleted from. */
  legacy_cleaned: string[];
}

type Clock = { now?: () => Date };
const nowOf = (opts: Clock): Date => (opts.now ?? (() => new Date()))();

const toPosix = (p: string): string => p.split(path.sep).join('/');

/** The planning scope `planningDir` resolves for this process, relative to `.planning/`. */
export function autoChainScope(projectDir: string): string {
  return toPosix(path.relative(planningRoot(projectDir), planningDir(projectDir)));
}

/** Absolute path of the scope's state file. */
export function autoChainStatePath(projectDir: string): string {
  const scope = autoChainScope(projectDir);
  return path.join(projectDir, GSD_RUN_DIRNAME, AUTO_CHAIN_DIRNAME, ...scope.split('/').filter(Boolean), STATE_FILENAME);
}

interface Held { owner: AutoChainOwner; since: string | null; touchedAt: string | null }

function statusFor(projectDir: string, held: Held | null): AutoChainStatus {
  const expires = held?.owner === 'autonomous' && held.touchedAt
    ? new Date(Date.parse(held.touchedAt) + AUTONOMOUS_HOLD_TTL_MS).toISOString()
    : null;
  return {
    active: held !== null,
    scope: autoChainScope(projectDir),
    path: toPosix(path.relative(projectDir, autoChainStatePath(projectDir))),
    owner: held?.owner ?? null,
    since: held?.since ?? null,
    expires_at: expires,
  };
}

/**
 * The live record for this scope, or null. Anything unreadable is null, and so is an autonomous
 * hold with no readable refresh time or one older than AUTONOMOUS_HOLD_TTL_MS (`age >= ttl`
 * has lapsed). A record without an owner field is a chain.
 */
function readHeld(projectDir: string, opts: Clock): Held | null {
  const file = autoChainStatePath(projectDir);
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (rec['active'] !== true) return null;
    const owner = rec['owner'] === undefined ? 'chain' : rec['owner'];
    if (!OWNERS.includes(owner as AutoChainOwner)) return null;
    const since = typeof rec['since'] === 'string' ? rec['since'] : null;
    const touchedAt = typeof rec['touched_at'] === 'string' ? rec['touched_at'] : null;
    if (owner === 'autonomous') {
      const touched = touchedAt === null ? NaN : Date.parse(touchedAt);
      if (!Number.isFinite(touched) || nowOf(opts).getTime() - touched >= AUTONOMOUS_HOLD_TTL_MS) return null;
    }
    return { owner: owner as AutoChainOwner, since, touchedAt };
  } catch {
    return null; // absent or unreadable: inactive
  }
}

/** The recorded state for this scope. Never throws; anything unreadable or lapsed is inactive. */
export function readAutoChainState(projectDir: string, opts: Clock = {}): AutoChainStatus {
  return statusFor(projectDir, readHeld(projectDir, opts));
}

export function readAutoChainActive(projectDir: string, opts: Clock = {}): boolean {
  return readHeld(projectDir, opts) !== null;
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

function ensureStateDir(projectDir: string): string {
  const runDir = ensureGsdRunDir(projectDir, RUN_DIR_OWNER);
  const stateDir = path.dirname(autoChainStatePath(projectDir));
  fs.mkdirSync(stateDir, { recursive: true });
  // A link anywhere under .gsd/auto-chain could carry the write out of the run directory.
  const rel = path.relative(fs.realpathSync(runDir), fs.realpathSync(stateDir));
  if (rel.startsWith('..') || path.isAbsolute(rel) || toPosix(rel) !== toPosix(path.relative(runDir, stateDir))) {
    throw new Error('auto-chain state directory is a symlink or resolves outside the run directory');
  }
  return stateDir;
}

/**
 * Record (`active: true`) or clear (`active: false`) the run for this scope, and retire the
 * legacy config key. `owner` is who is asking (default `chain`):
 *   - set chain over a live autonomous hold changes nothing (the hold already covers it);
 *   - set autonomous takes the record (keeping `since` if it already held it) and refreshes it;
 *   - clear chain leaves a live autonomous hold in place and reports it in `held_by`;
 *   - clear autonomous removes the record whoever holds it.
 * Throws when the run directory cannot be used safely (a symlinked `.gsd`).
 */
export function setAutoChain(
  projectDir: string,
  active: boolean,
  opts: Clock & { owner?: AutoChainOwner } = {},
): AutoChainChange {
  const owner = opts.owner ?? 'chain';
  const before = readHeld(projectDir, opts);
  const file = autoChainStatePath(projectDir);
  let after: Held | null = before;
  let heldBy: AutoChainOwner | null = null;
  if (active) {
    const keepsAutonomous = before?.owner === 'autonomous' && owner === 'chain';
    const refresh = owner === 'autonomous' || before === null;
    if (!keepsAutonomous && refresh) {
      const now = nowOf(opts).toISOString();
      after = { owner, since: before?.owner === owner && before.since ? before.since : now, touchedAt: now };
      ensureStateDir(projectDir);
      writeJsonAtomic(file, { active: true, owner, since: after.since, touched_at: now, scope: autoChainScope(projectDir) });
    }
  } else if (before?.owner === 'autonomous' && owner === 'chain') {
    heldBy = 'autonomous';
  } else {
    try {
      fs.unlinkSync(file); // a link is removed, never followed; a lapsed record goes too
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    after = null;
  }
  const legacyCleaned = removeLegacyConfigKey(projectDir);
  return {
    ...statusFor(projectDir, after),
    changed: (before === null) !== (after === null) || before?.owner !== after?.owner,
    held_by: heldBy,
    legacy_cleaned: legacyCleaned,
  };
}

const USAGE = 'Usage: auto-chain <set|clear|status> [--owner chain|autonomous]';

/** `gsd-tools auto-chain set|clear|status [--owner chain|autonomous]` — `--raw` prints `true`/`false`. */
export function cmdAutoChain(cwd: string, args: string[], raw: boolean): void {
  const [subcommand, ...rest] = args;
  let owner: AutoChainOwner = 'chain';
  const extra: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--raw' || arg === '--json') continue;
    if (arg === '--owner' || arg.startsWith('--owner=')) {
      const value = arg === '--owner' ? rest[++i] : arg.slice('--owner='.length);
      if (!OWNERS.includes(value as AutoChainOwner)) {
        error(`auto-chain ${subcommand ?? ''}: --owner must be chain or autonomous. ${USAGE}`, ERROR_REASON.USAGE);
        return;
      }
      owner = value as AutoChainOwner;
      continue;
    }
    extra.push(arg);
  }
  if (extra.length > 0) {
    error(`auto-chain ${subcommand ?? ''}: unexpected argument ${extra[0]}. ${USAGE}`, ERROR_REASON.USAGE);
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
      result = setAutoChain(cwd, subcommand === 'set', { owner });
    } catch (err) {
      error(`auto-chain ${subcommand}: ${(err as Error).message}`);
      return;
    }
    output(result, raw, String(result.active));
    return;
  }
  error(subcommand ? `Unknown auto-chain subcommand: ${subcommand}. ${USAGE}` : USAGE, ERROR_REASON.USAGE);
}
