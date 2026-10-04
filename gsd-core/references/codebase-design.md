# Codebase design — the vocabulary of the architecture survey

Read by `gsd-arch-surveyor` and by whoever reads a `SURVEY-<date>.md`. Adapted from
the `codebase-design` and `improve-codebase-architecture` skills of
[mattpocock/skills](https://github.com/mattpocock/skills) (MIT), commit `24fe0ef`.

The aim is **deep modules**: a lot of behaviour behind a small interface, placed at a
clean seam, testable through that interface. Leverage for callers, locality for
maintainers, testability for everyone.

## Glossary

Use these words exactly. Do not substitute "component", "service", "API" or
"boundary": a shared vocabulary is the point.

- **Module** — anything with an interface and an implementation: a function, a class, a
  package, a slice across tiers. Scale-agnostic on purpose.
- **Interface** — everything a caller must know to use the module correctly: the type
  signature, and also invariants, ordering constraints, error modes, required
  configuration, performance characteristics. Not the `interface` keyword, not "the
  public methods".
- **Implementation** — the body of code inside a module.
- **Depth** — leverage at the interface: how much behaviour a caller (or a test) can
  exercise per unit of interface it has to learn. **Deep** = much behaviour behind a small
  interface. **Shallow** = the interface is nearly as complex as the implementation.
- **Seam** (Feathers) — a place where behaviour can be altered without editing in that
  place; where a module's interface lives. Choosing the seam is its own decision.
- **Adapter** — a concrete thing that satisfies an interface at a seam. Names a role, not
  a substance.
- **Leverage** — what callers get from depth: one implementation pays back across N call
  sites and M tests.
- **Locality** — what maintainers get from depth: change, bugs, knowledge and
  verification concentrate in one place. Fix once, fixed everywhere.

## Principles

- **Depth is a property of the interface, not of the implementation.** A deep module can
  be built from small parts internally; they are just not part of its interface.
- **The deletion test.** Imagine deleting the module. If its complexity vanishes, it was
  a pass-through. If the complexity reappears across its callers, it was earning its
  keep. Only a deletion that *concentrates* complexity — the callers would each have to
  re-implement what it hides — supports a deepening candidate. A deletion that merely
  *moves* code is not a candidate.
- **The interface is the test surface.** Callers and tests cross the same seam. Wanting
  to test past the interface means the module is the wrong shape.
- **One adapter is a hypothetical seam; two adapters are a real one.** Do not introduce a
  seam (a port) unless something actually varies across it — typically production and
  test.

## Rejected framings

- **Depth as implementation lines divided by interface lines** (Ousterhout). It rewards
  padding the implementation. No line ratio is a depth verdict here. `arch metrics`
  carries `exportsPerLoc` per module as a hint for where to look, nothing more.
- **"Interface" as a type signature only** — too narrow; invariants and error modes are
  part of what a caller must know.
- **"Boundary"** — overloaded with the bounded context of DDD. Say seam or interface.

## What the survey looks for

The friction kinds a candidate card names (`kind`):

| Kind | Friction |
|---|---|
| `scattered-concept` | Understanding one concept means bouncing between many small modules |
| `shallow-module` | The interface is nearly as complex as the implementation |
| `pass-through` | Deleting the module would make its complexity vanish, not move |
| `no-locality` | Pure functions extracted for testability while the bugs live in how they are called |
| `leaky-seam` | Tightly coupled modules leak across their seams |
| `untestable-interface` | The current interface makes the behaviour hard to test |
| `cycle` | Modules import each other at runtime |
| `smeared-change` | Files change together without an import between them: one behaviour in several places |
| `other` | None of the above, named in the problem text |

Strength: **Strong** (the deletion test concentrates complexity, with evidence),
**Worth exploring**, **Speculative**. A Strong card without a concentrating deletion
test is shown as Worth exploring.

## Deepening a candidate

Classify the candidate's dependencies first; the category decides how the deepened
module is tested across its seam.

1. **In-process** — pure computation, in-memory state. Merge and test through the new
   interface; no adapter needed.
2. **Local-substitutable** — a local stand-in exists (an in-memory filesystem, an
   embedded database). Test with the stand-in; the seam stays internal.
3. **Remote but owned** — your own service across a network. Define a port at the seam;
   production uses a network adapter, tests an in-memory one.
4. **True external** — a third party you do not control. Inject it as a port; tests use
   a mock adapter.

Replace, do not layer: once tests at the deepened interface exist, the old unit tests of
the shallow modules are waste. Tests assert observable outcomes through the interface and
survive internal refactors.

## Design it twice

When a chosen candidate needs an interface, design it several radically different ways
before picking one (Ousterhout): minimise the interface (one to three entry points),
maximise flexibility, optimise for the most common caller, and — when a dependency crosses
a network — design around ports and adapters. Compare the designs by depth, locality and
seam placement, then recommend one or a hybrid. This happens after the survey, in
`/gsd:explore` or the phase that takes the candidate, never inside the survey itself.
