#!/usr/bin/env node
'use strict';

/**
 * Generates `docs/reference/state-machines.md` — the lifecycle diagrams of the
 * closed status vocabularies — from the code constants that own them:
 *
 *   - plan status        `PLAN_STATUSES` + `PLAN_STATUS_TRANSITIONS`  (src/plan-status.cts)
 *   - VerificationStatus `VERIFICATION_STATUS` + `VERIFIER_STATUSES`
 *                        + `VERIFICATION_ROUTES`                      (src/verification.cts)
 *   - PhaseStatus        `PHASE_STATUS`                               (src/phase-status.cts)
 *   - check outcome      `CHECK_STATUS` + `CHECK_OUTCOME_RULES`
 *                        + `CHECK_STATUS_VERDICT`                     (src/verify-gates.cts)
 *
 * A transition is drawn ONLY when the code defines it in a table. Plan status
 * has one (`PLAN_STATUS_TRANSITIONS`), so its diagram has arrows. The other two
 * have only a set of values — a verification status is read from a report, a
 * phase status is computed from facts by `phaseStatusFromFacts` — so their
 * diagrams show the states and say, in the document, that no transitions are
 * defined. Inventing the "obvious" arrows would be the exact failure this
 * generator exists to prevent: a valid diagram that states something the code
 * does not.
 *
 * What is drawn besides states comes from data too: the writer-set / reader-only
 * split (`VERIFIER_STATUSES`), each verification status's route
 * (`VERIFICATION_ROUTES[status].command`), the terminal plan statuses (an empty
 * row in the transition table).
 *
 * Sources are the COMPILED modules (`gsd-core/bin/lib/*.cjs`, built from
 * `src/*.cts` by `npm run build:lib`), the same convention as gen-health-docs.
 *
 * Usage:
 *   node scripts/gen-state-machines.cjs              # print the document to stdout
 *   node scripts/gen-state-machines.cjs --write      # rewrite docs/reference/state-machines.md
 *   node scripts/gen-state-machines.cjs --check      # exit 1 if the committed document is stale
 *   node scripts/gen-state-machines.cjs --check --target <path>  # test-only: another file
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC_REL = 'docs/reference/state-machines.md';
const DOC_PATH = path.join(ROOT, DOC_REL);
const LIB_DIR = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const SOURCE = 'scripts/gen-state-machines.cjs';

function loadCompiled(name) {
  const p = path.join(LIB_DIR, `${name}.cjs`);
  if (!fs.existsSync(p)) {
    throw new ExitError(2, `gen-state-machines: compiled artifact not found at gsd-core/bin/lib/${name}.cjs.\nRun \`npm run build:lib\` first.`);
  }
  return require(p);
}

/**
 * The data the document is built from — exactly the code constants, copied
 * into plain arrays/objects so a test can hand in a modified set.
 */
function loadSources() {
  const planStatus = loadCompiled('plan-status');
  const verification = loadCompiled('verification');
  const phaseStatus = loadCompiled('phase-status');
  const verifyGates = loadCompiled('verify-gates');
  return {
    plan: {
      statuses: [...planStatus.PLAN_STATUSES],
      transitions: Object.fromEntries(
        Object.entries(planStatus.PLAN_STATUS_TRANSITIONS).map(([from, to]) => [from, [...to]]),
      ),
    },
    verification: {
      statuses: Object.values(verification.VERIFICATION_STATUS),
      writerSet: [...verification.VERIFIER_STATUSES],
      routes: Object.fromEntries(
        Object.entries(verification.VERIFICATION_ROUTES).map(([status, r]) => [status, `${r.command}${r.tail}`]),
      ),
    },
    phase: {
      statuses: Object.values(phaseStatus.PHASE_STATUS),
    },
    check: {
      statuses: Object.values(verifyGates.CHECK_STATUS),
      rules: verifyGates.CHECK_OUTCOME_RULES.map((r) => ({ id: r.id, observed: r.observed, status: r.status })),
      verdicts: { ...verifyGates.CHECK_STATUS_VERDICT },
    },
  };
}

/** Escape a markdown table cell. */
function cell(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

/** The pseudo-origin `none` in PLAN_STATUS_TRANSITIONS: a plan that declares no status yet. */
const PLAN_NO_STATUS = 'none';

function planSection(m, plan) {
  const ids = m.createIdRegistry();
  const origins = Object.keys(plan.transitions);
  for (const origin of origins) {
    if (origin !== PLAN_NO_STATUS && !plan.statuses.includes(origin)) {
      throw new Error(`gen-state-machines: PLAN_STATUS_TRANSITIONS has origin ${JSON.stringify(origin)} outside PLAN_STATUSES`);
    }
  }
  const stateKeys = [PLAN_NO_STATUS, ...plan.statuses];
  const states = stateKeys.map((s) => ({
    id: ids.id(s),
    label: s === PLAN_NO_STATUS ? '(no status)' : s,
  }));
  const transitions = [];
  for (const from of stateKeys) {
    for (const to of plan.transitions[from] ?? []) {
      if (!plan.statuses.includes(to)) {
        throw new Error(`gen-state-machines: PLAN_STATUS_TRANSITIONS ${from} → ${JSON.stringify(to)} targets a value outside PLAN_STATUSES`);
      }
      transitions.push({ from: ids.id(from), to: ids.id(to) });
    }
  }
  const terminal = stateKeys.filter((s) => (plan.transitions[s] ?? []).length === 0);
  const notes = terminal.map((s) => ({ state: ids.id(s), text: 'terminal: no transitions out' }));
  const rows = stateKeys.map(
    (s) => `| ${cell(s === PLAN_NO_STATUS ? '(no status)' : `\`${s}\``)} | ${cell((plan.transitions[s] ?? []).map((t) => `\`${t}\``).join(', ') || '—')} |`,
  );
  return [
    '## Plan status',
    '',
    'Source: `PLAN_STATUSES` and `PLAN_STATUS_TRANSITIONS` in `src/plan-status.cts`. The code defines the',
    'transitions as a table, so they are drawn. `(no status)` is the table\'s `none` origin — a plan whose',
    'frontmatter declares no `status` (not started, which is valid).',
    '',
    m.fence(m.stateDiagram({ direction: 'LR', states, transitions, notes })),
    '',
    '| From | Allowed next |',
    '|------|--------------|',
    ...rows,
    '',
  ];
}

function verificationSection(m, v) {
  const ids = m.createIdRegistry();
  for (const w of v.writerSet) {
    if (!v.statuses.includes(w)) throw new Error(`gen-state-machines: VERIFIER_STATUSES member ${JSON.stringify(w)} is not a VERIFICATION_STATUS`);
  }
  const readerOnly = v.statuses.filter((s) => !v.writerSet.includes(s));
  const states = v.statuses.map((s) => ({ id: ids.id(s), label: s }));
  const groups = [
    { id: 'writer_set', label: 'writer set — a report may carry it', states: v.writerSet.map((s) => ids.id(s)) },
    { id: 'reader_only', label: 'reader-only — derived by the reader, never written', states: readerOnly.map((s) => ids.id(s)) },
  ];
  const notes = v.statuses
    .filter((s) => (v.routes[s] ?? '') !== '')
    .map((s) => ({ state: ids.id(s), text: `route: ${v.routes[s]}` }));
  const rows = v.statuses.map(
    (s) => `| \`${cell(s)}\` | ${v.writerSet.includes(s) ? 'writer set' : 'reader-only'} | ${cell(v.routes[s] ? `\`${v.routes[s]}\`` : '—')} |`,
  );
  return [
    '## VerificationStatus',
    '',
    'Source: `VERIFICATION_STATUS`, `VERIFIER_STATUSES` and `VERIFICATION_ROUTES` in `src/verification.cts`.',
    '**The code defines no transitions between these values** — a status is read from a report (writer',
    'set) or derived by the reader (reader-only) — so only the states are drawn, grouped by who may produce',
    'them. A note is the routing table\'s next command, not a transition.',
    '',
    m.fence(m.stateDiagram({ states, groups, notes })),
    '',
    '| Value | Produced by | Route (`VERIFICATION_ROUTES`) |',
    '|-------|-------------|-------------------------------|',
    ...rows,
    '',
  ];
}

function phaseSection(m, phase) {
  const ids = m.createIdRegistry();
  const states = phase.statuses.map((s) => ({ id: ids.id(s), label: s }));
  return [
    '## PhaseStatus',
    '',
    'Source: `PHASE_STATUS` in `src/phase-status.cts`, in declaration order. **The code defines no',
    'transitions**: a phase status is not stored, it is computed from facts (plan/summary counts, the',
    'completion verdict, the verification status) by `phaseStatusFromFacts`, and nothing in the code',
    'constrains how it changes from one reading to the next. Only the states are drawn.',
    '',
    m.fence(m.stateDiagram({ direction: 'LR', states })),
    '',
    '| Value |',
    '|-------|',
    ...phase.statuses.map((s) => `| \`${cell(s)}\` |`),
    '',
  ];
}

/**
 * The outcome of one `verify gates` / `verify baseline` check run. The code defines a classifier,
 * not a lifecycle: each run enters exactly one status, by the first rule of `CHECK_OUTCOME_RULES`
 * that matches, and never moves. So the arrows are drawn from the start state, one per rule and
 * labelled with what the rule observes — the same table `classifyRun` walks — and each state
 * carries what a gate makes of it (`CHECK_STATUS_VERDICT`) as a note.
 */
function checkSection(m, check) {
  const ids = m.createIdRegistry();
  for (const rule of check.rules) {
    if (!check.statuses.includes(rule.status)) {
      throw new Error(`gen-state-machines: CHECK_OUTCOME_RULES rule ${JSON.stringify(rule.id)} targets ${JSON.stringify(rule.status)} outside CHECK_STATUS`);
    }
  }
  for (const s of check.statuses) {
    if (!check.verdicts[s]) throw new Error(`gen-state-machines: CHECK_STATUS ${JSON.stringify(s)} has no CHECK_STATUS_VERDICT entry`);
    if (!check.rules.some((r) => r.status === s)) throw new Error(`gen-state-machines: CHECK_STATUS ${JSON.stringify(s)} is reached by no CHECK_OUTCOME_RULES rule`);
  }
  const states = check.statuses.map((s) => ({ id: ids.id(s), label: s }));
  // One start state for every rule, so the verdicts are notes rather than groups: a composite
  // state would give each group its own `[*]`, drawing four starts for one classification.
  const notes = check.statuses.map((s) => ({ state: ids.id(s), text: `gate verdict: ${check.verdicts[s]}` }));
  const transitions = check.rules.map((r) => ({ from: m.STATE_TERMINAL, to: ids.id(r.status), label: r.observed }));
  const rows = check.rules.map(
    (r, i) => `| ${i + 1} | \`${cell(r.id)}\` | ${cell(r.observed)} | \`${cell(r.status)}\` | ${cell(check.verdicts[r.status])} |`,
  );
  return [
    '## Check outcome (`verify gates`, `verify baseline`)',
    '',
    'Source: `CHECK_STATUS`, `CHECK_OUTCOME_RULES` and `CHECK_STATUS_VERDICT` in `src/verify-gates.cts`. A',
    'check run is **classified, not transitioned**: it enters exactly one status, by the first rule that',
    'matches, and never moves. Each arrow is one rule of the table the classifier walks, labelled with what',
    'it observes; a note is what the mn gates (`check mn-verify-gates`, `check mn-baseline`) make of the',
    'status.',
    '',
    m.fence(m.stateDiagram({ direction: 'LR', states, transitions, notes })),
    '',
    '| Order | Rule | Observed | Status | Gate verdict |',
    '|-------|------|----------|--------|--------------|',
    ...rows,
    '',
  ];
}

/** The whole document for a given set of sources. Pure. */
function renderStateMachinesDoc(sources, m = loadCompiled('mermaid')) {
  return [
    m.derivedMarker(SOURCE),
    '',
    '# State machines',
    '',
    'Lifecycle diagrams of the closed status vocabularies, generated from the code constants that own',
    'them. Regenerate with `node scripts/gen-state-machines.cjs --write`; `--check` (part of',
    '`npm run lint:generated-sync`) fails when a vocabulary changes without regeneration.',
    '',
    ...planSection(m, sources.plan),
    ...verificationSection(m, sources.verification),
    ...phaseSection(m, sources.phase),
    ...checkSection(m, sources.check),
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { write: false, check: false, targetPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--target') {
      const value = argv[i + 1];
      if (value === undefined) throw new ExitError(1, '--target requires a path argument.');
      opts.targetPath = value;
      i++;
    } else {
      throw new ExitError(1, `unknown flag: ${arg}\nRecognized flags: --write, --check, --target <path>.`);
    }
  }
  return opts;
}

function main() {
  const { write, check, targetPath } = parseArgs(process.argv.slice(2));
  const expected = renderStateMachinesDoc(loadSources());
  // `--target` exists for test isolation only (as in gen-health-docs.cjs).
  const resolvedPath = targetPath ? path.resolve(targetPath) : DOC_PATH;
  const displayPath = targetPath || DOC_REL;

  if (write) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, expected, 'utf8');
    process.stdout.write(`Wrote ${displayPath}.\n`);
    return 0;
  }
  if (check) {
    const current = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : null;
    if (current !== expected) {
      process.stderr.write(
        `${displayPath} is ${current === null ? 'missing' : 'stale'} — it does not match the status constants in ` +
          'src/plan-status.cts, src/verification.cts, src/phase-status.cts and src/verify-gates.cts.\nRun:\n  node scripts/gen-state-machines.cjs --write\n\n',
      );
      throw new ExitError(1);
    }
    process.stdout.write(`${displayPath} is up to date.\n`);
    return 0;
  }
  process.stdout.write(expected);
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  loadSources,
  renderStateMachinesDoc,
  parseArgs,
  DOC_PATH,
  DOC_REL,
  SOURCE,
};
