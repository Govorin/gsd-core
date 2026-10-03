"use strict";
/**
 * Plan Status Module — the single definition of the plan lifecycle vocabulary,
 * the transition matrix, and the `blocked_reason` ceiling.
 *
 * ── This module DOCUMENTS a field that already ships; it does not introduce one ──
 *
 * Two of the four values are already live, each with its own reader:
 *
 *   D-00a  `status: superseded` ships today (#2349, src/plan-scan.cts:49-68). A plan
 *          carrying it is excluded from BOTH the plan and the summary counts, because
 *          such a plan can never gain a matching `*-SUMMARY.md` and would otherwise
 *          pin its phase at `completed: false` forever.
 *   D-00b  `in_progress` is understood by the second reader
 *          (capabilities/mn-verify-gate/scripts/orphan-plans.mjs:136-153), which
 *          treats a stranded `in_progress` (no SUMMARY) as an orphaned plan.
 *
 * So `superseded` and `in_progress` must keep meaning exactly what their existing
 * readers already take them to mean. This module gives all four values ONE
 * definition; it does not redefine the two that ship. Adding a third independent
 * hardcoded list in the validator is what would let them drift — the
 * `gates.tests_passed` collision this fork already paid for once.
 *
 * ── LEAF MODULE (load-bearing) ──
 *
 * This module imports NOTHING from `src/`. Plan 01-02 makes `src/frontmatter.cts`
 * depend on it, and `src/frontmatter.cts` is already required by 20 other modules
 * including `src/plan-scan.cts` — so any back-edge from here would close an import
 * cycle. Keep it dependency-free.
 *
 * ── Every comparison is a STRING comparison (D-02) ──
 *
 * `extractFrontmatter` parses every scalar as a string: `FrontmatterValue` has no
 * boolean member, so YAML `gap_closure: true` arrives as the JS string `"true"`.
 * There is deliberately no boolean or numeric coercion path anywhere in this file.
 *
 * ── Storage (D-11) ──
 *
 * The field lives in the plan's OWN frontmatter and nowhere else — never in STATE.md
 * and never in a separate TASKS.json. One writer per file means races are impossible
 * by construction, which is why this vocabulary never needs a lock and the value
 * survives a session crash (it is on disk and in git).
 */
/**
 * The closed vocabulary (D-06). Four values, no more.
 *
 * Deliberately EXCLUDED, and not to be "helpfully" re-added:
 *   - `cancelled` — indistinguishable from `superseded` by resulting action.
 *   - `failed`    — that is `blocked` with a reason; a separate status only invites
 *                   the model to invent intermediates.
 *
 * `PlanStatus` is derived from this tuple rather than declared beside it, so the
 * vocabulary and the type cannot drift apart.
 */
const PLAN_STATUSES = ['in_progress', 'done', 'blocked', 'superseded'];
/**
 * The D-07 transition matrix, as a code table in the style of
 * `VERIFICATION_ROUTING_TABLE` (src/verification.cts:81) — never as prose.
 *
 *   (none)       → in_progress | superseded
 *   in_progress  → done | blocked | superseded
 *   blocked      → in_progress | superseded
 *   done         → superseded            (terminal except supersession)
 *   superseded   → (terminal)
 *
 * "No status yet" is modelled as the EXPLICIT key `none` rather than as `undefined`,
 * so the table has a row for every origin and the lookup is total. A status absent
 * from the table therefore cannot fall through to an allow branch.
 *
 * `done → in_progress` is forbidden on purpose: in a system where each plan commits
 * atomically, reopening is a NEW plan, not a status rollback. Otherwise SUMMARY.md
 * stops meaning "this work is in git history".
 */
const PLAN_STATUS_TRANSITIONS = {
    none: ['in_progress', 'superseded'],
    in_progress: ['done', 'blocked', 'superseded'],
    blocked: ['in_progress', 'superseded'],
    done: ['superseded'],
    superseded: [],
};
/**
 * The fields a status may legitimately bring with it.
 *
 * `blocked_reason` is required by `blocked` and `superseded_by` by `superseded`
 * (D-08). `status_at` (D-12) is written because it is cheap and reversible, and
 * naming it here is what keeps it a recognised companion rather than an unmodelled
 * stray key. It carries NO validation beyond being a string: stall detection from it
 * ("in_progress older than N hours") is explicitly OUT OF SCOPE, because that is a
 * wall-clock assertion requiring an injectable `{ clock }`.
 */
const PLAN_STATUS_COMPANION_FIELDS = ['blocked_reason', 'superseded_by', 'status_at'];
/**
 * Normalise a raw frontmatter value to a status string.
 *
 * `trim()` then `toLowerCase()` and NOTHING else, because that is literally what
 * `src/plan-scan.cts:67` does today (D-06a):
 *
 *     status.trim().toLowerCase() === 'superseded'
 *
 * A stricter rule here would make the validator reject a file `plan-scan` accepts —
 * two readers disagreeing about the same file, which is the exact failure this
 * module exists to prevent.
 *
 * Returns `null` for a non-string input and for the empty-after-trim string. `null`
 * means "no status declared" — i.e. NOT STARTED, which is VALID (D-04), not an
 * error. Roughly 1031 plans already on disk carry no status; a rule that treated
 * absence as a failure would invalidate every plan ever written.
 */
function normalizePlanStatus(raw) {
    if (typeof raw !== 'string')
        return null;
    const normalized = raw.trim().toLowerCase();
    return normalized === '' ? null : normalized;
}
/** Type guard: is `value` a member of the closed vocabulary, after normalisation? */
function isPlanStatus(value) {
    const normalized = normalizePlanStatus(value);
    if (normalized === null)
        return false;
    return PLAN_STATUSES.includes(normalized);
}
/**
 * Is the transition `from → to` allowed?
 *
 * Answers ONLY by looking up `PLAN_STATUS_TRANSITIONS`. There is deliberately no
 * `if` special-casing any particular status: a reviewer changes behaviour by editing
 * the table alone. That is criterion 3 ("rejected by the code table, not by prose")
 * expressed in code shape.
 *
 * Both arguments are normalised first, so the predicate agrees with `plan-scan`'s
 * case-insensitive reading of the same file.
 */
function isTransitionAllowed(from, to) {
    const origin = normalizePlanStatus(from) ?? 'none';
    const target = normalizePlanStatus(to);
    if (target === null)
        return false;
    const reachable = Object.prototype.hasOwnProperty.call(PLAN_STATUS_TRANSITIONS, origin)
        ? PLAN_STATUS_TRANSITIONS[origin]
        : undefined;
    if (reachable === undefined)
        return false;
    return reachable.includes(target);
}
/**
 * Ceiling on `blocked_reason` length, in characters.
 *
 * Do NOT "round" this number — it is bounded against something specific:
 *
 *   (a) DeepSeek Harness's `ralph` uses 16,384 serialized characters for a FIVE-field
 *       handoff envelope. One free-text field warrants an order less.
 *   (b) The DECISIVE constraint is local. `src/plan-scan.cts` reads only the first
 *       `PLAN_FRONTMATTER_READ_CAP = 64 * 1024` bytes of a plan to find `status:`
 *       (D-00a, src/plan-scan.cts:29). A `blocked_reason` sitting ABOVE `status` in
 *       the frontmatter consumes that budget, so the reason ceiling must stay far
 *       below the read cap — otherwise a maximal reason could push `status` past the
 *       bounded prefix and make reader #1 silently miss it.
 *
 * 2048 is 1/32 of the read cap, leaving the margin unambiguous.
 */
const BLOCKED_REASON_MAX_LENGTH = 2048;
/**
 * Validate a `blocked_reason` (D-08 requires a NON-EMPTY reason for `blocked`).
 *
 * Returns a discriminated result — not a boolean and not a string — so plan 01-02
 * can render a message naming both the offending length and the limit without
 * re-deriving either.
 *
 * Length is measured on the RAW string, before trimming: the file carries those
 * bytes either way, and it is the on-disk size that competes with reader #1's
 * bounded prefix. Emptiness is measured AFTER trimming, so a whitespace-only reason
 * is rejected as empty rather than accepted as 40 characters of nothing.
 *
 * D-10: an oversized reason FAILS; it is NEVER truncated. There is no truncation
 * path in this function at all, and the result deliberately carries only `length`
 * and `limit` — never the reason content — so an oversized reason is not echoed
 * back into gate output.
 */
function validateBlockedReason(raw) {
    if (typeof raw !== 'string') {
        return { ok: false, reason: 'missing', length: 0, limit: BLOCKED_REASON_MAX_LENGTH };
    }
    const length = raw.length;
    if (raw.trim() === '') {
        return { ok: false, reason: 'empty', length, limit: BLOCKED_REASON_MAX_LENGTH };
    }
    if (length > BLOCKED_REASON_MAX_LENGTH) {
        return { ok: false, reason: 'too_long', length, limit: BLOCKED_REASON_MAX_LENGTH };
    }
    return { ok: true };
}
module.exports = {
    PLAN_STATUSES,
    PLAN_STATUS_TRANSITIONS,
    PLAN_STATUS_COMPANION_FIELDS,
    BLOCKED_REASON_MAX_LENGTH,
    normalizePlanStatus,
    isPlanStatus,
    isTransitionAllowed,
    validateBlockedReason,
};
