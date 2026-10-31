_GSD_LEDGER="$(git rev-parse --git-dir)/gsd-plan-head-before-{phase}-{plan}"
[ -f "$_GSD_LEDGER" ] || git rev-parse HEAD > "$_GSD_LEDGER"
