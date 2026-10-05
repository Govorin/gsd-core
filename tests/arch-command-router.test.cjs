'use strict';

/**
 * Tests for arch-command-router.cjs (built from src/arch-command-router.cts) — `gsd-tools arch`,
 * the CLI steps of `/gsd:arch-survey` (pocock-practices design, D1).
 *
 * The router is driven in-process through its `_output` / `_clock` seams (the architecture
 * capability registers the `arch` family through `commands[]`). Assertions read the typed results each step emits and the typed readers of the files it
 * writes; a written report is checked by size against what the renderer produces, never by content.
 *
 * Pinned here:
 *   - `metrics` writes `metrics-<date>.json`; `--compare-last` compares with the latest earlier
 *     run and applies `architecture.survey_at_milestone` from the project config;
 *   - `stage` (the `milestone:post` command step) measures with `--compare-last` over the
 *     configured scope, always, and answers skip / suggest / auto with the survey as `next`;
 *   - bad flags and paths outside the project are `usage`; a step run before its input exists is
 *     `arch_input_unavailable`;
 *   - the whole flow — metrics, cards, refutation, report, decide — and a rejection excluding the
 *     candidate from the next `cards` run; `report` names the structures the metrics found;
 *   - `decide`: a rejection needs a reason; a re-decision replaces; an unknown id is refused; an
 *     ADR is suggested only for a rejection in a project with an ADR directory.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { routeArchCommand, ADR_DIRECTORY } = require('../gsd-core/bin/lib/arch-command-router.cjs');
const am = require('../gsd-core/bin/lib/arch-metrics.cjs');
const as = require('../gsd-core/bin/lib/arch-survey.cjs');
const { ERROR_REASON } = require('../gsd-core/bin/lib/io.cjs');

const DATE = '2026-10-05';

let root;

function write(rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** Run one `arch` subcommand; returns `{ value }` on output or `{ error, reason }`. */
function arch(args, today = DATE) {
  let result = null;
  routeArchCommand({
    args: ['arch', ...args],
    cwd: root,
    raw: false,
    error: (message, reason) => { result = { error: message, reason }; },
    _output: (value) => { result = { value }; },
    _clock: { localToday: () => today },
  });
  return result;
}

function archDir(...parts) {
  return path.join(root, '.planning', 'architecture', ...parts);
}

beforeEach(() => {
  root = createTempGitProject('gsd-archrouter-');
  write('src/a.ts', "import { b } from './b';\nexport function a(x) { if (x) { return b(x); } return 0; }\n");
  write('src/b.ts', "import { a } from './a';\nexport function b(x) { return x ? a(x - 1) : 0; }\n");
  write('src/c.ts', 'export const c = 1;\n');
  gitOrThrow(['add', '-A'], { cwd: root });
  gitOrThrow(['commit', '-q', '-m', 'code'], { cwd: root });
});
afterEach(() => {
  cleanup(root);
});

describe('arch metrics', () => {
  test('writes metrics-<date>.json and summarises zones', () => {
    const r = arch(['metrics', '--date', DATE, '--json']);
    assert.equal(r.value.path, '.planning/architecture/metrics-2026-10-05.json');
    const saved = am.readMetricsFile(archDir('metrics-2026-10-05.json'));
    assert.notEqual(saved, null);
    assert.deepEqual(r.value.zones, saved.zones);
    assert.deepEqual(saved.cycles.map((c) => c.members), [['src/a.ts', 'src/b.ts']]);
  });

  test(`--top accepts 1 and ${am.MAX_TOP_ZONES}`, () => {
    assert.deepEqual([arch(['metrics', '--top', '1']).value.zones.length, arch(['metrics', '--top', String(am.MAX_TOP_ZONES)]).value.zones.length], [1, 1]);
  });

  test('--paths scopes the run to the named directories', () => {
    write('lib/x.ts', 'export const x = 1;\n');
    const r = arch(['metrics', '--paths', 'lib']);
    assert.deepEqual(r.value.scope.paths, ['lib']);
    assert.equal(r.value.graph.modules, 1);
  });

  test('--compare-last: no earlier run is no baseline; an earlier run is the baseline', () => {
    const first = arch(['metrics', '--date', '2026-09-01', '--compare-last']);
    assert.deepEqual([first.value.comparison.baseline, first.value.milestone.reason], [null, 'no-baseline']);
    write('src/a.ts', `${fs.readFileSync(path.join(root, 'src/a.ts'), 'utf-8')}export function more(y) { if (y) { if (y > 1) { return 2; } } return 1; }\n`);
    gitOrThrow(['commit', '-qam', 'grow a'], { cwd: root });
    const second = arch(['metrics', '--date', DATE, '--compare-last']);
    assert.equal(second.value.comparison.baseline, '2026-09-01');
    assert.deepEqual(second.value.comparison.grown.map((g) => g.file), ['src/a.ts']);
    assert.deepEqual([second.value.milestone.action, second.value.milestone.reason], ['suggest', 'growth']);
  });

  test('--compare-last honours architecture.survey_at_milestone from the project config', () => {
    write('.planning/config.json', JSON.stringify({ architecture: { survey_at_milestone: 'off' } }));
    const r = arch(['metrics', '--compare-last']);
    assert.deepEqual([r.value.milestone.mode, r.value.milestone.action], ['off', 'off']);
  });

  for (const [label, args] of [
    ['a path outside the project', ['--paths', '../elsewhere']],
    ['an unreadable window', ['--since', 'two weeks']],
    ['--top 0', ['--top', '0']],
    [`--top above ${am.MAX_TOP_ZONES}`, ['--top', String(am.MAX_TOP_ZONES + 1)]],
    ['--top without a value', ['--top']],
    ['an impossible date', ['--date', '2026-13-45']],
    ['a repeated flag', ['--since', '30d', '--since', '60d']],
  ]) {
    test(`${label} is a usage error`, () => {
      assert.equal(arch(['metrics', ...args]).reason, ERROR_REASON.USAGE);
    });
  }
});

describe('arch stage (milestone:post)', () => {
  function growA() {
    write('src/a.ts', `${fs.readFileSync(path.join(root, 'src/a.ts'), 'utf-8')}export function more(y) { if (y) { if (y > 1) { return 2; } } return 1; }\n`);
    gitOrThrow(['commit', '-qam', 'grow a'], { cwd: root });
  }

  test('the first run writes metrics and skips: no baseline, nothing to compare', () => {
    const r = arch(['stage', '--milestone', 'v1.0', '--date', '2026-09-01']);
    assert.equal(r.value.path, '.planning/architecture/metrics-2026-09-01.json');
    assert.deepEqual([r.value.milestone.reason, r.value.decision, r.value.next], ['no-baseline', 'skip', null]);
  });

  test('growth under suggest names the survey scoped to the zone directories, and dispatches nothing', () => {
    arch(['stage', '--date', '2026-09-01']);
    growA();
    const r = arch(['stage', '--milestone', 'v1.1', '--date', DATE]);
    assert.equal(r.value.decision, 'suggest');
    assert.deepEqual(r.value.next, { skill: 'arch-survey', args: '--paths src' });
    assert.equal(typeof r.value.message, 'string');
  });

  test('growth under auto dispatches the survey with no message', () => {
    write('.planning/config.json', JSON.stringify({ architecture: { survey_at_milestone: 'auto' } }));
    arch(['stage', '--date', '2026-09-01']);
    growA();
    const r = arch(['stage', '--date', DATE]);
    assert.deepEqual([r.value.decision, r.value.message], ['auto', null]);
    assert.equal(r.value.next.skill, 'arch-survey');
  });

  test('off still measures and skips', () => {
    write('.planning/config.json', JSON.stringify({ architecture: { survey_at_milestone: 'off' } }));
    arch(['stage', '--date', '2026-09-01']);
    growA();
    const r = arch(['stage', '--date', DATE]);
    assert.equal(r.value.path, '.planning/architecture/metrics-2026-10-05.json');
    assert.deepEqual([r.value.milestone.action, r.value.decision], ['off', 'skip']);
  });

  test('--raw (how a loop point runs it) prints the stage answer as JSON', () => {
    let rawText = null;
    routeArchCommand({
      args: ['arch', 'stage', '--date', DATE],
      cwd: root,
      raw: true,
      error: (message) => { throw new Error(message); },
      _output: (_value, _raw, text) => { rawText = text; },
      _clock: { localToday: () => DATE },
    });
    assert.deepEqual(Object.keys(JSON.parse(rawText)).filter((k) => ['decision', 'message', 'next'].includes(k)), ['decision', 'message', 'next']);
  });

  test('the user flags of metrics do not reach the stage', () => {
    const r = arch(['stage', '--paths', '../elsewhere', '--top', '0']);
    assert.equal(r.value.decision, 'skip');
    assert.deepEqual(r.value.scope, arch(['metrics']).value.scope, 'the configured scope, not --paths');
  });
});

describe('milestoneStageAnswer', () => {
  const zone = (id, label) => ({ id, label, seed: `${label}/x.ts`, score: 1, files: [], signals: {} });
  test('a zone at the root runs the survey unscoped; labels are deduplicated and sorted', () => {
    const d = { mode: 'auto', action: 'auto', reason: 'growth', zones: ['z1', 'z2', 'z3'] };
    assert.equal(am.milestoneStageAnswer(d, [zone('z1', 'src/b'), zone('z2', 'src/a'), zone('z3', 'src/a')]).next.args, '--paths src/a,src/b');
    assert.equal(am.milestoneStageAnswer(d, [zone('z1', '.'), zone('z2', 'src')]).next.args, '');
  });
  test('none and off are skip', () => {
    for (const action of ['none', 'off']) {
      assert.deepEqual(am.milestoneStageAnswer({ mode: 'suggest', action, reason: 'no-growth', zones: [] }, []), { decision: 'skip', message: null, next: null });
    }
  });
});

describe('arch steps out of order', () => {
  test('cards, report and decide before their inputs exist are arch_input_unavailable', () => {
    assert.equal(arch(['cards']).reason, ERROR_REASON.ARCH_INPUT_UNAVAILABLE);
    arch(['metrics']);
    assert.equal(arch(['report']).reason, ERROR_REASON.ARCH_INPUT_UNAVAILABLE);
    assert.equal(arch(['decide', '--id', 'arch-0123456789ab', '--disposition', 'deferred']).reason, ERROR_REASON.ARCH_INPUT_UNAVAILABLE);
  });

  test('an unknown subcommand is refused', () => {
    assert.notEqual(arch(['survey']).error, undefined);
  });
});

describe('arch survey flow', () => {
  function cards(doc) {
    write(`.planning/architecture/survey-${DATE}/cards-z1.json`, JSON.stringify(doc));
  }
  const cycleCard = {
    title: 'Fold b into a', kind: 'cycle', files: ['src/a.ts', 'src/b.ts'], problem: 'a and b import each other.',
    solution: 'One module.', benefits: 'Locality.', strength: 'strong',
    deletionTest: { result: 'concentrates', evidence: 'b has no caller but a' },
  };
  const constCard = {
    title: 'Inline c', kind: 'pass-through', files: ['src/c.ts'], problem: 'c is one constant.',
    solution: 'Inline it.', benefits: 'One file less.', strength: 'speculative',
  };

  test('metrics → cards → refutation → report → decide, and a rejection excludes the next time', () => {
    arch(['metrics']);
    cards({ zone: 'z1', verdict: 'candidates', cards: [cycleCard, constCard] });

    const c = arch(['cards']).value;
    assert.deepEqual(c.candidates.map((x) => [x.n, x.title, x.strength]), [[1, 'Fold b into a', 'strong'], [2, 'Inline c', 'speculative']]);
    const set = JSON.parse(fs.readFileSync(path.join(root, c.candidatesPath), 'utf-8'));
    assert.equal(fs.statSync(path.join(root, c.refuterInputPath)).size, Buffer.byteLength(as.renderRefuterInput(set)));

    write(`.planning/architecture/survey-${DATE}/refutation.md`, [
      '## REFUTATION COMPLETE', '', 'upheld: 1', 'refuted: 1', '',
      '### Finding 1: Fold b into a', 'verdict: UPHELD', 'evidence: src/b.ts:1 imports ./a; nothing else imports b', '',
      '### Finding 2: Inline c', 'verdict: REFUTED', 'evidence: c is the documented extension point', '',
    ].join('\n'));
    const r = arch(['report']).value;
    assert.deepEqual([r.verdict, r.top], ['candidates', c.candidates[0].id]);
    assert.deepEqual(r.candidates.map((x) => x.verification), ['upheld', 'refuted']);
    const metrics = am.readMetricsFile(archDir(`metrics-${DATE}.json`));
    const refutation = fs.readFileSync(archDir(`survey-${DATE}`, 'refutation.md'), 'utf-8');
    const doc = as.buildSurvey({ metrics, set, verification: as.verifyCandidates(set, refutation) });
    assert.equal(fs.statSync(path.join(root, r.path)).size, Buffer.byteLength(as.renderSurvey(doc)));
    // The a ⇄ b cycle is reported from the metrics whether or not a surveyor carded it.
    assert.deepEqual(r.foundByMetrics.cycles, [['src/a.ts', 'src/b.ts']]);
    assert.deepEqual(r.foundByMetrics.passThrough, metrics.passThrough.map((p) => p.file));
    assert.deepEqual(r.foundByMetrics.smallClusters, metrics.smallClusters.map((c) => c.dir));

    const d = arch(['decide', '--id', c.candidates[1].id, '--disposition', 'rejected', '--reason', 'extension point']).value;
    assert.deepEqual([d.disposition, d.replaced, d.adrSuggested], ['rejected', null, false]);
    const again = arch(['cards']).value;
    assert.deepEqual(again.candidates.map((x) => x.title), ['Fold b into a']);
    assert.deepEqual(again.excludedByDecision.map((x) => x.id), [c.candidates[1].id]);

    const s = arch(['status']).value;
    assert.deepEqual([s.metrics.latest, s.survey.latest, s.decisions.rejected], [DATE, DATE, 1]);
  });

  test('decide: a rejection needs a reason; a re-decision replaces; an ADR is suggested only with an ADR directory', () => {
    arch(['metrics']);
    cards({ cards: [cycleCard] });
    const id = arch(['cards']).value.candidates[0].id;
    assert.equal(arch(['decide', '--id', id, '--disposition', 'rejected']).reason, ERROR_REASON.USAGE);
    assert.equal(arch(['decide', '--id', id, '--disposition', 'maybe']).reason, ERROR_REASON.USAGE);
    assert.equal(arch(['decide', '--id', 'arch-1', '--disposition', 'deferred']).reason, ERROR_REASON.USAGE);

    assert.equal(arch(['decide', '--id', id, '--disposition', 'deferred']).value.replaced, null);
    fs.mkdirSync(path.join(root, ADR_DIRECTORY), { recursive: true });
    const second = arch(['decide', '--id', id, '--disposition', 'rejected', '--reason', 'cycle is the plugin seam'], '2026-10-06').value;
    assert.deepEqual([second.replaced, second.adrSuggested], ['deferred', true]);
    const { entries } = as.parseDecisions(fs.readFileSync(archDir('DECISIONS.md'), 'utf-8'));
    assert.deepEqual(entries.map((e) => [e.id, e.disposition, e.date, e.survey]), [[id, 'rejected', '2026-10-06', DATE]]);
  });

  test('report without a refutation marks every candidate unverified', () => {
    arch(['metrics']);
    cards({ cards: [cycleCard] });
    arch(['cards']);
    const r = arch(['report']).value;
    assert.deepEqual([r.refutation, r.candidates[0].verification], [null, 'unverified']);
    assert.deepEqual(r.foundByMetrics.cycles, [['src/a.ts', 'src/b.ts']]);
    assert.equal(arch(['report', '--refutation', '../outside.md']).reason, ERROR_REASON.USAGE);
    assert.equal(arch(['report', '--refutation', 'missing.md']).reason, ERROR_REASON.ARCH_INPUT_UNAVAILABLE);
  });
});
