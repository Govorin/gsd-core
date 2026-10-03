#!/usr/bin/env node
/**
 * UAT-гейт — блокирует ship, пока в фазе остались непроведённые ручные проверки.
 *
 * ── Что уже есть и почему этого не хватало ──────────────────────────────
 *
 * Верификатор, столкнувшись с истиной, которую нельзя проверить чтением кода,
 * ставит `status: human_needed` и записывает пункты в `{phase}-UAT.md` — это
 * единственный сток для таких пунктов (`agents/gsd-verifier.md`:533,
 * `workflows/execute-phase.md`:1352). Команда `audit-uat` умеет их найти и
 * возвращает структурированный ответ с `summary.by_category`.
 *
 * Гейта, который бы это прочитал, не было. Фаза с `status: testing` и
 * непроведёнными пунктами доходила до ship беспрепятственно: механизм записи
 * работал, механизм чтения — нет. В ретроспективе `ucars` этот класс закрывали
 * вручную, изобретая в каждой фазе свой `NN-HUMAN-UAT.md`, потому что иначе
 * пункты «тихо терялись» (формулировка автора).
 *
 * Отдельный артефакт здесь не нужен и был бы вреден: он создал бы второй сток
 * для того, что уже имеет один. Нужен читатель существующего.
 *
 * ── Что считается открытым ──────────────────────────────────────────────
 *
 * Пункт открыт, если его категория — `pending` (проверка не проводилась).
 * Провалившийся пункт (`failed`) — НЕ предмет этого гейта: провал ручной
 * проверки означает дефект, о котором уже знают, и его судьбу решает
 * верификация, а не наличие записи. Гейт отвечает ровно на один вопрос:
 * «остались ли проверки, которых никто не делал».
 *
 * ── Отсутствие UAT.md — это НЕ отказ ────────────────────────────────────
 *
 * Большинство фаз не порождают ручных проверок вовсе, и требовать от них
 * артефакт значило бы блокировать за то, что проверять было нечего. Отличие
 * от `blast-radius` (где пустая декларация — отказ) существенно: там пустота
 * означала «планировщик не заявил ничего», здесь — «верификатору нечего было
 * отложить на человека».
 *
 * Использование:
 *   node uat-open.mjs --dir <phase-dir>            # только эта фаза
 *   node uat-open.mjs --dir <phase-dir> --all      # весь проект (для ship milestone)
 *
 * Коды выхода: 0 — открытых пунктов нет; 1 — есть; 2 — не смог проверить.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const has = (name) => argv.includes(`--${name}`);

const dir = arg('dir');
const allPhases = has('all');

if (!dir) {
  console.error('usage: --dir <phase-dir> [--all]');
  process.exit(2);
}

const phaseDir = resolve(dir);
if (!existsSync(phaseDir)) {
  console.error(`FAIL: phase directory not found: ${phaseDir}`);
  process.exit(2);
}

// Корень проекта: поднимаемся от директории фазы до того, что содержит .planning/.
// Не repo-root: в этих проектах .planning/ вложены (10 корней в mn), и якорь по
// репозиторию прочитал бы чужую фазу.
function findPlanningRoot(from) {
  let current = from;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(resolve(current, '.planning'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const projectRoot = findPlanningRoot(phaseDir);
if (!projectRoot) {
  console.error(`FAIL: no .planning/ above ${phaseDir} — cannot resolve the project`);
  process.exit(2);
}

// gsd_run — не всегда в PATH у гейта; вызываем tools напрямую, тем же способом,
// каким это делают остальные скрипты этой capability.
const toolsCandidates = [
  resolve(process.env.HOME || '', '.claude/gsd-core/bin/gsd-tools.cjs'),
  resolve(process.env.HOME || '', '.gsd/gsd-core/bin/gsd-tools.cjs'),
  resolve(projectRoot, 'gsd-core/bin/gsd-tools.cjs'),
];
const tools = toolsCandidates.find((candidate) => existsSync(candidate));
if (!tools) {
  console.error('FAIL: could not locate gsd-tools.cjs — checked ' + toolsCandidates.join(', '));
  process.exit(2);
}

let raw;
try {
  raw = execFileSync(process.execPath, [tools, 'audit-uat', '--cwd', projectRoot, '--raw'], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
} catch (err) {
  console.error(`FAIL: audit-uat did not run (${err && err.message ? err.message : 'unknown'})`);
  process.exit(2);
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('FAIL: audit-uat returned output that is not JSON');
  process.exit(2);
}

const results = Array.isArray(report.results) ? report.results : [];

// Фильтр по фазе: audit-uat отчитывается по всему проекту, а гейт на ship:pre
// спрашивает про ОДНУ фазу. Сверяем по имени директории — оно уникально по
// построению, в отличие от номера фазы, который в монорепо повторяется между
// проектами (тот же урок, что у blast-radius: скоуп коммита коллизиен, путь — нет).
const phaseName = basename(phaseDir);
const scoped = allPhases ? results : results.filter((entry) => entry.phase_dir === phaseName);

if (scoped.length === 0) {
  console.log(
    allPhases
      ? 'OK: no UAT files in this project — no manual checks were deferred'
      : `OK: no UAT file in ${phaseName} — this phase deferred no manual checks`
  );
  process.exit(0);
}

const open = [];
for (const entry of scoped) {
  const items = Array.isArray(entry.items) ? entry.items : [];
  for (const item of items) {
    // `pending` — проверка не проводилась. `failed` сознательно пропускаем:
    // провал ручной проверки — это известный дефект, судьбу которого решает
    // верификация; этот гейт спрашивает только про непроведённое.
    if (item.category === 'pending') {
      open.push({ file: entry.file, test: item.test, name: item.name });
    }
  }
}

if (open.length === 0) {
  const scope = allPhases ? 'this project' : phaseName;
  console.log(`OK: every UAT item in ${scope} has been run (${scoped.length} file(s) checked)`);
  process.exit(0);
}

console.error(
  `FAIL: ${open.length} manual verification item(s) never run` +
    (allPhases ? '' : ` in ${phaseName}`) +
    '.'
);
for (const item of open.slice(0, 20)) {
  console.error(`  ${item.file} #${item.test}: ${item.name}`);
}
if (open.length > 20) console.error(`  … and ${open.length - 20} more`);
console.error(
  '\nThe verifier could not confirm these by reading code and deferred them to a human. ' +
    'Run them and record the result in the UAT file, or — if one is genuinely not needed — ' +
    'say so there. Shipping with them unrun means the phase\'s own report says nobody checked.'
);
process.exit(1);
