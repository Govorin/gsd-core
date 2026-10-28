/**
 * Retro signals — deterministic friction signals for `/gsd-retro`.
 *
 * A retro is worth a model pass only when the session actually struggled.
 * This module decides that without a model: it reads the typed transcript
 * (session-transcript.cts) plus the planning record and git history, and
 * emits **signals** — each a kind, a weight, an occurrence count, pointers to
 * where it happened, and a short redacted excerpt. The session score against
 * `retro.signal_threshold` answers "suggest a retro or stay silent".
 *
 * ── What counts as friction ─────────────────────────────────────────────
 *
 * Instance signals (every occurrence scores): a user correction ("нет",
 * "не так", "стоп", "no", "wrong", …), a user interrupt, a tool call the user
 * rejected, a permission denial, a revert (`git revert`, a `Revert "…"`
 * commit, or reset --hard / checkout -- / restore covering the agent's own
 * uncommitted edits), a node repair, a `gaps_found` verdict, an API error, a
 * context compaction, a navigation streak (navigation calls with nothing
 * else in between).
 *
 * Repetition signals (score only from their threshold up): the same tool
 * error again, the same tool call again with nothing edited since, the same
 * range of a file re-read with no edit to it in between, the agent rewriting
 * lines it wrote itself in one file, the plan-checker spawned again (a
 * revision loop), a checkpoint reached again, the same hook blocking again.
 *
 * Behavioural kinds (MAIN_ONLY_KINDS) come from the main transcript only;
 * environment kinds come from subagent transcripts too.
 *
 * ── Thresholds and the score ────────────────────────────────────────────
 *
 * Every `*_min` threshold is "at least": a repetition signal exists when its
 * count is `>= min`, and its score is `weight × (count − min + 1)` — one
 * weight per occurrence at or past the threshold (its *units*). The session
 * score is not the sum of those: per kind, units are taken as a rate over the
 * session's volume and saturated —
 *
 *   kind score = weight × min(kind_cap, units × min(1, reference / volume))
 *
 * where volume is user turns for the user kinds (corrections, interrupts,
 * rejections; reference `volume_turns`), main-transcript tool calls for the
 * behavioural kinds and all tool calls for the rest (reference
 * `volume_calls`). A session up to the reference volume scores its units as
 * they are; a longer one scores the same rate, so length alone never crosses
 * the threshold, and one cause can never add more than `kind_cap` weights.
 * `suggest` is `score >= signal_threshold`. `max_signals` caps the list,
 * never the score: the cut signals are enumerated in `omitted`, by id, so
 * "nothing else" and "more than fit" are different answers.
 *
 * The defaults are calibrated on a corpus of real sessions (ADR-5209,
 * "Calibration"): mins at about the 90th percentile of what each detector
 * sees, references at about the 90th percentile of session volume.
 *
 * ── Privacy ─────────────────────────────────────────────────────────────
 *
 * No full text leaves this module. A signal carries pointers (file:line,
 * record uuid, commit sha) and one `excerpt()` of at most `excerpt_chars`;
 * keys (normalized commands, file paths, hook names) go through the same
 * redaction. A signal id is a hash of kind, key and first pointer — stable
 * across runs over the same files.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { tryWithinRootLexical } from './security.cjs';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import type { SpawnResultOutput } from './shell-command-projection.cjs';
import { excerpt } from './session-transcript.cjs';
import type { SessionTranscript, TranscriptEvent, TranscriptPointer } from './session-transcript.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterModule = require('./frontmatter.cjs');
const { extractFrontmatter } = frontmatterModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseLocatorModule = require('./phase-locator.cjs');
const { listMilestonePhaseDirs } = phaseLocatorModule;
// eslint-disable-next-line @typescript-eslint/no-require-imports
import planningWorkspaceModule = require('./planning-workspace.cjs');
const { planningPaths } = planningWorkspaceModule;

// ─── Thresholds ───────────────────────────────────────────────────────────────

export interface RetroThresholds {
  /** `retro.signal_threshold` — session score at or above which a retro is suggested. */
  signalThreshold: number;
  /** `retro.kind_cap` — units one kind can add to the score, at most. */
  kindCap: number;
  /** `retro.volume_calls` — tool calls up to which tool-side units count as they are. */
  volumeCalls: number;
  /** `retro.volume_turns` — user turns up to which user-side units count as they are. */
  volumeTurns: number;
  /** `retro.repeat_call_min` — identical tool calls with nothing edited in between. */
  repeatCallMin: number;
  /** `retro.repeat_error_min` — the same tool error. */
  repeatErrorMin: number;
  /** `retro.reread_min` — reads of one file range with no edit to it in between. */
  rereadMin: number;
  /** `retro.edit_churn_min` — edits of one file that rewrite lines an earlier own edit wrote. */
  editChurnMin: number;
  /** `retro.nav_streak_min` — navigation calls with nothing else in between. */
  navStreakMin: number;
  /** `retro.checker_loop_min` — plan-checker spawns. */
  checkerLoopMin: number;
  /** `retro.checkpoint_min` — checkpoints reached. */
  checkpointMin: number;
  /** `retro.hook_block_min` — blocks by the same hook. */
  hookBlockMin: number;
  /** `retro.excerpt_window` — events either side of a signal named in its window. */
  excerptWindow: number;
  /** `retro.max_signals` — signals listed (the rest are enumerated in `omitted`). */
  maxSignals: number;
  /** `retro.excerpt_chars` — maximum excerpt length. */
  excerptChars: number;
}

export const DEFAULT_RETRO_THRESHOLDS: Readonly<RetroThresholds> = Object.freeze({
  signalThreshold: 8,
  kindCap: 3,
  volumeCalls: 300,
  volumeTurns: 20,
  repeatCallMin: 3,
  repeatErrorMin: 2,
  rereadMin: 3,
  editChurnMin: 4,
  navStreakMin: 12,
  checkerLoopMin: 2,
  checkpointMin: 2,
  hookBlockMin: 1,
  excerptWindow: 6,
  maxSignals: 40,
  excerptChars: 160,
});

const THRESHOLD_KEYS: ReadonlyArray<[keyof RetroThresholds, string]> = [
  ['signalThreshold', 'signal_threshold'],
  ['kindCap', 'kind_cap'],
  ['volumeCalls', 'volume_calls'],
  ['volumeTurns', 'volume_turns'],
  ['repeatCallMin', 'repeat_call_min'],
  ['repeatErrorMin', 'repeat_error_min'],
  ['rereadMin', 'reread_min'],
  ['editChurnMin', 'edit_churn_min'],
  ['navStreakMin', 'nav_streak_min'],
  ['checkerLoopMin', 'checker_loop_min'],
  ['checkpointMin', 'checkpoint_min'],
  ['hookBlockMin', 'hook_block_min'],
  ['excerptWindow', 'excerpt_window'],
  ['maxSignals', 'max_signals'],
  ['excerptChars', 'excerpt_chars'],
];

/**
 * Thresholds from a project config object (`retro.<key>` nested, or the flat
 * dotted form). A value that is not a non-negative integer (or, for the
 * `*_min`, cap and volume keys, below 1) keeps the default and is named in
 * `problems` — a typo never silently becomes "no threshold".
 */
const FLOOR_ONE_KEYS = new Set(['max_signals', 'excerpt_chars', 'kind_cap', 'volume_calls', 'volume_turns']);

export function resolveRetroThresholds(config: Record<string, unknown> | null | undefined): {
  thresholds: RetroThresholds;
  problems: string[];
} {
  const thresholds: RetroThresholds = { ...DEFAULT_RETRO_THRESHOLDS };
  const problems: string[] = [];
  const nested = config && typeof config['retro'] === 'object' && config['retro'] !== null
    ? (config['retro'] as Record<string, unknown>)
    : {};
  for (const [field, key] of THRESHOLD_KEYS) {
    const raw = nested[key] !== undefined ? nested[key] : config?.[`retro.${key}`];
    if (raw === undefined || raw === null) continue;
    const floor = key.endsWith('_min') || FLOOR_ONE_KEYS.has(key) ? 1 : 0;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < floor) {
      problems.push(`retro.${key} must be an integer >= ${floor}, got ${JSON.stringify(raw)} — using ${DEFAULT_RETRO_THRESHOLDS[field]}`);
      continue;
    }
    thresholds[field] = raw;
  }
  return { thresholds, problems };
}

// ─── Signal model ─────────────────────────────────────────────────────────────

export const SIGNAL_KIND = Object.freeze({
  UserCorrection: 'user-correction',
  UserInterrupt: 'user-interrupt',
  ToolRejected: 'tool-rejected',
  PermissionDenial: 'permission-denial',
  HookBlock: 'hook-block',
  HookError: 'hook-error',
  RepeatedToolError: 'repeated-tool-error',
  RepeatedCall: 'repeated-call',
  Reread: 'reread',
  EditChurn: 'edit-churn',
  NavStreak: 'nav-streak',
  Revert: 'revert',
  PlanCheckerLoop: 'plan-checker-loop',
  NodeRepair: 'node-repair',
  GapsFound: 'gaps-found',
  RepeatedCheckpoint: 'repeated-checkpoint',
  ApiError: 'api-error',
  Compaction: 'compaction',
} as const);

export type SignalKind = typeof SIGNAL_KIND[keyof typeof SIGNAL_KIND];

/** Per-occurrence weight of each kind. */
export const SIGNAL_WEIGHTS: Readonly<Record<SignalKind, number>> = Object.freeze({
  'user-correction': 3,
  'user-interrupt': 2,
  'tool-rejected': 2,
  'permission-denial': 1,
  'hook-block': 2,
  'hook-error': 1,
  'repeated-tool-error': 2,
  'repeated-call': 1,
  'reread': 1,
  'edit-churn': 1,
  'nav-streak': 2,
  'revert': 3,
  'plan-checker-loop': 2,
  'node-repair': 2,
  'gaps-found': 3,
  'repeated-checkpoint': 1,
  'api-error': 1,
  'compaction': 1,
});

export type SignalPointer =
  | ({ source: 'transcript' } & TranscriptPointer)
  | { source: 'artifact'; file: string; line: number }
  | { source: 'git'; commit: string; timestamp: string | null };

export interface RetroSignal {
  id: string;
  kind: SignalKind;
  weight: number;
  count: number;
  score: number;
  /** Normalized, redacted subject: a command, a file, a hook. */
  key: string | null;
  /**
   * What the signal is about, stable across sessions and checkouts: the kind
   * and the group's identity (a repeated tool error is its tool and error, not
   * the first command that hit it) with every path masked. Null for a signal
   * with no subject (a correction, a compaction). See `signalFingerprint`.
   */
  fingerprint: string | null;
  /** The basis said nothing specific once masked (`Exit code 1`, a URL, only paths): shown on recurrence, never enforced. */
  fingerprintWeak: boolean;
  /** Where it happened — the first `MAX_POINTERS` occurrences. */
  pointers: SignalPointer[];
  excerpt: string | null;
  /** The transcript lines an analyst reads around the first occurrence. */
  window: { file: string; fromLine: number; toLine: number } | null;
}

export const MAX_POINTERS = 5;

// ─── Evidence outside the transcript ──────────────────────────────────────────

export interface ArtifactFinding {
  kind: 'gaps-found';
  file: string;
  line: number;
  excerpt: string;
}

export interface GitRevert {
  commit: string;
  subject: string;
  timestamp: string | null;
}

export interface PlanningEvidence {
  status: 'ok' | 'degraded' | 'absent';
  reason: string | null;
  findings: ArtifactFinding[];
}

/**
 * `gaps_found` verdicts in the current milestone's phase verification
 * reports. Phases are enumerated by the single owner
 * (phase-locator `listMilestonePhaseDirs`: milestone window, sentinels
 * refused, workstream-aware through `planningPaths`); this function only
 * lists the files inside each phase directory it is handed. `sinceMs` keeps
 * only reports modified at or after it. Pointers are project-relative POSIX
 * paths with the `status:` line.
 */
export function collectPlanningEvidence(projectRoot: string, opts: { sinceMs?: number } = {}): PlanningEvidence {
  const phasesRoot = planningPaths(projectRoot).phases;
  if (!fs.existsSync(phasesRoot)) return { status: 'absent', reason: 'no phases directory', findings: [] };
  const { value: phaseDirNames, scope } = listMilestonePhaseDirs(phasesRoot, { cwd: projectRoot });
  // `unreadable` with no dirs: the phases directory itself could not be read.
  // `unreadable` with dirs: the milestone window could not be read (no
  // ROADMAP), so every non-sentinel phase is considered — said, not hidden.
  if (scope === 'unreadable' && phaseDirNames.length === 0) {
    return { status: 'degraded', reason: 'phases directory unreadable', findings: [] };
  }
  const windowReason = scope === 'unreadable'
    ? 'milestone window unreadable — every phase considered'
    : scope === 'truncated' ? 'milestone phase window truncated' : null;
  const findings: ArtifactFinding[] = [];
  for (const dirName of phaseDirNames) {
    const dirAbs = path.join(phasesRoot, dirName);
    let names: string[];
    try {
      names = fs.readdirSync(dirAbs).filter(n => /-VERIFICATION\.md$/.test(n)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(dirAbs, name);
      let text: string;
      try {
        if (opts.sinceMs !== undefined && fs.statSync(abs).mtimeMs < opts.sinceMs) continue;
        text = fs.readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const fm = extractFrontmatter(text) as Record<string, unknown>;
      if (fm['status'] !== 'gaps_found') continue;
      const lineIdx = text.split('\n').findIndex(l => /^status:\s*gaps_found\b/.test(l));
      findings.push({
        kind: 'gaps-found',
        file: path.relative(projectRoot, abs).split(path.sep).join('/'),
        line: lineIdx + 1,
        excerpt: 'status: gaps_found',
      });
    }
  }
  return { status: windowReason ? 'degraded' : 'ok', reason: windowReason, findings };
}

export type GitRunner = (args: string[], opts?: { cwd?: string }) => SpawnResultOutput;

export interface GitEvidence {
  status: 'ok' | 'degraded';
  reason: string | null;
  reverts: GitRevert[];
}

const REVERT_SUBJECT_RE = /^(?:Revert "|revert(?:\([^)]*\))?!?:)/;

/** Revert commits on HEAD since a git date (`"7 days ago"`, an ISO date), through the git seam. */
export function collectGitReverts(projectRoot: string, opts: { since: string; execGit?: GitRunner }): GitEvidence {
  const run = opts.execGit ?? execGitSeam;
  const res = run(['log', `--since=${opts.since}`, '--format=%H%x1f%cI%x1f%s'], { cwd: projectRoot });
  if (res.exitCode !== 0) {
    return { status: 'degraded', reason: `git log failed: ${excerpt(res.stderr || res.error?.message || 'unknown error', 120)}`, reverts: [] };
  }
  const reverts: GitRevert[] = [];
  for (const line of res.stdout.split('\n')) {
    const [commit, timestamp, subject] = line.split('\x1f');
    if (!commit || subject === undefined || !REVERT_SUBJECT_RE.test(subject)) continue;
    reverts.push({ commit, subject, timestamp: timestamp || null });
  }
  return { status: 'ok', reason: null, reverts };
}

// ─── Transcript detectors ─────────────────────────────────────────────────────

// `\b` is ASCII-only even under the `u` flag, so "нет\b" never matches:
// word ends are spelled as "not followed by a letter or digit" (`E`).
// phase-id-owner: a Unicode word end for the correction phrases below, not a phase-name validity check (hasNameableContent is unrelated).
const E = '(?![\\p{L}\\p{N}])';
const CORRECTION_START_RE = new RegExp(
  `^(?:нет${E}|не так${E}|не то${E}|не надо${E}|не нужно${E}|не делай${E}|стоп${E}|стой${E}|подожди|отмени|откати|верни${E}|` +
  `неправильно|ошибка${E}|опять${E}|снова${E}|no${E}|nope${E}|stop${E}|wait${E}|don't${E}|do not${E}|wrong${E}|` +
  `that's not|that is not|not what|undo${E}|revert${E}|again${E})`,
  'iu',
);
const CORRECTION_ANYWHERE_RE = new RegExp(
  `(?:я же (?:сказал|просил|говорил)|как я (?:сказал|просил)|ещё раз${E}|еще раз${E}|i (?:said|told you|asked you)${E}|as i said${E})`,
  'iu',
);

/** A user prompt that pushes back on what the agent just did. */
export function isCorrection(text: string): boolean {
  const t = text.trim().replace(/^[\s"'«>*-]+/, '');
  return CORRECTION_START_RE.test(t) || CORRECTION_ANYWHERE_RE.test(t.slice(0, 400));
}

// One git command that can throw work away. `git revert` always does; the
// others only when they cover the agent's own uncommitted edits (see
// `revertsOwnWork`) — `git reset --hard next` on a fresh worktree or
// `git checkout -- <regenerated file>` is housekeeping, not a revert.
const REVERT_COMMAND_RE = /\bgit\s+(?:-C\s+\S+\s+)?(revert\b|reset\s+--hard\b|checkout\s+--\s|restore\b(?![^\n;&|]*--staged))([^\n;&|>]*)/g;
const COMMIT_COMMAND_RE = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;
const NODE_REPAIR_RE = /\[Node Repair - (RETRY|DECOMPOSE|PRUNE)\]/;
const CHECKPOINT_RE = /CHECKPOINT REACHED/;
const GAPS_FOUND_RE = /\bstatus:\s*gaps_found\b|\bgaps_found\b/;

const NAV_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NAV_BASH_RE = /^(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|ag|find|ls|tree|cat|head|tail|wc|sed\s+-n|git\s+(?:grep|log|show|ls-files))\b/;
// Structural navigation through MCP servers (LSP, code graph, Nx index,
// indexed search): navigation like Read/Grep, never an edit.
const MCP_NAV_RE = /^mcp__.*(?:serena__(?:find_|get_symbols|search_for_pattern|list_dir|read_file)|codebase-memory-mcp__(?:search_|trace_|get_|query_)|atlas__atlas_(?:get_|find_|search_|validate_)|context-mode__ctx_search$)/;
// Symbol-level edits through serena: an edit like Edit/Write.
const MCP_EDIT_RE = /^mcp__.*serena__(?:replace_|insert_|rename_symbol|create_text_file|safe_delete)/;
// Waiting on agents, background jobs and schedules: asking again is how they are polled.
const POLL_TOOLS = new Set(['ListAgents', 'ReadNotifications', 'ScheduleWakeup', 'TaskOutput', 'BashOutput', 'TaskList', 'TaskGet', 'Monitor', 'CronList']);

/**
 * Kinds that describe how an agent worked rather than what the environment
 * did to it. They are detected in the main transcript only: a subagent's
 * navigation and edit pattern is its assignment (an Explore agent does
 * nothing but navigate, an executor edits one file many times), and a long
 * orchestration would multiply them by the number of agents it spawned.
 * Everything else — hooks, denials, repeated tool errors, API errors,
 * verdicts — is the same environment wherever it hits, and counts from
 * subagents too.
 */
export const MAIN_ONLY_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  SIGNAL_KIND.NavStreak, SIGNAL_KIND.Reread, SIGNAL_KIND.EditChurn, SIGNAL_KIND.RepeatedCall, SIGNAL_KIND.Revert,
]);

function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool) || MCP_EDIT_RE.test(tool);
}

function isNavigation(tool: string, command: string): boolean {
  return NAV_TOOLS.has(tool) || MCP_NAV_RE.test(tool) || (tool === 'Bash' && NAV_BASH_RE.test(command.trim()));
}

/** Does a pathspec name this edited file (or a directory holding it)? */
function pathspecCovers(spec: string, edited: string): boolean {
  const s = spec.replace(/^\.\//, '').replace(/\/+$/, '');
  if (s === '' || s === '.' || s === ':/') return true;
  return edited === s || edited.endsWith(`/${s}`) || edited.includes(`/${s}/`) || edited.startsWith(`${s}/`); // allow-handrolled-containment: matches a git pathspec against a path string from the transcript (selection, no filesystem access), not a containment decision
}

/**
 * The own uncommitted edits a shell command throws away, or null when it
 * throws none away. `git revert` reverts a commit and always counts;
 * `reset --hard` counts when there are own edits to lose; `checkout --` and
 * `restore` count when a pathspec covers one.
 */
export function revertsOwnWork(command: string, ownEdits: ReadonlySet<string>): string[] | null {
  // A commit message, an echo or a heredoc that mentions `git restore` runs nothing:
  // heredoc bodies and quoted strings with a space in them are prose, not pathspecs.
  // A heredoc cut at capture (no terminator) runs to the end of the text.
  const code = command
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n(?:[\s\S]*?\n\s*\1\b|[\s\S]*$)/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*\s(?:[^"\\\n]|\\.)*"|'[^'\n]*\s[^'\n]*'/g, ' ');
  const lost = new Set<string>();
  let reverted = false;
  for (const m of code.matchAll(REVERT_COMMAND_RE)) {
    const verb = m[1];
    if (verb.startsWith('revert')) {
      reverted = true;
      continue;
    }
    if (verb.startsWith('reset')) {
      for (const p of ownEdits) lost.add(p);
      continue;
    }
    const specs = m[2].split(/\s+/).map(a => a.replace(/^["']|["']$/g, '')).filter(a => a && !a.startsWith('-'));
    for (const p of ownEdits) if (specs.some(s => pathspecCovers(s, p))) lost.add(p);
  }
  return reverted || lost.size > 0 ? [...lost] : null;
}

/** Lines long enough to identify text, trimmed. */
function substantiveLines(text: string | undefined): string[] {
  return (text ?? '').split('\n').map(l => l.trim()).filter(l => l.length >= 12);
}

/** The (old, new) text pairs of one edit call; a Write has no old text. */
function editPairs(ev: Extract<TranscriptEvent, { kind: 'tool-use' }>): Array<{ oldText: string | null; newText: string }> {
  if (ev.tool === 'Write') return [{ oldText: null, newText: ev.input['content'] ?? '' }];
  if (ev.tool === 'MultiEdit') {
    try {
      const edits = JSON.parse(ev.input['edits'] ?? '[]') as Array<{ old_string?: unknown; new_string?: unknown }>;
      if (Array.isArray(edits)) {
        return edits.map(e => ({ oldText: typeof e.old_string === 'string' ? e.old_string : '', newText: typeof e.new_string === 'string' ? e.new_string : '' }));
      }
    } catch {
      // cut at capture: fall through to the raw text
    }
    return [{ oldText: ev.input['edits'] ?? '', newText: '' }];
  }
  return [{ oldText: ev.input['old_string'] ?? '', newText: ev.input['new_string'] ?? '' }];
}

/**
 * A command reduced to what identifies it as "the same call again": the home
 * directory folded, long numbers and hashes masked, whitespace collapsed,
 * credentials redacted, length capped.
 */
export function normalizeKey(text: string, maxChars = 120): string {
  const masked = text
    .replace(/\b[0-9a-f]{7,40}\b/gi, 'H')
    .replace(/\b\d{4,}\b/g, 'N');
  return excerpt(masked, maxChars);
}

/** The first words of a hook's message with every number masked — "Blocked: sleep N followed by:". */
function hookMessageKey(text: string): string {
  const words = text.replace(/<\/?tool_use_error>/g, ' ').replace(/\d+/g, 'N').trim().split(/\s+/).slice(0, 6);
  return excerpt(words.join(' '), 80);
}

/** An error's first line, with the next one after a bare `Exit code N`. */
function errorLine(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  return lines[0] && /^Exit code \d+$/.test(lines[0]) && lines[1] ? `${lines[0]} ${lines[1]}` : (lines[0] ?? '');
}

/** The error line normalized and redacted, not cut (the fingerprint's input). */
function errorHead(text: string): string {
  return normalizeKey(errorLine(text), 100_000);
}

function errorKey(text: string): string {
  return normalizeKey(errorLine(text), 100);
}

function filePathOf(ev: Extract<TranscriptEvent, { kind: 'tool-use' }>): string | null {
  return ev.input['file_path'] ?? ev.input['notebook_path'] ?? ev.input['path'] ?? ev.input['relative_path'] ?? null;
}

interface Occurrence {
  index: number;
  ptr: SignalPointer;
  text: string | null;
}

interface Group {
  kind: SignalKind;
  key: string | null;
  /** What the fingerprint hashes: the group's identity without its scope; the key unless a kind says otherwise. */
  basis: string | null;
  /** The basis is weak (`isWeakBasis`). */
  weak?: boolean;
  occurrences: Occurrence[];
  /** Repetition kinds: the threshold; instance kinds: 1. */
  min: number;
}

function tptr(ev: TranscriptEvent): SignalPointer {
  return { source: 'transcript', ...ev.ptr };
}

function groupsFromTranscript(transcript: SessionTranscript, t: RetroThresholds, roots: readonly string[] = []): Group[] {
  const instances: Group[] = [];
  const keyed = new Map<string, Group>();
  const events = transcript.events;

  function instance(kind: SignalKind, index: number, key: string | null, text: string | null, basis: string | null = key): void {
    instances.push({ kind, key, basis, min: 1, occurrences: [{ index, ptr: tptr(events[index]), text }] });
  }
  // A repetition is "the same thing again in the same context": groups are
  // scoped to one transcript file (the main session or one subagent) unless
  // `crossFile`, and identified by `identity` — the full normalized subject —
  // while `key` is only its capped display form.
  function keyedHit(
    kind: SignalKind, key: string, min: number, index: number, text: string | null,
    opts: { identity?: string; crossFile?: boolean; basis?: string; weak?: boolean } = {},
  ): void {
    const scope = opts.crossFile ? '' : events[index].ptr.file;
    const id = `${kind}\u0000${scope}\u0000${opts.identity ?? key}`;
    let g = keyed.get(id);
    if (!g) {
      g = { kind, key, basis: opts.basis ?? key, weak: opts.weak === true, min, occurrences: [] };
      keyed.set(id, g);
    }
    g.occurrences.push({ index, ptr: tptr(events[index]), text });
  }

  const toolUses = new Map<string, Extract<TranscriptEvent, { kind: 'tool-use' }>>();
  // Main-transcript edit calls awaiting their result, by tool-use id → event index.
  const useIndex = new Map<string, number>();
  // Per transcript file: the navigation streak, reads since the last edit (by
  // file and range), the lines each own edit introduced, own edits not yet
  // committed, and the edit epoch (edits so far).
  interface FileState {
    streak: { start: number; last: number; length: number } | null;
    reads: Map<string, Occurrence[]>;
    introduced: Map<string, Set<string>>;
    ownEdits: Set<string>;
    epoch: number;
  }
  const states = new Map<string, FileState>();
  const stateOf = (file: string): FileState => {
    let s = states.get(file);
    if (!s) {
      s = { streak: null, reads: new Map(), introduced: new Map(), ownEdits: new Set(), epoch: 0 };
      states.set(file, s);
    }
    return s;
  };
  const maxRuns = new Map<string, { path: string; run: Occurrence[] }>();

  function closeStreak(s: FileState): void {
    const run = s.streak;
    if (run && run.length >= t.navStreakMin) {
      instances.push({
        // The streak's length is this session's; the friction (searching instead of knowing where) is not.
        kind: SIGNAL_KIND.NavStreak, key: `${run.length} navigation calls in a row`, basis: 'navigation streak', min: 1,
        occurrences: [{ index: run.start, ptr: tptr(events[run.start]), text: null }, { index: run.last, ptr: tptr(events[run.last]), text: null }],
      });
    }
    s.streak = null;
  }

  /** An own edit of `p`: rewrites of earlier own lines are edit churn. */
  function ownEdit(s: FileState, ev: Extract<TranscriptEvent, { kind: 'tool-use' }>, p: string, i: number): void {
    s.ownEdits.add(p);
    for (const key of [...s.reads.keys()]) if (key.split('\u0000')[0] === p) s.reads.delete(key);
    if (!EDIT_TOOLS.has(ev.tool)) return;
    const introduced = s.introduced.get(p) ?? new Set<string>();
    let rewrite = false;
    for (const { oldText, newText } of editPairs(ev)) {
      const after = new Set(substantiveLines(newText));
      // A Write replaces the whole file: every line an earlier edit introduced is its old text.
      const before = oldText === null ? [...introduced] : substantiveLines(oldText);
      if (before.some(l => introduced.has(l) && !after.has(l))) rewrite = true;
      const beforeSet = new Set(before);
      for (const l of after) if (!beforeSet.has(l)) introduced.add(l);
    }
    s.introduced.set(p, introduced);
    if (rewrite) keyedHit(SIGNAL_KIND.EditChurn, excerpt(p, 120), t.editChurnMin, i, null, { identity: p });
  }

  events.forEach((ev, i) => {
    const file = ev.ptr.file;
    // Behavioural kinds come from the main transcript only (MAIN_ONLY_KINDS).
    const main = ev.ptr.agentId === undefined;
    switch (ev.kind) {
      case 'user-prompt':
        if (isCorrection(ev.text)) instance(SIGNAL_KIND.UserCorrection, i, null, ev.text);
        if (main) closeStreak(stateOf(file));
        return;
      case 'user-interrupt':
        instance(SIGNAL_KIND.UserInterrupt, i, ev.duringToolUse ? 'during tool use' : null, null);
        return;
      case 'api-error':
        instance(SIGNAL_KIND.ApiError, i, null, ev.text);
        return;
      case 'compaction':
        instance(SIGNAL_KIND.Compaction, i, null, null);
        // What was read before a compaction is gone from context: reading it again is not a reread.
        stateOf(file).reads.clear();
        return;
      case 'assistant-text': {
        const repair = NODE_REPAIR_RE.exec(ev.text);
        if (repair) instance(SIGNAL_KIND.NodeRepair, i, repair[1], repair[0]);
        if (CHECKPOINT_RE.test(ev.text)) keyedHit(SIGNAL_KIND.RepeatedCheckpoint, 'checkpoint', t.checkpointMin, i, null);
        return;
      }
      case 'hook': {
        // The same hook blocking again is environment friction wherever it
        // happens, so hook groups span files.
        const who = [ev.event, ev.hook ? excerpt(ev.hook, 60) : null, ev.tool].filter(Boolean).join(' ');
        if (ev.outcome === 'blocked') {
          keyedHit(SIGNAL_KIND.HookBlock, `${who} ${hookMessageKey(ev.text)}`.trim(), t.hookBlockMin, i, ev.text, { crossFile: true });
        } else {
          keyedHit(SIGNAL_KIND.HookError, `${who} ${ev.outcome}`, 1, i, ev.text, { crossFile: true });
        }
        return;
      }
      case 'tool-use': {
        toolUses.set(`${file}\u0000${ev.toolUseId}`, ev);
        if (ev.tool === 'Agent' || ev.tool === 'Task') {
          if (ev.input['subagent_type'] === 'gsd-plan-checker') keyedHit(SIGNAL_KIND.PlanCheckerLoop, 'gsd-plan-checker', t.checkerLoopMin, i, null);
        }
        if (!main) return;
        const s = stateOf(file);
        const command = ev.input['command'] ?? '';
        const p = filePathOf(ev);
        const edit = isEditTool(ev.tool);
        if (ev.tool === 'Bash') {
          const lost = revertsOwnWork(command, s.ownEdits);
          if (lost) {
            instance(SIGNAL_KIND.Revert, i, normalizeKey(command), null);
            for (const q of lost) s.ownEdits.delete(q);
          }
          if (COMMIT_COMMAND_RE.test(command)) s.ownEdits.clear();
        }
        // The same call again with nothing edited since — re-running a check
        // after a fix is the loop working, and polling is how waiting looks.
        if (ev.tool !== 'Read' && !POLL_TOOLS.has(ev.tool)) {
          const call = `${ev.tool} ${JSON.stringify(ev.input)}`;
          keyedHit(SIGNAL_KIND.RepeatedCall, normalizeKey(call, 160), t.repeatCallMin, i, null, { identity: `${s.epoch}\u0000${call}` });
        }
        // Navigation streak: navigation calls with nothing else in between.
        if (isNavigation(ev.tool, command)) {
          if (s.streak) {
            s.streak.length++;
            s.streak.last = i;
          } else {
            s.streak = { start: i, last: i, length: 1 };
          }
        } else {
          closeStreak(s);
        }
        if (edit) useIndex.set(`${file}\u0000${ev.toolUseId}`, i);
        if (!p) return;
        if (ev.tool === 'Read') {
          // The same range of the same file again, with no edit to it in between.
          const readKey = [p, ev.input['offset'] ?? '', ev.input['limit'] ?? ''].join('\u0000');
          const run = s.reads.get(readKey) ?? [];
          run.push({ index: i, ptr: tptr(ev), text: null });
          s.reads.set(readKey, run);
          const best = maxRuns.get(`${file}\u0000${readKey}`);
          if (!best || run.length > best.run.length) maxRuns.set(`${file}\u0000${readKey}`, { path: p, run: [...run] });
        }
        return;
      }
      case 'tool-result': {
        const use = toolUses.get(`${file}\u0000${ev.toolUseId}`);
        // An edit counts once it went through: a rejected or failed edit changed nothing.
        const editAt = useIndex.get(`${file}\u0000${ev.toolUseId}`);
        if (use && editAt !== undefined && !ev.isError) {
          const s = stateOf(file);
          s.epoch++;
          const p = filePathOf(use);
          if (p) ownEdit(s, use, p, editAt);
        }
        if (!ev.isError) return;
        const subject = use ? `${use.tool} ${normalizeKey(use.input['command'] ?? filePathOf(use) ?? '', 80)}`.trim() : (ev.tool ?? 'tool');
        // A denial is about the kind of call refused, not this call's arguments.
        const call = use ? callBasis(use.tool, { command: use.input['command'], filePath: filePathOf(use) }, roots) : (ev.tool ?? 'tool');
        const denied = call;
        if (ev.denial === 'user-rejected') {
          instance(SIGNAL_KIND.ToolRejected, i, subject, null, denied);
        } else if (ev.denial === 'permission-rule' || ev.denial === 'other') {
          instance(SIGNAL_KIND.PermissionDenial, i, subject, ev.text, denied);
        } else if (ev.blockedBy === null && ev.denial === null) {
          // The same wall hit again: one tool, one error, whatever the
          // arguments were (a test command re-run with a different filter,
          // a path guessed three ways). The key shows the first call.
          const err = errorKey(ev.text);
          const tool = use?.tool ?? ev.tool ?? '';
          // The error before any cut: a long path must not push the words that name the error off the end.
          const fb = toolErrorBasis(tool, errorHead(ev.text), call);
          keyedHit(SIGNAL_KIND.RepeatedToolError, `${subject} → ${err}`, t.repeatErrorMin, i, ev.text, {
            identity: `${tool}\u0000${err}`,
            basis: fb.basis ?? undefined,
            weak: fb.weak,
          });
        }
        if ((ev.tool === 'Agent' || ev.tool === 'Task') && GAPS_FOUND_RE.test(ev.text)) {
          instance(SIGNAL_KIND.GapsFound, i, 'verifier', null);
        }
        return;
      }
    }
  });

  // Subagent results arrive as non-error tool results too: scan them for verdicts.
  events.forEach((ev, i) => {
    if (ev.kind === 'tool-result' && !ev.isError && (ev.tool === 'Agent' || ev.tool === 'Task')) {
      if (GAPS_FOUND_RE.test(ev.text)) instance(SIGNAL_KIND.GapsFound, i, 'verifier', null);
      if (CHECKPOINT_RE.test(ev.text)) keyedHit(SIGNAL_KIND.RepeatedCheckpoint, 'checkpoint', t.checkpointMin, i, null);
    }
  });

  for (const s of states.values()) closeStreak(s);
  for (const { path: p, run } of maxRuns.values()) {
    if (run.length < t.rereadMin) continue;
    instances.push({ kind: SIGNAL_KIND.Reread, key: excerpt(p, 120), basis: excerpt(p, 120), min: t.rereadMin, occurrences: run });
  }
  return [...instances, ...[...keyed.values()].filter(g => g.occurrences.length >= g.min)];
}

// ─── Report ───────────────────────────────────────────────────────────────────

export interface RetroSignalReport {
  status: 'ok' | 'degraded';
  /** Why the report is partial, one entry per source that could not be read fully. */
  reasons: string[];
  sources: {
    transcript: 'read' | 'degraded' | 'absent';
    planning: 'read' | 'degraded' | 'absent';
    git: 'read' | 'degraded' | 'absent';
  };
  session: string | null;
  thresholds: RetroThresholds;
  /** Per kind, units as a rate over the session volume, saturated at `kind_cap`, weighted — summed. */
  score: number;
  threshold: number;
  suggest: boolean;
  /** The plain sum of signal scores: what the session would score with no rate and no cap. */
  rawScore: number;
  volume: SessionVolume;
  scoreByKind: Partial<Record<SignalKind, number>>;
  countsByKind: Partial<Record<SignalKind, number>>;
  signals: RetroSignal[];
  /** Signals past `max_signals`, by id — listed, never dropped silently. */
  /** Signals cut past `retro.max_signals`: enough to cite and to recognise again, no key or text. */
  omitted: Array<{ id: string; kind: SignalKind; score: number; count: number; fingerprint: string | null; fingerprintWeak: boolean }>;
}

/** How much session there was to have friction in. */
export interface SessionVolume {
  /** User prompts in the main transcript. */
  userTurns: number;
  /** Tool calls in the main transcript. */
  mainToolCalls: number;
  /** Tool calls in the main transcript and every subagent transcript. */
  toolCalls: number;
}

/** Kinds that are the user pushing back; their volume is user turns. */
export const USER_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  SIGNAL_KIND.UserCorrection, SIGNAL_KIND.UserInterrupt, SIGNAL_KIND.ToolRejected,
]);

export function sessionVolume(transcript: SessionTranscript | null): SessionVolume {
  const volume: SessionVolume = { userTurns: 0, mainToolCalls: 0, toolCalls: 0 };
  for (const ev of transcript?.events ?? []) {
    const main = ev.ptr.agentId === undefined;
    if (ev.kind === 'user-prompt' && main) volume.userTurns++;
    if (ev.kind === 'tool-use') {
      volume.toolCalls++;
      if (main) volume.mainToolCalls++;
    }
  }
  return volume;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The session score (see the module header): per kind, units scaled to a
 * rate past the reference volume, capped at `kind_cap`, times the weight.
 * Rounded to two decimals so the threshold comparison is stable.
 */
export function sessionScore(signals: readonly RetroSignal[], volume: SessionVolume, t: RetroThresholds): {
  score: number;
  scoreByKind: Partial<Record<SignalKind, number>>;
} {
  const units = new Map<SignalKind, number>();
  for (const s of signals) units.set(s.kind, (units.get(s.kind) ?? 0) + s.score / s.weight);
  const scoreByKind: Partial<Record<SignalKind, number>> = {};
  let score = 0;
  for (const [kind, u] of units) {
    const [actual, reference] = USER_KINDS.has(kind)
      ? [volume.userTurns, t.volumeTurns]
      : [MAIN_ONLY_KINDS.has(kind) ? volume.mainToolCalls : volume.toolCalls, t.volumeCalls];
    const rate = Math.min(1, reference / Math.max(1, actual));
    const kindScore = round2(SIGNAL_WEIGHTS[kind] * Math.min(t.kindCap, u * rate));
    scoreByKind[kind] = kindScore;
    score += kindScore;
  }
  return { score: round2(score), scoreByKind };
}

function pointerString(p: SignalPointer): string {
  if (p.source === 'transcript') return `${p.file}:${p.line}`;
  if (p.source === 'artifact') return `${p.file}:${p.line}`;
  return p.commit;
}

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`<>)]+/gi;
const WIN_PATH_RE = /(^|[\s'"`=(:,])[A-Za-z]:\\[^\s'"`);|&]*/g;
const HOME_PATH_RE = /~\/[^\s'"`);|&]*/g;
const ABS_PATH_RE = /(^|[\s'"`=(:,])\/[^\s'"`);|&]+/g;

/**
 * Every path in a text masked to `<path>`: `~/…`, absolute POSIX paths and
 * Windows paths (`C:\…`). A worktree root, a project root and a temp
 * directory all differ between sessions and checkouts while the friction is
 * the same. URLs are left as they are (`maskVolatile` masks them for a
 * fingerprint).
 */
export function maskPaths(text: string): string {
  const urls: string[] = [];
  return text
    .replace(URL_RE, (u) => { urls.push(u); return `\u0001${urls.length - 1}\u0001`; })
    .replace(HOME_PATH_RE, '<path>')
    .replace(ABS_PATH_RE, '$1<path>')
    .replace(WIN_PATH_RE, '$1<path>')
    .replace(/<path>…/g, '<path>')
    .replace(/\u0001(\d+)\u0001/g, (_m, i: string) => urls[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
}

/** The last segment of a path, for the weak form of a basis (`foo.spec.ts`). */
function pathName(p: string): string {
  const parts = p.replace(/…$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : '<path>';
}

/**
 * What changes between sessions masked, for a fingerprint: URLs (`<url>`, or
 * `<url:host>` with `keepNames`), paths (`<path>`, or their last segment with
 * `keepNames`), every number (`N`, whatever its length), shell variables
 * (`$V`). A trailing cut mark is dropped.
 */
export function maskVolatile(text: string, opts: { keepNames?: boolean } = {}): string {
  const keep = opts.keepNames === true;
  return text
    .replace(URL_RE, (u) => (keep ? `<url:${(/^[a-z][a-z0-9+.-]*:\/\/([^/\s?#]+)/i.exec(u) ?? ['', '?'])[1]}>` : '<url>'))
    .replace(HOME_PATH_RE, (m) => (keep ? pathName(m) : '<path>'))
    .replace(ABS_PATH_RE, (m: string, pre: string) => `${pre}${keep ? pathName(m.slice(pre.length)) : '<path>'}`)
    .replace(WIN_PATH_RE, (m: string, pre: string) => `${pre}${keep ? pathName(m.slice(pre.length)) : '<path>'}`)
    .replace(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/g, '$V')
    // A standalone number is volatile (a line, a count, a pid); digits inside
    // an identifier are not (TS2304, E11000, ES2022). A status — three digits
    // after status/code/HTTP — keeps its value: 404 and 500 are two frictions,
    // line 12 and line 13 are one.
    .replace(/\b(status|code|HTTP(?:\/[\d.]+)?)(\s*[:=]?\s*)([1-5]\d\d)\b/gi, '$1$2\u0002$3')
    .replace(/(^|[^\w\u0002])\d+(?:\.\d+)*(?![\w])/g, '$1N')
    .replace(/\u0002/g, '')
    .replace(/<path>…/g, '<path>')
    .replace(/…$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A basis is hashed up to this length: errors differing past it are one friction. */
export const BASIS_MAX = 200;

/** Words that say nothing about which friction it was. */
const NON_WORDS = new Set([
  'exit', 'code', 'error', 'errors', 'fail', 'failed', 'failure', 'fatal', 'warning', 'command', 'file', 'files',
  'does', 'not', 'no', 'such', 'or', 'directory', 'exist', 'exists', 'enoent', 'at', 'in', 'on', 'of', 'the', 'a',
  'an', 'to', 'is', 'was', 'and', 'with', 'for', 'n', 'v', 'path', 'url', 'current', 'working', 'cwd', 'open',
  'read', 'write', 'found', 'cannot', 'could', 'unable',
]);

/**
 * A weak basis tells nothing about which friction it was once the volatile
 * parts are masked: a bare `Exit code N`, a URL, or nothing but paths and
 * filler words (`File does not exist. <path>`, `Error: Command failed:
 * <path>`). Its fingerprint is kept apart by what the masking hid (file
 * names, the URL's host, the call), and recurrence shows it without
 * enforcing anything (ADR-5209 §10).
 */
export function isWeakBasis(masked: string): boolean {
  if (/^Exit code (?:N|\d+)$/i.test(masked)) return true;
  if (/<url>/.test(masked)) return true;
  const words = masked.replace(/<path>|<url>/g, ' ').toLowerCase().split(/[^a-zа-яё]+/i).filter(Boolean);
  return words.every(w => NON_WORDS.has(w));
}

/** An error's basis: its masked text, at most `BASIS_MAX` characters. */
export function errorBasis(errorText: string): string {
  return maskVolatile(errorText).slice(0, BASIS_MAX).trim();
}

const CD_RE = /^cd(\s|$)/;
/** Commands whose first positional argument says what they do (`git push`, `npm test`). */
const SUBCOMMAND_TOOLS = new Set(['git', 'npm', 'pnpm', 'yarn', 'npx', 'bun', 'bunx', 'docker', 'kubectl', 'gh', 'cargo', 'go', 'make', 'nx', 'gsd-tools', 'gsd_run']);
/** Interpreters: their first positional is the script they run — its file name says what runs. */
const INTERPRETERS = new Set(['node', 'bash', 'sh', 'zsh', 'dash', 'python', 'python3', 'deno', 'ruby', 'perl', 'php', 'tsx', 'ts-node']);
const FORM_WORDS = 3;

/**
 * A command's form: its name, its flags, and for a tool with subcommands its
 * first positional — for an interpreter, the file name of its script (from
 * `named`, the same words with paths cut to their last segment), so `node
 * <install>/gsd-core/bin/gsd-tools.cjs` and `node /tmp/evil.js` are two
 * frictions; never plain arguments.
 */
function commandForm(words: readonly string[], named: readonly string[] = words): string {
  const name = path.basename(words[0]);
  const out = [words[0]];
  const interpreter = INTERPRETERS.has(name);
  let positional = SUBCOMMAND_TOOLS.has(name) || interpreter ? 1 : 0;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (out.length >= FORM_WORDS) break;
    if (w.startsWith('-')) out.push(w.split('=')[0]);
    else if (positional > 0) { out.push(interpreter ? (named[i] ?? w) : w); positional--; }
  }
  return out.join(' ');
}
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/**
 * A shell command's form: its first command that does something — leading
 * `cd <dir>` segments, `export`/plain `VAR=…` assignments and assignment
 * prefixes skipped — as its name, flags and (for a tool with subcommands) the
 * subcommand, at most three words, volatile parts masked; for `git`, the
 * subcommand after the global options (`git -C <dir> push` is `git push`).
 * `cd <p> && rm -rf build` and `cd <q> && git push --force` are two frictions;
 * `cat a` and `cat b` are one.
 */
export function shellBasis(command: string): string {
  const split = (t: string) => t.split(/&&|\|\||;|\|/).map(seg => seg.trim()).filter(Boolean);
  const segments = split(maskVolatile(command));
  // The same command with each path cut to its last segment instead of <path>: one token per path, so the words align.
  const namedSegments = split(maskVolatile(command, { keepNames: true }));
  for (const [si, seg] of segments.entries()) {
    let words = seg.split(' ');
    let named = (namedSegments[si] ?? seg).split(' ');
    if (named.length !== words.length) named = words;
    if (words[0] === 'export') { words = words.slice(1); named = named.slice(1); }
    while (words.length > 0 && ASSIGN_RE.test(words[0])) { words = words.slice(1); named = named.slice(1); }
    if (words.length === 0 || CD_RE.test(words.join(' '))) continue;
    if (words[0] === 'git') {
      let i = 1;
      while (i < words.length && words[i].startsWith('-')) {
        const opt = words[i].split('=')[0];
        i += GIT_OPTS_WITH_VALUE.has(opt) && !words[i].includes('=') ? 2 : 1;
      }
      return commandForm(['git', ...words.slice(i)]);
    }
    return commandForm(words, named);
  }
  return segments.length > 0 ? 'cd' : '';
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read']);

/**
 * Where a file a tool touched sits, as a fingerprint can say it: `project`
 * (under one of `roots`, or relative), `home` (under the home directory) or
 * `outside`, and its extension. `Write <project>/a.ts` and `Write /etc/hosts`
 * are two frictions.
 */
export function fileBasis(filePath: string, roots: readonly string[], homeDir: string = os.homedir()): string {
  const p = filePath.trim();
  const ext = path.extname(p.replace(/…$/, '')).toLowerCase() || '(none)';
  let where = 'outside';
  const absolute = p.startsWith('/') || /^[A-Za-z]:\\/.test(p);
  if (p.startsWith('~')) where = 'home';
  else if (!absolute) where = 'project';
  else if (roots.some(r => r && tryWithinRootLexical(p, r) !== null)) where = 'project';
  else if (homeDir && tryWithinRootLexical(p, homeDir) !== null) where = 'home';
  return `${where} ${ext}`;
}

/** The form of a call: a shell command's (`shellBasis`), a file tool's place and extension, else the tool. */
export function callBasis(tool: string, input: { command?: string; filePath?: string | null }, roots: readonly string[] = []): string {
  if (typeof input.command === 'string' && input.command.trim() !== '') return `${tool} ${shellBasis(input.command)}`.trim();
  if (input.filePath && FILE_TOOLS.has(tool)) return `${tool} ${fileBasis(input.filePath, roots)}`;
  return tool;
}

/** A command's form from a display subject `<tool> <command or path>` (an old bundle's key). */
export function commandBasis(subject: string): string {
  const at = subject.indexOf(' ');
  const tool = at < 0 ? subject : subject.slice(0, at);
  const rest = at < 0 ? '' : subject.slice(at + 1);
  return FILE_TOOLS.has(tool) ? callBasis(tool, { filePath: rest }) : callBasis(tool, { command: rest });
}

/** What a fingerprint hashes, and whether it is weak. */
export interface FingerprintBasis {
  basis: string | null;
  weak: boolean;
}

/**
 * A repeated tool error's basis: the tool and the masked error; a weak error
 * keeps what the masking hid (file names, hosts) and adds the call's form, so
 * `Exit code 1` after `npm test` and after `git push` stay apart.
 */
export function toolErrorBasis(tool: string, errorText: string, call: string): FingerprintBasis {
  const err = errorBasis(errorText);
  if (!isWeakBasis(err)) return { basis: `${tool}\u0000${err}`, weak: false };
  return { basis: `${tool}\u0000${maskVolatile(errorText, { keepNames: true }).slice(0, BASIS_MAX)}\u0000${call}`, weak: true };
}

/**
 * The LEGACY basis of a signal, from its display key: how a retro recorded
 * before fingerprints existed (ADR-5209 §10) is recognised. It can never be
 * compared with a fingerprint of the full text — a key's error was cut at 100
 * characters before any masking — so recurrence compares it with the legacy
 * basis of the current signal's key (`legacyFingerprint`), never with its
 * fingerprint. Two keys of the same error cut at different points (a longer
 * or shorter worktree path) agree only up to the error's first path, so a
 * repeated tool error's legacy basis is its masked error up to and including
 * that path; a weak one adds the call's form.
 */
export function fingerprintBasisFromKey(kind: string, key: string | null): FingerprintBasis {
  if (key === null) return { basis: null, weak: false };
  if (kind === SIGNAL_KIND.RepeatedToolError) {
    const at = key.indexOf(' → ');
    if (at < 0) return { basis: key, weak: false };
    const subject = key.slice(0, at);
    const tool = subject.split(' ')[0];
    const masked = maskVolatile(key.slice(at + 3));
    const p = masked.indexOf('<path>');
    const head = (p >= 0 ? masked.slice(0, p + '<path>'.length) : masked).trim();
    if (isWeakBasis(head)) return { basis: `${tool}\u0000${head}\u0000${commandBasis(subject)}`, weak: true };
    return { basis: `${tool}\u0000${head}`, weak: false };
  }
  if (kind === SIGNAL_KIND.PermissionDenial || kind === SIGNAL_KIND.ToolRejected) return { basis: commandBasis(key), weak: false };
  return { basis: key, weak: false };
}

/** The legacy fingerprint of a signal's key (`fingerprintBasisFromKey`), prefixed so it never equals a full-text one. */
export function legacyFingerprint(kind: string, key: string | null): { fingerprint: string | null; weak: boolean } {
  const b = fingerprintBasisFromKey(kind, key);
  return { fingerprint: signalFingerprint(kind, b.basis === null ? null : `legacy\u0000${b.basis}`), weak: b.weak };
}

/** `kind:` + 10 hex of sha1 over the kind and the masked basis; null without a basis. */
export function signalFingerprint(kind: string, basis: string | null | undefined): string | null {
  if (typeof basis !== 'string') return null;
  const masked = maskPaths(basis);
  if (masked === '') return null;
  return `${kind}:${crypto.createHash('sha1').update(`${kind}\u0000${masked}`).digest('hex').slice(0, 10)}`;
}

function signalId(kind: SignalKind, key: string | null, first: SignalPointer | undefined): string {
  const h = crypto.createHash('sha1').update(`${kind}\u0000${key ?? ''}\u0000${first ? pointerString(first) : ''}`).digest('hex');
  return `${kind}:${h.slice(0, 10)}`;
}

function windowFor(events: readonly TranscriptEvent[] | null, index: number, size: number): RetroSignal['window'] {
  if (!events || index < 0 || !events[index]) return null;
  const anchor = events[index];
  let from = anchor.ptr.line;
  let to = anchor.ptr.line;
  let seen = 0;
  for (let i = index - 1; i >= 0 && seen < size; i--) {
    if (events[i].ptr.file !== anchor.ptr.file) continue;
    from = Math.min(from, events[i].ptr.line);
    seen++;
  }
  seen = 0;
  for (let i = index + 1; i < events.length && seen < size; i++) {
    if (events[i].ptr.file !== anchor.ptr.file) continue;
    to = Math.max(to, events[i].ptr.line);
    seen++;
  }
  return { file: anchor.ptr.file, fromLine: from, toLine: to };
}

function toSignal(g: Group, events: readonly TranscriptEvent[] | null, t: RetroThresholds): RetroSignal {
  const weight = SIGNAL_WEIGHTS[g.kind];
  const count = g.occurrences.length;
  const score = weight * (count - g.min + 1);
  const pointers = g.occurrences.slice(0, MAX_POINTERS).map(o => o.ptr);
  const firstText = g.occurrences.find(o => o.text)?.text ?? null;
  const first = g.occurrences[0];
  return {
    id: signalId(g.kind, g.key, pointers[0]),
    kind: g.kind,
    weight,
    count,
    score,
    key: g.key,
    fingerprint: signalFingerprint(g.kind, g.basis),
    fingerprintWeak: g.weak === true,
    pointers,
    excerpt: firstText ? excerpt(firstText, t.excerptChars) : null,
    window: first && first.ptr.source === 'transcript' ? windowFor(events, first.index, t.excerptWindow) : null,
  };
}

export interface ComputeRetroSignalsInput {
  transcript?: SessionTranscript | null;
  planning?: PlanningEvidence | null;
  git?: GitEvidence | null;
  config?: Record<string, unknown> | null;
  /** Explicit thresholds win over `config`. */
  thresholds?: Partial<RetroThresholds>;
  /** A degraded-runtime reason (session-transcript `transcriptSupport`), reported as-is. */
  transcriptUnavailable?: string | null;
  /** The project's roots (the checkout and its main worktree): a file a tool touched there is `project` in a fingerprint. */
  projectRoots?: readonly string[];
}

/**
 * Score a session. Pure: every input is already read. Signals are ordered by
 * score, then kind, then first pointer, so the same inputs give the same list
 * and the same `max_signals` cut.
 */
export function computeRetroSignals(input: ComputeRetroSignalsInput): RetroSignalReport {
  const resolved = resolveRetroThresholds(input.config);
  const thresholds: RetroThresholds = { ...resolved.thresholds, ...(input.thresholds || {}) };
  const reasons: string[] = [...resolved.problems];
  const transcript = input.transcript ?? null;
  const groups: Group[] = [];

  let transcriptSource: RetroSignalReport['sources']['transcript'] = 'absent';
  if (transcript) {
    transcriptSource = transcript.status === 'ok' ? 'read' : 'degraded';
    if (transcript.reason) reasons.push(transcript.reason);
    for (const f of transcript.files) {
      if (f.stats.truncatedBytes) reasons.push(`${f.file}: read stopped at the byte limit`);
      if (f.stats.truncatedEvents) reasons.push(`${f.file}: event limit reached`);
      if (f.stats.oversizeLines > 0) reasons.push(`${f.file}: ${f.stats.oversizeLines} over-long line(s) skipped`);
      if (f.stats.malformedLines > 0) reasons.push(`${f.file}: ${f.stats.malformedLines} malformed line(s) skipped`);
    }
    groups.push(...groupsFromTranscript(transcript, thresholds, input.projectRoots ?? []));
  } else if (input.transcriptUnavailable) {
    transcriptSource = 'degraded';
    reasons.push(input.transcriptUnavailable);
  }

  let planningSource: RetroSignalReport['sources']['planning'] = 'absent';
  if (input.planning) {
    planningSource = input.planning.status === 'ok' ? 'read' : input.planning.status === 'degraded' ? 'degraded' : 'absent';
    if (input.planning.status === 'degraded' && input.planning.reason) reasons.push(input.planning.reason);
    for (const f of input.planning.findings) {
      groups.push({ kind: SIGNAL_KIND.GapsFound, key: f.file, basis: f.file, min: 1, occurrences: [{ index: -1, ptr: { source: 'artifact', file: f.file, line: f.line }, text: f.excerpt }] });
    }
  }

  let gitSource: RetroSignalReport['sources']['git'] = 'absent';
  if (input.git) {
    gitSource = input.git.status === 'ok' ? 'read' : 'degraded';
    if (input.git.reason) reasons.push(input.git.reason);
    for (const r of input.git.reverts) {
      groups.push({ kind: SIGNAL_KIND.Revert, key: normalizeKey(r.subject), basis: normalizeKey(r.subject), min: 1, occurrences: [{ index: -1, ptr: { source: 'git', commit: r.commit, timestamp: r.timestamp }, text: r.subject }] });
    }
  }

  const all = groups.map(g => toSignal(g, transcript ? transcript.events : null, thresholds));
  all.sort((a, b) =>
    b.score - a.score ||
    a.kind.localeCompare(b.kind) ||
    (a.pointers[0] ? pointerString(a.pointers[0]) : '').localeCompare(b.pointers[0] ? pointerString(b.pointers[0]) : '', 'en', { numeric: true }) ||
    a.id.localeCompare(b.id));

  const volume = sessionVolume(transcript);
  const { score, scoreByKind } = sessionScore(all, volume, thresholds);
  const countsByKind: Partial<Record<SignalKind, number>> = {};
  for (const s of all) countsByKind[s.kind] = (countsByKind[s.kind] ?? 0) + s.count;

  const degraded = transcriptSource === 'degraded' || planningSource === 'degraded' || gitSource === 'degraded' ||
    (transcript?.files.some(f => f.stats.truncatedBytes || f.stats.truncatedEvents) ?? false);

  return {
    status: degraded ? 'degraded' : 'ok',
    reasons,
    sources: { transcript: transcriptSource, planning: planningSource, git: gitSource },
    session: transcript?.session ?? null,
    thresholds,
    score,
    threshold: thresholds.signalThreshold,
    suggest: score >= thresholds.signalThreshold,
    rawScore: all.reduce((sum, s) => sum + s.score, 0),
    volume,
    scoreByKind,
    countsByKind,
    signals: all.slice(0, thresholds.maxSignals),
    omitted: all.slice(thresholds.maxSignals).map(s => ({ id: s.id, kind: s.kind, score: s.score, count: s.count, fingerprint: s.fingerprint, fingerprintWeak: s.fingerprintWeak })),
  };
}
