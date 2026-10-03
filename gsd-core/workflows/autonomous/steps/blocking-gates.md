Before transitioning, run the blocking gates the interactive path would have run:

```bash
SHIP_GATES=$(gsd_run loop render-hooks ship:pre --raw 2>/dev/null || echo '{}')
VERIFY_GATES=$(gsd_run loop render-hooks verify:pre --raw 2>/dev/null || echo '{}')
```

Autonomous never reaches `ship`, and every other dispatch point here takes only `kind == "step"` hooks — so a gate declared at `ship:pre` or `verify:pre` currently never executes in this mode. That is backwards: unattended is precisely when a gate earns its keep, because no one is reading the output as it goes by.

For each entry in either `activeHooks` array where `kind == "gate"` and `blocking` is true, evaluate its check:

```bash
gsd_run check predicate --predicate '<check.predicate JSON>' --phase-dir "${PHASE_DIR}" --raw
```

- Every gate returns `block: false` → continue to the transition.
- Any gate returns `block: true` → handle_blocker with that gate's `message`. Do not transition: a phase whose own artifacts still report unproven work has not earned an unattended advance.
- The check command itself fails — malformed predicate, missing script, unknown predicate kind → handle_blocker with the error. A gate that could not run is not a gate that passed, and treating it as one is how a green run stops meaning anything.
