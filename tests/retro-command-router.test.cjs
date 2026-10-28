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

/**
 * Run `gsd-tools --json-errors retro …`; `reason` is the error's wire code,
 * parsed from stderr. GSD_HOME is a per-test temp dir, so the lessons journal
 * (`$GSD_HOME/.gsd/lessons/`) is never the real one.
 */
function retro(args, cwd, env = {}) {
  const res = runGsdTools(['--json-errors', 'retro', ...args], cwd, { GSD_RUNTIME: 'claude', GSD_HOME: gsdHome, ...env });
  const last = (res.error || '').trim().split('\n').filter(Boolean).pop() || '';
  let reason = null;
  if (!res.success && last.startsWith('{')) reason = JSON.parse(last).reason;
  return { ...res, reason, json: res.success && res.output ? JSON.parse(res.output) : null };
}

let project;
let sessions;
let gsdHome;
beforeEach(() => {
  project = createTempGitProject('gsd-retro-cli-');
  sessions = createTempDir('gsd-retro-sessions-');
  gsdHome = createTempDir('gsd-retro-home-');
});
afterEach(() => {
  cleanup(project);
  cleanup(sessions);
  cleanup(gsdHome);
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
    const dropped = Object.fromEntries(r.json.dropped.map((d) => [d.id, d.codes]));
    assert.deepEqual(dropped['cand-2'], ['judgement-in-steering-file']);
    assert.deepEqual(dropped['cand-3'], ['unknown-signal']);
    assert.deepEqual(dropped['cand-4'], ['missing-verify']);

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
    assert.deepEqual(r.json.dropped[0].codes, ['patch-outside']);
  });
});

// ─── checks ───────────────────────────────────────────────────────────────────

describe('retro checks', () => {
  const journal = () => JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'CHECKS.json'), 'utf8'));

  test('an edit runs under the journal lock; a lock that cannot be had writes nothing', () => {
    const calls = [];
    const errors = [];
    const route = (lock) => router.routeRetroCommand({
      args: ['retro', 'checks', 'record', '--id', 'no-stash', '--kind', 'hook', '--match', 'git stash is disabled'],
      cwd: project,
      raw: true,
      error: (message, reason) => { errors.push(reason); },
      _journalLock: lock,
    });
    route({ acquire: (p) => { calls.push(['acquire', path.basename(p)]); return null; }, release: () => calls.push(['release']) });
    assert.deepEqual(calls, [['acquire', '.CHECKS.lock']]);
    assert.deepEqual(errors, ['usage']);
    assert.equal(fs.existsSync(path.join(project, '.planning', 'retro', 'CHECKS.json')), false);
  });

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
    assert.deepEqual([r.json.due, r.json.reason, r.json.cadencePhases, r.json.journal], [false, 'no-roadmap', 2, '.planning/retro/RUNS.json']);
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
    assert.equal(r.json.cadencePhases, 2);
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

  // Boundary at the default retro.cadence_phases 2 (absent from config): limit−1, limit, limit+1.
  for (const [executed, decision] of [[1, 'skip'], [2, 'suggest'], [3, 'suggest']]) {
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

// ─── Layers, lessons and earlier proposals (ADR-5209 §10) ─────────────────────

const REPO_ROOT = path.resolve(__dirname, '..');
const HOST_VERSION = '2.1.310';

/** The struggling session as Claude Code records it, with its version on each record. */
function versionedRecords(extraBlocks = 0) {
  const rec = strugglingRecords().map((r) => JSON.stringify({ ...JSON.parse(r), version: HOST_VERSION }));
  for (let i = 0; i < extraBlocks; i++) {
    rec.push(JSON.stringify({ uuid: `x-${i}a`, timestamp: '2026-10-04T00:01:00Z', version: HOST_VERSION, type: 'assistant', message: { content: [{ type: 'tool_use', id: `hx${i}`, name: 'Bash', input: { command: 'git stash' } }] } }));
    rec.push(JSON.stringify({ uuid: `x-${i}b`, timestamp: '2026-10-04T00:01:01Z', version: HOST_VERSION, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `hx${i}`, content: 'PreToolUse:Bash hook error: git stash is disabled', is_error: true }] } }));
  }
  return rec;
}

function prepareSession(id, records) {
  writeSession(sessions, project, id, records);
  const prep = retro(['prepare', '--sessions-dir', sessions, '--session', id], project);
  assert.equal(prep.success, true, prep.error);
  return { prep, bundle: readBundle(prep) };
}

function writeCandidates(prep, candidates, version = 2) {
  fs.writeFileSync(path.join(project, prep.json.candidates), JSON.stringify({ version, candidates }));
}

const lessonsFile = () => path.join(gsdHome, '.gsd', 'lessons', 'LESSONS.json');

describe('retro prepare: what the analyst knows about the machine and the past', () => {
  test('the bundle names the GSD install, the runtime and its version, the lessons and the recurring proposals', () => {
    const { prep, bundle } = prepareSession('sess-v', versionedRecords());
    assert.equal(bundle.version, 2);
    assert.equal(fs.realpathSync(bundle.gsd.root), fs.realpathSync(REPO_ROOT));
    assert.equal(typeof bundle.gsd.version, 'string');
    assert.deepEqual(bundle.host, { name: 'claude', version: HOST_VERSION });
    assert.deepEqual([bundle.lessons.status, bundle.lessons.items, bundle.recurring.items], ['absent', [], []]);
    assert.deepEqual([bundle.evidence.lessons, bundle.evidence.retros], [[], []]);
    assert.deepEqual([prep.json.lessons.status, prep.json.recurring], ['absent', 0]);
  });

  test('a transcript without a version leaves host.version null', () => {
    const { bundle } = prepareSession('sess-nov', strugglingRecords());
    assert.deepEqual(bundle.host, { name: 'claude', version: null });
  });

  test('an unreadable lessons journal is reported as lessons-invalid and gives no lessons', () => {
    fs.mkdirSync(path.dirname(lessonsFile()), { recursive: true });
    fs.writeFileSync(lessonsFile(), '{ broken');
    const { prep, bundle } = prepareSession('sess-v', versionedRecords());
    assert.deepEqual([bundle.lessons.status, bundle.lessons.reason, bundle.lessons.items], ['invalid', 'lessons-invalid', []]);
    assert.equal(prep.json.lessons.reason, 'lessons-invalid');
    assert.equal(fs.readFileSync(lessonsFile(), 'utf8'), '{ broken', 'prepare never rewrites it');
  });
});

describe('retro candidates by layer, through the CLI', () => {
  test('each layer is checked against the machine and gets its route', () => {
    const { prep, bundle } = prepareSession('sess-v', versionedRecords());
    const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(prep, [
      { id: 'cand-1', severity: 'high', layer: 'gsd', category: 'environment', title: 'loader refused', signals: [hook], target: 'agents/gsd-retro-analyst.md', change: 'c', related: ['cand-2'] },
      { id: 'cand-2', severity: 'medium', layer: 'project', category: 'navigation', title: 'stopgap', signals: [hook], target: 'CLAUDE.md', change: 'c', related: ['cand-1'] },
      { id: 'cand-3', severity: 'medium', layer: 'host', category: 'environment', title: 'host', signals: [hook], target: `claude@${HOST_VERSION}: worktree isolation`, change: 'c' },
      { id: 'cand-4', severity: 'medium', layer: 'user', category: 'environment', title: 'hook', signals: [hook], target: '~/.claude/settings.json', change: 'c' },
      { id: 'cand-5', severity: 'low', layer: 'gsd', category: 'environment', title: 'nope', signals: [hook], target: 'agents/not-a-gsd-file.md', change: 'c' },
      { id: 'cand-6', severity: 'low', layer: 'host', category: 'environment', title: 'old', signals: [hook], target: 'claude@2.0.0: x', change: 'c' },
      { id: 'cand-7', severity: 'low', category: 'environment', title: 'no layer', signals: [hook], change: 'c' },
    ]);
    const r = retro(['candidates'], project);
    assert.equal(r.success, true, r.error);
    assert.equal(r.json.version, 2);
    assert.deepEqual(r.json.valid.map((c) => [c.id, c.layer, c.route]), [['cand-1', 'gsd', 'lesson'], ['cand-2', 'project', 'capture'], ['cand-3', 'host', 'lesson'], ['cand-4', 'user', 'user']]);
    assert.deepEqual(Object.fromEntries(r.json.dropped.map((d) => [d.id, d.codes])), {
      'cand-5': ['gsd-target-not-surface'],
      'cand-6': ['host-target-version'],
      'cand-7': ['missing-layer'],
    });
  });

  test('a version-1 candidates file written before layers is still valid and routed as before', () => {
    const { prep, bundle } = prepareSession('sess-v', versionedRecords());
    const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(prep, [{ id: 'cand-1', severity: 'high', category: 'environment', title: 'old shape', signals: [hook], target: 'apps/x/notes.md', change: 'c', patch: null, verify: null, existing: null }], 1);
    const r = retro(['candidates', '--id', 'cand-1'], project);
    assert.deepEqual([r.json.candidate.layer, r.json.candidate.layerDeclared, r.json.candidate.route], ['project', false, 'capture']);
  });
});

describe('retro lessons', () => {
  function gsdCandidate() {
    const { prep, bundle } = prepareSession('sess-v', versionedRecords());
    const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(prep, [
      { id: 'cand-1', severity: 'high', layer: 'gsd', category: 'environment', title: 'loader refused in a worktree', signals: [hook, bundle.evidence.inventory[0]].filter(Boolean), target: 'agents/gsd-retro-analyst.md', change: 'use literal paths' },
      { id: 'cand-2', severity: 'low', layer: 'project', category: 'navigation', title: 'pointer', signals: [hook], target: 'CLAUDE.md', change: 'c' },
    ]);
    return { prep, hook };
  }

  test('record journals a gsd candidate under GSD_HOME with an issue draft; a repeat is a duplicate', () => {
    const { prep, hook } = gsdCandidate();
    const rec = retro(['lessons', 'record', '--candidate', 'cand-1'], project);
    assert.equal(rec.success, true, rec.error);
    assert.deepEqual([rec.json.outcome, rec.json.lesson.layer, rec.json.lesson.status, rec.json.lesson.occurrences], ['created', 'gsd', 'open', 1]);
    assert.equal(rec.json.retro, prep.json.stem);
    const journal = JSON.parse(fs.readFileSync(lessonsFile(), 'utf8'));
    const [lesson] = journal.lessons;
    assert.deepEqual(lesson.occurrences[0].signals, [hook], 'signal ids only — no inventory refs, no text');
    assert.deepEqual([lesson.occurrences[0].hostVersion, typeof lesson.occurrences[0].gsdVersion], [HOST_VERSION, 'string']);
    assert.equal(fs.existsSync(path.join(gsdHome, '.gsd', 'lessons', 'drafts', `${lesson.id}.md`)), true);
    assert.equal(JSON.stringify(journal).includes(SECRET), false);
    assert.equal(retro(['lessons', 'record', '--candidate', 'cand-1'], project).json.outcome, 'duplicate');
  });

  test('a project candidate is not a lesson; an unknown or dropped candidate is a usage error', () => {
    gsdCandidate();
    for (const id of ['cand-2', 'cand-9']) {
      const r = retro(['lessons', 'record', '--candidate', id], project);
      assert.equal(r.reason, 'usage', id);
    }
    assert.equal(fs.existsSync(lessonsFile()), false);
  });

  test('list filters by layer and status; close marks it fixed; the next bundle carries it as evidence', () => {
    gsdCandidate();
    const id = retro(['lessons', 'record', '--candidate', 'cand-1'], project).json.lesson.id;
    const all = retro(['lessons', '--json'], project);
    assert.deepEqual([all.json.status, all.json.lessons.map((l) => [l.id, l.projects])], ['ok', [[id, 1]]]);
    assert.deepEqual(retro(['lessons', 'list', '--layer', 'host'], project).json.lessons, []);
    assert.equal(retro(['lessons', '--layer', 'team'], project).reason, 'usage');
    const closed = retro(['lessons', 'close', '--id', id, '--status', 'fixed', '--fixed-in', '1.19.0'], project);
    assert.deepEqual([closed.json.lesson.status, closed.json.lesson.fixedIn], ['fixed', '1.19.0']);
    assert.deepEqual(retro(['lessons', '--status', 'open'], project).json.lessons, []);
    assert.equal(retro(['lessons', 'close', '--id', id, '--status', 'maybe'], project).reason, 'usage');
    const { bundle } = prepareSession('sess-w', versionedRecords());
    assert.deepEqual(bundle.lessons.items.map((l) => [l.id, l.status]), [[id, 'fixed']]);
    assert.deepEqual(bundle.evidence.lessons, [id]);
  });

  test('an invalid journal: record fails with retro_lessons_invalid and leaves it; list answers lessons-invalid', () => {
    gsdCandidate();
    fs.mkdirSync(path.dirname(lessonsFile()), { recursive: true });
    fs.writeFileSync(lessonsFile(), '{"version":1,"lessons":[{"id":"bad"}]}');
    const r = retro(['lessons', 'record', '--candidate', 'cand-1'], project);
    assert.equal(r.reason, 'retro_lessons_invalid');
    assert.equal(fs.readFileSync(lessonsFile(), 'utf8'), '{"version":1,"lessons":[{"id":"bad"}]}');
    const list = retro(['lessons'], project);
    assert.deepEqual([list.success, list.json.status, list.json.reason, list.json.lessons], [true, 'invalid', 'lessons-invalid', []]);
  });

  test('record runs under the lessons lock; a lock that cannot be had writes nothing', (t) => {
    gsdCandidate();
    const saved = process.env.GSD_HOME;
    process.env.GSD_HOME = gsdHome;
    t.after(() => { if (saved === undefined) delete process.env.GSD_HOME; else process.env.GSD_HOME = saved; });
    const calls = [];
    const errors = [];
    router.routeRetroCommand({
      args: ['retro', 'lessons', 'record', '--candidate', 'cand-1'],
      cwd: project,
      raw: true,
      error: (_message, reason) => { errors.push(reason); },
      _lessonsLock: { acquire: (p) => { calls.push(path.basename(p)); return null; }, release: () => calls.push('release') },
    });
    assert.deepEqual([calls, errors], [['.LESSONS.lock'], ['usage']]);
    assert.equal(fs.existsSync(lessonsFile()), false);
  });

  test('an unknown lessons action is a usage error', () => {
    assert.equal(retro(['lessons', 'forget'], project).reason, 'usage');
  });
});

describe('retro applied and recurring proposals', () => {
  function firstRetro() {
    const { prep, bundle } = prepareSession('sess-1', versionedRecords());
    const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(prep, [{ id: 'cand-1', severity: 'medium', layer: 'project', category: 'navigation', title: 'pointer for the hook', signals: [hook], target: 'CLAUDE.md', change: 'c' }]);
    return { prep, hook };
  }

  test('applied is journaled on the retro\'s run; once only', () => {
    const { prep } = firstRetro();
    const a = retro(['applied', '--candidate', 'cand-1'], project);
    assert.deepEqual([a.json.recorded, a.json.already, a.json.refusal, a.json.route], [true, false, null, 'capture']);
    const runs = JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'RUNS.json'), 'utf8')).runs;
    assert.deepEqual(runs.find((r) => r.stem === prep.json.stem).applied.map((x) => [x.candidate, x.route]), [['cand-1', 'capture']]);
    assert.equal(retro(['applied', '--candidate', 'cand-1'], project).json.already, true);
    assert.equal(retro(['applied', '--candidate', 'cand-7'], project).reason, 'usage');
    assert.equal(retro(['applied'], project).reason, 'usage');
  });

  test('the same friction in a later session recurs with a new signal id; ignored and grown, it escalates', () => {
    const { prep: first, hook } = firstRetro();
    const { prep: second, bundle } = prepareSession('sess-2', versionedRecords(3));
    const now = bundle.report.signals.find((s) => s.kind === 'hook-block');
    assert.notEqual(now.id, hook, 'a signal id hashes its pointer: another session, another id');
    assert.deepEqual(bundle.recurring.items.map((e) => [e.retro, e.candidate, e.signals, e.applied, e.countNow > e.countThen, e.escalate]),
      [[first.json.stem, 'cand-1', [now.id], false, true, true]]);
    assert.deepEqual(bundle.evidence.retros, [`${first.json.stem}:cand-1`]);
    writeCandidates(second, [
      { id: 'cand-1', severity: 'high', layer: 'project', category: 'navigation', title: 'uncited', signals: [now.id], target: 'CLAUDE.md', change: 'c' },
      { id: 'cand-2', severity: 'medium', layer: 'project', category: 'navigation', title: 'not high', signals: [now.id, `retro:${first.json.stem}:cand-1`], target: 'CLAUDE.md', change: 'c' },
      { id: 'cand-3', severity: 'high', layer: 'gsd', category: 'environment', title: 'the real cause', signals: [now.id, `retro:${first.json.stem}:cand-1`], target: 'agents/gsd-retro-analyst.md', change: 'c' },
    ]);
    const r = retro(['candidates', '--retro', second.json.stem], project);
    assert.deepEqual(r.json.valid.map((c) => c.id), ['cand-3']);
    assert.deepEqual(Object.fromEntries(r.json.dropped.map((d) => [d.id, d.codes])), { 'cand-1': ['recurring-uncited'], 'cand-2': ['recurring-not-escalated'] });
  });

  test('the first retro\'s .work bundle gone (a new clone or worktree): RUNS.json still carries its signals', () => {
    const { prep: first } = firstRetro();
    const run = JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'RUNS.json'), 'utf8')).runs.find((r) => r.stem === first.json.stem);
    assert.ok(run.signals.length > 0);
    assert.deepEqual(Object.keys(run.signals[0]).sort(), ['count', 'fingerprint', 'id'], 'ids, hashes and counts — no key, no text');
    fs.unlinkSync(path.join(project, first.json.bundle));
    const { bundle } = prepareSession('sess-2', versionedRecords(3));
    assert.deepEqual([bundle.recurring.items.map((e) => [e.retro, e.escalate]), bundle.recurring.unreadable], [[[first.json.stem, true]], []]);
  });

  test('an applied proposal that recurs is applied, not escalated: the change did not work', () => {
    firstRetro();
    retro(['applied', '--candidate', 'cand-1'], project);
    const { bundle } = prepareSession('sess-2', versionedRecords(3));
    assert.deepEqual(bundle.recurring.items.map((e) => [e.applied, e.appliedBy, e.escalate]), [[true, 'runs', false]]);
  });

  test('a gsd lesson is waiting for a fix, not applied; once fixed it is applied (and its recurrence a regression)', () => {
    const { prep, bundle } = prepareSession('sess-1', versionedRecords());
    const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(prep, [{ id: 'cand-1', severity: 'high', layer: 'gsd', category: 'environment', title: 'loader', signals: [hook], target: 'agents/gsd-retro-analyst.md', change: 'c' }]);
    const id = retro(['lessons', 'record', '--candidate', 'cand-1'], project).json.lesson.id;
    const waiting = prepareSession('sess-2', versionedRecords(3)).bundle;
    assert.deepEqual(waiting.recurring.items.map((e) => [e.applied, e.appliedBy, e.lesson, e.escalate]), [[false, null, { id, status: 'open', layer: 'gsd' }, false]]);
    retro(['lessons', 'close', '--id', id, '--status', 'fixed', '--fixed-in', '1.0.0'], project);
    const fixed = prepareSession('sess-3', versionedRecords(3)).bundle;
    assert.deepEqual(fixed.recurring.items.filter((e) => e.retro === prep.json.stem).map((e) => [e.applied, e.appliedBy, e.lesson.status]), [[true, 'lessons', 'fixed']]);
  });

  test('--apply reads the stem from the candidate lookup: --pick retro gives it', () => {
    const { prep } = firstRetro();
    const res = runGsdTools(['retro', 'candidates', '--id', 'cand-1', '--pick', 'retro'], project, { GSD_RUNTIME: 'claude', GSD_HOME: gsdHome });
    assert.equal(res.success, true, res.error);
    assert.equal(res.output.trim(), prep.json.stem);
  });

  test('without the .work bundle (a new clone): applied records, and lessons record takes evidence from the run', () => {
    const { prep, bundle } = prepareSession('sess-1', versionedRecords());
    const hook = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(prep, [
      { id: 'cand-1', severity: 'medium', layer: 'project', category: 'navigation', title: 'pointer', signals: [hook], target: 'CLAUDE.md', change: 'c' },
      { id: 'cand-2', severity: 'high', layer: 'host', category: 'environment', title: 'isolation', signals: [hook], target: `claude@${HOST_VERSION}: worktree isolation`, change: 'c' },
    ]);
    fs.unlinkSync(path.join(project, prep.json.bundle));
    const a = retro(['applied', '--candidate', 'cand-1'], project);
    assert.deepEqual([a.json.recorded, a.json.route], [true, 'capture']);
    const v = retro(['candidates'], project);
    assert.deepEqual([v.json.bundle, v.json.valid.map((c) => c.id)], [null, ['cand-2', 'cand-1']]);
    const rec = retro(['lessons', 'record', '--candidate', 'cand-2'], project);
    assert.equal(rec.json.outcome, 'created', rec.error);
    const occ = JSON.parse(fs.readFileSync(lessonsFile(), 'utf8')).lessons[0].occurrences[0];
    assert.deepEqual([occ.signals, occ.hostVersion, occ.date], [[hook], HOST_VERSION, prep.json.stem.slice(6, 16)]);
  });

  test('validation trusts the run, not the bundle the analyst can write: a forged host version or recurring list changes nothing', () => {
    const { prep: first } = firstRetro();
    const { prep, bundle } = prepareSession('sess-2', versionedRecords(3));
    const now = bundle.report.signals.find((s) => s.kind === 'hook-block').id;
    const forged = { ...bundle, host: { name: 'claude', version: '9.9.9' }, recurring: { items: [], omitted: 0, unreadable: [] } };
    fs.writeFileSync(path.join(project, prep.json.bundle), JSON.stringify(forged));
    writeCandidates(prep, [
      { id: 'cand-1', severity: 'high', layer: 'host', category: 'environment', title: 'forged', signals: [now, `retro:${first.json.stem}:cand-1`], target: 'claude@9.9.9: x', change: 'c' },
      { id: 'cand-2', severity: 'high', layer: 'project', category: 'navigation', title: 'uncited', signals: [now], target: 'CLAUDE.md', change: 'c' },
    ]);
    const r = retro(['candidates', '--retro', prep.json.stem], project);
    assert.deepEqual(Object.fromEntries(r.json.dropped.map((d) => [d.id, d.codes])), { 'cand-1': ['host-target-version'], 'cand-2': ['recurring-uncited'] });
  });
});

describe('a retro is held to what prepare showed the analyst (ADR-5209 §10)', () => {
  test('a lesson recorded after R2 was prepared does not drop R2\'s candidate (N1)', () => {
    // R1: a gsd candidate for the hook block.
    const { prep: r1, bundle: b1 } = prepareSession('sess-1', versionedRecords());
    const hook1 = b1.report.signals.find((s) => s.kind === 'hook-block').id;
    writeCandidates(r1, [{ id: 'cand-1', severity: 'high', layer: 'gsd', category: 'environment', title: 'loader', signals: [hook1], target: 'agents/gsd-retro-analyst.md', change: 'c' }]);
    // R2, prepared while R1 cand-1 is not a lesson yet: the analyst cites retro:R1:cand-1.
    const { prep: r2, bundle: b2 } = prepareSession('sess-2', versionedRecords(3));
    const hook2 = b2.report.signals.find((s) => s.kind === 'hook-block').id;
    assert.deepEqual(b2.recurring.items.map((e) => [e.retro, e.lesson]), [[r1.json.stem, null]]);
    writeCandidates(r2, [
      { id: 'cand-1', severity: 'low', layer: 'project', category: 'navigation', title: 'pointer', signals: [hook2], target: 'CLAUDE.md', change: 'c' },
      { id: 'cand-2', severity: 'high', layer: 'gsd', category: 'environment', title: 'loader again', signals: [hook2, `retro:${r1.json.stem}:cand-1`], target: 'agents/gsd-retro-analyst.md', change: 'c' },
    ]);
    // Then the human applies R1 cand-1: it becomes an open gsd lesson.
    assert.equal(retro(['lessons', 'record', '--retro', r1.json.stem, '--candidate', 'cand-1'], project).json.outcome, 'created');
    // R2 cand-2 stays valid: R2 is held to its own snapshot, where no lesson existed.
    const r = retro(['candidates', '--retro', r2.json.stem], project);
    assert.deepEqual(r.json.valid.map((c) => c.id), ['cand-2']);
    assert.deepEqual(Object.fromEntries(r.json.dropped.map((d) => [d.id, d.codes])), { 'cand-1': ['recurring-uncited'] });
    const rec = retro(['lessons', 'record', '--retro', r2.json.stem, '--candidate', 'cand-2'], project);
    assert.equal(rec.success, true, rec.error);
  });

  test('the run journals the snapshot; without the bundle, inventory refs still count and a dropped candidate is not applied', () => {
    const { prep, bundle } = prepareSession('sess-1', versionedRecords());
    const run = JSON.parse(fs.readFileSync(path.join(project, '.planning', 'retro', 'RUNS.json'), 'utf8')).runs.find((x) => x.stem === prep.json.stem);
    assert.deepEqual(Object.keys(run.snapshot).sort(), ['checks', 'inventory', 'lessons', 'recurring']);
    assert.deepEqual(run.snapshot.inventory, bundle.evidence.inventory);
    const inv = bundle.evidence.inventory[0];
    assert.ok(inv, 'the fixture project has an inventory finding');
    writeCandidates(prep, [
      { id: 'cand-1', severity: 'low', layer: 'project', category: 'environment', title: 'wire it', signals: [inv], change: 'c' },
      { id: 'cand-2', severity: 'low', layer: 'project', category: 'mechanical', title: 'no verify', signals: [inv], change: 'c' },
    ]);
    fs.unlinkSync(path.join(project, prep.json.bundle));
    assert.deepEqual(retro(['applied', '--candidate', 'cand-1'], project).json.recorded, true);
    assert.equal(retro(['applied', '--candidate', 'cand-2'], project).reason, 'usage', 'missing-verify: not applied');
  });
});

describe('a RUNS.json from a newer GSD', () => {
  test('the stage says journal-newer, not journal-invalid, and nothing is rewritten', () => {
    writeMilestone(3);
    const file = path.join(project, '.planning', 'retro', 'RUNS.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 3, runs: [] }));
    const due = retro(['due'], project);
    assert.equal(due.json.reason, 'journal-newer');
    writeSession(sessions, project, 'sess-s', smoothRecords());
    const stage = retro(['stage', '--sessions-dir', sessions], project);
    assert.deepEqual([stage.json.decision, stage.json.reason, stage.json.next], ['suggest', 'journal-newer', null]);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ version: 3, runs: [] }));
  });
});
