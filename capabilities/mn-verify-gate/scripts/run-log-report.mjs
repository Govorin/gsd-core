#!/usr/bin/env node
/**
 * RUN-LOG reporter — восьмичасовой автономный прогон за пять секунд чтения.
 *
 * ── Задача ──────────────────────────────────────────────────────────────
 *
 * Пользователь запускает /gsd-autonomous и уходит спать. Восемь часов работы
 * уходят в stdout терминала, которого никто не видит: к утру буфер прокручен,
 * агенты завершены, а вопрос простой — «что произошло и где оно свернуло не
 * туда». STATE.md отвечает на «где мы сейчас», git log — на «что изменилось»,
 * и ни один не отвечает на «как мы сюда пришли и сколько это стоило».
 *
 * ── Формат: JSONL ───────────────────────────────────────────────────────
 *
 * Одна строка — одно событие. Выбор продиктован единственным требованием:
 * журнал обязан пережить смерть писателя. Автономный прогон падает,
 * прерывается по Ctrl-C, упирается в лимит контекста — и во всех этих случаях
 * JSON-массив остаётся с незакрытой скобкой, то есть непарсимым целиком.
 * JSONL деградирует построчно: битой оказывается только последняя строка,
 * всё предыдущее читается. Append одной строкой атомарен в пределах
 * O_APPEND для записей меньше PIPE_BUF, что для событийной строки выполняется.
 *
 * Путь: `.planning/RUN-LOG.jsonl` (рядом со STATE.md, в репозитории).
 *
 * Поля — минимальный набор, отвечающий на утренние вопросы:
 *
 *   ts       ISO-8601 UTC        когда
 *   run      идентификатор прогона (ISO старта) — разделяет ночи в одном файле
 *   phase    номер фазы          что
 *   event    тип события         см. словарь ниже
 *   status   ok|fail|skip|block  чем кончилось
 *   detail   строка              человекочитаемая суть (имя гейта, причина блока)
 *   data     объект              необязательные метрики (files, lines, plans)
 *
 * Словарь `event` намеренно узкий — журнал не должен превратиться в trace:
 *   run_start / run_end          границы прогона
 *   phase_start / phase_end      границы фазы
 *   discuss / plan / execute     стадии пайплайна
 *   verify                       результат верификации
 *   gate                         срабатывание гейта (detail = имя)
 *   blocker                      handle_blocker
 *   deferred                     фаза отложена/пропущена
 *
 * ── Кто пишет: ОРКЕСТРАТОР, и только он ─────────────────────────────────
 *
 * Executor работает в git-worktree, который удаляется по завершении фазы —
 * файл, записанный оттуда, исчезает вместе с деревом. Кроме того, воркеры
 * параллельной волны писали бы конкурентно. Поэтому пишет главный контекст
 * autonomous.md, в точках, которые в нём РЕАЛЬНО существуют (проверено по
 * ~/.claude/gsd-core/workflows/autonomous.md, 934 строки):
 *
 *   §1 Initialize            → run_start
 *   §3 Execute Phase (баннер)→ phase_start
 *   §3a Smart Discuss        → discuss (ok|skip)
 *   §3b/3c plan+execute      → plan, execute
 *   §3d Post-Execution       → verify + gate (здесь уже читаются ship:pre и
 *                              verify:pre — тот самый чинёный участок)
 *   §4 Iterate               → phase_end
 *   §5 Lifecycle             → run_end
 *   §6 Handle Blocker        → blocker
 *
 * Инструкция для autonomous.md — одна строка на точку:
 *   gsd_log() { printf '%s\n' "$1" >> .planning/RUN-LOG.jsonl; }
 *
 * ── Чтение ──────────────────────────────────────────────────────────────
 *
 *   node run-log-report.mjs                      # последний прогон
 *   node run-log-report.mjs --all                # все прогоны в файле
 *   node run-log-report.mjs --mermaid            # gantt для вставки в отчёт
 *   node run-log-report.mjs --log <path>
 *
 * exit 0 — прогон без блокировок; exit 1 — были blocker/gate-block/fail;
 * exit 2 — журнала нет или он нечитаем.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

let repoRoot = process.cwd();
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim() || repoRoot;
} catch {
  /* не git — читаем от cwd */
}

const logPath = resolve(repoRoot, arg('log', '.planning/RUN-LOG.jsonl'));

if (!existsSync(logPath)) {
  console.error(`FAIL: no run log at ${logPath}`);
  console.error('An autonomous run that logged nothing cannot be reviewed after the fact.');
  process.exit(2);
}

// Битая последняя строка — ожидаемое состояние при обрыве прогона, а не
// повод отказать в отчёте: ради этого свойства и выбран JSONL.
const events = [];
let malformed = 0;
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    events.push(JSON.parse(line));
  } catch {
    malformed += 1;
  }
}

if (events.length === 0) {
  console.error(`FAIL: ${logPath} holds no parsable events.`);
  process.exit(2);
}

const runs = [...new Set(events.map((e) => e.run || 'unknown'))];
const selected = has('all') ? runs : runs.slice(-1);
const rows = events.filter((e) => selected.includes(e.run || 'unknown'));

const ms = (a, b) => new Date(b).getTime() - new Date(a).getTime();
const dur = (m) => {
  if (!Number.isFinite(m) || m < 0) return '—';
  const s = Math.round(m / 1000);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const min = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h${String(min).padStart(2, '0')}m` : `${min}m`;
};

// ── Свод по фазам ───────────────────────────────────────────────────────
const phases = new Map();
for (const e of rows) {
  if (e.phase === undefined || e.phase === null) continue;
  const k = String(e.phase);
  if (!phases.has(k)) {
    phases.set(k, { phase: k, start: null, end: null, name: '', stages: [], problems: [] });
  }
  const p = phases.get(k);
  if (e.event === 'phase_start') {
    p.start = e.ts;
    p.name = e.detail || p.name;
  }
  if (e.event === 'phase_end') p.end = e.ts;
  if (['discuss', 'plan', 'execute', 'verify', 'gate'].includes(e.event)) {
    p.stages.push(e);
  }
  if (e.status === 'fail' || e.status === 'block' || e.event === 'blocker') {
    p.problems.push(e);
  }
}

const runStart = rows.find((e) => e.event === 'run_start');
const runEnd = [...rows].reverse().find((e) => e.event === 'run_end');
const lastTs = rows[rows.length - 1]?.ts;

// ── Mermaid gantt ───────────────────────────────────────────────────────
if (has('mermaid')) {
  console.log('```mermaid');
  console.log('gantt');
  console.log('    title Autonomous run timeline');
  console.log('    dateFormat YYYY-MM-DDTHH:mm:ss');
  console.log('    axisFormat %H:%M');
  console.log('    section Phases');
  // `dateFormat YYYY-MM-DDTHH:mm:ss` не описывает ни дробные секунды, ни
  // суффикс `Z` — оставить их значит отдать mermaid строку, которую он не
  // разберёт, и получить пустую диаграмму вместо ошибки. Срезаем оба.
  const stamp = (t) => t.replace(/\.\d+/, '').replace(/Z$/, '');
  for (const p of phases.values()) {
    if (!p.start) continue;
    const end = p.end || lastTs;
    // `crit` красит фазу, где что-то заблокировало, — на диаграмме сразу
    // видно, куда смотреть, без чтения строк.
    const tag = p.problems.length ? 'crit, ' : '';
    // Двоеточие и `#` — служебные в gantt-строке; в имени фазы они встречаются.
    const label = `Phase ${p.phase}${p.name ? ` ${p.name}` : ''}`.replace(/[:#]/g, ' ');
    // Нулевая длительность (фаза стартовала и оборвалась) рисуется как
    // невидимая полоса — даём ей минуту, иначе обрыв пропадает с диаграммы.
    const to = stamp(end) === stamp(p.start) ? `${stamp(p.start)}, 1m` : `${stamp(p.start)}, ${stamp(end)}`;
    console.log(`    ${label} :${tag}${to}`);
  }
  console.log('```');
  process.exit(phases.size && [...phases.values()].some((p) => p.problems.length) ? 1 : 0);
}

// ── Текстовый таймлайн ──────────────────────────────────────────────────
const total = runStart ? ms(runStart.ts, runEnd?.ts || lastTs) : NaN;

console.log('━'.repeat(64));
console.log(` AUTONOMOUS RUN LOG — ${selected.length} run(s), ${rows.length} event(s)`);
if (runStart) console.log(` started ${runStart.ts}   elapsed ${dur(total)}`);
if (!runEnd) console.log(' ⚠ no run_end event — the run did not finish cleanly');
if (malformed) console.log(` ⚠ ${malformed} malformed line(s) (expected if the run was killed mid-write)`);
console.log('━'.repeat(64));

const icon = (s) => ({ ok: '✅', fail: '❌', block: '⛔', skip: '⏭' })[s] || '·';

for (const p of [...phases.values()].sort((a, b) => a.phase.localeCompare(b.phase, undefined, { numeric: true }))) {
  const span = p.start ? dur(ms(p.start, p.end || lastTs)) : '—';
  const flag = p.problems.length ? '⛔' : p.end ? '✅' : '⏳';
  console.log(`\n${flag} Phase ${p.phase}${p.name ? ` — ${p.name}` : ''}   [${span}]${p.end ? '' : '  (never completed)'}`);
  for (const s of p.stages) {
    const t = s.ts?.slice(11, 19) || '--:--:--';
    const d = s.detail ? ` — ${s.detail}` : '';
    const extra = s.data ? ` ${JSON.stringify(s.data)}` : '';
    console.log(`   ${t} ${icon(s.status)} ${s.event}${d}${extra}`);
  }
  for (const pr of p.problems) {
    if (p.stages.includes(pr)) continue;
    console.log(`   ${pr.ts?.slice(11, 19)} ⛔ ${pr.event} — ${pr.detail || 'no detail'}`);
  }
}

// Блокеры без номера фазы (сбой инициализации, срыв lifecycle) иначе выпали бы.
const orphan = rows.filter((e) => (e.phase === undefined || e.phase === null) && (e.status === 'fail' || e.event === 'blocker'));
if (orphan.length) {
  console.log('\n⛔ Run-level problems:');
  for (const o of orphan) console.log(`   ${o.ts?.slice(11, 19)} ${o.event} — ${o.detail || ''}`);
}

const blocked = [...phases.values()].filter((p) => p.problems.length);
// «Не завершена» считается только среди фаз БЕЗ проблем: фаза, которую
// заблокировал гейт, закономерно не имеет phase_end, и учитывать её дважды
// значит выдать «0 clean · 1 problem · 2 unfinished» на трёх фазах, где одна
// прошла чисто. Сводка, не сходящаяся с телом отчёта, обесценивает обе.
const incomplete = [...phases.values()].filter((p) => p.start && !p.end && !p.problems.length);
const clean = phases.size - blocked.length - incomplete.length;

console.log(`\n${'━'.repeat(64)}`);
console.log(
  ` ${phases.size} phase(s) · ${clean} clean · ` +
    `${blocked.length} with problems · ${incomplete.length} never finished`,
);
if (blocked.length) console.log(` Start here: Phase ${blocked.map((p) => p.phase).join(', Phase ')}`);
console.log('━'.repeat(64));

process.exit(blocked.length || incomplete.length || orphan.length || !runEnd ? 1 : 0);
