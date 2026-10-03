#!/usr/bin/env node
/**
 * Wave solver — вычисляет назначение волн вместо того, чтобы поручать его LLM.
 *
 * ── Почему это не оптимизация ────────────────────────────────────────────
 *
 * Правило параллельности одно: планам одной волны запрещено пересекаться по
 * `files_modified`, и волна плана должна быть строго позже волны каждого его
 * `depends_on`. Правило записано псевдокодом внутри промпта планировщика,
 * исполняет его LLM, и до `wave-collision` результат не проверяло ничто.
 *
 * Замер: **38 фаз из 283 (13.4%) нарушают инвариант**, 107 пересекающихся пар.
 * Величина устойчива — при удвоении качества данных (не-файлы 10%→4%, планов
 * без файлов 14%→5%) доля нарушений не сдвинулась: 13.3% → 13.4%. Это
 * исключает объяснение «дело в данных» и оставляет ровно одно: правило
 * формулируется словами, а не вычисляется.
 *
 * Детектор (`wave-collision.mjs`) ловит нарушение постфактум. Этот скрипт
 * отвечает на другой вопрос — **каким назначение должно было быть**.
 *
 * ── Алгоритм и почему именно он ─────────────────────────────────────────
 *
 * Жадное послойное назначение, детерминированное по построению:
 *
 *   1. Волна плана ≥ (максимальная волна его зависимостей) + 1.
 *   2. Внутри волны план сдвигается дальше, пока пересекается по файлам с уже
 *      размещённым в ней.
 *   3. Порядок обхода — лексикографический по id. Не «как удобнее», а чтобы
 *      **один и тот же вход давал один и тот же выход**: решатель, зависящий
 *      от порядка чтения каталога, невоспроизводим, а невоспроизводимый ответ
 *      нельзя сверить с существующим назначением.
 *
 * Жадный, а не оптимальный. Минимизация числа волн — задача раскраски графа,
 * NP-трудная, и её точное решение здесь не окупается: разница между жадным и
 * оптимальным — одна-две лишние волны, а цена ошибки в инварианте — гонка в
 * worktree. Правильность важнее плотности.
 *
 * ── Чего решатель НЕ делает ─────────────────────────────────────────────
 *
 * Не переписывает планы. Он сравнивает и сообщает; правку делает человек или
 * планировщик, получивший результат. Скрипт, молча меняющий `wave:` в 73
 * файлах, — это ровно та автоматика, которая однажды перепишет то, чего не
 * поняла.
 *
 * Не раскрывает глобы. `libs/**` и `libs/a/b.ts` не считаются пересечением:
 * раскрытие требует обхода дерева и срабатывает на путях, которые план только
 * создаст. Такие записи пропускаются и **сообщаются** при `--verbose`.
 *
 * Не судит о циклах. Цикл в `depends_on` — дефект данных, а не задача
 * решателя: он сообщается и прерывает работу кодом 2, потому что назначение
 * волн для циклического графа не существует, а выдуманное хуже отсутствующего.
 *
 * ── Коды выхода ─────────────────────────────────────────────────────────
 *
 *   0 — вычисленное назначение совпало с объявленным (или сравнивать нечего)
 *   1 — расхождение: объявленные волны отличаются от вычисленных
 *   2 — не смог посмотреть: нет каталога, цикл в зависимостях, нечитаемый файл
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
const asJson = args.includes('--json');

if (!phaseDir) {
  process.stderr.write('wave-solve: --dir <phase-dir> is required\n');
  process.exit(2);
}
if (!existsSync(phaseDir)) {
  process.stderr.write(`wave-solve: phase dir not found: ${phaseDir}\n`);
  process.exit(2);
}

function normalizePath(p) {
  return String(p).trim().replace(/^\.\//, '').replace(/\/+$/, '');
}

/** Конкретный файл? Каталоги и глобы сравнивать нельзя — см. заголовок. */
function isConcreteFile(p) {
  if (p.includes('*') || p.includes('?')) return false;
  const base = p.slice(p.lastIndexOf('/') + 1);
  return base.includes('.');
}

/**
 * Разбор frontmatter — построчный, не регекспом по блоку.
 *
 * Регексп, требующий `\n` после каждой записи списка, теряет ПОСЛЕДНЮЮ строку
 * frontmatter: её перевод строки съеден закрывающим `---`. Этот дефект уже был
 * пойман собственным тестом в `wave-collision.mjs`.
 */
function parsePlan(file, name) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    process.stderr.write(`wave-solve: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }

  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm === null) return null;

  const body = fm[1];
  const waveMatch = body.match(/^wave:\s*(\d+)\s*$/m);

  const files = [];
  const skipped = [];
  let inFiles = false;
  for (const line of body.split('\n')) {
    if (/^files_modified:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    // Пустая строка внутри блока его НЕ закрывает: это легальный YAML, и в
    // одном живом проекте так оформлены 17 планов из 96. Трактовка «конец
    // списка» превращала такой план в «ничего не заявлено».
    if (line.trim() === '') continue;
    const item = line.match(/^[ \t]+-[ \t]*(.*)$/);
    if (item === null) break;
    const p = normalizePath(item[1].replace(/^["']|["']$/g, ''));
    if (p === '') continue;
    if (isConcreteFile(p)) files.push(p);
    else skipped.push(p);
  }

  // depends_on — и inline `["a","b"]`, и блочный список.
  const deps = [];
  const inline = body.match(/^depends_on:\s*\[(.*)\]\s*$/m);
  if (inline !== null) {
    for (const raw of inline[1].split(',')) {
      const d = raw.replace(/^["'\s]+|["'\s]+$/g, '');
      if (d !== '') deps.push(d);
    }
  } else {
    let inDeps = false;
    for (const line of body.split('\n')) {
      if (/^depends_on:\s*$/.test(line)) {
        inDeps = true;
        continue;
      }
      if (!inDeps) continue;
      const item = line.match(/^[ \t]+-[ \t]*(.*)$/);
      if (item === null) break;
      const d = item[1].replace(/^["']|["']$/g, '').trim();
      if (d !== '') deps.push(d);
    }
  }

  return {
    name,
    id: planIdOf(name),
    declaredWave: waveMatch ? Number(waveMatch[1]) : null,
    deps,
    files,
    skipped,
  };
}

/** `03-08-PLAN.md` → `03-08`; используется для сопоставления с depends_on. */
function planIdOf(name) {
  const m = name.match(/^(.*?)-?PLAN\.md$/);
  return m ? m[1] : name;
}

/** Ссылка из depends_on может быть как полным id, так и его хвостом. */
function resolveDep(dep, plans) {
  const d = String(dep).trim();
  const exact = plans.find((p) => p.id === d);
  if (exact) return exact;
  return plans.find((p) => p.id.endsWith(`-${d}`) || p.id === d.replace(/^0+/, '')) || null;
}

// ── сбор ────────────────────────────────────────────────────────────────────

let entries;
try {
  entries = readdirSync(phaseDir, { withFileTypes: true });
} catch (e) {
  process.stderr.write(`wave-solve: cannot list ${phaseDir}: ${e.message}\n`);
  process.exit(2);
}

const plans = [];
for (const e of entries) {
  if (!e.isFile() || !/PLAN\.md$/.test(e.name)) continue;
  const plan = parsePlan(join(phaseDir, e.name), e.name);
  if (plan !== null) plans.push(plan);
}

if (plans.length === 0) {
  if (verbose) process.stdout.write('wave-solve: no plans here — nothing to solve\n');
  process.exit(0);
}

// Лексикографический порядок — источник детерминизма (см. заголовок).
plans.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/**
 * База нумерации берётся из самой фазы, а не задаётся константой.
 *
 * Обе конвенции встречаются в живых данных: часть фаз нумерует волны с 1,
 * часть — с 0. Решатель, жёстко начинающий с 1, сообщил бы о расхождении в
 * КАЖДОМ плане нуль-базированной фазы — сдвиг на единицу выглядел бы как
 * системное нарушение инварианта, и настоящее нарушение утонуло бы в этом шуме.
 * Гейт, который валит целую фазу из-за конвенции нумерации, выключают.
 */
const declared = plans.map((p) => p.declaredWave).filter((w) => w !== null);
const BASE = declared.length > 0 ? Math.min(...declared, 1) : 1;

// ── решение ─────────────────────────────────────────────────────────────────

const solved = new Map(); // id → wave
const visiting = new Set();

/** Волна плана: на единицу выше максимума его зависимостей. */
function depthOf(plan, trail) {
  if (solved.has(plan.id)) return solved.get(plan.id);
  if (visiting.has(plan.id)) {
    const cycle = [...trail, plan.id].join(' → ');
    process.stderr.write(`wave-solve: dependency cycle: ${cycle}\n`);
    process.stderr.write('A cyclic graph has no wave assignment; inventing one would be worse than none.\n');
    process.exit(2);
  }
  visiting.add(plan.id);

  let base = BASE;
  for (const dep of plan.deps) {
    const target = resolveDep(dep, plans);
    if (target === null) continue; // ссылка вовне фазы — не наша забота
    base = Math.max(base, depthOf(target, [...trail, plan.id]) + 1);
  }

  visiting.delete(plan.id);
  solved.set(plan.id, base);
  return base;
}

for (const p of plans) depthOf(p, []);

// Разведение по файлам: план сдвигается вперёд, пока конфликтует с волной.
const byWave = new Map();
for (const plan of plans) {
  let wave = solved.get(plan.id);
  const own = new Set(plan.files);
  for (;;) {
    const here = byWave.get(wave) || [];
    const clash = here.some((other) => other.files.some((f) => own.has(f)));
    if (!clash) break;
    wave++;
  }
  solved.set(plan.id, wave);
  if (!byWave.has(wave)) byWave.set(wave, []);
  byWave.get(wave).push(plan);
}

// ── сравнение с объявленным ─────────────────────────────────────────────────

/**
 * Расхождения делятся по НАПРАВЛЕНИЮ, и это не косметика.
 *
 * Объявлено ПОЗЖЕ вычисленного — безопасно. План, поставленный в волну 3 там,
 * где хватило бы второй, ничего не ломает: он лишь исполняется последовательно
 * с тем, с чем мог бы идти параллельно. Инвариант не нарушен, потеряна только
 * скорость. На живом проекте это большинство расхождений, и блокировать их
 * значило бы валить фазы за консервативное планирование.
 *
 * Объявлено РАНЬШЕ вычисленного — нарушение. План идёт либо до собственной
 * зависимости (работает против кода, которого ещё нет), либо в одной волне с
 * планом, пишущим в тот же файл (гонка в отдельном worktree). Именно это ловит
 * `wave-collision`, и именно это здесь блокирует.
 */
const violations = [];
const conservative = [];
let matched = 0;
let undeclared = 0;

for (const plan of plans) {
  const computed = solved.get(plan.id);
  if (plan.declaredWave === null) {
    undeclared++;
    continue;
  }
  if (plan.declaredWave === computed) matched++;
  else if (plan.declaredWave < computed) violations.push({ ...plan, computed });
  else conservative.push({ ...plan, computed });
}

const diffs = violations;

const skippedTotal = plans.reduce((n, p) => n + p.skipped.length, 0);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        phase: phaseDir,
        waves: Math.max(...solved.values()),
        plans: plans.map((p) => ({
          id: p.id,
          declared: p.declaredWave,
          computed: solved.get(p.id),
        })),
        diffs: diffs.length,
      },
      null,
      2,
    )}\n`,
  );
  process.exit(diffs.length > 0 ? 1 : 0);
}

if (diffs.length === 0) {
  process.stdout.write(
    `wave-solve: OK — ${matched} plan(s) match the computed assignment` +
      (conservative.length > 0 ? `, ${conservative.length} scheduled later than necessary` : '') +
      (undeclared > 0 ? `, ${undeclared} declare no wave` : '') +
      `, ${Math.max(...solved.values())} wave(s) total\n`,
  );
  if (verbose && conservative.length > 0) {
    process.stdout.write(
      'wave-solve: these could run earlier — safe as they stand, only slower:\n',
    );
    for (const c of conservative) {
      process.stdout.write(`  ${c.name}: declared ${c.declaredWave}, could be ${c.computed}\n`);
    }
  }
  if (verbose && skippedTotal > 0) {
    process.stdout.write(
      `wave-solve: ${skippedTotal} non-file entr(ies) (directories or globs) were not compared\n`,
    );
  }
  process.exit(0);
}

process.stderr.write('\nwave-solve: declared waves differ from the computed assignment\n\n');

for (const d of diffs) {
  process.stderr.write(`  ${d.name}\n`);
  process.stderr.write(`    declared: wave ${d.declaredWave}\n`);
  process.stderr.write(`    computed: wave ${d.computed}\n`);
  if (d.deps.length > 0) process.stderr.write(`    depends_on: ${d.deps.join(', ')}\n`);
  process.stderr.write('\n');
}

process.stderr.write(
  `${diffs.length} plan(s) differ, ${matched} match.\n` +
    'A plan scheduled earlier than its dependencies runs against work that does not exist yet;\n' +
    'one sharing a wave with a plan touching the same file races it in a separate worktree.\n' +
    'Renumber the waves, or fix depends_on if the dependency is what is wrong.\n',
);
process.exit(1);
