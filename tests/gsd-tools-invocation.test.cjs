'use strict';

/**
 * ADR-5211 — gsd-tools-invocation.cts: the literal `node '<path>'` an
 * orchestrator substitutes for {GSD_TOOLS_CMD} in a worktree sub-agent's prompt.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempProject, cleanup, runGsdTools, TOOLS_PATH } = require('./helpers.cjs');
const { runNode, runHook } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { resolveGsdToolsInvocation } = require('../gsd-core/bin/lib/gsd-tools-invocation.cjs');

const identity = { realpath: (p) => p, isFile: () => true };

describe('resolveGsdToolsInvocation', () => {
  test('describes the gsd-tools.cjs this module ships beside, by realpath', () => {
    const inv = resolveGsdToolsInvocation();
    assert.equal(inv.gsd_tools_path, fs.realpathSync.native(TOOLS_PATH).split(path.sep).join('/'));
    assert.equal(inv.gsd_tools_cmd, `node '${inv.gsd_tools_path}'`);
  });

  test('a symlinked install resolves to the real file', (t) => {
    const dir = createTempDir('gsd-invocation-link-');
    t.after(() => cleanup(dir));
    const link = path.join(dir, 'gsd-tools.cjs');
    fs.symlinkSync(TOOLS_PATH, link);
    const inv = resolveGsdToolsInvocation({ toolPath: link });
    assert.equal(inv.gsd_tools_path, fs.realpathSync.native(TOOLS_PATH).split(path.sep).join('/'));
  });

  test('a single quote in the path is escaped the POSIX way', () => {
    const inv = resolveGsdToolsInvocation({ ...identity, toolPath: "/a b/it's/gsd-tools.cjs" });
    assert.equal(inv.gsd_tools_cmd, "node '/a b/it'\\''s/gsd-tools.cjs'");
  });

  test('a Windows path is projected to forward slashes for git-bash', () => {
    const inv = resolveGsdToolsInvocation({ ...identity, toolPath: 'C:\\Users\\RUNNER~1\\x y\\gsd-tools.cjs' });
    assert.equal(inv.gsd_tools_path, 'C:/Users/RUNNER~1/x y/gsd-tools.cjs');
    assert.equal(inv.gsd_tools_cmd, "node 'C:/Users/RUNNER~1/x y/gsd-tools.cjs'");
  });

  test('a local install inside the project tree is described as-is (probe P2: the host accepts it)', () => {
    const inv = resolveGsdToolsInvocation({ ...identity, toolPath: '/repo/.claude/gsd-core/bin/gsd-tools.cjs' });
    assert.equal(inv.gsd_tools_cmd, "node '/repo/.claude/gsd-core/bin/gsd-tools.cjs'");
  });

  test('an unresolvable tool yields nulls, never a guessed path', () => {
    assert.deepEqual(resolveGsdToolsInvocation({ toolPath: '/nonexistent/gsd-tools.cjs' }), { gsd_tools_path: null, gsd_tools_cmd: null });
    assert.deepEqual(resolveGsdToolsInvocation({ realpath: (p) => p, isFile: () => false }), { gsd_tools_path: null, gsd_tools_cmd: null });
  });
});

describe('the literal survives the shell', { skip: process.platform === 'win32' ? 'bash round trip is POSIX-only here' : false }, () => {
  test('a path with a space and a quote reaches node intact', (t) => {
    const dir = createTempDir('gsd-invocation-quote-');
    t.after(() => cleanup(dir));
    const weird = path.join(dir, "it's a dir");
    fs.mkdirSync(weird);
    const script = path.join(weird, 'echo-argv.cjs');
    fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({ self: __filename, args: process.argv.slice(2) }));\n');
    const inv = resolveGsdToolsInvocation({ toolPath: script });
    const r = runHook('-c', [`${inv.gsd_tools_cmd} worktree guard branch`], { interpreter: 'bash', timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.self, fs.realpathSync.native(script));
    assert.deepEqual(out.args, ['worktree', 'guard', 'branch']);
  });
});

describe('init and the tools-cmd verb expose the literal', () => {
  test('the described path proves the @opengsd/gsd-core identity', () => {
    const inv = resolveGsdToolsInvocation();
    const r = runNode([inv.gsd_tools_path, 'runtime-identity', '--raw'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).packageName, '@opengsd/gsd-core');
  });

  for (const args of [['init', 'quick', 'append a line'], ['init', 'quick-batch'], ['worktree', 'tools-cmd']]) {
    test(`${args.join(' ')} reports gsd_tools_cmd`, (t) => {
      const dir = createTempProject('gsd-invocation-init-');
      t.after(() => cleanup(dir));
      const r = runGsdTools(args, dir);
      assert.equal(r.exitCode, 0, r.error);
      const json = JSON.parse(r.output.startsWith('@file:') ? fs.readFileSync(r.output.slice(6), 'utf8') : r.output);
      assert.equal(json.gsd_tools_cmd, resolveGsdToolsInvocation().gsd_tools_cmd);
    });
  }

  test('worktree tools-cmd --raw prints the command alone', (t) => {
    const dir = createTempProject('gsd-invocation-raw-');
    t.after(() => cleanup(dir));
    const r = runGsdTools(['worktree', 'tools-cmd', '--raw'], dir);
    assert.equal(r.output, resolveGsdToolsInvocation().gsd_tools_cmd);
  });
});
