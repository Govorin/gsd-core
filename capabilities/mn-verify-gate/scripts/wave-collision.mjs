#!/usr/bin/env node
/**
 * Wave collision — два плана одной волны, пишущие в один файл.
 *
 * ── Единственное правило параллельности, и его никто не проверял ─────────
 *
 * Планы одной волны исполняются ОДНОВРЕМЕННО, каждый в своём worktree, и
 * коммитят по очереди. Если два таких плана заявили один и тот же файл, второй
 * коммит либо затрёт правку первого, либо упрётся в конфликт слияния — в
 * зависимости от того, как разошлись строки. Отсюда инвариант: планам одной
 * волны запрещено пересекаться по `files_modified`.
 *
 * Правило существует. Оно записано псевдокодом внутри промпта планировщика
 * (`agents/gsd-planner.md`), исполняет его LLM, и до сих пор **результат не
 * проверяло ничто**.
 *
 * ── Почему это не гипотеза ───────────────────────────────────────────────
 *
 * Замер по 13 корням `.planning/`, 1412 планов, 283 фазы с волнами:
 *
 *   38 фаз (13.4%) нарушают инвариант, 107 пересекающихся пар планов.
 *
 * Число устойчиво. При повторном замере качество данных выросло вдвое-втрое
 * (записей-не-файлов 10% → 4%, планов без `files_modified` 14% → 5%), а доля
 * нарушений не сдвинулась: 13.3% → 13.4%. Это исключает объяснение «дело в
 * грязных данных» и оставляет ровно одно: правило формулируется в промпте, и
 * никто не сверяет то, что получилось, с тем, что требовалось.
 *
 * ── Почему детектор, а не решатель ───────────────────────────────────────
 *
 * Полное решение — вычислять назначение волн из `depends_on` и
 * `files_modified` детерминированно, вместо того чтобы поручать это LLM.
 * Это правильная цель, и она дороже: планировщик должен принимать результат
 * решателя, а существующие 1412 планов пришлось бы конвертировать.
 *
 * Детектор даёт основную часть ценности немедленно и ничего не конвертирует.
 * Он ловит тот же класс отказа в тот момент, когда его ещё дёшево исправить —
 * до исполнения, когда нужно лишь переставить номер волны, а не разбирать
 * затёртый коммит. Решатель остаётся отдельной вехой; этот скрипт — её
 * измерительная часть, и он же страховка, если решатель однажды ошибётся.
 *
 * ── Что считается пересечением ───────────────────────────────────────────
 *
 * Пути нормализуются (`./x` → `x`, конечный слэш снимается) и сравниваются
 * буквально. Глоб НЕ раскрывается: `libs/**` и `libs/a/b.ts` не считаются
 * пересечением, потому что раскрытие требует обхода дерева и даёт ложные
 * срабатывания на путях, которых ещё нет — их создаст сам план. Это
 * сознательный предел: детектор ловит точные совпадения, которых достаточно,
 * чтобы поймать 107 измеренных пар.
 *
 * Записи, не являющиеся файлами (каталоги, глобы), пропускаются с пометкой в
 * отчёте при `--verbose` — их доля 4%, и они не должны ни блокировать, ни
 * молча исчезать.
 *
 * ── Коды выхода ──────────────────────────────────────────────────────────
 *
 *   0 — пересечений нет (в том числе когда сравнивать нечего)
 *   1 — найдено пересечение внутри волны
 *   2 — не смог посмотреть: нет каталога, нечитаемый файл
 *
 * Различие 1 и 2 обязательно: «ничего не нашёл» и «не смог искать» — разные
 * ответы, и второй не должен читаться как успех.
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

if (!phaseDir) {
  process.stderr.write('wave-collision: --dir <phase-dir> is required\n');
  process.exit(2);
}
if (!existsSync(phaseDir)) {
  process.stderr.write(`wave-collision: phase dir not found: ${phaseDir}\n`);
  process.exit(2);
}

/** Нормализовать путь до сравнимой формы, не трогая его смысл. */
function normalizePath(p) {
  return String(p)
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** Похоже ли на конкретный файл? Каталоги и глобы сравнивать нельзя. */
function isConcreteFile(p) {
  if (p.includes('*') || p.includes('?')) return false;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base.includes('.');
}

/**
 * Разобрать frontmatter плана.
 *
 * Возвращает null, если это не план с волной — такие файлы просто не участвуют.
 */
function parsePlan(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    process.stderr.write(`wave-collision: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }

  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;

  const waveMatch = fm[1].match(/^wave:\s*(\d+)\s*$/m);
  if (!waveMatch) return null;

  // Построчный разбор, не регексп по блоку. Регексп, требующий `\n` после
  // каждой записи, теряет ПОСЛЕДНЮЮ строку frontmatter — её перевод строки
  // съеден закрывающим `---`. Дефект тихий ровно в том же смысле, что и всё
  // остальное здесь: список выглядит прочитанным, а он пуст, и гейт рапортует
  // «пересечений нет» на файле, где они есть. Пойман собственным тестом.
  const raw = [];
  let inList = false;
  for (const line of fm[1].split('\n')) {
    if (/^files_modified:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    // Пустая строка внутри блока его НЕ закрывает: это легальный YAML, и в
    // одном живом проекте так оформлены 17 планов из 96. Трактовка «конец
    // списка» превращала такой план в «ничего не заявлено».
    if (line.trim() === '') continue;
    const item = line.match(/^[ \t]+-[ \t]*(.*)$/);
    if (item === null) break; // список кончился — следующий ключ frontmatter
    raw.push(item[1].replace(/^["']|["']$/g, '').trim());
  }

  const files = [];
  const skipped = [];
  for (const entry of raw) {
    const p = normalizePath(entry);
    if (p === '') continue;
    if (isConcreteFile(p)) files.push(p);
    else skipped.push(p);
  }

  return { wave: Number(waveMatch[1]), files, skipped };
}

// ── сбор планов фазы ────────────────────────────────────────────────────────

let entries;
try {
  entries = readdirSync(phaseDir, { withFileTypes: true });
} catch (e) {
  process.stderr.write(`wave-collision: cannot list ${phaseDir}: ${e.message}\n`);
  process.exit(2);
}

const byWave = new Map();
let skippedTotal = 0;

for (const e of entries) {
  if (!e.isFile() || !/PLAN\.md$/.test(e.name)) continue;
  const plan = parsePlan(join(phaseDir, e.name));
  if (plan === null) continue;

  skippedTotal += plan.skipped.length;
  if (!byWave.has(plan.wave)) byWave.set(plan.wave, []);
  byWave.get(plan.wave).push({ name: e.name, files: plan.files });
}

if (byWave.size === 0) {
  if (verbose) process.stdout.write('wave-collision: no wave-tagged plans — nothing to check\n');
  process.exit(0);
}

// ── поиск пересечений внутри каждой волны ───────────────────────────────────

const collisions = [];
let pairsChecked = 0;

for (const [wave, plans] of [...byWave.entries()].sort((a, b) => a[0] - b[0])) {
  for (let i = 0; i < plans.length; i++) {
    for (let j = i + 1; j < plans.length; j++) {
      pairsChecked++;
      const left = new Set(plans[i].files);
      const shared = plans[j].files.filter((f) => left.has(f));
      if (shared.length > 0) {
        collisions.push({ wave, a: plans[i].name, b: plans[j].name, shared });
      }
    }
  }
}

if (collisions.length === 0) {
  const plans = [...byWave.values()].reduce((n, l) => n + l.length, 0);
  process.stdout.write(
    `wave-collision: OK — ${plans} plan(s) across ${byWave.size} wave(s), ${pairsChecked} pair(s) checked, no shared files\n`,
  );
  if (verbose && skippedTotal > 0) {
    process.stdout.write(
      `wave-collision: ${skippedTotal} non-file entr(ies) (directories or globs) were not compared\n`,
    );
  }
  process.exit(0);
}

process.stderr.write('\nwave-collision: plans in the same wave declare the same file\n\n');

for (const c of collisions) {
  process.stderr.write(`  WAVE ${c.wave}  ${c.a}  ⨯  ${c.b}\n`);
  for (const f of c.shared.slice(0, 8)) process.stderr.write(`    ${f}\n`);
  if (c.shared.length > 8) process.stderr.write(`    … and ${c.shared.length - 8} more\n`);
  process.stderr.write('\n');
}

process.stderr.write(
  `${collisions.length} colliding pair(s).\n` +
    'Same-wave plans run at once in separate worktrees and commit in sequence, so the\n' +
    'second commit either overwrites the first or lands in a merge conflict.\n' +
    'Move one plan to a later wave, or split the shared file out of one of them.\n',
);
process.exit(1);
