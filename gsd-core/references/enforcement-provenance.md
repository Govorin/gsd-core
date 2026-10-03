# What guards this? — provenance for every finding and every rule

Read by `gsd-code-reviewer` and `gsd-architect-reviewer` when
`workflow.enforcement_provenance` is on.

## The rule

**A check is a mechanism only once it has an assigned execution point.** A
script that is written but called by nothing is not a weak mechanism — it is
worse than none, because it creates the impression that the invariant is
guarded and removes the question from review while checking nothing.

That makes "this is a violation" and "CI will catch this" two different claims,
and the second is wrong more often than anyone expects. Three things have to
line up before it is true:

1. a rule or script exists,
2. something invokes it — a lint config at `error`, a CI step, a git hook,
3. the thing that invokes it actually runs on the change in question.

Any one of the three missing, and the rule is an agreement, not a mechanism.
Agreements are kept by review — that is, by you.

## What this asks of a review

**For every finding, say what guards it.** Not as decoration: the sentence
changes what happens next.

- `guarded by: enforce-layer-imports (oxlint, error)` — the pipeline will catch
  a recurrence. The finding is worth fixing and then forgetting.
- `guarded by: review only` — nothing will catch a recurrence. Either the fix
  must come with a mechanism, or the team accepts that this class of defect
  returns whenever nobody is looking.

The provenance is what tells those two apart, and they call for different work.

**Check the rule's actual reach before claiming it.** A rule can be real,
enabled, and still not apply: several boundary rules that read as general are
hardcoded to one domain or one path prefix, so the identical violation
elsewhere is caught by nobody. Read the rule's severity and its scope — a rule
at `warn` in a project whose lint step tolerates warnings guards nothing.

Do not write "caught by lint" from memory. The claim is checkable in seconds
and wrong often enough that checking is cheaper than being wrong.

## The failure this prevents

A reviewer who says "the linter has this" when it does not produces a silence
that reads as safety. Nobody re-examines the boundary, because it was declared
guarded; the next violation of it is invisible for as long as nobody happens to
look. The defect was not the missing rule — it was the false statement that one
existed.

The inverse costs little: naming a mechanism that turns out to be redundant
wastes one line.

## A ledger of what nothing guards

Where a project keeps a list of rules that hold by agreement rather than by
machine, read it and keep it current. A finding whose rule is on that list is
not "already handled"; it is precisely the finding that needs a human decision,
because no mechanism will make it again.

Adding a check means three steps, not one: write it, wire it to an execution
point, and confirm that the execution point itself runs. Steps two and three
are not polish — without them the first is decoration, and each new script
enlarges the illusion of coverage rather than the coverage.
