---
type: Fixed
pr: 0
---
**An `--auto` / `--chain` run no longer dirties `.planning/config.json`** — the auto-chain flag was `workflow._auto_chain_active` in the versioned config, flipped by every chained workflow, so autonomous runs left the tree dirty. It is now run state in `.gsd/auto-chain/` (ignored locally, scoped per workstream), written through the new `gsd-tools auto-chain set|clear|status` verb; `check auto-mode` keeps its shape. A leftover `workflow._auto_chain_active` in config.json is no longer read and is deleted the next time a chained workflow starts; `config-set` refuses the key and names the verb.
