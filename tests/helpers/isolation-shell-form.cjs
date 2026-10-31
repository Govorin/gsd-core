'use strict';

/**
 * A conservative model of the shell forms Claude Code ≥ 2.1.310 refuses inside an
 * `isolation: "worktree"` agent (ADR-5211), from the probe table in
 * `.plans/worktree-isolation-verifier.md`. It lints OUR mandatory blocks — the text a
 * worktree sub-agent is told to run — not arbitrary shell: every rule over-approximates
 * the host's check, so a block that passes here passes there.
 *
 * Refused (each a rule id):
 * - `command-substitution` — `$(…)` or a backtick anywhere outside single quotes
 *   (`X=$(git rev-parse …)` is refused; node inside `$( )` happens to pass, but no
 *   mandatory block needs a capture, so the model stays strict);
 * - `computed-argument` — `$NAME` / `${…}` in the arguments of git, node or sed;
 * - `cd-chain` — `cd … &&` (a cd chained to the next command);
 * - `git-dash-C` — `git -C <dir>`;
 * - `unbound-placeholder` — a `{UPPER_CASE}` dispatch placeholder left unsubstituted.
 *
 * It lives with the tests, not in src/: nothing at runtime consults it.
 */

const RULES = Object.freeze(['command-substitution', 'computed-argument', 'cd-chain', 'git-dash-C', 'unbound-placeholder']);

/** Split one line into command segments at unquoted `&&`, `||`, `;`, `|`, `&`. */
function segments(line) {
  const out = [];
  let cur = '';
  let q = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === q) q = '';
      else if (c === '\\' && q === '"') { cur += c + (line[i + 1] ?? ''); i += 1; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === '\\') { cur += c + (line[i + 1] ?? ''); i += 1; continue; }
    if (c === '&' || c === '|' || c === ';') {
      const two = line.slice(i, i + 2);
      out.push({ text: cur.trim(), op: two === '&&' || two === '||' ? two : c });
      if (two === '&&' || two === '||') i += 1;
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '') out.push({ text: cur.trim(), op: null });
  return out;
}

/** Text outside single quotes (the only quoting that stops `$` and backticks). */
function unquotedText(s) {
  let out = '';
  let inSingle = false;
  for (const c of s) {
    if (c === "'") { inSingle = !inSingle; continue; }
    if (!inSingle) out += c;
  }
  return out;
}

/** The command word of a segment, after leading NAME=value assignments. */
function commandWord(seg) {
  const words = seg.split(/\s+/);
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) k += 1;
  return { word: words[k] ?? '', rest: words.slice(k + 1) };
}

/**
 * Classify a script (one or more lines). Comments and blank lines are ignored.
 * @returns {{ ok: boolean, violations: { line: string, rule: string }[] }}
 */
function classifyIsolationShellForm(script) {
  const violations = [];
  for (const raw of String(script).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const bare = unquotedText(line);
    if (bare.includes('$(') || bare.includes('`')) violations.push({ line, rule: 'command-substitution' });
    if (/\{[A-Z][A-Z0-9_]*\}/.test(line)) violations.push({ line, rule: 'unbound-placeholder' });
    const segs = segments(line);
    segs.forEach((seg, i) => {
      const { word, rest } = commandWord(seg.text);
      const base = word.split('/').pop();
      if (['git', 'node', 'sed'].includes(base) && /\$[A-Za-z_{(]/.test(unquotedText(rest.join(' ')))) {
        violations.push({ line, rule: 'computed-argument' });
      }
      if (base === 'git' && rest.includes('-C')) violations.push({ line, rule: 'git-dash-C' });
      if (base === 'cd' && seg.op === '&&' && i < segs.length - 1) violations.push({ line, rule: 'cd-chain' });
    });
  }
  return { ok: violations.length === 0, violations };
}

module.exports = { classifyIsolationShellForm, RULES };
