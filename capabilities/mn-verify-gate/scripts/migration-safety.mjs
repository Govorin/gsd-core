#!/usr/bin/env node
/**
 * Гейт: безопасность миграций БД, попавших в диапазон коммитов фазы.
 *
 * Зачем отдельно от schema-gate и drift. Оба существующих гейта смотрят на
 * СХЕМУ: schema-gate требует применить push (иначе типы приходят из конфига, а
 * не из живой БД), drift ловит расхождение схемы с деревом. Ни один не смотрит
 * на ДАННЫЕ и на обратимость. Миграция, роняющая колонку, зелена в обоих:
 * схема и код согласованы ровно потому, что колонка удалена всюду. Потеря
 * данных не является расхождением схемы — она является следствием согласованной
 * схемы, и увидеть её можно только читая сам SQL.
 *
 * Что проверяется:
 *  1. Необратимые без потери данных операции в новых .sql (DROP COLUMN/TABLE,
 *     несовместимый ALTER TYPE, ADD COLUMN NOT NULL без DEFAULT, SET NOT NULL,
 *     TRUNCATE, DROP CONSTRAINT/INDEX как lossy-предупреждение).
 *  2. Рассинхрон meta/_journal.json с .sql на диске. Файл мимо журнала = его
 *     писали руками; drizzle-kit его не применит и не учтёт в хеше, а
 *     следующий generate построит diff, не зная о нём.
 *
 * Контракт по умолчанию — ПРЕДУПРЕЖДАЮЩИЙ, не запрещающий. DROP COLUMN сам по
 * себе не дефект: колонка, чьи читатели мигрированы, обязана быть удалена, и
 * блокировать это значит блокировать нормальную эволюцию схемы. Дефект —
 * НЕЗАДЕКЛАРИРОВАННЫЙ DROP. Поэтому находка гасится явной декларацией в самом
 * .sql (маркеры ниже) либо в PLAN.md фазы: гейт требует, чтобы кто-то подумал,
 * а не чтобы операции не было.
 *
 * Маркеры-декларации в .sql (комментарий в любом месте файла):
 *   -- gsd:irreversible   — потеря данных осознана и принята
 *   -- gsd:backfill       — существующие строки заполняются здесь же
 *   -- gsd:reverse: <SQL> — записан обратный путь
 *   -- gsd:manual         — файл написан руками мимо drizzle-kit осознанно
 *
 *   node migration-safety.mjs --base <git-ref> [--dir <phase-dir>] [--root <repo>]
 *                             [--strict] [--all] [--json]
 *
 * exit 0 — безопасно (или всё задекларировано);
 * exit 1 — требует внимания (недекларированная необратимая операция / рассинхрон);
 * exit 2 — не смог проверить (нет git, нет базы сравнения, нечитаемый журнал).
 *          Отличать 2 от 0 обязательно: «не проверял» — не «проверил и чисто».
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename, relative, sep } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

const ROOT = arg('root', process.cwd());
const PHASE_DIR = arg('dir');
const BASE = arg('base');
const STRICT = has('strict');
const SCAN_ALL = has('all');
const AS_JSON = has('json');

const EXIT_OK = 0;
const EXIT_ATTENTION = 1;
const EXIT_UNKNOWN = 2;

const findings = [];
const notes = [];
const add = (sev, kind, file, detail) => findings.push({ sev, kind, file, detail });

/* ─────────────────────────── git-помощники ─────────────────────────── */

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitAvailable() {
  try {
    git(['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * База сравнения. Явный --base выигрывает всегда. Иначе пробуем ветку фазы
 * (origin/main / main), затем HEAD~1. Если ничего — возвращаем null, и это
 * exit 2, а не «изменений нет»: пустой список файлов от несуществующей базы
 * неотличим от чистой фазы, и молчаливый ноль здесь — ровно тот ложно-зелёный,
 * ради которого гейт заводится.
 */
function resolveBase() {
  if (BASE) {
    try {
      git(['rev-parse', '--verify', `${BASE}^{commit}`]);
      return BASE;
    } catch {
      notes.push(`--base "${BASE}" не разрешается в коммит`);
      return null;
    }
  }
  for (const cand of ['origin/main', 'main', 'origin/master', 'master', 'HEAD~1']) {
    try {
      git(['rev-parse', '--verify', `${cand}^{commit}`]);
      const head = git(['rev-parse', 'HEAD']).trim();
      const c = git(['rev-parse', `${cand}^{commit}`]).trim();
      if (c !== head || cand === 'HEAD~1') return cand;
    } catch {
      /* пробуем следующего */
    }
  }
  return null;
}

/** Новые/изменённые .sql миграции: diff базы с рабочим деревом + untracked. */
function changedSqlFiles(base) {
  const set = new Set();
  const collect = (out) =>
    out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => set.add(f));
  try {
    collect(git(['diff', '--name-only', '--diff-filter=ACMR', base, '--']));
  } catch {
    return null;
  }
  try {
    collect(git(['ls-files', '--others', '--exclude-standard']));
  } catch {
    /* необязательно */
  }
  return [...set].filter(isMigrationPath);
}

function isMigrationPath(p) {
  const norm = p.split(sep).join('/');
  return /\.sql$/i.test(norm) && /(^|\/)(drizzle|migrations?)(-[\w-]+)?\//i.test(norm) && !/\/meta\//.test(norm);
}

function scanAllMigrations() {
  const out = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.nx', 'tmp', 'coverage', '.venv']);
  (function walk(dir, depth) {
    if (depth > 12) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full, depth + 1);
      } else if (e.isFile() && e.name.endsWith('.sql')) {
        const rel = relative(ROOT, full);
        if (isMigrationPath(rel)) out.push(rel);
      }
    }
  })(ROOT, 0);
  return out;
}

/* ─────────────────────────── разбор SQL ─────────────────────────── */

/**
 * Убрать комментарии, dollar-quoted тела и строковые литералы.
 *
 * Это не косметика, а ядро точности. В миграциях пользователя обратный путь
 * принято записывать комментарием (`-- Reverse: ALTER TABLE ... DROP COLUMN`),
 * и наивный grep считает такую строку удалением колонки — то есть ругается
 * ровно на тот файл, автор которого как раз всё продумал. Проверено на корпусе:
 * до вырезания 18 «DROP», после — 15; три ложных были документацией отката.
 * Строковые литералы гасятся, чтобы `INSERT INTO log VALUES ('drop column')`
 * не считался DDL.
 */
function stripNoise(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' $BODY$ ')
    .replace(/\$([A-Za-z_]\w*)\$[\s\S]*?\$\1\$/g, ' $BODY$ ')
    .replace(/'(?:[^']|'')*'/g, "'S'");
}

/** Statement'ы: drizzle-kit ставит `--> statement-breakpoint`, но он комментарий. */
function statements(stripped) {
  return stripped
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const DECLARATIONS = {
  irreversible: /--\s*gsd:irreversible/i,
  backfill: /--\s*gsd:backfill/i,
  reverse: /--\s*gsd:reverse:/i,
  manual: /--\s*gsd:manual/i,
};

function declarationsIn(raw) {
  return Object.fromEntries(Object.entries(DECLARATIONS).map(([k, re]) => [k, re.test(raw)]));
}

/**
 * Совместимость расширения типа. text→varchar и varchar(n)→varchar(m>n) и
 * →text данные сохраняют; сужение и смена семейства — нет. Не ловим всё, но
 * ловим тот класс, где потеря молчаливая.
 */
function typeChangeSeverity(stmt) {
  const m = /ALTER\s+COLUMN\s+"?(\w+)"?\s+(?:SET\s+DATA\s+)?TYPE\s+([\w".()\[\]]+)/i.exec(stmt);
  if (!m) return null;
  const target = m[2].toLowerCase().replace(/"/g, '');
  const hasUsing = /\bUSING\b/i.test(stmt);
  const widening = /^(text|varchar|character varying|jsonb|bigint|numeric|double precision)/.test(target);
  if (widening && !hasUsing) return { sev: 'info', why: `расширение типа до ${target} — данные сохраняются` };
  if (hasUsing) return { sev: 'warn', why: `приведение через USING к ${target} — строки, не проходящие каст, потеряются или свалят миграцию` };
  return { sev: 'warn', why: `смена типа на ${target} без USING — PostgreSQL откажет либо приведёт неявно` };
}

/**
 * SQLite не умеет большинство ALTER TABLE, поэтому drizzle-kit генерирует
 * перестройку: CREATE TABLE `__new_x` → INSERT INTO `__new_x` SELECT … FROM `x`
 * → DROP TABLE `x` → ALTER TABLE `__new_x` RENAME TO `x`. Строки при этом
 * переносятся, и DROP здесь — середина безопасной последовательности, а не
 * потеря данных. Без этого исключения гейт ругался бы на КАЖДУЮ миграцию rpg
 * (единственный SQLite-домен), а гейт, который всегда красный, отучает читать
 * его вывод — это дороже, чем пропущенный DROP.
 *
 * Требуем полную последовательность: голый `DROP TABLE x` рядом с несвязанным
 * `__new_y` не должен гаситься.
 */
function sqliteRebuildTables(stmts) {
  const rebuilt = new Set();
  for (const s of stmts) {
    const m = /ALTER\s+TABLE\s+[`"']?__new_(\w+)[`"']?\s+RENAME\s+TO\s+[`"']?(\w+)[`"']?/i.exec(s);
    if (m && m[1] === m[2]) {
      const copied = stmts.some((x) => new RegExp(`INSERT\\s+INTO\\s+[\`"']?__new_${m[1]}[\`"']?`, 'i').test(x));
      if (copied) rebuilt.add(m[2]);
    }
  }
  return rebuilt;
}

/** `DROP TABLE IF EXISTS x` перед `CREATE TABLE x` — идемпотентный bootstrap. */
function isBootstrapDrop(stmt, stmts) {
  if (!/\bDROP\s+TABLE\s+IF\s+EXISTS\b/i.test(stmt)) return false;
  const m = /DROP\s+TABLE\s+IF\s+EXISTS\s+([\w."`]+)/i.exec(stmt);
  if (!m) return false;
  const name = m[1].replace(/["`]/g, '');
  return stmts.some((x) => new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["\`]?`, 'i').test(x));
}

function analyzeSql(relPath, raw) {
  const decl = declarationsIn(raw);
  const stripped = stripNoise(raw);
  const stmts = statements(stripped);
  const local = [];

  const createsOnly = !/\bALTER\s+TABLE\b|\bDROP\b/i.test(stripped);
  const rebuilt = sqliteRebuildTables(stmts);

  for (const s of stmts) {
    if (/\bDROP\s+TABLE\b/i.test(s)) {
      const m = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w."`]+)/i.exec(s);
      const name = m ? m[1].replace(/["`]/g, '') : '';
      if (rebuilt.has(name)) {
        local.push({ sev: 'info', kind: 'sqlite-table-rebuild', detail: `перестройка таблицы ${name}: строки перенесены через __new_${name}` });
        continue;
      }
      if (isBootstrapDrop(s, stmts)) {
        local.push({ sev: 'info', kind: 'bootstrap-drop', detail: `DROP TABLE IF EXISTS + CREATE TABLE ${name} — идемпотентный bootstrap` });
        continue;
      }
      local.push({ sev: 'high', kind: 'drop-table', detail: s.slice(0, 160) });
    }
    if (/\bDROP\s+COLUMN\b/i.test(s)) {
      local.push({ sev: 'high', kind: 'drop-column', detail: s.slice(0, 160) });
    }
    if (/\bTRUNCATE\b/i.test(s)) {
      local.push({ sev: 'high', kind: 'truncate', detail: s.slice(0, 160) });
    }
    if (/\bDELETE\s+FROM\b/i.test(s) && !/\bWHERE\b/i.test(s)) {
      local.push({ sev: 'high', kind: 'delete-all', detail: s.slice(0, 160) });
    }
    // ADD COLUMN ... NOT NULL без DEFAULT: на пустой таблице безопасно, на
    // непустой — миграция падает. Мы не знаем населённость БД, поэтому это
    // всегда «требует внимания», и снимается декларацией backfill.
    //
    // Послабление даёт не номер файла, а то, что таблицу создают ЗДЕСЬ ЖЕ:
    // в свежесозданной таблице строк нет по определению. Ориентироваться на
    // префикс 0000_ было ошибкой — ALTER TABLE в 0000_ бьёт по таблице,
    // созданной раньше (или вне drizzle), и там строки быть могут.
    if (/\bADD\s+COLUMN\b/i.test(s) && /\bNOT\s+NULL\b/i.test(s) && !/\bDEFAULT\b/i.test(s) && !/\bGENERATED\b/i.test(s)) {
      const tm = /ALTER\s+TABLE\s+(?:ONLY\s+)?([\w."`]+)/i.exec(s);
      const tbl = tm ? tm[1].replace(/["`]/g, '').split('.').pop() : null;
      const createdHere =
        tbl &&
        stmts.some((x) => new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?["\`]?(\\w+\\.)?["\`]?${tbl}["\`]?\\s*\\(`, 'i').test(x));
      local.push({
        sev: createdHere ? 'info' : 'high',
        kind: 'notnull-no-default',
        detail: s.slice(0, 160),
      });
    }
    if (/\bSET\s+NOT\s+NULL\b/i.test(s)) {
      local.push({ sev: 'high', kind: 'set-not-null', detail: s.slice(0, 160) });
    }
    const tc = typeChangeSeverity(s);
    if (tc) local.push({ sev: tc.sev, kind: 'type-change', detail: `${tc.why} :: ${s.slice(0, 120)}` });
    if (/\bDROP\s+CONSTRAINT\b/i.test(s)) {
      local.push({ sev: 'info', kind: 'drop-constraint', detail: s.slice(0, 140) });
    }
  }

  const hasBackfill = /\bUPDATE\b[\s\S]{0,4000}?\bSET\b/i.test(stripped) || /\bINSERT\s+INTO\b/i.test(stripped);
  return { decl, local, createsOnly, hasBackfill, statementCount: stmts.length };
}

/* ─────────────────────── журнал drizzle ─────────────────────── */

function journalDirsFor(files) {
  const dirs = new Set();
  for (const f of files) dirs.add(dirname(join(ROOT, f)));
  return [...dirs];
}

function checkJournal(migDir) {
  const jp = join(migDir, 'meta', '_journal.json');
  const relDir = relative(ROOT, migDir);
  if (!existsSync(jp)) {
    notes.push(`нет meta/_journal.json в ${relDir} — каталог не управляется drizzle-kit`);
    return { checked: false };
  }
  let journal;
  try {
    journal = JSON.parse(readFileSync(jp, 'utf8'));
  } catch (e) {
    add('high', 'journal-unreadable', `${relDir}/meta/_journal.json`, String(e.message).slice(0, 120));
    return { checked: false };
  }
  const entries = Array.isArray(journal.entries) ? journal.entries : [];
  const tags = new Set(entries.map((e) => e.tag));
  let disk;
  try {
    disk = readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    return { checked: false };
  }

  const orphans = disk.filter((f) => !tags.has(f.replace(/\.sql$/, '')));
  const missing = [...tags].filter((t) => !disk.includes(`${t}.sql`));

  // Дубли числового префикса: два файла 0014_* — сигнал, что нумерацию вели
  // параллельно две ветки или две руки. Drizzle сортирует по префиксу и
  // порядок применения между ними не определён.
  const byPrefix = new Map();
  for (const f of disk) {
    const p = f.slice(0, 4);
    byPrefix.set(p, [...(byPrefix.get(p) || []), f]);
  }
  const dupPrefix = [...byPrefix.entries()].filter(([, v]) => v.length > 1);

  if (orphans.length) {
    const undeclared = orphans.filter((f) => {
      try {
        return !DECLARATIONS.manual.test(readFileSync(join(migDir, f), 'utf8'));
      } catch {
        return true;
      }
    });
    if (undeclared.length) {
      add(
        'high',
        'journal-desync',
        relDir,
        `${undeclared.length} .sql на диске отсутствуют в _journal.json (журнал знает ${entries.length}, на диске ${disk.length}): ` +
          `${undeclared.slice(0, 6).join(', ')}${undeclared.length > 6 ? ` …+${undeclared.length - 6}` : ''}`
      );
    }
  }
  if (missing.length) {
    add('high', 'journal-missing-file', relDir, `журнал ссылается на отсутствующие файлы: ${missing.join(', ')}`);
  }
  if (dupPrefix.length) {
    add(
      'warn',
      'duplicate-index',
      relDir,
      `дублирующиеся номера миграций (порядок применения не определён): ${dupPrefix.map(([k, v]) => `${k}×${v.length}`).join(', ')}`
    );
  }
  return { checked: true, journalCount: entries.length, diskCount: disk.length, orphans, missing };
}

/* ─────────────────────── PLAN.md как декларация ─────────────────────── */

/**
 * Фаза могла обосновать необратимость в плане, а не в SQL. Ищем в артефактах
 * фазы явное упоминание отката/бэкфилла — этого достаточно, чтобы считать
 * «человек подумал». Намеренно широкий матч: цель гейта — заставить подумать,
 * а не навязать формулировку.
 */
function phaseDeclaresMigrationThinking() {
  if (!PHASE_DIR || !existsSync(PHASE_DIR)) return false;
  let files;
  try {
    files = readdirSync(PHASE_DIR).filter((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
  const re = /(backfill|бэкфилл|обратим|необратим|rollback|откат миграц|reverse migration|down-миграц)/i;
  for (const f of files) {
    try {
      if (re.test(readFileSync(join(PHASE_DIR, f), 'utf8'))) return true;
    } catch {
      /* пропускаем нечитаемое */
    }
  }
  return false;
}

/* ─────────────────────────── main ─────────────────────────── */

function main() {
  if (!existsSync(ROOT)) {
    console.error(`UNKNOWN: --root не существует: ${ROOT}`);
    return EXIT_UNKNOWN;
  }

  let files;
  if (SCAN_ALL) {
    files = scanAllMigrations();
    notes.push(`режим --all: просканировано ${files.length} миграций во всём дереве`);
  } else {
    if (!gitAvailable()) {
      console.error('UNKNOWN: git недоступен — диапазон фазы определить нечем');
      return EXIT_UNKNOWN;
    }
    const base = resolveBase();
    if (!base) {
      console.error(
        'UNKNOWN: не найдена база сравнения (--base <ref>). Пустой список изменений от несуществующей базы неотличим от чистой фазы — не выдаём зелёный.'
      );
      notes.forEach((n) => console.error(`  note: ${n}`));
      return EXIT_UNKNOWN;
    }
    files = changedSqlFiles(base);
    if (files === null) {
      console.error(`UNKNOWN: git diff против ${base} не выполнился`);
      return EXIT_UNKNOWN;
    }
    notes.push(`база сравнения: ${base}`);
  }

  if (files.length === 0) {
    console.log('OK: миграций в скоупе фазы нет — проверять нечего');
    notes.forEach((n) => console.log(`  note: ${n}`));
    return EXIT_OK;
  }

  const planCovers = phaseDeclaresMigrationThinking();

  for (const rel of files) {
    const abs = join(ROOT, rel);
    let raw;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      raw = readFileSync(abs, 'utf8');
    } catch (e) {
      add('warn', 'unreadable', rel, String(e.message).slice(0, 100));
      continue;
    }
    const a = analyzeSql(rel, raw);

    if (a.statementCount === 0) {
      add('warn', 'empty-migration', rel, 'после вырезания комментариев не осталось ни одного statement');
      continue;
    }

    // Свернуть повторы одного вида в одну находку на файл. 0007_rapid_nico_minoru
    // роняет шесть колонок одним решением автора — шесть одинаковых строк в
    // выводе не добавляют информации, а создают ощущение вала, из-за которого
    // гейт начинают проматывать. Решение одно — и строка про него одна.
    const collapsed = [];
    for (const f of a.local) {
      const prev = collapsed.find((c) => c.kind === f.kind && c.sev === f.sev);
      if (prev) {
        prev.count += 1;
        if (prev.count <= 3) prev.detail += `\n      + ${f.detail}`;
      } else {
        collapsed.push({ ...f, count: 1 });
      }
    }
    for (const c of collapsed) if (c.count > 3) c.detail += `\n      … ещё ${c.count - 3} того же вида`;

    for (const f of collapsed) {
      // Гашение декларациями. Разные операции гасятся разными декларациями:
      // NOT NULL закрывается бэкфиллом (в файле или заявленным), DROP —
      // признанием необратимости или записанным обратным путём.
      const silencedByBackfill =
        (f.kind === 'notnull-no-default' || f.kind === 'set-not-null') && (a.decl.backfill || a.hasBackfill);
      const silencedByReverse = a.decl.irreversible || a.decl.reverse;
      const silenced = f.sev === 'info' || silencedByBackfill || silencedByReverse || (planCovers && !STRICT);

      if (!silenced) add(f.sev, f.count > 1 ? `${f.kind}×${f.count}` : f.kind, rel, f.detail);
      else if (STRICT && f.sev === 'high' && !(a.decl.irreversible || a.decl.reverse || a.decl.backfill)) {
        add('warn', `${f.kind}(undeclared-in-sql)`, rel, f.detail);
      }
    }
  }

  for (const d of journalDirsFor(files)) checkJournal(d);

  const high = findings.filter((f) => f.sev === 'high');
  const warn = findings.filter((f) => f.sev === 'warn');

  if (AS_JSON) {
    console.log(JSON.stringify({ files: files.length, findings, notes, planCovers }, null, 2));
  } else {
    console.log(`migration-safety: проверено ${files.length} .sql${planCovers ? ' (артефакты фазы обсуждают миграцию)' : ''}`);
    notes.forEach((n) => console.log(`  note: ${n}`));
    for (const f of findings) {
      const tag = f.sev === 'high' ? 'ATTENTION' : f.sev === 'warn' ? 'warn' : 'info';
      console.log(`  [${tag}] ${f.kind} — ${f.file}\n      ${f.detail}`);
    }
  }

  if (high.length) {
    console.error(
      `\nFAIL: ${high.length} операц(ий), необратимых без потери данных или не заявленных в журнале.\n` +
        'Разблокировать: заявить решение в самом .sql — `-- gsd:irreversible`, `-- gsd:backfill`,\n' +
        '`-- gsd:reverse: <SQL>`, `-- gsd:manual` — либо описать откат и бэкфилл в PLAN.md фазы.\n' +
        'Гейт требует не отсутствия операции, а того, чтобы кто-то за неё отвечал.'
    );
    return EXIT_ATTENTION;
  }
  if (warn.length && STRICT) {
    console.error(`\nFAIL (--strict): ${warn.length} предупреждени(й) требуют явной декларации.`);
    return EXIT_ATTENTION;
  }
  console.log(`\nOK: необратимых незадекларированных операций не найдено${warn.length ? ` (${warn.length} предупреждений)` : ''}`);
  return EXIT_OK;
}

let code;
try {
  code = main();
} catch (e) {
  console.error(`UNKNOWN: migration-safety упал: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`);
  code = EXIT_UNKNOWN;
}
process.exit(code);
