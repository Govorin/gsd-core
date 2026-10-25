'use strict';

/**
 * `gsd-tools retro` — the CLI surface of the retro capability (ADR-5209).
 *
 * Every transcript is a synthetic JSONL fixture under a temp sessions
 * directory passed with --sessions-dir; nothing here reads the real
 * ~/.claude. Assertions are on the JSON the command prints and on the files
 * it writes, never on free-form text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempGitProject, createTempDir, cleanup, runGsdTools } = require('./helpers.cjs');

const router = require('../gsd-core/bin/lib/retro-command-router.cjs');
const rs = require('../gsd-core/bin/lib/retro-signals.cjs');
const st = require('../gsd-core/bin/lib/session-transcript.cjs');

const SECRET = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The struggling session of tests/retro-signals.test.cjs (score 10 with the
 * default thresholds): three identical failing `npm test` calls, a user
 * correction, a hook-blocked `git stash`. The first prompt carries a secret
 * and the hook message names the check `git stash is disabled`.
 */
function strugglingRecords() {
  const rec = [];
  let u = 0;
  const push = (r) => rec.push(JSON.stringify({ uuid: `e2e-${++u}`, timestamp: '2026-10-04T00:00:00Z', ...r }));
  const tu = (id, name, input) => push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const tr = (id, content, isError) => push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
  push({ type: 'user', userType: 'external', message: { content: `почини тест парсера, ключ ${SECRET}` } });
  for (let i = 0; i < 3; i++) {
    tu(`t${i}`, 'Bash', { command: 'npm test' });
    tr(`t${i}`, 'Exit code 1\nnot ok 4 - parser handles empty input', true);
  }
  push({ type: 'user', userType: 'external', message: { content: 'нет, не так — тест трогать нельзя' } });
  tu('h1', 'Bash', { command: 'git stash' });
  tr('h1', 'PreToolUse:Bash hook error: git stash is disabled', true);
  return rec;
}

function smoothRecords() {
  return [
    JSON.stringify({ uuid: 's-1', timestamp: '2026-10-04T00:00:00Z', type: 'user', userType: 'external', message: { content: 'add a test' } }),
    JSON.stringify({ uuid: 's-2', timestamp: '2026-10-04T00:00:01Z', type: 'assistant', message: { content: [{ type: 'text', text: 'done' }] } }),
  ];
}

/** Write a session for `projectRoot` under `sessionsDir` the way Claude Code lays it out. */
function writeSession(sessionsDir, projectRoot, id, records, mtime) {
  const dir = path.join(sessionsDir, st.encodeProjectDirName(fs.realpathSync(projectRoot)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, records.join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function writeConfig(projectRoot, config) {
  fs.writeFileSync(path.join(projectRoot, '.planning', 'config.json'), JSON.stringify(config, null, 2));
}

/** Run `gsd-tools --json-errors retro …`; `reason` is the error's wire code, parsed from stderr. */
function retro(args, cwd, env = {}) {
  const res = runGsdTools(['--json-errors', 'retro', ...args], cwd, { GSD_RUNTIME: 'claude', ...env });
  const last = (res.error || '').trim().split('\n').filter(Boolean).pop() || '';
  let reason = null;
  if (!res.success && last.startsWith('{')) reason = JSON.parse(last).reason;
  return { ...res, reason, json: res.success && res.output ? JSON.parse(res.output) : null };
}

let project;
let sessions;
beforeEach(() => {
  project = createTempGitProject('gsd-retro-cli-');
  sessions = createTempDir('gsd-retro-sessions-');
});
afterEach(() => {
  cleanup(project);
  cleanup(sessions);
});

// ─── Config surface ───────────────────────────────────────────────────────────

describe('capability config', () => {
  const capability = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'retro', 'capability.json'), 'utf8'));

  test('every threshold key resolveRetroThresholds reads is declared, with its default', () => {
    for (const key of router.RETRO_THRESHOLD_KEYS) {
      // The key is one resolveRetroThresholds reads: an invalid value is named.
      const { problems } = rs.resolveRetroThresholds({ [`retro.${key}`]: -5 });
      assert.equal(problems.length, 1, `retro.${key} is read by resolveRetroThresholds`);
      const declared = capability.config[`retro.${key}`];
      assert.ok(declared, `retro.${key} is declared`);
      const field = key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
      assert.equal(declared.default, rs.DEFAULT_RETRO_THRESHOLDS[field], `retro.${key} default matches retro-signals`);
    }
    assert.equal(Object.keys(rs.DEFAULT_RETRO_THRESHOLDS).length, router.RETRO_THRESHOLD_KEYS.length, 'no threshold left undeclared');
  });

  test('retro.auto is an enum suggest|auto|off defaulting to suggest', () => {
    assert.deepEqual(capability.config['retro.auto'].values, ['suggest', 'auto', 'off']);
    assert.equal(capability.config['retro.auto'].default, 'suggest');
  });

  test('config-set accepts the retro keys it used to reject', () => {
    for (const [key, value] of [['retro.signal_threshold', '12'], ['retro.auto', 'off'], ['retro.check_stale_days', '45']]) {
      const res = runGsdTools(['config-set', key, value], project);
      assert.equal(res.success, true, `config-set ${key}: ${res.error}`);
    }
    const saved = JSON.parse(fs.readFileSync(path.join(project, '.planning', 'config.json'), 'utf8'));
    assert.equal(saved.retro.signal_threshold, 12);
    assert.equal(saved.retro.auto, 'off');
  });
});

// ─── signals ──────────────────────────────────────────────────────────────────

describe('retro signals', () => {
  test('scores the newest session and points into its file', () => {
    writeSession(sessions, project, 'sess-old', smoothRecords(), new Date(Date.now() - DAY_MS));
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--sessions-dir', sessions], project);
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.session, 'sess-e2e');
    assert.equal(r.json.sources.transcript, 'read');
    assert.equal(r.json.score, 10);
    assert.equal(r.json.suggest, true);
    const err = r.json.signals.find((s) => s.kind === 'repeated-tool-error');
    assert.deepEqual(err.pointers.map((p) => [p.file, p.line]), [['sess-e2e.jsonl', 3], ['sess-e2e.jsonl', 5], ['sess-e2e.jsonl', 7]]);
  });

  test('--session picks a session by id; an unknown id is a usage error', () => {
    writeSession(sessions, project, 'sess-smooth', smoothRecords(), new Date(Date.now() - DAY_MS));
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const picked = retro(['signals', '--sessions-dir', sessions, '--session', 'sess-smooth'], project);
    assert.equal(picked.json.session, 'sess-smooth');
    assert.equal(picked.json.score, 0);
    const missing = retro(['signals', '--sessions-dir', sessions, '--session', 'nope'], project);
    assert.equal(missing.success, false);
    assert.equal(missing.reason, 'usage');
  });

  test('a crafted --session never names a file outside the project directory', () => {
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--sessions-dir', sessions, '--session', '../../etc/passwd'], project);
    assert.equal(r.success, false);
    assert.equal(r.reason, 'usage');
  });

  for (const bad of ['0d', '7x', '2026-02-30', '2026-10-04T10:00']) {
    test(`--since ${bad} is refused`, () => {
      const r = retro(['signals', '--sessions-dir', sessions, '--since', bad], project);
      assert.equal(r.success, false);
      assert.equal(r.reason, 'usage');
    });
  }

  test('a runtime without a transcript adapter degrades and says so', () => {
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--sessions-dir', sessions], project, { GSD_RUNTIME: 'codex' });
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.status, 'degraded');
    assert.equal(r.json.sources.transcript, 'degraded');
    assert.equal(r.json.session, null);
    assert.ok(r.json.reasons.some((x) => x.includes('no transcript adapter for runtime "codex"')));
  });

  test('a missing sessions directory degrades instead of reading ~/.claude', () => {
    const r = retro(['signals', '--sessions-dir', path.join(sessions, 'absent')], project);
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.sources.transcript, 'degraded');
    assert.ok(r.json.reasons.includes('no Claude Code sessions directory'));
  });

  test('the report carries no secret and no home directory', () => {
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--sessions-dir', sessions], project);
    const correction = r.json.signals.find((s) => s.kind === 'user-correction');
    assert.ok(correction, 'the correction is a signal');
    const all = JSON.stringify(r.json);
    assert.equal(all.includes(SECRET), false, 'the secret never leaves the reader');
    assert.equal(all.includes(require('node:os').homedir() + path.sep), false);
  });

  test('an invalid threshold in config.json is named, not silently replaced', () => {
    writeConfig(project, { retro: { signal_threshold: 'high' } });
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--sessions-dir', sessions], project);
    assert.equal(r.json.threshold, rs.DEFAULT_RETRO_THRESHOLDS.signalThreshold);
    assert.ok(r.json.reasons.some((x) => x.startsWith('retro.signal_threshold must be an integer')));
  });

  test('a disabled capability reads nothing', () => {
    writeConfig(project, { retro: { enabled: false } });
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--sessions-dir', sessions], project);
    assert.equal(r.json.disabled, true);
  });
});

// ─── --decide ─────────────────────────────────────────────────────────────────

describe('retro signals --decide', () => {
  // The fixture session scores exactly 10.
  for (const [threshold, decision] of [[9, 'suggest'], [10, 'suggest'], [11, 'skip']]) {
    test(`score 10 against retro.signal_threshold ${threshold} → ${decision}`, () => {
      writeConfig(project, { retro: { signal_threshold: threshold } });
      writeSession(sessions, project, 'sess-e2e', strugglingRecords());
      const r = retro(['signals', '--decide', '--sessions-dir', sessions], project);
      assert.equal(r.success, true, r.error);
      assert.equal(r.json.decision, decision);
      assert.equal(r.json.score, 10);
      assert.equal(r.json.threshold, threshold);
      if (decision === 'suggest') {
        assert.equal(r.json.command, '/gsd-retro --session sess-e2e');
        assert.equal(typeof r.json.message, 'string');
      } else {
        assert.equal(r.json.reason, 'below-threshold');
        assert.equal(r.json.command, null);
      }
    });
  }

  test('retro.auto auto answers auto above the threshold', () => {
    writeConfig(project, { retro: { auto: 'auto' } });
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--decide', '--sessions-dir', sessions], project);
    assert.equal(r.json.decision, 'auto');
    assert.equal(r.json.message, null);
  });

  test('retro.auto off skips without reading a transcript', () => {
    writeConfig(project, { retro: { auto: 'off' } });
    const r = retro(['signals', '--decide', '--sessions-dir', path.join(sessions, 'absent')], project);
    assert.deepEqual([r.json.decision, r.json.reason, r.json.score], ['skip', 'retro-auto-off', null]);
  });

  test('a disabled capability skips', () => {
    writeConfig(project, { retro: { enabled: false } });
    const r = retro(['signals', '--decide'], project);
    assert.deepEqual([r.json.decision, r.json.reason], ['skip', 'capability-disabled']);
  });

  test('retro stage is the loop-point form: same answer, --phase ignored, next names the skill', () => {
    writeConfig(project, { retro: { auto: 'auto' } });
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['stage', '--phase', '3', '--sessions-dir', sessions], project);
    assert.equal(r.success, true, r.error);
    assert.deepEqual([r.json.decision, r.json.reason], ['auto', 'threshold-reached']);
    assert.deepEqual(r.json.next, { skill: 'retro', args: '--session sess-e2e' });
  });

  test('retro stage below the threshold skips with no next', () => {
    writeConfig(project, { retro: { signal_threshold: 11 } });
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['stage', '--phase', '3', '--sessions-dir', sessions], project);
    assert.deepEqual([r.json.decision, r.json.next, r.json.message], ['skip', null, null]);
  });

  test('an invalid retro.auto keeps suggest and is named', () => {
    // Written straight to config.json: config-set would refuse the value.
    writeConfig(project, { retro: { auto: 'always' } });
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['signals', '--decide', '--sessions-dir', sessions], project);
    assert.equal(r.json.mode, 'suggest');
    assert.equal(r.json.problems.length, 1);
  });
});

// ─── decideRetro / parseSince (pure) ──────────────────────────────────────────

describe('decideRetro', () => {
  const report = (score, threshold = 8) => ({ score, threshold, session: 's1', status: 'ok' });
  for (const mode of ['suggest', 'auto']) {
    for (const [score, decision] of [[7, 'skip'], [8, mode], [9, mode]]) {
      test(`${mode}: score ${score} against threshold 8 → ${decision}`, () => {
        const d = router.decideRetro({ active: true, mode, report: report(score) });
        assert.equal(d.decision, decision);
        assert.equal(d.reason, decision === 'skip' ? 'below-threshold' : 'threshold-reached');
      });
    }
  }
  test('off skips at any score; inactive skips first', () => {
    assert.equal(router.decideRetro({ active: true, mode: 'off', report: report(100) }).reason, 'retro-auto-off');
    assert.equal(router.decideRetro({ active: false, mode: 'auto', report: report(100) }).reason, 'capability-disabled');
  });
  test('threshold 0 always proposes, even a clean session', () => {
    assert.equal(router.decideRetro({ active: true, mode: 'suggest', report: report(0, 0) }).decision, 'suggest');
  });
  test('no session id → the bare command', () => {
    assert.equal(router.decideRetro({ active: true, mode: 'auto', report: { ...report(9), session: null } }).command, '/gsd-retro');
  });
  test('next is set exactly when the answer is not skip', () => {
    assert.deepEqual(router.decideRetro({ active: true, mode: 'suggest', report: report(8) }).next, { skill: 'retro', args: '--session s1' });
    assert.deepEqual(router.decideRetro({ active: true, mode: 'auto', report: { ...report(8), session: null } }).next, { skill: 'retro', args: '' });
    assert.equal(router.decideRetro({ active: true, mode: 'auto', report: report(7) }).next, null);
  });
});

describe('resolveRetroAuto', () => {
  test('the three modes pass, absent is suggest, anything else is suggest and named', () => {
    for (const m of ['suggest', 'auto', 'off']) assert.deepEqual(router.resolveRetroAuto(m), { mode: m, problem: null });
    assert.deepEqual(router.resolveRetroAuto(undefined), { mode: 'suggest', problem: null });
    for (const bad of ['Auto', true, 1, '']) {
      const r = router.resolveRetroAuto(bad);
      assert.equal(r.mode, 'suggest');
      assert.equal(typeof r.problem, 'string');
    }
  });
});

describe('parseSince', () => {
  const now = new Date('2026-10-05T12:00:00Z');
  test('durations count back from the clock', () => {
    assert.equal(router.parseSince('12h', now), now.getTime() - 12 * 3600 * 1000);
    assert.equal(router.parseSince('7d', now), now.getTime() - 7 * DAY_MS);
    assert.equal(router.parseSince('2w', now), now.getTime() - 14 * DAY_MS);
  });
  test('a bare date is 00:00 UTC; a date-time keeps its offset', () => {
    assert.equal(router.parseSince('2026-10-01', now), Date.parse('2026-10-01T00:00:00Z'));
    assert.equal(router.parseSince('2026-10-01T10:00+03:00', now), Date.parse('2026-10-01T07:00:00Z'));
  });
  for (const bad of ['0d', '07d', '7', '7m', '2026-02-30', '2026-9-1', '2026-10-01T10:00', 'last', 'HEAD~3']) {
    test(`${JSON.stringify(bad)} is not a window`, () => assert.equal(router.parseSince(bad, now), null));
  }
});

// ─── prepare / candidates ─────────────────────────────────────────────────────

function readBundle(prep) {
  return JSON.parse(fs.readFileSync(path.join(project, prep.json.bundle), 'utf8'));
}

describe('retro prepare', () => {
  test('writes a self-ignoring bundle and the next free report paths', () => {
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const today = new Date().toISOString().slice(0, 10);
    const first = retro(['prepare', '--sessions-dir', sessions], project);
    assert.equal(first.success, true, first.error);
    assert.equal(first.json.stem, `RETRO-${today}`);
    assert.equal(first.json.report, `.planning/retro/RETRO-${today}.md`);
    assert.equal(fs.readFileSync(path.join(project, '.planning', 'retro', '.work', '.gitignore'), 'utf8'), '*\n');
    const bundle = readBundle(first);
    assert.equal(bundle.report.score, 10);
    assert.deepEqual(bundle.evidence.signals.sort(), bundle.report.signals.map((s) => s.id).sort());
    const err = bundle.report.signals.find((s) => s.kind === 'repeated-tool-error');
    assert.ok(bundle.contexts[err.id].length > 1, 'the analyst gets the events around a signal');
    assert.ok(Array.isArray(bundle.inventory.findings));
    assert.equal(JSON.stringify(bundle).includes(SECRET), false, 'the bundle carries no secret');

    // The analyst wrote its report: the next retro of the day does not overwrite it.
    fs.writeFileSync(path.join(project, first.json.report), '# retro\n');
    const second = retro(['prepare', '--sessions-dir', sessions], project);
    assert.equal(second.json.stem, `RETRO-${today}-2`);
  });
});

describe('retro candidates', () => {
  function prepareWithCandidates(candidates) {
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const prep = retro(['prepare', '--sessions-dir', sessions], project);
    const bundle = readBundle(prep);
    fs.mkdirSync(path.join(project, prep.json.patches), { recursive: true });
    fs.writeFileSync(path.join(project, prep.json.patches, 'cand-1.patch'), 'diff --git a/x b/x\n');
    fs.writeFileSync(path.join(project, prep.json.candidates), JSON.stringify({ version: 1, candidates: candidates(bundle, prep) }));
    return prep;
  }

  test('only candidates tied to real evidence survive, each with its route', () => {
    const prep = prepareWithCandidates((bundle, p) => {
      const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
      const err = bundle.report.signals.find((s) => s.kind === 'repeated-tool-error').id;
      const inv = bundle.evidence.inventory[0];
      return [
        { id: 'cand-1', severity: 'high', category: 'mechanical', title: 'lint rule', signals: [err], change: 'add rule', patch: `${p.json.patches}/cand-1.patch`, verify: 'npm run lint' },
        { id: 'cand-2', severity: 'low', category: 'judgement', title: 'standards', signals: [hook], target: 'CLAUDE.md', change: 'add prose' },
        { id: 'cand-3', severity: 'medium', category: 'navigation', title: 'pointer', signals: ['repeated-call:0000000000'], change: 'pointer' },
        { id: 'cand-4', severity: 'medium', category: 'mechanical', title: 'no verify', signals: [hook], change: 'hook' },
        { id: 'cand-5', severity: 'medium', category: 'judgement', title: 'reviewer rule', signals: [hook], target: '.claude/skills/reviewer/SKILL.md', change: 'rule' },
        ...(inv ? [{ id: 'cand-6', severity: 'low', category: 'environment', title: 'wire it', signals: [inv], change: 'wire' }] : []),
      ];
    });
    const r = retro(['candidates'], project);
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.retro, prep.json.stem);
    assert.deepEqual(r.json.valid.map((c) => [c.id, c.route]).slice(0, 2), [['cand-1', 'quick'], ['cand-5', 'capture']]);
    const dropped = Object.fromEntries(r.json.dropped.map((d) => [d.id, d.reasons.join(' | ')]));
    assert.match(dropped['cand-2'], /^judgement-in-steering-file/);
    assert.match(dropped['cand-3'], /^unknown-signal: repeated-call:0000000000/);
    assert.match(dropped['cand-4'], /^missing-verify/);

    const one = retro(['candidates', '--id', 'cand-1'], project);
    assert.equal(one.json.candidate.route, 'quick');
    const gone = retro(['candidates', '--id', 'cand-2'], project);
    assert.equal(gone.reason, 'usage');
  });

  test('a patch outside the retro patches directory is refused', () => {
    prepareWithCandidates((bundle) => [
      { id: 'cand-1', severity: 'high', category: 'mechanical', title: 't', signals: [bundle.evidence.signals[0]], change: 'c', patch: 'package.json', verify: 'npm test' },
    ]);
    const r = retro(['candidates'], project);
    assert.equal(r.json.valid.length, 0);
    assert.match(r.json.dropped[0].reasons[0], /^patch must live under/);
  });
});

// ─── checks ───────────────────────────────────────────────────────────────────

describe('retro checks', () => {
  const journal = () => JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'CHECKS.json'), 'utf8'));

  test('record and retire edit the journal; a duplicate id is refused', () => {
    const rec = retro(['checks', 'record', '--id', 'no-git-stash', '--kind', 'hook', '--match', 'git stash is disabled', '--signal', 'hook-block:abc'], project);
    assert.equal(rec.success, true, rec.error);
    assert.deepEqual(journal().checks.map((c) => [c.id, c.kind, c.source.signal]), [['no-git-stash', 'hook', 'hook-block:abc']]);
    const dup = retro(['checks', 'record', '--id', 'no-git-stash', '--kind', 'hook', '--match', 'x'], project);
    assert.equal(dup.reason, 'usage');
    const badKind = retro(['checks', 'record', '--id', 'other', '--kind', 'prose', '--match', 'x'], project);
    assert.equal(badKind.reason, 'usage');
    const ret = retro(['checks', 'retire', '--id', 'no-git-stash'], project);
    assert.equal(ret.success, true, ret.error);
    assert.deepEqual(journal().checks, []);
  });

  function seedJournal(checks) {
    fs.mkdirSync(path.join(project, '.planning', 'retro'), { recursive: true });
    fs.writeFileSync(path.join(project, '.planning', 'retro', 'CHECKS.json'), JSON.stringify({ version: 1, checks }));
  }
  const daysAgo = (n) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
  const check = (id, match, acceptedDaysAgo) => ({ id, kind: 'hook', match, acceptedAt: daysAgo(acceptedDaysAgo), source: {} });

  test('a check that fired is fired; an old silent one over a full window is a removal candidate', () => {
    seedJournal([check('no-git-stash', 'git stash is disabled', 60), check('never-fires', 'no such message', 60), check('young', 'no such message', 3)]);
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    // An older session outside the window: transcripts reach back past it.
    writeSession(sessions, project, 'sess-ancient', smoothRecords(), new Date(Date.now() - 45 * DAY_MS));
    const r = retro(['checks', '--sessions-dir', sessions], project);
    assert.equal(r.success, true, r.error);
    const state = Object.fromEntries(r.json.checks.map((c) => [c.id, c.state]));
    assert.deepEqual(state, { 'no-git-stash': 'fired', 'never-fires': 'removal-candidate', 'young': 'silent' });
    assert.deepEqual(r.json.removalCandidates, ['never-fires']);
    assert.equal(r.json.sessionsScanned, 1);
  });

  test('a window shorter than check_stale_days proposes no removal', () => {
    seedJournal([check('never-fires', 'no such message', 60)]);
    writeSession(sessions, project, 'sess-e2e', strugglingRecords());
    const r = retro(['checks', '--sessions-dir', sessions], project);
    assert.equal(r.json.checks[0].state, 'silent');
    assert.deepEqual(r.json.removalCandidates, []);
  });

  test('without a readable transcript nothing is a removal candidate', () => {
    seedJournal([check('never-fires', 'no such message', 60)]);
    const r = retro(['checks', '--sessions-dir', sessions], project, { GSD_RUNTIME: 'codex' });
    assert.equal(r.json.status, 'degraded');
    assert.equal(r.json.checks[0].state, 'unknown');
    assert.deepEqual(r.json.removalCandidates, []);
  });
});

// ─── the schedule: retro due, and the stage's schedule triggers ───────────────

/** STATE.md + ROADMAP.md for milestone `version` with `phaseCount` phases, none run. */
function writeMilestone(phaseCount, version = 'v1.2') {
  const planning = path.join(project, '.planning');
  fs.writeFileSync(path.join(planning, 'STATE.md'), `---\nmilestone: ${version}\n---\n# State\n`);
  const phases = Array.from({ length: phaseCount }, (_, i) => `### Phase ${i + 1}: P${i + 1}\n**Goal:** g${i + 1}\n`).join('\n');
  fs.writeFileSync(path.join(planning, 'ROADMAP.md'), `# Roadmap\n\n## ${version} — Cadence\n\n${phases}`);
}

/** Phase `n` finished executing: its one plan has a summary. */
function executePhase(n) {
  const dir = path.join(project, '.planning', 'phases', `0${n}-p${n}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `0${n}-01-PLAN.md`), '# Plan');
  fs.writeFileSync(path.join(dir, `0${n}-01-SUMMARY.md`), '# Summary');
}

function readRuns() {
  return JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'RUNS.json'), 'utf8'));
}

describe('retro due', () => {
  test('the JSON a dashboard reads: one stable shape', () => {
    const r = retro(['due'], project);
    assert.equal(r.success, true, r.error);
    assert.deepEqual(Object.keys(r.json), [
      'due', 'trigger', 'triggers', 'reason', 'active', 'mode', 'planningDir', 'milestone',
      'cadencePhases', 'atMilestoneStart', 'phases', 'phasesSinceRetro', 'phasesSinceRetroIds',
      'baseline', 'lastRetro', 'latestReport', 'journal', 'problems',
    ]);
    assert.deepEqual([r.json.due, r.json.reason, r.json.cadencePhases, r.json.journal], [false, 'no-roadmap', 3, '.planning/retro/RUNS.json']);
  });

  test('a planned milestone is due at its start; the retro held there clears it', () => {
    writeMilestone(4);
    const before = retro(['due'], project);
    assert.deepEqual([before.json.due, before.json.trigger, before.json.milestone, before.json.lastRetro], [true, 'milestone-start', 'v1.2', null]);

    writeSession(sessions, project, 'sess-smooth', smoothRecords());
    const prep = retro(['prepare', '--sessions-dir', sessions], project);
    assert.equal(prep.success, true, prep.error);
    assert.deepEqual(prep.json.run, { journal: '.planning/retro/RUNS.json', recorded: true, problems: [] });
    const runs = readRuns();
    assert.equal(runs.runs.length, 1);
    assert.deepEqual([runs.runs[0].stem, runs.runs[0].milestone, runs.runs[0].executedPhases, runs.runs[0].planningDir], [prep.json.stem, 'v1.2', [], '.planning']);

    const after = retro(['due'], project);
    assert.deepEqual([after.json.due, after.json.reason, after.json.baseline], [false, 'not-due', 'retro']);
    assert.equal(after.json.lastRetro.stem, prep.json.stem);
  });

  test('retro.at_milestone_start false: not due at the start', () => {
    writeMilestone(4);
    writeConfig(project, { retro: { at_milestone_start: false } });
    assert.deepEqual(retro(['due'], project).json.triggers, []);
  });

  test('an invalid cadence key keeps the default and is named', () => {
    writeConfig(project, { retro: { cadence_phases: -2 } });
    const r = retro(['due'], project);
    assert.equal(r.json.cadencePhases, 3);
    assert.equal(r.json.problems.length, 1);
  });

  test('config-set accepts the schedule keys', () => {
    for (const [key, value] of [['retro.cadence_phases', '2'], ['retro.at_milestone_start', 'false']]) {
      const res = runGsdTools(['config-set', key, value], project);
      assert.equal(res.success, true, `config-set ${key}: ${res.error}`);
    }
    const r = retro(['due'], project);
    assert.deepEqual([r.json.cadencePhases, r.json.atMilestoneStart], [2, false]);
  });
});

describe('retro stage: the schedule triggers', () => {
  /** Hold a retro now (as /gsd-retro does), then return the stage answer after `executed` more phases. */
  function holdRetro() {
    const prep = retro(['prepare', '--sessions-dir', sessions], project);
    assert.equal(prep.success, true, prep.error);
    return readRuns().runs.at(-1);
  }

  beforeEach(() => {
    writeMilestone(6);
    writeSession(sessions, project, 'sess-smooth', smoothRecords());
  });

  test('roadmap:post on a planned milestone: suggest, trigger milestone-start', () => {
    const r = retro(['stage', '--milestone', 'v1.2', '--sessions-dir', sessions], project);
    assert.equal(r.success, true, r.error);
    assert.deepEqual([r.json.decision, r.json.reason, r.json.trigger, r.json.triggers], ['suggest', 'milestone-start', 'milestone-start', ['milestone-start']]);
    assert.equal(r.json.command, '/gsd-retro --session sess-smooth');
    assert.deepEqual(r.json.next, { skill: 'retro', args: '--session sess-smooth' });
    assert.equal(typeof r.json.message, 'string');
    assert.equal(r.json.schedule.due, true);
  });

  // Boundary at the default retro.cadence_phases 3: N−1, N, N+1 phases after the retro.
  for (const [executed, decision] of [[2, 'skip'], [3, 'suggest'], [4, 'suggest']]) {
    test(`execute:post, ${executed} phase(s) executed since the retro → ${decision}`, () => {
      const run = holdRetro();
      for (let n = 1; n <= executed; n++) executePhase(n);
      const r = retro(['stage', '--phase', String(executed), '--sessions-dir', sessions], project);
      assert.equal(r.success, true, r.error);
      assert.equal(r.json.decision, decision);
      assert.equal(r.json.schedule.phasesSinceRetro, executed);
      if (decision === 'skip') {
        assert.deepEqual([r.json.reason, r.json.trigger, r.json.next], ['below-threshold', null, null]);
      } else {
        assert.deepEqual([r.json.reason, r.json.trigger], ['cadence-reached', 'cadence']);
        // A scheduled retro reaches back to the last one.
        assert.deepEqual(r.json.next, { skill: 'retro', args: `--session sess-smooth --since ${run.at}` });
      }
    });
  }

  test('the retro the cadence asked for restarts the count', () => {
    holdRetro();
    for (let n = 1; n <= 3; n++) executePhase(n);
    assert.equal(retro(['stage', '--phase', '3', '--sessions-dir', sessions], project).json.decision, 'suggest');
    holdRetro();
    const r = retro(['stage', '--phase', '3', '--sessions-dir', sessions], project);
    assert.deepEqual([r.json.decision, r.json.schedule.phasesSinceRetro], ['skip', 0]);
  });

  test('retro.cadence_phases 0 never makes a retro due by count', () => {
    writeConfig(project, { retro: { cadence_phases: 0 } });
    holdRetro();
    for (let n = 1; n <= 6; n++) executePhase(n);
    const r = retro(['stage', '--phase', '6', '--sessions-dir', sessions], project);
    assert.deepEqual([r.json.decision, r.json.triggers], ['skip', []]);
  });

  test('retro.auto off silences the schedule too, and nothing is read', () => {
    writeConfig(project, { retro: { auto: 'off' } });
    const r = retro(['stage', '--milestone', 'v1.2', '--sessions-dir', sessions], project);
    assert.deepEqual([r.json.decision, r.json.reason, r.json.schedule, r.json.score], ['skip', 'retro-auto-off', null, null]);
    assert.equal(retro(['due'], project).json.due, false);
  });

  test('retro.auto auto dispatches the scheduled retro with no message', () => {
    writeConfig(project, { retro: { auto: 'auto' } });
    const r = retro(['stage', '--milestone', 'v1.2', '--sessions-dir', sessions], project);
    assert.deepEqual([r.json.decision, r.json.trigger, r.json.message], ['auto', 'milestone-start', null]);
    assert.deepEqual(r.json.next, { skill: 'retro', args: '--session sess-smooth' });
  });

  test('a corrupt journal pauses the schedule: a warning, no retro, problems at the top level', () => {
    for (let n = 1; n <= 3; n++) executePhase(n);
    fs.mkdirSync(path.join(project, '.planning', 'retro'), { recursive: true });
    fs.writeFileSync(path.join(project, '.planning', 'retro', 'RUNS.json'), '{ nope');
    for (const mode of ['suggest', 'auto']) {
      writeConfig(project, { retro: { auto: mode } });
      const r = retro(['stage', '--phase', '3', '--sessions-dir', sessions], project);
      assert.equal(r.success, true, r.error);
      assert.deepEqual([r.json.decision, r.json.reason, r.json.trigger, r.json.command, r.json.next], ['suggest', 'journal-invalid', null, null, null], mode);
      assert.match(r.json.message, /RUNS\.json/);
      assert.ok(r.json.problems.some((p) => p.includes('RUNS.json')), 'the journal problem is in the problems a host reads');
    }
    const due = retro(['due'], project).json;
    assert.deepEqual([due.due, due.reason, due.phasesSinceRetro, due.lastRetro], [false, 'journal-invalid', null, null]);
    assert.ok(due.problems.some((p) => p.includes('RUNS.json')));
    // A retro held now cannot be journaled either, and says so.
    const prep = retro(['prepare', '--sessions-dir', sessions], project);
    assert.equal(prep.json.run.recorded, false);
  });

  test('ship:post asks friction only: the schedule is not repeated after execute:post', () => {
    holdRetro();
    for (let n = 1; n <= 3; n++) executePhase(n);
    assert.equal(retro(['stage', '--phase', '3', '--sessions-dir', sessions], project).json.reason, 'cadence-reached');
    const ship = retro(['stage', 'signals', '--phase', '3', '--sessions-dir', sessions], project);
    assert.equal(ship.success, true, ship.error);
    assert.deepEqual([ship.json.decision, ship.json.reason, ship.json.schedule, ship.json.triggers], ['skip', 'below-threshold', null, []]);
  });

  test('an unknown stage scope is a usage error', () => {
    const r = retro(['stage', 'cadence', '--phase', '3', '--sessions-dir', sessions], project);
    assert.deepEqual([r.success, r.reason], [false, 'usage']);
  });

  test('the stage hands /gsd-retro arguments its prepare accepts, ISO --since included', () => {
    const first = holdRetro();
    for (let n = 1; n <= 3; n++) executePhase(n);
    const stage = retro(['stage', '--phase', '3', '--sessions-dir', sessions], project);
    assert.match(stage.json.next.args, /--since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    const prep = retro(['prepare', ...stage.json.next.args.split(' '), '--sessions-dir', sessions], project);
    assert.equal(prep.success, true, prep.error);
    assert.equal(prep.json.run.recorded, true);
    assert.equal(readRuns().runs.length, 2);
    assert.ok(readRuns().runs[1].at > first.at);
    assert.equal(retro(['stage', '--phase', '3', '--sessions-dir', sessions], project).json.decision, 'skip');
  });

  test('friction wins over the schedule and keeps its answer unchanged', () => {
    writeSession(sessions, project, 'sess-e2e', strugglingRecords(), new Date(Date.now() + 60000));
    const r = retro(['stage', '--milestone', 'v1.2', '--sessions-dir', sessions], project);
    assert.deepEqual([r.json.decision, r.json.reason, r.json.trigger], ['suggest', 'threshold-reached', 'signals']);
    assert.deepEqual(r.json.triggers, ['signals', 'milestone-start']);
    assert.equal(r.json.command, '/gsd-retro --session sess-e2e');
    assert.deepEqual(r.json.next, { skill: 'retro', args: '--session sess-e2e' });
  });
});

describe('decideRetro with a schedule', () => {
  const report = (score) => ({ score, threshold: 8, session: 's1', status: 'ok' });
  const schedule = (over = {}) => ({
    due: true, trigger: 'cadence', triggers: ['cadence'], reason: 'cadence-reached', milestone: 'v1.2', phasesSinceRetro: 3, cadencePhases: 3,
    lastRetro: { stem: 'RETRO-2026-10-20', at: '2026-10-20T10:00:00.000Z', milestone: 'v1.2' }, journal: '.planning/retro/RUNS.json', problems: [], ...over,
  });

  test('a due schedule below the threshold proposes, naming the trigger', () => {
    const d = router.decideRetro({ active: true, mode: 'suggest', report: report(2), schedule: schedule() });
    assert.deepEqual([d.decision, d.reason, d.trigger, d.triggers], ['suggest', 'cadence-reached', 'cadence', ['cadence']]);
    assert.equal(d.command, '/gsd-retro --session s1 --since 2026-10-20T10:00:00.000Z');
  });

  test('without a session or an earlier retro the command is bare', () => {
    const d = router.decideRetro({ active: true, mode: 'auto', report: { ...report(0), session: null }, schedule: schedule({ trigger: 'milestone-start', triggers: ['milestone-start'], lastRetro: null }) });
    assert.deepEqual([d.decision, d.reason, d.command, d.next], ['auto', 'milestone-start', '/gsd-retro', { skill: 'retro', args: '' }]);
  });

  test('a schedule that is not due changes nothing', () => {
    const d = router.decideRetro({ active: true, mode: 'suggest', report: report(7), schedule: schedule({ due: false, trigger: null, triggers: [] }) });
    assert.deepEqual([d.decision, d.reason, d.trigger], ['skip', 'below-threshold', null]);
  });

  test('off and inactive skip whatever the schedule says', () => {
    assert.equal(router.decideRetro({ active: true, mode: 'off', report: null, schedule: schedule() }).reason, 'retro-auto-off');
    assert.equal(router.decideRetro({ active: false, mode: 'auto', report: null, schedule: schedule() }).reason, 'capability-disabled');
  });
  test('under a workstream every proposed command names it, friction and schedule alike', () => {
    const sched = router.decideRetro({ active: true, mode: 'auto', report: report(2), schedule: schedule(), workstream: 'auth' });
    assert.equal(sched.next.args, '--session s1 --ws auth --since 2026-10-20T10:00:00.000Z');
    const friction = router.decideRetro({ active: true, mode: 'auto', report: report(9), schedule: schedule(), workstream: 'auth' });
    assert.equal(friction.next.args, '--session s1 --ws auth');
  });

  test('journal-invalid prints a warning and dispatches nothing, whatever the mode', () => {
    const broken = schedule({ due: false, trigger: null, triggers: [], reason: 'journal-invalid', phasesSinceRetro: null, lastRetro: null, problems: ['RUNS.json is not JSON'] });
    for (const mode of ['suggest', 'auto']) {
      const d = router.decideRetro({ active: true, mode, report: report(2), schedule: broken, problems: ['a config problem'] });
      assert.deepEqual([d.decision, d.reason, d.trigger, d.command, d.next], ['suggest', 'journal-invalid', null, null, null]);
      assert.deepEqual(d.problems, ['a config problem', 'RUNS.json is not JSON']);
      assert.match(d.message, /RUNS\.json is not JSON/);
    }
    // Friction still proposes its retro; the journal problem rides along.
    const f = router.decideRetro({ active: true, mode: 'suggest', report: report(9), schedule: broken });
    assert.deepEqual([f.reason, f.problems], ['threshold-reached', ['RUNS.json is not JSON']]);
  });
});

// ─── unknown subcommand ───────────────────────────────────────────────────────

test('an unknown subcommand is refused', () => {
  const r = runGsdTools(['retro', 'apply'], project);
  assert.equal(r.success, false);
});
