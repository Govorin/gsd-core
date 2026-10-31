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
 * A block may also name `reference`: a file in `gsd-core/references/` that
 * says when to use the grants. Each agent that gets the grants then gets one
 * pointer line at the end of its body, naming the grants and the file (ADR-5210
 * amendment, 2026-11-01). The pointer is added before the path rewrites, so
 * every runtime sees its own path, and it rides the same activation key as the
 * grants: on together, off together. `agents/*.md` stays upstream's bytes.
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

/** One capability's pointer for one agent: the grants it names and the reference file. */
interface AgentReference {
  capability: string;
  grants: string[];
  reference: string;
}

/** agent name -> pointers, in capability id order. */
type AgentReferences = Record<string, AgentReference[]>;

/** A validated, active `agentTools` block. */
interface ActiveBlock {
  id: string;
  grants: string[];
  agents: string[];
  reference: string | null;
}

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

/** A file name directly in `gsd-core/references/`: no directory part, no traversal. */
function isUsableReference(entry: unknown): entry is string {
  return typeof entry === 'string' && /^[a-z0-9][a-z0-9-]*\.md$/.test(entry);
}

/**
 * Pure: every first-party capability's `agentTools` block that is well-formed
 * and active, in capability id order. A capability whose activation key
 * resolves to anything but `false` contributes (absent = enabled); a malformed
 * block — a bad grant, agent name or reference — contributes nothing rather
 * than half of itself.
 */
function activeAgentToolBlocks(registry: unknown, readConfigValue: ConfigValueReader): ActiveBlock[] {
  const blocks: ActiveBlock[] = [];
  const capabilities = isPlainObject(registry) && isPlainObject(registry['capabilities']) ? registry['capabilities'] : {};
  for (const id of Object.keys(capabilities).sort()) {
    const cap = capabilities[id];
    if (!isPlainObject(cap) || !isPlainObject(cap['agentTools'])) continue;
    const { grants, agents, reference } = cap['agentTools'];
    if (!Array.isArray(grants) || !grants.every(isUsableGrant)) continue;
    if (!Array.isArray(agents) || !agents.every((a) => typeof a === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(a))) continue;
    if (reference !== undefined && !isUsableReference(reference)) continue;

    const activationKey = typeof cap['activationKey'] === 'string' ? cap['activationKey'] : null;
    if (activationKey !== null) {
      const configured = readConfigValue(activationKey);
      const declared = isPlainObject(cap['config']) && isPlainObject(cap['config'][activationKey])
        ? cap['config'][activationKey]['default']
        : undefined;
      const effective = configured !== undefined ? configured : declared;
      // Read as capability activation reads it (_resolveActivationValue: Boolean of the
      // resolved value), so 0, "" or null disable the grants just as they mark the
      // capability inactive; only an absent key falls through to enabled.
      if (effective !== undefined && !effective) continue;
    }

    blocks.push({ id, grants, agents: agents as string[], reference: reference ?? null });
  }
  return blocks;
}

/** Pure: per-agent grant lists from the active blocks; a grant two blocks share is kept once. */
function resolveCapabilityAgentTools(registry: unknown, readConfigValue: ConfigValueReader): AgentToolGrants {
  const result: AgentToolGrants = Object.create(null) as AgentToolGrants;
  for (const { grants, agents } of activeAgentToolBlocks(registry, readConfigValue)) {
    for (const agent of agents) {
      const list = result[agent] ?? (result[agent] = []);
      for (const grant of grants) if (!list.includes(grant)) list.push(grant);
    }
  }
  return result;
}

/** Pure: per-agent pointers from the active blocks that name a reference. */
function resolveCapabilityAgentReferences(registry: unknown, readConfigValue: ConfigValueReader): AgentReferences {
  const result: AgentReferences = Object.create(null) as AgentReferences;
  for (const { id, grants, agents, reference } of activeAgentToolBlocks(registry, readConfigValue)) {
    if (reference === null) continue;
    for (const agent of agents) {
      (result[agent] ?? (result[agent] = [])).push({ capability: id, grants: [...grants], reference });
    }
  }
  return result;
}

/** A `.compact` variant is the same agent with a shorter body (ADR-4139). */
function baseAgentName(agentName: string): string {
  return agentName.endsWith('.compact') ? agentName.slice(0, -'.compact'.length) : agentName;
}

/** The grants for one staged agent file stem; a `.compact` variant gets its agent's. */
function grantsForAgent(grants: AgentToolGrants | null, agentName: string): string[] {
  if (!grants) return [];
  const base = baseAgentName(agentName);
  return Object.prototype.hasOwnProperty.call(grants, base) ? grants[base] : [];
}

/** The pointers for one staged agent file stem; a `.compact` variant gets its agent's. */
function referencesForAgent(references: AgentReferences | null, agentName: string): AgentReference[] {
  if (!references) return [];
  const base = baseAgentName(agentName);
  return Object.prototype.hasOwnProperty.call(references, base) ? references[base] : [];
}

/** The one line a pointer renders to. `~/.claude/` is rewritten per runtime by the path step after it. */
function renderReferencePointer({ grants, reference }: AgentReference): string {
  const tools = grants.map((grant) => `\`${grant}\``).join(', ');
  return `**Granted at install:** if your tools include ${tools}, Read \`~/.claude/gsd-core/references/${reference}\` before you start; it says when to use them.`;
}

/**
 * Append one pointer line per reference at the end of the agent body, after a
 * blank line, in the content's own line ending. No references: the content is
 * returned unchanged, byte for byte.
 */
function appendAgentReferences(content: string, references: AgentReference[]): string {
  if (references.length === 0) return content;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const body = content.endsWith(eol) ? content : content + eol;
  return body + eol + references.map(renderReferencePointer).join(eol) + eol;
}

/**
 * The frozen registry (or the test seam's) and a config reader resolved for
 * the install rooted at `targetDir` (walks up to the nearest `.planning/`;
 * `null` reads only the global defaults). Each file is read at most once.
 */
function installContext(targetDir: string | null, options: ReadOptions): { registry: unknown; readConfigValue: ConfigValueReader } {
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
  return { registry, readConfigValue };
}

/** Impure entry point for the installer: the grants, per agent. */
function readCapabilityAgentTools(targetDir: string | null = null, options: ReadOptions = {}): AgentToolGrants {
  const { registry, readConfigValue } = installContext(targetDir, options);
  return resolveCapabilityAgentTools(registry, readConfigValue);
}

/** Impure entry point for the installer: the reference pointers, per agent. */
function readCapabilityAgentReferences(targetDir: string | null = null, options: ReadOptions = {}): AgentReferences {
  const { registry, readConfigValue } = installContext(targetDir, options);
  return resolveCapabilityAgentReferences(registry, readConfigValue);
}

export = {
  resolveCapabilityAgentTools,
  resolveCapabilityAgentReferences,
  readCapabilityAgentTools,
  readCapabilityAgentReferences,
  grantsForAgent,
  referencesForAgent,
  appendAgentReferences,
};
