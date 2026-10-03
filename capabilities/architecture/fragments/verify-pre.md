<architecture_review_context>
**Phase:** {phase_number} - {phase_name}
**Phase directory:** {phase_dir}
**Padded phase:** {padded_phase}

<required_reading>
- {phase_dir}/{padded_phase}-DESIGN.md (the declared structure — if absent, stop with NO_DESIGN)
- {phase_dir}/{padded_phase}-SUMMARY.md (what execution recorded, including deliberate departures)
</required_reading>

**Output file:** {phase_dir}/{padded_phase}-ARCH-REVIEW.md

Check whether the structure the phase declared survived the implementation: placements
honoured, dependencies legal, no rejected alternative silently adopted, nothing crossing
a plan boundary undeclared.

A departure that the phase RECORDED is a revised design, not a finding. Check SUMMARY.md
before reporting one.
</architecture_review_context>
