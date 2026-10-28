'use strict';

/**
 * src/retro-signals.cts — deterministic friction signals for /gsd-retro.
 *
 * Transcripts are synthetic: built as typed events for the threshold matrix
 * (every `*_min` at -1 / = / +1, `signal_threshold` and `max_signals` at their
 * boundaries) and as a JSONL fixture for one end-to-end pass through
 * session-transcript. Planning evidence comes from a temp project; git
 * evidence from an injected runner and from one real repository with a
 * revert commit, both through the seam.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, createTempGitProject, cleanup } = require('./helpers.cjs');
const { runGit, OUTCOME } = require('./helpers/process-seam.cjs');

const rs = require('../gsd-core/bin/lib/retro-signals.cjs');
const st = require('../gsd-core/bin/lib/session-transcript.cjs');

// ─── Synthetic transcript builder ─────────────────────────────────────────────

function builder(file = 'main.jsonl', opts = {}) {
  const events = [];
  let line = 0;
  let ids = 0;
  const ptr = (f = file) => ({ session: 'sess', file: f, line: ++line, uuid: `uuid-${line}`, timestamp: null, ...(opts.agentId ? { agentId: opts.agentId } : {}) });
  const api = {
    events,
    prompt(text) { events.push({ kind: 'user-prompt', ptr: ptr(), text }); return api; },
    interrupt() { events.push({ kind: 'user-interrupt', ptr: ptr(), duringToolUse: false }); return api; },
    say(text) { events.push({ kind: 'assistant-text', ptr: ptr(), text }); return api; },
    call(tool, input, result = { ok: true }) {
      const id = `t${++ids}`;
      events.push({ kind: 'tool-use', ptr: ptr(), toolUseId: id, tool, input });
      events.push({
        kind: 'tool-result', ptr: ptr(), toolUseId: id, tool, isError: !result.ok, text: result.text ?? '',
        blockedBy: result.blockedBy ?? null, denial: result.denial ?? null,
      });
      return api;
    },
    hook(outcome, extra = {}) {
      events.push({ kind: 'hook', ptr: ptr(), event: 'PreToolUse', hook: null, tool: 'Bash', outcome, text: 'Blocked: sleep 60 followed by: cat', ...extra });
      return api;
    },
    compact() { events.push({ kind: 'compaction', ptr: ptr() }); return api; },
    transcript() {
      return { status: 'ok', reason: null, runtime: 'claude', session: 'sess', events, files: [{ file, agentId: null, agentType: null, stats: { truncatedBytes: false, truncatedEvents: false, oversizeLines: 0, malformedLines: 0 }, recognisedRecords: 1 }], toolResults: { count: 0, bytes: 0 } };
    },
  };
  return api;
}

const signalsOf = (report, kind) => report.signals.filter((s) => s.kind === kind);
const run = (b, thresholds) => rs.computeRetroSignals({ transcript: b.transcript(), thresholds });

// ─── Thresholds ───────────────────────────────────────────────────────────────

describe('resolveRetroThresholds', () => {
  test('defaults when config is absent', () => {
    const { thresholds, problems } = rs.resolveRetroThresholds(undefined);
    assert.deepEqual(thresholds, { ...rs.DEFAULT_RETRO_THRESHOLDS });
    assert.deepEqual(problems, []);
  });

  test('nested and flat keys are read; nested wins', () => {
    const { thresholds } = rs.resolveRetroThresholds({ retro: { signal_threshold: 12 }, 'retro.signal_threshold': 3, 'retro.reread_min': 5 });
    assert.equal(thresholds.signalThreshold, 12);
    assert.equal(thresholds.rereadMin, 5);
  });

  test('an invalid value keeps the default and is named', () => {
    const { thresholds, problems } = rs.resolveRetroThresholds({ retro: { repeat_call_min: 0, max_signals: 'many', signal_threshold: 0 } });
    assert.equal(thresholds.repeatCallMin, rs.DEFAULT_RETRO_THRESHOLDS.repeatCallMin);
    assert.equal(thresholds.maxSignals, rs.DEFAULT_RETRO_THRESHOLDS.maxSignals);
    assert.equal(thresholds.signalThreshold, 0, 'signal_threshold 0 is legal: always suggest');
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /retro\.repeat_call_min must be an integer >= 1/);
  });

  test('config problems surface in the report reasons', () => {
    const report = rs.computeRetroSignals({ transcript: builder().transcript(), config: { retro: { reread_min: -1 } } });
    assert.match(report.reasons.join('\n'), /retro\.reread_min/);
  });
});

// ─── Repetition thresholds: -1 / = / +1 ───────────────────────────────────────

function boundary(name, kind, min, thresholdKey, build) {
  describe(`${kind} at ${thresholdKey} boundary`, () => {
    for (const [count, expected] of [[min - 1, null], [min, 1], [min + 1, 2]]) {
      test(`${count} occurrence(s) with min ${min} → ${expected === null ? 'no signal' : `score ×${expected}`}`, () => {
        const b = builder();
        build(b, count);
        const report = run(b, { [thresholdKey]: min });
        const found = signalsOf(report, kind);
        if (expected === null) {
          assert.equal(found.length, 0, `${name}: no signal below the threshold`);
        } else {
          assert.equal(found.length, 1, `${name}: one aggregated signal`);
          assert.equal(found[0].count, count);
          assert.equal(found[0].score, rs.SIGNAL_WEIGHTS[kind] * expected);
        }
      });
    }
  });
}

boundary('identical call', 'repeated-call', 3, 'repeatCallMin', (b, n) => {
  for (let i = 0; i < n; i++) b.call('Bash', { command: 'git status --short' });
});
boundary('same tool error', 'repeated-tool-error', 2, 'repeatErrorMin', (b, n) => {
  for (let i = 0; i < n; i++) b.call('Bash', { command: `npm test -- --grep case${i}` }, { ok: false, text: 'Exit code 1\nnot ok 1 parser' });
  // A different error never joins the group.
  b.call('Bash', { command: 'npm test' }, { ok: false, text: 'Exit code 2\nsyntax error' });
});
boundary('reread', 'reread', 3, 'rereadMin', (b, n) => {
  for (let i = 0; i < n; i++) b.call('Read', { file_path: '/p/a.ts' });
});
boundary('rewrite of own lines', 'edit-churn', 4, 'editChurnMin', (b, n) => {
  // One edit writes the line, then each of n edits rewrites what the last one wrote.
  b.call('Edit', { file_path: '/p/a.ts', old_string: 'export {};', new_string: 'const value = compute(0);' });
  for (let i = 1; i <= n; i++) b.call('Edit', { file_path: '/p/a.ts', old_string: `const value = compute(${i - 1});`, new_string: `const value = compute(${i});` });
});
boundary('plan-checker loop', 'plan-checker-loop', 2, 'checkerLoopMin', (b, n) => {
  for (let i = 0; i < n; i++) b.call('Agent', { subagent_type: 'gsd-plan-checker', prompt: `check round ${i}` });
});
boundary('checkpoint', 'repeated-checkpoint', 2, 'checkpointMin', (b, n) => {
  for (let i = 0; i < n; i++) b.say(`## CHECKPOINT REACHED\nround ${i}`);
});
boundary('hook block', 'hook-block', 2, 'hookBlockMin', (b, n) => {
  for (let i = 0; i < n; i++) b.hook('blocked', { text: `<tool_use_error>Blocked: sleep ${30 + i} followed by: cat` });
});

describe('nav-streak at navStreakMin boundary', () => {
  for (const [count, expected] of [[4, 0], [5, 1], [6, 1]]) {
    test(`${count} navigation calls in a row with min 5 → ${expected} streak signal(s)`, () => {
      const b = builder();
      for (let i = 0; i < count; i++) b.call(i % 2 ? 'Grep' : 'Glob', { pattern: `p${i}` });
      b.call('Edit', { file_path: '/p/x.ts', old_string: 'a', new_string: 'b' });
      const found = signalsOf(run(b, { navStreakMin: 5 }), 'nav-streak');
      assert.equal(found.length, expected);
      if (expected) assert.equal(found[0].key, `${count} navigation calls in a row`);
    });
  }

  test('an edit resets the streak; a trailing streak is still closed at the end', () => {
    const b = builder();
    for (let i = 0; i < 4; i++) b.call('Grep', { pattern: `a${i}` });
    b.call('Write', { file_path: '/p/y.ts', content: 'x' });
    for (let i = 0; i < 5; i++) b.call('Bash', { command: `rg needle${i} src` });
    const found = signalsOf(run(b, { navStreakMin: 5 }), 'nav-streak');
    assert.equal(found.length, 1);
    assert.equal(found[0].pointers.length, 2, 'first and last call of the streak');
  });
});

describe('repetition is per transcript file', () => {
  test('the same call once in each of three subagents is not a repetition', () => {
    const events = [];
    for (const f of ['a.jsonl', 'b.jsonl', 'c.jsonl']) events.push(...builder(f).call('ToolSearch', { query: 'select:Monitor' }).events);
    const t = builder().transcript();
    t.events = events;
    assert.equal(signalsOf(rs.computeRetroSignals({ transcript: t }), 'repeated-call').length, 0);
  });

  test('reads separated by an edit of the same file do not accumulate', () => {
    const b = builder();
    b.call('Read', { file_path: '/p/a.ts' }).call('Read', { file_path: '/p/a.ts' });
    b.call('Edit', { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' });
    b.call('Read', { file_path: '/p/a.ts' }).call('Read', { file_path: '/p/a.ts' });
    assert.equal(signalsOf(run(b, { rereadMin: 3 }), 'reread').length, 0);
  });

  test('calls that differ past the display cap are not merged', () => {
    const b = builder();
    const prefix = 'x'.repeat(300);
    for (let i = 0; i < 3; i++) b.call('Bash', { command: `${prefix} ${i}` });
    assert.equal(signalsOf(run(b, { repeatCallMin: 3 }), 'repeated-call').length, 0);
  });
});

// ─── Instance signals ─────────────────────────────────────────────────────────

describe('instance signals', () => {
  test('user corrections in Russian and English; ordinary prompts are not corrections', () => {
    for (const text of ['нет, не так', 'Стоп. Откати это', 'не надо заводить issue', 'я же сказал — без моков', 'No, that is wrong', "don't touch the config", 'wait', 'ещё раз: только чтение']) {
      assert.equal(rs.isCorrection(text), true, text);
    }
    for (const text of ['Сделай ревью', 'нетривиальная задача', 'add a test for the parser', 'Notes on the design', 'stopwatch module is slow']) {
      assert.equal(rs.isCorrection(text), false, text);
    }
  });

  test('every instance kind is detected from its event shape', () => {
    const b = builder();
    b.prompt('нет, не то');
    b.interrupt();
    b.call('Edit', { file_path: '/p/a.ts' }, { ok: false, text: "The user doesn't want to proceed", denial: 'user-rejected', blockedBy: 'denial' });
    b.call('Bash', { command: 'cat .env' }, { ok: false, text: 'Permission to use Bash has been denied', denial: 'permission-rule', blockedBy: 'denial' });
    // The rejected edit above changed nothing; this one is an own edit the reset throws away.
    b.call('Edit', { file_path: '/p/b.ts', old_string: 'x', new_string: 'y' });
    b.call('Bash', { command: 'git reset --hard HEAD~1' });
    b.call('Bash', { command: 'git restore --staged a.ts' });
    b.say('[Node Repair - RETRY] Task 3: widened the timeout');
    b.call('Agent', { subagent_type: 'gsd-verifier' }, { ok: true, text: '## Verification\nstatus: gaps_found' });
    b.hook('timed-out', { event: 'UserPromptSubmit', tool: null });
    b.events.push({ kind: 'api-error', ptr: { session: 'sess', file: 'main.jsonl', line: 900, uuid: null, timestamp: null }, text: 'API Error: overloaded' });
    b.events.push({ kind: 'compaction', ptr: { session: 'sess', file: 'main.jsonl', line: 901, uuid: null, timestamp: null } });
    const report = run(b);
    const kinds = Object.fromEntries(Object.entries(report.countsByKind));
    assert.deepEqual(kinds, {
      'user-correction': 1, 'user-interrupt': 1, 'tool-rejected': 1, 'permission-denial': 1, 'revert': 1,
      'node-repair': 1, 'gaps-found': 1, 'hook-error': 1, 'api-error': 1, 'compaction': 1,
    });
    assert.equal(signalsOf(report, 'revert')[0].key, 'git reset --hard HEAD~1', '`git restore --staged` is not a revert');
    assert.equal(signalsOf(report, 'node-repair')[0].key, 'RETRY');
    assert.equal(signalsOf(report, 'repeated-tool-error').length, 0, 'denials are not tool errors');
  });
});

// ─── Score, suggest, max_signals ──────────────────────────────────────────────

describe('signal_threshold boundary', () => {
  // Three corrections = score 9 (weight 3 each).
  const threeCorrections = () => builder().prompt('нет').prompt('нет').prompt('нет');
  for (const [threshold, suggest] of [[8, true], [9, true], [10, false]]) {
    test(`score 9 against threshold ${threshold} → suggest ${suggest}`, () => {
      const report = run(threeCorrections(), { signalThreshold: threshold });
      assert.equal(report.score, 9);
      assert.equal(report.threshold, threshold);
      assert.equal(report.suggest, suggest);
    });
  }

  test('a smooth session scores 0 and stays silent', () => {
    const b = builder().prompt('add a parser test').call('Read', { file_path: '/p/a.ts' }).call('Edit', { file_path: '/p/a.ts' });
    const report = run(b);
    assert.equal(report.score, 0);
    assert.equal(report.suggest, false);
    assert.deepEqual(report.signals, []);
  });
});

describe('max_signals boundary', () => {
  const nCorrections = (n) => {
    const b = builder();
    for (let i = 0; i < n; i++) b.prompt(`нет ${i}`);
    return b;
  };
  for (const [n, kept, omitted] of [[2, 2, 0], [3, 3, 0], [4, 3, 1]]) {
    test(`${n} signals with max 3 → ${kept} listed, ${omitted} omitted`, () => {
      const report = run(nCorrections(n), { maxSignals: 3, kindCap: 100 });
      assert.equal(report.signals.length, kept);
      assert.equal(report.omitted.length, omitted);
      assert.equal(report.score, 3 * n, 'the list cap never lowers the score');
      assert.equal(report.rawScore, 3 * n);
    });
  }

  test('what was cut is enumerated by id and kind', () => {
    const report = run(nCorrections(5), { maxSignals: 3 });
    const all = run(nCorrections(5), { maxSignals: 100 });
    assert.deepEqual(report.omitted.map((o) => o.id), all.signals.slice(3).map((s) => s.id));
    assert.ok(report.omitted.every((o) => o.kind === 'user-correction' && o.score === 3));
  });
});

// ─── Session score: saturation and volume ─────────────────────────────────────

describe('kind_cap boundary', () => {
  // Corrections weigh 3; with the cap at 3 units the kind tops out at 9.
  for (const [n, score] of [[2, 6], [3, 9], [4, 9]]) {
    test(`${n} corrections with kind_cap 3 → score ${score}`, () => {
      const b = builder();
      for (let i = 0; i < n; i++) b.prompt(`нет ${i}`);
      const report = run(b, { kindCap: 3 });
      assert.equal(report.score, score);
      assert.equal(report.scoreByKind['user-correction'], score);
      assert.equal(report.rawScore, 3 * n, 'the raw sum is uncapped');
    });
  }
});

describe('volume_turns boundary', () => {
  // Two corrections (6) among N user turns, reference 10: a rate only past 10 turns.
  for (const [turns, score] of [[9, 6], [10, 6], [11, 5.45]]) {
    test(`2 corrections in ${turns} turns with volume_turns 10 → score ${score}`, () => {
      const b = builder().prompt('нет').prompt('нет');
      for (let i = 2; i < turns; i++) b.prompt(`add case ${i}`);
      const report = run(b, { volumeTurns: 10 });
      assert.equal(report.volume.userTurns, turns);
      assert.equal(report.score, score);
    });
  }
});

describe('volume_calls boundary', () => {
  // Two hook errors (weight 1) among N tool calls, reference 10.
  for (const [calls, score] of [[9, 2], [10, 2], [11, 1.82]]) {
    test(`2 hook errors in ${calls} tool calls with volume_calls 10 → score ${score}`, () => {
      const b = builder().hook('timed-out', { text: 'slow' }).hook('timed-out', { text: 'slow' });
      for (let i = 0; i < calls; i++) b.call('Bash', { command: `npm run step${i}` });
      const report = run(b, { volumeCalls: 10 });
      assert.equal(report.volume.toolCalls, calls);
      assert.equal(report.score, score);
    });
  }

  test('a main-only kind is diluted by main calls only; an environment kind by every call', () => {
    const main = builder();
    for (let i = 0; i < 3; i++) main.call('Bash', { command: 'git push origin main' });
    main.hook('timed-out', { text: 'slow' }).hook('timed-out', { text: 'slow' });
    const sub = builder('sub/agent-a.jsonl', { agentId: 'a' });
    for (let i = 0; i < 20; i++) sub.call('Bash', { command: `npm run step${i}` });
    const t = main.transcript();
    t.events = [...main.events, ...sub.events];
    const report = rs.computeRetroSignals({ transcript: t, thresholds: { volumeCalls: 10 } });
    assert.deepEqual(report.volume, { userTurns: 0, mainToolCalls: 3, toolCalls: 23 });
    assert.equal(report.scoreByKind['repeated-call'], 1, '3 main calls ≤ 10: counted as is');
    assert.equal(report.scoreByKind['hook-error'], 0.87, '2 × 10/23');
  });

  test('a long session with the same rate of friction scores the same as a reference-length one', () => {
    const at = (calls) => {
      const b = builder();
      for (let i = 0; i < calls / 100; i++) b.hook('timed-out', { text: 'slow' });
      for (let i = 0; i < calls; i++) b.call('Bash', { command: `npm run step${i}` });
      return run(b, { volumeCalls: 300, kindCap: 100 }).score;
    };
    assert.equal(at(300), 3);
    assert.equal(at(3000), 3, 'ten times the session, ten times the hook errors: the same score');
  });
});

// ─── Regressions: false positives found on real sessions ──────────────────────

describe('nav-streak: navigation with progress in between is not a streak', () => {
  test('reads interleaved with commands and spawned agents never accumulate (no edit needed)', () => {
    const b = builder();
    for (let i = 0; i < 12; i++) {
      b.call('Read', { file_path: `/p/f${i}.ts` });
      b.call(i % 2 ? 'Agent' : 'Bash', i % 2 ? { subagent_type: 'gsd-executor', prompt: `task ${i}` } : { command: `npm test -- f${i}` });
    }
    assert.equal(signalsOf(run(b, { navStreakMin: 5 }), 'nav-streak').length, 0);
  });

  test('structural MCP navigation is navigation; a serena edit or a user turn ends the streak', () => {
    const nav = (b, n) => {
      for (let i = 0; i < n; i++) {
        b.call(i % 2 ? 'mcp__plugin_serena_serena__find_symbol' : 'mcp__codebase-memory-mcp__search_graph', { name_path: `s${i}` });
      }
    };
    const streak = builder();
    nav(streak, 5);
    assert.equal(signalsOf(run(streak, { navStreakMin: 5 }), 'nav-streak').length, 1);
    const edited = builder();
    nav(edited, 3);
    edited.call('mcp__plugin_serena_serena__replace_symbol_body', { relative_path: 'src/a.ts', body: 'x' });
    nav(edited, 3);
    edited.prompt('продолжай');
    nav(edited, 3);
    assert.equal(signalsOf(run(edited, { navStreakMin: 5 }), 'nav-streak').length, 0);
  });
});

describe('revert: only own uncommitted edits thrown away', () => {
  const reverts = (b) => signalsOf(run(b), 'revert').map((s) => s.key);

  test('worktree and branch housekeeping with no own edits is not a revert', () => {
    const b = builder();
    b.call('Bash', { command: 'git -C ../wt reset --hard next' });
    b.call('Bash', { command: 'git checkout -- tests/fixtures/install-tree/claude.json' });
    b.call('Bash', { command: 'git worktree remove ../wt --force && git stash list' });
    assert.deepEqual(reverts(b), []);
  });

  test('restoring a file the agent did not edit is not a revert; restoring one it did is', () => {
    const b = builder();
    b.call('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' });
    b.call('Bash', { command: 'npm run regen && git checkout -- docs/INVENTORY-MANIFEST.json' });
    b.call('Bash', { command: 'cd /repo && git checkout -- src/a.ts' });
    assert.deepEqual(reverts(b), ['cd /repo && git checkout -- src/a.ts']);
  });

  test('a commit makes edits no longer the agent\'s to lose; a message that mentions restore runs nothing', () => {
    const b = builder();
    b.call('Edit', { file_path: '/repo/src/a.ts', old_string: 'x', new_string: 'y' });
    b.call('Bash', { command: "git commit -m \"$(cat <<'EOF'\nfix: stop using git restore src/a.ts\nEOF\n)\"" });
    b.call('Bash', { command: 'git reset --hard HEAD' });
    b.call('Edit', { file_path: '/repo/src/b.ts', old_string: 'x', new_string: 'y' });
    b.call('Bash', { command: 'echo "next: git restore src/b.ts if lint fails"' });
    assert.deepEqual(reverts(b), []);
  });

  test('git revert of a commit always counts', () => {
    assert.deepEqual(reverts(builder().call('Bash', { command: 'git revert --no-edit abc1234' })), ['git revert --no-edit H']);
  });

  test('revertsOwnWork names the edits a reset or a covering pathspec loses', () => {
    const own = new Set(['/repo/src/a.ts', '/repo/lib/b.ts']);
    assert.deepEqual(rs.revertsOwnWork('git checkout -- src', own), ['/repo/src/a.ts']);
    assert.deepEqual(rs.revertsOwnWork('git restore .', own).sort(), ['/repo/lib/b.ts', '/repo/src/a.ts']);
    assert.equal(rs.revertsOwnWork('git restore --staged src/a.ts', own), null);
    assert.equal(rs.revertsOwnWork('git reset --hard next', new Set()), null);
  });
});

describe('edit-churn: rewriting own lines, not editing many places', () => {
  test('six successive edits of different places in one file are not churn', () => {
    const b = builder();
    for (let i = 0; i < 6; i++) b.call('Edit', { file_path: '/p/a.ts', old_string: `// anchor number ${i} here`, new_string: `// anchor number ${i} here\nexport const added${i} = make(${i});` });
    assert.equal(signalsOf(run(b, { editChurnMin: 1 }), 'edit-churn').length, 0);
  });

  test('anchoring a new edit on a line the last edit wrote keeps that line: not a rewrite', () => {
    const b = builder();
    b.call('Edit', { file_path: '/p/a.ts', old_string: 'export {};', new_string: 'export function first() {}' });
    b.call('Edit', { file_path: '/p/a.ts', old_string: 'export function first() {}', new_string: 'export function first() {}\nexport function second() {}' });
    assert.equal(signalsOf(run(b, { editChurnMin: 1 }), 'edit-churn').length, 0);
  });

  test('a failed edit and a Write over a file never written before are not rewrites; a Write over own lines is', () => {
    const b = builder();
    b.call('Edit', { file_path: '/p/a.ts', old_string: 'missing', new_string: 'const never = applied();' }, { ok: false, text: 'String to replace not found' });
    b.call('Write', { file_path: '/p/a.ts', content: 'const first = version(1);' });
    b.call('Write', { file_path: '/p/a.ts', content: 'const second = version(2);' });
    const churn = signalsOf(run(b, { editChurnMin: 1 }), 'edit-churn');
    assert.equal(churn.length, 1);
    assert.equal(churn[0].count, 1);
  });
});

describe('repeated-call and reread: progress and polling are not repetition', () => {
  test('the same check re-run after each fix is the loop working', () => {
    const b = builder();
    for (let i = 0; i < 4; i++) {
      b.call('Bash', { command: 'npm test' }, { ok: false, text: `Exit code 1\nnot ok ${i}` });
      b.call('Edit', { file_path: '/p/a.ts', old_string: `bug number ${i} here`, new_string: `fixed number ${i} here` });
    }
    assert.equal(signalsOf(run(b), 'repeated-call').length, 0);
  });

  test('polling agents and background jobs never counts', () => {
    const b = builder();
    for (let i = 0; i < 10; i++) b.call('ListAgents', {}).call('TaskOutput', { task_id: 'bg1' });
    assert.equal(signalsOf(run(b), 'repeated-call').length, 0);
  });

  test('different ranges of one file are not rereads; the same range after a compaction is not either', () => {
    const b = builder();
    for (let i = 0; i < 4; i++) b.call('Read', { file_path: '/p/big.ts', offset: String(i * 200), limit: '200' });
    b.call('Read', { file_path: '/p/a.ts' }).call('Read', { file_path: '/p/a.ts' }).compact().call('Read', { file_path: '/p/a.ts' });
    assert.equal(signalsOf(run(b, { rereadMin: 3 }), 'reread').length, 0);
  });
});

describe('subagent transcripts: environment kinds only', () => {
  test('a subagent\'s navigation, rereads, rewrites and repeats are its assignment; its hook errors are the environment', () => {
    const sub = builder('sub/agent-x.jsonl', { agentId: 'x' });
    for (let i = 0; i < 14; i++) sub.call('Grep', { pattern: `p${i}` });
    for (let i = 0; i < 4; i++) sub.call('Read', { file_path: '/p/a.ts' });
    for (let i = 0; i < 4; i++) sub.call('Bash', { command: 'git status' });
    sub.call('Edit', { file_path: '/p/a.ts', old_string: 'export {};', new_string: 'const value = compute(0);' });
    for (let i = 1; i <= 5; i++) sub.call('Edit', { file_path: '/p/a.ts', old_string: `const value = compute(${i - 1});`, new_string: `const value = compute(${i});` });
    sub.call('Bash', { command: 'git checkout -- /p/a.ts' });
    sub.hook('timed-out', { text: 'slow' });
    const t = builder().transcript();
    t.events = sub.events;
    const kinds = Object.keys(rs.computeRetroSignals({ transcript: t }).countsByKind);
    assert.deepEqual(kinds, ['hook-error']);
    for (const k of kinds) assert.equal(rs.MAIN_ONLY_KINDS.has(k), false);
  });
});

// ─── Pointers, ids, privacy ───────────────────────────────────────────────────

describe('pointers and ids', () => {
  test('the id is stable across runs over the same input and changes with the pointer', () => {
    const make = (pad) => {
      const b = builder();
      for (let i = 0; i < pad; i++) b.say('ok');
      return b.prompt('нет, не так');
    };
    const id1 = run(make(0)).signals[0].id;
    assert.equal(run(make(0)).signals[0].id, id1);
    assert.match(id1, /^user-correction:[0-9a-f]{10}$/);
    assert.notEqual(run(make(1)).signals[0].id, id1);
  });

  test('pointers carry file, line and uuid; at most MAX_POINTERS are kept', () => {
    const b = builder();
    for (let i = 0; i < 9; i++) b.call('Bash', { command: 'git status' });
    const sig = signalsOf(run(b), 'repeated-call')[0];
    assert.equal(sig.count, 9);
    assert.equal(sig.pointers.length, rs.MAX_POINTERS);
    assert.deepEqual(sig.pointers[0], { source: 'transcript', session: 'sess', file: 'main.jsonl', line: 1, uuid: 'uuid-1', timestamp: null });
  });

  test('the window spans excerpt_window same-file events either side of the first occurrence', () => {
    const b = builder();
    for (let i = 0; i < 5; i++) b.say(`step ${i}`);
    b.prompt('стоп');
    for (let i = 0; i < 5; i++) b.say(`after ${i}`);
    const sig = signalsOf(run(b, { excerptWindow: 2 }), 'user-correction')[0];
    assert.deepEqual(sig.window, { file: 'main.jsonl', fromLine: 4, toLine: 8 });
  });

  test('excerpts are redacted and capped; no full text leaves the report', () => {
    const key = 'sk-' + 'ant-' + 'k'.repeat(32);
    const long = `нет, используй ключ ${key} ` + 'и ещё много текста '.repeat(40);
    const report = run(builder().prompt(long), { excerptChars: 60 });
    const json = JSON.stringify(report);
    assert.equal(json.includes(key), false);
    assert.equal(json.includes('и ещё много текста и ещё много текста и ещё много текста и ещё'), false);
    assert.ok(report.signals[0].excerpt.length <= 60);
  });
});

// ─── Degraded inputs ──────────────────────────────────────────────────────────

describe('degraded and absent sources', () => {
  test('no transcript but a runtime reason → degraded, reason carried', () => {
    const report = rs.computeRetroSignals({ transcriptUnavailable: 'no transcript adapter for runtime "codex"' });
    assert.equal(report.status, 'degraded');
    assert.equal(report.sources.transcript, 'degraded');
    assert.deepEqual(report.reasons, ['no transcript adapter for runtime "codex"']);
  });

  test('a truncated transcript read degrades the report and says why', () => {
    const t = builder().prompt('ok').transcript();
    t.files[0].stats.truncatedBytes = true;
    const report = rs.computeRetroSignals({ transcript: t });
    assert.equal(report.status, 'degraded');
    assert.match(report.reasons.join('\n'), /byte limit/);
  });
});

// ─── Planning and git evidence ────────────────────────────────────────────────

describe('collectPlanningEvidence', () => {
  let dir;
  const roadmap = () => {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'ROADMAP.md'), '# Roadmap\n\n## Milestone v1\n\n### Phase 1: Core\n\n### Phase 2: UI\n');
  };
  beforeEach(() => { dir = createTempDir('gsd-retro-plan-'); });
  afterEach(() => { cleanup(dir); });

  test('gaps_found verification reports become signals with file:line pointers', () => {
    roadmap();
    const p1 = path.join(dir, '.planning', 'phases', '01-core');
    const p2 = path.join(dir, '.planning', 'phases', '02-ui');
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nphase: 01\nstatus: gaps_found\n---\n# body\n');
    fs.writeFileSync(path.join(p2, '02-VERIFICATION.md'), '---\nstatus: passed\n---\n');
    const evidence = rs.collectPlanningEvidence(dir);
    assert.equal(evidence.status, 'ok');
    assert.deepEqual(evidence.findings, [{ kind: 'gaps-found', file: '.planning/phases/01-core/01-VERIFICATION.md', line: 3, excerpt: 'status: gaps_found' }]);
    const report = rs.computeRetroSignals({ planning: evidence });
    assert.equal(report.sources.planning, 'read');
    assert.deepEqual(report.signals[0].pointers, [{ source: 'artifact', file: '.planning/phases/01-core/01-VERIFICATION.md', line: 3 }]);
    assert.equal(report.signals[0].window, null);
  });

  test('a 999.x backlog directory is never read as a milestone phase', () => {
    roadmap();
    const backlog = path.join(dir, '.planning', 'phases', '999.1-backlog');
    fs.mkdirSync(backlog, { recursive: true });
    fs.writeFileSync(path.join(backlog, '999.1-VERIFICATION.md'), '---\nstatus: gaps_found\n---\n');
    assert.deepEqual(rs.collectPlanningEvidence(dir).findings, []);
  });

  test('no ROADMAP: findings still come back, the report says the milestone window was not applied', () => {
    const p1 = path.join(dir, '.planning', 'phases', '01-core');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-VERIFICATION.md'), '---\nstatus: gaps_found\n---\n');
    const evidence = rs.collectPlanningEvidence(dir);
    assert.equal(evidence.status, 'degraded');
    assert.match(evidence.reason, /milestone window unreadable/);
    assert.equal(evidence.findings.length, 1);
  });

  test('sinceMs drops reports older than the window', () => {
    roadmap();
    const p1 = path.join(dir, '.planning', 'phases', '01-core');
    fs.mkdirSync(p1, { recursive: true });
    const f = path.join(p1, '01-VERIFICATION.md');
    fs.writeFileSync(f, '---\nstatus: gaps_found\n---\n');
    fs.utimesSync(f, new Date(1000), new Date(1000));
    assert.equal(rs.collectPlanningEvidence(dir, { sinceMs: 2000 }).findings.length, 0);
    assert.equal(rs.collectPlanningEvidence(dir, { sinceMs: 1000 }).findings.length, 1);
  });

  test('no .planning/phases → absent, not degraded', () => {
    const evidence = rs.collectPlanningEvidence(dir);
    assert.equal(evidence.status, 'absent');
    assert.equal(rs.computeRetroSignals({ planning: evidence }).status, 'ok');
  });
});

describe('collectGitReverts', () => {
  test('revert subjects are picked from git log through the injected runner', () => {
    const calls = [];
    const execGit = (args, opts) => {
      calls.push({ args, cwd: opts.cwd });
      return {
        exitCode: 0, stderr: '', signal: null, error: null, timedOut: false,
        stdout: ['a1\x1f2026-10-01T00:00:00Z\x1fRevert "feat: x"', 'b2\x1f2026-10-02T00:00:00Z\x1ffeat: y', 'c3\x1f2026-10-03T00:00:00Z\x1frevert(#12): drop z', ''].join('\n'),
      };
    };
    const ev = rs.collectGitReverts('/repo', { since: '7 days ago', execGit });
    assert.deepEqual(calls, [{ args: ['log', '--since=7 days ago', '--format=%H%x1f%cI%x1f%s'], cwd: '/repo' }]);
    assert.deepEqual(ev.reverts.map((r) => r.commit), ['a1', 'c3']);
    const report = rs.computeRetroSignals({ git: ev });
    assert.equal(report.countsByKind.revert, 2);
    assert.deepEqual(report.signals[0].pointers[0], { source: 'git', commit: 'a1', timestamp: '2026-10-01T00:00:00Z' });
  });

  test('a failing git log is degraded with its stderr', () => {
    const execGit = () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository', signal: null, error: null, timedOut: false });
    const ev = rs.collectGitReverts('/repo', { since: '1 day ago', execGit });
    assert.equal(ev.status, 'degraded');
    assert.match(ev.reason, /not a git repository/);
    assert.equal(rs.computeRetroSignals({ git: ev }).status, 'degraded');
  });

  test('a real revert commit is found through the default seam', (t) => {
    const repo = createTempGitProject('gsd-retro-git-');
    t.after(() => cleanup(repo));
    const git = (args) => {
      const res = runGit(args, { cwd: repo });
      assert.deepEqual([res.outcome, res.exitCode], [OUTCOME.EXITED, 0], `git ${args.join(' ')}: ${res.stderr}`);
    };
    fs.writeFileSync(path.join(repo, 'f.txt'), 'one\n');
    git(['add', 'f.txt']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'feat: add f']);
    git(['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'revert', '--no-edit', 'HEAD']);
    const ev = rs.collectGitReverts(repo, { since: '1 day ago' });
    assert.equal(ev.status, 'ok');
    assert.equal(ev.reverts.length, 1);
    assert.match(ev.reverts[0].subject, /^Revert "feat: add f"/);
  });
});

// ─── End to end through session-transcript ────────────────────────────────────

describe('end to end from a JSONL fixture', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-retro-e2e-'); });
  afterEach(() => { cleanup(dir); });

  test('a struggling session crosses the default threshold with pointers into the file', async () => {
    const rec = [];
    let u = 0;
    const push = (r) => rec.push(JSON.stringify({ uuid: `e2e-${++u}`, timestamp: '2026-10-04T00:00:00Z', ...r }));
    const tu = (id, name, input) => push({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
    const tr = (id, content, isError) => push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
    push({ type: 'user', userType: 'external', message: { content: 'почини тест парсера' } });
    for (let i = 0; i < 3; i++) {
      tu(`t${i}`, 'Bash', { command: 'npm test' });
      tr(`t${i}`, 'Exit code 1\nnot ok 4 - parser handles empty input', true);
    }
    push({ type: 'user', userType: 'external', message: { content: 'нет, не так — тест трогать нельзя' } });
    tu('h1', 'Bash', { command: 'git stash' });
    tr('h1', 'PreToolUse:Bash hook error: git stash is disabled', true);
    const file = path.join(dir, 'sess-e2e.jsonl');
    fs.writeFileSync(file, rec.join('\n') + '\n');
    const stat = fs.statSync(file);
    const transcript = await st.readSession({ sessionId: 'sess-e2e', filePath: file, size: stat.size, modified: stat.mtime, subagents: [], toolResults: { count: 0, bytes: 0 } });
    const report = rs.computeRetroSignals({ transcript });
    assert.equal(report.status, 'ok');
    assert.deepEqual(report.countsByKind, { 'repeated-tool-error': 3, 'user-correction': 1, 'hook-block': 1, 'repeated-call': 3 });
    // repeated-tool-error 2×(3−2+1)=4, correction 3, hook-block 2×1=2, repeated-call 1×(3−3+1)=1.
    assert.equal(report.score, 10);
    assert.equal(report.suggest, true);
    const err = signalsOf(report, 'repeated-tool-error')[0];
    assert.equal(err.key, 'Bash npm test → Exit code 1 not ok 4 - parser handles empty input');
    assert.deepEqual(err.pointers.map((p) => p.line), [3, 5, 7]);
    assert.equal(err.pointers[0].file, 'sess-e2e.jsonl');
  });
});

// ─── Fingerprints (ADR-5209 §10) ──────────────────────────────────────────────

describe('signal fingerprints: the same friction across sessions and checkouts', () => {
  const wall = (wt, why = 'but this command changes directory to the shared checkout') => `This session is isolated in the worktree ${wt}, ${why}`;
  /** A session hitting `error` twice with Bash, starting from `firstCommand`. */
  function errorSignal(firstCommand, error, opts = {}) {
    const b = builder();
    b.call(opts.tool ?? 'Bash', opts.tool ? { file_path: firstCommand } : { command: firstCommand }, { ok: false, text: error });
    b.call(opts.tool ?? 'Bash', opts.tool ? { file_path: opts.second ?? firstCommand } : { command: opts.second ?? 'git status' }, { ok: false, text: error });
    return signalsOf(rs.computeRetroSignals({ transcript: b.transcript(), projectRoots: opts.roots ?? [] }), 'repeated-tool-error')[0];
  }
  const fp = (s) => s.fingerprint;

  test('the same wall from another first command in another worktree: another id, the same fingerprint', () => {
    const a = errorSignal('cd ~/IdeaProjects/mn-wt-121-12/libs/polyglot && cat x', wall('~/IdeaProjects/mn/.claude/worktrees/polyglot-autonomous'));
    const b = errorSignal('cd /Users/someone/IdeaProjects/mn && git worktree add -b wt/132 ~/IdeaProjects/mn-wt-132', wall('/Users/someone/IdeaProjects/mn/.claude/worktrees/zeta'));
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.key, b.key);
    assert.match(fp(a), /^repeated-tool-error:[0-9a-f]{10}$/);
    assert.deepEqual([fp(a), a.fingerprintWeak], [fp(b), false]);
  });

  test('the text after the path tells two walls apart', () => {
    const wt = '~/IdeaProjects/mn/.claude/worktrees/p';
    assert.notEqual(fp(errorSignal('ls', wall(wt))), fp(errorSignal('ls', wall(wt, 'but this command runs sed with a value computed at runtime'))));
  });

  test('every number is masked alike, whatever its length', () => {
    assert.equal(fp(errorSignal('ls', 'Request failed after 3 retries on attempt 12')), fp(errorSignal('ls', 'Request failed after 4 retries on attempt 99999')));
  });

  test('errors that differ past the 90th character are two frictions; past BASIS_MAX they are one', () => {
    const head = 'Validation failed for the configuration because the schema requires a field that is missing: ';
    assert.ok(head.length > 90);
    assert.notEqual(fp(errorSignal('ls', `${head}alpha`)), fp(errorSignal('ls', `${head}omega`)));
    const long = 'x '.repeat(rs.BASIS_MAX);
    assert.equal(fp(errorSignal('ls', `${long}alpha`)), fp(errorSignal('ls', `${long}omega`)));
  });

  test('weak errors are flagged and kept apart by what the masking hid and by the call', () => {
    const cases = [
      ['bare exit code, two commands', ['npm test', 'Exit code 1'], ['git push', 'Exit code 1']],
      ['exit code and a path, two files', ['npm test', 'Exit code 1 /repo/a.spec.ts'], ['npm test', 'Exit code 1 /repo/b.spec.ts']],
      ['FAIL and a path, two files', ['npm test', 'FAIL /repo/src/a.spec.ts'], ['npm test', 'FAIL /repo/src/b.spec.ts']],
      ['command failed, two subcommands', ['make', 'Error: Command failed: /usr/bin/git push'], ['make', 'Error: Command failed: /usr/bin/git fetch']],
      ['file does not exist, two files', ['cat', 'File does not exist. Current working directory: /repo/a.md'], ['cat', 'File does not exist. Current working directory: /repo/b.md']],
      ['URL, two hosts', ['curl', 'https://registry.example.com/x'], ['curl', 'https://other.example.org/x']],
    ];
    for (const [name, [c1, e1], [c2, e2]] of cases) {
      const a = errorSignal(c1, e1, { second: c1 });
      const b = errorSignal(c2, e2, { second: c2 });
      assert.notEqual(fp(a), fp(b), name);
      if (name !== 'command failed, two subcommands') assert.deepEqual([a.fingerprintWeak, b.fingerprintWeak], [true, true], name);
    }
    const strong = errorSignal('ls', wall('~/wt'));
    assert.equal(strong.fingerprintWeak, false);
  });

  test('a call is its first command that does something; git is its subcommand', () => {
    assert.notEqual(rs.shellBasis('cd /a && rm -rf build'), rs.shellBasis('cd /b && git push --force'));
    assert.equal(rs.shellBasis('cd /a && rm -rf build'), rs.shellBasis('cd ~/elsewhere; rm -rf build'));
    assert.equal(rs.shellBasis('S=/tmp/x; export P=1 && FOO=bar npm test'), 'npm test');
    assert.notEqual(rs.shellBasis('git -C /a status'), rs.shellBasis('git -C /b push'));
    assert.equal(rs.shellBasis('git -C /a -c core.x=1 --no-pager push origin --force'), 'git push --force');
    assert.equal(rs.shellBasis('cd /a'), 'cd');
  });

  test('a file tool is the file\'s place and extension', () => {
    const roots = ['/repo'];
    assert.notEqual(rs.callBasis('Write', { filePath: '/repo/a.ts' }, roots), rs.callBasis('Write', { filePath: '/etc/hosts' }, roots));
    assert.equal(rs.callBasis('Write', { filePath: '/repo/a.ts' }, roots), rs.callBasis('Write', { filePath: '/repo/deep/b.ts' }, roots));
    assert.notEqual(rs.callBasis('Write', { filePath: '/repo/a.ts' }, roots), rs.callBasis('Write', { filePath: '/repo/a.md' }, roots));
    assert.equal(rs.fileBasis('~/notes.md', roots), 'home .md');
  });

  test('a denial is the form of the call refused, not its arguments; a correction has none', () => {
    const deny = (input, tool = 'Bash') => {
      const b = builder();
      b.call(tool, input, { ok: false, text: 'Permission to use it has been denied', denial: 'permission-rule' });
      return signalsOf(rs.computeRetroSignals({ transcript: b.transcript(), projectRoots: ['/repo'] }), 'permission-denial')[0];
    };
    assert.equal(fp(deny({ command: 'cd ~/a/b && cat x' })), fp(deny({ command: 'cd /Users/q/c; cat y' })));
    assert.notEqual(fp(deny({ command: 'cd ~/a/b && rm -rf build' })), fp(deny({ command: 'cd ~/a/b && git push --force' })));
    assert.notEqual(fp(deny({ file_path: '/repo/a.ts' }, 'Write')), fp(deny({ file_path: '/etc/hosts' }, 'Write')));
    const c = builder().prompt('нет, не так');
    assert.equal(signalsOf(run(c), 'user-correction')[0].fingerprint, null);
  });

  test('an old bundle\'s key implies the fingerprint the signal carries when the key was not cut', () => {
    const a = errorSignal('cd ~/IdeaProjects/mn && wc -l notes.md', 'Permission denied while reading the lock file');
    const legacy = rs.fingerprintBasisFromKey(a.kind, a.key);
    assert.equal(rs.signalFingerprint(a.kind, legacy.basis), a.fingerprint);
  });

  test('maskPaths masks ~/…, absolute and Windows paths, keeps URLs', () => {
    assert.equal(rs.maskPaths('cd ~/IdeaProjects/mn && cat /etc/hosts "/tmp/a b" ~/x…'), 'cd <path> && cat <path> "<path> b" <path>');
    assert.equal(rs.maskPaths('open C:\\Users\\me\\x.ts or see https://example.com/a/b'), 'open <path> or see https://example.com/a/b');
    assert.equal(rs.maskVolatile('see https://example.com/a/b at 12'), 'see <url> at N');
    assert.equal(rs.isWeakBasis('Exit code N'), true);
    assert.equal(rs.isWeakBasis('File does not exist. <path>'), true);
    assert.equal(rs.isWeakBasis('This session is isolated in the worktree <path>'), false);
  });
});

// ─── Legacy fingerprints: a retro recorded before §10 (ADR-5209 §10) ─────────

describe('legacy fingerprints: an old bundle\'s key against a new session\'s full text', () => {
  // Verbatim from the polyglot bundle of 2026-10-28 (RETRO-2026-10-28.bundle.json): the key as it was
  // written, cut at 100 characters before any masking, and the excerpt of the same refusal.
  const OLD_KEY = 'Bash cd ~/IdeaProjects/mn && wc -l apps/polyglot/.planning/notes/RESUME-orchestratio… → This session is isolated in the worktree ~/IdeaProjects/mn/.claude/worktrees/polyglot-autonomous, b…';
  const FULL = (wt) => `This session is isolated in the worktree ${wt}, but this command changes directory to the shared checkout (~/IdeaProjects/mn). Run it inside the worktree instead.`;
  function newSession(firstCommand, wt) {
    const b = builder();
    b.call('Bash', { command: firstCommand }, { ok: false, text: FULL(wt) });
    b.call('Bash', { command: 'git status' }, { ok: false, text: FULL(wt) });
    return signalsOf(run(b), 'repeated-tool-error')[0];
  }

  test('the same wall, another worktree and first command, full text: its key\'s legacy fingerprint equals the old key\'s', () => {
    const old = rs.legacyFingerprint('repeated-tool-error', OLD_KEY);
    for (const wt of ['/Users/someone/IdeaProjects/mn/.claude/worktrees/zeta', '~/IdeaProjects/mn/.claude/worktrees/polyglot-autonomous', '/home/a/very/long/path/to/a/checkout/of/mn/.claude/worktrees/feature-with-a-long-name']) {
      const now = newSession('cd ~/IdeaProjects/other-wt-9/x && git status', wt);
      assert.equal(rs.legacyFingerprint(now.kind, now.key).fingerprint, old.fingerprint, wt);
      assert.notEqual(now.fingerprint, old.fingerprint, 'a full-text fingerprint never equals a legacy one');
    }
    assert.equal(old.weak, false);
  });

  test('another wall is another legacy fingerprint', () => {
    const now = newSession('ls', '/x/wt');
    const other = rs.legacyFingerprint('repeated-tool-error', 'Bash ls → Permission denied: the file is read-only');
    assert.notEqual(rs.legacyFingerprint(now.kind, now.key).fingerprint, other.fingerprint);
  });
});

describe('fingerprint details: numbers and interpreters', () => {
  test('standalone numbers are masked; identifiers and three-digit statuses keep their digits', () => {
    assert.equal(rs.maskVolatile('line 12 col 3, attempt 99'), 'line N col N, attempt N');
    assert.equal(rs.maskVolatile('TS2304 E11000 ES2022'), 'TS2304 E11000 ES2022');
    assert.equal(rs.maskVolatile('HTTP 404 Not Found / status: 500'), 'HTTP 404 Not Found / status: 500');
    assert.notEqual(rs.errorBasis('request failed: status 404'), rs.errorBasis('request failed: status 500'));
    assert.equal(rs.errorBasis('failed at line 12'), rs.errorBasis('failed at line 13'));
    assert.equal(rs.isWeakBasis('Exit code 128'), true);
  });

  test('an interpreter is its script\'s file name', () => {
    assert.notEqual(rs.shellBasis('node ~/.claude/gsd-core/bin/gsd-tools.cjs init'), rs.shellBasis('node /tmp/evil.js'));
    assert.equal(rs.shellBasis('node ~/.claude/gsd-core/bin/gsd-tools.cjs init'), rs.shellBasis('node /other/install/gsd-core/bin/gsd-tools.cjs query'));
    assert.notEqual(rs.shellBasis('bash a.sh'), rs.shellBasis('bash b.sh'));
    assert.equal(rs.shellBasis('cd /x && python3 -u /a/run.py --fast'), 'python3 -u run.py');
  });
});
