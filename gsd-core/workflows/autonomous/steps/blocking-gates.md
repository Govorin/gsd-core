Before transitioning, run the blocking gates the interactive path would have run:

```bash
SHIP_GATES=$(gsd_run loop render-hooks ship:pre --raw 2>/dev/null || echo '{}')
VERIFY_GATES=$(gsd_run loop render-hooks verify:pre --raw 2>/dev/null || echo '{}')
```

Autonomous never reaches `ship`, and every other dispatch point here takes only `kind == "step"` hooks — so a gate declared at `ship:pre` or `verify:pre` would otherwise never execute in this mode. That is backwards: unattended is precisely when a gate earns its keep, because no one is reading the output as it goes by.

For each entry in either `activeHooks` array where `kind == "gate"` and `blocking` is true, dispatch it exactly as `@~/.claude/gsd-core/references/loop-hook-dispatch.md` § `gate` specifies — validate `check` in-context before any shell use, pass `check.predicate` as a single argv element, honor `onError`. With `--phase-dir "${PHASE_DIR}"` for a predicate check:

- Every gate returns `block: false` → continue to the transition.
- Any gate returns `block: true` → handle_blocker with that gate's `message`. Do not transition: a phase whose own artifacts still report unproven work has not earned an unattended advance.
- A gate whose check errors, or whose `check` fails validation → route by its `onError`; on `halt`, handle_blocker with the error. Never report such a gate as passed.
