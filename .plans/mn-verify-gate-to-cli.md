# mn-verify-gate → `gsd_run`-команды (проект задачи 3.12)

Статус: проект, ничего не изменено. Основа — ветка `next` форка (скрипты, капабилити, тесты) и
`upstream/next` (форма команд). Задача 3.12 и раздел «Принцип решений» — `.plans/upstream-sync-plan.md:215-229`.

**Расхождение с постановкой.** В плане написано «17 скриптов», в каталоге
`capabilities/mn-verify-gate/scripts/` их **19** (5799 строк). `plan-graph` уходит в задачу 5.3, а
`wave-survey` не вызывается ни одним гейтом, фрагментом или хуком. Без этих двух остаётся 17 —
вероятно, отсюда и число.

---

## 1. Инвентарь

Обозначения в колонке «вызывает»: **G** — гейт `capability.json` (точка, ключ `when`, таймаут
предиката). **F** — фрагмент `plan:pre`. **H** — человек или агент вручную. Все гейты сейчас имеют вид
`check.predicate.kind = command-exit-zero` с командой `node "$HOME/.gsd/mn-verify-gate/scripts/<x>.mjs" --dir "${PHASE_DIR}"`,
`blocking: true` и `onError: halt`. Коды выхода у всех скриптов, где не указано иное, такие: 0 —
чисто, 1 — находка, 2 — «не смог проверить». Код 2 считается отказом, потому что предикат
`command-exit-zero` воспринимает любой ненулевой код как `block`.

| # | Скрипт (строк) | Что делает | Входы → выход | Зависимости | Вызывает | Тесты (кейсов ≈) |
|---|---|---|---|---|---|---|
| 1 | `check-frontmatter` (139) | Проверяет, что поле во frontmatter артефакта фазы равно заданному значению. Отсутствие файла — провал, но с `--optional` — проход | `--dir --artifact --field --equals [--optional]`; коды 0/1 | fs | **G×6** `ship:pre`: `nyquist_enforce` (VALIDATION `nyquist_compliant=true`), `verify_enforce` (VERIFICATION `truths_unproven=0`), `verify_gates_enforce` (VERIFICATION `gates.all_passed=true`, вложенное поле), `mn_security_enforce` (SECURITY `threats_open=0`, optional), `mn_windows_enforce` (WINDOWS `open_count=0`, optional); таймаут 20 с | `mn-check-frontmatter` (10), часть `mn-contract-drift` |
| 2 | `uat-open` (174) | Есть ли в UAT фазы непроведённые пункты (`pending` и т.п.). Запускает `gsd-tools audit-uat --raw`, перебирая три жёстко заданных пути, включая `$HOME/.claude` и `$HOME/.gsd`, и фильтрует по фазе | `--dir`; 0/1/2 | fs, child_process (gsd-tools) | **G** `ship:pre` `uat_enforce`, 90 с | `mn-uat-gate` (8), `mn-enforcement-evals` (3), часть `mn-plan-status-gate` |
| 3 | `mutation-spot-check` (310) | Вносит мутации в изменённые фазой файлы, гоняет тестовую команду проекта и восстанавливает файлы; выживший мутант — провал | `--dir`, конфиг `workflow.mutation_test_command`, `workflow.mutation_max_mutants`; 0/1/2 | fs (**пишет в исходники**), child_process (команда тестов) | **G** `verify:pre` `mutation_spot_check`, **1800 с** | `mn-mutation-spot-check` (11) |
| 4 | `assertion-ratchet` (130) | Храповик: число ассертов и skip-маркеров не должно убывать относительно baseline. `--update` пишет baseline | `--baseline .planning/assertion-baseline.json [--update] [--paths]`; 0/1 | fs (пишет baseline), git (`rev-parse`) | **G** `verify:pre` `assertion_ratchet`, 120 с; **H** `--update` (по тексту описания ключа и сообщения `hooks/gsd-test-tamper-guard.js:276`) | `mn-assertion-ratchet` (8) |
| 5 | `migration-safety` (555) | Ищет в новых `.sql` фазы необратимые операции без декларации `-- gsd:irreversible` и проверяет согласованность `_journal.json` с `.sql` | `--dir [--strict]`; 0/1/2 | fs, git (диапазон коммитов, untracked) | **G×2** `execute:wave:post`: `migration_safety` и `migration_safety_strict` (с `--strict`), 60 с; **F** `plan-pre-migration` (без вызова скрипта) | `mn-migration-safety` (8) |
| 6 | `blast-radius` (483) | Изменённые фазой файлы (git diff) сверяет с объединением `files_modified` всех PLAN.md; незаявленный файл — провал | `--dir`; 0/1/2 | fs, git (numstat, first-parent) | **G** `verify:pre` `blast_radius`, 60 с; упоминается в `hooks/gsd-prohibition-guard.js` (тот же словарь `declaredFiles`) | `mn-blast-radius` (8) |
| 7 | `contract-drift` (400) | Сигнатуры из `## Contracts` в DESIGN.md сверяет с фактическими сигнатурами в коде | `--dir --root [--verbose]`; 0/1/2 | fs | **G** `verify:pre` `contract_drift`, 120 с | `mn-contract-drift` (15), части `plan-status-*`/`wave-normalize-drift` (импортирует словарь) |
| 8 | `wave-collision` (230) | Ищет пересечения `files_modified` у планов одной волны. Сравниваются только записи с точкой в имени; каталоги и глобы пропускаются | `--dir [--verbose]`; 0/1/2 | fs | **G** `plan:post` `wave_collision`, 60 с | `mn-wave-collision` (13), части `mn-files-modified-normalize`, `mn-orphan-plans` |
| 9 | `wave-normalize` (668) | То же, что `wave-collision`, но раскрывает каталоги и глобы по живому дереву | `--dir [--root --json --verbose]`; 0/1/2 | fs | **G** `plan:post` `wave_normalize`, 60 с | `mn-wave-normalize` (50), `mn-wave-normalize-drift` (3) |
| 10 | `wave-solve` (362) | Вычисляет волны (жадное послойное назначение: волна позже всех `depends_on`, без пересечений по файлам) и сравнивает с объявленными | `--dir [--json --verbose]`; 0/1/2 (2 также при цикле) | fs | **G** `plan:post` `wave_solve`, 60 с | `mn-wave-solve` (15) |
| 11 | `wave-survey` (361) | Исследовательский драйвер: прогоняет `wave-normalize` по многим деревьям; код 2 перебивает 1 | `--root --dir --json`; агрегат | fs, child_process (node) | **нигде** (критерий прошлой фазы форка) | `mn-wave-survey` (29) |
| 12 | `orphan-plans` (195) | Ищет план в `status: in_progress` без SUMMARY (брошенный исполнителем) | `--dir [--strict --verbose]`; 0/1/2 | fs | **G** `verify:pre` `orphan_plans`, 60 с | `mn-orphan-plans` (14), `plan-status.unit` (57, общий словарь) |
| 13 | `plan-status` (415) | Проверяет, что статус каждого PLAN.md читаем и допустим по словарю или матрице, и не пускает волну в неистолкуемом состоянии | `--dir`; 0/1/2 | fs | **G** `execute:wave:post` `plan_status_enforce`, 60 с | `mn-plan-status-gate` (27), `plan-status-vocabulary-drift` (10), `plan-status-readers-regression` (11) |
| 14 | `clean-state` (121) | Проверяет, что рабочее дерево чистое (кроме `.planning/`) и нет незавершённой операции git (MERGE_HEAD, rebase-* и т.д.) | `--dir`; 0/1/2 | git (`status`, `--git-path`) | **G** `ship:pre` `clean_state_enforce`, 30 с | `mn-clean-state` (15) |
| 15 | `plan-graph` (266) | Строит mermaid-граф фазы из `wave` и `depends_on` с подсветкой дефектов | `--dir [--out --strict]`; 0/1/2 | fs (пишет `--out`) | **H** | `mn-plan-graph` (20) → **задача 5.3** |
| 16 | `design-registry` (455) | Сопоставляет ноды дизайна с компонентами в коде (`--html` экспорт Pencil, `--registry` DESIGN-SYSTEM.md, `--pen`) | флаги; 0/1/2 | fs | **F** `plan-pre-design-registry.md` (два вызова `node "$HOME/.gsd/..."`) | **нет** |
| 17 | `zod-fieldtable` (159) | Строит таблицу полей и `erDiagram` по Zod-схеме проекта; делает `import()` пользовательского TS-модуля | `--module/--file --export`; 0/1 | **bun** (TS-рантайм), динамический `import`, `zod` из проекта | **F** `plan-pre-fieldtable.md` (`bun "$HOME/.gsd/..."`) | **нет** |
| 18 | `run-log-report` (242) | Сводка автономного прогона по `.planning/RUN-LOG.jsonl` | 0/1/2 | fs, git | **H**. **Писателя журнала в дереве нет**: `gsd_log` упомянут только в комментарии самого скрипта, `git grep RUN-LOG` вне `scripts/`/`tests/` пуст | `mn-run-log-report` (7) |
| 19 | `worktree-gc` (134) | Убирает брошенные worktree; ветки с уникальными коммитами не трогает никогда | `[--yes --older-than]`; всегда 0 | git (worktree, branch, rev-list) | **H** | `mn-worktree-gc` (6) |

Прочие ссылки на скрипты, которые придётся переписать:
- `capability.json` — описание `workflow.assertion_ratchet` (`node ~/.gsd/.../assertion-ratchet.mjs --update`);
- фрагменты `plan-pre-design-registry.md` и `plan-pre-fieldtable.md`;
- `hooks/gsd-test-tamper-guard.js:276` — текст для пользователя;
- комментарии в `hooks/gsd-prohibition-guard.js`, `src/plan-status.cts`, `src/frontmatter.cts`,
  `src/files-modified-normalize.cts`;
- сгенерированный `gsd-core/bin/lib/capability-registry.cjs` и `tests/emitted-drift-acks/*`.

Уже на `gsd_run`: шаг `verify:pre` → `gsd_run verify gates "${PHASE_DIR}" --raw`. Он лежит в
`src/verify-gates.cts`, подключён в `src/verify-command-router.cts` (+12 строк форка) — это прецедент.

---

## 2. Целевая форма (как устроено в upstream/next)

**Семейство для гейтов — `gsd_run check <verb>`.** `src/check-command-router.cts` (ADR-5057 §4,
#5139) сам ничего не решает. Каждый гейт — отдельный модуль `src/gate-<verb>.cts`. Модуль возвращает
`GateResult` из `src/gate-verdict.cts`:
- `GateVerdict { outcome: 'pass'|'block'|'skip'|'advisory', block, payload }`;
- `GateUsageFailure { failure: { code, message } }`.

Печатает только роутер — через `emitGateResult` → `output(payload, raw)`.

ESLint (`eslint.config.mjs:926-958`, тест `tests/check-router-gate-boundaries.test.cjs`) задаёт
границы. Модулям по glob `src/gate-*.cts` запрещено импортировать `io.cjs`, писать в
console/stdout/stderr и вызывать `process.stdout`. Роутеру запрещены `fs`, `child_process` и
exec/git-хелперы.

**Объявление в capability.json.** Есть две формы:
- `check.query: "<verb>"` — для встроенной логики. Так сделаны `ui.plan-gate`, `verify.schema-drift`,
  `api-coverage.verify-pre`, `tdd.review-checkpoint`. Роутер заменяет точки на дефисы.
- `check.predicate: { kind, ... }` — универсальный вычислитель (ADR-2008,
  `src/gate-predicate-evaluator.cts`). Знает два вида: `command-exit-zero` и
  `artifact-frontmatter-equals`. Последним уже пользуются upstream-капабилити `security`
  (SECURITY `threats_open=0`) и `broken-windows` (WINDOWS `open_count=0`).

`command-exit-zero` нужен для сторонних капабилити, логика которых живёт вне ядра. После переноса
`mn-verify-gate` становится первосторонней капабилити, и её гейты переходят на `check.query`.

**Санитизация query.** `gsd-core/references/loop-hook-dispatch.md` § `gate` требует проверять
query регуляркой `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$` в контексте модели. Регулярка **не
пропускает точки и `--`**. Значит, новые глаголы — чистый kebab-case с префиксом `mn-`, а
модификаторы — голые слова: `mn-migration-safety strict`. Upstream-запросы с точками эту проверку
не проходят — это несогласованность внутри upstream (см. риски).

**Как передаётся фаза** (`gsd_run check ${hook.check.query} <arg> --raw`):
- `"${PHASE_DIR}"` — в `ship.md:163`, `verify-work.md:89`, `plan-phase.md:1454` (плюс
  `"${PHASE_REQ_IDS}"`);
- `"${PHASE_NUMBER}"` — в `execute-phase/steps/wave-post-gate-hooks.md:11` и
  `verify-phase-goal.md:91`.

Поэтому глагол обязан принимать первый позиционный аргумент как номер **или** каталог и
игнорировать лишние. Для этого есть `resolvePhaseDirOrEmpty(projectDir, phase)` и
`resolveContainedPath` с защитой от выхода за корень (ADR-4650) в `src/gate-phase-context.cts`.
Предикат получает `--phase-dir`/`--phase-number` и подставляет `${PHASE_DIR}` сам.

**Контракт вывода.** Команда печатает JSON payload, обязательно с ключами `block` и `message`
(конверт `{block, message, details?}`, `gate-predicate.cts:8`), выход 0. Workflow проверяет гейт в два
шага (`wave-post-gate-hooks.md`, `verify-work.md:98`):
1. ненулевой код, пустой или нераспарсиваемый вывод → действует `onError` (`halt` или `skip`);
2. `block: true` у блокирующего гейта → HALT, независимо от `onError`.

**Коды выхода (ADR-3889).** 0 и 1 свободны. **2 зарезервирован за протоколом хуков** — никто
другой его не выдаёт. 3–13 запрещены, 64–78 — общие (`USAGE` 64, `NO_INPUT` 66, `UNAVAILABLE` 69,
`INTERNAL` 70), 80–125 — доменные с владельцем. Реестр — `gsd-core/bin/shared/exit-codes.json`,
генератор `scripts/gen-exit-code-registry.cjs`, `--check` входит в `lint:generated-sync`.
`io.error(msg, ERROR_REASON.X)` отображает причину на имя кода (`src/io.cts:513+`); проекция `v1`
сохраняет текущие числа. ADR-5057 §4: «код выхода — функция вердикта». Следствие: **«2 = не смог
проверить» из скриптов в новой форме не выживает** (решение — в §3).

**Конфиг.** Ключи читаются через `readWorkflowConfigValue(projectDir, dotKey)` из
`src/gate-config.cts` — с учётом workstream, тихо, без собственного парсинга `config.json`. `when`
в capability.json — один ключ-строка (`loop-resolver.cts:221`), выражений нет.

**ADR-457.** Исходники лежат в `src/*.cts` (strict TS), компилируются в `gsd-core/bin/lib/*.cjs`,
результат в gitignore. Только CommonJS и встроенные модули Node. При проверке «есть ли X» искать в
`src/*.cts`, а не в сгенерированном `.cjs`.

**Тесты.** Только `node:test` с `assert/strict`. Grep по исходникам и по свободному тексту вывода
запрещён (`local/no-source-grep`). Проверяется:
- **типизированная поверхность** — `evaluateX(...)` возвращает `GateVerdict`, проверяются
  `outcome`, `block`, поля payload;
- **CLI JSON** — через `runGsdTools`, поле `.block`.

Подпроцессы — только через `tests/helpers/process-seam.cjs`. Без `try/finally`. Часы инжектируются.
Для лимитов — проверка границ (`limit-1/limit/limit+1`), например у `mutation_max_mutants`.

**Регистрация.** Глагол `check` добавляется:
- в `switch` роутера и список `Available:` в `default`;
- в `docs/INVENTORY.md` и `docs/INVENTORY-MANIFEST.json` (семейство CLI-модулей потребляют тесты);
- в changeset-фрагмент.

Новый **семейный** роутер (не `check`) подключается в `gsd-core/bin/gsd-tools.cjs` по образцу
`feature-view`: `routeFeatureView`, строки 268 и 3338, плюс список команд на 3570.

---

## 3. Отображение

### 3.1 Архитектурные решения

1. **Глаголы гейтов — `gsd_run check mn-<x>`**, модули — `src/gate-mn-<x>.cts`. Имя попадает под
   ESLint-glob `src/gate-*.cts`, так что граница «модуль не печатает» включается без правки
   конфига. Чтобы не расползаться по upstream-роутеру, в `check-command-router.cts` добавляется
   **одна** ветка: `default:` → если `subcommand` начинается с `mn-`, вызвать
   `routeMnCheck(args, cwd, raw)` из `src/mn-check-router.cts`. Этот роутер форка повторяет форму
   upstream: argv → `evaluate*` → `emitGateResult`, без fs и child_process. Upstream-файл получает
   ~5 строк, и почти все будущие конфликты синхронизации уходят в файлы форка.
2. **Инструменты для людей и агентов (не гейты) — семейство `gsd_run mn <verb>`**, роутер
   `src/mn-command-router.cts`. Подключается в `gsd-tools.cjs` так же, как `feature-view`.
3. **«Не смог проверить» (бывший код 2)** → `gateVerdict('block', true, { status: 'unresolvable', reason, ... })`.
   Гейт закрывается при отказе (так задумано в форке), остаётся различимым в payload и не нарушает
   ADR-3889. Upstream-пробы (`unresolvableProbeVerdict`) в этом случае отдают `skip/false`. Но они
   рекомендательные, а гейты `mn-*` блокирующие, поэтому отклонение осознанное (открытый вопрос
   Q2). Ошибка вызова (нет аргумента, выход за корень) → `GateUsageFailure` → `error(usage)` →
   `onError: halt`.
4. **Внешние эффекты — через инжектируемые зависимости**: `{ runGit, runCommand, fs, clock }` по
   образцу `buildPredicateDeps`. Продакшн-реализация — `shell-command-projection.cjs` / `execFileSync`
   с массивом аргументов. Тесты работают без реального git там, где это возможно.
5. **Словари не дублируются.** Читатели статуса плана берут его из `src/plan-status.cts` и
   `src/plan-scan.cts` (upstream), читатели `files_modified` — из `src/files-modified-normalize.cts`
   и `plan-document.cts`, frontmatter — из `src/frontmatter.cts`. Drift-тесты
   (`plan-status-vocabulary-drift`, `mn-wave-normalize-drift`), которые сейчас сравнивают копии
   словаря в скриптах, после переноса теряют предмет и превращаются в проверку «один импорт».

### 3.2 Таблица

| Скрипт | Команда | Файл `src/*.cts` | Гейт в capability.json | Тест (перенос) |
|---|---|---|---|---|
| check-frontmatter ×5 | — (декларативно) | правка `gate-predicate-evaluator.cts`: у `artifact-frontmatter-equals` появляются **точечный путь `field`** (`gates.all_passed`) и **`optional: true`** (нет артефакта → `block:false`, `details.artifactNotFound`) | `check.predicate: { kind: "artifact-frontmatter-equals", artifact, field, equals[, optional] }`, те же `when` (`nyquist_enforce`, `verify_enforce`, `verify_gates_enforce`, `mn_security_enforce`, `mn_windows_enforce`) | `mn-check-frontmatter` → unit-тесты `evaluatePredicate` (совпало, не совпало, нет файла, optional, вложенное поле) с границами |
| uat-open | `check mn-uat-open` | `gate-mn-uat-open.cts`, внутри процесса поверх `uat.cts`/`audit-command-router` (логика `audit-uat`) — **без подпроцесса и без поиска gsd-tools по `$HOME`** | `ship:pre`, `uat_enforce`, `check.query: "mn-uat-open"` | `mn-uat-gate`, `mn-enforcement-evals` → verdict, CLI `.block` |
| plan-status | `check mn-plan-status` | `gate-mn-plan-status.cts` (два evaluator-а, общий словарь `plan-status.cts`) | `execute:wave:post`, `plan_status_enforce` | `mn-plan-status-gate`, `plan-status-readers-regression` |
| orphan-plans | `check mn-orphan-plans` | тот же `gate-mn-plan-status.cts` | `verify:pre`, `orphan_plans` | `mn-orphan-plans`, `plan-status.unit` (импорт меняется на модуль) |
| wave-collision | `check mn-wave-collision` | `gate-mn-waves.cts` (поверх `files-modified-normalize.cts`) | `plan:post`, `wave_collision` | `mn-wave-collision`, `mn-files-modified-normalize` |
| wave-normalize | `check mn-wave-collision expand` (тот же глагол с раскрытием каталогов и глобов) | `gate-mn-waves.cts` | `plan:post`, `wave_normalize`, query `"mn-wave-collision expand"` | `mn-wave-normalize` (50 кейсов → на verdict) |
| wave-solve | `check mn-wave-solve` | `gate-mn-waves.cts`, композиция upstream-модулей: `computeDependencyLevels` (`phase.cts`, экспортирован) → `partitionByFileOverlap` (`file-overlap-partitioner.cts`) внутри уровня, на нормализованных записях | `plan:post`, `wave_solve` | `mn-wave-solve` |
| blast-radius | `check mn-blast-radius` | `gate-mn-blast-radius.cts` | `verify:pre`, `blast_radius` | `mn-blast-radius` |
| contract-drift | `check mn-contract-drift` | `gate-mn-contract-drift.cts` (корень = `projectDir`, флаг `--root` не нужен) | `verify:pre`, `contract_drift` | `mn-contract-drift` |
| migration-safety | `check mn-migration-safety` / `check mn-migration-safety strict` | `gate-mn-migration-safety.cts` | `execute:wave:post`: две записи сохраняются (`migration_safety` → `"mn-migration-safety"`, `migration_safety_strict` → `"mn-migration-safety strict"`) | `mn-migration-safety` |
| clean-state | `check mn-clean-state` | `gate-mn-clean-state.cts` | `ship:pre`, `clean_state_enforce` | `mn-clean-state` |
| assertion-ratchet | `check mn-assertion-ratchet` (только чтение) + `mn assertion-baseline` (запись `--update`) | `gate-mn-assertion-ratchet.cts` + общий счётчик `mn-assertion-count.cts` | `verify:pre`, `assertion_ratchet` (путь baseline фиксирован: `.planning/assertion-baseline.json`) | `mn-assertion-ratchet` → два набора: verdict и команда записи |
| mutation-spot-check | `check mn-mutation-spot-check` | `gate-mn-mutation-spot-check.cts`; восстановление файлов при любом исходе и по сигналу; бюджет из `mutation_max_mutants` и таймаут на одного мутанта | `verify:pre`, `mutation_spot_check` | `mn-mutation-spot-check` (временные каталоги, инжектируемый раннер) |
| design-registry | `mn design-registry` | `mn-design-registry.cts` | — (фрагмент) | **новый** тест (сейчас тестов нет) |
| zod-fieldtable | `mn zod-fieldtable` | `mn-zod-fieldtable.cts`: чистый рендер таблицы и ER из объекта схемы; загрузчик схемы — дочерний процесс `bun` (запускается через process-seam), отдаёт JSON-описание схемы | — (фрагмент) | **новый** тест на рендер (фикстура JSON-описания); загрузчик — интеграционный, `skip`, если нет bun |
| worktree-gc | `mn worktree-gc` | `mn-worktree-gc.cts` | — | `mn-worktree-gc` |
| plan-graph | `plan graph` | `src/plan-graph.cts` | — | **задача 5.3** (не здесь) |
| wave-survey | **выкинуть** | — | — | `mn-wave-survey` удаляется |
| run-log-report | **выкинуть** (у журнала нет писателя) | — | — | `mn-run-log-report` удаляется |

**Итого: 15 новых команд и одно расширение предиката.** 11 глаголов `check mn-*`: uat-open,
plan-status, orphan-plans, wave-collision (с `expand`), wave-solve, blast-radius, contract-drift,
migration-safety (со `strict`), clean-state, assertion-ratchet, mutation-spot-check. 4 инструмента
`mn *`: assertion-baseline, design-registry, zod-fieldtable, worktree-gc. Модулей `gate-mn-*` —
9 (plan-status и waves объединены).

### 3.3 Что выкидывается или объединяется — и почему

- **`check-frontmatter` → встроенный предикат.** Сам скрипт объясняет, зачем существует: в
  опубликованном 1.9.1 не было `artifact-frontmatter-equals` (`check-frontmatter.mjs:1-12`). В
  upstream/next предикат есть, им пользуются `security` и `broken-windows`. Не хватает только
  вложенного поля (`gates.all_passed`; сейчас берётся `fm[field]` по плоскому ключу) и `optional`
  (сейчас отсутствие артефакта → block). Обе вещи — небольшое обобщение upstream-вычислителя, его
  стоит предложить upstream отдельным issue. Так `mn_security_enforce`/`mn_windows_enforce`
  сохраняют семантику «нет файла — нет угроз», хотя upstream-ключи `security_enforcement`/`windows_enforce`
  в этом случае блокируют.
- **`wave-normalize` ⊃ `wave-collision`.** По собственному тексту, normalize — это collision «со
  зрением». Ядро нормализации уже перенесено в `src/files-modified-normalize.cts`. Остаётся один
  глагол с модификатором `expand`; конфиг-ключи сохраняются, каждый указывает на свой вариант
  query.
- **`wave-solve` — наполовину дубль upstream.** `cmdPhasePlanIndex` в `phase.cts` уже строит
  уровни DAG (`computeDependencyLevels`, Kahn), находит циклы и неразрешённые `depends_on` и
  предупреждает «declared wave X but depends_on DAG places it in wave Y». Более того, upstream
  **сам подменяет** объявленную волну вычисленной (`effectiveWave = computedWave`). Пересечения по
  файлам внутри волны upstream в `phase-plan-index` не разводит. Их делят только
  `claude-orchestration` и `quick-batch` через `partitionByFileOverlap`, сравнивая точным
  совпадением строк без нормализации. Агент `gsd-plan-checker` лишь *описывает* это правило
  (Dimension 3 и «wave guard #3003»), это проза для LLM, а не код. Поэтому собственные топосорт и
  разбор графа выкидываются, а глагол становится композицией upstream-функций и нормализации форка.
  Свой код остаётся только для сравнения «вычислено ↔ объявлено» и выдачи вердикта.
- **`wave-collision` против upstream.** Детерминированной проверки пересечений `files_modified` в
  одной волне в upstream нет ни как гейта, ни в `phase-plan-index`. «Wave guard» в
  `execute-phase-wave-guard.md` — это проверка базы worktree (#1369), не пересечений. Значит,
  гейт не дублирует upstream и остаётся.
- **`uat-open` — частичный дубль.** Логика `audit-uat` (upstream `audit-command-router.cts`) уже
  есть. Гейт сводится к фильтру по фазе поверх неё, внутри процесса. Upstream `phase uat-passed`
  (`uat-predicate.cts`) проверяет другое — `result:`, а не pending-пункты — и заменой не является.
- **`clean-state`** дублирует только инструкцию модели в `ship.md:72` («Clean working tree?», без
  механизма). Остаётся.
- **`worktree-gc`** не равен upstream `worktree reap-orphans` в `worktree-safety.cts`: тот убирает
  только worktree с файлом `locked`. Остаётся в семействе `mn` — правка большого upstream-файла
  означала бы постоянные конфликты. Расширение `reap-orphans` можно предложить upstream отдельным
  issue.
- **`wave-survey`** — исследовательский драйвер прошлой фазы, его никто не вызывает. Удаляется.
- **`run-log-report`** читает `.planning/RUN-LOG.jsonl`, но писателя у журнала нет
  (`gsd_log` есть только в комментарии скрипта). Удаляется, если владелец не укажет внешний
  источник (Q5).
- **`plan-graph`** переносится в задаче 5.3. Здесь только порядок: скрипт удаляется после неё.

---

## 4. Миграция

### 4.1 Порядок: одно семейство за коммит, гейт и тесты атомарно

Каждый коммит одновременно:
- добавляет модуль или модули;
- переводит записи `gates` в `capability.json` с `command-exit-zero` на `check.query` или
  `predicate`;
- переносит тесты и удаляет перенесённые скрипты;
- запускает `npm run regen:derived` (registry) и `npm run lint:generated-sync`.

Пока скрипт и глагол сосуществуют, временный golden-тест эквивалентности (по образцу
`tests/check-router-cutover-equivalence.test.cjs`) гоняет старый скрипт и новый глагол на одних
фикстурах и сравнивает `exit≠0` с `block`. Он удаляется вместе со скриптом.

| Коммит | Содержание | Удаляемые скрипты |
|---|---|---|
| C0 `feat(mn): check delegation and mn family` | `src/mn-check-router.cts`, `src/mn-command-router.cts`, общий `src/gate-mn-support.cts` (`resolvePhaseDirOrEmpty` + вердикт `unresolvable` + чтение конфига через `gate-config`), одна ветка в `check-command-router.cts`, регистрация `mn` в `gsd-tools.cjs`, INVENTORY | — |
| C1 `feat(gate): frontmatter predicate dotted field + optional` | расширение `gate-predicate-evaluator.cts`, 5 гейтов → predicate | `check-frontmatter` |
| C2 plan-status | `gate-mn-plan-status.cts` (plan-status + orphan-plans) | `plan-status`, `orphan-plans` |
| C3 waves | `gate-mn-waves.cts` (collision/expand/solve) | `wave-collision`, `wave-normalize`, `wave-solve`, `wave-survey` |
| C4 git-diff | `gate-mn-blast-radius`, `gate-mn-contract-drift`, `gate-mn-migration-safety`, `gate-mn-clean-state` | 4 скрипта |
| C5 test-quality | `gate-mn-assertion-ratchet` + `mn assertion-baseline`, `gate-mn-mutation-spot-check`; правка текста `hooks/gsd-test-tamper-guard.js:276` и описания ключа | `assertion-ratchet`, `mutation-spot-check` |
| C6 uat | `gate-mn-uat-open` | `uat-open` |
| C7 tools + fragments | `mn design-registry`, `mn zod-fieldtable`, `mn worktree-gc`; фрагменты переходят на `gsd_run mn …`; новый фрагмент в `tests/emitted-drift-acks/` (ADR-2719) | `design-registry`, `zod-fieldtable`, `worktree-gc`, `run-log-report` |
| C8 cleanup | удаление `capabilities/mn-verify-gate/scripts/` (после 5.3), правка комментариев в hooks/src, `.plans/mn-fork-worklog.md` (строки 8-11, 63-79, 405-408), changeset | `plan-graph` (если 5.3 закрыта) |

Сообщения коммитов — conventional, номер issue в scope. Каждый коммит проходит
`npm run test:affected` и `npm run lint:ci`.

### 4.2 Совместимость

- **Все ключи `workflow.*` и их `when` сохраняются** — меняется только `check`. Значения по
  умолчанию (`false`) не меняются.
- Параметры, которые раньше шли флагами (`--strict`, `--optional`, `--root`, `--baseline`),
  переходят в слово query, поле предиката, `projectDir` или фиксированный путь. Пользовательских
  флагов, видимых снаружи, у гейтов не было (их задавала капабилити), так что внешний контракт не
  ломается.
- Инструменты `mn *` сохраняют флаги скриптов (`--html/--registry/--pen/--code/--map`,
  `--file/--module/--export`, `--yes/--older-than`), чтобы фрагменты переписывались механически.
- `mn-verify-gate.version` поднимается; `engines.gsd` поднимается до версии, где есть
  `check mn-*` и расширенный предикат.

### 4.3 Фрагменты

`plan-pre-design-registry.md` и `plan-pre-fieldtable.md`: `node|bun "$HOME/.gsd/mn-verify-gate/scripts/<x>.mjs" …`
→ `gsd_run mn <x> …`. Агенты upstream уже вызывают `gsd_run` (`gsd-plan-checker.md:876`). Правка
меняет эмитируемые байты, поэтому нужен per-PR фрагмент в `tests/emitted-drift-acks/` — не legacy
`emitted-drift-ack.json`. Остальные четыре фрагмента скрипты не вызывают, их правка не нужна.

### 4.4 Удаление `scripts/` и `~/.gsd/mn-verify-gate`

- `capabilities/mn-verify-gate/scripts/` удаляется в C8 (поскриптово — уже в C1–C7). Перед этим
  проверить, что `bin/install.js` не копирует `capabilities/*/scripts` (упоминания `scripts` в нём
  касаются только генераторов registry, #1920).
- `~/.gsd/mn-verify-gate/` и временная копия `~/.gsd/capabilities/mn-verify-gate` из задачи 1.3
  лежат вне репозитория. Их удаляет владелец после установки новой версии, а шаг вносится в
  приёмку 3.12. Если оставить `~/.gsd/capabilities/mn-verify-gate`, повторно возникнет дубль id
  из 1.3, причём со старыми гейтами на `$HOME`.

### 4.5 Приёмка (воспроизводимые команды)

```bash
git grep -n 'HOME/\.gsd\|~/\.gsd/mn-verify-gate' -- capabilities hooks src agents gsd-core   # пусто
command ls capabilities/mn-verify-gate/scripts 2>&1                                           # No such file
node --test tests/mn-*.test.cjs tests/plan-status*.test.cjs                                   # зелёные
node gsd-core/bin/gsd-tools.cjs loop render-hooks ship:pre --raw | jq '[.activeHooks[]|select(.capId=="mn-verify-gate")|.check]'
#   → только {query:"mn-…"} и {predicate:{kind:"artifact-frontmatter-equals",…}}, ни одного command-exit-zero
node gsd-core/bin/gsd-tools.cjs check mn-plan-status <phase> --raw | jq -e 'has("block") and has("message")'
npm run lint:generated-sync && npm run check:alias-drift
```

Плюс повторить на реальной фазе приёмку задачи 3.5: ни одного `status:"unresolvable"` там, где
раньше было «0/1 по смыслу».

---

## 5. Риски и открытые вопросы

### Риски

1. **Таймауты пропадают.** У `command-exit-zero` был собственный `timeout` на гейт (20…1800 с), у
   `check.query` его нет. Workflow вызывает `gsd_run check …` из Bash-инструмента: лимит по
   умолчанию 2 мин, максимум 10. Для `mutation-spot-check` (1800 с) это прямой провал. Глагол
   обязан сам ограничивать время (бюджет мутантов и таймаут на мутанта) и укладываться в 10 мин.
   Иначе — разделить на запуск и чтение результата (Q3).
2. **Мутация исходников внутри процесса gsd-tools.** Падение посреди прогона оставляет файл
   мутированным. Нужны восстановление в `finally` на уровне модуля и обработчики сигналов, а тесты
   должны работать только во временных каталогах.
3. **Несогласованность upstream.** Документированная регулярка query не пропускает точки, а
   upstream-запросы с точками есть. Глаголы `mn-*` без точек проходят в обоих прочтениях; но если
   upstream ужесточит регулярку, это его проблема, если ослабит — наша схема не пострадает.
4. **Разные аргументы фазы по точкам** (`PHASE_DIR` / `PHASE_NUMBER` / `+REQ_IDS`). Ошибка в
   разборе превратит каждый гейт в `unresolvable` и заблокирует всё. Нужен матричный тест «каждый
   глагол × каждая форма аргумента».
5. **Расхождение с upstream в двух файлах:** `gate-predicate-evaluator.cts` (расширение) и
   `check-command-router.cts` (делегирование `mn-*`). Роутер upstream часто правит, и при синке
   будут конфликты. Смягчение: изменение в одну ветку и issue upstream на расширение предиката.
6. **Паритет поведения.** Скрипты разбирают frontmatter и планы своими мини-парсерами. Upstream
   `frontmatter.cjs` и `plan-scan` по-другому типизируют значения (`"0"` против `0`, js-yaml) и
   учитывают `superseded` и вложенную раскладку (#3139). Golden-тест эквивалентности обязателен
   на переходный коммит; задачу 3.5 после переноса прогнать заново.
7. **`zod-fieldtable` требует TS-рантайм** с резолвом алиасов tsconfig. Node 24 умеет снимать
   типы, но не понимает `paths`. Значит, остаётся дочерний `bun`: без bun — `unresolvable`,
   рендер тестируется отдельно.
8. **Закрытие при отказе против upstream-практики.** `status: unresolvable` → `block: true`
   отличается от рекомендательных проб upstream (`skip`). Если владелец выберет код `UNAVAILABLE`
   через `error()`, гейт будет зависеть от `onError` (у всех сейчас `halt`, эффект тот же).
9. **Удаление тестов** `mn-wave-survey` (29) и `mn-run-log-report` (7) снижает число кейсов `mn-*`.
   Формулировку приёмки «все тесты `mn-*` зелёные» нужно читать как «перенесённые», а удалённые
   перечислить в changeset.

### Открытые вопросы

- **Q1.** Расширять upstream-предикат (`field` с точками и `optional`) или держать глаголы
  `check mn-frontmatter-*`? Глагол не может принимать параметры: регулярка query не пропускает
  `.md`, заглавные буквы и `=`, так что параметризованная проверка возможна только через
  предикат. Рекомендация — расширение плюс issue upstream.
- **Q2.** «Не смог проверить»: вердикт `block` со `status: unresolvable` (рекомендация) или
  `error(ERROR_REASON → UNAVAILABLE)`?
- **Q3.** `mutation-spot-check`: уложить в 10 мин бюджетом или вынести в шаг (`steps`, `produces`) и
  оставить гейту только чтение артефакта?
- **Q4.** Слить `migration_safety` и `migration_safety_strict` в один гейт, где строгость читается
  из конфига (`gate-config`)? При `when` из одного ключа это меняет поведение для тех, у кого
  включён только strict. По умолчанию оставляем две записи.
- **Q5.** Есть ли внешний писатель `.planning/RUN-LOG.jsonl` (хук в `~/.claude` пользователя)? Если
  есть — `mn run-log-report` остаётся, если нет — удаляется.
- **Q6.** Нужно ли добавлять модули `gate-mn-*` в явный список `GATE_MODULES` теста
  `check-router-gate-boundaries`? Glob ESLint их уже покрывает; правка списка — ещё одно
  расхождение с upstream.
- **Q7.** Регистрировать ли семейство `mn` в `docs/CLI-TOOLS.md` и реестрах паритета? Это тот же
  вопрос, что открыт для `feature-view` и `verify gates` в решениях синка.

## Решения по рискам (интегратор, 2026-10-04)

1. Мутационный гейт (1800 с) — не гейт с долгим `check.query`, а **шаг**, записывающий результат в
   `VERIFICATION.md` (как `verify gates`), и дешёвый гейт по записи. Таймауты не растягивать.
2. «Не смог проверить» → `block: true`, статус `unresolvable`, причина в `message` (fail-closed, ADR-3889).
3. Фаза — везде `--phase N` с общим резолвером каталога фазы (как вызывает диспетчер upstream);
   позиционный `<phase-dir>` поддерживается для совместимости.
4. Имена query — без точек и `--` (`mn-wave-collision` и т.п.); параметры — из конфига, не из query.
5. Регистрация команд: сначала найти точку расширения upstream без правки роутера; если её нет —
   свести к одной строке регистрации (найдено: `commands` в capability.json, ADR-959). Upstream-предложений не заводить.
6. Переходный тест эквивалентности «скрипт ↔ команда» на общих фикстурах до удаления скриптов.
7. `wave-survey` и `run-log-report` удалить (нет вызывающих / нет писателя журнала).
