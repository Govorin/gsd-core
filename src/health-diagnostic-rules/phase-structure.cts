/**
 * Health Diagnostic — Phase directory structure rules (Phase 11, #3309,
 * ADR-3180 §8.2/§8.3/§8.5).
 *
 * Group: "Phase directory structure" (design doc, "Rule table organization"
 * table) — W005, W023, I001, W009, W030 (#5118), and the fork's W031 (a
 * legacy status with exactly one meaning, repairable) and W032 (a report
 * whose frontmatter does not parse).
 *
 * Ported behavior-preserving from `cmdValidateHealth`
 * (`src/verify.cts:1893-1990`, the exact call sites for W005/W023/I001/W009),
 * with two disclosed fidelity reductions forced by `PlanningSnapshot`'s
 * current shape (see each rule's own comment below):
 *
 * - I001 cannot name the individual unsummarized PLAN filename (`snapshot.
 *   phases.value[i]` exposes only `planCount`/`summaryCount`, not per-plan
 *   filenames) — this rule reports a coarser per-PHASE message instead.
 * - W023's original "described" list called `determinePhaseStatus`
 *   (`commands.cts:154`, since deleted, #5060). The label now comes from the
 *   Phase Status Module's pure ladder (`phaseStatusFromFacts` +
 *   `toDisplayLabel`, `../phase-status.cjs`) over the same `PhaseSnapshot`
 *   facts this rule already had — `planCount`/`summaryCount`,
 *   `complete`/`verificationStatus` (`isPhaseComplete`'s §7.4 disk-strict
 *   routing of the SAME `*-VERIFICATION.md` file). §8.1 rule 1 (no ambient
 *   I/O in `check`) still holds: the module's ladder is a pure function of
 *   facts already on the snapshot, no new I/O or snapshot field is needed.
 *
 * W009's original message interpolates `${slash('plan-phase')}`
 * (`verify.cts:1982`, ``Re-run ${slash('plan-phase')} with --research to
 * regenerate``), a per-project runtime-resolved value (`formatGsdSlash`,
 * `src/runtime-slash.cts`) this rule's `(snapshot) => Diagnostic[]`
 * signature has no access to. Hardcodes the canonical `/gsd-plan-phase`
 * hyphen form instead, mirroring the sibling "config.json validation"
 * group's W016 rule (`src/health-diagnostic-rules/config-validation.cts`),
 * which hardcodes `/gsd-ai-integration-phase` the same way for the
 * identical reason.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * ADR-457 build-at-publish: source in
 * src/health-diagnostic-rules/phase-structure.cts, compiled to
 * gsd-core/bin/lib/health-diagnostic-rules/phase-structure.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- type-only; erased at compile time, no runtime require emitted
import type planningSnapshotMod = require('../planning-snapshot.cjs');

type PlanningSnapshot = ReturnType<typeof planningSnapshotMod.buildPlanningSnapshot>;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import healthDiagnosticMod = require('../health-diagnostic-types.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK, adviseRemedy } = healthDiagnosticMod;
type Diagnostic = healthDiagnosticMod.Diagnostic;
type Rule = healthDiagnosticMod.Rule;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import validateMod = require('../validate.cjs');
// #612: `isPhaseDirName` is the convention-SELECTED shape test wrapping
// `phaseDirNameRe`. Handed no convention it delegates to that very regex, so a
// legacy repo's W005 reading is byte-identical; handed 'bracket' it also
// recognizes `{CODE}.{MM}-{PP}-slug`, which `phaseDirNameRe` rejects outright —
// left un-threaded, W005 fires on EVERY phase directory of a repo that opted
// into the convention, i.e. the check inverts on exactly the repos PR-2 widens.
const { isPhaseDirName } = validateMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import phaseIdMod = require('../phase-id.cjs');
const { extractPhaseToken, normalizePhaseName, comparePhaseNum } = phaseIdMod;

// eslint-disable-next-line @typescript-eslint/no-require-imports
import verificationMod = require('../verification.cjs');
// The closed set the reader accepts — W030 folds a spelling variant onto it.
// #5291: W030 also asks whether a raw report status has a known repair
// (`legacyStatusRepairTarget`). The lookup is a pure read of a frozen table,
// so `check` stays free of ambient I/O (§8.1 rule 1).
const { VERIFIER_STATUSES, legacyStatusRepairTarget } = verificationMod;
type VerifierStatus = verificationMod.VerifierStatus;

// #5060: the Phase Status Module owns the status-label ladder.
import { phaseStatusFromFacts, toDisplayLabel } from '../phase-status.cjs';

// ─── W005 — phase directory doesn't follow NN-name format (verify.cts:1893-1902) ─

function checkW005(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const name of snapshot.phaseDirs.value) {
    if (!isPhaseDirName(name, snapshot.phaseIdConvention)) {
      diagnostics.push({
        code: 'W005',
        severity: SEVERITY.WARNING,
        message: `Phase directory "${name}" doesn't follow NN-name format`,
        remedy: adviseRemedy('Rename to match pattern (e.g., 01-setup)'),
      });
    }
  }
  return diagnostics;
}

// ─── W023 — phase directories collide on normalized key (verify.cts:1904-1950) ─
//
// Groups `snapshot.phaseDirs.value` by `normalizePhaseName(extractPhaseToken(name))`
// — the exact same two owners (`phase-id.cjs`) the original `verify.cts:1917-1918`
// call site uses, relocated verbatim rather than reimplemented. Sorted with
// `comparePhaseNum` + a `localeCompare` tiebreak, mirroring
// `verify.cts:1930-1932`'s deterministic-output rationale. See the file-level
// comment for the disclosed "described" fidelity reduction.

function checkW023(snapshot: PlanningSnapshot): Diagnostic[] {
  const groups = new Map<string, string[]>();
  for (const name of snapshot.phaseDirs.value) {
    const token = extractPhaseToken(name);
    const key = normalizePhaseName(token);
    const list = groups.get(key);
    if (list) list.push(name);
    else groups.set(key, [name]);
  }

  const phaseByDir = new Map(snapshot.phases.value.map((p) => [p.dir, p]));

  const diagnostics: Diagnostic[] = [];
  for (const [key, dirs] of groups) {
    if (dirs.length < 2) continue;
    const described = dirs
      .slice()
      .sort((a, b) => comparePhaseNum(a, b) || String(a).localeCompare(String(b)))
      .map((d) => {
        const phase = phaseByDir.get(d);
        const plans = phase ? phase.planCount : 0;
        const summaries = phase ? phase.summaryCount : 0;
        const complete = phase ? phase.complete : false;
        const verificationStatus = phase ? phase.verificationStatus : null;
        const status = toDisplayLabel(
          phaseStatusFromFacts({ planCount: plans, summaryCount: summaries, complete, verificationStatus }),
          { pendingWord: 'Not Started' },
        );
        return `${d} (${status})`;
      })
      .join(', ');
    diagnostics.push({
      code: 'W023',
      severity: SEVERITY.WARNING,
      message: `Phase directories collide on normalized key "${key}": ${described}`,
      remedy: adviseRemedy(
        'Inspect each directory; rename or remove the duplicate so only one directory maps to this phase key',
      ),
    });
  }
  return diagnostics;
}

// ─── I001 — plan(s) without a matching SUMMARY.md (verify.cts:1952-1965) ───
//
// GENUINE FIDELITY GAP (see file-level comment): the original is PER-PLAN
// (`${e.name}/${plan} has no SUMMARY.md`, `plan` an individual PLAN.md
// filename from `findUnsummarizedPlans`). `PlanningSnapshot`'s
// `phases.value[i]` carries only `planCount`/`summaryCount` NUMBERS per
// phase — no per-plan filenames — so this rule cannot name which plan lacks
// a summary without reading the phase directory directly inside `check`
// (forbidden by §8.1 rule 1). This rule instead reports one coarser
// per-PHASE diagnostic naming the deficit count, not the individual
// filename(s).

function checkI001(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const phase of snapshot.phases.value) {
    const deficit = phase.planCount - phase.summaryCount;
    if (deficit > 0) {
      diagnostics.push({
        code: 'I001',
        severity: SEVERITY.INFO,
        message: `Phase ${phase.dir} has ${deficit} plan(s) without a matching summary`,
        remedy: adviseRemedy('May be in progress'),
      });
    }
  }
  return diagnostics;
}

// ─── W009 — Validation Architecture in RESEARCH.md but no VALIDATION.md ────
// (verify.cts:1967-1990)

function checkW009(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const entry of snapshot.researchValidationStatus.value) {
    if (entry.hasValidationArchitecture && !entry.hasValidationMd) {
      diagnostics.push({
        code: 'W009',
        severity: SEVERITY.WARNING,
        message: `Phase ${entry.dir}: has Validation Architecture in RESEARCH.md but no VALIDATION.md`,
        remedy: adviseRemedy('Re-run /gsd-plan-phase with --research to regenerate'),
      });
    }
  }
  return diagnostics;
}

// ─── Legacy report statuses — what each one should become ──────────────────
//
// Reports written before the closed set (#4817/#5118) carry values the reader
// now refuses. The owner of each phase decides what a report meant; health
// can only say what the value most likely meant and why. Exactly one entry is
// unambiguous: `verified` is the old spelling of `passed` — same verdict, no
// judgement to make — so it alone becomes W031, which `--repair` rewrites.
// Every other value is W030. A value upstream's maintainer ruled on (#5291,
// `pass_with_caveats` -> `passed`, `LEGACY_STATUS_REPAIRS` in verification.cts)
// is a repairable W030 that keeps the original in `legacy_status`; any other
// value is an advise-only W030 with a proposal. Where a value could mean either
// a pass or something still open, the proposal is the value that keeps the
// gate closed (`gaps_found` / `human_needed`), and `passed` is named as the
// alternative the owner may pick after reading the report.

interface StatusProposal {
  suggested: VerifierStatus;
  alternative: VerifierStatus | null;
  reason: string;
}

const UNAMBIGUOUS_LEGACY_STATUSES: ReadonlyMap<string, { to: VerifierStatus; reason: string }> = new Map([
  ['verified', { to: 'passed', reason: 'the pre-closed-set spelling of `passed` — the same verdict' }],
]);

const AMBIGUOUS_LEGACY_STATUSES: ReadonlyMap<string, StatusProposal> = new Map<string, StatusProposal>([
  ['passed_with_human_verification', {
    suggested: 'human_needed',
    alternative: 'passed',
    reason: 'the report asks for a human check; `passed` only if that check has already been done',
  }],
  ['passed_with_open_checkpoint', {
    suggested: 'human_needed',
    alternative: null,
    reason: 'an open checkpoint is waiting on a person',
  }],
  ['passed-degraded', {
    suggested: 'gaps_found',
    alternative: 'passed',
    reason: 'a degradation is a gap; `passed` only if the degradation was accepted',
  }],
  ['PASS-WITH-FLAGS', {
    suggested: 'gaps_found',
    alternative: 'passed',
    reason: 'the flags may be gaps or accepted notes; `passed` only if every flag was accepted',
  }],
]);

/**
 * The proposal for an out-of-set value that is not unambiguous: a known
 * legacy value, or a spelling variant of a closed-set member (`Passed`,
 * `gaps-found`) — a variant is still a proposal, not a rewrite, because the
 * reader rejects it on purpose (#4817) and the owner confirms it. `null` when
 * nothing is known about the value.
 */
function proposeVerificationStatus(raw: unknown): StatusProposal | null {
  if (typeof raw !== 'string') return null;
  const known = AMBIGUOUS_LEGACY_STATUSES.get(raw);
  if (known) return known;
  const folded = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const legacy = UNAMBIGUOUS_LEGACY_STATUSES.get(folded);
  if (legacy) {
    return {
      suggested: legacy.to,
      alternative: null,
      reason: `a spelling variant of \`${folded}\`, ${legacy.reason}; confirm that is what the report means`,
    };
  }
  if ((VERIFIER_STATUSES as ReadonlySet<string>).has(folded)) {
    return {
      suggested: folded as VerifierStatus,
      alternative: null,
      reason: `a spelling variant of \`${folded}\`; confirm that is what the report means`,
    };
  }
  return null;
}

function unambiguousNormalization(raw: unknown): { to: VerifierStatus; reason: string } | null {
  return typeof raw === 'string' ? UNAMBIGUOUS_LEGACY_STATUSES.get(raw) ?? null : null;
}

const W030_RECOVERY =
  'Set the report frontmatter `status` to one of passed | gaps_found | human_needed, or delete the report and re-run the phase verification';

function w030Fix(proposal: StatusProposal | null): string {
  if (!proposal) return `No known mapping for this value — read the report and pick the verdict it records. ${W030_RECOVERY}`;
  const alternative = proposal.alternative ? ` (or \`${proposal.alternative}\`)` : '';
  return `Suggested: \`status: ${proposal.suggested}\`${alternative} — ${proposal.reason}. ${W030_RECOVERY}`;
}

// ─── The reports the readers refuse ─────────────────────────────────────────
//
// `snapshot.verificationReportDefects` is the verification owner's judgement
// over its one report enumeration — every report `audit-open`/`audit-uat`
// read, archived phases included — so W030/W031/W032 fire on exactly the
// reports those commands fail on. A diagnostics surface must survive the
// defect it diagnoses: `validate health` (exit 0) lists each one instead of
// failing with `verification_status_invalid` like the query surfaces do.

type ReportDefect = PlanningSnapshot['verificationReportDefects']['value'][number];
type OutOfSetDefect = Extract<ReportDefect, { kind: 'out_of_set' }>;
type UnparseableDefect = Extract<ReportDefect, { kind: 'unparseable' }>;

/** The phase a report belongs to: its directory, prefixed by the archive label for an archived phase. */
function reportPhaseLabel(defect: ReportDefect): string {
  const { dir, milestone } = defect.report;
  return milestone === undefined ? dir : `${milestone}/${dir}`;
}

function outOfSetDefects(snapshot: PlanningSnapshot): OutOfSetDefect[] {
  return snapshot.verificationReportDefects.value.filter((d): d is OutOfSetDefect => d.kind === 'out_of_set');
}

// ─── W030 — verification report status outside the closed set (#5118) ─────
//
// A ruled legacy value (#5291) is repaired; for any other value the fix names
// the proposed value and why. An unambiguous legacy value is W031 instead.

function checkW030(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const defect of outOfSetDefects(snapshot)) {
    if (unambiguousNormalization(defect.rawStatus)) continue;
    const file = defect.report.filePath;
    // #5291: a status the maintainer ruled on (`legacyStatusRepairTarget`) is
    // repairable — rewritten to its closed-set value, the original kept in
    // `legacy_status`. Every other value has no mapping and stays ADVISE, with
    // the fork's proposal in the fix and in `remedy.args`.
    const target = legacyStatusRepairTarget(defect.rawStatus);
    let remedy: Diagnostic['remedy'];
    if (target !== null) {
      remedy = {
        action: REMEDY_ACTION.REPAIR_VERIFICATION_STATUS,
        risk: REMEDY_RISK.NONE,
        args: { file, from: defect.rawStatus, to: target },
      };
    } else {
      const proposal = proposeVerificationStatus(defect.rawStatus);
      const advice = adviseRemedy(w030Fix(proposal));
      // The proposal also rides as data, so a caller migrating reports reads
      // the suggestion instead of parsing the fix sentence.
      remedy = {
        ...advice,
        args: {
          ...advice.args,
          file,
          suggested: proposal ? proposal.suggested : null,
          alternative: proposal ? proposal.alternative : null,
          reason: proposal ? proposal.reason : null,
        },
      };
    }
    diagnostics.push({
      code: 'W030',
      severity: SEVERITY.WARNING,
      message: `Phase ${reportPhaseLabel(defect)}: ${defect.message}`,
      remedy,
    });
  }
  return diagnostics;
}

// ─── W031 — verification report carries an unambiguous legacy status ───────
//
// The one case with no judgement in it: the value is a legacy spelling of a
// closed-set member. `--repair` rewrites the frontmatter `status` scalar only
// (`normalizeVerificationStatus`, `health-diagnostic.cts`), leaving every
// other key and the report body byte-identical — an archived report as much
// as an active one, since `audit-open` refuses both.

function checkW031(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const defect of outOfSetDefects(snapshot)) {
    const normalization = unambiguousNormalization(defect.rawStatus);
    if (!normalization) continue;
    const from = defect.rawStatus as string;
    const file = defect.report.filePath;
    diagnostics.push({
      code: 'W031',
      severity: SEVERITY.WARNING,
      message:
        `Phase ${reportPhaseLabel(defect)}: verification report ${JSON.stringify(file)} has legacy status ` +
        `${JSON.stringify(from)} — ${normalization.reason}; the closed set spells it \`${normalization.to}\``,
      remedy: {
        action: REMEDY_ACTION.NORMALIZE_VERIFICATION_STATUS,
        risk: REMEDY_RISK.NONE,
        args: { file, from, to: normalization.to },
      },
    });
  }
  return diagnostics;
}

// ─── W032 — verification report frontmatter does not parse ─────────────────
//
// A report whose frontmatter block is not YAML has no readable `status`, and
// every reader refuses it (`VerificationReportUnparseableError`) rather than
// reading it as a report with no status. Health names the line the parser
// stopped at and its reason. Not repairable: what the block was meant to say
// is the owner's to fix.

function checkW032(snapshot: PlanningSnapshot): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const unparseableDefects = snapshot.verificationReportDefects.value
    .filter((d): d is UnparseableDefect => d.kind === 'unparseable');
  for (const unparseable of unparseableDefects) {
    const where = unparseable.line === null ? '' : ` at line ${unparseable.line}`;
    const advice = adviseRemedy(
      `Fix the YAML in the report frontmatter${where} (a nested key under a scalar is the usual cause) so ` +
      '`status` reads as one of passed | gaps_found | human_needed, or delete the report and re-run the phase verification',
    );
    diagnostics.push({
      code: 'W032',
      severity: SEVERITY.WARNING,
      message: `Phase ${reportPhaseLabel(unparseable)}: ${unparseable.message}`,
      remedy: {
        ...advice,
        args: { ...advice.args, file: unparseable.report.filePath, line: unparseable.line, reason: unparseable.reason },
      },
    });
  }
  return diagnostics;
}

// ─── Exports ────────────────────────────────────────────────────────────────

const RULES: Rule[] = [
  {
    code: 'W005',
    severity: SEVERITY.WARNING,
    description: 'Phase directory naming mismatch',
    repairable: false,
    check: checkW005,
  },
  {
    code: 'W023',
    severity: SEVERITY.WARNING,
    description: 'Phase directories collide on normalized key',
    repairable: false,
    check: checkW023,
  },
  {
    code: 'I001',
    severity: SEVERITY.INFO,
    description: 'Plan without SUMMARY (may be in progress)',
    repairable: false,
    check: checkI001,
  },
  {
    code: 'W009',
    severity: SEVERITY.WARNING,
    description: 'Phase has Validation Architecture in RESEARCH.md but no VALIDATION.md',
    repairable: false,
    check: checkW009,
  },
  {
    code: 'W030',
    severity: SEVERITY.WARNING,
    description: 'Phase verification report status is outside the closed set',
    // #5291: repairable per finding — a KNOWN legacy status (`pass_with_caveats`)
    // is rewritten by `--repair`; any other value stays advise-only (with the
    // fork's proposal). `verified` is W031, never W030.
    repairable: true,
    check: checkW030,
  },
  {
    code: 'W031',
    severity: SEVERITY.WARNING,
    description: 'Phase verification report status is a legacy synonym of a closed-set value (`verified`)',
    repairable: true,
    check: checkW031,
  },
  {
    code: 'W032',
    severity: SEVERITY.WARNING,
    description: 'Phase verification report frontmatter does not parse',
    repairable: false,
    check: checkW032,
  },
];

export = { RULES };
