'use strict';

/**
 * Tool preflight (LG-01, src/tool-preflight.cts): does the installed agent that will execute a plan
 * grant the tools the plan's tasks name?
 *
 * In the October 2026 review, 43.6 % of one project's subagent tokens went to `general-purpose`
 * agents the orchestrator spawned in place of `gsd-executor`, because the plans drove a Pencil
 * design file and the executor's installed `tools:` had no `mcp__pencil__*`. The prohibition was a
 * sentence in the workflow. These tests pin the typed answer that replaces it:
 *
 *   - what blocks — only DECLARED needs: `requires_tools:` and `.pen` files in `files_modified` —
 *     and what only warns: tool names in `<tasks>`/`<context>` prose, after code and `<verify>` are
 *     cut out ("Do not touch app.pen" names the file to forbid it);
 *   - grant matching, exact and wildcard, at the server-name boundary;
 *   - where the installed agent is read from, and that could-not-look — including a non-Claude
 *     runtime whose installer translated the grants — is `unknown`, never `ok` or `missing`;
 *   - the three surfaces: `verify tool-preflight`, `verify plan-structure`'s `tool_preflight`, and
 *     the execute:pre gate `check mn-tool-preflight`, which blocks only on `missing`, only for the
 *     plans the run will execute (`--wave`, `--gaps-only`).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir, runGsdTools, scrubConfigLocationEnv } = require('./helpers.cjs');
const { createMnProject, makePhase, runMnCheck, writeFiles, writeWorkflowConfig } = require('./helpers/mn-gate-fixture.cjs');
const preflight = require('../gsd-core/bin/lib/tool-preflight.cjs');
const { evaluateMnToolPreflight } = require('../gsd-core/bin/lib/gate-mn-tool-preflight.cjs');

const CAPABILITY = require('../capabilities/mn-verify-gate/capability.json');

function planText({ tasks = '', context = '', objective = 'Do the thing.', files = '[src/a.ts]', extra = '' } = {}) {
  return [
    '---',
    'phase: 01-gate',
    'plan: 01',
    'type: execute',
    'wave: 1',
    'depends_on: []',
    `files_modified: ${files}`,
    'autonomous: true',
    extra,
    'must_haves:',
    '  truths: []',
    '---',
    `<objective>${objective}</objective>`,
    context ? `<context>${context}</context>` : '',
    '<tasks>',
    '<task type="auto">',
    '<name>Work</name>',
    '<files>src/a.ts</files>',
    `<action>${tasks}</action>`,
    '<verify>npm test</verify>',
    '<done>done</done>',
    '</task>',
    '</tasks>',
    '',
  ].filter((l) => l !== '').join('\n');
}

function agentFile(tools) {
  const toolsLine = tools === null ? '' : `tools: ${tools}\n`;
  return `---\nname: agent\ndescription: test\n${toolsLine}---\n\nbody\n`;
}

const tools = (required) => required.map((r) => r.tool);

// ─── requirement extraction ──────────────────────────────────────────────────

const PEN_DECL = { files: '[design/app.pen, src/a.ts]' };
const needs = (opts) => preflight.extractToolNeeds(planText(opts));

describe('extractToolNeeds: what blocks (declared)', () => {
  test('a .pen file in files_modified requires the Pencil server', () => {
    const { required, mentioned } = needs(PEN_DECL);
    assert.deepEqual(tools(required), ['mcp__pencil__*']);
    assert.equal(required[0].source, 'pen-file');
    assert.equal(required[0].where, 'files_modified');
    assert.equal(required[0].evidence, 'design/app.pen');
    assert.deepEqual(mentioned, []);
  });

  test('requires_tools entries are required, normalised (a bare server is the whole server)', () => {
    const { required } = needs({ extra: 'requires_tools: [mcp__context7__query-docs, mcp__atlas, WebFetch]' });
    assert.deepEqual(tools(required), ['mcp__context7__query-docs', 'mcp__atlas__*', 'WebFetch']);
    assert.ok(required.every((r) => r.source === 'requires-tools' && r.where === 'requires_tools'));
  });

  test('requires_tools as a YAML sequence; an entry that is not a tool token is ignored', () => {
    const { required } = needs({ extra: 'requires_tools:\n  - mcp__pencil__*\n  - "two words"' });
    assert.deepEqual(tools(required), ['mcp__pencil__*']);
  });

  test('a lookalike in files_modified (.pencil, .pen.bak, .penx) requires nothing', () => {
    assert.deepEqual(needs({ files: '[notes.pencil, app.pen.bak, x.penx]' }).required, []);
  });

  test('a plugin-namespaced MCP name keeps its server segment intact', () => {
    assert.deepEqual(tools(needs({ extra: 'requires_tools: [mcp__plugin_serena_serena__find_symbol]' }).required), ['mcp__plugin_serena_serena__find_symbol']);
  });
});

describe('extractToolNeeds: what only warns (mentioned in prose)', () => {
  // Each of these was a false halt: the review counted 106 of legion's 237 plans that prose alone
  // would have stopped ("Do not touch or stage app.pen").
  for (const [label, tasks] of [
    ['a forbidding sentence about a .pen file', 'Do NOT modify design/app.pen.'],
    ['a forbidding sentence about a tool', 'do not use WebFetch for this.'],
    ['an MCP name in prose', 'The server mcp__pencil__batch_design is not needed here.'],
  ]) {
    test(`${label} is a mention, not a requirement`, () => {
      const { required, mentioned } = needs({ tasks });
      assert.deepEqual(required, []);
      assert.equal(mentioned.length, 1, JSON.stringify(mentioned));
    });
  }

  test('a <verify> check naming an MCP prefix is neither required nor mentioned', () => {
    const text = planText().replace('<verify>npm test</verify>', '<verify>grep -q "mcp__pencil__" .claude/agents/x.md</verify>');
    assert.deepEqual(preflight.extractToolNeeds(text), { required: [], mentioned: [] });
  });

  test('fenced code (JSON with grants) and inline code are cut out', () => {
    const tasks = 'Write the config:\n```json\n{"agent_tools": {"gsd-executor": ["mcp__pencil__*", "WebFetch"]}}\n```\nthen run `mcp__x__y` nowhere.';
    assert.deepEqual(needs({ tasks }), { required: [], mentioned: [] });
  });

  test('a tool name inside a file name is not a tool: webfetch-cache.pen, WebFetch-cache.pen, src/WebFetch.ts', () => {
    const { mentioned } = needs({ tasks: 'Update webfetch-cache.pen, WebFetch-cache.pen and src/WebFetch.ts.' });
    assert.deepEqual(tools(mentioned), ['mcp__pencil__*'], 'only the .pen paths are mentions; no WebFetch');
  });

  test('a sentence-final tool name is still recognised; other CamelCase words are not', () => {
    const { mentioned } = needs({ tasks: 'Fetch it with WebFetch. Then the Agent runs a Task.' });
    assert.deepEqual(tools(mentioned), ['WebFetch']);
  });

  test('a mention of a tool that is also declared is reported once, as required', () => {
    const { required, mentioned } = needs({ ...PEN_DECL, tasks: 'Edit design/app.pen with mcp__pencil__*' });
    assert.deepEqual(tools(required), ['mcp__pencil__*']);
    assert.deepEqual(mentioned, []);
  });

  test('<context> prose is read; <objective> never is', () => {
    assert.equal(needs({ context: 'Read @design/screens.pen' }).mentioned[0].where, 'context');
    assert.deepEqual(needs({ objective: 'Not doing: design/app.pen or mcp__pencil__x' }), { required: [], mentioned: [] });
  });
});

// ─── grant matching ──────────────────────────────────────────────────────────

describe('grantCovers / isGranted', () => {
  test('exact grant covers exactly that tool', () => {
    assert.equal(preflight.grantCovers('mcp__pencil__batch_design', 'mcp__pencil__batch_design'), true);
    assert.equal(preflight.grantCovers('mcp__pencil__batch_design', 'mcp__pencil__get_style'), false);
  });

  test('a server wildcard covers every tool of that server and the whole-server requirement', () => {
    assert.equal(preflight.grantCovers('mcp__pencil__*', 'mcp__pencil__batch_design'), true);
    assert.equal(preflight.grantCovers('mcp__pencil__*', 'mcp__pencil__*'), true);
  });

  test('the server-name boundary holds: mcp__pencilx__* does not cover the pencil server', () => {
    assert.equal(preflight.grantCovers('mcp__pencilx__*', 'mcp__pencil__*'), false);
    assert.equal(preflight.grantCovers('mcp__pencilx__*', 'mcp__pencil__batch_design'), false);
    assert.equal(preflight.grantCovers('mcp__pencil__*', 'mcp__pencilx__batch'), false);
  });

  test('a whole-server requirement is met by any one tool of that server', () => {
    assert.equal(preflight.grantCovers('mcp__pencil__get_style', 'mcp__pencil__*'), true);
  });

  test('`mcp__<server>` with no tool part and the broad wildcards cover the server', () => {
    assert.equal(preflight.grantCovers('mcp__pencil', 'mcp__pencil__batch_design'), true);
    assert.equal(preflight.grantCovers('mcp__pencil', 'mcp__pencil__*'), true);
    assert.equal(preflight.grantCovers('mcp__*', 'mcp__pencil__*'), true);
    assert.equal(preflight.grantCovers('*', 'WebFetch'), true);
  });

  test('a built-in name is covered only by itself or `*`', () => {
    assert.equal(preflight.grantCovers('WebFetch', 'WebFetch'), true);
    assert.equal(preflight.grantCovers('WebSearch', 'WebFetch'), false);
  });

  test('"all" (a Claude agent with no tools: key) grants everything', () => {
    assert.equal(preflight.isGranted('mcp__pencil__*', 'all'), true);
    assert.equal(preflight.isGranted('mcp__pencil__*', []), false);
  });

  test('parseToolsField reads the inline and the YAML-sequence forms; absent is null', () => {
    assert.deepEqual(preflight.parseToolsField('Read, Write, mcp__x__*'), ['Read', 'Write', 'mcp__x__*']);
    assert.deepEqual(preflight.parseToolsField(['Read', '"mcp__x__*"']), ['Read', 'mcp__x__*']);
    assert.equal(preflight.parseToolsField(undefined), null);
  });
});

// ─── installed agent resolution ──────────────────────────────────────────────

describe('readInstalledAgentTools', () => {
  let projectDir;
  let globalDir;
  let restoreEnv;
  let savedAgentsDir;

  beforeEach(() => {
    restoreEnv = scrubConfigLocationEnv();
    savedAgentsDir = process.env.GSD_AGENTS_DIR;
    delete process.env.GSD_AGENTS_DIR;
    projectDir = createTempDir('gsd-preflight-proj-');
    globalDir = createTempDir('gsd-preflight-claude-');
    process.env.CLAUDE_CONFIG_DIR = globalDir;
  });

  afterEach(() => {
    if (savedAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR;
    else process.env.GSD_AGENTS_DIR = savedAgentsDir;
    restoreEnv();
    cleanup(projectDir);
    cleanup(globalDir);
  });

  test('Claude: the project agent shadows the global one (Claude Code\'s precedence)', () => {
    writeFiles(globalDir, { 'agents/gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    writeFiles(projectDir, { '.claude/agents/gsd-executor.md': agentFile('Read') });
    const r = preflight.readInstalledAgentTools('gsd-executor', 'claude', projectDir);
    assert.equal(r.kind, 'found');
    assert.equal(r.scope, 'project');
    assert.deepEqual(r.tools, ['Read']);
  });

  test('Claude: with no project agent, the global agent (CLAUDE_CONFIG_DIR) is read', () => {
    writeFiles(globalDir, { 'agents/gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    const r = preflight.readInstalledAgentTools('gsd-executor', 'claude', projectDir);
    assert.equal(r.kind, 'found');
    assert.equal(r.scope, 'global');
    assert.deepEqual(r.tools, ['Read', 'mcp__pencil__*']);
  });

  test('no installed agent file anywhere is unknown, naming every path searched', () => {
    const r = preflight.readInstalledAgentTools('gsd-executor', 'claude', projectDir);
    assert.equal(r.kind, 'unknown');
    assert.equal(r.file, null);
    assert.ok(r.searched.some((p) => p.startsWith(path.join(projectDir, '.claude', 'agents'))), r.searched.join(','));
    assert.ok(r.searched.some((p) => p.startsWith(path.join(globalDir, 'agents'))), r.searched.join(','));
  });

  test('a Claude agent with no tools: key inherits every tool', () => {
    writeFiles(globalDir, { 'agents/gsd-executor.md': agentFile(null) });
    const r = preflight.readInstalledAgentTools('gsd-executor', 'claude', projectDir);
    assert.equal(r.kind, 'found');
    assert.equal(r.tools, 'all');
  });

  test('GSD_AGENTS_DIR, when set, is the only directory read', () => {
    const override = createTempDir('gsd-preflight-override-');
    writeFiles(globalDir, { 'agents/gsd-executor.md': agentFile('mcp__pencil__*') });
    process.env.GSD_AGENTS_DIR = override;
    const r = preflight.readInstalledAgentTools('gsd-executor', 'claude', projectDir);
    assert.equal(r.kind, 'unknown', 'the global agent must not be read when the override is set');
    cleanup(override);
  });

  test('a TOML agent carries no tools: list — unknown, not a pass', () => {
    const override = createTempDir('gsd-preflight-toml-');
    writeFiles(override, { 'gsd-executor.toml': 'name = "gsd-executor"\n' });
    process.env.GSD_AGENTS_DIR = override;
    const r = preflight.readInstalledAgentTools('gsd-executor', 'codex', projectDir);
    assert.equal(r.kind, 'unknown');
    assert.match(r.reason, /TOML/);
    cleanup(override);
  });
});

// ─── plan preflight (in-process) ─────────────────────────────────────────────

describe('preflightPlanContent', () => {
  let projectDir;
  let agentsDir;
  let savedAgentsDir;

  beforeEach(() => {
    savedAgentsDir = process.env.GSD_AGENTS_DIR;
    projectDir = createMnProject('gsd-preflight-plan-');
    agentsDir = createTempDir('gsd-preflight-agents-');
    process.env.GSD_AGENTS_DIR = agentsDir;
  });

  afterEach(() => {
    if (savedAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR;
    else process.env.GSD_AGENTS_DIR = savedAgentsDir;
    cleanup(projectDir);
    cleanup(agentsDir);
  });

  const run = (content, opts = {}) => preflight.preflightPlanContent(content, { projectRoot: projectDir, plan: '01-01-PLAN.md', runtime: 'claude', ...opts });

  test('a plan naming no tool is ok without reading any agent file', () => {
    const r = run(planText({ tasks: 'plain code change' }));
    assert.equal(r.status, 'ok');
    assert.equal(r.agent_file, null);
  });

  test('a wildcard grant covers a .pen plan → ok', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, Write, mcp__pencil__*') });
    const r = run(planText(PEN_DECL));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.missing, []);
  });

  test('an exact grant covers that tool only: the second tool is missing', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__batch_design') });
    const r = run(planText({ extra: 'requires_tools: [mcp__pencil__batch_design, mcp__pencil__get_style]' }));
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.missing, ['mcp__pencil__get_style']);
  });

  test('missing → a fix naming the server wildcard, the config-set command and the reinstall', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, Write') });
    const r = run(planText({ ...PEN_DECL, extra: 'requires_tools: [mcp__pencil__batch_design]' }));
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.fix.grants, ['mcp__pencil__*']);
    assert.deepEqual(r.fix.agent_tools, { 'gsd-executor': ['mcp__pencil__*'] });
    assert.equal(r.fix.config_set, `gsd-tools config-set agent_tools.gsd-executor '["mcp__pencil__*"]'`);
    assert.equal(r.fix.already_configured, false);
  });

  test('the reinstall is described, never an npx/installer command that would replace a fork with upstream', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const r = run(planText(PEN_DECL));
    assert.doesNotMatch(r.fix.reinstall, /npx|gsd-core --|@opengsd/);
    assert.match(r.fix.reinstall, /the same way it was installed/);
    assert.match(r.fix.reinstall, /from this project's root/, 'a global install must be run from the project root to read its agent_tools');
  });

  test('only mentioned in prose → ok, with mentioned_missing and an advisory message', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const r = run(planText({ tasks: 'Do not touch or stage app.pen.' }));
    assert.equal(r.status, 'ok', 'prose never halts');
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.mentioned_missing, ['mcp__pencil__*']);
    assert.match(r.message, /requires_tools/);
  });

  test('a grant already in agent_tools but not installed → the fix is the reinstall alone', () => {
    fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), JSON.stringify({ agent_tools: { 'gsd-executor': ['WebFetch', 'mcp__pencil__*'] } }));
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const r = run(planText(PEN_DECL));
    assert.equal(r.status, 'missing');
    assert.equal(r.fix.already_configured, true);
    assert.deepEqual(r.fix.agent_tools['gsd-executor'], ['WebFetch', 'mcp__pencil__*'], 'existing selector entries are kept');
    assert.doesNotMatch(r.message, /config-set/);
  });

  test('a missing installed agent file is unknown — never a pass', () => {
    const r = run(planText(PEN_DECL));
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /no installed gsd-executor agent/);
    assert.deepEqual(r.missing, []);
  });

  test('a resolvable agent_hint is the agent checked', () => {
    writeFiles(agentsDir, {
      'gsd-executor.md': agentFile('Read'),
      'pencil-designer.md': agentFile('Read, mcp__pencil__*'),
    });
    const r = run(planText({ ...PEN_DECL, extra: 'agent_hint: pencil-designer' }));
    assert.equal(r.agent, 'pencil-designer');
    assert.equal(r.agent_source, 'agent_hint');
    assert.equal(r.status, 'ok');
  });

  test('with agent_hint routing off, the default executor is checked', () => {
    writeWorkflowConfig(projectDir, { agent_hint_routing: false });
    writeFiles(agentsDir, {
      'gsd-executor.md': agentFile('Read'),
      'pencil-designer.md': agentFile('Read, mcp__pencil__*'),
    });
    const r = run(planText({ ...PEN_DECL, extra: 'agent_hint: pencil-designer' }));
    assert.equal(r.agent, 'gsd-executor');
    assert.equal(r.status, 'missing');
  });

  test('a non-Claude runtime is unknown: its installer translated the grants (Copilot)', () => {
    // What the Copilot converter writes for mcp__context7__*: comparing a Claude-syntax need with it
    // read as missing, and the suggested agent_tools fix could not change that answer.
    writeFiles(agentsDir, { 'gsd-executor.agent.md': "---\nname: gsd-executor\ntools: ['read', 'edit', 'io.github.upstash/context7/*']\n---\n" });
    const r = run(planText({ extra: 'requires_tools: [mcp__context7__*]' }), { runtime: 'copilot' });
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /translates tool grants/);
    assert.equal(r.fix, null);
  });

  test('an agent_hint that resolves to no installed agent falls back to gsd-executor', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    const r = run(planText({ ...PEN_DECL, extra: 'agent_hint: nobody' }));
    assert.equal(r.agent, 'gsd-executor');
    assert.equal(r.status, 'ok');
  });
});

// ─── CLI contracts ───────────────────────────────────────────────────────────

describe('CLI: verify tool-preflight and verify plan-structure', () => {
  let projectDir;
  let agentsDir;

  beforeEach(() => {
    projectDir = createMnProject('gsd-preflight-cli-');
    agentsDir = createTempDir('gsd-preflight-cli-agents-');
  });

  afterEach(() => {
    cleanup(projectDir);
    cleanup(agentsDir);
  });

  const env = () => ({ GSD_AGENTS_DIR: agentsDir, GSD_RUNTIME: 'claude' });

  test('verify tool-preflight prints the typed result and exits 0 on missing', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText(PEN_DECL) });
    const r = runGsdTools(['verify', 'tool-preflight', path.join(phaseDir, '01-01-PLAN.md')], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    const json = JSON.parse(r.output);
    assert.equal(json.status, 'missing');
    assert.equal(json.agent, 'gsd-executor');
    assert.deepEqual(json.missing, ['mcp__pencil__*']);
    assert.equal(typeof json.message, 'string');
    assert.deepEqual(json.fix.grants, ['mcp__pencil__*']);
  });

  test('the dotted query form with --raw prints the status alone', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText(PEN_DECL) });
    const r = runGsdTools(['query', 'verify.tool-preflight', path.join(phaseDir, '01-01-PLAN.md'), '--raw'], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    assert.equal(r.output.trim(), 'ok');
  });

  test('--agent forces the agent checked', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read'), 'other.md': agentFile('mcp__pencil__*') });
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText({ ...PEN_DECL, extra: 'agent_hint: other' }) });
    const r = runGsdTools(['verify', 'tool-preflight', path.join(phaseDir, '01-01-PLAN.md'), '--agent', 'gsd-executor'], projectDir, env());
    const json = JSON.parse(r.output);
    assert.equal(json.agent, 'gsd-executor');
    assert.equal(json.agent_source, 'explicit');
    assert.equal(json.status, 'missing');
  });

  test('a plan path outside the project is refused', () => {
    const outside = createTempDir('gsd-preflight-outside-');
    fs.writeFileSync(path.join(outside, 'PLAN.md'), planText());
    const r = runGsdTools(['verify', 'tool-preflight', path.join(outside, 'PLAN.md')], projectDir, env());
    assert.notEqual(r.exitCode, 0);
    cleanup(outside);
  });

  test('verify plan-structure carries tool_preflight and a warning, and stays valid', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText(PEN_DECL) });
    const r = runGsdTools(['verify', 'plan-structure', path.join(phaseDir, '01-01-PLAN.md')], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    const json = JSON.parse(r.output);
    assert.equal(json.valid, true, 'a missing grant is a warning, not a structure error');
    assert.equal(json.tool_preflight.status, 'missing');
    assert.equal(json.warnings.filter((w) => w.startsWith('Tool preflight (missing)')).length, 1);
  });

  test('verify plan-structure on a plan naming no tool adds no warning', () => {
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText({ tasks: 'plain' }) });
    const json = JSON.parse(runGsdTools(['verify', 'plan-structure', path.join(phaseDir, '01-01-PLAN.md')], projectDir, env()).output);
    assert.equal(json.tool_preflight.status, 'ok');
    assert.equal(json.warnings.some((w) => w.startsWith('Tool preflight')), false);
  });
});

// ─── the execute:pre gate ────────────────────────────────────────────────────

describe('check mn-tool-preflight', () => {
  let projectDir;
  let agentsDir;
  let savedAgentsDir;

  beforeEach(() => {
    savedAgentsDir = process.env.GSD_AGENTS_DIR;
    projectDir = createMnProject('gsd-preflight-gate-');
    agentsDir = createTempDir('gsd-preflight-gate-agents-');
    process.env.GSD_AGENTS_DIR = agentsDir;
  });

  afterEach(() => {
    if (savedAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR;
    else process.env.GSD_AGENTS_DIR = savedAgentsDir;
    cleanup(projectDir);
    cleanup(agentsDir);
  });

  const gate = (files) => {
    const { phaseNumber } = makePhase(projectDir, files);
    return evaluateMnToolPreflight({ projectDir, args: [phaseNumber] }).payload;
  };

  test('blocks when a plan to run needs a tool its executor lacks; the message carries the fix', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const v = gate({ '01-01-PLAN.md': planText(PEN_DECL) });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.match(v.message, /agent_tools\.gsd-executor/);
    assert.match(v.message, /never execute the plan under a different agent type/);
  });

  test('passes when every grant is present', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    const v = gate({ '01-01-PLAN.md': planText(PEN_DECL) });
    assert.equal(v.block, false);
    assert.equal(v.checked, 1);
  });

  test('a plan with a SUMMARY is done and is not checked', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const v = gate({
      '01-01-PLAN.md': planText(PEN_DECL),
      '01-01-SUMMARY.md': '---\nphase: 01\n---\n',
    });
    assert.equal(v.block, false);
    assert.equal(v.checked, 0);
  });

  test('unknown (no installed agent) does not block, and the message says it could not check', () => {
    const v = gate({ '01-01-PLAN.md': planText(PEN_DECL) });
    assert.equal(v.block, false);
    assert.match(v.message, /1 could not be checked/);
  });

  test('a plan that only mentions a tool in prose never blocks (the legion false-halt shape)', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const v = gate({ '01-01-PLAN.md': planText({ tasks: 'Do not touch or stage app.pen. Do not use WebFetch.' }) });
    assert.equal(v.block, false);
    assert.equal(v.checked, 1);
  });

  const waved = (wave, extra = '') => planText({ ...PEN_DECL, extra: `${extra}` }).replace('wave: 1', `wave: ${wave}`);

  test('--wave N checks only that wave: a missing grant in another wave does not halt it', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const { phaseNumber } = makePhase(projectDir, {
      '01-01-PLAN.md': waved(1),
      '01-02-PLAN.md': planText().replace('wave: 1', 'wave: 2'),
    });
    const only2 = evaluateMnToolPreflight({ projectDir, args: [phaseNumber, '--wave', '2'] }).payload;
    assert.equal(only2.block, false);
    assert.equal(only2.checked, 1);
    const only1 = evaluateMnToolPreflight({ projectDir, args: ['--wave=1', phaseNumber] }).payload;
    assert.equal(only1.block, true, 'the selected wave still halts');
  });

  test('--gaps-only checks only gap_closure plans', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const { phaseNumber } = makePhase(projectDir, {
      '01-01-PLAN.md': waved(1),
      '01-02-PLAN.md': planText({ extra: 'gap_closure: true' }),
    });
    const gaps = evaluateMnToolPreflight({ projectDir, args: [phaseNumber, '--gaps-only'] }).payload;
    assert.equal(gaps.block, false);
    assert.equal(gaps.checked, 1);
    assert.equal(evaluateMnToolPreflight({ projectDir, args: [phaseNumber] }).payload.block, true);
  });

  test('the gate dispatch tells the orchestrator to pass the run\'s selection to this gate', () => {
    // source-text-is-the-product: the step file is what the orchestrator executes.
    const text = fs.readFileSync(path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase', 'steps', 'execute-pre-gate-hooks.md'), 'utf8');
    assert.ok(text.includes('`mn-tool-preflight` takes the run\'s selection'));
    assert.ok(text.includes('--wave {WAVE_FILTER}') && text.includes('--gaps-only'));
  });

  test('the CLI delivers the same verdict', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const { phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': planText(PEN_DECL) });
    const payload = runMnCheck(projectDir, 'mn-tool-preflight', [phaseNumber]);
    assert.equal(payload.block, true);
    assert.equal(runMnCheck(projectDir, 'mn-tool-preflight', [phaseNumber, '--wave', '2']).block, false, 'the CLI honours --wave');
  });

  test('the capability registers it as a blocking execute:pre gate, on by default', () => {
    const entry = CAPABILITY.gates.find((g) => g.check && g.check.query === 'mn-tool-preflight');
    assert.ok(entry, 'mn-tool-preflight gate must be declared');
    assert.equal(entry.point, 'execute:pre');
    assert.equal(entry.blocking, true);
    assert.equal(entry.when, 'workflow.tool_preflight');
    assert.equal(CAPABILITY.config['workflow.tool_preflight'].default, true);
  });

  test('the gate renders at execute:pre by default and not when switched off', () => {
    const rendered = () => {
      const r = runGsdTools(['loop', 'render-hooks', 'execute:pre', '--raw'], projectDir);
      assert.equal(r.exitCode, 0, r.error);
      return JSON.parse(r.output).activeHooks.filter((h) => h.check && h.check.query === 'mn-tool-preflight');
    };
    assert.equal(rendered().length, 1);
    writeWorkflowConfig(projectDir, { tool_preflight: false });
    assert.equal(rendered().length, 0);
  });
});
