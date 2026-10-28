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

  // The default (absent from config) is 2: limit−1, limit, limit+1.
  for (const [since, expected] of [[1, false], [2, true], [3, true]]) {
    test(`default config: ${since} phase(s) since the last retro → due ${expected}`, () => {
      const { config } = rc.resolveCadenceConfig({});
      assert.equal(config.cadencePhases, 2);
      const d = rc.computeRetroDue({
        facts: facts({ total: 8, executed: 1 + since }),
        runs: [runAt('2026-10-20T10:00:00.000Z', { executedPhases: ['1'] })],
        config,
        active: true,
        mode: 'suggest',
      });
      assert.deepEqual([d.phasesSinceRetro, d.due, d.trigger, d.cadencePhases], [since, expected, expected ? 'cadence' : null, 2]);
    });
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

// ─── a journal that cannot be read fails closed ──────────────────────────────

describe('journal-invalid: nothing is counted from a journal that cannot be read whole', () => {
  const broken = ['RUNS.json is not JSON: Unexpected token'];

  test('with phases due by count, the schedule pauses instead of reading "no retro yet"', () => {
    const d = due({ facts: facts({ executed: 3 }), journalProblems: broken });
    assert.deepEqual([d.due, d.trigger, d.triggers, d.reason], [false, null, [], 'journal-invalid']);
    assert.deepEqual([d.phasesSinceRetro, d.phasesSinceRetroIds, d.baseline, d.lastRetro], [null, null, 'unknown', null]);
    assert.ok(d.problems.includes(broken[0]), 'the journal problem is reported');
  });

  test('at a milestone start too: "no retro in this milestone" cannot be known', () => {
    const d = due({ facts: facts({ executed: 0 }), journalProblems: broken });
    assert.deepEqual([d.due, d.reason], [false, 'journal-invalid']);
  });

  test('one malformed entry is enough: the well-formed runs are not taken as the whole history', () => {
    const d = due({ facts: facts({ executed: 4 }), runs: [runAt('2026-10-20T10:00:00.000Z', { executedPhases: ['1'] })], journalProblems: ['runs[1]: stem must be …'] });
    assert.deepEqual([d.due, d.reason, d.phasesSinceRetro], [false, 'journal-invalid', null]);
  });

  test('with both schedules switched off the journal does not matter', () => {
    const d = due({ facts: facts({ executed: 3 }), journalProblems: broken, config: { cadencePhases: 0, atMilestoneStart: false } });
    assert.equal(d.reason, 'not-due');
  });

  test('the switches that silence the schedule still come first', () => {
    assert.equal(due({ facts: facts({ executed: 3 }), journalProblems: broken, mode: 'off' }).reason, 'retro-auto-off');
    assert.equal(due({ facts: facts({ executed: 3 }), journalProblems: broken, active: false }).reason, 'capability-disabled');
  });
});

// ─── config ───────────────────────────────────────────────────────────────────

describe('resolveCadenceConfig', () => {
  test('absent keeps the defaults: 2 phases, at milestone start', () => {
    assert.deepEqual(rc.resolveCadenceConfig({}), { config: { cadencePhases: 2, atMilestoneStart: true }, problems: [] });
  });

  test('valid values pass, 0 included', () => {
    assert.deepEqual(rc.resolveCadenceConfig({ cadencePhases: 0, atMilestoneStart: false }).config, { cadencePhases: 0, atMilestoneStart: false });
    assert.equal(rc.resolveCadenceConfig({ cadencePhases: 2 }).config.cadencePhases, 2);
  });

  for (const bad of [-1, 2.5, '3', true]) {
    test(`cadence_phases ${JSON.stringify(bad)} keeps 2 and is named`, () => {
      const r = rc.resolveCadenceConfig({ cadencePhases: bad });
      assert.equal(r.config.cadencePhases, 2);
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

describe('recordRun holds the journal lock', () => {
  /** A lock seam that records what was asked of it; `onAcquire` runs while "held". */
  function fakeLock({ grant = true, onAcquire = () => {} } = {}) {
    const calls = [];
    return {
      calls,
      acquire(lockPath) {
        calls.push(['acquire', path.relative(project, lockPath).split(path.sep).join('/')]);
        if (!grant) return null;
        onAcquire();
        return { token: 'held' };
      },
      release(handle) { calls.push(['release', handle.token]); },
    };
  }
  const mine = runAt('2026-10-21T10:00:00.000Z', { stem: 'RETRO-2026-10-21' });
  const theirs = runAt('2026-10-21T09:59:00.000Z', { stem: 'RETRO-2026-10-21', planningDir: '.planning/workstreams/other' });

  test('the read happens under the lock, so a writer that finished first is kept', () => {
    // The other workstream's prepare held the lock and wrote while this one waited.
    const lock = fakeLock({ onAcquire: () => rc.recordRun(project, theirs, fakeLock()) });
    assert.deepEqual(rc.recordRun(project, mine, lock), { recorded: true, problems: [] });
    assert.deepEqual(rc.readRunsJournal(project).journal.runs.map((r) => r.planningDir), ['.planning/workstreams/other', '.planning']);
    assert.deepEqual(lock.calls, [['acquire', '.planning/retro/.RUNS.lock'], ['release', 'held']]);
  });

  test('a lock that cannot be had writes nothing and says so', () => {
    const lock = fakeLock({ grant: false });
    const rec = rc.recordRun(project, mine, lock);
    assert.equal(rec.recorded, false);
    assert.match(rec.problems[0], /\.RUNS\.lock/);
    assert.equal(fs.existsSync(rc.runsJournalPath(project)), false);
    assert.deepEqual(lock.calls.map((c) => c[0]), ['acquire']);
  });

  test('the lock is released when the journal is refused too', () => {
    const file = rc.runsJournalPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ nope');
    const lock = fakeLock();
    assert.equal(rc.recordRun(project, mine, lock).recorded, false);
    assert.deepEqual(lock.calls.map((c) => c[0]), ['acquire', 'release']);
  });

  test('the default lock is the shared primitive and leaves no lockfile behind', () => {
    assert.equal(rc.recordRun(project, mine).recorded, true);
    assert.equal(fs.existsSync(path.join(project, '.planning', 'retro', '.RUNS.lock')), false);
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

// ─── Applied candidates (ADR-5209 §10) ────────────────────────────────────────

describe('recordApplied: what a human applied, on the retro\'s run', () => {
  const run = runAt('2026-10-25T10:00:00.000Z', { stem: 'RETRO-2026-10-25' });
  const entry = (over = {}) => ({ candidate: 'cand-1', route: 'capture', at: '2026-10-26T09:00:00.000Z', ...over });
  const freeLock = { acquire: () => ({}), release: () => {} };

  test('recorded once on the run of that stem; a second time is already, unchanged', () => {
    rc.recordRun(project, run);
    assert.deepEqual(rc.recordApplied(project, 'RETRO-2026-10-25', entry(), freeLock), { recorded: true, already: false, refusal: null, problems: [] });
    const before = fs.readFileSync(rc.runsJournalPath(project), 'utf8');
    assert.deepEqual(rc.recordApplied(project, 'RETRO-2026-10-25', entry({ at: '2026-10-27T09:00:00.000Z' }), freeLock).already, true);
    assert.equal(fs.readFileSync(rc.runsJournalPath(project), 'utf8'), before);
    const [r] = rc.readRunsJournal(project).journal.runs;
    assert.deepEqual(r.applied, [entry()]);
    assert.deepEqual([...rc.appliedFromRuns([r])], ['RETRO-2026-10-25:cand-1']);
  });

  test('the schedule still reads the run the same way', () => {
    rc.recordRun(project, run);
    rc.recordApplied(project, 'RETRO-2026-10-25', entry(), freeLock);
    const r = rc.readRunsJournal(project);
    assert.deepEqual([r.status, r.problems, r.journal.runs[0].executedPhases], ['ok', [], []]);
  });

  test('a journal nothing was applied from keeps its bytes (no applied key)', () => {
    rc.recordRun(project, run);
    const parsed = JSON.parse(fs.readFileSync(rc.runsJournalPath(project), 'utf8'));
    assert.equal('applied' in parsed.runs[0], false);
  });

  test('no run of that stem, an invalid journal, a busy lock, a malformed entry: typed refusal, nothing written', () => {
    assert.equal(rc.recordApplied(project, 'RETRO-2026-10-25', entry(), freeLock).refusal, rc.APPLIED_REFUSAL.NO_RUN);
    const file = rc.runsJournalPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ nope');
    assert.equal(rc.recordApplied(project, 'RETRO-2026-10-25', entry(), freeLock).refusal, rc.APPLIED_REFUSAL.JOURNAL_INVALID);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ nope');
    fs.unlinkSync(file);
    rc.recordRun(project, run);
    const busy = { acquire: () => null, release: () => {} };
    assert.equal(rc.recordApplied(project, 'RETRO-2026-10-25', entry(), busy).refusal, rc.APPLIED_REFUSAL.LOCKED);
    assert.equal(rc.recordApplied(project, 'RETRO-2026-10-25', entry({ route: 'somewhere' }), freeLock).refusal, rc.APPLIED_REFUSAL.INVALID);
    assert.equal(rc.readRunsJournal(project).journal.runs[0].applied, undefined);
  });

  test('a run whose applied entry is malformed makes the journal fail closed', () => {
    const file = rc.runsJournalPath(project);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, runs: [{ ...run, applied: [{ candidate: 'x', route: 'quick', at: 'now' }] }] }));
    const r = rc.readRunsJournal(project);
    assert.deepEqual([r.journal.runs.length, r.problems.length], [0, 1]);
  });
});

describe('runs journal the signals a retro saw', () => {
  const sig = (i) => ({ id: `hook-block:${String(i).padStart(10, '0')}`, fingerprint: `hook-block:${String(i).padStart(10, 'f')}`, count: 1 });
  const sigs = (n) => Array.from({ length: n }, (_, i) => sig(i));

  test('runFor keeps at most MAX_RUN_SIGNALS facts: limit-1, limit, limit+1', () => {
    const f = facts({ executed: 0 });
    for (const [n, kept] of [[rc.MAX_RUN_SIGNALS - 1, rc.MAX_RUN_SIGNALS - 1], [rc.MAX_RUN_SIGNALS, rc.MAX_RUN_SIGNALS], [rc.MAX_RUN_SIGNALS + 1, rc.MAX_RUN_SIGNALS]]) {
      assert.equal(rc.runFor('RETRO-2026-10-28', new Date('2026-10-28T10:00:00.000Z'), f, sigs(n)).signals.length, kept, `${n} signals`);
    }
    assert.equal('signals' in rc.runFor('RETRO-2026-10-28', new Date('2026-10-28T10:00:00.000Z'), f), false);
  });

  test('recorded and read back; journaledSignals maps stem to them; over the limit is malformed', () => {
    const run = { ...runAt('2026-10-28T10:00:00.000Z', { stem: 'RETRO-2026-10-28' }), signals: sigs(2) };
    assert.equal(rc.recordRun(project, run).recorded, true);
    const read = rc.readRunsJournal(project);
    assert.deepEqual(rc.journaledSignals(read.journal.runs).get('RETRO-2026-10-28'), sigs(2));
    assert.deepEqual(rc.runProblems({ ...run, signals: sigs(rc.MAX_RUN_SIGNALS) }), []);
    assert.equal(rc.runProblems({ ...run, signals: sigs(rc.MAX_RUN_SIGNALS + 1) }).length, 1);
    assert.equal(rc.runProblems({ ...run, signals: [{ id: 'x', fingerprint: 'y', count: -1 }] }).length, 3);
  });
});
