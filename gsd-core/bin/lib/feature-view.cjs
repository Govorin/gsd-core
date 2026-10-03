"use strict";
/**
 * Feature View — the cross-phase `feature:` view, DERIVED ON READ.
 *
 * ROADMAP Phase 5 criterion 2 is "the view is derived on read and never
 * stored, so it cannot drift". This module is that derivation, and the way it
 * satisfies the criterion is structural rather than promised: there is no
 * write path here at all — no cache file, no `--write` mode, no memoisation to
 * disk. The view exists only as this function's return value and as the JSON
 * the command prints. Criterion 3 ("no `FEATURE.md` artifact") follows from
 * the same absence.
 *
 * That absence is enforced BEHAVIOURALLY by tests/feature-view.test.cjs, which
 * mutates a plan's `feature:` between two CLI invocations with no regeneration
 * step in between and compares a recursive listing of the tree before and
 * after — not by trusting this comment.
 *
 * D-56: the reader lives in this repo rather than in `graphify`. `graphify` is
 * a disabled-by-default wrapper around an uninstalled external Python package
 * and does not read plan frontmatter at all, so "add a field and query it"
 * would have required the external indexer to learn about `feature:` too. This
 * departs from the ROADMAP's wording and the departure is disclosed in the
 * phase SUMMARY, not quietly redefined.
 *
 * ADR-457: TypeScript source of truth, compiled by tsc to a gitignored .cjs.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
const ioMod = require("./io.cjs");
const { output } = ioMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
const planningWorkspace = require("./planning-workspace.cjs");
const { planningDir } = planningWorkspace;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-id.cjs is an export= CommonJS module
const phaseIdMod = require("./phase-id.cjs");
const { comparePhaseNum } = phaseIdMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-scan.cjs is an export= CommonJS module
const planScan = require("./plan-scan.cjs");
const { isRootPlanFile } = planScan;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- frontmatter.cjs is an export= CommonJS module
const frontmatterMod = require("./frontmatter.cjs");
const { extractFrontmatter } = frontmatterMod;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- feature-vocabulary.cjs is a GENERATED export= CommonJS module
const featureVocabulary = require("./feature-vocabulary.cjs");
const { FEATURE_VALUES } = featureVocabulary;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- plan-status.cjs is an export= CommonJS module
const planStatus = require("./plan-status.cjs");
const { normalizePlanStatus } = planStatus;
const PLAN_FILE_RE = /-PLAN\.md$/i;
/**
 * Is this filename one of the plan files the view reports on?
 *
 * `isRootPlanFile` (plan-scan.cts) is the project's ONE definition of "what is
 * a plan file" and is reused rather than re-derived — a second filename regex
 * is precisely the drift this project removes. It is intersected with an
 * explicit `-PLAN.md` suffix because `isRootPlanFile`'s loose `/PLAN/i`
 * fallback also admits derivative names, and the view should report canonical
 * plans only.
 */
function isFeatureViewPlanFile(fileName) {
    return isRootPlanFile(fileName) && (PLAN_FILE_RE.test(fileName) || fileName === 'PLAN.md');
}
/**
 * Render an out-of-vocabulary `feature:` value for the `invalid` bucket.
 *
 * A string passes through verbatim — the whole point is that the reader sees
 * exactly what is on disk. Anything else (a YAML list, a mapping, a number) is
 * JSON-rendered, because `String()` collapses an object to `[object Object]`,
 * naming nothing a reader could search for or fix.
 */
function renderOffendingValue(raw) {
    if (typeof raw === 'string')
        return raw;
    try {
        return JSON.stringify(raw) ?? String(raw);
    }
    catch {
        return Object.prototype.toString.call(raw);
    }
}
/**
 * Derive the feature view from plan frontmatter, reading the tree at the
 * moment of the call.
 *
 * Every vocabulary token is seeded with an empty array BEFORE any plan is
 * walked. That is deliberate: seeding from the vocabulary rather than from
 * what plans happen to carry is what makes a declared-but-unused feature
 * visible as empty instead of invisible. The view then reports the
 * vocabulary, not merely the tagging.
 */
function deriveFeatureView(cwd) {
    const features = {};
    for (const token of [...FEATURE_VALUES].sort()) {
        features[token] = [];
    }
    const untagged = [];
    const invalid = [];
    const unreadable = [];
    let planCount = 0;
    const phasesDir = node_path_1.default.join(planningDir(cwd), 'phases');
    let phaseDirs;
    try {
        phaseDirs = node_fs_1.default
            .readdirSync(phasesDir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort((a, b) => comparePhaseNum(a, b));
    }
    catch {
        // Not an error: a project may legitimately have no phases yet. The caller
        // learns which case this was from `phases_readable`, never by guessing
        // from an empty result.
        return { features, untagged, invalid, unreadable, plan_count: 0, phases_readable: false };
    }
    for (const phase of phaseDirs) {
        const phaseDir = node_path_1.default.join(phasesDir, phase);
        let planFiles;
        try {
            planFiles = node_fs_1.default.readdirSync(phaseDir).filter(isFeatureViewPlanFile).sort();
        }
        catch {
            continue; // an unreadable phase dir contributes nothing; the tree walk goes on
        }
        for (const planFile of planFiles) {
            planCount += 1;
            const planPath = node_path_1.default.join(phaseDir, planFile);
            const ref = {
                phase,
                plan: planFile,
                path: ['.planning', 'phases', phase, planFile].join('/'),
            };
            let content;
            try {
                content = node_fs_1.default.readFileSync(planPath, 'utf-8');
            }
            catch (err) {
                // Reported, never silently skipped — a plan the view could not read is
                // a plan whose feature is unknown, which is not the same as untagged.
                unreadable.push({ ...ref, reason: err instanceof Error ? err.message : String(err) });
                continue;
            }
            let rawFeature;
            try {
                rawFeature = extractFrontmatter(content, planPath)['feature'];
            }
            catch (err) {
                unreadable.push({ ...ref, reason: err instanceof Error ? err.message : String(err) });
                continue;
            }
            if (rawFeature === undefined || rawFeature === null) {
                // D-52: no plan on disk carries `feature:` today, so untagged is the
                // legitimate and overwhelmingly common shape — a bucket, not a defect.
                untagged.push(ref);
                continue;
            }
            // The SHARED normaliser (D-51), imported rather than re-declared. A
            // second trim+lowercase here would be a third place the rule lives.
            const normalized = normalizePlanStatus(rawFeature);
            const bucket = normalized === null ? undefined : features[normalized];
            if (bucket !== undefined) {
                bucket.push(ref);
            }
            else {
                // `feature:` is validated at write time, so an out-of-list value is
                // rare — but the view REPORTS it rather than crashing or dropping it,
                // and it carries the offending value so it can be found and fixed.
                // A non-string (a YAML list, say) is JSON-rendered rather than
                // String()-ed: `[object Object]` names nothing a reader could act on.
                invalid.push({ ...ref, value: renderOffendingValue(rawFeature) });
            }
        }
    }
    return { features, untagged, invalid, unreadable, plan_count: planCount, phases_readable: true };
}
/**
 * Emit the derived view. Thin by design — keeping derivation separate from
 * emission is what lets the tests assert on the structure directly.
 */
function cmdFeatureView(cwd, raw) {
    output(deriveFeatureView(cwd), raw);
}
module.exports = {
    deriveFeatureView,
    cmdFeatureView,
};
