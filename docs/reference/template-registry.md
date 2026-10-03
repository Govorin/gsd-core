# The `gsd-template:` registry block

**Status:** specified, not yet applied. No template carries the block as of this writing.
**Applies to:** every `.md` file under `gsd-core/templates/`, recursively.
**Implemented by:** `scripts/gen-template-registry.cjs` (Plan 02). **Enforced by:** the Plan 03 gate.

This document is the single authored definition of the `gsd-template:` block. The parser, the
generator and the gate all implement what is written here; where any of them diverges from this
document, that divergence is a defect in the code, not a documentation nit.

---

## What the block is, and what it is not

A `gsd-template:` block is **metadata about a template file** — its level, its lifecycle, who
authors it and who reads it. A human maintains it. It is the source the registry index in
`gsd-core/templates/README.md` is generated from.

It is **not** an instruction, and it is **not** part of the artifact the template produces.

That second sentence carries the whole weight of this specification. Nothing in the codebase
reads template files at runtime — searched across `src/`, `gsd-core/bin/` and `bin/`: there is no
parser, no consumer, no code path that opens a template. Templates are consumed by **agents
reading them as text** through `@` references in prompts. The consequence is uncomfortable and
load-bearing: **any text placed in a template is text a model loads, and text a model loads it may
follow.** A registry block that reads like an instruction will be executed as one.

So the block is specified to be visually and structurally separable from the template body, and to
carry an explicit ignore-comment as part of its definition.

---

## The placement rule

> **The `gsd-template:` block is a YAML frontmatter block containing exactly one top-level key,
> `gsd-template:`, with every registry field nested beneath it. It is the FIRST block in the file
> that is not an artifact-frontmatter block. It is never merged into another block.**

The rule is uniform across all three shapes a template file takes today. There is no exception,
by deliberate choice: a rule whose exception applies to exactly one file is a rule the next author
gets wrong.

### The three shapes, measured

Of the 44 `.md` templates measured on 2026-08-26 (see *Measured, not assumed* below):

| Shape | Count | What the file opens with |
|---|---|---|
| **A — file-level frontmatter at byte 0** | 4 | `---` on line 1 |
| **B — artifact frontmatter inside a fence** | 12 | prose, then ```` ```markdown ```` then `---` |
| **C — neither** | 28 | prose or a heading |

### Shape C (28 files) — nothing to disambiguate

The block goes at byte 0. The file previously had no frontmatter; now it has exactly one block,
and that block is the registry block.

```markdown
---
# gsd-template: registry metadata about THIS TEMPLATE FILE.
# Not part of the artifact this template produces. Agents: ignore this block.
gsd-template:
  level: phase
  lifecycle: active
  required: false
  author: agent
  readers: [gsd-planner, gsd-executor]
---

# Phase {N} — ...
```

### Shape B (12 files) — the fence already separates them

These templates teach an artifact's frontmatter by showing it **inside a fenced code block**:

````markdown
Produce a file with this frontmatter:

```markdown
---
phase: {N}
status: draft
---
```
````

The artifact frontmatter lives inside the fence. A block placed at byte 0 is outside the fence,
and is therefore structurally not part of what the agent reproduces — the fence does the
disambiguation for free. The registry block goes at byte 0, exactly as in shape C.

The 12: `BET.md`, `DEBUG.md`, `DESIGN.md`, `PRODUCT.md`, `UAT.md`, `continue-here.md`,
`deferred-items.md`, `discovery.md`, `plan.md`, `state.md`, `summary.md`,
`verification-report.md`.

### Shape A (4 files) — the hard case, and why merging is prohibited

Four templates open with a frontmatter block at byte 0. Three of them
(`SECURITY.md`, `UI-SPEC.md`, `VALIDATION.md`) carry **the artifact's** frontmatter — the literal
bytes the template instructs the agent to emit into the produced `NN-VALIDATION.md`. The fourth
(`host/dev-preferences.md`) carries a `description:` key that genuinely describes the template
itself.

**For all four, the registry block is a SEPARATE second `---` block placed immediately after the
first. A `gsd-template:` key is never added into the existing block.**

Why merging is prohibited, stated plainly because it is this phase's defining constraint:

> The byte-0 block in `VALIDATION.md`, `SECURITY.md` and `UI-SPEC.md` is a **template of output**.
> Its keys are copied by the agent into the artifact. Adding `gsd-template:` to it would instruct
> every agent that runs `/gsd-plan-phase` or `/gsd-secure-phase` to stamp `gsd-template:` onto the
> produced `NN-VALIDATION.md` and `NN-SECURITY.md` — polluting real planning state, in every
> project, forever, with metadata that describes a file the artifact is not.

`host/dev-preferences.md` gets the same treatment even though its `description:` block is genuinely
self-describing and merging would be harmless there. Uniformity is worth more than the two lines
saved: the parser has one rule, the gate has one rule, and an author moving a key between templates
cannot get it wrong.

---

## Worked example: `gsd-core/templates/VALIDATION.md`

`VALIDATION.md` is the hardest of the 44 — a byte-0 artifact block, with comments, whose keys are
copied verbatim into produced artifacts. A rule that reads correctly here reads correctly
everywhere.

**Current bytes (lines 1–10, verbatim):**

```markdown
---
phase: {N}
slug: {phase-slug}
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: {date}
---

# Phase {N} — Validation Strategy
```

**After the block is applied (Plan 02) — two blocks, in this order:**

```markdown
---
phase: {N}
slug: {phase-slug}
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: {date}
---

---
# gsd-template: registry metadata about THIS TEMPLATE FILE.
# Not part of the artifact this template produces. Agents: ignore this block.
gsd-template:
  level: phase
  lifecycle: active
  required: false
  author: agent
  readers: [gsd-planner, gsd-validator]
---

# Phase {N} — Validation Strategy
```

The first block is unchanged, byte for byte. An agent reproducing "the frontmatter at the top of
the template" reproduces the first block and stops at its closing `---`. The second block is a
distinct block, headed by a comment that names itself as out of scope.

**Ordering note for the Plan 02 parser.** The registry block is the block whose sole top-level key
is `gsd-template:`. The parser identifies it by that key, never by ordinal position — "second
block" is where this spec puts it, not how the parser finds it. A parser keyed on position would
silently mis-read the 28 shape-C files, where the registry block is first.

---

## The key set is CLOSED

Exactly five keys are permitted under `gsd-template:`. **An unknown key is an authoring error**,
rejected by the Plan 03 gate — not a silently-carried extra field. This is specified here so the
gate's behaviour is designed rather than emergent.

| Key | Type | Allowed values | What a reader learns |
|---|---|---|---|
| `level` | string, closed | `project` · `milestone` · `phase` · `host` | Which scope the produced artifact belongs to — a `.planning/` root file, a milestone archive entry, a phase-directory file, or host-runtime config. |
| `lifecycle` | string, closed | `active` · `deprecated` · `experimental` | Whether the template is in current use, on its way out, or not yet load-bearing. A deprecated template still ships; readers should not build new workflows on it. |
| `required` | boolean | `true` · `false` | Whether the artifact must exist for the workflow that produces it to be considered complete. `false` means optional-by-design, not merely often-absent. |
| `author` | string, closed | `agent` · `human` · `generated` | Who writes the produced artifact: an agent during a workflow, a person by hand, or a generator script. Determines whether hand-edits are expected or will be overwritten. |
| `readers` | array of strings | agent or workflow identifiers, e.g. `gsd-planner` | Which agents load this artifact. An empty array is a real answer and means nothing loads it — a template with no readers is a candidate for `lifecycle: deprecated`. |

`required` is a genuine boolean, not the string `"true"`. `readers` is a YAML flow sequence.
Neither takes a null; omitting a key is as much an authoring error as inventing one.

### The ignore-comment is part of the block

Every emitted block is headed by exactly this two-line comment, immediately after the opening
`---`:

```yaml
# gsd-template: registry metadata about THIS TEMPLATE FILE.
# Not part of the artifact this template produces. Agents: ignore this block.
```

This comment is **part of the block by specification, not decoration**. It exists because of the
runtime fact recorded above: template bytes enter agent context, so the block must announce its own
scope in the same bytes an agent reads. Plan 02 emits it from a single constant; it is not
per-file authoring, and it is not optional.

---

## Measured, not assumed

Every figure below was re-measured on **2026-08-26** with the command shown. This project has
carried five stale figures forward before this one; two more were caught inside this plan.
Reproduce rather than inherit.

### 1. Template count — **44** `.md` files, plus `config.json`

```bash
find gsd-core/templates -type f -name '*.md' | wc -l    # → 44
```

ROADMAP and CONTEXT both said **32**. That figure counted a shell glob that stops at one
directory level (top level + `host/`) and omitted two subdirectories entirely:

```
top level + host/ ...... 32
codebase/ ..............  7
research-project/ ......  5
                        ----
                          44
```

Anything sized against 32 is under-scoped by a quarter. Measure with `find`, not with a glob.
Plan 03 corrects the ROADMAP; this document is where the corrected figure is derived.

### 2. Frontmatter distribution — **4 file-level / 12 fenced / 28 neither**

```bash
node -e "
const fs=require('fs'),p=require('path');
function walk(d,a=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const f=p.join(d,e.name); e.isDirectory()?walk(f,a):e.name.endsWith('.md')&&a.push(f);} return a;}
let fl=0,fenced=0,neither=0;
for (const f of walk('gsd-core/templates')) { const t=fs.readFileSync(f,'utf8');
  if (t.startsWith('---\n')) fl++;
  else if (/\`\`\`[a-z]*\n---\n/.test(t)) fenced++;
  else neither++; }
console.log(fl, fenced, neither);"                       # → 4 12 28
```

> **Deviation from the plan (Rule 1).** Plan 04.1-01 states **11 fenced / 29 neither**. The
> measured split is **12 / 28**. The uncounted file is `deferred-items.md`, which carries a fenced
> artifact block. The 4 / 44 figures are unaffected. Corrected here rather than carried, since
> carrying it is precisely the failure mode this section exists to stop.

### 3. Generator count — **15** `scripts/gen-*.cjs`

```bash
find scripts -maxdepth 1 -name 'gen-*.cjs' | wc -l      # → 15
```

Matches what CONTEXT recorded (D-70). No correction needed.

### 4. Emitted cost — **~45 × 19 hash movements**, expected to need **no ack fragment**

```bash
find tests/fixtures/install-tree -name '*.json' | wc -l  # → 19 install families
node -e "const s=require('fs').readFileSync('tests/fixtures/install-tree/claude.json','utf8');
console.log((s.match(/gsd-core\/templates\//g)||[]).length);"   # → 45 template paths
```

Every template is emitted into all 19 install families, so stamping all 45 template paths moves on
the order of **45 × 19** emitted hashes — not the ~32 the ROADMAP's figure implies.

The mitigating fact, and the reason that number is affordable:
`tests/helpers/emitted-provenance.cjs`'s `gsd-core-verbatim` rule is `kind: 'identity'` with
`sources: gsd-core/<path>`. **Editing a template's CONTENT self-attributes to the changed path and
requires no ack fragment.** Phase 4's two template acks were both for path **additions and
deletions** (one rename, two removals), which identity attribution cannot cover. This phase adds
and deletes no template path.

**State of that claim: an expectation, not a settled fact.** Plan 03 verifies it against a real
run. The attribution baseline is **169/170** — a pre-existing failure unrelated to this work, which
must not be "fixed" here; the check is that the result is no worse than 169 passing / 1 failing.

---

## What the three registries actually are

The ROADMAP frames this phase as collapsing three hand-maintained lists into one generated source.
Measurement says one of the three is not a list of templates at all, and generating it would cause
real damage.

### `src/artifacts.cts` — a different set, with a typed consumer. **Out of scope.**

`CANONICAL_EXACT` is **not a registry of templates**. It enumerates `.planning/` **root artifact
filenames** so that `isCanonicalPlanningFile` (`src/verify.cts`) can tell `gsd-health` which root
files are real planning state and which to flag as W019.

Measured — of its 13 members, which have a same-named template file:

```bash
node -e "
const fs=require('fs'),p=require('path');
const names=['PROJECT.md','ROADMAP.md','STATE.md','REQUIREMENTS.md','MILESTONES.md','BACKLOG.md',
  'LEARNINGS.md','LEARNINGS-DIGEST.md','CROSS-DOMAIN.md','THREADS.md','config.json',
  'CLAUDE.md','RETROSPECTIVE.md'];
function walk(d,a=[]){for(const e of fs.readdirSync(d,{withFileTypes:true})){
  const f=p.join(d,e.name); e.isDirectory()?walk(f,a):a.push(f);} return a;}
const have=new Set(walk('gsd-core/templates').map(f=>p.basename(f).toLowerCase()));
const has=names.filter(n=>have.has(n.toLowerCase()));
console.log('has:', has.length, '| none:', names.length-has.length);"   # → has: 6 | none: 7
```

| Has a template | Has no template |
|---|---|
| `PROJECT.md`, `ROADMAP.md`, `STATE.md`, `REQUIREMENTS.md`, `config.json`, `RETROSPECTIVE.md` | `MILESTONES.md`, `BACKLOG.md`, `LEARNINGS.md`, `LEARNINGS-DIGEST.md`, `CROSS-DOMAIN.md`, `THREADS.md`, `CLAUDE.md` |

> **Deviation from the plan (Rule 1).** Plan 04.1-01 lists the covered members as
> "PROJECT.md, ROADMAP.md, STATE.md, REQUIREMENTS.md, RETROSPECTIVE.md — 5" and puts `config.json`
> and `CLAUDE.md` among the uncovered. Measured, `config.json` **does** have a template
> (`gsd-core/templates/config.json`) and `CLAUDE.md` does **not** have a same-named one — its
> template is `host/claude-md.md`, a different filename. The corrected split is **6 / 7**. The
> conclusion is unchanged and in fact strengthened: a majority is still uncovered.

Generating `CANONICAL_EXACT` from template frontmatter would **delete 7 of its 13 entries**, and
with them the protection those names carry. `README.md`'s own text already documents that
`BACKLOG.md` and `THREADS.md` are reserved names **no workflow writes** — they exist in the set
precisely so that a hand-created file with either name is protected from cleanup. A generator
sourced from template files would see no template, emit no entry, and silently un-protect real
planning state.

**Conclusion: `artifacts.cts` is a different set with a typed consumer and is out of scope for
generation.** This is a **disclosed departure** from the ROADMAP's phrasing, to be carried into
the phase SUMMARY under criterion 5 the way Phase 4 disclosed its unmet criterion 4 — reported
plainly, not reframed as the criterion being met.

### `gsd-core/templates/README.md` — in scope, partially

Read by agents, documented as authoritative for W019. Plan 02's generator owns **one delimited
region** of it, between `<!-- gsd:template-registry -->` and `<!-- /gsd:template-registry -->`.
The four hand-written sections below that region list **artifacts**, which are a different set from
templates; how much of them a generated index can honestly replace is answered in Plan 03 against a
working generator, not guessed at now.

### `docs/ARCHITECTURE.md` §Templates, plus four translations — deferred

Human documentation in five languages (en, ja-JP, zh-CN, ko-KR, pt-BR). Phase 4 set the precedent:
update only the mechanical token, leave localized prose alone, on the grounds that an unreviewable
change in four languages is the larger risk. Generating localized prose is a worse risk than a
stale line. Disclosed under criterion 5, not silently skipped.
