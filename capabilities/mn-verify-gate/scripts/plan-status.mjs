#!/usr/bin/env node
/**
 * Гейт: состояние планов фазы — читаемо ли оно вообще.
 *
 * Фаза 1 ввела словарь статусов, матрицу переходов и валидацию, и ничего из
 * этого никто не вызывает. Этот скрипт — первый вызывающий. Он осматривает
 * каждый `*-PLAN.md` в директории фазы и отказывается пропустить волну,
 * оставленную в состоянии, которое никто не может истолковать, — пропуская при
 * этом каждое состояние, истолкованию поддающееся.
 *
 * ── Зачем отдельный скрипт, а не встроенный предикат ────────────────────
 *
 * Напрашивается объявить гейт декларативно: `artifact-frontmatter-equals` по
 * полю `status`. Так нельзя. Установленный evaluator 1.9.1 знает ровно один
 * вид предиката — `command-exit-zero`; `artifact-frontmatter-equals`
 * документирован на `next`, но в релиз не попал, и гейт, объявляющий его,
 * halt'ится с «unknown predicate kind» ВМЕСТО того чтобы проверить
 * (`capabilities/mn-verify-gate/scripts/check-frontmatter.mjs:1-12`). Гейт,
 * который роняет прогон вместо проверки, хуже отсутствующего гейта. Отсюда
 * `.mjs` за `command-exit-zero` — единственная форма, которая на живом
 * evaluator'е действительно исполняется (D-26).
 *
 * ── Что считается находкой ──────────────────────────────────────────────
 *
 *   in_progress + нет SUMMARY   → НАХОДКА. Исполнитель ставит статус при
 *                                 старте и снимает при записи SUMMARY;
 *                                 остаток означает, что он не дожил до конца.
 *   значение вне словаря        → НАХОДКА. Никто не может его истолковать.
 *   blocked без причины         → НАХОДКА. Статус без причины не блокирует
 *                                 ничего — он лишь сообщает, что кто-то сдался.
 *   superseded без преемника    → НАХОДКА. Вытеснен — кем?
 *   blocked_reason выше потолка → НАХОДКА. Не обрезается и не сокращается.
 *
 * ── Что НАМЕРЕННО находкой НЕ является ──────────────────────────────────
 *
 * Две первые строки обратны наивному прочтению, и в них весь смысл гейта.
 *
 *   нет поля `status`           → ПРОХОДИТ. Отсутствие означает «не начинали».
 *                                 Примерно 1031 план уже лежит на дисках
 *                                 потребляющих деревьев без статуса; гейт,
 *                                 валящий их, выключат в день установки, и
 *                                 после этого он не защитит ничего.
 *   blocked + непустая причина  → ПРОХОДИТ. Заблокированный план — законный и
 *                                 корректно объявленный исход. Валить его
 *                                 значит блокировать ровно тот случай, ради
 *                                 которого статус вводился. Прецедент:
 *                                 `uat-open.mjs` пропускает пункт `failed`,
 *                                 потому что это известный и объявленный
 *                                 дефект, — против `blast-radius`, где пустое
 *                                 объявление И ЕСТЬ дефект. Разница в том, кто
 *                                 был обязан что-то объявить.
 *   superseded + преемник       → ПРОХОДИТ и пропускается мимо всех прочих
 *                                 правил, ровно как это уже делают
 *                                 `orphan-plans.mjs` и `src/plan-scan.cts:49-68`.
 *   done                        → ПРОХОДИТ без замечаний. Завершённость
 *                                 читается ИЗ НАЛИЧИЯ SUMMARY и только оттуда
 *                                 (D-05). Гейт не выводит завершённость из
 *                                 статуса и не сверяет их между собой ни в одну
 *                                 сторону: `status: done` без SUMMARY — не его
 *                                 находка, SUMMARY без статуса — тоже. Второй
 *                                 сигнал завершённости мог бы разойтись с
 *                                 первым, а два расходящихся читателя одного
 *                                 файла — это тот самый дефект, против которого
 *                                 весь словарь и заводился.
 *   пустая директория           → ПРОХОДИТ. Толковать нечего.
 *   только SUMMARY, без планов  → ПРОХОДИТ. Толковать нечего.
 *
 * ── Скоуп: ВСЯ директория, а не волна ───────────────────────────────────
 *
 * Проверяются все `*-PLAN.md` фазы, а не только планы завершившейся волны.
 * Принадлежность волне — поле frontmatter, которое пишет планировщик, а фаза 3,
 * которая сделала бы его достоверным, отложена. Гейт, фильтрующий по
 * недостоверному полю, молча недоохватывает — это ровно тот отказ
 * `passed-degraded`, который этот форк уже отказался принимать. Охват всей
 * директорией не может пропустить план и не стоит ничего: каждое условие здесь
 * является настоящим дефектом независимо от того, какая волна его породила.
 * Не «оптимизировать» обратно.
 *
 * ── Коды выхода ─────────────────────────────────────────────────────────
 *
 *   0 — чисто
 *   1 — находка
 *   2 — НЕ СМОГ ПРОВЕРИТЬ: нет `--dir`, каталога нет, каталог не читается,
 *       файл плана не читается, непойманное исключение.
 *
 * Различать 2 и 0 обязательно: «не проверял» — не «проверил и чисто». Непойманное
 * исключение обязано выходить как 2 и никогда как 1 — ложный halt хуже пропуска
 * (D-28). Прецедент: `loop-resolver.cts:545-559`, где синтетический блокирующий
 * гейт останавливал каждый `ship:pre` и был удалён целиком, а не сделан
 * неблокирующим.
 *
 *   node plan-status.mjs --dir <phase-dir> [--json] [--verbose]
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const PHASE_DIR = arg('dir');
const AS_JSON = has('json');
const VERBOSE = has('verbose');

const EXIT_OK = 0;
const EXIT_FINDING = 1;
const EXIT_UNKNOWN = 2;

/* ─────────────────────── копия словаря фазы 1 ───────────────────────
 *
 * Источник истины — `src/plan-status.cts`. Значения ДУБЛИРУЮТСЯ здесь, а не
 * импортируются, потому что этот файл ставится в
 * `~/.gsd/mn-verify-gate/scripts/` и исполняется как отдельный
 * процесс: до `src/` оттуда дотянуться нечем. Ту же конвенцию использует
 * `contract-drift.mjs:322`. Честность копии держит
 * `tests/plan-status-vocabulary-drift.test.cjs`.
 *
 * Матрица переходов НЕ копируется намеренно: этот гейт судит покоящееся
 * состояние и никогда — переход. Втащить сюда ту таблицу значило бы добавить
 * правило, которого никто не просил.
 */

/** src/plan-status.cts → PLAN_STATUSES */
const PLAN_STATUSES = ['in_progress', 'done', 'blocked', 'superseded'];

/** src/plan-status.cts → BLOCKED_REASON_MAX_LENGTH */
const BLOCKED_REASON_MAX_LENGTH = 2048;

/** src/plan-status.cts → PLAN_STATUS_COMPANION_FIELDS (те два, что обязательны) */
const BLOCKED_REASON_FIELD = 'blocked_reason';
const SUPERSEDED_BY_FIELD = 'superseded_by';

/**
 * Ограниченный префикс чтения. `src/plan-scan.cts:29` использует ровно этот
 * потолок по той же причине: frontmatter плана всегда лежит в байте 0 и
 * закрывается задолго до тела, поэтому втягивать в память патологически большой
 * закоммиченный файл ради одного ключа незачем.
 */
const PLAN_FRONTMATTER_READ_CAP = 64 * 1024;

/* ─────────────────────── чтение frontmatter ─────────────────────── */

/**
 * Ошибка «не смог проверить». Бросается вместо возврата кода, чтобы единственная
 * точка выхода внизу файла отличила её от находки.
 */
class UnknownError extends Error {}

/**
 * Прочитать frontmatter плана построчно.
 *
 * Построчно, а не регекспом по всему блоку: регексп, требующий `\n` после
 * записи, теряет последнюю строку frontmatter — её перевод строки съеден
 * закрывающим `---`. Этот дефект уже был пойман однажды в `wave-collision.mjs`
 * его собственным тестом; `orphan-plans.mjs` описывает его в тех же словах.
 *
 * Защита от нерегулярных файлов — `statSync().isFile()` ДО открытия. Символическая
 * ссылка на устройство вроде `/dev/zero` — закоммитируемый в git вектор DoS
 * (#2378/#2383), и `src/plan-scan.cts` защищается здесь ровно так же.
 */
function readFrontmatter(file) {
  let text;
  try {
    const st = statSync(file);
    if (!st.isFile()) return null;
    if (st.size === 0) return null;
    text = readFileSync(file, 'utf8').slice(0, PLAN_FRONTMATTER_READ_CAP);
  } catch (e) {
    throw new UnknownError(`не читается ${file}: ${e.message}`);
  }

  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};

  const out = {};
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(out, m[1])) continue;
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** Снять ПАРНЫЕ окружающие кавычки и ничего больше. */
function unquote(raw) {
  const v = raw.trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Нормализация статуса: `trim()` + `toLowerCase()` и НИЧЕГО больше.
 *
 * Ровно это делает `src/plan-scan.cts:67`. Более строгое правило здесь заставило
 * бы гейт отвергать файл, который `plan-scan` принимает, — два читателя,
 * расходящиеся об одном файле, и есть тот отказ, который словарь предотвращает.
 * Возвращает `null` для отсутствующего и для пустого после trim значения: `null`
 * означает «статус не объявлен», то есть НЕ НАЧИНАЛИ, что допустимо.
 */
function normalizeStatus(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return v === '' ? null : v;
}

/* ─────────────────────────── main ─────────────────────────── */

function main() {
  if (!PHASE_DIR) {
    console.error('UNKNOWN: plan-status: требуется --dir <phase-dir>');
    console.error('  usage: node plan-status.mjs --dir <phase-dir> [--json] [--verbose]');
    return EXIT_UNKNOWN;
  }
  if (!existsSync(PHASE_DIR)) {
    console.error(`UNKNOWN: plan-status: директория фазы не найдена: ${PHASE_DIR}`);
    return EXIT_UNKNOWN;
  }

  let entries;
  try {
    entries = readdirSync(PHASE_DIR, { withFileTypes: true });
  } catch (e) {
    console.error(`UNKNOWN: plan-status: не смог перечислить ${PHASE_DIR}: ${e.message}`);
    return EXIT_UNKNOWN;
  }

  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  const summaries = fileNames.filter((n) => /SUMMARY\.md$/.test(n));
  const plans = fileNames.filter((n) => /PLAN\.md$/.test(n));

  /**
   * Есть ли SUMMARY, относящийся к этому плану? Правило сопоставления по основе
   * — то же, что уже использует `orphan-plans.mjs` (`01-01-PLAN.md`
   * удовлетворяется любым `01-01-*SUMMARY.md`), чтобы два гейта не могли
   * разойтись об одной директории.
   */
  const hasSummary = (planName) => {
    const stem = planName.replace(/-?PLAN\.md$/, '');
    if (stem === '') return summaries.length > 0;
    return summaries.some((s) => s.startsWith(stem));
  };

  if (plans.length === 0) {
    if (VERBOSE) console.log('plan-status: планов здесь нет — толковать нечего');
    if (AS_JSON) console.log(JSON.stringify({ plans: 0, findings: [], passed: [] }, null, 2));
    return EXIT_OK;
  }

  const findings = [];
  const passed = [];
  const counts = { plans: plans.length, done: 0, superseded: 0, blocked: 0, noStatus: 0 };

  for (const name of plans.sort()) {
    const fm = readFrontmatter(join(PHASE_DIR, name));
    if (fm === null) {
      // Нерегулярный или пустой файл: толковать нечего, дефектом плана это не является.
      passed.push({ name, why: 'не обычный файл или пуст — толковать нечего' });
      continue;
    }

    const status = normalizeStatus(fm.status);
    const finished = hasSummary(name);

    if (status === null) {
      counts.noStatus++;
      passed.push({ name, why: 'статуса нет — не начинали, это допустимо' });
      continue;
    }

    // На каждый план — не более одной находки, чтобы один дефект давал одно
    // сообщение: та же дисциплина, что фаза 01-02 установила для правил-спутников.

    if (!PLAN_STATUSES.includes(status)) {
      findings.push({
        name,
        kind: 'unknown-status',
        detail:
          `status: ${status} — вне словаря. Допустимы только: ${PLAN_STATUSES.join(', ')}. ` +
          'Значение, которое никто не может истолковать, обязано валиться громко, а не деградировать в «наверное, нормально».',
      });
      continue;
    }

    // `superseded` пропускается мимо всех прочих правил — ровно так его уже
    // трактуют `orphan-plans.mjs` и `src/plan-scan.cts:49-68`.
    if (status === 'superseded') {
      if (typeof fm[SUPERSEDED_BY_FIELD] !== 'string' || fm[SUPERSEDED_BY_FIELD].trim() === '') {
        findings.push({
          name,
          kind: 'superseded-without-successor',
          detail: `status: superseded, но поля ${SUPERSEDED_BY_FIELD} нет — вытеснен кем?`,
        });
        continue;
      }
      counts.superseded++;
      passed.push({ name, why: `superseded → ${fm[SUPERSEDED_BY_FIELD]}` });
      continue;
    }

    if (status === 'blocked') {
      const rawReason = fm[BLOCKED_REASON_FIELD];
      if (typeof rawReason !== 'string') {
        findings.push({
          name,
          kind: 'blocked-without-reason',
          detail: `status: blocked, но поля ${BLOCKED_REASON_FIELD} нет — статус без причины не блокирует ничего`,
        });
        continue;
      }
      // Пустота меряется ПОСЛЕ trim: причина из одних пробелов отвергается как
      // пустая, а не принимается как сорок символов ничего. Тот же раздел, что
      // делает `validateBlockedReason` в `src/plan-status.cts`.
      if (rawReason.trim() === '') {
        findings.push({
          name,
          kind: 'blocked-with-empty-reason',
          detail: `status: blocked, но ${BLOCKED_REASON_FIELD} пуст после trim — причины нет`,
        });
        continue;
      }
      // Длина меряется на СЫРОЙ строке, ДО trim: файл несёт эти байты в любом
      // случае, и именно размер на диске конкурирует с ограниченным 64 KiB
      // префиксом, который читает `plan-scan`.
      //
      // Сообщается ТОЛЬКО измеренная длина и потолок — числами и ничем больше.
      // Содержимое причины не попадает ни в stdout, ни в stderr: нечитаемый
      // отчёт не должен суметь сойти за «нечего сообщить» (T-02-01).
      if (rawReason.length > BLOCKED_REASON_MAX_LENGTH) {
        findings.push({
          name,
          kind: 'blocked-reason-too-long',
          detail:
            `${BLOCKED_REASON_FIELD} длиной ${rawReason.length} символов при потолке ${BLOCKED_REASON_MAX_LENGTH}. ` +
            'Не обрезается и не сокращается: причина, которую нельзя прочитать, не является причиной.',
        });
        continue;
      }
      counts.blocked++;
      passed.push({ name, why: 'blocked с непустой причиной в пределах потолка — законный исход' });
      continue;
    }

    if (status === 'in_progress') {
      // Наличие SUMMARY проверяется ДО правила о зависшем in_progress: план с
      // SUMMARY завершён независимо от того, что написано в его статусе.
      if (finished) {
        counts.done++;
        passed.push({ name, why: 'in_progress, но SUMMARY есть — завершён' });
        continue;
      }
      findings.push({
        name,
        kind: 'stranded-in-progress',
        detail: 'объявляет status: in_progress, но SUMMARY нет — исполнитель начал и не дошёл до конца',
      });
      continue;
    }

    // Остаётся `done`. Проходит без замечаний и НЕ сверяется с наличием SUMMARY
    // ни в одну сторону: завершённость читается из SUMMARY и только оттуда.
    counts.done++;
    passed.push({ name, why: 'status: done' });
  }

  if (AS_JSON) {
    console.log(JSON.stringify({ ...counts, findings, passed: VERBOSE ? passed : undefined }, null, 2));
  }

  if (findings.length === 0) {
    if (!AS_JSON) {
      console.log(
        `plan-status: OK — ${counts.plans} план(ов): ${counts.done} завершено, ` +
          `${counts.superseded} вытеснено, ${counts.blocked} заблокировано, ${counts.noStatus} без статуса`,
      );
      if (VERBOSE) for (const p of passed) console.log(`  pass  ${p.name} — ${p.why}`);
    }
    return EXIT_OK;
  }

  process.stderr.write('\nplan-status: планы в состоянии, которое никто не может истолковать\n\n');
  for (const f of findings) {
    process.stderr.write(`  FINDING  ${f.name}\n`);
    process.stderr.write(`    ${f.detail}\n\n`);
  }
  process.stderr.write(
    `FAIL: ${findings.length} из ${counts.plans} план(ов) в нечитаемом состоянии.\n` +
      'Разблокировать — одно из трёх, по тому, что сказано выше:\n' +
      `  · дописать недостающее поле-спутник (${BLOCKED_REASON_FIELD} для blocked, ${SUPERSEDED_BY_FIELD} для superseded);\n` +
      `  · исправить статус на значение из словаря (${PLAN_STATUSES.join(', ')});\n` +
      '  · доисполнить план и записать его SUMMARY.\n',
  );
  return EXIT_FINDING;
}

let code;
try {
  code = main();
} catch (e) {
  if (e instanceof UnknownError) {
    console.error(`UNKNOWN: plan-status: ${e.message}`);
  } else {
    console.error(
      `UNKNOWN: plan-status упал: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`,
    );
  }
  code = EXIT_UNKNOWN;
}
process.exit(code);
