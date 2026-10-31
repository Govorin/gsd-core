'use strict';

/**
 * ADR-5211 — automated-command-containment.cts: step 0c (#4767) as a typed
 * function. The whole #4767 corpus runs against it here, on its own; the
 * same corpus ran differentially against the frozen bash until ADR-5211 wave 4
 * (442 rows with 300 generated commands, identical verdicts).
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { cleanup } = require('./helpers.cjs');
const {
  buildAutomatedFixture, AUTOMATED_HALT_ROWS, AUTOMATED_PASS_ROWS, commandOf,
} = require('./helpers/worktree-guard-corpus.cjs');
const {
  checkAutomatedCommand, unquote, resetsCwd, normalizeLexical, restOfSimpleCommand, MAX_COMMAND_CHARS, MAX_UNWRAP_DEPTH, CONTAINMENT_CODE,
} = require('../gsd-core/bin/lib/automated-command-containment.cjs');

describe('shell-text helpers (the bash _unquote / _resets_cwd / _norm)', () => {
  for (const [raw, expected] of [
    [String.raw`"/x"/y`, '/x/y'],
    [`"O'Reilly"`, "O'Reilly"],
    [String.raw`path\ with\ space`, 'path with space'],
    [String.raw`'a\b'`, String.raw`a\b`],
    [String.raw`"a\"b"`, 'a"b'],
    ['release=main', 'release=main'],
  ]) {
    test(`unquote ${raw}`, () => assert.equal(unquote(raw), expected));
  }

  for (const [raw, expected] of [
    ['cd x & y', true], ['a | b', true], ['a && b', false], ['a || b', false],
    ["echo 'a & b'", false], ['echo "a | b"', false], [String.raw`echo a\&b`, false],
  ]) {
    test(`resetsCwd ${JSON.stringify(raw)} → ${expected}`, () => assert.equal(resetsCwd(raw), expected));
  }

  for (const [raw, expected] of [['/a/./b/../c', '/a/c'], ['/../..', '/'], ['//a//b/', '/a/b'], ['/', '/']]) {
    test(`normalizeLexical ${raw}`, () => assert.equal(normalizeLexical(raw), expected));
  }
});

describe('the #4767 corpus, verb side', { skip: process.platform === 'win32' ? 'POSIX path semantics, as the bash guard was' : false }, () => {
  let fx;
  before(() => { fx = buildAutomatedFixture(); });
  after(() => cleanup(fx.tmp));
  const roots = () => ({ worktreeRoot: fx.wt, mainRoot: fx.main });

  for (const row of AUTOMATED_HALT_ROWS) {
    test(`halts on ${row[0]}`, () => {
      const v = checkAutomatedCommand(commandOf(row, fx), roots());
      assert.equal(v.ok, false);
      assert.ok([CONTAINMENT_CODE.RELOCATES_OUTSIDE_WORKTREE, CONTAINMENT_CODE.NAMES_MAIN_CHECKOUT].includes(v.code), v.code);
    });
  }
  for (const row of AUTOMATED_PASS_ROWS) {
    test(`passes ${row[0]}`, () => {
      const v = checkAutomatedCommand(commandOf(row, fx), roots());
      assert.equal(v.ok, true, JSON.stringify(v));
      assert.equal(v.code, CONTAINMENT_CODE.OK);
    });
  }

  test('a relocation names the word as written and where it lands', () => {
    const v = checkAutomatedCommand('cd ../main && ls', roots());
    assert.equal(v.code, CONTAINMENT_CODE.RELOCATES_OUTSIDE_WORKTREE);
    assert.equal(v.target, '../main');
    assert.equal(v.resolved, fx.main);
    assert.equal(v.via, 'cd');
  });

  test('a command length boundary: limit - 1 and limit are scanned, limit + 1 is refused', () => {
    const pad = (n) => `ls ${'a'.repeat(n - 3)}`;
    assert.equal(checkAutomatedCommand(pad(MAX_COMMAND_CHARS - 1), roots()).code, CONTAINMENT_CODE.OK);
    assert.equal(checkAutomatedCommand(pad(MAX_COMMAND_CHARS), roots()).code, CONTAINMENT_CODE.OK);
    assert.equal(checkAutomatedCommand(pad(MAX_COMMAND_CHARS + 1), roots()).code, CONTAINMENT_CODE.COMMAND_TOO_LARGE);
  });

  test('the unwrap depth bound: limit - 1 and limit scan, limit + 1 refuses unwrap_too_deep', () => {
    const evals = (n) => `${'eval '.repeat(n)}ls`;
    assert.equal(checkAutomatedCommand(evals(MAX_UNWRAP_DEPTH - 1), roots()).code, CONTAINMENT_CODE.OK);
    assert.equal(checkAutomatedCommand(evals(MAX_UNWRAP_DEPTH), roots()).code, CONTAINMENT_CODE.OK);
    assert.equal(checkAutomatedCommand(evals(MAX_UNWRAP_DEPTH + 1), roots()).code, CONTAINMENT_CODE.UNWRAP_TOO_DEEP);
    // An interpreter payload shares the bound: `sh -c` reached at depth limit - 1 unwraps, at limit refuses.
    assert.equal(checkAutomatedCommand(`${'eval '.repeat(MAX_UNWRAP_DEPTH - 1)}sh -c ls`, roots()).code, CONTAINMENT_CODE.OK);
    assert.equal(checkAutomatedCommand(`${'eval '.repeat(MAX_UNWRAP_DEPTH)}sh -c ls`, roots()).code, CONTAINMENT_CODE.UNWRAP_TOO_DEEP);
  });

  test('restOfSimpleCommand stops at the first unquoted boundary', () => {
    assert.equal(restOfSimpleCommand(" ../m 'a;b' && ls"), " ../m 'a;b' ");
    assert.equal(restOfSimpleCommand(' x | y'), ' x ');
    assert.equal(restOfSimpleCommand(' x\\;y; z'), ' x\\;y');
  });

  test('a NUL byte is refused, never scanned', () => {
    assert.equal(checkAutomatedCommand('ls\0cd ../main', roots()).code, CONTAINMENT_CODE.COMMAND_INVALID);
  });

  test('a relative root is an internal refusal, never a pass', () => {
    const v = checkAutomatedCommand('ls', { worktreeRoot: 'wt', mainRoot: fx.main });
    assert.equal(v.ok, false);
    assert.equal(v.code, CONTAINMENT_CODE.INTERNAL_ERROR);
  });
});
