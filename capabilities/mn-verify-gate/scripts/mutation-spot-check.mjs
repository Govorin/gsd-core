#!/usr/bin/env node
/**
 * Mutation spot-check — доказывает, что тесты фазы РЕАГИРУЮТ на изменения кода,
 * а не просто существуют и зеленеют.
 *
 * ── Что закрывает ────────────────────────────────────────────────────────
 *
 * Зелёный прогон не отличает «код верен» от «тест ничего не проверяет».
 * `norn/13-01-SUMMARY.md` содержит ровно этот случай, найденный вручную:
 * «⚠ My own test was a false green, caught by mutation». Приём сработал —
 * и остался приёмом, который нужно вспомнить, а не шагом, который выполняется.
 *
 * Ratchet ассершенов ловит удалённую проверку. Он не ловит проверку, которая
 * никогда ничего не утверждала: `expect(true).toBe(true)` считается наравне
 * с настоящей. Мутация — единственный способ различить их без чтения кода.
 *
 * ── Почему не Stryker ────────────────────────────────────────────────────
 *
 * Его нет ни в одном из проектов, где это нужно (проверено: ни `mn`, ни
 * `awesome-projects` его не ставят), а гейт, требующий установки инструмента,
 * не включат. Здесь используется тестраннер, который у проекта уже есть:
 * мутация вносится в файл, запускается команда проекта, файл восстанавливается.
 *
 * ── Что считается провалом ───────────────────────────────────────────────
 *
 * Мутант ВЫЖИЛ — тесты остались зелёными при изменённом коде. Это значит, что
 * поведение в этой точке не проверяет никто. Обратное (мутант убит) не
 * доказывает качества теста в целом — только то, что в этой точке он реагирует.
 * Утверждение сознательно узкое: спот-чек, а не покрытие.
 *
 * ── Границы, выбранные намеренно ─────────────────────────────────────────
 *
 * • Файлы берутся из `files_modified` планов фазы — мутировать чужой код
 *   бессмысленно, фаза за него не отвечает.
 * • Мутации — только те, что почти наверняка меняют поведение и почти никогда
 *   не ломают синтаксис: `>` ↔ `>=`, `===` ↔ `!==`, `true` ↔ `false`,
 *   `&&` ↔ `||`. Мутант, падающий компиляцией, ничего не доказывает — он
 *   «убит» тем, что не собрался, а не тем, что кто-то проверил поведение.
 * • Не трогаются сами тесты (`*.spec.*`, `tests/`): мутация теста проверяет
 *   тест тестом.
 * • Файл ВСЕГДА восстанавливается — в том числе при падении раннера и при
 *   сигнале. Скрипт, оставивший мутацию в рабочем дереве, хуже отсутствия
 *   скрипта.
 *
 * Использование:
 *   node mutation-spot-check.mjs --dir <phase-dir> --command "npx vitest run"
 *   node mutation-spot-check.mjs --dir <phase-dir> --command "..." --max 3
 *
 * Коды выхода: 0 — все мутанты убиты (или мутировать было нечего);
 *              1 — хотя бы один выжил; 2 — проверку выполнить не удалось.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : dflt;
};

const dir = arg('dir');
let command = arg('command');
let maxMutants = Number(arg('max', '3'));
const timeoutMs = Number(arg('timeout', '600')) * 1000;

if (!dir) {
  console.error('usage: --dir <phase-dir> [--command "<test command>"] [--max N] [--timeout SECONDS]');
  process.exit(2);
}

const phaseDir = resolve(dir);
if (!existsSync(phaseDir)) {
  console.error(`FAIL: phase directory not found: ${phaseDir}`);
  process.exit(2);
}

function findPlanningRoot(from) {
  let current = from;
  for (let depth = 0; depth < 64; depth += 1) {
    if (existsSync(join(current, '.planning'))) return current;
    const parent = resolve(current, '..');
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

const projectRoot = findPlanningRoot(phaseDir);
if (!projectRoot) {
  console.error(`FAIL: no .planning/ above ${phaseDir}`);
  process.exit(2);
}

// Команда и лимит берутся из конфига проекта, если не переданы флагом.
// Гейт не может подставить их сам: интерполяция в предикатах ограничена тремя
// переменными (PHASE_NUMBER, PHASE_DIR, PHASE_REQ_IDS — см.
// src/gate-predicate-evaluator.cts), и `${WORKFLOW_...}` в команде гейта
// осталось бы литеральной строкой. Читаем конфиг сами — это к тому же
// единственный источник истины, а не его копия в объявлении гейта.
if (!command || !maxMutants) {
  try {
    const cfg = JSON.parse(readFileSync(join(projectRoot, '.planning', 'config.json'), 'utf8'));
    const workflow = (cfg && cfg.workflow) || {};
    if (!command && typeof workflow.mutation_test_command === 'string') {
      command = workflow.mutation_test_command.trim();
    }
    if (!Number.isFinite(maxMutants) || maxMutants <= 0) {
      maxMutants = Number.isInteger(workflow.mutation_max_mutants) && workflow.mutation_max_mutants > 0
        ? workflow.mutation_max_mutants
        : 3;
    }
  } catch {
    /* конфига нет или он нечитаем — проверим ниже */
  }
}

if (!command) {
  console.error(
    'FAIL: no test command. Pass --command, or set workflow.mutation_test_command in .planning/config.json. ' +
      'Guessing a runner would produce an unrunnable check, which reads as a code failure and is worse than no check.'
  );
  process.exit(2);
}

/** `files_modified` планов фазы — та же форма чтения, что у blast-radius. */
function declaredFiles(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return [];
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^files_modified:\s*$/.test(l));
  if (start === -1) {
    const inline = /^files_modified:\s*\[(.*)\]\s*$/m.exec(fm[1]);
    if (!inline) return [];
    return inline[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    // Пустая строка внутри блока его НЕ закрывает: это легальный YAML, и в
    // одном живом проекте так оформлены 17 планов из 96. Трактовка «конец
    // списка» превращала такой план в «ничего не заявлено».
    if (lines[i].trim() === '') continue;
    const m = /^\s+-\s+(.+?)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1].replace(/^['"]|['"]$/g, '').replace(/\s+#.*$/, '').trim());
  }
  return out;
}

let planFiles;
try {
  planFiles = readdirSync(phaseDir).filter((f) => f.endsWith('PLAN.md')).sort();
} catch (err) {
  console.error(`FAIL: cannot read ${phaseDir} (${err.code || 'unknown'})`);
  process.exit(2);
}

const declared = new Set();
for (const name of planFiles) {
  for (const entry of declaredFiles(readFileSync(join(phaseDir, name), 'utf8'))) {
    declared.add(entry.replace(/^\.\//, '').replace(/^\/+/, ''));
  }
}

// Только реальные исходники: глобы и директории пропускаем (мутировать «шаблон»
// нечего), тесты пропускаем (мутация теста проверяет тест тестом).
const candidates = [...declared]
  .filter((entry) => !entry.includes('*'))
  .filter((entry) => /\.[cm]?[jt]sx?$/.test(entry))
  .filter((entry) => !/\.(spec|test)\.[cm]?[jt]sx?$/.test(entry))
  .filter((entry) => !/(^|\/)(tests?|__tests__)\//.test(entry))
  .map((entry) => join(projectRoot, entry))
  .filter((abs) => existsSync(abs));

if (candidates.length === 0) {
  console.log('OK: no mutable source files declared by this phase — nothing to spot-check');
  process.exit(0);
}

/**
 * Мутации, почти всегда меняющие поведение и почти никогда — синтаксис.
 * Порядок важен: `===` до `==`, иначе первое правило съест часть второго.
 */
const MUTATIONS = [
  { from: /([^=!<>])>=/g, to: '$1>', label: '>= → >' },
  { from: /([^=!<>])<=/g, to: '$1<', label: '<= → <' },
  { from: /===/g, to: '!==', label: '=== → !==' },
  { from: /!==/g, to: '===', label: '!== → ===' },
  { from: /&&/g, to: '||', label: '&& → ||' },
  { from: /\btrue\b/g, to: 'false', label: 'true → false' },
];

/** Первая применимая мутация для файла, вносимая ровно в одном месте. */
function mutateOnce(source) {
  for (const rule of MUTATIONS) {
    rule.from.lastIndex = 0;
    const match = rule.from.exec(source);
    if (!match) continue;
    const at = match.index;
    const replaced = match[0].replace(new RegExp(rule.from.source), rule.to);
    return {
      label: rule.label,
      line: source.slice(0, at).split('\n').length,
      mutated: source.slice(0, at) + replaced + source.slice(at + match[0].length),
    };
  }
  return null;
}

function runTests() {
  const res = spawnSync(command, {
    cwd: projectRoot,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status, unrunnable: Boolean(res.error) || res.status === null, signal: res.signal };
}

// Базовый прогон: мутационная проверка на красном дереве бессмысленна —
// «мутант убит» нельзя отличить от «тесты и так падали».
const baseline = runTests();
if (baseline.unrunnable) {
  console.error(`FAIL: the test command could not run (${baseline.signal || 'spawn failed'}) — fix the command, not the code`);
  process.exit(2);
}
if (baseline.status !== 0) {
  console.error(`FAIL: the suite is already red (exit ${baseline.status}) — a surviving mutant cannot be told from a pre-existing failure`);
  process.exit(2);
}

const survivors = [];
const killed = [];
let attempted = 0;

// Восстановление файла — обязательство, а не best effort: держим оригиналы и
// возвращаем их даже при сигнале.
const originals = new Map();
const restoreAll = () => {
  for (const [file, source] of originals) {
    try {
      writeFileSync(file, source);
    } catch {
      console.error(`WARNING: could not restore ${file} — check your working tree`);
    }
  }
  originals.clear();
};
process.on('SIGINT', () => { restoreAll(); process.exit(2); });
process.on('SIGTERM', () => { restoreAll(); process.exit(2); });

try {
  for (const file of candidates) {
    if (attempted >= maxMutants) break;
    const source = readFileSync(file, 'utf8');
    const mutation = mutateOnce(source);
    if (!mutation) continue;

    attempted += 1;
    originals.set(file, source);
    writeFileSync(file, mutation.mutated);

    const result = runTests();
    writeFileSync(file, source);
    originals.delete(file);

    const rel = relative(projectRoot, file);
    if (result.unrunnable) {
      // Раннер не смог выполниться на мутанте — это не «убит». Считаем
      // попытку несостоявшейся, а не успешной.
      console.error(`  ? ${rel}:${mutation.line} (${mutation.label}) — the runner did not complete; not counted`);
      attempted -= 1;
      continue;
    }
    if (result.status === 0) {
      survivors.push({ file: rel, ...mutation });
    } else {
      killed.push({ file: rel, ...mutation });
    }
  }
} finally {
  restoreAll();
}

if (attempted === 0) {
  console.log('OK: none of this phase\'s declared files carry a mutable construct — nothing to spot-check');
  process.exit(0);
}

for (const k of killed) {
  console.log(`  ✓ ${k.file}:${k.line} (${k.label}) — a test noticed`);
}

if (survivors.length === 0) {
  console.log(`OK: ${killed.length}/${attempted} mutant(s) killed — the tests react to changes in this code`);
  process.exit(0);
}

console.error(`\nFAIL: ${survivors.length} of ${attempted} mutant(s) survived — the suite stayed green with the code changed:`);
for (const s of survivors) {
  console.error(`  ✗ ${s.file}:${s.line} — ${s.label} changed nothing that any test checks`);
}
console.error(
  '\nA green suite cannot tell "the code is right" from "nothing checks this". ' +
    'The measured case in this project: a summary reading "my own test was a false green, caught by mutation". ' +
    'Add an assertion that fails when the behaviour at these points changes.'
);
process.exit(1);
