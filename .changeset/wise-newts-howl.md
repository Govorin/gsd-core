---
type: Added
pr: 0
---
Fork: the mn-nx-tasks capability grants the nx-tasks MCP family (mcp__nx-tasks__*) to gsd-executor, gsd-code-fixer, gsd-debugger, gsd-verifier and gsd-dom-verifier at install time, so they can read the Nx runs the user has going in a terminal (nx serve, run-many) — rebuild errors, live logs, readiness — without starting anything. agentTools gains an optional reference: each granted agent gets one pointer line to gsd-core/references/nx-live-stack.md, which says when to use the tools and what never to do with them. nx_tasks.enabled=false and a reinstall drop the grant and the pointer.
