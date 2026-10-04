/**
 * Retro signals — deterministic friction signals for `/gsd-retro`.
 *
 * A retro is worth a model pass only when the session actually struggled.
 * This module decides that without a model: it reads the typed transcript
 * (session-transcript.cts) plus the planning record and git history, and
 * emits **signals** — each a kind, a weight, an occurrence count, pointers to
 * where it happened, and a short redacted excerpt. The weighted sum against
 * `retro.signal_threshold` answers "suggest a retro or stay silent".
 *
 * ── What counts as friction ─────────────────────────────────────────────
 *
 * Instance signals (every occurrence scores): a user correction ("нет",
 * "не так", "стоп", "no", "wrong", …), a user interrupt, a tool call the user
 * rejected, a permission denial, a revert (git revert / reset --hard /
 * checkout -- / restore in a Bash call, or a `Revert "…"` commit), a node
 * repair, a `gaps_found` verdict, an API error, a context compaction, a
 * navigation streak (many Read/Grep/Glob with no edit in between).
 *
 * Repetition signals (score only from their threshold up): the same tool
 * error again, the same tool call again, the same file re-read with no edit
 * in between, the same file edited over and over, the plan-checker spawned
 * again (a revision loop), a checkpoint reached again, the same hook blocking
 * again.
 *
 * ── Thresholds ──────────────────────────────────────────────────────────
 *
 * Every `*_min` threshold is "at least": a repetition signal exists when its
 * count is `>= min`, and its score is `weight × (count − min + 1)` — one
 * weight per occurrence at or past the threshold. `suggest` is
 * `score >= signal_threshold`. `max_signals` caps the list, never the score:
 * the cut signals are enumerated in `omitted`, by id, so "nothing else" and
 * "more than fit" are different answers.
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
import path from 'node:path';
import crypto from 'node:crypto';
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
  /** `retro.signal_threshold` — total score at or above which a retro is suggested. */
  signalThreshold: number;
  /** `retro.repeat_call_min` — identical tool calls. */
  repeatCallMin: number;
  /** `retro.repeat_error_min` — the same tool error. */
  repeatErrorMin: number;
  /** `retro.reread_min` — reads of one file with no edit to it in between. */
  rereadMin: number;
  /** `retro.edit_churn_min` — edits of one file. */
  editChurnMin: number;
  /** `retro.nav_streak_min` — navigation calls in a row with no edit. */
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
  repeatCallMin: 3,
  repeatErrorMin: 2,
  rereadMin: 3,
  editChurnMin: 6,
  navStreakMin: 8,
  checkerLoopMin: 2,
  checkpointMin: 2,
  hookBlockMin: 1,
  excerptWindow: 6,
  maxSignals: 40,
  excerptChars: 160,
});

const THRESHOLD_KEYS: ReadonlyArray<[keyof RetroThresholds, string]> = [
  ['signalThreshold', 'signal_threshold'],
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
 * `*_min` keys, below 1) keeps the default and is named in `problems` — a
 * typo never silently becomes "no threshold".
 */
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
    const floor = key.endsWith('_min') || key === 'max_signals' || key === 'excerpt_chars' ? 1 : 0;
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

const REVERT_COMMAND_RE = /\bgit\s+(?:-C\s+\S+\s+)?(?:revert\b|reset\s+--hard\b|checkout\s+--\s|restore\b(?![^\n;&|]*--staged))/;
const NODE_REPAIR_RE = /\[Node Repair - (RETRY|DECOMPOSE|PRUNE)\]/;
const CHECKPOINT_RE = /CHECKPOINT REACHED/;
const GAPS_FOUND_RE = /\bstatus:\s*gaps_found\b|\bgaps_found\b/;

const NAV_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const NAV_BASH_RE = /^(?:cd\s+\S+\s*&&\s*)?(?:grep|rg|ag|find|ls|tree|cat|head|tail|wc|sed\s+-n|git\s+(?:grep|log|show|ls-files))\b/;

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

function errorKey(text: string): string {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const head = lines[0] && /^Exit code \d+$/.test(lines[0]) && lines[1] ? `${lines[0]} ${lines[1]}` : (lines[0] ?? '');
  return normalizeKey(head, 100);
}

function filePathOf(ev: Extract<TranscriptEvent, { kind: 'tool-use' }>): string | null {
  return ev.input['file_path'] ?? ev.input['notebook_path'] ?? ev.input['path'] ?? null;
}

interface Occurrence {
  index: number;
  ptr: SignalPointer;
  text: string | null;
}

interface Group {
  kind: SignalKind;
  key: string | null;
  occurrences: Occurrence[];
  /** Repetition kinds: the threshold; instance kinds: 1. */
  min: number;
}

function tptr(ev: TranscriptEvent): SignalPointer {
  return { source: 'transcript', ...ev.ptr };
}

function groupsFromTranscript(transcript: SessionTranscript, t: RetroThresholds): Group[] {
  const instances: Group[] = [];
  const keyed = new Map<string, Group>();
  const events = transcript.events;

  function instance(kind: SignalKind, index: number, key: string | null, text: string | null): void {
    instances.push({ kind, key, min: 1, occurrences: [{ index, ptr: tptr(events[index]), text }] });
  }
  // A repetition is "the same thing again in the same context": groups are
  // scoped to one transcript file (the main session or one subagent) unless
  // `crossFile`, and identified by `identity` — the full normalized subject —
  // while `key` is only its capped display form.
  function keyedHit(
    kind: SignalKind, key: string, min: number, index: number, text: string | null,
    opts: { identity?: string; crossFile?: boolean } = {},
  ): void {
    const scope = opts.crossFile ? '' : events[index].ptr.file;
    const id = `${kind}\u0000${scope}\u0000${opts.identity ?? key}`;
    let g = keyed.get(id);
    if (!g) {
      g = { kind, key, min, occurrences: [] };
      keyed.set(id, g);
    }
    g.occurrences.push({ index, ptr: tptr(events[index]), text });
  }

  const toolUses = new Map<string, Extract<TranscriptEvent, { kind: 'tool-use' }>>();
  // Per transcript file: navigation streak and reads-since-edit runs.
  const streak = new Map<string, { start: number; last: number; length: number }>();
  const readRuns = new Map<string, Map<string, Occurrence[]>>();
  const maxRuns = new Map<string, Occurrence[]>();

  function closeStreak(file: string): void {
    const s = streak.get(file);
    if (s && s.length >= t.navStreakMin) {
      instances.push({
        kind: SIGNAL_KIND.NavStreak, key: `${s.length} navigation calls with no edit`, min: 1,
        occurrences: [{ index: s.start, ptr: tptr(events[s.start]), text: null }, { index: s.last, ptr: tptr(events[s.last]), text: null }],
      });
    }
    streak.delete(file);
  }

  events.forEach((ev, i) => {
    const file = ev.ptr.file;
    switch (ev.kind) {
      case 'user-prompt':
        if (isCorrection(ev.text)) instance(SIGNAL_KIND.UserCorrection, i, null, ev.text);
        return;
      case 'user-interrupt':
        instance(SIGNAL_KIND.UserInterrupt, i, ev.duringToolUse ? 'during tool use' : null, null);
        return;
      case 'api-error':
        instance(SIGNAL_KIND.ApiError, i, null, ev.text);
        return;
      case 'compaction':
        instance(SIGNAL_KIND.Compaction, i, null, null);
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
        const command = ev.input['command'] ?? '';
        if (ev.tool === 'Bash' && REVERT_COMMAND_RE.test(command)) instance(SIGNAL_KIND.Revert, i, normalizeKey(command), null);
        if (ev.tool === 'Agent' || ev.tool === 'Task') {
          if (ev.input['subagent_type'] === 'gsd-plan-checker') keyedHit(SIGNAL_KIND.PlanCheckerLoop, 'gsd-plan-checker', t.checkerLoopMin, i, null);
        }
        if (ev.tool !== 'Read') {
          const call = `${ev.tool} ${JSON.stringify(ev.input)}`;
          keyedHit(SIGNAL_KIND.RepeatedCall, normalizeKey(call, 160), t.repeatCallMin, i, null, { identity: call });
        }
        // Navigation streak.
        const isNav = NAV_TOOLS.has(ev.tool) || (ev.tool === 'Bash' && NAV_BASH_RE.test(command.trim()));
        if (EDIT_TOOLS.has(ev.tool)) {
          closeStreak(file);
        } else if (isNav) {
          const s = streak.get(file);
          if (s) {
            s.length++;
            s.last = i;
          } else {
            streak.set(file, { start: i, last: i, length: 1 });
          }
        }
        // Reads since the last edit of the same path; edits per path.
        const p = filePathOf(ev);
        if (p) {
          let runs = readRuns.get(file);
          if (!runs) {
            runs = new Map();
            readRuns.set(file, runs);
          }
          if (ev.tool === 'Read') {
            const run = runs.get(p) ?? [];
            run.push({ index: i, ptr: tptr(ev), text: null });
            runs.set(p, run);
            const best = maxRuns.get(`${file}\u0000${p}`);
            if (!best || run.length > best.length) maxRuns.set(`${file}\u0000${p}`, [...run]);
          } else if (EDIT_TOOLS.has(ev.tool)) {
            runs.delete(p);
            keyedHit(SIGNAL_KIND.EditChurn, excerpt(p, 120), t.editChurnMin, i, null, { identity: p });
          }
        }
        return;
      }
      case 'tool-result': {
        if (!ev.isError) return;
        const use = toolUses.get(`${file}\u0000${ev.toolUseId}`);
        const subject = use ? `${use.tool} ${normalizeKey(use.input['command'] ?? filePathOf(use) ?? '', 80)}`.trim() : (ev.tool ?? 'tool');
        if (ev.denial === 'user-rejected') {
          instance(SIGNAL_KIND.ToolRejected, i, subject, null);
        } else if (ev.denial === 'permission-rule' || ev.denial === 'other') {
          instance(SIGNAL_KIND.PermissionDenial, i, subject, ev.text);
        } else if (ev.blockedBy === null && ev.denial === null) {
          // The same wall hit again: one tool, one error, whatever the
          // arguments were (a test command re-run with a different filter,
          // a path guessed three ways). The key shows the first call.
          const err = errorKey(ev.text);
          keyedHit(SIGNAL_KIND.RepeatedToolError, `${subject} → ${err}`, t.repeatErrorMin, i, ev.text, {
            identity: `${use?.tool ?? ev.tool ?? ''}\u0000${err}`,
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

  for (const file of [...streak.keys()]) closeStreak(file);
  for (const [id, run] of maxRuns) {
    if (run.length < t.rereadMin) continue;
    const p = id.split('\u0000')[1];
    instances.push({ kind: SIGNAL_KIND.Reread, key: excerpt(p, 120), min: t.rereadMin, occurrences: run });
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
  score: number;
  threshold: number;
  suggest: boolean;
  countsByKind: Partial<Record<SignalKind, number>>;
  signals: RetroSignal[];
  /** Signals past `max_signals`, by id — listed, never dropped silently. */
  omitted: Array<{ id: string; kind: SignalKind; score: number }>;
}

function pointerString(p: SignalPointer): string {
  if (p.source === 'transcript') return `${p.file}:${p.line}`;
  if (p.source === 'artifact') return `${p.file}:${p.line}`;
  return p.commit;
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
    groups.push(...groupsFromTranscript(transcript, thresholds));
  } else if (input.transcriptUnavailable) {
    transcriptSource = 'degraded';
    reasons.push(input.transcriptUnavailable);
  }

  let planningSource: RetroSignalReport['sources']['planning'] = 'absent';
  if (input.planning) {
    planningSource = input.planning.status === 'ok' ? 'read' : input.planning.status === 'degraded' ? 'degraded' : 'absent';
    if (input.planning.status === 'degraded' && input.planning.reason) reasons.push(input.planning.reason);
    for (const f of input.planning.findings) {
      groups.push({ kind: SIGNAL_KIND.GapsFound, key: f.file, min: 1, occurrences: [{ index: -1, ptr: { source: 'artifact', file: f.file, line: f.line }, text: f.excerpt }] });
    }
  }

  let gitSource: RetroSignalReport['sources']['git'] = 'absent';
  if (input.git) {
    gitSource = input.git.status === 'ok' ? 'read' : 'degraded';
    if (input.git.reason) reasons.push(input.git.reason);
    for (const r of input.git.reverts) {
      groups.push({ kind: SIGNAL_KIND.Revert, key: normalizeKey(r.subject), min: 1, occurrences: [{ index: -1, ptr: { source: 'git', commit: r.commit, timestamp: r.timestamp }, text: r.subject }] });
    }
  }

  const all = groups.map(g => toSignal(g, transcript ? transcript.events : null, thresholds));
  all.sort((a, b) =>
    b.score - a.score ||
    a.kind.localeCompare(b.kind) ||
    (a.pointers[0] ? pointerString(a.pointers[0]) : '').localeCompare(b.pointers[0] ? pointerString(b.pointers[0]) : '', 'en', { numeric: true }) ||
    a.id.localeCompare(b.id));

  const score = all.reduce((sum, s) => sum + s.score, 0);
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
    countsByKind,
    signals: all.slice(0, thresholds.maxSignals),
    omitted: all.slice(thresholds.maxSignals).map(s => ({ id: s.id, kind: s.kind, score: s.score })),
  };
}
