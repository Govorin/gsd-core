'use strict';

/**
 * `gsd-tools mn design-registry` — design masters reconciled with component
 * exports on disk (src/mn-design-registry.cts, routed by
 * src/mn-command-router.cts).
 *
 * The readers and the reconciliation are pure, so they are driven with
 * strings and objects and asserted on their typed results (masters, rows,
 * code-only symbols). The CLI cases assert the JSON result and the
 * `--json-errors` reason/cause — never free-form message text.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, createTempDir, cleanup } = require('./helpers.cjs');
const dr = require('../gsd-core/bin/lib/mn-design-registry.cjs');
const { derivedMarker } = require('../gsd-core/bin/lib/mermaid.cjs');

const registryDoc = (rows, heading = '### Компоненты Kit') =>
  ['# Design system', '', heading, '', '| Нода | Компонент | Состояния |', '|---|---|---|', ...rows, ''].join('\n');

describe('mn design-registry: readers', () => {
  test('the registry reader takes only the table under a heading about components', () => {
    const md = [
      '## Tokens',
      '| `p-green-500` | Green |',
      registryDoc(['| `aB12c` | Button | default · hover |', '| `xY98z` | IconButton | — |']),
      '## Zone map',
      '| `zone01` | Header |',
    ].join('\n');
    const r = dr.parseRegistryMasters(md);
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.masters.map((m) => [m.id, m.name, m.states]),
      [
        ['aB12c', 'Button', ['default', 'hover']],
        ['xY98z', 'IconButton', []],
      ],
    );
  });

  test('a node id is 4 to 12 identifier characters (boundaries 3/4 and 12/13)', () => {
    const ids = ['abc', 'abcd', 'abcdefghijkl', 'abcdefghijklm'];
    const r = dr.parseRegistryMasters(registryDoc(ids.map((id) => `| \`${id}\` | Comp${id.length} | — |`)));
    assert.deepEqual(r.masters.map((m) => m.id), ['abcd', 'abcdefghijkl']);
  });

  test('header rows, hex colours and phrases are not components', () => {
    const r = dr.parseRegistryMasters(
      registryDoc(['| `node` | Header |', '| `c0lor1` | #1F7A3D |', '| `phr4se` | a long phrase, with punctuation! |', '| `ok0001` | Real |']),
    );
    assert.deepEqual(r.masters.map((m) => m.name), ['Real']);
  });

  test('a document without a component table is refused, not read as empty', () => {
    const r = dr.parseRegistryMasters('## Tokens\n| `abcd` | Thing |\n');
    assert.deepEqual([r.ok, r.reason], [false, 'empty']);
  });

  test('the HTML reader accepts both attribute orders, keeps only component/ masters, counts repeats', () => {
    const r = dr.parseHtmlMasters([
      { file: '/x/a.html', text: '<div data-id="n1" data-name="component/Button"></div><div data-name="component/Card" data-node-id="n2"></div>' },
      { file: '/x/b.html', text: '<div data-id="n1" data-name="component/Button"></div><div data-id="n3" data-name="Frame 12"></div>' },
    ]);
    assert.deepEqual(
      r.masters.map((m) => [m.id, m.name, m.instances, m.origin]),
      [
        ['n1', 'Button', 1, 'a.html'],
        ['n2', 'Card', 0, 'a.html'],
      ],
    );
    assert.deepEqual(dr.parseHtmlMasters([{ file: 'a.html', text: '<div></div>' }]).reason, 'empty');
  });

  test('the .pen reader takes reusable nodes, instances from refs, states from StateCell frames', () => {
    const doc = {
      variables: { a: 1, b: 2 },
      themes: { light: {} },
      children: [
        { id: 'm1', name: 'component/Button', reusable: true },
        { id: 'm2', name: 'Card', reusable: true },
        { id: 's1', name: 'StateCell · Hover', children: [{ type: 'ref', ref: 'm1' }] },
        { id: 'f1', children: [{ type: 'ref', ref: 'm1' }, { type: 'ref', ref: 'gone' }] },
      ],
    };
    const r = dr.parsePenMasters(doc, 'app.pen');
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.masters.map((m) => [m.id, m.name, m.instances, m.states]),
      [
        ['m1', 'Button', 2, ['Hover']],
        ['m2', 'Card', 0, []],
      ],
    );
    assert.deepEqual(r.extra, { dangling: 1, tokens: 2, themes: ['light'] });
    assert.equal(dr.parsePenMasters({ nope: 1 }, 'x.pen').reason, 'unreadable');
    assert.equal(dr.parsePenMasters({ children: [{ id: 'a' }] }, 'x.pen').reason, 'empty');
  });
});

describe('mn design-registry: reconciliation', () => {
  const master = (id, name, instances = 0) => ({ id, name, states: [], instances, origin: 'x' });
  const rel = (f) => f;

  test('matching is exact on a normalised name and never by substring', () => {
    const exports = dr.collectExports([
      { file: 'libs/kit/icon-button.tsx', text: 'export const IconButton = () => null;' },
      { file: 'libs/kit/drink-row.tsx', text: 'export function DrinkRow() {}' },
    ]);
    const { rows } = dr.reconcile([master('a', 'icon-button'), master('b', 'RecDrinkRow')], exports, {}, rel);
    assert.deepEqual(
      rows.map((r) => [r.component, r.status, r.symbol, r.confidence]),
      [
        ['icon-button', 'implemented', 'IconButton', 'exact'],
        ['RecDrinkRow', 'missing', null, null],
      ],
    );
  });

  test('a --map entry maps, ignores, or is reported broken; inherited keys are not entries', () => {
    const exports = dr.collectExports([{ file: 'libs/kit/drink-row.tsx', text: 'export const DrinkRow = 1;' }]);
    const map = { RecDrinkRow: 'DrinkRow', old01: false, Gone: 'Missing' };
    const { rows } = dr.reconcile(
      [master('rec1', 'RecDrinkRow'), master('old01', 'Old'), master('g1', 'Gone'), master('c1', 'constructor')],
      exports,
      map,
      rel,
    );
    const by = Object.fromEntries(rows.map((r) => [r.component, [r.status, r.confidence]]));
    assert.deepEqual(by, {
      RecDrinkRow: ['implemented', 'mapped'],
      Old: ['ignored', 'ignored'],
      Gone: ['missing', 'map-broken'],
      constructor: ['missing', null],
    });
  });

  test('rows order by instance count, then name; a name exported twice is flagged ambiguous', () => {
    const exports = dr.collectExports([
      { file: 'a/card.tsx', text: 'export const Card = 1;' },
      { file: 'b/card.tsx', text: 'export const Card = 2;' },
    ]);
    const { rows } = dr.reconcile([master('1', 'Zed', 0), master('2', 'Card', 0), master('3', 'Alpha', 5)], exports, {}, rel);
    assert.deepEqual(rows.map((r) => r.component), ['Alpha', 'Card', 'Zed']);
    assert.equal(rows[1].ambiguous, 2);
    assert.equal(rows[1].code, 'a/card.tsx');
  });

  test('code-only symbols are Kit components only: no icons, providers, screens or non-kit files', () => {
    const exports = dr.collectExports([
      { file: 'libs/ui/kit/badge.tsx', text: 'export const Badge = 1;' },
      { file: 'libs/ui/kit/star-icon.tsx', text: 'export const StarIcon = 1;' },
      { file: 'libs/ui/kit/theme.tsx', text: 'export const ThemeProvider = 1;' },
      { file: 'libs/ui/kit/home.screen.tsx', text: 'export const Home = 1;' },
      { file: 'libs/data/util.ts', text: 'export const Helper = 1;' },
    ]);
    const { codeOnly } = dr.reconcile([], exports, {}, rel);
    assert.deepEqual(codeOnly, [{ symbol: 'Badge', file: 'libs/ui/kit/badge.tsx' }]);
  });
});

describe('gsd-tools mn design-registry', () => {
  let project;
  const reasonOf = (r) => JSON.parse(r.error.trim().split('\n').at(-1));

  beforeEach(() => {
    project = createTempProject('gsd-mn-design-');
    fs.writeFileSync(
      path.join(project, 'DESIGN-SYSTEM.md'),
      registryDoc(['| `aB12c` | Button | default · hover |', '| `xY98z` | IconButton | — |', '| `qQ11q` | Card | — |']),
    );
    fs.mkdirSync(path.join(project, 'libs', 'ui', 'kit'), { recursive: true });
    fs.writeFileSync(path.join(project, 'libs', 'ui', 'kit', 'button.tsx'), 'export const Button = () => null;\n');
  });
  afterEach(() => cleanup(project));

  const run = (extra) => runGsdTools(['mn', 'design-registry', '--registry', 'DESIGN-SYSTEM.md', '--code', 'libs', ...extra], project);

  test('prints the typed result; --raw prints the same document, marker first', () => {
    const r = run([]);
    assert.equal(r.success, true, r.error);
    const result = JSON.parse(r.output);
    assert.deepEqual([result.summary.masters, result.summary.implemented, result.summary.missing], [3, 1, 2]);
    assert.equal(result.components.find((c) => c.component === 'Button').code, 'libs/ui/kit/button.tsx');
    assert.equal(result.check_failed, null);
    const raw = run(['--raw']);
    assert.equal(raw.output.trim(), result.markdown.trim());
    assert.equal(raw.output.split('\n')[0], derivedMarker(dr.DESIGN_REGISTRY_SOURCE));
  });

  test('--check fails only past the threshold (2 missing: threshold 1, 2, 3)', () => {
    const one = run(['--check', '--threshold', '1', '--json-errors']);
    assert.equal(one.success, false);
    assert.equal(reasonOf(one).cause, 'unimplemented');
    assert.equal(run(['--check', '--threshold', '2']).success, true);
    assert.equal(run(['--check', '--threshold', '3']).success, true);
    assert.equal(run([]).success, true, 'without --check findings never fail the process');
  });

  test('a --map naming absent symbols fails --check as a caller mistake; an unreadable map is refused', () => {
    fs.writeFileSync(path.join(project, 'map.json'), JSON.stringify({ Card: 'NoSuchCard' }));
    const broken = run(['--map', 'map.json', '--check', '--threshold', '9', '--json-errors']);
    assert.deepEqual([reasonOf(broken).reason, reasonOf(broken).cause], ['usage', 'map_broken']);
    fs.writeFileSync(path.join(project, 'bad.json'), '{not json');
    const bad = run(['--map', 'bad.json', '--json-errors']);
    assert.deepEqual([reasonOf(bad).reason, reasonOf(bad).cause], ['usage', 'bad_map']);
  });

  test('flags: one input mode, a --code, a non-negative integer threshold', () => {
    for (const args of [
      ['--code', 'libs'],
      ['--registry', 'DESIGN-SYSTEM.md'],
      ['--registry', 'DESIGN-SYSTEM.md', '--pen', 'x.pen', '--code', 'libs'],
      ['--registry', 'DESIGN-SYSTEM.md', '--code', 'libs', '--threshold', '-1'],
      ['--registry', 'DESIGN-SYSTEM.md', '--code', 'libs', '--threshold', 'x'],
      ['--registry', 'DESIGN-SYSTEM.md', '--code'],
    ]) {
      const r = runGsdTools(['mn', 'design-registry', ...args, '--json-errors'], project);
      assert.equal(r.success, false, args.join(' '));
      assert.equal(reasonOf(r).reason, 'usage', args.join(' '));
    }
  });

  test('inputs outside the project are refused; a missing input is a failure to look', () => {
    const outside = createTempDir('gsd-mn-design-outside-');
    const r = runGsdTools(['mn', 'design-registry', '--html', outside, '--code', 'libs', '--json-errors'], project);
    cleanup(outside);
    assert.equal(reasonOf(r).reason, 'usage');
    const gone = runGsdTools(['mn', 'design-registry', '--registry', 'NOPE.md', '--code', 'libs', '--json-errors'], project);
    assert.deepEqual([reasonOf(gone).reason, reasonOf(gone).cause], ['unknown', 'not_found']);
    const noCode = runGsdTools(['mn', 'design-registry', '--registry', 'DESIGN-SYSTEM.md', '--code', 'nothing-here', '--json-errors'], project);
    assert.equal(reasonOf(noCode).cause, 'not_found');
  });
});
