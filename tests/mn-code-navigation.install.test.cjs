'use strict';

// allow-test-rule: source-text-is-the-product (ADR-5210) — the assertions read the
// canonical agents/*.md frontmatter and the installed agent frontmatter, the
// deployed agent contract, both through parseFrontmatter.

/**
 * mn-code-navigation: install-time code-navigation MCP grants (fork, ADR-5210).
 *
 * The grant set and the agents it goes to are declared once, in
 * capabilities/mn-code-navigation/capability.json `agentTools`. The installer
 * appends them before the runtime converter; agents/*.md keeps upstream's
 * `tools:` line. These tests pin: which agents get the grants (and only them),
 * no duplicate when the agent already declares a grant, the user's agent_tools
 * still follow, runtimes whose converter drops MCP grants stay without them,
 * code_navigation.enabled=false removes them, and a surface re-materialization
 * keeps them.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup, sandboxHome } = require('./helpers.cjs');
const { installerEnv, RUNTIME_META, runMinimalInstall } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { parseFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const {
  resolveCapabilityAgentTools,
  readCapabilityAgentTools,
  grantsForAgent,
} = require('../gsd-core/bin/lib/mn-agent-tools.cjs');
const { stageAgentsForRuntimeWithConverter } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const CAPABILITY = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'capabilities', 'mn-code-navigation', 'capability.json'), 'utf8'),
);
const GRANTS = CAPABILITY.agentTools.grants;
const LISTED = new Set(CAPABILITY.agentTools.agents);

function toolsOf(content) {
  const tools = parseFrontmatter(content).tools;
  if (tools === undefined || tools === null) return null;
  return (Array.isArray(tools) ? tools : String(tools).split(','))
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function canonicalTools(agentName) {
  return toolsOf(fs.readFileSync(path.join(AGENTS_DIR, `${agentName}.md`), 'utf8'));
}

/** What an installed agent's tools must be: canonical, then the grants it does not already declare. */
function expectedTools(agentName) {
  const base = canonicalTools(agentName);
  if (!LISTED.has(agentName)) return base;
  return [...base, ...GRANTS.filter((grant) => !base.includes(grant))];
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function install(t, runtime, { defaults, projectConfig } = {}) {
  const root = createTempDir(`gsd-mn-nav-${runtime}-project-`);
  const home = createTempDir(`gsd-mn-nav-${runtime}-home-`);
  t.after(() => {
    cleanup(root);
    cleanup(home);
  });
  if (defaults !== undefined) writeJson(path.join(home, '.gsd', 'defaults.json'), defaults);
  if (projectConfig !== undefined) writeJson(path.join(root, '.planning', 'config.json'), projectConfig);
  const result = runNode(
    ['--preserve-symlinks', '--preserve-symlinks-main', path.join(REPO_ROOT, 'bin', 'install.js'), `--${runtime}`, '--local'],
    { cwd: root, env: installerEnv({ HOME: home, USERPROFILE: home }), timeoutMs: INSTALL_TIMEOUT_MS },
  );
  assert.strictEqual(result.exitCode, 0, `${runtime} install failed (outcome=${result.outcome}):\n${result.stderr}`);
  return path.join(root, RUNTIME_META[runtime].localDir);
}

function installedTools(configDir, relDir, fileName) {
  return toolsOf(fs.readFileSync(path.join(configDir, relDir, fileName), 'utf8'));
}

describe('mn-code-navigation: the declaration', () => {
  test('every listed agent exists in agents/ and declares a tools: key the grants can extend', () => {
    for (const agent of LISTED) {
      const file = path.join(AGENTS_DIR, `${agent}.md`);
      assert.ok(fs.existsSync(file), `${agent} is listed in agentTools.agents but agents/${agent}.md does not exist`);
      assert.ok(canonicalTools(agent) !== null,
        `${agent} has no tools: key — it inherits every tool, so a grant would be a silent no-op`);
    }
  });

  test('no canonical agent declares a grant this capability owns — it is declared in one place', () => {
    const offenders = fs.readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => (toolsOf(fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8')) || [])
        .some((tool) => GRANTS.includes(tool)));
    assert.deepStrictEqual(offenders, [],
      'add the agent to capabilities/mn-code-navigation agentTools.agents instead of its tools: line');
  });

  test('the frozen registry carries the declaration the installer reads', () => {
    const grants = readCapabilityAgentTools(null, { registry: require('../gsd-core/bin/lib/capability-registry.cjs') });
    for (const agent of LISTED) assert.deepStrictEqual(grantsForAgent(grants, agent), GRANTS, agent);
  });
});

describe('mn-code-navigation: resolution (pure)', () => {
  const registry = (overrides = {}) => ({
    capabilities: {
      nav: {
        activationKey: 'nav.enabled',
        config: { 'nav.enabled': { type: 'boolean', default: true } },
        agentTools: { grants: ['mcp__a__*', 'mcp__b__*'], agents: ['gsd-one', 'gsd-two'] },
        ...overrides,
      },
    },
  });
  const unset = () => undefined;

  test('absent key is enabled: the declared default true applies', () => {
    const grants = resolveCapabilityAgentTools(registry(), unset);
    assert.deepStrictEqual(grantsForAgent(grants, 'gsd-one'), ['mcp__a__*', 'mcp__b__*']);
    assert.deepStrictEqual(grantsForAgent(grants, 'gsd-three'), [], 'an unlisted agent gets nothing');
  });

  test('a .compact variant gets the grants of its agent', () => {
    const grants = resolveCapabilityAgentTools(registry(), unset);
    assert.deepStrictEqual(grantsForAgent(grants, 'gsd-two.compact'), ['mcp__a__*', 'mcp__b__*']);
  });

  test('the activation key set to false contributes nothing; any other value keeps the grants', () => {
    assert.deepStrictEqual(grantsForAgent(resolveCapabilityAgentTools(registry(), () => false), 'gsd-one'), []);
    assert.deepStrictEqual(grantsForAgent(resolveCapabilityAgentTools(registry(), () => true), 'gsd-one'),
      ['mcp__a__*', 'mcp__b__*']);
  });

  test('a declared default of false is honoured when the key is unset', () => {
    const grants = resolveCapabilityAgentTools(
      registry({ config: { 'nav.enabled': { type: 'boolean', default: false } } }),
      unset,
    );
    assert.deepStrictEqual(grantsForAgent(grants, 'gsd-one'), []);
  });

  test('a malformed grant voids the whole block, never half of it', () => {
    for (const bad of ['mcp__a__* x', 'mcp__a__*,', 'tool:', '', 'mcp__"q"', ' mcp__a__*']) {
      const grants = resolveCapabilityAgentTools(
        registry({ agentTools: { grants: ['mcp__ok__*', bad], agents: ['gsd-one'] } }),
        unset,
      );
      assert.deepStrictEqual(grantsForAgent(grants, 'gsd-one'), [], JSON.stringify(bad));
    }
  });

  test('two capabilities granting the same tool yield it once', () => {
    const grants = resolveCapabilityAgentTools({
      capabilities: {
        a: { agentTools: { grants: ['mcp__x__*'], agents: ['gsd-one'] } },
        b: { agentTools: { grants: ['mcp__x__*', 'mcp__y__*'], agents: ['gsd-one'] } },
      },
    }, unset);
    assert.deepStrictEqual(grantsForAgent(grants, 'gsd-one'), ['mcp__x__*', 'mcp__y__*']);
  });
});

describe('mn-code-navigation: the staging pipeline', () => {
  test('a grant the agent already declares is not added twice; the user agent_tools follow the capability grants', (t) => {
    const home = createTempDir('gsd-mn-nav-stage-home-');
    const src = createTempDir('gsd-mn-nav-stage-src-');
    t.after(() => {
      cleanup(home);
      cleanup(src);
    });
    sandboxHome(t, home);
    const savedGsdHome = process.env.GSD_HOME;
    process.env.GSD_HOME = home;
    t.after(() => {
      if (savedGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = savedGsdHome;
    });
    writeJson(path.join(home, '.gsd', 'defaults.json'), { agent_tools: { 'gsd-verifier': ['WebFetch', GRANTS[1]] } });
    // An upstream that already ships one of the grants on the line.
    fs.writeFileSync(path.join(src, 'gsd-verifier.md'),
      `---\nname: gsd-verifier\ntools: Read, ${GRANTS[0]}\n---\nbody\n`, 'utf8');

    const staged = stageAgentsForRuntimeWithConverter(src, { skills: '*' }, (content) => content);
    const tools = toolsOf(fs.readFileSync(path.join(staged, 'gsd-verifier.md'), 'utf8'));
    assert.deepStrictEqual(tools, ['Read', ...GRANTS, 'WebFetch']);
  });
});

describe('mn-code-navigation: installed agents', () => {
  test('Claude: every installed agent has canonical tools plus the grants exactly when listed', (t) => {
    const configDir = install(t, 'claude');
    const installed = fs.readdirSync(path.join(configDir, 'agents')).filter((name) => /^gsd-.*\.md$/.test(name));
    assert.ok(installed.length >= LISTED.size, 'precondition: the install emits the listed agents');
    let granted = 0;
    for (const name of installed) {
      const agent = name.slice(0, -'.md'.length);
      if (canonicalTools(agent) === null) continue;
      assert.deepStrictEqual(installedTools(configDir, 'agents', name), expectedTools(agent), agent);
      if (LISTED.has(agent)) granted += 1;
    }
    assert.strictEqual(granted, LISTED.size, 'every listed agent was installed and checked');
  });

  test('Claude: code_navigation.enabled=false in the project config drops the grants', (t) => {
    const configDir = install(t, 'claude', { projectConfig: { code_navigation: { enabled: false } } });
    assert.deepStrictEqual(installedTools(configDir, 'agents', 'gsd-verifier.md'), canonicalTools('gsd-verifier'));
  });

  test('Claude: false in the global defaults drops them; true in the project config wins back', (t) => {
    const off = install(t, 'claude', { defaults: { code_navigation: { enabled: false } } });
    assert.deepStrictEqual(installedTools(off, 'agents', 'gsd-executor.md'), canonicalTools('gsd-executor'));
    const on = install(t, 'claude', {
      defaults: { code_navigation: { enabled: false } },
      projectConfig: { code_navigation: { enabled: true } },
    });
    assert.deepStrictEqual(installedTools(on, 'agents', 'gsd-executor.md'), expectedTools('gsd-executor'));
  });

  test('Qwen keeps MCP grants in frontmatter, including on .compact variants', (t) => {
    const configDir = install(t, 'qwen');
    assert.deepStrictEqual(installedTools(configDir, 'agents', 'gsd-planner.md'), expectedTools('gsd-planner'));
    assert.ok(fs.existsSync(path.join(configDir, 'agents', 'gsd-code-reviewer.compact.md')),
      'precondition: qwen installs the compact code reviewer');
    const compact = installedTools(configDir, 'agents', 'gsd-code-reviewer.compact.md');
    for (const grant of GRANTS) assert.ok(compact.includes(grant), `compact code reviewer lacks ${grant}`);
  });

  for (const runtime of ['zcode', 'pi']) {
    test(`${runtime}: the converter drops MCP grants, so the listed agents carry none`, (t) => {
      const configDir = install(t, runtime);
      const agentsDir = path.join(configDir, 'agents');
      const files = fs.readdirSync(agentsDir).filter((name) => /^gsd-.*\.md$/.test(name));
      assert.ok(files.length > 0, `precondition: ${runtime} installs native agents`);
      for (const name of files) {
        const tools = installedTools(configDir, 'agents', name) || [];
        assert.deepStrictEqual(tools.filter((tool) => GRANTS.includes(tool)), [], `${runtime} ${name}`);
      }
    });
  }

  test('a surface re-materialization from the installed corpus keeps the grants', (t) => {
    const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');
    const { loadSkillsManifest } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const { CLUSTERS } = require('../gsd-core/bin/lib/clusters.cjs');
    const installed = runMinimalInstall({ runtime: 'claude', scope: 'global' });
    t.after(() => cleanup(installed.root));
    sandboxHome(t, installed.root);
    const verifier = path.join(installed.configDir, 'agents', 'gsd-verifier.md');
    fs.writeFileSync(verifier, '---\nname: gsd-verifier\ntools: Read\n---\nstale\n', 'utf8');

    applySurface(
      installed.configDir,
      resolveRuntimeArtifactLayout('claude', installed.configDir, 'global'),
      loadSkillsManifest(path.join(REPO_ROOT, 'commands', 'gsd')),
      CLUSTERS,
    );
    assert.deepStrictEqual(toolsOf(fs.readFileSync(verifier, 'utf8')), expectedTools('gsd-verifier'));
  });
});
