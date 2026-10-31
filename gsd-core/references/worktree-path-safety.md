# Worktree Path Safety

Guards for executor agents running inside Claude Code worktrees. The
supplied-root pin (step 0p) runs in EVERY mode; the remaining checks run before
any staging, Edit, or Write operation in worktree mode.

Every guard is a gsd-tools `worktree guard <stage>` verb (ADR-5211). Claude Code
≥ 2.1.310 refuses `$(git …)`, `git -C`, `cd … &&` and variables in git or node
arguments inside an `isolation="worktree"` agent, so the checks run in node and
you run ONE literal command. `{GSD_TOOLS_CMD}` is the launcher your prompt's
`<gsd_tools_launcher>` block names (`node '/abs/…/gsd-tools.cjs'`; with no such
block, `gsd_run`); write every argument out literally — no `$VAR`, no `$(…)`.
Each verb prints JSON
`{ok, stage, code, exit_code, applies, detail}` and exits non-zero on a refusal.
A non-zero exit, or a guard that cannot run at all, is a HALT — never a skip,
never a retry in another form.

---

## Supplied-root pin — step 0p (#4254, EVERY mode)

Sequential-mode dispatch (no `isolation="worktree"`) gives the executor no
spawn-time cwd guarantee, and the worktree-only guards below do not apply — so
a sequential executor whose process cwd resolved to a different checkout of
the same repo would self-derive that checkout as its root and commit there,
silently. Step 0p closes that hole by comparing the executor's actual root
against a root the ORCHESTRATOR already validated — never against anything the
executor derives itself.

**Runtime contract (executor):** if your prompt contains a `<project_root_pin>`
block, run its command verbatim before your first Edit/Write and again
before every commit, in the same cwd as that write or commit. On a refusal, halt and
report the JSON `code` — recovery (moving commits between checkouts) is an
orchestrator/human decision, never agent self-repair. If your prompt contains
NO `<project_root_pin>` block (worktree/isolated dispatch, or a legacy
orchestrator), emit one warning line and continue with steps 0a/0b below — do
not fail closed on dispatches that never carried a pin. **Never bind
`{PINNED_ROOT}` yourself**: if this template reaches you unbound it is
reference prose, not your pin — only the orchestrator's build-time
substitution produces a valid guard (an unbound pin is refused as `pin_unbound`).

**Composition contract (orchestrator — build time, NOT a sub-agent runtime
step):** copy the command below into the dispatched prompt inside a
`<project_root_pin>` block, substituting `{GSD_TOOLS_CMD}` with `gsd_tools_cmd`
from `init` and `{PINNED_ROOT}` with the literal value of `$ORCHESTRATOR_WT`
captured at execute_waves entry, shell-single-quoted: wrap the path in `'…'`
and escape any embedded `'` as `'\''`. A path that cannot be quoted this way
must halt the phase (surface a blocker) rather than ship a pin that could
mis-parse. The verb compares git-vs-git on BOTH sides, so symlink aliases,
trailing slashes, `/var` vs `/private/var` spellings and Windows drive-letter
forms (`C:/…` or `C:\…`) compare equal by construction; a relative pin is
refused (`pin_not_absolute`), and the only legitimate other root is the
IMMEDIATE submodule of the pinned checkout — nested submodules surface as a
blocker (`root_mismatch`), not a self-route.

```bash
# gsd:guard=supplied-root-pin (#4254) — run before the first Edit/Write and before every commit.
{GSD_TOOLS_CMD} worktree guard pin --root {PINNED_ROOT}
```

---

## Worktree branch check (run once at spawn-time)

The spawn-time HEAD/base guard now lives in the canonical fragment
`gsd-core/references/worktree-branch-check.md`, which the orchestrator embeds directly
into your prompt at dispatch. Run that block FIRST, before any reset/checkout or staging.
If your prompt contains a `<worktree_branch_check>` embed instruction rather than the block itself, complete that read-and-embed step before any reset/checkout or staging.

---

## cwd-drift sentinel — step 0a (#3097)

A prior Bash call may have `cd`'d out of the worktree into the main repo, which
silently skips every worktree guard. The first run records the spawn-time
toplevel in the worktree's git dir; every later run (before each commit)
refuses with `cwd_drift` when the toplevel moved — `cd` back to
`detail.recovery_cd` and re-run the commit. Outside a linked worktree it reports
`applies: false` and passes.

```bash
{GSD_TOOLS_CMD} worktree guard sentinel
```

---

## Absolute-path guard — step 0b (#3099)

Edit/Write calls using absolute paths constructed from the **orchestrator's** `pwd`
(main repo root) will resolve to the main repo, not the worktree. Writes land in
the wrong directory; `git commit` from the worktree sees a clean tree and the work
is silently lost.

Before any Edit or Write using an absolute path, check it (repeat `--path` for several):

```bash
{GSD_TOOLS_CMD} worktree guard abs-path --path '/the/absolute/path/written/out'
```

Containment is resolved, not a string prefix: a sibling `<root>-x`, a `..` hop, or a
symlink inside the worktree that lands in the main checkout is `outside_worktree`.
**Prefer relative paths** for all Edit/Write operations. When an absolute path is
unavoidable, derive it from `git rev-parse --show-toplevel` run inside the
worktree — never from `pwd` captured in the orchestrator context.

---

## `<automated>` command guard — step 0c (#4767)

The plan's `<automated>` text is where an orchestrator-cwd absolute path most often
arrives: the planner saw absolute paths in its own context and wrote one into the
command. Run as written, `cd /abs/main-checkout/… && <test>` leaves the worktree, runs
against the main tree, and **passes on code this worktree changed and the main tree did
not** — a green verify that verified nothing. Before executing a task's `<automated>`
commands, have the verb read them from the plan by task number (1-based, in document
order) and scan them:

```bash
{GSD_TOOLS_CMD} worktree guard automated --plan '/path/to/the/PLAN.md' --task 2
```

It refuses `relocates_outside_worktree` (a `cd`/`pushd`, a tool's directory flag, or an
`env -C` launcher that lands outside the worktree, including inside an unwrapped
`bash -c`/`eval`/`node -e` payload) and `names_main_checkout` (any other absolute word
under the main checkout). Fail loud; never rewrite the command (#3050) — a rewritten
command hides the defective plan, and the next executor meets it again. A halt here is a
plan defect, not an executor deviation: report it via the checkpoint return format naming
the task and the offending command verbatim, and stop. The plan-checker's path probe
(`check verify-command-paths`) warns on the *outside-orchestrator-root* case before
execution; this guard is the one that sees the executor's actual root.

### What the automated stage does NOT see — step 0c's stated boundary

The scan recognizes **fixed sets** of relocating verbs, directory flags, interpreters,
launchers and command boundaries, matched against the command TEXT (it never runs it). The
full rationale lives with the code (`src/automated-command-containment.cts`); in
descending order of how likely a planner is to reach them:

- **A RELATIVE path argument to a command that is not a relocating verb** —
  `node ../main/test.js`, `make -f ../main/Makefile` — passes. Only words beginning with
  `/` are resolved; this is the widest gap.
- **Anything the shell builds at run time** — `cd $VAR`, `cd "$(…)"`, `~`,
  `bash -c "$CMD"`. `check verify-command-paths` reports these as `dynamic_path`.
- **A `cd` the shell completes from its own state** — bare `cd`, `cd -`, `CDPATH`, an alias
  or function defined elsewhere, a sourced script (`. ./x.sh`), a file a tool runs
  (`npm test`'s script, `bash x.sh`): the text holds no target.
- **A command boundary outside `&&` `&` `;` `|` `(` `{` and line start.** After a boundary,
  `time`, `!` and `if`/`then`/`else`/`elif`/`do`/`while`/`until` are read as prefixes;
  elsewhere they are words, so `grep -F 'if cd ../main; then' README.md` passes. The scan is
  quote-blind, so `echo 'note; bash -c "cd ../main"'` halts — an over-halt, in the loud
  direction. `eval` rescans all its words (`eval cd ../main` halts); an `eval` behind
  `exec`/`command` is not seen.
- **A launcher outside `env` `timeout` `nohup` `stdbuf` `nice` `ionice` `setsid`.**
  `command` and `exec` are excluded so `command -v bash` (a name probe) does not halt.
- **An interpreter outside the recognized set.** Recognized, each named by a bare word OR an
  absolute path: `sh` `bash` `zsh` `dash` `ksh`, and `python3`/`python` `node` `perl`
  `ruby`, with the option a short-option CLUSTER (`-c`, `-ec`, `-abc`). Recognized as a
  BARE WORD ONLY: `eval`; `/bin/eval 'cd ../main'` is NOT seen.
  Not recognized: an interpreter with no entry (`awk`, `php`, a shell not listed), whose
  payload stays one opaque token. **The two lists are delimited on purpose** — a test drives
  every name in them against the verb, so prose that claims or disclaims coverage the scan
  does not have fails it.
- **An interpreter option that takes an operand** (`bash -O extglob -c`), a launcher or
  directory-flag spelling outside each tool's grammar (`env -S '…'`), and a non-shell payload
  whose path is computed (`os.path.join(root, '..')`). Wrapping nested more than four deep
  refuses (`unwrap_too_deep`).
- **A payload behind a relocating launcher is scanned from the command's cwd**
  (`env -C scripts bash -c 'cd ..'` over-halts), and a pass-through argument spelling a
  directory flag over-halts (`npm run x -- --prefix=../main/`) — both in the loud direction.
- **A directory flag on a tool outside** `npm` `npx` `pnpm` `yarn` (`--prefix`/`--cwd`/
  `--dir`/`-C`), `make` `git` (`-C`/`--directory`) and `env` (`--chdir`/`-C`): only its
  ABSOLUTE form is caught.

The guard is the executor's last containment check, not its only one — a halt it misses
still has to get past `check verify-command-paths` at plan time.
