#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Secret Read Guard — PreToolUse hook (Read | Grep | Bash)
//
// Blocks reads of secret files — `.env`, `.env.<suffix>`, `.secrets` — by any
// of the three tools that can put file contents into the conversation: the
// Read tool (file_path), the Grep tool (an explicit path or a glob that
// selects the secret namespace), and Bash (a command whose operands or input
// redirects name a secret file, including inside `$( )`, backticks, `<( )`,
// `bash -c '…'` / `eval "…"` bodies, and `git show <ref>:<path>` shapes).
//
// Why a hook and not permission rules (#4221): since #768 the installer wrote
// three `Read(.env)` / `Read(.env.*)` / `Read(.secrets)` deny rules into
// settings.json. Claude Code 2.1.259 hardened the Bash-side enforcement of
// Read() deny rules so that ANY `cd DIR && cat/grep relative-path` compound
// prompts for approval whenever any Read() deny rule exists — even in `auto`
// permission mode. GSD subagents emit hundreds of those per session. A
// PreToolUse denial is not a permission rule, so it never arms that check,
// and it applies in `auto` and `bypassPermissions` modes alike. The three
// installer-written strings are retired by the same installer change (they
// are filtered out as legacy entries on install and uninstall).
//
// What counts as a secret name (basename match, no path resolution, matched
// case-INSENSITIVELY so `.ENV` / `.Secrets` are caught on the macOS/Windows
// filesystems where they ARE the secret file — the write guard's `/i` stance):
//   .env, .secrets, and .env.<suffix> — EXCEPT .env.example / .env.sample /
//   .env.template / .env.dist, which are the non-secret templates GSD's own
//   phase prompt tells executors to read.
//   Stated cost (#4580): the exemption matches the token's FINAL EXTENSION,
//   not the whole name, so the trusted set is `.env.<anything>.example` /
//   `.sample` / `.template` / `.dist` — an unbounded family, not four fixed
//   names. A real secret named `.env.prod-real-secrets.example` is NOT
//   protected, and renaming any secret to end in one of those four
//   extensions bypasses the guard across Read, Grep and Bash alike. This is
//   the deliberate cost of #4580, which fixed the prior whole-name
//   comparison wrongly refusing committed, secret-free templates like
//   `.env.local.example`.
//   A token containing `:` is also tested on the part after its LAST `:`,
//   so `git show HEAD:.env`, `origin/main:config/.env` and `C:\proj\.env`
//   are caught without git-specific parsing. Leading/interior whitespace is
//   still NOT trimmed: the commit message `fix: .env parsing` yields
//   ` .env parsing`, which is prose, not a name. TRAILING dots and spaces ARE
//   stripped from the basename before classification (`.env.`, `.env..`,
//   `.env `, `.env. ` all normalize to `.env`), because Win32 strips trailing
//   dots and spaces from each path component, so these are aliases for the
//   same on-disk file, not distinct names.
//
// Bash analysis is a two-pass token scan, not a shell:
//   pass 1 tokenizes with quote state, comments, redirect operators (with fd
//   digits and `>&N` dups), separators (recording the operator text), `$( )` /
//   backtick / `<( )` / `>( )` spans (recursed as nested commands, depth ≤ 3),
//   and heredocs (one token per body, carrying its `<<` segment). A heredoc
//   body is only ever run as a script when its segment's command is a shell
//   interpreter (below); a DATA heredoc — `cat <<EOF … EOF`, the agent-
//   populated bodies in GSD's own workflows, `git commit -m "$(cat <<'EOF' …
//   EOF)"` — is never operand-checked, so prose mentioning `.env` is safe.
//   pass 2 groups tokens by segment and evaluates each on its own:
//   input redirect targets (`<`, `N<`) are always checked; the command word is
//   located past wrapper prefixes AND their own options (`sudo -u U`,
//   `env -i VAR=x`, `timeout -s KILL 5`, `nice -n 5`, `stdbuf -oL`, `exec`;
//   see WRAPPERS, #5627); a closed set of
//   NON-READING commands (test/[/ls/stat/rm/touch/echo/…) exempts that
//   segment's operands — `[ -f .env ]` and `ls .env*` are existence checks
//   GSD's own agents run; `file` only with its classify options, since
//   `file -f .env` / `file -m .env x` print the file's lines (see
//   FILE_CLASSIFY_FLAGS) — while `cp`/`mv`/`ln`/`git` are deliberately NOT
//   exempt (`cp .env x && cat x` launders the name; `git show HEAD:.env`
//   reads). Narrower carve-outs exempt single operand POSITIONS that are
//   names, never contents, and keep checking the rest of the segment: the
//   `--env-file` value under a container runtime (#4639), the pathspecs of
//   `git check-ignore` / `git ls-files` / `git rm --cached`, and the
//   destination of a one-source `cp`/`mv` (#4856). These carve-outs fail
//   closed: an option they do not list withdraws them from the segment, and
//   so does a substitution or unquoted glob/brace in ANY word of the segment,
//   wrapper words and the command word included (`timeout {1,cat} cp x .env`
//   runs `cat`), which also withdraws the non-reading exemption when it sits
//   in a wrapper word or the command word (`timeout {1,cat} ls .env`,
//   `X='cat /bin'; $X/ls .env`). Leading `VAR=value` assignments never count:
//   bash neither splits nor globs their value (`ROOT="$PWD" ls .env`).
//   One position is checked more loosely instead of skipped: the PATTERN of
//   `grep`/`egrep`/`fgrep` — the first positional word, or each `-e` value
//   (fork:secret-guard-grep-pattern) — is judged on its POSIX `/` segments
//   only, without the Windows `\` split, because grep matches it and never
//   opens it: `ls -a | grep -i "^\.env"` and `grep -n "\.env" f` pass, while
//   a bare `.env` there is still denied (`grep -e .env README.md` is a
//   stated false positive, kept so that a misparse — the pattern taken to be
//   a file — can only ever let a `\`-bearing word through). An `-f` value
//   and every other operand get the full check. The looser check is
//   withdrawn on an option outside its tables, a bare `--context` (optional
//   value on macOS, required on GNU), a value option with no value, an `-e`
//   after a positional (POSIXLY_CORRECT reads it as a file), and a
//   substitution anywhere in the segment, so the Windows reading
//   (`grep x config\.env` shifted onto the pattern slot) returns. No
//   GREP_OPTIONS check is needed: an `-e`/`-f` that variable injects turns
//   the pattern word into a file, and a secret name in that word is denied
//   by the POSIX reading too.
//   Words bash expands itself are unrolled before any of the above
//   (scanExpansionWords): each brace alternative (`cat .e{n,}v`,
//   `{cat,.env}`, `timeout {1,cat,.env}`, the sequence `.e{m..o}v`; past 64
//   alternatives `glob-too-complex`), each glued `(…)` group in its zsh
//   alternation, zsh glob-qualifier (BARE_GLOB_QUAL is on by default:
//   `cat .env(N)` reads `.env`) and bash extglob readings (`cat .e(nv|x)`,
//   `cat @(.env)`), and each glob, judged by the Grep arm's
//   globAltSelectsSecret (`cat .en[v]`, `cat < .e*`, `cat .*rc`) — but only
//   when its last segment starts with a literal `.`: with bash and zsh
//   defaults `*`, `?` and `[…]` never match a leading dot, so `cat *.*` and
//   `cat *` cannot reach `.env` (dotglob / GLOB_DOTS is a documented gap; a
//   `(D)` qualifier is unrolled to a leading-dot glob). Only the operands of
//   a non-reading command with a clean command
//   part are spared (`ls .env*`). A `VAR=value` word counts as an assignment
//   only as the tokenizer reads it — unquoted, unescaped name and `=` — so
//   `"X"=/bin/cat .env` is a command word, as it is to bash and zsh.
//   A git global option the walker does not know also keeps the #5045 `-c`
//   scan running over every later word (see walkGitGlobals).
//   A shell interpreter (bash/sh/zsh/dash/ksh/su) has its script scanned
//   whether it arrives via `-c '…'`, a `<( )` file operand, a heredoc /
//   here-string, or a pipe from a knowable `echo`/`printf` source
//   (`echo cat .env | bash`); `eval` scans its joined operands; `source`/`.`
//   scans a `<( )` operand; and `find … | xargs cat` infers the upstream
//   segment's names as the sub-command's read operands.
//
// Grep globs are judged per brace alternative (never on the whole glob, so
// `{.env.local,zzz.ts}` cannot hide behind a benign sibling): a pure-wildcard
// alternative (`*`, `**`) is allowed — Grep already skips gitignored files,
// so it is equivalent to no glob; any other alternative is denied when its
// literal prefix is a prefix of `.env.`/`.secrets` (`.e*`, `.env*`, `.s*`) or
// when it matches a probe secret name (`*.local`, `*.*`, `*.env*`). More than
// 64 alternatives is denied as `glob-too-complex` (cheap to retry narrower).
//
// Documented gaps (none are statically resolvable by a hook, and Claude
// Code's own 2.1.259 Bash-side enforcement does not resolve them either):
//   `$VAR` indirection (`bash -c "$TEST_CMD"`, `cat "$F"`, an `IFS` that
//   splits a bare `$X` into a command), the shell expansions the scan does not
//   unroll (a glob that reaches dotfiles because bash `dotglob` or zsh
//   `GLOB_DOTS` is set beforehand — `cat *`, `cat *.*`; ANSI-C escapes
//   `$'\x2eenv'`; zsh `^`/`~`/`#` extended-glob operators),
//   interpreter one-liners (`python -c "open('.env')"`), a piped
//   script from a non-echo source (`cat gen.sh | bash`, `curl … | sh`), reads
//   inside scripts the agent executes, and `glob: '*'` reaching a
//   NON-gitignored `.env`, and a wrapper (or wrapper option taking a
//   separate value) the WRAPPERS table does not list, or `env -S 'script'` (the split string is skipped as
//   the option's value). The promise is "no looser than the retired rules
//   on plain commands, without arming the compound-`cd` prompt". Writes to
//   secret files are out of scope (Write/Edit were never gated). Commands
//   over 1 MiB are denied outright (`command-too-large`) rather than
//   scanned partially or waved through. (#4639 adds one more, by design: the
//   value of `--env-file` under a container runtime is exempt, so the
//   container's own command can print the interpolated environment
//   (`alpine printenv`, `docker compose config`) — the same exposure class
//   as the pre-existing volume-mount gap (`-v .env:/s`); the flag's value
//   itself is a name, never contents. #4856 adds another: the `cp`/`mv`
//   destination exemption can move a link prepared under a non-secret name
//   onto a secret name (`ln -s .env.example l && mv l .env`), so a later
//   edit of `.env` lands in the link target — a write redirection, the
//   out-of-scope write class, not a read.)
//   Two more gaps hold for every command, not only the carve-outs: a command
//   word shadowed by a shell function, an alias or a local file
//   (`grep(){ cat "$@"; }; grep x`, `alias ls=cat`, `./ls .env`) is judged
//   by its name, not by what runs; and an environment variable set before the
//   command — by the user's shell startup files (`~/.zshenv`) or an earlier
//   session — is invisible, e.g. a GREP_OPTIONS that macOS grep still
//   honours. fork:secret-guard-grep-pattern's own cost: with an `-e` or
//   `-f` injected that way, a pattern word holding a `\`-split secret path
//   (`grep "config\.env"`) is read as a file on Windows and not denied.
//   Also open, and the reason a lexical guard is not the boundary: dotfile
//   globbing switched on inside the same command (`shopt -s dotglob`,
//   `GLOBIGNORE=…`, `setopt globdots`) is not tracked, so `*env` stays
//   allowed after it; a zsh group that starts an argument word
//   (`cat (.env|x)`) is still split as a subshell opener. An OS-level read
//   deny (the runtime's sandbox) is the place for a hard guarantee.
//
// A second, unrelated contract is enforced on the Bash leg because this is the
// one hook that already parses EVERY Bash command (#5214): a Bash command that
// launches the debugger as a CLI process — `claude … --agent gsd-debugger` — is
// denied (`debugger-cli-spawn`). The debug session manager is required to spawn
// gsd-debugger with `Agent(run_in_background=false)` so it can read the
// debugger's structured return; on a captured 1.15.0 run it routed around that
// literal and shelled out with the Bash parameter `run_in_background: true`,
// so no return ever came back and the checkpoint never advanced. Prose in the
// agent file cannot stop an improvised tool call; a PreToolUse denial can, and
// Claude Code runs plugin hooks for a subagent's tool calls too. A person
// running `claude --agent gsd-debugger` in their own terminal never reaches
// this hook. Only the debugger is named: it is the agent whose blocking return
// the managed debug loop depends on.
//
// Triggers on: Read, Grep, Bash tool calls (Kimi: ReadFile, Grep, Shell)
// Action: BLOCK (decision: 'block', exit 2) — codes secret-read |
//         glob-too-complex | command-too-large | debugger-cli-spawn
// No-op: other tools, non-secret targets, hook errors (fail open — a parser
//        bug in a hook that runs on EVERY Bash call must never brick a
//        session; the crash policy is declared once below).

'use strict';

const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');
const { finalExtension, normalizeWindowsBasename, lastSegment } = require('./lib/filename-classification.js');

// Fail open on a hook-internal error (see header). Declared ONCE so the
// outer catch states its policy explicitly (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

// Commands longer than this are denied rather than scanned (see header).
const MAX_COMMAND_LENGTH = 1024 * 1024;

// Recursion budget for `$( )` / backtick / `<( )` / nested-shell rescans.
const MAX_NESTING_DEPTH = 3;

// Brace-alternative budget for a Grep glob before it is denied as too complex.
const MAX_GLOB_ALTERNATIVES = 64;

// `.env.<suffix>` names that are templates, not secrets (case-insensitive).
const NON_SECRET_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist']);

// Command-prefix wrappers to look through when locating the command word at
// the head of a segment (#5627). Each wrapper runs the words that follow its
// own options, so the table records what resolveCommand must step over:
//   short    letters of short options that take a value (`-n 5`, `-n5`)
//   long     long options that take a SEPARATE value word (`--adjustment 5`);
//            `--opt=value` is one word and needs no entry
//   assigns  leading `VAR=value` words belong to the wrapper (env)
//   operands positional words after the options (timeout's DURATION)
// Taken from sudo(8), doas(1), env(1), nice(1), time(1), timeout(1),
// stdbuf(1), setsid(1) and bash's `command`/`exec`. A wrong entry fails open
// (the option's value becomes the command word), so keep it to the man pages.
const WRAPPERS = new Map([
  ['sudo', { short: 'CDghpRrTtUu', long: ['--close-from', '--chdir', '--group', '--host', '--prompt', '--chroot', '--role', '--command-timeout', '--type', '--other-user', '--user'] }],
  ['doas', { short: 'Cu' }],
  ['env', { short: 'uCSaP', long: ['--unset', '--chdir', '--split-string', '--argv0'], assigns: true }],
  ['nice', { short: 'n', long: ['--adjustment'] }],
  ['nohup', {}],
  ['command', {}],
  ['time', { short: 'fo', long: ['--format', '--output'] }],
  ['timeout', { short: 'sk', long: ['--signal', '--kill-after'], operands: 1 }],
  ['stdbuf', { short: 'ioe', long: ['--input', '--output', '--error'] }],
  ['setsid', {}],
  ['exec', { short: 'a' }],
]);

// Commands whose ordinary operands are file NAMES, never file CONTENTS. A
// closed set on purpose: anything not listed is assumed to read. `file` is
// non-reading only with the options in FILE_CLASSIFY_FLAGS (see
// isNonReading): its `-f`/`--files-from` reads a list of names and
// `-m`/`-M`/`--magic-file` a magic file, and both echo the lines they reject.
const NON_READING_COMMANDS = new Set([
  'test', '[', '[[', 'ls', 'stat', 'touch', 'rm', 'chmod', 'chown', 'mkdir',
  'basename', 'dirname', 'realpath', 'file', 'echo', 'printf',
]);

// fork:secret-guard-grep-pattern (review): the `file` options that only
// change how a file is classified (macOS file-5.41 `man file`, GNU file 5.x).
// Each was run on macOS file-5.41 against a marker file and printed none of
// its contents. Any other option — `-f`/`--files-from`, `-m`/`-M`/
// `--magic-file`, `-F`/`--separator`, `-e`, `-P`, `-C`, the debug options
// `-D` (macOS: prints each magic test with the bytes it read, so the file's
// lines) and `-d` (GNU: the same debug output), an `--opt=value` — keeps the
// segment checked, as does a substitution in any of its words
// (`X=-f; file "$X" .env`).
const FILE_CLASSIFY_FLAGS = new Set([
  '-b', '--brief', '-c', '--checking-printout', '-E', '-h', '--no-dereference', '-i', '-I',
  '--mime', '--mime-type', '--mime-encoding', '-k', '--keep-going', '-l', '--list', '-L', '--dereference',
  '-n', '--no-buffer', '-N', '--no-pad', '-0', '--print0', '-p', '--preserve-date', '-r', '--raw',
  '-s', '--special-files', '-S', '--no-sandbox', '-v', '--version', '-z', '--uncompress', '-Z',
  '--uncompress-noreport', '--exclude-quiet', '--extension', '--help',
]);

// #4639: container runtimes take `--env-file <file>` — the runtime opens the
// file itself, interpolates it into the container environment, and returns
// nothing to the agent, so the flag's VALUE is a name, never contents. The
// same category NON_READING_COMMANDS encodes, expressed as a flag value. Only
// the flag's value under these runtimes is exempt; every other operand in the
// segment is still checked, so the carve-out cannot launder a read.
const CONTAINER_RUNTIMES = new Set(['docker', 'docker-compose', 'podman', 'nerdctl']);
const ENV_FILE_FLAG_RE = /^--env-file(=|$)/;

// #4856: git subcommands that report or drop a path's ignore / tracking
// status and never print the file, so their pathspec operands are names —
// the category NON_READING_COMMANDS encodes. Each carries the closed set of
// its NO-VALUE options (from `git <subcommand> -h`, git 2.49). Any other
// option withdraws the exemption from the whole segment, so an option value
// is never mistaken for a pathspec: `-X <file>` reads the file, and
// `--pathspec-from-file=<file>` echoes its lines in the "did not match"
// error. `requires` names the option without which the subcommand stays
// checked (#4856 scopes `git rm` to `--cached`).
const GIT_PATHSPEC_SUBCOMMANDS = new Map([
  ['check-ignore', {
    flags: new Set(['-q', '--quiet', '-v', '--verbose', '--stdin', '-z', '-n', '--non-matching', '--no-index', '--index']),
  }],
  ['ls-files', {
    flags: new Set([
      '-z', '-t', '-v', '-f', '-c', '--cached', '-d', '--deleted', '-m', '--modified', '-o', '--others',
      '-i', '--ignored', '-s', '--stage', '-k', '--killed', '-u', '--unmerged', '--directory', '--eol',
      '--no-empty-directory', '--resolve-undo', '--exclude-standard', '--full-name',
      '--recurse-submodules', '--error-unmatch', '--abbrev', '--debug', '--deduplicate', '--sparse',
    ]),
  }],
  ['rm', {
    flags: new Set(['--cached', '-f', '--force', '-n', '--dry-run', '-q', '--quiet', '-r', '--ignore-unmatch', '--sparse']),
    requires: '--cached',
  }],
]);

// git's global options (git.c handle_options, git 2.49) — the ONE vocabulary
// both the #4856 pathspec exemption and the #5045 -c scan walk, via
// walkGitGlobals. A value option consumes the next word; the long options in
// GIT_GLOBAL_EQUALS_FORM_OPTIONS also take it attached as `--opt=value`.
// `-C`, `-c` and the hidden `--shallow-file` accept only the separate word
// (git rejects `--shallow-file=x` and `-c<name>=<value>`), and
// `--exec-path` runs a subcommand only as `--exec-path=<path>` (bare, it
// prints the path and exits). Any other option fails closed for both
// consumers: its arity is unknown, so its value could be read as the
// subcommand (`git -C ls-files show HEAD:.env` runs `show`). The pathspec
// exemption is withdrawn, and the -c scan keeps collecting every later
// `-c <value>` pair instead of stopping.
const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source',
  '--shallow-file',
]);
const GIT_GLOBAL_EQUALS_FORM_OPTIONS = new Set([
  '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--exec-path',
]);
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '--paginate', '-P', '--no-pager', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
]);

// #4856: `cp`/`mv` write their destination and never print it, so a secret
// name that is ONLY the destination of a one-source copy or move is a name
// (`cp .env.example .env`). The exemption holds for exactly two operands
// behind options from this closed set; anything else keeps the whole segment
// checked — `-t`/`--target-directory` (every operand becomes a source), a
// backup (`-b`, `--backup`, `-S`: the old secret survives as `.env~`, a name
// the predicate does not classify), a link (`-l`, `-s`) or `--exchange`
// (the destination shares or swaps the secret). Options must precede the
// operands: a trailing one is an option under GNU getopt's permutation but
// an operand under POSIXLY_CORRECT (`cp a .env -f` then copies `.env` INTO
// `-f/`), so which word is the destination would hang on an environment
// the hook cannot see.
const COPY_NAME_ONLY_FLAGS = new Set(['-f', '--force', '-i', '--interactive', '-n', '--no-clobber', '-v', '--verbose']);

// fork:secret-guard-grep-pattern: grep matches its PATTERN against what it
// reads and never opens it, so the pattern word gets the POSIX-only name
// check (`ls -a | grep -i "^\.env"`; see grepPatternIndices). The vocabulary
// below is GNU grep 3.x and the FreeBSD grep 2.6.0 that ships as macOS
// /usr/bin/grep, checked against both. An option outside it returns the
// segment to the full check, so an unknown option can never be what decides
// which word is the pattern.
const GREP_COMMANDS = new Set(['grep', 'egrep', 'fgrep']);
// Short options whose value is the rest of the cluster (`-m5`) or the next word.
const GREP_SHORT_VALUE_OPTIONS = new Set([...'ABCDdefm']);
// Short options without a value; digits (`-2`, `-10`: context) are accepted too.
const GREP_SHORT_FLAGS = new Set([...'EFGPabchHiIlLnoqrRsTUuvVwxyzZJOpS']);
// Long options whose bare form takes the next word as the value. `--context`
// is not here: its value is optional on macOS (`--context 5 f` greps for `5`)
// and required on GNU, so the bare form returns the segment to the full check.
const GREP_LONG_VALUE_OPTIONS = new Set([
  '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--devices',
  '--directories', '--binary-files', '--label', '--include', '--exclude', '--exclude-dir',
  '--exclude-from', '--group-separator',
]);
// Long options accepted only in the one-word `--opt=value` form, besides the above.
const GREP_LONG_EQUALS_OPTIONS = new Set(['--context', '--color', '--colour']);
const GREP_LONG_FLAGS = new Set([
  '--ignore-case', '--no-ignore-case', '--invert-match', '--word-regexp', '--line-regexp', '--count',
  '--color', '--colour', '--files-with-matches', '--files-without-match', '--only-matching', '--quiet',
  '--silent', '--no-messages', '--byte-offset', '--with-filename', '--no-filename', '--line-number',
  '--initial-tab', '--unix-byte-offsets', '--null', '--null-data', '--text', '--recursive',
  '--dereference-recursive', '--extended-regexp', '--fixed-strings', '--basic-regexp', '--perl-regexp',
  '--line-buffered',
]);

// Shell interpreters that run a script from `-c`, a file operand, or stdin
// (heredoc / here-string / piped `echo`|`printf`). `su` is here for its `-c`
// form (`su [user] -c 'cmd'`); a bare `su user` resolves to file mode, which
// only runs the ordinary operand check. `eval`, `source`/`.` and `xargs` are
// their own cases below; they are not in this set.
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su']);

// Shell flags whose VALUE is the next operand (`bash -o pipefail`,
// `bash --rcfile x <<EOF`): skipped when locating a script-file operand, so a
// flag value is not mistaken for the script and stdin mode still applies.
const SHELL_VALUE_FLAGS = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']);

// Value-taking `xargs` flags (long `--flag=value` forms are single words).
// `-a`/`--arg-file` additionally replaces stdin, so it suppresses the pipeline
// inference below.
const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-i', '-L', '-l', '-P', '-s', '-d', '-E', '-a']);

// Probe names a Grep glob alternative is matched against. `.env` and
// `.secrets` are the exact names; the rest stand in for the open-ended
// `.env.<suffix>` family so empty-literal-prefix selectors (`*.local`,
// `*.production`, `*env.*`) are caught. Residual, stated in the header:
// an alternative like `*.ts` matches no probe and is allowed even though a
// `.env.foo.ts` would satisfy the name predicate.
const GLOB_PROBES = [
  '.env', '.secrets', '.env.local', '.env.development', '.env.production',
  '.env.staging', '.env.test', '.env.development.local', '.env.production.local',
  '.env.zzq',
];

// ---------------------------------------------------------------------------
// Secret-name predicate
// ---------------------------------------------------------------------------

function isSecretBasename(name) {
  // Win32 strips trailing dots/spaces per path component, so `.env.`,
  // `.env ` etc. resolve to the real `.env` on Windows — normalize FIRST so
  // those aliases can't bypass classification.
  const n = normalizeWindowsBasename(name);
  if (n === '.env' || n === '.secrets') return true;
  if (n.startsWith('.env.')) {
    const suffix = n.slice('.env.'.length);
    return suffix !== '' && !NON_SECRET_ENV_SUFFIXES.has(finalExtension(suffix).toLowerCase());
  }
  return false;
}

// True when the token's basename — or the basename of the part after its
// last `:` (git `<ref>:<path>`, Windows drive) — is a secret name. Folded to
// lower case once at the top so `.ENV` / `.Secrets` match on the
// case-insensitive filesystems (macOS, Windows) where they ARE the secret file
// — the same stance as the write guard's `/i` patterns.
function namesSecret(tok) {
  if (typeof tok !== 'string' || tok === '') return false;
  const lower = tok.toLowerCase();
  if (isSecretBasename(lastSegment(lower))) return true;
  const colon = lower.lastIndexOf(':');
  return colon !== -1 && isSecretBasename(lastSegment(lower.slice(colon + 1)));
}

// Last `/`-separated segment: the POSIX reading, where `\` is an ordinary
// character of the name.
function posixLastSegment(tok) {
  const s = tok.replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}

// namesSecret without the Windows `\` split (fork:secret-guard-grep-pattern),
// for a grep pattern position: `^\.env` and `\.env` are regexes, and on POSIX
// not the names of a secret file, while a bare `.env` still is.
function namesSecretPosix(tok) {
  if (typeof tok !== 'string' || tok === '') return false;
  const lower = tok.toLowerCase();
  if (isSecretBasename(posixLastSegment(lower))) return true;
  const colon = lower.lastIndexOf(':');
  return colon !== -1 && isSecretBasename(posixLastSegment(lower.slice(colon + 1)));
}

// ---------------------------------------------------------------------------
// Grep glob analysis
// ---------------------------------------------------------------------------

// Expand `{a,b,…}` (nested allowed) into the list of alternatives, or null
// when the list would exceed MAX_GLOB_ALTERNATIVES. Malformed braces are
// treated literally.
// The members of a bash/zsh sequence expression's body (`m..o`, `a..k..2`,
// `1..100`), or null when the body is not one.
function braceSequence(inner) {
  if (/^[+-]?\d+\.\.[+-]?\d+(\.\.[+-]?\d+)?$/.test(inner)) return ['0'];
  const m = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.([+-]?\d+))?$/.exec(inner);
  if (!m) return null;
  const from = m[1].charCodeAt(0);
  const to = m[2].charCodeAt(0);
  const step = Math.max(1, Math.abs(Number(m[3] || 1)));
  const dir = from <= to ? 1 : -1;
  const out = [];
  for (let c = from; dir > 0 ? c <= to : c >= to; c += dir * step) out.push(String.fromCharCode(c));
  return out;
}

// `sequences` (the Bash arm only — a Grep glob has no sequence syntax) also
// unrolls bash/zsh sequence expressions: a letter range `{a..e[..step]}` per
// character, and a numeric range `{1..100}` as the single representative
// `0`, since digits never decide whether a name is a secret and a loop like
// `{1..100}` must not exhaust the alternative budget.
function expandBraces(glob, sequences = false) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [glob];
  const pre = glob.slice(0, open);
  const post = glob.slice(close + 1);
  const inner = glob.slice(open + 1, close);
  const parts = [];
  let start = 0;
  for (const c of commas) {
    parts.push(inner.slice(start, c - open - 1));
    start = c - open;
  }
  parts.push(inner.slice(start));
  if (sequences && commas.length === 0) {
    const seq = braceSequence(inner);
    if (seq !== null) parts.splice(0, parts.length, ...seq);
  }
  if (parts.length > MAX_GLOB_ALTERNATIVES) return null;
  const out = [];
  for (const part of parts) {
    const expanded = expandBraces(pre + part + post, sequences);
    if (expanded === null) return null;
    for (const alt of expanded) {
      out.push(alt);
      if (out.length > MAX_GLOB_ALTERNATIVES) return null;
    }
  }
  return out;
}

// Anchored regex for one brace-free glob alternative (`*` → `[^/]*`,
// `?` → `[^/]`, `[…]` classes passed through with `[!` → `[^`).
function globAltToRegex(alt) {
  let out = '^';
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const j = alt.indexOf(']', i + 1);
      if (j === -1) out += '\\[';
      else {
        const body = alt.slice(i + 1, j);
        out += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body).replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

// Does this single alternative select any secret name? (See header.)
function globAltSelectsSecret(alt) {
  if (alt === '') return false;
  if (/^[*?]+$/.test(alt)) return false; // pure wildcard: equivalent to no glob
  const wild = alt.search(/[*?[]/);
  const lit = wild === -1 ? alt : alt.slice(0, wild);
  // #4580: when there is no wildcard, `alt` (== `lit`) is a WHOLE literal
  // filename, so classify it exactly the same way Read/Bash do (by its
  // FINAL extension, via isSecretBasename) rather than by a `.env.`-prefix
  // heuristic — that heuristic mis-blocked multi-dot templates like
  // `.env.local.example`. When a wildcard IS present, `lit` is only a
  // PARTIAL literal prefix (`.env.local.exam*` can still select
  // `.env.local`), which cannot be classified exactly, so the original
  // conservative prefix rule stays.
  if (wild === -1) {
    if (isSecretBasename(lit)) return true;
  } else if (lit.startsWith('.env.')) {
    return true;
  }
  if (lit !== '' && ('.env.'.startsWith(lit) || '.secrets'.startsWith(lit))) return true;
  let re;
  try {
    re = globAltToRegex(alt);
  } catch {
    return true; // an unparsable class — Grep would reject it too; deny is the safe side
  }
  return GLOB_PROBES.some((probe) => re.test(probe));
}

// Returns null (allowed), 'secret-read', or 'glob-too-complex'.
function classifyGrepGlob(glob) {
  // Segment via the SAME `lastSegment` helper Read/Bash use (namesSecret),
  // rather than a hand-rolled forward-slash-only split — the two used to
  // diverge on a backslash-bearing glob (`config\.env`), which `lastSegment`
  // reduces to `.env` but a `/`-only split left untouched, letting it escape
  // this arm's predicate while Read/Bash still blocked it.
  // Case-fold the last segment (GLOB_PROBES are lower case) so `.ENV*` and
  // `*.ENV` select the secret namespace on case-insensitive filesystems.
  const segment = lastSegment(glob).toLowerCase();
  const alts = expandBraces(segment);
  if (alts === null) return 'glob-too-complex';
  return alts.some(globAltSelectsSecret) ? 'secret-read' : null;
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 1: tokenizer
// ---------------------------------------------------------------------------

// Which reading of a heredoc the scan is making (#5513). The guard scans a command that
// opens a heredoc under every reading below and denies if any of them finds a secret read
// (see findSecretReadUnderOtherReadings), so a change of reading can add a denial but
// never remove one.
//  - heredocBodiesSkippedInSpans: bash 5 skips the bodies of heredocs opened inside a
//    `$( )` span when it looks for the closing `)`; bash 3.2.57 (still `/bin/bash` on
//    macOS) does not, so a `)` on a body line closes the substitution and the rest of
//    that line runs as the OUTER command.
//  - heredocTagsAsWords: an unquoted tag is a bash word (a CR and a substitution belong
//    to it). false is the earlier reading, where the tag stopped at any whitespace and at
//    `(`: kept as a reading so nothing the guard denied before is allowed now.
let heredocBodiesSkippedInSpans = true;
let heredocTagsAsWords = true;

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated. Quote- and heredoc-aware so a `)` inside a
// quoted string or a heredoc body never closes the span early.
function findParenClose(str, i) {
  let depth = 1;
  let heredocTags = [];
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') { i += 2; continue; }
        if (str[i] === '$' && str[i + 1] === '(') { i = findParenClose(str, i + 2) + 1; continue; }
        if (str[i] === '`') {
          const j = str.indexOf('`', i + 1);
          i = j === -1 ? str.length : j + 1;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const j = str.indexOf('`', i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (heredocBodiesSkippedInSpans && ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      const tag = readHeredocTag(str, i + 2);
      heredocTags.push(tag);
      i = tag.end;
      continue;
    }
    if (ch === '\n' && heredocTags.length) {
      i = consumeHeredocBodies(str, i + 1, heredocTags).end;
      heredocTags = [];
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return str.length;
}

// Reads the tag word after `<<` / `<<-` starting at `i`.
function readHeredocTag(str, i) {
  let stripTabs = false;
  if (str[i] === '-') { stripTabs = true; i++; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  let quoted = false;
  let tag = '';
  if (str[i] === "'" || str[i] === '"') {
    const q = str[i];
    const j = str.indexOf(q, i + 1);
    tag = str.slice(i + 1, j === -1 ? str.length : j);
    quoted = true;
    i = j === -1 ? str.length : j + 1;
  } else {
    if (str[i] === '\\') { quoted = true; i++; }
    // #5513: an unquoted tag is a bash WORD. It ends only at a metacharacter (space, tab,
    // newline, `;&|<>()`): a carriage return is not one, so `EOF` + CR is the tag and the
    // CRLF terminator line matches it; and a substitution inside the word belongs to it,
    // taken literally (`E$(x)F` waits for the line `E$(x)F`).
    while (i < str.length && !(heredocTagsAsWords ? /[ \t\n;&|<>()]/ : /[\s;&|<>()]/).test(str[i])) {
      if (!heredocTagsAsWords) { tag += str[i++]; continue; }
      if (str[i] === '$' && str[i + 1] === '(') {
        const e = findParenClose(str, i + 2);
        tag += str.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (str[i] === '$' && str[i + 1] === '{') {
        const j = str.indexOf('}', i);
        const e = j === -1 ? str.length - 1 : j;
        tag += str.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      if (str[i] === '`') {
        const j = str.indexOf('`', i + 1);
        const e = j === -1 ? str.length - 1 : j;
        tag += str.slice(i, e + 1);
        i = e + 1;
        continue;
      }
      tag += str[i++];
    }
  }
  return { tag, quoted, stripTabs, end: i };
}

// From `i` (start of the line after the heredoc-opening line), consume one
// body per pending tag in order. Returns every body with its `quoted`/`seg`
// (the caller emits a token per body and recurses substitutions only for
// unquoted ones) and the index just past the last terminator line. An
// unterminated body consumes to end of input.
function consumeHeredocBodies(str, i, tags) {
  const bodies = [];
  for (const t of tags) {
    let body = '';
    let terminated = false;
    while (i < str.length) {
      const nl = str.indexOf('\n', i);
      const lineEnd = nl === -1 ? str.length : nl;
      const line = str.slice(i, lineEnd);
      i = nl === -1 ? str.length : nl + 1;
      const probe = t.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe === t.tag) { terminated = true; break; }
      body += line + '\n';
    }
    bodies.push({ body, quoted: t.quoted, seg: t.seg });
    if (!terminated) break;
  }
  return { bodies, end: i };
}

// `text` with its `$( )` and backtick spans cut out, so a space inside one
// (`.e(nv|$(echo x))`) does not stop a glob group from being one word.
function withoutSubstitutions(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '$' && text[i + 1] === '(') {
      i = findParenClose(text, i + 2) + 1;
    } else if (text[i] === '`') {
      const j = text.indexOf('`', i + 1);
      i = j === -1 ? text.length : j + 1;
    } else {
      out += text[i];
      i++;
    }
  }
  return out;
}

// `$( )` and backtick spans inside an unquoted heredoc body.
function collectSubstitutions(body, nested) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '(') {
      const e = findParenClose(body, i + 2);
      nested.push(body.slice(i + 2, e));
      i = e + 1;
      continue;
    }
    if (body[i] === '`') {
      const j = body.indexOf('`', i + 1);
      const e = j === -1 ? body.length : j;
      nested.push(body.slice(i + 1, e));
      i = e + 1;
      continue;
    }
    i++;
  }
}

// Tokens: { kind: 'word'|'op'|'sep', text, quoted: 'none'|'single'|'double', seg }.
// `op` tokens carry `read` (an input redirect) and `dup` (`>&N`, consumes no
// target). Nested command strings are collected separately.
function tokenize(str) {
  const tokens = [];
  const nested = [];
  let buf = '';
  let quoted = 'none';
  // fork:secret-guard-grep-pattern: the word holds a substitution or an
  // unquoted glob/brace — `$X`, `${X}`, `$( )` or backticks, bare or inside
  // double quotes (`"$@"`, `"${a[@]}"` and a bare `$X` can each become several
  // words), or `*?[{` outside quotes — so its run-time words, and with them
  // which word sits where, are unknown to the scan. Single-quoted text never
  // sets it.
  let expands = false;
  // The parts of `expands` the scan expands itself (scanExpansionWords): an
  // unquoted glob (`*`, `?`, a closed `[…]`) and a brace expansion (`{…}`
  // holding a `,` or `..`).
  let globbed = false;
  let brace = false;
  let group = false; // a glued `(…)` glob group (zsh alternation, bash extglob)
  let bracketOpen = false; // an unquoted `[` seen in this word
  let braceOpen = false; // an unquoted `{` seen in this word
  let braceHasSep = false; // and an unquoted `,` or `..` after it
  // A `VAR=value` assignment as bash sees one: the `=` is unquoted and the
  // text before it is a bare name with no quote, escape or substitution
  // (`"X"=v`, `\X=v` and `X"="v` are command words, not assignments).
  let assign = false;
  let assignDecided = false;
  let escaped = false;
  let hasWord = false;
  let seg = 0;
  let heredocs = [];
  let expectTag = null;

  const flush = () => {
    if (!hasWord) return;
    if (expectTag) {
      // Record the current seg (still the `<<` segment — flush runs before the
      // newline sep increments it) so pass 2 can attach the body to the shell.
      heredocs.push({ tag: buf, quoted: quoted !== 'none', stripTabs: expectTag.stripTabs, seg });
      expectTag = null;
    } else {
      tokens.push({ kind: 'word', text: buf, quoted, expands, globbed, brace, group, assign, seg });
    }
    buf = '';
    quoted = 'none';
    expands = false;
    globbed = false;
    brace = false;
    group = false;
    bracketOpen = false;
    braceOpen = false;
    braceHasSep = false;
    assign = false;
    assignDecided = false;
    escaped = false;
    hasWord = false;
  };
  // The operator text ends segment `seg`; pass 2 reads it to tell `a | bash`
  // (pipe inference) from `a || bash` and to skip grouping seps.
  const sep = (text) => {
    flush();
    tokens.push({ kind: 'sep', text, quoted: 'none', seg });
    seg++;
  };
  const op = (text, read, dup) => {
    tokens.push({ kind: 'op', text, quoted: 'none', seg, read, dup });
  };

  let i = 0;
  while (i < str.length) {
    const ch = str[i];

    if (ch === "'") {
      hasWord = true;
      if (quoted === 'none') quoted = 'single';
      const j = str.indexOf("'", i + 1);
      const end = j === -1 ? str.length : j;
      // A quoted `]` still closes an unquoted `[` for the scan (`.en[v"]"`):
      // reading it as a glob can only add a denial.
      if (bracketOpen && str.slice(i + 1, end).includes(']')) expands = globbed = true;
      buf += str.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      hasWord = true;
      if (quoted === 'none') quoted = 'double';
      i++;
      while (i < str.length && str[i] !== '"') {
        const c = str[i];
        if (c === '\\' && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
          if (str[i + 1] !== '\n') buf += str[i + 1];
          i += 2;
          continue;
        }
        if (c === '$') expands = true;
        if (c === '$' && str[i + 1] === '(') {
          const e = findParenClose(str, i + 2);
          nested.push(str.slice(i + 2, e));
          i = e + 1;
          continue;
        }
        if (c === '`') {
          expands = true;
          const j = str.indexOf('`', i + 1);
          const e = j === -1 ? str.length : j;
          nested.push(str.slice(i + 1, e));
          i = e + 1;
          continue;
        }
        if (c === ']' && bracketOpen) expands = globbed = true;
        buf += c;
        i++;
      }
      i++;
      continue;
    }

    if (ch === '\\') {
      if (str[i + 1] === '\n') { i += 2; continue; } // line continuation
      hasWord = true;
      escaped = true;
      if (i + 1 < str.length) buf += str[i + 1];
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      hasWord = true;
      expands = true;
      const e = findParenClose(str, i + 2);
      nested.push(str.slice(i + 2, e));
      if (expectTag && heredocTagsAsWords) buf += str.slice(i, e + 1); // #5513: the tag is taken literally
      i = e + 1;
      continue;
    }

    if (ch === '$' && str[i + 1] === '{') {
      hasWord = true;
      expands = true;
      const j = str.indexOf('}', i);
      const e = j === -1 ? str.length - 1 : j;
      buf += str.slice(i, e + 1);
      i = e + 1;
      continue;
    }

    if (ch === '`') {
      hasWord = true;
      expands = true;
      const j = str.indexOf('`', i + 1);
      const e = j === -1 ? str.length : j;
      nested.push(str.slice(i + 1, e));
      if (expectTag && heredocTagsAsWords) buf += str.slice(i, e + 1); // #5513: the tag is taken literally
      i = e + 1;
      continue;
    }

    if ((ch === '<' || ch === '>') && str[i + 1] === '(') {
      flush();
      const e = findParenClose(str, i + 2);
      const inner = str.slice(i + 2, e);
      nested.push(inner);
      // Emit a word carrying the inner script so a shell / `source` operand
      // (`sh <(echo 'cat .env')`) can reconstruct it; the bare nested recursion
      // above only sees `echo …`, whose operands are not read.
      tokens.push({ kind: 'word', text: str.slice(i, e + 1), quoted: 'none', seg, procsub: inner });
      i = e + 1;
      continue;
    }

    if (ch === '\n') {
      sep('\n');
      i++;
      if (heredocs.length) {
        const r = consumeHeredocBodies(str, i, heredocs);
        for (const b of r.bodies) {
          // Emit a heredoc token per body (quoted included) — the body is the
          // stdin script only a shell interpreter runs. Kept out of `words`.
          tokens.push({ kind: 'heredoc', text: b.body, quoted: b.quoted, seg: b.seg });
          if (!b.quoted) collectSubstitutions(b.body, nested); // bash expands $( ) here
        }
        heredocs = [];
        i = r.end;
      }
      continue;
    }

    // #5513: a CR is not a bash metacharacter, so inside a heredoc tag it is part of the word
    // (a CRLF command's terminator line is `EOF` + CR).
    if (ch === '\r' && expectTag && hasWord && heredocTagsAsWords) {
      buf += ch;
      i++;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      i++;
      continue;
    }

    if (ch === '#' && !hasWord) {
      const j = str.indexOf('\n', i);
      i = j === -1 ? str.length : j;
      continue;
    }

    if (ch === '<' || ch === '>' || (ch === '&' && str[i + 1] === '>')) {
      let fd = '';
      if (hasWord && quoted === 'none' && /^\d+$/.test(buf)) {
        fd = buf;
        buf = '';
        hasWord = false;
      } else {
        flush();
      }
      let j = i;
      let text;
      if (str.startsWith('<<<', j)) { text = '<<<'; j += 3; }
      else if (str.startsWith('<<-', j)) { text = '<<-'; j += 3; }
      else if (str.startsWith('<<', j)) { text = '<<'; j += 2; }
      else if (str.startsWith('&>>', j)) { text = '&>>'; j += 3; }
      else if (str.startsWith('&>', j)) { text = '&>'; j += 2; }
      else if (str.startsWith('>>', j)) { text = '>>'; j += 2; }
      else if (str.startsWith('>|', j)) { text = '>|'; j += 2; }
      else { text = ch; j += 1; }
      if (text === '<<' || text === '<<-') {
        expectTag = { stripTabs: text === '<<-' };
        i = j;
        continue;
      }
      let dup = false;
      if ((text === '<' || text === '>') && str[j] === '&' && /[\d-]/.test(str[j + 1] || '')) {
        let k = j + 1;
        while (k < str.length && /[\d-]/.test(str[k])) k++;
        text += str.slice(j, k);
        j = k;
        dup = true;
      }
      op(fd + text, text[0] === '<' && text !== '<<<', dup);
      i = j;
      continue;
    }

    // Lookahead first, THEN record the full operator, so `a || bash` reports
    // `||` (no pipe inference) and `a | bash` reports `|` (pipe inference).
    if (ch === ';') {
      let text = ';';
      i++;
      if (str[i] === ';') { text = ';;'; i++; }
      sep(text);
      continue;
    }
    if (ch === '|') {
      let text = '|';
      i++;
      if (str[i] === '|') { text = '||'; i++; }
      else if (str[i] === '&') { text = '|&'; i++; }
      sep(text);
      continue;
    }
    if (ch === '&') {
      let text = '&';
      i++;
      if (str[i] === '&') { text = '&&'; i++; }
      sep(text);
      continue;
    }
    // A `(` glued to a word with a one-word group behind it is a glob group:
    // zsh alternation (`.e(nv|x)`, on by default — and zsh is the shell Claude
    // Code runs on macOS) or a bash extglob (`@(.env)`, `!(x)`). It stays in
    // the word for scanExpansionWords; `f()` and a group holding a space or
    // an operator keep the old split, and a `$( )` inside is still scanned.
    if (ch === '(' && hasWord && !expectTag && str[i + 1] !== ')') {
      const e = findParenClose(str, i + 1);
      const inner = str.slice(i + 1, e);
      if (e < str.length && !/[\s;&<>]/.test(withoutSubstitutions(inner))) {
        collectSubstitutions(inner, nested);
        buf += `(${inner})`;
        expands = globbed = group = true;
        i = e + 1;
        continue;
      }
    }

    if (ch === '(' || ch === ')') {
      sep(ch);
      i++;
      continue;
    }
    if ((ch === '{' || ch === '}') && !hasWord && (i + 1 >= str.length || /[\s;&|)]/.test(str[i + 1]))) {
      sep(ch);
      i++;
      continue;
    }

    hasWord = true;
    // `[` and `{` alone are literal (`[ -f x ]`, `find -exec cat {} +`): a
    // bracket glob needs its `]`, a brace expansion a `,` or `..` and its `}`.
    if (ch === '=' && !assignDecided) {
      assignDecided = true;
      assign = quoted === 'none' && !escaped && !expands && /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(buf);
    }
    if (ch === '$') expands = true;
    else if (ch === '*' || ch === '?') expands = globbed = true;
    else if (ch === '[') bracketOpen = true;
    else if (ch === ']' && bracketOpen) expands = globbed = true;
    else if (ch === '{') braceOpen = true;
    else if (braceOpen && (ch === ',' || (ch === '.' && buf.endsWith('.')))) braceHasSep = true;
    else if (ch === '}' && braceHasSep) expands = brace = true;
    buf += ch;
    i++;
  }
  flush();
  return { tokens, nested };
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 2: per-segment evaluation
// ---------------------------------------------------------------------------

// Option characters of a bundled short cluster (`-2nif`).
const CLUSTER_FLAG_CHAR_RE = /[A-Za-z0-9]/;

// True when an operand word names a secret file. `@file` (curl -d) and
// `--flag=value` are stripped to the value. In a single-dash word
// (`/^-[^-]./`, so `-2if.env` counts too) the value of a bundled cluster
// starts right after its run of option characters (#5046): `-if.env` holds
// `.env`, `-nf=.env` holds `.env` after the `=`. That value is checked as
// well as the historical two-character strip, so the verdict is never looser
// than base and costs a fixed number of `namesSecret` calls (at most three,
// whatever the word's length). The option run also swallows a value's leading
// letters and digits, so `-fapp.env` is denied although `cat app.env` is not:
// a fail-safe false positive, pinned in tests. `names` is the name predicate:
// namesSecret, or namesSecretPosix at a grep pattern position.
function operandNamesSecret(text, names = namesSecret) {
  let v = text;
  if (v.startsWith('@')) v = v.slice(1);
  if (v.startsWith('--')) {
    const eq = v.indexOf('=');
    if (eq !== -1) v = v.slice(eq + 1);
    return names(v);
  }
  if (!/^-[^-]./.test(v)) return names(v);
  if (names(v.slice(2))) return true;
  let end = 1;
  while (end < v.length && CLUSTER_FLAG_CHAR_RE.test(v[end])) end++;
  if (end > 2 && names(v.slice(end))) return true;
  return v[end] === '=' && names(v.slice(end + 1));
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `-c`, or a combined short flag ending in `c` (`-lc`, `-ec`, `-euc`): mode c.
const DASH_C_RE = /^-[A-Za-z]*c$/;

const GROUPING_SEPS = new Set(['(', ')', '{', '}']);

// How many words the option `word` occupies for wrapper `spec`: 2 when it
// takes a separate value word, else 1.
function wrapperOptionWidth(word, spec) {
  if (word.startsWith('--')) {
    if (word.includes('=')) return 1;
    // getopt_long accepts any unambiguous prefix (`--adj 5`).
    return word.length > 2 && (spec.long || []).some((l) => l.startsWith(word)) ? 2 : 1;
  }
  const valued = spec.short || '';
  for (let i = 1; i < word.length; i++) {
    if (valued.includes(word[i])) return i === word.length - 1 ? 2 : 1; // `-n5` carries its value
  }
  return 1;
}

// Index of the first word after a wrapper's own options, assignments and
// positional operands (`-n 5`, `-i A=1`, `-s KILL 5`, `--`).
function skipWrapperArgs(words, start, spec) {
  let idx = start;
  let optionsEnded = false;
  while (idx < words.length) {
    const text = words[idx].text;
    if (spec.assigns && ASSIGNMENT_RE.test(text)) {
      idx++;
    } else if (!optionsEnded && text === '--') {
      optionsEnded = true;
      idx++;
    } else if (!optionsEnded && text.length > 1 && text.startsWith('-')) {
      idx += wrapperOptionWidth(text, spec);
    } else {
      break;
    }
  }
  if (!spec.operands) return idx;
  idx = Math.min(idx + spec.operands, words.length);
  // `timeout 5 -- cmd`: some getopt builds still accept `--` after DURATION.
  return idx < words.length && words[idx].text === '--' ? idx + 1 : idx;
}

// Command base + operands after leading `VAR=val` assignments and prefix
// wrappers with their own options (`sudo -u root`, `env -i VAR=x`,
// `timeout -s KILL 5`, `nice -n 5`, …), or null when nothing but prefixes remain.
function resolveCommand(words) {
  let idx = 0;
  // `assign` is the tokenizer's reading, not the text: `"X"=/bin/cat .env` runs a
  // command word (a path through a directory named `X=`), not an assignment.
  while (idx < words.length && words[idx].assign) idx++;
  while (idx < words.length) {
    const spec = WRAPPERS.get(lastSegment(words[idx].text).toLowerCase());
    if (!spec) break;
    idx = skipWrapperArgs(words, idx + 1, spec);
  }
  if (idx >= words.length) return null;
  return { base: lastSegment(words[idx].text).toLowerCase(), operands: words.slice(idx + 1) };
}

/**
 * Rescan only the command-valued -c keys selected by #5045. This deliberately
 * does not resolve config files, --config-env/GIT_CONFIG_* values, or other
 * executing keys (diff drivers, filters, credential helpers, ssh, gpg).
 * Those are documented gaps, not a promise of complete Git config analysis.
 * Global option values and subcommand arguments are data, not more -c flags.
 */
function scanGitConfig(operands, depth) {
  for (const config of walkGitGlobals(operands).configs) {
    const eq = config.indexOf('=');
    if (eq === -1) continue;
    const key = config.slice(0, eq).toLowerCase();
    const value = config.slice(eq + 1);
    let script;
    if (key.startsWith('alias.') && value.startsWith('!')) script = value.slice(1);
    else if (key === 'diff.external') script = value;
    else continue;
    const hit = findSecretRead(script, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// Operand indices the segment's command consumes as a NAME, never as
// CONTENTS (#4639, #4856). Only these positions skip the operand check;
// every other operand is still checked, so a carve-out cannot launder a read
// elsewhere in the segment. The caller withdraws them all when a word of the
// segment holds a substitution (see findSecretRead).
function nameOnlyOperandIndices(base, operands) {
  if (CONTAINER_RUNTIMES.has(base)) return envFileValueIndices(operands);
  if (base === 'git') return gitPathspecIndices(operands);
  if (base === 'cp' || base === 'mv') return copyDestinationIndices(operands);
  return new Set();
}

// fork:secret-guard-grep-pattern: the pattern operands of grep/egrep/fgrep,
// which the caller checks with namesSecretPosix instead of namesSecret — not
// skipped, so a misparse that takes a file for the pattern can let through
// only a word whose Windows `\` reading names a secret. With an
// `-e`/`--regexp` or `-f`/`--file` anywhere there is no positional pattern,
// and only the `-e`/`--regexp` values are patterns (an `-f` value is a file
// grep reads). Without them the first positional word is the pattern; after
// `--` it is the next word. GNU and macOS grep permute options, so an option
// may follow the pattern; under POSIXLY_CORRECT a word after the first
// positional is an operand instead, so an `-e` value counts only when it
// precedes every positional — the one reading both orders agree on. Returns
// nothing (the full check everywhere) on an option outside the GREP_* tables
// or a value option with no value word.
function grepPatternIndices(operands) {
  const regexpValues = [];
  let patternOption = false;
  let firstPositional = -1;
  let endOfOptions = false;
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (endOfOptions || t === '-' || !t.startsWith('-')) {
      if (firstPositional === -1) firstPositional = k;
      continue;
    }
    if (t === '--') {
      endOfOptions = true;
      continue;
    }
    const opt = t.startsWith('--') ? grepLongOption(t) : grepShortCluster(t);
    if (opt === null) return new Set();
    if (opt.pattern) patternOption = true;
    if (opt.valueIsNextWord) {
      if (k + 1 >= operands.length) return new Set();
      k++;
    }
    // k is now the word holding the `-e` value: the next word, or the
    // cluster itself (`-ie.env`, `--regexp=.env`).
    if (opt.regexp && firstPositional === -1) regexpValues.push(k);
  }
  if (patternOption) return new Set(regexpValues);
  return firstPositional === -1 ? new Set() : new Set([firstPositional]);
}

// The shape of a `--long` grep option, or null when it is not in the tables.
function grepLongOption(t) {
  const eq = t.indexOf('=');
  const name = eq === -1 ? t : t.slice(0, eq);
  const valued = GREP_LONG_VALUE_OPTIONS.has(name);
  const shape = { pattern: name === '--regexp' || name === '--file', regexp: name === '--regexp', valueIsNextWord: false };
  if (eq !== -1) return valued || GREP_LONG_EQUALS_OPTIONS.has(name) ? shape : null;
  if (valued) return { ...shape, valueIsNextWord: true };
  return GREP_LONG_FLAGS.has(name) ? shape : null;
}

// The shape of a short grep cluster (`-rn`, `-m5`, `-ie`), or null when it
// holds a character outside the tables. A value option ends the cluster: the
// rest is its value, or the next word when nothing follows it.
function grepShortCluster(t) {
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (GREP_SHORT_VALUE_OPTIONS.has(ch)) {
      return { pattern: ch === 'e' || ch === 'f', regexp: ch === 'e', valueIsNextWord: i === t.length - 1 };
    }
    if (!GREP_SHORT_FLAGS.has(ch) && !(ch >= '0' && ch <= '9')) return null;
  }
  return { pattern: false, regexp: false, valueIsNextWord: false };
}

// #4639: the `--env-file` word, plus the next operand for the bare flag
// (`--env-file=<value>` is a single word).
function envFileValueIndices(operands) {
  const exempt = new Set();
  for (let k = 0; k < operands.length; k++) {
    if (!ENV_FILE_FLAG_RE.test(operands[k].text)) continue;
    exempt.add(k);
    if (!operands[k].text.includes('=')) exempt.add(++k);
  }
  return exempt;
}

// True when `text` is a listed long option, or a short cluster (`-co`) whose
// every letter is listed. `--opt=value`, an abbreviation, or a cluster
// holding a value option (`-ciX`) is not.
function isListedFlag(text, flags) {
  if (text.startsWith('--')) return flags.has(text);
  return /^-[A-Za-z]+$/.test(text) && [...text.slice(1)].every((ch) => flags.has(`-${ch}`));
}

// fork:secret-guard-grep-pattern (final review): words bash expands itself.
// A brace word is unrolled with the Grep arm's expandBraces plus sequence
// expressions (same 64 alternative budget; past it the command is denied
// `glob-too-complex`), a glued `(…)` group with expandGlobGroups, and each
// alternative is judged like an operand (`cat .e{n,}v`, `{cat,.env}`,
// `timeout {1,cat,.env}`, `cat .env(N)`). A glob word is judged by
// globSelectsSecret (`cat .en[v]`, `cat .e*`; not `cat *.*`, which bash and
// zsh keep off dotfiles by default). Every word counts — the command word,
// wrapper words, operands — except leading assignments (bash expands neither
// in them) and the operands of a non-reading command whose command part
// holds no substitution (`ls .env*` is an existence check).
// Returns the word, `{ code: 'glob-too-complex', path }`, or null.
function scanExpansionWords(words, cmd) {
  let lead = 0;
  while (lead < words.length && words[lead].assign) lead++;
  const opStart = cmd ? words.length - cmd.operands.length : words.length;
  const commandExpands = words.slice(lead, opStart).some((w) => w.expands);
  const skipOperands = cmd !== null && !commandExpands && isNonReading(cmd.base, cmd.operands);
  for (let k = lead; k < words.length; k++) {
    if (skipOperands && k >= opStart) continue;
    const hit = expansionNamesSecret(words[k]);
    if (hit) return hit;
  }
  return null;
}

// Unrolls a word's glued `(a|b)` glob groups into the patterns either shell
// may read: zsh takes `op(a|b)` as the character `op` (a wildcard for `*`/`?`)
// followed by an alternation; bash extglob takes `@(…)`/`+(…)` as one of the
// alternatives, `?(…)`/`*(…)` as optional and `!(…)` as anything (`*`). The
// union of both readings is returned, or null past MAX_GLOB_ALTERNATIVES.
const GLOB_GROUP_OPS = '@+*?!';
function expandGlobGroups(text) {
  const open = text.indexOf('(');
  if (open === -1) return [text];
  let depth = 0;
  let close = -1;
  const bars = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    } else if (ch === '|' && depth === 1) bars.push(i);
  }
  if (close === -1) return [text];
  const op = open > 0 && GLOB_GROUP_OPS.includes(text[open - 1]) ? text[open - 1] : '';
  const pre = text.slice(0, open - op.length);
  const post = text.slice(close + 1);
  const parts = [];
  let start = open + 1;
  for (const b of bars) {
    parts.push(text.slice(start, b));
    start = b + 1;
  }
  parts.push(text.slice(start, close));
  const middles = new Set();
  for (const p of parts) {
    middles.add(op + p);
    if (op !== '!') middles.add(p);
  }
  if (op === '*' || op === '?') middles.add('');
  if (op === '!') middles.add('*');
  // zsh BARE_GLOB_QUAL (on by default): a trailing `(…)` is a glob QUALIFIER
  // (`.env(N)`, `(.)`, `(om)`, `(:a)`), so the word without the group, with or
  // without the operator character, is a reading too. A `D` qualifier also
  // matches dotfiles, so its glob gets a leading-dot twin (`*(D)` → `.*`).
  middles.add('');
  middles.add(op);
  const variants = [...middles].map((m) => pre + m + post);
  if (parts.some((p) => p.includes('D'))) {
    const bare = pre + op + post;
    const cut = bare.lastIndexOf('/') + 1;
    variants.push(`${bare.slice(0, cut)}.${bare.slice(cut)}`);
  }
  const out = [];
  for (const variant of new Set(variants)) {
    const rest = expandGlobGroups(variant);
    if (rest === null) return null;
    for (const r of rest) {
      out.push(r);
      if (out.length > MAX_GLOB_ALTERNATIVES) return null;
    }
  }
  return out;
}

// One word's brace alternatives / glob judged as in scanExpansionWords.
function expansionNamesSecret(w) {
  if (!w.brace && !w.globbed) return null;
  let alts = w.group ? expandGlobGroups(w.text) : [w.text];
  if (alts !== null && w.brace) {
    const braced = [];
    for (const a of alts) {
      const expanded = expandBraces(a, true);
      if (expanded === null || braced.length + expanded.length > MAX_GLOB_ALTERNATIVES) {
        alts = null;
        break;
      }
      braced.push(...expanded);
    }
    if (alts !== null) alts = braced;
  }
  if (alts === null) return { code: 'glob-too-complex', path: w.text };
  for (const alt of alts) {
    if (operandNamesSecret(alt)) return w.text;
    // The same value stripping as for names (`--opt=`, a short cluster), so
    // `grep -if.env* p f` is judged like `grep .env* f`.
    if (w.globbed && operandNamesSecret(alt, globSelectsSecret)) return w.text;
  }
  return null;
}

// A Bash glob that can select a secret name. Unlike the Grep arm, a segment
// that does not START with a literal `.` is never a match: bash and zsh both
// keep a leading dot out of `*`, `?` and `[…]` unless dotglob / GLOB_DOTS is
// set (checked in `zsh -f` and with this machine's startup files), so `cat
// *.*` and `cat *` cannot reach `.env`, while `cat .e*` and `cat .*rc` can.
// The dotglob / GLOB_DOTS options are a documented gap; the zsh `(D)`
// qualifier, which turns dot matching on per glob, is unrolled by
// expandGlobGroups into a leading-dot twin instead.
function globSelectsSecret(v) {
  if (!/[*?[]/.test(v)) return false;
  const segment = lastSegment(v).toLowerCase();
  return segment.startsWith('.') && globAltSelectsSecret(segment);
}

// True when the segment's command prints only names (NON_READING_COMMANDS).
// `file` qualifies only with FILE_CLASSIFY_FLAGS options and no substitution
// in its operands; `file` permutes options, so one after an operand counts.
function isNonReading(base, operands) {
  if (!NON_READING_COMMANDS.has(base)) return false;
  if (base !== 'file') return true;
  let endOfOptions = false;
  for (const w of operands) {
    if (w.expands) return false;
    const t = w.text;
    if (endOfOptions || !t.startsWith('-') || t === '-') continue;
    if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, FILE_CLASSIFY_FLAGS)) return false;
  }
  return true;
}

// Walks git's global options (see GIT_GLOBAL_VALUE_OPTIONS). `sub` is the
// subcommand's index, or -1 when an unlisted option (or the end of the words)
// comes first; `configs` holds every `-c` value seen on the way, in order.
// Past an unlisted option the subcommand cannot be located, so `configs`
// conservatively takes the word after every later `-c` as well: a read
// still needs a command-valued key, so a harmless value stays allowed.
function walkGitGlobals(operands) {
  const configs = [];
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (!t.startsWith('-')) return { sub: k, configs };
    if (GIT_GLOBAL_VALUE_OPTIONS.has(t)) {
      if (t === '-c' && k + 1 < operands.length) configs.push(operands[k + 1].text);
      k++;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(t)) continue;
    const eq = t.indexOf('=');
    if (t.startsWith('--') && eq !== -1 && GIT_GLOBAL_EQUALS_FORM_OPTIONS.has(t.slice(0, eq))) continue;
    for (let j = k + 1; j + 1 < operands.length; j++) {
      if (operands[j].text === '-c') configs.push(operands[++j].text);
    }
    return { sub: -1, configs };
  }
  return { sub: -1, configs };
}

// #4856: the pathspec operands of a GIT_PATHSPEC_SUBCOMMANDS invocation. git
// permutes options, so one may follow a pathspec; after `--` every word is a
// pathspec. The subcommand is matched case-sensitively, as git looks it up.
function gitPathspecIndices(operands) {
  const { sub } = walkGitGlobals(operands);
  const spec = sub === -1 ? undefined : GIT_PATHSPEC_SUBCOMMANDS.get(operands[sub].text);
  if (!spec) return new Set();
  const pathspecs = new Set();
  let required = spec.requires === undefined;
  let endOfOptions = false;
  for (let k = sub + 1; k < operands.length; k++) {
    const t = operands[k].text;
    if (endOfOptions || !t.startsWith('-') || t === '-') pathspecs.add(k);
    else if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, spec.flags)) return new Set();
    else if (t === spec.requires) required = true;
  }
  return required ? pathspecs : new Set();
}

// #4856: the destination of a one-source `cp`/`mv` (see COPY_NAME_ONLY_FLAGS).
function copyDestinationIndices(operands) {
  const positional = [];
  let endOfOptions = false;
  for (let k = 0; k < operands.length; k++) {
    const t = operands[k].text;
    if (endOfOptions || !t.startsWith('-') || t === '-') positional.push(k);
    else if (positional.length) return new Set(); // an option or `--` after an operand
    else if (t === '--') endOfOptions = true;
    else if (!isListedFlag(t, COPY_NAME_ONLY_FLAGS)) return new Set();
  }
  return positional.length === 2 ? new Set([positional[1]]) : new Set();
}

// The statically-knowable stdin a segment writes: `echo`/`printf` operands
// joined by a space (for `echo`, leading `-neE` flags dropped). Any other
// source (`cat gen.sh | bash`, `curl … | sh`) is not knowable → null.
function reconstructedScript(words) {
  const cmd = resolveCommand(words);
  if (!cmd) return null;
  if (cmd.base === 'echo') {
    let start = 0;
    while (start < cmd.operands.length && /^-[neE]+$/.test(cmd.operands[start].text)) start++;
    return cmd.operands.slice(start).map((w) => w.text).join(' ');
  }
  if (cmd.base === 'printf') return cmd.operands.map((w) => w.text).join(' ');
  return null;
}

// Same rule applied to a `<( … )` / `>( … )` inner script's first segment.
function reconstructedProcsub(inner) {
  const { tokens } = tokenize(inner);
  const words = [];
  for (const t of tokens) {
    if (t.kind === 'sep') break;
    if (t.kind === 'word') words.push(t);
  }
  return reconstructedScript(words);
}

// The operator connecting segment `s` to the nearest PRECEDING segment that has
// word tokens, skipping empty grouping segments (`(echo cat .env) | bash` has an
// empty segment between `)` and `|`). Returns { op, prevSeg }.
function precedingOp(s, bySeg, sepAfter) {
  let p = s - 1;
  while (p >= 0 && !(bySeg.get(p) || []).some((t) => t.kind === 'word')) p--;
  if (p < 0) return { op: undefined, prevSeg: -1 };
  let op;
  for (let q = p; q < s; q++) {
    const text = sepAfter.get(q);
    if (text !== undefined && !GROUPING_SEPS.has(text)) op = text; // last non-grouping wins
  }
  return { op, prevSeg: p };
}

// #5513: the same scan under the other readings of a heredoc: bash 3.2.57's `$( )` span
// (bodies not skipped) and the earlier tag reading (tag ends at any whitespace). Only a
// command that opens a heredoc can read differently, so the extra passes are skipped for
// every other command.
function findSecretReadUnderOtherReadings(command) {
  if (!command.includes('<<')) return null;
  for (const [bodiesSkipped, tagsAsWords] of [[false, true], [true, false]]) {
    heredocBodiesSkippedInSpans = bodiesSkipped;
    heredocTagsAsWords = tagsAsWords;
    try {
      const hit = findSecretRead(command, 0);
      if (hit) return hit;
    } finally {
      heredocBodiesSkippedInSpans = true;
      heredocTagsAsWords = true;
    }
  }
  return null;
}

// Returns the offending token text, or null.
function findSecretRead(command, depth) {
  const { tokens, nested } = tokenize(command);

  for (const sub of nested) {
    if (depth < MAX_NESTING_DEPTH) {
      const hit = findSecretRead(sub, depth + 1);
      if (hit) return hit;
    }
  }

  // Group by seg, not separator order: heredoc tokens carry their `<<`
  // segment's seg and must reach the shell even though a data heredoc sits
  // between other separators. Heredocs are kept OUT of `words` so a data body
  // is never operand-checked (`cat <<EOF\n.env\nEOF` stays allowed).
  const bySeg = new Map();
  const heredocsBySeg = new Map();
  const sepAfter = new Map();
  let maxSeg = 0;
  for (const t of tokens) {
    if (t.seg > maxSeg) maxSeg = t.seg;
    if (t.kind === 'sep') {
      sepAfter.set(t.seg, t.text);
    } else if (t.kind === 'heredoc') {
      if (!heredocsBySeg.has(t.seg)) heredocsBySeg.set(t.seg, []);
      heredocsBySeg.get(t.seg).push(t);
    } else {
      if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
      bySeg.get(t.seg).push(t);
    }
  }

  for (let s = 0; s <= maxSeg; s++) {
    const segTokens = bySeg.get(s);
    if (!segTokens) continue;

    const words = [];
    const hereStrings = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        if (t.dup) continue;
        const target = segTokens[k + 1];
        if (target && target.kind === 'word') {
          k++;
          if (t.text.endsWith('<<<')) hereStrings.push(target.text); // stdin data for a shell
          // Input redirects are reads regardless of the command's exemption,
          // a glob in one included (`cat < .e*` reads the one match).
          else if (t.read && namesSecret(target.text)) return target.text;
          else if (t.read) {
            const hit = expansionNamesSecret(target);
            if (hit) return hit;
          }
        }
        continue;
      }
      words.push(t);
    }
    if (!words.length) continue;

    const cmd = resolveCommand(words);
    // Before the `!cmd` skip: `timeout {1,cat,.env}` leaves no command word
    // to the resolver, yet bash runs `timeout 1 cat .env`.
    const expansionHit = scanExpansionWords(words, cmd);
    if (expansionHit) return expansionHit;
    if (!cmd) continue;
    const { base, operands } = cmd;
    const heredocs = heredocsBySeg.get(s) || [];

    // eval concatenates ALL its operands and runs the result.
    if (base === 'eval') {
      if (depth < MAX_NESTING_DEPTH) {
        const hit = findSecretRead(operands.map((w) => w.text).join(' '), depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    // `source` / `.` reads a file (or a process-substitution script).
    if (base === 'source' || base === '.') {
      for (const w of operands) {
        if (w.procsub !== undefined && depth < MAX_NESTING_DEPTH) {
          const src = reconstructedProcsub(w.procsub);
          if (src !== null) {
            const hit = findSecretRead(src, depth + 1);
            if (hit) return hit;
          }
        } else if (operandNamesSecret(w.text)) return w.text;
      }
      continue;
    }

    // xargs turns stdin file names into a sub-command's operands.
    if (base === 'xargs' && depth < MAX_NESTING_DEPTH) {
      const hit = scanXargsPipe(operands, s, bySeg, sepAfter, depth);
      if (hit) return hit;
      // `.env` given to xargs itself (`xargs -a .env cat`) is an ordinary
      // operand — fall through to the operand check below.
    }

    if (SHELL_INTERPRETERS.has(base) && depth < MAX_NESTING_DEPTH) {
      const hit = scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth);
      if (hit) return hit;
      // `bash .env` (file mode) is caught by the operand check below.
    }

    // Git -c can carry a shell script instead of a file-name operand (#5045).
    if ((base === 'git' || base === 'git.exe') && depth < MAX_NESTING_DEPTH) {
      const hit = scanGitConfig(operands, depth);
      if (hit) return hit;
    }

    // A substitution or unquoted glob/brace can change the run-time words, so
    // the positions below are only trusted without one. In a wrapper word or
    // the command word itself it can even change WHICH command runs:
    // `timeout {1,cat} ls .env` runs `timeout 1 cat ls .env`, and
    // `X='cat /bin'; $X/ls .env` runs `cat /bin/ls .env`. Leading `VAR=value`
    // assignments are not counted: bash neither splits nor globs their value
    // (`ROOT="$PWD" ls .env`), and a `$( )` in one is scanned as its own
    // command. An assignment given to `env` is an argument and does count.
    let lead = 0;
    while (lead < words.length && words[lead].assign) lead++;
    const prefixExpands = words.slice(lead, words.length - operands.length).some((w) => w.expands);
    const segmentExpands = prefixExpands || operands.some((w) => w.expands);

    if (!prefixExpands && isNonReading(base, operands)) continue;

    // Name-only positions (#4639, #4856) skip the check; a grep pattern
    // position is checked without the Windows `\` split
    // (fork:secret-guard-grep-pattern). Both are withdrawn by a substitution
    // anywhere in the segment (`timeout {1,cat} cp x .env`).
    const nameOnly = segmentExpands ? new Set() : nameOnlyOperandIndices(base, operands);
    const posixOnly = segmentExpands || !GREP_COMMANDS.has(base) ? new Set() : grepPatternIndices(operands);
    for (let k = 0; k < operands.length; k++) {
      if (nameOnly.has(k)) continue;
      const names = posixOnly.has(k) ? namesSecretPosix : namesSecret;
      if (operandNamesSecret(operands[k].text, names)) return operands[k].text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// gsd-debugger CLI spawn scan (#5214)
// ---------------------------------------------------------------------------

const DEBUGGER_AGENT_NAME = 'gsd-debugger';
const CLAUDE_BINARY_RE = /^claude(\.exe)?$/;

// `gsd-debugger`, or a plugin-namespaced `<plugin>:gsd-debugger`.
function isDebuggerAgent(value) {
  return value.slice(value.lastIndexOf(':') + 1) === DEBUGGER_AGENT_NAME;
}

// Returns the `--agent` value text of a debugger launch, or null.
function findDebuggerCliSpawn(command, depth) {
  const { tokens, nested } = tokenize(command);

  for (const sub of nested) {
    if (depth < MAX_NESTING_DEPTH) {
      const hit = findDebuggerCliSpawn(sub, depth + 1);
      if (hit) return hit;
    }
  }

  const bySeg = new Map();
  for (const t of tokens) {
    if (t.kind !== 'word' && t.kind !== 'op') continue;
    if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
    bySeg.get(t.seg).push(t);
  }

  for (const segTokens of bySeg.values()) {
    const words = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        // A redirect consumes its target word; it is never the command.
        if (!t.dup && segTokens[k + 1] && segTokens[k + 1].kind === 'word') k++;
        continue;
      }
      words.push(t);
    }
    if (!words.length) continue;

    const cmd = resolveCommand(words);
    if (!cmd) continue;
    const { base, operands } = cmd;

    if (base === 'eval') {
      if (depth < MAX_NESTING_DEPTH) {
        const hit = findDebuggerCliSpawn(operands.map((w) => w.text).join(' '), depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    if (SHELL_INTERPRETERS.has(base)) {
      const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
      if (cIdx !== -1 && operands[cIdx + 1] && depth < MAX_NESTING_DEPTH) {
        const hit = findDebuggerCliSpawn(operands[cIdx + 1].text, depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    if (!CLAUDE_BINARY_RE.test(base)) continue;
    for (let k = 0; k < operands.length; k++) {
      const text = operands[k].text;
      if (text === '--agent') {
        const value = operands[k + 1];
        if (value && isDebuggerAgent(value.text)) return value.text;
      } else if (text.startsWith('--agent=') && isDebuggerAgent(text.slice('--agent='.length))) {
        return text.slice('--agent='.length);
      }
    }
  }
  return null;
}

// A shell interpreter's script comes from `-c`, a file operand, or stdin.
function scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth) {
  const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
  if (cIdx !== -1) {
    // Mode c: the next operand is the script; stdin is DATA (not scanned).
    const script = operands[cIdx + 1];
    if (script) return findSecretRead(script.text, depth + 1);
    return null;
  }
  let fileTok;
  for (let m = 0; m < operands.length; m++) {
    if (SHELL_VALUE_FLAGS.has(operands[m].text)) { m++; continue; }
    if (!operands[m].text.startsWith('-')) { fileTok = operands[m]; break; }
  }
  if (fileTok) {
    // Mode file: `bash <(echo 'cat .env')`; a plain file is checked as an operand.
    if (fileTok.procsub !== undefined) {
      const src = reconstructedProcsub(fileTok.procsub);
      if (src !== null) return findSecretRead(src, depth + 1);
    }
    return null;
  }
  // Mode stdin: heredoc bodies, here-strings, and a piped echo/printf source.
  for (const h of heredocs) {
    const hit = findSecretRead(h.text, depth + 1);
    if (hit) return hit;
  }
  for (const hs of hereStrings) {
    const hit = findSecretRead(hs, depth + 1);
    if (hit) return hit;
  }
  const { op, prevSeg } = precedingOp(s, bySeg, sepAfter);
  if ((op === '|' || op === '|&') && prevSeg >= 0) {
    const src = reconstructedScript((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word'));
    if (src !== null) return findSecretRead(src, depth + 1);
  }
  return null;
}

// `find … | xargs cat`: the upstream segment's operands become file names the
// sub-command reads. Only inferred across a real pipe and when stdin is not
// redirected by `-a`/`--arg-file`. A sub-command that is itself a shell
// (`xargs -I{} sh -c 'cat .env'`) carries a literal script and is scanned in
// mode c whether or not a pipe feeds it.
function scanXargsPipe(operands, s, bySeg, sepAfter, depth) {
  let argFile = false;
  let subIdx = -1;
  for (let m = 0; m < operands.length; m++) {
    const t = operands[m].text;
    if (t === '-a' || t === '--arg-file') { argFile = true; m++; continue; }
    if (t.startsWith('--arg-file=')) { argFile = true; continue; }
    if (XARGS_VALUE_FLAGS.has(t)) { m++; continue; }
    if (t.startsWith('--') && t.includes('=')) continue;
    if (t.startsWith('-')) continue; // no-value flag (-0 -r -t -p) or long flag
    subIdx = m;
    break;
  }
  if (subIdx === -1) return null; // no sub-command: xargs defaults to echo

  const subBase = lastSegment(operands[subIdx].text).toLowerCase();
  if (SHELL_INTERPRETERS.has(subBase)) {
    // Heredocs/here-strings belong to xargs, not the sub-shell; pass none.
    const hit = scanShellInterpreter(operands.slice(subIdx + 1), [], [], s, bySeg, sepAfter, depth);
    if (hit) return hit;
  }
  if (argFile) return null; // stdin replaced by a file — no pipeline inference
  if (isNonReading(subBase, operands.slice(subIdx + 1))) return null;

  const { op, prevSeg } = precedingOp(s, bySeg, sepAfter);
  if (op !== '|' && op !== '|&') return null;
  if (prevSeg < 0) return null;

  // Every upstream operand is a candidate file name — the NON_READING
  // exemption is bypassed for it, but the `.env.example|…` suffix exemption in
  // isSecretBasename still holds.
  const prevCmd = resolveCommand((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word'));
  if (!prevCmd) return null;
  for (const w of prevCmd.operands) {
    if (operandNamesSecret(w.text)) return w.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const PATTERN_TEXT = '.env, .env.<suffix> (except .env.example/.sample/.template/.dist), .secrets';

function reasonFor(code, tool, target) {
  if (code === 'command-too-large') {
    return `Secret read guard: this Bash command is over ${MAX_COMMAND_LENGTH} characters and ` +
      'cannot be checked for secret-file reads. Split it into smaller commands.';
  }
  if (code === 'glob-too-complex') {
    const what = tool === 'Grep' ? 'Grep glob' : 'brace expansion';
    return `Secret read guard: the ${what} '${target}' expands to more than ${MAX_GLOB_ALTERNATIVES} ` +
      'alternatives and cannot be checked for secret-file matches. Use a narrower glob.';
  }
  if (code === 'debugger-cli-spawn') {
    return `Debugger spawn guard: this Bash command launches the debugger as a CLI process ('--agent ${target}'). ` +
      'A shell-spawned debugger runs detached, returns no structured result, and the debug checkpoint never advances. ' +
      'Spawn it with the Agent tool instead: Agent(subagent_type="gsd-debugger", run_in_background=false, ...) ' +
      'and wait for its structured return.';
  }
  return `Secret read guard: ${tool} would read '${target}', which matches a protected secret-file ` +
    `pattern (${PATTERN_TEXT}). Secret values must not be read into the conversation. ` +
    'If you need a specific value, ask the user for it; if you need the variable NAMES, ' +
    'read the non-secret template (.env.example) instead.';
}

// stdout gets the typed JSON block; stderr gets the plain reason string
// (Kimi's hook bus reads stderr verbatim back to the model — #3911).
function emitBlock(code, tool, target) {
  const reason = reasonFor(code, tool, target);
  deny({ decision: 'block', code, tool, path: target, reason }, reason);
}

// Strips a `module:` prefix so Kimi's `kimi_cli.tools.file:Grep` (not in the
// KIMI_TOOL_NAMES map — Grep has the same name on both buses) matches.
function bareToolName(raw) {
  return typeof raw === 'string' ? raw.slice(raw.lastIndexOf(':') + 1) : '';
}

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the
// payload (ReadFile / Shell) and `path` instead of `file_path`; the map and
// normalizer below are the byte-identical copy every guard carries (bound by
// tests/kimi-guard-normalization-parity.test.cjs — do not edit locally).
// Grep keeps its name on Kimi and is not in the map; bareToolName() above
// strips the module prefix for it.
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write'], ['StrReplaceFile', 'Edit'], ['ReadFile', 'Read'], ['Shell', 'Bash']]);
function normalizeKimiPayload(data) {
  // #2595 (review nit): `JSON.parse('null')` is null, and null/primitive
  // payloads reached the `data.tool_name` read below and threw — falsifying
  // this function's own "total over the inputs JSON can express" claim, which
  // property (e) now tests directly. Harmless in practice (a null payload has
  // nothing to guard, and the throw landed in the same fail-open catch as the
  // exit-0 it now takes deliberately) but the claim should be true as stated.
  if (data === null || typeof data !== 'object') return data;
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (data.tool_response === undefined && data.tool_output !== undefined) {
    data.tool_response = data.tool_output;
  }
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    // #2547 (review): Kimi's `path` is AUTHORITATIVE — it must win outright,
    // not merely fill in when `file_path` happens to be absent. kimi-cli's file
    // tools carry no `file_path` field at all (src/kimi_cli/tools/file/write.py,
    // replace.py, @ 4a550ef — the SHA #2547 pins), and soul/toolset.py hands the
    // model's raw json-parsed
    // arguments to PreToolUse verbatim, doing typed validation only later inside
    // tool.call() — after the hook has already decided. So a `file_path` in a
    // Kimi payload is ALWAYS model-supplied, and under the old `=== undefined`
    // condition it SHADOWED the field kimi-cli actually executes on. A payload
    // pairing a cross-root `path` with a spurious `file_path: ""` left every
    // guard reading an empty string and exiting 0, while the identical write
    // without the extra key blocked — a bypass needing no crash at all. The same
    // shadowing also preserved a NON-STRING `file_path` (`[]`), which threw
    // inside gsd-worktree-path-guard's path.isAbsolute() and reached its outer
    // `catch { process.exit(0) }`: the same crash-to-allow this fix closes
    // elsewhere, reached through the guard's own read rather than through
    // normalization. Overwriting can only ever narrow what a guard inspects to
    // the path that will actually be written, so it cannot under-block.
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      // #2547: `e?.old`, not `e.old` — `??` guards the value, not the
      // dereference, so a NULLISH entry (`edit: [null]`) threw a TypeError
      // here. normalizeKimiPayload runs before any tool dispatch, so that throw
      // reached each guard's outer `catch { process.exit(0) }` and silently
      // downgraded a should-BLOCK call into an allow. (A string/number entry
      // never threw — `('x').old` is a legal read yielding undefined.)
      //
      // The String() coercion is guarded for the same reason: `{"toString":
      // null}` is valid JSON that throws "Cannot convert object to primitive
      // value", which is the identical crash-to-allow with a different
      // trigger. Degrading only the non-coercible entry to '' keeps
      // stringification intact for every value that CAN coerce (numbers,
      // arrays, plain objects), so nothing downstream — including
      // gsd-prompt-guard's scan of new_string — loses content it saw before.
      const editText = (v) => { try { return String(v ?? ''); } catch { return ''; } };
      // #2595 (review Major 2): reconstruct UNCONDITIONALLY, mirroring the
      // `path` decision above rather than merely filling in when the field
      // happens to be absent. kimi-cli's StrReplaceFile schema is `path` +
      // `edit` only (src/kimi_cli/tools/file/replace.py @ 4a550ef) — it carries
      // no `old_string`/`new_string` at all, so either field appearing in a
      // Kimi payload is ALWAYS model-supplied, exactly like `file_path`. Under
      // the old `=== undefined` condition a model-supplied `new_string: ""`
      // SHADOWED the reconstruction, leaving gsd-prompt-guard's injection scan
      // reading '' and exiting at its `if (!content)` before it ever saw the
      // real `edit[].new` — a one-key bypass of the very scan this fix's
      // guarded coercion exists to keep fed. A `typeof` test would NOT close
      // it: a benign non-empty string shadows just as effectively as ''.
      input.old_string = edits.map((e) => editText(e?.old)).join('\n');
      input.new_string = edits.map((e) => editText(e?.new)).join('\n');
    }
  }
  return data;
}

// mn fork (fork:shell-scan-export): the Bash scanner above is the one shell
// reader GSD ships, so gsd-planning-delete-guard.js reads commands through it
// instead of carrying a second tokenizer. Required as a module it exports the
// scanner and does not touch stdin; the body below is left unindented so an
// upstream change to it still merges.
module.exports = { tokenize, resolveCommand, expandBraces, globAltToRegex, MAX_NESTING_DEPTH };

if (require.main === module) {
let input = '';
const stdinTimeout = setTimeout(() => allow(undefined), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(JSON.parse(input));

    // A null/primitive payload has nothing to guard — exit deliberately
    // rather than throwing into the fail-open catch below (#2595 class).
    if (data === null || typeof data !== 'object') {
      allow(undefined);
    }

    const tool = bareToolName(data.tool_name);
    if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Bash') {
      allow(undefined);
    }
    if (!data.tool_input || typeof data.tool_input !== 'object') {
      allow(undefined);
    }

    // Every payload field is read TYPED in a single statement (#2547 class):
    // `[]`/`{}` are truthy and a non-string degrades to '' here.
    if (tool === 'Read') {
      const filePath = typeof data.tool_input.file_path === 'string' ? data.tool_input.file_path : '';
      if (namesSecret(filePath)) emitBlock('secret-read', tool, filePath);
      allow(undefined);
    }

    if (tool === 'Grep') {
      const grepPath = typeof data.tool_input.path === 'string' ? data.tool_input.path
        : (typeof data.tool_input.file_path === 'string' ? data.tool_input.file_path : '');
      if (namesSecret(grepPath)) emitBlock('secret-read', tool, grepPath);
      const glob = typeof data.tool_input.glob === 'string' ? data.tool_input.glob : '';
      if (glob !== '') {
        const verdict = classifyGrepGlob(glob);
        if (verdict) emitBlock(verdict, tool, glob);
      }
      allow(undefined);
    }

    // Bash
    const command = typeof data.tool_input.command === 'string' ? data.tool_input.command : '';
    if (command === '') allow(undefined);
    if (command.length > MAX_COMMAND_LENGTH) emitBlock('command-too-large', tool, '');
    const hit = findSecretRead(command, 0) || findSecretReadUnderOtherReadings(command);
    // A hit is the offending word, or `{ code, path }` for a brace word past
    // the alternative budget (scanExpansionWords).
    if (hit !== null && typeof hit === 'object') emitBlock(hit.code, tool, hit.path);
    if (hit !== null) emitBlock('secret-read', tool, hit);
    const spawn = findDebuggerCliSpawn(command, 0);
    if (spawn !== null) emitBlock('debugger-cli-spawn', tool, spawn);
    allow(undefined);
  } catch {
    // Fail open — never block valid tool calls due to hook errors.
    // ON_CRASH is declared ALLOW at module top (#3911).
    crash(ON_CRASH, undefined);
  }
});
}
