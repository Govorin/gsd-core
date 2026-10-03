#!/usr/bin/env node
/**
 * Orphan plans — планы, о судьбе которых не знает никто.
 *
 * ── Что именно теряется ─────────────────────────────────────────────────
 *
 * Состояние плана сегодня выводится из НАЛИЧИЯ SUMMARY.md рядом с ним. Это
 * работает ровно в двух случаях из четырёх:
 *
 *   SUMMARY есть  → план исполнен. Верно.
 *   SUMMARY нет   → план... не начинали? начали и бросили? исполнитель умер
 *                   на середине? план вытеснен и не нужен?
 *
 * Все четыре читаются одинаково — как «не начинали». Замер по 8 корням
 * `.planning/`: **445 планов из 1190 (37.4%) без SUMMARY**. Каждый из них
 * неотличим от работы, которая никогда не запускалась.
 *
 * Цена — не в бухгалтерии. Возобновляя фазу, нельзя ответить на вопрос «что
 * здесь уже сделано» иначе как перечитав её целиком; а автономный прогон,
 * встретив такой план, начнёт его заново поверх недоделанной работы.
 *
 * ── Почему статус в ПЛАНЕ, а не в STATE.md ──────────────────────────────
 *
 * У файла плана ровно один писатель — исполнитель этого плана. При таком
 * размещении гонка невозможна ПО ПОСТРОЕНИЮ, а не благодаря дисциплине
 * блокировок. STATE.md, напротив, пишут все, и каждый новый писатель — это
 * новый способ потерять чужую запись; в этом репозитории уже есть исправленные
 * дефекты ровно этого сорта (m8-writestatemd-scan-after-lock,
 * m9-statelock-write-error-orphan).
 *
 * ── Что уже существует, и чего не хватает ───────────────────────────────
 *
 * `status: superseded` в плане реализован (#2349, src/plan-scan.cts): такой
 * план исключается из набора и не тянет милстоун вниз.
 *
 * `status: halted` существует в SUMMARY (src/phase-locator.cts): спроектированная
 * остановка, и зависящие от неё планы получают `blocked_by`.
 *
 * Не хватает одного состояния — **`in_progress` в плане**. Оно закрывает
 * единственный случай, который не покрывают первые два: исполнитель начал и не
 * дошёл до SUMMARY. Именно этот случай сегодня читается как «не начинали», и
 * именно его нельзя восстановить постфактум — SUMMARY, которого нет, не
 * расскажет, что работа шла.
 *
 * ── Что считается сиротой ───────────────────────────────────────────────
 *
 *   in_progress + нет SUMMARY   → ОСИРОТЕЛ. Исполнитель не дожил до конца.
 *   нет status  + нет SUMMARY   → неизвестно. Сообщается отдельно, не блокирует:
 *                                 445 планов нельзя объявить сломанными задним
 *                                 числом, и гейт, валящий треть репозитория,
 *                                 выключат в первый же день.
 *   superseded                  → пропускается всегда.
 *   есть SUMMARY                → исполнен, независимо от статуса.
 *
 * Различие между двумя первыми — весь смысл скрипта. Первое утверждает, что
 * работа шла; второе — что о ней ничего не известно. Один требует вмешательства,
 * другой лишь фиксируется.
 *
 * ── Коды выхода ─────────────────────────────────────────────────────────
 *
 *   0 — сирот нет (планы без статуса при этом могут быть — они в отчёте)
 *   1 — есть план `in_progress` без SUMMARY
 *   2 — не смог посмотреть: нет каталога, нечитаемый файл
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const phaseDir = arg('--dir');
const verbose = args.includes('--verbose');
const strict = args.includes('--strict');

if (!phaseDir) {
  process.stderr.write('orphan-plans: --dir <phase-dir> is required\n');
  process.exit(2);
}
if (!existsSync(phaseDir)) {
  process.stderr.write(`orphan-plans: phase dir not found: ${phaseDir}\n`);
  process.exit(2);
}

/**
 * Прочитать `status:` из frontmatter, не разбирая весь файл.
 *
 * Построчно, а не регекспом по блоку: регексп, требующий `\n` после записи,
 * теряет последнюю строку frontmatter — её перевод строки съеден закрывающим
 * `---`. Этот дефект уже был пойман в wave-collision.mjs собственным тестом.
 */
function readStatus(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    process.stderr.write(`orphan-plans: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }

  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;

  for (const line of fm[1].split('\n')) {
    const m = line.match(/^status:\s*(.*)$/);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim().toLowerCase();
  }
  return null;
}

let entries;
try {
  entries = readdirSync(phaseDir, { withFileTypes: true });
} catch (e) {
  process.stderr.write(`orphan-plans: cannot list ${phaseDir}: ${e.message}\n`);
  process.exit(2);
}

const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
const summaries = fileNames.filter((n) => /SUMMARY\.md$/.test(n));

/** Есть ли SUMMARY, относящийся к этому плану? */
function hasSummary(planName) {
  const stem = planName.replace(/-?PLAN\.md$/, '');
  if (stem === '') return summaries.length > 0;
  return summaries.some((s) => s.startsWith(stem));
}

const orphaned = [];
const unknown = [];
let done = 0;
let superseded = 0;

for (const name of fileNames) {
  if (!/PLAN\.md$/.test(name)) continue;

  const status = readStatus(join(phaseDir, name));
  if (status === 'superseded') {
    superseded++;
    continue;
  }
  if (hasSummary(name)) {
    done++;
    continue;
  }
  if (status === 'in_progress') orphaned.push(name);
  else unknown.push({ name, status });
}

const total = orphaned.length + unknown.length + done + superseded;
if (total === 0) {
  if (verbose) process.stdout.write('orphan-plans: no plans here — nothing to check\n');
  process.exit(0);
}

if (orphaned.length === 0 && (!strict || unknown.length === 0)) {
  let line = `orphan-plans: OK — ${done} done, ${superseded} superseded, ${unknown.length} unknown-state`;
  process.stdout.write(`${line}\n`);
  if (verbose && unknown.length > 0) {
    process.stdout.write(
      'orphan-plans: unknown-state plans carry no status and no SUMMARY — they read as never-started:\n',
    );
    for (const u of unknown) process.stdout.write(`  ${u.name}\n`);
  }
  process.exit(0);
}

process.stderr.write('\norphan-plans: plans whose fate nothing records\n\n');

for (const name of orphaned) {
  process.stderr.write(`  ORPHANED  ${name}\n`);
  process.stderr.write('    declares status: in_progress, has no SUMMARY\n');
  process.stderr.write('    the executor started and never finished — its work is on disk, unrecorded\n\n');
}

if (strict) {
  for (const u of unknown) {
    process.stderr.write(`  UNKNOWN   ${u.name}\n`);
    process.stderr.write('    no status, no SUMMARY — indistinguishable from never started\n\n');
  }
}

process.stderr.write(
  `${orphaned.length} orphaned` +
    (strict ? `, ${unknown.length} unknown-state` : '') +
    `, ${done} done.\n` +
    'A plan that began and left no record is re-run from scratch on the next pass,\n' +
    'on top of whatever it already changed.\n' +
    'Write its SUMMARY, or set status: superseded if it was replaced.\n',
);
process.exit(1);
