'use strict';

/**
 * src/session-transcript.cts — the shared Claude Code transcript reader.
 *
 * Every fixture is a synthetic JSONL written into a temp directory; no test
 * reads a real ~/.claude. Covers: bounded streaming (malformed, blank,
 * over-long and byte-capped lines, chunk-straddling UTF-8), the typed
 * projection of each record shape retro-signals depends on, subagent and
 * spilled-output discovery, project/session discovery and its containment,
 * degraded status, and the privacy contract of excerpt().
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const st = require('../gsd-core/bin/lib/session-transcript.cjs');

const jsonl = (records) => records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

let n = 0;
const uid = () => `u-${String(++n).padStart(4, '0')}`;
const user = (content, extra = {}) => ({ type: 'user', userType: 'external', uuid: uid(), timestamp: '2026-10-04T10:00:00Z', message: { role: 'user', content }, ...extra });
const assistant = (content, extra = {}) => ({ type: 'assistant', uuid: uid(), timestamp: '2026-10-04T10:00:01Z', message: { role: 'assistant', content }, ...extra });
const toolUse = (id, name, input) => assistant([{ type: 'tool_use', id, name, input }]);
const toolResult = (id, content, isError = false, extra = {}) =>
  user([{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], extra);

async function collect(filePath, limits) {
  const stats = {
    bytesRead: 0, lines: 0, blankLines: 0, records: 0, malformedLines: 0, oversizeLines: 0,
    truncatedBytes: false, truncatedEvents: false,
  };
  const items = [];
  for await (const item of st.iterateJsonl(filePath, limits, stats)) items.push(item);
  return { items, stats };
}

function sessionFile(dir, id, records) {
  const filePath = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(filePath, typeof records === 'string' ? records : jsonl(records));
  const stat = fs.statSync(filePath);
  return { sessionId: id, filePath, size: stat.size, modified: stat.mtime, subagents: [], toolResults: { count: 0, bytes: 0 } };
}

describe('iterateJsonl — bounded streaming', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-transcript-'); });
  afterEach(() => { cleanup(dir); });

  test('malformed and non-object lines are skipped and counted; blank lines are counted, not yielded', async () => {
    const f = path.join(dir, 'a.jsonl');
    fs.writeFileSync(f, '{"type":"user"}\n\nnot json\n[1,2]\n{"type":"assistant"}\n');
    const { items, stats } = await collect(f);
    assert.deepEqual(items.map((i) => [i.kind, i.line]), [['record', 1], ['malformed', 3], ['malformed', 4], ['record', 5]]);
    assert.equal(stats.lines, 5);
    assert.equal(stats.blankLines, 1);
    assert.equal(stats.malformedLines, 2);
    assert.equal(stats.records, 2);
  });

  test('a final line without a trailing newline is read; CRLF endings are tolerated', async () => {
    const f = path.join(dir, 'b.jsonl');
    fs.writeFileSync(f, '{"a":1}\r\n{"a":2}');
    const { items } = await collect(f);
    assert.deepEqual(items.map((i) => i.record.a), [1, 2]);
  });

  test('maxLineBytes boundary: a line of exactly the limit is read, one byte over is skipped as oversize', async () => {
    const at = JSON.stringify({ p: 'x'.repeat(20) });
    const over = JSON.stringify({ p: 'x'.repeat(21) });
    const under = JSON.stringify({ p: 'x'.repeat(19) });
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, [under, at, over].join('\n') + '\n');
    const { items, stats } = await collect(f, { maxLineBytes: at.length });
    assert.deepEqual(items.map((i) => i.kind), ['record', 'record', 'oversize']);
    assert.equal(items[2].bytes, over.length);
    assert.equal(stats.oversizeLines, 1);
  });

  test('maxBytes boundary around the file size: size-1 drops the cut fragment, size and size+1 read everything', async () => {
    const line = '{"k":"v"}';
    const f = path.join(dir, 'd.jsonl');
    fs.writeFileSync(f, `${line}\n${line}\n${line}\n`);
    const size = (line.length + 1) * 3;
    const minusOne = await collect(f, { maxBytes: size - 1 });
    assert.equal(minusOne.items.length, 2, 'the third line lost its newline: a fragment, not a line');
    assert.equal(minusOne.stats.truncatedBytes, true);
    const exact = await collect(f, { maxBytes: size });
    assert.equal(exact.items.length, 3);
    assert.equal(exact.stats.truncatedBytes, false);
    const plusOne = await collect(f, { maxBytes: size + 1 });
    assert.equal(plusOne.items.length, 3);
    assert.equal(plusOne.stats.truncatedBytes, false);
  });

  test('a cap that ends on a line boundary still reports the read as truncated', async () => {
    const line = '{"k":"v"}';
    const f = path.join(dir, 'd2.jsonl');
    fs.writeFileSync(f, `${line}\n${line}\n${line}\n`);
    const { items, stats } = await collect(f, { maxBytes: (line.length + 1) * 2 });
    assert.equal(items.length, 2);
    assert.equal(stats.truncatedBytes, true, 'bytes remained unread — a short read is not a short session');
  });

  test('a multi-byte character straddling a read-chunk boundary decodes intact', async () => {
    // fs.createReadStream reads 64 KiB chunks; put "ж" (2 bytes) across byte 65536.
    const prefix = '{"t":"';
    const pad = 'a'.repeat(65536 - prefix.length - 1);
    const f = path.join(dir, 'e.jsonl');
    fs.writeFileSync(f, `${prefix}${pad}ж"}\n`);
    const { items } = await collect(f);
    assert.equal(items[0].record.t.endsWith('ж'), true);
  });
});

describe('projectRecord — typed events', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-transcript-'); });
  afterEach(() => { cleanup(dir); });

  test('prompts, interrupts, tool calls, errors, denials, hooks, api errors and compactions', async () => {
    const s = sessionFile(dir, 'sess-1', [
      user('please fix the parser'),
      user('<command-name>/clear</command-name>'),
      user('Base directory for this skill: /x', { isMeta: false }),
      user('meta note', { isMeta: true }),
      user([{ type: 'text', text: '[Request interrupted by user for tool use]' }]),
      user([{ type: 'text', text: '[Request interrupted by user]' }]),
      toolUse('t1', 'Bash', { command: 'npm test', description: 'run tests' }),
      toolResult('t1', 'Exit code 1\nnot ok 3', true),
      toolUse('t2', 'Bash', { command: 'grep -n x .env' }),
      toolResult('t2', 'Permission to use Bash with command grep -n x .env has been denied.', true, { toolDenialKind: 'permission-rule' }),
      toolUse('t3', 'Edit', { file_path: '/p/a.ts', old_string: 'a', new_string: 'b' }),
      toolResult('t3', "The user doesn't want to proceed with this tool use. The tool use was rejected", true),
      toolUse('t4', 'Bash', { command: 'git stash' }),
      toolResult('t4', 'PreToolUse:Bash hook error: git stash is disabled here', true),
      toolUse('t5', 'Bash', { command: 'sleep 60 && cat x' }),
      toolResult('t5', '<tool_use_error>Blocked: sleep 60 followed by: cat x</tool_use_error>', true),
      { type: 'attachment', uuid: uid(), attachment: { type: 'hook_non_blocking_error', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', toolUseID: 't3', stderr: 'lint warn', exitCode: 1 } },
      { type: 'attachment', uuid: uid(), attachment: { type: 'hook_cancelled', hookName: 'UserPromptSubmit', hookEvent: 'UserPromptSubmit', timedOut: true } },
      { type: 'attachment', uuid: uid(), attachment: { type: 'hook_cancelled', hookName: 'Stop', hookEvent: 'Stop' } },
      { type: 'system', subtype: 'stop_hook_summary', uuid: uid(), hookErrors: ['[/home/u/.claude/hooks/quality-gate.sh]: FAILED'], preventedContinuation: false },
      { type: 'system', subtype: 'stop_hook_summary', uuid: uid(), hookErrors: [], preventedContinuation: false },
      assistant([{ type: 'text', text: 'API Error: overloaded' }], { isApiErrorMessage: true }),
      { type: 'system', subtype: 'compact_boundary', uuid: uid() },
      user('This session is being continued from a previous conversation', { isCompactSummary: true }),
      assistant([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'Done.' }]),
    ]);
    const tr = await st.readSession(s);
    assert.equal(tr.status, 'ok');
    const kinds = tr.events.map((e) => e.kind);
    assert.deepEqual(kinds.filter((k) => k === 'user-prompt').length, 1, 'only the typed prompt is a prompt');
    const prompt = tr.events.find((e) => e.kind === 'user-prompt');
    assert.equal(prompt.text, 'please fix the parser');
    assert.equal(prompt.ptr.line, 1);
    assert.equal(prompt.ptr.file, 'sess-1.jsonl');
    const interrupts = tr.events.filter((e) => e.kind === 'user-interrupt');
    assert.deepEqual(interrupts.map((e) => e.duringToolUse), [true, false]);

    const results = tr.events.filter((e) => e.kind === 'tool-result');
    const byId = Object.fromEntries(results.map((r) => [r.toolUseId, r]));
    assert.equal(byId.t1.tool, 'Bash');
    assert.equal(byId.t1.isError, true);
    assert.equal(byId.t1.blockedBy, null);
    assert.equal(byId.t2.denial, 'permission-rule');
    assert.equal(byId.t2.blockedBy, 'denial');
    assert.equal(byId.t3.denial, 'user-rejected', 'text fallback when toolDenialKind is absent');
    assert.equal(byId.t4.blockedBy, 'hook');
    assert.equal(byId.t5.blockedBy, 'hook');

    const hooks = tr.events.filter((e) => e.kind === 'hook');
    assert.deepEqual(hooks.map((h) => [h.event, h.outcome, h.tool]), [
      ['PreToolUse', 'blocked', 'Bash'],
      ['PreToolUse', 'blocked', 'Bash'],
      ['PostToolUse', 'non-blocking-error', 'Edit'],
      ['UserPromptSubmit', 'timed-out', null],
      ['Stop', 'stop-error', null],
    ]);
    assert.equal(hooks[4].hook, 'quality-gate.sh');
    assert.equal(kinds.filter((k) => k === 'api-error').length, 1);
    assert.equal(kinds.filter((k) => k === 'compaction').length, 2);
    assert.deepEqual(tr.events.filter((e) => e.kind === 'assistant-text').map((e) => e.text), ['Done.']);
  });

  test('a sidechain user message is not a human prompt', async () => {
    const s = sessionFile(dir, 'sess-2', [user('do the subtask', { isSidechain: true })]);
    const tr = await st.readSession(s);
    assert.equal(tr.events.length, 0);
  });

  test('event text and tool input strings are cut to maxTextChars at capture', async () => {
    const s = sessionFile(dir, 'sess-3', [user('x'.repeat(50)), toolUse('t1', 'Write', { file_path: '/a', content: 'y'.repeat(50) })]);
    const tr = await st.readSession(s, { limits: { maxTextChars: 10 } });
    assert.equal(tr.events[0].text.length, 10);
    assert.equal(tr.events[1].input.content.length, 10);
    assert.equal(tr.events[1].input.file_path, '/a');
  });

  test('maxEvents boundary: limit-1, limit and limit+1 events', async () => {
    const records = [user('one'), user('two'), user('three')];
    for (const [limit, kept, truncated] of [[2, 2, true], [3, 3, false], [4, 3, false]]) {
      const s = sessionFile(dir, `sess-ev-${limit}`, records);
      const tr = await st.readSession(s, { limits: { maxEvents: limit } });
      assert.equal(tr.events.length, kept, `limit ${limit}`);
      assert.equal(tr.files[0].stats.truncatedEvents, truncated, `limit ${limit}`);
    }
  });
});

describe('readSession — subagents, spilled outputs, degraded', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-transcript-'); });
  afterEach(() => { cleanup(dir); });

  test('subagent transcripts are read with their agent id and type; tool-results are counted, never read', async () => {
    const projectDir = path.join(dir, 'proj');
    fs.mkdirSync(path.join(projectDir, 'sess-9', 'subagents'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, 'sess-9', 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'sess-9.jsonl'), jsonl([user('go')]));
    fs.writeFileSync(path.join(projectDir, 'sess-9', 'subagents', 'agent-abc.jsonl'),
      jsonl([toolUse('s1', 'Read', { file_path: '/x' }), { type: 'garbage' }, 'broken{']));
    fs.writeFileSync(path.join(projectDir, 'sess-9', 'subagents', 'agent-abc.meta.json'), JSON.stringify({ agentType: 'gsd-executor' }));
    fs.writeFileSync(path.join(projectDir, 'sess-9', 'tool-results', 'r1.txt'), 'z'.repeat(100));
    const found = st.findProjectSessions({ projectRoot: '/nowhere', sessionsDir: dir });
    assert.equal(found.status, 'degraded', 'no encoded dir and no index → not found');
    const viaIndex = (() => {
      fs.writeFileSync(path.join(projectDir, 'sessions-index.json'), JSON.stringify({ originalPath: '/work/proj', entries: [] }));
      return st.findProjectSessions({ projectRoot: '/work/proj', sessionsDir: dir });
    })();
    assert.equal(viaIndex.status, 'ok');
    const sf = viaIndex.sessions[0];
    assert.deepEqual(sf.subagents.map((a) => [a.agentId, a.agentType]), [['abc', 'gsd-executor']]);
    assert.deepEqual(sf.toolResults, { count: 1, bytes: 100 });
    const tr = await st.readSession(sf);
    const sub = tr.events.find((e) => e.ptr.agentId === 'abc');
    assert.equal(sub.kind, 'tool-use');
    assert.equal(sub.ptr.file, 'sess-9/subagents/agent-abc.jsonl');
    assert.equal(tr.files[1].stats.malformedLines, 1);
    assert.equal(tr.status, 'ok', 'a malformed subagent line is counted, not a degradation');
    const mainOnly = await st.readSession(sf, { includeSubagents: false });
    assert.equal(mainOnly.files.length, 1);
  });

  test('a main transcript with records but none of a recognised type is degraded', async () => {
    const s = sessionFile(dir, 'sess-x', [{ kind: 'event', body: 1 }, { kind: 'event', body: 2 }]);
    const tr = await st.readSession(s);
    assert.equal(tr.status, 'degraded');
    assert.match(tr.reason, /format not understood/);
  });

  test('an unreadable main transcript is degraded, with the cause', async () => {
    const s = { sessionId: 'gone', filePath: path.join(dir, 'gone.jsonl'), size: 0, modified: new Date(0), subagents: [], toolResults: { count: 0, bytes: 0 } };
    const tr = await st.readSession(s);
    assert.equal(tr.status, 'degraded');
    assert.match(tr.reason, /ENOENT/);
  });
});

describe('findProjectSessions / selectSession', () => {
  let dir;
  beforeEach(() => { dir = createTempDir('gsd-transcript-'); });
  afterEach(() => { cleanup(dir); });

  test('the encoded project directory is found; sessions are newest first', () => {
    const root = path.join(dir, 'work', 'my.app');
    const projectDir = path.join(dir, 'projects', st.encodeProjectDirName(root));
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'old.jsonl'), jsonl([user('a')]));
    fs.writeFileSync(path.join(projectDir, 'new.jsonl'), jsonl([user('b')]));
    fs.utimesSync(path.join(projectDir, 'old.jsonl'), new Date(1000), new Date(1000));
    const found = st.findProjectSessions({ projectRoot: root, sessionsDir: path.join(dir, 'projects') });
    assert.equal(found.status, 'ok');
    assert.deepEqual(found.sessions.map((s) => s.sessionId), ['new', 'old']);
    assert.equal(st.selectSession(found, {}).sessionId, 'new');
    assert.equal(st.selectSession(found, { sessionId: 'old' }).sessionId, 'old');
    assert.equal(st.selectSession(found, { sessionId: 'missing' }), null);
  });

  test('encodeProjectDirName replaces every non-alphanumeric character', () => {
    assert.equal(st.encodeProjectDirName('/Users/me/my.app_x'), '-Users-me-my-app-x');
  });

  test('a session id that is not a plain identifier is refused before any lookup', () => {
    const found = { status: 'ok', reason: null, projectDir: dir, sessions: [{ sessionId: '../escape' }] };
    for (const bad of ['../escape', 'a/b', '', '.hidden', 'x'.repeat(129)]) {
      assert.equal(st.selectSession(found, { sessionId: bad }), null, JSON.stringify(bad));
    }
  });

  test('no sessions directory → degraded with a reason', () => {
    const found = st.findProjectSessions({ projectRoot: dir, sessionsDir: path.join(dir, 'absent') });
    assert.equal(found.status, 'degraded');
    assert.equal(found.sessions.length, 0);
  });
});

describe('transcriptSupport', () => {
  test('claude is supported; every other runtime is degraded with a reason', () => {
    assert.deepEqual(st.transcriptSupport('claude'), { status: 'supported', runtime: 'claude' });
    assert.equal(st.transcriptSupport(undefined).status, 'supported');
    const codex = st.transcriptSupport('codex');
    assert.equal(codex.status, 'degraded');
    assert.match(codex.reason, /git and \.planning only/);
  });
});

describe('isGenuineUserRecord — profile-pipeline parity', () => {
  test('accepts a typed external prompt and rejects every excluded shape', () => {
    const ok = { type: 'user', userType: 'external', message: { content: 'hi' } };
    assert.equal(st.isGenuineUserRecord(ok), true);
    for (const bad of [
      { ...ok, type: 'assistant' },
      { ...ok, userType: 'internal' },
      { ...ok, isMeta: true },
      { ...ok, isSidechain: true },
      { ...ok, message: { content: '' } },
      { ...ok, message: { content: [{ type: 'text', text: 'hi' }] } },
      { ...ok, message: { content: '<command-name>x' } },
      { ...ok, message: { content: '<local-command-stdout>x' } },
      { ...ok, message: { content: '<task-notification>x' } },
    ]) {
      assert.equal(st.isGenuineUserRecord(bad), false, JSON.stringify(bad));
    }
  });
});

describe('excerpt — the privacy contract', () => {
  test('a secret in the excerpt is masked, the home directory folded', () => {
    const key = 'sk-' + 'ant-' + 'q'.repeat(30);
    const out = st.excerpt(`cat /home/alice/app/.env -> ANTHROPIC_KEY=${key}`, 200, '/home/alice');
    assert.equal(out.includes(key), false);
    assert.equal(out.includes('alice'), false);
    assert.match(out, /^cat ~\/app\/\.env/);
  });

  test('a secret straddling the cut is still redacted, not half-shown', () => {
    const key = 'gh' + 'p_' + 'B'.repeat(36);
    const out = st.excerpt(`token ${key}`, 12, '/nonexistent');
    assert.equal(out.includes('BBBB'), false);
  });

  test('length boundary: max chars kept as-is, max+1 cut with an ellipsis', () => {
    assert.equal(st.excerpt('abcde', 5, '/nonexistent'), 'abcde');
    assert.equal(st.excerpt('abcdef', 5, '/nonexistent'), 'abcd…');
    assert.equal(st.excerpt('abcd', 5, '/nonexistent'), 'abcd');
  });

  test('eventContext lists neighbours from the same file only, as one-line descriptions', () => {
    const p = (file, line) => ({ session: 's', file, line, uuid: null, timestamp: null });
    const events = [
      { kind: 'user-prompt', ptr: p('a', 1), text: 'start' },
      { kind: 'tool-use', ptr: p('b', 1), toolUseId: 'x', tool: 'Read', input: { file_path: '/f' } },
      { kind: 'tool-use', ptr: p('a', 2), toolUseId: 'y', tool: 'Bash', input: { command: 'ls' } },
      { kind: 'tool-result', ptr: p('a', 3), toolUseId: 'y', tool: 'Bash', isError: true, text: 'boom', blockedBy: null, denial: null },
    ];
    const ctx = st.eventContext(events, 2, 1);
    assert.deepEqual(ctx.map((c) => c.text), ['user: start', 'Bash ls', 'Bash → error: boom']);
    assert.equal(st.formatPointer({ ...p('a', 7), uuid: '0123456789' }), 'a:7#01234567');
  });
});
