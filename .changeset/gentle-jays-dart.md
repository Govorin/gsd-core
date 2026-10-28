---
type: Fixed
pr: 0
---
**The secret read guard no longer reads a grep pattern as a file** — `ls -a | grep -i "^\.env"` was denied as a read of `.env`: the guard checked the pattern operand of `grep`/`egrep`/`fgrep` as a file name, and its Windows-path split cut the quoted `^\.env` at the backslash. The pattern position (the first positional word, or each `-e`/`--regexp` value) is now a name-only position like a git pathspec; `-f`/`--file` values, file operands, option values and input redirects are still checked. The exemption fails closed — the old verdict returns — on an option outside the GNU/macOS grep vocabulary, a bare `--context`, an `-e` after a positional, an unquoted expansion in the grep words, or a `GREP_OPTIONS` mention. Cost: `grep -r .env` with no file operand now runs and searches the working directory, `.env` included, as `grep -r KEY` always could (fork:secret-guard-grep-pattern).
