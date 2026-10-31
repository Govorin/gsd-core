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
  /** When the chain was set (ISO), or null when inactive. */
  since: string | null;
}

export interface AutoChainChange extends AutoChainStatus {
  /** Whether this call changed the recorded state. */
  changed: boolean;
  /** Project-relative config files the legacy key was deleted from. */
  legacy_cleaned: string[];
}

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

function statusFor(projectDir: string, active: boolean, since: string | null): AutoChainStatus {
  return {
    active,
    scope: autoChainScope(projectDir),
    path: toPosix(path.relative(projectDir, autoChainStatePath(projectDir))),
    since: active ? since : null,
  };
}

/** The recorded state for this scope. Never throws; anything unreadable is inactive. */
export function readAutoChainState(projectDir: string): AutoChainStatus {
  const file = autoChainStatePath(projectDir);
  try {
    if (!fs.lstatSync(file).isFile()) return statusFor(projectDir, false, null);
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>)['active'] === true) {
      const since = (parsed as Record<string, unknown>)['since'];
      return statusFor(projectDir, true, typeof since === 'string' ? since : null);
    }
  } catch {
    // absent or unreadable: inactive
  }
  return statusFor(projectDir, false, null);
}

export function readAutoChainActive(projectDir: string): boolean {
  return readAutoChainState(projectDir).active;
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
 * Record (`active: true`) or clear (`active: false`) the chain for this scope, and retire the
 * legacy config key. Throws when the run directory cannot be used safely (a symlinked `.gsd`).
 */
export function setAutoChain(
  projectDir: string,
  active: boolean,
  opts: { now?: () => Date } = {},
): AutoChainChange {
  const before = readAutoChainState(projectDir);
  const file = autoChainStatePath(projectDir);
  let since: string | null = before.since;
  if (active) {
    if (!before.active) {
      since = (opts.now ?? (() => new Date()))().toISOString();
      ensureStateDir(projectDir);
      writeJsonAtomic(file, { active: true, since, scope: autoChainScope(projectDir) });
    }
  } else {
    try {
      fs.unlinkSync(file); // a link is removed, never followed
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const legacyCleaned = removeLegacyConfigKey(projectDir);
  return {
    ...statusFor(projectDir, active, since),
    changed: before.active !== active,
    legacy_cleaned: legacyCleaned,
  };
}

const USAGE = 'Usage: auto-chain <set|clear|status>';

/** `gsd-tools auto-chain set|clear|status` — `--raw` prints `true`/`false`. */
export function cmdAutoChain(cwd: string, args: string[], raw: boolean): void {
  const [subcommand, ...rest] = args;
  const extra = rest.filter((a) => a !== '--raw' && a !== '--json');
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
      result = setAutoChain(cwd, subcommand === 'set');
    } catch (err) {
      error(`auto-chain ${subcommand}: ${(err as Error).message}`);
      return;
    }
    output(result, raw, String(result.active));
    return;
  }
  error(subcommand ? `Unknown auto-chain subcommand: ${subcommand}. ${USAGE}` : USAGE, ERROR_REASON.USAGE);
}
