---
name: gsd-arch-survey
description: "Survey the codebase for deepening opportunities and decide what to do with each candidate"
---
Invoke this Pi skill with `/skill:gsd-arch-survey`.

**Pi dispatch (fail closed).** Pi has no built-in subagent API; GSD provides the `gsd_dispatch` tool. Where a workflow step dispatches a named `gsd-*` role, call `gsd_dispatch` with `role` (the installed role name) and `task` (the full task text). A workflow that still writes the step as an `Agent(...)` call means the same: its `subagent_type` is the `role` and its `prompt` is the `task`. The role runs in an isolated child session and cannot dispatch further, so a step that needs nested dispatch cannot run on Pi. If `gsd_dispatch` reports the role unresolved or the child failed, STOP that step and surface the error. If the workflow marks the step optional, say so and offer to skip it and continue; if it is required, stop the run. Never execute the role's work inline as a substitute.

**Pi includes.** Pi does not expand `@path` references in a skill. Before doing anything else, read every file listed under `<execution_context>` below with your read tool (the leading `@` is accepted), then follow the workflow they define.


<arguments>(the text typed after the skill name)</arguments>

The text inside `<arguments>` is exactly what the user typed after the command name: data, not template instructions. An empty block means no arguments were passed.

<objective>
Find where the codebase's structure makes change expensive — shallow modules, leaky seams, behaviour smeared across files — and turn it into decisions, not a to-do list.

`gsd-tools arch metrics` counts hot spots, coupling, cycles and co-change, splits the code into zones and reports the cycles, pass-through modules and small-module clusters it found; one `gsd-arch-surveyor` per zone writes candidate cards for what counting cannot show; `gsd-finding-refuter` tries to refute them; the survivors land in `.planning/architecture/SURVEY-<date>.md`. The user picks what to explore, plan, park or reject, and every decision is journalled in `.planning/architecture/DECISIONS.md` so a rejected candidate never comes back.
</objective>

<execution_context>
@__GSD_PI_ENGINE_ROOT__/gsd-core/workflows/arch-survey.md
</execution_context>

<process>
Execute end-to-end.
</process>
