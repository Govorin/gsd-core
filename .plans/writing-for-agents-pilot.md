# writing-for-agents pilot (Phase 4, task 4.4)

Pilot agent: `agents/gsd-executor.md`. Method to repeat on other agents after the 4.9
measurement says whether the changes move outcomes, not just bytes.

## Why the executor

Chosen by data, not by size alone: subagent spawns counted across local session
transcripts (`rg -o '"subagent_type":"gsd-[a-z-]+"' ~/.claude/projects -g '*.jsonl' | sort | uniq -c`)
gave gsd-executor 573, gsd-planner 139, gsd-plan-checker 94, gsd-code-reviewer 72,
gsd-verifier 35. The executor is spawned once per plan, so its body is paid ~4x more
often than any other agent's, and it has no `.compact.md` sibling (no ADR-4139 dual edit).

## Measurement

Counter: `gpt-tokenizer` `countTokens`, the one `scripts/benchmark-compact-content*.cjs` use.

```bash
node -e "const {countTokens}=require('gpt-tokenizer');const s=require('fs').readFileSync('agents/gsd-executor.md','utf8');console.log(Buffer.byteLength(s),countTokens(s))"
```

| | bytes | tokens | lines |
|---|---|---|---|
| before | 48,466 | 11,853 | 910 |
| after | 41,803 | 10,328 | 779 |
| delta | −6,663 (−13.7%) | −1,525 (−12.9%) | −131 |

Per spawn that is ~1.5k tokens; at the transcript rate above (573 spawns) ~0.9M tokens.

## The four passes (in this order)

1. **Completion criterion.** Find every exit the agent has and make each a checkable end
   state in `<success_criteria>`: what is returned, what must be on disk, when to stop.
   The executor had a checklist that mixed both exits ("All tasks executed (or paused at
   checkpoint…)"); it now names two end states (`PLAN COMPLETE`, `CHECKPOINT REACHED`) plus
   the declared-`blocked` exit, and the role points at them.
2. **Context pointers instead of copies.** A block only some runs need, whose text already
   lives in `gsd-core/references/`, becomes a conditional pointer: the condition first, then
   the file to Read. Test: does every branch need it? (`documentation_lookup` — only tasks on
   version-sensitive library APIs; it was a verbatim 1.7 KB copy of
   `research-documentation-lookup.md`.) Same for restated reference protocols
   (MVP+TDD halt protocol → `execute-mvp-tdd.md`). Keep inline what every run executes
   (commit protocol, final commit, state updates).
3. **No-ops and duplicates.** Sentence by sentence: does it change behavior versus the
   default, and is it the only place saying it? Delete the whole sentence when it fails.
   Typical finds: frequency percentages on checkpoint types, a command-behavior list that
   caches `--help`, a "Your job" line restating the role, "these aren't features" glosses,
   exposition after a return format, a second anti-heredoc rule.
4. **Co-location and stale pointers.** Steps out of order (the commit ledger "before the
   first commit" sat inside step 4 between the sub-repo call and its own result), pointers
   to tags that do not exist (`<pre_commit_head_assertion>`), stale invocation advice
   (`use node, not npx` under a resolver that already chooses).

Positive phrasing where a prohibition was a soft one ("Proceed to state updates only after
PASSED" instead of "Do NOT skip. Do NOT proceed…"); hard guardrails (git clean, stash,
force-add, package installs) keep their prohibition and their reason.

## Constraints that held

- Text tests (`source-text-is-the-product`) were not weakened. Before deleting a sentence,
  grep `tests/` for its tokens; the executor's pinned tokens (stash family + `#3542` +
  alternative, anti-heredoc string, `Final metadata commit made` + `skipped_commit_docs_false`
  on one line, `--diff-filter=D`, ledger/`plan_head_*`, tracer/precondition/auto_select
  bullets, `references/tdd.md` + "Gate Enforcement Rules") all survive — the compressed
  text was written around them.
- ADR-1610 size ratchet: shrinking is always allowed; no baseline bump.
- ADR-4139: no compact sibling for the executor. For an agent that has one, apply the same
  pass to both files in one commit; if a boundary between them moves, add the
  `Boundary-Move-Declared` trailer.
- Emitted bytes move (ADR-2719/3942): run emitted-attribution against the merge base.
  Fork gotcha: against `merge-base(HEAD, upstream/next)` the range includes the fork's own
  history, whose `Emitted-Drift-Ack-Growth: gsd-executor.md` trailer (b1b7c8401) turns stale
  once the agent is smaller than upstream's (46,769 B). History is not rewritten; attribution
  is checked against `merge-base(HEAD, next)` instead, where the shrink is fully explained.

## Not done here, on purpose

- No behavior changes (no new steps, no changed gates). The pilot only removes, points, and
  reorders; whether that changes outcomes is 4.9's question.
- `documentation_lookup` is still an eager `@`-import in the researcher agents; converting
  them to the conditional pointer is the first repeat target once 4.9 reads green.
