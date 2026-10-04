# Mermaid Authoring — the Checked Subset

Diagrams in documentation and in a phase's `DESIGN.md` are Mermaid, and every one is checked by
`gsd_run diagrams check --file <doc>`: (a) the block keeps to the subset below — exactly what GSD's
own diagram builders emit — and (b) every class, participant, call, state and entity it draws exists in
the code. A diagram is a claim about the code; valid syntax makes an invented name read as fact, so the
check is a declaration index of the project, not a judgement.

## Which diagram

| Shows | Type | Checked against the code |
|-------|------|--------------------------|
| Components / modules and what calls what | `flowchart` | syntax only (node ids are labels) |
| Key abstractions: classes, interfaces, ports | `classDiagram` | classes, methods/fields by owner, `<\|--`/`<\|..` as extends/implements |
| One request across three or more parties | `sequenceDiagram` | participants (by label), each call-shaped message as a member of its receiver |
| A lifecycle / screen route | `stateDiagram-v2` | states, against the enum named by `%% gsd:source` |
| Data (tables, schemas) | `erDiagram` | entities as table/schema, attributes as fields |

ASCII art only when the project's doc tooling cannot render Mermaid at all.

## The subset

Write one statement per line. Ids are ASCII identifiers (`A-Za-z0-9_`, not starting with a digit), never
a keyword (`end`, `class`, `state`, `loop`, …). Quote any label holding brackets, quotes, `|` or `;`.
`<br/>` is the only HTML allowed in a label; write a literal `;` as `#59;` and `#` as `#35;`.

- **flowchart** — `flowchart LR|TB|TD|RL|BT` (or `graph`); nodes `id`, `id[...]`, `id(...)`, `id([...])`,
  `id[[...]]`, `id[(...)]`, `id((...))`, `id{...}`, `id{{...}}`; links `-->` `---` `-.->` `-.-` `==>` `===`,
  labels `-->|text|` or `-- text -->`; chains `A --> B --> C`; `subgraph id["title"]` … `end` (one level,
  `direction` inside); `classDef name style`, `class a,b name`, `id:::name`; `linkStyle N style`.
- **stateDiagram-v2** — a state is `state "Label" as Id`, `Id : Label`, or just named by a transition
  (never a bare `state Id` — mermaid reads it on into the next `{`); then
  `A --> B : label`, `[*]`; one level of `state Id { … }` (a line naming a grouped state goes inside its
  group); `note left|right of Id : text`; `classDef` / `class`.
- **classDiagram** — `class Id`, `class Id["Label"]`, `class Id { <<interface>> +field +method(args) Ret }`,
  `Id : +member`, `<<annotation>> Id`; relations `--|>` `..|>` `--*` `--o` `-->` `..>` `--` and their
  reversed forms `<|--` `<|..` `*--` `o--` `<--` `<..`, set off by spaces, optional `"card"` and `: label`.
  A class named only by a relation or `Id : member` is declared there. Generics as `~T~`, never `<T>`.
- **erDiagram** — `ENTITY { type name PK|FK|UK "comment" }`; `A ||--o{ B : label` with `|o || }o }|` /
  `o| || o{ |{` and `--` or `..`.
- **sequenceDiagram** — `participant Id as Label`, `actor Id as Label` (declare before the first message);
  messages `->>` (call), `-->>` (reply), `-x`, `--x`, each with `: text`; `Note over A[,B]: text`,
  `Note left of A: text`; `alt` / `else` / `opt` / `loop` … `end`, nested at most 3 deep; `autonumber`.

Refused everywhere: `%%{init}%%` and front matter, `click`, `style`, `&` chaining, nested subgraphs or
composite states, choice/fork/join, `par`/`rect`/`critical`/`break`/`activate`/`box`, `+`/`-` activation,
namespaces and notes in class diagrams, entity aliases. A refused block is a warning in docs and a blocker
in a DESIGN.md (none of its names were checked): rewrite it in the subset rather than keep it.

## Identifiers

- **Name the real thing.** A class is its declared name; a participant's label is the class, interface or
  module it stands for (`participant S as ThingService`); a call is the receiver's method
  (`S->>R: findById(id)` checks `findById` on `R`'s class). Replies (`-->>`) and prose messages
  (`POST /things`) are not looked up.
- **Outside the repository** — a client, a payment provider — say so on its own line inside the block:
  `%% gsd:external C, P`. Those ids are not looked up.
- **States** are looked up only when the block names where they are defined:
  `%% gsd:source src/order/order-status.ts#OrderStatus` (an enum, a string-literal union, a const object,
  `z.enum([...])`, a Python `Enum`, a Prisma/SQL enum). Without it the diagram is unverifiable — a warning
  in docs, a blocker in a DESIGN.md. The path is relative to the project directory (the one holding
  `.planning/`) and may reach anywhere in its git repository — from a monorepo sub-project,
  `../../libs/order/src/order-status.ts#OrderStatus`. A path out of the repository (out of the project,
  outside git) names nothing.
- **DESIGN.md is written before the code.** A name the same document introduces — a `## Layer Placement`
  row, a declaration in a `## Contracts` code block, a row of a Contracts table — counts as planned. Once
  frontmatter says `contracts_superseded: true`, every name must exist in the code.
- **Derived blocks** — a block under a `<!-- gsd:derived … -->` or `<!-- DERIVED. … -->` comment in the same
  section — are re-generated and compared, not trusted: a `source=` the check can re-run (`zod-fieldtable`
  records its inputs) must match, and a derived state diagram with `%% gsd:source` must draw every member.
  A marker nothing can re-run is a blocker and the block's names are checked as written (a flowchart
  excepted). Paste derived output as emitted; never edit it.

Verdicts: `declared` / `planned` / `external` pass; `ambiguous` (declared as another kind or owner, only
mentioned, or found only in a language the recognizer does not parse) is a warning; `absent` (spelled
nowhere in the code) is a blocker.

## ER diagrams come from the schema

Never draw an ER diagram by hand. Generate it from the Zod schema and paste the output (field table and
`erDiagram`, under its derived marker) unchanged:

```bash
gsd_run mn zod-fieldtable --file <path/to/schema.ts> --export <SchemaName>
```

If the command cannot load the schema (no `bun`, path aliases without `bun`), omit the ER diagram and write
one line saying why. A hand-drawn substitute is exactly the invented diagram this rule exists to prevent.

## Self-check

After writing a document with diagrams, run the check from the project root — the Bash call begins with
the resolver block from `gsd-run-resolver.md`:

```bash
gsd_run diagrams check --file <doc.md>
```

Read `findings` in the JSON: fix every `BLOCKER` (an `absent` name — rename it to what the code declares,
mark it `%% gsd:external`, or remove it); rewrite every block reported `diagram_syntax`. Re-run until
`blocker_count` is 0.
