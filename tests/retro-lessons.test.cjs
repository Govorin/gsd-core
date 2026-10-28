'use strict';

/**
 * src/retro-lessons.cts — the cross-repository lessons journal of the retro
 * capability (ADR-5209 §10): `${GSD_HOME}/.gsd/lessons/LESSONS.json`.
 *
 * Every journal here lives under a temp GSD_HOME passed explicitly; nothing
 * reads or writes the real ~/.gsd. Assertions are on typed fields (status,
 * reason, outcome), never on message text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');

const rl = require('../gsd-core/bin/lib/retro-lessons.cjs');

const NOW = new Date('2026-10-28T12:00:00.000Z');

let home;
beforeEach(() => { home = createTempDir('gsd-retro-lessons-home-'); });
afterEach(() => { cleanup(home); });

function occurrence(over = {}) {
  return {
    project: '~/work/alpha',
    retro: 'RETRO-2026-10-28',
    candidate: 'cand-1',
    date: '2026-10-28',
    signals: ['repeated-tool-error:617f086244'],
    gsdVersion: '1.18.0',
    hostVersion: '2.1.310',
    ...over,
  };
}

function input(over = {}) {
  return {
    layer: 'gsd',
    target: 'gsd-core/references/gsd-run-resolver.md',
    title: 'The gsd_run loader is refused in an isolated worktree',
    change: 'Resolve gsd-tools with literal paths instead of computed ones.',
    cited: [],
    occurrence: occurrence(),
    ...over,
  };
}

/** One record through the journal edit, under a lock that is always free. */
const freeLock = { acquire: () => ({}), release: () => {} };
function record(inp, opts = {}) {
  return rl.editLessons((j) => rl.recordLesson(j, inp, opts.now ?? NOW), { gsdHome: home, lock: opts.lock ?? freeLock });
}
const journalFile = () => rl.lessonsJournalPath(home);

describe('lessons journal location', () => {
  test('the journal sits under the GSD_HOME it is given, in .gsd/lessons', () => {
    assert.equal(journalFile(), path.join(home, '.gsd', 'lessons', 'LESSONS.json'));
    assert.equal(rl.lessonsLockPath(home), path.join(home, '.gsd', 'lessons', '.LESSONS.lock'));
    assert.equal(rl.lessonDraftPath('lesson-0123456789', home), path.join(home, '.gsd', 'lessons', 'drafts', 'lesson-0123456789.md'));
  });

  test('absent is an empty, readable journal', () => {
    const r = rl.readLessonsJournal(home);
    assert.deepEqual([r.status, r.reason, r.journal.lessons], ['absent', null, []]);
  });
});

describe('lessons journal: fail closed', () => {
  const write = (text) => {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    fs.writeFileSync(journalFile(), text);
  };

  test('not JSON, the wrong envelope, or one malformed lesson: invalid with reason lessons-invalid', () => {
    const good = JSON.parse(rl.formatLessonsJournal(rl.recordLesson({ version: 1, lessons: [] }, input(), NOW).journal));
    const broken = { ...good, lessons: [{ ...good.lessons[0], status: 'maybe' }] };
    for (const text of ['{not json', '{"version":2,"lessons":[]}', '[]', JSON.stringify(broken)]) {
      write(text);
      const r = rl.readLessonsJournal(home);
      assert.deepEqual([r.status, r.reason, r.journal.lessons.length], ['invalid', rl.LESSONS_INVALID, 0], text.slice(0, 20));
      assert.ok(r.problems.length > 0);
    }
  });

  test('a record against an invalid journal writes nothing and says lessons-invalid', () => {
    write('{not json');
    const w = record(input());
    assert.deepEqual([w.ok, w.reason], [false, rl.LESSONS_INVALID]);
    assert.equal(fs.readFileSync(journalFile(), 'utf8'), '{not json');
    assert.equal(fs.existsSync(path.dirname(rl.lessonDraftPath('x', home))), false);
  });

  test('a duplicate lesson id is malformed', () => {
    const j = rl.recordLesson({ version: 1, lessons: [] }, input(), NOW).journal;
    write(JSON.stringify({ version: 1, lessons: [j.lessons[0], j.lessons[0]] }));
    assert.equal(rl.readLessonsJournal(home).reason, rl.LESSONS_INVALID);
  });
});

describe('lessons journal: the lock', () => {
  test('the edit acquires .LESSONS.lock; a lock that cannot be had writes nothing', () => {
    const calls = [];
    const busy = { acquire: (p) => { calls.push(path.basename(p)); return null; }, release: () => calls.push('release') };
    const w = record(input(), { lock: busy });
    assert.deepEqual([w.ok, w.reason], [false, 'locked']);
    assert.deepEqual(calls, ['.LESSONS.lock']);
    assert.equal(fs.existsSync(journalFile()), false);
  });

  test('a held lock is released after the write', () => {
    const calls = [];
    const lock = { acquire: () => { calls.push('acquire'); return { h: 1 }; }, release: () => calls.push('release') };
    assert.equal(record(input(), { lock }).ok, true);
    assert.deepEqual(calls, ['acquire', 'release']);
  });

  test('the real lock serialises two edits: both occurrences survive', () => {
    assert.equal(rl.editLessons((j) => rl.recordLesson(j, input(), NOW), { gsdHome: home }).ok, true);
    const second = rl.editLessons((j) => rl.recordLesson(j, input({ occurrence: occurrence({ project: '~/work/beta' }) }), NOW), { gsdHome: home });
    assert.deepEqual([second.ok, second.outcome], [true, rl.RECORD_OUTCOME.APPENDED]);
    assert.equal(rl.readLessonsJournal(home).journal.lessons[0].occurrences.length, 2);
  });
});

describe('recordLesson: identity and dedup', () => {
  test('the same layer, target and title is one lesson, whatever the case, spacing or #anchor', () => {
    const a = rl.lessonId('gsd', 'gsd-core/references/gsd-run-resolver.md', 'Loader refused');
    assert.equal(rl.lessonId('gsd', '  gsd-core/references/GSD-run-resolver.md#loader ', 'loader   REFUSED'), a);
    assert.notEqual(rl.lessonId('user', 'gsd-core/references/gsd-run-resolver.md', 'Loader refused'), a);
    assert.match(a, /^lesson-[0-9a-f]{10}$/);
  });

  test('a host lesson is the same lesson on the next runtime version, whatever the spacing around the colon', () => {
    const a = rl.lessonId('host', 'claude@2.1.310: worktree isolation', 't');
    for (const t of ['claude@2.1.400: worktree isolation', 'claude : worktree isolation', 'Claude@2.1.310 :  worktree isolation', 'claude:worktree isolation']) {
      assert.equal(rl.lessonId('host', t, 't'), a, t);
    }
    assert.notEqual(rl.lessonId('host', 'claude: permissions', 't'), a);
  });

  test('created, then appended from another project, then a repeat of the same occurrence is a duplicate', () => {
    const first = record(input());
    assert.deepEqual([first.ok, first.outcome, first.lesson.status], [true, 'created', 'open']);
    const second = record(input({ occurrence: occurrence({ project: '~/work/beta', retro: 'RETRO-2026-10-29' }) }));
    assert.equal(second.outcome, 'appended');
    const before = fs.readFileSync(journalFile(), 'utf8');
    const again = record(input({ occurrence: occurrence({ project: '~/work/beta', retro: 'RETRO-2026-10-29' }) }));
    assert.equal(again.outcome, 'duplicate');
    assert.equal(fs.readFileSync(journalFile(), 'utf8'), before, 'a duplicate rewrites nothing');
    const [lesson] = rl.readLessonsJournal(home).journal.lessons;
    assert.deepEqual([lesson.occurrences.length, rl.projectCount(lesson)], [2, 2]);
  });

  test('a cited lesson of another layer does not take the occurrence', () => {
    const g = record(input());
    const u = record(input({ layer: 'user', target: '~/.claude/settings.json', title: 'stopgap', cited: [g.lesson.id], occurrence: occurrence({ retro: 'RETRO-2026-10-30' }) }));
    assert.deepEqual([u.outcome, u.lesson.layer, u.lesson.id === g.lesson.id], ['created', 'user', false]);
  });

  test('a candidate citing lesson:<id> adds to that lesson even with other words', () => {
    const first = record(input());
    const other = record(input({ title: 'Worded differently', target: 'gsd-core/workflows/execute-phase.md', cited: ['lesson-ffffffffff', first.lesson.id], occurrence: occurrence({ retro: 'RETRO-2026-10-30' }) }));
    assert.deepEqual([other.outcome, other.lesson.id], ['appended', first.lesson.id]);
    assert.equal(rl.readLessonsJournal(home).journal.lessons.length, 1);
  });

  test('signals per occurrence: at the limit kept, past it cut to the limit', () => {
    const ids = (n) => Array.from({ length: n }, (_, i) => `hook-block:${String(i).padStart(10, '0')}`);
    for (const [n, kept] of [[rl.MAX_OCCURRENCE_SIGNALS - 1, rl.MAX_OCCURRENCE_SIGNALS - 1], [rl.MAX_OCCURRENCE_SIGNALS, rl.MAX_OCCURRENCE_SIGNALS], [rl.MAX_OCCURRENCE_SIGNALS + 1, rl.MAX_OCCURRENCE_SIGNALS]]) {
      const r = rl.recordLesson({ version: 1, lessons: [] }, input({ occurrence: occurrence({ signals: ids(n) }) }), NOW);
      assert.equal(r.lesson.occurrences[0].signals.length, kept, `${n} signals`);
    }
  });

  test('a journal whose occurrence holds more than the limit is malformed', () => {
    const r = rl.recordLesson({ version: 1, lessons: [] }, input(), NOW);
    const lesson = r.journal.lessons[0];
    const over = { ...lesson, occurrences: [{ ...lesson.occurrences[0], signals: Array.from({ length: rl.MAX_OCCURRENCE_SIGNALS + 1 }, (_, i) => `hook-block:${String(i).padStart(10, '0')}`) }] };
    assert.equal(rl.lessonProblems(over).length, 1);
    const at = { ...lesson, occurrences: [{ ...lesson.occurrences[0], signals: Array.from({ length: rl.MAX_OCCURRENCE_SIGNALS }, (_, i) => `hook-block:${String(i).padStart(10, '0')}`) }] };
    assert.deepEqual(rl.lessonProblems(at), []);
  });

  test('an occurrence with transcript-shaped text in signals is refused', () => {
    const r = rl.recordLesson({ version: 1, lessons: [] }, input({ occurrence: occurrence({ signals: ['the user said: do not touch'] }) }), NOW);
    assert.equal(r.ok, false);
  });
});

describe('recordLesson: regressions', () => {
  function fixedLesson(layer, fixedIn) {
    const created = rl.recordLesson({ version: 1, lessons: [] }, input(layer === 'host' ? { layer, target: 'claude@2.1.310: worktree isolation' } : { layer }), NOW);
    return rl.closeLesson(created.journal, created.lesson.id, 'fixed', fixedIn, NOW).journal;
  }
  const recur = (journal, layer, versions) => rl.recordLesson(journal, input({
    layer,
    ...(layer === 'host' ? { target: 'claude@2.1.310: worktree isolation' } : {}),
    occurrence: occurrence({ retro: 'RETRO-2026-11-02', ...versions }),
  }), NOW);

  test('gsd: recurring at the fixed version or later reopens; before it stays fixed', () => {
    const j = fixedLesson('gsd', '1.19.0');
    for (const [v, outcome, status] of [['1.18.9', 'before-fix', 'fixed'], ['1.19.0', 'regression', 'open'], ['1.19.1', 'regression', 'open']]) {
      const r = recur(j, 'gsd', { gsdVersion: v });
      assert.deepEqual([r.outcome, r.lesson.status], [outcome, status], v);
      if (status === 'open') assert.equal(r.lesson.regressions, 1);
    }
  });

  test('host: measured against the runtime version, not GSD', () => {
    const j = fixedLesson('host', '2.1.400');
    assert.equal(recur(j, 'host', { hostVersion: '2.1.399', gsdVersion: '9.9.9' }).outcome, 'before-fix');
    assert.equal(recur(j, 'host', { hostVersion: '2.1.400', gsdVersion: '0.0.1' }).outcome, 'regression');
  });

  test('an unknown version cannot show the fix applies: a recurrence reopens', () => {
    const j = fixedLesson('gsd', '1.19.0');
    assert.equal(recur(j, 'gsd', { gsdVersion: null }).outcome, 'regression');
    const noFixedIn = fixedLesson('gsd', null);
    assert.equal(recur(noFixedIn, 'gsd', { gsdVersion: '1.0.0' }).outcome, 'regression');
  });

  test('user: any recurrence after the fix is a regression', () => {
    const j = fixedLesson('user', null);
    assert.equal(recur(j, 'user', {}).outcome, 'regression');
  });

  test('wontfix keeps its status and takes the occurrence', () => {
    const created = rl.recordLesson({ version: 1, lessons: [] }, input(), NOW);
    const j = rl.closeLesson(created.journal, created.lesson.id, 'wontfix', null, NOW).journal;
    const r = recur(j, 'gsd', {});
    assert.deepEqual([r.outcome, r.lesson.status, r.lesson.occurrences.length], ['appended', 'wontfix', 2]);
  });
});

describe('closeLesson', () => {
  test('fixed takes an optional version; wontfix none; unknown id refused', () => {
    const { journal, lesson } = rl.recordLesson({ version: 1, lessons: [] }, input(), NOW);
    const fixed = rl.closeLesson(journal, lesson.id, 'fixed', '1.19.0', NOW);
    assert.deepEqual([fixed.ok, fixed.lesson.status, fixed.lesson.fixedIn], [true, 'fixed', '1.19.0']);
    assert.equal(rl.closeLesson(journal, lesson.id, 'fixed', 'soon', NOW).ok, false);
    assert.equal(rl.closeLesson(journal, lesson.id, 'wontfix', '1.19.0', NOW).ok, false);
    assert.equal(rl.closeLesson(journal, 'lesson-0000000000', 'fixed', null, NOW).ok, false);
  });
});

describe('drafts', () => {
  test('a draft that cannot be written leaves the journal unchanged and says draft-unwritable', () => {
    // A file where the drafts directory should be: the draft write fails.
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(journalFile()), 'drafts'), 'not a directory');
    const w = record(input());
    assert.deepEqual([w.ok, w.reason], [false, 'draft-unwritable']);
    assert.equal(fs.existsSync(journalFile()), false);
  });

  test('a gsd lesson gets an issue draft file; a user lesson none', () => {
    const g = record(input());
    assert.equal(g.draft, rl.lessonDraftPath(g.lesson.id, home));
    assert.equal(fs.readFileSync(g.draft, 'utf8'), g.lesson.draft);
    const u = record(input({ layer: 'user', target: '~/.claude/settings.json', title: 'SubagentStart hook' }));
    assert.deepEqual([u.draft, u.lesson.draft], [null, null]);
  });

  test('the draft numbers projects, never names them, in the evidence', () => {
    let j = rl.recordLesson({ version: 1, lessons: [] }, input({ occurrence: occurrence({ project: '~/IdeaProjects/secret-client' }) }), NOW).journal;
    const r = rl.recordLesson(j, input({ occurrence: occurrence({ project: '~/work/other', retro: 'RETRO-2026-10-29' }) }), NOW);
    const evidence = r.lesson.draft.split('\n').filter((l) => l.startsWith('- 2026'));
    assert.deepEqual(evidence, [
      '- 2026-10-28 · project 1 · RETRO-2026-10-28 cand-1 · signals: repeated-tool-error:617f086244',
      '- 2026-10-28 · project 2 · RETRO-2026-10-29 cand-1 · signals: repeated-tool-error:617f086244',
    ]);
  });

  test('title, target and change are masked in the draft: paths, the project path and its name', () => {
    const r = rl.recordLesson({ version: 1, lessons: [] }, input({
      title: 'secret-client loses its worktree in ~/IdeaProjects/secret-client',
      change: 'In secret-client run /Users/me/IdeaProjects/secret-client/bin/x instead; see ~/notes.md.',
      occurrence: occurrence({ project: '~/IdeaProjects/secret-client' }),
    }), NOW);
    const d = r.lesson.draft;
    assert.equal(d.split('\n')[0], '# <project> loses its worktree in <project>');
    const proposal = d.split('\n## Proposal\n\n')[1].split('\n')[0];
    assert.equal(proposal, 'In <project> run <path> instead; see <path>');
    assert.deepEqual(['secret-client', '/Users/', '~/'].filter((x) => d.includes(x)), []);
    assert.equal(rl.maskForDraft('the mn repo, not column', ['~/IdeaProjects/mn']), 'the <project> repo, not column');
  });
});

describe('bundleLessons', () => {
  function journalOf(n) {
    let j = { version: 1, lessons: [] };
    for (let i = 0; i < n; i++) j = rl.recordLesson(j, input({ title: `lesson ${i}` }), NOW).journal;
    return { status: 'ok', reason: null, journal: j, problems: [] };
  }

  test('at most max lessons, the rest counted as omitted: max-1, max, max+1', () => {
    const max = 4;
    for (const [n, kept, omitted] of [[max - 1, max - 1, 0], [max, max, 0], [max + 1, max, 1]]) {
      const b = rl.bundleLessons(journalOf(n), max);
      assert.deepEqual([b.items.length, b.omitted], [kept, omitted], `${n} lessons`);
    }
    assert.equal(rl.MAX_BUNDLE_LESSONS, 50);
  });

  test('open first, then by projects; an invalid journal gives none and its reason', () => {
    let j = rl.recordLesson({ version: 1, lessons: [] }, input({ title: 'fixed one' }), NOW).journal;
    const fixedId = j.lessons[0].id;
    j = rl.closeLesson(j, fixedId, 'fixed', null, NOW).journal;
    j = rl.recordLesson(j, input({ title: 'open one' }), NOW).journal;
    const b = rl.bundleLessons({ status: 'ok', reason: null, journal: j, problems: [] });
    assert.deepEqual(b.items.map((l) => l.status), ['open', 'fixed']);
    assert.deepEqual(Object.keys(b.items[0]).sort(), ['fixedIn', 'id', 'layer', 'occurrences', 'projects', 'status', 'target', 'title']);
    const bad = rl.bundleLessons({ status: 'invalid', reason: rl.LESSONS_INVALID, journal: { version: 1, lessons: [] }, problems: ['x'] });
    assert.deepEqual([bad.status, bad.reason, bad.items], ['invalid', rl.LESSONS_INVALID, []]);
  });

  test('lessonsByCandidate maps stem:cand of one project only to its lesson', () => {
    let j = rl.recordLesson({ version: 1, lessons: [] }, input(), NOW).journal;
    j = rl.recordLesson(j, input({ occurrence: occurrence({ project: '~/work/beta', candidate: 'cand-2' }) }), NOW).journal;
    const m = rl.lessonsByCandidate(j, '~/work/alpha');
    assert.deepEqual([...m.entries()], [['RETRO-2026-10-28:cand-1', { id: j.lessons[0].id, status: 'open', layer: 'gsd' }]]);
  });
});

describe('compareVersions', () => {
  test('major.minor.patch numerically; a prerelease below its release; null without one', () => {
    assert.equal(rl.compareVersions('1.10.0', '1.9.9'), 1);
    assert.equal(rl.compareVersions('2.1.310', '2.1.310'), 0);
    assert.equal(rl.compareVersions('v1.2.3', '1.2.4'), -1);
    assert.equal(rl.compareVersions('1.19.0-rc.1', '1.19.0'), -1);
    assert.equal(rl.compareVersions('1.19.0', '1.19.0-rc.1'), 1);
    assert.equal(rl.compareVersions('1.19.0-rc.1', '1.19.0-rc.2'), -1);
    assert.equal(rl.compareVersions('1.19.0+build.7', '1.19.0'), 0);
    assert.equal(rl.compareVersions('soon', '1.0.0'), null);
  });

  test('a fix in 1.19.0 recurring on 1.19.0-rc.1 is before the fix', () => {
    const created = rl.recordLesson({ version: 1, lessons: [] }, input(), NOW);
    const j = rl.closeLesson(created.journal, created.lesson.id, 'fixed', '1.19.0', NOW).journal;
    assert.equal(rl.recordLesson(j, input({ occurrence: occurrence({ retro: 'RETRO-2026-11-01', gsdVersion: '1.19.0-rc.1' }) }), NOW).outcome, 'before-fix');
  });
});

describe('where the retro runs', () => {
  test('foldHome folds the home directory to ~ and leaves other paths', () => {
    assert.equal(rl.foldHome(path.join(home, 'a', 'b'), home), '~/a/b');
    assert.equal(rl.foldHome(home, home), '~');
    assert.equal(rl.foldHome(`${home}-other/x`, home), `${home}-other/x`.split(path.sep).join('/'));
  });

  test('a linked worktree counts as its main repository', (t) => {
    const repo = createTempGitProject('gsd-retro-lessons-repo-');
    const wtParent = createTempDir('gsd-retro-lessons-wt-');
    t.after(() => { cleanup(wtParent); cleanup(repo); });
    const wt = path.join(wtParent, 'wt');
    const add = runGit(['worktree', 'add', '-q', wt], { cwd: repo });
    assert.deepEqual([add.outcome, add.exitCode], [OUTCOME.EXITED, 0], add.stderr);
    assert.equal(rl.projectKey(wt, '/nonexistent-home'), fs.realpathSync(repo).split(path.sep).join('/'));
    assert.equal(rl.projectKey(repo, '/nonexistent-home'), fs.realpathSync(repo).split(path.sep).join('/'));
  });

  test('the GSD install is the directory holding gsd-core/, with its VERSION', (t) => {
    const root = createTempDir('gsd-retro-install-');
    const elsewhere = createTempDir('gsd-retro-noinstall-');
    t.after(() => { cleanup(root); cleanup(elsewhere); });
    const lib = path.join(root, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(root, 'gsd-core', 'VERSION'), '1.18.0\n');
    assert.deepEqual(rl.resolveGsdInstall(lib), { root, version: '1.18.0' });
    assert.deepEqual(rl.resolveGsdInstall(path.join(elsewhere, 'a', 'b', 'c')), { root: null, version: null });
  });

  test('this checkout resolves to itself', () => {
    const self = rl.resolveGsdInstall();
    assert.equal(self.root, path.resolve(__dirname, '..'));
    assert.equal(fs.existsSync(path.join(self.root, 'agents', 'gsd-retro-analyst.md')), true);
  });
});
