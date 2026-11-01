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
 *   - what counts as a requirement (MCP names, `.pen` files, a closed list of built-in tools — and
 *     what does not: the objective's prose);
 *   - grant matching, exact and wildcard, at the server-name boundary;
 *   - where the installed agent is read from, and that could-not-look is `unknown`, never `ok`;
 *   - the three surfaces: `verify tool-preflight`, `verify plan-structure`'s `tool_preflight`, and
 *     the execute:pre gate `check mn-tool-preflight`, which blocks only on `missing`.
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

describe('extractRequiredTools', () => {
  test('an MCP tool name in a task is required exactly', () => {
    const r = preflight.extractRequiredTools(planText({ tasks: 'Call mcp__pencil__batch_design to draw.' }));
    assert.deepEqual(tools(r), ['mcp__pencil__batch_design']);
    assert.equal(r[0].source, 'mcp-name');
    assert.equal(r[0].where, 'tasks');
  });

  test('a server wildcard or a bare server name is a whole-server requirement', () => {
    const r = preflight.extractRequiredTools(planText({ tasks: 'Use `mcp__figma__*` and then mcp__atlas.' }));
    assert.deepEqual(tools(r), ['mcp__figma__*', 'mcp__atlas__*']);
  });

  test('a plugin-namespaced MCP name keeps its server segment intact', () => {
    const r = preflight.extractRequiredTools(planText({ tasks: 'mcp__plugin_serena_serena__find_symbol' }));
    assert.deepEqual(tools(r), ['mcp__plugin_serena_serena__find_symbol']);
  });

  test('a .pen file in a task, in <context> or in files_modified requires the Pencil server', () => {
    for (const [opts, where] of [
      [{ tasks: 'Edit design/app.pen' }, 'tasks'],
      [{ context: '@design/screens.pen' }, 'context'],
      [{ files: '[design/app.pen]' }, 'files_modified'],
    ]) {
      const r = preflight.extractRequiredTools(planText(opts));
      assert.deepEqual(tools(r), ['mcp__pencil__*'], JSON.stringify(opts));
      assert.equal(r[0].source, 'pen-file');
      assert.equal(r[0].where, where);
    }
  });

  test('the closed list of built-in tool names is recognised; other CamelCase words are not', () => {
    const r = preflight.extractRequiredTools(planText({ tasks: 'Use WebFetch, `WebSearch`, NotebookEdit and AskUserQuestion; the Agent runs a Task.' }));
    assert.deepEqual(tools(r).sort(), ['AskUserQuestion', 'NotebookEdit', 'WebFetch', 'WebSearch']);
  });

  test('the objective\'s prose is not a requirement', () => {
    const r = preflight.extractRequiredTools(planText({ objective: 'Not doing: design/app.pen or mcp__pencil__x' }));
    assert.deepEqual(r, []);
  });

  test('one entry per tool: the first sighting is kept as evidence', () => {
    const r = preflight.extractRequiredTools(planText({ tasks: 'a.pen then b.pen', files: '[c.pen]' }));
    assert.equal(r.length, 1);
    assert.equal(r[0].evidence, 'a.pen');
  });

  test('a lookalike extension (.pencil, .penX) is not a .pen file', () => {
    assert.deepEqual(preflight.extractRequiredTools(planText({ tasks: 'see notes.pencil and x.penx' })), []);
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
    const r = run(planText({ tasks: 'Edit design/app.pen' }));
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.missing, []);
  });

  test('an exact grant covers that tool only: the second tool is missing', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__batch_design') });
    const r = run(planText({ tasks: 'mcp__pencil__batch_design then mcp__pencil__get_style' }));
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.missing, ['mcp__pencil__get_style']);
  });

  test('missing → a fix naming the server wildcard, the config-set command and the reinstall', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, Write') });
    const r = run(planText({ tasks: 'Edit design/app.pen with mcp__pencil__batch_design' }));
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.fix.grants, ['mcp__pencil__*']);
    assert.deepEqual(r.fix.agent_tools, { 'gsd-executor': ['mcp__pencil__*'] });
    assert.equal(r.fix.config_set, `gsd-tools config-set agent_tools.gsd-executor '["mcp__pencil__*"]'`);
    assert.equal(r.fix.reinstall, 'gsd-core --claude --global');
    assert.equal(r.fix.already_configured, false);
  });

  test('a grant already in agent_tools but not installed → the fix is the reinstall alone', () => {
    fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), JSON.stringify({ agent_tools: { 'gsd-executor': ['WebFetch', 'mcp__pencil__*'] } }));
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const r = run(planText({ tasks: 'Edit design/app.pen' }));
    assert.equal(r.status, 'missing');
    assert.equal(r.fix.already_configured, true);
    assert.deepEqual(r.fix.agent_tools['gsd-executor'], ['WebFetch', 'mcp__pencil__*'], 'existing selector entries are kept');
    assert.doesNotMatch(r.message, /config-set/);
  });

  test('a missing installed agent file is unknown — never a pass', () => {
    const r = run(planText({ tasks: 'Edit design/app.pen' }));
    assert.equal(r.status, 'unknown');
    assert.match(r.reason, /no installed gsd-executor agent/);
    assert.deepEqual(r.missing, []);
  });

  test('a resolvable agent_hint is the agent checked', () => {
    writeFiles(agentsDir, {
      'gsd-executor.md': agentFile('Read'),
      'pencil-designer.md': agentFile('Read, mcp__pencil__*'),
    });
    const r = run(planText({ tasks: 'Edit design/app.pen', extra: 'agent_hint: pencil-designer' }));
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
    const r = run(planText({ tasks: 'Edit design/app.pen', extra: 'agent_hint: pencil-designer' }));
    assert.equal(r.agent, 'gsd-executor');
    assert.equal(r.status, 'missing');
  });

  test('an agent_hint that resolves to no installed agent falls back to gsd-executor', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    const r = run(planText({ tasks: 'Edit design/app.pen', extra: 'agent_hint: nobody' }));
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
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
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
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
    const r = runGsdTools(['query', 'verify.tool-preflight', path.join(phaseDir, '01-01-PLAN.md'), '--raw'], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    assert.equal(r.output.trim(), 'ok');
  });

  test('--agent forces the agent checked', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read'), 'other.md': agentFile('mcp__pencil__*') });
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen', extra: 'agent_hint: other' }) });
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
    const { phaseDir } = makePhase(projectDir, { '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
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
    const v = gate({ '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
    assert.equal(v.block, true);
    assert.equal(v.status, 'finding');
    assert.match(v.message, /agent_tools\.gsd-executor/);
    assert.match(v.message, /never execute the plan under a different agent type/);
  });

  test('passes when every grant is present', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read, mcp__pencil__*') });
    const v = gate({ '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
    assert.equal(v.block, false);
    assert.equal(v.checked, 1);
  });

  test('a plan with a SUMMARY is done and is not checked', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const v = gate({
      '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }),
      '01-01-SUMMARY.md': '---\nphase: 01\n---\n',
    });
    assert.equal(v.block, false);
    assert.equal(v.checked, 0);
  });

  test('unknown (no installed agent) does not block, and the message says it could not check', () => {
    const v = gate({ '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
    assert.equal(v.block, false);
    assert.match(v.message, /1 could not be checked/);
  });

  test('the CLI delivers the same verdict', () => {
    writeFiles(agentsDir, { 'gsd-executor.md': agentFile('Read') });
    const { phaseNumber } = makePhase(projectDir, { '01-01-PLAN.md': planText({ tasks: 'Edit design/app.pen' }) });
    const payload = runMnCheck(projectDir, 'mn-tool-preflight', [phaseNumber]);
    assert.equal(payload.block, true);
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
