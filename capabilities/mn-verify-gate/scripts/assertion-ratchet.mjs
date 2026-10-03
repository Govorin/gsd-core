#!/usr/bin/env node
/**
 * Assertion ratchet — храповик по числу живых проверок.
 *
 * Ловит класс отказа, который не ловит ничто другое: тест не падает, потому
 * что проверку из него убрали. Удаление ассерта делает набор тестов зеленее,
 * и ни один зелёный прогон об этом не сообщит. Покрытие тоже молчит: строка
 * по-прежнему исполняется, просто её результат больше никто не сверяет.
 *
 * Инвариант: число ассертов не убывает. Убыло — требуется явная запись
 * причины, а не молчание. Правило намеренно допускает убывание (рефакторинг
 * тестов, слияние дублей — законны); недопустимо только необъявленное.
 *
 * Что считается ассертом: `expect(`, `assert(`, `assert.`, `.toThrow`,
 * `should.` и skip-маркеры отдельной метрикой (`it.skip` не падает, но и не
 * проверяет — тихий эквивалент удаления).
 *
 * Счёт статический, по исходникам: `vitest list` требует резолва всего
 * workspace и в монорепо на сотню проектов стоит минуты; обход дерева даёт
 * тот же ответ за секунды. Цена — считаются и ассерты в закомментированном
 * коде; для храповика это приемлемо, он сравнивает величину с самой собой.
 *
 * Обход — своими силами, без ripgrep: в некоторых окружениях `rg` оказывается
 * shell-функцией, а не бинарём в PATH, и дочерний процесс её не видит. Гейт,
 * падающий из-за отсутствия инструмента, неотличим от гейта, поймавшего
 * дефект — а такой шум учит игнорировать блокировки.
 *
 *   node assertion-ratchet.mjs --baseline .planning/assertion-baseline.json [--update] [--paths libs apps]
 *
 * exit 0 — не убыло (или baseline создан); exit 1 — убыло без записи.
 */
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
};

const update = argv.includes('--update');

// Якорим обход на корень репозитория, а не на cwd. GSD запускает гейт из
// директории проекта (apps/rpg), а код монорепозитория лежит выше — из
// подпроекта `libs`/`apps` не видны, обход возвращает ноль спек, и с --update
// это записало бы пустой baseline: храповик, который больше никогда не сработает.
// Пустой результат обязан быть отказом, а не новой точкой отсчёта.
let repoRoot = process.cwd();
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim() || repoRoot;
} catch {
  // Не git — работаем от cwd; проверка на ноль спек ниже всё равно поймает промах.
}

const baselinePath = resolve(repoRoot, arg('baseline', '.planning/assertion-baseline.json'));
const roots = (arg('paths', 'libs apps') || '')
  .split(/\s+/)
  .filter(Boolean)
  .map((r) => resolve(repoRoot, r));

const ASSERTIONS = /expect\(|\bassert\(|\bassert\.|\.toThrow|\bshould\./g;
const SKIPS = /\b(it|test|describe)\.(skip|todo)\b|\bxit\(|\bxdescribe\(/g;
const SPEC = /\.(spec|test)\.tsx?$/;
const PRUNE = new Set(['node_modules', 'dist', 'build', '.git', '.nx', 'coverage', '.venv', '__pycache__']);

/** Все спеки под указанными корнями. Пропущенный корень — не ошибка: не каждый репозиторий несёт apps/. */
function* specs(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!PRUNE.has(e.name)) yield* specs(p);
    } else if (SPEC.test(e.name)) {
      yield p;
    }
  }
}

const current = { assertions: 0, skipped: 0, files: 0 };
for (const root of roots) {
  for (const file of specs(root)) {
    const text = readFileSync(file, 'utf8');
    current.files += 1;
    current.assertions += (text.match(ASSERTIONS) || []).length;
    current.skipped += (text.match(SKIPS) || []).length;
  }
}

if (current.files === 0) {
  // Ноль спек — почти всегда промах обхода (не тот корень, переименованная папка),
  // а не репозиторий без тестов. Записать это как baseline значит навсегда
  // обнулить храповик, поэтому отказываем даже при --update.
  console.error(`FAIL: no spec files found under [${roots.join(', ')}] (repo root: ${repoRoot}).`);
  console.error('Refusing to record an empty baseline — a zeroed ratchet never fires again.');
  process.exit(1);
}

if (!existsSync(baselinePath) || update) {
  writeFileSync(baselinePath, `${JSON.stringify({ ...current, updated: new Date().toISOString() }, null, 2)}\n`);
  console.log(`baseline written: ${current.assertions} assertions, ${current.skipped} skipped, across ${current.files} spec files`);
  process.exit(0);
}

const base = JSON.parse(readFileSync(baselinePath, 'utf8'));
const dAssert = current.assertions - base.assertions;
const dSkip = current.skipped - base.skipped;

console.log(`assertions ${base.assertions} → ${current.assertions} (${dAssert >= 0 ? '+' : ''}${dAssert})`);
console.log(`skipped    ${base.skipped} → ${current.skipped} (${dSkip >= 0 ? '+' : ''}${dSkip})`);

const problems = [];
if (dAssert < 0) problems.push(`${-dAssert} assertion(s) removed`);
if (dSkip > 0) problems.push(`${dSkip} test(s) newly skipped`);

if (problems.length) {
  console.error(`\nFAIL: ${problems.join('; ')}.`);
  console.error('Removing a check makes the suite greener while proving less — say why, or restore it.');
  console.error('Record the reason in VALIDATION.md "## Assertion Ratchet", then re-run with --update.');
  process.exit(1);
}

console.log('\nOK: no checks were silently removed.');
process.exit(0);
