#!/usr/bin/env node
'use strict';

/**
 * Report A/B experiment (sync plan task 4.9) — deterministic scoring.
 *
 * A finding matches a seeded defect when BOTH hold:
 *   - its `kind` is one the defect class accepts (ACCEPT below — a cycle reported as a wave-order
 *     problem on the cycle's edge still counts, an undeclared import reported as a file conflict
 *     still counts);
 *   - the plan ids it names — in `plans` or in its description; reviewers often put the second
 *     plan of a pair only in the prose — cover the defect's plans: all of them for a pair, two of
 *     the three for a cycle, the ghost id for a missing reference.
 * A finding counts for at most one defect (first match in finding order). A later finding that
 * matches an already-found defect is a duplicate, and a finding that matches a defect's
 * companion (the wave-order side of a seeded cycle) is the same defect seen from another side:
 * both are neutral — neither a hit nor a false positive.
 *
 * A finding of a structural kind (the first six) that matches nothing is a false positive. The
 * other kinds (vague_task, missing_verification, scope, other) are opinions about plan quality,
 * not claims about the seeded structure; they are counted separately as noise.
 *
 * Unmatched structural findings are listed so a human can check the matcher; a verdict goes into
 * adjudication.json as { "<model>": { "<fixture>/<variant>/<rep>#<finding index>":
 * "<defect key>" | "fp" | "neutral" } } and is applied on the next run, so the scoring stays
 * reproducible. "neutral" is for a restatement or a consequence of a seeded defect the matcher
 * could not tie to it, and for a finding that retracts itself ("…is fine").
 *
 * Usage: node scripts/experiments/report-ab/score.cjs [--out <dir>] [--runs runs-sonnet.jsonl] [--json <file>]
 */

const fs = require('node:fs');
const path = require('node:path');

const STRUCTURAL = new Set(['dependency_cycle', 'unknown_reference', 'wave_order', 'missing_dependency', 'status_inconsistency', 'file_conflict']);

const ACCEPT = Object.freeze({
  cycle: new Set(['dependency_cycle', 'wave_order']),
  missing: new Set(['unknown_reference', 'missing_dependency']),
  wave: new Set(['wave_order', 'missing_dependency']),
  status: new Set(['status_inconsistency']),
  undeclared: new Set(['missing_dependency', 'file_conflict', 'wave_order']),
  file_conflict: new Set(['file_conflict', 'missing_dependency', 'wave_order']),
});

const PLAN_ID = /\b\d{2}-\d{2}\b/g;

function namedPlans(finding) {
  const ids = new Set((Array.isArray(finding.plans) ? finding.plans : []).map(String));
  for (const m of String(finding.description || '').match(PLAN_ID) || []) ids.add(m);
  return ids;
}

function covers(defect, finding) {
  const plans = namedPlans(finding);
  if (defect.class === 'missing') return plans.has(defect.ghost);
  const hit = defect.plans.filter((id) => plans.has(id)).length;
  return defect.class === 'cycle' ? hit >= 2 : hit === defect.plans.length;
}

function scoreRun(run, defects, adjudication) {
  const found = new Map();
  const fps = [];
  let noise = 0;
  let companions = 0;
  let duplicates = 0;
  (run.findings || []).forEach((f, i) => {
    const key = `${run.fixture}/${run.variant}/${run.rep}#${i}`;
    const verdict = adjudication[key];
    if (verdict === 'fp') {
      fps.push({ key, finding: f, adjudicated: true });
      return;
    }
    if (verdict === 'neutral') {
      duplicates += 1;
      return;
    }
    if (verdict) {
      if (!found.has(verdict)) found.set(verdict, key);
      return;
    }
    const matches = (x) => ACCEPT[x.class].has(f.kind) && covers(x, f);
    const d = defects.find((x) => !found.has(x.key) && matches(x));
    if (d) found.set(d.key, key);
    else if (defects.some(matches)) duplicates += 1;
    else if (defects.some((x) => x.companion && ACCEPT[x.companion.class].has(f.kind) && covers(x.companion, f))) companions += 1;
    else if (STRUCTURAL.has(f.kind)) fps.push({ key, finding: f, adjudicated: false });
    else noise += 1;
  });
  return { found: new Set(found.keys()), fps, noise, companions: companions + duplicates };
}

// ─── Statistics ──────────────────────────────────────────────────────────────

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

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

/**
 * Cluster bootstrap over defects: resample defects with replacement; a defect's rate in a
 * variant is its detection share over that variant's reps. Defects are the unit because reps of
 * one defect are not independent. Paired: the same resample feeds every variant, so a difference
 * is computed on the same defects.
 */
function bootstrap(rates, variants, iters = 10000, seed = 7) {
  const rnd = mulberry32(seed);
  const keys = Object.keys(rates);
  const draws = Object.fromEntries(variants.map((v) => [v, []]));
  const diffs = {};
  for (const v of variants.slice(1)) diffs[`${v}-${variants[0]}`] = [];
  for (let it = 0; it < iters; it++) {
    const sample = Array.from({ length: keys.length }, () => keys[Math.floor(rnd() * keys.length)]);
    const mean = (v) => sample.reduce((s, k) => s + rates[k][v], 0) / sample.length;
    const m = Object.fromEntries(variants.map((v) => [v, mean(v)]));
    for (const v of variants) draws[v].push(m[v]);
    for (const v of variants.slice(1)) diffs[`${v}-${variants[0]}`].push(m[v] - m[variants[0]]);
  }
  const ci = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return [quantile(s, 0.025), quantile(s, 0.975)];
  };
  return {
    recall_ci: Object.fromEntries(variants.map((v) => [v, ci(draws[v])])),
    diff_ci: Object.fromEntries(Object.entries(diffs).map(([k, arr]) => [k, ci(arr)])),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function score(outDir, runsFile) {
  const truth = JSON.parse(fs.readFileSync(path.join(outDir, 'ground-truth.json'), 'utf8'));
  const adjPath = path.join(outDir, 'adjudication.json');
  const model = path.basename(runsFile).replace(/^runs-|\.jsonl$/g, '');
  const adjudication = (fs.existsSync(adjPath) ? JSON.parse(fs.readFileSync(adjPath, 'utf8')) : {})[model] || {};
  const runs = fs
    .readFileSync(path.join(outDir, runsFile), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  // The last ok record per key wins (a resumed batch never duplicates, but be safe).
  const byKey = new Map();
  for (const r of runs) if (r.ok) byKey.set(`${r.fixture}/${r.variant}/${r.rep}`, r);
  const failed = runs.filter((r) => !r.ok).length;
  const variants = [...new Set([...byKey.values()].map((r) => r.variant))].sort();

  const perVariant = Object.fromEntries(
    variants.map((v) => [v, { runs: 0, control_runs: 0, seeded: 0, found: 0, fp: 0, fp_control: 0, noise: 0, companions: 0, matched_findings: 0, cost: 0, out_tok: 0, dur: 0, byClass: {}, byCategory: {} }]),
  );
  const defectRates = {};
  const unmatched = [];

  for (const r of byKey.values()) {
    const fx = truth.fixtures[r.fixture];
    const pv = perVariant[r.variant];
    const s = scoreRun(r, fx.defects, adjudication);
    pv.runs += 1;
    if (fx.control) pv.control_runs += 1;
    pv.seeded += fx.defects.length;
    pv.found += s.found.size;
    pv.matched_findings += s.found.size;
    pv.fp += s.fps.length;
    if (fx.control) pv.fp_control += s.fps.length;
    pv.noise += s.noise;
    pv.companions += s.companions;
    pv.cost += r.cost_usd || 0;
    pv.out_tok += r.output_tokens || 0;
    pv.dur += r.duration_ms || 0;
    for (const d of fx.defects) {
      for (const [bucket, name] of [['byClass', d.class], ['byCategory', d.category]]) {
        pv[bucket][name] = pv[bucket][name] || { seeded: 0, found: 0 };
        pv[bucket][name].seeded += 1;
        if (s.found.has(d.key)) pv[bucket][name].found += 1;
      }
      defectRates[d.key] = defectRates[d.key] || { class: d.class, category: d.category };
      const cell = (defectRates[d.key][`_${r.variant}`] = defectRates[d.key][`_${r.variant}`] || { n: 0, hit: 0 });
      cell.n += 1;
      if (s.found.has(d.key)) cell.hit += 1;
    }
    for (const fp of s.fps) if (!fp.adjudicated) unmatched.push(fp);
  }

  const rates = {};
  for (const [k, d] of Object.entries(defectRates)) {
    rates[k] = Object.fromEntries(variants.map((v) => [v, d[`_${v}`] ? d[`_${v}`].hit / d[`_${v}`].n : 0]));
  }
  const boot = Object.keys(rates).length > 0 && variants.length > 1 ? bootstrap(rates, variants) : null;
  const byCategoryBoot = {};
  if (boot) {
    for (const cat of ['flagged', 'visible', 'text']) {
      const sub = Object.fromEntries(Object.entries(rates).filter(([k]) => defectRates[k].category === cat));
      if (Object.keys(sub).length > 0) byCategoryBoot[cat] = bootstrap(sub, variants);
    }
  }

  return { variants, failed, perVariant, rates, defectRates, boot, byCategoryBoot, unmatched };
}

/** Exact two-sided sign test over the non-tied defects. */
function signTest(up, down) {
  const n = up + down;
  if (n === 0) return 1;
  const k = Math.min(up, down);
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    let c = 1;
    for (let j = 0; j < i; j++) c = (c * (n - j)) / (j + 1);
    tail += c / 2 ** n;
  }
  return Math.min(1, 2 * tail);
}

/** Per defect, did variant v detect it more often, less often, or as often as the baseline? */
function signs(res, v, base, category) {
  let up = 0;
  let down = 0;
  let tie = 0;
  for (const [k, r] of Object.entries(res.rates)) {
    if (category && res.defectRates[k].category !== category) continue;
    if (r[v] > r[base]) up += 1;
    else if (r[v] < r[base]) down += 1;
    else tie += 1;
  }
  return { up, down, tie, p: signTest(up, down) };
}

const pct = (x) => `${(100 * x).toFixed(1)}%`;
const ciStr = (ci) => `[${pct(ci[0])}, ${pct(ci[1])}]`;

function print(res) {
  const lines = [];
  lines.push(`variants: ${res.variants.join(', ')}; failed runs: ${res.failed}`);
  lines.push('variant | runs | recall | 95% CI | precision | FP (all/control runs) | neutral (dup+companion) | noise | $/run | out tok/run | s/run');
  for (const v of res.variants) {
    const p = res.perVariant[v];
    const precision = p.matched_findings + p.fp === 0 ? 1 : p.matched_findings / (p.matched_findings + p.fp);
    lines.push(
      [v, p.runs, pct(p.found / p.seeded), res.boot ? ciStr(res.boot.recall_ci[v]) : '-', pct(precision), `${p.fp}/${p.fp_control}`, p.companions, p.noise,
        (p.cost / p.runs).toFixed(4), Math.round(p.out_tok / p.runs), (p.dur / p.runs / 1000).toFixed(1)].join(' | '),
    );
  }
  if (res.boot) for (const [k, ci] of Object.entries(res.boot.diff_ci)) lines.push(`diff ${k}: 95% CI ${ciStr(ci)}`);
  for (const cat of ['flagged', 'visible', 'text']) {
    const row = res.variants.map((v) => {
      const c = res.perVariant[v].byCategory[cat];
      return c ? `${v} ${c.found}/${c.seeded}` : `${v} -`;
    });
    const b = res.byCategoryBoot[cat];
    lines.push(`category ${cat}: ${row.join('  ')}${b ? '  ' + Object.entries(b.diff_ci).map(([k, ci]) => `${k} ${ciStr(ci)}`).join('  ') : ''}`);
  }
  const classes = Object.keys(ACCEPT);
  for (const cls of classes) {
    const row = res.variants.map((v) => {
      const c = res.perVariant[v].byClass[cls];
      return c ? `${v} ${c.found}/${c.seeded}` : `${v} -`;
    });
    lines.push(`class ${cls}: ${row.join('  ')}`);
  }
  const base = res.variants[0];
  for (const v of res.variants.slice(1)) {
    for (const cat of [null, 'flagged', 'visible', 'text']) {
      const s = signs(res, v, base, cat);
      lines.push(`per-defect ${v} vs ${base} (${cat || 'all'}): better ${s.up}, worse ${s.down}, same ${s.tie}; sign test p=${s.p.toFixed(3)}`);
    }
  }
  lines.push(`unadjudicated unmatched structural findings: ${res.unmatched.length}`);
  for (const u of res.unmatched) lines.push(`  ${u.key} ${u.finding.kind} [${u.finding.plans}] ${String(u.finding.description).slice(0, 160)}`);
  return lines.join('\n');
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : null;
  };
  const outDir = path.resolve(get('--out') || path.join(__dirname, 'out'));
  const res = score(outDir, get('--runs') || 'runs-sonnet.jsonl');
  process.stdout.write(print(res) + '\n');
  const jsonOut = get('--json');
  if (jsonOut) {
    const { unmatched, ...rest } = res;
    fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ ...rest, unmatched: unmatched.map((u) => u.key) }, null, 2) + '\n');
  }
}

module.exports = { score, scoreRun, ACCEPT };
