#!/usr/bin/env node
/**
 * Contract drift — сверка ОБЪЯВЛЕННОЙ сигнатуры с ФАКТИЧЕСКОЙ в коде.
 *
 * ── Какой отказ это ловит ────────────────────────────────────────────────
 *
 * Система признаёт его сама, дословно (fragments/plan-pre-design.md):
 * «Nothing in the pipeline typechecks across plans».
 *
 * Волна 1 объявляет в DESIGN.md порт, возвращающий `EitherAsync<RepoError,
 * Book>`. Волна 2 пишет вызов, ожидающий `Promise<Book | null>`. Обе волны
 * исполняются в изолированных worktree, обе проходят свои тесты, обе
 * верифицируются зелёными — потому что ни одна из них не видит другую.
 * Расхождение всплывает при интеграции, когда обе уже закоммичены, и
 * выглядит как отказ сборки без единого виновника.
 *
 * Это не гипотетический класс: DESIGN.md существует в шаблоне (секция
 * `## Contracts`) именно потому, что владелец на него натыкался. Чего не
 * существовало — проверки, что написанное в контракте соответствует коду.
 *
 * ── Почему сверяется расхождение, а не наличие ───────────────────────────
 *
 * Соблазн: требовать `## Contracts` в каждом DESIGN.md и блокировать
 * отсутствие. Это неверно по двум причинам.
 *
 * Во-первых, измерено: на живом проекте девять DESIGN.md, и НИ ОДИН не имеет
 * секции `## Contracts` — они написаны в свободной форме, потому что
 * `workflow.design_phase` по умолчанию выключен. Гейт «секция обязана быть»
 * заблокировал бы сегодня всё до единой фазы. Гейт, который валит всех,
 * выключают в первый же день, и тогда он хуже отсутствующего.
 *
 * Во-вторых, наличие секции ничего не доказывает. Скопированная из шаблона
 * заготовка с `IThingRepository` пройдёт проверку на наличие и не поймает
 * ни одного расхождения. Проверять надо не форму, а соответствие.
 *
 * Отсюда правило: **фаза, не объявившая ни одной сигнатуры, проходит**.
 * Гейт молчит там, где нечего сверять, и говорит там, где объявленное
 * разошлось с фактическим. Так он остаётся включённым.
 *
 * ── Что считается расхождением ───────────────────────────────────────────
 *
 * Сравнивается нормализованная сигнатура: имя символа + список типов
 * параметров + возвращаемый тип. Нормализация снимает то, что не несёт
 * смысла (пробелы, переносы, имена параметров, `readonly`, кавычки), и
 * сохраняет то, что несёт (имена типов, généric-аргументы, `|` и `?`).
 *
 * Три исхода на символ:
 *
 *   match     — объявленное и фактическое совпали после нормализации;
 *   drift     — символ найден, сигнатура разошлась → БЛОКИРУЕТ;
 *   missing   — символ не найден ни в одном файле фазы → БЛОКИРУЕТ.
 *
 * `missing` блокирует наравне с `drift` намеренно: контракт, объявивший
 * символ, которого нет, — это либо невыполненная работа, либо переименование,
 * о котором не узнал ни один потребитель. Оба случая ровно так же ломают
 * следующую волну, как и расхождение типов.
 *
 * ── Чего этот гейт НЕ делает ─────────────────────────────────────────────
 *
 * Не тайпчекает. Сравнение текстовое по нормализованной форме, и это
 * сознательный предел: настоящий кросс-планный тайпчек требует LSP или
 * `tsc` по всему дереву — секунды-минуты на гейте, который должен отвечать
 * за миллисекунды. Текстовая сверка ловит ровно тот класс, ради которого
 * секция существует: «объявили одно, написали другое». Она не поймает
 * несовместимость, выраженную структурно эквивалентными, но разными типами
 * (`Book | null` против `Maybe<Book>` через алиас) — и не претендует.
 *
 * Не читает `contracts_superseded: true`. После исполнения фазы код — это
 * контракт, а секция становится историческим слепком; шаблон говорит об этом
 * прямо. Такая фаза пропускается целиком.
 *
 * ── Коды выхода ──────────────────────────────────────────────────────────
 *
 *   0 — сверка пройдена (включая «нечего сверять»)
 *   1 — найдено расхождение (drift или missing)
 *   2 — не смог посмотреть: нет каталога фазы, нечитаемый файл
 *
 * Различие 1 и 2 существенно: «ничего не нашёл» и «не смог искать» — разные
 * ответы, и второй не должен читаться как успех. В этом форке `rg` — функция
 * шелла, а не бинарник, и в подшелле она молча возвращает пустоту с кодом 0;
 * каждый скрипт здесь пишется так, чтобы этот класс ошибки был невозможен.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const phaseDir = arg('--dir');
const repoRoot = arg('--root', process.cwd());
const verbose = args.includes('--verbose');

if (!phaseDir) {
  process.stderr.write('contract-drift: --dir <phase-dir> is required\n');
  process.exit(2);
}
if (!existsSync(phaseDir)) {
  process.stderr.write(`contract-drift: phase dir not found: ${phaseDir}\n`);
  process.exit(2);
}

/** Прочитать файл, отличая «нет файла» от «не смог прочитать». */
function readOrNull(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    process.stderr.write(`contract-drift: cannot read ${file}: ${e.message}\n`);
    process.exit(2);
  }
}

/**
 * Нормализация сигнатуры до сравнимой формы.
 *
 * Снимается: перенос строк, кратные пробелы, пробелы вокруг пунктуации,
 * `readonly`, `public`, `export`, `declare`, завершающие `;` и `,`,
 * имена параметров (остаются только типы), кавычки одного вида приводятся
 * к другому.
 *
 * Сохраняется: имена типов, generic-аргументы, `|`, `&`, `?`, `[]`.
 */
function normalizeSignature(raw) {
  let s = String(raw)
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(export|declare|public|readonly|abstract)\s+/g, '')
    .replace(/["']/g, "'")
    .trim()
    .replace(/[;,]+$/, '');

  // Имена параметров не несут контрактного смысла: `findById(id: BookId)` и
  // `findById(bookId: BookId)` — один контракт. Тип — несёт.
  s = s.replace(/\(([^)]*)\)/g, (_m, params) => {
    const parts = splitTopLevel(params, ',');
    const types = parts
      .map((p) => {
        const colon = indexOfTopLevel(p, ':');
        return colon === -1 ? p.trim() : p.slice(colon + 1).trim();
      })
      .filter((p) => p !== '');
    return `(${types.join(',')})`;
  });

  return s.replace(/\s*([(),:|&<>])\s*/g, '$1');
}

/** Разбить по разделителю верхнего уровня, не заходя внутрь <>, (), [], {}. */
function splitTopLevel(str, sep) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

function indexOfTopLevel(str, ch) {
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

/**
 * Извлечь объявленные сигнатуры из DESIGN.md.
 *
 * Источник — секция `## Contracts` и только она: остальной документ прозаичен,
 * и парсить прозу означало бы ловить примеры и цитаты. Внутри секции читаются
 * блоки ```ts / ```typescript.
 *
 * Возвращает [] когда секции нет — это «нечего сверять», не ошибка.
 */
function extractDeclaredSignatures(designMd) {
  const lines = designMd.split('\n');
  let inContracts = false;
  let inFence = false;
  const collected = [];

  for (const line of lines) {
    if (/^##\s+Contracts\s*$/i.test(line)) {
      inContracts = true;
      continue;
    }
    // Любой следующий заголовок того же уровня закрывает секцию.
    if (inContracts && /^##\s+/.test(line)) break;
    if (!inContracts) continue;

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim().toLowerCase();
      inFence = !inFence && (lang === 'ts' || lang === 'typescript' || lang === '');
      if (!inFence) inFence = false;
      continue;
    }
    if (inFence) collected.push(line);
  }

  return parseMembers(collected.join('\n'));
}

/**
 * Разобрать тело блока в список { name, signature }.
 *
 * Ловятся две формы, покрывающие то, что шаблон показывает как пример:
 *   - член интерфейса:  `findById(id: ThingId): Promise<...>;`
 *   - функция/метод:    `function foo(...): T` / `foo(...): T`
 *
 * Строки, не похожие на объявление (открытие интерфейса, `}`, комментарии),
 * пропускаются молча — это структура, а не контракт.
 */
function parseMembers(body) {
  const out = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('*')) continue;
    if (/^(export\s+)?(interface|type|class|enum|namespace)\b/.test(line)) continue;
    if (line === '}' || line === '{') continue;

    // <имя>(<params>): <returnType>
    const m = line.match(/^(?:export\s+)?(?:async\s+)?(?:function\s+)?([A-Za-z_$][\w$]*)\s*(\([\s\S]*)$/);
    if (!m) continue;
    const [, name, rest] = m;
    if (!rest.includes(':')) continue; // без возвращаемого типа это не контракт
    out.push({ name, signature: normalizeSignature(`${name}${rest}`) });
  }
  return out;
}

/** Собрать .ts/.tsx файлы репозитория, пропуская то, что не является исходником. */
function collectSourceFiles(root) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.nx', 'tmp']);
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // нечитаемый каталог — не повод падать
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(full);
        continue;
      }
      const ext = extname(e.name);
      if (ext === '.ts' || ext === '.tsx') out.push(full);
    }
  }
  return out;
}

/**
 * Найти фактическую сигнатуру символа в исходниках.
 *
 * Возвращает первое совпадение по имени. Однозначность обеспечивается тем, что
 * контракт объявляет символы, пересекающие границу плана, — они по определению
 * экспортированы и уникальны в своём слое. Если имя встречается дважды,
 * сравнение идёт с первым: расхождение при этом всё равно будет замечено, а
 * ложное «совпало» невозможно, потому что совпасть должна вся сигнатура.
 */
function findActualSignature(name, files) {
  const re = new RegExp(`(?:^|[^\\w$])${escapeRegex(name)}\\s*\\(`, 'm');
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!re.test(text)) continue;

    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      const m = line.match(
        new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s+)?${escapeRegex(name)}\\s*(\\([\\s\\S]*)$`),
      );
      if (!m) continue;
      if (!m[1].includes(':')) continue;
      return { signature: normalizeSignature(`${name}${m[1]}`), file };
    }
  }
  return null;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // allow-adhoc-regex-escape: standalone capability script run from $HOME/.gsd/mn-verify-gate, cannot reach the src/pattern.cts seam
}

// ── main ────────────────────────────────────────────────────────────────────

// Артефакты фазы несут числовой префикс. Архитектор пишет
// `{phase_dir}/{padded_phase}-DESIGN.md` (`agents/gsd-system-architect.md:24`,
// `capabilities/architecture/fragments/plan-pre.md:12`), а этот скрипт искал
// голый `DESIGN.md` — и молча выходил с 0 на КАЖДОЙ фазе. То есть гейт нельзя
// было заставить сработать: даже при включённых `architecture_design` и
// `contract_drift` он читал файл, которого никто не создаёт.
//
// Проверено на живых проектах: все найденные файлы фаз — `07.1-DESIGN.md`,
// `09.1-DESIGN.md`; голых `DESIGN.md` в директориях фаз нет ни одного.
// Матчим по суффиксу — той же формой, что `check-frontmatter.mjs:58`, иначе
// два скрипта одной capability расходятся в том, что считают артефактом фазы.
const designName = (() => {
  let entries;
  try {
    entries = readdirSync(phaseDir);
  } catch {
    return null;
  }
  return entries.find((f) => f === 'DESIGN.md' || f.endsWith('-DESIGN.md')) || null;
})();

const design = designName === null ? null : readOrNull(join(phaseDir, designName));

if (design === null) {
  if (verbose) process.stdout.write('contract-drift: no DESIGN.md — nothing to check\n');
  process.exit(0);
}

// Исполненная фаза: код — контракт, секция стала слепком (см. шаблон).
if (/^contracts_superseded:\s*true\s*$/m.test(design)) {
  if (verbose) process.stdout.write('contract-drift: contracts_superseded — skipping\n');
  process.exit(0);
}

const declared = extractDeclaredSignatures(design);
if (declared.length === 0) {
  if (verbose) process.stdout.write('contract-drift: no declared signatures — nothing to check\n');
  process.exit(0);
}

const files = collectSourceFiles(repoRoot);
if (files.length === 0) {
  process.stderr.write(`contract-drift: no .ts/.tsx sources under ${repoRoot} — cannot verify\n`);
  process.exit(2);
}

const drift = [];
const missing = [];
let matched = 0;

for (const d of declared) {
  const actual = findActualSignature(d.name, files);
  if (actual === null) {
    missing.push(d);
    continue;
  }
  if (actual.signature === d.signature) {
    matched++;
    continue;
  }
  drift.push({ ...d, actual: actual.signature, file: actual.file });
}

if (drift.length === 0 && missing.length === 0) {
  process.stdout.write(`contract-drift: OK — ${matched} declared signature(s) match the code\n`);
  process.exit(0);
}

process.stderr.write('\ncontract-drift: declared contracts do not match the code\n\n');

for (const d of drift) {
  process.stderr.write(`  DRIFT  ${d.name}\n`);
  process.stderr.write(`    declared: ${d.signature}\n`);
  process.stderr.write(`    actual:   ${d.actual}\n`);
  process.stderr.write(`    in:       ${d.file}\n\n`);
}
for (const m of missing) {
  process.stderr.write(`  MISSING ${m.name}\n`);
  process.stderr.write(`    declared: ${m.signature}\n`);
  process.stderr.write(`    not found in any .ts/.tsx source\n\n`);
}

process.stderr.write(
  `${drift.length} drifted, ${missing.length} missing, ${matched} matched.\n` +
    'A contract that no longer describes the code will mislead the next wave that reads it.\n' +
    'Fix the code, or update DESIGN.md and say why in the phase notes.\n',
);
process.exit(1);
