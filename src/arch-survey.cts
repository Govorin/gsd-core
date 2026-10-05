'use strict';
/**
 * Architecture survey — the deterministic glue between the model steps of
 * `/gsd:arch-survey` (pocock-practices design, D1; adapted from
 * mattpocock/skills `improve-codebase-architecture`, MIT).
 *
 * The surveyors (one per zone, fresh context) each write a cards file; this
 * module turns those files into one candidate list, the refuter's input, and
 * the SURVEY report, and keeps the decision journal. No model reads or writes
 * anything here: "synthesis" is a merge with fixed rules, so two runs over the
 * same cards produce the same report.
 *
 * ── Rules applied to the cards ──
 *
 *   - A card must name a known `kind`, a `strength`, and root-relative files.
 *     A malformed card is reported in `invalid` with its problems — never
 *     dropped silently, never repaired by guessing.
 *   - `strong` needs the deletion test: `deletionTest.result: concentrates`
 *     with evidence. A strong card without it is demoted to
 *     `worth-exploring` and says so (`demoted`).
 *   - A card naming a file that does not exist fails the check outright
 *     (`failedCheck`), before the refuter is asked anything.
 *   - The candidate id is a hash of the kind and the normalised file set, so
 *     the same problem over the same files has the same id in every run. An id
 *     rejected in `DECISIONS.md` is excluded (`excludedByDecision`); two zones
 *     proposing the same id merge into one candidate (`alsoFrom`).
 *   - A zone's verdict is computed, not trusted: `no-strong-candidates`
 *     exactly when none of its surviving cards is strong.
 *
 * ── Files ──
 *
 *   .planning/architecture/metrics-<date>.json        arch metrics
 *   .planning/architecture/survey-<date>/cards-<zone>.json   one per surveyor
 *   .planning/architecture/survey-<date>/candidates.json     arch cards
 *   .planning/architecture/survey-<date>/refuter-input.md    arch cards
 *   .planning/architecture/survey-<date>/refutation.md       the refuter's reply
 *   .planning/architecture/SURVEY-<date>.md           arch report (derived)
 *   .planning/architecture/DECISIONS.md               arch decide
 *
 * ADR-457 build-at-publish: source in src/arch-survey.cts, compiled to
 * gsd-core/bin/lib/arch-survey.cjs (gitignored).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryWithinRootLexical } from './security.cjs';
import { normalizeContent } from './shell-command-projection.cjs';
import { derivedMarker, fence, flowchart, createIdRegistry, DEFECT_LINK_STYLE } from './mermaid.cjs';
import type { FlowEdge, FlowNode, FlowchartSpec } from './mermaid.cjs';
import type { ArchMetrics, Comparison, Zone } from './arch-metrics.cjs';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** What a candidate is about — the friction list of improve-codebase-architecture, plus the metric classes. */
export const PROBLEM_KINDS = Object.freeze([
  'shallow-module',
  'pass-through',
  'scattered-concept',
  'no-locality',
  'leaky-seam',
  'untestable-interface',
  'cycle',
  'smeared-change',
  'other',
] as const);
export type ProblemKind = (typeof PROBLEM_KINDS)[number];

export const STRENGTHS = Object.freeze(['strong', 'worth-exploring', 'speculative'] as const);
export type Strength = (typeof STRENGTHS)[number];

export const DELETION_RESULTS = Object.freeze(['concentrates', 'moves', 'not-applied'] as const);
export type DeletionResult = (typeof DELETION_RESULTS)[number];

export const DISPOSITIONS = Object.freeze(['accepted', 'rejected', 'deferred'] as const);
export type Disposition = (typeof DISPOSITIONS)[number];

export const CARDS_FILE_RE = /^cards-(z\d+)\.json$/;
const ID_RE = /^arch-[0-9a-f]{12}$/;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Card {
  title: string;
  kind: ProblemKind;
  files: string[];
  problem: string;
  solution: string;
  benefits: string;
  tests: string;
  strength: Strength;
  deletionTest: { result: DeletionResult; evidence: string };
  adrConflict: string | null;
  /**
   * True when the card has the kind and the file set of a structure `arch metrics` found (see
   * `foundByMetrics`): one candidate, glued to that finding, never listed twice. Set by
   * `collectCandidates`, not by the surveyor.
   */
  fromMetrics: boolean;
}

export interface Candidate extends Card {
  id: string;
  zone: string;
  alsoFrom: string[];
  /** Set when a strong card lacked the deletion test. */
  demoted: string | null;
  priorDecision: Disposition | null;
}

export interface InvalidCard {
  source: string;
  index: number | null;
  problems: string[];
}

export interface CandidateSet {
  date: string;
  zones: Array<{ id: string; status: 'reported' | 'invalid' | 'missing'; verdict: 'candidates' | 'no-strong-candidates' | null; verdictMismatch: boolean }>;
  candidates: Candidate[];
  invalid: InvalidCard[];
  failedCheck: Array<{ id: string; title: string; zone: string; reason: string; files: string[] }>;
  excludedByDecision: Array<{ id: string; title: string; zone: string; reason: string }>;
}

export interface Verification {
  verdict: 'upheld' | 'refuted' | 'unverified' | 'unmatched';
  evidence: string | null;
}

export interface DecisionEntry {
  id: string;
  disposition: Disposition;
  title: string;
  kind: string;
  files: string[];
  date: string;
  survey: string | null;
  reason: string | null;
  route: string | null;
}

// ─── Small helpers ───────────────────────────────────────────────────────────

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Markdown exactly as `platformWriteSync` will store it (blank lines around headings and lists,
 * one trailing newline), so a rendered document and the file written from it are the same bytes.
 */
function asWritten(markdown: string): string {
  return normalizeContent('document.md', markdown).content;
}

// ─── Files and ids ───────────────────────────────────────────────────────────

/**
 * Root-relative POSIX paths, deduplicated and sorted. An absolute path or one
 * climbing out with `..` is a problem, not something to normalise away.
 */
export function normalizeFiles(files: unknown): { files: string[]; problems: string[] } {
  if (!Array.isArray(files) || files.length === 0) return { files: [], problems: ['files must be a non-empty array of paths'] };
  const out = new Set<string>();
  const problems: string[] = [];
  for (const f of files) {
    if (!nonEmptyString(f)) {
      problems.push(`file ${JSON.stringify(f)} is not a path`);
      continue;
    }
    const posix = f.trim().replace(/\\/g, '/');
    const norm = path.posix.normalize(posix).replace(/^\.\//, '').replace(/\/+$/, '');
    if (path.posix.isAbsolute(norm) || /^[A-Za-z]:/.test(norm) || norm === '..' || norm.startsWith('../') || norm === '.' || norm === '') {
      problems.push(`file ${JSON.stringify(f)} is not a root-relative path`);
      continue;
    }
    out.add(norm);
  }
  return { files: [...out].sort(cmp), problems };
}

/** The candidate's signature: same kind over the same files is the same candidate, in any run. */
export function candidateId(kind: string, files: readonly string[]): string {
  const { files: norm } = normalizeFiles([...files]);
  const digest = crypto.createHash('sha256').update(`${kind}\n${norm.join('\n')}`).digest('hex');
  return `arch-${digest.slice(0, 12)}`;
}

// ─── Cards ───────────────────────────────────────────────────────────────────

function validateCard(raw: unknown): { card: Card | null; problems: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { card: null, problems: ['card is not an object'] };
  const c = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of ['title', 'problem', 'solution', 'benefits'] as const) {
    if (!nonEmptyString(c[key])) problems.push(`${key} must be a non-empty string`);
  }
  if (!(PROBLEM_KINDS as readonly unknown[]).includes(c['kind'])) problems.push(`kind must be one of ${PROBLEM_KINDS.join(', ')}`);
  if (!(STRENGTHS as readonly unknown[]).includes(c['strength'])) problems.push(`strength must be one of ${STRENGTHS.join(', ')}`);
  const files = normalizeFiles(c['files']);
  problems.push(...files.problems);
  const dt = c['deletionTest'];
  let deletionTest: Card['deletionTest'] = { result: 'not-applied', evidence: '' };
  if (dt !== undefined && dt !== null) {
    const d = dt as Record<string, unknown>;
    if (typeof dt !== 'object' || !(DELETION_RESULTS as readonly unknown[]).includes(d['result'])) {
      problems.push(`deletionTest.result must be one of ${DELETION_RESULTS.join(', ')}`);
    } else {
      deletionTest = { result: d['result'] as DeletionResult, evidence: typeof d['evidence'] === 'string' ? oneLine(d['evidence']) : '' };
    }
  }
  if (c['adrConflict'] !== undefined && c['adrConflict'] !== null && typeof c['adrConflict'] !== 'string') {
    problems.push('adrConflict must be a string or null');
  }
  if (problems.length > 0) return { card: null, problems };
  return {
    card: {
      title: oneLine(c['title'] as string),
      kind: c['kind'] as ProblemKind,
      files: files.files,
      problem: (c['problem'] as string).trim(),
      solution: (c['solution'] as string).trim(),
      benefits: (c['benefits'] as string).trim(),
      tests: typeof c['tests'] === 'string' ? c['tests'].trim() : '',
      strength: c['strength'] as Strength,
      deletionTest,
      adrConflict: nonEmptyString(c['adrConflict']) ? oneLine(c['adrConflict']) : null,
      fromMetrics: false,
    },
    problems: [],
  };
}

export interface CardSource {
  /** File name, for messages. */
  source: string;
  /** The zone the file name claims (`cards-z2.json` → `z2`). */
  zone: string;
  /** Parsed JSON, or the parse error message. */
  content: unknown;
  parseError: string | null;
}

/** Read `cards-z<N>.json` files of a survey directory, in zone order. A missing directory has none. */
export function readCardSources(dir: string): CardSource[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: CardSource[] = [];
  for (const name of names) {
    const m = CARDS_FILE_RE.exec(name);
    if (m === null) continue;
    let content: unknown = null;
    let parseError: string | null = null;
    try {
      content = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as unknown;
    } catch (e) {
      parseError = (e as Error).message;
    }
    out.push({ source: name, zone: m[1], content, parseError });
  }
  return out.sort((a, b) => Number(a.zone.slice(1)) - Number(b.zone.slice(1)));
}

const STRENGTH_RANK: Readonly<Record<Strength, number>> = Object.freeze({ strong: 0, 'worth-exploring': 1, speculative: 2 });

/**
 * One candidate list from the surveyors' cards: validated, deletion-tested,
 * existence-checked, deduplicated by id, filtered by rejected decisions, and
 * ordered by strength, then zone order, then the order the surveyor gave.
 */
export function collectCandidates(input: {
  root: string;
  date: string;
  zones: readonly Zone[];
  sources: readonly CardSource[];
  decisions: readonly DecisionEntry[];
  /** The metrics of the survey: a card with the signature of a structure they found is glued to it. */
  metrics?: Pick<ArchMetrics, 'cycles' | 'passThrough' | 'smallClusters'>;
}): CandidateSet {
  const counted = input.metrics === undefined ? new Set<string>() : metricsFindingIds(input.metrics);
  const zoneOrder = new Map(input.zones.map((z, i) => [z.id, i]));
  const decisionById = new Map(input.decisions.map((d) => [d.id, d]));
  const invalid: InvalidCard[] = [];
  const failedCheck: CandidateSet['failedCheck'] = [];
  const excludedByDecision: CandidateSet['excludedByDecision'] = [];
  const byId = new Map<string, Candidate & { order: [number, number] }>();
  const reported = new Map<string, { strong: boolean; claimed: unknown }>();
  const unreadable = new Set<string>();
  const reject = (src: CardSource, problem: string): void => {
    invalid.push({ source: src.source, index: null, problems: [problem] });
    unreadable.add(src.zone);
  };

  for (const src of input.sources) {
    if (!zoneOrder.has(src.zone)) {
      invalid.push({ source: src.source, index: null, problems: [`zone ${src.zone} is not a zone of this survey's metrics`] });
      continue;
    }
    if (src.parseError !== null) {
      reject(src, `not JSON: ${src.parseError}`);
      continue;
    }
    const doc = src.content as Record<string, unknown> | null;
    if (doc === null || typeof doc !== 'object' || !Array.isArray(doc['cards'])) {
      reject(src, 'expected an object with a cards array');
      continue;
    }
    if (doc['zone'] !== undefined && doc['zone'] !== src.zone) {
      reject(src, `zone field ${JSON.stringify(doc['zone'])} does not match the file name`);
      continue;
    }
    let strong = false;
    (doc['cards'] as unknown[]).forEach((raw, index) => {
      const { card, problems } = validateCard(raw);
      if (card === null) {
        invalid.push({ source: src.source, index, problems });
        return;
      }
      const id = candidateId(card.kind, card.files);
      const missing = card.files.filter((f) => {
        const abs = tryWithinRootLexical(f, input.root);
        return abs === null || !fs.existsSync(abs);
      });
      if (missing.length > 0) {
        failedCheck.push({ id, title: card.title, zone: src.zone, reason: 'missing-files', files: missing });
        return;
      }
      const prior = decisionById.get(id);
      if (prior !== undefined && prior.disposition === 'rejected') {
        excludedByDecision.push({ id, title: card.title, zone: src.zone, reason: prior.reason ?? '' });
        return;
      }
      let strength = card.strength;
      let demoted: string | null = null;
      if (strength === 'strong' && (card.deletionTest.result !== 'concentrates' || card.deletionTest.evidence === '')) {
        strength = 'worth-exploring';
        demoted = 'strong-without-deletion-test';
      }
      if (strength === 'strong') strong = true;
      const existing = byId.get(id);
      if (existing !== undefined) {
        if (!existing.alsoFrom.includes(src.zone) && existing.zone !== src.zone) existing.alsoFrom.push(src.zone);
        return;
      }
      byId.set(id, {
        ...card,
        strength,
        id,
        zone: src.zone,
        alsoFrom: [],
        fromMetrics: counted.has(id),
        demoted,
        priorDecision: prior?.disposition ?? null,
        order: [zoneOrder.get(src.zone) as number, index],
      });
    });
    reported.set(src.zone, { strong, claimed: doc['verdict'] });
  }

  const candidates = [...byId.values()]
    .sort((a, b) => STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength] || a.order[0] - b.order[0] || a.order[1] - b.order[1])
    .map(({ order: _order, ...c }) => c);
  const zones = input.zones.map((z) => {
    const r = reported.get(z.id);
    if (r === undefined) {
      return { id: z.id, status: unreadable.has(z.id) ? 'invalid' as const : 'missing' as const, verdict: null, verdictMismatch: false };
    }
    const verdict = r.strong ? 'candidates' as const : 'no-strong-candidates' as const;
    return { id: z.id, status: 'reported' as const, verdict, verdictMismatch: r.claimed !== undefined && r.claimed !== verdict };
  });
  return { date: input.date, zones, candidates, invalid, failedCheck, excludedByDecision };
}

// ─── Refuter input and reply ─────────────────────────────────────────────────

/**
 * The candidates as numbered findings for `gsd-finding-refuter` (mode `arch`). The refuter
 * answers per `### Finding N: <title>`; `parseRefutation` maps the answers back by number and
 * checks the title.
 */
export function renderRefuterInput(set: CandidateSet): string {
  const lines = [
    `# Architecture candidates to refute — survey ${set.date}`,
    '',
    'Mode: arch. For each finding check that every listed file exists and plays the role the',
    'problem describes, and that the deletion test claim holds against the callers.',
    '',
  ];
  set.candidates.forEach((c, i) => {
    lines.push(
      `### Finding ${i + 1}: ${c.title}`,
      `- id: ${c.id}`,
      `- kind: ${c.kind}`,
      `- strength: ${c.strength}`,
      `- files: ${c.files.map((f) => `\`${f}\``).join(', ')}`,
      `- problem: ${oneLine(c.problem)}`,
      `- deletion test: ${c.deletionTest.result}${c.deletionTest.evidence !== '' ? ` — ${c.deletionTest.evidence}` : ''}`,
      ...(c.adrConflict !== null ? [`- ADR conflict: ${c.adrConflict}`] : []),
      '',
    );
  });
  return asWritten(lines.join('\n'));
}

/** `### Finding N: title` / `verdict:` / `evidence:` blocks of a refuter reply, by number. */
export function parseRefutation(text: string): Map<number, { title: string; verdict: 'upheld' | 'refuted'; evidence: string }> {
  const out = new Map<number, { title: string; verdict: 'upheld' | 'refuted'; evidence: string }>();
  const blocks = text.replace(/\r\n/g, '\n').split(/^### Finding /m).slice(1);
  for (const block of blocks) {
    const head = /^(\d+):[ \t]*(.*)$/m.exec(block);
    if (head === null) continue;
    const verdict = /^verdict:\s*(UPHELD|REFUTED)\b/im.exec(block);
    if (verdict === null) continue;
    out.set(Number(head[1]), {
      title: oneLine(head[2]),
      verdict: verdict[1].toUpperCase() === 'REFUTED' ? 'refuted' : 'upheld',
      evidence: evidenceOf(block),
    });
  }
  return out;
}

/** The `evidence:` line and its continuation lines, up to a blank line, a fence or a heading. */
function evidenceOf(block: string): string {
  const lines = block.split('\n');
  const at = lines.findIndex((l) => /^evidence:/i.test(l));
  if (at < 0) return '';
  const taken = [lines[at].replace(/^evidence:\s*/i, '')];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '' || l.startsWith('```') || l.startsWith('#')) break;
    taken.push(l);
  }
  return oneLine(taken.join(' '));
}

/**
 * One verification per candidate, by position. A reply whose title does not match is
 * `unmatched` and a missing reply `unverified` — neither is treated as upheld or refuted.
 */
export function verifyCandidates(set: CandidateSet, refutation: string | null): Verification[] {
  if (refutation === null) return set.candidates.map(() => ({ verdict: 'unverified', evidence: null }));
  const parsed = parseRefutation(refutation);
  return set.candidates.map((c, i) => {
    const r = parsed.get(i + 1);
    if (r === undefined) return { verdict: 'unverified', evidence: null };
    if (r.title !== c.title) return { verdict: 'unmatched', evidence: r.evidence };
    return { verdict: r.verdict, evidence: r.evidence };
  });
}

// ─── Decision journal ────────────────────────────────────────────────────────

const DECISIONS_PREAMBLE = [
  '# Architecture decisions',
  '',
  '<!-- Kept by `gsd-tools arch decide`. One block per candidate id; the id is a hash of the',
  'problem kind and the file set, and a rejected id is never proposed again. -->',
  '',
].join('\n');

const BLOCK_HEAD_RE = /^### (arch-[0-9a-f]{12}) · (accepted|rejected|deferred)[ \t]*$/;

interface JournalSegment {
  raw: string;
  entry: DecisionEntry | null;
}

function splitJournal(text: string): { preamble: string; blocks: JournalSegment[] } {
  const normalized = text.replace(/\r\n/g, '\n');
  const starts: number[] = [];
  const re = /^### /gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(normalized)) !== null) starts.push(m.index);
  if (starts.length === 0) return { preamble: normalized, blocks: [] };
  const blocks = starts.map((s, i) => {
    const raw = normalized.slice(s, i + 1 < starts.length ? starts[i + 1] : normalized.length);
    return { raw, entry: parseBlock(raw) };
  });
  return { preamble: normalized.slice(0, starts[0]), blocks };
}

function parseBlock(raw: string): DecisionEntry | null {
  const lines = raw.split('\n');
  const head = BLOCK_HEAD_RE.exec(lines[0]);
  if (head === null) return null;
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const f = /^- ([a-z]+): (.*)$/.exec(line);
    if (f !== null) fields[f[1]] = f[2].trim();
  }
  if (fields['title'] === undefined || fields['date'] === undefined) return null;
  return {
    id: head[1],
    disposition: head[2] as Disposition,
    title: fields['title'],
    kind: fields['kind'] ?? 'other',
    files: (fields['files'] ?? '').split(',').map((s) => s.trim().replace(/^`|`$/g, '')).filter((s) => s !== ''),
    date: fields['date'],
    survey: fields['survey'] ?? null,
    reason: fields['reason'] ?? null,
    route: fields['route'] ?? null,
  };
}

/** The parsed entries of a journal; blocks that are not entries are kept on write but not returned. */
export function parseDecisions(text: string | null): { entries: DecisionEntry[]; unparsed: number } {
  if (text === null) return { entries: [], unparsed: 0 };
  const { blocks } = splitJournal(text);
  return {
    entries: blocks.filter((b) => b.entry !== null).map((b) => b.entry as DecisionEntry),
    unparsed: blocks.filter((b) => b.entry === null).length,
  };
}

export function renderDecisionBlock(e: DecisionEntry): string {
  if (!ID_RE.test(e.id)) throw new TypeError(`arch-survey: bad candidate id ${JSON.stringify(e.id)}`);
  return [
    `### ${e.id} · ${e.disposition}`,
    `- title: ${oneLine(e.title)}`,
    `- kind: ${oneLine(e.kind)}`,
    `- files: ${e.files.map((f) => `\`${f}\``).join(', ')}`,
    `- date: ${e.date}`,
    ...(e.survey !== null ? [`- survey: ${e.survey}`] : []),
    ...(e.reason !== null ? [`- reason: ${oneLine(e.reason)}`] : []),
    ...(e.route !== null ? [`- route: ${oneLine(e.route)}`] : []),
    '',
    '',
  ].join('\n');
}

function blankLineEnd(s: string): string {
  return `${s.replace(/\n*$/, '')}\n\n`;
}

/**
 * The journal with `entry` recorded: its block replaced in place when the id is already there,
 * appended otherwise. Everything else — hand-written notes, blocks this parser does not
 * understand — is kept, up to the markdown normalisation every write applies.
 */
export function upsertDecision(text: string | null, entry: DecisionEntry): string {
  const rendered = renderDecisionBlock(entry);
  if (text === null || text.trim() === '') return asWritten(`${DECISIONS_PREAMBLE}\n${rendered}`);
  const { preamble, blocks } = splitJournal(text);
  let head = preamble;
  const at = blocks.findIndex((b) => b.entry?.id === entry.id);
  if (at >= 0) {
    blocks[at] = { raw: rendered, entry };
  } else {
    // The new block starts after a blank line; only trailing newlines of what precedes it change.
    if (blocks.length > 0) blocks[blocks.length - 1].raw = blankLineEnd(blocks[blocks.length - 1].raw);
    else head = blankLineEnd(head);
    blocks.push({ raw: rendered, entry });
  }
  return asWritten(`${head}${blocks.map((b) => b.raw).join('')}`);
}

// ─── Report ──────────────────────────────────────────────────────────────────

const HOT_CLASS = Object.freeze({ name: 'hot', style: 'fill:#fde2e1,stroke:#d33' });
const CONTEXT_CLASS = Object.freeze({ name: 'ctx', style: 'fill:#f2f2f2,stroke:#9e9e9e,color:#555' });

/**
 * The import structure of `files` as a flowchart spec, from the metrics only: import edges among
 * them (an edge inside a runtime cycle in red), co-change pairs without an import as dotted
 * links, hot spots marked. `context` files are drawn greyed as outside neighbours. The model
 * never draws these: a picture of the structure is data, not judgement.
 */
export function structureSpec(metrics: ArchMetrics, files: readonly string[], context: readonly string[] = []): FlowchartSpec {
  const ids = createIdRegistry('m');
  const inSet = new Set([...files, ...context]);
  const hot = new Set(metrics.hotspots.map((h) => h.file));
  const runtimeCycles = metrics.cycles.filter((c) => c.runtime).map((c) => new Set(c.members));
  const nodes: FlowNode[] = [...files, ...context].map((f) => ({
    id: ids.id(f),
    label: f,
    ...(context.includes(f) ? { className: CONTEXT_CLASS.name } : hot.has(f) ? { className: HOT_CLASS.name } : {}),
  }));
  const edges: FlowEdge[] = [];
  for (const [from, to] of metrics.edges) {
    if (!inSet.has(from) || !inSet.has(to)) continue;
    const cyclic = runtimeCycles.some((c) => c.has(from) && c.has(to));
    edges.push({ from: ids.id(from), to: ids.id(to), ...(cyclic ? { linkStyle: DEFECT_LINK_STYLE } : {}) });
  }
  for (const p of metrics.coChange) {
    if (p.importLinked || !inSet.has(p.a) || !inSet.has(p.b)) continue;
    edges.push({ from: ids.id(p.a), to: ids.id(p.b), line: 'dotted', arrow: false, label: `co-change ${p.support}` });
  }
  return { direction: 'LR', nodes, edges, classDefs: [{ ...HOT_CLASS }, { ...CONTEXT_CLASS }] };
}

/** Direct production neighbours of `files` outside them, sorted, capped. */
function neighbours(metrics: ArchMetrics, files: readonly string[], cap: number): string[] {
  const set = new Set(files);
  const out = new Set<string>();
  for (const [from, to] of metrics.edges) {
    if (set.has(from) && !set.has(to)) out.add(to);
    if (set.has(to) && !set.has(from)) out.add(from);
  }
  return [...out].sort(cmp).slice(0, cap);
}

/** The first candidate in report order that survived verification (or, with no verification at all, the first). */
export function topRecommendation(set: CandidateSet, verification: readonly Verification[]): string | null {
  const upheld = set.candidates.find((_c, i) => verification[i]?.verdict === 'upheld');
  if (upheld !== undefined) return upheld.id;
  if (verification.every((v) => v.verdict === 'unverified')) return set.candidates[0]?.id ?? null;
  return null;
}

/** Neighbours drawn around a candidate's files. */
const CANDIDATE_CONTEXT_CAP = 8;
/** Hot spots listed in the report. */
const REPORT_HOTSPOTS = 10;

export type ZoneOutcome = 'candidates' | 'no-strong-candidates' | 'missing' | 'invalid';

/**
 * The structures `arch metrics` finds by counting, reported as found without a surveyor. The
 * surveyor prompt leaves them out: handed to the model, the metrics pulled cards toward these
 * classes and away from the ones counting cannot see (pocock wave 3 eval).
 */
interface Glue {
  /** The candidate id a card about this structure has: a cycle over its members, a pass-through over its module, a cluster as a shallow module over its modules. */
  id: string;
  /** The id of the kept card glued to it, or null when no surveyor carded it. */
  carded: string | null;
}

export interface FoundByMetrics {
  cycles: Array<ArchMetrics['cycles'][number] & Glue>;
  passThrough: Array<ArchMetrics['passThrough'][number] & Glue>;
  smallClusters: Array<ArchMetrics['smallClusters'][number] & Glue>;
}

type CountedStructures = Pick<ArchMetrics, 'cycles' | 'passThrough' | 'smallClusters'>;

export function foundByMetrics(metrics: CountedStructures, cardedIds: ReadonlySet<string> = new Set()): FoundByMetrics {
  const glue = (kind: ProblemKind, files: readonly string[]): Glue => {
    const id = candidateId(kind, files);
    return { id, carded: cardedIds.has(id) ? id : null };
  };
  return {
    cycles: (metrics.cycles ?? []).map((c) => ({ members: [...c.members], runtime: c.runtime, ...glue('cycle', c.members) })),
    passThrough: (metrics.passThrough ?? []).map((p) => ({ ...p, ...glue('pass-through', [p.file]) })),
    smallClusters: (metrics.smallClusters ?? []).map((c) => ({ dir: c.dir, modules: [...c.modules], ...glue('shallow-module', c.modules) })),
  };
}

/** The candidate ids of every structure the metrics found — what a duplicate card would be. */
export function metricsFindingIds(metrics: CountedStructures): Set<string> {
  const f = foundByMetrics(metrics);
  return new Set([...f.cycles, ...f.passThrough, ...f.smallClusters].map((x) => x.id));
}

/** The survey report as data — `renderSurvey` only formats it. */
export interface SurveyDoc {
  date: string;
  header: {
    paths: string[] | null;
    window: string;
    commits: number;
    historyStatus: string;
    historyReason: string | null;
    hotspotBasis: ArchMetrics['hotspotBasis'];
    metricsStatus: ArchMetrics['status'];
    metricsReasons: string[];
  };
  /** `no-strong-candidates` when no Strong card survived verification. */
  verdict: 'candidates' | 'no-strong-candidates';
  comparison: Comparison | null;
  hotspots: ArchMetrics['hotspots'];
  zones: Array<{ id: string; seed: string; label: string; files: string[]; score: number; outcome: ZoneOutcome; diagram: FlowchartSpec }>;
  foundByMetrics: FoundByMetrics;
  kept: Array<{ candidate: Candidate; verification: Verification; diagram: FlowchartSpec }>;
  top: string | null;
  rejected: Array<{ id: string; title: string; reason: 'refuted' | 'missing-files'; detail: string }>;
  excluded: CandidateSet['excludedByDecision'];
  invalid: InvalidCard[];
}

export function buildSurvey(input: {
  metrics: ArchMetrics & { comparison?: Comparison };
  set: CandidateSet;
  verification: readonly Verification[];
}): SurveyDoc {
  const { metrics, set, verification } = input;
  if (verification.length !== set.candidates.length) {
    throw new TypeError(`arch-survey: ${verification.length} verifications for ${set.candidates.length} candidates`);
  }
  const pairs = set.candidates.map((candidate, i) => ({ candidate, verification: verification[i] }));
  const kept = pairs.filter((p) => p.verification.verdict !== 'refuted');
  const outcomeOf = (id: string): ZoneOutcome => {
    const z = set.zones.find((s) => s.id === id);
    if (z === undefined || z.status === 'missing') return 'missing';
    if (z.status === 'invalid') return 'invalid';
    return z.verdict ?? 'missing';
  };
  return {
    date: set.date,
    header: {
      paths: metrics.scope.paths,
      window: metrics.scope.window,
      commits: metrics.history.commits,
      historyStatus: metrics.history.status,
      historyReason: metrics.history.reason,
      hotspotBasis: metrics.hotspotBasis,
      metricsStatus: metrics.status,
      metricsReasons: [...metrics.reasons],
    },
    verdict: kept.some((p) => p.candidate.strength === 'strong') ? 'candidates' : 'no-strong-candidates',
    comparison: metrics.comparison !== undefined && metrics.comparison.baseline !== null ? metrics.comparison : null,
    hotspots: metrics.hotspots.slice(0, REPORT_HOTSPOTS),
    zones: metrics.zones.map((z) => ({
      id: z.id, seed: z.seed, label: z.label, files: [...z.files], score: z.score,
      outcome: outcomeOf(z.id), diagram: structureSpec(metrics, z.files),
    })),
    foundByMetrics: foundByMetrics(metrics, new Set(kept.map((p) => p.candidate.id))),
    kept: kept.map((p) => ({
      ...p,
      diagram: structureSpec(metrics, p.candidate.files, neighbours(metrics, p.candidate.files, CANDIDATE_CONTEXT_CAP)),
    })),
    top: topRecommendation(set, verification),
    rejected: [
      ...pairs.filter((p) => p.verification.verdict === 'refuted').map((p) => ({
        id: p.candidate.id, title: p.candidate.title, reason: 'refuted' as const, detail: p.verification.evidence ?? '',
      })),
      ...set.failedCheck.map((f) => ({ id: f.id, title: f.title, reason: 'missing-files' as const, detail: f.files.join(', ') })),
    ],
    excluded: set.excludedByDecision,
    invalid: set.invalid,
  };
}

function strengthLabel(s: Strength): string {
  return s === 'strong' ? 'Strong' : s === 'worth-exploring' ? 'Worth exploring' : 'Speculative';
}

function verificationLabel(v: Verification): string {
  switch (v.verdict) {
    case 'upheld': return 'upheld by the refuter';
    case 'refuted': return 'refuted';
    case 'unmatched': return 'not verified (the refuter reply did not match this finding)';
    case 'unverified': return 'not verified';
  }
}

function outcomeLabel(o: ZoneOutcome): string {
  return o === 'missing' ? 'no cards file' : o === 'invalid' ? 'malformed cards file' : o;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function code(files: readonly string[]): string {
  return files.map((f) => `\`${f}\``).join(', ');
}

/** SURVEY-<date>.md: every word that is not the surveyors' card text comes from data. */
export function renderSurvey(doc: SurveyDoc): string {
  const h = doc.header;
  const out: string[] = [
    derivedMarker('gsd-tools arch report'),
    `# Architecture survey — ${doc.date}`,
    '',
    `- Scope: ${h.paths === null ? 'whole project' : code(h.paths)}; window \`${h.window}\` (${h.commits} commits, history ${h.historyStatus}${h.historyReason !== null ? `: ${h.historyReason}` : ''})`,
    `- Hot spots ranked by ${h.hotspotBasis === 'churn-x-complexity' ? 'churn × complexity' : 'complexity alone (no readable history in the window)'}`,
    `- Metrics: ${h.metricsStatus}${h.metricsReasons.length > 0 ? ` (${h.metricsReasons.join(', ')})` : ''}`,
    `- Verdict: ${doc.verdict === 'candidates' ? 'strong candidates found' : '**no strong candidates**'} — ${doc.kept.length} kept, ${doc.rejected.length} rejected on verification, ${doc.excluded.length} excluded by earlier decisions`,
    '',
    'Metrics are signals for where to look, never verdicts. Depth is leverage at the interface, not a',
    'ratio of implementation to interface lines.',
    '',
  ];

  if (doc.comparison !== null) {
    const c = doc.comparison;
    out.push(`## Since the survey of ${c.baseline ?? ''}`, '');
    if (!c.signal) out.push(`No hot spot grew by more than ${Math.round(c.threshold * 100)}%, none entered, no new cycle.`);
    for (const g of c.grown) out.push(`- grew: \`${g.file}\` ${g.before} → ${g.after} (+${Math.round(g.growth * 100)}%)`);
    for (const e of c.entered) out.push(`- entered the hot spots: \`${e.file}\` (${e.score})`);
    for (const cy of c.newCycles) out.push(`- new cycle: ${code(cy)}`);
    out.push('');
  }

  out.push('## Hot spots', '', '| # | File | Churn | Complexity | Score |', '|---|---|---|---|---|');
  doc.hotspots.forEach((x, i) => out.push(`| ${i + 1} | \`${cell(x.file)}\` | ${x.churn} | ${x.complexity} | ${x.score} |`));
  if (doc.hotspots.length === 0) out.push('| – | none | | | |');
  out.push('', '## Zones', '', '| Zone | Seed | Files | Score | Surveyor |', '|---|---|---|---|---|');
  for (const z of doc.zones) out.push(`| ${z.id} | \`${cell(z.seed)}\` | ${z.files.length} | ${z.score} | ${outcomeLabel(z.outcome)} |`);
  out.push('');
  for (const z of doc.zones) out.push(`### ${z.id} — \`${z.label}\``, '', fence(flowchart(z.diagram)), '');

  const found = doc.foundByMetrics;
  out.push('## Found by metrics', '', 'Counted by `gsd-tools arch metrics`, not by a surveyor: each is a structure that exists, not a verdict on it.', '');
  const carded = (g: Glue): string => (g.carded === null ? '' : ` — carded below as \`${g.carded}\``);
  for (const c of found.cycles) out.push(`- Import cycle${c.runtime ? '' : ' (type-only)'}: ${code(c.members)}${carded(c)}`);
  for (const p of found.passThrough) out.push(`- Pass-through module: \`${p.file}\` (${p.loc} lines) — its only importer \`${p.importer}\`, its only import \`${p.target}\`${carded(p)}`);
  for (const c of found.smallClusters) out.push(`- Small-module cluster in \`${c.dir}\`: ${code(c.modules)}${carded(c)}`);
  if (found.cycles.length + found.passThrough.length + found.smallClusters.length === 0) out.push('None: no import cycle, pass-through module or small-module cluster in scope.');
  out.push('');

  out.push('## Candidates', '');
  if (doc.kept.length === 0) out.push('No candidate survived. The zones above were surveyed and nothing earned a card.', '');
  for (const { candidate: c, verification: v, diagram } of doc.kept) {
    out.push(
      `### ${c.title}`,
      '',
      `\`${c.id}\` · **${strengthLabel(c.strength)}** · ${c.kind} · zone ${[c.zone, ...c.alsoFrom].join(', ')} · ${verificationLabel(v)}`,
      '',
      `**Files:** ${code(c.files)}`,
      '',
      `**Problem.** ${c.problem}`,
      '',
      `**Solution.** ${c.solution}`,
      '',
      `**Benefits.** ${c.benefits}`,
      '',
      ...(c.tests !== '' ? [`**Tests.** ${c.tests}`, ''] : []),
      `**Deletion test:** ${c.deletionTest.result}${c.deletionTest.evidence !== '' ? ` — ${c.deletionTest.evidence}` : ''}`,
      '',
      ...(c.fromMetrics ? ['_The metrics found this structure too (same kind, same files): one candidate, listed once._', ''] : []),
      ...(c.demoted !== null ? ['_Proposed as Strong without a deletion test that concentrates complexity — shown as Worth exploring._', ''] : []),
      ...(c.adrConflict !== null ? [`> **ADR conflict:** ${c.adrConflict}`, ''] : []),
      ...(c.priorDecision !== null ? [`_Already decided: ${c.priorDecision}._`, ''] : []),
      ...(v.evidence !== null && v.evidence !== '' ? [`_Verification:_ ${v.evidence}`, ''] : []),
      fence(flowchart(diagram)),
      '',
    );
  }

  const top = doc.top === null ? undefined : doc.kept.find((k) => k.candidate.id === doc.top)?.candidate;
  out.push('## Top recommendation', '', top === undefined ? 'None.' : `\`${top.id}\` — ${top.title} (${strengthLabel(top.strength)}, zone ${top.zone}).`, '');

  if (doc.rejected.length > 0) {
    out.push('## Rejected on verification', '');
    for (const r of doc.rejected) out.push(`- \`${r.id}\` ${r.title} — ${r.reason}: ${r.detail}`);
    out.push('');
  }
  if (doc.excluded.length > 0) {
    out.push('## Excluded by earlier decisions', '');
    for (const e of doc.excluded) out.push(`- \`${e.id}\` ${e.title} — rejected before: ${e.reason}`);
    out.push('');
  }
  if (doc.invalid.length > 0) {
    out.push('## Malformed cards', '');
    for (const inv of doc.invalid) out.push(`- ${inv.source}${inv.index !== null ? ` #${inv.index}` : ''}: ${inv.problems.join('; ')}`);
    out.push('');
  }
  return asWritten(out.join('\n'));
}
