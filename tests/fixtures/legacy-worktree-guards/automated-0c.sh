# WT_ROOT as in step 0b. MAIN_ROOT is the checkout this worktree was created from — the one an
# orchestrator-cwd path points at.
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
MAIN_ROOT=$(cd "$(git rev-parse --git-common-dir)/.." 2>/dev/null && pwd -P)
# Resolve a path the way the shell would land in it. A relative path is taken from the second
# argument — the cwd a chained `cd` has reached so far — or the worktree root. An existing directory resolves through `cd && pwd -P`; a file through its directory (a
# symlinked file through its link target first), so a symlink or `..` hop inside the worktree that
# lands in the main checkout is seen for what it is; a path that does not exist yet — a Wave-0
# scaffold — is normalized lexically and must still PASS when it sits under the worktree. Never
# `readlink -m` / `realpath -m` — GNU-only. `_norm` splits with `read -ra` (no glob expansion) and
# expands the array with the `${a[@]+"${a[@]}"}` idiom (bash < 4.4 errors on an empty array under -u).
_norm(){ local -a out=() seg; local s; IFS=/ read -ra seg <<<"$1"
  for s in ${seg[@]+"${seg[@]}"}; do case "$s" in ''|.) ;; ..) [ ${#out[@]} -gt 0 ] && unset 'out[${#out[@]}-1]' ;; *) out+=("$s") ;; esac; done
  printf '/%s' ${out[@]+"${out[@]}"}; [ ${#out[@]} -gt 0 ] || printf '/'; }
_resolve(){ local p t; case "$1" in /*) p=$1 ;; *) p="${2:-$WT_ROOT}/$1" ;; esac
  if [ -L "$p" ] && ! [ -d "$p" ]; then t=$(readlink "$p"); case "$t" in /*) p=$t ;; *) p="$(dirname -- "$p")/$t" ;; esac; fi
  ( cd -- "$p" 2>/dev/null && pwd -P ) \
  || ( cd -- "$(dirname -- "$p")" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$(basename -- "$p")" ) \
  || _norm "$p"; }
_outside_wt(){ case "$1" in "$WT_ROOT"|"$WT_ROOT"/*) return 1 ;; *) return 0 ;; esac; }
# A shell word as the planner wrote it: runs of bare characters, "…" / '…' spans, and backslash
# escapes, in any mix (`"/x"/y`, `"O'Reilly"`, `path\ with\ space`, `release=main`). `_unquote`
# walks it with the shell's own three quoting states and returns the string the shell would pass.
_TOK='("[^"]*"|'"'"'[^'"'"']*'"'"'|\\.|[^[:space:]"'"'"';|&()])+'
_unquote(){ local s=$1 out='' q='' c i
  for ((i=0; i<${#s}; i++)); do c=${s:i:1}
    if [ -z "$q" ]; then case "$c" in '"'|"'") q=$c ;; '\') i=$((i+1)); out+=${s:i:1} ;; *) out+=$c ;; esac
    elif [ "$q" = '"' ]; then case "$c" in '"') q='' ;; '\') i=$((i+1)); out+=${s:i:1} ;; *) out+=$c ;; esac
    else case "$c" in "'") q='' ;; *) out+=$c ;; esac; fi
  done; printf '%s' "$out"; }
# True when raw shell text contains an unquoted single `&` or `|`. `&&` and
# `||` keep the current shell's cwd; the single forms cross a process boundary.
_resets_cwd(){ local s=$1 q='' i c p n; for ((i=0;i<${#s};i++)); do c=${s:i:1}
    if [ -z "$q" ]; then case "$c" in
      "'"|'"') q=$c ;; '\') i=$((i+1)) ;;
      '&'|'|') p=''; n=''; [ "$i" -gt 0 ] && p=${s:i-1:1}; [ "$i" -lt $((${#s}-1)) ] && n=${s:i+1:1};
        [ "$p" = "$c" ] || [ "$n" = "$c" ] || return 0 ;;
    esac
    elif [ "$q" = '"' ]; then case "$c" in '"') q='' ;; '\') i=$((i+1)) ;; esac
    else [ "$c" = "'" ] && q=''; fi
  done; return 1; }
# The relocating verbs — `cd` / `pushd` (bare, `builtin`/`command`-prefixed, env-prefixed, or with
# `--`) and a tool's own directory flag (`npm`/`npx`/`pnpm` `--prefix`, `yarn --cwd`, `pnpm -C`,
# `make -C`, `git -C`; both `--flag <p>` and `--flag=<p>`) at the start of a segment, including after a
# `(`/`{` opener or a `&` background operator. Each match is stripped of its prefix with an ANCHORED sed,
# so the target is taken verbatim, unquoted, and compared LITERALLY — never interpolated into a regex.
_VERB='((builtin|command)[[:space:]]+)?(cd|pushd)([[:space:]]+--)?'
_ENV='([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'
# `&` joins the operator set; grep is line-oriented, so a newline is already covered by `^`.
# CONTROL KEYWORDS (`if`, `then`, `do`, …) WERE TRIED HERE AND REVERTED, and the reason is the rule
# this fence is built on rather than a detail: these operators are matched against RAW TEXT, with no
# awareness of quoting, so a keyword that is also an ordinary English word turns prose inside a
# quoted argument into a command boundary — `grep -F 'if cd ../main; then' README.md` halted on a
# command that relocates nothing. That buys a rare false negative (`if cd ../main; then …`) at the
# cost of a realistic false positive, and this guard's whole posture is that the false-positive
# direction is the one that gets it routed around. The residual is disclosed instead.
# Spell the literal ERE operators as bracket expressions. `\|` / `\(` / `\{`
# are GNU-tolerated but undefined by POSIX and BSD sed rejects the same boundary
# expression with "unbalanced brackets" before the scan can run (#4767).
_OPEN='(^|&&|&|;|[|][|]|[|]|[(]|[{])[[:space:]]*'
# LAUNCHERS are a NAMED set, not `[^&;|]*`. A wrapper reached through a launcher is still a wrapper,
# and the set admits an absolute path (`/usr/bin/env`) and an option with a SEPARATE operand
# (`env -u FOO`, `timeout --signal TERM`, `stdbuf -o L`). Which options TAKE an operand is
# TOOL-SCOPED for the same reason `_DIR`'s flags are: `-i` takes one on `stdbuf` and NONE on `env`,
# so a flat set consumed the COMMAND after an operandless flag and `env -i echo bash -c '…'` —
# which runs `echo` — halted. `command` and `exec` are deliberately NOT in the set: `command -v
# bash` is a name PROBE that executes nothing, and halting it is the false-positive direction
# again. The cost is that a genuine `command bash -c …` is not unwrapped; that is disclosed.
# but a catch-all leading run also unwraps interpreter TEXT that is merely an argument — `echo bash -c
# 'cd ../main'` halted on a command that executes nothing. A spurious unwrap is NOT harmless: the scans
# halt on a path the shell would never visit. Name the launchers instead.
_LOPT='([[:space:]]+-[^[:space:]]+|[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)*'
# THE SHAPE IS `(<generic opts> <opt> <operand>)* <generic opts>`, NOT `<generic opts> (<opt>
# <operand>)* <generic opts>`. The second admits only ONE contiguous run of operand-taking options,
# so a generic option BETWEEN two of them ends the run and hides everything after it:
# `env -u FOO --debug -u BAR -C ../main` relocates and passed silently. Interleaving is the normal
# way these tools are invoked, so the grammar has to allow it. Same shape for timeout and stdbuf.
# env's own separate-operand options, factored out because BOTH consumers need them: $_LAUNCH, so a
# payload behind `env -u FOO bash -c …` is unwrapped, and $_DIR, so `env -u FOO -C ../main` is still
# seen as a relocation. Generic $_LOPT cannot consume `FOO`, so without this the option HID the flag.
_ENVOPT='('"$_LOPT"'[[:space:]]+(-u|--unset)[[:space:]]+'"$_TOK"')*'"$_LOPT"
# $_LAUNCH needs a WIDER env group than $_DIR does, and the difference is deliberate. $_DIR must leave
# `-C`/`--chdir` UNCONSUMED — that flag is the thing it is looking for. $_LAUNCH must consume it, or
# `env -C scripts bash -c '…'` has its relocation seen and its PAYLOAD never unwrapped, which is the
# bypass class this whole guard is about. Two groups, one per consumer.
_ENVOPTL='('"$_LOPT"'[[:space:]]+((-u|--unset)[[:space:]]+|(-C|--chdir)([[:space:]]+|=))'"$_TOK"')*'"$_LOPT"
_LAUNCH='((/[^[:space:]]*/)?((env|setsid|nohup)'"$_ENVOPTL"'|timeout('"$_LOPT"'[[:space:]]+(-s|--signal|-k|--kill-after)[[:space:]]+[^[:space:]]+)*'"$_LOPT"'[[:space:]]+[0-9]+[smhd]?|(stdbuf|nice|ionice)('"$_LOPT"'[[:space:]]+(-i|-o|-e|-n|-c)[[:space:]]+[^[:space:]]+)*'"$_LOPT"')[[:space:]]+)*'
# The directory flags are TOOL-SCOPED, because the same spelling is not the same flag on every tool:
# `git archive --prefix=../main/ HEAD` names archive MEMBERS and changes no directory, so a flat
# six-tool `--prefix` halts a legitimate command. `--prefix`/`--cwd`/`--dir`/`-C` belong to the node
# package managers; `-C`/`--directory` to make and git. $_LAUNCH leads it for $_EXEC's reason — a
# recognised tool behind `env` is still that tool.
_DIR='(('"$_LAUNCH"')(npm|npx|pnpm|yarn)[[:space:]]+([^&;|]*[[:space:]]+)?(--prefix|--cwd|--dir|-C)|('"$_LAUNCH"')(make|git)[[:space:]]+([^&;|]*[[:space:]]+)?(-C|--directory)|('"$_LAUNCH"')(/[^[:space:]]*/)?env'"$_ENVOPT"'[[:space:]]+(--chdir|-C))[[:space:]=]+'
# Command-string interpreters. `eval "cd <main> && x"`, `sh -c "…"`, `bash -c '…'`, `node -e '…'` bury
# the real command inside ONE opaque quoted token, and that defeats BOTH scans below at once: the
# relocating verb never sits at a boundary scan 1 recognizes, and scan 2's tokenizer swallows the whole
# quoted span, which after unquoting does not begin with `/`. These are ordinary portability idioms, not
# obfuscation — a planner imitating a CI script reaches for one without any adversarial intent — so the
# payload is UNWRAPPED and re-scanned rather than trusted or rejected wholesale. $_LAUNCH lets the
# launcher forms a planner actually writes — `env bash -c`, a `timeout`-wrapped `bash -c`,
# `nohup sh -c` — reach the same unwrap as a bare one, and an absolute or option-bearing
# interpreter (`/bin/bash -c`, `bash --noprofile -c`) with it.
_EXEC='('"$_LAUNCH"')((/[^[:space:]]*/)?(sh|bash|zsh|dash|ksh)([[:space:]]+--[a-z-]+)*[[:space:]]+-[a-z]*c|(/[^[:space:]]*/)?(python3?|node|perl|ruby)([[:space:]]+--[a-z-]+)*[[:space:]]+-[a-z]*[ce]|eval)[[:space:]]+'
# `eval` runs in the current shell, unlike the other interpreters above; its payload's final cwd must
# therefore flow into the next event. A subprocess payload is scanned from the reached cwd and then
# restores its caller's cwd.
_EVAL='eval[[:space:]]+'
# ONE ordered pass per scanned string, each event tagged `C` (a cd/pushd — moves the cwd), `N` (a
# tool's directory flag — resolved from the cwd reached so far but does NOT move it), `E` (`eval`,
# whose cwd change persists), or `W` (a subprocess interpreter, whose cwd change does not). Ordering
# is load-bearing: scanning every outer relocation before an earlier payload lets a later `cd` supply
# that payload with a cwd the shell has not reached yet. `_scan` is a FUNCTION so an unwrapped payload
# reaches the SAME event scan as the top-level command; it halts with
# `exit 1`, never a return code, so a halt inside a payload is exactly as fatal as one outside; and it
# ends `return 0` so a trailing non-`C` target cannot make the function itself look failed under `set -e`.
CUR=$WT_ROOT
_scan(){ local CMD=$1 D=$2 RAW BODY BFR REST K Q T R P S PREFIX LDS LD _T _P
  _T=$( printf '%s' "$CMD" | grep -oE "${_OPEN}(${_ENV}${_EXEC}|${_ENV}${_VERB}[[:space:]]+|${_DIR})${_TOK}" \
        | sed '/^$/d' )
  # 1. Every relocating target, relative or absolute, resolved from the cwd the command has reached
  # (chained `cd scripts && cd ..` lands back at the root and passes; `cd scripts && cd ../..` does
  # not): outside the worktree → halt. A target the shell would expand (`~`, `$VAR`, `$(…)`) cannot
  # be evaluated here and passes through — the plan-checker's probe already reports those as
  # `dynamic_path`, and `$(git rev-parse --show-toplevel)` is the form step 0b itself recommends.
  REST=$CMD
  while IFS= read -r RAW; do
    [ -n "$RAW" ] || continue
    # Preserve process boundaries even when an unrecognized command sits between
    # one and the next recognized event (`cd x & echo y && bash -c ...`).
    BFR=${REST%%"$RAW"*}; REST=${REST#*"$RAW"}
    if _resets_cwd "$BFR" || _resets_cwd "$RAW"; then CUR=$WT_ROOT; fi
    BODY=$(printf '%s' "$RAW" | sed -E "s/^(&&|&|;|[|][|]|[|]|[(]|[{])?[[:space:]]*//")
    # Classify with the same grep implementation that produced the event and
    # remove the matched prefix literally. Expanding these composed EREs into a
    # multi-expression BSD sed program fails with "unbalanced brackets" on
    # macOS even though BSD grep accepts the event expression (#4767).
    if _P=$(printf '%s' "$BODY" | grep -oE "^${_ENV}${_EVAL}"); then K=E
    elif _P=$(printf '%s' "$BODY" | grep -oE "^${_ENV}${_EXEC}"); then K=W
    elif _P=$(printf '%s' "$BODY" | grep -oE "^${_DIR}"); then K=N
    else _P=$(printf '%s' "$BODY" | grep -oE "^${_ENV}${_VERB}[[:space:]]+"); K=C
    fi
    Q=${BODY#"$_P"}; T=$(_unquote "$Q")
    case "$K" in
      E) [ "$D" -ge 4 ] || _walk "$T" "$((D+1))" ;;
      W) if [ "$D" -lt 4 ]; then
           S=$CUR
           # `_EXEC` is longer than `_DIR`, so a wrapper reached through
           # `env -C/--chdir` wins grep's leftmost-longest match. Recover that
           # launcher's relocation here: validate it, start the child there,
           # then restore the parent cwd when the payload scan returns.
           PREFIX=${BODY%"$Q"}
           LDS=$(printf '%s' "$PREFIX" | grep -oE "(^|[[:space:]])(-C|--chdir)([[:space:]]+|=)${_TOK}" \
             | sed -E 's/^[[:space:]]*(-C|--chdir)([[:space:]]+|=)//' || true)
           while IFS= read -r LD; do
             [ -n "$LD" ] || continue
             LD=$(_unquote "$LD"); R=$(_resolve "$LD" "$CUR")
             if _outside_wt "$R"; then
               echo "FATAL: <automated> command relocates to $LD -> $R, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
               exit 1
             fi
             CUR=$R
           done <<EOF_LAUNCH_DIRS
$LDS
EOF_LAUNCH_DIRS
           _walk "$T" "$((D+1))"; CUR=$S
         fi ;;
      C|N)
        R=$(_resolve "$T" "$CUR")
        if _outside_wt "$R"; then
          echo "FATAL: <automated> command relocates to $T -> $R, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
          exit 1
        fi
        [ "$K" = C ] && CUR=$R ;;
    esac
  done <<EOF_TARGETS
$_T
EOF_TARGETS
  # 2. Any other absolute word that resolves under the MAIN checkout — a file argument, a redirect,
  # an include — is the same defect by a different verb; system paths such as /dev/null or /usr/bin
  # are neither and pass.
  while IFS= read -r P; do
    [ -n "$P" ] || continue
    P=$(_unquote "$P"); case "$P" in [A-Za-z_]*=*|--*=*) P=${P#*=} ;; esac   # FOO=/x, --flag=/x
    case "$P" in /*) ;; *) continue ;; esac
    R=$(_resolve "$P")
    _outside_wt "$R" || continue
    case "$R" in
      "$MAIN_ROOT"|"$MAIN_ROOT"/*)
        echo "FATAL: <automated> command names $P (-> $R) inside the main checkout, outside the worktree ($WT_ROOT) — it would verify the wrong checkout. Rewrite the plan's command root-relative (cwd is the checkout root); do not rewrite it in place." >&2
        exit 1 ;;
    esac
  done <<EOF_ABS
$(printf '%s' "$CMD" | grep -oE "$_TOK")
EOF_ABS
  return 0; }
# EVERY s-COMMAND THAT INTERPOLATES ONE OF THESE REGEXES USES `#`, NOT `/`. $_EXEC, $_LAUNCH and
# (through $_LAUNCH) $_DIR all contain a literal `/` from their absolute-path groups, and a `/`
# inside the pattern closes an `s/…/…/` early: sed dies `unknown option to 's'` on STDERR inside a
# command substitution, the extracted list comes back EMPTY, and the scan silently stops happening
# while every command reads as a clean pass. It is written as a rule about ALL of them rather than
# about the one that had a slash first, because that is exactly how it recurred: $_EXEC was fixed,
# then $_LAUNCH gained `(/[^[:space:]]*/)?` and took $_DIR down with it. Both driven, not theorised.
# 3. The ordered event scan unwraps each interpreter payload in place, to a bounded depth — a wrapper
# inside a wrapper is still a wrapper, and the bound is what keeps a pathological nest finite.
# A payload the shell would build at run time (`bash -c $CMD`) is not a literal token here and passes
# through as a dynamic_path, exactly as scan 1 treats an expansion.
_walk(){ _scan "$1" "$2"; }
_walk "$AUTOMATED_CMD" 0
