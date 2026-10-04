/**
 * `check architecture.diagrams` as a gate module (ADR-5057 §4 first bullet): it returns a
 * `GateResult`; the command router formats it. Imports no io module and performs no direct
 * console/stdout/stderr write (ESLint-enforced).
 *
 * The `architecture` capability's blocking gate at `plan:post`. The system architect drew the
 * phase's DESIGN.md before planning; this gate runs the same deterministic check as
 * `gsd_run diagrams check --file <phase>/<N>-DESIGN.md` (src/diagrams-check.cts, `design` mode)
 * over every `*DESIGN.md` in the phase directory, and blocks on every BLOCKER finding: a diagram
 * naming an identifier that is neither declared in the code nor introduced by the design itself
 * (`absent`), and — because `design` mode cannot let an unchecked block pass as checked (review
 * M4/M5) — a block outside the mermaid subset, a stateDiagram with no `%% gsd:source`, and a
 * derived block that is stale or that nothing can regenerate. Warnings (an ambiguous name) never
 * block — they are returned for the dispatch to surface.
 *
 * No DESIGN.md → `skip`, not a block: the design step is optional (`workflow.architecture_design`)
 * and a phase without one has nothing to check. A design that exists but cannot be read → block
 * with `status: 'unresolvable'` (fail-closed: a gate that could not look must not pass).
 *
 * Argv after the verb: `<phase-dir> [phase-req-ids]` (the plan:post named-query convention).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gateVerdict, gateUsageFailure, isGateUsageFailure, GATE_FAILURE_CODE } from './gate-verdict.cjs';
import type { GateResult } from './gate-verdict.cjs';
import { resolveContainedPath } from './gate-phase-context.cjs';
import { runDiagramsCheck } from './diagrams-check.cjs';
import type { Finding } from './diagrams-check.cjs';
import { buildSymbolIndex } from './symbol-index.cjs';
import type { SymbolIndex } from './symbol-index.cjs';

/** A phase design document: `DESIGN.md` or `<N>-DESIGN.md`. */
const DESIGN_FILE = /^(?:.*-)?DESIGN\.md$/;

export interface ArchitectureDiagramsInput {
  projectDir: string;
  args: readonly string[];
  /** Test seam: replaces the index builder (shared by every design file of the phase). */
  buildIndex?: (root: string) => SymbolIndex;
}

export function evaluateArchitectureDiagrams(input: ArchitectureDiagramsInput): GateResult {
  const { projectDir, args } = input;
  const phaseArg = args[0] || '';
  if (!phaseArg) {
    return gateUsageFailure(
      GATE_FAILURE_CODE.SDK_MISSING_ARG,
      'architecture.diagrams requires a phase-dir argument: check architecture.diagrams <phase-dir>',
    );
  }
  const phaseDir = resolveContainedPath(phaseArg, projectDir);
  if (isGateUsageFailure(phaseDir)) return phaseDir;

  let entries: string[];
  try {
    entries = fs.readdirSync(phaseDir).filter((f) => DESIGN_FILE.test(f)).sort();
  } catch {
    entries = [];
  }
  if (entries.length === 0) {
    return gateVerdict('skip', false, {
      block: false,
      passed: true,
      status: 'no_design',
      files: [],
      findings: [],
      message: 'no DESIGN.md in the phase directory — nothing to check',
    });
  }

  let shared: SymbolIndex | null = null;
  const buildIndex = (root: string): SymbolIndex => {
    if (shared === null) shared = (input.buildIndex ?? buildSymbolIndex)(root);
    return shared;
  };
  const files: Array<{ file: string; diagram_count: number; blocker_count: number; warning_count: number }> = [];
  const findings: Array<Finding & { file: string }> = [];
  const unresolvable: string[] = [];
  for (const name of entries) {
    const file = path.join(phaseDir, name);
    const result = runDiagramsCheck({ file, root: projectDir, mode: 'design', buildIndex });
    const rel = path.relative(projectDir, file).split(path.sep).join('/');
    if (!result.ok) {
      unresolvable.push(`${rel}: ${result.message}`);
      continue;
    }
    files.push({ file: rel, diagram_count: result.diagram_count, blocker_count: result.blocker_count, warning_count: result.warning_count });
    for (const f of result.findings) findings.push({ file: rel, ...f });
  }
  if (unresolvable.length > 0) {
    return gateVerdict('block', true, {
      block: true,
      passed: false,
      status: 'unresolvable',
      files,
      findings,
      message: `could not check: ${unresolvable.join('; ')}`,
    });
  }
  const blockers = findings.filter((f) => f.severity === 'BLOCKER');
  const block = blockers.length > 0;
  const onlyIdentifiers = blockers.every((f) => f.reason === 'absent' || f.reason === 'relation_absent');
  return gateVerdict(block ? 'block' : 'pass', block, {
    block,
    passed: !block,
    status: !block ? 'ok' : onlyIdentifiers ? 'absent_identifiers' : 'diagram_blockers',
    files,
    findings,
    message: block
      ? blockers.map((f) => `${f.file}:${f.line} ${f.message}`).join('\n')
      : `${files.reduce((n, f) => n + f.diagram_count, 0)} diagram(s) checked, no blockers`,
  });
}
