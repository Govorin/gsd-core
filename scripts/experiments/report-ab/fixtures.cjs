#!/usr/bin/env node
'use strict';

/**
 * Report A/B experiment (sync plan task 4.9) — fixture generator and variant builder.
 *
 * Writes, under the output directory (default: ./out next to this file):
 *
 *   fixtures/<fx>/<phase-dir>/*-PLAN.md, *-SUMMARY.md   a phase directory per fixture
 *   ground-truth.json                                   the seeded defects (the answer key)
 *   reports/<fx>/{A,B,C}.md                             the three variants of the artifact
 *
 * Everything is a pure function of the seeds below: the same checkout gives the same bytes.
 *
 * Variants — the CONTENT is the same plan files in all three, only the form differs:
 *   A  the plan files, verbatim, with a directory listing (what a reviewer reads today);
 *   B  A + a neutral mermaid diagram of the same `wave`/`depends_on` data — nodes, waves,
 *      edges, status glyphs, nothing judged (no red, no defect list);
 *   C  A + the `plan graph` output exactly as the fork ships it (gsd-core/bin/lib/plan-graph.cjs):
 *      defects drawn red and listed. C is not "form only" — it carries a detector's verdict for
 *      three of the six defect classes; it is here to measure what the shipped tool adds and
 *      whether its marks pull attention away from the classes it does not mark.
 *
 * Defect classes (two per category, each seeded three times across six fixtures):
 *   flagged by plan-graph:  cycle, missing (depends_on names no plan), wave (same/later wave)
 *   visible, not flagged:   status (a plan has a SUMMARY while its dependency is unfinished)
 *   text only:              undeclared (imports a same-wave plan's file, no depends_on),
 *                           file_conflict (two same-wave plans modify one file, no ordering)
 *
 * The generator checks itself: every fixture is run through the real plan-graph detector, which
 * must report exactly the flagged defects that were seeded (zero on a control), and the text-only
 * invariants are re-derived from the written files.
 *
 * Usage: node scripts/experiments/report-ab/fixtures.cjs [--out <dir>]
 * Needs the compiled lib (`npm run build:lib`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib');

// ─── Fixture table ───────────────────────────────────────────────────────────

const DOMAINS = [
  { phase: '03', slug: 'session-auth', title: 'Session authentication', dir: 'auth',
    nouns: ['session', 'token', 'password', 'login', 'logout', 'cookie', 'csrf', 'rate-limit', 'audit', 'refresh', 'lockout', 'mfa'] },
  { phase: '05', slug: 'billing', title: 'Subscription billing', dir: 'billing',
    nouns: ['plan', 'invoice', 'payment', 'webhook', 'coupon', 'tax', 'proration', 'receipt', 'dunning', 'ledger', 'refund', 'trial'] },
  { phase: '04', slug: 'search', title: 'Catalog search', dir: 'search',
    nouns: ['indexer', 'tokenizer', 'query', 'ranking', 'facet', 'synonym', 'highlight', 'cache', 'suggest', 'filter', 'paging', 'telemetry'] },
  { phase: '06', slug: 'notifications', title: 'User notifications', dir: 'notify',
    nouns: ['channel', 'template', 'queue', 'email', 'push', 'digest', 'preference', 'throttle', 'unsubscribe', 'retry', 'render', 'metrics'] },
  { phase: '07', slug: 'file-uploads', title: 'File uploads', dir: 'upload',
    nouns: ['bucket', 'presign', 'scanner', 'thumbnail', 'quota', 'mime', 'chunk', 'resume', 'cleanup', 'manifest', 'cdn', 'policy'] },
  { phase: '02', slug: 'admin-reports', title: 'Admin reports', dir: 'reports',
    nouns: ['dataset', 'aggregate', 'schedule', 'export', 'chart', 'filter', 'permission', 'snapshot', 'csv', 'mailer', 'retention', 'dashboard'] },
  { phase: '08', slug: 'feature-flags', title: 'Feature flags', dir: 'flags',
    nouns: ['flag', 'segment', 'rollout', 'evaluator', 'override', 'audit', 'sdk', 'cache', 'kill-switch', 'experiment', 'sync', 'console'] },
  { phase: '09', slug: 'inventory', title: 'Inventory tracking', dir: 'inventory',
    nouns: ['sku', 'warehouse', 'stock', 'reservation', 'transfer', 'count', 'threshold', 'supplier', 'reorder', 'movement', 'valuation', 'alert'] },
];

/** Which defects each fixture carries. f7/f8 are controls. Each class appears exactly 3 times. */
const FIXTURES = [
  { id: 'f1', domain: 0, seed: 101, defects: ['cycle', 'status', 'file_conflict'] },
  { id: 'f2', domain: 1, seed: 202, defects: ['missing', 'undeclared', 'wave'] },
  { id: 'f3', domain: 2, seed: 303, defects: ['wave', 'status', 'undeclared'] },
  { id: 'f4', domain: 3, seed: 404, defects: ['cycle', 'missing', 'file_conflict'] },
  { id: 'f5', domain: 4, seed: 505, defects: ['missing', 'status', 'wave'] },
  { id: 'f6', domain: 5, seed: 606, defects: ['cycle', 'undeclared', 'file_conflict'] },
  { id: 'f7', domain: 6, seed: 707, defects: [] },
  { id: 'f8', domain: 7, seed: 808, defects: [] },
];

const CATEGORY = Object.freeze({
  cycle: 'flagged',
  missing: 'flagged',
  wave: 'flagged',
  status: 'visible',
  undeclared: 'text',
  file_conflict: 'text',
});

// ─── Deterministic randomness ────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

function shuffle(rnd, arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const camel = (noun) => noun.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (noun) => camel(noun).replace(/^[a-z]/, (c) => c.toUpperCase());

// ─── A clean phase ───────────────────────────────────────────────────────────

/**
 * 9–10 plans over 4 waves; waves 2 and 3 hold three plans each so same-wave defects have room.
 * Every dependency points to an earlier wave, at least one to the wave just before. Wave 1 is
 * done (SUMMARY + status done); the first wave-2 plan is in progress; the rest have no status.
 */
function cleanPhase(domain, seed) {
  const rnd = mulberry32(seed);
  const sizes = [rnd() < 0.5 ? 2 : 3, 3, 3, rnd() < 0.5 ? 1 : 2];
  const nouns = shuffle(rnd, domain.nouns);
  const plans = [];
  let n = 0;
  sizes.forEach((size, wi) => {
    for (let k = 0; k < size; k++) {
      n += 1;
      const noun = nouns[n - 1];
      plans.push({
        id: `${domain.phase}-${String(n).padStart(2, '0')}`,
        noun,
        wave: wi + 1,
        dependsOn: [],
        main: `src/${domain.dir}/${noun}.ts`,
        test: `src/${domain.dir}/${noun}.test.ts`,
        extraFiles: [],
        symbol: `${camel(noun)}Service`,
        uses: [],
        extraTasks: [],
        status: null,
        summary: false,
      });
    }
  });
  for (const p of plans) {
    if (p.wave === 1) continue;
    const prev = plans.filter((q) => q.wave === p.wave - 1);
    const earlier = plans.filter((q) => q.wave < p.wave - 1);
    const deps = new Set([pick(rnd, prev).id]);
    if (prev.length > 1 && rnd() < 0.5) deps.add(pick(rnd, prev).id);
    if (earlier.length > 0 && rnd() < 0.35) deps.add(pick(rnd, earlier).id);
    p.dependsOn = [...deps].sort();
    // A plan uses the main export of every plan it depends on — and of nothing else.
    p.uses = p.dependsOn.map((id) => id);
  }
  for (const p of plans) {
    if (p.wave === 1) {
      p.status = 'done';
      p.summary = true;
    }
  }
  plans.find((p) => p.wave === 2).status = 'in_progress';
  return plans;
}

// ─── Defect injection ────────────────────────────────────────────────────────

const byId = (plans) => new Map(plans.map((p) => [p.id, p]));

function reaches(plans, start, goal) {
  const map = byId(plans);
  const seen = new Set();
  const stack = [start];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === goal) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    // edges run dependency → dependent; walk dependents
    for (const p of plans) if (map.get(p.id).dependsOn.includes(cur)) stack.push(p.id);
  }
  return false;
}

/** A same-wave pair with no path between them either way, neither plan already used. */
function freeSameWavePair(rnd, plans, used, wave) {
  const members = plans.filter((p) => p.wave === wave && !used.has(p.id));
  const pairs = [];
  for (const a of members) {
    for (const b of members) {
      if (a.id >= b.id) continue;
      if (reaches(plans, a.id, b.id) || reaches(plans, b.id, a.id)) continue;
      pairs.push([a, b]);
    }
  }
  if (pairs.length === 0) return null;
  return shuffle(rnd, pick(rnd, pairs));
}

const INJECT = {
  /** B(w2) → C(w3) → D(w4) along existing edges; then B also depends on D. */
  cycle(rnd, plans, used) {
    const map = byId(plans);
    const chains = [];
    for (const d of plans.filter((p) => p.wave === 4)) {
      for (const cId of d.dependsOn) {
        const c = map.get(cId);
        if (c.wave !== 3) continue;
        for (const bId of c.dependsOn) {
          const b = map.get(bId);
          if (b.wave === 2 && b.status === null && ![b, c, d].some((x) => used.has(x.id))) chains.push([b, c, d]);
        }
      }
    }
    const [b, c, d] = pick(rnd, chains);
    b.dependsOn = [...b.dependsOn, d.id].sort();
    [b, c, d].forEach((x) => used.add(x.id));
    // The back edge also points from wave 2 to wave 4: a wave-order report on it is the same
    // defect seen from another side — neither a hit nor a false positive (score.cjs).
    return {
      plans: [b.id, c.id, d.id],
      companion: { class: 'wave', plans: [b.id, d.id] },
      text: `${b.id} → ${c.id} → ${d.id} → ${b.id}: ${b.id} depends_on ${d.id}`,
    };
  },

  /** A wave-3 or wave-4 plan depends on an id one or two past the last plan. */
  missing(rnd, plans, used) {
    const cands = plans.filter((p) => p.wave >= 3 && !used.has(p.id));
    const p = pick(rnd, cands);
    const phase = p.id.split('-')[0];
    const ghost = `${phase}-${String(plans.length + 1 + Math.floor(rnd() * 2)).padStart(2, '0')}`;
    p.dependsOn = [...p.dependsOn, ghost].sort();
    used.add(p.id);
    return { plans: [p.id], ghost, text: `${p.id} depends_on ${ghost}, no such plan in the phase` };
  },

  /** P depends on Q, both in the same wave (wave 3 when possible). */
  wave(rnd, plans, used) {
    const pair = freeSameWavePair(rnd, plans, used, 3) ?? freeSameWavePair(rnd, plans, used, 2);
    const [p, q] = pair;
    p.dependsOn = [...p.dependsOn, q.id].sort();
    p.uses = [...p.uses, q.id];
    used.add(p.id);
    used.add(q.id);
    return { plans: [p.id, q.id], text: `${p.id} (wave ${p.wave}) depends_on ${q.id} (wave ${q.wave})` };
  },

  /** A wave-2 plan P is done (SUMMARY) while its wave-1 dependency Q is back in progress. */
  status(rnd, plans, used) {
    const map = byId(plans);
    const cands = plans.filter(
      (p) => p.wave === 2 && p.status === null && !used.has(p.id) && p.dependsOn.some((id) => !used.has(id)),
    );
    const p = pick(rnd, cands);
    const q = map.get(pick(rnd, p.dependsOn.filter((id) => !used.has(id))));
    // Wave 1 reopened means wave 2 has not started: drop the baseline in-progress plan, or it
    // would be a second, unseeded instance of the same contradiction.
    for (const other of plans) if (other.wave > 1 && other.status === 'in_progress') other.status = null;
    p.status = 'done';
    p.summary = true;
    q.status = 'in_progress';
    q.summary = false;
    used.add(p.id);
    used.add(q.id);
    return { plans: [p.id, q.id], text: `${p.id} has a SUMMARY (done) while its dependency ${q.id} is in_progress with no SUMMARY` };
  },

  /** P imports Q's main export; same wave, no depends_on between them. */
  undeclared(rnd, plans, used) {
    const pair = freeSameWavePair(rnd, plans, used, 3) ?? freeSameWavePair(rnd, plans, used, 2);
    const [p, q] = pair;
    p.uses = [...p.uses, q.id];
    used.add(p.id);
    used.add(q.id);
    return { plans: [p.id, q.id], file: q.main, text: `${p.id} imports ${q.symbol} from ${q.main} (created by ${q.id}, same wave ${p.wave}) without depends_on` };
  },

  /** P also modifies Q's main file; same wave, no ordering between them. */
  file_conflict(rnd, plans, used) {
    const pair = freeSameWavePair(rnd, plans, used, 2) ?? freeSameWavePair(rnd, plans, used, 3);
    const [p, q] = pair;
    p.extraFiles = [...p.extraFiles, q.main];
    p.extraTasks = [...p.extraTasks, `Register the ${p.noun} hooks inside \`${q.main}\` (add a \`${camel(p.noun)}Hook\` entry next to the existing exports).`];
    used.add(p.id);
    used.add(q.id);
    return { plans: [p.id, q.id], file: q.main, text: `${p.id} and ${q.id} (both wave ${p.wave}) both modify ${q.main} with no depends_on between them` };
  },
};

// ─── Rendering plan files ────────────────────────────────────────────────────

function yamlList(items) {
  return items.length === 0 ? '[]' : `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

/** A small deterministic hash so each plan's phrasing is fixed by its id and the fixture seed. */
function hashSeed(text, seed) {
  let h = seed >>> 0;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 2654435761) >>> 0;
  return h;
}

/** Phrasing pools: realistic plan prose that only ever talks about the plan's own files. */
const PURPOSE = [
  (n, t) => `Without a dedicated ${n} layer the rest of ${t} has to re-implement the same checks inline, and they drift.`,
  (n, t) => `${pascal(n)} is the seam the later plans of ${t} build on, so its contract has to be fixed first and tested on its own.`,
  (n, t) => `Today the ${n} logic is scattered across request handlers; ${t} needs one owner for it with a typed surface.`,
];
const NOT_DOING = [
  (n) => `UI for ${n} management (deferred to the admin phase, see ROADMAP.md).`,
  (n) => `Migrating historical ${n} records (tracked as a backlog item).`,
  (n) => `Multi-region replication of ${n} state (out of scope for this milestone per PROJECT.md).`,
];
const ACTION_EXTRA = [
  (n) => `Validate every input at the boundary with a zod schema \`${pascal(n)}Input\`; reject unknown keys.`,
  (n) => `Return errors as values (\`Result<${pascal(n)}, ${pascal(n)}Error>\`), never throw across the module boundary.`,
  (n) => `Log one structured line per call at debug level with the ${n} id and the elapsed time; never log secrets.`,
  (_n) => `Keep the module free of framework imports so it can be unit-tested without the HTTP server.`,
  (n) => `Make the operation idempotent on the ${n} id: a repeated call with the same id returns the stored result.`,
  (n) => `Read the timeout from \`config.${camel(n)}TimeoutMs\` (default 5000) instead of hard-coding it.`,
];
const TEST_CASES = [
  (n) => `creates a ${n} from valid input and returns it`,
  (_n) => `rejects input with an unknown key`,
  (_n) => `returns the stored result on a repeated call with the same id`,
  (n) => `maps a storage failure to \`${pascal(n)}Error.Unavailable\``,
  (_n) => `does not log secret fields`,
  (_n) => `honours the configured timeout`,
];
const THREATS = [
  (n) => `| Tampering with ${n} input | T | zod schema at the boundary, unknown keys rejected |`,
  (_n) => `| Information disclosure via logs | I | structured logger with a deny-list for secret fields |`,
  (n) => `| Denial of service by oversized ${n} payload | D | body size limit 64 KiB enforced before parsing |`,
  (n) => `| Repudiation of ${n} changes | R | every mutation writes an audit entry with the actor id |`,
];

function planFile(domain, p, map, phaseDirName, seed) {
  const rnd = mulberry32(hashSeed(p.id, seed));
  const files = [p.main, p.test, ...p.extraFiles];
  const uses = p.uses.map((id) => map.get(id));
  const N = pascal(p.noun);
  const front = [
    '---',
    `phase: ${domain.phase}-${domain.slug}`,
    `plan: ${p.id.split('-')[1]}`,
    'type: execute',
    `wave: ${p.wave}`,
    `depends_on: ${yamlList(p.dependsOn)}`,
    `files_modified: ${yamlList(files)}`,
    'autonomous: true',
    `requirements: [${domain.dir.toUpperCase()}-${p.id.split('-')[1]}]`,
    'user_setup: []',
    ...(p.status !== null ? [`status: ${p.status}`] : []),
    '',
    'must_haves:',
    '  truths:',
    `    - "${N} behaviour is reachable only through ${p.symbol}"`,
    `    - "Invalid ${p.noun} input is rejected before any side effect"`,
    `    - "A repeated call with the same ${p.noun} id is idempotent"`,
    '  artifacts:',
    `    - path: ${p.main}`,
    `      provides: ${p.symbol} and the ${N}Input / ${N}Error types`,
    `    - path: ${p.test}`,
    `      provides: unit tests for ${p.symbol}`,
    '  key_links:',
    ...(uses.length === 0
      ? [`    - from: ${p.main}`, `      to: config`, `      via: config.${camel(p.noun)}TimeoutMs`]
      : uses.flatMap((d) => [`    - from: ${p.main}`, `      to: ${d.main}`, `      via: import { ${d.symbol} }`])),
    '---',
  ];
  const objective = [
    '<objective>',
    `Deliver the ${p.noun} part of ${domain.title.toLowerCase()}: one module that owns ${p.noun} behaviour behind \`${p.symbol}\`.`,
    '',
    `Purpose: ${pick(rnd, PURPOSE)(p.noun, domain.title.toLowerCase())}`,
    `Output: \`${p.main}\` exporting \`${p.symbol}\`, and \`${p.test}\`.`,
    `Restated: the phase makes ${domain.title.toLowerCase()} dependable; this plan supplies its ${p.noun} piece with a contract later plans can import.`,
    `Not doing: ${pick(rnd, NOT_DOING)(p.noun)}`,
    '</objective>',
  ];
  const context = [
    '<execution_context>',
    '@$HOME/.claude/gsd-core/workflows/execute-plan.md',
    '@$HOME/.claude/gsd-core/templates/summary.md',
    '</execution_context>',
    '',
    '<context>',
    '@.planning/PROJECT.md',
    '@.planning/ROADMAP.md',
    '@.planning/STATE.md',
    ...p.dependsOn.filter((id) => map.has(id)).map((id) => `@.planning/phases/${phaseDirName}/${id}-SUMMARY.md`),
    '</context>',
  ];
  const interfaces =
    uses.length === 0
      ? []
      : [
          '',
          '<interfaces>',
          ...uses.flatMap((d) => [
            `// From ${d.main}`,
            `export interface ${pascal(d.noun)} { id: string; createdAt: Date; ${camel(d.noun)}Ref: string }`,
            `export function ${d.symbol}(input: ${pascal(d.noun)}Input): Promise<Result<${pascal(d.noun)}, ${pascal(d.noun)}Error>>;`,
            '',
          ]),
          '</interfaces>',
        ];
  const extras = shuffle(rnd, ACTION_EXTRA).slice(0, 3).map((f) => f(p.noun));
  const usesText = uses.map((d) => `Import \`${d.symbol}\` from \`${d.main}\` and call it where the ${p.noun} flow needs ${d.noun} data.`);
  const tasks = [
    '<task type="auto">',
    `  <name>Task 1: ${N} service</name>`,
    `  <files>${p.main}</files>`,
    '  <action>',
    `Create \`${p.main}\` exporting \`${p.symbol}\` together with the \`${N}Input\` and \`${N}Error\` types.`,
    ...usesText,
    ...extras,
    '  </action>',
    `  <verify><automated>npx tsc --noEmit</automated></verify>`,
    `  <done>\`${p.symbol}\` compiles, is exported, and rejects invalid input.</done>`,
    '</task>',
    '',
    ...p.extraTasks.flatMap((t, i) => [
      '<task type="auto">',
      `  <name>Task ${i + 2}: ${N} registration</name>`,
      '  <action>',
      t,
      '  </action>',
      '  <verify><automated>npx tsc --noEmit</automated></verify>',
      `  <done>The ${p.noun} hook is registered.</done>`,
      '</task>',
      '',
    ]),
    '<task type="auto" tdd="true">',
    `  <name>Task ${p.extraTasks.length + 2}: ${N} tests</name>`,
    `  <files>${p.test}</files>`,
    '  <behavior>',
    ...shuffle(rnd, TEST_CASES).slice(0, 4).map((f) => `    - ${f(p.noun)}`),
    '  </behavior>',
    `  <verify><automated>npx vitest run ${p.test}</automated></verify>`,
    `  <done>All ${p.noun} tests pass.</done>`,
    '</task>',
  ];
  const tail = [
    '<threat_model>',
    '| Threat | STRIDE | Mitigation |',
    '|---|---|---|',
    ...shuffle(rnd, THREATS).slice(0, 2).map((f) => f(p.noun)),
    '</threat_model>',
    '',
    '<verification>',
    `- \`npx tsc --noEmit\` passes`,
    `- \`npx vitest run ${p.test}\` passes`,
    `- \`${p.symbol}\` is the only export that touches ${p.noun} storage`,
    '</verification>',
    '',
    '<success_criteria>',
    `- ${N} behaviour is available through \`${p.symbol}\` with typed errors`,
    `- Invalid input never reaches storage`,
    `- Requirement ${domain.dir.toUpperCase()}-${p.id.split('-')[1]} is covered by a passing test`,
    '</success_criteria>',
    '',
    '<output>',
    `After completion, create \`.planning/phases/${phaseDirName}/${p.id}-SUMMARY.md\`.`,
    '</output>',
  ];
  return [...front, '', ...objective, '', ...context, ...interfaces, '', '<tasks>', '', ...tasks, '', '</tasks>', '', ...tail, ''].join('\n');
}

function summaryFile(domain, p) {
  return [
    '---',
    `phase: ${domain.phase}-${domain.slug}`,
    `plan: ${p.id.split('-')[1]}`,
    'completed: 2026-09-30',
    '---',
    '',
    `# ${p.id} summary`,
    '',
    `\`${p.symbol}\` landed in \`${p.main}\`; tests pass.`,
    '',
  ].join('\n');
}

// ─── Variants ────────────────────────────────────────────────────────────────

const GLYPH = { done: '✓', running: '▶', blocked: '⛔', superseded: '⊘', pending: '○' };

/**
 * Variant B's diagram: plan-graph's nodes, wave subgraphs, edges and status glyphs — the same
 * data — with nothing judged: no defect colour, no "no such plan" label, no defect list.
 */
function neutralDiagramFor(graph, planGraph, mermaid) {
  const ids = mermaid.createIdRegistry('p_');
  const waveKey = (w) => (w === null ? Number.POSITIVE_INFINITY : w);
  const waves = [...new Set(graph.plans.map((p) => p.wave))].sort((a, b) => waveKey(a) - waveKey(b));
  const nodes = [];
  const subgraphs = [];
  for (const w of waves) {
    const members = graph.plans.filter((p) => p.wave === w);
    subgraphs.push({ id: w === null ? 'W_none' : `W${w}`, title: w === null ? 'wave не задана' : `wave ${w}`, nodes: members.map((p) => ids.id(p.id)) });
    for (const p of members) {
      const st = planGraph.planNodeState(p);
      nodes.push({ id: ids.id(p.id), label: `${GLYPH[st]} ${p.id}` });
    }
  }
  for (const m of graph.missing) nodes.push({ id: ids.id(m), label: m });
  const edges = graph.edges.map((e) => ({ from: ids.id(e.from), to: ids.id(e.to) }));
  return mermaid.fence(mermaid.flowchart({ direction: 'LR', nodes, subgraphs, edges }));
}

function report(domain, phaseDirName, files, graphSection) {
  const out = [
    `# Phase ${domain.phase}: ${domain.title} — plans`,
    '',
    `Directory \`.planning/phases/${phaseDirName}/\`:`,
    '',
    ...files.map((f) => `- ${f.name}`),
    '',
  ];
  if (graphSection !== null) out.push('## Dependency graph', '', graphSection.trimEnd(), '');
  for (const f of files) {
    if (!f.name.endsWith('-PLAN.md')) continue;
    out.push(`## ${f.name}`, '', '````markdown', f.text.trimEnd(), '````', '');
  }
  return out.join('\n');
}

// ─── Self-check ──────────────────────────────────────────────────────────────

function selfCheck(fx, defects, graph) {
  const flagged = defects.filter((d) => CATEGORY[d.class] === 'flagged');
  if (flagged.length === 0 && graph.defects.length !== 0) {
    throw new Error(`${fx.id}: plan-graph reports ${graph.defects.length} defect(s) where none were seeded`);
  }
  for (const d of flagged) {
    const hit = graph.defects.some((e) => d.plans.includes(e.to) && (d.class !== 'missing' || e.from === d.ghost));
    if (!hit) throw new Error(`${fx.id}: seeded ${d.class} (${d.text}) is not reported by plan-graph`);
  }
  for (const e of graph.defects) {
    const owned = flagged.some((d) => d.plans.includes(e.to) && d.plans.concat(d.ghost ?? []).includes(e.from));
    if (!owned) throw new Error(`${fx.id}: plan-graph reports an unseeded defect ${e.from}→${e.to} (${e.defect})`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

function generate(outDir) {
  const planGraph = require(path.join(LIB, 'plan-graph.cjs'));
  const mermaid = require(path.join(LIB, 'mermaid.cjs'));
  fs.rmSync(outDir, { recursive: true, force: true });
  const truth = { generated_by: 'scripts/experiments/report-ab/fixtures.cjs', categories: CATEGORY, fixtures: {} };

  for (const fx of FIXTURES) {
    const domain = DOMAINS[fx.domain];
    const plans = cleanPhase(domain, fx.seed);
    const rnd = mulberry32(fx.seed * 7 + 1);
    const used = new Set();
    const defects = fx.defects.map((cls, i) => ({ key: `${fx.id}-d${i + 1}`, class: cls, category: CATEGORY[cls], ...INJECT[cls](rnd, plans, used) }));

    const phaseDirName = `${domain.phase}-${domain.slug}`;
    const phaseDir = path.join(outDir, 'fixtures', fx.id, phaseDirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    const map = byId(plans);
    const files = [];
    for (const p of plans) {
      files.push({ name: `${p.id}-PLAN.md`, text: planFile(domain, p, map, phaseDirName, fx.seed) });
      if (p.summary) files.push({ name: `${p.id}-SUMMARY.md`, text: summaryFile(domain, p) });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const f of files) fs.writeFileSync(path.join(phaseDir, f.name), f.text);

    const read = planGraph.readPhasePlans(phaseDir);
    if (!read.ok) throw new Error(`${fx.id}: plan-graph cannot read the fixture: ${read.message}`);
    const graph = planGraph.buildPlanGraph(read.plans);
    selfCheck(fx, defects, graph);

    const reportDir = path.join(outDir, 'reports', fx.id);
    fs.mkdirSync(reportDir, { recursive: true });
    const variants = {
      A: report(domain, phaseDirName, files, null),
      B: report(domain, phaseDirName, files, neutralDiagramFor(graph, planGraph, mermaid)),
      C: report(domain, phaseDirName, files, planGraph.renderPlanGraph(graph)),
    };
    const sha256 = {};
    for (const [v, text] of Object.entries(variants)) {
      fs.writeFileSync(path.join(reportDir, `${v}.md`), text);
      sha256[v] = crypto.createHash('sha256').update(text).digest('hex');
    }

    truth.fixtures[fx.id] = { phase_dir: phaseDirName, plan_count: plans.length, control: defects.length === 0, report_sha256: sha256, defects };
  }
  fs.writeFileSync(path.join(outDir, 'ground-truth.json'), JSON.stringify(truth, null, 2) + '\n');
  return truth;
}

if (require.main === module) {
  const i = process.argv.indexOf('--out');
  const outDir = i > -1 ? path.resolve(process.argv[i + 1]) : path.join(__dirname, 'out');
  const truth = generate(outDir);
  const n = Object.values(truth.fixtures).reduce((s, f) => s + f.defects.length, 0);
  process.stdout.write(`OK: ${Object.keys(truth.fixtures).length} fixtures, ${n} seeded defects → ${outDir}\n`);
}

module.exports = { generate, FIXTURES, CATEGORY };
