/**
 * Session transcript — the one reader of Claude Code session history.
 *
 * Claude Code writes every session to `~/.claude/projects/<encoded-cwd>/<id>.jsonl`,
 * one JSON record per line, with subagent transcripts under `<id>/subagents/`
 * and spilled large tool outputs under `<id>/tool-results/`. Two consumers read
 * it: profile-pipeline (genuine user prompts, for the behavioural profile) and
 * retro-signals (the whole interaction — tool calls, tool errors, permission
 * denials, hook blocks — for friction signals). This module owns discovery,
 * bounded streaming and the typed projection; neither consumer parses JSONL
 * itself.
 *
 * ── Read-only, bounded ──────────────────────────────────────────────────
 *
 * Nothing here writes. Reading is streamed and capped three ways
 * (`ReadLimits`): total bytes per file, bytes per line (an over-long line is
 * skipped and counted without ever being buffered whole), and events per
 * transcript. Every cap that bites is reported in `stats`, never silent — a
 * truncated read is a different fact from a short session.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────
 *
 * Event text is held in memory only to derive signals, cut to
 * `maxTextChars` at capture. What leaves a consumer goes through `excerpt()`:
 * whitespace-collapsed, home directory folded to `~`, credentials redacted
 * (secrets.cts `redactSecretText`), length-capped. Spilled `tool-results/`
 * files are counted, never opened.
 *
 * ── Runtimes ────────────────────────────────────────────────────────────
 *
 * Claude Code is the only runtime with an adapter. `transcriptSupport()`
 * answers `degraded` with a reason for every other runtime, so a caller can
 * say "signals from git and .planning only" instead of reporting a clean,
 * empty session. A Claude transcript whose records carry none of the expected
 * fields (a format change) reads as `degraded` too, never as `ok` with zero
 * events.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { tryWithinRoot, PathAcceptance } from './security.cjs';
import { redactSecretText } from './secrets.cjs';

// ─── Limits ───────────────────────────────────────────────────────────────────

export interface ReadLimits {
  /** Stop reading a file after this many bytes. */
  maxBytes: number;
  /** A line longer than this is skipped (and counted) without being buffered whole. */
  maxLineBytes: number;
  /** Stop projecting events after this many per transcript (main + subagents). */
  maxEvents: number;
  /** Event text is cut to this many characters at capture. */
  maxTextChars: number;
}

export const DEFAULT_READ_LIMITS: Readonly<ReadLimits> = Object.freeze({
  maxBytes: 256 * 1024 * 1024,
  maxLineBytes: 8 * 1024 * 1024,
  maxEvents: 200_000,
  maxTextChars: 2000,
});

/** For callers that preserve an unbounded legacy read (profile-pipeline). */
export const UNBOUNDED_READ_LIMITS: Readonly<ReadLimits> = Object.freeze({
  maxBytes: Infinity,
  maxLineBytes: Infinity,
  maxEvents: Infinity,
  maxTextChars: Infinity,
});

export interface ReadStats {
  bytesRead: number;
  lines: number;
  blankLines: number;
  records: number;
  malformedLines: number;
  oversizeLines: number;
  /** True when `maxBytes` stopped the read before end of file. */
  truncatedBytes: boolean;
  /** True when `maxEvents` stopped event projection. */
  truncatedEvents: boolean;
}

function emptyStats(): ReadStats {
  return {
    bytesRead: 0, lines: 0, blankLines: 0, records: 0, malformedLines: 0, oversizeLines: 0,
    truncatedBytes: false, truncatedEvents: false,
  };
}

// ─── Streaming ────────────────────────────────────────────────────────────────

export type JsonlItem =
  | { kind: 'record'; line: number; record: Record<string, unknown> }
  | { kind: 'malformed'; line: number }
  | { kind: 'oversize'; line: number; bytes: number };

const NEWLINE = 0x0a;

/**
 * Stream a JSONL file line by line within `limits`. Lines are split on `\n`
 * (a trailing `\r` is dropped); bytes are decoded only once a whole line is
 * assembled, so a multi-byte character split across chunks survives. A line
 * past `maxLineBytes` has its bytes discarded as they arrive and is yielded as
 * `oversize`. Blank lines are counted, not yielded. `stats` is filled in place
 * so a caller that breaks out early still has what was read.
 */
export async function* iterateJsonl(
  filePath: string,
  limits: Partial<ReadLimits> = {},
  stats: ReadStats = emptyStats(),
): AsyncGenerator<JsonlItem> {
  const maxBytes = limits.maxBytes ?? DEFAULT_READ_LIMITS.maxBytes;
  const maxLineBytes = limits.maxLineBytes ?? DEFAULT_READ_LIMITS.maxLineBytes;
  let parts: Buffer[] = [];
  let partBytes = 0;
  let discarding = false;
  let lineNo = 0;

  function* finishLine(): Generator<JsonlItem> {
    lineNo++;
    stats.lines++;
    if (discarding) {
      stats.oversizeLines++;
      const bytes = partBytes;
      discarding = false;
      parts = [];
      partBytes = 0;
      yield { kind: 'oversize', line: lineNo, bytes };
      return;
    }
    let text = Buffer.concat(parts, partBytes).toString('utf8');
    parts = [];
    partBytes = 0;
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') {
      stats.blankLines++;
      return;
    }
    let record: unknown;
    try {
      record = JSON.parse(text);
    } catch {
      stats.malformedLines++;
      yield { kind: 'malformed', line: lineNo };
      return;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      stats.malformedLines++;
      yield { kind: 'malformed', line: lineNo };
      return;
    }
    stats.records++;
    yield { kind: 'record', line: lineNo, record: record as Record<string, unknown> };
  }

  function append(slice: Buffer): void {
    if (discarding) {
      partBytes += slice.length;
      return;
    }
    if (partBytes + slice.length > maxLineBytes) {
      discarding = true;
      parts = [];
      partBytes += slice.length;
      return;
    }
    parts.push(slice);
    partBytes += slice.length;
  }

  const stream = fs.createReadStream(filePath);
  try {
    for await (const chunk of stream) {
      let buf = chunk as Buffer;
      if (stats.bytesRead + buf.length > maxBytes) {
        buf = buf.subarray(0, Math.max(0, maxBytes - stats.bytesRead));
        stats.truncatedBytes = true;
      }
      stats.bytesRead += buf.length;
      let start = 0;
      for (let i = buf.indexOf(NEWLINE); i !== -1; i = buf.indexOf(NEWLINE, start)) {
        append(buf.subarray(start, i));
        start = i + 1;
        yield* finishLine();
      }
      if (start < buf.length) append(buf.subarray(start));
      if (stats.truncatedBytes) break;
    }
    // A final line without a trailing newline is still a line — unless the
    // byte cap cut it, in which case it is a fragment and is dropped.
    if (!stats.truncatedBytes && (partBytes > 0 || discarding)) yield* finishLine();
  } finally {
    stream.destroy();
  }
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export interface SessionEntry {
  sessionId: string;
  filePath: string;
  size: number;
  modified: Date;
}

export interface SessionIndexEntry {
  sessionId?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
}

export interface SessionIndex {
  originalPath: string | null;
  entries: Map<string, SessionIndexEntry>;
}

/** `~/.claude/projects`, or the override; null when the directory does not exist. */
export function getSessionsDir(overridePath?: string | null, homeDir: string = os.homedir()): string | null {
  const dir = overridePath || path.join(homeDir, '.claude', 'projects');
  if (!fs.existsSync(dir)) return null;
  return dir;
}

/** Project directories under the sessions dir. Throws when the dir cannot be read. */
export function listProjectDirs(sessionsDir: string): string[] {
  return fs.readdirSync(sessionsDir).filter(entry => {
    try {
      return fs.statSync(path.join(sessionsDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Top-level `<id>.jsonl` sessions of one project directory, newest first. */
export function scanProjectDir(projectDirPath: string): SessionEntry[] {
  const sessions: SessionEntry[] = [];
  for (const entry of fs.readdirSync(projectDirPath)) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDirPath, entry);
    const stat = fs.statSync(filePath);
    sessions.push({ sessionId: entry.replace('.jsonl', ''), filePath, size: stat.size, modified: stat.mtime });
  }
  sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  return sessions;
}

export function readSessionIndex(projectDirPath: string): SessionIndex {
  try {
    const raw = fs.readFileSync(path.join(projectDirPath, 'sessions-index.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { originalPath?: string; entries?: SessionIndexEntry[] };
    const entries = new Map<string, SessionIndexEntry>();
    for (const entry of (parsed.entries || [])) {
      if (entry.sessionId) entries.set(entry.sessionId, entry);
    }
    return { originalPath: parsed.originalPath || null, entries };
  } catch {
    return { originalPath: null, entries: new Map() };
  }
}

export function getProjectName(projectDirName: string, indexData: SessionIndex, firstRecordCwd?: string | null): string {
  if (indexData && indexData.originalPath) return path.basename(indexData.originalPath);
  if (firstRecordCwd) return path.basename(firstRecordCwd);
  return projectDirName;
}

/**
 * The directory name Claude Code gives a project: every character outside
 * `[A-Za-z0-9]` becomes `-` (`/Users/me/my.app` → `-Users-me-my-app`).
 */
export function encodeProjectDirName(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-');
}

export interface SubagentFile {
  agentId: string;
  filePath: string;
  agentType: string | null;
}

export interface SessionFile extends SessionEntry {
  subagents: SubagentFile[];
  /** Spilled large tool outputs — counted, never read. */
  toolResults: { count: number; bytes: number };
}

function describeSessionFile(entry: SessionEntry): SessionFile {
  const sessionDir = entry.filePath.replace(/\.jsonl$/, '');
  const subagents: SubagentFile[] = [];
  const subDir = path.join(sessionDir, 'subagents');
  let subEntries: string[] = [];
  try {
    subEntries = fs.readdirSync(subDir);
  } catch {
    subEntries = [];
  }
  for (const name of subEntries.filter(n => n.endsWith('.jsonl')).sort()) {
    const agentId = name.replace(/\.jsonl$/, '').replace(/^agent-/, '');
    let agentType: string | null = null;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, name.replace(/\.jsonl$/, '.meta.json')), 'utf8')) as { agentType?: unknown };
      if (typeof meta.agentType === 'string') agentType = meta.agentType;
    } catch {
      agentType = null;
    }
    subagents.push({ agentId, filePath: path.join(subDir, name), agentType });
  }
  const toolResults = { count: 0, bytes: 0 };
  try {
    for (const name of fs.readdirSync(path.join(sessionDir, 'tool-results'))) {
      const stat = fs.statSync(path.join(sessionDir, 'tool-results', name));
      if (!stat.isFile()) continue;
      toolResults.count++;
      toolResults.bytes += stat.size;
    }
  } catch {
    // no spilled outputs
  }
  return { ...entry, subagents, toolResults };
}

export interface ProjectSessions {
  status: 'ok' | 'degraded';
  reason: string | null;
  /** The Claude Code project directory, when one was found. */
  projectDir: string | null;
  sessions: SessionFile[];
}

/**
 * Find the Claude Code sessions recorded for `projectRoot`. The encoded
 * directory name is tried first; failing that, a directory whose
 * `sessions-index.json` names the project as its original path. Absent is
 * `degraded` with a reason, not an error — a project may simply never have
 * been opened in Claude Code.
 */
export function findProjectSessions(opts: { projectRoot: string; sessionsDir?: string | null; homeDir?: string }): ProjectSessions {
  const sessionsDir = getSessionsDir(opts.sessionsDir, opts.homeDir);
  if (!sessionsDir) {
    return { status: 'degraded', reason: 'no Claude Code sessions directory', projectDir: null, sessions: [] };
  }
  const root = path.resolve(opts.projectRoot);
  let projectDir: string | null = null;
  const encoded = path.join(sessionsDir, encodeProjectDirName(root));
  if (fs.existsSync(encoded)) {
    projectDir = encoded;
  } else {
    let dirs: string[] = [];
    try {
      dirs = listProjectDirs(sessionsDir);
    } catch (err) {
      return { status: 'degraded', reason: `sessions directory unreadable: ${(err as Error).message}`, projectDir: null, sessions: [] };
    }
    const match = dirs.find(d => {
      const idx = readSessionIndex(path.join(sessionsDir, d));
      return idx.originalPath !== null && path.resolve(idx.originalPath) === root;
    });
    if (match) projectDir = path.join(sessionsDir, match);
  }
  if (!projectDir) {
    return { status: 'degraded', reason: 'no Claude Code sessions recorded for this project', projectDir: null, sessions: [] };
  }
  return { status: 'ok', reason: null, projectDir, sessions: scanProjectDir(projectDir).map(describeSessionFile) };
}

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/**
 * Pick one session of a project: by id, or the newest. An id is
 * shape-checked and contained in the project directory before it is touched,
 * so a crafted `--session ../../x` cannot name a file outside it.
 */
export function selectSession(found: ProjectSessions, selector: { sessionId?: string | null }): SessionFile | null {
  if (!found.projectDir) return null;
  if (selector.sessionId === undefined || selector.sessionId === null) return found.sessions[0] ?? null;
  if (!SESSION_ID_RE.test(selector.sessionId)) return null;
  if (!tryWithinRoot(`${selector.sessionId}.jsonl`, found.projectDir, PathAcceptance.RelativeOnly)) return null;
  return found.sessions.find(s => s.sessionId === selector.sessionId) ?? null;
}

// ─── Runtime support ──────────────────────────────────────────────────────────

export type TranscriptSupport =
  | { status: 'supported'; runtime: 'claude' }
  | { status: 'degraded'; runtime: string; reason: string };

/** Only Claude Code has a transcript adapter; every other runtime is degraded, and says so. */
export function transcriptSupport(runtime: string | null | undefined): TranscriptSupport {
  const r = (runtime || 'claude').toLowerCase();
  if (r === 'claude' || r === 'claude-code') return { status: 'supported', runtime: 'claude' };
  return {
    status: 'degraded',
    runtime: r,
    reason: `no transcript adapter for runtime "${r}" — signals come from git and .planning only`,
  };
}

// ─── Typed projection ─────────────────────────────────────────────────────────

/** Where an event came from: file (relative to the session's project dir), 1-based line, record identity. */
export interface TranscriptPointer {
  session: string;
  file: string;
  line: number;
  uuid: string | null;
  timestamp: string | null;
  /** Set for events read from a subagent transcript. */
  agentId?: string;
}

export type DenialKind = 'permission-rule' | 'user-rejected' | 'interrupted' | 'other';
export type HookOutcome = 'blocked' | 'non-blocking-error' | 'timed-out' | 'stop-error';

export type TranscriptEvent =
  | { kind: 'user-prompt'; ptr: TranscriptPointer; text: string }
  | { kind: 'user-interrupt'; ptr: TranscriptPointer; duringToolUse: boolean }
  | { kind: 'assistant-text'; ptr: TranscriptPointer; text: string }
  | { kind: 'tool-use'; ptr: TranscriptPointer; toolUseId: string; tool: string; input: Record<string, string> }
  | {
    kind: 'tool-result'; ptr: TranscriptPointer; toolUseId: string; tool: string | null; isError: boolean; text: string;
    /** Why the call did not run, when it did not: a permission denial or a blocking hook. */
    blockedBy: 'denial' | 'hook' | null;
    denial: DenialKind | null;
  }
  | {
    kind: 'hook'; ptr: TranscriptPointer; event: string;
    /** The hook's own name, when the record carries it (attachments, Stop summaries). */
    hook: string | null;
    /** The tool the hook fired on, when it fired on one. */
    tool: string | null;
    outcome: HookOutcome; text: string;
  }
  | { kind: 'api-error'; ptr: TranscriptPointer; text: string }
  | { kind: 'compaction'; ptr: TranscriptPointer };

export interface TranscriptFileRead {
  file: string;
  agentId: string | null;
  agentType: string | null;
  stats: ReadStats;
  /** Records of a recognised Claude Code type (user/assistant/system/attachment). */
  recognisedRecords: number;
}

export interface SessionTranscript {
  status: 'ok' | 'degraded';
  reason: string | null;
  runtime: 'claude';
  session: string;
  events: TranscriptEvent[];
  files: TranscriptFileRead[];
  toolResults: { count: number; bytes: number };
}

/**
 * The profile-pipeline definition of a genuine user prompt: a top-level,
 * human-typed string message — not meta, not a sidechain, not a slash-command
 * or task-notification wrapper. Kept byte-for-behaviour from profile-pipeline.
 */
export function isGenuineUserRecord(record: Record<string, unknown>): boolean {
  if (record['type'] !== 'user') return false;
  if (record['userType'] !== 'external') return false;
  if (record['isMeta'] === true) return false;
  if (record['isSidechain'] === true) return false;
  const message = record['message'] as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content !== 'string') return false;
  if (content.length === 0) return false;
  if (content.startsWith('<local-command')) return false;
  if (content.startsWith('<command-')) return false;
  if (content.startsWith('<task-notification')) return false;
  if (content.startsWith('<local-command-stdout')) return false;
  return true;
}

// Text a user record carries that a person did not type: injected wrappers,
// skill bodies, continuation summaries, messages from other agents.
const NON_HUMAN_PREFIXES = [
  '<local-command', '<command-', '<task-notification', '<system-reminder', '<teammate-message',
  '<cross-session-message', '<user-prompt-submit-hook', 'Base directory for this skill:',
  'This session is being continued', 'Caveat: The messages below',
];
const INTERRUPT_RE = /^\[Request interrupted by user( for tool use)?\]/;
const HOOK_ERROR_RE = /^(PreToolUse|PostToolUse|UserPromptSubmit|Stop|SubagentStop)(?::([A-Za-z0-9_.-]+))? hook error:/;
const TOOL_BLOCKED_RE = /^<tool_use_error>Blocked:/;
const PERMISSION_DENIED_RE = /^Permission to use \S+ .*has been denied/s;
const USER_REJECTED_RE = /^The user doesn't want to proceed with this tool use/;
const RECOGNISED_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

function cut(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Tool input reduced to strings, each cut to `max`; nested values are JSON text. */
function projectInput(input: unknown, max: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const obj = input as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    out[key] = cut(typeof v === 'string' ? v : JSON.stringify(v) ?? '', max);
  }
  return out;
}

function denialFrom(record: Record<string, unknown>, text: string): DenialKind | null {
  const kind = record['toolDenialKind'];
  if (kind === 'permission-rule' || kind === 'user-rejected' || kind === 'interrupted') return kind;
  if (typeof kind === 'string' && kind) return 'other';
  if (PERMISSION_DENIED_RE.test(text)) return 'permission-rule';
  if (USER_REJECTED_RE.test(text)) return 'user-rejected';
  return null;
}

interface ProjectionContext {
  session: string;
  file: string;
  agentId: string | null;
  maxTextChars: number;
  toolNames: Map<string, string>;
}

/** One JSONL record → zero or more typed events. Unknown record types and fields are ignored. */
export function projectRecord(record: Record<string, unknown>, line: number, ctx: ProjectionContext): TranscriptEvent[] {
  const ptr: TranscriptPointer = {
    session: ctx.session,
    file: ctx.file,
    line,
    uuid: typeof record['uuid'] === 'string' ? record['uuid'] : null,
    timestamp: typeof record['timestamp'] === 'string' ? record['timestamp'] : null,
  };
  if (ctx.agentId) ptr.agentId = ctx.agentId;
  const max = ctx.maxTextChars;
  const type = record['type'];
  const events: TranscriptEvent[] = [];
  const message = record['message'] as { content?: unknown } | undefined;
  const content = message?.content;

  if (type === 'user') {
    if (record['isCompactSummary'] === true) {
      events.push({ kind: 'compaction', ptr });
      return events;
    }
    const sidechain = record['isSidechain'] === true;
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block || typeof block !== 'object') continue;
        if (block['type'] === 'tool_result') {
          const toolUseId = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
          const text = blockText(block['content']);
          const isError = block['is_error'] === true;
          const hookMatch = isError ? HOOK_ERROR_RE.exec(text) : null;
          const toolBlocked = isError && TOOL_BLOCKED_RE.test(text);
          const denial = isError ? denialFrom(record, text) : null;
          const blockedBy = hookMatch || toolBlocked ? 'hook' : denial && denial !== 'interrupted' ? 'denial' : null;
          events.push({
            kind: 'tool-result', ptr, toolUseId, tool: ctx.toolNames.get(toolUseId) ?? null,
            isError, text: cut(text, max), blockedBy, denial,
          });
          if (hookMatch || toolBlocked) {
            events.push({
              kind: 'hook', ptr,
              event: hookMatch ? hookMatch[1] : 'PreToolUse',
              hook: null,
              tool: hookMatch?.[2] ?? ctx.toolNames.get(toolUseId) ?? null,
              outcome: 'blocked', text: cut(text, max),
            });
          }
        } else if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const m = INTERRUPT_RE.exec(block['text']);
          if (m) events.push({ kind: 'user-interrupt', ptr, duringToolUse: Boolean(m[1]) });
          else if (!sidechain && record['isMeta'] !== true && isHumanText(block['text'])) {
            events.push({ kind: 'user-prompt', ptr, text: cut(block['text'], max) });
          }
        }
      }
    } else if (typeof content === 'string') {
      const m = INTERRUPT_RE.exec(content);
      if (m) events.push({ kind: 'user-interrupt', ptr, duringToolUse: Boolean(m[1]) });
      else if (!sidechain && record['isMeta'] !== true && isHumanText(content)) {
        events.push({ kind: 'user-prompt', ptr, text: cut(content, max) });
      }
    }
    return events;
  }

  if (type === 'assistant') {
    if (record['isApiErrorMessage'] === true) {
      events.push({ kind: 'api-error', ptr, text: cut(blockText(content), max) });
      return events;
    }
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block || typeof block !== 'object') continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
          events.push({ kind: 'assistant-text', ptr, text: cut(block['text'], max) });
        } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
          const toolUseId = typeof block['id'] === 'string' ? block['id'] : '';
          if (toolUseId) ctx.toolNames.set(toolUseId, block['name']);
          events.push({ kind: 'tool-use', ptr, toolUseId, tool: block['name'], input: projectInput(block['input'], max) });
        }
      }
    }
    return events;
  }

  if (type === 'system') {
    if (record['subtype'] === 'compact_boundary') {
      events.push({ kind: 'compaction', ptr });
    } else if (record['subtype'] === 'stop_hook_summary') {
      const errors = Array.isArray(record['hookErrors']) ? (record['hookErrors'] as unknown[]) : [];
      if (errors.length > 0 || record['preventedContinuation'] === true) {
        const text = errors.map(e => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
        const hookName = /^\[([^\]]+)\]/.exec(text)?.[1] ?? null;
        events.push({
          kind: 'hook', ptr, event: 'Stop', hook: hookName ? path.basename(hookName) : null, tool: null,
          outcome: 'stop-error', text: cut(text, max),
        });
      }
    }
    return events;
  }

  if (type === 'attachment') {
    const att = record['attachment'] as Record<string, unknown> | undefined;
    if (!att || typeof att !== 'object') return events;
    const event = typeof att['hookEvent'] === 'string' ? att['hookEvent'] : '';
    const hook = typeof att['hookName'] === 'string' ? att['hookName'] : null;
    const toolUseId = typeof att['toolUseID'] === 'string' ? att['toolUseID'] : '';
    const tool = ctx.toolNames.get(toolUseId) ?? null;
    const raw = att['stderr'] ?? att['content'];
    const text = cut(typeof raw === 'string' ? raw : raw === undefined || raw === null ? '' : JSON.stringify(raw), max);
    if (att['type'] === 'hook_blocking_error') {
      events.push({ kind: 'hook', ptr, event, hook, tool, outcome: 'blocked', text });
    } else if (att['type'] === 'hook_non_blocking_error') {
      events.push({ kind: 'hook', ptr, event, hook, tool, outcome: 'non-blocking-error', text });
    } else if (att['type'] === 'hook_cancelled' && att['timedOut'] === true) {
      events.push({ kind: 'hook', ptr, event, hook, tool, outcome: 'timed-out', text });
    }
  }
  return events;
}

function isHumanText(text: string): boolean {
  const t = text.trimStart();
  if (!t) return false;
  return !NON_HUMAN_PREFIXES.some(p => t.startsWith(p));
}

async function readOneFile(
  filePath: string,
  ctx: ProjectionContext,
  limits: ReadLimits,
  events: TranscriptEvent[],
): Promise<{ stats: ReadStats; recognisedRecords: number }> {
  const stats = emptyStats();
  let recognisedRecords = 0;
  for await (const item of iterateJsonl(filePath, limits, stats)) {
    if (item.kind !== 'record') continue;
    const r = item.record;
    if (typeof r['type'] === 'string' && RECOGNISED_TYPES.has(r['type'])) recognisedRecords++;
    if (events.length >= limits.maxEvents) {
      stats.truncatedEvents = true;
      continue;
    }
    for (const ev of projectRecord(r, item.line, ctx)) {
      if (events.length >= limits.maxEvents) {
        stats.truncatedEvents = true;
        break;
      }
      events.push(ev);
    }
  }
  return { stats, recognisedRecords };
}

/**
 * Read a session — the main transcript and, by default, every subagent
 * transcript — into typed events. Events keep file order; the main file comes
 * first, then subagents by file name. `status` is `degraded` when a file
 * could not be read or when the main file held records but none of a
 * recognised type (the format changed under us).
 */
export async function readSession(
  session: SessionFile,
  opts: { limits?: Partial<ReadLimits>; includeSubagents?: boolean; baseDir?: string } = {},
): Promise<SessionTranscript> {
  const limits: ReadLimits = { ...DEFAULT_READ_LIMITS, ...(opts.limits || {}) };
  const baseDir = opts.baseDir ?? path.dirname(session.filePath);
  const rel = (p: string) => path.relative(baseDir, p).split(path.sep).join('/');
  const events: TranscriptEvent[] = [];
  const files: TranscriptFileRead[] = [];
  const reasons: string[] = [];

  const targets: Array<{ filePath: string; agentId: string | null; agentType: string | null }> = [
    { filePath: session.filePath, agentId: null, agentType: null },
  ];
  if (opts.includeSubagents !== false) {
    for (const s of session.subagents) targets.push({ filePath: s.filePath, agentId: s.agentId, agentType: s.agentType });
  }

  for (const t of targets) {
    const ctx: ProjectionContext = {
      session: session.sessionId, file: rel(t.filePath), agentId: t.agentId,
      maxTextChars: limits.maxTextChars, toolNames: new Map(),
    };
    try {
      const { stats, recognisedRecords } = await readOneFile(t.filePath, ctx, limits, events);
      files.push({ file: ctx.file, agentId: t.agentId, agentType: t.agentType, stats, recognisedRecords });
      if (t.agentId === null && stats.records > 0 && recognisedRecords === 0) {
        reasons.push(`${ctx.file}: no records of a recognised Claude Code type — transcript format not understood`);
      }
    } catch (err) {
      reasons.push(`${ctx.file}: unreadable (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})`);
    }
  }

  return {
    status: reasons.length > 0 ? 'degraded' : 'ok',
    reason: reasons.length > 0 ? reasons.join('; ') : null,
    runtime: 'claude',
    session: session.sessionId,
    events,
    files,
    toolResults: session.toolResults,
  };
}

// ─── Excerpts ─────────────────────────────────────────────────────────────────

export const EXCERPT_MAX_CHARS = 160;

/**
 * The only form in which transcript text leaves a consumer: whitespace
 * collapsed, the home directory folded to `~`, credentials redacted, then cut
 * to `maxChars` (redaction runs on the whole text first, so a secret that
 * straddles the cut is still redacted).
 */
export function excerpt(text: string, maxChars: number = EXCERPT_MAX_CHARS, homeDir: string = os.homedir()): string {
  let t = text.replace(/\s+/g, ' ').trim();
  if (homeDir && homeDir.length > 1) t = t.split(homeDir).join('~');
  t = t.replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+(?=\/|\b)/g, '~');
  t = redactSecretText(t).text;
  if (t.length <= maxChars) return t;
  return t.slice(0, Math.max(0, maxChars - 1)) + '…';
}

/** A one-line, privacy-safe description of an event for context windows. */
export function describeEvent(ev: TranscriptEvent, maxChars: number = 80): string {
  switch (ev.kind) {
    case 'user-prompt': return `user: ${excerpt(ev.text, maxChars)}`;
    case 'user-interrupt': return ev.duringToolUse ? 'user interrupted a tool use' : 'user interrupted';
    case 'assistant-text': return `assistant: ${excerpt(ev.text, maxChars)}`;
    case 'tool-use': return `${ev.tool} ${excerpt(ev.input['command'] ?? ev.input['file_path'] ?? ev.input['pattern'] ?? ev.input['description'] ?? '', maxChars)}`.trim();
    case 'tool-result': return `${ev.tool ?? 'tool'} → ${ev.isError ? 'error' : 'ok'}${ev.isError ? `: ${excerpt(ev.text, maxChars)}` : ''}`;
    case 'hook': return `hook ${ev.event}${ev.hook ? ` ${excerpt(ev.hook, maxChars)}` : ''}${ev.tool ? ` on ${ev.tool}` : ''} ${ev.outcome}`;
    case 'api-error': return `api error: ${excerpt(ev.text, maxChars)}`;
    case 'compaction': return 'context compacted';
  }
}

/**
 * Pointers and one-line descriptions of the `window` events before and after
 * `index` in the same transcript file (events of other files interleaved
 * between them are skipped, not counted) — what an analyst reads instead of
 * the transcript.
 */
export function eventContext(
  events: readonly TranscriptEvent[],
  index: number,
  window: number,
  maxChars: number = 80,
): Array<{ ptr: TranscriptPointer; kind: TranscriptEvent['kind']; text: string }> {
  const anchor = events[index];
  if (!anchor) return [];
  const picked: number[] = [index];
  for (let i = index - 1, seen = 0; i >= 0 && seen < window; i--) {
    if (events[i].ptr.file !== anchor.ptr.file) continue;
    picked.unshift(i);
    seen++;
  }
  for (let i = index + 1, seen = 0; i < events.length && seen < window; i++) {
    if (events[i].ptr.file !== anchor.ptr.file) continue;
    picked.push(i);
    seen++;
  }
  return picked.map(i => ({ ptr: events[i].ptr, kind: events[i].kind, text: describeEvent(events[i], maxChars) }));
}

export function formatPointer(ptr: TranscriptPointer): string {
  return `${ptr.file}:${ptr.line}${ptr.uuid ? `#${ptr.uuid.slice(0, 8)}` : ''}`;
}
