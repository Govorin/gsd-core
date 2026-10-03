<design_before_planning>
**Before splitting this phase into plans, decide where the new code lives and what signatures cross between plans — and write both down.**

The split into plans *is* a boundary decision. When you assign `book.service.ts` to plan 02 and `book-repository.port.ts` to plan 01, you have already decided which layer owns which behaviour, which project each file lands in, and what has to pass between them. Nothing downstream records that you decided it. `PATTERNS.md` answers a neighbouring question — "what existing file should this one resemble" — with a role vocabulary of controller/service/model/middleware/utility. That vocabulary is three-layer MVC. It cannot express a repository where `ports` and `rules` are separate layers with separate import permissions, so in that repository it answers about form and stays silent about boundary.

Record the design in `{phase}-DESIGN.md` (template: `~/.claude/gsd-core/templates/DESIGN.md`). Four things earn their place; the rest are conditional.

**1. Where each new artifact lives, and why not the layer next door.**

The reason is the load-bearing part. "This is a service, so it goes in services" restates the placement. A reason names either the import that would become illegal or the consumer that would be forced into knowledge it must not have:

> `canCompleteTask` goes in `rules`, not `services`. The button needs it and `ui/**` may not import `services`. Putting it in `services` forces a copy in the component, and the copy is what drifts — the button ends up permitting what the server rejects.

Placements that are forced deserve one line each. Spend the words on the contested ones. If every row in the table reads "belongs in X", the section was filled in out of obligation and no one will read the next one.

**2. The signatures this phase introduces that another plan will call — with their full return types.**

This is the failure the section exists to close, and it is not hypothetical. Parallel plans are planned before the code they depend on exists. Wave 1 writes `findById(id): EitherAsync<RepoError, Book>`; wave 2's plan was authored when nothing existed to read, so it calls `findById(id): Promise<Book | null>`. Both plans pass their own verification — `files_modified` do not overlap, `key_links` match by regexp, each plan's tests run against its own project. Nothing in the pipeline typechecks across plans. The mismatch surfaces at the pre-commit gate, with both commits already in history.

An abbreviated signature does not prevent this. It is what causes it. The `<interfaces>` blocks in this repository's own completed phases show the shape:

```
ITaskRepository: findById, findByName, listActive, save, update, delete
```

Every executor that read this had to guess a return type, and the guesses agreed only by luck. The real declaration is `findByName(name: TaskName): Promise<Either<RepositoryError, TaskEntity | null>>` — three decisions (`Promise` vs `EitherAsync`, `Either` vs throw, `| null` vs a not-found error code) that the method name records none of. Write the declaration, not the roster:

```typescript
findByName(name: TaskName): Promise<Either<RepositoryError, TaskEntity | null>>;
```

Then carry the same text into each consuming plan's `<interfaces>` block, so the two plans are reading one string rather than two paraphrases of one intention.

**Put these declarations under a heading named exactly `## Contracts`.** That is not a formatting preference: `workflow.contract_drift` reads that section and only that section, then compares each declaration against the shipped code at verify:pre. Written under any other heading, the signatures are prose — the gate finds nothing to compare and reports no drift on a phase that drifted. Measured before this line was added: nine DESIGN.md files in one project, not one of them carrying the heading, so the gate had been silent by construction.

**3. What was rejected, stated as its advocate would state it.**

An option rejected without a record is re-proposed at every review, and the rebuttal is reconstructed from memory each time — slightly differently, until someone reconstructs it wrong and the option wins by attrition. This is the cheapest section in the document and the only one that stays true after the code changes.

Two rules make it worth writing. State the alternative strongly: a strawman makes a live question look settled, and the option returns anyway with nothing recorded to answer it. And give the condition that would flip it — "would revisit if the fake repository needs a second implementation" is a decision; "rejected, less clean" is a preference wearing a decision's clothes.

**4. Do not hand-draw what the repository can generate.**

Where a layer graph exists in machine-readable form, the allowed-dependency diagram is derived from it and carries the command that produced it, so the reader can re-run it. Typed by hand, that diagram is an unverified claim about the linter's configuration that no one re-checks, and it diverges the first time the graph changes — leaving a document that contradicts the tool while looking authoritative. Absent is better than wrong. Same for the port/implementation diagram: generate it where the ports already exist, author it only for ports this phase introduces.

**On the shelf life of section 2.** Once the phase executes, the code is the contract and the markdown is a copy. Set `contracts_superseded: true` and stop maintaining it. It remains useful as a record of what was intended at plan time — which is exactly what a reviewer wants when the shipped signature differs. Chasing refactors with edits to a markdown table produces a document that is neither a record nor a source of truth.

**When to skip all of this.** A phase that adds one function to an existing library, touches one project, and hands nothing to a parallel plan has one honest row of placement and no contracts. Write those and move on. The document earns its cost when plans run in parallel, when a port is introduced, or when the layer was genuinely arguable — and it loses its readers when it is filled in because the section existed.
</design_before_planning>
