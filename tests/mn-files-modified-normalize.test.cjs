'use strict';

/**
 * files-modified-normalize — resolving declared `files_modified` entries against
 * a real tree so the wave-collision gate stops skipping them (`check
 * mn-wave-collision` in expand mode, src/gate-mn-waves.cts, reads through it).
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 *
 * Literal wave collision (formerly `scripts/wave-collision.mjs`) works: it names
 * the colliding pair and the shared file. What it cannot do
 * is compare an entry that is not a concrete file. Its own `--verbose` output on
 * `legion-app/08.2-heimdall-runtime`:
 *
 *   "OK — 9 plan(s) across 8 wave(s), 1 pair(s) checked, no shared files"
 *   "13 non-file entr(ies) (directories or globs) were not compared"
 *
 * That phase carries a genuine overlap: `08.2-01-PLAN.md` and `08.2-01b-PLAN.md`
 * both declare `libs/modules/heimdall/testing` — a directory. The gate declines
 * to guess and says so. Measured across 55 reachable phase directories: 2
 * collisions caught, 17 phases where entries are skipped. The gate is not wrong;
 * it is blind on 17 of 55, and this module restores its sight.
 *
 * ── The four outcomes, which must never collapse (D-66) ─────────────────────
 *
 *   1. plain file          → compared as declared
 *   2. glob/dir → N files  → those files are compared
 *   3. glob/dir → 0 files  → "stale glob, the files moved"
 *   4. plan declared none  → "the planner refused to declare" (D-65, criterion 2)
 *
 * 3 and 4 are different breakages with different remedies. Merging them is what
 * earns a gate the reputation that gets it switched off (criterion 4).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyEntry,
  normalizeEntries,
  normalizePlanFiles,
} = require('../gsd-core/bin/lib/files-modified-normalize.cjs');

// ── in-memory FsProbe ───────────────────────────────────────────────────────
//
// The module takes its filesystem by injection, so every test here runs against
// an object literal: no temp tree, no `try/finally`, no teardown. `order` lets a
// test hand back a deliberately reversed listing to prove the sort inside the
// module is load-bearing rather than incidentally satisfied by the host's
// readdir order (criterion 3).

/**
 * @param {Record<string, 'dir'|'file'>} tree path → kind
 * @param {(names: string[]) => string[]} [order] listing transform
 */
function makeProbe(tree, order = (n) => n) {
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(tree, p),
    isDirectory: (p) => tree[p] === 'dir',
    readDir: (p) => {
      const prefix = p === '' ? '' : p + '/';
      const names = new Set();
      for (const key of Object.keys(tree)) {
        if (!key.startsWith(prefix) || key === p) continue;
        const rest = key.slice(prefix.length);
        const head = rest.split('/')[0];
        if (head !== '') names.add(head);
      }
      return order([...names]);
    },
  };
}

const REVERSED = (names) => [...names].reverse();

// A tree with the shape the live measurement found: nested directories, a file
// that shares a prefix with a directory, and a sibling subtree the globs must
// not wander into.
const TREE = {
  libs: 'dir',
  'libs/x': 'dir',
  'libs/x/b.ts': 'file',
  'libs/x/a.ts': 'file',
  'libs/x/nested': 'dir',
  'libs/x/nested/c.ts': 'file',
  'libs/y': 'dir',
  'libs/y/z.ts': 'file',
  apps: 'dir',
  'apps/one.ts': 'file',
};

describe('classifyEntry — four kinds, each reachable', () => {
  const fs = makeProbe(TREE);

  test('an existing directory is a directory', () => {
    assert.equal(classifyEntry('libs/x', fs), 'directory');
  });

  test('a concrete existing path that is not a directory is a file', () => {
    assert.equal(classifyEntry('libs/x/a.ts', fs), 'file');
  });

  test('a path that does not exist yet is still a file — the plan intends to create it', () => {
    // Treating a to-be-created path as unresolved would flag every greenfield
    // plan, which is the opposite of the defect this module addresses.
    assert.equal(classifyEntry('libs/x/brand-new.ts', fs), 'file');
  });

  test('a wildcard makes it a glob', () => {
    assert.equal(classifyEntry('libs/**', fs), 'glob');
    assert.equal(classifyEntry('libs/x/*.ts', fs), 'glob');
  });

  test('prose is malformed, not a directory', () => {
    assert.equal(
      classifyEntry('apps/ucars/api (9 files), libs/ucars/client (6)', fs),
      'malformed',
    );
  });

  test('prose containing a wildcard is malformed, NOT a glob', () => {
    // Measured live: 16 of the 45 wildcard-bearing entries are prose wrapped
    // around a glob. Classifying them `glob` would resolve them to zero files
    // and report "stale glob — the files moved", when in fact nothing moved and
    // the planner simply wrote a sentence. Two different failures; D-66 forbids
    // reporting them as one.
    assert.equal(
      classifyEntry(
        'libs/** (19 prefer-zod-validate files + 7 use-either-async files — exact list from live scan)',
        fs,
      ),
      'malformed',
    );
  });

  test('a trailing slash does not change the kind — the live trees write directories that way', () => {
    // `.prod-truth/schema/introspect/` is a real measured entry.
    assert.equal(classifyEntry('libs/x/', fs), 'directory');
    assert.equal(classifyEntry('./libs/x', fs), 'directory');
  });
});

describe('normalizePlanFiles — outcome 1 and 2: entries that resolve', () => {
  const fs = makeProbe(TREE);

  test('a directory resolves to the sorted files beneath it, recursively', () => {
    const out = normalizePlanFiles(['libs/x'], fs);
    assert.equal(out.entries.length, 1);
    assert.equal(out.entries[0].kind, 'directory');
    assert.equal(out.entries[0].declared, 'libs/x');
    assert.deepStrictEqual(out.entries[0].resolved, [
      'libs/x/a.ts',
      'libs/x/b.ts',
      'libs/x/nested/c.ts',
    ]);
    assert.equal(out.entries[0].unresolved, false);
    assert.equal(out.declaredNothing, false);
  });

  test('the measured false negative: a directory and a file inside it now share a path', () => {
    // This is the `libs/modules/heimdall/testing` case from 08.2-heimdall-runtime,
    // reduced. Before normalisation the gate compared nothing and reported OK.
    const a = normalizePlanFiles(['libs/x'], fs);
    const b = normalizePlanFiles(['libs/x/a.ts'], fs);
    const shared = a.files.filter((f) => b.files.includes(f));
    assert.deepStrictEqual(shared, ['libs/x/a.ts']);
  });

  test('a directory does NOT collide with an unrelated sibling', () => {
    // D-63c: the normaliser must turn a skipped comparison into a real one, not
    // reinstate naive string matching that manufactures collisions.
    const a = normalizePlanFiles(['libs/x'], fs);
    const b = normalizePlanFiles(['libs/y'], fs);
    assert.deepStrictEqual(
      a.files.filter((f) => b.files.includes(f)),
      [],
    );
  });

  test('a glob resolves to its matches and nothing outside them', () => {
    const out = normalizePlanFiles(['libs/x/*.ts'], fs);
    assert.equal(out.entries[0].kind, 'glob');
    assert.deepStrictEqual(out.entries[0].resolved, ['libs/x/a.ts', 'libs/x/b.ts']);
    assert.equal(out.entries[0].unresolved, false);
  });

  test('a ** glob crosses depth, a * glob does not', () => {
    const deep = normalizePlanFiles(['libs/**'], fs);
    assert.deepStrictEqual(deep.entries[0].resolved, [
      'libs/x/a.ts',
      'libs/x/b.ts',
      'libs/x/nested/c.ts',
      'libs/y/z.ts',
    ]);
    const shallow = normalizePlanFiles(['libs/*'], fs);
    assert.deepStrictEqual(shallow.entries[0].resolved, []);
  });

  test('a plain file passes through as declared', () => {
    const out = normalizePlanFiles(['apps/one.ts'], fs);
    assert.equal(out.entries[0].kind, 'file');
    assert.deepStrictEqual(out.entries[0].resolved, ['apps/one.ts']);
    assert.equal(out.entries[0].unresolved, false);
  });

  test('files is the deduplicated sorted union across entries', () => {
    const out = normalizePlanFiles(['libs/x', 'libs/x/a.ts', 'apps/one.ts'], fs);
    assert.deepStrictEqual(out.files, [
      'apps/one.ts',
      'libs/x/a.ts',
      'libs/x/b.ts',
      'libs/x/nested/c.ts',
    ]);
  });
});

describe('normalizePlanFiles — outcomes 3 and 4 stay distinguishable (D-66)', () => {
  const fs = makeProbe(TREE);

  test('outcome 3: a glob matching nothing is resolved-to-empty, not undeclared', () => {
    const out = normalizePlanFiles(['libs/gone/**'], fs);
    assert.equal(out.entries[0].kind, 'glob');
    assert.deepStrictEqual(out.entries[0].resolved, []);
    assert.equal(out.entries[0].unresolved, true);
    assert.equal(out.declaredNothing, false);
  });

  test('outcome 4: a plan declaring nothing is a refusal, carrying no entries at all', () => {
    const out = normalizePlanFiles([], fs);
    assert.equal(out.declaredNothing, true);
    assert.deepStrictEqual(out.entries, []);
    assert.deepStrictEqual(out.files, []);
  });

  test('outcome 3 and outcome 4 are not equal under ANY comparison a caller makes', () => {
    const staleGlob = normalizePlanFiles(['libs/gone/**'], fs);
    const declaredNothing = normalizePlanFiles([], fs);

    // The whole result differs...
    assert.notDeepStrictEqual(staleGlob, declaredNothing);
    // ...and so does each field a caller would plausibly branch on, so no
    // narrow read of the result can merge the two.
    assert.notEqual(staleGlob.declaredNothing, declaredNothing.declaredNothing);
    assert.notEqual(staleGlob.entries.length, declaredNothing.entries.length);

    // The trap: `files` is [] for BOTH. A caller reading only `files` cannot
    // tell them apart, which is exactly why declaredNothing is carried
    // separately and must never be inferred from files.length.
    assert.deepStrictEqual(staleGlob.files, declaredNothing.files);
  });

  test('a directory that is gone resolves empty and is NOT declaredNothing', () => {
    const out = normalizePlanFiles(['libs/vanished'], fs);
    // Non-existent concrete paths stay `file` (the plan may be creating it);
    // what matters here is that the plan is not read as having declared nothing.
    assert.equal(out.declaredNothing, false);
    assert.equal(out.entries.length, 1);
  });

  test('a plan whose only entry is prose declared SOMETHING, badly', () => {
    // Not the same as declaring nothing: the remedy is "rewrite the entry",
    // not "write one".
    const out = normalizePlanFiles(
      ['apps/ucars/api (9 files), libs/ucars/client (6) — exact list from live scan'],
      fs,
    );
    assert.equal(out.declaredNothing, false);
    assert.equal(out.entries[0].kind, 'malformed');
    assert.deepStrictEqual(out.entries[0].resolved, []);
    assert.equal(out.entries[0].unresolved, true);
    assert.deepStrictEqual(out.files, []);
  });
});

describe('malformed entries measured in the live trees', () => {
  const fs = makeProbe(TREE);

  test('the verbatim prose entry classifies malformed and contributes zero paths', () => {
    const prose =
      'apps/ucars/api (9 files), apps/ucars/admin (6), libs/ucars/client (6), ' +
      'apps/ucars/web-e2e (5), libs/ucars/services (5), + ~21 scattered files — ' +
      'exact list from live scan';
    const out = normalizePlanFiles([prose, 'apps/one.ts'], fs);
    const [bad, good] = out.entries;
    assert.equal(bad.kind, 'malformed');
    assert.equal(bad.declared, prose);
    assert.deepStrictEqual(bad.resolved, []);
    assert.equal(good.kind, 'file');
    // The good entry still counts; one bad entry does not poison the plan.
    assert.deepStrictEqual(out.files, ['apps/one.ts']);
  });

  test('the verbatim quoted glob-with-prose entry is malformed, not a stale glob', () => {
    const prose =
      'libs/** (19 prefer-zod-validate files + 7 use-either-async files — exact list from live scan)';
    const out = normalizePlanFiles([prose], fs);
    assert.equal(out.entries[0].kind, 'malformed');
    // `libs/**` alone would have resolved to four real files. Had this been
    // read as a glob it would instead have resolved to zero and been reported
    // as "the files moved" — a fabricated diagnosis.
    assert.deepStrictEqual(out.entries[0].resolved, []);
    assert.notDeepStrictEqual(out.entries[0], normalizePlanFiles(['libs/**'], fs).entries[0]);
  });

  test('an empty or whitespace-only entry is dropped, and dropping it is not declaring nothing', () => {
    const out = normalizePlanFiles(['   ', 'apps/one.ts'], fs);
    assert.equal(out.declaredNothing, false);
    assert.deepStrictEqual(out.files, ['apps/one.ts']);
  });
});

describe('determinism — stability AND variance, adjacent on purpose (criterion 3)', () => {
  // 03-CONTEXT.md states the trap outright: "identical assignment is trivially
  // satisfied by a solver that always returns the same constant". The stability
  // test alone proves nothing. The variance test is what denies a constant-
  // returning impostor the pass, and the shuffle test is what proves the sort
  // inside the module is real rather than inherited from the host's readdir.
  //
  // These three live in one block, adjacent, so a future reader cannot delete
  // the variance half without seeing that the stability half now proves nothing.

  const inputA = ['libs/x', 'libs/**', 'apps/one.ts', 'libs/gone/**'];

  const fsA = makeProbe(TREE);
  const fsB = makeProbe({
    libs: 'dir',
    'libs/x': 'dir',
    'libs/x/different.ts': 'file',
    apps: 'dir',
    'apps/one.ts': 'file',
  });
  const fsReversed = makeProbe(TREE, REVERSED);

  test('stability: the same input on the same tree normalises identically twice', () => {
    assert.deepStrictEqual(normalizePlanFiles(inputA, fsA), normalizePlanFiles(inputA, fsA));
  });

  test('variance: the same input on a DIFFERENT tree normalises differently', () => {
    // A normaliser that always returned [] would sail through the stability
    // test above. It cannot survive this one.
    assert.notDeepStrictEqual(normalizePlanFiles(inputA, fsA), normalizePlanFiles(inputA, fsB));
  });

  test('the sort is load-bearing: a reversed readDir yields byte-identical output', () => {
    // The two probes differ ONLY in listing order. If any level of the walk
    // iterated an unsorted listing, these would diverge.
    assert.deepStrictEqual(
      normalizePlanFiles(inputA, fsA),
      normalizePlanFiles(inputA, fsReversed),
    );
  });

  test('byte-identical, not merely deep-equal', () => {
    // deepStrictEqual tolerates key-order differences; JSON does not. Array
    // order and key order are both part of "the same input gives the same
    // answer" (criterion 3).
    assert.equal(
      JSON.stringify(normalizePlanFiles(inputA, fsA)),
      JSON.stringify(normalizePlanFiles(inputA, fsReversed)),
    );
  });

  test('entry order follows the declaration, not the tree', () => {
    const out = normalizePlanFiles(['libs/y', 'apps/one.ts', 'libs/x'], fsA);
    assert.deepStrictEqual(
      out.entries.map((e) => e.declared),
      ['libs/y', 'apps/one.ts', 'libs/x'],
    );
  });
});

describe('directory boundary at 0, 1 and 2 files', () => {
  // Zero and one are where an off-by-one in the recursive walk hides; two is
  // the smallest input where the sort can be observed at all.

  test('0 files: an empty directory resolves to [] and is unresolved', () => {
    const fs = makeProbe({ libs: 'dir', 'libs/empty': 'dir' });
    const out = normalizePlanFiles(['libs/empty'], fs);
    assert.equal(out.entries[0].kind, 'directory');
    assert.deepStrictEqual(out.entries[0].resolved, []);
    assert.equal(out.entries[0].unresolved, true);
    assert.equal(out.declaredNothing, false);
  });

  test('1 file: resolves to exactly that file and is resolved', () => {
    const fs = makeProbe({ libs: 'dir', 'libs/one': 'dir', 'libs/one/only.ts': 'file' });
    const out = normalizePlanFiles(['libs/one'], fs);
    assert.deepStrictEqual(out.entries[0].resolved, ['libs/one/only.ts']);
    assert.equal(out.entries[0].unresolved, false);
  });

  test('2 files: both are present and sorted regardless of listing order', () => {
    const tree = {
      libs: 'dir',
      'libs/two': 'dir',
      'libs/two/b.ts': 'file',
      'libs/two/a.ts': 'file',
    };
    const forward = normalizePlanFiles(['libs/two'], makeProbe(tree));
    const reversed = normalizePlanFiles(['libs/two'], makeProbe(tree, REVERSED));
    assert.deepStrictEqual(forward.entries[0].resolved, ['libs/two/a.ts', 'libs/two/b.ts']);
    assert.deepStrictEqual(forward, reversed);
  });

  test('a directory holding only sub-directories, none with files, resolves empty', () => {
    const fs = makeProbe({
      libs: 'dir',
      'libs/hollow': 'dir',
      'libs/hollow/deep': 'dir',
      'libs/hollow/deep/deeper': 'dir',
    });
    const out = normalizePlanFiles(['libs/hollow'], fs);
    assert.deepStrictEqual(out.entries[0].resolved, []);
    assert.equal(out.entries[0].unresolved, true);
  });
});

describe('normalizeEntries — the per-entry surface', () => {
  const fs = makeProbe(TREE);

  test('returns one entry per declaration, preserving the declared text verbatim', () => {
    const declared = ['./libs/x/', 'libs/**'];
    const entries = normalizeEntries(declared, fs);
    assert.equal(entries.length, 2);
    // `declared` is the entry exactly as the plan wrote it, so a gate can quote
    // the plan back to its author rather than a rewritten form they must map.
    assert.deepStrictEqual(
      entries.map((e) => e.declared),
      declared,
    );
  });

  test('an empty declaration list yields no entries', () => {
    assert.deepStrictEqual(normalizeEntries([], fs), []);
  });
});

// ── T-03-01: an entry or a link leaving the root is never resolved ───────────

describe('containment (T-03-01)', () => {
  const fs = makeProbe(TREE);

  test('an entry climbing above the root via .. is malformed, not a file the plan creates', () => {
    assert.equal(classifyEntry('../outside/x.ts', fs), 'malformed');
    assert.equal(classifyEntry('libs/../../x.ts', fs), 'malformed');
  });

  test('.. that stays inside the root is still a path', () => {
    assert.equal(classifyEntry('libs/x/../y/z.ts', fs), 'file');
  });

  test('an absolute entry is malformed', () => {
    assert.equal(classifyEntry('/etc/passwd', fs), 'malformed');
    assert.equal(classifyEntry('C:\\Windows\\x.ts', fs), 'malformed');
  });

  test('a walk with isSymbolicLink neither descends into nor counts a link', () => {
    const linked = {
      ...makeProbe({ ...TREE, 'libs/x/link': 'dir', 'libs/x/link/secret.ts': 'file', 'libs/x/filelink.ts': 'file' }),
      isSymbolicLink: (p) => p === 'libs/x/link' || p === 'libs/x/filelink.ts',
    };
    assert.deepEqual([...normalizePlanFiles(['libs/x'], linked).files], ['libs/x/a.ts', 'libs/x/b.ts', 'libs/x/nested/c.ts']);
  });

  test('without isSymbolicLink the walk is unchanged', () => {
    const plain = makeProbe({ ...TREE, 'libs/x/link': 'dir', 'libs/x/link/secret.ts': 'file' });
    assert.ok(normalizePlanFiles(['libs/x'], plain).files.includes('libs/x/link/secret.ts'));
  });
});
