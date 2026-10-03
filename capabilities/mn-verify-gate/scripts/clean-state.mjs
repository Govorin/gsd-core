#!/usr/bin/env node
/**
 * Гейт чистого состояния — не даёт отправить фазу, пока сессия оставила рабочее
 * дерево или git посреди операции.
 *
 * ── Что уже есть и чего не хватало ──────────────────────────────────────
 *
 * `workflows/ship.md` (шаг «Clean working tree?») запускает `git status --short`
 * и при непустом выводе просит пользователя закоммитить или убрать в stash.
 * Это инструкция модели: прочтёт ли она вывод и остановится ли — вопрос
 * дисциплины, а не механизма. Здесь та же проверка становится кодом возврата.
 *
 * Есть и то, чего `git status --short` не показывает вовсе. Остановленный
 * `rebase` или `cherry-pick` может оставить дерево чистым, а историю — на
 * половине операции: ветка указывает не туда, где её ждут. Статус пуст, ship
 * идёт дальше. Такое состояние видно только по служебным файлам git
 * (`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, каталоги `rebase-merge` и
 * `rebase-apply`).
 *
 * ── Что НЕ проверяется, и почему ────────────────────────────────────────
 *
 * `.planning/` исключён: состояние планирования меняется по ходу самой работы,
 * и требовать его чистоты значило бы блокировать каждую фазу. Оставшийся
 * `.continue-here.md` тоже не считается — `resume-project` удаляет
 * `HANDOFF.json`, но не его, так что его наличие не означает «сессия
 * брошена», и гейт срабатывал бы на здоровых фазах.
 *
 * Использование:
 *   node clean-state.mjs --dir <phase-dir>
 *
 * Коды выхода: 0 — чисто; 1 — дерево грязное или операция не завершена;
 * 2 — не смог проверить (не git-репозиторий, git недоступен).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const dir = arg('dir');
if (!dir) {
  console.error('usage: --dir <phase-dir>');
  process.exit(2);
}

const phaseDir = resolve(dir);
if (!existsSync(phaseDir)) {
  console.error(`FAIL: phase directory not found: ${phaseDir}`);
  process.exit(2);
}

const git = (args) =>
  execFileSync('git', args, { cwd: phaseDir, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });

try {
  git(['rev-parse', '--show-toplevel']);
} catch (e) {
  console.error(`FAIL: cannot look — not a git repository or git unavailable (${(e.stderr || e.message || '').toString().trim()})`);
  process.exit(2);
}

// Незавершённая операция: путь к служебному файлу спрашиваем у самого git,
// а не собираем руками, — в linked worktree каталог .git — это файл.
// `--git-path` печатает путь относительно текущего каталога (здесь — каталог
// фазы), поэтому разрешать его надо от него же, а не от корня репозитория.
const OPERATIONS = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
];
const operations = [];
try {
  for (const [name, label] of OPERATIONS) {
    const p = git(['rev-parse', '--git-path', name]).trim();
    if (existsSync(resolve(phaseDir, p)) && !operations.includes(label)) operations.push(label);
  }
} catch (e) {
  console.error(`FAIL: cannot look — git rejected --git-path (${(e.stderr || e.message || '').toString().trim()})`);
  process.exit(2);
}

// Грязное дерево: `-z` — чтобы пути с пробелами и юникодом не искажались.
let dirty;
try {
  const records = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0').filter(Boolean);
  dirty = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const xy = rec.slice(0, 2);
    dirty.push(rec.slice(3));
    // переименование и копия занимают две записи: новый путь, затем исходный
    if (xy.includes('R') || xy.includes('C')) i++;
  }
  dirty = dirty.filter((p) => !p.startsWith('.planning/'));
} catch (e) {
  console.error(`FAIL: cannot look — git status failed (${(e.stderr || e.message || '').toString().trim()})`);
  process.exit(2);
}

if (operations.length === 0 && dirty.length === 0) {
  console.log('OK: working tree clean, no git operation in progress');
  process.exit(0);
}

if (operations.length > 0) {
  console.error(`FAIL: git operation not finished: ${operations.join(', ')} — finish or abort it before shipping`);
}
if (dirty.length > 0) {
  const shown = dirty.slice(0, 10);
  console.error(`FAIL: ${dirty.length} path(s) changed outside .planning/ — commit or stash them:`);
  for (const p of shown) console.error(`  ${p}`);
  if (dirty.length > shown.length) console.error(`  … and ${dirty.length - shown.length} more`);
}
process.exit(1);
