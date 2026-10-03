#!/usr/bin/env node
/**
 * Сборка мусора worktree — с проверкой уникальных коммитов.
 *
 * Зачем отдельная команда: `worktree reap-orphans` подметает только worktree
 * с файлом `locked` (краш при залоченном дереве, #3707). Брошенное штатным
 * путём — умерла сессия, оркестратор убит, волна прервана — файла `locked` не
 * имеет и для уборщика невидимо. `gsd-health` про такое предупреждает (W017),
 * но в repair_actions не входит, так что автоматического пути убрать нет.
 *
 * Итог наблюдался вживую: 35 брошенных worktree и 19 ГБ, диск заполнился до
 * отказа записи. Три дерева из них несли реальную работу.
 *
 * Отсюда единственное правило, которое здесь важно: ветка с уникальными
 * коммитами НЕ удаляется никогда, даже с --yes. Она попадает в отчёт со
 * списком команд для спасения. Автоматика, стирающая невоспроизводимую
 * работу, хуже, чем отсутствие автоматики: 19 ГБ — это дёшево, 33 коммита — нет.
 *
 *   node worktree-gc.mjs                 # что удалилось бы (по умолчанию)
 *   node worktree-gc.mjs --yes           # удалить мусор
 *   node worktree-gc.mjs --older-than 7  # только старше недели
 *
 * exit 0 — всегда, кроме внутренней ошибки. Это уборщик, а не гейт.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

const argv = process.argv.slice(2);
const apply = argv.includes('--yes');
const olderThan = (() => {
  const i = argv.indexOf('--older-than');
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : 0;
})();

const git = (args, opts = {}) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
};

const root = git(['rev-parse', '--show-toplevel']);
if (!root) {
  console.error('FAIL: not a git repository');
  process.exit(1);
}

const mainRef = git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  || (git(['rev-parse', '--verify', '--quiet', 'main']) ? 'main' : 'master');

const branches = (git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']) || '')
  .split('\n')
  .filter((b) => b.startsWith('worktree-'));

// Путь рабочего дерева ветки, если оно ещё зарегистрировано.
const worktreePaths = new Map();
{
  const porcelain = git(['worktree', 'list', '--porcelain']) || '';
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    else if (line.startsWith('branch ') && cur) worktreePaths.set(line.slice(7).replace('refs/heads/', ''), cur);
  }
}

const reap = [];
const keep = [];

for (const branch of branches) {
  const ahead = Number(git(['rev-list', '--count', `${mainRef}..${branch}`]) ?? '0');
  const path = worktreePaths.get(branch);
  const dirty = path && existsSync(path)
    ? Boolean(git(['-C', path, 'status', '--porcelain', '--untracked-files=all']))
    : false;

  let ageDays = Infinity;
  if (path && existsSync(path)) {
    ageDays = (Date.now() - statSync(path).mtimeMs) / 86_400_000;
  }

  if (ahead > 0) {
    keep.push({ branch, path, reason: `${ahead} unique commit(s)`, ahead });
  } else if (dirty) {
    keep.push({ branch, path, reason: 'uncommitted changes in worktree', ahead: 0 });
  } else if (ageDays < olderThan) {
    keep.push({ branch, path, reason: `younger than ${olderThan}d`, ahead: 0 });
  } else {
    reap.push({ branch, path });
  }
}

console.log(`main ref: ${mainRef}`);
console.log(`worktree-* branches: ${branches.length} — ${reap.length} reapable, ${keep.length} kept\n`);

if (keep.length) {
  console.log('KEPT — holds work that exists nowhere else:');
  for (const k of keep.sort((a, b) => b.ahead - a.ahead)) {
    console.log(`  ${k.branch}  (${k.reason})`);
    if (k.ahead > 0) {
      console.log(`      inspect: git log ${mainRef}..${k.branch}`);
      console.log(`      keep:    git merge ${k.branch}`);
      console.log(`      discard: git branch -D ${k.branch}`);
    }
  }
  console.log();
}

if (!reap.length) {
  console.log('Nothing to reap.');
  process.exit(0);
}

if (!apply) {
  console.log(`DRY RUN — would remove ${reap.length} branch(es) and their worktrees:`);
  for (const r of reap.slice(0, 20)) console.log(`  ${r.branch}${r.path ? `  → ${r.path}` : ''}`);
  if (reap.length > 20) console.log(`  … and ${reap.length - 20} more`);
  console.log('\nRe-run with --yes to apply.');
  process.exit(0);
}

let removed = 0;
for (const r of reap) {
  if (r.path && existsSync(r.path)) {
    git(['worktree', 'unlock', r.path]);
    git(['worktree', 'remove', '--force', r.path]);
  }
  if (git(['branch', '-D', r.branch]) !== null) removed += 1;
}
git(['worktree', 'prune']);

console.log(`Removed ${removed} branch(es); pruned stale worktree registrations.`);
if (keep.length) console.log(`${keep.length} branch(es) kept — see the list above before discarding any.`);
process.exit(0);
