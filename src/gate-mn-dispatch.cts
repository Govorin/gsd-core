/**
 * mn gate dispatch — the table of `gsd_run check mn-*` verbs (mn-verify-gate's gates) and the one
 * entry the check router calls (.plans/mn-verify-gate-to-cli.md §3.1, decision 5).
 *
 * The upstream check router has no extension point, so it carries exactly one registration line:
 * `isMnCheckVerb(verb)` → `evaluateMnCheck(verb, input)` → its own `emitGateResult`. Every mn verb
 * lives here and in its `gate-mn-*` module, so a sync with upstream meets one line in
 * `check-command-router.cts` instead of a growing `switch`.
 *
 * Like every gate module, this one decides nothing about output: it returns the gate's
 * `GateResult` and the router prints it.
 *
 * Verb names are kebab-case with the `mn-` prefix and no modifiers: the gate-dispatch contract
 * validates a query against `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$`, and a workflow quoting
 * `"${query}"` would hand a multi-word query to the router as ONE argument. A gate's parameters
 * come from `workflow.*` config instead (decision 4).
 */

import type { GateResult } from './gate-verdict.cjs';
import type { MnGateInput } from './gate-mn-support.cjs';
import { evaluateMnPlanStatus, evaluateMnOrphanPlans } from './gate-mn-plan-status.cjs';
import { evaluateMnUatOpen } from './gate-mn-uat-open.cjs';
import { evaluateMnBlastRadius } from './gate-mn-blast-radius.cjs';
import { evaluateMnContractDrift } from './gate-mn-contract-drift.cjs';
import { evaluateMnMigrationSafety } from './gate-mn-migration-safety.cjs';
import { evaluateMnCleanState } from './gate-mn-clean-state.cjs';
import { evaluateMnWaveCollision, evaluateMnWaveSolve } from './gate-mn-waves.cjs';
import { evaluateMnAssertionRatchet } from './gate-mn-assertion-ratchet.cjs';
import { evaluateMnMutationSpotCheck } from './gate-mn-mutation-spot-check.cjs';
import { evaluateMnBaseline } from './gate-mn-baseline.cjs';
import { evaluateMnVerifyGates } from './gate-mn-verify-gates.cjs';

type MnGateEvaluator = (input: MnGateInput) => GateResult;

/**
 * What a verb evaluates. A `phase` gate requires a phase argument and reports a missing phase as
 * unresolvable; a `project` gate judges the whole project and ignores the phase the dispatcher
 * appends anyway.
 */
export type MnGateScope = 'phase' | 'project';

interface MnGateEntry {
  evaluate: MnGateEvaluator;
  scope: MnGateScope;
}

const MN_CHECK_VERBS: Readonly<Record<string, MnGateEntry>> = Object.freeze({
  'mn-plan-status': { evaluate: evaluateMnPlanStatus, scope: 'phase' },
  'mn-orphan-plans': { evaluate: evaluateMnOrphanPlans, scope: 'phase' },
  'mn-uat-open': { evaluate: evaluateMnUatOpen, scope: 'phase' },
  'mn-blast-radius': { evaluate: evaluateMnBlastRadius, scope: 'phase' },
  'mn-contract-drift': { evaluate: evaluateMnContractDrift, scope: 'phase' },
  'mn-migration-safety': { evaluate: (input) => evaluateMnMigrationSafety(input), scope: 'phase' },
  'mn-clean-state': { evaluate: (input) => evaluateMnCleanState(input), scope: 'project' },
  'mn-wave-collision': { evaluate: evaluateMnWaveCollision, scope: 'phase' },
  'mn-wave-solve': { evaluate: evaluateMnWaveSolve, scope: 'phase' },
  'mn-assertion-ratchet': { evaluate: (input) => evaluateMnAssertionRatchet(input), scope: 'project' },
  'mn-mutation-spot-check': { evaluate: evaluateMnMutationSpotCheck, scope: 'phase' },
  'mn-baseline': { evaluate: (input) => evaluateMnBaseline(input), scope: 'phase' },
  'mn-verify-gates': { evaluate: evaluateMnVerifyGates, scope: 'phase' },
});

/** Is `verb` one of the mn gates? (Own keys only — `toString` is not a verb.) */
export function isMnCheckVerb(verb: unknown): verb is string {
  return typeof verb === 'string' && Object.prototype.hasOwnProperty.call(MN_CHECK_VERBS, verb);
}

/** Evaluate the mn gate `verb` (which `isMnCheckVerb` accepted) on the argv after the verb. */
export function evaluateMnCheck(verb: string, input: MnGateInput): GateResult {
  const entry = Object.prototype.hasOwnProperty.call(MN_CHECK_VERBS, verb) ? MN_CHECK_VERBS[verb] : undefined;
  if (entry === undefined) throw new Error(`not an mn gate: ${verb}`);
  return entry.evaluate(input);
}

/** The mn gate verbs, sorted — all of them, or only those of one scope. */
export function listMnCheckVerbs(scope?: MnGateScope): string[] {
  return Object.keys(MN_CHECK_VERBS)
    .filter((verb) => scope === undefined || MN_CHECK_VERBS[verb].scope === scope)
    .sort();
}
