"use strict";
/**
 * Feature Vocabulary — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: the `<!-- gsd:feature-vocabulary -->` block in
 * .planning/ROADMAP.md.
 * Generator:       scripts/gen-feature-vocabulary.cjs
 *
 * Edit the ROADMAP block and re-run:
 *
 *     node scripts/gen-feature-vocabulary.cjs --write
 *
 * `node scripts/gen-feature-vocabulary.cjs --check`, wired into
 * `npm run lint:generated-sync`, fails when this file disagrees with that
 * block — so a hand edit here is caught by a gate, not by review.
 *
 * The vocabulary:
 *
 *   dispatch — how a run is routed: waves, ordering, and what may execute in parallel
 *   lifecycle — a plan's own state over time: status, transitions, and companion fields
 *   planning — the artifacts that describe intended work before it is executed
 *   templates — the emitted document surface and the registry that describes it
 *   validation — the gates that reject a malformed artifact instead of degrading
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const planStatus = require("./plan-status.cjs");
/**
 * The closed `feature:` vocabulary, sorted and deduplicated by the generator.
 *
 * Typed exactly like `PLAN_STATUSES` (src/plan-status.cts) — an `as const`
 * tuple — so `allowedValues`'s `Record<string, readonly string[]>` consumes it
 * with no widening and no new machinery.
 *
 * `Object.freeze` is applied ON TOP of `as const` deliberately. `as const`
 * is a COMPILE-TIME readonly marker only: tsc emits a plain mutable array, so
 * `PLAN_STATUSES` itself answers `Object.isFrozen` with `false` and can be
 * mutated by any JS caller that never sees the types. This vocabulary is a
 * security boundary — a pushed value would silently widen the allowed set — so
 * the runtime guarantee is made real rather than assumed from the type.
 */
const FEATURE_VALUES = Object.freeze([
    "dispatch",
    "lifecycle",
    "planning",
    "templates",
    "validation",
]);
/**
 * Type guard: is `value` a member of the closed vocabulary, after
 * normalisation?
 *
 * Normalisation is `normalizePlanStatus` — the SHARED `trim()` +
 * `toLowerCase()` from src/plan-status.cts, imported rather than re-derived
 * (D-51). A second copy here is exactly the drift this fork already paid for
 * once. `normalizePlanStatus` returns `null` for a non-string and for the
 * empty-after-trim string, both of which are non-members.
 */
function isFeature(value) {
    const normalized = planStatus.normalizePlanStatus(value);
    if (normalized === null)
        return false;
    return FEATURE_VALUES.includes(normalized);
}
module.exports = {
    FEATURE_VALUES,
    isFeature,
};
