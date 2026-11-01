/**
 * Tool preflight (LG-01): does the agent that will execute a plan hold the tools the plan's tasks
 * name?
 *
 * A plan that drives a design file (`.pen` → Pencil MCP) or names an MCP tool (`mcp__<server>__…`)
 * cannot be carried out by an executor whose installed `tools:` line lacks that grant. Orchestrators
 * met that by spawning `general-purpose` instead of `gsd-executor` — the prohibition was prose only
 * (`execute-phase.md`, `quick.md`) — and the substituted agent ran without the executor's contract.
 * This module answers the question before execution so the answer can stop the run instead:
 *
 *   - `verify plan-structure` carries the result as `tool_preflight` (a warning at planning time);
 *   - `verify tool-preflight <plan>` is the typed verb `/gsd-quick` reads before its executor spawn;
 *   - `check mn-tool-preflight <phase>` is the execute:pre gate that halts `/gsd-execute-phase`;
 *
 * What the agent holds is read from the INSTALLED agent file, the way the installer writes it and
 * the runtime reads it — not from canonical `agents/*.md`, which carries no install-time grants
 * (ADR-5210, upstream #4032). Claude Code resolves a project agent (the project's `.claude` dir)
 * ahead of the user's (the global Claude config dir, honouring CLAUDE_CONFIG_DIR); other runtimes go through
 * `getAgentsDir` (manifest-backed project install, else the runtime's global directory).
 * `GSD_AGENTS_DIR`, when set, is the only directory read.
 *
 * Could-not-look is never a pass: no installed file, an unreadable file, or a format with no
 * `tools:` list GSD can read (Codex TOML, a non-Claude `.md` with no `tools:` key) is status
 * `unknown`, with the reason and the paths searched. A Claude agent file with no `tools:` key
 * inherits every tool (Claude Code's documented default), so nothing it needs can be missing.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
import frontmatterMod = require('./frontmatter.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- agent-install-check.cjs is an export= CommonJS module
import agentInstallCheck = require('./agent-install-check.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- install-model-override-resolver.cjs is an export= CommonJS module
import installModelOverrideResolver = require('./install-model-override-resolver.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import ioMod = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
import { getGlobalConfigDir } from './runtime-homes.cjs';
import { getDirName, NO_LOCAL_CONFIG_DIR_SENTINEL } from './runtime-name-policy.cjs';
import { resolveRuntime } from './runtime-slash.cjs';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { listPhasePlans } from './gate-mn-plan-status.cjs';
import { extractTaggedBlocks } from './markdown-sectionizer.cjs';

const { extractFrontmatter, stripFrontmatter } = frontmatterMod;
const { getAgentsDir, resolveAgentHint } = agentInstallCheck;
const { readGsdEffectiveAgentTools } = installModelOverrideResolver;
const { output, error } = ioMod;
const { planningDir } = planningWorkspace;

/** The executor every plan runs under unless a resolvable `agent_hint` names another. */
export const DEFAULT_EXECUTOR_AGENT = 'gsd-executor';

export const PREFLIGHT_STATUS = Object.freeze({
  /** Every tool the plan names is granted (or the plan names none). */
  OK: 'ok',
  /** At least one named tool is not granted by the installed agent. */
  MISSING: 'missing',
  /** The plan names tools, but the installed agent's grants could not be read. */
  UNKNOWN: 'unknown',
} as const);
export type PreflightStatus = (typeof PREFLIGHT_STATUS)[keyof typeof PREFLIGHT_STATUS];

/** How a requirement was recognised in the plan. */
export const REQUIREMENT_SOURCE = Object.freeze({
  MCP_NAME: 'mcp-name',
  PEN_FILE: 'pen-file',
  TOOL_NAME: 'tool-name',
} as const);
export type RequirementSource = (typeof REQUIREMENT_SOURCE)[keyof typeof REQUIREMENT_SOURCE];

/**
 * Built-in tools the executor does not hold by default, recognised when a plan names them. The list
 * is closed on purpose: a CamelCase name that is also an English word (`Agent`, `Task`) would turn
 * prose into requirements.
 */
export const KNOWN_TOOL_NAMES: readonly string[] = Object.freeze(['WebFetch', 'WebSearch', 'NotebookEdit', 'AskUserQuestion']);

/** The MCP server a `.pen` file is driven through (pen.dev's Pencil app). */
const PEN_MCP_SERVER = 'pencil';

export interface RequiredTool {
  /** The tool the plan needs: an exact name, or `mcp__<server>__*` for "some tool of that server". */
  tool: string;
  source: RequirementSource;
  /** Where it was seen: `tasks`, `context` or `files_modified`. */
  where: string;
  /** The text that produced it (a tool name or a `.pen` path), for the message. */
  evidence: string;
}

export type InstalledAgentTools =
  | { kind: 'found'; file: string; scope: AgentFileScope; tools: string[] | 'all' }
  | { kind: 'unknown'; reason: string; searched: string[]; file: string | null };

export type AgentFileScope = 'project' | 'global' | 'override';

export interface PreflightFix {
  agent: string;
  /** The grants to add — a server wildcard for an MCP requirement, the name for a built-in. */
  grants: string[];
  /** `true` when `agent_tools` already holds every grant: only the reinstall is missing. */
  already_configured: boolean;
  /** The project selector's value after the fix (existing entries kept). */
  agent_tools: Record<string, string[]>;
  config_set: string;
  reinstall: string;
  /** The first-party alternative (ADR-5210): declare the grants in a capability's `agentTools`. */
  capability: string;
}

export interface ToolPreflight {
  plan: string;
  agent: string;
  agent_source: 'default' | 'agent_hint' | 'explicit';
  status: PreflightStatus;
  required: RequiredTool[];
  missing: string[];
  agent_file: string | null;
  /** Where `agent_file` was found: decides `--local` / `--global` in the reinstall. */
  agent_scope: AgentFileScope | null;
  runtime: string;
  reason: string | null;
  message: string;
  fix: PreflightFix | null;
}

// ─── Requirement extraction ──────────────────────────────────────────────────

const MCP_TOKEN_RE = /(?<![A-Za-z0-9_])mcp__[A-Za-z0-9_*-]+/g;
const PEN_PATH_RE = /(?<![A-Za-z0-9_.-])((?:[\w@~.-]+\/)*[\w@~-][\w@~.-]*\.pen)(?![A-Za-z0-9_-])/g;
const KNOWN_TOOL_RE = new RegExp(`(?<![A-Za-z0-9_])(${KNOWN_TOOL_NAMES.join('|')})(?![A-Za-z0-9_])`, 'g');

/** `mcp__srv__tool` → `{server, tool}`; `mcp__srv`, `mcp__srv__`, `mcp__srv__*` → whole-server. */
function splitMcpName(raw: string): { server: string; tool: string | null } | null {
  const body = raw.replace(/[_-]+$/, '').slice('mcp__'.length);
  if (body.length === 0) return null;
  const sep = body.indexOf('__');
  const server = sep === -1 ? body : body.slice(0, sep);
  if (server.length === 0 || server.includes('*')) return null;
  const tool = sep === -1 ? '' : body.slice(sep + 2);
  return { server, tool: tool === '' || tool === '*' ? null : tool };
}

function mcpRequirement(raw: string): string | null {
  const parts = splitMcpName(raw);
  if (parts === null) return null;
  return parts.tool === null ? `mcp__${parts.server}__*` : `mcp__${parts.server}__${parts.tool}`;
}

function scanText(text: string, where: string, add: (r: RequiredTool) => void): void {
  for (const m of text.matchAll(MCP_TOKEN_RE)) {
    const tool = mcpRequirement(m[0]);
    if (tool !== null) add({ tool, source: REQUIREMENT_SOURCE.MCP_NAME, where, evidence: m[0].replace(/[_-]+$/, '') });
  }
  for (const m of text.matchAll(PEN_PATH_RE)) {
    add({ tool: `mcp__${PEN_MCP_SERVER}__*`, source: REQUIREMENT_SOURCE.PEN_FILE, where, evidence: m[1] });
  }
  for (const m of text.matchAll(KNOWN_TOOL_RE)) {
    add({ tool: m[1], source: REQUIREMENT_SOURCE.TOOL_NAME, where, evidence: m[1] });
  }
}

function filesModifiedList(fm: Record<string, unknown>): string[] {
  const raw = fm['files_modified'];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw === 'string') return raw.split(/[\s,]+/).filter(Boolean);
  return [];
}

/**
 * The tools a plan's executor needs, read from what the executor acts on: the `<tasks>` region, the
 * `<context>` region it reads, and the `files_modified` it writes. A plan without a `<tasks>` region
 * is scanned whole after its frontmatter. The objective's prose ("not doing: touch design.pen") is
 * not a requirement. One entry per tool; the first sighting is kept as evidence.
 */
export function extractRequiredTools(content: string): RequiredTool[] {
  const text = typeof content === 'string' ? content : '';
  const seen = new Map<string, RequiredTool>();
  const add = (r: RequiredTool): void => {
    if (!seen.has(r.tool)) seen.set(r.tool, r);
  };
  const tasks = extractTaggedBlocks(text, 'tasks');
  if (tasks.length > 0) {
    for (const region of tasks) scanText(region, 'tasks', add);
  } else {
    scanText(stripFrontmatter(text), 'tasks', add);
  }
  for (const region of extractTaggedBlocks(text, 'context', true)) scanText(region, 'context', add);
  let fm: Record<string, unknown> = {};
  try {
    fm = extractFrontmatter(text);
  } catch {
    fm = {};
  }
  scanText(filesModifiedList(fm).join('\n'), 'files_modified', add);
  return [...seen.values()];
}

// ─── Grant matching ──────────────────────────────────────────────────────────

/** A `tools:` frontmatter value → the grant list (`"A, B"` or a YAML sequence), or `null` if absent. */
export function parseToolsField(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const items: unknown[] = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return items
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim().replace(/^["']|["']$/g, '').trim())
    .filter((v) => v.length > 0);
}

function globMatches(pattern: string, name: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return re.test(name);
}

/** Does `grant` (an installed `tools:` entry) satisfy `requirement`? */
export function grantCovers(grant: string, requirement: string): boolean {
  if (grant === '*' || grant === requirement) return true;
  const req = requirement.startsWith('mcp__') ? splitMcpName(requirement) : null;
  if (req !== null) {
    const serverPrefix = `mcp__${req.server}__`;
    // `mcp__<server>` (no tool part) is a whole-server grant.
    if (grant === `mcp__${req.server}`) return true;
    if (req.tool === null) {
      // "Some tool of the server": any grant inside the server's namespace, or a wildcard that
      // spans it (`mcp__*`).
      if (grant.startsWith(serverPrefix)) return true;
      return grant.endsWith('*') && serverPrefix.startsWith(grant.slice(0, -1));
    }
  }
  return grant.includes('*') && globMatches(grant, requirement);
}

export function isGranted(requirement: string, tools: string[] | 'all'): boolean {
  if (tools === 'all') return true;
  return tools.some((grant) => grantCovers(grant, requirement));
}

/** The grant that fixes a missing requirement: the server wildcard for MCP, the name otherwise. */
export function suggestedGrant(requirement: string): string {
  const parts = requirement.startsWith('mcp__') ? splitMcpName(requirement) : null;
  return parts === null ? requirement : `mcp__${parts.server}__*`;
}

// ─── Installed agent resolution ──────────────────────────────────────────────

interface AgentDir {
  dir: string;
  scope: AgentFileScope;
}

function candidateAgentDirs(runtime: string, projectRoot: string): AgentDir[] {
  const override = process.env['GSD_AGENTS_DIR'];
  if (override) return [{ dir: override, scope: 'override' }];
  const dirs: AgentDir[] = [];
  const localName = getDirName(runtime);
  if (runtime === 'claude' && localName !== NO_LOCAL_CONFIG_DIR_SENTINEL) {
    // Claude Code's own precedence: the project agent shadows the user agent of the same name.
    dirs.push({ dir: path.join(projectRoot, localName, 'agents'), scope: 'project' });
  } else {
    const resolved = getAgentsDir(runtime, projectRoot);
    const global = path.join(getGlobalConfigDir(runtime), 'agents');
    if (path.resolve(resolved) !== path.resolve(global)) dirs.push({ dir: resolved, scope: 'project' });
  }
  dirs.push({ dir: path.join(getGlobalConfigDir(runtime), 'agents'), scope: 'global' });
  return dirs;
}

function readTextFile(file: string): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    return { ok: false, reason: (err as NodeJS.ErrnoException).code ?? 'unreadable' };
  }
}

/**
 * The tools the runtime will give `agent`, read from its installed file. The first directory that
 * holds the agent decides (see the module comment for the order); a later directory never rescues
 * an unreadable earlier one, since the runtime would not either.
 */
export function readInstalledAgentTools(agent: string, runtime: string, projectRoot: string): InstalledAgentTools {
  const searched: string[] = [];
  for (const { dir, scope } of candidateAgentDirs(runtime, projectRoot)) {
    for (const name of [`${agent}.md`, `${agent}.agent.md`, `${agent}.toml`]) {
      const file = path.join(dir, name);
      searched.push(file);
      if (!fs.existsSync(file)) continue;
      if (name.endsWith('.toml')) {
        return { kind: 'unknown', file, searched, reason: `${file} is a TOML agent: it carries no tools: list GSD can compare` };
      }
      const read = readTextFile(file);
      if (!read.ok) return { kind: 'unknown', file, searched, reason: `${file} could not be read (${read.reason})` };
      let fm: Record<string, unknown>;
      try {
        fm = extractFrontmatter(read.text, file);
      } catch {
        return { kind: 'unknown', file, searched, reason: `${file} has frontmatter GSD could not parse` };
      }
      const tools = parseToolsField(fm['tools']);
      if (tools === null) {
        if (runtime === 'claude') return { kind: 'found', file, scope, tools: 'all' };
        return { kind: 'unknown', file, searched, reason: `${file} has no tools: key, and ${runtime} does not document what that grants` };
      }
      return { kind: 'found', file, scope, tools };
    }
  }
  return {
    kind: 'unknown',
    file: null,
    searched,
    reason: `no installed ${agent} agent for ${runtime} — install GSD for this runtime first`,
  };
}

// ─── Plan preflight ──────────────────────────────────────────────────────────

/** Read `workflow.agent_hint_routing` (default ON) from the project config. */
function agentHintRoutingEnabled(projectRoot: string): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(planningDir(projectRoot), 'config.json'), 'utf8')) as Record<string, unknown>;
    const workflow = raw['workflow'];
    if (workflow && typeof workflow === 'object' && !Array.isArray(workflow)) {
      return (workflow as Record<string, unknown>)['agent_hint_routing'] !== false;
    }
  } catch {
    // Absent or unreadable config: the key's default.
  }
  return true;
}

/** The agent `execute-phase` would dispatch for a plan (its `agent_hint` when it resolves). */
export function resolvePlanAgent(
  fm: Record<string, unknown>,
  runtime: string,
  projectRoot: string,
): { agent: string; source: 'default' | 'agent_hint' } {
  const hint = typeof fm['agent_hint'] === 'string' ? fm['agent_hint'].trim() : '';
  if (hint !== '' && agentHintRoutingEnabled(projectRoot)) {
    const resolved = resolveAgentHint(hint, runtime, projectRoot);
    if (resolved !== null) return { agent: resolved, source: 'agent_hint' };
  }
  return { agent: DEFAULT_EXECUTOR_AGENT, source: 'default' };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPreflightFix(agent: string, missing: string[], runtime: string, projectRoot: string, scope: AgentFileScope | null): PreflightFix {
  const grants = [...new Set(missing.map(suggestedGrant))];
  let effective: Record<string, string[]> = {};
  try {
    effective = readGsdEffectiveAgentTools(projectRoot) ?? {};
  } catch {
    effective = {};
  }
  const configured = [...(effective['*'] ?? []), ...(effective[agent] ?? [])];
  const alreadyConfigured = missing.every((req) => configured.some((g) => grantCovers(g, req)));
  const selector = [...(effective[agent] ?? [])];
  for (const g of grants) if (!selector.includes(g)) selector.push(g);
  const installScope = scope === 'project' ? '--local' : '--global';
  return {
    agent,
    grants,
    already_configured: alreadyConfigured,
    agent_tools: { [agent]: selector },
    config_set: `gsd-tools config-set agent_tools.${agent} ${shellQuote(JSON.stringify(selector))}`,
    reinstall: `gsd-core --${runtime} ${installScope}`,
    capability: `or, for a grant every install of this fork should carry, add ${grants.join(', ')} to a first-party capability's agentTools.grants and ${agent} to its agentTools.agents (ADR-5210)`,
  };
}

export interface PreflightOptions {
  /** Project root (gsd-tools' cwd). */
  projectRoot: string;
  /** Plan label for messages (a file name or id). */
  plan: string;
  /** Force the agent (quick always runs gsd-executor); otherwise resolved from `agent_hint`. */
  agent?: string;
  /** Runtime override; defaults to the project's resolved runtime. */
  runtime?: string;
}

/** Preflight one plan's text. Pure apart from reading the installed agent file and the config. */
export function preflightPlanContent(content: string, opts: PreflightOptions): ToolPreflight {
  const runtime = opts.runtime ?? resolveRuntime(opts.projectRoot);
  let fm: Record<string, unknown> = {};
  try {
    fm = extractFrontmatter(content);
  } catch {
    fm = {};
  }
  const chosen = opts.agent
    ? { agent: opts.agent, source: 'explicit' as const }
    : resolvePlanAgent(fm, runtime, opts.projectRoot);
  const required = extractRequiredTools(content);
  const base = {
    plan: opts.plan,
    agent: chosen.agent,
    agent_source: chosen.source,
    required,
    runtime,
  };
  if (required.length === 0) {
    return { ...base, status: PREFLIGHT_STATUS.OK, missing: [], agent_file: null, agent_scope: null, reason: null, fix: null, message: `${opts.plan}: names no tool beyond the executor's own` };
  }
  const installed = readInstalledAgentTools(chosen.agent, runtime, opts.projectRoot);
  if (installed.kind === 'unknown') {
    return {
      ...base,
      status: PREFLIGHT_STATUS.UNKNOWN,
      missing: [],
      agent_file: installed.file,
      agent_scope: null,
      reason: installed.reason,
      fix: null,
      message: `${opts.plan}: needs ${required.map((r) => r.tool).join(', ')}, but whether ${chosen.agent} holds them is unknown: ${installed.reason}`,
    };
  }
  const missing = required.filter((r) => !isGranted(r.tool, installed.tools)).map((r) => r.tool);
  if (missing.length === 0) {
    return { ...base, status: PREFLIGHT_STATUS.OK, missing, agent_file: installed.file, agent_scope: installed.scope, reason: null, fix: null, message: `${opts.plan}: ${chosen.agent} (${installed.file}) grants every tool the plan names` };
  }
  const fix = buildPreflightFix(chosen.agent, missing, runtime, opts.projectRoot, installed.scope);
  const evidence = required
    .filter((r) => missing.includes(r.tool))
    .map((r) => (r.evidence === r.tool ? r.tool : `${r.tool} (${r.evidence})`))
    .join(', ');
  const steps = fix.already_configured ? fix.reinstall : `${fix.config_set} && ${fix.reinstall}`;
  return {
    ...base,
    status: PREFLIGHT_STATUS.MISSING,
    missing,
    agent_file: installed.file,
    agent_scope: installed.scope,
    reason: null,
    fix,
    message:
      `${opts.plan}: needs ${evidence}, which ${chosen.agent} (${installed.file}) does not grant. ` +
      `Grant it — ${steps} — then re-run; never execute the plan under a different agent type.`,
  };
}

/** The preflight of every plan in `phaseDir` that has no SUMMARY yet, or the reason it could not be read. */
export function preflightIncompletePlans(projectDir: string, phaseDir: string): { results: ToolPreflight[] } | { unreadable: string } {
  const listed = listPhasePlans(phaseDir);
  if ('unreadable' in listed) return { unreadable: listed.unreadable };
  const results: ToolPreflight[] = [];
  for (const plan of listed.plans) {
    if (!listed.unsummarized.has(plan)) continue;
    const read = readPlanFile(path.join(phaseDir, plan));
    if (!read.ok) return { unreadable: `${plan} could not be read (${read.reason})` };
    results.push(preflightPlanContent(read.content, { projectRoot: projectDir, plan }));
  }
  return { results };
}

export type PlanFileRead = { ok: true; content: string } | { ok: false; reason: string };

export function readPlanFile(file: string): PlanFileRead {
  const read = readTextFile(file);
  return read.ok ? { ok: true, content: read.text } : { ok: false, reason: read.reason };
}

/**
 * `verify tool-preflight <plan-file> [--agent <name>]` — the preflight of one plan as JSON. Exit 0
 * whatever the status: the caller reads `status` (`ok` | `missing` | `unknown`). A missing or
 * unreadable plan file is a usage error.
 */
export function cmdVerifyToolPreflight(cwd: string, args: readonly string[], raw: boolean): void {
  let planArg: string | undefined;
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--agent') {
      agent = args[i + 1];
      i++;
    } else if (arg.startsWith('--agent=')) {
      agent = arg.slice('--agent='.length);
    } else if (!arg.startsWith('-') && planArg === undefined) {
      planArg = arg;
    }
  }
  if (!planArg) return error('Usage: verify tool-preflight <plan-file> [--agent <name>]');
  if (agent !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent)) {
    return error(`verify tool-preflight: --agent must be a bare agent name, got ${JSON.stringify(agent)}`);
  }
  const contained = tryWithinRoot(planArg, cwd, PathAcceptance.AbsoluteInsideRoot);
  if (contained === null) return error(`verify tool-preflight: ${planArg} is outside the project`);
  const read = readPlanFile(String(contained));
  if (!read.ok) return error(`verify tool-preflight: cannot read ${planArg} (${read.reason})`);
  const result = preflightPlanContent(read.content, { projectRoot: cwd, plan: path.basename(planArg), agent });
  output(result, raw, result.status);
}
