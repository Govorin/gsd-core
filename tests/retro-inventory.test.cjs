'use strict';

/**
 * src/retro-inventory.cts — what guardrails a project already has.
 *
 * Temp projects only. The capability registry and active-capability resolver
 * are injected so a gate's presence and state do not depend on the GSD
 * install running the test; git goes through an injected runner except in
 * the one test that checks the real hook-installation probe.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');

const { buildRetroInventory, invokesScript } = require('../gsd-core/bin/lib/retro-inventory.cjs');

const write = (root, rel, content) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
};

// No git: config lookups fail, the hook probe reports "unknown".
const noGit = () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null, timedOut: false });

const registry = {
  capabilities: {
    security: {
      gates: [{ point: 'ship:pre', check: { predicate: { kind: 'artifact-frontmatter-equals' } }, when: 'workflow.security_enforcement', blocking: true }],
    },
    tdd: {
      gates: [{ point: 'execute:post', check: { query: 'tdd.review-checkpoint' }, when: 'workflow.tdd_mode', blocking: false }],
    },
    plain: {},
  },
};
const baseOpts = { execGit: noGit, registry, activeCapabilities: () => new Set(['security']) };

const kinds = (inv) => inv.findings.map((f) => `${f.kind}:${f.subject}`).sort();

describe('invokesScript', () => {
  test('recognises npm/pnpm/yarn/bun invocations and npm test shorthands, not prefixes', () => {
    assert.equal(invokesScript('run: npm run lint', 'lint'), true);
    assert.equal(invokesScript('pnpm lint:ci && echo', 'lint:ci'), true);
    assert.equal(invokesScript('yarn run check', 'check'), true);
    assert.equal(invokesScript('bun run test', 'test'), true);
    assert.equal(invokesScript('npm test', 'test'), true);
    assert.equal(invokesScript('npm t', 'test'), true);
    assert.equal(invokesScript('npm run lint:ci', 'lint'), false, 'lint:ci is not lint');
    assert.equal(invokesScript('echo lint', 'lint'), false);
  });
});

describe('buildRetroInventory — a project with guardrails, some unwired', () => {
  let root;
  beforeEach(() => {
    root = createTempDir('gsd-retro-inv-');
    write(root, 'package.json', {
      scripts: {
        lint: 'eslint .',
        'lint:ci': 'npm run lint && node scripts/check-x.cjs',
        'lint:fix': 'eslint . --fix',
        test: 'node --test',
        'check:docs': 'node scripts/check-docs.cjs',
        'check:orphan': 'node scripts/orphan.cjs',
        typecheck: 'tsc --noEmit',
        build: 'tsc',
      },
    });
    write(root, '.github/workflows/ci.yml', 'jobs:\n  t:\n    steps:\n      - run: npm run lint:ci\n      - run: npm test\n      - run: node scripts/check-docs.cjs\n');
    write(root, 'lefthook.yml', 'pre-commit:\n  commands:\n    types:\n      run: npm run typecheck\n');
    write(root, 'eslint.config.js', "module.exports = [{ rules: { 'local/no-wired': 'error' } }];\n");
    write(root, 'eslint-rules/no-wired.js', 'module.exports = {};\n');
    write(root, 'eslint-rules/no-orphan.js', 'module.exports = {};\n');
    write(root, 'eslint-rules/index.js', 'module.exports = {};\n');
    write(root, '.claude/settings.json', {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$HOME/.claude/hooks/gsd-prompt-guard.js"' }] }],
        Stop: [{ hooks: [{ type: 'command', command: './scripts/quality-gate.sh --token=abcdefghijkl' }] }],
      },
    });
    write(root, '.planning/config.json', {
      workflow: { verify_gates: { tests: 'npm test' }, security_enforcement: true },
      agent_skills: { 'gsd-code-reviewer': ['standards'], 'gsd-executor': 'tdd' },
    });
    write(root, '.claude/skills/standards/SKILL.md', '# s\n');
    write(root, 'CLAUDE.md', 'x'.repeat(1234));
    write(root, '.plans/rules-registry/merged.json', {
      rows: [
        { id: 'R-1', enforced_by: ['eslint/no-x'], checkable: 'ast' },
        { id: 'R-2', enforced_by: [], checkable: 'ast' },
        { id: 'R-3', enforced_by: [], checkable: 'semantic' },
        { id: 'R-4', checkable: 'types' },
      ],
    });
  });
  afterEach(() => { cleanup(root); });

  test('scripts are classified and wired through CI, pre-commit, verbatim bodies and script chains', () => {
    const inv = buildRetroInventory(root, baseOpts);
    assert.equal(inv.scripts.packageJson, true);
    const byName = Object.fromEntries(inv.scripts.entries.map((e) => [e.name, e]));
    assert.equal(byName.build, undefined, 'build is not a check');
    assert.deepEqual(
      Object.fromEntries(Object.entries(byName).map(([n, e]) => [n, [e.class, e.wired]])),
      {
        'check:docs': ['check', true],     // CI runs its command line verbatim
        'check:orphan': ['check', false],
        lint: ['lint', true],              // reached through lint:ci
        'lint:ci': ['lint', true],
        'lint:fix': ['lint', false],
        test: ['test', true],
        typecheck: ['typecheck', true],    // lefthook runs it
      },
    );
  });

  test('every class is reported and only the real gaps are findings', () => {
    const inv = buildRetroInventory(root, baseOpts);
    assert.deepEqual(inv.ci.files, ['.github/workflows/ci.yml']);
    assert.deepEqual(inv.precommit, { tools: ['lefthook'], gitHookInstalled: null, hooksPath: null });
    assert.deepEqual(inv.lint.configs, ['eslint.config.js']);
    assert.deepEqual(inv.lint.localRules, [
      { name: 'no-orphan', file: 'eslint-rules/no-orphan.js', wired: false },
      { name: 'no-wired', file: 'eslint-rules/no-wired.js', wired: true },
    ]);
    assert.deepEqual(inv.verifyGates, { configured: true, names: ['tests'], problems: [] });
    assert.deepEqual(inv.agentSkills, { 'gsd-code-reviewer': ['standards'], 'gsd-executor': ['tdd'] });
    assert.deepEqual(inv.skills, ['standards']);
    assert.deepEqual(inv.steeringFiles, [{ path: 'CLAUDE.md', bytes: 1234 }]);
    assert.deepEqual(inv.rulesRegistry, { path: '.plans/rules-registry/merged.json', total: 4, proseOnly: 2, proseOnlyIds: ['R-2', 'R-4'] });
    assert.deepEqual(kinds(inv), [
      'unwired-check:lint rule no-orphan',
      'unwired-check:script check:orphan',
    ], 'lint:fix is a fixer, not an unwired check; the hook probe being unknown is not a finding');
    assert.deepEqual(inv.problems, []);
  });

  test('Claude hooks are listed with GSD-managed ones marked and commands redacted', () => {
    const inv = buildRetroInventory(root, baseOpts);
    assert.deepEqual(inv.claudeHooks.map((h) => [h.event, h.matcher, h.gsdManaged]), [['PreToolUse', 'Bash', true], ['Stop', null, false]]);
    assert.equal(inv.claudeHooks[1].command.includes('abcdefghijkl'), false);
  });

  test('capability gates carry their active state and the raw when value', () => {
    const inv = buildRetroInventory(root, baseOpts);
    assert.deepEqual(inv.capabilityGates, [
      { capability: 'security', active: true, point: 'ship:pre', check: 'predicate artifact-frontmatter-equals', when: 'workflow.security_enforcement', whenValue: true, blocking: true },
      { capability: 'tdd', active: false, point: 'execute:post', check: 'query tdd.review-checkpoint', when: 'workflow.tdd_mode', whenValue: null, blocking: false },
    ]);
  });

  test('an unresolvable capability state reads as null, with the cause in problems', () => {
    const inv = buildRetroInventory(root, { ...baseOpts, activeCapabilities: () => { throw new Error('no runtime'); } });
    assert.deepEqual(inv.capabilityGates.map((g) => g.active), [null, null]);
    assert.match(inv.problems.join('\n'), /capability state unresolved: no runtime/);
  });

  test('a rules registry path outside the project is refused', () => {
    const outside = createTempDir('gsd-retro-outside-');
    const inv = buildRetroInventory(root, { ...baseOpts, rulesRegistryPath: path.join(outside, 'merged.json') });
    cleanup(outside);
    assert.equal(inv.rulesRegistry, null);
    assert.match(inv.problems.join('\n'), /rules registry validation failed/);
  });

  test('a malformed verify_gates entry is an unwired-check finding, not "nothing configured"', () => {
    write(root, '.planning/config.json', { workflow: { verify_gates: { tests: '' } } });
    const inv = buildRetroInventory(root, baseOpts);
    assert.equal(inv.verifyGates.configured, false);
    assert.equal(inv.verifyGates.problems.length, 1);
    assert.ok(kinds(inv).includes('unwired-check:verify-gates'));
    assert.equal(kinds(inv).includes('missing-guardrail:verify-gates'), false);
  });

  test('malformed JSON inputs are reported, the rest of the inventory still builds', () => {
    write(root, '.claude/settings.json', '{ not json');
    const inv = buildRetroInventory(root, baseOpts);
    assert.deepEqual(inv.claudeHooks, []);
    assert.match(inv.problems.join('\n'), /\.claude\/settings\.json: not valid JSON/);
    assert.equal(inv.ci.files.length, 1);
  });
});

describe('buildRetroInventory — absence of guardrails is the finding', () => {
  let root;
  beforeEach(() => { root = createTempDir('gsd-retro-inv-empty-'); });
  afterEach(() => { cleanup(root); });

  test('an empty project: no lint, no CI, no pre-commit, no verify gates', () => {
    const inv = buildRetroInventory(root, baseOpts);
    assert.deepEqual(kinds(inv), [
      'missing-guardrail:ci',
      'missing-guardrail:lint',
      'missing-guardrail:pre-commit',
      'missing-guardrail:verify-gates',
    ]);
  });

  test('a package.json without lint or test scripts names both; an empty workflows dir is still no CI', () => {
    write(root, 'package.json', { scripts: { build: 'tsc' } });
    fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
    const inv = buildRetroInventory(root, baseOpts);
    assert.ok(kinds(inv).includes('missing-guardrail:lint'));
    assert.ok(kinds(inv).includes('missing-guardrail:test'));
    assert.ok(kinds(inv).includes('missing-guardrail:ci'));
  });

  test('with no CI and no pre-commit, an unrun script is not called unwired — there is nothing to wire it into', () => {
    write(root, 'package.json', { scripts: { lint: 'eslint .', test: 'node --test' } });
    const inv = buildRetroInventory(root, baseOpts);
    assert.equal(kinds(inv).some((k) => k.startsWith('unwired-check:script')), false);
  });
});

describe('buildRetroInventory — the real git hook probe', () => {
  test('pre-commit tooling with no installed hook is unwired; installing one clears it', (t) => {
    const root = createTempGitProject('gsd-retro-inv-git-');
    t.after(() => cleanup(root));
    const git = (args) => {
      const res = runGit(args, { cwd: root });
      assert.deepEqual([res.outcome, res.exitCode], [OUTCOME.EXITED, 0], res.stderr);
    };
    // A local hooksPath overrides any global one the machine running the test has.
    git(['config', 'core.hooksPath', '.githooks']);
    write(root, '.husky/pre-commit', 'npm test\n');
    const opts = { registry, activeCapabilities: () => new Set() };
    const before = buildRetroInventory(root, opts);
    assert.deepEqual(before.precommit, { tools: ['husky'], gitHookInstalled: false, hooksPath: '.githooks' });
    assert.ok(kinds(before).includes('unwired-check:pre-commit'));
    write(root, '.githooks/pre-commit', '#!/bin/sh\nnpm test\n');
    const after = buildRetroInventory(root, opts);
    assert.equal(after.precommit.gitHookInstalled, true);
    assert.equal(kinds(after).includes('unwired-check:pre-commit'), false);
  });
});
