'use strict';

/**
 * Unit tests for arch-metrics.cjs (built from src/arch-metrics.cts) — the deterministic half of
 * `/gsd:arch-survey` (pocock-practices design, D1 acceptance).
 *
 * The properties pinned here:
 *   - `small_module_loc` is inclusive and exact at N-1 / N / N+1;
 *   - a pass-through is one production importer, one import and small — a test importer does not
 *     count, a second importer or one line too many disqualifies;
 *   - test files are never module rows, signals or zone members, but are counted as `testFanIn`;
 *   - a cycle through `import type` only is marked as not a runtime cycle;
 *   - hot spots are churn × complexity; a window without commits falls back to complexity and
 *     says so (`degraded`, `hotspot-basis:complexity`) instead of reporting no hot spots;
 *   - co-change pairs carry whether an import links them;
 *   - zones: at most `topZones`, disjoint, seeded by the hottest module, capped at `zoneMaxFiles`
 *     (boundary at cap-1 / cap / cap+1 neighbours);
 *   - the comparison threshold is strict (growth exactly at the threshold is not growth), and the
 *     milestone decision proposes a survey only on a real signal;
 *   - the baseline is the latest earlier run over the same scope, window and basis;
 *   - the output shape (keys and types) is fixed.
 *
 * Fixtures are real files and commits in temp git projects; assertions read the typed metrics.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const am = require('../gsd-core/bin/lib/arch-metrics.cjs');

const DATE = '2026-10-05';

let root;
let serial = 0;

function write(rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A module of exactly `loc` non-blank lines, optionally importing `imports`. */
function moduleOf(loc, imports = []) {
  const lines = imports.map((target, i) => `import { v as i${i} } from '${target}';`);
  while (lines.length < loc - 1) lines.push(`export const x${lines.length} = ${lines.length};`);
  lines.push('export const v = 1;');
  return `${lines.join('\n')}\n`;
}

function git(args, env = {}) {
  return gitOrThrow(args, { cwd: root, env: { ...process.env, ...env } }).trim();
}

/** One commit touching every file in `files` (a comment line appended, so every change is real). */
function commit(files) {
  for (const rel of files) fs.appendFileSync(path.join(root, rel), `// change ${++serial}\n`);
  git(['add', '-A']);
  git(['commit', '-q', '-m', `change ${serial}`]);
}

function metrics(config = {}, extra = {}) {
  return am.computeMetrics(root, { date: DATE, config, ...extra });
}

function row(m, file) {
  return m.modules.find((r) => r.file === file);
}

beforeEach(() => {
  root = createTempGitProject('gsd-archmetrics-');
});
afterEach(() => {
  cleanup(root);
});

describe('arch-metrics: config', () => {
  test('absent keys resolve to the defaults with no problems', () => {
    const r = am.resolveArchConfig(null);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.config, {
      window: '90d', topZones: 5, smallModuleLoc: 40, cochangeMinSupport: 3,
      cochangeMinConfidence: 0.6, growthThreshold: 0.25, atMilestone: 'suggest',
    });
  });

  test('nested and dotted keys are read', () => {
    const r = am.resolveArchConfig({
      architecture: { survey_window: '30d', small_module_loc: 25 },
      'architecture.survey_at_milestone': 'auto',
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.config.window, '30d');
    assert.equal(r.config.smallModuleLoc, 25);
    assert.equal(r.config.atMilestone, 'auto');
  });

  test(`survey_top_zones is bounded: 1 and ${am.MAX_TOP_ZONES} accepted, ${am.MAX_TOP_ZONES + 1} refused`, () => {
    assert.equal(am.resolveArchConfig({ 'architecture.survey_top_zones': 1 }).config.topZones, 1);
    assert.equal(am.resolveArchConfig({ 'architecture.survey_top_zones': am.MAX_TOP_ZONES }).config.topZones, am.MAX_TOP_ZONES);
    const over = am.resolveArchConfig({ 'architecture.survey_top_zones': am.MAX_TOP_ZONES + 1 });
    assert.deepEqual([over.config.topZones, over.problems.length], [am.DEFAULTS.topZones, 1]);
  });

  test('a bad value falls back to its default and is named, one problem per key', () => {
    const r = am.resolveArchConfig({
      architecture: {
        survey_window: 'two weeks', survey_top_zones: 0, cochange_min_confidence: 1.5,
        survey_growth_threshold: -1, survey_at_milestone: 'always', cochange_min_support: 2.5,
      },
    });
    assert.equal(r.problems.length, 6);
    assert.deepEqual(r.config, am.resolveArchConfig(null).config);
  });
});

describe('arch-metrics: module size, pass-through, tests', () => {
  test('small_module_loc is inclusive: N-1 and N are small, N+1 is not', () => {
    const N = 6;
    write('src/below.ts', moduleOf(N - 1));
    write('src/at.ts', moduleOf(N));
    write('src/above.ts', moduleOf(N + 1));
    const m = metrics({ smallModuleLoc: N });
    assert.deepEqual(['src/below.ts', 'src/at.ts', 'src/above.ts'].map((f) => [row(m, f).loc, row(m, f).small]), [
      [N - 1, true], [N, true], [N + 1, false],
    ]);
    assert.deepEqual(m.smallModules, ['src/at.ts', 'src/below.ts']);
  });

  test('a pass-through has one production importer, one import, and is small', () => {
    const N = 5;
    write('src/a.ts', moduleOf(N + 5, ['./p', './q', './big']));
    write('src/b.ts', moduleOf(N + 5, ['./q']));
    write('src/p.ts', moduleOf(N, ['./t'])); // pass-through
    write('src/q.ts', moduleOf(N, ['./t'])); // two importers
    write('src/big.ts', moduleOf(N + 1, ['./t'])); // one line too many
    write('src/t.ts', moduleOf(N + 5));
    write('src/p.test.ts', moduleOf(3, ['./p'])); // a test importer is not an importer
    const m = metrics({ smallModuleLoc: N });
    assert.deepEqual(m.passThrough, [{ file: 'src/p.ts', importer: 'src/a.ts', target: 'src/t.ts', loc: N }]);
    assert.deepEqual([row(m, 'src/p.ts').fanIn, row(m, 'src/p.ts').testFanIn], [1, 1]);
  });

  test('test files are never rows, but are counted as test importers', () => {
    write('src/lib.ts', moduleOf(3));
    write('src/lib.spec.ts', moduleOf(3, ['./lib']));
    write('tests/lib-check.ts', moduleOf(3, ['../src/lib']));
    write('src/__tests__/deep.ts', moduleOf(3, ['../lib']));
    const m = metrics();
    assert.deepEqual(m.modules.map((r) => r.file), ['src/lib.ts']);
    assert.equal(row(m, 'src/lib.ts').testFanIn, 3);
    assert.equal(row(m, 'src/lib.ts').fanIn, 0);
    assert.equal(m.graph.testModules, 3);
  });
});

describe('arch-metrics: cycles', () => {
  test('a runtime cycle and a cycle through `import type` only are told apart', () => {
    write('src/a.ts', "import { b } from './b';\nexport const a = () => b;\n");
    write('src/b.ts', "import { a } from './a';\nexport const b = () => a;\n");
    write('src/c.ts', "import type { D } from './d';\nexport type C = { d: D };\n");
    write('src/d.ts', "import type { C } from './c';\nexport type D = { c: C };\n");
    const m = metrics();
    assert.deepEqual(m.cycles, [
      { members: ['src/a.ts', 'src/b.ts'], runtime: true },
      { members: ['src/c.ts', 'src/d.ts'], runtime: false },
    ]);
    assert.equal(row(m, 'src/a.ts').inCycle, true);
  });
});

describe('arch-metrics: hot spots and history', () => {
  test('hot spots are churn × complexity, hottest first', () => {
    write('src/busy.ts', 'export function f(x) { if (x) { return 1; } return 0; }\n'); // complexity 2
    write('src/knotty.ts', 'export function g(x, y) { if (x && y) { return 1; } if (x || y) { return 2; } return 0; }\n'); // 5
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add']);
    commit(['src/busy.ts']);
    commit(['src/busy.ts']);
    commit(['src/busy.ts']);
    const m = metrics();
    assert.equal(m.hotspotBasis, 'churn-x-complexity');
    assert.deepEqual(m.hotspots, [
      { file: 'src/busy.ts', churn: 4, complexity: 2, score: 8 },
      { file: 'src/knotty.ts', churn: 1, complexity: 5, score: 5 },
    ]);
  });

  test('a window with no commits ranks by complexity alone and says so', () => {
    write('src/knotty.ts', 'export function g(x, y) { if (x && y) { return 1; } return 0; }\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add']);
    const m = metrics({ window: 'HEAD' }); // HEAD..HEAD: a window with no commits
    assert.equal(m.history.reason, 'empty-window');
    assert.equal(m.hotspotBasis, 'complexity');
    assert.equal(m.status, 'degraded');
    assert.deepEqual(m.reasons, ['history:empty-window', 'hotspot-basis:complexity']);
    assert.deepEqual(m.hotspots, [{ file: 'src/knotty.ts', churn: 0, complexity: 3, score: 3 }]);
  });

  test('co-change pairs say whether an import links them', () => {
    write('src/a.ts', moduleOf(3));
    write('src/b.ts', moduleOf(3));
    write('src/c.ts', moduleOf(3, ['./d']));
    write('src/d.ts', moduleOf(3));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add']);
    for (let i = 0; i < 3; i++) commit(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    const m = metrics({ cochangeMinSupport: 4, cochangeMinConfidence: 1 });
    const linked = Object.fromEntries(m.coChange.map((p) => [`${p.a}~${p.b}`, p.importLinked]));
    assert.equal(linked['src/a.ts~src/b.ts'], false);
    assert.equal(linked['src/c.ts~src/d.ts'], true);
  });
});

describe('arch-metrics: zones', () => {
  /** `n` hot, isolated modules: s0 hottest. */
  function isolatedHotspots(n) {
    for (let i = 0; i < n; i++) {
      const branches = Array.from({ length: n - i }, (_, k) => `if (x === ${k}) { return ${k}; }`).join(' ');
      write(`src/s${i}.ts`, `export function f(x) { ${branches} return -1; }\n`);
    }
  }

  test('at most topZones zones, seeded hottest first', () => {
    isolatedHotspots(3);
    const m = metrics({ topZones: 2 });
    assert.deepEqual(m.zones.map((z) => [z.id, z.seed]), [['z1', 'src/s0.ts'], ['z2', 'src/s1.ts']]);
  });

  test('zones are disjoint: a hub reached by the first zone is not surveyed again', () => {
    write('src/hub.ts', moduleOf(3));
    write('src/a.ts', 'import { v } from "./hub";\nexport function a(x) { if (x) { if (v) { return 1; } } return 0; }\n');
    write('src/b.ts', 'import { v } from "./hub";\nexport function b(x) { if (x) { return v; } return 0; }\n');
    const m = metrics();
    const seen = m.zones.flatMap((z) => z.files);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(m.zones.map((z) => z.files), [['src/a.ts', 'src/hub.ts'], ['src/b.ts']]);
  });

  for (const [neighbours, expected] of [[am.DEFAULTS.zoneMaxFiles - 2, am.DEFAULTS.zoneMaxFiles - 1], [am.DEFAULTS.zoneMaxFiles - 1, am.DEFAULTS.zoneMaxFiles], [am.DEFAULTS.zoneMaxFiles, am.DEFAULTS.zoneMaxFiles]]) {
    test(`a seed with ${neighbours} neighbours makes a zone of ${expected} files (cap ${am.DEFAULTS.zoneMaxFiles})`, () => {
      const imports = Array.from({ length: neighbours }, (_, i) => `./n${String(i).padStart(2, '0')}`);
      write('src/seed.ts', `${imports.map((t, i) => `import { v as i${i} } from '${t}';`).join('\n')}\nexport function f(x) { if (x) { return 1; } return 0; }\n`);
      for (let i = 0; i < neighbours; i++) write(`src/n${String(i).padStart(2, '0')}.ts`, moduleOf(2));
      const m = metrics({ topZones: 1 });
      assert.equal(m.zones[0].seed, 'src/seed.ts');
      assert.equal(m.zones[0].files.length, expected);
    });
  }

  test('a zone lists the signals that touch it', () => {
    write('src/a.ts', "import { b } from './b';\nexport function a(x) { if (x) { return b; } return 0; }\n");
    write('src/b.ts', "import { a } from './a';\nexport const b = () => a;\n");
    const m = metrics();
    assert.deepEqual(m.zones[0].signals.cycles, [0]);
    assert.deepEqual(m.zones[0].signals.hotspots, ['src/a.ts', 'src/b.ts']);
  });
});

describe('arch-metrics: output shape', () => {
  test('top-level and row keys are fixed, with their types', () => {
    write('src/a.ts', moduleOf(3, ['./b']));
    write('src/b.ts', 'export function f(x) { return x ? 1 : 0; }\n');
    const m = metrics();
    assert.deepEqual(Object.keys(m).sort(), [
      'coChange', 'cycles', 'date', 'edges', 'graph', 'history', 'hotspotBasis', 'hotspots', 'modules',
      'passThrough', 'reasons', 'schema', 'scope', 'smallClusters', 'smallModules', 'status', 'thresholds', 'zones',
    ]);
    assert.equal(m.schema, am.SCHEMA_VERSION);
    assert.equal(m.date, DATE);
    assert.deepEqual(Object.keys(m.modules[0]).sort(), [
      'churn', 'complexity', 'exports', 'exportsPerLoc', 'fanIn', 'fanOut', 'file', 'hotspot', 'inCycle',
      'loc', 'maxFunctionComplexity', 'small', 'testFanIn',
    ]);
    assert.deepEqual(Object.keys(m.zones[0]).sort(), ['files', 'id', 'label', 'score', 'seed', 'signals']);
    assert.deepEqual(m.edges, [['src/a.ts', 'src/b.ts']]);
    assert.equal(typeof m.graph.modules, 'number');
    assert.deepEqual(JSON.parse(JSON.stringify(m)), m, 'metrics are plain JSON');
  });

  test('a date that is not YYYY-MM-DD is refused', () => {
    assert.throws(() => am.computeMetrics(root, { date: '5 Oct' }), TypeError);
  });
});

// ─── Pure comparison ─────────────────────────────────────────────────────────

function fakeMetrics(date, hotspots, { cycles = [], zones = [], window = '90d', paths = null, basis = 'churn-x-complexity' } = {}) {
  return {
    schema: am.SCHEMA_VERSION, date, scope: { paths, window, range: {} }, hotspotBasis: basis,
    hotspots: hotspots.map(([file, score]) => ({ file, churn: 1, complexity: score, score })),
    cycles: cycles.map((members) => ({ members, runtime: true })),
    zones,
  };
}

describe('arch-metrics: comparison and the milestone decision', () => {
  const T = 0.25;

  test('growth exactly at the threshold is not growth; just above it is', () => {
    const base = fakeMetrics('2026-09-01', [['src/at.ts', 100], ['src/above.ts', 100], ['src/below.ts', 100]]);
    const cur = fakeMetrics(DATE, [['src/at.ts', 125], ['src/above.ts', 126], ['src/below.ts', 124]]);
    const c = am.compareMetrics(base, cur, T);
    assert.deepEqual(c.grown.map((g) => g.file), ['src/above.ts']);
    assert.equal(c.signal, true);
  });

  test('entered hot spots and new cycles are signals, and name the zones holding them', () => {
    const base = fakeMetrics('2026-09-01', [['src/a.ts', 10]], { cycles: [['src/x.ts', 'src/y.ts']] });
    const cur = fakeMetrics(DATE, [['src/a.ts', 10], ['src/new.ts', 5]], {
      cycles: [['src/x.ts', 'src/y.ts'], ['src/p.ts', 'src/q.ts']],
      zones: [{ id: 'z1', files: ['src/a.ts'] }, { id: 'z2', files: ['src/new.ts'] }, { id: 'z3', files: ['src/q.ts'] }],
    });
    const c = am.compareMetrics(base, cur, T);
    assert.deepEqual(c.entered, [{ file: 'src/new.ts', score: 5 }]);
    assert.deepEqual(c.newCycles, [['src/p.ts', 'src/q.ts']]);
    assert.deepEqual(c.zones, ['z2', 'z3']);
  });

  test('no baseline: no comparison, no signal', () => {
    const c = am.compareMetrics(null, fakeMetrics(DATE, [['src/a.ts', 10]]), T);
    assert.deepEqual([c.baseline, c.signal], [null, false]);
  });

  test('the decision proposes a survey only on a signal, in the configured mode', () => {
    const grown = am.compareMetrics(fakeMetrics('2026-09-01', [['src/a.ts', 10]]), fakeMetrics(DATE, [['src/a.ts', 20]], { zones: [{ id: 'z1', files: ['src/a.ts'] }] }), T);
    const flat = am.compareMetrics(fakeMetrics('2026-09-01', [['src/a.ts', 10]]), fakeMetrics(DATE, [['src/a.ts', 10]]), T);
    const none = am.compareMetrics(null, fakeMetrics(DATE, []), T);
    assert.deepEqual(am.milestoneDecision(grown, 'suggest'), { mode: 'suggest', action: 'suggest', reason: 'growth', zones: ['z1'] });
    assert.deepEqual(am.milestoneDecision(grown, 'auto'), { mode: 'auto', action: 'auto', reason: 'growth', zones: ['z1'] });
    assert.deepEqual(am.milestoneDecision(grown, 'off'), { mode: 'off', action: 'off', reason: 'disabled', zones: [] });
    assert.equal(am.milestoneDecision(flat, 'auto').action, 'none');
    assert.equal(am.milestoneDecision(flat, 'auto').reason, 'no-growth');
    assert.equal(am.milestoneDecision(none, 'suggest').reason, 'no-baseline');
  });
});

describe('arch-metrics: baseline selection', () => {
  let dir;
  beforeEach(() => {
    dir = createTempDir('gsd-archbaseline-');
  });
  afterEach(() => {
    cleanup(dir);
  });

  function save(m) {
    fs.writeFileSync(path.join(dir, am.metricsFileName(m.date)), JSON.stringify(m));
  }

  test('the latest strictly earlier run over the same scope, window and basis', () => {
    save(fakeMetrics('2026-08-01', []));
    save(fakeMetrics('2026-09-01', []));
    save(fakeMetrics('2026-09-15', [], { window: '30d' }));
    save(fakeMetrics('2026-09-20', [], { paths: ['src'] }));
    save(fakeMetrics('2026-09-25', [], { basis: 'complexity' }));
    save(fakeMetrics(DATE, []));
    fs.writeFileSync(path.join(dir, am.metricsFileName('2026-09-30')), '{not json');
    const b = am.findBaseline(dir, fakeMetrics(DATE, []));
    assert.equal(b.date, '2026-09-01');
  });

  test('no earlier comparable run: no baseline; a missing directory has no runs', () => {
    save(fakeMetrics(DATE, []));
    assert.equal(am.findBaseline(dir, fakeMetrics(DATE, [])), null);
    assert.deepEqual(am.listMetricsFiles(path.join(dir, 'absent')), []);
  });
});
