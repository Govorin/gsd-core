# Решения по конфликтам синхронизации (фаза 2: задачи 2.6 и 2.8)

Составлено 2026-10-03. Только чтение: ни ветки, ни рабочее дерево не менялись.
Основание: `git log` / `git diff` / `git show` / `git merge-tree` между `cbd180c5c` (общий предок),
`next` = **`195582f1f`** и `upstream/next` = **`bd93e0aa9`**.

> ⚠ `upstream/next` ушёл вперёд: план (`upstream-sync-plan.md` 2.1) называет `8cca2e172`, сейчас tip —
> `bd93e0aa9` (2026-10-03). `merge-tree` на текущих tip'ах даёт **66 конфликтов** (50 по содержимому,
> 16 modify/delete-строк, из них две — один файл `claude-md.md`: rename/delete + modify/delete).
> `next` за время разбора получил три коммита (`4b3e27b52`, `273a91853`, `195582f1f`); из файлов
> списка они тронули только `agents/gsd-ui-checker.md` — разбор ниже сделан по `195582f1f`.

## Сводка

| Категория | Кол-во | Файлы |
|---|---|---|
| Разобрано | **35** (20 из 2.6, включая серию `--cwd`, + 15 из 2.8) | |
| «Взять upstream» (правка форка здесь не нужна или уехала в другое место без переноса текста) | **13** | `verify-work.md`, `markdown-table.cts`, `templates/codebase/*` ×5, `templates/discovery.md`, `templates/host/claude-md.md`, ack-фрагменты ×4 |
| «Взять upstream + перенести правку форка в тот же файл» | **18** | все `src/*.cts` из 2.6 кроме `markdown-table`, три агента, `hooks.json`, `package.json`, `eslint.config.mjs`, `autonomous.md`, `undo.md`, `diagnose-issues.md`, `gsd-tools.cjs`, `tdd.md`, серия `--cwd` |
| «Переосмыслить: перенести смысл в другое место» | **4** | `plan-milestone-gaps.md`, `fix-2297`, `fix-3045`, `issue-2517` |

### Самое рискованное (подробности — в строках таблиц)

1. **`verify:pre`-шаг `mn-verify-gate` не пройдёт общий диспетчер upstream** (относится к
   `verify-work.md`, но чинить надо в `capabilities/mn-verify-gate/capability.json` и
   `src/verify-command-router.cts`). У форка `ref.command` = `gsd_run verify gates "${PHASE_DIR}" --raw`.
   Upstream (`references/loop-hook-dispatch.md` § `step`) сверяет `ref.command` с
   `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$` (подчёркивание, кавычки, `$`, `--` не проходят) и при
   несовпадении **молча пропускает хук с предупреждением**; прошедший запускается как
   `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw`. Значит: (а) нужен
   `"command": "verify gates"` (как у upstream `intel api-surface`, `refactor evaluate`);
   (б) маршрутизатор `verify gates` сейчас берёт первый аргумент без `-` как каталог фазы — получит
   номер `3`, сделает `path.resolve(cwd,'3')` → `phase_dir_not_found`, exit 2, `onError: skip` —
   опять молча. Итог без правки: блок `gates:` не пишется, гейт `verify_gates_enforce` читает пустоту —
   ровно класс дефекта, с которого начинается worklog.
2. **Потолки размера агентов** (`tests/agent-size-budget.test.cjs` upstream: LARGE 49152, DEFAULT
   24576, плюс побайтовый `tests/agent-size-baseline.json`). Оценка «upstream + дельта форка»:
   `gsd-verifier` ≈ 50104 > 49152, `gsd-ui-auditor` ≈ 27542 > 24576 (upstream уже 24569 — 7 байт до
   потолка), `gsd-executor` ≈ 50332 > 49152 (известно, 3.8). План 3.8 видит только executor.
   Оценка арифметическая, не прогон.
3. **`gsd-ui-checker`: обе стороны добавили «Dimension 7» с разным смыслом** — upstream
   «Inventory Provenance» (#2845) и уже поменял счётчики на «7» (в т.ч. `ui-phase.md`), форк —
   «Design Contract (.pen)». Механическое разрешение даст два раздела «Dimension 7» и неверные счётчики.

Следом по риску: `hooks.json` против нового теста upstream `plugin-manifest.test.cjs` (не знает
событий `PostCompact`, `WorktreeCreate`); `state.cts` — у upstream предупреждения стали объектами
`stateDiagnostic(code, …)`; `plan-milestone-gaps.md` — с удалением теряется единственный сброс
`[x]`→`[ ]`.

---

## 2.6 — ручные конфликты

| Файл | Форк (коммиты, зачем) | Upstream (ключевое) | Пересечение | Рекомендация | Риск |
|---|---|---|---|---|---|
| `src/frontmatter.cts` | `2aecaf7dd`, `4770dc07d`: механизм `allowedValues` рядом с `requiredValues`; словарь `status` плана (из `plan-status.cts`) и `feature` (из сгенерированного `feature-vocabulary.cts`); таблица полей-спутников (`blocked`→`blocked_reason`, `superseded`→`superseded_by`); четвёртый проход в `cmdFrontmatterValidate`, `errors[]` только при ошибке. +180/−3 | 13 коммитов, +1338/−391: вендорный js-yaml вместо самописного парсера (#3888), шов `PlanningDoc` (#4918), писатель вынесен в `frontmatter-splice.cts` (#5105) с отказом `FrontmatterWriteRefusedError`. `FRONTMATTER_SCHEMAS` и `requiredValues` остались той же формы (`frontmatter.cts:1377`), вывод `cmdFrontmatterValidate` тот же (`:1699`) | Не пересекаются по смыслу: у upstream нет ни статуса плана, ни `feature`, ни `allowedValues` | **Взять upstream + перенести 4 блока форка**: импорты `plan-status.cjs`/`feature-vocabulary.cjs`; `PLAN_ALLOWED_VALUES` + тип схемы с `allowedValues` + `allowedValues` в `plan` и `plan-gap-closure`; `STATUS_COMPANION_FIELDS`; четвёртый проход и `result.errors` вместо однострочного `output(...)` | Средний. Типы значений после js-yaml не сверены: если парсер теперь отдаёт не строку (число, bool), `normalizePlanStatus` и проверка `blocked_reason` должны это пережить. Не проверено прогоном. Зависит от решения владельца по `feature` (вопрос 2) |
| `src/markdown-table.cts` | `c0abd63ab`: `updateTableCell` проходит мимо таблицы без нужной колонки (легенда перед таблицей Traceability). +102/−51, 2 теста в `tests/markdown-table.test.cjs` | `864f76b46` (#3255/#3377): **то же самое** — ищет первую валидную таблицу с нужной колонкой; плюс ещё 4 коммита (quick-tasks) | Upstream сделал то же самое. Отличие: форк по сообщению коммита ещё и проходит мимо таблицы, где колонка есть, а строки нет; upstream там возвращает `no matching row`. Тесты форка этот случай **не** покрывают | **Взять upstream.** Два теста форка (`#4102: …legend table…`, `…every candidate table lacking the column…`) добавить в `tests/markdown-table.test.cjs` upstream как регрессию (они тоже в конфликте) | Низкий. Что тесты форка зелёные на коде upstream — не прогонялось |
| `src/state.cts` | `47da6d6a2`: в `cmdStateValidate` якорный разбор `status:` вместо `/status:\s*passed/i` (тот ловил `passed-degraded`), предупреждение о неканоничном статусе, `drift.verification_status_vocabulary`. +17/−1 | 62 коммита, +4043/−541. Строка `/status:\s*passed/i` **осталась** (`state.cts:5976`), но предупреждения теперь `stateDiagnostic('S006', SEVERITY.WARNING, msg, remedy)`; есть закрытый `VERIFICATION_STATUS` и `VERIFIER_STATUSES` в `verification.cts` (экспортированы) | Upstream ошибку не исправил; форма предупреждений несовместима (строка vs объект) | **Взять upstream + переписать правку форка под его API**: словарь брать из `verificationMod.VERIFIER_STATUSES` (не локальный массив); для неканоничного статуса — новый код `S010` через `stateDiagnostic` (и где регистрируются коды — дописать); условие S006 → `declared === 'passed'` | Средний: реестр кодов диагностики не изучен; возможен тест на полный список S-кодов |
| `src/verify.cts` | `2845c6813`: `import verifyGates = require('./verify-gates.cjs')` и реэкспорт `cmdVerifyGates`. +8 | 33 коммита (почти полная переработка), блок `export = {…}` на месте (`:2765`), добавлены `computeContextDrift`, `cmdVerifyContextDrift` | Нет | **Взять upstream + 2 строки форка** (импорт, ключ в `export`) | Низкий. Зависимость `verify-gates.cts` от API frontmatter (`spliceFrontmatter` теперь может отказать) — вопрос задачи 2.2, не этого файла |
| `src/project-root.cts` | `2611a5449`: `findProjectRoot(startDir, {declaredOnly})` — для явно названного `--cwd` подъём вверх только по явной заявке предка (`sub_repos`/`multiRepo`), без эвристик «.git + родительский .planning» и «ближайший .planning». +36/−1 | `5aaf7ef27` (#4815): не считать границей git симлинк `.planning`; `setExplicitProjectRoot`/`resolveProjectRoot` для `--project-dir` (#4894) | Смежно, не одно и то же: `--project-dir` у upstream **обязан уже содержать `.planning/`** (`gsd-tools.cjs:5276`), поэтому бутстрап `gsd-new-project --cwd libs/modules/<name>` им не решается | **Взять upstream + перенести `declaredOnly`** (параметр, `continue` в ветке «.git + parent», ранний `return startDir` перед эвристикой 4). Тесты форка из `tests/project-root.test.cjs` (тоже в конфликте) — дописать к upstream | Средний: два механизма «явного корня» рядом — см. вопрос 4 |
| `src/command-aliases.cts` | `2845c6813`: алиас `verify.gates` (`mutation: true`) в конце `VERIFY_COMMAND_ALIASES` | +45: в тот же конец добавлен `verify.context-drift` | Только текстовая коллизия | **Взять upstream + добавить запись форка после `context-drift`**; затем `npm run check:alias-drift` | Низкий |
| `src/verify-command-router.cts` | `2845c6813`: метод `cmdVerifyGates` в интерфейсе, маршрут `gates` (первый аргумент без `-` = каталог фазы, `--strict`) | +2: `context-drift` | Текстовая коллизия; **смысловая** — с общим диспетчером upstream (см. «Самое рискованное» №1) | **Взять upstream + перенести маршрут форка, и расширить его**: принимать `--phase <N>` (резолвить в каталог тем же путём, что `find-phase`), позиционный каталог оставить для ручного вызова. Тест на форму вызова диспетчера: `verify gates --phase 3 --raw` | **Высокий**, если пропустить расширение — молчаливый провал гейтов |
| `agents/gsd-verifier.md` | `b736def67` (MCP-инструменты в `tools:`), `a814850c4` (Step 2a-bis: `AC-n` из `SPEC.md` как `spec_truths`, без права планов их вычитать), `f4de5939b` (`truths_unproven` — число для гейта `ship:pre`, обязательно даже при 0). +17/−1, +2071 байт | 15 коммитов, +61/−12: Resolver Bootstrap, coincidental-reliance (5c), advisory в re-verification, `covered_files`/`covered_digest`, самопроверка статуса (#5118). Ни `SPEC.md`/`AC-n`, ни `truths_unproven` нет | Не пересекаются по смыслу; соседние строки (Step 2/Resolver, шаблон frontmatter) | **Взять upstream + 3 правки форка** (строка `tools:`, Step 2a-bis, строки `truths_unproven` в Step 9 и в шаблоне frontmatter). **Затем ужать**: ≈50104 > LARGE 49152 — вынести текст Step 2a-bis и обоснование `truths_unproven` в лениво читаемый reference (ADR-1610 запрещает eager `@` ради размера); обновить `agent-size-baseline.json` (`npm run size:baseline`) | **Высокий** (потолок размера); куда выносить — вопрос 7 |
| `agents/gsd-ui-checker.md` | `b736def67` (MCP в `tools:`), `273a91853` (вчера-сегодня): «Dimension 7: Design Contract (.pen)», счётчики 6→7 | `4918c62d7` (#2845): **своя «Dimension 7: Inventory Provenance»**, счётчики 6→7, `required_property` у каждой проверки; `1017898cb` (#3771) | **Несовместимо по нумерации**; по смыслу соседи (provenance инвентаря ↔ контракт `.pen` как источник перечисления) | **Взять upstream + перенести `.pen` как «Dimension 8»**: счётчики 7→8 в `description`, абзаце Auditor, таблице вывода, «No re-reads», чек-листе; `ui-phase.md` («Check all 7», «All 7» → 8). Добавить `required_property` в стиле upstream. Размер ≈22145 < 24576 — проходит | Средний; вариант «слить с Dimension 7» — вопрос 3. Открытое из worklog: хардкод `bun tools/ui-system/...`, glob `**/*.contract.json` |
| `agents/gsd-mempalace-curator.md` | `b736def67`: MCP в `tools:` | `529480b4a` удалил соседнюю строку `model: sonnet` (#4048), +блок Mandatory Initial Read, `!== false` (#3527, #5184) | Только текстовая коллизия | **Взять upstream + строка `tools:` форка**; `model: sonnet` не возвращать | Низкий |
| `hooks/hooks.json` | `daadafb5b`, `57b25bb0f`, `74129324d`: файл переформатирован в многострочный JSON; добавлены `gsd-pin-invariants` (SessionStart 5, PostCompact 5), `gsd-prohibition-guard` и `gsd-test-tamper-guard` (PreToolUse `Write\|Edit\|MultiEdit`, 120), `gsd-exit-gate` (SubagentStop, 620), `gsd-worktree-provision` (WorktreeCreate, 620) | `f052e5eb2` (#5180): блокирующие стражи на 120 (prompt, worktree-path, write, agent-isolation); `77e2472ca` (#4236): `gsd-secret-read-guard` (`Read\|Grep\|Bash`). Однострочный стиль сохранён | Таймауты: upstream сделал для своих то же, что форк для своих. Конфликт почти целиком — из-за переформатирования форка | **Взять upstream (его формат) + дописать 6 записей форка однострочно** с теми же таймаутами. Затем: в `tests/plugin-manifest.test.cjs` (новый у upstream, 1296 строк) добавить `PostCompact`, `WorktreeCreate` в `validEvents` — иначе тест красный; блокирующие стражи форка внести в `BLOCKING_GUARD_NAMES` (`runtime-hooks-surface`), тогда `blocking-guard-budget-parity` будет их проверять (задача 3.2). `managed-hooks-registry.cjs` у форка уже содержит 5 хуков и сливается без конфликта | Средний: `validEvents` — гарантированное падение теста; что `PostCompact`/`WorktreeCreate` поддержаны плагинным `hooks.json` Claude Code — не проверено |
| `package.json` | `5aaa309e2`, `e1d931edc`: в `regen:derived` и `lint:generated-sync` добавлены `gen-feature-vocabulary.cjs` и `gen-template-registry.cjs` | 64 коммита: версия 1.15.0, `engines`, обе цепочки сильно выросли (`gen-features`, `gen-state-md-docs`, `gen-*-cli-exit`, `gen-exit-code-*`, `gen-platform-conformance-tier`…) | Нет по смыслу | **Взять upstream + вставить 2 генератора форка** в обе цепочки — **только для тех, что владелец оставляет** (вопросы 1, 2) | Низкий. Имя: у upstream есть `gen-features.cjs` (FEATURES.md) — не путать с `gen-feature-vocabulary.cjs` |
| `eslint.config.mjs` | `2845c6813`, `8158deea8`, `bac00fda3`: в глобальные `ignores` (ADR-457) 5 сгенерированных `.cjs`: `verify-gates`, `files-modified-normalize`, `plan-status`, `feature-vocabulary`, `feature-view` | 68 коммитов, +502: список ignores того же устройства, много новых правил | Нет | **Взять upstream + 5 строк форка** в `ignores`. Затем `npm run lint` — upstream ввёл `--max-warnings 0` и новые локальные правила | Низкий для файла; новые правила на коде форка — задача 3.9 |
| `gsd-core/workflows/autonomous.md` | 5 коммитов: `a7fcc3a0e` (spec-phase в маршруте, блокирующие гейты), `b63d3a20e` (`state signal-waiting` перед вопросом о блокере, `signal-resume`, пропущенная фаза → `## Deferred Items`), `97b06ac26` (вынос веток human_needed/gaps_found/blocking-gates/spec-phase в `autonomous/steps/*.md` ради размера), `a5021672c` (`--max-phases` / `workflow.autonomous_max_phases`), `f40808b56` (без повторного `cat STATE.md`) | 15 коммитов: `VERIFY_STATUS … \|\| VERIFY_ERROR=1`; любой статус кроме `passed/human_needed/gaps_found` → `handle_blocker` с `--pick next_action` (#5118, вместо отдельной ветки `stale`); `--ws`, letter-suffix фаз, DAG-ready планы, converge. Ничего из функций форка нет | Пересекаются в одном месте: маршрутизация статуса верификации. У upstream ветки `human_needed`/`gaps_found` остались inline, у форка вынесены в steps | **Взять upstream + перенести правки форка**: spec-phase, max-phases, signal-waiting/resume, Deferred Items, без повторного cat. Ветки `human_needed`/`gaps_found`: выносить в steps-файлы форка **из текста upstream** (а не из старого текста форка), чтобы не потерять `VERIFY_ERROR` и `next_action`; ветку `stale` форка не возвращать. Steps-файлы форка добавлены без конфликта, но их содержимое нужно пересверить с upstream. Размер: LARGE 60 KiB, upstream 41207 — запас есть | Средний: легко вернуть старую логику `stale`/пустого статуса из steps-файлов форка |
| `gsd-core/workflows/undo.md` | `4e748beff`: пометка «`.phase-manifest.json` никто не пишет»; в fallback по scope — вывод коммитов окна фазы без scope перед подтверждением | 9 коммитов, +347: манифест **убран совсем**; окно выбора привязано к каталогу фазы (#4465, #3995), выбор — `gsd_run query select-revert-commits --phase … --range "${UNDO_RANGE}"` (#4906), без `--all` | Половина правки форка (про манифест) устарела. Вторая половина (коммиты окна без scope не попадают в revert и не показываются) у upstream **не закрыта**: выбор всё ещё по объявленному scope | **Взять upstream + перенести только предупреждение про коммиты без scope**, переписав на upstream-окно: `git log --oneline --no-merges ${UNDO_RANGE}` минус `COMMITS` → блок «⚠ Unscoped commits in this phase's window — NOT included» + явное подтверждение; пункт чек-листа. Текст про манифест не переносить; запись «Known dead ends» о манифесте в worklog закрыть | Низкий |
| `gsd-core/workflows/diagnose-issues.md` | `c1f438ab6`: тело debug-промпта вписано в workflow, потому что шаблон `debug-subagent-prompt.md` форк удалил | 11 коммитов: `<files_to_read>` → `<required_reading>` (#3432) и др. **Upstream тоже удалил шаблон** (`a27cb6b2f`), но строка 146 по-прежнему «fill the debug-subagent-prompt template» — висячая ссылка | Upstream получил ту же поломку и не заметил (его аудит искал путь к файлу, а тут имя без пути) | **Взять upstream + вписать промпт форка**; переменную назвать `filled_debug_prompt`, тег — `<required_reading>` (как у upstream). Кандидат в issue upstream (вопрос 6) | Низкий |
| `gsd-core/workflows/verify-work.md` | `ae05475cd`: абзац «Command steps first» — выполнить `ref.command` шагов `verify:pre` до гейтов, `onError` skip/halt | 24 коммита; общий диспетчер #3866 — `references/loop-hook-dispatch.md`. Порядок в `verify_pre_hooks`: contribution → **step** (стр. 82) → gate (стр. 88) — **шаги до гейтов, да**. `onError`: шаг рекомендательный, «never blocks the start of UAT, … routed by its own `onError` without failing verification» — т.е. `halt` у шага верификацию не останавливает (у форка `halt` останавливал). Валидация `ref.command` регуляркой до shell; вызов `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw` | Upstream сделал то же лучше (валидация, все виды шагов) | **Взять upstream, правку форка не переносить** (решение 2.7). Но **обязательно** поправить `capability.json` (`"command": "verify gates"`) и маршрутизатор (`--phase`) — см. «Самое рискованное» №1. Шаг форка объявлен `onError: skip`, так что потери семантики `halt` нет. Тест `capability-command-step-dispatch.test.cjs` (2.10) пройдёт как есть (в upstream-тексте есть `` `ref.command` ``), но поломку не поймает — добавить в него проверку: каждый `ref.command` капабилити форка проходит регулярку upstream | **Высокий** без правки капабилити (см. выше) |
| `gsd-core/bin/gsd-tools.cjs` | `1283f657b`: маршрут `feature-view` (+ usage, список команд); серия `--cwd` (`6dbc80b65`, `366b54c0d`, `2611a5449`): флаг `explicitCwd`, в `main()` `findProjectRoot(cwd, {declaredOnly: explicitCwd})`, комментарий в `resolveMainWorktreeCwd` «здесь сознательно нет ветки explicitCwd» | 51 коммит, +1947/−307: `--project-dir` (#3881/#4894, корень без подъёма, требует `.planning/`), `preWorktreeRemapCwd`/`invokingCwd` (#4465), `HOST_COMMAND_ROUTERS` на месте (`:4638`), `SKIP_ROOT_RESOLUTION` (`:5063`). `feature-view` нет | `--project-dir` не покрывает бутстрап (см. `project-root.cts`) | **Взять upstream + перенести**: маршрут `feature-view` (+ строки usage/списка команд); `explicitCwd` в разборе `--cwd` (`:5231`) и `findProjectRoot(cwd, { declaredOnly: explicitCwd })` в ветке `if (!projectDirExplicit && !SKIP_ROOT_RESOLUTION.has(command))` (`:5412`); комментарий у `resolveMainWorktreeCwd` — по желанию | Средний: не проверено, требует ли upstream регистрации новой команды в `docs/CLI-TOOLS.md` / реестре команд (тесты паритета) |
| `gsd-core/references/tdd.md` | `7434db454`: в `<test_quality>` два антипаттерна — тавтология («сломай реализацию нарочно») и horizontal slicing | 9 коммитов, +50/−15: обязательное «intentional RED» с проверкой `check tdd-red-evidence` (#3770), RED-pathspec. «tautolog»/«horizontal» не встречаются; `<test_quality>` не изменён | Частично: проверка RED-evidence ловит тест, который зелёный сразу (`unexpected_green`), — т.е. часть тавтологий. Не ловит «ожидаемое пересчитано той же логикой» и «все тесты сначала» | **Не конфликтует** (сливается автоматически, в списке `merge-tree` его нет). Взять слитое, блок форка оставить; по желанию одна строка-ссылка на RED-evidence в пункте про тавтологию. Ack `tdd-antipatterns` → трейлер (2.9) | Низкий |
| Серия `--cwd` (`6dbc80b65` wip, `aa8e6646d` test, `366b54c0d`, `2611a5449`, `ba2278769` merge; `28c771989` попал в выборку `--grep` случайно — он про assertion-ratchet) | Файлы: `gsd-tools.cjs`, `src/project-root.cts`, `src/worktree-safety.cts` (сравнение `--git-dir`/`--git-common-dir` через `realpathSync`: на macOS `/tmp`→`/private/tmp` превращал обычный подкаталог в «linked worktree»), `tests/commands.test.cjs` (2 теста), `tests/project-root.test.cjs`, `tests/fix-3045-…` (1 тест) | Из серии в upstream **нет ничего**: `--project-dir` — другой механизм (требует `.planning/`), `worktree-safety.cts:229` по-прежнему `path.resolve` без `realpath` | — | **Перенести целиком**: `project-root.cts`, `gsd-tools.cjs` — как в строках выше; `worktree-safety.cts` и `commands.test.cjs` сливаются без конфликта (проверить, что слились); тест из `fix-3045` — см. 2.8 | Средний: realpath-фикс и бутстрап-фикс живут только у форка; при потере — тихий ре-рут на корень монорепо |

---

## 2.8 — modify/delete (upstream удалил, форк менял)

| Файл | Форк | Почему удалил upstream / куда переехало | Рекомендация | Риск |
|---|---|---|---|---|
| `templates/codebase/concerns.md`, `conventions.md`, `integrations.md`, `structure.md`, `testing.md` (5) | `349f3b86b`: только блок `gsd-template:` (registry-метаданные, 11 строк) | `a27cb6b2f` (#4139 Phase 6, PR #4540): аудит достижимости — ноль ссылок из workflow/агентов/команд/кода/тестов, «мёртвые заготовки». Содержимое никуда не переехало: картограф пишет документы по своим инструкциям. В форке на эти файлы тоже ссылается только `templates/README.md` (колонка «readers» — заявление реестра, не реальное чтение; проверено `git grep` по `next`) | **Принять удаление.** Убрать строки из реестра шаблонов форка (`templates/README.md`, `docs/TEMPLATE-REGISTRY.json` — пересоздать генератором), если реестр остаётся (вопрос 1) | Низкий |
| `templates/discovery.md` | `349f3b86b`: блок `gsd-template:` | Тот же `a27cb6b2f`; связанный workflow `discovery-phase.md` удалён раньше (`c5b83cb05`, #3564) как недостижимый. Ссылок в форке нет (совпадения `discovery.md` — это `project-skills-discovery.md`) | **Принять удаление**; убрать из реестра | Низкий |
| `templates/host/claude-md.md` | `cb0667247` перенёс `templates/claude-md.md` → `templates/host/`; `349f3b86b` — блок `gsd-template:` | `a27cb6b2f` удалил `templates/claude-md.md` как мёртвый. `src/profile-output.cts` upstream собирает CLAUDE.md сам (`generate-claude-md`); форк в `cb0667247` перенаправил чтения только `dev-preferences`/`user-profile`. В форке на файл ссылаются лишь `templates/README.md` и ack-фрагмент `2658-…` | **Принять удаление.** `host/dev-preferences.md`, `host/user-profile.md` (upstream их не удалял — живые) — проверить, что перенос форка в `host/` и пути в `profile-output.cts` слились без конфликта (в списке `merge-tree` их нет) | Низкий |
| `workflows/plan-milestone-gaps.md` | `4e748beff`: блок `<status>` «UNREACHABLE, не удалён, потому что `tests/phase.test.cjs` требует файл; здесь единственный сброс `[x]`→`[ ]` для неудовлетворённых требований — перенести в `audit-milestone.md`, прежде чем считать лишним» | `c5b83cb05` (#3564): команда удалена ещё в #2790, workflow недостижим; добавлено правило 6 `lint-command-contract` — каждый workflow должен быть достижим (блокирующее). `audit-milestone.md` upstream сброс **не делает**: таблица 5d только «`passed` + `[ ]` → satisfied (update checkbox)» | **Принять удаление** (иначе красный lint правила 6) **и перенести смысл**: шаг «для каждого требования со статусом `unsatisfied` сменить `[x]`→`[ ]`, обновить счётчик покрытия» в `audit-milestone.md` (рядом с 5d/5e) + пункт чек-листа. Запись «Known dead ends» в worklog обновить | Средний: без переноса устаревшие `[x]` остаются молча |
| `tests/emitted-drift-acks/2650-plan-phase-stall-detection.json` | `cc932dc83`: к причине для `plan-phase.md` дописано обоснование форка (два источника ack не могут называть один путь) | `8b4545f3c` (#3218) — фрагмент израсходован; затем ADR 3942: подтверждения дрейфа — git-трейлеры, каталог фрагментов в upstream пуст | **Принять удаление.** Причину форка для `plan-phase.md` — в трейлер `Emitted-Drift-Ack-*` на коммите переноса (2.9) | Низкий |
| `tests/emitted-drift-acks/2775-planner-package-legitimacy-gate.json` | `cc932dc83`: то же для `gsd-planner.md` | `a84f75630` (#3823, sweep израсходованных фрагментов) | **Принять удаление**; `gsd-planner.md` — в трейлеры 2.9 | Низкий |
| `tests/emitted-drift-acks/2930-fragmentize-execute-phase-markers.json` | `cc932dc83`: то же для `execute-phase.md` | `b77b7f8e5` (#3419) | **Принять удаление**; `execute-phase.md` — в трейлеры 2.9 | Низкий |
| `tests/emitted-drift-acks/2962-zsh-nomatch-for-glob-portability.json` | `cc932dc83`: то же для `audit-milestone.md` (`human_needed`/`stale`/прочее в матрице) | `a84f75630` (#3823) | **Принять удаление**; `audit-milestone.md` — в трейлеры 2.9 | Низкий. **Важно для 2.9:** «9 форковых подтверждений» — это 9 файлов `mn-fork-*`/`tdd-antipatterns` **плюс** эти 4 пути, чьи причины форк вписал в чужие фрагменты |
| `tests/fix-2297-resolve-model-ids-runtime-scoping.test.cjs` | `a0229fafe`: id моделей `claude-opus-4-8` → `claude-opus-5-5` (2 строки) | `a875372f1` (#3335/#3373): «fold» — проверки влиты в общие тесты (`model-resolver.test.cjs` и др.) | **Переосмыслить**: файл не возвращать (решение 2.4); правку форка перенести туда, куда влиты проверки — в upstream-тестах с id 4.8/sonnet-5: `model-resolver.test.cjs`, `model-alias-map.test.cjs`, `model-catalog.unit.test.cjs`, `codex-config.test.cjs` (тоже в конфликте), `install-runtime-artifacts.test.cjs` (5 файлов по `git grep claude-opus-4-8`, всего 9 с `sonnet-5`) | Средний: объём правок в чужих тестах; без них — красные тесты моделей |
| `tests/issue-2517-runtime-aware-profiles.test.cjs` | `a0229fafe`: те же замены id (18 строк) | `1bc7f7e6b` (#3339 Wave 7, fold) | **Переосмыслить** — как `fix-2297`, те же целевые файлы | Средний |
| `tests/fix-3045-dispatch-isolation-resolver.test.cjs` | `aa8e6646d`: тест «бутстрап-цель, названная `--cwd`, не перекореняется на монорепо» (`query dispatch-isolation --cwd <target>`) | `33fca50d8` (#3333/#3341, fold) → `tests/gsd-agent-isolation-guard.test.cjs`, раздел «Folded from tests/fix-3045-dispatch-isolation-resolver.test.cjs» (`:916`) | **Переосмыслить**: тест форка добавить в этот раздел. Переписать под правила upstream: без `try/finally` (у форка `try { … } finally { cleanup }`) → `t.after(() => cleanup(dir))`; git — через `git-fixture`/process-seam, не самописный `git()` | Средний: этот тест — единственная сквозная проверка бутстрап-фикса `--cwd` |

---

## Прочие конфликты, не входившие в задание (для полноты)

`merge-tree` показывает ещё: `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `gsd-core/templates/README.md`
(реестр шаблонов форка — зависит от вопроса 1), `tests/artifacts.test.cjs`, `tests/autonomous-converge.test.cjs`,
`tests/codex-config.test.cjs` (id моделей), `tests/markdown-table.test.cjs`, `tests/project-root.test.cjs`,
`tests/qwen-upgrades.test.cjs`, и производные (`capability-registry.cjs`, `INVENTORY*`, `capability-matrix.md`,
19 × `tests/fixtures/install-tree/*.json` — пересоздать, 2.7). Не разбирались.

Без конфликта, но с риском потолка: `agents/gsd-ui-auditor.md` (`.pen`-правка форка `273a91853`,
≈27542 > DEFAULT 24576) — сливается молча, падает в `agent-size-budget`.

## Вопросы владельцу

1. **Реестр шаблонов (серия 04.1: блоки `gsd-template:` на 43 шаблонах, `gen-template-registry.cjs`,
   `docs/TEMPLATE-REGISTRY.json`, индекс в `templates/README.md`)** — переносить на upstream или
   отказаться? У upstream другой набор шаблонов (11 удалены, есть новые и `*.compact.md`-варианты с
   проверкой паритета `compact-content-variant`). Перенос = проштамповать новые шаблоны и
   убедиться, что блок не ломает проверку паритета compact-вариантов (не проверено). От ответа
   зависят `package.json` и конфликт `templates/README.md`.
2. **`feature:` и `gen-feature-vocabulary`** (словарь собирается из `.planning/ROADMAP.md` репозитория
   gsd-core) — оставлять? Затрагивает `frontmatter.cts`, `package.json`, `gsd-tools.cjs` (`feature-view`).
3. **`.pen` в `gsd-ui-checker`**: отдельная «Dimension 8» (рекомендую) или слить с upstream
   «Dimension 7: Inventory Provenance» — контракт `.pen` там естественен как источник перечисления?
4. **`--cwd` против `--project-dir`**: оставляю семантику форка (`declaredOnly` для `--cwd`), потому что
   `--project-dir` требует существующего `.planning/` и бутстрап не покрывает. Согласны? Альтернатива —
   учить `new-project` создавать `.planning/` до вызова с `--project-dir`.
5. **Сброс `[x]`→`[ ]`** из `plan-milestone-gaps.md`: переносить в `audit-milestone.md` в рамках
   синхронизации или в бэклог?
6. **Сообщить upstream** (внешнее действие, как D4): висячая ссылка на удалённый
   `debug-subagent-prompt` в `diagnose-issues.md:146`.
7. **Куда ужать `gsd-verifier`** (≈950 байт сверх LARGE): в reference-файл ядра (контракт SPEC и
   `truths_unproven` работают всегда) или во фрагмент-contribution `mn-verify-gate` (работают только при
   включённой капабилити)? Рекомендую reference: `truths_unproven` читает `ship:pre`-гейт, а
   `spec_truths` — общий контракт фазы.

## Что не проверено

- Ни одного реального слияния, сборки или теста: всё по `git diff`/`git show`/`merge-tree`.
- Размеры агентов — арифметика «upstream + (fork − base)», не замер слитого файла.
- Поведение `allowedValues` после перехода upstream на js-yaml (типы значений).
- Зелёность тестов форка `markdown-table` и `project-root` на коде upstream.
- Требует ли upstream регистрации новых команд (`feature-view`, `verify gates`) в `docs/CLI-TOOLS.md`
  или реестрах паритета.
- Где регистрируются коды `stateDiagnostic` (S001–S009) и есть ли тест на их полный список.
- Попадает ли блок `gates:` в отпечаток верификации: по тексту `gsd-verifier` upstream отчёт сам себя
  в покрытый набор не включает (#4155/#5095) — вероятно безопасно, но не проверено кодом.
- Поддержка событий `PostCompact`/`WorktreeCreate` в плагинном `hooks.json` Claude Code.
- Слились ли без конфликта `src/worktree-safety.cts`, `tests/commands.test.cjs`,
  `hooks/managed-hooks-registry.cjs`, `templates/host/{dev-preferences,user-profile}.md` — по
  `merge-tree` конфликта нет, содержимое результата не смотрел.

## Решения по вопросам (2026-10-03, по рекомендациям)

1. Реестр шаблонов (04.1) — **переносить**; проштамповать новые шаблоны upstream; проверить, что блок
   `gsd-template:` не ломает проверку паритета `compact-content-variant`.
2. `feature:` и `gen-feature-vocabulary` — **оставить** (серия feature-view — ядро форка).
3. `.pen` в `gsd-ui-checker` — **отдельная Dimension 8**; upstream-овскую Dimension 7 (Inventory
   Provenance) не трогать; счёт измерений во всех местах — 8.
4. `--cwd` — **семантика форка** (`declaredOnly`), т.к. `--project-dir` не покрывает бутстрап.
5. Сброс `[x]`→`[ ]` из `plan-milestone-gaps` — **перенести в `audit-milestone.md` сейчас**.
6. Висячая ссылка в `diagnose-issues.md` — **сообщить upstream** (issue заводится).
7. `gsd-verifier` — лишнее **в лениво читаемый reference ядра** (не в contribution).

Дополнительно (из рисков):
- Шаг `verify:pre` mn-verify-gate под общий диспетчер upstream: `ref.command` в формате
  `^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$` (`verify gates`), `verify gates` должен принимать `--phase N`
  (разрешать каталог фазы сам). Проверка: шаг реально пишет `gates:` при вызове диспетчером.
- `gsd-ui-auditor` после слияния превышает LARGE/DEFAULT — вынести секцию Design Sync Audit в лениво
  читаемый reference.
- Правило бойскаута: найденные по ходу дефекты чинить в той же волне, где правка выживет.
