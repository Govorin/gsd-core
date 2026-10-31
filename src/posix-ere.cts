/**
 * posix-ere.cts — `grep -oE` / `sed -E 's/…//'` semantics over POSIX extended
 * regular expressions, for the step 0c port (ADR-5211).
 *
 * ## Why this module exists
 *
 * The step 0c `<automated>` containment guard (`automated-command-containment.cts`)
 * was a bash script built on `grep -oE` and `sed -E`. Its expressions are POSIX
 * EREs, and POSIX defines a match as the LEFTMOST-LONGEST one: among all matches
 * starting at the leftmost possible position, the longest wins. JavaScript's
 * RegExp is leftmost-FIRST — the first alternative that lets the rest succeed
 * wins, even when a later alternative would match more. The guard's own design
 * depends on the POSIX rule ("`_EXEC` is longer than `_DIR`, so a wrapper reached
 * through `env -C` wins grep's leftmost-longest match"), and its token grammar
 * has overlapping alternatives (`\\.` against a bare class that also admits `\`).
 * Translating the expressions to RegExp would silently change which text a scan
 * extracts. So the expressions are kept verbatim and evaluated by the vendored
 * RE2 engine (`vendor/re2js.cjs`, already the repo's linear-time engine for
 * untrusted patterns — see pattern.cts) with its LONGEST_MATCH flag, which gives
 * exactly POSIX's leftmost-longest overall match. Linear time also means a
 * hostile command cannot blow the scan up.
 *
 * This module adds only grep's framing: input is scanned line by line, empty
 * matches print nothing, and after a match the scan resumes at its end.
 */

import { RE2JS } from './vendor/re2js.cjs';

type Compiled = ReturnType<typeof RE2JS.compile>;

const COMPILE_CACHE = new Map<string, Compiled>();

/** Compile an ERE for leftmost-longest matching. Throws on syntax RE2 rejects. */
export function compileEre(pattern: string): Compiled {
  const cached = COMPILE_CACHE.get(pattern);
  if (cached) return cached;
  const compiled = RE2JS.compile(pattern, RE2JS.LONGEST_MATCH);
  COMPILE_CACHE.set(pattern, compiled);
  return compiled;
}

/** One match within a single line: UTF-16 offsets plus the text. */
export interface EreMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * `grep -oE` over ONE line: every non-empty, non-overlapping leftmost-longest
 * match, in order.
 */
export function matchAllInLine(pattern: string, line: string): EreMatch[] {
  const m = compileEre(pattern).matcher(line);
  const out: EreMatch[] = [];
  while (m.find()) {
    const start = m.start();
    const end = m.end();
    if (end > start) out.push({ start, end, text: line.slice(start, end) });
  }
  return out;
}

/**
 * `printf '%s' "$text" | grep -oE pattern`: every match of every line, in order —
 * what grep prints, one match per element.
 */
export function grepOnlyMatching(pattern: string, text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    for (const m of matchAllInLine(pattern, line)) out.push(m.text);
  }
  return out;
}

/**
 * The match of a `^`-anchored pattern at the start of `line`, or null — the
 * `printf '%s' "$line" | grep -oE "^…"` classification the guard runs.
 */
export function matchPrefix(pattern: string, line: string): string | null {
  const ms = matchAllInLine(pattern, line);
  if (ms.length === 0 || ms[0].start !== 0) return null;
  return ms[0].text;
}

/** `sed -E "s/<pattern>//"` on one line: remove the FIRST match (no `g`). */
export function deleteFirstMatch(pattern: string, line: string): string {
  const m = compileEre(pattern).matcher(line);
  if (!m.find()) return line;
  return line.slice(0, m.start()) + line.slice(m.end());
}
