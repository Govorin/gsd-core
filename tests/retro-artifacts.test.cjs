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
    assert.deepEqual(r.dropped.map((d) => [d.id, d.codes]), [['cand-4', [ra.CANDIDATE_DROP.UNKNOWN_SIGNAL]], ['cand-5', [ra.CANDIDATE_DROP.NO_SIGNAL]]]);
    assert.deepEqual(r.dropped.map((d) => d.reasons.length), r.dropped.map((d) => d.codes.length), 'one code per reason');
  });

  test('judgement rules never land in a steering file, whatever its directory or case', () => {
    for (const target of ['CLAUDE.md', '.claude/CLAUDE.md', 'guides/agents.md', 'GEMINI.md']) {
      const r = ra.validateCandidates({ candidates: [base({ category: 'judgement', target })] }, evidence, opts());
      assert.deepEqual(r.dropped[0].codes, [ra.CANDIDATE_DROP.JUDGEMENT_IN_STEERING_FILE], target);
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
    assert.deepEqual(r.dropped[0].codes, [ra.CANDIDATE_DROP.MISSING_VERIFY]);
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
    assert.deepEqual(r.dropped.map((d) => d.codes), [[ra.CANDIDATE_DROP.PATCH_MISSING], [ra.CANDIDATE_DROP.PATCH_OUTSIDE], [ra.CANDIDATE_DROP.PATCH_OUTSIDE]]);
  });

  test('a duplicate id, a bad id and a missing envelope are dropped', () => {
    const r = ra.validateCandidates({ candidates: [base(), base(), base({ id: 'c1' })] }, evidence, opts());
    assert.deepEqual(r.dropped.map((d) => d.codes), [[ra.CANDIDATE_DROP.DUPLICATE_ID], [ra.CANDIDATE_DROP.INVALID_ID]]);
    for (const bad of [[], { version: 3, candidates: [] }, { version: 2 }]) {
      const f = ra.validateCandidates(bad, evidence, opts());
      assert.deepEqual([f.version, f.dropped[0].id, f.dropped[0].codes], [null, '(file)', [ra.CANDIDATE_DROP.INVALID_ENVELOPE]]);
    }
  });
});

// ─── Layers (ADR-5209 §10) ────────────────────────────────────────────────────

describe('validateCandidates: the layer that owns the cause', () => {
  const evidence = {
    signals: new Set(['hook-block:aaaaaaaaaa', 'repeated-tool-error:bbbbbbbbbb']),
    inventory: new Set(),
    checks: new Set(),
    lessons: new Set(['lesson-0123456789']),
    retros: new Set(['RETRO-2026-10-25:cand-1']),
  };
  let gsdRoot;
  let home;
  beforeEach(() => {
    gsdRoot = createTempProject('gsd-retro-install-');
    fs.mkdirSync(path.join(gsdRoot, 'gsd-core', 'references'), { recursive: true });
    fs.writeFileSync(path.join(gsdRoot, 'gsd-core', 'references', 'gsd-run-resolver.md'), '# r\n');
    fs.mkdirSync(path.join(gsdRoot, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(gsdRoot, 'agents', 'gsd-retro-analyst.md'), '# a\n');
    fs.writeFileSync(path.join(gsdRoot, 'agents', 'my-own-agent.md'), '# mine\n');
    home = path.dirname(project);
  });
  afterEach(() => { cleanup(gsdRoot); });
  const ctx = (over = {}) => ({ gsdRoot, hostName: 'claude', hostVersion: '2.1.310', homeDir: home, ...over });
  const opts = (over = {}) => ({ projectRoot: project, patchesDir: '.planning/retro/patches/RETRO-2026-10-28', layer: ctx(), ...over });
  const cand = (over) => ({ id: 'cand-1', severity: 'high', category: 'environment', title: 't', change: 'c', signals: ['hook-block:aaaaaaaaaa'], ...over });
  const v2 = (...candidates) => ({ version: 2, candidates });
  const one = (c, o) => ra.validateCandidates(v2(c), evidence, opts(o));
  const codes = (r) => (r.dropped[0] ? r.dropped[0].codes : []);

  test('version 2: layer is required and one of four', () => {
    assert.deepEqual(codes(one(cand({}))), [ra.CANDIDATE_DROP.MISSING_LAYER]);
    assert.deepEqual(codes(one(cand({ layer: 'team' }))), [ra.CANDIDATE_DROP.INVALID_LAYER]);
    assert.deepEqual(ra.CANDIDATE_LAYERS, ['project', 'user', 'gsd', 'host']);
  });

  test('version 1 without a layer reads as project and is routed as before, unchecked by layer', () => {
    for (const envelope of [{ version: 1 }, {}]) {
      const r = ra.validateCandidates({ ...envelope, candidates: [cand({ target: '~/.claude/settings.json' }), cand({ id: 'cand-2', category: 'mechanical', verify: 'npm test' })] }, evidence, opts());
      assert.deepEqual(r.valid.map((c) => [c.id, c.layer, c.layerDeclared, c.route]), [['cand-1', 'project', false, 'capture'], ['cand-2', 'project', false, 'quick']]);
      assert.equal(r.version, 1);
    }
  });

  test('version 1 with a declared layer is checked like version 2', () => {
    const r = ra.validateCandidates({ version: 1, candidates: [cand({ layer: 'gsd', target: 'gsd-core/missing.md' })] }, evidence, opts());
    assert.deepEqual(codes(r), [ra.CANDIDATE_DROP.GSD_TARGET_MISSING]);
  });

  test('project: a target inside the project passes, one outside it does not', () => {
    for (const target of ['eslint-rules/no-stash.js', 'agent_skills.gsd-code-reviewer', '.claude/settings.json#permissions.allow', null]) {
      assert.equal(one(cand({ layer: 'project', target })).valid.length, 1, String(target));
    }
    for (const target of ['~/.claude/settings.json', '/etc/hosts', '../other-repo/CLAUDE.md']) {
      assert.deepEqual(codes(one(cand({ layer: 'project', target }))), [ra.CANDIDATE_DROP.PROJECT_TARGET_OUTSIDE], target);
    }
    assert.equal(one(cand({ layer: 'project' })).valid[0].route, 'capture');
  });

  test('user: under the home directory and outside the project; routed to the human', () => {
    const ok = one(cand({ layer: 'user', target: '~/.claude/settings.json#hooks.SubagentStart' }));
    assert.deepEqual(ok.valid.map((c) => [c.layer, c.route]), [['user', 'user']]);
    const inProject = `~/${path.basename(project)}/CLAUDE.md`;
    const cases = [
      ['/etc/claude/settings.json', ra.CANDIDATE_DROP.USER_TARGET_OUTSIDE_HOME],
      ['.claude/settings.json', ra.CANDIDATE_DROP.USER_TARGET_OUTSIDE_HOME],
      ['~/../elsewhere/settings.json', ra.CANDIDATE_DROP.USER_TARGET_OUTSIDE_HOME],
      [inProject, ra.CANDIDATE_DROP.USER_TARGET_IN_PROJECT],
      [null, ra.CANDIDATE_DROP.MISSING_TARGET],
    ];
    for (const [target, code] of cases) assert.deepEqual(codes(one(cand({ layer: 'user', target }))), [code], String(target));
  });

  test('user: a judgement rule still never lands in a steering file, global or not', () => {
    assert.deepEqual(codes(one(cand({ layer: 'user', category: 'judgement', target: '~/.claude/CLAUDE.md' }))), [ra.CANDIDATE_DROP.JUDGEMENT_IN_STEERING_FILE]);
  });

  test('gsd: an existing path of GSD\'s own surface in the install; routed to a lesson', () => {
    const ok = one(cand({ layer: 'gsd', target: 'gsd-core/references/gsd-run-resolver.md#loader' }));
    assert.deepEqual(ok.valid.map((c) => [c.layer, c.route]), [['gsd', 'lesson']]);
    const cases = [
      ['gsd-core/references/missing.md', ra.CANDIDATE_DROP.GSD_TARGET_MISSING],
      ['agents/my-own-agent.md', ra.CANDIDATE_DROP.GSD_TARGET_NOT_SURFACE],
      ['src/retro-artifacts.cts', ra.CANDIDATE_DROP.GSD_TARGET_NOT_SURFACE],
      ['gsd-core/../agents/my-own-agent.md', ra.CANDIDATE_DROP.GSD_TARGET_NOT_SURFACE],
      [path.join(gsdRoot, 'gsd-core', 'references', 'gsd-run-resolver.md'), ra.CANDIDATE_DROP.GSD_TARGET_NOT_SURFACE],
      [null, ra.CANDIDATE_DROP.MISSING_TARGET],
    ];
    for (const [target, code] of cases) assert.deepEqual(codes(one(cand({ layer: 'gsd', target }))), [code], String(target));
    assert.deepEqual(codes(one(cand({ layer: 'gsd', target: 'agents/gsd-retro-analyst.md' }), { layer: ctx({ gsdRoot: null }) })), [ra.CANDIDATE_DROP.GSD_ROOT_UNKNOWN]);
  });

  test('gsd: a mechanical check is verified in GSD, not here, so verify is optional', () => {
    assert.equal(one(cand({ layer: 'gsd', category: 'mechanical', target: 'agents/gsd-retro-analyst.md' })).valid.length, 1);
    assert.deepEqual(codes(one(cand({ layer: 'user', category: 'mechanical', target: '~/.claude/hooks/x.js' }))), [ra.CANDIDATE_DROP.MISSING_VERIFY]);
  });

  test('host: names the runtime and the version the session ran', () => {
    assert.deepEqual(one(cand({ layer: 'host', target: 'claude@2.1.310: worktree isolation' })).valid.map((c) => [c.route, c.notes]), [['lesson', []]]);
    const cases = [
      ['codex@2.1.310: worktree isolation', ra.CANDIDATE_DROP.HOST_TARGET_NAME],
      ['worktree isolation in Claude Code', ra.CANDIDATE_DROP.HOST_TARGET_NAME],
      ['claude: worktree isolation', ra.CANDIDATE_DROP.HOST_TARGET_VERSION],
      ['claude@2.1.309: worktree isolation', ra.CANDIDATE_DROP.HOST_TARGET_VERSION],
    ];
    for (const [target, code] of cases) assert.deepEqual(codes(one(cand({ layer: 'host', target }))), [code], target);
  });

  test('host: an unknown version is allowed without one, and flagged', () => {
    const o = { layer: ctx({ hostVersion: null }) };
    for (const target of ['claude: worktree isolation', 'claude@unknown: worktree isolation', 'claude']) {
      assert.deepEqual(one(cand({ layer: 'host', target }), o).valid.map((c) => c.notes), [[ra.CANDIDATE_NOTE.HOST_VERSION_UNKNOWN]], target);
    }
    assert.deepEqual(codes(one(cand({ layer: 'host', target: 'claude@2.1.310: x' }), o)), [ra.CANDIDATE_DROP.HOST_TARGET_VERSION]);
    assert.deepEqual(codes(one(cand({ layer: 'host', target: 'claude: x' }), { layer: ctx({ hostName: null }) })), [ra.CANDIDATE_DROP.HOST_UNKNOWN]);
  });

  test('user: a bare ~ or ~/ is no target; the main worktree of a linked one counts as the project', () => {
    for (const target of ['~', '~/', '~//']) {
      assert.deepEqual(codes(one(cand({ layer: 'user', target }))), [ra.CANDIDATE_DROP.USER_TARGET_OUTSIDE_HOME], target);
    }
    const main = path.join(home, 'main-repo');
    const o = { layer: ctx({ projectRoots: [main] }) };
    assert.deepEqual(codes(one(cand({ layer: 'user', target: '~/main-repo/CLAUDE.md' }), o)), [ra.CANDIDATE_DROP.USER_TARGET_IN_PROJECT]);
    assert.equal(one(cand({ layer: 'user', target: '~/main-repo-other/x' }), o).valid.length, 1);
  });

  test('gsd: a directory of the install is not a target file', () => {
    assert.deepEqual(codes(one(cand({ layer: 'gsd', target: 'gsd-core/references' }))), [ra.CANDIDATE_DROP.GSD_TARGET_MISSING]);
  });

  test('gsd and host: no path of this machine in the title or the change (it may be filed upstream)', () => {
    const base = { layer: 'gsd', target: 'agents/gsd-retro-analyst.md' };
    for (const [field, text] of [['title', 'refused in ~/IdeaProjects/mn'], ['change', 'call /Users/me/bin/x instead'], ['change', 'see (/tmp/x)']]) {
      assert.deepEqual(codes(one(cand({ ...base, [field]: text }))), [ra.CANDIDATE_DROP.PRIVATE_PATH], text);
    }
    assert.deepEqual(codes(one(cand({ layer: 'host', target: 'claude@2.1.310: x', title: 'see ~/x' }))), [ra.CANDIDATE_DROP.PRIVATE_PATH]);
    const inside = path.join(gsdRoot, 'agents', 'gsd-retro-analyst.md');
    assert.equal(one(cand({ ...base, change: `edit ${inside} and gsd-core/references/x.md; 1/2 of calls` })).valid.length, 1, 'a path inside the GSD install and relative paths pass');
    assert.equal(one(cand({ layer: 'project', change: 'edit ~/.claude/x by hand', target: 'CLAUDE.md' })).valid.length, 1, 'a project candidate is not filed upstream');
  });

  test('a lesson keeps title and target ≤ 300 and change ≤ 2000: limit, limit+1', () => {
    const base = { layer: 'gsd', target: 'agents/gsd-retro-analyst.md' };
    for (const [field, max] of [['title', 300], ['change', 2000]]) {
      assert.equal(one(cand({ ...base, [field]: 'x'.repeat(max - 1) })).valid.length, 1, `${field} ${max - 1}`);
      assert.equal(one(cand({ ...base, [field]: 'x'.repeat(max) })).valid.length, 1, `${field} ${max}`);
      assert.deepEqual(codes(one(cand({ ...base, [field]: 'x'.repeat(max + 1) }))), [ra.CANDIDATE_DROP.FIELD_TOO_LONG], `${field} ${max + 1}`);
    }
    assert.deepEqual(codes(one(cand({ layer: 'host', target: `claude@2.1.310: ${'x'.repeat(300)}` }))), [ra.CANDIDATE_DROP.FIELD_TOO_LONG]);
    assert.equal(one(cand({ layer: 'project', change: 'x'.repeat(5000) })).valid.length, 1, 'a project candidate is not journaled');
    assert.deepEqual(ra.LESSON_TEXT_MAX, { target: 300, title: 300, change: 2000 });
  });

  test('a retire-check is always project', () => {
    assert.deepEqual(codes(one(cand({ layer: 'gsd', category: 'retire-check', verify: 'x', target: 'agents/gsd-retro-analyst.md' }))), [ra.CANDIDATE_DROP.LAYER_CATEGORY]);
  });

  test('related names another candidate of the same file, never itself or a stranger', () => {
    const r = ra.validateCandidates(v2(
      cand({ id: 'cand-1', layer: 'gsd', target: 'agents/gsd-retro-analyst.md', related: ['cand-2'] }),
      cand({ id: 'cand-2', layer: 'project', target: 'CLAUDE.md', category: 'navigation', related: ['cand-1'] }),
      cand({ id: 'cand-3', layer: 'project', related: ['cand-3'] }),
      cand({ id: 'cand-4', layer: 'project', related: ['cand-9'] }),
    ), evidence, opts());
    assert.deepEqual(r.valid.map((c) => [c.id, c.related]), [['cand-1', ['cand-2']], ['cand-2', ['cand-1']]]);
    assert.deepEqual(r.dropped.map((d) => [d.id, d.codes]), [['cand-3', [ra.CANDIDATE_DROP.INVALID_RELATED]], ['cand-4', [ra.CANDIDATE_DROP.INVALID_RELATED]]]);
  });

  test('lesson:<id> and retro:<stem>:<cand> are evidence only when the bundle carried them', () => {
    assert.equal(one(cand({ layer: 'project', signals: ['lesson:lesson-0123456789'] })).valid.length, 1);
    assert.equal(one(cand({ layer: 'project', signals: ['retro:RETRO-2026-10-25:cand-1'] })).valid.length, 1);
    for (const ref of ['lesson:lesson-ffffffffff', 'lesson:anything', 'retro:RETRO-2026-10-24:cand-1', 'retro:RETRO-2026-10-25:cand-1:extra']) {
      assert.deepEqual(codes(one(cand({ layer: 'project', signals: [ref] }))), [ra.CANDIDATE_DROP.UNKNOWN_SIGNAL], ref);
    }
    assert.deepEqual(ra.citedLessons(['hook-block:aaaaaaaaaa', 'lesson:lesson-0123456789']), ['lesson-0123456789']);
  });

  test('a recurring proposal must be cited; one ignored and grown makes the answer high', () => {
    const recurring = [
      { retro: 'RETRO-2026-10-25', candidate: 'cand-1', signals: ['hook-block:aaaaaaaaaa'], escalate: true },
      { retro: 'RETRO-2026-10-20', candidate: 'cand-2', signals: ['repeated-tool-error:bbbbbbbbbb'], escalate: false },
    ];
    const r = ra.validateCandidates(v2(
      cand({ id: 'cand-1', layer: 'project', signals: ['hook-block:aaaaaaaaaa'] }),
      cand({ id: 'cand-2', layer: 'project', severity: 'medium', signals: ['hook-block:aaaaaaaaaa', 'retro:RETRO-2026-10-25:cand-1'] }),
      cand({ id: 'cand-3', layer: 'project', severity: 'high', signals: ['hook-block:aaaaaaaaaa', 'retro:RETRO-2026-10-25:cand-1'] }),
      cand({ id: 'cand-4', layer: 'project', severity: 'low', signals: ['repeated-tool-error:bbbbbbbbbb', 'retro:RETRO-2026-10-20:cand-2'] }),
    ), { ...evidence, retros: new Set(['RETRO-2026-10-25:cand-1', 'RETRO-2026-10-20:cand-2']) }, opts({ recurring }));
    assert.deepEqual(r.valid.map((c) => c.id), ['cand-3', 'cand-4']);
    assert.deepEqual(r.dropped.map((d) => [d.id, d.codes]), [
      ['cand-1', [ra.CANDIDATE_DROP.RECURRING_UNCITED]],
      ['cand-2', [ra.CANDIDATE_DROP.RECURRING_NOT_ESCALATED]],
    ]);
  });
});

describe('validateCandidates: a recurring open lesson', () => {
  test('a candidate whose friction is an open gsd lesson must cite it; a fixed or user one need not', () => {
    const evidence = { signals: new Set(['hook-block:aaaaaaaaaa']), inventory: new Set(), checks: new Set(), lessons: new Set(['lesson-0123456789']), retros: new Set(['RETRO-2026-10-25:cand-1']) };
    const opts = (lesson) => ({ projectRoot: project, patchesDir: '.planning/retro/patches/RETRO-2026-10-28', recurring: [{ retro: 'RETRO-2026-10-25', candidate: 'cand-1', signals: ['hook-block:aaaaaaaaaa'], escalate: false, lesson }] });
    const c = (signals) => ({ version: 2, candidates: [{ id: 'cand-1', severity: 'low', layer: 'project', category: 'navigation', title: 't', change: 'c', signals }] });
    const open = { id: 'lesson-0123456789', status: 'open', layer: 'gsd' };
    const without = ['hook-block:aaaaaaaaaa', 'retro:RETRO-2026-10-25:cand-1'];
    assert.deepEqual(ra.validateCandidates(c(without), evidence, opts(open)).dropped.map((d) => d.codes), [[ra.CANDIDATE_DROP.RECURRING_LESSON_UNCITED]]);
    assert.equal(ra.validateCandidates(c([...without, 'lesson:lesson-0123456789']), evidence, opts(open)).valid.length, 1);
    for (const lesson of [{ ...open, status: 'fixed' }, { ...open, layer: 'user' }, null]) {
      assert.equal(ra.validateCandidates(c(without), evidence, opts(lesson)).valid.length, 1, JSON.stringify(lesson));
    }
  });
});

// ─── Earlier proposals ────────────────────────────────────────────────────────

describe('signalFingerprint', () => {
  test('the same kind and basis across sessions, paths masked; no basis, no fingerprint', () => {
    const a = ra.signalFingerprint('hook-block', 'git stash is disabled');
    assert.equal(ra.signalFingerprint('hook-block', 'git   stash is disabled'), a);
    assert.notEqual(ra.signalFingerprint('permission-denial', 'git stash is disabled'), a);
    assert.match(a, /^hook-block:[0-9a-f]{10}$/);
    assert.equal(ra.signalFingerprint('hook-block', 'isolated in ~/wt/one'), ra.signalFingerprint('hook-block', 'isolated in /Users/x/wt/two'));
    assert.equal(ra.signalFingerprint('user-correction', null), null);
    assert.equal(ra.signalFingerprint('user-correction', '  '), null);
  });
});

describe('recurring proposals', () => {
  /** A retro on disk: its candidates file and its bundle's signals. */
  function writeRetro(stem, candidates, signals) {
    const p = ra.retroPathsFor(project, stem);
    fs.mkdirSync(path.join(project, path.dirname(p.bundle)), { recursive: true });
    fs.writeFileSync(path.join(project, p.candidates), JSON.stringify({ version: 1, candidates }));
    if (signals) fs.writeFileSync(path.join(project, p.bundle), JSON.stringify({ report: { signals, omitted: [] } }));
  }
  const old = { id: 'hook-block:1111111111', kind: 'hook-block', key: 'worktree isolation refused git -C', count: 7 };
  const none = { runs: new Set(), checks: new Set(), lessons: new Map() };

  test('the same friction in a new session has a new id and is still recognised', () => {
    writeRetro('RETRO-2026-10-25', [{ id: 'cand-1', title: 'pointer in CLAUDE.md', signals: [old.id] }], [old]);
    const past = ra.readPastProposals(project, 'RETRO-2026-10-28');
    assert.deepEqual(past.map((p) => [p.retro, p.candidate, p.layer]), [['RETRO-2026-10-25', 'cand-1', 'project']]);
    const now = { ...old, id: 'hook-block:2222222222', count: 68 };
    const r = ra.computeRecurring({ current: ra.signalFacts([now]), past, applied: none });
    assert.deepEqual(r.items.map((e) => [e.retro, e.candidate, e.signals, e.countThen, e.countNow, e.applied, e.escalate]),
      [['RETRO-2026-10-25', 'cand-1', ['hook-block:2222222222'], 7, 68, false, true]]);
  });

  test('applied by runs, checks, a user lesson or a fixed lesson; an open gsd lesson is waiting, not applied', () => {
    writeRetro('RETRO-2026-10-25', [{ id: 'cand-1', title: 't', signals: [old.id] }], [old]);
    const past = ra.readPastProposals(project, null);
    const now = ra.signalFacts([{ ...old, id: 'hook-block:3333333333', count: 99 }]);
    const key = 'RETRO-2026-10-25:cand-1';
    const lesson = (layer, status) => new Map([[key, { id: 'lesson-0123456789', layer, status }]]);
    const cases = [
      [{ ...none, runs: new Set([key]) }, true, 'runs', false],
      [{ ...none, checks: new Set([key]) }, true, 'checks', false],
      [{ ...none, lessons: lesson('user', 'open') }, true, 'lessons', false],
      [{ ...none, lessons: lesson('gsd', 'fixed') }, true, 'lessons', false],
      [{ ...none, lessons: lesson('gsd', 'open') }, false, null, false],
      [{ ...none, lessons: lesson('host', 'wontfix') }, false, null, false],
      [none, false, null, true],
    ];
    for (const [applied, isApplied, by, escalate] of cases) {
      const [e] = ra.computeRecurring({ current: now, past, applied }).items;
      assert.deepEqual([e.applied, e.appliedBy, e.escalate], [isApplied, by, escalate], JSON.stringify([...applied.lessons.values()]));
      assert.deepEqual(e.lesson, applied.lessons.get(key) ?? null);
    }
    assert.deepEqual([ra.lessonApplied({ layer: 'user', status: 'open' }), ra.lessonApplied({ layer: 'gsd', status: 'open' }), ra.lessonApplied({ layer: 'host', status: 'fixed' })], [true, false, true]);
  });

  test('not grown never escalates', () => {
    writeRetro('RETRO-2026-10-25', [{ id: 'cand-1', title: 't', signals: [old.id] }], [old]);
    const past = ra.readPastProposals(project, null);
    for (const count of [6, 7]) {
      const [e] = ra.computeRecurring({ current: ra.signalFacts([{ ...old, id: 'hook-block:3333333333', count }]), past, applied: none }).items;
      assert.equal(e.escalate, false, `count ${count} against 7`);
    }
    const [grown] = ra.computeRecurring({ current: ra.signalFacts([{ ...old, id: 'hook-block:3333333333', count: 8 }]), past, applied: none }).items;
    assert.equal(grown.escalate, true, 'count 8 against 7');
  });

  test('other friction does not recur; a retro whose bundle is gone is named, not guessed', () => {
    writeRetro('RETRO-2026-10-20', [{ id: 'cand-1', title: 't', signals: [old.id] }], null);
    writeRetro('RETRO-2026-10-25', [{ id: 'cand-1', title: 't', signals: [old.id] }], [old]);
    const r = ra.computeRecurring({ current: ra.signalFacts([{ ...old, key: 'something else' }]), past: ra.readPastProposals(project, null), applied: none });
    assert.deepEqual([r.items, r.unreadable], [[], ['RETRO-2026-10-20']]);
  });

  test('the current retro is not its own past; at most max entries, newest first: max-1, max, max+1', () => {
    const max = 3;
    for (const n of [max - 1, max, max + 1]) {
      const candidates = Array.from({ length: n }, (_, i) => ({ id: `cand-${i + 1}`, title: 't', signals: [old.id] }));
      writeRetro('RETRO-2026-10-25', candidates, [old]);
      writeRetro('RETRO-2026-10-28', [{ id: 'cand-1', title: 'me', signals: [old.id] }], [old]);
      const r = ra.computeRecurring({ current: ra.signalFacts([old]), past: ra.readPastProposals(project, 'RETRO-2026-10-28'), applied: none, max });
      assert.deepEqual([r.items.length, r.omitted], [Math.min(n, max), Math.max(0, n - max)], `${n} proposals`);
      assert.equal(r.items.every((e) => e.retro === 'RETRO-2026-10-25'), true);
    }
    assert.equal(ra.MAX_RECURRING, 30);
  });

  test('a retro whose bundle is gone is still compared through the signals its run journaled', () => {
    writeRetro('RETRO-2026-10-25', [{ id: 'cand-1', title: 't', signals: [old.id] }], null);
    const journaled = new Map([['RETRO-2026-10-25', ra.signalFacts([old])]]);
    const r = ra.computeRecurring({ current: ra.signalFacts([{ ...old, id: 'hook-block:4444444444', count: 9 }]), past: ra.readPastProposals(project, null, journaled), applied: none });
    assert.deepEqual([r.items.map((e) => [e.countThen, e.countNow, e.escalate]), r.unreadable], [[[7, 9, true]], []]);
    const facts = ra.signalFacts([old, { id: 'user-correction:5555555555', kind: 'user-correction', key: null, count: 1 }]);
    assert.deepEqual(facts.map((f) => [f.id, f.fingerprint === null, f.count]), [[old.id, false, 7], ['user-correction:5555555555', true, 1]]);
    assert.equal(JSON.stringify(facts).includes(old.key), false, 'a fingerprint never carries the key');
  });

  test('a past candidate written before layers is project; with one it keeps it', () => {
    writeRetro('RETRO-2026-10-25', [{ id: 'cand-1', title: 't', signals: [old.id] }, { id: 'cand-2', layer: 'gsd', title: 't', signals: [old.id] }], [old]);
    assert.deepEqual(ra.readPastProposals(project, null).map((p) => p.layer), ['project', 'gsd']);
  });

  test('appliedFromChecks lists the retro candidates checks came from', () => {
    const j = { version: 1, checks: [
      { id: 'a', kind: 'hook', match: 'm', acceptedAt: '2026-10-01', source: { retro: 'RETRO-2026-10-01', candidate: 'cand-2', signal: null } },
      { id: 'b', kind: 'hook', match: 'm', acceptedAt: '2026-10-01', source: { retro: null, candidate: null, signal: null } },
    ] };
    assert.deepEqual([...ra.appliedFromChecks(j)], ['RETRO-2026-10-01:cand-2']);
  });
});
