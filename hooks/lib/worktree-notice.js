'use strict';
// hooks/lib/worktree-notice.js — the hand-off between gsd-worktree-provision.js
// (WorktreeCreate) and gsd-pin-invariants.js (SessionStart) for equipment that
// did not arrive.
//
// Why a hand-off at all: a WorktreeCreate hook's stdout is the worktree path and
// nothing else, so a warning it prints goes to stderr — which the host keeps
// in its debug log, where the agent working in that worktree never sees it. An
// agent that does not know its node_modules link failed discovers it by failing,
// mid-phase: the exact failure provisioning exists to prevent. So a creation
// that succeeds with warnings records them here, and the first SessionStart in
// that worktree hands them to the agent once.
//
// Where: `<git dir of the linked worktree>/gsd/worktree-provision-notice.json`
// — the per-worktree directory git keeps under the main repository's
// `.git/worktrees/<id>/` (what `git rev-parse --git-dir` prints inside the
// worktree). Not the working tree: nothing appears in `git status`, nothing can
// be committed by accident, and `git worktree remove` deletes it with the rest.
//
// Lifecycle: written once at creation, `delivered_at` stamped when a session
// has been given it. A delivered notice is never shown again, including after
// a compaction re-fire of SessionStart — it describes the creation, not a
// standing constraint.

const fs = require('fs');
const path = require('path');

const NOTICE_DIR = 'gsd';
const NOTICE_FILE = 'worktree-provision-notice.json';
const NOTICE_SCHEMA = 1;

/** Bounds on what reaches the agent's context: a notice is a pointer, not a log. */
const MAX_WARNINGS = 20;
const MAX_REASON_CHARS = 400;

function noticePath(gitDir) {
  return path.join(gitDir, NOTICE_DIR, NOTICE_FILE);
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function clip(text) {
  const s = String(text);
  return s.length > MAX_REASON_CHARS ? `${s.slice(0, MAX_REASON_CHARS - 1)}…` : s;
}

/**
 * Record what a worktree creation could not provide. `warnings` is
 * `[{ step, reason }]`. Returns `{ ok: true, path }` or `{ ok: false, reason }`;
 * never throws — a lost notice must not turn a created worktree into a failure.
 */
function writeNotice(gitDir, { worktree, branch, warnings }, { now = () => new Date() } = {}) {
  const file = noticePath(gitDir);
  try {
    writeJsonAtomic(file, {
      schema: NOTICE_SCHEMA,
      created_at: now().toISOString(),
      worktree,
      branch,
      warnings: warnings.map((w) => ({ step: String(w.step), reason: String(w.reason) })),
      delivered_at: null,
    });
    return { ok: true, path: file };
  } catch (err) {
    return { ok: false, reason: err && err.code ? String(err.code) : 'write failed' };
  }
}

/**
 * The git dir of the linked worktree containing `cwd`, or null.
 *
 * A linked worktree's root carries a `.git` FILE (`gitdir: <path>`); the main
 * checkout carries a `.git` directory. Read from the filesystem rather than by
 * spawning git, because the reader runs on every SessionStart under a few
 * seconds' budget. Only linked worktrees get notices, so a `.git` directory
 * ends the search.
 */
function linkedWorktreeGitDir(cwd) {
  let dir = path.resolve(cwd);
  for (let depth = 0; depth < 64; depth += 1) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = null;
    }
    if (stat && stat.isDirectory()) return null;
    if (stat && stat.isFile()) {
      let text;
      try {
        text = fs.readFileSync(dotGit, 'utf8');
      } catch {
        return null;
      }
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(text);
      return m ? path.resolve(dir, m[1]) : null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function isNotice(raw) {
  return Boolean(
    raw &&
      typeof raw === 'object' &&
      raw.schema === NOTICE_SCHEMA &&
      Array.isArray(raw.warnings) &&
      raw.warnings.length > 0
  );
}

/**
 * The undelivered notice of the worktree containing `cwd`, stamped as
 * delivered. Null when there is none, it was already delivered, or it cannot
 * be read. A notice whose stamp cannot be written is still returned: showing
 * it twice beats never showing it.
 */
function takeNotice(cwd, { now = () => new Date() } = {}) {
  const gitDir = linkedWorktreeGitDir(cwd);
  if (!gitDir) return null;
  const file = noticePath(gitDir);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isNotice(raw) || raw.delivered_at) return null;
  try {
    writeJsonAtomic(file, { ...raw, delivered_at: now().toISOString() });
  } catch {
    /* see above: deliver anyway */
  }
  return raw;
}

/** The text an agent receives for a notice. */
function formatNotice(notice) {
  const shown = notice.warnings.slice(0, MAX_WARNINGS);
  const lines = shown.map((w) => `- ${w.step}: ${clip(w.reason)}`);
  if (notice.warnings.length > shown.length) {
    lines.push(`- (${notice.warnings.length - shown.length} more not shown)`);
  }
  const where = typeof notice.branch === 'string' && notice.branch ? ` (${notice.branch})` : '';
  return (
    `WORKTREE PROVISIONING — this worktree${where} was created, but part of its equipment did not arrive:\n` +
    `${lines.join('\n')}\n` +
    'Expect what depends on it (tools, dependencies) to be missing here; provide it before relying on it.'
  );
}

module.exports = {
  NOTICE_DIR,
  NOTICE_FILE,
  NOTICE_SCHEMA,
  MAX_WARNINGS,
  noticePath,
  writeNotice,
  linkedWorktreeGitDir,
  takeNotice,
  formatNotice,
};
