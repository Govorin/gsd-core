#!/usr/bin/env node
/**
 * Гейт: значение поля во frontmatter markdown-артефакта фазы.
 *
 * Зачем скрипт, а не встроенный предикат: `artifact-frontmatter-equals` живёт
 * в ветке next и в опубликованном @opengsd/gsd-core@1.9.1 отсутствует —
 * установленный evaluator знает только `command-exit-zero`
 * (bin/lib/gate-predicate-evaluator.cjs: EVALUATOR_KINDS). Этот скрипт даёт ту
 * же семантику через поддерживаемый вид предиката. Когда встроенный предикат
 * доедет до релиза, capability можно переписать на него, а скрипт удалить.
 *
 * Контракт (как у встроенного): отсутствие артефакта — ПРОВАЛ, не пропуск.
 * Фаза, не произведшая VALIDATION.md, не доказала соответствие; молчаливый
 * зелёный здесь и есть тот самый ложно-зелёный, ради которого гейт заводится.
 *
 * `--optional` инвертирует это правило для артефактов, которые фаза законно
 * может не создавать: фаза без угроз не пишет SECURITY.md, и требовать его
 * значило бы блокировать ship за отсутствие проблемы. Флаг ослабляет только
 * случай «файла нет» — существующий файл с неверным значением валит гейт всегда.
 *
 *   node check-frontmatter.mjs --dir <phase-dir> --artifact VALIDATION.md \
 *                              --field nyquist_compliant --equals true
 *   node check-frontmatter.mjs --dir <phase-dir> --artifact SECURITY.md \
 *                              --field threats_open --equals 0 --optional
 *
 * exit 0 — совпало; exit 1 — не совпало, файл не найден или поля нет.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
};

const dir = arg('dir');
const artifact = arg('artifact');
const field = arg('field');
const expected = arg('equals');
const optional = argv.includes('--optional');

if (!dir || !artifact || !field || expected === undefined) {
  console.error('usage: --dir <phase-dir> --artifact <NAME.md> --field <key> --equals <value>');
  process.exit(1);
}

if (!existsSync(dir)) {
  if (optional) {
    console.log(`SKIP: phase dir ${dir} absent, ${artifact} optional`);
    process.exit(0);
  }
  console.error(`FAIL: phase dir not found: ${dir}`);
  process.exit(1);
}

// Артефакты фазы несут числовой префикс (08-VALIDATION.md) — матчим по суффиксу.
const match = readdirSync(dir).find((f) => f === artifact || f.endsWith(`-${artifact}`));

if (!match) {
  if (optional) {
    console.log(`SKIP: no ${artifact} in ${dir} — nothing to enforce`);
    process.exit(0);
  }
  console.error(`FAIL: no ${artifact} in ${dir} — phase produced no such artifact`);
  process.exit(1);
}

const text = readFileSync(join(dir, match), 'utf8');
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);

if (!fm) {
  console.error(`FAIL: ${match} has no YAML frontmatter`);
  process.exit(1);
}

/**
 * Читаем скаляр: либо верхнего уровня (`key: value`), либо один уровень
 * вложенности по точечному пути (`gates.all_passed`).
 *
 * Вложенность понадобилась под `verify gates`: команда пишет измеренные
 * результаты проверок в блок `gates:`, и без пути гейт не смог бы их прочесть.
 * Глубже одного уровня сознательно не идём — писатель frontmatter (`spliceFrontmatter`)
 * всё равно отказывается сериализовать более глубокую структуру, поэтому её
 * там физически не бывает, а поддержка произвольной глубины regex'ом означала
 * бы разбор отступов YAML вручную.
 *
 * Порядок важен: сначала пробуем ключ ЦЕЛИКОМ на верхнем уровне. Ключ с точкой
 * в имени (маловероятный, но легальный) продолжает работать и не перекрывается
 * трактовкой «путь».
 */
function findScalar(yaml, path) {
  const flat = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)\\s*$`, 'm').exec(yaml);
  if (flat) return flat[1];

  const dot = path.indexOf('.');
  if (dot === -1) return null;

  const parent = path.slice(0, dot);
  const child = path.slice(dot + 1);
  // Блок родителя: строка `parent:` без значения, затем отступённые строки до
  // первой строки нулевого отступа.
  const block = new RegExp(
    `^${parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*$\\n((?:[ \\t]+.*\\n?)*)`,
    'm'
  ).exec(yaml);
  if (!block) return null;

  const nested = new RegExp(
    `^[ \\t]+${child.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)\\s*$`,
    'm'
  ).exec(block[1]);
  return nested ? nested[1] : null;
}

const rawValue = findScalar(fm[1], field);

if (rawValue === null) {
  console.error(`FAIL: field "${field}" absent from ${match} frontmatter`);
  process.exit(1);
}


// Шаблоны GSD документируют поля inline-комментарием (`truths_unproven: 0 # ...`),
// и YAML считает такой хвост комментарием, а не частью значения. Срезаем его —
// иначе гейт падает на корректном артефакте, а ложное срабатывание приучает
// игнорировать блокировки. ` #` с пробелом: значение вида `v1.0#rc` не пострадает.
const actual = rawValue
  .replace(/\s+#.*$/, '')
  .trim()
  .replace(/^['"]|['"]$/g, '');

if (actual !== expected) {
  console.error(`FAIL: ${match} ${field} is "${actual}", expected "${expected}"`);
  process.exit(1);
}

console.log(`OK: ${match} ${field} == ${expected}`);
process.exit(0);
