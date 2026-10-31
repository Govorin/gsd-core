'use strict';

/**
 * ADR-5211 — posix-ere.cts: POSIX EREs with grep's leftmost-LONGEST semantics.
 * The step 0c port depends on this engine choosing the same match grep does
 * where JavaScript's leftmost-FIRST RegExp would not.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { compileEre, matchAllInLine, grepOnlyMatching, matchPrefix, deleteFirstMatch } = require('../gsd-core/bin/lib/posix-ere.cjs');

describe('leftmost-longest, not leftmost-first', () => {
  test('a later, longer alternative wins (JS RegExp would take the first)', () => {
    assert.equal(/a|ab/.exec('ab')[0], 'a', 'control: JS is leftmost-first');
    assert.deepEqual(grepOnlyMatching('a|ab', 'ab'), ['ab']);
  });

  test('the overall match is longest even through a lazy-looking alternation inside a repeat', () => {
    // `\\.` vs a bare class that also admits a backslash: the longest token wins.
    assert.deepEqual(grepOnlyMatching(String.raw`(\\.|[^ "])+`, String.raw`a\ b`), [String.raw`a\ b`]);
  });

  test('leftmost beats longest: a match starting earlier wins over a longer later one', () => {
    assert.deepEqual(matchAllInLine('b|abcd', 'xbabcd').map((m) => m.text), ['b', 'abcd']);
  });
});

describe('grep -o semantics', () => {
  test('non-overlapping matches, resuming at the end of each', () => {
    assert.deepEqual(grepOnlyMatching('aa', 'aaaaa'), ['aa', 'aa']);
  });

  test('every line is scanned and ^ anchors at each line start', () => {
    assert.deepEqual(grepOnlyMatching('^x', 'xa\nbx\nx'), ['x', 'x']);
  });

  test('an empty match prints nothing', () => {
    assert.deepEqual(grepOnlyMatching('a*', 'bbb'), []);
  });

  test('matchPrefix only accepts a match at offset 0', () => {
    assert.equal(matchPrefix('^ab', 'abc'), 'ab');
    assert.equal(matchPrefix('^b', 'abc'), null);
  });

  test('deleteFirstMatch removes only the first match (sed without g)', () => {
    assert.equal(deleteFirstMatch('[0-9]+', 'a12b34'), 'ab34');
    assert.equal(deleteFirstMatch('^(&&|&)?[[:space:]]*', '&& x'), 'x');
  });
});

describe('bracket expressions', () => {
  test('classes, ranges, negation, literal ] first and - last', () => {
    assert.deepEqual(grepOnlyMatching('[[:space:]]+', 'a \t b'), [' \t ']);
    assert.deepEqual(grepOnlyMatching('[a-c]+', 'xabcd'), ['abc']);
    assert.deepEqual(grepOnlyMatching('[^a]+', 'aaxyaa'), ['xy']);
    assert.deepEqual(grepOnlyMatching('[]x]+', 'a]x]b'), [']x]']);
    assert.deepEqual(grepOnlyMatching('[a-]+', 'b-a-b'), ['-a-']);
    assert.deepEqual(grepOnlyMatching('[|][|]|[(]', 'a||(b'), ['||', '(']);
  });

  test('characters are code points, as under a UTF-8 locale', () => {
    assert.deepEqual(grepOnlyMatching('[^ ]', 'é'), ['é']);
    assert.deepEqual(grepOnlyMatching('.', '😀'), ['😀'], 'a surrogate pair is one character');
  });
});

describe('malformed patterns are refused at compile time', () => {
  for (const pattern of ['(a', 'a)', '[a', '[[:nope:]]', '*a', '[z-a]']) {
    test(`refuses ${JSON.stringify(pattern)}`, () => {
      assert.throws(() => compileEre(pattern));
    });
  }
});
