#!/usr/bin/env node
/**
 * Реестр компонентов: нода дизайна -> компонент в коде.
 *
 * Зачем. Мост между дизайном и кодом уже наполовину построен: DESIGN-SYSTEM.md
 * (по скиллу quality-design) несёт id компонентов, их состояния, карту зон и
 * реестр экранов. Чего в нём нет — колонки «а написан ли этот компонент».
 * И GSD про этот файл не знает вовсе: UI-SPEC.md на него не ссылается,
 * gsd-ui-researcher его не читает. Скрипт закрывает ровно эту дыру: берёт
 * список нод и отвечает, у каких есть реализация.
 *
 * ЧТО ЭТОТ СКРИПТ НЕ ДЕЛАЕТ. Он не источник правды о дизайне. По quality-design
 * источник правды — живой дизайн-файл, а DESIGN-SYSTEM.md — проектная конкретика
 * и только пока совпадает с файлом. Скрипт лишь сверяет уже записанный реестр
 * с диском. Разошлось — чинить документ, а не верить выводу скрипта.
 *
 * ВХОД — два режима, по убыванию достоверности:
 *
 *   --html <dir|file>   Экспорт из Pencil (`export_html`). Канонический путь:
 *                       это то, что реально отрисовано, со структурой и стилями.
 *                       Требует запущенного приложения Pencil в момент экспорта
 *                       (сам скрипт приложение не дёргает — читает уже готовое).
 *
 *   --registry <md>     DESIGN-SYSTEM.md. Разбирает markdown-таблицы, где
 *                       первая колонка — id ноды, вторая — имя компонента.
 *                       Работает без Pencil и переживает то, что приложение
 *                       не поднято.
 *
 *   --pen <file.pen>    Аварийный путь. .pen — это JSON, и его можно прочитать
 *                       напрямую, но по конвенции проекта с дизайном работают
 *                       через HTML-экспорт. Годится, когда Pencil не поднять,
 *                       а DESIGN-SYSTEM.md ещё не заведён. Помечает вывод
 *                       как fallback, чтобы это не стало привычкой.
 *
 * Генерируется (derived) — не устаревает, потому что перечитывается:
 *   есть ли файл компонента · его путь · дрейф в обе стороны · число инстансов
 * Не генерируется (authored, решение человека) — и потому не выдумывается:
 *   todo/in-progress/done · сознательное расхождение с макетом · какое состояние
 *   обязательно · брейкпоинты, которых в макете нет · маппинг при разошедшихся
 *   именах (--map) · нужен ли компонент вообще
 *
 *   node design-registry.mjs --registry apps/polyglot/DESIGN-SYSTEM.md --code libs/polyglot
 *   node design-registry.mjs --html /tmp/pen-export --code libs/savor --format md
 *   node design-registry.mjs --pen savor.pen --code libs/savor --check --threshold 5
 *
 * Exit codes (различают «не найдено» и «не смог проверить»):
 *   0 — сверка выполнена, расхождений в пределах порога
 *   1 — сверка выполнена, есть незакрытые компоненты (только под --check)
 *   2 — проверить не смог: нет входа, битый файл, пустой код
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

const htmlIn = arg('html');
const registryIn = arg('registry');
const penIn = arg('pen');
const codeRoot = arg('code');
const format = arg('format', 'md');
const mapPath = arg('map');
const threshold = Number(arg('threshold', '0'));

const USAGE =
  'usage: (--html <dir> | --registry <DESIGN-SYSTEM.md> | --pen <file.pen>) --code <dir>\n' +
  '       [--format md|json] [--map <file.json>] [--check] [--threshold N]';

if (!codeRoot || (!htmlIn && !registryIn && !penIn)) {
  console.error(USAGE);
  process.exit(2);
}

const die = (msg, hint) => {
  console.error(`FAIL: ${msg}`);
  if (hint) console.error(hint);
  process.exit(2);
};

/* ------------------------------------------------------------------ *
 * 1. ДИЗАЙН. Каждый режим отдаёт один и тот же список:
 *    { id, name, states[], instances, origin }
 * ------------------------------------------------------------------ */

let masters = [];
let source = { mode: null, label: null, fallback: false, extra: {} };

/** Режим A — HTML-экспорт Pencil. Канон. */
function fromHtml(target) {
  const p = resolve(target);
  if (!existsSync(p)) die(`не найден HTML-экспорт: ${target}`, 'Сделайте export_html из Pencil в этот путь.');

  const files = [];
  const st = statSync(p);
  if (st.isDirectory()) {
    const walkDir = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walkDir(f);
        else if (/\.html?$/i.test(e.name)) files.push(f);
      }
    };
    walkDir(p);
  } else files.push(p);

  if (!files.length) die(`в ${target} нет ни одного .html`, 'Проверьте, что export_html действительно отработал.');

  const found = new Map();
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    // Pencil проставляет на элементах id ноды и её имя. Терпим оба
    // распространённых вида: data-атрибуты и id/class с именем компонента.
    const patterns = [
      /data-(?:node-)?id=["']([\w-]+)["'][^>]*data-(?:node-)?name=["']([^"']+)["']/gi,
      /data-(?:node-)?name=["']([^"']+)["'][^>]*data-(?:node-)?id=["']([\w-]+)["']/gi,
    ];
    patterns.forEach((re, idx) => {
      let m;
      while ((m = re.exec(html))) {
        const id = idx === 0 ? m[1] : m[2];
        const name = idx === 0 ? m[2] : m[1];
        if (!/^component\//i.test(name)) continue; // только мастера Kit
        const clean = name.replace(/^component\//i, '').trim();
        if (!found.has(id)) found.set(id, { id, name: clean, states: [], instances: 0, origin: basename(f) });
        else found.get(id).instances += 1;
      }
    });
  }

  if (!found.size) {
    die(
      'в HTML-экспорте не нашлось ни одного узла с data-id/data-name и префиксом "component/"',
      'Экспорт может не нести атрибутов нод. Тогда идите через --registry (DESIGN-SYSTEM.md) — он для этого и заведён.'
    );
  }
  masters = [...found.values()];
  source = { mode: 'html', label: relative(process.cwd(), p), fallback: false, extra: { files: files.length } };
}

/** Режим B — DESIGN-SYSTEM.md. Работает без Pencil. */
function fromRegistry(target) {
  const p = resolve(target);
  if (!existsSync(p)) die(`не найден ${target}`, 'DESIGN-SYSTEM.md заводится по скиллу quality-design.');
  const md = readFileSync(p, 'utf8');

  // Берём ТОЛЬКО таблицу под заголовком про компоненты. Без этой привязки
  // парсер тащит и токены (`p-green-500 | #1F7A3D`), и карту зон, и куски прозы
  // с обратными кавычками — проверено на polyglot/DESIGN-SYSTEM.md: 41 «компонент»,
  // из них ~35 мусор. Реестр компонентов — это конкретная секция, а не «любая
  // таблица, где первая ячейка похожа на id».
  const HEAD_RE = /^\s{0,3}#{2,4}\s+(.*)$/;
  const COMPONENT_SECTION = /(компонент|component)/i;
  const lines = md.split('\n');
  const found = new Map();
  let inSection = false;

  for (const line of lines) {
    const head = line.match(HEAD_RE);
    if (head) {
      inSection = COMPONENT_SECTION.test(head[1]);
      continue;
    }
    if (!inSection || !/^\s*\|/.test(line)) continue;

    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c));
    if (cells.length < 2) continue;

    const idCell = cells[0].replace(/`/g, '').trim();
    if (!/^[A-Za-z0-9_-]{4,12}$/.test(idCell)) continue;
    if (/^(id|нода|node|компонент)/i.test(idCell)) continue;
    if (/^-+$/.test(idCell)) continue;

    const name = cells[1].replace(/[`*]/g, '').trim();
    // Имя компонента — идентификатор, а не фраза и не hex-цвет.
    if (!name || !/^[A-Za-z][A-Za-z0-9 _-]{1,40}$/.test(name)) continue;
    if (/^#[0-9a-f]{3,8}$/i.test(name)) continue;

    const tail = cells[cells.length - 1] || '';
    const states =
      cells.length >= 3 && /[·×]/.test(tail)
        ? tail.split(/[·×]/).map((s) => s.trim()).filter(Boolean)
        : [];

    if (!found.has(idCell)) found.set(idCell, { id: idCell, name, states, instances: 0, origin: 'DESIGN-SYSTEM.md' });
  }

  if (!found.size) {
    die(
      `в ${target} не нашлось таблицы компонентов`,
      'Ожидается секция с «Компонент» в заголовке (например «### Компоненты Kit»),\n' +
        'а под ней markdown-таблица: первая колонка — id ноды, вторая — имя компонента.'
    );
  }
  masters = [...found.values()];
  source = { mode: 'registry', label: relative(process.cwd(), p), fallback: false, extra: {} };
}

/** Режим C — сырой .pen. Аварийный. */
function fromPen(target) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(resolve(target), 'utf8'));
  } catch (err) {
    die(`не смог прочитать ${target}: ${err.message}`, 'Если файл открыт в Pencil и не сохранён — сохраните его.');
  }
  if (!doc || !Array.isArray(doc.children)) die(`${target} не похож на .pen — нет массива children.`);

  const nodes = [];
  const walkNode = (n) => {
    nodes.push(n);
    for (const c of n.children || []) walkNode(c);
  };
  for (const c of doc.children) walkNode(c);

  const instanceCount = new Map();
  for (const n of nodes) if (n.type === 'ref' && n.ref) instanceCount.set(n.ref, (instanceCount.get(n.ref) || 0) + 1);

  // Состояния: узел "StateCell · <Имя>", внутри — ref на мастера
  const statesBy = new Map();
  for (const n of nodes) {
    if (!/^StateCell\b/.test(String(n.name || ''))) continue;
    const label = String(n.name).replace(/^StateCell\s*·?\s*/, '').trim() || '(без имени)';
    for (const c of n.children || []) {
      if (c.type !== 'ref' || !c.ref) continue;
      if (!statesBy.has(c.ref)) statesBy.set(c.ref, new Set());
      statesBy.get(c.ref).add(label);
    }
  }

  masters = nodes
    .filter((n) => n.reusable)
    .map((n) => ({
      id: n.id,
      name: String(n.name || '').replace(/^component\//, ''),
      states: [...(statesBy.get(n.id) || [])],
      instances: instanceCount.get(n.id) || 0,
      origin: basename(target),
    }));

  if (!masters.length) die(`в ${target} нет ни одного узла с reusable:true — нечего сверять.`);

  const dangling = nodes.filter((n) => n.type === 'ref' && n.ref && !nodes.some((x) => x.id === n.ref)).length;
  source = {
    mode: 'pen',
    label: relative(process.cwd(), resolve(target)),
    fallback: true,
    extra: { dangling, tokens: doc.variables ? Object.keys(doc.variables).length : 0, themes: doc.themes ? Object.keys(doc.themes) : [] },
  };
}

if (htmlIn) fromHtml(htmlIn);
else if (registryIn) fromRegistry(registryIn);
else fromPen(penIn);

/* ------------------------------------------------------------------ *
 * 2. КОД
 * ------------------------------------------------------------------ */

if (!existsSync(codeRoot)) die(`каталог кода не найден: ${codeRoot}`);

const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', 'tmp', '.expo']);
const sources = [];
const collect = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (/\.[jt]sx?$/.test(e.name) && !/\.(spec|test|stories)\./.test(e.name)) sources.push(p);
  }
};
collect(resolve(codeRoot));
if (!sources.length) die(`под ${codeRoot} нет ни одного исходника — сверять не с чем.`);

const EXPORT_RE = /export\s+(?:default\s+)?(?:const|function|class)\s+([A-Z][A-Za-z0-9_]*)/g;
const exportsByName = new Map();
for (const f of sources) {
  let src;
  try {
    src = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  let m;
  while ((m = EXPORT_RE.exec(src))) {
    if (!exportsByName.has(m[1])) exportsByName.set(m[1], []);
    exportsByName.get(m[1]).push(f);
  }
}

/* ------------------------------------------------------------------ *
 * 3. СВЕРКА
 * ------------------------------------------------------------------ */

let manualMap = {};
if (mapPath) {
  try {
    manualMap = JSON.parse(readFileSync(resolve(mapPath), 'utf8'));
  } catch (err) {
    die(`не смог прочитать --map ${mapPath}: ${err.message}`);
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const byNorm = new Map();
for (const [sym, files] of exportsByName) {
  const k = norm(sym);
  if (!byNorm.has(k)) byNorm.set(k, { sym, files });
}

const rows = masters
  .map((m) => {
    const key = norm(m.name);
    let match = null;
    let confidence = null;

    const want = manualMap[m.id] ?? manualMap[m.name];
    if (want !== undefined) {
      if (want === false) confidence = 'ignored';
      else if (exportsByName.has(want)) {
        match = { sym: want, files: exportsByName.get(want) };
        confidence = 'mapped';
      } else confidence = 'map-broken';
    } else if (byNorm.has(key)) {
      match = byNorm.get(key);
      confidence = 'exact';
    }
    // Намеренно НЕТ подбора по подстроке. Он даёт ложные совпадения
    // (RecDrinkRow -> DrinkRow — проверено на savor.pen), а ложное «сделано»
    // дороже честного «нет»: по нему закрывают задачу, которую не делали.
    // Разошедшиеся имена закрываются файлом --map, то есть решением человека.

    return {
      nodeId: m.id,
      component: m.name,
      instances: m.instances,
      states: m.states,
      code: match ? relative(process.cwd(), match.files[0]) : null,
      symbol: match ? match.sym : null,
      ambiguous: match && match.files.length > 1 ? match.files.length : 0,
      confidence,
      status: match ? 'implemented' : confidence === 'ignored' ? 'ignored' : 'missing',
    };
  })
  .sort((a, b) => b.instances - a.instances || a.component.localeCompare(b.component));

// Обратный дрейф: компонент в коде, которого нет в реестре дизайна.
// Сужаем до Kit — общих переиспользуемых компонентов. Экраны, иконки, провайдеры
// и хелперы в макете и не должны иметь мастера, и в списке дрейфа они только шум:
// на savor без этого фильтра получалось 58 строк, из которых почти все — норма.
const designNorms = new Set(masters.map((m) => norm(m.name)));
const KIT_HINT = /(\/kit\/|\/ui-kit\/|\/components?\/|ui-native)/;
const NOT_A_COMPONENT = /(\.screen\.|\.context\.|\.provider\.|-icons?\.|\/icons?\/|\.hook\.|\/gallery\/)/;
const codeOnly = [];
for (const [sym, files] of exportsByName) {
  if (designNorms.has(norm(sym))) continue;
  // Иконки и провайдеры — не компоненты Kit, даже когда лежат в kit/
  if (/(Icon|Provider|Context|Screen)$/.test(sym)) continue;
  const uiFile = files.find((f) => KIT_HINT.test(f) && /\.[jt]sx$/.test(f) && !NOT_A_COMPONENT.test(f));
  if (!uiFile) continue;
  codeOnly.push({ symbol: sym, file: relative(process.cwd(), uiFile) });
}
codeOnly.sort((a, b) => a.symbol.localeCompare(b.symbol));

const implemented = rows.filter((r) => r.status === 'implemented');
const missing = rows.filter((r) => r.status === 'missing');
const mapBroken = rows.filter((r) => r.confidence === 'map-broken');
const ambiguous = rows.filter((r) => r.ambiguous);

/* ------------------------------------------------------------------ *
 * 4. ВЫВОД
 * ------------------------------------------------------------------ */

const summary = {
  sourceMode: source.mode,
  sourceLabel: source.label,
  fallback: source.fallback,
  masters: masters.length,
  implemented: implemented.length,
  missing: missing.length,
  ignored: rows.filter((r) => r.status === 'ignored').length,
  codeOnly: codeOnly.length,
  ambiguous: ambiguous.length,
  mapBroken: mapBroken.length,
  ...source.extra,
};

if (format === 'json') {
  console.log(JSON.stringify({ summary, components: rows, codeOnly }, null, 2));
} else {
  const esc = (s) => String(s).replace(/\|/g, '\\|');
  const out = [];
  out.push(`<!-- gsd:derived source=${source.label} mode=${source.mode} generator=design-registry.mjs -->`);
  if (source.fallback) {
    out.push('');
    out.push('> ⚠ Прочитано напрямую из `.pen`, в обход HTML-экспорта. Это аварийный путь:');
    out.push('> канон — `export_html` из Pencil, либо реестр в `DESIGN-SYSTEM.md`.');
  }
  out.push('');
  out.push(`Источник: \`${source.label}\` · мастеров ${summary.masters} · **реализовано ${summary.implemented}**, не начато ${summary.missing}, в коде без ноды ${summary.codeOnly}.`);
  out.push('');
  out.push('Колонки «Нода», «Компонент», «Состояния» — из дизайна. Колонка «Код» — с диска,');
  out.push('перечитывается. Статус `todo/in-progress/done` и осознанные расхождения');
  out.push('здесь не выводятся: это решение человека, его место в DESIGN-SYSTEM.md.');
  if (summary.dangling) out.push(`\n⚠ Битых ссылок в дизайне: ${summary.dangling} — инстанс указывает на удалённый мастер.`);
  if (mapBroken.length) out.push(`\n⚠ В \`--map\` указаны символы, которых нет в коде: ${mapBroken.map((r) => r.component).join(', ')}`);
  if (ambiguous.length) out.push(`\n⚠ Имя встречается в нескольких файлах (взят первый): ${ambiguous.map((r) => r.component).join(', ')}`);
  out.push('');
  out.push('## Реестр');
  out.push('');
  const showInst = masters.some((m) => m.instances > 0);
  out.push(`| Нода | Компонент |${showInst ? ' Исп. |' : ''} Состояния в дизайне | Код | Реализован |`);
  out.push(`|---|---|${showInst ? '---:|' : ''}---|---|---|`);
  for (const r of rows) {
    out.push(
      `| \`${r.nodeId}\` | ${esc(r.component)} |${showInst ? ` ${r.instances} |` : ''} ${r.states.length ? esc(r.states.join(' · ')) : '—'} | ${r.code ? `\`${esc(r.code)}\`` : '—'} | ${r.status === 'implemented' ? '✅' : r.status === 'ignored' ? '⊘ не нужен' : '❌'} |`
    );
  }
  if (codeOnly.length) {
    out.push('');
    out.push('## В коде, но не в реестре дизайна');
    out.push('');
    out.push('Либо дизайн отстал от кода, либо компонент служебный и в макет не попадёт.');
    out.push('Решает человек — помечать в DESIGN-SYSTEM.md, а не здесь.');
    out.push('');
    out.push('| Символ | Файл |');
    out.push('|---|---|');
    for (const c of codeOnly) out.push(`| ${esc(c.symbol)} | \`${esc(c.file)}\` |`);
  }
  console.log(out.join('\n'));
}

if (flag('check')) {
  if (mapBroken.length) {
    console.error(`\n--map ссылается на ${mapBroken.length} несуществующих символов.`);
    process.exit(2);
  }
  if (missing.length > threshold) {
    console.error(`\n${missing.length} компонентов дизайна без реализации (порог ${threshold}): ${missing.map((r) => r.component).join(', ')}`);
    process.exit(1);
  }
}
process.exit(0);
