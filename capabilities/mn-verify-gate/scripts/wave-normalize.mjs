#!/usr/bin/env node
/**
 * Wave normalize — wave-collision с раскрытыми каталогами и глобами.
 *
 * ── Измеренное ложноотрицательное срабатывание ───────────────────────────
 *
 * `wave-collision.mjs` сравнивает только записи, в basename которых есть
 * точка. Каталог и глоб он честно пропускает и об этом сообщает. Замер по
 * всем 55 достижимым каталогам фаз: поймано коллизий — **2**, фаз, где
 * записи пропускаются как «не файлы», — **17 из 55**.
 *
 * Дословный вывод шиппящегося детектора на `legion-app/08.2-heimdall-runtime`:
 *
 *   "OK — 9 plan(s) across 8 wave(s), 1 pair(s) checked, no shared files"
 *   "13 non-file entr(ies) (directories or globs) were not compared"
 *
 * А коллизия там настоящая: `08.2-01-PLAN.md` и `08.2-01b-PLAN.md` оба
 * заявляют `libs/modules/heimdall/testing` — каталог, в котором 40 файлов.
 * Шесть пар с точным совпадением файлов детектор ловит; седьмую, каталожную,
 * не видит.
 *
 * **Детектор не неправ — он слеп.** Он отказывается гадать и говорит об этом
 * вслух, что честнее ложного «чисто». Этот скрипт возвращает ему зрение,
 * раскрывая записи в реальные файлы ПЕРЕД сравнением.
 *
 * ── Почему рядом, а не вместо ────────────────────────────────────────────
 *
 * `wave-collision.mjs` не изменяется. Он остаётся консервативным запасным
 * вариантом, если нормализация однажды промахнётся, и `03-CONTEXT.md`
 * требует гейты добавлять, а не переписывать. Оба могут быть включены
 * одновременно: `wave_collision` идёт раньше по массиву, этот ловит то,
 * что тот пропустил.
 *
 * ── D-63c: раскрывать, а не сравнивать строки ────────────────────────────
 *
 * Наивное сравнение строк, считающее `libs/modules/heimdall/testing` файлом,
 * сфабрикует коллизию между каталогом и файлом внутри него, из-за которой ни
 * один worktree никогда не конфликтовал бы. Поэтому запись раскрывается в
 * файлы, которые она реально покрывает, и сравниваются уже они.
 *
 * ── Четыре исхода, которые не схлопываются (D-65, D-66) ──────────────────
 *
 *   COLLIDING PAIRS      — одна волна, пересекающиеся раскрытые множества
 *   DECLARED NOTHING     — план не заявил ничего: отказ планировщика заявлять,
 *                          НИКОГДА не «ни с кем не пересекается» (D-65)
 *   RESOLVED TO NOTHING  — глоб/каталог раскрылись в ноль: файлы переехали
 *   UNPARSEABLE ENTRIES  — проза вместо пути
 *
 * Все четыре дают выход 1. Различается ЗАГОЛОВОК, потому что лечение разное:
 * устаревший глоб значит «файлы переехали», пустая декларация — «никто её не
 * написал». Схлопывание — то, как гейт зарабатывает репутацию, из-за которой
 * его выключают.
 *
 * ── Откуда взят алгоритм классификации ───────────────────────────────────
 *
 * Форма продублирована с `src/files-modified-normalize.cts` — эталонной
 * реализации, покрытой 33 модульными тестами, которая и закрепляет семантику.
 * Скрипт капабилити НЕ МОЖЕТ импортировать из `src/`: он ставится в
 * `~/.gsd/mn-verify-gate/scripts/` и запускается отдельным
 * процессом, где `src/` не существует. Конвенция дублирования формы под
 * комментарием с указанием источника — здешняя (ср. `contract-drift.mjs:322`).
 *
 * Комментарий, однако, не есть принуждение. Расхождение стережёт
 * `tests/mn-wave-normalize-drift.test.cjs`: он гоняет ОБЕ реализации на одних
 * входах и валится при первом же расхождении по kind или по раскрытому списку.
 *
 * ── Коды выхода ──────────────────────────────────────────────────────────
 *
 *   0 — чисто
 *   1 — находка (любая из четырёх)
 *   2 — не смог посмотреть: нет `--dir`, нет каталога, нечитаемый файл
 *
 * Непойманное исключение обязано выходить как 2. По умолчанию Node выходит с
 * 1, что прочиталось бы как «нашёл коллизию» и было бы неотличимо от реальной
 * находки — ложный halt хуже пропуска. Отсюда единственная точка выхода внизу
 * файла с catch-all, как в `migration-safety.mjs`.
 */

import { readFileSync, readdirSync, existsSync, statSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const EXIT_OK = 0;
const EXIT_FINDING = 1;
const EXIT_UNKNOWN = 2;

/**
 * Потолок глубины обхода.
 *
 * `readDir` поверх реальной ФС можно скормить петлю симлинков, и неограниченный
 * обход не завершится. Контракт гейта — либо ответить, либо сказать, что не
 * смог посмотреть; «зависнуть» в контракте нет. 64 намного больше любой
 * измеренной глубины репозитория (самая глубокая живая запись — 8 сегментов) и
 * при этом конечно.
 */
const MAX_WALK_DEPTH = 64;

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const phaseDir = arg('--dir');
const verbose = args.includes('--verbose');
const asJson = args.includes('--json');

// ── файловая система ────────────────────────────────────────────────────────

/**
 * Корень репозитория для записи `files_modified`.
 *
 * Пути в планах — относительно корня репозитория, поэтому раскрытие без корня
 * превратило бы каждую запись в несуществующий путь, и гейт рапортовал бы
 * «чисто» на всём: та же поломка в новом костюме. Идём вверх от `--dir` в
 * поисках `.planning`, и только если не нашли — `process.cwd()`.
 */
function inferRoot(dir) {
  let current = dir;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (existsSync(join(current, '.planning'))) return current;
    const parent = join(current, '..');
    // Дошли до корня ФС — `join('/', '..')` возвращает '/'.
    if (parent === current) break;
    current = parent;
  }
  return process.cwd();
}

/**
 * Пробник ФС. Все пути — относительно `root`.
 *
 * T-03-01: симлинки НЕ раскрываются (`lstatSync`, а не `statSync`), поэтому
 * каталог, ссылающийся наружу, вносит ноль файлов вместо содержимого чужого
 * дерева.
 */
function makeProbe(root) {
  const abs = (p) => (p === '' ? root : join(root, p));
  return {
    exists(p) {
      try {
        lstatSync(abs(p));
        return true;
      } catch {
        return false;
      }
    },
    isDirectory(p) {
      try {
        // lstat, не stat: симлинк на каталог НЕ является каталогом для обхода.
        return lstatSync(abs(p)).isDirectory();
      } catch {
        return false;
      }
    },
    isSymbolicLink(p) {
      try {
        return lstatSync(abs(p)).isSymbolicLink();
      } catch {
        return false;
      }
    },
    readDir(p) {
      return readdirSync(abs(p));
    },
  };
}

// ── классификация: форма из src/files-modified-normalize.cts ────────────────

/**
 * Нормализовать заявленный путь до сравнимой формы, НЕ меняя его смысл.
 *
 * Сознательно не схлопывает `..` и не зовёт `path.resolve`: записи по
 * соглашению относительны корню репозитория, а разрешение их против
 * `process.cwd()` сделало бы вывод машинозависимым и сломало бы критерий 3.
 */
function normalizePath(declared) {
  return String(declared)
    .trim()
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** Это проза, а не путь? */
function looksLikeProse(text) {
  // Замер по живым деревьям: 25 записей содержат `(`, 26 — пробел, и 16 из них
  // ЕЩЁ И `*`. Путь в этом корпусе не содержит пробела; скобка всегда вводит
  // счётчик или ремарку.
  return /\s/.test(text) || text.includes('(');
}

/**
 * Выходит ли путь за пределы корня.
 *
 * T-03-01: `../outside/x.ts` и абсолютный путь уводят обход наружу
 * репозитория. Они не «файл, который план создаст», а запись, которую этот
 * гейт раскрывать не станет.
 */
function escapesRoot(p) {
  if (isAbsolute(p)) return true;
  let depth = 0;
  for (const seg of p.split('/')) {
    if (seg === '..') {
      depth--;
      if (depth < 0) return true;
    } else if (seg !== '.' && seg !== '') {
      depth++;
    }
  }
  return false;
}

/**
 * Один из четырёх видов. Порядок решений несущий:
 *
 *   1. Проза → `malformed`, ДО проверки на подстановочный знак. Замер: 16 из
 *      45 записей с `*` в живых деревьях — это проза, обёрнутая вокруг глоба,
 *      напр. `libs/** (19 prefer-zod-validate files — exact list from live
 *      scan)`. Чтение её как глоба компилирует всё предложение в RegExp,
 *      ничего не находит и рапортует «устаревший глоб — файлы переехали».
 *      Ничего не переезжало; планировщик написал предложение. Две разные
 *      поломки, которые D-66 запрещает сливать.
 *   2. Подстановочный знак → `glob`.
 *   3. Существующий каталог → `directory`.
 *   4. Иначе → `file`. Несуществующий конкретный путь остаётся `file` с
 *      `resolved: [p]`: план заявляет файл, который СОЗДАСТ, и трактовка его
 *      как нераскрытого пометила бы каждый greenfield-план.
 */
function classifyEntry(declared, fs) {
  const p = normalizePath(declared);
  if (p === '') return 'malformed';
  if (looksLikeProse(p)) return 'malformed';
  if (escapesRoot(p)) return 'malformed';
  if (p.includes('*') || p.includes('?')) return 'glob';
  if (fs.exists(p) && fs.isDirectory(p)) return 'directory';
  return 'file';
}

/** Отсортированный листинг. Через него идёт каждый уровень каждого обхода. */
function sortedChildren(fs, dir) {
  let names;
  try {
    names = fs.readDir(dir);
  } catch {
    // Каталог, который не листается, вносит ноль вместо срыва всей
    // нормализации. Вызывающий всё равно увидит `unresolved`.
    return [];
  }
  // `readdirSync` не гарантирует порядок — сортируем явно (критерий 3).
  return [...names].sort();
}

/** Каждый обычный файл в каталоге и под ним, отсортированно, в глубину. */
function walkDirectory(fs, dir, depth = 0) {
  if (depth >= MAX_WALK_DEPTH) return [];
  const out = [];
  for (const name of sortedChildren(fs, dir)) {
    const child = dir === '' ? name : `${dir}/${name}`;
    // T-03-01: симлинк не обходится И не засчитывается как файл. Он не то, что
    // план собирается писать, а обход по нему уводит за пределы репозитория.
    if (fs.isSymbolicLink && fs.isSymbolicLink(child)) continue;
    if (fs.isDirectory(child)) out.push(...walkDirectory(fs, child, depth + 1));
    else out.push(child);
  }
  return out;
}

/**
 * Скомпилировать глоб в заякоренный RegExp.
 *
 * T-03-02: словарь — ровно то, что содержат измеренные деревья: `*` (один
 * сегмент) и `**` (любая глубина). Каждый метасимвол кроме `*` экранируется,
 * так что ни альтернатива, ни квантификатор от пользователя до движка не
 * доходят и катастрофический бэктрекинг неоткуда взять.
 */
function globToRegExp(pattern) {
  // Слева направо, а не цепочкой `replace`: цепочке приходится парковать
  // промежуточные результаты в сторожевых символах, и любой сторож, способный
  // встретиться в реальном пути, молча портит шаблон.
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      body += '(?:.*/)?'; // `libs/**/x` покрывает и `libs/x`, и `libs/a/x`
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      body += '.*'; // хвостовой `**`: любая глубина
      i += 2;
    } else if (pattern[i] === '*') {
      body += '[^/]*'; // одиночная `*`: внутри одного сегмента
      i += 1;
    } else {
      body += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // allow-adhoc-regex-escape: standalone capability script run from $HOME/.gsd/mn-verify-gate, cannot reach the src/pattern.cts seam
      i += 1;
    }
  }
  return new RegExp(`^${body}$`);
}

/**
 * Самый длинный буквальный префикс шаблона — до первого подстановочного знака,
 * обрезанный по последнему разделителю.
 *
 * Обход начинается отсюда, а не от корня репозитория, поэтому постороннее
 * поддерево не листается вовсе: `libs/x/**` никогда не трогает `apps/`
 * (T-03-02: подмножество обхода ограничено).
 */
function literalPrefix(pattern) {
  const star = pattern.search(/[*?]/);
  const head = star === -1 ? pattern : pattern.slice(0, star);
  const cut = head.lastIndexOf('/');
  return cut === -1 ? '' : head.slice(0, cut);
}

/** Файлы, попавшие под глоб, отсортированно. Пусто, если префикса нет. */
function resolveGlob(fs, pattern) {
  const prefix = literalPrefix(pattern);
  // Исчезнувший префикс — это случай устаревшего глоба (исход 3): возвращаем
  // пусто и даём вызывающему пометить `unresolved`, а не бросаем.
  if (prefix !== '' && !fs.exists(prefix)) return [];
  const re = globToRegExp(pattern);
  return walkDirectory(fs, prefix).filter((f) => re.test(f));
}

/** Раскрыть одну заявленную запись в файлы, которые она обозначает. */
function normalizeOne(declared, fs) {
  const kind = classifyEntry(declared, fs);
  const p = normalizePath(declared);

  let resolved;
  switch (kind) {
    case 'malformed':
      // Сознательно вносит ноль. Проза, раскрывшаяся во что-то, позволила бы
      // предложению столкнуться с файлом.
      resolved = [];
      break;
    case 'glob':
      resolved = resolveGlob(fs, p);
      break;
    case 'directory':
      resolved = walkDirectory(fs, p);
      break;
    default:
      // Включая ещё не существующие пути: план намерен их создать.
      resolved = [p];
      break;
  }

  return { declared, kind, resolved, unresolved: resolved.length === 0 };
}

/**
 * Раскрыть весь список плана, сохраняя порядок объявления.
 *
 * `declaredNothing` берётся СТРОГО из `declared.length === 0` и никогда не
 * выводится из пустого `files`: исход 3 (устаревший глоб) тоже даёт пустой
 * `files`, а D-66 требует, чтобы эти два оставались наблюдаемы порознь.
 */
function normalizePlanFiles(declared, fs) {
  const entries = declared
    // Пустой элемент списка — артефакт YAML, а не декларация. Его отбрасывание
    // НЕ то же самое, что «план не заявил ничего».
    .filter((d) => normalizePath(d) !== '')
    .map((d) => normalizeOne(d, fs));

  const union = new Set();
  for (const entry of entries) for (const f of entry.resolved) union.add(f);

  return { entries, files: [...union].sort(), declaredNothing: declared.length === 0 };
}

// ── разбор frontmatter ──────────────────────────────────────────────────────

/**
 * Разобрать frontmatter плана. Возвращает null, если это не план с волной.
 *
 * Построчно, не регекспом по блоку — обе причуды унаследованы от
 * `wave-collision.mjs`, где за них уже заплачено:
 *   - пустая строка внутри блока его НЕ закрывает (17 планов из 96 в одном
 *     живом проекте оформлены так, включая `08.2-01b-PLAN.md`);
 *   - регексп, требующий `\n` после каждой записи, теряет ПОСЛЕДНЮЮ строку
 *     frontmatter — её перевод строки съеден закрывающим `---`.
 * Дополнительно принимается ВСТРОЕННАЯ форма `files_modified: [a, b]`, которая
 * тоже встречается в живых деревьях.
 */
/**
 * Снять кавычки и хвостовой YAML-комментарий с элемента списка.
 *
 * Найдено прогоном по 55 каталогам фаз: `mn-konung/05-09-PLAN.md` пишет
 * `- apps/.../use-websocket.ts    # DELETED in this commit`. Оба пути
 * настоящие. Оставленный комментарий даёт в записи пробел, после чего правило
 * прозы относит её к UNPARSEABLE — гейт винит планировщика за то, что тот
 * корректно аннотировал путь.
 *
 * Внутри кавычек `#` НЕ комментарий: путь имеет право содержать решётку, и
 * обрезание по первой `#` молча испортило бы его.
 */
function stripInlineComment(text) {
  const trimmed = text.trim();
  const quoted = trimmed.match(/^(["'])(.*?)\1/);
  if (quoted) return quoted[2];
  // Комментарием считается `#`, отделённая пробелом (или стоящая первой) —
  // так же, как это читает YAML.
  return trimmed.replace(/(?:^|\s+)#.*$/, '').trim();
}

function parsePlan(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    // Нечитаемый план — это «не смог посмотреть», а не «чисто».
    throw new Error(`нечитаемый план ${file}: ${e.message}`);
  }

  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;

  const waveMatch = fm[1].match(/^wave:\s*(\d+)\s*$/m);
  if (!waveMatch) return null;

  const raw = [];
  let inList = false;
  for (const line of fm[1].split('\n')) {
    const inline = line.match(/^files_modified:\s*\[(.*)\]\s*$/);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const item = stripInlineComment(part);
        if (item !== '') raw.push(item);
      }
      continue;
    }
    if (/^files_modified:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    if (line.trim() === '') continue; // пустая строка блок НЕ закрывает
    // Комментарий блок тоже НЕ закрывает. Найдено прогоном по всем 55
    // достижимым каталогам фаз: `legion-app/08.3-gates/08.3-05-PLAN.md`
    // заявляет четыре файла ПОСЛЕ трёх строк `#`, и разбор, обрывающийся на
    // первой не-элементной строке, отнёс его к DECLARED NOTHING. Это ровно та
    // подмена, которую D-65 и существует предотвращать — план, который ЗАЯВИЛ,
    // подшитый в «отказался заявлять», — и такое ложное срабатывание хуже
    // пропуска, который оно заменило.
    if (/^[ \t]*#/.test(line)) continue;
    const item = line.match(/^[ \t]+-[ \t]*(.*)$/);
    if (item === null) break; // список кончился — следующий ключ frontmatter
    raw.push(stripInlineComment(item[1]));
  }

  return { wave: Number(waveMatch[1]), declared: raw };
}

// ── отчёт ───────────────────────────────────────────────────────────────────

/** Секция отчёта — целиком опускается, когда пуста. */
function section(heading, lines) {
  if (lines.length === 0) return '';
  return `\n${heading}\n\n${lines.map((l) => `  ${l}`).join('\n')}\n`;
}

function main() {
  if (!phaseDir) {
    process.stderr.write('UNKNOWN: wave-normalize: --dir <phase-dir> is required\n');
    return EXIT_UNKNOWN;
  }
  if (!existsSync(phaseDir)) {
    process.stderr.write(`UNKNOWN: wave-normalize: phase dir not found: ${phaseDir}\n`);
    return EXIT_UNKNOWN;
  }
  if (!statSync(phaseDir).isDirectory()) {
    process.stderr.write(`UNKNOWN: wave-normalize: --dir is not a directory: ${phaseDir}\n`);
    return EXIT_UNKNOWN;
  }

  const root = arg('--root') || inferRoot(phaseDir);
  if (!existsSync(root)) {
    process.stderr.write(`UNKNOWN: wave-normalize: --root not found: ${root}\n`);
    return EXIT_UNKNOWN;
  }
  const probe = makeProbe(root);

  let dirEntries;
  try {
    dirEntries = readdirSync(phaseDir, { withFileTypes: true });
  } catch (e) {
    process.stderr.write(`UNKNOWN: wave-normalize: cannot list ${phaseDir}: ${e.message}\n`);
    return EXIT_UNKNOWN;
  }

  const plans = [];
  // Сортируем имена: `readdirSync` порядок не гарантирует, а порядок планов
  // виден в отчёте и в `--json` (критерий 3).
  for (const name of dirEntries.map((e) => e.name).sort()) {
    if (!/PLAN\.md$/.test(name)) continue;
    const full = join(phaseDir, name);
    // PLAN.md, оказавшийся каталогом, — это «не смог посмотреть». Тихий пропуск
    // прочитался бы как «чисто» на фазе, которую никто не проверил.
    if (!statSync(full).isFile()) {
      process.stderr.write(`UNKNOWN: wave-normalize: ${name} is not a readable file\n`);
      return EXIT_UNKNOWN;
    }
    const parsed = parsePlan(full);
    if (parsed === null) continue;
    const normalized = normalizePlanFiles(parsed.declared, probe);
    plans.push({ name, wave: parsed.wave, ...normalized });
  }

  // ── пересечения внутри волны ──────────────────────────────────────────────

  const byWave = new Map();
  for (const p of plans) {
    if (!byWave.has(p.wave)) byWave.set(p.wave, []);
    byWave.get(p.wave).push(p);
  }

  const collisions = [];
  let pairsChecked = 0;
  for (const [wave, group] of [...byWave.entries()].sort((a, b) => a[0] - b[0])) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        pairsChecked++;
        const left = new Set(group[i].files);
        const shared = group[j].files.filter((f) => left.has(f));
        if (shared.length > 0) {
          collisions.push({ wave, a: group[i].name, b: group[j].name, shared });
        }
      }
    }
  }

  // ── три остальных вида находок ────────────────────────────────────────────

  const declaredNothing = plans.filter((p) => p.declaredNothing).map((p) => p.name);

  const resolvedToNothing = [];
  const unparseable = [];
  for (const p of plans) {
    for (const e of p.entries) {
      if (e.kind === 'malformed') unparseable.push({ plan: p.name, declared: e.declared });
      else if (e.unresolved && (e.kind === 'glob' || e.kind === 'directory')) {
        resolvedToNothing.push({ plan: p.name, declared: e.declared, kind: e.kind });
      }
    }
  }

  const findings =
    collisions.length + declaredNothing.length + resolvedToNothing.length + unparseable.length;
  const code = findings > 0 ? EXIT_FINDING : EXIT_OK;

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          exitCode: code,
          root,
          phaseDir,
          pairsChecked,
          waves: byWave.size,
          plans,
          collisions,
          declaredNothing,
          resolvedToNothing,
          unparseable,
        },
        null,
        2,
      )}\n`,
    );
    return code;
  }

  if (code === EXIT_OK) {
    process.stdout.write(
      `wave-normalize: OK — ${plans.length} plan(s) across ${byWave.size} wave(s), ` +
        `${pairsChecked} pair(s) checked, no shared files\n`,
    );
    if (verbose) {
      const resolvedTotal = plans.reduce((n, p) => n + p.files.length, 0);
      process.stdout.write(
        `wave-normalize: ${resolvedTotal} resolved file(s) compared after normalisation\n`,
      );
    }
    return code;
  }

  process.stderr.write('\nwave-normalize: the wave assignment does not hold up once entries are resolved\n');

  process.stderr.write(
    section(
      'COLLIDING PAIRS',
      collisions.flatMap((c) => [
        `WAVE ${c.wave}  ${c.a}  ⨯  ${c.b}`,
        ...c.shared.slice(0, 8).map((f) => `  ${f}`),
        ...(c.shared.length > 8 ? [`  … and ${c.shared.length - 8} more`] : []),
      ]),
    ),
  );

  process.stderr.write(
    section(
      'DECLARED NOTHING',
      declaredNothing.map((n) => `${n} — declared no files at all`),
    ),
  );

  process.stderr.write(
    section(
      'RESOLVED TO NOTHING',
      resolvedToNothing.map((r) => `${r.plan} — ${r.kind} "${r.declared}" matched no files`),
    ),
  );

  process.stderr.write(
    section(
      'UNPARSEABLE ENTRIES',
      unparseable.map((u) => `${u.plan} — not a path: "${u.declared}"`),
    ),
  );

  // Лечение у каждого заголовка своё — ради этого они и разделены.
  process.stderr.write(
    `\n${findings} finding(s).\n` +
      'COLLIDING PAIRS — same-wave plans run at once in separate worktrees and commit in\n' +
      '  sequence, so a shared file means the second commit overwrites the first or\n' +
      '  conflicts. Move one plan to a later wave, or split the shared file out of one.\n' +
      'DECLARED NOTHING — the planner was obliged to declare something and did not. This is\n' +
      '  a refusal to declare, never "overlaps nobody": an empty list cannot be checked.\n' +
      'RESOLVED TO NOTHING — the entry is real but the files moved. Re-point it at where\n' +
      '  they live now, or drop it.\n' +
      'UNPARSEABLE ENTRIES — a sentence was written where a path belongs. Replace the prose\n' +
      '  with the paths it describes.\n',
  );

  return code;
}

try {
  // `process.exitCode`, а НЕ `process.exit()`.
  //
  // Найдено прогоном плана 03-03 по живым деревьям: на
  // `legion-app/08.2-heimdall-runtime` этот `--json` весит 109741 байт.
  // В ФАЙЛ он приезжал целиком, через ТРУБУ обрубался ровно на 65536 —
  // `process.exit()` выбрасывает недослитый хвост асинхронной записи в трубу.
  // Трубу читает каждый программный потребитель (драйвер обзора, раннер
  // гейтов), поэтому руками дефект не виден вовсе, а в автоматике тотален.
  //
  // Ущерб хуже недочитанного текста: обрубленный JSON не парсится, и
  // вызывающий, читающий неразобранное как «находок нет», превращает
  // коллизию на 40 файлов в чистый вердикт — ровно тот класс
  // ложноотрицательных срабатываний, ради закрытия которого этот гейт и
  // написан, воспроизведённый этажом выше.
  //
  // Присвоение кода вместо немедленного выхода даёт Node слить stdout
  // штатно. Контракт кодов (0/1/2) не меняется.
  process.exitCode = main();
} catch (e) {
  // Единственный catch-all. Непойманное исключение по умолчанию выходит с 1,
  // что прочиталось бы как настоящая находка, — поэтому здесь ровно код 2 и
  // ничего другого. Литерал, а не константа: этот выход и есть контракт
  // скрипта, и он должен читаться без перехода к определению.
  process.stderr.write(
    `UNKNOWN: wave-normalize упал: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}\n`,
  );
  process.exitCode = 2;
}
