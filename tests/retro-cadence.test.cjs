'use strict';

/**
 * src/retro-cadence.cts — when a retro is due by schedule (ADR-5209 §9):
 * the `milestone-start` and `cadence` triggers, the RUNS.json journal of held
 * retros, and the milestone facts read from the planning files.
 *
 * The schedule is pure over (facts, runs, config) and is driven with typed
 * facts; the journal and the facts reader run in temp projects.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const rc = require('../gsd-core/bin/lib/retro-cadence.cjs');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Typed milestone facts: `executed` phases done, the rest not started. */
function facts({ total = 6, executed = 0, partial = 0, milestone = 'v1.2', shipped = false, roadmap = true, planningDir = '.planning' } = {}) {
  const phases = [];
  for (let i = 1; i <= total; i++) {
    let status = 'no_directory';
    if (i <= executed) status = i % 2 === 0 ? 'complete' : 'executed';
    else if (i <= executed + partial) status = 'partial';
    phases.push({ number: String(i), status });
  }
  return { planningDir, roadmap, milestone, shipped, phases, problems: [] };
}

function runAt(at, { executedPhases = [], milestone = 'v1.2', planningDir = '.planning', stem = 'RETRO-2026-10-20' } = {}) {
  return { stem, at, planningDir, milestone, executedPhases };
}

const CFG = Object.freeze({ cadencePhases: 3, atMilestoneStart: true });

function due(input) {
  return rc.computeRetroDue({ runs: [], config: CFG, active: true, mode: 'suggest', ...input });
}

// ─── cadence ──────────────────────────────────────────────────────────────────

describe('cadence: executed phases since the last retro against retro.cadence_phases', () => {
  // Boundary: N−1, N, N+1 executed phases since the retro, for N = 3 and N = 2.
  for (const n of [2, 3]) {
    for (const [since, expected] of [[n - 1, false], [n, true], [n + 1, true]]) {
      test(`cadence_phases ${n}: ${since} phase(s) since the last retro → due ${expected}`, () => {
        // The retro was held after phase 1; `since` more phases ran after it.
        const d = rc.computeRetroDue({
          facts: facts({ total: 8, executed: 1 + since }),
          runs: [runAt('2026-10-20T10:00:00.000Z', { executedPhases: ['1'] })],
          config: { cadencePhases: n, atMilestoneStart: true },
          active: true,
          mode: 'suggest',
        });
        assert.equal(d.phasesSinceRetro, since);
        assert.equal(d.due, expected);
        assert.equal(d.trigger, expected ? 'cadence' : null);
        assert.equal(d.reason, expected ? 'cadence-reached' : 'not-due');
        assert.equal(d.baseline, 'retro');
        assert.deepEqual(d.phasesSinceRetroIds, Array.from({ length: since }, (_, i) => String(i + 2)));
      });
    }
  }

  test('cadence_phases 0 switches the cadence off at any count', () => {
    for (const executed of [0, 1, 5, 8]) {
      const d = due({ facts: facts({ total: 8, executed }), runs: [runAt('2026-10-20T10:00:00.000Z')], config: { cadencePhases: 0, atMilestoneStart: true } });
      assert.equal(d.triggers.includes('cadence'), false, `executed ${executed}`);
      assert.equal(d.cadencePhases, 0);
    }
  });

  test('without a retro in this milestone the count runs from the milestone start', () => {
    const d = due({ facts: facts({ executed: 3 }) });
    assert.deepEqual([d.due, d.trigger, d.baseline, d.phasesSinceRetro], [true, 'cadence', 'milestone', 3]);
  });

  test('a retro in the previous milestone does not count: the boundary restarts the count', () => {
    const runs = [runAt('2026-10-01T10:00:00.000Z', { milestone: 'v1.1', executedPhases: ['1', '2', '3', '4'] })];
    const d = due({ facts: facts({ executed: 2 }), runs });
    assert.deepEqual([d.baseline, d.phasesSinceRetro, d.due], ['milestone', 2, false]);
    assert.deepEqual(d.lastRetro, { stem: 'RETRO-2026-10-20', at: '2026-10-01T10:00:00.000Z', milestone: 'v1.1' });
  });

  test('the latest retro of the milestone is the baseline, by time not by journal order', () => {
    const runs = [
      runAt('2026-10-22T10:00:00.000Z', { executedPhases: ['1', '2', '3'], stem: 'RETRO-2026-10-22' }),
      runAt('2026-10-20T10:00:00.000Z', { executedPhases: [], stem: 'RETRO-2026-10-20' }),
    ];
    const d = due({ facts: facts({ executed: 4 }), runs });
    assert.deepEqual([d.phasesSinceRetro, d.due, d.lastRetro.stem], [1, false, 'RETRO-2026-10-22']);
  });

  test('a phase in progress does not count; executed and complete do', () => {
    const d = due({ facts: facts({ executed: 2, partial: 1 }), runs: [runAt('2026-10-20T10:00:00.000Z')] });
    assert.equal(d.phasesSinceRetro, 2);
    assert.deepEqual(d.phases, { total: 6, executed: 2, started: 3 });
  });

  test('another planning directory keeps its own schedule', () => {
    const runs = [runAt('2026-10-20T10:00:00.000Z', { planningDir: '.planning/workstreams/other', executedPhases: ['1', '2', '3'] })];
    const d = due({ facts: facts({ executed: 3 }), runs });
    assert.deepEqual([d.baseline, d.due, d.lastRetro], ['milestone', true, null]);
  });
});

// ─── milestone-start ──────────────────────────────────────────────────────────

describe('milestone-start: planned, nothing started, no retro in it yet', () => {
  test('a planned milestone with no phase started is due', () => {
    const d = due({ facts: facts({ executed: 0 }) });
    assert.deepEqual([d.due, d.trigger, d.reason, d.triggers], [true, 'milestone-start', 'milestone-start', ['milestone-start']]);
  });

  test('after the first retro in the milestone it is no longer due', () => {
    const d = due({ facts: facts({ executed: 0 }), runs: [runAt('2026-10-20T10:00:00.000Z', { executedPhases: [] })] });
    assert.deepEqual([d.due, d.reason, d.baseline], [false, 'not-due', 'retro']);
  });

  test('a retro in the previous milestone does not cover this one', () => {
    const d = due({ facts: facts({ executed: 0 }), runs: [runAt('2026-10-01T10:00:00.000Z', { milestone: 'v1.1', executedPhases: ['1'] })] });
    assert.equal(d.trigger, 'milestone-start');
  });

  test('once a phase has started, the start has passed', () => {
    assert.equal(due({ facts: facts({ executed: 0, partial: 1 }) }).due, false);
    assert.equal(due({ facts: facts({ executed: 1 }) }).due, false);
  });

  test('retro.at_milestone_start false switches it off', () => {
    const d = due({ facts: facts({ executed: 0 }), config: { cadencePhases: 3, atMilestoneStart: false } });
    assert.deepEqual([d.due, d.triggers], [false, []]);
  });

  test('a roadmap without phases is not a planned milestone', () => {
    assert.equal(due({ facts: facts({ total: 0 }) }).due, false);
  });

  test('the two schedules exclude each other: nothing executed cannot reach a cadence of 1', () => {
    const d = due({ facts: facts({ executed: 0 }), config: { cadencePhases: 1, atMilestoneStart: true } });
    assert.deepEqual(d.triggers, ['milestone-start']);
  });
});

// ─── what silences the schedule ──────────────────────────────────────────────

describe('what the schedule cannot be due on', () => {
  test('no roadmap', () => {
    const d = due({ facts: facts({ roadmap: false, total: 0 }) });
    assert.deepEqual([d.due, d.reason], [false, 'no-roadmap']);
  });

  test('a shipped milestone: the next milestone-start covers the boundary', () => {
    const d = due({ facts: facts({ executed: 6, shipped: true }) });
    assert.deepEqual([d.due, d.reason, d.triggers], [false, 'milestone-shipped', []]);
  });

  test('retro.auto off and a disabled capability silence it, the counts stay', () => {
    const off = due({ facts: facts({ executed: 3 }), mode: 'off' });
    assert.deepEqual([off.due, off.reason, off.trigger, off.triggers, off.phasesSinceRetro], [false, 'retro-auto-off', null, ['cadence'], 3]);
    const inactive = due({ facts: facts({ executed: 0 }), active: false });
    assert.deepEqual([inactive.due, inactive.reason, inactive.triggers], [false, 'capability-disabled', ['milestone-start']]);
  });
});

// ─── config ───────────────────────────────────────────────────────────────────

describe('resolveCadenceConfig', () => {
  test('absent keeps the defaults: 3 phases, at milestone start', () => {
    assert.deepEqual(rc.resolveCadenceConfig({}), { config: { cadencePhases: 3, atMilestoneStart: true }, problems: [] });
  });

  test('valid values pass, 0 included', () => {
    assert.deepEqual(rc.resolveCadenceConfig({ cadencePhases: 0, atMilestoneStart: false }).config, { cadencePhases: 0, atMilestoneStart: false });
    assert.equal(rc.resolveCadenceConfig({ cadencePhases: 2 }).config.cadencePhases, 2);
  });

  for (const bad of [-1, 2.5, '3', true]) {
    test(`cadence_phases ${JSON.stringify(bad)} keeps 3 and is named`, () => {
      const r = rc.resolveCadenceConfig({ cadencePhases: bad });
      assert.equal(r.config.cadencePhases, 3);
      assert.equal(r.problems.length, 1);
    });
  }

  test('a non-boolean at_milestone_start keeps true and is named', () => {
    const r = rc.resolveCadenceConfig({ atMilestoneStart: 'yes' });
    assert.deepEqual([r.config.atMilestoneStart, r.problems.length], [true, 1]);
  });
});

// ─── the runs journal ─────────────────────────────────────────────────────────

let project;
beforeEach(() => { project = createTempProject('gsd-retro-cadence-'); });
afterEach(() => { cleanup(project); });

describe('RUNS.json', () => {
  const run = runAt('2026-10-20T10:00:00.000Z', { executedPhases: ['1', '2'] });

  test('absent is an empty history; a recorded run reads back', () => {
    assert.deepEqual(rc.readRunsJournal(project), { status: 'absent', journal: { version: 1, runs: [] }, problems: [] });
    assert.deepEqual(rc.recordRun(project, run), { recorded: true, problems: [] });
    const read = rc.readRunsJournal(project);
    assert.deepEqual([read.status, read.journal.runs], ['ok', [run]]);
    assert.equal(rc.runsJournalRelPath(project), '.planning/retro/RUNS.json');
  });

  test('runs are kept in time order', () => {
    rc.recordRun(project, runAt('2026-10-22T10:00:00.000Z', { stem: 'RETRO-2026-10-22' }));
    rc.recordRun(project, runAt('2026-10-21T10:00:00.000Z', { stem: 'RETRO-2026-10-21' }));
    assert.deepEqual(rc.readRunsJournal(project).journal.runs.map((r) => r.stem), ['RETRO-2026-10-21', 'RETRO-2026-10-22']);
  });

  test('a malformed entry is named and the journal is left unchanged', () => {
    const file = rc.runsJournalPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ version: 1, runs: [run, { stem: 'nope', at: 'yesterday' }] });
    fs.writeFileSync(file, text);
    const read = rc.readRunsJournal(project);
    assert.deepEqual([read.status, read.journal.runs.length, read.problems.length], ['ok', 1, 1]);
    const rec = rc.recordRun(project, runAt('2026-10-23T10:00:00.000Z'));
    assert.equal(rec.recorded, false);
    assert.equal(fs.readFileSync(file, 'utf8'), text, 'the history is not rewritten');
  });

  test('a journal that is not JSON is invalid and left unchanged', () => {
    const file = rc.runsJournalPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ nope');
    assert.equal(rc.readRunsJournal(project).status, 'invalid');
    assert.equal(rc.recordRun(project, run).recorded, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
  });

  test('a run that is not well-formed is refused', () => {
    assert.equal(rc.appendRun({ version: 1, runs: [] }, { ...run, at: '2026-10-20' }).ok, false);
    assert.equal(rc.appendRun({ version: 1, runs: [] }, { ...run, stem: 'RETRO-x' }).ok, false);
  });
});

// ─── milestone facts from the planning files ─────────────────────────────────

describe('readMilestoneFacts', () => {
  function writeMilestone(phaseCount, { version = 'v1.2', heading = `## ${version} — Cadence` } = {}) {
    const planning = path.join(project, '.planning');
    fs.writeFileSync(path.join(planning, 'STATE.md'), `---\nmilestone: ${version}\n---\n# State\n`);
    const phases = Array.from({ length: phaseCount }, (_, i) => `### Phase ${i + 1}: P${i + 1}\n**Goal:** g${i + 1}\n`).join('\n');
    fs.writeFileSync(path.join(planning, 'ROADMAP.md'), `# Roadmap\n\n${heading}\n\n${phases}`);
  }
  function executePhase(n, { verified = false } = {}) {
    const dir = path.join(project, '.planning', 'phases', `0${n}-p${n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `0${n}-01-PLAN.md`), '# Plan');
    fs.writeFileSync(path.join(dir, `0${n}-01-SUMMARY.md`), '# Summary');
    if (verified) fs.writeFileSync(path.join(dir, `0${n}-VERIFICATION.md`), '---\nstatus: passed\n---\n# Verification\n');
  }

  test('no ROADMAP.md: nothing to be due on, and no problem', () => {
    const f = rc.readMilestoneFacts(project);
    assert.deepEqual([f.roadmap, f.milestone, f.phases, f.problems], [false, null, [], []]);
    assert.equal(f.planningDir, '.planning');
  });

  test('the current milestone, its phases and what ran', () => {
    writeMilestone(3);
    executePhase(1, { verified: true });
    executePhase(2);
    const f = rc.readMilestoneFacts(project);
    assert.deepEqual([f.roadmap, f.milestone, f.shipped], [true, 'v1.2', false]);
    assert.deepEqual(f.phases, [
      { number: '1', status: 'complete' },
      { number: '2', status: 'executed' },
      { number: '3', status: 'no_directory' },
    ]);
    assert.deepEqual(rc.executedPhaseNumbers(f), ['1', '2']);
  });

  test('an archived snapshot marks the milestone shipped', () => {
    writeMilestone(2);
    fs.mkdirSync(path.join(project, '.planning', 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(project, '.planning', 'milestones', 'v1.2-ROADMAP.md'), '# archived\n');
    assert.equal(rc.readMilestoneFacts(project).shipped, true);
  });

  test('a run journaled now snapshots the executed phases', () => {
    writeMilestone(3);
    executePhase(1);
    const r = rc.runFor('RETRO-2026-10-25', new Date('2026-10-25T09:30:00Z'), rc.readMilestoneFacts(project));
    assert.deepEqual(r, { stem: 'RETRO-2026-10-25', at: '2026-10-25T09:30:00.000Z', planningDir: '.planning', milestone: 'v1.2', executedPhases: ['1'] });
  });
});
