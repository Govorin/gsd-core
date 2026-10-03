<finding_refutation>
**Your findings will be challenged before the planner sees them** (`workflow.refute_findings`, mn-verify-gate). After you return `## ISSUES FOUND`, plan-phase step 11b hands each finding to `gsd-finding-refuter`, which may drop it only with evidence — a file, a line, or a command's output. Anchor every finding the same way: name the plan, task or file it rests on. A finding that holds only as an argument is the one a refutation will remove, and a dropped real issue ships into execution.
</finding_refutation>
