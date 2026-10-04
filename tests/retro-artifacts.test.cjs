'use strict';

/**
 * src/retro-artifacts.cts — the `.planning/retro/` layout, the accepted-checks
 * journal (CHECKS.json) and the candidate contract of /gsd-retro (ADR-5209).
 *
 * Pure functions are driven with fixed clocks and typed transcript events;
 * the filesystem parts run in temp projects.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup } = require('./helpers.cjs');

const ra = require('../gsd-core/bin/lib/retro-artifacts.cjs');

const DAY_MS = 24 * 60 * 60 * 1000;

let project;
beforeEach(() => { project = createTempProject('gsd-retro-artifacts-'); });
afterEach(() => { cleanup(project); });

// ─── Layout ───────────────────────────────────────────────────────────────────

describe('retro paths', () => {
  test('the first retro of a day takes the bare stem; later ones the next free number', () => {
    const first = ra.nextRetroPaths(project, '2026-10-05');
    assert.deepEqual(
      [first.stem, first.report, first.candidates, first.patches, first.bundle],
      ['RETRO-2026-10-05', '.planning/retro/RETRO-2026-10-05.md', '.planning/retro/RETRO-2026-10-05.json',
        '.planning/retro/patches/RETRO-2026-10-05', '.planning/retro/.work/RETRO-2026-10-05.bundle.json'],
    );
    fs.mkdirSync(first.dir, { recursive: true });
    fs.writeFileSync(path.join(project, first.report), '# r\n');
    assert.equal(ra.nextRetroPaths(project, '2026-10-05').stem, 'RETRO-2026-10-05-2');
    // A candidates file alone also holds the stem.
    fs.writeFileSync(path.join(first.dir, 'RETRO-2026-10-05-2.json'), '{}');
    assert.equal(ra.nextRetroPaths(project, '2026-10-05').stem, 'RETRO-2026-10-05-3');
  });

  test('a malformed date or stem is refused', () => {
    assert.throws(() => ra.nextRetroPaths(project, '2026-10-5'), RangeError);
    for (const bad of ['RETRO-2026-10-05-0', 'RETRO-2026-10-05/../x', 'CHECKS', '../RETRO-2026-10-05']) {
      assert.throws(() => ra.retroPathsFor(project, bad), RangeError, bad);
    }
  });

  test('latest stem orders by date, then sequence numerically', () => {
    assert.equal(ra.latestRetroStem(project), null);
    const dir = ra.retroDir(project);
    fs.mkdirSync(dir, { recursive: true });
    for (const stem of ['RETRO-2026-10-04-9', 'RETRO-2026-10-05', 'RETRO-2026-10-05-2', 'RETRO-2026-10-05-10']) {
      fs.writeFileSync(path.join(dir, `${stem}.json`), '{}');
    }
    fs.writeFileSync(path.join(dir, 'CHECKS.json'), '{}');
    assert.equal(ra.latestRetroStem(project), 'RETRO-2026-10-05-10');
  });

  test('the bundle directory ignores itself', () => {
    const paths = ra.nextRetroPaths(project, '2026-10-05');
    ra.writeBundle(project, paths, { version: 1 });
    assert.equal(fs.readFileSync(path.join(paths.dir, '.work', '.gitignore'), 'utf8'), '*\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, paths.bundle), 'utf8')), { version: 1 });
  });
});

// ─── Journal ──────────────────────────────────────────────────────────────────

const check = (over = {}) => ({ id: 'no-stash', kind: 'hook', match: 'git stash is disabled', acceptedAt: '2026-09-01', source: { retro: null, candidate: null, signal: null }, ...over });

describe('CHECKS.json', () => {
  test('absent is its own status, not an error', () => {
    assert.equal(ra.readChecksJournal(project).status, 'absent');
  });

  test('malformed entries are skipped and named; the rest are kept', () => {
    const text = JSON.stringify({ version: 1, checks: [check(), check({ id: 'Bad Id' }), check({ kind: 'prose', id: 'b' }), check(), check({ id: 'c', acceptedAt: '2026-02-30x' })] });
    const read = ra.parseChecksJournal(text);
    assert.equal(read.status, 'ok');
    assert.deepEqual(read.journal.checks.map((c) => c.id), ['no-stash']);
    assert.equal(read.problems.length, 4);
    assert.ok(read.problems.some((p) => p.includes('duplicate id no-stash')));
  });

  test('a wrong envelope or non-JSON is invalid', () => {
    assert.equal(ra.parseChecksJournal('{"checks": []}').status, 'invalid');
    assert.equal(ra.parseChecksJournal('nope').status, 'invalid');
  });

  test('record refuses a duplicate and a malformed check; retire refuses an unknown id', () => {
    const one = ra.recordCheck({ version: 1, checks: [] }, check());
    assert.equal(one.ok, true);
    assert.equal(ra.recordCheck(one.journal, check()).ok, false);
    assert.equal(ra.recordCheck(one.journal, check({ id: 'x', match: '' })).ok, false);
    assert.equal(ra.retireCheck(one.journal, 'missing').ok, false);
    assert.deepEqual(ra.retireCheck(one.journal, 'no-stash').journal.checks, []);
  });

  test('serialisation is stable: ordered by id, fixed keys', () => {
    const a = ra.formatChecksJournal({ version: 1, checks: [check({ id: 'b' }), check({ id: 'a' })] });
    const b = ra.formatChecksJournal({ version: 1, checks: [check({ id: 'a' }), check({ id: 'b' })] });
    assert.equal(a, b);
    assert.deepEqual(ra.parseChecksJournal(a).journal.checks.map((c) => c.id), ['a', 'b']);
  });
});

// ─── Firings and states ───────────────────────────────────────────────────────

function transcript(session, events) {
  let line = 0;
  const ptr = () => ({ session, file: `${session}.jsonl`, line: ++line, uuid: `u${line}`, timestamp: `2026-10-0${line}T00:00:00Z` });
  return { status: 'ok', reason: null, runtime: 'claude', session, files: [], toolResults: { count: 0, bytes: 0 }, events: events.map((e) => ({ ...e, ptr: ptr() })) };
}

describe('countCheckFires', () => {
  test('hook events and failed or blocked tool results carrying the literal count; a successful result does not', () => {
    const t1 = transcript('s1', [
      { kind: 'hook', event: 'PreToolUse', hook: 'no-stash-guard', tool: 'Bash', outcome: 'blocked', text: 'nothing here' },
      { kind: 'tool-result', toolUseId: 'a', tool: 'Bash', isError: true, text: 'hook error: git stash is disabled', blockedBy: null, denial: null },
      { kind: 'tool-result', toolUseId: 'b', tool: 'Bash', isError: false, text: 'git stash is disabled', blockedBy: null, denial: null },
      { kind: 'tool-result', toolUseId: 'c', tool: 'Bash', isError: false, text: 'git stash is disabled', blockedBy: 'hook', denial: null },
    ]);
    const t2 = transcript('s2', [{ kind: 'hook', event: 'PreToolUse', hook: null, tool: 'Bash', outcome: 'blocked', text: 'Blocked: git stash is disabled' }]);
    const [stash, guard, none] = ra.countCheckFires(
      [check(), check({ id: 'guard', match: 'no-stash-guard' }), check({ id: 'none', match: 'GIT STASH IS DISABLED' })],
      [t1, t2],
    );
    assert.deepEqual([stash.fires, stash.sessions], [3, 2]);
    assert.equal(stash.lastFiredAt, '2026-10-04T00:00:00Z');
    assert.deepEqual([guard.fires, guard.pointers], [1, ['s1/s1.jsonl:1#u1']]);
    assert.equal(none.fires, 0, 'the match is case-sensitive');
  });
});

describe('checksStatus boundaries', () => {
  const now = new Date('2026-10-31T12:00:00Z');
  const acceptedDaysAgo = (n) => new Date(now.getTime() - n * DAY_MS).toISOString().slice(0, 10);
  const status = (age, windowDays, extra = {}) => ra.checksStatus({
    journal: { version: 1, checks: [check({ acceptedAt: acceptedDaysAgo(age) })] },
    fires: [],
    now,
    staleDays: 30,
    windowDays,
    sessionsScanned: 3,
    transcriptsRead: true,
    ...extra,
  }).checks[0];

  for (const [age, state] of [[29, 'silent'], [30, 'removal-candidate'], [31, 'removal-candidate']]) {
    test(`accepted ${age} day(s) ago, full window → ${state}`, () => assert.equal(status(age, 30).state, state));
  }
  for (const [windowDays, state] of [[29, 'silent'], [30, 'removal-candidate']]) {
    test(`window of ${windowDays} day(s), old check → ${state}`, () => assert.equal(status(60, windowDays).state, state));
  }
  test('a firing wins over age; no transcript read is unknown', () => {
    const fired = ra.checksStatus({
      journal: { version: 1, checks: [check({ acceptedAt: acceptedDaysAgo(90) })] },
      fires: [{ id: 'no-stash', fires: 1, sessions: 1, lastFiredAt: null, pointers: [] }],
      now, staleDays: 30, windowDays: 30, sessionsScanned: 1, transcriptsRead: true,
    });
    assert.equal(fired.checks[0].state, 'fired');
    const blind = ra.checksStatus({
      journal: { version: 1, checks: [check({ acceptedAt: acceptedDaysAgo(90) })] },
      fires: [], now, staleDays: 30, windowDays: 0, sessionsScanned: 0, transcriptsRead: false,
    });
    assert.deepEqual([blind.status, blind.checks[0].state, blind.removalCandidates], ['degraded', 'unknown', []]);
  });
});

// ─── Candidates ───────────────────────────────────────────────────────────────

describe('validateCandidates', () => {
  const evidence = { signals: new Set(['hook-block:aaa']), inventory: new Set(['inventory:missing-guardrail:ci']), checks: new Set(['old-check']) };
  const opts = () => ({ projectRoot: project, patchesDir: '.planning/retro/patches/RETRO-2026-10-05' });
  const base = (over) => ({ id: 'cand-1', severity: 'medium', category: 'navigation', title: 't', change: 'c', signals: ['hook-block:aaa'], ...over });

  test('each evidence kind resolves; an unknown one drops the candidate', () => {
    const r = ra.validateCandidates({ version: 1, candidates: [
      base({ id: 'cand-1' }),
      base({ id: 'cand-2', signals: ['inventory:missing-guardrail:ci'] }),
      base({ id: 'cand-3', category: 'retire-check', signals: ['check:old-check'], verify: 'node -e 1' }),
      base({ id: 'cand-4', signals: ['inventory:unwired-check:lint'] }),
      base({ id: 'cand-5', signals: [] }),
    ] }, evidence, opts());
    assert.deepEqual(r.valid.map((c) => [c.id, c.route]), [['cand-1', 'capture'], ['cand-2', 'capture'], ['cand-3', 'quick']]);
    assert.deepEqual(r.dropped.map((d) => [d.id, d.reasons[0].split(':')[0]]), [['cand-4', 'unknown-signal'], ['cand-5', 'no-signal']]);
  });

  test('judgement rules never land in a steering file, whatever its directory or case', () => {
    for (const target of ['CLAUDE.md', '.claude/CLAUDE.md', 'guides/agents.md', 'GEMINI.md']) {
      const r = ra.validateCandidates({ candidates: [base({ category: 'judgement', target })] }, evidence, opts());
      assert.match(r.dropped[0].reasons[0], /^judgement-in-steering-file/, target);
    }
    const ok = ra.validateCandidates({ candidates: [base({ category: 'judgement', target: 'agent_skills.gsd-code-reviewer' })] }, evidence, opts());
    assert.equal(ok.valid.length, 1);
  });

  test('a mechanical candidate needs verify; severity orders the valid list', () => {
    const r = ra.validateCandidates({ candidates: [
      base({ id: 'cand-1', severity: 'low' }),
      base({ id: 'cand-2', severity: 'high' }),
      base({ id: 'cand-3', category: 'mechanical' }),
      base({ id: 'cand-10', severity: 'high' }),
    ] }, evidence, opts());
    assert.deepEqual(r.valid.map((c) => c.id), ['cand-2', 'cand-10', 'cand-1']);
    assert.match(r.dropped[0].reasons[0], /^missing-verify/);
  });

  test('a patch must exist under the retro patches directory', () => {
    const patches = path.join(project, opts().patchesDir);
    fs.mkdirSync(patches, { recursive: true });
    fs.writeFileSync(path.join(patches, 'cand-1.patch'), 'diff\n');
    const r = ra.validateCandidates({ candidates: [
      base({ id: 'cand-1', patch: `${opts().patchesDir}/cand-1.patch` }),
      base({ id: 'cand-2', patch: `${opts().patchesDir}/missing.patch` }),
      base({ id: 'cand-3', patch: '.planning/retro/patches/../../config.json' }),
      base({ id: 'cand-4', patch: '/etc/passwd' }),
    ] }, evidence, opts());
    assert.deepEqual(r.valid.map((c) => c.id), ['cand-1']);
    assert.deepEqual(r.dropped.map((d) => d.reasons[0].split(':')[0].split(' ')[0]), ['patch', 'patch', 'patch']);
  });

  test('a duplicate id, a bad id and a missing envelope are dropped', () => {
    const r = ra.validateCandidates({ candidates: [base(), base(), base({ id: 'c1' })] }, evidence, opts());
    assert.deepEqual(r.dropped.map((d) => d.reasons[0]), ['duplicate id', 'id must look like cand-<n>']);
    assert.equal(ra.validateCandidates([], evidence, opts()).dropped[0].id, '(file)');
  });
});
