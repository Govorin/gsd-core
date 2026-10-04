#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Test Tamper Guard — PreToolUse hook (mn fork)
//
// Problem: the cheapest way to make a red suite green is to delete the check.
// This is not hypothetical for coding agents — it is the measured shape of
// reward hacking in them (SpecBench, arXiv 2605.21384: the visible/hidden test
// gap widens ~28 points per 10× of code size; RHB, arXiv 2605.02964, evaluates
// read-only test directories as the practical defence). Anthropic's own
// long-running-harness guidance states the rule flatly in its feature list:
// "unacceptable to remove or edit tests".
//
// This fork already owns the after-the-fact half: `assertion-ratchet.mjs`
// compares live assertion counts against `.planning/assertion-baseline.json` at
// verify:pre. That catches the deletion after it is committed. This guard
// catches it at the write, where the answer is "no" instead of "revert" — and
// it reuses exactly the same notion of an assertion, so the two cannot disagree
// about what counts.
//
// Scope: existing test files only. Creating a test file is always allowed
// (there is nothing to weaken), and non-test files are none of this guard's
// business.
//
// What blocks (`workflow.test_tamper_guard`, default "off"; "ask" | "deny"):
//   • the write removes assertions — the pending content holds strictly fewer
//     than the file on disk,
//   • the write newly skips tests — `.skip`, `xit`, `xdescribe`, `t.skip`,
//     `test.todo` appear where they did not before,
//   • the write empties a test file (all assertions gone).
//
// What never blocks, because each is legitimate and blocking it would train
// people to disable the guard:
//   • adding assertions, or holding the count level while restructuring,
//   • deleting a test file outright (that is a different tool and a different
//     decision — the ratchet reports it at verify:pre),
//   • any write when the file is declared in the running plan AND the plan
//     declares the removal in its own deviation notes… which cannot be
//     verified here, so instead: a declared file lowers nothing by itself. The
//     guard applies equally to declared and undeclared test files, because
//     "the plan said I could touch this file" is not "the plan said I could
//     delete its checks". The escape hatch is the mode, not the declaration.
//
// Fail-open: not a GSD project, guard off, unreadable payload, or a file that
// cannot be read → allow. Fail-closed is deliberately NOT used here: unlike
// scope guarding, a read error on a source file is a poor reason to refuse a
// write, and the ratchet still backstops at verify:pre.

'use strict';

const fs = require('fs');
const path = require('path');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');

const MODE_OFF = 'off';
const MODE_ASK = 'ask';
const MODE_DENY = 'deny';
const VALID_MODES = new Set([MODE_OFF, MODE_ASK, MODE_DENY]);

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

/**
 * Is this a test file?
 *
 * Covers the conventions in play across this fork's own projects: `*.spec.ts`
 * (1,935 files in mn, the house convention), `*.test.cjs` (this repo's own),
 * and anything under a `tests/` or `__tests__/` directory.
 */
function isTestFile(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (/(^|\/)(tests?|__tests__)\//.test(p)) return true;
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(p);
}

/**
 * Count live assertions.
 *
 * Same vocabulary as capabilities/mn-verify-gate/scripts/assertion-ratchet.mjs,
 * so a write this guard permits cannot fail the ratchet for the reason the
 * guard just cleared. Comment-only lines are excluded: a commented-out
 * assertion is a deleted assertion, and counting it would let the deletion
 * through disguised as a comment.
 */
/**
 * Remove commented-out code from one line, in both comment syntaxes.
 *
 * Commenting a check out in place is the ordinary way to disable it, and both
 * forms occur:
 *
 *     // expect(x).toBe(1);
 *     it('c', () => { [slash-star] expect(x).toBe(1); [star-slash] });
 *
 * A line-comment-only strip misses the second, which a behavioural eval case
 * caught after the unit tests were green — the block form left the assertion
 * counted as live and let the deletion through disguised as a comment.
 *
 * Inline block comments are removed first (so what they contained cannot be
 * counted), then an unterminated block opener and everything after it, then
 * the line comment. A `//` inside a string literal is stripped too; that loses
 * nothing, since an assertion never lives after one on the same line.
 */
function stripComments(rawLine) {
  return rawLine
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\*.*$/, ' ')
    .split('//')[0];
}

function countAssertions(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComments(rawLine).trim();
    // A continuation line of a multi-line block comment (` * expect(...)`)
    // carries no live code either.
    if (!line || line.startsWith('*')) continue;
    // One assertion per matcher CHAIN, not per token. `expect(x).toBe(1)` is a
    // single assertion; counting the `expect(` and the `.toBe(` separately
    // doubles every Jest-style file and makes the before/after numbers in the
    // block message meaningless. Chained matchers therefore only count when
    // they are NOT preceded by an `expect(` on the same line — which is the
    // `assert`-free bare-matcher style some suites use.
    let matched = 0;
    const heads = line.match(/\b(?:expect|assert|should)\s*[(.]/g);
    if (heads) matched += heads.length;
    if (!heads) {
      const bare = line.match(/\.(?:toBe[A-Za-z]*|toEqual|toThrow[A-Za-z]*|toMatch[A-Za-z]*)\s*\(/g);
      if (bare) matched += bare.length;
    }
    count += matched;
  }
  return count;
}

/** Count skip/todo markers, which silence a test without deleting it. */
function countSkips(text) {
  if (typeof text !== 'string') return 0;
  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComments(rawLine).trim();
    if (!line || line.startsWith('*')) continue;
    const matches = line.match(
      /\b(?:it|test|describe|context)\.(?:skip|todo|failing)\b|\bx(?:it|describe|test)\s*\(|\bt\.skip\s*\(|\.skip\s*\(\s*['"`]/g
    );
    if (matches) count += matches.length;
  }
  return count;
}

function findPlanningRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    if (fs.existsSync(path.join(dir, '.planning'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function readMode(planningRoot) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(planningRoot, '.planning', 'config.json'), 'utf8')
    );
    const value = cfg && cfg.workflow ? cfg.workflow.test_tamper_guard : undefined;
    if (typeof value !== 'string') return MODE_OFF;
    const normalized = value.trim().toLowerCase();
    return VALID_MODES.has(normalized) ? normalized : MODE_OFF;
  } catch {
    return MODE_OFF;
  }
}

/**
 * Project the post-write content of the file.
 *
 * `Write` carries the whole file. `Edit`/`MultiEdit` carry replacements, which
 * are applied to the on-disk text so the comparison is against what the file
 * will actually contain — comparing against the fragment alone would read every
 * small edit as a mass deletion.
 *
 * Returns null when the projection cannot be made, which the caller treats as
 * "nothing to judge" rather than as a violation.
 */
function projectContent(toolName, toolInput, onDisk) {
  if (!toolInput || typeof toolInput !== 'object') return null;

  if (toolName === 'Write') {
    return typeof toolInput.content === 'string' ? toolInput.content : null;
  }

  const applyOne = (text, oldString, newString, replaceAll) => {
    if (typeof oldString !== 'string' || typeof newString !== 'string') return text;
    if (oldString === '') return text;
    if (replaceAll) return text.split(oldString).join(newString);
    const at = text.indexOf(oldString);
    return at === -1 ? text : text.slice(0, at) + newString + text.slice(at + oldString.length);
  };

  if (toolName === 'Edit') {
    return applyOne(onDisk, toolInput.old_string, toolInput.new_string, toolInput.replace_all === true);
  }

  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(toolInput.edits) ? toolInput.edits : null;
    if (!edits) return null;
    let text = onDisk;
    for (const edit of edits) {
      if (!edit || typeof edit !== 'object') continue;
      text = applyOne(text, edit.old_string, edit.new_string, edit.replace_all === true);
    }
    return text;
  }

  return null;
}

/**
 * Decide one PreToolUse payload. Pure; the testable core.
 *
 * Returns `{ action: 'allow' }` or
 * `{ action: 'ask' | 'deny', reason, before, after, skipsBefore, skipsAfter }`.
 */
function evaluateTestWrite(data, options = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow' };
  if (!WRITE_TOOLS.has(data.tool_name)) return { action: 'allow' };

  const toolInput = data.tool_input;
  const rawPath =
    toolInput && typeof toolInput === 'object' && typeof toolInput.file_path === 'string'
      ? toolInput.file_path
      : '';
  if (!rawPath) return { action: 'allow' };

  const cwd = options.cwd || data.cwd || process.cwd();
  const planningRoot = findPlanningRoot(cwd);
  if (!planningRoot) return { action: 'allow' };

  const mode = readMode(planningRoot);
  if (mode === MODE_OFF) return { action: 'allow' };

  const absolute = path.resolve(cwd, rawPath);
  const relative = path.relative(planningRoot, absolute).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../')) return { action: 'allow' };
  if (!isTestFile(relative)) return { action: 'allow' };

  let onDisk;
  try {
    onDisk = fs.readFileSync(absolute, 'utf8');
  } catch {
    // No file on disk: this is a new test, and a new test weakens nothing.
    // An unreadable existing file also lands here; the ratchet backstops it.
    return { action: 'allow' };
  }

  const after = projectContent(data.tool_name, toolInput, onDisk);
  if (typeof after !== 'string') return { action: 'allow' };

  const before = countAssertions(onDisk);
  const afterCount = countAssertions(after);
  const skipsBefore = countSkips(onDisk);
  const skipsAfter = countSkips(after);

  const losesAssertions = afterCount < before;
  const addsSkips = skipsAfter > skipsBefore;
  if (!losesAssertions && !addsSkips) return { action: 'allow' };

  const parts = [];
  if (losesAssertions) parts.push(`assertions ${before} → ${afterCount}`);
  if (addsSkips) parts.push(`skipped tests ${skipsBefore} → ${skipsAfter}`);

  const reason =
    `Test tamper guard: this write weakens '${relative}' (${parts.join(', ')}). ` +
    `Removing a check is the cheapest way to turn a suite green and the one failure a green ` +
    `suite cannot report. If the assertion is genuinely obsolete — the behaviour it pinned was ` +
    `deliberately removed — say so in the plan's deviation notes and re-record the baseline ` +
    `(gsd_run mn assertion-baseline); the ratchet at verify:pre reads the same counts this ` +
    `guard just read. If it is failing, fix the code it is testing instead.`;

  return {
    action: mode === MODE_DENY ? 'deny' : 'ask',
    reason,
    targetPath: relative,
    assertionsBefore: before,
    assertionsAfter: afterCount,
    skipsBefore,
    skipsAfter,
  };
}

/**
 * The ask path exits 0, where stderr is deny-only for terminateNow; the reason
 * still goes to fd 2 as it always has, so the transcript shows why the user was
 * asked. Best-effort: a failed write never changes the outcome.
 */
function emitAskReason(reason) {
  try {
    if (typeof reason === 'string' && reason) fs.writeSync(2, reason);
  } catch {
    /* the decision stands regardless */
  }
}

/* istanbul ignore next -- stdin adapter, exercised via the process seam in tests */
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => allow(undefined), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    let decision;
    try {
      decision = evaluateTestWrite(JSON.parse(input));
    } catch {
      crash(HOOK_ON_CRASH.ALLOW, undefined);
    }
    if (!decision || decision.action === 'allow') allow(undefined);

    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.action === 'deny' ? 'deny' : 'ask',
        permissionDecisionReason: decision.reason,
      },
      decision: decision.action === 'deny' ? 'block' : undefined,
      targetPath: decision.targetPath,
      assertionsBefore: decision.assertionsBefore,
      assertionsAfter: decision.assertionsAfter,
      skipsBefore: decision.skipsBefore,
      skipsAfter: decision.skipsAfter,
      reason: decision.reason,
    };
    if (decision.action === 'deny') deny(output, decision.reason);
    emitAskReason(decision.reason);
    allow(output);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateTestWrite,
  countAssertions,
  countSkips,
  isTestFile,
  projectContent,
};
