<architecture_design_context>
**Phase:** {phase_number} - {phase_name}
**Phase directory:** {phase_dir}
**Padded phase:** {padded_phase}

<required_reading>
- {context_path} (USER DECISIONS from /gsd:discuss-phase)
- {research_path} (Technical Research, when present)
- `gsd-core/templates/DESIGN.md` (the output contract — read before writing)
</required_reading>

**Output file:** {phase_dir}/{padded_phase}-DESIGN.md

Fix the structural boundaries this phase introduces before the planner splits work
into plans: which layer owns each new artifact, which dependencies that placement
permits, and which signatures cross a plan boundary.

Write the FULL return type for every declared signature. The abbreviated form is what
lets one wave write `EitherAsync` while another calls it as a bare `Promise` — both
verify green in isolated worktrees, and the mismatch surfaces at integration.

If the phase introduces no cross-plan signature, say so and leave `## Contracts` empty.
An invented contract becomes a fiction the `contract-drift` gate then grades the code against.
</architecture_design_context>
