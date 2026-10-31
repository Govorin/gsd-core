/**
 * `check auto-mode` state — whether the workflow's auto-advance preference or an auto-chain run
 * is on (#5139, epic #5056, design D5). Not a gate: it reports state.
 *
 * `auto_advance` is configuration: `workflow.auto_advance`, read NESTED-ONLY through the same
 * reader as the gates (`gate-config.cts`), so it answers exactly what `config-get
 * workflow.auto_advance` answers; a top-level `auto_advance` is never read.
 *
 * `auto_chain_active` is run state (X5): the scope's `.gsd/auto-chain` record, read through
 * `auto-chain-state.cts`, so it answers exactly what `auto-chain status` answers. The retired
 * `workflow._auto_chain_active` config key is never read. Returns plain data; the router formats
 * it. The shape is a public contract other readers (hooks, workflows) depend on.
 */

import { readWorkflowConfigValue } from './gate-config.cjs';
import { readAutoChainActive } from './auto-chain-state.cjs';

export interface AutoModeState {
  active: boolean;
  source: 'none' | 'auto_chain' | 'auto_advance' | 'both';
  auto_chain_active: boolean;
  auto_advance: boolean;
}

function flag(projectDir: string, dotKey: string): boolean {
  const resolved = readWorkflowConfigValue(projectDir, dotKey);
  return Boolean(resolved.found ? resolved.value ?? false : false);
}

export function readAutoModeState(projectDir: string): AutoModeState {
  const autoAdvance = flag(projectDir, 'workflow.auto_advance');
  const autoChainActive = readAutoChainActive(projectDir);
  let source: AutoModeState['source'] = 'none';
  if (autoChainActive && autoAdvance) source = 'both';
  else if (autoChainActive) source = 'auto_chain';
  else if (autoAdvance) source = 'auto_advance';
  return {
    active: autoChainActive || autoAdvance,
    source,
    auto_chain_active: autoChainActive,
    auto_advance: autoAdvance,
  };
}
