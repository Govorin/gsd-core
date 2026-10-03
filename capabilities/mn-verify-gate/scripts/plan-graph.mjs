#!/usr/bin/env node
/**
 * Граф планов фазы — mermaid из `wave` и `depends_on`, а не из памяти модели.
 *
 * ── Зачем ────────────────────────────────────────────────────────────────
 *
 * Порядок выполнения фазы лежит во frontmatter планов: волна и список планов,
 * от которых план зависит. Читать его по файлам — значит держать в голове
 * граф, который машина построит за миллисекунды. Построенный моделью граф был
 * бы хуже: LLM рисуют несуществующие рёбра и узлы (arXiv 2508.00255,
 * 2601.20476), и корректный синтаксис этого не лечит — валидный mermaid с
 * выдуманной связью читается как факт. Поэтому здесь каждый узел — файл
 * `*-PLAN.md`, каждое ребро — запись в `depends_on`, и ничего сверх.
 *
 * ── Дефекты видны на самом графе ─────────────────────────────────────────
 *
 * Скрипт не судит, а показывает. Три вещи рисуются, а не прячутся:
 *   · зависимость от плана, которого нет в каталоге — пунктирное ребро к узлу
 *     «(нет такого плана)»;
 *   · волна плана не строго позже волны зависимости — красное ребро (правило
 *     то же, что проверяет `wave-collision`, но здесь оно видно глазами);
 *   · цикл по `depends_on` — красные рёбра цикла.
 * Решает про них гейт, а не этот скрипт: код выхода 0, пока не задан `--strict`.
 *
 * ── Что означает цвет узла ───────────────────────────────────────────────
 *
 * Только то, что записано на диске: есть `NN-MM-SUMMARY.md` — выполнен;
 * `status: in_progress` — идёт; `status: superseded` — заменён; иначе —
 * «не выполнен» (нет ни SUMMARY, ни статуса). «Не выполнен» не равно «не
 * начат»: четыре разных состояния читаются одинаково (см. `orphan-plans`), и
 * граф не делает вид, что различает их.
 *
 * Использование:
 *   node plan-graph.mjs --dir <phase-dir>              # markdown в stdout
 *   node plan-graph.mjs --dir <phase-dir> --out <file> # записать в файл
 *   node plan-graph.mjs --dir <phase-dir> --strict     # код 1 при дефектах
 *
 * Коды выхода: 0 — граф построен; 1 — построен, но есть дефекты и задан
 * `--strict`; 2 — не смог прочитать (нет каталога, нет ни одного плана).
 */

import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const dir = arg('dir');
const out = arg('out');
const strict = has('strict');

if (!dir) {
  console.error('usage: --dir <phase-dir> [--out <file>] [--strict]');
  process.exit(2);
}
const phaseDir = resolve(dir);
if (!existsSync(phaseDir)) {
  console.error(`FAIL: cannot look — phase directory not found: ${phaseDir}`);
  process.exit(2);
}

// ── разбор плана ────────────────────────────────────────────────────────────

/** Идентификатор плана — префикс имени файла: `01-02-PLAN.md` → `01-02`. */
const PLAN_FILE = /^(\d+(?:\.\d+)?-\d+)-?.*PLAN\.md$/;

function stripQuotes(s) {
  return s.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * `depends_on` бывает тремя способами: `[]`, `["01-01", "01-02"]` в строку и
 * блоком `- 01-01`. Все три — легальный YAML, и во всех трёх нужен тот же
 * ответ. Пустые строки внутри блока список не закрывают (как в wave-collision).
 */
function parseDependsOn(front) {
  const lines = front.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^depends_on:\s*(.*)$/);
    if (!m) continue;
    const rest = m[1].trim();
    if (rest.startsWith('[')) {
      const inner = rest.replace(/^\[/, '').replace(/\]\s*(#.*)?$/, '');
      return inner.split(',').map(stripQuotes).filter(Boolean);
    }
    if (rest !== '' && !rest.startsWith('#')) return [stripQuotes(rest)];
    const items = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue;
      const item = lines[j].match(/^[ \t]+-[ \t]*(.*)$/);
      if (item === null) break;
      items.push(stripQuotes(item[1].replace(/\s+#.*$/, '')));
    }
    return items.filter(Boolean);
  }
  return [];
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`FAIL: cannot look — cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
}

let entries;
try {
  entries = readdirSync(phaseDir, { withFileTypes: true });
} catch (e) {
  console.error(`FAIL: cannot look — cannot list ${phaseDir}: ${e.message}`);
  process.exit(2);
}

const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
const plans = [];
for (const e of entries) {
  if (!e.isFile()) continue;
  const idm = e.name.match(PLAN_FILE);
  if (!idm) continue;
  const text = readText(join(phaseDir, e.name));
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const front = fm ? fm[1] : '';
  const waveM = front.match(/^wave:\s*(\d+)\s*$/m);
  const statusM = front.match(/^status:\s*["']?([\w-]+)["']?\s*(?:#.*)?$/m);
  const id = idm[1];
  plans.push({
    id,
    file: e.name,
    wave: waveM ? Number(waveM[1]) : null,
    status: statusM ? statusM[1] : null,
    dependsOn: parseDependsOn(front),
    done: [...names].some((n) => n.startsWith(`${id}-`) && /SUMMARY\.md$/.test(n)),
  });
}

if (plans.length === 0) {
  console.error(`FAIL: cannot look — no *-PLAN.md files in ${phaseDir}`);
  process.exit(2);
}

plans.sort((a, b) => (a.wave ?? Infinity) - (b.wave ?? Infinity) || a.id.localeCompare(b.id, 'en', { numeric: true }));
const byId = new Map(plans.map((p) => [p.id, p]));

// ── рёбра и дефекты ─────────────────────────────────────────────────────────

const edges = []; // { from, to, defect: null | 'missing' | 'wave' | 'cycle' }
const missing = new Set();
for (const p of plans) {
  for (const dep of p.dependsOn) {
    const target = byId.get(dep);
    let defect = null;
    if (!target) {
      defect = 'missing';
      missing.add(dep);
    } else if (p.wave !== null && target.wave !== null && p.wave <= target.wave) {
      defect = 'wave';
    }
    edges.push({ from: dep, to: p.id, defect });
  }
}

// Цикл: ребро dep→id лежит на цикле, если из id можно дойти до dep.
const adj = new Map(plans.map((p) => [p.id, []]));
for (const e of edges) if (byId.has(e.from) && byId.has(e.to)) adj.get(e.from).push(e.to);
function reaches(start, goal) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === goal) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of adj.get(cur) ?? []) stack.push(nxt);
  }
  return false;
}
for (const e of edges) {
  if (byId.has(e.from) && byId.has(e.to) && reaches(e.to, e.from)) e.defect = e.defect ?? 'cycle';
}

const defects = edges.filter((e) => e.defect);

// ── mermaid ─────────────────────────────────────────────────────────────────

/** Идентификатор узла: mermaid не любит точки и дефисы в id, а метку не трогаем. */
const nodeId = (id) => `p_${id.replace(/[^A-Za-z0-9]/g, '_')}`;
const label = (s) => String(s).replace(/"/g, '#quot;');

function stateOf(p) {
  if (p.done) return 'done';
  if (p.status === 'in_progress') return 'running';
  if (p.status === 'superseded') return 'superseded';
  return 'pending';
}
const GLYPH = { done: '✓', running: '▶', superseded: '⊘', pending: '○' };

const lines = ['flowchart LR'];
const waves = [...new Set(plans.map((p) => p.wave))].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
for (const w of waves) {
  const title = w === null ? 'wave не задана' : `wave ${w}`;
  lines.push(`  subgraph W${w === null ? 'x' : w}["${title}"]`);
  for (const p of plans.filter((q) => q.wave === w)) {
    const st = stateOf(p);
    lines.push(`    ${nodeId(p.id)}["${label(`${GLYPH[st]} ${p.id}`)}"]:::${st}`);
  }
  lines.push('  end');
}
for (const m of [...missing].sort()) {
  lines.push(`  ${nodeId(m)}["${label(`${m} — нет такого плана`)}"]:::missing`);
}
const linkStyles = [];
edges.forEach((e, i) => {
  const arrow = e.defect === 'missing' ? '-.->' : '-->';
  lines.push(`  ${nodeId(e.from)} ${arrow} ${nodeId(e.to)}`);
  if (e.defect) linkStyles.push(`  linkStyle ${i} stroke:#d33,stroke-width:2px`);
});
lines.push(...linkStyles);
lines.push('  classDef done fill:#e6f4ea,stroke:#2e7d32');
lines.push('  classDef running fill:#fff4e5,stroke:#ef6c00');
lines.push('  classDef superseded fill:#eee,stroke:#999,stroke-dasharray:4 3,color:#777');
lines.push('  classDef pending fill:#fff,stroke:#555');
lines.push('  classDef missing fill:#fdecea,stroke:#d33,stroke-dasharray:4 3');

const doc = [
  '<!-- gsd:derived source=plan-graph — regenerated, do not hand-edit -->',
  '',
  '```mermaid',
  ...lines,
  '```',
  '',
];

if (defects.length > 0) {
  doc.push('Дефекты графа:');
  for (const e of defects) {
    const why =
      e.defect === 'missing'
        ? `${e.to} зависит от ${e.from}, такого плана в каталоге нет`
        : e.defect === 'wave'
          ? `${e.to} (wave ${byId.get(e.to).wave}) зависит от ${e.from} (wave ${byId.get(e.from).wave}) — волна должна быть строго позже`
          : `${e.from} → ${e.to} лежит на цикле`;
    doc.push(`- ${why}`);
  }
  doc.push('');
}

const text = doc.join('\n');
if (out) {
  try {
    writeFileSync(resolve(out), text);
  } catch (e) {
    console.error(`FAIL: cannot write ${out}: ${e.message}`);
    process.exit(2);
  }
  console.log(`OK: ${plans.length} plan(s), ${edges.length} edge(s), ${defects.length} defect(s) → ${out}`);
} else {
  process.stdout.write(text);
}
if (defects.length > 0) console.error(`plan-graph: ${defects.length} defect(s) drawn in red`);
process.exit(strict && defects.length > 0 ? 1 : 0);
