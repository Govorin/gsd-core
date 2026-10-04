'use strict';

/**
 * TRANSITIONAL — deleted together with
 * capabilities/mn-verify-gate/scripts/design-registry.mjs.
 *
 * Runs the legacy script and `gsd-tools mn design-registry` on the same
 * fixtures, for each input mode, and asserts the same reconciliation: the
 * script's `--format json` (summary, components, codeOnly) equals the
 * command's JSON fields, and the markdown documents agree line for line
 * except the marker (now `derivedMarker('design-registry')`, the shared
 * spelling, instead of a hand-built comment naming the input file). Under
 * `--check`, the script's exit 1 (unimplemented) and 2 (broken map) are the
 * command's failure causes `unimplemented` and `map_broken`.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const LEGACY = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'design-registry.mjs');

describe('design-registry: legacy script ↔ gsd-tools mn design-registry', () => {
  let project;
  beforeEach(() => {
    project = createTempProject('gsd-mn-design-eq-');
    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
      fs.writeFileSync(path.join(project, rel), body);
    };
    write(
      'DESIGN-SYSTEM.md',
      [
        '## Tokens',
        '| `p-green-500` | #1F7A3D |',
        '### Компоненты Kit',
        '| Нода | Компонент | Состояния |',
        '|---|---|---|',
        '| `aB12c` | Button | default · hover · disabled |',
        '| `xY98z` | IconButton | default |',
        '| `qQ11q` | Card | — |',
        '| `rD001` | RecDrinkRow | — |',
        '',
      ].join('\n'),
    );
    write(
      'export/screen.html',
      '<div data-id="aB12c" data-name="component/Button"></div><div data-name="component/Card" data-id="qQ11q"></div><div data-id="aB12c" data-name="component/Button"></div>',
    );
    write(
      'app.pen',
      JSON.stringify({
        variables: { a: 1 },
        themes: { light: {} },
        children: [
          { id: 'aB12c', name: 'component/Button', reusable: true },
          { id: 'qQ11q', name: 'Card', reusable: true },
          { id: 's1', name: 'StateCell · Hover', children: [{ type: 'ref', ref: 'aB12c' }] },
          { id: 'f1', children: [{ type: 'ref', ref: 'aB12c' }, { type: 'ref', ref: 'gone' }] },
        ],
      }),
    );
    write('libs/ui/kit/button.tsx', 'export const Button = () => null;\n');
    write('libs/ui/kit/drink-row.tsx', 'export function DrinkRow() {}\n');
    write('libs/ui/kit/badge.tsx', 'export const Badge = () => null;\n');
    write('libs/ui/kit/star-icon.tsx', 'export const StarIcon = () => null;\n');
    write('map.json', JSON.stringify({ RecDrinkRow: 'DrinkRow', qQ11q: false }));
    write('broken-map.json', JSON.stringify({ Card: 'NoSuchCard' }));
  });
  afterEach(() => cleanup(project));

  const legacy = (args) => runNode([LEGACY, ...args], { cwd: project, timeoutMs: PROBE_TIMEOUT_MS });
  const current = (args) => runGsdTools(['mn', 'design-registry', ...args], project);

  for (const [mode, input] of [
    ['registry', 'DESIGN-SYSTEM.md'],
    ['html', 'export'],
    ['pen', 'app.pen'],
  ]) {
    for (const withMap of [false, true]) {
      const label = `${mode}${withMap ? ' with --map' : ''}`;
      test(`same reconciliation and document: ${label}`, () => {
        const args = [`--${mode}`, input, '--code', 'libs', ...(withMap ? ['--map', 'map.json'] : [])];
        const oldJson = legacy([...args, '--format', 'json']);
        assert.equal(oldJson.outcome, OUTCOME.EXITED);
        assert.equal(oldJson.exitCode, 0, oldJson.stderr);
        const was = JSON.parse(oldJson.stdout);
        const now = JSON.parse(current(args).output);
        assert.deepEqual(now.summary, was.summary);
        assert.deepEqual(now.components, was.components);
        assert.deepEqual(now.codeOnly, was.codeOnly);
        const oldMd = legacy(args).stdout.trim().split('\n');
        const newMd = now.markdown.trim().split('\n');
        assert.deepEqual(newMd.slice(1), oldMd.slice(1));
      });
    }
  }

  test('--check verdicts agree: unimplemented beyond the threshold, a broken map', () => {
    const cases = [
      // three components are unimplemented without a map: IconButton, Card, RecDrinkRow
      { args: ['--check', '--threshold', '2'], exit: 1, cause: 'unimplemented' },
      { args: ['--check', '--threshold', '3'], exit: 0, cause: null },
      { args: ['--check', '--map', 'broken-map.json', '--threshold', '9'], exit: 2, cause: 'map_broken' },
    ];
    for (const c of cases) {
      const args = ['--registry', 'DESIGN-SYSTEM.md', '--code', 'libs', ...c.args];
      assert.equal(legacy(args).exitCode, c.exit, c.args.join(' '));
      const r = current([...args, '--json-errors']);
      assert.equal(r.success, c.cause === null, c.args.join(' '));
      if (c.cause !== null) assert.equal(JSON.parse(r.error.trim().split('\n').at(-1)).cause, c.cause);
    }
  });
});
