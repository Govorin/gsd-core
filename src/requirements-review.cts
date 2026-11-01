/**
 * Requirements review (ADR-5212) — the deterministic half of a milestone's requirements review, run
 * at `roadmap:pre` by `/gsd:requirements-review` (capability `mn-requirements-review`): after
 * REQUIREMENTS.md is committed and before the roadmapper turns it into phases.
 *
 *   prepareReview  run.json and one report path per lens; reports of an earlier run are removed so a
 *                  lens that fails this time cannot be read from last time.
 *   composeReview  REQUIREMENTS-REVIEW.md from the lens reports, the refuter's verdicts and the
 *                  accepted risks: lenses keep their own sections, nothing is merged or re-ranked.
 *   acceptFindings a surviving critical finding recorded as a known risk (ACCEPTED.json), then the
 *                  review is composed again so the document says so.
 *   judgeReview    (pure) what the `roadmap:pre` gate decides from the composed review.
 *
 * The lens agents (`gsd-requirements-reviewer`) and the refuter (`gsd-finding-refuter`, mode
 * `requirements`) supply the judgement; nothing here asks a model. A finding's identity across runs
 * is its fingerprint — lens, requirement and normalised title — never its renumbered ID.
 *
 * Every read here is of files this module or its agents wrote under the planning directory; reads
 * report absence (`null`) only for ENOENT/ENOTDIR and rethrow anything else, so "could not read"
 * never reads as "not there".
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { retryRenameSync } from './shell-command-projection.cjs';
import { normalizeEol, splitLines } from './text-lines.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import frontmatterMod = require('./frontmatter.cjs');
const { rawFrontmatterField } = frontmatterMod;

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/** The lenses, in report order. Each runs in its own fresh agent context. */
export const REQUIREMENTS_REVIEW_LENSES = Object.freeze(['data', 'compat', 'security', 'testability'] as const);
export type RequirementsLens = (typeof REQUIREMENTS_REVIEW_LENSES)[number];

/** What each lens asks of the requirements — the one-line brief the workflow hands its agent. */
export const LENS_FOCUS: Readonly<Record<RequirementsLens, string>> = Object.freeze({
  data: 'data and migrations: persisted data a requirement changes, the migrations, backfills and recomputations that change needs, and whether they apply in every environment and branch that has to run them',
  compat: 'client compatibility: shipped clients and published API contracts a requirement changes or gates, and whether already-released versions keep working',
  security: 'security: authentication, authorization, input, secrets and personal data a requirement touches, and the abuse it opens',
  testability: 'testability: whether each requirement can be verified as written — an observable outcome, a threshold, an environment that can show it — and whether requirements contradict each other or the code',
});

export const REVIEW_DIR = 'requirements-review';
export const REVIEW_FILE = 'REQUIREMENTS-REVIEW.md';
export const REQUIREMENTS_FILE = 'REQUIREMENTS.md';
const RUN_FILE = 'run.json';
const REFUTATION_FILE = 'REFUTATION.md';
const ACCEPTED_FILE = 'ACCEPTED.json';
const REPORT_RE = /^REVIEW-[a-z]+\.md$/;

export interface ReviewPaths {
  dir: string;
  run: string;
  refutation: string;
  accepted: string;
  review: string;
  requirements: string;
}

/** Where a review of `planning` (a planning directory, workstream-scoped or not) lives. */
export function reviewPaths(planning: string): ReviewPaths {
  const dir = path.join(planning, REVIEW_DIR);
  return {
    dir,
    run: path.join(dir, RUN_FILE),
    refutation: path.join(dir, REFUTATION_FILE),
    accepted: path.join(dir, ACCEPTED_FILE),
    review: path.join(planning, REVIEW_FILE),
    requirements: path.join(planning, REQUIREMENTS_FILE),
  };
}

export function lensReportPath(dir: string, lens: RequirementsLens): string {
  return path.join(dir, `REVIEW-${lens}.md`);
}

/** The digest a review is bound to. EOL-normalised, so a checkout's line endings never stale it. */
export function requirementsDigest(text: string): string {
  return crypto.createHash('sha256').update(normalizeEol(text)).digest('hex');
}

/**
 * A lens list from config or `--lens`: comma-separated or an array, canonical order, no duplicates.
 * An unknown lens or an empty list is an error, never silently narrowed to what was recognised.
 */
export function parseLenses(value: unknown): { ok: true; lenses: RequirementsLens[] } | { ok: false; message: string } {
  const entries = Array.isArray(value)
    ? value.map((v) => String(v).trim())
    : typeof value === 'string' ? value.split(',').map((s) => s.trim()) : null;
  if (entries === null) return { ok: false, message: `lenses must be a comma-separated list of ${REQUIREMENTS_REVIEW_LENSES.join(', ')}` };
  const named = entries.filter((e) => e !== '');
  const known = REQUIREMENTS_REVIEW_LENSES as readonly string[];
  const unknown = named.filter((e) => !known.includes(e));
  if (unknown.length > 0) return { ok: false, message: `unknown lens ${unknown.join(', ')} (known: ${known.join(', ')})` };
  const lenses = REQUIREMENTS_REVIEW_LENSES.filter((l) => named.includes(l));
  if (lenses.length === 0) return { ok: false, message: `no lens named (known: ${known.join(', ')})` };
  return { ok: true, lenses };
}

// ─── Reading what the agents wrote ───────────────────────────────────────────

export type Severity = 'critical' | 'warning' | 'info';

export interface LensFinding {
  id: string;
  severity: Severity;
  title: string;
  /** The `**Requirement:**` value (a REQ-ID, several, or `cross-cutting`); null when absent. */
  requirement: string | null;
  /** Heading line through the line before the next heading of level 1–3. */
  block: string;
}

const FINDING_HEADING = /^### ((?:CR|WR|IN)-\d+):[ \t]*(.*)$/;
const ANY_HEADING = /^#{1,3} /;
const REQUIREMENT_LINE = /\*\*Requirement:\*\*\s*(.+)$/m;
const SEVERITY_BY_PREFIX: Readonly<Record<string, Severity>> = Object.freeze({ CR: 'critical', WR: 'warning', IN: 'info' });

/** The `### CR-01: …` / `WR-` / `IN-` findings of a lens report, in document order. */
export function parseLensFindings(text: string): LensFinding[] {
  const lines = splitLines(text);
  const findings: LensFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FINDING_HEADING.exec(lines[i]);
    if (m === null) continue;
    let end = i + 1;
    while (end < lines.length && !ANY_HEADING.test(lines[end])) end++;
    const block = lines.slice(i, end).join('\n').replace(/\n+$/, '');
    const req = REQUIREMENT_LINE.exec(block);
    findings.push({
      id: m[1],
      severity: SEVERITY_BY_PREFIX[m[1].slice(0, 2)],
      title: m[2].trim(),
      requirement: req === null ? null : req[1].replace(/[`*]/g, '').trim(),
      block,
    });
    i = end - 1;
  }
  return findings;
}

export interface Verdict {
  lens: RequirementsLens;
  id: string;
  verdict: 'upheld' | 'refuted';
  evidence: string;
}

const REFUTATION_HEADING = new RegExp(`^### (${REQUIREMENTS_REVIEW_LENSES.join('|')}) ((?:CR|WR|IN)-\\d+):`);

/**
 * The refuter's verdicts (`gsd-finding-refuter`, mode `requirements`): `### <lens> <ID>: <title>`,
 * then `verdict: UPHELD | REFUTED` and `evidence: …`. A heading with no readable verdict is UPHELD —
 * a finding nobody could check must not be dropped.
 */
export function parseRefutation(text: string): Verdict[] {
  const lines = splitLines(text);
  const verdicts: Verdict[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = REFUTATION_HEADING.exec(lines[i]);
    if (m === null) continue;
    let verdict: Verdict['verdict'] = 'upheld';
    let evidence = '';
    for (let j = i + 1; j < lines.length && !ANY_HEADING.test(lines[j]); j++) {
      const v = /^verdict:\s*(UPHELD|REFUTED)\b/i.exec(lines[j]);
      if (v !== null) verdict = v[1].toUpperCase() === 'REFUTED' ? 'refuted' : 'upheld';
      const e = /^evidence:\s*(.*)$/i.exec(lines[j]);
      if (e !== null) evidence = e[1].trim();
    }
    verdicts.push({ lens: m[1] as RequirementsLens, id: m[2], verdict, evidence });
  }
  return verdicts;
}

const REQ_ID_RE = /[A-Z][A-Z0-9]*-[A-Za-z0-9_-]+/g;

/** The REQ-IDs a finding's `**Requirement:**` value names, sorted and unique (none for `cross-cutting`). */
export function requirementRefs(requirement: string | null): string[] {
  return [...new Set((requirement ?? '').match(REQ_ID_RE) ?? [])].sort();
}

/** One requirement's text, as the fingerprint binds to it: whitespace-collapsed, then digested. */
export function requirementTextDigest(text: string): string {
  return crypto.createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/**
 * A finding's identity across runs, and what an acceptance binds to: the lens, the requirements it
 * names and THE TEXT of each as the run read it (`run.requirementDigests`) — never its renumbered ID
 * and never its title, which a fresh lens agent words differently every run. A finding naming no
 * known REQ-ID (`cross-cutting`) binds to the whole REQUIREMENTS.md digest. So an accepted risk stays
 * accepted when the review runs again over the same requirement, and is released the moment that
 * requirement's text changes. Two findings of one lens about one requirement share the identity: an
 * acceptance is of "this requirement, as written, along this lens".
 */
export function findingFingerprint(lens: string, requirement: string | null, run: Pick<RunRecord, 'requirementDigests' | 'requirementsSha256'>): string {
  const refs = requirementRefs(requirement);
  const bound = refs.length === 0
    ? `*=${run.requirementsSha256}`
    : refs.map((id) => `${id}=${(run.requirementDigests ?? {})[id] ?? 'unknown'}`).join('\0');
  const digest = crypto.createHash('sha256').update(`${lens}\0${bound}`).digest('hex').slice(0, 10);
  return `rq:${digest}`;
}

// ─── Accepted risks ──────────────────────────────────────────────────────────

export interface AcceptedRisk {
  fingerprint: string;
  id: string;
  lens: string;
  title: string;
  reason: string;
  milestone: string | null;
  acceptedAt: string;
}

/** The accepted-risk journal; a file that exists but is not the journal's shape throws (never "none accepted"). */
export function parseAccepted(text: string): AcceptedRisk[] {
  const data: unknown = JSON.parse(text);
  const list = (data as { accepted?: unknown } | null)?.accepted;
  if (!Array.isArray(list)) throw new Error(`${ACCEPTED_FILE} has no "accepted" list`);
  return list.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (typeof e?.fingerprint !== 'string' || typeof e.reason !== 'string') throw new Error(`${ACCEPTED_FILE} entry ${i} needs a fingerprint and a reason`);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      fingerprint: e.fingerprint,
      id: str(e.id),
      lens: str(e.lens),
      title: str(e.title),
      reason: e.reason,
      milestone: typeof e.milestone === 'string' ? e.milestone : null,
      acceptedAt: str(e.acceptedAt),
    };
  });
}

/** The fingerprints accepted for `milestone` — an acceptance never carries over to another milestone. */
export function acceptedFor(accepted: readonly AcceptedRisk[], milestone: string | null): Set<string> {
  return new Set(accepted.filter((a) => a.milestone === milestone).map((a) => a.fingerprint));
}

// ─── Compose ─────────────────────────────────────────────────────────────────

export interface RunRecord {
  version: 1;
  milestone: string | null;
  requirements: string;
  requirementsSha256: string;
  requirementIds: string[];
  /** REQ-ID → digest of its text (`requirementTextDigest`); what a finding's identity binds to. */
  requirementDigests: Record<string, string>;
  lenses: RequirementsLens[];
  preparedAt: string;
}

export interface ComposeInput {
  run: RunRecord;
  reports: ReadonlyArray<{ lens: RequirementsLens; text: string | null }>;
  /** The refuter's output, or null when it did not run. */
  refutation: string | null;
  accepted: readonly AcceptedRisk[];
  reviewedAt: string;
}

export interface ComposedFinding {
  id: string;
  lens: RequirementsLens;
  lensId: string;
  severity: Severity;
  title: string;
  requirement: string | null;
  verification: 'upheld' | 'unverified';
  fingerprint: string;
  accepted: boolean;
}

export type ReviewStatus = 'clean' | 'issues_found' | 'incomplete';

export interface ComposedReview {
  text: string;
  status: ReviewStatus;
  counts: { critical: number; warning: number; info: number; total: number; refuted: number; unverified: number; accepted: number; blocking: number };
  findings: ComposedFinding[];
  missingReports: RequirementsLens[];
}

/**
 * The milestone's REQUIREMENTS-REVIEW.md. Lens reports keep their own sections in lens order and
 * their findings their own order; IDs are renumbered across the document and every finding names
 * the lens report and ID it came from, its verification and its fingerprint. A critical finding the
 * refuter did not refute (upheld, or unverified because no refutation ran) and nobody accepted is
 * blocking. A lens that was expected but wrote nothing is named, and with no findings the review is
 * `incomplete`, never `clean`.
 */
export function composeReview(input: ComposeInput): ComposedReview {
  const verdicts = input.refutation === null ? [] : parseRefutation(input.refutation);
  const accepted = acceptedFor(input.accepted, input.run.milestone);
  const reasons = new Map(input.accepted.filter((a) => a.milestone === input.run.milestone).map((a) => [a.fingerprint, a.reason]));
  const counters = { CR: 0, WR: 0, IN: 0 };
  const counts = { critical: 0, warning: 0, info: 0, total: 0, refuted: 0, unverified: 0, accepted: 0, blocking: 0 };
  const sections: string[] = [];
  const refutedLines: string[] = [];
  const missingReports: RequirementsLens[] = [];
  const findings: ComposedFinding[] = [];

  const run = input.run;
  for (const report of input.reports) {
    if (report.text === null) {
      missingReports.push(report.lens);
      continue;
    }
    const body: string[] = [];
    for (const f of parseLensFindings(report.text)) {
      const verdict = verdicts.find((v) => v.lens === report.lens && v.id === f.id);
      if (verdict?.verdict === 'refuted') {
        counts.refuted++;
        refutedLines.push(`- ${report.lens} ${f.id}: ${f.title} — ${verdict.evidence || 'no evidence recorded'}`);
        continue;
      }
      const prefix = f.severity === 'critical' ? 'CR' : f.severity === 'warning' ? 'WR' : 'IN';
      counters[prefix]++;
      counts[f.severity]++;
      counts.total++;
      const verification = verdict === undefined ? 'unverified' : 'upheld';
      if (verification === 'unverified') counts.unverified++;
      const fingerprint = findingFingerprint(report.lens, f.requirement, run);
      const isAccepted = f.severity === 'critical' && accepted.has(fingerprint);
      if (isAccepted) counts.accepted++;
      if (f.severity === 'critical' && !isAccepted) counts.blocking++;
      const id = `${prefix}-${String(counters[prefix]).padStart(2, '0')}`;
      findings.push({ id, lens: report.lens, lensId: f.id, severity: f.severity, title: f.title, requirement: f.requirement, verification, fingerprint, accepted: isAccepted });
      const [, ...rest] = f.block.split('\n');
      const origin = `_Lens: ${report.lens} ${f.id} · verification: ${verification} · id: ${fingerprint}_`;
      const acceptance = isAccepted ? [`_Accepted as a known risk: ${reasons.get(fingerprint) ?? ''}_`] : [];
      body.push([`### ${id}: ${f.title}`, origin, ...acceptance, ...rest].join('\n'));
    }
    sections.push(`## Lens: ${report.lens}\n\n${body.length === 0 ? 'No findings.' : body.join('\n\n')}`);
  }

  const status: ReviewStatus = counts.total > 0 ? 'issues_found' : missingReports.length > 0 ? 'incomplete' : 'clean';
  const frontmatter = [
    '---',
    // No milestone, no key: this repo's frontmatter reader returns a YAML `null` scalar as the
    // string "null", which would bind acceptances to a milestone named "null".
    ...(run.milestone === null ? [] : [`milestone: ${JSON.stringify(run.milestone)}`]),
    `requirements: ${JSON.stringify(run.requirements)}`,
    `requirements_sha256: ${JSON.stringify(run.requirementsSha256)}`,
    `reviewed: ${JSON.stringify(input.reviewedAt)}`,
    `lenses: ${JSON.stringify(input.reports.map((r) => r.lens))}`,
    'findings:',
    `  critical: ${counts.critical}`,
    `  warning: ${counts.warning}`,
    `  info: ${counts.info}`,
    `  total: ${counts.total}`,
    `refuted: ${counts.refuted}`,
    `unverified: ${counts.unverified}`,
    `accepted: ${counts.accepted}`,
    `blocking: ${counts.blocking}`,
    `missing_reports: ${JSON.stringify(missingReports)}`,
    `status: ${status}`,
    '---',
  ].join('\n');
  const parts = [
    frontmatter,
    '',
    `# Requirements Review${run.milestone === null ? '' : `: ${run.milestone}`}`,
    '',
    `**Requirements:** \`${run.requirements}\` (${run.requirementIds.length} IDs)  **Status:** ${status}  **Blocking:** ${counts.blocking}`,
    '',
    'Each lens is its own section, findings in the order the lens reported them. A critical finding that survived refutation and was not accepted as a known risk holds the roadmap.',
    '',
    ...sections.flatMap((s) => [s, '']),
  ];
  if (refutedLines.length > 0) parts.push('## Refuted on verification', '', ...refutedLines, '');
  if (missingReports.length > 0) parts.push('## Lens reports not written', '', ...missingReports.map((l) => `- ${l}`), '');
  if (input.refutation === null) parts.push('_The refutation pass did not run: every finding is unverified, and an unverified critical finding blocks._', '');
  return { text: `${parts.join('\n').replace(/\n+$/, '')}\n`, status, counts, findings, missingReports };
}

// ─── The gate's judgement ────────────────────────────────────────────────────

const COMPOSED_FINDING = /^### ((?:CR|WR|IN)-\d+):[ \t]*(.*)$/;
const COMPOSED_ORIGIN = /^_Lens: (\S+) ((?:CR|WR|IN)-\d+) · verification: (\w+) · id: (rq:[0-9a-f]{10})_$/;

/** The findings of a composed REQUIREMENTS-REVIEW.md: heading ID and title, with their origin line. */
export function parseComposedFindings(text: string): Array<{ id: string; title: string; lens: string; severity: Severity; fingerprint: string }> {
  const lines = splitLines(text);
  const out: Array<{ id: string; title: string; lens: string; severity: Severity; fingerprint: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const h = COMPOSED_FINDING.exec(lines[i]);
    if (h === null) continue;
    const origin = i + 1 < lines.length ? COMPOSED_ORIGIN.exec(lines[i + 1]) : null;
    if (origin === null) continue;
    out.push({ id: h[1], title: h[2].trim(), lens: origin[1], severity: SEVERITY_BY_PREFIX[h[1].slice(0, 2)], fingerprint: origin[4] });
  }
  return out;
}

export type ReviewJudgement =
  | { kind: 'pass'; warnings: number; total: number; accepted: number }
  | { kind: 'stale'; reviewedSha256: string | null; currentSha256: string }
  | { kind: 'incomplete'; missing: string[] }
  | { kind: 'malformed'; problem: string }
  | { kind: 'blocking'; blocking: Array<{ id: string; lens: string; title: string }>; missing: string[] };

/**
 * What the gate decides, given the composed review, the current REQUIREMENTS.md and the accepted
 * risks: a review of other requirements is stale; a critical finding nobody refuted or accepted
 * blocks; a lens that never reported blocks (it was not reviewed); otherwise the roadmap may proceed.
 * Acceptances are re-read here, not trusted from the composed counts, so `accept` after compose counts.
 */
export function judgeReview(review: string, requirements: string, accepted: readonly AcceptedRisk[]): ReviewJudgement {
  const sha = rawFrontmatterField(review, 'requirements_sha256');
  const reviewedSha = typeof sha?.value === 'string' ? sha.value : null;
  const currentSha = requirementsDigest(requirements);
  if (reviewedSha === null) return { kind: 'malformed', problem: 'no requirements_sha256 in its frontmatter' };
  if (reviewedSha !== currentSha) return { kind: 'stale', reviewedSha256: reviewedSha, currentSha256: currentSha };
  const milestoneField = rawFrontmatterField(review, 'milestone');
  const milestone = typeof milestoneField?.value === 'string' && milestoneField.value !== '' ? milestoneField.value : null;
  const missingField = rawFrontmatterField(review, 'missing_reports');
  if (missingField === null || !Array.isArray(missingField.value)) return { kind: 'malformed', problem: 'no missing_reports list in its frontmatter' };
  const missing = missingField.value.map(String);
  const ok = acceptedFor(accepted, milestone);
  const findings = parseComposedFindings(review);
  const blocking = findings.filter((f) => f.severity === 'critical' && !ok.has(f.fingerprint)).map(({ id, lens, title }) => ({ id, lens, title }));
  if (blocking.length > 0) return { kind: 'blocking', blocking, missing };
  if (missing.length > 0) return { kind: 'incomplete', missing };
  return {
    kind: 'pass',
    warnings: findings.filter((f) => f.severity === 'warning').length,
    total: findings.length,
    accepted: findings.filter((f) => f.severity === 'critical' && ok.has(f.fingerprint)).length,
  };
}

// ─── Files ───────────────────────────────────────────────────────────────────

function isAbsent(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** A file's text, or null when it does not exist. Any other read failure is thrown. */
export function readTextOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (isAbsent(err)) return null;
    throw err;
  }
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    retryRenameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function listOrEmpty(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch (err) {
    if (isAbsent(err)) return [];
    throw err;
  }
}

export type ReviewFailure = { ok: false; reason: 'no-requirements' | 'no-run' | 'bad-run' | 'bad-accepted' | 'no-review' | 'unknown-id' | 'not-critical' | 'no-reason'; message: string };

export interface PrepareInput {
  planning: string;
  /** Project root, for the relative paths the result names. */
  cwd: string;
  /** `--milestone`; null → the milestone STATE.md names (new-milestone switched it in step 5), else none. */
  milestone: string | null;
  lenses: readonly RequirementsLens[];
  /**
   * True when the caller named the lenses (`--lens`): with a run of the SAME requirements on disk,
   * only these lenses run again and the other lenses' reports are kept (a re-review after a lens
   * failed or a blocking finding was disputed). Otherwise every report of an earlier run is removed.
   */
  lensesExplicit: boolean;
  /** The requirements of a REQUIREMENTS.md text, `{id, text}` per REQ-ID (the caller owns the parser). */
  requirements: (text: string) => Array<{ id: string; text: string }>;
  now: () => Date;
}

export interface PrepareResult {
  ok: true;
  /** `partial`: the requirements are unchanged and only `reports` run again; `full`: a fresh run. */
  mode: 'full' | 'partial';
  dir: string;
  run: string;
  review: string;
  requirements: string;
  requirementsSha256: string;
  requirementCount: number;
  milestone: string | null;
  refutation: string;
  /** The lenses to run now — one agent each. */
  reports: Array<{ label: RequirementsLens; lens: RequirementsLens; focus: string; path: string }>;
  /** Lenses of the run whose reports are kept from the earlier run (partial mode only). */
  kept: RequirementsLens[];
  context: { project: string | null; codebase: string[]; researchSummary: string | null; milestones: string | null };
  removed: string[];
}

function rel(cwd: string, p: string): string {
  return path.relative(cwd, p).split(path.sep).join('/');
}

/** The milestone STATE.md's frontmatter names, or null (no STATE.md yet, as in new-project). */
function stateMilestone(planning: string): string | null {
  const text = readTextOrNull(path.join(planning, 'STATE.md'));
  if (text === null) return null;
  const value = rawFrontmatterField(text, 'milestone')?.value;
  return typeof value === 'string' && value !== '' && value !== 'null' ? value : null;
}

export function prepareReview(input: PrepareInput): PrepareResult | ReviewFailure {
  const paths = reviewPaths(input.planning);
  const requirements = readTextOrNull(paths.requirements);
  if (requirements === null) return { ok: false, reason: 'no-requirements', message: `no ${REQUIREMENTS_FILE} at ${rel(input.cwd, paths.requirements)} — define the milestone's requirements first` };
  const sha = requirementsDigest(requirements);
  const previous = readTextOrNull(paths.run) === null ? null : readRun(paths);
  const prior = input.lensesExplicit && previous !== null && !isFailure(previous) && previous.requirementsSha256 === sha ? previous : null;
  const milestone = input.milestone ?? prior?.milestone ?? stateMilestone(input.planning);
  const runLenses = prior === null ? [...input.lenses] : REQUIREMENTS_REVIEW_LENSES.filter((l) => prior.lenses.includes(l) || input.lenses.includes(l));

  fs.mkdirSync(paths.dir, { recursive: true });
  const removed: string[] = [];
  const stale = (name: string): boolean => name === REFUTATION_FILE
    || (prior === null ? REPORT_RE.test(name) : input.lenses.some((l) => name === `REVIEW-${l}.md`));
  for (const name of listOrEmpty(paths.dir)) {
    if (stale(name)) {
      fs.rmSync(path.join(paths.dir, name), { force: true });
      removed.push(name);
    }
  }
  const items = input.requirements(requirements);
  const run: RunRecord = {
    version: 1,
    milestone,
    requirements: rel(input.cwd, paths.requirements),
    requirementsSha256: sha,
    requirementIds: items.map((r) => r.id),
    requirementDigests: Object.fromEntries(items.map((r) => [r.id, requirementTextDigest(r.text)])),
    lenses: runLenses,
    preparedAt: input.now().toISOString(),
  };
  writeAtomic(paths.run, `${JSON.stringify(run, null, 2)}\n`);
  const existing = (p: string): string | null => (readTextOrNull(p) === null ? null : rel(input.cwd, p));
  const codebaseDir = path.join(input.planning, 'codebase');
  return {
    ok: true,
    mode: prior === null ? 'full' : 'partial',
    dir: rel(input.cwd, paths.dir),
    run: rel(input.cwd, paths.run),
    review: rel(input.cwd, paths.review),
    requirements: run.requirements,
    requirementsSha256: sha,
    requirementCount: items.length,
    milestone,
    refutation: rel(input.cwd, paths.refutation),
    reports: input.lenses.map((lens) => ({ label: lens, lens, focus: LENS_FOCUS[lens], path: rel(input.cwd, lensReportPath(paths.dir, lens)) })),
    kept: runLenses.filter((l) => !input.lenses.includes(l)),
    context: {
      project: existing(path.join(input.planning, 'PROJECT.md')),
      codebase: listOrEmpty(codebaseDir).filter((n) => n.endsWith('.md')).map((n) => rel(input.cwd, path.join(codebaseDir, n))),
      researchSummary: existing(path.join(input.planning, 'research', 'SUMMARY.md')),
      milestones: existing(path.join(input.planning, 'MILESTONES.md')),
    },
    removed,
  };
}

function readRun(paths: ReviewPaths): RunRecord | ReviewFailure {
  const text = readTextOrNull(paths.run);
  if (text === null) return { ok: false, reason: 'no-run', message: `no ${RUN_FILE} in ${paths.dir} — run requirements-review prepare first` };
  let data: Partial<RunRecord>;
  try {
    data = JSON.parse(text) as Partial<RunRecord>;
  } catch (err) {
    return { ok: false, reason: 'bad-run', message: `${RUN_FILE} is not JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  const lenses = parseLenses(data.lenses);
  if (!lenses.ok || typeof data.requirementsSha256 !== 'string' || typeof data.requirements !== 'string') {
    return { ok: false, reason: 'bad-run', message: `${RUN_FILE} lacks lenses, requirements or requirementsSha256` };
  }
  return {
    version: 1,
    milestone: typeof data.milestone === 'string' ? data.milestone : null,
    requirements: data.requirements,
    requirementsSha256: data.requirementsSha256,
    requirementIds: Array.isArray(data.requirementIds) ? data.requirementIds.map(String) : [],
    requirementDigests: data.requirementDigests !== null && typeof data.requirementDigests === 'object' && !Array.isArray(data.requirementDigests)
      ? Object.fromEntries(Object.entries(data.requirementDigests).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : {},
    lenses: lenses.lenses,
    preparedAt: String(data.preparedAt ?? ''),
  };
}

function readAccepted(paths: ReviewPaths): AcceptedRisk[] | ReviewFailure {
  const text = readTextOrNull(paths.accepted);
  if (text === null) return [];
  try {
    return parseAccepted(text);
  } catch (err) {
    return { ok: false, reason: 'bad-accepted', message: `${rel(path.dirname(paths.dir), paths.accepted)} cannot be read as the accepted-risk journal: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function isFailure(value: unknown): value is ReviewFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}

export interface ComposeResult {
  ok: true;
  review: string;
  status: ReviewStatus;
  counts: ComposedReview['counts'];
  missingReports: RequirementsLens[];
  blocking: Array<{ id: string; lens: string; title: string; requirement: string | null }>;
  /** True when REQUIREMENTS.md changed after prepare: this review is of other requirements. */
  stale: boolean;
}

export function composeReviewFiles(planning: string, cwd: string, now: () => Date): ComposeResult | ReviewFailure {
  const paths = reviewPaths(planning);
  const run = readRun(paths);
  if (isFailure(run)) return run;
  const accepted = readAccepted(paths);
  if (isFailure(accepted)) return accepted;
  const composed = composeReview({
    run,
    reports: run.lenses.map((lens) => ({ lens, text: readTextOrNull(lensReportPath(paths.dir, lens)) })),
    refutation: readTextOrNull(paths.refutation),
    accepted,
    reviewedAt: now().toISOString(),
  });
  writeAtomic(paths.review, composed.text);
  const current = readTextOrNull(paths.requirements);
  return {
    ok: true,
    review: rel(cwd, paths.review),
    status: composed.status,
    counts: composed.counts,
    missingReports: composed.missingReports,
    blocking: composed.findings
      .filter((f) => f.severity === 'critical' && !f.accepted)
      .map((f) => ({ id: f.id, lens: f.lens, title: f.title, requirement: f.requirement })),
    stale: current === null || requirementsDigest(current) !== run.requirementsSha256,
  };
}

export interface AcceptInput {
  planning: string;
  cwd: string;
  ids: readonly string[];
  reason: string;
  now: () => Date;
}

/** `alsoCovers`: other findings of the same lens about the same requirement text — one acceptance covers them. */
export type AcceptResult = { ok: true; accepted: Array<{ id: string; fingerprint: string; alsoCovers: string[] }>; compose: ComposeResult };

/**
 * Record critical findings of the composed review as known risks, then compose again. Only a
 * critical finding can be accepted — nothing else blocks — and only with a reason, which the review
 * then carries under the finding.
 */
export function acceptFindings(input: AcceptInput): AcceptResult | ReviewFailure {
  const reason = input.reason.trim();
  if (reason === '') return { ok: false, reason: 'no-reason', message: 'accepting a finding as a known risk needs --reason "<why>"' };
  const paths = reviewPaths(input.planning);
  const review = readTextOrNull(paths.review);
  if (review === null) return { ok: false, reason: 'no-review', message: `no ${REVIEW_FILE} — compose the review first` };
  const run = readRun(paths);
  if (isFailure(run)) return run;
  const journal = readAccepted(paths);
  if (isFailure(journal)) return journal;
  const findings = parseComposedFindings(review);
  const picked = [];
  for (const id of input.ids) {
    const f = findings.find((x) => x.id === id);
    if (f === undefined) return { ok: false, reason: 'unknown-id', message: `${id} is not a finding of ${REVIEW_FILE} (findings: ${findings.map((x) => x.id).join(', ') || 'none'})` };
    if (f.severity !== 'critical') return { ok: false, reason: 'not-critical', message: `${id} is not critical — only a critical finding holds the roadmap, so only one can be accepted` };
    picked.push(f);
  }
  const at = input.now().toISOString();
  const next = [...journal];
  for (const f of picked) {
    if (next.some((a) => a.fingerprint === f.fingerprint && a.milestone === run.milestone)) continue;
    next.push({ fingerprint: f.fingerprint, id: f.id, lens: f.lens, title: f.title, reason, milestone: run.milestone, acceptedAt: at });
  }
  writeAtomic(paths.accepted, `${JSON.stringify({ accepted: next }, null, 2)}\n`);
  const compose = composeReviewFiles(input.planning, input.cwd, input.now);
  if (isFailure(compose)) return compose;
  return {
    ok: true,
    accepted: picked.map((f) => ({ id: f.id, fingerprint: f.fingerprint, alsoCovers: findings.filter((x) => x.fingerprint === f.fingerprint && x.id !== f.id).map((x) => x.id) })),
    compose,
  };
}
