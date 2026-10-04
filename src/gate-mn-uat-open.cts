/**
 * `gsd_run check mn-uat-open` — block ship while the phase still has manual verification items
 * nobody ran (mn-verify-gate; replaces scripts/uat-open.mjs).
 *
 * ── What already existed, and what was missing ──────────────────────────
 *
 * A verifier meeting a truth it cannot prove by reading code sets `status: human_needed` and
 * writes the items into `{phase}-UAT.md` — the one sink for them (agents/gsd-verifier.md,
 * workflows/execute-phase.md). `audit-uat` finds them and reports them by category. Nothing read
 * that report at ship: a phase with unrun items reached ship unopposed. This gate is the reader;
 * a separate artifact would have been a second sink for what already has one.
 *
 * The script spawned `gsd-tools audit-uat`, hunting for it on fixed paths under `$HOME`. The gate
 * calls the same collector in-process (`collectAuditUat`, src/uat.cts), so the report it filters
 * is the one `audit-uat` prints, from the checkout that is running.
 *
 * ── What counts as open ─────────────────────────────────────────────────
 *
 * An item is open when its category is `pending` — the check was never run. A `failed` item is
 * NOT this gate's business: a failed manual check is a known defect whose fate verification
 * decides. The gate answers one question: "are there checks nobody did?"
 *
 * ── No UAT.md is NOT a failure ──────────────────────────────────────────
 *
 * Most phases defer no manual checks; demanding the artifact would block for having had nothing
 * to defer. (Unlike blast-radius, where an empty declaration IS the defect.)
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * `audit-uat` reports the whole project; the gate keeps the entries whose `phase_dir` is this
 * phase's directory name — unique by construction, unlike a phase number, which repeats across
 * projects in a monorepo. `--all` (by hand only: ship milestone) keeps every entry.
 *
 * Could not check (the audit throws — e.g. a VERIFICATION.md status outside the closed enum — or
 * the project has no phases tree) → `unresolvable`, which blocks.
 */

import path from 'node:path';
import type { GateResult } from './gate-verdict.cjs';
import { mnFinding, mnPass, mnUnresolvable, withMnPhase } from './gate-mn-support.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- uat.cjs is an export= CommonJS module
import uatMod = require('./uat.cjs');
const { collectAuditUat } = uatMod;

/** How many open items the message names before summarising the rest. */
const NAMED_ITEMS_MAX = 20;

interface OpenItem {
  file: string;
  test: number | null;
  name: string;
}

/** `gsd_run check mn-uat-open <phase> [--all]` */
export function evaluateMnUatOpen(input: MnGateInput): GateResult {
  const allPhases = input.args.includes('--all');
  // A bare boolean flag is removed before the phase is parsed: `--all 3` must not read `3` as its value.
  const args = input.args.filter((a) => a !== '--all');
  return withMnPhase('mn-uat-open', { projectDir: input.projectDir, args }, ({ phaseDir }) => {
    const report = collectAuditUat(input.projectDir);
    if (report === null) {
      return mnUnresolvable('mn-uat-open: the project has no phases directory — audit-uat has nothing to read', { phaseDir });
    }
    const phaseName = path.basename(phaseDir);
    const scoped = allPhases ? report.results : report.results.filter((entry) => entry.phase_dir === phaseName);
    const scope = allPhases ? 'this project' : phaseName;

    const open: OpenItem[] = [];
    for (const entry of scoped) {
      for (const item of entry.items) {
        // `failed` is deliberately skipped: a failed manual check is a known defect.
        if (item.category === 'pending') open.push({ file: entry.file, test: item.test ?? null, name: item.name });
      }
    }

    const details = { phaseDir, all: allPhases, filesChecked: scoped.length, open };
    if (scoped.length === 0) {
      return mnPass(
        allPhases
          ? 'mn-uat-open: no UAT files in this project — no manual checks were deferred'
          : `mn-uat-open: no UAT file in ${phaseName} — this phase deferred no manual checks`,
        details,
      );
    }
    if (open.length === 0) {
      return mnPass(`mn-uat-open: every UAT item in ${scope} has been run (${scoped.length} file(s) checked)`, details);
    }
    const named = open.slice(0, NAMED_ITEMS_MAX).map((item) => `${item.file} #${item.test ?? '?'}: ${item.name}`);
    const more = open.length > NAMED_ITEMS_MAX ? `; … and ${open.length - NAMED_ITEMS_MAX} more` : '';
    return mnFinding(
      `mn-uat-open: ${open.length} manual verification item(s) never run in ${scope} (${named.join('; ')}${more}). ` +
        'The verifier could not confirm these by reading code and deferred them to a human. Run them and record ' +
        'the result in the UAT file, or — if one is genuinely not needed — say so there.',
      details,
    );
  });
}
