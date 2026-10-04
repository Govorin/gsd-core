/**
 * Retro inventory — what guardrails a project already has, so `/gsd-retro`
 * never proposes a check that exists and always notices one that exists but
 * is not wired in.
 *
 * Read-only and deterministic. It reports, per class, what is present:
 * package scripts (lint/check/test/typecheck/format), CI workflows, pre-commit
 * tooling and whether a git hook is actually installed, lint configs and
 * repo-local lint rules, Claude Code hooks from `.claude/settings*.json`,
 * capability gates and whether each is active, `workflow.verify_gates`,
 * `agent_skills`, project skills, steering-file sizes (CLAUDE.md, AGENTS.md),
 * and — when a rules registry sits beside the project — the rules that live
 * only in prose.
 *
 * Two finding kinds carry the retro's first-class signal (Pocock: an unwired
 * or broken existing check IS the finding; a repo with no guardrail is too):
 *   - `missing-guardrail`: a class with nothing in it (no lint script, no CI,
 *     no pre-commit, no verify gates …);
 *   - `unwired-check`: a check that exists but nothing runs it (a lint script
 *     no CI job or hook reaches, a local lint rule no config names, a
 *     pre-commit config with no installed git hook).
 *
 * Text is never copied out wholesale: commands are `excerpt()`ed (redacted,
 * capped), rule texts are not copied at all — ids only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { assertWithinRoot, PathAcceptance } from './security.cjs';
import { excerpt } from './session-transcript.cjs';
import { escapeRegex } from './pattern.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import verifyGatesModule = require('./verify-gates.cjs');
const { readChecks } = verifyGatesModule;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScriptClass = 'lint' | 'check' | 'test' | 'typecheck' | 'format';

export interface ScriptEntry {
  name: string;
  class: ScriptClass;
  command: string;
  /** Reached from CI, a pre-commit config, or another wired script. */
  wired: boolean;
}

export interface LocalLintRule {
  name: string;
  file: string;
  /** Named in a lint config file. */
  wired: boolean;
}

export interface ClaudeHookEntry {
  source: string;
  event: string;
  matcher: string | null;
  command: string;
  /** A GSD-managed hook (`gsd-*.js|sh`). */
  gsdManaged: boolean;
}

export interface CapabilityGateEntry {
  capability: string;
  /** The capability is active in this project (installed, surfaced, activated). */
  active: boolean | null;
  point: string;
  check: string;
  when: string | null;
  /** The raw project config value of `when`, `null` when unset. */
  whenValue: unknown;
  blocking: boolean;
}

export interface InventoryFinding {
  kind: 'missing-guardrail' | 'unwired-check';
  subject: string;
  detail: string;
}

export interface RetroInventory {
  scripts: { packageJson: boolean; entries: ScriptEntry[] };
  ci: { files: string[] };
  precommit: { tools: string[]; gitHookInstalled: boolean | null; hooksPath: string | null };
  lint: { configs: string[]; localRules: LocalLintRule[] };
  claudeHooks: ClaudeHookEntry[];
  capabilityGates: CapabilityGateEntry[];
  verifyGates: { configured: boolean; names: string[]; problems: string[] };
  agentSkills: Record<string, string[]>;
  skills: string[];
  steeringFiles: Array<{ path: string; bytes: number }>;
  rulesRegistry: { path: string; total: number; proseOnly: number; proseOnlyIds: string[] } | null;
  findings: InventoryFinding[];
  /** Inputs that could not be read; the matching section is partial. */
  problems: string[];
}

export type GitRunner = (args: string[], opts?: { cwd?: string }) => SpawnResultOutput;

export interface CapabilityRegistryLike {
  capabilities?: Record<string, { gates?: unknown; config?: Record<string, { default?: unknown }> }>;
}

export interface InventoryOptions {
  execGit?: GitRunner;
  /** The capability registry (default: the generated capability-registry.cjs). */
  registry?: CapabilityRegistryLike;
  /** Active capability ids in this project; `null` when the state cannot be resolved. */
  activeCapabilities?: (projectRoot: string) => Set<string> | null;
  /** A rules registry (`.plans/rules-registry/merged.json` shape), inside the project. */
  rulesRegistryPath?: string;
}

// ─── Small readers ────────────────────────────────────────────────────────────

function rel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

function readJson(abs: string, problems: string[], root: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') problems.push(`${rel(root, abs)}: unreadable`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    problems.push(`${rel(root, abs)}: not valid JSON (${(err as Error).message})`);
    return undefined;
  }
}

function listFiles(dir: string, filter: (name: string) => boolean): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isFile() && filter(d.name)).map(d => d.name).sort();
  } catch {
    return [];
  }
}

function exists(abs: string): boolean {
  return fs.existsSync(abs);
}

function readText(abs: string): string {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

// ─── Scripts and wiring ───────────────────────────────────────────────────────

const SCRIPT_CLASSES: ReadonlyArray<[ScriptClass, RegExp]> = [
  ['typecheck', /^(?:typecheck|type-check|tsc|check[:-]types?|types?(?::check)?)(?:[:-].*)?$/],
  ['format', /^(?:format|fmt|prettier)(?:[:-]check)?$/],
  ['lint', /^lint(?:[:-].*)?$/],
  ['check', /^check(?:[:-].*)?$/],
  ['test', /^test(?:[:-].*)?$/],
];

function classify(name: string): ScriptClass | null {
  for (const [cls, re] of SCRIPT_CLASSES) if (re.test(name)) return cls;
  return null;
}

/** Does `text` invoke package script `name` (`npm run x`, `pnpm x`, `yarn x`, `bun run x`, `npm test`)? */
export function invokesScript(text: string, name: string): boolean {
  const n = escapeRegex(name);
  const runner = new RegExp(`(?:npm|pnpm|yarn|bun)\\s+(?:run(?:-script)?\\s+|--silent\\s+run\\s+)?${n}(?=$|[\\s;&|"'\`)])`, 'm');
  if (runner.test(text)) return true;
  if (name === 'test' && /(?:npm|pnpm|yarn|bun)\s+t(?:est)?(?=$|[\s;&|"'`)])/m.test(text)) return true;
  return false;
}

const DEV_ONLY_SCRIPT_RE = /(?:^|[:-])(?:fix|watch|affected|since|update|dev)$/;

const PRECOMMIT_PROBES: ReadonlyArray<[string, string[]]> = [
  ['husky', ['.husky']],
  ['lefthook', ['lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml']],
  ['pre-commit', ['.pre-commit-config.yaml']],
  ['lint-staged', ['.lintstagedrc', '.lintstagedrc.json', '.lintstagedrc.js', 'lint-staged.config.js']],
];

const LINT_CONFIG_NAMES = [
  'eslint.config.js', 'eslint.config.cjs', 'eslint.config.mjs', 'eslint.config.ts',
  '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
  'biome.json', 'biome.jsonc', '.oxlintrc.json', 'ruff.toml', '.ruff.toml', '.golangci.yml', '.golangci.yaml',
  'clippy.toml', '.rubocop.yml', '.stylelintrc.json',
];

// ─── Inventory ────────────────────────────────────────────────────────────────

/**
 * Build the inventory for `projectRoot`. Never throws for a missing or
 * malformed input: the section is left empty and the cause goes to
 * `problems`.
 */
export function buildRetroInventory(projectRoot: string, opts: InventoryOptions = {}): RetroInventory {
  const root = path.resolve(projectRoot);
  const problems: string[] = [];
  const findings: InventoryFinding[] = [];
  const run = opts.execGit ?? execGitSeam;

  // CI workflows.
  const ciFiles: string[] = [];
  for (const f of listFiles(path.join(root, '.github', 'workflows'), n => /\.ya?ml$/.test(n))) ciFiles.push(`.github/workflows/${f}`);
  for (const f of ['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile']) {
    if (exists(path.join(root, f))) ciFiles.push(f);
  }
  const ciText = ciFiles.map(f => readText(path.join(root, f))).join('\n');

  // Pre-commit tooling and the installed git hook.
  const tools: string[] = [];
  const precommitTexts: string[] = [];
  for (const [tool, probes] of PRECOMMIT_PROBES) {
    for (const probe of probes) {
      const abs = path.join(root, probe);
      if (!exists(abs)) continue;
      if (!tools.includes(tool)) tools.push(tool);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        stat = null;
      }
      if (stat?.isDirectory()) {
        for (const f of listFiles(abs, () => true)) precommitTexts.push(readText(path.join(abs, f)));
      } else {
        precommitTexts.push(readText(abs));
      }
    }
  }
  const pkg = readJson(path.join(root, 'package.json'), problems, root) as Record<string, unknown> | undefined;
  if (pkg && (pkg['lint-staged'] || pkg['simple-git-hooks'] || pkg['husky'])) {
    for (const key of ['lint-staged', 'simple-git-hooks', 'husky']) {
      if (pkg[key]) {
        if (!tools.includes(key)) tools.push(key);
        precommitTexts.push(JSON.stringify(pkg[key]));
      }
    }
  }
  let hooksPath: string | null = null;
  let gitHookInstalled: boolean | null = null;
  const hp = run(['config', '--get', 'core.hooksPath'], { cwd: root });
  if (hp.exitCode === 0 && hp.stdout.trim()) hooksPath = hp.stdout.trim();
  const gitDir = run(['rev-parse', '--git-common-dir'], { cwd: root });
  if (gitDir.exitCode === 0 && gitDir.stdout.trim()) {
    const hookDir = hooksPath
      ? path.resolve(root, hooksPath)
      : path.join(path.resolve(root, gitDir.stdout.trim()), 'hooks');
    gitHookInstalled = ['pre-commit', 'pre-push', 'commit-msg'].some(h => exists(path.join(hookDir, h)));
    for (const h of ['pre-commit', 'pre-push']) {
      const t = readText(path.join(hookDir, h));
      if (t) precommitTexts.push(t);
    }
  }
  const precommitText = precommitTexts.join('\n');

  // Package scripts. A script is wired when the text that runs anyway — CI,
  // pre-commit, the bodies of scripts already wired — invokes it by name or
  // carries its command line verbatim (CI calling `node scripts/x.cjs`
  // directly). Iterated to a fixed point so `lint:ci → lint → lint:x` chains.
  const scriptsObj = pkg && pkg['scripts'] && typeof pkg['scripts'] === 'object' ? (pkg['scripts'] as Record<string, unknown>) : {};
  const allScripts = Object.entries(scriptsObj).filter(([, v]) => typeof v === 'string') as Array<[string, string]>;
  const wired = new Set<string>();
  const reachable = [ciText, precommitText];
  const reaches = (name: string, body: string) => reachable.some(text =>
    invokesScript(text, name) || (body.trim().length >= 12 && text.includes(body.trim())));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, body] of allScripts) {
      if (wired.has(name) || !reaches(name, body)) continue;
      wired.add(name);
      reachable.push(body);
      changed = true;
    }
  }
  const entries: ScriptEntry[] = [];
  for (const [name, body] of allScripts.sort((a, b) => a[0].localeCompare(b[0]))) {
    const cls = classify(name);
    if (!cls) continue;
    entries.push({ name, class: cls, command: excerpt(body, 160), wired: wired.has(name) });
  }

  // Lint configs and repo-local rules.
  const lintConfigs = LINT_CONFIG_NAMES.filter(n => exists(path.join(root, n)));
  const lintConfigText = lintConfigs.map(n => readText(path.join(root, n))).join('\n');
  const localRules: LocalLintRule[] = [];
  for (const dirName of ['eslint-rules', 'lint-rules']) {
    for (const f of listFiles(path.join(root, dirName), n => /\.(?:c|m)?[jt]s$/.test(n) && !/\.test\.|\.spec\.|^index\./.test(n))) {
      const name = f.replace(/\.(?:c|m)?[jt]s$/, '');
      localRules.push({ name, file: `${dirName}/${f}`, wired: new RegExp(`['"/:]${escapeRegex(name)}['"]`).test(lintConfigText) });
    }
  }

  // Claude Code hooks.
  const claudeHooks: ClaudeHookEntry[] = [];
  for (const src of ['.claude/settings.json', '.claude/settings.local.json']) {
    const json = readJson(path.join(root, src), problems, root) as { hooks?: unknown } | undefined;
    const hooks = json && json.hooks && typeof json.hooks === 'object' ? (json.hooks as Record<string, unknown>) : {};
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue;
      for (const g of groups as Array<{ matcher?: unknown; hooks?: unknown }>) {
        for (const h of (Array.isArray(g?.hooks) ? g.hooks : []) as Array<{ command?: unknown }>) {
          if (typeof h?.command !== 'string') continue;
          claudeHooks.push({
            source: src, event,
            matcher: typeof g.matcher === 'string' && g.matcher ? g.matcher : null,
            command: excerpt(h.command, 160),
            gsdManaged: /(?:^|[\s/"'])gsd-[a-z0-9-]+\.(?:js|cjs|sh)\b/.test(h.command),
          });
        }
      }
    }
  }

  // Project config: verify gates, agent skills, gate `when` values.
  const config = readJson(path.join(root, '.planning', 'config.json'), problems, root) as Record<string, unknown> | undefined;
  const checks = readChecks(root);
  const verifyGates = checks.ok
    ? { configured: checks.checks.length > 0, names: checks.checks.map(c => c.name), problems: [] as string[] }
    : { configured: false, names: [] as string[], problems: checks.problems };
  const agentSkills: Record<string, string[]> = {};
  const rawSkills = config && config['agent_skills'] && typeof config['agent_skills'] === 'object' ? (config['agent_skills'] as Record<string, unknown>) : {};
  for (const [agent, v] of Object.entries(rawSkills)) {
    agentSkills[agent] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : [];
  }

  // Capability gates.
  const registry = opts.registry ?? loadRegistry(problems);
  let active: Set<string> | null = null;
  try {
    active = (opts.activeCapabilities ?? defaultActiveCapabilities)(root);
  } catch (err) {
    problems.push(`capability state unresolved: ${(err as Error).message}`);
  }
  const capabilityGates: CapabilityGateEntry[] = [];
  for (const [capId, cap] of Object.entries(registry.capabilities ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!Array.isArray(cap.gates)) continue;
    for (const g of cap.gates as Array<Record<string, unknown>>) {
      const check = g['check'] as Record<string, unknown> | undefined;
      const when = typeof g['when'] === 'string' ? g['when'] : null;
      const predicate = check?.['predicate'] as { kind?: unknown } | undefined;
      capabilityGates.push({
        capability: capId,
        active: active === null ? null : active.has(capId),
        point: typeof g['point'] === 'string' ? g['point'] : '',
        check: typeof check?.['query'] === 'string' ? `query ${check['query']}` : predicate ? `predicate ${String(predicate.kind)}` : 'unknown',
        when,
        whenValue: when ? dotted(config, when) ?? null : null,
        blocking: g['blocking'] === true,
      });
    }
  }

  // Skills and steering files.
  let skills: string[] = [];
  try {
    skills = fs.readdirSync(path.join(root, '.claude', 'skills'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  } catch {
    skills = [];
  }
  const steeringFiles: Array<{ path: string; bytes: number }> = [];
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md']) {
    try {
      steeringFiles.push({ path: f, bytes: fs.statSync(path.join(root, f)).size });
    } catch {
      // absent
    }
  }

  // Rules registry: rules no tool enforces.
  let rulesRegistry: RetroInventory['rulesRegistry'] = null;
  let registryAbs: string | null = null;
  if (opts.rulesRegistryPath) {
    try {
      registryAbs = assertWithinRoot(opts.rulesRegistryPath, root, 'rules registry', PathAcceptance.AbsoluteInsideRoot);
    } catch (err) {
      problems.push((err as Error).message);
    }
  } else if (exists(path.join(root, '.plans', 'rules-registry', 'merged.json'))) {
    registryAbs = path.join(root, '.plans', 'rules-registry', 'merged.json');
  }
  if (registryAbs) {
    const reg = readJson(registryAbs, problems, root) as { rows?: unknown } | undefined;
    if (reg && Array.isArray(reg.rows)) {
      const rows = reg.rows as Array<{ id?: unknown; enforced_by?: unknown; checkable?: unknown }>;
      const proseOnly = rows.filter(r =>
        (!Array.isArray(r.enforced_by) || r.enforced_by.length === 0) &&
        r.checkable !== 'semantic' && r.checkable !== 'process');
      rulesRegistry = {
        path: rel(root, registryAbs),
        total: rows.length,
        proseOnly: proseOnly.length,
        proseOnlyIds: proseOnly.map(r => (typeof r.id === 'string' ? r.id : '')).filter(Boolean).slice(0, 200),
      };
    } else if (reg !== undefined) {
      problems.push(`${rel(root, registryAbs)}: no "rows" array`);
    }
  }

  // Findings.
  const byClass = (cls: ScriptClass) => entries.filter(e => e.class === cls);
  if (!pkg && lintConfigs.length === 0) {
    findings.push({ kind: 'missing-guardrail', subject: 'lint', detail: 'no package.json scripts and no lint config' });
  } else if (byClass('lint').length === 0 && lintConfigs.length === 0) {
    findings.push({ kind: 'missing-guardrail', subject: 'lint', detail: 'no lint script and no lint config' });
  }
  if (pkg && byClass('test').length === 0) findings.push({ kind: 'missing-guardrail', subject: 'test', detail: 'no test script in package.json' });
  if (ciFiles.length === 0) findings.push({ kind: 'missing-guardrail', subject: 'ci', detail: 'no CI workflow' });
  if (tools.length === 0 && !gitHookInstalled) findings.push({ kind: 'missing-guardrail', subject: 'pre-commit', detail: 'no pre-commit tooling and no installed git hook' });
  if (!verifyGates.configured && verifyGates.problems.length === 0) {
    findings.push({ kind: 'missing-guardrail', subject: 'verify-gates', detail: 'workflow.verify_gates names no checks — VERIFICATION.md carries no machine-run gate results' });
  }
  for (const e of entries) {
    // A fixer, watcher or diff-scoped runner is a developer convenience, not a
    // check something should run on every change.
    if (DEV_ONLY_SCRIPT_RE.test(e.name)) continue;
    if (!e.wired && (ciFiles.length > 0 || tools.length > 0)) {
      findings.push({ kind: 'unwired-check', subject: `script ${e.name}`, detail: `${e.class} script that no CI job, pre-commit hook or wired script runs` });
    }
  }
  for (const r of localRules) {
    if (!r.wired) findings.push({ kind: 'unwired-check', subject: `lint rule ${r.name}`, detail: `${r.file} is not named in any lint config` });
  }
  if (tools.length > 0 && gitHookInstalled === false) {
    findings.push({ kind: 'unwired-check', subject: 'pre-commit', detail: `${tools.join(', ')} configured but no git hook is installed` });
  }
  for (const p of verifyGates.problems) findings.push({ kind: 'unwired-check', subject: 'verify-gates', detail: p });

  return {
    scripts: { packageJson: Boolean(pkg), entries },
    ci: { files: ciFiles },
    precommit: { tools, gitHookInstalled, hooksPath },
    lint: { configs: lintConfigs, localRules },
    claudeHooks,
    capabilityGates,
    verifyGates,
    agentSkills,
    skills,
    steeringFiles,
    rulesRegistry,
    findings,
    problems,
  };
}

function dotted(obj: Record<string, unknown> | undefined, key: string): unknown {
  if (!obj) return undefined;
  if (obj[key] !== undefined) return obj[key];
  let cur: unknown = obj;
  for (const part of key.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function loadRegistry(problems: string[]): CapabilityRegistryLike {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('./capability-registry.cjs') as CapabilityRegistryLike;
  } catch (err) {
    problems.push(`capability registry unavailable: ${(err as Error).message}`);
    return {};
  }
}

function defaultActiveCapabilities(projectRoot: string): Set<string> | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const state = require('./capability-state.cjs') as {
    resolveCapabilityRuntimeState(cwd: string, runtimeConfigDir: string | null): { capabilities: Array<{ id: string; active: boolean }> };
  };
  const res = state.resolveCapabilityRuntimeState(projectRoot, null);
  return new Set(res.capabilities.filter(c => c.active).map(c => c.id));
}
