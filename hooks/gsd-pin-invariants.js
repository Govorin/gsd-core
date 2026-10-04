#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Invariant Pin — SessionStart hook, re-fired after compaction (mn fork)
//
// Problem: compaction rewrites the conversation, and the standing rules of the
// work in progress do not survive that rewrite. This is measured, not
// suspected: rule-violation rates after a compaction step run 0%→59%
// (DeepSeek-V4), 0%→41% (GPT-5.4-mini), 0%→30% (Qwen3.6) across models
// (arXiv 2606.22528). The same paper measures the fix: re-injecting the rules
// verbatim after each compaction, at a cost of tens of tokens, returns the
// violation rate to 0%.
//
// Claude Code re-injects the project-root CLAUDE.md after a compaction, but not
// path-scoped rules, and never anything from `.planning/` — so the constraints
// that matter most to a GSD run (this plan's prohibitions, this phase's
// must-haves, an open blocker awaiting an answer) are exactly the ones that
// vanish. This hook re-states them.
//
// What is pinned, in order, smallest first:
//   1. an open blocker (`.planning/WAITING.json`) — a question already asked
//      must not be silently dropped and re-derived,
//   2. the running plan's `prohibitions` — the things this phase must NOT do,
//      which no test can catch and no other artifact repeats,
//   3. the running plan's `must_haves` — its definition of done,
//   4. an explicitly pinned block from CLAUDE.md, delimited by
//      `<!-- gsd:pinned -->` … `<!-- /gsd:pinned -->`, for project rules the
//      author judged load-bearing enough to survive every compaction.
//
// Budget: the whole injection is capped (`workflow.pin_invariants_budget`,
// default 2000 characters). A pin that grows without bound recreates the
// problem it solves — the point is the smallest set of high-signal tokens, and
// an unbounded one competes with the work for context. When the content
// exceeds the cap it is truncated at an item boundary and the omission is
// stated rather than hidden.
//
// Applicability: a GSD project with something to pin. No `.planning/`, no
// running plan, nothing pinned in CLAUDE.md and no open blocker → silent.
// This hook never blocks: it emits `additionalContext` and exits 0. It cannot
// fail a session, only fail to help.
//
// Worktree provisioning notice. SessionStart is also the one point where a
// session started inside a freshly created worktree can be told what its
// creation could not provide: gsd-worktree-provision.js (WorktreeCreate) can
// only print the worktree path on stdout, so a warning it raises would
// otherwise reach nobody but Claude Code's debug log. It records them in the
// worktree's git dir; this hook delivers them once, ahead of the pin, and
// stamps them delivered (hooks/lib/worktree-notice.js). The notice is a
// one-time report of the creation, not a standing constraint: it is delivered
// in any git project (the provision hook runs in all of them), regardless of
// `workflow.pin_invariants`, outside the pin budget, and never repeated after a
// compaction.

'use strict';

const fs = require('fs');
const path = require('path');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');
const { takeNotice, formatNotice } = require('./lib/worktree-notice.js');

const DEFAULT_BUDGET = 2000;
const PIN_OPEN = '<!-- gsd:pinned -->';
const PIN_CLOSE = '<!-- /gsd:pinned -->';

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

function readConfig(planningRoot) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(planningRoot, '.planning', 'config.json'), 'utf8')
    );
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

/**
 * The YAML body of a document's frontmatter, or null when it has no closed block.
 * The fence is located by the repo's single owner (src/frontmatter-fence.cts →
 * gsd-core/bin/lib/frontmatter-fence.cjs), reached through the self-healing build
 * seam like every compiled-lib require under hooks/. If the owner cannot be
 * loaded the hook reads no frontmatter — the same inert outcome as a plan that
 * has none — and never blocks over its own plumbing.
 */
function frontmatterBody(text) {
  try {
    const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');
    ensureRuntimeBuild();
    const { locateFrontmatterFence } = require('../gsd-core/bin/lib/frontmatter-fence.cjs');
    const fence = locateFrontmatterFence(text);
    return fence && fence.closed ? text.slice(fence.openEnd, fence.bodyEnd) : null;
  } catch {
    return null;
  }
}

/** Frontmatter body of a markdown file, or '' when there is none. */
function frontmatter(text) {
  return frontmatterBody(text) ?? '';
}

/**
 * Read a YAML list field in either shape the planner emits (block or inline).
 * Deliberately not a YAML parser: this hook must run without installation.
 */
function listField(body, field) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${field}:\\s*$`).test(l));
  if (start === -1) {
    const inline = new RegExp(`^${field}:\\s*\\[(.*)\\]\\s*$`, 'm').exec(body);
    if (!inline) return [];
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    // A blank line inside the block does not end it: it is legal YAML, and
    // 17 of 96 plans in one live project put one between the key and the
    // first item. Reading it as the end made those plans declare nothing.
    if (lines[i].trim() === '') continue;
    const m = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) break;
    const entry = m[1].replace(/^['"]|['"]$/g, '').trim();
    if (entry) out.push(entry);
  }
  return out;
}

/** Scalar YAML field, or null. */
function scalarField(body, field) {
  const m = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm').exec(body);
  return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : null;
}

/**
 * The plan currently in flight: the single plan whose frontmatter says
 * `status: in_progress`. Several at once means parallel waves, and no one plan
 * speaks for the session — pin nothing rather than pin the wrong constraints.
 */
function findRunningPlan(planningRoot) {
  const phasesDir = path.join(planningRoot, '.planning', 'phases');
  let phases;
  try {
    phases = fs.readdirSync(phasesDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return null;
  }
  const found = [];
  for (const phase of phases) {
    const dir = path.join(phasesDir, phase.name);
    let names;
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('PLAN.md'));
    } catch {
      continue;
    }
    for (const name of names) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, name), 'utf8');
      } catch {
        continue;
      }
      const body = frontmatter(text);
      if (scalarField(body, 'status') === 'in_progress') {
        found.push({ phase: phase.name, plan: name, body });
        if (found.length > 1) return null; // ambiguous
      }
    }
  }
  return found.length === 1 ? found[0] : null;
}

/** An open blocker, when one is waiting on an answer. */
function readWaiting(planningRoot) {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(planningRoot, '.planning', 'WAITING.json'), 'utf8')
    );
    if (!raw || typeof raw !== 'object') return null;
    // A resolved signal is left on disk by design; only an open one is pinned.
    if (raw.resolved === true || raw.status === 'resolved') return null;
    const question =
      (typeof raw.question === 'string' && raw.question) ||
      (typeof raw.message === 'string' && raw.message) ||
      (typeof raw.reason === 'string' && raw.reason) ||
      '';
    if (!question) return null;
    return { type: typeof raw.type === 'string' ? raw.type : 'blocker', question };
  } catch {
    return null;
  }
}

/** The author-pinned block of CLAUDE.md, when the markers are present. */
function readPinnedBlock(planningRoot, config) {
  const configured =
    config && config.planning && typeof config.planning.claude_md_path === 'string'
      ? config.planning.claude_md_path
      : null;
  const candidates = [];
  if (configured) candidates.push(path.resolve(planningRoot, configured));
  candidates.push(path.join(planningRoot, 'CLAUDE.md'));

  for (const file of candidates) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const open = text.indexOf(PIN_OPEN);
    if (open === -1) continue;
    const close = text.indexOf(PIN_CLOSE, open);
    if (close === -1) continue;
    const block = text.slice(open + PIN_OPEN.length, close).trim();
    if (block) return block;
  }
  return null;
}

/**
 * Build the injection.
 *
 * Returns `{ context }` or null when there is nothing worth saying. Pure over
 * an injected filesystem root so tests need no process.
 */
function buildPin(cwd) {
  const planningRoot = findPlanningRoot(cwd);
  if (!planningRoot) return null;

  const config = readConfig(planningRoot);
  const workflow = config.workflow && typeof config.workflow === 'object' ? config.workflow : {};
  if (workflow.pin_invariants === false) return null; // absent = enabled

  const rawBudget = workflow.pin_invariants_budget;
  const budget = Number.isInteger(rawBudget) && rawBudget > 0 ? rawBudget : DEFAULT_BUDGET;

  const sections = [];

  const waiting = readWaiting(planningRoot);
  if (waiting) {
    sections.push(
      `OPEN ${waiting.type.toUpperCase()} — answered by the user, not by you:\n${waiting.question}`
    );
  }

  const running = findRunningPlan(planningRoot);
  if (running) {
    const prohibitions = listField(running.body, 'prohibitions');
    const mustHaves = listField(running.body, 'must_haves');
    const header = `RUNNING PLAN: ${running.phase}/${running.plan}`;
    if (prohibitions.length) {
      sections.push(
        `${header} — prohibitions (these do not lapse when the context is rewritten):\n` +
          prohibitions.map((p) => `- ${p}`).join('\n')
      );
    }
    if (mustHaves.length) {
      sections.push(
        `${header} — must-haves (its definition of done):\n` +
          mustHaves.map((m) => `- ${m}`).join('\n')
      );
    }
    if (!prohibitions.length && !mustHaves.length) {
      sections.push(`${header} is in progress.`);
    }
  }

  const pinned = readPinnedBlock(planningRoot, config);
  if (pinned) sections.push(`PROJECT RULES (pinned in CLAUDE.md):\n${pinned}`);

  if (!sections.length) return null;

  // Apply the budget at an item boundary. Truncating mid-rule would leave a
  // half-stated constraint, which is worse than an honestly omitted one.
  const preamble =
    'Standing constraints for the work in progress, restated because a context rewrite drops them:';
  const kept = [];
  let used = preamble.length;
  let dropped = 0;
  for (const section of sections) {
    if (used + section.length + 2 > budget) {
      dropped += 1;
      continue;
    }
    kept.push(section);
    used += section.length + 2;
  }
  if (!kept.length) {
    // Even the first item does not fit: state that rather than inject nothing,
    // so a mis-set budget is visible instead of silently disabling the pin.
    return {
      context:
        `${preamble}\n\n(${sections.length} constraint block(s) omitted — all exceed ` +
        `workflow.pin_invariants_budget=${budget}. Raise the budget or shorten the pinned block.)`,
      dropped: sections.length,
      budget,
    };
  }

  let context = `${preamble}\n\n${kept.join('\n\n')}`;
  if (dropped) {
    context += `\n\n(${dropped} further constraint block(s) omitted — over workflow.pin_invariants_budget=${budget}.)`;
  }
  return { context, dropped, budget };
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
    let output = null;
    try {
      output = sessionStartOutput(JSON.parse(input));
    } catch {
      crash(HOOK_ON_CRASH.ALLOW, undefined); // a pin that cannot be built must never disturb a session
    }
    allow(output || undefined);
  });
}

/**
 * The whole stdout payload for one hook invocation, or null for silence: the
 * worktree provisioning notice (taken — stamped delivered — only when the
 * event can carry it), then the pin.
 */
function sessionStartOutput(data, { now } = {}) {
  const cwd = (data && typeof data.cwd === 'string' && data.cwd) || process.cwd();
  if (!pinOutput(data, '')) return null; // an event that cannot carry context consumes nothing
  const pin = buildPin(cwd);
  const notice = takeNotice(cwd, { now });
  const parts = [notice ? formatNotice(notice) : null, pin ? pin.context : null].filter(Boolean);
  return parts.length ? pinOutput(data, parts.join('\n\n')) : null;
}

/**
 * The stdout payload for a built pin, or null when the event cannot carry one.
 *
 * Claude Code takes context from a SessionStart hook only as
 * `hookSpecificOutput.additionalContext` (a top-level `additionalContext` is
 * not read), and after a compaction it fires SessionStart again with
 * `source: "compact"` — that re-fire is the documented re-injection point.
 * PostCompact is observational and cannot add context, so an entry left there
 * by an older install stays silent instead of printing output nobody reads.
 */
function pinOutput(data, context) {
  const event = data && typeof data.hook_event_name === 'string' ? data.hook_event_name : 'SessionStart';
  if (event !== 'SessionStart') return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } };
}

if (require.main === module) {
  main();
}

module.exports = {
  buildPin,
  pinOutput,
  sessionStartOutput,
  findRunningPlan,
  readWaiting,
  readPinnedBlock,
  listField,
  PIN_OPEN,
  PIN_CLOSE,
};
