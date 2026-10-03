#!/usr/bin/env node
/**
 * Blast-radius tripwire — сверка ФАКТА изменений с ДЕКЛАРАЦИЕЙ фазы.
 *
 * ── Почему расхождение важнее абсолютного числа ──────────────────────────
 *
 * Соблазн очевиден: поставить `--max-files 50` и блокировать превышение. Это
 * не работает, и вот почему.
 *
 * Абсолютное число не несёт информации о правильности. Фаза «01-types-
 * foundation» законно трогает 180 файлов — это её работа, каждый файл заявлен
 * в PLAN.md. Фаза «03-ports» законно трогает 40. Единого порога, отделяющего
 * здоровую большую фазу от разъехавшегося агента, не существует: порог,
 * который пропустит первую, пропустит любой разнос, а порог, который поймает
 * разнос, будет валить каждую крупную фазу. Порог, срабатывающий ложно,
 * приучает игнорировать блокировки — и тогда он хуже, чем его отсутствие.
 *
 * Расхождение информацию несёт. `files_modified` в PLAN.md — это заявление
 * планировщика о намерении, сделанное ДО работы и проверенное plan-checker'ом.
 * Файл, изменённый, но не заявленный ни в одном плане фазы, означает ровно
 * одно из двух:
 *
 *   (а) исполнитель ушёл за границы задачи — тот самый «идём не туда»,
 *       который в 3 часа ночи никто не читает; либо
 *   (б) план был неполон, и никто этого не заметил — дефект планирования,
 *       который надо зафиксировать, пока фаза свежая.
 *
 * Оба случая требуют человеческого взгляда, и оба невидимы для тестов, линта
 * и типов: незаявленная правка компилируется и проходит гейты ровно так же,
 * как заявленная. Это класс отказа, который не ловит НИЧТО другое — ровно как
 * удалённый ассерт для assertion-ratchet.
 *
 * Отсюда контракт: расхождение — БЛОКИРУЕТ, объём — только ОТЧЁТ. Пороги
 * `--max-files` / `--max-lines` печатают строку «OVER BUDGET» и не влияют на
 * exit-код без `--strict-budget`. Число полезно утром как приоритет чтения
 * («фаза 05 разнесла 300 файлов — начни с неё»), но не как приговор.
 *
 * ── Асимметрия направлений ──────────────────────────────────────────────
 *
 * Файл заявлен, но не изменён — НЕ ошибка. Планировщик заявляет намерение;
 * исполнитель законно обнаруживает, что правка не нужна (файл уже верен,
 * задача решена иначе). Блокировать за это значит требовать изменений ради
 * отчётности. Печатаем как `undelivered` (полезно для верификации: заявленный
 * артефакт, которого нет, часто означает недоделанную задачу), но не валим.
 *
 * ── Определение базы фазы ───────────────────────────────────────────────
 *
 * Проверены три стратегии на реальной истории apps/rpg (341 коммита):
 *
 *   1. `git merge-base` — не годится: автономный прогон коммитит в одну ветку,
 *      разветвления нет, merge-base с самим собой = HEAD, диапазон пуст.
 *   2. Тег фазы — не существует: GSD тегов не ставит.
 *   3. Conventional-commit скоуп (`feat(03-xx):`) — ОПАСНО. Проверено: скоуп
 *      `03` в этом монорепо принадлежит одновременно rpg (`docs(03): capture
 *      phase 03 ports context`) и savor (`feat(03-02): age-gate server`).
 *      Отбор по скоупу склеил бы две несвязанные фазы разных проектов в один
 *      диапазон и выдал бы сотни ложных «незаявленных» файлов.
 *
 * Работающая стратегия — ЯКОРЬ ПО ПУТИ: коммиты, тронувшие саму директорию
 * фазы (`apps/rpg/.planning/phases/03-ports`). Путь уникален по построению,
 * коллизий скоупов не бывает.
 *
 * ⚠ Но диапазон `base..head` по этим коммитам ТОЖЕ неверен, и это измерено.
 * В монорепо ветка одна, и работа проектов ЧЕРЕДУЕТСЯ: между первым и
 * последним коммитом фазы 03 (rpg) лежат 27 коммитов, из которых rpg трогают
 * только 3 — остальные 24 это polyglot phases 39/40/41. Диапазон дал 147
 * файлов и 95 «незаявленных», из которых НИ ОДИН не имел отношения к rpg.
 * Гейт, срабатывающий на чужой работе, — ровно тот шум, который приучает
 * игнорировать блокировки.
 *
 * Поэтому считаем не диапазон, а ОБЪЕДИНЕНИЕ ДИФФОВ ОТОБРАННЫХ КОММИТОВ:
 * `git show --numstat` по каждому отобранному коммиту. Чередование перестаёт
 * существовать как проблема: чужой коммит просто не попадает в выборку.
 *
 * Отбор двухступенчатый, и вторая ступень обязательна. Исполнитель GSD
 * коммитит код и документы РАЗДЕЛЬНО (`feat(rpg-02-09):` трогает только
 * `libs/rpg/**`, `docs(rpg-02-09):` — только `.planning/**`), поэтому якорь по
 * пути видит одни документы. Измерено: на фазах 02 и 06 это давало
 * `changed=0` при 73 и 69 заявленных файлах — PASS, не посмотрев ни на один
 * файл. Ложно-зелёный здесь опаснее ложно-красного: он выглядит как
 * доказательство, которым не является. Вторая ступень добавляет коммиты с тем
 * же conventional-commit скоупом, ВЫЧИТАННЫМ из якорных коммитов (не
 * угаданным) — см. комментарий у `collectNumstat`.
 *
 * Порядок разрешения: `--base <ref>` (явное, диапазонный режим для «прямо
 * сейчас идущей» фазы) → отбор коммитов по якорю пути → рабочее дерево
 * (последний рубеж, когда фаза ещё ничего не коммитила).
 *
 * ── Прочие грабли, унаследованные от assertion-ratchet ───────────────────
 *
 * • git-root anchoring: гейт запускается из директории проекта (apps/rpg),
 *   а `git diff` обязан считаться от корня монорепо — иначе пути в numstat
 *   относительны не к тому, и сверка с files_modified (которые записаны от
 *   корня репо) промахивается на 100%.
 * • Ноль PLAN.md — ОТКАЗ, не пропуск. Фаза без планов не декларировала
 *   ничего, и «расхождений нет» здесь читается как зелёный, хотя проверять
 *   было нечего. Пустая декларация обязана быть отказом, а не тишиной.
 * • Обход дерева своими силами, без `rg`: в этом окружении `rg` —
 *   shell-функция, дочерний процесс её не видит.
 *
 *   node blast-radius.mjs --dir <phase-dir> [--base <ref>] \
 *                         [--max-files N] [--max-lines N] \
 *                         [--strict-budget] [--json]
 *
 * exit 0 — факт совпал с декларацией (объём мог превысить бюджет).
 * exit 1 — расхождение: изменены файлы, не заявленные ни в одном PLAN.md
 *          (либо --strict-budget и бюджет превышен).
 * exit 2 — гейт не смог выполниться: нет директории, нет планов, не git.
 *          Отдельный код: «не смог проверить» ≠ «проверил и всё плохо».
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const dirArg = arg('dir');
const baseArg = arg('base');
const maxFiles = Number(arg('max-files', '0')) || 0;
const maxLines = Number(arg('max-lines', '0')) || 0;
const strictBudget = has('strict-budget');
const asJson = has('json');

if (!dirArg) {
  console.error('usage: --dir <phase-dir> [--base <ref>] [--max-files N] [--max-lines N] [--strict-budget] [--json]');
  process.exit(2);
}

/** Ровно один канал вывода — чтобы --json оставался машиночитаемым. */
const log = (...a) => {
  if (!asJson) console.log(...a);
};

// ── git root ─────────────────────────────────────────────────────────────
// Гейт запускается из директории проекта; diff обязан считаться от корня
// монорепо, иначе пути в numstat не сойдутся с files_modified.
let repoRoot;
try {
  repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  console.error('FAIL: not a git repository — blast radius is undefined without history.');
  process.exit(2);
}

const git = (args) =>
  execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const phaseDir = resolve(process.cwd(), dirArg);
if (!existsSync(phaseDir) || !statSync(phaseDir).isDirectory()) {
  console.error(`FAIL: phase dir not found: ${phaseDir}`);
  process.exit(2);
}

// Путь фазы относительно корня репо — это и якорь для поиска коммитов,
// и префикс, по которому планировочные артефакты исключаются из сверки.
const phaseRel = relative(repoRoot, phaseDir).split(sep).join('/');

// ── 1. Декларация: объединение files_modified из всех PLAN.md фазы ───────

/**
 * files_modified — плоский YAML-список строк в frontmatter:
 *   files_modified:
 *     - libs/rpg/ports/project.json
 * Полноценный YAML-парсер здесь избыточен и добавил бы зависимость гейту,
 * который обязан запускаться без установки. Читаем ровно эту форму, а всё,
 * что на неё не похоже (вложенность, inline-массив), считаем концом списка.
 */
function declaredFiles(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return [];
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^files_modified:\s*$/.test(l));
  if (start === -1) {
    // Inline-форма: files_modified: [a, b]
    const inline = /^files_modified:\s*\[(.*)\]\s*$/m.exec(fm[1]);
    if (!inline) return [];
    return inline[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    // Пустая строка внутри блока его НЕ закрывает: это легальный YAML, и в
    // одном живом проекте так оформлены 17 планов из 96. Трактовка «конец
    // списка» превращала такой план в «ничего не заявлено».
    if (lines[i].trim() === '') continue;
    const m = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) break; // первая строка не-элемента закрывает список
    out.push(m[1].replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, ''));
  }
  return out;
}

const planFiles = readdirSync(phaseDir)
  .filter((f) => f.endsWith('PLAN.md'))
  .sort();

if (planFiles.length === 0) {
  console.error(`FAIL: no PLAN.md in ${phaseRel} — the phase declared nothing to compare against.`);
  console.error('An empty declaration must be a refusal, not a silent pass: there was nothing to check.');
  process.exit(2);
}

const declared = new Map(); // path -> [plan files declaring it]
for (const p of planFiles) {
  for (const f of declaredFiles(readFileSync(join(phaseDir, p), 'utf8'))) {
    const norm = f.replace(/^\.\//, '').replace(/^\/+/, '');
    if (!declared.has(norm)) declared.set(norm, []);
    declared.get(norm).push(p);
  }
}

if (declared.size === 0) {
  console.error(`FAIL: ${planFiles.length} PLAN.md file(s) in ${phaseRel}, none carrying files_modified.`);
  console.error('Refusing to report "no drift" against an empty declaration — nothing was actually compared.');
  process.exit(2);
}

// ── 2. База фазы ────────────────────────────────────────────────────────

/**
 * Возвращает сырые numstat-блоки, составляющие фактический радиус фазы.
 * Два режима — потому что «фаза уже закоммичена» и «фаза идёт прямо сейчас»
 * это разные вопросы к git, и склеивать их в один диапазон нельзя.
 */
function collectNumstat() {
  // Явная база: диапазонный режим. Осознанно грубее отбора по коммитам —
  // применяется, когда фаза ещё не закоммичена и отбирать нечего.
  if (baseArg) {
    let sha;
    try {
      sha = git(['rev-parse', '--verify', `${baseArg}^{commit}`]).trim();
    } catch {
      console.error(`FAIL: --base ${baseArg} is not a resolvable commit.`);
      process.exit(2);
    }
    return {
      blocks: [git(['diff', '--numstat', sha, 'HEAD'])],
      how: `--base ${baseArg} (range mode; interleaved commits from other projects are NOT filtered out)`,
      commits: null,
    };
  }

  // Отбор коммитов по якорю пути. Скоуп conventional-commit НЕ используется
  // намеренно: в этом монорепо `03` принадлежит и rpg, и savor одновременно.
  let commits = [];
  try {
    commits = git(['log', '--format=%H', '--all', '--', phaseRel]).split('\n').filter(Boolean);
  } catch {
    commits = [];
  }

  if (commits.length > 0) {
    // ── Коммиты кода: сиблинги по скоупу ──────────────────────────────
    //
    // Одного якоря по пути НЕДОСТАТОЧНО, и это измерено. Исполнитель GSD
    // коммитит код и планировочные документы РАЗДЕЛЬНО:
    //   feat(rpg-02-09): SkillEntity schema      ← только libs/rpg/**
    //   docs(rpg-02-09): complete plan + SUMMARY ← только .planning/**
    // Якорь по пути видит лишь второй. На фазах 02 и 06 это давало
    // `changed=0` при 73 и 69 заявленных файлах — гейт рапортовал PASS,
    // не посмотрев ни на один файл. Ложно-зелёный опаснее ложно-красного:
    // он выглядит как доказательство, которым не является.
    //
    // Скоуп мы не угадываем, а ВЫЧИТЫВАЕМ из уже отобранных по пути
    // коммитов — поэтому коллизия `03` между rpg и savor не воспроизводится:
    // якорные коммиты rpg дают `rpg-02-09` и `rpg-03`, savor'овские — свои.
    // Голый числовой скоуп (`docs(03):`) отбрасывается: он неквалифицирован
    // и в этом монорепо заведомо неоднозначен.
    const scopes = new Set();
    for (const c of commits) {
      const subject = git(['log', '-1', '--format=%s', c]).trim();
      const m = /^[a-z]+\(([^)]+)\)/i.exec(subject);
      if (!m) continue;
      const scope = m[1];
      // Квалифицированным считаем скоуп, содержащий не только цифры/точки:
      // `rpg-02-09` — да, `03` или `3.4.12` — нет.
      if (/[a-z]/i.test(scope)) scopes.add(scope);
    }

    const selected = new Set(commits);
    if (scopes.size > 0) {
      // `%H %s` одним проходом по истории — дешевле, чем log на каждый скоуп.
      const all = git(['log', '--format=%H\t%s', '--all']).split('\n');
      for (const line of all) {
        const tab = line.indexOf('\t');
        if (tab === -1) continue;
        const sha = line.slice(0, tab);
        const subj = line.slice(tab + 1);
        const m = /^[a-z]+\(([^)]+)\)/i.exec(subj);
        if (m && scopes.has(m[1])) selected.add(sha);
      }
    }

    // Объединение диффов ОТОБРАННЫХ коммитов, а не диапазон между крайними.
    // Диапазон в монорепо с чередующейся работой втягивает чужие проекты:
    // измерено — 27 коммитов между крайними фазы 03, из них к ней относятся 3.
    // `-m --first-parent` разворачивает merge-коммиты относительно первой
    // ветки: без этого merge отдаёт пустой numstat и его работа теряется.
    const list = [...selected];
    const blocks = list.map((c) => git(['show', '--format=', '--numstat', '-m', '--first-parent', c]));
    return {
      blocks,
      how:
        `path-anchored on ${phaseRel} (${commits.length} commit(s)) + ` +
        `${list.length - commits.length} scope-sibling(s) [${[...scopes].join(', ') || 'none'}]`,
      commits: list,
    };
  }

  // Фаза ещё ничего не закоммитила — радиус целиком в рабочем дереве.
  return {
    blocks: [],
    how: 'working tree only — phase dir has no commits yet',
    commits: [],
  };
}

const { blocks, how, commits } = collectNumstat();

// ── 3. Факт: numstat ────────────────────────────────────────────────────

/**
 * Незакоммиченная работа входит в радиус ТОЛЬКО когда фаза ещё не коммитила
 * (идёт прямо сейчас) или база задана явно.
 *
 * Для завершённой фазы грязное дерево — чужое. Измерено: на этом репозитории
 * рабочее дерево содержит правки параллельного агента (миграция polyglot) плюс
 * общерепозиторный дрейф `.planning/**` — и подмешивание их в диффы давало
 * одинаковые 5-7 «незаявленных» файлов во ВСЕХ девяти фазах rpg сразу.
 * Одинаковое нарушение везде — верный признак, что виноват измеритель, а не
 * измеряемое: фаза, закрытая в апреле, не могла тронуть файл, изменённый
 * сегодня. Гейт, обвиняющий каждую фазу в чужой работе, читается как
 * сломанный и обесценивает настоящие находки.
 */
const includeDirty = Boolean(baseArg) || (commits !== null && commits.length === 0);
let dirty = '';
if (includeDirty) {
  try {
    dirty = git(['diff', '--numstat', 'HEAD']);
  } catch {
    /* пустое дерево или отсутствие HEAD — просто нет грязных правок */
  }
}

const changed = new Map(); // path -> {added, deleted}
for (const line of [...blocks, dirty].join('\n').split('\n')) {
  if (!line.trim()) continue;
  const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  if (!m) continue;
  // Переименование: `old => new` или `dir/{a => b}/f`. Считаем целевой путь —
  // именно он существует после фазы и именно его заявляет план.
  let path = m[3];
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (brace) path = `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/');
  else if (path.includes(' => ')) path = path.split(' => ')[1];

  const added = m[1] === '-' ? 0 : Number(m[1]);
  const deleted = m[2] === '-' ? 0 : Number(m[2]);
  const prev = changed.get(path) || { added: 0, deleted: 0 };
  changed.set(path, { added: prev.added + added, deleted: prev.deleted + deleted });
}

// ── 4. Сверка ───────────────────────────────────────────────────────────

/**
 * Планировочные артефакты (.planning/**) исключены из сверки. Их пишет сам
 * GSD — PLAN.md, SUMMARY.md, STATE.md, ROADMAP.md — и ни один план не
 * декларирует собственное создание. Требовать этого значило бы утопить
 * сигнал в шуме, который заведомо ожидаем.
 */
const isPlanningArtifact = (p) => p.includes('/.planning/') || p.startsWith('.planning/');

const undeclared = [];
const matched = [];
for (const [path, stat] of changed) {
  if (isPlanningArtifact(path)) continue;
  if (declared.has(path)) matched.push(path);
  else undeclared.push({ path, ...stat });
}

const undelivered = [...declared.keys()].filter((p) => !changed.has(p));

const totalFiles = matched.length + undeclared.length;
const totalLines = [...changed.entries()]
  .filter(([p]) => !isPlanningArtifact(p))
  .reduce((s, [, v]) => s + v.added + v.deleted, 0);

undeclared.sort((a, b) => b.added + b.deleted - (a.added + a.deleted));

const overFiles = maxFiles > 0 && totalFiles > maxFiles;
const overLines = maxLines > 0 && totalLines > maxLines;

// ── 5. Отчёт ────────────────────────────────────────────────────────────

if (asJson) {
  console.log(
    JSON.stringify(
      {
        phase_dir: phaseRel,
        commits: commits ? commits.length : null,
        base_strategy: how,
        working_tree_included: includeDirty,
        plans: planFiles.length,
        declared: declared.size,
        changed_files: totalFiles,
        changed_lines: totalLines,
        matched: matched.length,
        undeclared: undeclared.map((u) => u.path),
        undelivered,
        over_budget: { files: overFiles, lines: overLines },
        verdict: undeclared.length > 0 || (strictBudget && (overFiles || overLines)) ? 'BLOCK' : 'PASS',
      },
      null,
      2,
    ),
  );
} else {
  log(`phase       ${phaseRel}`);
  log(`scope       ${how}`);
  log(`declared    ${declared.size} file(s) across ${planFiles.length} plan(s)`);
  log(
    `changed     ${totalFiles} file(s), ${totalLines} line(s)  [.planning/ excluded; working tree ${includeDirty ? 'included' : 'excluded — phase already committed'}]`,
  );
  log(`matched     ${matched.length}`);
  log(`undeclared  ${undeclared.length}`);
  log(`undelivered ${undelivered.length}  (declared but untouched — reported, never blocking)`);

  if (maxFiles > 0 || maxLines > 0) {
    const fb = maxFiles > 0 ? `${totalFiles}/${maxFiles} files` : '';
    const lb = maxLines > 0 ? `${totalLines}/${maxLines} lines` : '';
    const flag = overFiles || overLines ? 'OVER BUDGET' : 'within budget';
    log(`budget      ${[fb, lb].filter(Boolean).join(', ')} — ${flag}`);
  }

  if (undeclared.length) {
    log('\nUndeclared changes (changed, but named by no PLAN.md in this phase):');
    for (const u of undeclared.slice(0, 40)) log(`  +${u.added}/-${u.deleted}  ${u.path}`);
    if (undeclared.length > 40) log(`  … and ${undeclared.length - 40} more`);
  }

  if (undelivered.length) {
    log('\nDeclared but untouched (not a failure — planners may over-declare):');
    for (const p of undelivered.slice(0, 20)) log(`  ${p}`);
    if (undelivered.length > 20) log(`  … and ${undelivered.length - 20} more`);
  }
}

if (undeclared.length > 0) {
  console.error(
    `\nFAIL: ${undeclared.length} file(s) changed that no plan in this phase declared.`,
  );
  console.error(
    'Either the executor went outside the task, or the plan was incomplete — both need a human look.',
  );
  console.error('Fix: add the paths to the owning PLAN.md files_modified, or revert the stray change.');
  process.exit(1);
}

if (strictBudget && (overFiles || overLines)) {
  console.error(`\nFAIL: over budget with --strict-budget (${totalFiles} files, ${totalLines} lines).`);
  process.exit(1);
}

log('\nOK: every changed file was declared by a plan in this phase.');
if (overFiles || overLines) {
  log('Note: over the reported budget, but declared — size alone is not a defect.');
}
process.exit(0);
