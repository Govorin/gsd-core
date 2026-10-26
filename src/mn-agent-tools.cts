/**
 * Capability Agent Tools Module (fork, mn) — install-time tool grants that a
 * first-party capability declares for agents it does not own (ADR-5210).
 *
 * A capability's `agentTools: { grants, agents }` is the one place a grant set
 * and the agents it goes to are declared. `stageAgentsForRuntimeWithConverter`
 * (install-profiles.cts) puts these grants first in the list it hands to
 * `appendAgentTools`, ahead of the user's `agent_tools` selectors — the order
 * the grants had when they were written into `agents/*.md` — and the runtime
 * converter then gives them whatever representation it gives any MCP grant.
 *
 * Only the FROZEN first-party registry (`capability-registry.cjs`, generated
 * from `capabilities/<id>/capability.json`) is read, never the installed
 * overlay: a third-party capability can never widen a first-party agent
 * (ADR-1244 D2).
 *
 * A capability with an `activationKey` contributes only while that key
 * resolves true: nearest `.planning/config.json` first, then
 * `$GSD_HOME/.gsd/defaults.json`, then the key's declared default — absent is
 * enabled. The same two files `agent_tools` is read from, so one install sees
 * one answer.
 *
 * Every fs touch goes through the shared install-effort-resolver readers,
 * which route through `installFs()`.
 */
import path from 'node:path';
import os from 'node:os';
import { resolveGsdHome } from './runtime-homes.cjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- install-effort-resolver.cjs is an export= CommonJS module
import installEffortResolver = require('./install-effort-resolver.cjs');
const { _readGsdConfigFile, _findAncestorGsdConfigPath } = installEffortResolver as {
  _readGsdConfigFile: (absPath: string, label: string) => Record<string, unknown> | null;
  _findAncestorGsdConfigPath: (targetDir: string) => string | null;
};

/** agent name -> grants, in declaration order (capability id order, then grant order). */
type AgentToolGrants = Record<string, string[]>;

/** Reads a dotted config key; `undefined` means "not set anywhere". */
type ConfigValueReader = (dottedKey: string) => unknown;

interface ReadOptions {
  homedir?: () => string;
  /** Test seam: a registry object in place of the frozen `capability-registry.cjs`. */
  registry?: unknown;
}

/** The token rule `agent_tools` applies (docs/CONFIGURATION.md "Agent tool grants"). */
function isUsableGrant(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false;
  const value = entry.trim();
  return value.length > 0
    && value === entry
    && !value.endsWith(':')
    && !/[\s\u0000-\u001F\u007F-\u009F,#"'\u2028\u2029]/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Nested (`{ a: { b: v } }`, what `config-set` writes) first, then a flat `"a.b"` key. */
function readDotted(config: Record<string, unknown> | null, dottedKey: string): unknown {
  if (!config) return undefined;
  let node: unknown = config;
  for (const part of dottedKey.split('.')) {
    if (!isPlainObject(node) || !Object.prototype.hasOwnProperty.call(node, part)) {
      node = undefined;
      break;
    }
    node = node[part];
  }
  if (node !== undefined) return node;
  return Object.prototype.hasOwnProperty.call(config, dottedKey) ? config[dottedKey] : undefined;
}

/**
 * Pure: collect every first-party capability's `agentTools` into per-agent
 * grant lists. A capability whose activation key resolves to anything but
 * `false` contributes (absent = enabled); a malformed `agentTools` block or
 * grant contributes nothing rather than half of itself.
 */
function resolveCapabilityAgentTools(registry: unknown, readConfigValue: ConfigValueReader): AgentToolGrants {
  const result: AgentToolGrants = Object.create(null) as AgentToolGrants;
  const capabilities = isPlainObject(registry) && isPlainObject(registry['capabilities']) ? registry['capabilities'] : {};
  for (const id of Object.keys(capabilities).sort()) {
    const cap = capabilities[id];
    if (!isPlainObject(cap) || !isPlainObject(cap['agentTools'])) continue;
    const { grants, agents } = cap['agentTools'];
    if (!Array.isArray(grants) || !grants.every(isUsableGrant)) continue;
    if (!Array.isArray(agents) || !agents.every((a) => typeof a === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(a))) continue;

    const activationKey = typeof cap['activationKey'] === 'string' ? cap['activationKey'] : null;
    if (activationKey !== null) {
      const configured = readConfigValue(activationKey);
      const declared = isPlainObject(cap['config']) && isPlainObject(cap['config'][activationKey])
        ? cap['config'][activationKey]['default']
        : undefined;
      const effective = configured !== undefined ? configured : declared;
      if (effective === false) continue;
    }

    for (const agent of agents as string[]) {
      const list = result[agent] ?? (result[agent] = []);
      for (const grant of grants) if (!list.includes(grant)) list.push(grant);
    }
  }
  return result;
}

/**
 * The grants for one staged agent file stem. A `.compact` variant is the same
 * agent with a shorter body (ADR-4139), so it gets the same grants.
 */
function grantsForAgent(grants: AgentToolGrants | null, agentName: string): string[] {
  if (!grants) return [];
  const base = agentName.endsWith('.compact') ? agentName.slice(0, -'.compact'.length) : agentName;
  return Object.prototype.hasOwnProperty.call(grants, base) ? grants[base] : [];
}

/**
 * Impure entry point for the installer: the frozen registry plus the two
 * config files, resolved for the install rooted at `targetDir` (walks up to
 * the nearest `.planning/`; `null` reads only the global defaults).
 */
function readCapabilityAgentTools(targetDir: string | null = null, options: ReadOptions = {}): AgentToolGrants {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- generated first-party registry, loaded at call time
  const registry: unknown = options.registry !== undefined ? options.registry : (require('./capability-registry.cjs') as unknown);
  const home = resolveGsdHome(options.homedir ? options.homedir() : os.homedir());
  let globalConfig: Record<string, unknown> | null | undefined;
  let projectConfig: Record<string, unknown> | null | undefined;
  const readConfigValue: ConfigValueReader = (dottedKey) => {
    if (projectConfig === undefined) {
      const candidate = targetDir ? _findAncestorGsdConfigPath(targetDir) : null;
      projectConfig = candidate ? _readGsdConfigFile(candidate, 'project config') : null;
    }
    const fromProject = readDotted(projectConfig, dottedKey);
    if (fromProject !== undefined) return fromProject;
    if (globalConfig === undefined) {
      globalConfig = _readGsdConfigFile(path.join(home, '.gsd', 'defaults.json'), 'global defaults');
    }
    return readDotted(globalConfig, dottedKey);
  };
  return resolveCapabilityAgentTools(registry, readConfigValue);
}

export = {
  resolveCapabilityAgentTools,
  readCapabilityAgentTools,
  grantsForAgent,
};
