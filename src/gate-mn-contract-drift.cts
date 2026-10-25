/**
 * `gsd_run check mn-contract-drift` — compares a signature DECLARED in the phase's DESIGN.md
 * `## Contracts` against the one actually in the code (mn-verify-gate; replaces
 * capabilities/mn-verify-gate/scripts/contract-drift.mjs).
 *
 * ── The failure it catches ───────────────────────────────────────────────
 *
 * The system admits it in its own words (fragments/plan-pre-design.md): "Nothing in the pipeline
 * typechecks across plans". Wave 1 declares a port returning `EitherAsync<RepoError, Book>`, wave 2
 * calls it as `Promise<Book | null>`; both verify green in isolated worktrees and the mismatch
 * surfaces at integration with no single commit to blame.
 *
 * ── Divergence, not presence ─────────────────────────────────────────────
 *
 * Measured on a live project: nine of nine DESIGN.md files carry no `## Contracts` section, so a
 * gate demanding one would block every phase and be switched off on day one. And presence proves
 * nothing — a template stub passes a presence check and catches no drift. Hence: **a phase that
 * declared no signature passes**; the gate speaks only where declared and actual diverged.
 *
 * Per declared symbol (name + parameter types + return type, normalised: whitespace, line breaks,
 * parameter names, `readonly`/`export`/`declare`/`public`/`abstract`, quote style and trailing `;,`
 * removed; type names, generic arguments, `|`, `&`, `?`, `[]` kept):
 *
 *   match    declared and actual agree
 *   drift    found, signature differs   → FINDING
 *   missing  found in no source file    → FINDING (unfinished work, or a rename no consumer heard of)
 *
 * It does not typecheck — a textual comparison of the normalised form, deliberately: a cross-plan
 * typecheck needs tsc or an LSP over the whole tree. `contracts_superseded: true` (after execution
 * the code IS the contract) skips the phase.
 *
 * The source root is the project directory (`.ts`/`.tsx`, skipping dot-directories, node_modules,
 * dist, build, coverage, .next, .nx, tmp). Declared contracts with no TypeScript to compare against,
 * or a DESIGN.md that exists but cannot be read, is "could not check".
 */

import path from 'node:path';
import { gateUnreadable, gateVerdict } from './gate-verdict.cjs';
import { readDirEntriesEvidence, readDirEvidence, readTextEvidence } from './gate-evidence.cjs';
import type { GateResult, GateVerdict } from './gate-verdict.cjs';
import { MN_GATE_STATUS, mnPayload, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { escapeRegex } from './pattern.cjs';

// This gate's verdicts, built here so its failing arms are visible in its own file to the
// positive-control lint (#5204); gate-mn-support owns the payload shape.
function mnPass(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('pass', false, mnPayload(MN_GATE_STATUS.PASS, message, details));
}
function mnFinding(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateVerdict('block', true, mnPayload(MN_GATE_STATUS.FINDING, message, details));
}
/** Could not look: outcome `unreadable` (exit 69, routed by the gate's `onError`), blocking. */
function mnUnreadable(message: string, details: Record<string, unknown> = {}): GateVerdict {
  return gateUnreadable(true, mnPayload(MN_GATE_STATUS.UNRESOLVABLE, message, details));
}

export interface DeclaredSignature {
  name: string;
  signature: string;
}

/** Split on a top-level separator, never inside <>, (), [], {}. */
function splitTopLevel(str: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function indexOfTopLevel(str: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/** Normalise a signature to its comparable form (see the module header). */
export function normalizeSignature(raw: string): string {
  let s = raw
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(export|declare|public|readonly|abstract)\s+/g, '')
    .replace(/["']/g, "'")
    .trim()
    .replace(/[;,]+$/, '');

  // Parameter names carry no contract: `findById(id: BookId)` and `findById(bookId: BookId)` agree.
  s = s.replace(/\(([^)]*)\)/g, (_m, params: string) => {
    const types = splitTopLevel(params, ',')
      .map((p) => {
        const colon = indexOfTopLevel(p, ':');
        return colon === -1 ? p.trim() : p.slice(colon + 1).trim();
      })
      .filter((p) => p !== '');
    return `(${types.join(',')})`;
  });

  return s.replace(/\s*([(),:|&<>])\s*/g, '$1');
}

/** `{ name, signature }` for each member-or-function line of a ts block body. */
function parseMembers(body: string): DeclaredSignature[] {
  const out: DeclaredSignature[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('*')) continue;
    if (/^(export\s+)?(interface|type|class|enum|namespace)\b/.test(line)) continue;
    if (line === '}' || line === '{') continue;
    const m = /^(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(\([\s\S]*)$/.exec(line);
    if (!m) continue;
    const [, name, rest] = m;
    if (!rest.includes(':')) continue; // no return type, no contract
    out.push({ name, signature: normalizeSignature(`${name}${rest}`) });
  }
  return out;
}

/**
 * The signatures declared in DESIGN.md's `## Contracts` section — its ```ts / ```typescript (or
 * untagged) fences, and nothing else: the rest of the document is prose. [] when there is none.
 */
export function extractDeclaredSignatures(designMd: string): DeclaredSignature[] {
  let inContracts = false;
  let inFence = false;
  const collected: string[] = [];
  for (const line of designMd.split('\n')) {
    if (/^##\s+Contracts\s*$/i.test(line)) {
      inContracts = true;
      continue;
    }
    if (inContracts && /^##\s+/.test(line)) break;
    if (!inContracts) continue;
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim().toLowerCase();
      inFence = !inFence && (lang === 'ts' || lang === 'typescript' || lang === '');
      continue;
    }
    if (inFence) collected.push(line);
  }
  return parseMembers(collected.join('\n'));
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nx', 'tmp']);

/**
 * The `.ts`/`.tsx` sources under `root`, and the paths that could not be read on the way. An
 * unreadable directory or file does not fail the scan — most contracts are found elsewhere — but it is
 * recorded, because a signature that is "missing" may live in it (see `computeContractDrift`).
 */
function collectSourceFiles(root: string, unreadable: string[]): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const listing = readDirEntriesEvidence(dir);
    if (listing.kind === 'unreadable') unreadable.push(`${path.relative(root, dir) || '.'} (${listing.reason})`);
    if (listing.kind !== 'found') continue;
    for (const e of listing.value) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
        continue;
      }
      const ext = path.extname(e.name);
      if (ext === '.ts' || ext === '.tsx') out.push(full);
    }
  }
  return out;
}

/**
 * The first actual signature of `name` in the sources. A contract names symbols that cross a plan
 * boundary — exported and unique in their layer; with a duplicate the first wins, and a false
 * "match" stays impossible because the whole signature must agree. A file that cannot be read is
 * recorded in `unreadable` and skipped.
 */
function findActualSignature(
  name: string,
  files: readonly string[],
  root: string,
  unreadable: string[],
): { signature: string; file: string } | null {
  const mention = new RegExp(`(?:^|[^\\w$])${escapeRegex(name)}\\s*\\(`, 'm');
  const declaration = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s+)?${escapeRegex(name)}\\s*(\\([\\s\\S]*)$`);
  for (const file of files) {
    const source = readTextEvidence(file);
    if (source.kind === 'unreadable') {
      const entry = `${path.relative(root, file)} (${source.reason})`;
      if (!unreadable.includes(entry)) unreadable.push(entry);
    }
    if (source.kind !== 'found') continue;
    const text = source.value;
    if (!mention.test(text)) continue;
    for (const rawLine of text.split('\n')) {
      const m = declaration.exec(rawLine.trim());
      if (!m || !m[1].includes(':')) continue;
      return { signature: normalizeSignature(`${name}${m[1]}`), file };
    }
  }
  return null;
}

/** The phase's design file: `DESIGN.md` or the phase-numbered `NN-DESIGN.md` the architect writes. */
function findDesignFile(phaseDir: string): { file: string | null } | { unreadable: string } {
  const listing = readDirEvidence(phaseDir);
  if (listing.kind === 'unreadable') return { unreadable: listing.reason };
  if (listing.kind === 'none') return { file: null };
  return { file: listing.value.find((f) => f === 'DESIGN.md' || f.endsWith('-DESIGN.md')) ?? null };
}

/** The gate's body against a resolved phase directory; `root` holds the sources. */
export function computeContractDrift(phaseDir: string, root: string): GateResult {
  const located = findDesignFile(phaseDir);
  if ('unreadable' in located) {
    return mnUnreadable(`mn-contract-drift: cannot list ${phaseDir}: ${located.unreadable}`, { phaseDir, readError: located.unreadable });
  }
  const designFile = located.file;
  if (designFile === null) return mnPass('mn-contract-drift: no DESIGN.md — nothing to check', { phaseDir, skipped: 'no-design' });

  const designText = readTextEvidence(path.join(phaseDir, designFile));
  if (designText.kind === 'none') {
    return mnPass('mn-contract-drift: no DESIGN.md — nothing to check', { phaseDir, skipped: 'no-design' });
  }
  if (designText.kind === 'unreadable') {
    return mnUnreadable(`mn-contract-drift: cannot read ${designFile}: ${designText.reason}`, { phaseDir, designFile });
  }
  const design = designText.value;

  if (/^contracts_superseded:\s*true\s*$/m.test(design)) {
    return mnPass('mn-contract-drift: contracts_superseded — the code is the contract now', { phaseDir, designFile, skipped: 'superseded' });
  }

  const declared = extractDeclaredSignatures(design);
  if (declared.length === 0) {
    return mnPass('mn-contract-drift: no declared signatures — nothing to check', { phaseDir, designFile, skipped: 'no-contracts' });
  }

  const unreadable: string[] = [];
  const files = collectSourceFiles(root, unreadable);
  if (files.length === 0) {
    return mnUnreadable(`mn-contract-drift: no .ts/.tsx sources under ${root} — cannot verify ${declared.length} declared signature(s)`, {
      phaseDir,
      designFile,
      declared: declared.length,
    });
  }

  const drift: Array<{ name: string; declared: string; actual: string; file: string }> = [];
  const missing: Array<{ name: string; declared: string }> = [];
  let matched = 0;
  for (const d of declared) {
    const actual = findActualSignature(d.name, files, root, unreadable);
    if (actual === null) missing.push({ name: d.name, declared: d.signature });
    else if (actual.signature === d.signature) matched++;
    else drift.push({ name: d.name, declared: d.signature, actual: actual.signature, file: path.relative(root, actual.file).split(path.sep).join('/') });
  }

  const details = { phaseDir, designFile, declared: declared.length, matched, drift, missing, unreadable };
  // A drifted signature was read and disagrees: a finding whatever else could not be read. A missing
  // one may live in a path that could not be read, so with any such path it is "could not check".
  if (drift.length === 0 && missing.length > 0 && unreadable.length > 0) {
    return mnUnreadable(
      `mn-contract-drift: ${missing.length} declared signature(s) not found (${missing.map((m) => m.name).join(', ')}) and ` +
        `${unreadable.length} source path(s) could not be read — they may be declared there: ${unreadable.join('; ')}`,
      details,
    );
  }
  if (drift.length === 0 && missing.length === 0) {
    return mnPass(`mn-contract-drift: OK — ${matched} declared signature(s) match the code`, details);
  }
  return mnFinding(
    `mn-contract-drift: ${drift.length} drifted, ${missing.length} missing, ${matched} matched ` +
      `(${[...drift.map((d) => d.name), ...missing.map((m) => m.name)].join(', ')}) — a contract that no longer ` +
      'describes the code will mislead the next wave that reads it. Fix the code, or update DESIGN.md and say why.',
    details,
  );
}

/** `gsd_run check mn-contract-drift <phase>` — the source root is the project directory. */
export function evaluateMnContractDrift(input: MnGateInput): GateResult {
  return withMnPhase('mn-contract-drift', input, ({ phaseDir }) => computeContractDrift(phaseDir, input.projectDir));
}
