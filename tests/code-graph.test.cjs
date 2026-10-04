'use strict';

/**
 * Unit tests for code-graph.cjs (built from src/code-graph.cts) — the import graph behind
 * `arch metrics` and the window review pre-pass (pocock-practices design, D1 acceptance).
 *
 * The properties pinned here:
 *   - an import written in a comment, a docblock, a string or a template literal is not an import;
 *   - every import form is recognised with its kind, line, type-only flag and bound names;
 *   - relative specifiers follow TypeScript's probing order; `tsconfig` `paths` aliases resolve
 *     through `extends` (Nx `tsconfig.base.json`), JSONC included, exact key before wildcard and
 *     the longest prefix first; an `outDir` → `rootDir` mapping follows emitted files to source;
 *   - an unresolvable specifier lands in `unresolved` with its reason — never silently dropped;
 *   - cycles of 2 and 3 modules and a self-import are strongly connected components; fan-in,
 *     fan-out, LOC and export counts are exact;
 *   - the size limit is exact at its boundary.
 *
 * Fixtures are real files in a temp git project; assertions read the typed graph.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, cleanup } = require('./helpers.cjs');
const cg = require('../gsd-core/bin/lib/code-graph.cjs');
const { MAX_FILE_BYTES } = require('../gsd-core/bin/lib/symbol-index.cjs');

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** `from -> to` of every edge, in graph order. */
function arrows(graph) {
  return graph.edges.map((e) => `${e.from} -> ${e.to}`);
}

function edgeFrom(graph, from, specifier) {
  return graph.edges.find((e) => e.from === from && e.specifier === specifier);
}

let root;
beforeEach(() => {
  root = createTempGitProject('gsd-codegraph-');
});
afterEach(() => {
  cleanup(root);
});

describe('code-graph: import sites are lexed, not grepped', () => {
  test('imports inside comments, docblocks, strings and template literals are not imports', () => {
    write(root, 'src/real.ts', 'export const real = 1;\n');
    write(root, 'src/a.ts', [
      "// import { x } from './ghost-line';",
      "/* require('./ghost-block') */",
      '/**',
      " * @example import y from './ghost-doc'",
      ' */',
      'const s = "import z from \'./ghost-string\'";',
      "const t = `require('./ghost-template')`;",
      "import { real } from './real';",
      '',
    ].join('\n'));
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(arrows(graph), ['src/a.ts -> src/real.ts']);
    assert.deepEqual(graph.unresolved, [], 'a ghost import is not even an unresolved one');
  });

  test('every import form carries its kind, line, type-only flag and bound names', () => {
    for (const f of ['d', 'n', 't', 's', 'e', 'star', 'r', 'dyn', 'tf']) write(root, `src/${f}.ts`, 'export {};\n');
    write(root, 'src/main.ts', [
      "import D, { a, b as c, type T } from './d';", // 1
      "import * as N from './n';", // 2
      "import type { X } from './t';", // 3
      "import './s';", // 4
      "export { e1, default as E } from './e';", // 5
      "export * from './star';", // 6
      "const r = require('./r');", // 7
      "const dyn = import('./dyn');", // 8
      "import type from './tf';", // 9 — a default import NAMED `type`
      'import {',
      '  multi,',
      "} from './d';", // 12
      '',
    ].join('\n'));
    const graph = cg.buildImportGraph(root);
    const pick = (spec) => {
      const e = edgeFrom(graph, 'src/main.ts', spec);
      return { kind: e.kind, line: e.line, typeOnly: e.typeOnly, names: e.names };
    };
    assert.deepEqual(pick('./d'), { kind: 'import', line: 1, typeOnly: false, names: ['T', 'a', 'b', 'default'] });
    assert.deepEqual(pick('./n'), { kind: 'import', line: 2, typeOnly: false, names: null });
    assert.deepEqual(pick('./t'), { kind: 'import', line: 3, typeOnly: true, names: ['X'] });
    assert.deepEqual(pick('./s'), { kind: 'side-effect', line: 4, typeOnly: false, names: [] });
    assert.deepEqual(pick('./e'), { kind: 'export-from', line: 5, typeOnly: false, names: ['default', 'e1'] });
    assert.deepEqual(pick('./star'), { kind: 'export-from', line: 6, typeOnly: false, names: null });
    assert.deepEqual(pick('./r'), { kind: 'require', line: 7, typeOnly: false, names: null });
    assert.deepEqual(pick('./dyn'), { kind: 'dynamic', line: 8, typeOnly: false, names: null });
    assert.deepEqual(pick('./tf'), { kind: 'import', line: 9, typeOnly: false, names: ['default'] });
    const multi = graph.edges.filter((e) => e.specifier === './d').map((e) => [e.line, e.names]);
    assert.deepEqual(multi, [[1, ['T', 'a', 'b', 'default']], [12, ['multi']]]);
  });

  test('`.from(` / `x.require(` member calls are not import sites', () => {
    write(root, 'src/a.ts', "const x = Array.from('ab');\nconst y = loader.require('./nope');\n");
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.edges, []);
    assert.deepEqual(graph.unresolved, []);
  });
});

describe('code-graph: relative resolution', () => {
  test('TypeScript probing: extensionless, `.js` naming a `.ts` source, `.cjs` naming `.cts`, `index.*`', () => {
    write(root, 'src/x.ts', 'export {};\n');
    write(root, 'src/y.ts', 'export {};\n');
    write(root, 'src/z.cts', 'export {};\n');
    write(root, 'src/dir/index.ts', 'export {};\n');
    write(root, 'src/plain.js', 'module.exports = {};\n');
    write(root, 'src/main.ts', [
      "import './x';",
      "import './y.js';",
      "import './z.cjs';",
      "import './dir';",
      "import './plain.js';",
      '',
    ].join('\n'));
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.edges.map((e) => [e.specifier, e.to, e.via]), [
      ['./x', 'src/x.ts', 'relative'],
      ['./y.js', 'src/y.ts', 'relative'],
      ['./z.cjs', 'src/z.cts', 'relative'],
      ['./dir', 'src/dir/index.ts', 'relative'],
      ['./plain.js', 'src/plain.js', 'relative'],
    ]);
  });

  test('unresolvable specifiers are kept with their reason; packages are externals, not unresolved', () => {
    write(root, '.gitignore', 'gen/\n');
    write(root, 'gen/built.js', 'module.exports = 1;\n');
    write(root, 'src/main.ts', [
      "import './missing';", // 1
      "import '../gen/built';", // 2 — on disk, but ignored
      "import '../../outside';", // 3
      'const name = "x";',
      'require(name);', // 5
      "import '#internal';", // 6
      "import '/abs/path';", // 7
      "import 'react';",
      "import '@scope/pkg/sub';",
      "import 'node:fs';",
      '',
    ].join('\n'));
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.unresolved.map((u) => [u.line, u.reason]), [
      [1, 'missing-target'],
      [2, 'not-in-file-set'],
      [3, 'outside-root'],
      [5, 'non-literal'],
      [6, 'subpath-import'],
      [7, 'absolute-specifier'],
    ]);
    assert.equal(graph.unresolved.find((u) => u.reason === 'non-literal').specifier, 'name);');
    const main = graph.nodes.find((n) => n.file === 'src/main.ts');
    assert.deepEqual(main.externals, ['@scope/pkg', 'node:fs', 'react']);
    assert.deepEqual(graph.edges, []);
  });
});

describe('code-graph: tsconfig aliases', () => {
  test('Nx-style `tsconfig.base.json` paths resolve through `extends`, JSONC included', () => {
    write(root, 'tsconfig.base.json', [
      '{',
      '  // Nx workspace aliases',
      '  "compilerOptions": {',
      '    "baseUrl": ".",',
      '    "paths": {',
      '      "@org/util": ["libs/util/src/index.ts"],',
      '      "@org/*": ["libs/*/src/index.ts",],', // trailing comma
      '      "@org/util/*": ["libs/util/src/*"],',
      '    },',
      '  },',
      '}',
      '',
    ].join('\n'));
    write(root, 'tsconfig.json', '{ "extends": "./tsconfig.base.json", "compilerOptions": { "noEmit": true } }\n');
    write(root, 'libs/util/src/index.ts', 'export {};\n');
    write(root, 'libs/util/src/deep.ts', 'export {};\n');
    write(root, 'libs/core/src/index.ts', 'export {};\n');
    write(root, 'apps/web/main.ts', [
      "import '@org/util';", // exact key wins over `@org/*`
      "import '@org/core';", // wildcard
      "import '@org/util/deep';", // `@org/util/*` — the longer prefix wins over `@org/*`
      "import '@org/ghost';", // alias matched, target missing
      '',
    ].join('\n'));
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.edges.map((e) => [e.specifier, e.to, e.via]), [
      ['@org/util', 'libs/util/src/index.ts', 'alias'],
      ['@org/core', 'libs/core/src/index.ts', 'alias'],
      ['@org/util/deep', 'libs/util/src/deep.ts', 'alias'],
    ]);
    assert.deepEqual(graph.unresolved.map((u) => [u.specifier, u.reason]), [['@org/ghost', 'missing-target']]);
    assert.deepEqual(graph.aliases.sources, ['tsconfig.json', 'tsconfig.base.json']);
    assert.deepEqual(graph.aliases.warnings, []);
  });

  test('paths without baseUrl are relative to the config that declared them; baseUrl bare specifiers resolve', () => {
    write(root, 'config/tsconfig.paths.json', '{ "compilerOptions": { "paths": { "~/*": ["../src/*"] } } }\n');
    write(root, 'tsconfig.json', '{ "extends": "./config/tsconfig.paths.json" }\n');
    write(root, 'src/lib/thing.ts', 'export {};\n');
    write(root, 'src/main.ts', "import '~/lib/thing';\n");
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.edges.map((e) => [e.to, e.via]), [['src/lib/thing.ts', 'alias']]);

    cleanup(root);
    root = createTempGitProject('gsd-codegraph-');
    write(root, 'tsconfig.json', '{ "compilerOptions": { "baseUrl": "src" } }\n');
    write(root, 'src/lib/thing.ts', 'export {};\n');
    write(root, 'src/main.ts', "import 'lib/thing';\nimport 'lodash';\n");
    const g2 = cg.buildImportGraph(root);
    assert.deepEqual(g2.edges.map((e) => [e.to, e.via]), [['src/lib/thing.ts', 'base-url']]);
    assert.deepEqual(g2.nodes.find((n) => n.file === 'src/main.ts').externals, ['lodash']);
  });

  test('an extends cycle and a missing parent are named in warnings, not thrown', () => {
    write(root, 'tsconfig.json', '{ "extends": ["./a.json", "./nope.json"] }\n');
    write(root, 'a.json', '{ "extends": "./tsconfig.json" }\n');
    const aliases = cg.loadTsconfigAliases(root);
    assert.deepEqual(aliases.warnings.sort(), ['extends-cycle:tsconfig.json', 'extends-not-found:tsconfig.json->./nope.json']);
  });

  test('outDir → rootDir: an emitted path is followed to its source, and a source `require` runs from its emitted location', () => {
    write(root, '.gitignore', 'out/\n');
    write(root, 'tsconfig.json', '{ "compilerOptions": { "rootDir": "src", "outDir": "out/lib" } }\n');
    write(root, 'src/mod.cts', "const s = require('../../scripts/tool.cjs');\nexport = { s };\n");
    write(root, 'scripts/tool.cjs', 'module.exports = {};\n');
    write(root, 'tests/mod.test.cjs', "const m = require('../out/lib/mod.cjs');\n");
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.via]), [
      ['src/mod.cts', 'scripts/tool.cjs', 'emitted'],
      ['tests/mod.test.cjs', 'src/mod.cts', 'emitted'],
    ]);
    assert.deepEqual(graph.aliases.emit, [{ outDir: 'out/lib', rootDir: 'src', source: 'tsconfig.json' }]);
    assert.deepEqual(graph.unresolved, []);
  });
});

describe('code-graph: parseJsonc', () => {
  test('comments and trailing commas go; the same characters inside strings stay', () => {
    const text = '{\n  // c\n  "url": "http://x/*y*/",\n  "s": "a, }",\n  "arr": [1, 2,],\n  /* b */ "n": 1,\n}\n';
    assert.deepEqual(cg.parseJsonc(text), { url: 'http://x/*y*/', s: 'a, }', arr: [1, 2], n: 1 });
  });
});

describe('code-graph: cycles and coupling', () => {
  beforeEach(() => {
    write(root, 'src/a.ts', "import './b';\n");
    write(root, 'src/b.ts', "import './a';\n");
    write(root, 'src/c.ts', "import './d';\n");
    write(root, 'src/d.ts', "import './e';\n");
    write(root, 'src/e.ts', "import './c';\nimport './f';\n");
    write(root, 'src/f.ts', "import './g';\n");
    write(root, 'src/g.ts', 'export const g = 1;\n');
    write(root, 'src/self.ts', "import './self';\n");
  });

  test('a 2-cycle, a 3-cycle and a self-import are components; an acyclic chain is not', () => {
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(cg.stronglyConnected(graph), [
      ['src/c.ts', 'src/d.ts', 'src/e.ts'],
      ['src/a.ts', 'src/b.ts'],
      ['src/self.ts'],
    ]);
    const inCycle = Object.fromEntries(cg.moduleStats(graph).map((s) => [s.file, s.inCycle]));
    assert.deepEqual(inCycle, {
      'src/a.ts': true, 'src/b.ts': true, 'src/c.ts': true, 'src/d.ts': true, 'src/e.ts': true,
      'src/f.ts': false, 'src/g.ts': false, 'src/self.ts': true,
    });
  });

  test('a cycle closed only by `import type` drops out with includeTypeOnly: false', () => {
    write(root, 'src/b.ts', "import type { A } from './a';\n");
    const graph = cg.buildImportGraph(root);
    assert.ok(cg.stronglyConnected(graph).some((c) => c.includes('src/a.ts')));
    assert.ok(!cg.stronglyConnected(graph, { includeTypeOnly: false }).some((c) => c.includes('src/a.ts')));
  });

  test('fan-in and fan-out count distinct modules; self-imports are not coupling', () => {
    write(root, 'src/h.ts', "import './g';\nimport './g';\nimport { x } from './g';\n");
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(cg.fanIn(graph).get('src/g.ts'), ['src/f.ts', 'src/h.ts']);
    assert.deepEqual(cg.fanOut(graph).get('src/e.ts'), ['src/c.ts', 'src/f.ts']);
    const stats = Object.fromEntries(cg.moduleStats(graph).map((s) => [s.file, [s.fanIn, s.fanOut]]));
    assert.deepEqual(stats['src/g.ts'], [2, 0]);
    assert.deepEqual(stats['src/h.ts'], [0, 1]);
    assert.deepEqual(stats['src/self.ts'], [0, 0]);
  });
});

describe('code-graph: size and exports', () => {
  test('LOC counts non-blank lines without comments; exports count ESM, `export =` and CommonJS bindings', () => {
    write(root, 'src/esm.ts', [
      '// header comment',
      '/* block',
      '   comment */',
      'export const a = 1;',
      '',
      'export function b() {}',
      'export default class {}',
      'export interface I {}',
      'export type T = string;',
      'const x = 1, y = 2;',
      'export { x, y as z };',
      "export * from './cjs';",
      '',
    ].join('\n'));
    write(root, 'src/cjs.js', [
      'exports.one = 1;',
      'module.exports.two = 2;',
      'module.exports = { three, four: () => {}, ...rest };',
      '',
    ].join('\n'));
    write(root, 'src/assign.cts', 'const p = 1;\nexport = { p, q: { nested: 1 } };\n');
    const graph = cg.buildImportGraph(root);
    const stats = Object.fromEntries(cg.moduleStats(graph).map((s) => [s.file, [s.loc, s.exports]]));
    assert.deepEqual(stats['src/esm.ts'], [8, 8]);
    assert.deepEqual(stats['src/cjs.js'], [3, 5]);
    assert.deepEqual(stats['src/assign.cts'], [2, 2]);
  });

  test('exportedNames lists what an importer can bind: aliases, default, namespaces, CommonJS keys', () => {
    const { lex } = require('../gsd-core/bin/lib/symbol-index.cjs');
    const names = (text) => cg.exportedNames(lex(text, 'ts').code);
    assert.deepEqual(names([
      'export const a = 1;',
      'export async function b() {}',
      'export default class {}',
      'export type T = string;',
      'const x = 1, y = 2;',
      'export { x, y as z, type T as U };',
      "export * as ns from './m';",
      "export * from './cjs';",
      "// export const commented = 1;",
      "const s = 'export const quoted = 1';",
    ].join('\n')), ['U', 'a', 'b', 'default', 'ns', 'x', 'z', 'T'].sort());
    assert.deepEqual(names("exports.one = 1;\nmodule.exports = { three, four: () => {}, ...rest, 'quoted': 1 };\n"), ['four', 'one', 'three']);
    assert.deepEqual(names('module.exports = factory();\n'), ['default']);
  });

  test('a file is lexed up to MAX_FILE_BYTES exactly: N-1 and N are scanned, N+1 is skipped', () => {
    const body = "import './t';\n";
    /** `body`, then one comment line padding the file to exactly `n` bytes. */
    const pad = (n) => `${body}//${'x'.repeat(n - body.length - 3)}\n`;
    write(root, 'src/t.ts', 'export {};\n');
    write(root, 'src/under.ts', pad(MAX_FILE_BYTES - 1));
    write(root, 'src/at.ts', pad(MAX_FILE_BYTES));
    write(root, 'src/over.ts', pad(MAX_FILE_BYTES + 1));
    for (const f of ['under', 'at', 'over']) assert.equal(fs.statSync(path.join(root, `src/${f}.ts`)).size, MAX_FILE_BYTES + { under: -1, at: 0, over: 1 }[f]);
    const graph = cg.buildImportGraph(root);
    assert.deepEqual(graph.skipped, [{ file: 'src/over.ts', reason: 'too_large' }]);
    assert.deepEqual(cg.fanIn(graph).get('src/t.ts'), ['src/at.ts', 'src/under.ts']);
  });
});

describe('code-graph: scope and determinism', () => {
  test('`paths` limits the lexed files; a target outside stays a node, unscanned', () => {
    write(root, 'libs/a/x.ts', "import '../b/y';\n");
    write(root, 'libs/b/y.ts', "import '../a/x';\n");
    const graph = cg.buildImportGraph(root, { paths: ['libs/a/'] });
    assert.deepEqual(graph.scope, ['libs/a']);
    assert.deepEqual(arrows(graph), ['libs/a/x.ts -> libs/b/y.ts']);
    assert.deepEqual(graph.nodes.map((n) => [n.file, n.scanned, n.loc]), [['libs/a/x.ts', true, 1], ['libs/b/y.ts', false, null]]);
  });

  test('a scope path outside the root is refused', () => {
    assert.throws(() => cg.buildImportGraph(root, { paths: ['../elsewhere'] }), /outside the root/);
  });

  test('`readText` graphs another revision: listed files are read through it, null leaves a file unscanned', () => {
    write(root, 'src/x.ts', 'export {};\n');
    const texts = { 'src/a.ts': "import { gone } from './gone';\n", 'src/gone.ts': 'export const gone = 1;\n' };
    const graph = cg.buildImportGraph(root, {
      listFiles: () => ['src/a.ts', 'src/gone.ts', 'src/x.ts'],
      readText: (rel) => (rel === 'src/a.ts' ? texts[rel] : null),
    });
    assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.names]), [['src/a.ts', 'src/gone.ts', ['gone']]]);
    assert.deepEqual(graph.nodes.map((n) => [n.file, n.scanned]), [['src/a.ts', true], ['src/gone.ts', false]]);
    assert.deepEqual(graph.skipped, []);
  });

  test('two builds of the same tree are equal', () => {
    write(root, 'src/b.ts', "import './a';\nimport 'pkg';\n");
    write(root, 'src/a.ts', "import './c';\n");
    write(root, 'src/c.ts', 'export {};\n');
    assert.deepEqual(cg.buildImportGraph(root), cg.buildImportGraph(root));
  });
});
