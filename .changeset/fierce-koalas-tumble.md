---
type: Added
pr: 0
---
**Tool preflight: a plan whose executor lacks a tool it names halts instead of running under another agent** — `verify plan-structure` now carries `tool_preflight` (and a warning) when a plan's tasks name an `mcp__<server>__…` tool, a `.pen` design file (Pencil MCP) or WebFetch/WebSearch/NotebookEdit/AskUserQuestion that the installed executor's `tools:` does not grant; the plan checker reports it as a warning with the fix. `/gsd-execute-phase` halts at execute:pre on it (`check mn-tool-preflight`, `workflow.tool_preflight`, default on) and `/gsd-quick` checks its plan before the executor spawn (`verify tool-preflight`). The message names the missing grants and the fix — `gsd-tools config-set agent_tools.<agent> '[…]'` and a reinstall — read from the agent file the runtime loads (Claude: project `.claude/agents/` ahead of `~/.claude/agents/`); an unreadable or absent agent file is reported as unknown, never as a pass.
