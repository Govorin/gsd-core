'use strict';

/**
 * mn-nx-tasks: install-time nx-tasks MCP grant plus its reference pointer
 * (fork, ADR-5210 and its 2026-11-01 amendment).
 *
 * capabilities/mn-nx-tasks/capability.json declares `agentTools: { grants,
 * agents, reference }`. The installer appends the grant to each listed agent's
 * tools: after mn-code-navigation's (capability id order) and one pointer line,
 * naming the grant and gsd-core/references/nx-live-stack.md, to the end of the
 * agent body. These tests pin: the declaration (agents, reference file, key),
 * the pointer's resolution and rendering (pure), its place in the staging
 * pipeline, and installed agents — on by default, off with
 * nx_tasks.enabled=false (grant and pointer together), mn-code-navigation's
 * grants untouched either way, a converter that keeps MCP names keeps it, one
 * that drops them drops it. The pointer is checked by exact equality: an
 * installed body with the capability on must be the body with it off plus
 * the one rendered line.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');
const { createTempDir, cleanup, sandboxHome } = require('./helpers.cjs');
const { installerEnv, RUNTIME_META } = require('./helpers/install-shared.cjs');
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { parseFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
const {
  resolveCapabilityAgentTools,
  resolveCapabilityAgentReferences,
  readCapabilityAgentTools,
  readCapabilityAgentReferences,
  grantsForAgent,
  referencesForAgent,
  appendAgentReferences,
} = require('../gsd-core/bin/lib/mn-agent-tools.cjs');
const { stageAgentsForRuntimeWithConverter } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const readCapability = (id) => JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, 'capabilities', id, 'capability.json'), 'utf8'),
);
const CAPABILITY = readCapability('mn-nx-tasks');
const { grants: NAVIGATION, agents: NAVIGATED } = readCapability('mn-code-navigation').agentTools;
const { grants: GRANTS, agents: AGENTS, reference: REFERENCE } = CAPABILITY.agentTools;
const LISTED = new Set(AGENTS);

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

/** Canonical tools plus code navigation when mn-code-navigation lists the agent (and it is on). */
function withNavigation(agentName, navigationOn = true) {
  const base = canonicalTools(agentName);
  if (!navigationOn || !NAVIGATED.includes(agentName)) return base;
  return [...base, ...NAVIGATION.filter((grant) => !base.includes(grant))];
}

/** The pointer the installer must write, with `~/.claude/` already rewritten to `prefix`. */
function expectedPointer(prefix) {
  return `**Granted at install:** if your tools include ${GRANTS.map((g) => `\`${g}\``).join(', ')}, `
    + `Read \`${prefix}gsd-core/references/${REFERENCE}\` before you start; it says when to use them.`;
}

/** The body after the frontmatter block. */
function bodyOf(content) {
  assert.ok(content.startsWith('---\n'), 'precondition: the agent opens with frontmatter');
  const close = content.indexOf('\n---', 4);
  return content.slice(content.indexOf('\n', close + 1) + 1);
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function install(t, runtime, { defaults, projectConfig } = {}) {
  const root = createTempDir(`gsd-mn-nx-${runtime}-project-`);
  const home = createTempDir(`gsd-mn-nx-${runtime}-home-`);
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

const installedAgent = (configDir, fileName) => fs.readFileSync(path.join(configDir, 'agents', fileName), 'utf8');

describe('mn-nx-tasks: the declaration', () => {
  test('every listed agent exists in agents/ and declares a tools: key the grant can extend', () => {
    for (const agent of LISTED) {
      assert.ok(fs.existsSync(path.join(AGENTS_DIR, `${agent}.md`)), `agents/${agent}.md does not exist`);
      assert.ok(canonicalTools(agent) !== null, `${agent} has no tools: key — the grant would be a silent no-op`);
    }
  });

  test('the reference is a shipped file in gsd-core/references/', () => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'gsd-core', 'references', REFERENCE)),
      `agentTools.reference names gsd-core/references/${REFERENCE}, which does not exist`);
  });

  test('no canonical agent declares the grant — it is declared in one place', () => {
    const offenders = fs.readdirSync(AGENTS_DIR)
      .filter((name) => name.endsWith('.md'))
      .filter((name) => (toolsOf(fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8')) || [])
        .some((tool) => GRANTS.includes(tool)));
    assert.deepStrictEqual(offenders, [], 'list the agent in capabilities/mn-nx-tasks agentTools.agents instead');
  });

  test('the activation key is declared, boolean, default true (absent = enabled)', () => {
    assert.strictEqual(CAPABILITY.activationKey, 'nx_tasks.enabled');
    assert.deepStrictEqual(
      { type: CAPABILITY.config['nx_tasks.enabled'].type, default: CAPABILITY.config['nx_tasks.enabled'].default },
      { type: 'boolean', default: true },
    );
  });

  test('the frozen registry carries it: grants after code navigation, the pointer only on listed agents', (t) => {
    // A home of its own: the person's ~/.gsd/defaults.json must not decide this test.
    const home = createTempDir('gsd-mn-nx-registry-home-');
    t.after(() => cleanup(home));
    const options = { registry: require('../gsd-core/bin/lib/capability-registry.cjs'), homedir: () => home };
    const grants = readCapabilityAgentTools(null, options);
    const references = readCapabilityAgentReferences(null, options);
    for (const agent of LISTED) {
      const list = grantsForAgent(grants, agent);
      assert.deepStrictEqual(list.slice(-GRANTS.length), GRANTS, agent);
      assert.deepStrictEqual(referencesForAgent(references, agent),
        [{ capability: 'mn-nx-tasks', grants: GRANTS, reference: REFERENCE }], agent);
    }
    // gsd-planner reads code but runs nothing: code navigation, no nx-tasks, no pointer.
    assert.deepStrictEqual(grantsForAgent(grants, 'gsd-planner'), NAVIGATION);
    assert.deepStrictEqual(referencesForAgent(references, 'gsd-planner'), []);
  });
});

describe('mn-nx-tasks: reference resolution and rendering (pure)', () => {
  const registry = (overrides = {}) => ({
    capabilities: {
      live: {
        activationKey: 'live.enabled',
        config: { 'live.enabled': { type: 'boolean', default: true } },
        agentTools: { grants: ['mcp__live__*'], agents: ['gsd-one'], reference: 'live.md' },
        ...overrides,
      },
    },
  });
  const unset = () => undefined;

  test('a block without reference grants but adds no pointer', () => {
    const reg = registry({ agentTools: { grants: ['mcp__live__*'], agents: ['gsd-one'] } });
    assert.deepStrictEqual(grantsForAgent(resolveCapabilityAgentTools(reg, unset), 'gsd-one'), ['mcp__live__*']);
    assert.deepStrictEqual(referencesForAgent(resolveCapabilityAgentReferences(reg, unset), 'gsd-one'), []);
  });

  test('a .compact variant gets its agent pointer; an unlisted agent none', () => {
    const refs = resolveCapabilityAgentReferences(registry(), unset);
    assert.deepStrictEqual(referencesForAgent(refs, 'gsd-one.compact'),
      [{ capability: 'live', grants: ['mcp__live__*'], reference: 'live.md' }]);
    assert.deepStrictEqual(referencesForAgent(refs, 'gsd-two'), []);
    assert.deepStrictEqual(referencesForAgent(null, 'gsd-one'), []);
  });

  test('a disabled key drops grant and pointer together; any other value keeps both', () => {
    for (const off of [false, 0, '', null]) {
      assert.deepStrictEqual(grantsForAgent(resolveCapabilityAgentTools(registry(), () => off), 'gsd-one'), [], JSON.stringify(off));
      assert.deepStrictEqual(referencesForAgent(resolveCapabilityAgentReferences(registry(), () => off), 'gsd-one'), [], JSON.stringify(off));
    }
    for (const on of [true, 1]) {
      assert.strictEqual(referencesForAgent(resolveCapabilityAgentReferences(registry(), () => on), 'gsd-one').length, 1);
    }
  });

  test('a malformed reference voids the whole block — no grant, no pointer', () => {
    for (const bad of ['', 'live', 'live.txt', 'Live.md', '../live.md', 'sub/live.md', '-live.md', ' live.md', 5, null, ['live.md']]) {
      const reg = registry({ agentTools: { grants: ['mcp__live__*'], agents: ['gsd-one'], reference: bad } });
      assert.deepStrictEqual(grantsForAgent(resolveCapabilityAgentTools(reg, unset), 'gsd-one'), [], JSON.stringify(bad));
      assert.deepStrictEqual(referencesForAgent(resolveCapabilityAgentReferences(reg, unset), 'gsd-one'), [], JSON.stringify(bad));
    }
  });

  test('two capabilities with references give two pointers, in capability id order', () => {
    const refs = resolveCapabilityAgentReferences({
      capabilities: {
        zeta: { agentTools: { grants: ['mcp__z__*'], agents: ['gsd-one'], reference: 'z.md' } },
        alpha: { agentTools: { grants: ['mcp__a__*', 'mcp__b__*'], agents: ['gsd-one'], reference: 'a.md' } },
      },
    }, unset);
    assert.deepStrictEqual(referencesForAgent(refs, 'gsd-one').map((r) => r.capability), ['alpha', 'zeta']);
    const out = appendAgentReferences('---\nname: gsd-one\n---\nbody\n', referencesForAgent(refs, 'gsd-one'));
    assert.strictEqual(out, '---\nname: gsd-one\n---\nbody\n\n'
      + '**Granted at install:** if your tools include `mcp__a__*`, `mcp__b__*`, Read `~/.claude/gsd-core/references/a.md` before you start; it says when to use them.\n'
      + '**Granted at install:** if your tools include `mcp__z__*`, Read `~/.claude/gsd-core/references/z.md` before you start; it says when to use them.\n');
  });

  test('no references leave the content byte-identical', () => {
    for (const content of ['---\nname: x\n---\nbody\n', 'no frontmatter', '', 'crlf\r\n']) {
      assert.strictEqual(appendAgentReferences(content, []), content, JSON.stringify(content));
    }
  });

  test('the pointer keeps the content line ending and closes an unterminated last line', () => {
    const refs = [{ capability: 'live', grants: ['mcp__live__*'], reference: 'live.md' }];
    const line = '**Granted at install:** if your tools include `mcp__live__*`, Read `~/.claude/gsd-core/references/live.md` before you start; it says when to use them.';
    assert.strictEqual(appendAgentReferences('---\r\nname: x\r\n---\r\nbody\r\n', refs), `---\r\nname: x\r\n---\r\nbody\r\n\r\n${line}\r\n`);
    assert.strictEqual(appendAgentReferences('body', refs), `body\n\n${line}\n`);
  });
});

describe('mn-nx-tasks: the staging pipeline', () => {
  test('a listed agent gets code navigation, then nx-tasks, then the user agent_tools; one pointer at the end', (t) => {
    const home = createTempDir('gsd-mn-nx-stage-home-');
    const src = createTempDir('gsd-mn-nx-stage-src-');
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
    writeJson(path.join(home, '.gsd', 'defaults.json'), { agent_tools: { 'gsd-executor': ['WebFetch'] } });
    const executor = '---\nname: gsd-executor\ntools: Read, Bash\n---\nbody\n';
    const planner = '---\nname: gsd-planner\ntools: Read\n---\nplan\n';
    fs.writeFileSync(path.join(src, 'gsd-executor.md'), executor, 'utf8');
    fs.writeFileSync(path.join(src, 'gsd-planner.md'), planner, 'utf8');

    const staged = stageAgentsForRuntimeWithConverter(src, { skills: '*' }, (content) => content);
    const stagedExecutor = fs.readFileSync(path.join(staged, 'gsd-executor.md'), 'utf8');
    assert.deepStrictEqual(toolsOf(stagedExecutor), ['Read', 'Bash', ...NAVIGATION, ...GRANTS, 'WebFetch']);
    assert.strictEqual(bodyOf(stagedExecutor), `body\n\n${expectedPointer('~/.claude/')}\n`);

    const stagedPlanner = fs.readFileSync(path.join(staged, 'gsd-planner.md'), 'utf8');
    assert.deepStrictEqual(toolsOf(stagedPlanner), ['Read', ...NAVIGATION]);
    assert.strictEqual(bodyOf(stagedPlanner), 'plan\n', 'an agent outside the list gets no pointer');
  });
});

describe('mn-nx-tasks: installed agents', () => {
  test('Claude: on, a listed agent is the off install plus the grant and one pointer to a shipped file; off, code navigation stays', (t) => {
    const on = install(t, 'claude');
    const off = install(t, 'claude', { projectConfig: { nx_tasks: { enabled: false } } });
    // Bodies carry the install's absolute config dir (the ~/.claude/ rewrite, against a cwd
    // macOS may report through /private): put one placeholder in its place on both sides.
    const normalized = (configDir, content) => [fs.realpathSync(configDir), configDir]
      .reduce((text, dir) => text.split(dir).join('<config>'), bodyOf(content));
    for (const agent of LISTED) {
      const withGrant = installedAgent(on, `${agent}.md`);
      const without = installedAgent(off, `${agent}.md`);
      assert.deepStrictEqual(toolsOf(withGrant), [...withNavigation(agent), ...GRANTS], agent);
      assert.deepStrictEqual(toolsOf(without), withNavigation(agent), agent);
      assert.strictEqual(normalized(on, withGrant),
        `${normalized(off, without)}\n${expectedPointer('<config>/')}\n`, agent);
    }
    assert.ok(fs.existsSync(path.join(on, 'gsd-core', 'references', REFERENCE)), 'the pointer names a file the install ships');
    const planner = [on, off].map((configDir) => installedAgent(configDir, 'gsd-planner.md'));
    assert.deepStrictEqual(toolsOf(planner[0]), withNavigation('gsd-planner'));
    assert.strictEqual(normalized(on, planner[0]), normalized(off, planner[1]), 'an unlisted agent gets no pointer');
  });

  test('Claude: code_navigation.enabled=false leaves nx-tasks alone, and the reverse holds', (t) => {
    const navOff = install(t, 'claude', { defaults: { code_navigation: { enabled: false } } });
    assert.deepStrictEqual(toolsOf(installedAgent(navOff, 'gsd-debugger.md')), [...withNavigation('gsd-debugger', false), ...GRANTS]);
    const bothOff = install(t, 'claude', {
      defaults: { code_navigation: { enabled: false } },
      projectConfig: { nx_tasks: { enabled: false } },
    });
    assert.deepStrictEqual(toolsOf(installedAgent(bothOff, 'gsd-debugger.md')), canonicalTools('gsd-debugger'));
  });

  test('Qwen keeps the MCP name in frontmatter, on the .compact DOM verifier too', (t) => {
    const configDir = install(t, 'qwen');
    assert.ok(toolsOf(installedAgent(configDir, 'gsd-executor.md')).includes(GRANTS[0]));
    assert.ok(fs.existsSync(path.join(configDir, 'agents', 'gsd-dom-verifier.compact.md')),
      'precondition: qwen installs the compact DOM verifier');
    assert.ok(toolsOf(installedAgent(configDir, 'gsd-dom-verifier.compact.md')).includes(GRANTS[0]));
  });

  test('zcode: the converter drops MCP grants, so no installed agent carries nx-tasks', (t) => {
    const configDir = install(t, 'zcode');
    const files = fs.readdirSync(path.join(configDir, 'agents')).filter((name) => /^gsd-.*\.md$/.test(name));
    assert.ok(files.length > 0, 'precondition: zcode installs native agents');
    for (const name of files) {
      const tools = toolsOf(installedAgent(configDir, name)) || [];
      assert.deepStrictEqual(tools.filter((tool) => GRANTS.includes(tool)), [], name);
    }
  });
});
