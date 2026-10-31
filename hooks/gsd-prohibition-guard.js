#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Prohibition Guard — PreToolUse hook (mn fork)
//
// Problem: `files_modified` in PLAN.md is a declaration of intent, checked by
// plan-checker BEFORE work and by blast-radius AFTER it. Between those two
// points nothing reads it. An executor that drifts outside its declared scope
// discovers this at verify:pre — after the edits are on disk and, in the GSD
// commit discipline, usually already committed. The measured consequence in
// this fork's own history: 26 of 174 phases carry same-wave plans that touch
// overlapping files, and the fix is always a revert plus a replan.
//
// blast-radius is the same check one step too late. This guard moves it to the
// moment of the write, where the answer is still "don't" rather than "undo".
//
// Applicability (must positively determine all four to act — otherwise inert):
//   1. this is a GSD project (`.planning/` resolves from cwd),
//   2. a phase is in progress (STATE.md names it, or exactly one phase
//      directory holds a plan with `status: in_progress`),
//   3. that phase has at least one PLAN.md carrying `files_modified`,
//   4. the pending write targets a path under the repository.
//
// Decision (`workflow.prohibition_guard`, default "off"):
//   "off"  — inert.
//   "ask"  — a write outside the declared set escalates to the user
//            (`permissionDecision: "ask"`); the model cannot self-approve.
//   "deny" — the same write is blocked outright. For unattended runs, where
//            "ask" has no one to ask and times out into a default.
//   While auto mode is active (`gsd_run check auto-mode`), "ask" is answered
//   "deny" with a reason that says so: nobody is there to approve, and a
//   waiting write stalled recorded autonomous runs for hours
//   (hooks/lib/unattended-ask.js, shared with the test tamper guard).
//
// Always allowed regardless of mode, because blocking them would break the
// workflow itself rather than protect it:
//   • anything under `.planning/` — the harness's own bookkeeping (SUMMARY,
//     VERIFICATION, STATE) is written by design and is never in files_modified,
//   • paths matching a declared glob or a declared directory prefix — 10% of
//     real `files_modified` entries are globs or directories, and treating
//     `libs/rpg/ports/**` as a literal filename would deny every write it was
//     written to permit,
//   • files the phase's own plans declare, obviously.
//
// Fail-closed exception (#3050 lesson: a guard that cannot verify must not
// answer "safe"): if the project IS a GSD project, a phase IS in progress, and
// the guard cannot read that phase's plans, it escalates rather than allowing.
// A guard that waves writes through on a read error is not enforcement.
//
// Fail-open by construction: no `.planning/`, no phase in progress, no plan
// with a non-empty `files_modified`, or an unreadable/unrecognized payload —
// all exit 0. The guard only speaks when it can point at a declaration.
//
// An EMPTY `files_modified` across every plan is NOT treated as "declares
// nothing, so allow everything" — that is the inverse of what the field means
// and would make the guard silently inert on exactly the phases where the
// planner was sloppiest. It is treated as "this phase declared nothing", which
// is out of scope for a per-write guard, and reported by blast-radius at
// verify:pre instead (which refuses rather than passes). Hence: inert here.

'use strict';

const fs = require('fs');
const path = require('path');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { askOrDeny } = require('./lib/unattended-ask.js');

/** Modes, in the order of increasing strictness. */
const MODE_OFF = 'off';
const MODE_ASK = 'ask';
const MODE_DENY = 'deny';
const VALID_MODES = new Set([MODE_OFF, MODE_ASK, MODE_DENY]);

/** Tools whose payload carries a single destination path. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// #2304 class: Kimi's hook bus delivers Kimi's tool vocabulary in the payload
// while the matcher is registered pre-translated. A byte-identical copy of the
// canonical block in gsd-prompt-guard.js (tests/kimi-guard-normalization-parity
// binds every copy) — inlined per guard on purpose: hook scripts are staged as
// standalone files and a sibling require is a staging dependency that can fail
// silently. A Map (not an object literal) so prototype keys can't resolve.
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write'], ['StrReplaceFile', 'Edit'], ['ReadFile', 'Read'], ['Shell', 'Bash']]);
function normalizeKimiPayload(data) {
  // #2595 (review nit): `JSON.parse('null')` is null, and null/primitive
  // payloads reached the `data.tool_name` read below and threw — falsifying
  // this function's own "total over the inputs JSON can express" claim, which
  // property (e) now tests directly. Harmless in practice (a null payload has
  // nothing to guard, and the throw landed in the same fail-open catch as the
  // exit-0 it now takes deliberately) but the claim should be true as stated.
  if (data === null || typeof data !== 'object') return data;
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (data.tool_response === undefined && data.tool_output !== undefined) {
    data.tool_response = data.tool_output;
  }
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    // #2547 (review): Kimi's `path` is AUTHORITATIVE — it must win outright,
    // not merely fill in when `file_path` happens to be absent. kimi-cli's file
    // tools carry no `file_path` field at all (src/kimi_cli/tools/file/write.py,
    // replace.py, @ 4a550ef — the SHA #2547 pins), and soul/toolset.py hands the
    // model's raw json-parsed
    // arguments to PreToolUse verbatim, doing typed validation only later inside
    // tool.call() — after the hook has already decided. So a `file_path` in a
    // Kimi payload is ALWAYS model-supplied, and under the old `=== undefined`
    // condition it SHADOWED the field kimi-cli actually executes on. A payload
    // pairing a cross-root `path` with a spurious `file_path: ""` left every
    // guard reading an empty string and exiting 0, while the identical write
    // without the extra key blocked — a bypass needing no crash at all. The same
    // shadowing also preserved a NON-STRING `file_path` (`[]`), which threw
    // inside gsd-worktree-path-guard's path.isAbsolute() and reached its outer
    // `catch { process.exit(0) }`: the same crash-to-allow this fix closes
    // elsewhere, reached through the guard's own read rather than through
    // normalization. Overwriting can only ever narrow what a guard inspects to
    // the path that will actually be written, so it cannot under-block.
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      // #2547: `e?.old`, not `e.old` — `??` guards the value, not the
      // dereference, so a NULLISH entry (`edit: [null]`) threw a TypeError
      // here. normalizeKimiPayload runs before any tool dispatch, so that throw
      // reached each guard's outer `catch { process.exit(0) }` and silently
      // downgraded a should-BLOCK call into an allow. (A string/number entry
      // never threw — `('x').old` is a legal read yielding undefined.)
      //
      // The String() coercion is guarded for the same reason: `{"toString":
      // null}` is valid JSON that throws "Cannot convert object to primitive
      // value", which is the identical crash-to-allow with a different
      // trigger. Degrading only the non-coercible entry to '' keeps
      // stringification intact for every value that CAN coerce (numbers,
      // arrays, plain objects), so nothing downstream — including
      // gsd-prompt-guard's scan of new_string — loses content it saw before.
      const editText = (v) => { try { return String(v ?? ''); } catch { return ''; } };
      // #2595 (review Major 2): reconstruct UNCONDITIONALLY, mirroring the
      // `path` decision above rather than merely filling in when the field
      // happens to be absent. kimi-cli's StrReplaceFile schema is `path` +
      // `edit` only (src/kimi_cli/tools/file/replace.py @ 4a550ef) — it carries
      // no `old_string`/`new_string` at all, so either field appearing in a
      // Kimi payload is ALWAYS model-supplied, exactly like `file_path`. Under
      // the old `=== undefined` condition a model-supplied `new_string: ""`
      // SHADOWED the reconstruction, leaving gsd-prompt-guard's injection scan
      // reading '' and exiting at its `if (!content)` before it ever saw the
      // real `edit[].new` — a one-key bypass of the very scan this fix's
      // guarded coercion exists to keep fed. A `typeof` test would NOT close
      // it: a benign non-empty string shadows just as effectively as ''.
      input.old_string = edits.map((e) => editText(e?.old)).join('\n');
      input.new_string = edits.map((e) => editText(e?.new)).join('\n');
    }
  }
  return data;
}

/**
 * Walk up from `cwd` to the nearest directory holding `.planning/`.
 *
 * Nearest-upward, not repo-root: the measured topology in this fork's own
 * projects is 10 `.planning/` roots inside one monorepo (`mn`) and 3 in another
 * (`awesome-projects`). Anchoring at the repo root would read the wrong phase's
 * plans for every nested project — the exact failure recorded in the ucars
 * retrospective ("gsd-tools state/roadmap intermittently resolved to the wrong
 * monorepo-root .planning/").
 */
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

/** Read `workflow.prohibition_guard` from a project's config. Absent → off. */
function readMode(planningRoot) {
  try {
    const raw = fs.readFileSync(path.join(planningRoot, '.planning', 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const value = cfg && cfg.workflow ? cfg.workflow.prohibition_guard : undefined;
    if (typeof value !== 'string') return MODE_OFF;
    const normalized = value.trim().toLowerCase();
    return VALID_MODES.has(normalized) ? normalized : MODE_OFF;
  } catch {
    // No config, unreadable config, or malformed JSON: the guard is opt-in, and
    // an unreadable config cannot have opted in. Distinct from the fail-closed
    // branch below, which only applies once the mode is known to be armed.
    return MODE_OFF;
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

/**
 * Extract `files_modified` from a plan's frontmatter.
 *
 * Both YAML forms the planner actually emits are read: the block list
 * (`files_modified:` followed by `  - path` lines) and the inline array
 * (`files_modified: [a, b]`). A full YAML parser would be a dependency for a
 * guard that must run without installation; anything that matches neither shape
 * ends the list rather than being guessed at. The gate that reads the same key
 * (`check mn-blast-radius`, src/gate-mn-blast-radius.cts `declaredFilesOf`)
 * goes through the full frontmatter parser, which this hook cannot load.
 */
function declaredFiles(text) {
  const body = frontmatterBody(text);
  if (body === null) return [];
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^files_modified:\s*$/.test(l));
  if (start === -1) {
    const inline = /^files_modified:\s*\[(.*)\]\s*$/m.exec(body);
    if (!inline) return [];
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    // A blank line inside the block does NOT end it. Measured: 17 of 96 plans
    // in one live project put an empty line between `files_modified:` and the
    // first `  - path`, and treating that as the end of the list made the
    // guard read those plans as declaring nothing — which, by the empty-
    // declaration rule below, silently turned it off for exactly those phases.
    // YAML ignores the blank line; so does this now.
    if (lines[i].trim() === '') continue;
    const m = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) break; // a non-item, non-blank line closes the block
    const entry = m[1].replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '').trim();
    if (entry) out.push(entry);
  }
  return out;
}

/** `status:` from a plan's frontmatter, or null when the field is absent. */
function planStatus(text) {
  const body = frontmatterBody(text);
  if (body === null) return null;
  const m = /^status:\s*(.+?)\s*$/m.exec(body);
  return m ? m[1].replace(/^['"]|['"]$/g, '').trim() : null;
}

/**
 * Resolve the phase directory whose declaration governs this write.
 *
 * Two signals, in order of authority:
 *   1. a plan marked `status: in_progress` — written by the executor at
 *      dispatch (feat/mn-verify-gate: "mark a plan in_progress when execution
 *      starts"), so it is the freshest statement of what is running now;
 *   2. `STATE.md`'s `current_phase` — the orchestrator's view, correct between
 *      plans but stale while a plan is mid-flight.
 *
 * Returns `{ phaseDir }`, `{ error }` when a signal exists but its target
 * cannot be read, or `null` when no phase is in progress at all.
 */
function resolveActivePhase(planningRoot) {
  const phasesDir = path.join(planningRoot, '.planning', 'phases');
  let entries;
  try {
    entries = fs.readdirSync(phasesDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // no phases yet — nothing to govern
    return { error: err };
  }

  const phaseDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  // Signal 1: a plan that says it is running.
  const inProgress = [];
  for (const name of phaseDirs) {
    const dir = path.join(phasesDir, name);
    let planNames;
    try {
      planNames = fs.readdirSync(dir).filter((f) => f.endsWith('PLAN.md'));
    } catch {
      continue; // one unreadable phase dir must not blind the scan
    }
    for (const plan of planNames) {
      let text;
      try {
        text = fs.readFileSync(path.join(dir, plan), 'utf8');
      } catch {
        continue;
      }
      if (planStatus(text) === 'in_progress') {
        inProgress.push(dir);
        break;
      }
    }
  }
  // Exactly one: unambiguous. Several at once means parallel waves are running
  // and no single declaration governs the write — the union of their scopes is
  // not a scope, so the guard steps aside rather than picking one.
  if (inProgress.length === 1) return { phaseDir: inProgress[0] };
  if (inProgress.length > 1) return null;

  // Signal 2: STATE.md.
  let stateText;
  try {
    stateText = fs.readFileSync(path.join(planningRoot, '.planning', 'STATE.md'), 'utf8');
  } catch {
    return null; // no STATE.md and no in-progress plan: nothing claims to be running
  }
  const m = /^current_phase:\s*(.+?)\s*$/m.exec(stateText);
  if (!m) return null;
  const current = m[1].replace(/^['"]|['"]$/g, '').trim();
  if (!current || current === 'null' || current === 'none') return null;

  // STATE.md may name the phase by id ("03") or by directory ("03-ports").
  const exact = phaseDirs.find((d) => d === current);
  if (exact) return { phaseDir: path.join(phasesDir, exact) };
  const byPrefix = phaseDirs.filter((d) => d === current || d.startsWith(`${current}-`));
  if (byPrefix.length === 1) return { phaseDir: path.join(phasesDir, byPrefix[0]) };
  return null; // ambiguous or absent — do not guess which phase governs
}

/**
 * Collect declared paths for a phase.
 *
 * Returns `{ declared: string[] }`, or `{ error }` when the phase directory
 * cannot be read — the fail-closed branch, because an armed guard that cannot
 * see the declaration must not answer "in scope".
 */
function collectDeclared(phaseDir) {
  let planNames;
  try {
    planNames = fs.readdirSync(phaseDir).filter((f) => f.endsWith('PLAN.md')).sort();
  } catch (err) {
    return { error: err };
  }
  if (planNames.length === 0) return { declared: [] };

  const declared = [];
  for (const name of planNames) {
    let text;
    try {
      text = fs.readFileSync(path.join(phaseDir, name), 'utf8');
    } catch (err) {
      return { error: err };
    }
    for (const entry of declaredFiles(text)) {
      declared.push(entry.replace(/^\.\//, '').replace(/^\/+/, ''));
    }
  }
  return { declared };
}

/**
 * Does `target` (repo-relative, forward slashes) fall inside `entry`?
 *
 * Three shapes are honoured, because all three occur in real plans:
 *   • exact path            `libs/rpg/ports/book.port.ts`
 *   • directory prefix      `libs/rpg/ports/`  or  `libs/rpg/ports`
 *   • glob                  `libs/rpg/ports/@@`, `libs/@@/x.spec.ts` (@@ = double star)
 *
 * Measured on this fork's projects: ~10% of entries are globs or directories.
 * Literal-only matching would deny writes those entries exist to permit, which
 * is the failure mode that trains people to disable a guard.
 */
function matchesDeclaration(target, entry) {
  if (!entry) return false;
  const clean = entry.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!clean) return false;

  if (clean === target) return true;

  // Directory: declared as a path with no glob and no extension-looking tail,
  // or with an explicit trailing slash.
  if (clean.endsWith('/')) return target.startsWith(clean);

  if (!clean.includes('*') && !clean.includes('?')) {
    // `libs/rpg/ports` covers `libs/rpg/ports/book.ts`. A file declared without
    // an extension is indistinguishable from a directory here; treating it as a
    // prefix errs toward allowing, which is correct for a scope declaration.
    // `?` must fall through to the glob branch — it is a wildcard, and treating
    // a pattern that carries one as a literal directory prefix would silently
    // match nothing.
    return target.startsWith(`${clean}/`); // allow-handrolled-containment: matches a repo-relative path against a files_modified declaration (selection), not a filesystem boundary
  }

  // Glob: a double star spans separators, a single star and ? do not.
  //
  // A trailing double star is the common "everything under here" form and must
  // cover the whole subtree, files directly inside it included. It is handled
  // before the general translation, because the general form (optional path
  // segments) leaves nothing to match at the end of the pattern and would
  // reject such a declaration against a file sitting directly inside it.
  const trailing = /^(.*?)\/?\*\*$/.exec(clean);
  if (trailing) {
    const prefix = trailing[1];
    if (!prefix) return true; // a bare double star declares the whole tree
    if (!prefix.includes('*')) return target === prefix || target.startsWith(prefix + '/'); // allow-handrolled-containment: matches a repo-relative path against a files_modified declaration (selection), not a filesystem boundary
  }

  // A NUL byte stands in for the separator-crossing double star: it cannot
  // occur in a path, so it cannot collide with literal pattern text the way a
  // printable placeholder could.
  const CROSS = String.fromCharCode(0);
  const rx = clean
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, CROSS)
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(CROSS)
    .join('(?:.*/)?');
  try {
    return new RegExp(`^${rx}$`).test(target);
  } catch {
    return false; // an unparseable declaration cannot authorize, but must not crash
  }
}

/**
 * Decide one PreToolUse payload.
 *
 * Pure: no stdin, stdout, or process.exit — the directly testable core, per the
 * seam convention established by gsd-agent-isolation-guard.js.
 *
 * Returns `{ action: 'allow' }` or
 * `{ action: 'ask' | 'deny', reason, unattended, targetPath, phaseDir, declaredCount }`;
 * `unattended` marks an "ask" answered "deny" because auto mode is active.
 * `isAutoRun(planningRoot)` overrides the auto-mode reader (tests).
 */
function evaluateWrite(data, { cwd: cwdOverride, isAutoRun } = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow' };
  const payload = normalizeKimiPayload(data);

  if (!WRITE_TOOLS.has(payload.tool_name)) return { action: 'allow' };

  const rawInput = payload.tool_input;
  const rawPath =
    rawInput && typeof rawInput === 'object' && typeof rawInput.file_path === 'string'
      ? rawInput.file_path
      : '';
  if (!rawPath) return { action: 'allow' };

  const cwd = cwdOverride || payload.cwd || process.cwd();
  const planningRoot = findPlanningRoot(cwd);
  if (!planningRoot) return { action: 'allow' }; // not a GSD project

  const mode = readMode(planningRoot);
  if (mode === MODE_OFF) return { action: 'allow' };

  const active = resolveActivePhase(planningRoot);
  if (!active) return { action: 'allow' }; // no phase in progress
  if (active.error) {
    return {
      ...askOrDeny(mode, planningRoot,
        `Prohibition guard: could not read this project's phase directory under ` +
        `'${planningRoot}/.planning/phases' (${active.error.code || 'unknown read error'}), so ` +
        `the declared scope of the running phase is unknown. workflow.prohibition_guard is ` +
        `"${mode}", and a guard that cannot verify must not answer "in scope". Retry once the ` +
        `directory is readable.`, isAutoRun),
      targetPath: rawPath,
      phaseDir: null,
      declaredCount: 0,
      readError: active.error.code ? String(active.error.code) : 'UNKNOWN',
    };
  }

  const { phaseDir } = active;
  const collected = collectDeclared(phaseDir);
  if (collected.error) {
    return {
      ...askOrDeny(mode, planningRoot,
        `Prohibition guard: could not read the plans in '${phaseDir}' ` +
        `(${collected.error.code || 'unknown read error'}), so this phase's declared file scope ` +
        `is unknown. workflow.prohibition_guard is "${mode}", and a guard that cannot verify ` +
        `must not answer "in scope". Retry once the plans are readable.`, isAutoRun),
      targetPath: rawPath,
      phaseDir,
      declaredCount: 0,
      readError: collected.error.code ? String(collected.error.code) : 'UNKNOWN',
    };
  }

  const declared = collected.declared;
  // A phase whose plans declare nothing is out of scope for a per-write guard —
  // see the header note. blast-radius refuses this case at verify:pre.
  if (declared.length === 0) return { action: 'allow' };

  // Resolve the write target relative to the planning root, following symlinks
  // so a link into a declared tree is judged by where it lands, not where it is
  // named (the gsd-write-guard.js precedent).
  let absolute = path.resolve(cwd, rawPath);
  try {
    absolute = fs.realpathSync(absolute);
  } catch {
    /* new file — keep the lexical path */
  }
  const relative = path.relative(planningRoot, absolute).replace(/\\/g, '/');

  // Outside the project tree entirely: not this phase's business. Writes to
  // ~/.claude, /tmp, a sibling repo — all legitimate and none declarable.
  if (!relative || relative.startsWith('../')) return { action: 'allow' };

  // The harness's own bookkeeping. SUMMARY.md, VERIFICATION.md, STATE.md and
  // the rest are written by design and never appear in files_modified; guarding
  // them would block the workflow instead of protecting it.
  if (relative === '.planning' || relative.startsWith('.planning/')) return { action: 'allow' };

  if (declared.some((entry) => matchesDeclaration(relative, entry))) return { action: 'allow' };

  const phaseName = path.basename(phaseDir);
  const reason =
    `Prohibition guard: '${relative}' is not declared by any plan in phase '${phaseName}'. ` +
    `That phase's plans declare ${declared.length} path(s); this write falls outside all of ` +
    `them. Either the work drifted outside the task, or the plan was incomplete — both need a ` +
    `decision, not a silent edit. To proceed: add '${relative}' to the owning PLAN.md's ` +
    `files_modified (and say why in the plan's deviation notes), or write inside the declared ` +
    `scope instead. This is blast-radius (verify:pre) moved to the moment of the write, where ` +
    `the answer can still be "don't" rather than "revert".`;

  return {
    ...askOrDeny(mode, planningRoot, reason, isAutoRun),
    targetPath: relative,
    phaseDir,
    declaredCount: declared.length,
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
      decision = evaluateWrite(JSON.parse(input));
    } catch {
      // Silent fail — a malformed payload must never block a valid tool call.
      crash(HOOK_ON_CRASH.ALLOW, undefined);
    }
    if (!decision || decision.action === 'allow') allow(undefined);

    // `ask` escalates to the user through the permission layer and leaves the
    // session running; `deny` blocks outright. Both carry typed fields beside
    // the prose so consumers never regex the reason (CONTRIBUTING.md).
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.action === 'deny' ? 'deny' : 'ask',
        permissionDecisionReason: decision.reason,
      },
      decision: decision.action === 'deny' ? 'block' : undefined,
      targetPath: decision.targetPath,
      declaredCount: decision.declaredCount,
      readError: decision.readError,
      unattended: decision.unattended || undefined,
      reason: decision.reason,
    };
    // Kimi feeds stderr (not stdout) back to the model on exit 2, so a deny
    // carries the plain reason on fd 2 beside the JSON on fd 1.
    if (decision.action === 'deny') deny(output, decision.reason);
    emitAskReason(decision.reason);
    allow(output);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateWrite,
  declaredFiles,
  matchesDeclaration,
  findPlanningRoot,
  resolveActivePhase,
  readMode,
};
