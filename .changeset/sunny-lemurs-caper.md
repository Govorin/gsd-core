---
type: Fixed
pr: 0
---
**Write guards in `ask` mode no longer stall autonomous runs** — `workflow.prohibition_guard` and `workflow.test_tamper_guard` set to `ask` now answer `deny` while an auto-chain runs (`auto_chain_active` in `gsd_run check auto-mode`; the standing `workflow.auto_advance` alone does not count, since its owner may be at the terminal), with a reason telling the agent not to retry and to report the write as a blocker. Before, the write waited for an approval nobody was there to give: one project's background agents waited 3285 minutes on 61 such prompts. Manual sessions still get `ask`; `deny` and `off` are unchanged; the hook payload carries `unattended: true` when the answer was converted.
