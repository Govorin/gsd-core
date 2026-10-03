#!/usr/bin/env node
/**
 * Wave survey — прогон wave-normalize по многим деревьям сразу.
 *
 * ── Зачем нужен драйвер ──────────────────────────────────────────────────
 *
 * `wave-normalize.mjs` отвечает про ОДИН каталог фазы. Критерий 1 этой фазы
 * формулируется в ROADMAP жёстко: «фикстура доказывает, что солвер
 * запускается, а не что он что-то чинит». Закрыть критерий — значит навести
 * чекер на все достижимые потребляющие деревья и записать, что вернулось. Это
 * вопрос про 55 каталогов, а не про один.
 *
 * ── Приоритет кодов выхода — несущее свойство ────────────────────────────
 *
 * Естественная агрегация — «побеждает худшая находка», и «худшей» естественно
 * читается 1: нарушение это настоящий дефект, а 2 всего лишь пожатие плечами.
 * Это прочтение перевёрнуто и было бы главной ошибкой драйвера. Прогон, не
 * сумевший прочитать часть дерева, эту часть НЕ обследовал, поэтому подводить
 * итог по прочитанной части — значит выдать частичный обзор за полный.
 *
 * Поэтому: 2 перебивает 1, 1 перебивает 0.
 *
 * ── Абсент ≠ нечитаемость ────────────────────────────────────────────────
 *
 * Корень без `.planning/phases` не даёт ни одной строки и НЕ поднимает код
 * выхода. Дерево, где фаз просто нет, — не дерево, которое не удалось
 * прочитать. Смешать их значило бы сделать код 2 обычным фоном, после чего
 * настоящая нечитаемость перестанет быть слышна.
 *
 * ── Детерминизм (критерий 3) ─────────────────────────────────────────────
 *
 * `readdirSync` порядок не гарантирует, поэтому имена каталогов сортируются
 * явно, а строки идут в порядке `root/phase`. Ни времени, ни случайности в
 * выводе нет: два прогона по тем же деревьям дают побайтово равный stdout.
 *
 * ── Разрешение соседнего скрипта ─────────────────────────────────────────
 *
 * Чекер ищется рядом с этим файлом через `import.meta.url`, а не в `$HOME`:
 * обзор обязан запускаться из чекаута репозитория ДО того, как капабилити
 * куда-либо установлена. Установленная копия при этом найдёт свою соседнюю.
 *
 * ── Коды выхода ──────────────────────────────────────────────────────────
 *
 *   0 — чисто
 *   1 — хотя бы одна фаза с находкой
 *   2 — хотя бы одну фазу не удалось проверить (или сам вызов негоден)
 *
 * Непойманное исключение обязано выходить как 2: по умолчанию Node выходит с
 * 1, что прочиталось бы как настоящая находка. Отсюда единственная точка
 * выхода внизу файла с catch-all — та же форма, что в `wave-normalize.mjs`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXIT_OK = 0;
const EXIT_FINDING = 1;
const EXIT_UNKNOWN = 2;

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(HERE, 'wave-normalize.mjs');

/**
 * Потолок вывода чекера на одну фазу.
 *
 * `--verbose` печатает stderr чекера дословно, а фаза с сотнями общих файлов
 * может выдать много. Обрезание по буферу — «не смог посмотреть», а не
 * «чисто», поэтому переполнение уходит в код 2, а не проглатывается.
 */
const MAX_CHECKER_OUTPUT_BYTES = 8 * 1024 * 1024;

const CHECKER_TIMEOUT_MS = 120000;

// ── разбор argv ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const verbose = argv.includes('--verbose');

/**
 * Собрать все значения повторяемого флага.
 *
 * `--root` без значения возвращает признак негодного вызова, а не молча ноль
 * корней: обследовать ничего — не то же самое, что обследовать и не найти.
 */
function collectRoots(args) {
  const out = [];
  let malformed = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--root') continue;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) {
      malformed = true;
      continue;
    }
    out.push(value);
    i++;
  }
  return { roots: out, malformed };
}

// ── обход ───────────────────────────────────────────────────────────────────

/**
 * Каталоги фаз внутри одного корня, отсортированные.
 *
 * Возвращает `null`, когда `.planning/phases` отсутствует — это «фаз нет», а
 * не «не удалось прочесть», и вызывающий обязан различать эти два случая.
 */
function phaseDirsOf(root) {
  const phasesRoot = join(root, '.planning', 'phases');
  if (!existsSync(phasesRoot)) return null;
  if (!statSync(phasesRoot).isDirectory()) return null;

  const entries = readdirSync(phasesRoot, { withFileTypes: true });
  // `readdirSync` порядок не гарантирует — сортируем явно (критерий 3).
  return [...entries]
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Запустить чекер на одной фазе.
 *
 * `execFileSync` с МАССИВОМ аргументов, а не `execSync` со строкой: пути
 * приходят из argv оператора и из листинга каталогов, то есть содержат что
 * угодно, включая пробелы и кавычки. Интерполяция их в шелл-строку — это
 * инъекция команд, а сортировка имён каталогов её ещё и делает
 * воспроизводимой.
 *
 * `execFileSync` бросает на любом ненулевом выходе, поэтому находка (код 1)
 * приходит сюда исключением. Разбираем `e.status`, а не считаем throw
 * ошибкой: у чекера ненулевой выход — это ответ, а не сбой.
 */
function runChecker(phaseDir, root) {
  const args = [CHECKER, '--dir', phaseDir, '--root', root, '--json'];
  const options = {
    encoding: 'utf8',
    maxBuffer: MAX_CHECKER_OUTPUT_BYTES,
    timeout: CHECKER_TIMEOUT_MS,
  };

  try {
    const stdout = execFileSync(process.execPath, args, options);
    return { status: EXIT_OK, stdout, stderr: '' };
  } catch (e) {
    // Ненулевой выход: `status` — ответ чекера, `stdout`/`stderr` собраны.
    if (typeof e.status === 'number') {
      return {
        status: e.status,
        stdout: typeof e.stdout === 'string' ? e.stdout : '',
        stderr: typeof e.stderr === 'string' ? e.stderr : '',
      };
    }
    // Ни кода, ни ответа: таймаут, переполнение буфера, не запустился. Это
    // «не смог посмотреть» — код 2, никогда не 1.
    return {
      status: EXIT_UNKNOWN,
      stdout: '',
      stderr: `checker did not report an exit code: ${e && e.message ? e.message : e}\n`,
    };
  }
}

/** Разобрать `--json` чекера. Непрочитанный JSON даёт `null`. */
function parseCheckerJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/**
 * Развернуть находки фазы в строки для `--verbose`.
 *
 * Берётся из РАЗОБРАННОГО `--json`, а не из stderr чекера: с `--json` чекер
 * пишет всё в stdout и stderr остаётся пустым, поэтому «дословный stderr»
 * дал бы под каждой строкой пустоту. Вдобавок JSON — типизированная
 * поверхность, а не текст отчёта, и не поедет при правке формулировок.
 *
 * Четыре заголовка сохраняются раздельно: лечение у каждого своё, и слияние
 * их — ровно то, что D-66 запрещает.
 */
function detailLines(parsed) {
  if (parsed === null) return [];
  const out = [];

  for (const c of parsed.collisions ?? []) {
    out.push(`COLLIDING PAIRS  WAVE ${c.wave}  ${c.a}  ⨯  ${c.b}`);
    for (const f of c.shared.slice(0, 8)) out.push(`  ${f}`);
    if (c.shared.length > 8) out.push(`  … and ${c.shared.length - 8} more`);
  }
  for (const n of parsed.declaredNothing ?? []) {
    out.push(`DECLARED NOTHING  ${n} — declared no files at all`);
  }
  for (const r of parsed.resolvedToNothing ?? []) {
    out.push(`RESOLVED TO NOTHING  ${r.plan} — ${r.kind} "${r.declared}" matched no files`);
  }
  for (const u of parsed.unparseable ?? []) {
    out.push(`UNPARSEABLE ENTRIES  ${u.plan} — not a path: "${u.declared}"`);
  }
  return out;
}

const VERDICT = { [EXIT_OK]: 'OK', [EXIT_FINDING]: 'FINDING', [EXIT_UNKNOWN]: 'ERROR' };

// ── отчёт ───────────────────────────────────────────────────────────────────

/** Фиксированная ширина колонки, без обрезания содержимого. */
function pad(text, width) {
  const s = String(text);
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderTable(rows, totals) {
  const rootWidth = Math.max(4, ...rows.map((r) => r.root.length));
  const phaseWidth = Math.max(5, ...rows.map((r) => r.phase.length));

  const lines = [];
  lines.push(`${pad('ROOT', rootWidth)}  ${pad('PHASE', phaseWidth)}  VERDICT  PAIRS`);
  lines.push(`${'-'.repeat(rootWidth)}  ${'-'.repeat(phaseWidth)}  -------  -----`);

  for (const r of rows) {
    lines.push(
      `${pad(r.root, rootWidth)}  ${pad(r.phase, phaseWidth)}  ${pad(r.verdict, 7)}  ${r.pairs}`,
    );
    // Находки под своей строкой — иначе оператор обязан перезапускать чекер
    // вручную, чтобы узнать, ЧТО именно найдено.
    if (verbose) {
      for (const line of r.detail) lines.push(`    ${line}`);
    }
  }

  lines.push('');
  lines.push(
    `${totals.phases} phase(s) across ${totals.roots} root(s): ` +
      `${totals.ok} OK, ${totals.finding} FINDING, ${totals.error} ERROR` +
      (totals.rootsWithoutPhases > 0
        ? ` (${totals.rootsWithoutPhases} root(s) carry no .planning/phases)`
        : ''),
  );
  return `${lines.join('\n')}\n`;
}

function main() {
  const { roots: declaredRoots, malformed } = collectRoots(argv);

  if (malformed) {
    process.stderr.write('UNKNOWN: wave-survey: --root requires a directory argument\n');
    return EXIT_UNKNOWN;
  }
  if (declaredRoots.length === 0) {
    process.stderr.write('UNKNOWN: wave-survey: at least one --root <dir> is required\n');
    return EXIT_UNKNOWN;
  }

  for (const root of declaredRoots) {
    if (!existsSync(root)) {
      process.stderr.write(`UNKNOWN: wave-survey: root not found: ${root}\n`);
      return EXIT_UNKNOWN;
    }
    if (!statSync(root).isDirectory()) {
      process.stderr.write(`UNKNOWN: wave-survey: root is not a directory: ${root}\n`);
      return EXIT_UNKNOWN;
    }
  }

  // Корни сортируются по разрешённому пути: порядок строк не должен зависеть
  // от того, в каком порядке оператор перечислил их в командной строке.
  const roots = [...declaredRoots].map((r) => resolve(r)).sort();

  const rows = [];
  let rootsWithoutPhases = 0;

  for (const root of roots) {
    let phases;
    try {
      phases = phaseDirsOf(root);
    } catch (e) {
      process.stderr.write(`UNKNOWN: wave-survey: cannot list phases under ${root}: ${e.message}\n`);
      return EXIT_UNKNOWN;
    }

    // Дерева без фаз попросту нечего обследовать. Ноль строк, код не растёт.
    if (phases === null) {
      rootsWithoutPhases++;
      continue;
    }

    for (const phase of phases) {
      const phaseDir = join(root, '.planning', 'phases', phase);
      const result = runChecker(phaseDir, root);
      let verdict = VERDICT[result.status] ?? 'ERROR';
      const parsed = parseCheckerJson(result.stdout);

      // Чекер сказал «находка», но его ответ не разобрался. Читать это как
      // ноль пар — значит превратить обрубленный ответ в чистый счёт: ровно
      // тот ложноотрицательный исход, который однажды уже стоил 40-файловой
      // коллизии её видимости. Нечитаемый ответ — это «не смог посмотреть».
      let unreadable = '';
      if (verdict !== 'ERROR' && parsed === null) {
        verdict = 'ERROR';
        unreadable =
          `checker exited ${result.status} but its --json did not parse ` +
          `(${result.stdout.length} bytes) — treating as could-not-check\n`;
      }

      const pairs = verdict === 'FINDING' ? (parsed.collisions?.length ?? 0) : 0;
      // У ERROR разобранного JSON нет — единственное свидетельство это stderr
      // чекера, и оно обязано доехать до оператора дословно.
      const detail =
        verdict === 'ERROR'
          ? [unreadable.trim(), result.stderr.trim()].filter(Boolean)
          : detailLines(parsed);
      rows.push({ root, phase, verdict, pairs, detail });
    }
  }

  const totals = {
    roots: roots.length,
    rootsWithoutPhases,
    phases: rows.length,
    ok: rows.filter((r) => r.verdict === 'OK').length,
    finding: rows.filter((r) => r.verdict === 'FINDING').length,
    error: rows.filter((r) => r.verdict === 'ERROR').length,
  };

  // Приоритет обратен интуиции и в этом весь смысл: непроверенное дерево не
  // может быть подытожено проверенной его частью.
  let code = EXIT_OK;
  if (totals.finding > 0) code = EXIT_FINDING;
  if (totals.error > 0) code = EXIT_UNKNOWN;

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ exitCode: code, rows, totals }, null, 2)}\n`);
    return code;
  }

  process.stdout.write(renderTable(rows, totals));
  return code;
}

try {
  // `process.exitCode`, а не `process.exit()` — та же причина, что в
  // `wave-normalize.mjs`: немедленный выход выбрасывает недослитый хвост
  // записи в трубу, а обзор по 55 каталогам легко перерастает её буфер.
  process.exitCode = main();
} catch (e) {
  // Единственный catch-all. Непойманное исключение по умолчанию выходит с 1,
  // что прочиталось бы как настоящая находка, — поэтому здесь ровно
  // `process.exit(2)`. Литерал, а не константа: этот выход и есть контракт
  // скрипта, и он должен читаться без перехода к определению.
  process.stderr.write(
    `UNKNOWN: wave-survey упал: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}\n`,
  );
  process.exitCode = 2;
}
