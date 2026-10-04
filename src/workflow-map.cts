/**
 * Workflow Map Module — the logic of a shipped workflow (`gsd-core/workflows/*.md`)
 * as data, and as mermaid diagrams built from that data (phase 5.5 of the
 * upstream sync).
 *
 * ── What is drawn, and why nothing else ──
 *
 * A node is something that EXISTS in the markdown: a `<step name=…>` block, a
 * `<!-- gsd:section id when -->` fragment, or — in a workflow with no steps — an
 * H2 heading of its `<process>`. An agent node is a `subagent_type` argument of
 * an `Agent(` call, checked against the real `agents/*.md`, the runtime
 * built-ins and the capability registry. A loop-point node is a
 * `loop render-hooks <point>` call, checked against `LOOP_HOST_CONTRACT`; the
 * capability steps hung on it come from the registry's `byLoopPoint`.
 *
 * Edges are only the deterministic ones: document order, the step's
 * `condition` / the section's `when` (as the label of the edge into it), and a
 * prose jump ("go to …", "proceed to …") whose target NAMES a real unit — a
 * step name, a section id, or the number of a numbered heading. Prose
 * transitions are mostly "step 5", "the next step", "Route A": they cannot be
 * resolved, so they are COUNTED (`unresolvedJumps`) instead of drawn. A guessed
 * arrow would be a valid-looking diagram stating something the file does not.
 *
 * Defects are drawn, not dropped: an `Agent(` with an unknown `subagent_type`,
 * a jump to a snake_case name no unit carries, a `render-hooks` point outside
 * the contract, a referenced workflow file that does not exist, a step opened
 * and never closed, a spawn written in prose because a fence is broken, a
 * manifest/marker mismatch of a section.
 *
 * ── Parsing goes through the canonical primitives ──
 *
 * Steps: `scanTaggedBlocks` (the positioned form of `extractTaggedBlocks`).
 * Sections: `parseWorkflowSections` (the grammar owner). Headings:
 * `tokenizeHeadings`. Code vs prose: `scanFencedBlocks` + `scanInlineCodeSpans`
 * — so an `Agent()` mentioned in a sentence is not a spawn, while
 * `Agent(subagent_type="gsd-x", …)` in a fence or in inline code is.
 *
 * The module is pure: the caller hands in the workflow text, the reference
 * sets (agents, loop points, capability hooks, section manifest) and a
 * `readFile` for referenced fragment files. `scripts/gen-workflow-maps.cjs`
 * does the I/O.
 *
 * ADR-457 build-at-publish: source in src/workflow-map.cts, compiled to
 * gsd-core/bin/lib/workflow-map.cjs (gitignored).
 */

import { createIdRegistry, derivedMarker, fence, flowchart } from './mermaid.cjs';
import type { ClassDef, FlowEdge, FlowNode, FlowSubgraph, FlowchartSpec } from './mermaid.cjs';
import { scanFencedBlocks, scanInlineCodeSpans, scanTaggedBlocks, tokenizeHeadings } from './markdown-sectionizer.cjs';
import { parseWorkflowSections } from './workflow-fragments.cjs';
import { normalizeEol, splitLines } from './text-lines.cjs';

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Agents every runtime provides without an `agents/*.md` file. */
export const BUILTIN_AGENTS: readonly string[] = Object.freeze(['general-purpose']);

/** One capability step hung on a loop point (`byLoopPoint[point].steps[]`). */
export interface LoopHookStep {
  capId: string;
  ref: { agent?: string; skill?: string; command?: string };
}

/** What the registry says about one loop point. */
export interface LoopPointHooks {
  steps: readonly LoopHookStep[];
  gates: number;
  contributions: number;
}

/** A `section-manifest.json` entry of one workflow. */
export interface ManifestEntry {
  id: string;
  when: string;
  read: string;
}

export interface WorkflowMapContext {
  /** Basenames of `agents/*.md`. */
  agents: ReadonlySet<string>;
  /** Agents a capability ships (`capability-registry` `byAgent` keys). */
  capabilityAgents: ReadonlySet<string>;
  /** Defaults to `BUILTIN_AGENTS`. */
  builtinAgents?: ReadonlySet<string>;
  /** Every point of `LOOP_HOST_CONTRACT`. */
  loopPoints: ReadonlySet<string>;
  /** `byLoopPoint`, reduced to what the map draws. */
  loopHooks: Readonly<Record<string, LoopPointHooks>>;
  /** This workflow's `section-manifest.json` entries (empty when it has none). */
  manifest: readonly ManifestEntry[];
  /** Repo-relative path → text, or null when the file does not exist. */
  readFile(relPath: string): string | null;
}

export interface WorkflowSource {
  /** Workflow name — the file's basename without `.md`. */
  name: string;
  /** Repo-relative path, e.g. `gsd-core/workflows/execute-phase.md`. */
  path: string;
  text: string;
}

// ─── Model ───────────────────────────────────────────────────────────────────

export type UnitKind = 'step' | 'section' | 'heading';

export interface WorkflowUnit {
  /** Unique within the map: `step:<name>`, `section:<id>`, `heading:<text>` (`#2`… on a repeat). */
  key: string;
  kind: UnitKind;
  /** The step name, the section id, or the heading text — exactly as written. */
  name: string;
  attrs: { condition?: string; priority?: string; required?: string; when?: string };
  /** Position in document order, from 0. */
  order: number;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** A `<step>` opener with no well-formed block (it never closes before the next step). */
  malformed: boolean;
  /** A numbered heading's number (`5.5`, `9a`), for `step 5.5` jumps and grouping. */
  number: string | null;
}

/** Where an agent name is defined; null = nowhere (an `unknown-agent` defect). */
export type AgentRegistry = 'agents' | 'capability' | 'builtin' | null;

export type SpawnTarget =
  | { kind: 'agent'; name: string; registry: 'agents' | 'capability' | null }
  | { kind: 'builtin'; name: string }
  /** `{EXECUTOR_TYPE}`: candidates only when every assignment of the variable is a literal. */
  | { kind: 'dynamic'; expr: string; candidates: { name: string; registry: AgentRegistry }[] }
  /** `ref.agent` of a capability hook: resolved through the loop points the same unit renders. */
  | { kind: 'capability-hook'; expr: string; points: string[] };

export type CodeLocation = 'fence' | 'inline' | 'prose';

export interface Spawn {
  /** Unit key, or null for text outside every unit. */
  unit: string | null;
  target: SpawnTarget;
  /** Repo-relative file the call is written in (the workflow or a fragment it reads). */
  file: string;
  line: number;
  location: CodeLocation;
}

export interface Jump {
  unit: string | null;
  /** The matched phrase, e.g. `proceed to \`execute_waves\``. */
  raw: string;
  /** The named token (`execute_waves`, `5.5`), or null when the phrase names nothing. */
  token: string | null;
  /** Unit key of the target, or null. */
  to: string | null;
  resolved: boolean;
  line: number;
}

export interface LoopPointCall {
  unit: string | null;
  point: string;
  known: boolean;
  file: string;
  line: number;
}

export interface Include {
  unit: string | null;
  /** Repo-relative path of the referenced file. */
  path: string;
  /** `workflow`: another top-level workflow; `fragment`: a file under a workflow's sub-directory. */
  kind: 'workflow' | 'fragment';
  exists: boolean;
  /** File the reference is written in. */
  file: string;
  line: number;
}

export type WorkflowMapDefectKind =
  | 'unknown-agent'
  | 'spawn-in-prose'
  | 'dangling-jump'
  | 'unknown-point'
  | 'missing-include'
  | 'orphan-fragment'
  | 'nested-step'
  | 'section-grammar';

export interface WorkflowMapDefect {
  kind: WorkflowMapDefectKind;
  unit: string | null;
  /** The offending name / path / id. */
  subject: string;
  file: string;
  line: number | null;
  message: string;
}

export interface WorkflowMap {
  workflow: string;
  path: string;
  units: WorkflowUnit[];
  spawns: Spawn[];
  jumps: Jump[];
  loopPoints: LoopPointCall[];
  includes: Include[];
  defects: WorkflowMapDefect[];
  /** Prose transitions that do not name a real unit — counted, never drawn. */
  unresolvedJumps: number;
}

// ─── Text helpers ────────────────────────────────────────────────────────────

const WORKFLOWS_DIR = 'gsd-core/workflows/';

/** Bounded walk for an `Agent(` argument list — a call longer than this is not one call. */
export const MAX_CALL_CHARS = 6000;

/** Depth of fragment-reads-fragment chains followed (they are one or two deep in practice). */
export const MAX_INCLUDE_DEPTH = 4;

interface ScannedText {
  file: string;
  text: string;
  lines: string[];
  /** Offset of each line's first character. */
  lineStarts: number[];
  /** 0-based line index → true when the line is inside a fenced block (delimiters included). */
  fenced: boolean[];
}

function scanText(file: string, raw: string): ScannedText {
  const text = normalizeEol(raw);
  const lines = splitLines(text);
  const lineStarts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1;
  }
  const fenced = new Array<boolean>(lines.length).fill(false);
  for (const b of scanFencedBlocks(lines)) {
    const last = b.closeLineIdx === -1 ? lines.length - 1 : b.closeLineIdx;
    for (let i = b.openLineIdx; i <= last; i++) fenced[i] = true;
  }
  return { file, text, lines, lineStarts, fenced };
}

/** 0-based line index of a string offset. */
function lineIndexOf(s: ScannedText, offset: number): number {
  let lo = 0;
  let hi = s.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where an offset sits: inside a fenced block, inside an inline code span, or in prose. */
function locationOf(s: ScannedText, offset: number): CodeLocation {
  const idx = lineIndexOf(s, offset);
  if (s.fenced[idx]) return 'fence';
  const col = offset - s.lineStarts[idx];
  const inSpan = scanInlineCodeSpans(s.lines[idx]).some((span) => col >= span.start && col < span.end);
  return inSpan ? 'inline' : 'prose';
}

/** `key="value"` pairs of an opening tag. */
function parseTagAttributes(attributes: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of attributes.matchAll(/([A-Za-z][\w-]{0,40})\s{0,4}=\s{0,4}"([^"\n]{0,400})"/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

/** `5.5. Create Validation Strategy` → `5.5`; `Step 3b: …` → `3b`; unnumbered → null. */
function headingNumber(text: string): string | null {
  const m = /^(?:step\s{1,4})?(\d{1,3}(?:\.\d{1,3}){0,3}[a-z]?)(?=[.:)\s]|$)/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// ─── Units ───────────────────────────────────────────────────────────────────

interface UnitDraft extends Omit<WorkflowUnit, 'key' | 'order'> {
  baseKey: string;
}

function stepUnits(s: ScannedText, defects: WorkflowMapDefect[]): UnitDraft[] {
  const drafts: UnitDraft[] = [];
  const blocks = scanTaggedBlocks(s.text, 'step', true);
  const blockStarts = new Set(blocks.map((b) => b.start));
  for (const b of blocks) {
    const attrs = parseTagAttributes(b.attributes);
    const name = attrs.get('name') ?? '';
    drafts.push({
      baseKey: `step:${name}`,
      kind: 'step',
      name,
      attrs: pickAttrs(attrs, ['condition', 'priority', 'required']),
      startLine: lineIndexOf(s, b.start) + 1,
      endLine: lineIndexOf(s, b.end - 1) + 1,
      malformed: false,
      number: null,
    });
  }
  // An opener that starts no block never closed before the next `<step`.
  const openers = [...s.text.matchAll(/<step(?:\s[^>]{0,1000})?>/g)].map((m) => ({
    offset: m.index ?? 0,
    attrs: parseTagAttributes(m[0].slice(5, -1)),
  }));
  openers.forEach((o, i) => {
    if (blockStarts.has(o.offset)) return;
    const name = o.attrs.get('name') ?? '';
    const startLine = lineIndexOf(s, o.offset) + 1;
    const next = openers[i + 1];
    const endLine = next ? lineIndexOf(s, next.offset) : s.lines.length;
    drafts.push({
      baseKey: `step:${name}`,
      kind: 'step',
      name,
      attrs: pickAttrs(o.attrs, ['condition', 'priority', 'required']),
      startLine,
      endLine,
      malformed: true,
      number: null,
    });
    defects.push({
      kind: 'nested-step',
      unit: `step:${name}`,
      subject: name,
      file: s.file,
      line: startLine,
      message: `шаг ${name} открыт, но не закрыт до начала следующего шага (строка ${startLine})`,
    });
  });
  return drafts;
}

function pickAttrs(attrs: Map<string, string>, names: readonly ('condition' | 'priority' | 'required')[]): WorkflowUnit['attrs'] {
  const out: WorkflowUnit['attrs'] = {};
  for (const n of names) {
    const v = attrs.get(n);
    if (v !== undefined) out[n] = v;
  }
  return out;
}

function sectionUnits(s: ScannedText, ctx: WorkflowMapContext, defects: WorkflowMapDefect[]): UnitDraft[] {
  let sections;
  try {
    sections = parseWorkflowSections(s.text, s.file);
  } catch (err) {
    const e = err as { reason?: string; message?: string };
    defects.push({
      kind: 'section-grammar',
      unit: null,
      subject: e.reason ?? 'error',
      file: s.file,
      line: null,
      message: `разметка gsd:section не разбирается: ${e.message ?? String(err)}`,
    });
    return [];
  }
  const explicit = sections.filter((x) => x.explicit);
  const drafts = explicit.map((x): UnitDraft => {
    const bodyLines = splitLines(x.body.replace(/\n$/, '')).length;
    return {
      baseKey: `section:${x.id}`,
      kind: 'section',
      name: x.id,
      attrs: { when: x.when },
      startLine: x.startLine,
      endLine: x.startLine + bodyLines - 1,
      malformed: false,
      number: null,
    };
  });
  const markerIds = new Set(explicit.map((x) => x.id));
  const manifestIds = new Set(ctx.manifest.map((e) => e.id));
  for (const id of manifestIds) {
    if (!markerIds.has(id)) {
      defects.push({
        kind: 'orphan-fragment', unit: null, subject: id, file: s.file, line: null,
        message: `секция ${id} есть в section-manifest.json, но маркера gsd:section в workflow нет`,
      });
    }
  }
  for (const x of explicit) {
    if (!manifestIds.has(x.id)) {
      defects.push({
        kind: 'orphan-fragment', unit: `section:${x.id}`, subject: x.id, file: s.file, line: x.startLine,
        message: `маркер gsd:section ${x.id} не записан в section-manifest.json`,
      });
    }
  }
  return drafts;
}

/** H2 headings of the `<process>` block(s) — or of the whole file when it has none. */
function headingUnits(s: ScannedText): UnitDraft[] {
  const process = scanTaggedBlocks(s.text, 'process').map((b) => [lineIndexOf(s, b.start) + 1, lineIndexOf(s, b.end - 1) + 1]);
  const within = (line: number): [number, number] | null => {
    if (process.length === 0) return [1, s.lines.length];
    const hit = process.find(([a, z]) => line >= a && line <= z);
    return hit ? [hit[0], hit[1]] : null;
  };
  const h2 = tokenizeHeadings(s.text).filter((h) => h.level === 2 && within(h.line) !== null);
  return h2.map((h, i): UnitDraft => {
    const [, blockEnd] = within(h.line) as [number, number];
    const next = h2[i + 1];
    const endLine = next && next.line <= blockEnd ? next.line - 1 : blockEnd;
    return {
      baseKey: `heading:${h.text}`,
      kind: 'heading',
      name: h.text,
      attrs: {},
      startLine: h.line,
      endLine,
      malformed: false,
      number: headingNumber(h.text),
    };
  });
}

function finalizeUnits(drafts: UnitDraft[]): WorkflowUnit[] {
  const sorted = [...drafts].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  const seen = new Map<string, number>();
  return sorted.map((d, order) => {
    const n = (seen.get(d.baseKey) ?? 0) + 1;
    seen.set(d.baseKey, n);
    const { baseKey, ...rest } = d;
    return { ...rest, key: n === 1 ? baseKey : `${baseKey}#${n}`, order };
  });
}

/** The innermost unit whose span holds `line` (a section inside a step wins over the step). */
function unitAt(units: readonly WorkflowUnit[], line: number): string | null {
  let best: WorkflowUnit | null = null;
  for (const u of units) {
    if (line < u.startLine || line > u.endLine) continue;
    if (best === null || u.endLine - u.startLine < best.endLine - best.startLine) best = u;
  }
  return best ? best.key : null;
}

// ─── Spawns, loop points, includes (in a file and the fragments it reads) ────

interface RawSpawn {
  value: string;
  quoted: boolean;
  offset: number;
  location: CodeLocation;
}

/** Every `Agent(` call that passes `subagent_type`, with the argument's value. */
function scanSpawns(s: ScannedText): RawSpawn[] {
  const out: RawSpawn[] = [];
  for (const m of s.text.matchAll(/\bAgent\(/g)) {
    const open = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let end = open;
    const limit = Math.min(s.text.length, open + MAX_CALL_CHARS);
    while (end < limit && depth > 0) {
      const ch = s.text[end];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      end++;
    }
    const args = s.text.slice(open, end);
    const a = /\bsubagent_type\s{0,4}[=:]\s{0,4}(?:"([^"\n]{1,120})"|'([^'\n]{1,120})'|([A-Za-z_{$][\w.{}$]{0,120}))/.exec(args);
    if (!a) continue;
    const quotedValue = a[1] ?? a[2];
    out.push({
      value: (quotedValue ?? a[3]).trim(),
      quoted: quotedValue !== undefined,
      offset: m.index ?? 0,
      location: locationOf(s, m.index ?? 0),
    });
  }
  return out;
}

const POINT_RE = /^[a-z]{1,20}(?::[a-z]{1,20}){1,2}$/;

function scanLoopPoints(s: ScannedText): { point: string; offset: number }[] {
  const out: { point: string; offset: number }[] = [];
  for (const m of s.text.matchAll(/\bloop\s{1,4}render-hooks\s{1,4}([A-Za-z0-9:_-]{1,60})/g)) {
    const offset = m.index ?? 0;
    if (locationOf(s, offset) === 'prose') continue;
    if (!POINT_RE.test(m[1])) continue;
    out.push({ point: m[1], offset });
  }
  return out;
}

function scanIncludes(s: ScannedText): { path: string; offset: number }[] {
  const out: { path: string; offset: number }[] = [];
  for (const m of s.text.matchAll(/gsd-core\/workflows\/([A-Za-z0-9_][A-Za-z0-9_./-]{0,200}?\.md)(?![A-Za-z0-9_-])/g)) {
    const rel = m[1];
    if (rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) continue;
    out.push({ path: WORKFLOWS_DIR + rel, offset: m.index ?? 0 });
  }
  return out;
}

/** `NAME=value` assignments in fenced code: the literal values, or null when any is computed. */
function literalAssignments(texts: readonly ScannedText[], name: string): string[] | null {
  const values: string[] = [];
  let seen = false;
  for (const s of texts) {
    s.lines.forEach((line, i) => {
      if (!s.fenced[i]) return;
      const m = /^\s{0,8}(?:export\s{1,4}|local\s{1,4})?([A-Z_][A-Z0-9_]{0,60})=(.{0,400})$/.exec(line);
      if (!m || m[1] !== name) return;
      seen = true;
      const lit = /^(?:"([\w-]{1,80})"|'([\w-]{1,80})'|([\w-]{1,80}))\s{0,4}(?:#.{0,200})?$/.exec(m[2].trim());
      if (lit === null) {
        values.push('\u0000');
        return;
      }
      const v = lit[1] ?? lit[2] ?? lit[3];
      if (!values.includes(v)) values.push(v);
    });
  }
  if (!seen || values.includes('\u0000')) return null;
  return values;
}

interface Collected {
  spawns: RawSpawnAt[];
  points: { point: string; file: string; line: number; anchorLine: number }[];
  includes: { path: string; kind: Include['kind']; exists: boolean; file: string; line: number; anchorLine: number }[];
  texts: ScannedText[];
  includedStepNames: Set<string>;
}

interface RawSpawnAt extends RawSpawn {
  file: string;
  line: number;
  /** Line in the WORKFLOW file the spawn is attributed by (the include's line for a fragment). */
  anchorLine: number;
}

function collect(
  main: ScannedText,
  self: string,
  ctx: WorkflowMapContext,
  extra: readonly { path: string; anchorLine: number; endLine: number }[],
): Collected {
  const out: Collected = { spawns: [], points: [], includes: [], texts: [main], includedStepNames: new Set() };
  const cache = new Map<string, ScannedText | null>();
  const load = (p: string): ScannedText | null => {
    if (!cache.has(p)) {
      const raw = ctx.readFile(p);
      cache.set(p, raw === null ? null : scanText(p, raw));
    }
    return cache.get(p) ?? null;
  };

  const visit = (s: ScannedText, anchorFor: (offset: number) => number, depth: number, chain: ReadonlySet<string>): void => {
    for (const sp of scanSpawns(s)) {
      out.spawns.push({ ...sp, file: s.file, line: lineIndexOf(s, sp.offset) + 1, anchorLine: anchorFor(sp.offset) });
    }
    for (const lp of scanLoopPoints(s)) {
      out.points.push({ point: lp.point, file: s.file, line: lineIndexOf(s, lp.offset) + 1, anchorLine: anchorFor(lp.offset) });
    }
    for (const inc of scanIncludes(s)) {
      if (inc.path === self) continue;
      const rest = inc.path.slice(WORKFLOWS_DIR.length);
      const kind: Include['kind'] = rest.includes('/') ? 'fragment' : 'workflow';
      const target = load(inc.path);
      const anchorLine = anchorFor(inc.offset);
      out.includes.push({ path: inc.path, kind, exists: target !== null, file: s.file, line: lineIndexOf(s, inc.offset) + 1, anchorLine });
      if (kind !== 'fragment' || target === null || chain.has(inc.path) || depth >= MAX_INCLUDE_DEPTH) continue;
      if (!out.texts.includes(target)) {
        out.texts.push(target);
        for (const b of scanTaggedBlocks(target.text, 'step', true)) {
          const n = parseTagAttributes(b.attributes).get('name');
          if (n) out.includedStepNames.add(n);
        }
      }
      visit(target, () => anchorLine, depth + 1, new Set([...chain, inc.path]));
    }
  };

  visit(main, (offset) => lineIndexOf(main, offset) + 1, 0, new Set([self]));
  // A section whose manifest fragment the body never names still reads it.
  for (const e of extra) {
    if (out.includes.some((i) => i.path === e.path && i.anchorLine >= e.anchorLine && i.anchorLine <= e.endLine)) continue;
    const target = load(e.path);
    out.includes.push({ path: e.path, kind: 'fragment', exists: target !== null, file: main.file, line: e.anchorLine, anchorLine: e.anchorLine });
    if (target !== null) {
      if (!out.texts.includes(target)) out.texts.push(target);
      visit(target, () => e.anchorLine, 1, new Set([self, e.path]));
    }
  }
  return out;
}

// ─── Jumps ───────────────────────────────────────────────────────────────────

const JUMP_RE =
  /\b(?:go(?:es)?(?:\s{1,4}back)?\s{1,4}to|proceed(?:s)?(?:\s{1,4}directly)?\s{1,4}to|skip(?:s)?(?:\s{1,4}ahead)?\s{1,4}to|jump(?:s)?\s{1,4}to|continue(?:s)?\s{1,4}(?:on\s{1,4})?(?:to|with)|return(?:s)?\s{1,4}to|loop(?:s)?\s{1,4}back\s{1,4}to|route(?:s)?\s{1,4}to|advance(?:s)?\s{1,4}to|move(?:s)?\s{1,4}on\s{1,4}to|resume(?:s)?\s{1,4}at)\s{1,4}(?:the\s{1,4})?(?:\*\*)?(?=([^\n]{0,80}))/gi;
const RU_JUMP_RE = /(?:перейди|переходи|перейти)\s{1,4}к\s{1,4}(?:шагу\s{1,4})?(?=([^\n]{0,80}))/gi;
/** "the next step", "the following step": position words, not names. */
const RELATIVE_STEP_WORDS: ReadonlySet<string> = new Set(['next', 'previous', 'following', 'same', 'current', 'final', 'that', 'this', 'each', 'appropriate', 'relevant']);
const SNAKE_RE = /^[a-z][a-z0-9]{0,40}(?:_[a-z0-9]{1,40}){1,10}$/;

/** The name a jump phrase's tail points at, if it names anything. */
function jumpToken(tail: string): string | null {
  let m = /^`([^`\n]{1,80})`/.exec(tail);
  if (m) return m[1].replace(/\(\)$/, '').trim();
  m = /^(?:step|section|шаг)\s{1,4}(\d{1,3}(?:\.\d{1,3}){0,3}[a-z]?)\b/i.exec(tail);
  if (m) return m[1].toLowerCase();
  m = /^([a-z][a-z0-9]{0,40}(?:_[a-z0-9]{1,40}){1,10})\b/.exec(tail);
  if (m) return m[1];
  m = /^([a-z][a-z0-9_-]{1,60})\s{1,4}step\b/i.exec(tail);
  if (m && !RELATIVE_STEP_WORDS.has(m[1].toLowerCase())) return m[1];
  return null;
}

function scanJumps(s: ScannedText, units: readonly WorkflowUnit[], includedStepNames: ReadonlySet<string>, defects: WorkflowMapDefect[]): Jump[] {
  const byName = new Map<string, string>();
  const byNumber = new Map<string, string>();
  for (const u of units) {
    if (u.kind !== 'heading' && !byName.has(u.name)) byName.set(u.name, u.key);
    if (u.number !== null && !byNumber.has(u.number)) byNumber.set(u.number, u.key);
  }
  const jumps: Jump[] = [];
  s.lines.forEach((line, i) => {
    if (s.fenced[i]) return;
    for (const re of [JUMP_RE, RU_JUMP_RE]) {
      for (const m of line.matchAll(re)) {
        const token = jumpToken(m[1]);
        const to = token === null ? null : byName.get(token) ?? byNumber.get(token.toLowerCase()) ?? null;
        const unit = unitAt(units, i + 1);
        // The match is the phrase alone (the tail is a lookahead), so a second phrase on the line is found too.
        const raw = m[0] + m[1].split(/[.,;:—](?:\s|$)/)[0];
        jumps.push({ unit, raw: raw.trim(), token, to, resolved: to !== null, line: i + 1 });
        if (to === null && token !== null && SNAKE_RE.test(token) && !includedStepNames.has(token)) {
          defects.push({
            kind: 'dangling-jump', unit, subject: token, file: s.file, line: i + 1,
            message: `переход к «${token}» (строка ${i + 1}), такого шага в workflow нет`,
          });
        }
      }
    }
  });
  return jumps;
}

// ─── parseWorkflow ───────────────────────────────────────────────────────────

/** First occurrence of each key, in input order. */
function uniqueBy<T>(items: readonly T[], key: (item: T) => readonly unknown[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = JSON.stringify(key(item));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The map of one workflow. Pure: everything outside `source.text` comes in
 * through `ctx` (including `readFile` for the fragments the workflow reads).
 */
export function parseWorkflow(source: WorkflowSource, ctx: WorkflowMapContext): WorkflowMap {
  const main = scanText(source.path, source.text);
  const defects: WorkflowMapDefect[] = [];
  const builtins = ctx.builtinAgents ?? new Set(BUILTIN_AGENTS);

  const steps = stepUnits(main, defects);
  const sections = sectionUnits(main, ctx, defects);
  const primary = steps.length > 0 ? steps : headingUnits(main);
  const units = finalizeUnits([...primary, ...sections]);

  const manifestReads = units
    .filter((u) => u.kind === 'section')
    .flatMap((u) => ctx.manifest.filter((e) => e.id === u.name).map((e) => ({ path: e.read, anchorLine: u.startLine, endLine: u.endLine })));
  const c = collect(main, source.path, ctx, manifestReads);

  // A fragment read twice by one unit is one set of calls, not two.
  const loopPoints: LoopPointCall[] = uniqueBy(
    c.points.map((p) => ({
      unit: unitAt(units, p.anchorLine),
      point: p.point,
      known: ctx.loopPoints.has(p.point),
      file: p.file,
      line: p.line,
    })),
    (p) => [p.unit, p.file, p.line, p.point],
  );
  for (const lp of loopPoints) {
    if (lp.known) continue;
    defects.push({
      kind: 'unknown-point', unit: lp.unit, subject: lp.point, file: lp.file, line: lp.line,
      message: `render-hooks ${lp.point} (${lp.file}:${lp.line}): такой точки нет в LOOP_HOST_CONTRACT`,
    });
  }

  const spawns: Spawn[] = uniqueBy(
    c.spawns.map((sp) => {
      const unit = unitAt(units, sp.anchorLine);
      return { unit, target: resolveSpawnTarget(sp, unit, loopPoints, c.texts, ctx, builtins), file: sp.file, line: sp.line, location: sp.location };
    }),
    (sp) => [sp.unit, sp.file, sp.line],
  );
  for (const sp of spawns) {
    const unknown =
      sp.target.kind === 'agent' && sp.target.registry === null
        ? [sp.target.name]
        : sp.target.kind === 'dynamic'
          ? sp.target.candidates.filter((c) => c.registry === null).map((c) => c.name)
          : [];
    for (const name of unknown) {
      defects.push({
        kind: 'unknown-agent', unit: sp.unit, subject: name, file: sp.file, line: sp.line,
        message: `subagent_type «${name}» (${sp.file}:${sp.line}): нет agents/${name}.md, это не встроенный агент и не агент капабилити`,
      });
    }
    if (sp.location === 'prose') {
      const who = spawnLabel(sp.target);
      defects.push({
        kind: 'spawn-in-prose', unit: sp.unit, subject: who, file: sp.file, line: sp.line,
        message: `вызов Agent(… ${who}) (${sp.file}:${sp.line}) записан в прозе, а не в блоке кода (если рядом блок кода — проверьте парность ограничителей \`\`\`)`,
      });
    }
  }

  const includes: Include[] = uniqueBy(
    c.includes.map((inc) => ({
      unit: unitAt(units, inc.anchorLine),
      path: inc.path,
      kind: inc.kind,
      exists: inc.exists,
      file: inc.file,
      line: inc.line,
    })),
    (inc) => [inc.unit, inc.file, inc.line, inc.path],
  );
  for (const inc of includes) {
    if (inc.exists) continue;
    defects.push({
      kind: 'missing-include', unit: inc.unit, subject: inc.path, file: inc.file, line: inc.line,
      message: `ссылка на ${inc.path} (${inc.file}:${inc.line}): такого файла нет`,
    });
  }

  const jumps = scanJumps(main, units, c.includedStepNames, defects);
  return {
    workflow: source.name,
    path: source.path,
    units,
    spawns,
    jumps,
    loopPoints,
    includes,
    // One physical line is one defect, however many units read the file it is in.
    defects: uniqueBy(defects, (d) => [d.kind, d.subject, d.file, d.line]),
    unresolvedJumps: jumps.filter((j) => !j.resolved).length,
  };
}

function resolveSpawnTarget(
  sp: RawSpawnAt,
  unit: string | null,
  loopPoints: readonly LoopPointCall[],
  texts: readonly ScannedText[],
  ctx: WorkflowMapContext,
  builtins: ReadonlySet<string>,
): SpawnTarget {
  const v = sp.value;
  const dyn = /^\$?\{([A-Za-z_][A-Za-z0-9_]{0,60})\}$/.exec(v);
  if (dyn) {
    const names = literalAssignments(texts, dyn[1]) ?? [];
    return { kind: 'dynamic', expr: dyn[1], candidates: names.map((name) => ({ name, registry: agentRegistry(name, ctx, builtins) })) };
  }
  if (!sp.quoted && /(?:^|\.)ref\.agent$/.test(v)) {
    const points = [...new Set(loopPoints.filter((p) => p.unit === unit && p.known).map((p) => p.point))];
    return { kind: 'capability-hook', expr: v, points };
  }
  if (!sp.quoted) return { kind: 'dynamic', expr: v, candidates: [] };
  const registry = agentRegistry(v, ctx, builtins);
  if (registry === 'builtin') return { kind: 'builtin', name: v };
  return { kind: 'agent', name: v, registry };
}

function agentRegistry(name: string, ctx: WorkflowMapContext, builtins: ReadonlySet<string>): AgentRegistry {
  if (builtins.has(name)) return 'builtin';
  if (ctx.agents.has(name)) return 'agents';
  if (ctx.capabilityAgents.has(name)) return 'capability';
  return null;
}

function spawnLabel(t: SpawnTarget): string {
  switch (t.kind) {
    case 'agent':
    case 'builtin':
      return t.name;
    case 'dynamic':
    case 'capability-hook':
      return t.expr;
  }
}

// ─── Diagrams ────────────────────────────────────────────────────────────────

/** What a diagram node stands for — the structure tests check against the repo. */
export type NodeMeta =
  | { id: string; kind: 'root'; workflow: string }
  | { id: string; kind: 'unit'; unit: string }
  | { id: string; kind: 'agent'; name: string; registry: AgentRegistry }
  | { id: string; kind: 'dynamic'; expr: string }
  | { id: string; kind: 'point'; point: string; known: boolean }
  | { id: string; kind: 'capability-step'; point: string; capId: string; ref: string }
  | { id: string; kind: 'file'; path: string; fileKind: Include['kind']; exists: boolean }
  | { id: string; kind: 'missing-step'; token: string };

export interface DiagramSpec {
  spec: FlowchartSpec;
  nodes: NodeMeta[];
}

export interface WorkflowMapDiagrams {
  /** Units in document order, conditions, resolved jumps, dangling jumps. */
  flow: DiagramSpec;
  /** Units → agents, loop points (with their capability steps), other workflows, missing files; null when there are none. */
  calls: DiagramSpec | null;
}

export const DEFECT_LINK_STYLE = 'stroke:#d33,stroke-width:2px';

export const WORKFLOW_MAP_CLASS_DEFS: readonly ClassDef[] = Object.freeze([
  { name: 'missing', style: 'fill:#fdecea,stroke:#d33,stroke-dasharray:4 3' },
  { name: 'unparsed', style: 'fill:#f2f2f2,stroke:#888,stroke-dasharray:4 3' },
  { name: 'conditional', style: 'fill:#fff8e1,stroke:#b28704' },
  { name: 'root', style: 'fill:#263238,color:#ffffff,stroke:#263238' },
  { name: 'agent', style: 'fill:#e8f0fe,stroke:#3367d6' },
  { name: 'builtin', style: 'fill:#eeeeee,stroke:#777777' },
  { name: 'capability', style: 'fill:#e6f4ea,stroke:#2e7d32' },
  { name: 'dynamic', style: 'fill:#f2f2f2,stroke:#888,stroke-dasharray:2 2' },
  { name: 'point', style: 'fill:#f3e8fd,stroke:#8e24aa' },
  { name: 'workflow', style: 'fill:#ffffff,stroke:#555555' },
]);

/** A workflow with more units than this gets its flow split into subgraphs (when its headings are numbered). */
export const SUBGRAPH_THRESHOLD = 12;

function unitLabel(u: WorkflowUnit): string {
  if (u.kind === 'section') return `§ ${u.name}`;
  if (u.malformed) return `${u.name}\n(шаг не закрыт)`;
  return u.name;
}

function unitCondition(u: WorkflowUnit): string | null {
  if (u.attrs.condition !== undefined) return `если: ${u.attrs.condition}`;
  if (u.attrs.when !== undefined && u.attrs.when !== 'always') return `when: ${u.attrs.when}`;
  return null;
}

/**
 * Subgraphs for a large heading-based flow: one per major heading number
 * (`5`, `5.5`, `5.55` → group 5), titled by the group's first heading. A unit
 * without a number joins the group before it. Null when grouping would not
 * help (small flow, unnumbered headings, one group, or one unit per group).
 */
function headingGroups(units: readonly WorkflowUnit[]): { title: string; keys: string[] }[] | null {
  if (units.length <= SUBGRAPH_THRESHOLD) return null;
  if (!units.some((u) => u.kind === 'heading' && u.number !== null)) return null;
  const groups: { major: string | null; title: string; keys: string[] }[] = [];
  for (const u of units) {
    const major = u.kind === 'heading' && u.number !== null ? (/^\d{1,3}/.exec(u.number) ?? [''])[0] : null;
    const last = groups[groups.length - 1];
    if (last === undefined || (major !== null && major !== last.major)) {
      groups.push({ major, title: u.name, keys: [u.key] });
    } else {
      last.keys.push(u.key);
    }
  }
  if (groups.length < 2 || groups.length === units.length) return null;
  return groups.map((g) => ({ title: g.title, keys: g.keys }));
}

/** The specs handed to `mermaid.flowchart` — and what each node stands for. */
export function workflowMapDiagrams(map: WorkflowMap, hooks: Readonly<Record<string, LoopPointHooks>> = {}): WorkflowMapDiagrams {
  return { flow: flowDiagram(map), calls: callsDiagram(map, hooks) };
}

function flowDiagram(map: WorkflowMap): DiagramSpec {
  const ids = createIdRegistry('u_');
  const missingIds = createIdRegistry('m_');
  const nodes: FlowNode[] = [];
  const meta: NodeMeta[] = [];
  const edges: FlowEdge[] = [];

  const rootId = 'wf_root';
  nodes.push({ id: rootId, label: `${map.workflow}.md`, shape: 'stadium', className: 'root' });
  meta.push({ id: rootId, kind: 'root', workflow: map.workflow });
  const unitId = (key: string | null): string => (key === null ? rootId : ids.id(key));

  for (const u of map.units) {
    const cls = u.malformed ? 'unparsed' : unitCondition(u) !== null ? 'conditional' : undefined;
    nodes.push({ id: unitId(u.key), label: unitLabel(u), shape: u.kind === 'section' ? 'round' : 'rect', ...(cls ? { className: cls } : {}) });
    meta.push({ id: unitId(u.key), kind: 'unit', unit: u.key });
  }
  map.units.forEach((u, i) => {
    const from = i === 0 ? rootId : unitId(map.units[i - 1].key);
    const cond = unitCondition(u);
    edges.push({ from, to: unitId(u.key), ...(cond !== null ? { label: cond } : {}) });
  });

  const drawn = new Set<string>();
  for (const j of map.jumps) {
    if (!j.resolved || j.to === null) continue;
    const pair = `${unitId(j.unit)}>${unitId(j.to)}`;
    if (drawn.has(pair)) continue;
    drawn.add(pair);
    edges.push({ from: unitId(j.unit), to: unitId(j.to), line: 'dotted', label: 'goto' });
  }
  for (const d of map.defects) {
    if (d.kind !== 'dangling-jump') continue;
    const mid = missingIds.id(d.subject);
    if (!meta.some((n) => n.id === mid)) {
      nodes.push({ id: mid, label: `${d.subject} — такого шага нет`, className: 'missing' });
      meta.push({ id: mid, kind: 'missing-step', token: d.subject });
    }
    const pair = `${unitId(d.unit)}>${mid}`;
    if (drawn.has(pair)) continue;
    drawn.add(pair);
    edges.push({ from: unitId(d.unit), to: mid, line: 'dotted', label: 'goto', linkStyle: DEFECT_LINK_STYLE });
  }

  const subgraphs: FlowSubgraph[] = [];
  const groups = headingGroups(map.units);
  if (groups !== null) {
    groups.forEach((g, i) => {
      subgraphs.push({ id: `g_${i + 1}`, title: g.title, nodes: g.keys.map((k) => unitId(k)) });
    });
  }
  return {
    spec: { direction: 'TB', nodes, edges, subgraphs, classDefs: [...WORKFLOW_MAP_CLASS_DEFS] },
    nodes: meta,
  };
}

function callsDiagram(map: WorkflowMap, hooks: Readonly<Record<string, LoopPointHooks>>): DiagramSpec | null {
  const missingFiles = map.includes.filter((i) => !i.exists);
  const workflowCalls = map.includes.filter((i) => i.exists && i.kind === 'workflow');
  if (map.spawns.length === 0 && map.loopPoints.length === 0 && missingFiles.length === 0 && workflowCalls.length === 0) {
    return null;
  }
  const uIds = createIdRegistry('u_');
  const aIds = createIdRegistry('a_');
  const pIds = createIdRegistry('p_');
  const cIds = createIdRegistry('c_');
  const wIds = createIdRegistry('w_');
  const rootId = 'wf_root';

  const nodes: FlowNode[] = [];
  const meta: NodeMeta[] = [];
  const edges: FlowEdge[] = [];
  const edgeSeen = new Set<string>();
  const addEdge = (e: FlowEdge): void => {
    const k = `${e.from}>${e.to}`;
    if (edgeSeen.has(k)) return;
    edgeSeen.add(k);
    edges.push(e);
  };
  const declared = new Set<string>();
  const addNode = (n: FlowNode, m: NodeMeta): string => {
    if (!declared.has(n.id)) {
      declared.add(n.id);
      nodes.push(n);
      meta.push(m);
    }
    return n.id;
  };
  const unitsById = new Map(map.units.map((u) => [u.key, u]));
  const unitNode = (key: string | null): string => {
    if (key === null) return addNode({ id: rootId, label: `${map.workflow}.md (вне шагов)`, shape: 'stadium', className: 'root' }, { id: rootId, kind: 'root', workflow: map.workflow });
    const u = unitsById.get(key) as WorkflowUnit;
    return addNode({ id: uIds.id(key), label: unitLabel(u), shape: u.kind === 'section' ? 'round' : 'rect' }, { id: uIds.id(key), kind: 'unit', unit: key });
  };
  // Units first, in document order, so the left column reads top to bottom like the file.
  const involved = new Set<string | null>([
    ...map.spawns.map((s) => s.unit),
    ...map.loopPoints.map((p) => p.unit),
    ...missingFiles.map((i) => i.unit),
    ...workflowCalls.map((i) => i.unit),
  ]);
  if (involved.has(null)) unitNode(null);
  for (const u of map.units) if (involved.has(u.key)) unitNode(u.key);

  const agentNode = (name: string, registry: AgentRegistry): string => {
    const cls = registry === null ? 'missing' : registry === 'builtin' ? 'builtin' : registry === 'capability' ? 'capability' : 'agent';
    const label = registry === null ? `${name} — нет такого агента` : registry === 'builtin' ? `${name} (встроенный)` : name;
    return addNode({ id: aIds.id(name), label, shape: 'subroutine', className: cls }, { id: aIds.id(name), kind: 'agent', name, registry });
  };
  const pointNode = (point: string, known: boolean): string => {
    const h = hooks[point];
    const extra = known && h !== undefined && (h.gates > 0 || h.contributions > 0) ? `\n+${h.gates} gates, +${h.contributions} contributions` : '';
    const label = known ? `${point}${extra}` : `${point} — нет такой точки`;
    const id = pIds.id(point);
    const isNew = !declared.has(id);
    addNode({ id, label, shape: 'hexagon', className: known ? 'point' : 'missing' }, { id, kind: 'point', point, known });
    if (isNew && known && h !== undefined) {
      for (const st of h.steps) {
        const ref = st.ref.agent !== undefined ? `agent ${st.ref.agent}` : st.ref.skill !== undefined ? `skill ${st.ref.skill}` : `command ${st.ref.command ?? '?'}`;
        const cid = cIds.id(`${point} ${st.capId} ${ref}`);
        addNode({ id: cid, label: `${st.capId}: ${ref}`, className: 'capability' }, { id: cid, kind: 'capability-step', point, capId: st.capId, ref });
        addEdge({ from: id, to: cid, line: 'dotted' });
      }
    }
    return id;
  };

  for (const sp of map.spawns) {
    const from = unitNode(sp.unit);
    const via = sp.file !== map.path ? sp.file.slice(WORKFLOWS_DIR.length) : null;
    const red = sp.location === 'prose' ? { linkStyle: DEFECT_LINK_STYLE } : {};
    const label = via !== null ? { label: `через ${via}` } : {};
    const t = sp.target;
    if (t.kind === 'agent' || t.kind === 'builtin') {
      const registry = t.kind === 'builtin' ? 'builtin' : t.registry;
      const to = agentNode(t.name, registry);
      addEdge({ from, to, ...label, ...(registry === null ? { linkStyle: DEFECT_LINK_STYLE } : red) });
    } else if (t.kind === 'dynamic') {
      const id = `d_${aIds.id(`dyn ${t.expr}`)}`;
      addNode({ id, label: `dynamic: ${t.expr}`, shape: 'subroutine', className: 'dynamic' }, { id, kind: 'dynamic', expr: t.expr });
      addEdge({ from, to: id, ...label, ...red });
      for (const cand of t.candidates) {
        addEdge({ from: id, to: agentNode(cand.name, cand.registry), line: 'dotted', ...(cand.registry === null ? { linkStyle: DEFECT_LINK_STYLE } : {}) });
      }
    } else if (t.points.length > 0) {
      for (const p of t.points) addEdge({ from, to: pointNode(p, true), ...label, ...red });
    } else {
      const id = `d_${aIds.id(`dyn ${t.expr}`)}`;
      addNode({ id, label: `агент капабилити: ${t.expr}`, shape: 'subroutine', className: 'dynamic' }, { id, kind: 'dynamic', expr: t.expr });
      addEdge({ from, to: id, ...label, ...red });
    }
  }
  for (const lp of map.loopPoints) {
    const via = lp.file !== map.path ? { label: `через ${lp.file.slice(WORKFLOWS_DIR.length)}` } : {};
    addEdge({ from: unitNode(lp.unit), to: pointNode(lp.point, lp.known), ...via, ...(lp.known ? {} : { linkStyle: DEFECT_LINK_STYLE }) });
  }
  for (const inc of workflowCalls) {
    const name = inc.path.slice(WORKFLOWS_DIR.length).replace(/\.md$/, '');
    const id = wIds.id(inc.path);
    addNode({ id, label: `workflow: ${name}`, shape: 'stadium', className: 'workflow' }, { id, kind: 'file', path: inc.path, fileKind: 'workflow', exists: true });
    addEdge({ from: unitNode(inc.unit), to: id, line: 'dotted' });
  }
  for (const inc of missingFiles) {
    const id = wIds.id(inc.path);
    addNode({ id, label: `${inc.path} — нет такого файла`, className: 'missing' }, { id, kind: 'file', path: inc.path, fileKind: inc.kind, exists: false });
    addEdge({ from: unitNode(inc.unit), to: id, line: 'dotted', linkStyle: DEFECT_LINK_STYLE });
  }

  const inGroup = (kinds: readonly NodeMeta['kind'][]): string[] => meta.filter((m) => kinds.includes(m.kind)).map((m) => m.id);
  const subgraphs: FlowSubgraph[] = [];
  const agentIds = inGroup(['agent', 'dynamic']);
  const pointIds = inGroup(['point', 'capability-step']);
  const fileIds = inGroup(['file']);
  if (agentIds.length > 0) subgraphs.push({ id: 'g_agents', title: 'Агенты', nodes: agentIds });
  if (pointIds.length > 0) subgraphs.push({ id: 'g_points', title: 'Точки цикла и капабилити', nodes: pointIds });
  if (fileIds.length > 0) subgraphs.push({ id: 'g_files', title: 'Другие workflows и файлы', nodes: fileIds });
  return {
    spec: { direction: 'LR', nodes, edges, subgraphs, classDefs: [...WORKFLOW_MAP_CLASS_DEFS] },
    nodes: meta,
  };
}

// ─── Documents ───────────────────────────────────────────────────────────────

/** The generator named in every map's derived marker. */
export const WORKFLOW_MAPS_SOURCE = 'scripts/gen-workflow-maps.cjs';

/** A workflow gets a map when it has at least one unit or one spawn. */
export function hasMap(map: WorkflowMap): boolean {
  return map.units.length > 0 || map.spawns.length > 0;
}

function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function code(text: string): string {
  return text.includes('`') ? cell(text) : `\`${cell(text)}\``;
}

function plural(n: number, one: string, few: string, many: string): string {
  const d10 = n % 10;
  const d100 = n % 100;
  if (d10 === 1 && d100 !== 11) return `${n} ${one}`;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/** Distinct agent names a map spawns (including resolved dynamic candidates). */
export function spawnedAgents(map: WorkflowMap): string[] {
  const names = new Set<string>();
  for (const s of map.spawns) {
    if (s.target.kind === 'agent' || s.target.kind === 'builtin') names.add(s.target.name);
    if (s.target.kind === 'dynamic') for (const c of s.target.candidates) names.add(c.name);
  }
  return [...names];
}

function unitSummary(map: WorkflowMap): string {
  const count = (k: UnitKind): number => map.units.filter((u) => u.kind === k).length;
  const parts: string[] = [];
  if (count('step') > 0) parts.push(`${plural(count('step'), 'шаг', 'шага', 'шагов')} \`<step>\``);
  if (count('heading') > 0) parts.push(`${plural(count('heading'), 'раздел', 'раздела', 'разделов')} H2`);
  if (count('section') > 0) parts.push(`${plural(count('section'), 'секция', 'секции', 'секций')} \`gsd:section\``);
  return parts.length > 0 ? parts.join(', ') : 'единиц нет';
}

function spawnCell(map: WorkflowMap, key: string | null): string {
  const out: string[] = [];
  for (const s of map.spawns) {
    if (s.unit !== key) continue;
    const t = s.target;
    const label = t.kind === 'agent' || t.kind === 'builtin' ? t.name : t.kind === 'dynamic' ? `{${t.expr}}` : t.expr;
    const item = code(label);
    if (!out.includes(item)) out.push(item);
  }
  return out.join(', ');
}

function pointCell(map: WorkflowMap, key: string | null): string {
  const out: string[] = [];
  for (const p of map.loopPoints) {
    if (p.unit !== key) continue;
    const item = code(p.point);
    if (!out.includes(item)) out.push(item);
  }
  return out.join(', ');
}

function includeCell(map: WorkflowMap, key: string | null): string {
  const out: string[] = [];
  for (const i of map.includes) {
    if (i.unit !== key || i.file !== map.path) continue;
    const item = code(i.path.slice(WORKFLOWS_DIR.length));
    if (!out.includes(item)) out.push(item);
  }
  return out.join(', ');
}

/** One workflow's map document. Pure. */
export function renderWorkflowMapDoc(map: WorkflowMap, hooks: Readonly<Record<string, LoopPointHooks>> = {}): string {
  const d = workflowMapDiagrams(map, hooks);
  const resolved = map.jumps.filter((j) => j.resolved).length;
  const agents = spawnedAgents(map);
  const points = [...new Set(map.loopPoints.map((p) => p.point))];
  const lines: string[] = [
    derivedMarker(WORKFLOW_MAPS_SOURCE),
    '',
    `# ${map.workflow}`,
    '',
    `Источник: \`${map.path}\`. Единицы: ${unitSummary(map)}. ` +
      `Спавнов: ${map.spawns.length}${agents.length > 0 ? ` (агенты: ${agents.map(code).join(', ')})` : ''}. ` +
      `Точки цикла: ${points.length > 0 ? points.map(code).join(', ') : 'нет'}.`,
    '',
    `> **Переходы в прозе** (фразы «перейди к …»): всего ${map.jumps.length}; не называют реальный шаг и не рисуются — ` +
      `**${map.unresolvedJumps}**; названы по имени шага и нарисованы пунктиром \`goto\` — ${resolved}.`,
    '',
    'Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок',
    'документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —',
    'в [README](README.md).',
    '',
    '## Поток',
    '',
    fence(flowchart(d.flow.spec)),
    '',
  ];
  if (d.calls !== null) {
    lines.push('## Агенты и точки цикла', '', fence(flowchart(d.calls.spec)), '');
  }
  lines.push('## Единицы', '', '| # | Единица | Вид | Условие | Спавны | Точки цикла | Читает |', '|---|---|---|---|---|---|---|');
  const rootRow = [spawnCell(map, null), pointCell(map, null), includeCell(map, null)];
  if (rootRow.some((c) => c !== '')) {
    lines.push(`| — | (вне единиц) | — | — | ${rootRow.join(' | ')} |`);
  }
  for (const u of map.units) {
    const kind = u.kind === 'step' ? (u.malformed ? 'step (не закрыт)' : 'step') : u.kind === 'section' ? 'section' : 'H2';
    const cond = unitCondition(u) ?? '';
    lines.push(
      `| ${u.order + 1} | ${code(u.name)} | ${kind} | ${cell(cond)} | ${spawnCell(map, u.key)} | ${pointCell(map, u.key)} | ${includeCell(map, u.key)} |`,
    );
  }
  lines.push('', '## Дефекты', '');
  if (map.defects.length === 0) lines.push('Дефектов нет.');
  else for (const def of map.defects) lines.push(`- \`${def.kind}\`: ${def.message}`);
  lines.push('');
  return lines.join('\n');
}

/** The index of all maps. `skipped`: workflows with no unit and no spawn (no map). Pure. */
export function renderWorkflowMapsIndex(maps: readonly WorkflowMap[], skipped: readonly string[]): string {
  const totalUnresolved = maps.reduce((n, m) => n + m.unresolvedJumps, 0);
  const totalJumps = maps.reduce((n, m) => n + m.jumps.length, 0);
  const totalDefects = maps.reduce((n, m) => n + m.defects.length, 0);
  const lines: string[] = [
    derivedMarker(WORKFLOW_MAPS_SOURCE),
    '',
    '# Карты workflows',
    '',
    'Логика каждого workflow из `gsd-core/workflows/` — шаги, переходы и спавны агентов — построенная из',
    'разметки самого markdown, а не нарисованная. Перегенерация: `node scripts/gen-workflow-maps.cjs --write`',
    '(входит в `npm run regen:derived`); `--check` (часть `npm run lint:generated-sync`) падает, когда workflow',
    'изменён без перегенерации.',
    '',
    '## Что на карте',
    '',
    '- **Узел** — то, что есть в файле: блок `<step name=…>`; фрагмент `<!-- gsd:section id when -->` (скруглённый,',
    '  с префиксом `§`); в workflow без шагов — заголовок H2 внутри `<process>`. Тёмный узел — сам workflow.',
    '- **Сплошное ребро** — порядок документа. Подпись на ребре — условие входа: `если: …` (атрибут `condition`',
    '  шага) или `when: …` (закрытый словарь секций). Условный узел подсвечен жёлтым: он пропускается, когда',
    '  условие ложно.',
    '- **Пунктир `goto`** — фраза перехода («go to», «proceed to», «skip to», «перейди к» …), называющая реальную',
    '  единицу: имя шага, id секции или номер нумерованного раздела (`step 5.5`). Остальные фразы («the next',
    '  step», «Route A», «step 3» в файле без нумерованных разделов) не рисуются, а **считаются** — счётчик в шапке',
    '  каждой карты.',
    '- **Агенты** (`[[…]]`) — аргумент `subagent_type` вызова `Agent(` в блоке кода или в inline-коде, сверенный',
    '  с `agents/*.md` (синий), встроенными агентами рантайма (серый) и агентами капабилити из реестра (зелёный).',
    '  `dynamic: X` — тип агента из переменной; к кандидатам ведёт пунктир, только если все присваивания',
    '  переменной — литералы.',
    '- **Точки цикла** (шестиугольник) — вызов `loop render-hooks <point>`; к точке подшиты шаги капабилити из',
    '  `byLoopPoint` реестра. `ref.agent` хука капабилити разрешается через эти точки.',
    '- Спавны и точки из файлов, которые единица читает (`gsd-core/workflows/<workflow>/steps/*.md` и т. п.),',
    '  приписаны этой единице с подписью `через …`.',
    '',
    '**Дефекты рисуются красным**, а не отбрасываются: неизвестный агент, переход к snake_case-имени, которого',
    'нет среди шагов, точка вне `LOOP_HOST_CONTRACT`, ссылка на несуществующий файл, шаг без закрывающего',
    '`</step>` (серый пунктир), вызов `Agent(` в прозе вместо блока кода, расхождение маркеров',
    '`gsd:section` с `section-manifest.json`.',
    '',
    `## Workflows (${maps.length})`,
    '',
    `Всего фраз перехода: ${totalJumps}, из них не называют реальный шаг: ${totalUnresolved}. Дефектов: ${totalDefects}.`,
    '',
    '| Workflow | Единицы | Спавны | Агенты | Точки цикла | Переходы без имени | Дефекты |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const m of maps) {
    const points = [...new Set(m.loopPoints.map((p) => p.point))];
    lines.push(
      `| [${m.workflow}](${m.workflow}.md) | ${cell(unitSummary(m))} | ${m.spawns.length} | ${spawnedAgents(m).length} | ` +
        `${points.map(code).join(', ')} | ${m.unresolvedJumps} / ${m.jumps.length} | ${m.defects.length} |`,
    );
  }
  lines.push('');
  if (skipped.length > 0) {
    lines.push(
      '## Без карты',
      '',
      'В этих workflows нет ни шагов, ни секций, ни разделов H2 внутри `<process>`, ни спавнов — рисовать нечего:',
      '',
      ...skipped.map((s) => `- \`${s}\``),
      '',
    );
  }
  return lines.join('\n');
}
