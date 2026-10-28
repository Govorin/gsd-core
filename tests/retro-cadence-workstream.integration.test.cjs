'use strict';

/**
 * The retro schedule under a workstream (ADR-5209 §9): `retro due` and
 * `retro stage` read the workstream's own milestone when it is named by
 * `--ws` or `GSD_WORKSTREAM`, the stage hands the workstream on to the retro
 * it proposes, and the retro that runs with it journals that planning
 * directory — so the workstream's count restarts and the root's is untouched.
 *
 * Assertions are on the JSON the CLI prints and the journal it writes.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');
const st = require('../gsd-core/bin/lib/session-transcript.cjs');

const WS = 'foo';

let project;
let sessions;
let gsdHome;
beforeEach(() => {
  project = createTempGitProject('gsd-retro-ws-');
  sessions = createTempDir('gsd-retro-ws-sessions-');
  // prepare reads the lessons journal ($GSD_HOME/.gsd/lessons): never the real one.
  gsdHome = createTempDir('gsd-retro-ws-home-');
  // The workstream has a planned milestone; the root has no roadmap at all.
  const wsDir = path.join(project, '.planning', 'workstreams', WS);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'STATE.md'), '---\nmilestone: v2.0\n---\n# State\n');
  fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), '# Roadmap\n\n## v2.0 — Streams\n\n### Phase 1: A\n**Goal:** a\n\n### Phase 2: B\n**Goal:** b\n');
  const dir = path.join(sessions, st.encodeProjectDirName(fs.realpathSync(project)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sess-ws.jsonl'), [
    JSON.stringify({ uuid: 'w-1', timestamp: '2026-10-25T00:00:00Z', type: 'user', userType: 'external', message: { content: 'plan the stream' } }),
    JSON.stringify({ uuid: 'w-2', timestamp: '2026-10-25T00:00:01Z', type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  ].join('\n') + '\n');
});
afterEach(() => {
  cleanup(project);
  cleanup(sessions);
  cleanup(gsdHome);
});

function retro(args, env = {}) {
  const res = runGsdTools(['retro', ...args], project, { GSD_RUNTIME: 'claude', GSD_HOME: gsdHome, ...env });
  assert.equal(res.success, true, res.error);
  return JSON.parse(res.output);
}

function runs() {
  return JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'RUNS.json'), 'utf8')).runs;
}

describe('retro due under a workstream', () => {
  test('--ws names the workstream: its milestone is due at its start', () => {
    const d = retro(['due', '--ws', WS]);
    assert.deepEqual([d.planningDir, d.milestone, d.due, d.trigger], [`.planning/workstreams/${WS}`, 'v2.0', true, 'milestone-start']);
  });

  test('GSD_WORKSTREAM names it just the same', () => {
    const d = retro(['due'], { GSD_WORKSTREAM: WS });
    assert.deepEqual([d.planningDir, d.due, d.trigger], [`.planning/workstreams/${WS}`, true, 'milestone-start']);
  });

  test('without either the root is read, and it has no roadmap', () => {
    const d = retro(['due']);
    assert.deepEqual([d.planningDir, d.due, d.reason], ['.planning', false, 'no-roadmap']);
  });
});

describe('the stage carries the workstream to the retro it proposes', () => {
  for (const [how, args, env] of [['--ws', ['--ws', WS], {}], ['GSD_WORKSTREAM', [], { GSD_WORKSTREAM: WS }]]) {
    test(`named by ${how}: next names it, and the retro it starts restarts that workstream's count`, () => {
      const stage = retro(['stage', '--milestone', 'v2.0', '--sessions-dir', sessions, ...args], env);
      assert.deepEqual([stage.decision, stage.trigger], ['suggest', 'milestone-start']);
      assert.equal(stage.next.args, `--session sess-ws --ws ${WS}`);

      // /gsd-retro passes next.args to prepare unchanged (retro.md parse_arguments).
      const prep = retro(['prepare', ...stage.next.args.split(' '), '--sessions-dir', sessions]);
      assert.equal(prep.run.recorded, true);
      assert.deepEqual(runs().map((r) => [r.planningDir, r.milestone]), [[`.planning/workstreams/${WS}`, 'v2.0']]);

      const after = retro(['due', '--ws', WS]);
      assert.deepEqual([after.due, after.baseline, after.lastRetro.stem], [false, 'retro', prep.stem]);
      // The root keeps its own (empty) history.
      assert.equal(retro(['due']).lastRetro, null);
    });
  }
});
