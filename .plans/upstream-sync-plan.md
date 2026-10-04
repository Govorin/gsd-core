# План: синхронизация с upstream 1.15 + исправление найденного

Составлен 2026-10-03. Основание: `.plans/upstream-1.15-what-to-take.md` (вердикты по
возможностям upstream) и проверки этой сессии. Каждая задача имеет критерий приёмки, который
проверяется командой, а не словами.

Обозначения: **S/M/L** — усилие; ⚠ — риск; 🔒 — нужно решение владельца до старта.

## Решения владельца (до начала)

| # | Решение | Рекомендация | Блокирует |
|---|---|---|---|
| D1 🔒 | Стратегия: (в) новая ветка от `upstream/next` + перенос ядра по зонам, или (б) merge | (в) — ядро форка в новых каталогах, каждая зона проверяется отдельно | Фаза 2 |
| D2 🔒 | `capabilities/gemini`: upstream удалил в 1.15.0, у форка он есть | Удалить вслед за upstream | 2.4 |
| D3 🔒 | Переименование `next` и push в `origin` после синхронизации | Только после зелёной фазы 3; старую ветку оставить как `next-pre-sync` | 2.9 |
| D4 🔒 | Сообщить upstream об их ошибке `status: pending` (см. 1.1) | Да, это внешнее действие — с вашего согласия | 4.8 |

---

## Фаза 0. Страховка — S, полчаса

| ID | Задача | Приёмка |
|---|---|---|
| 0.1 | Закоммитить незакоммиченное (`BACKLOG.md`, `plan-pre-typemodel.md`, `capability-registry.cjs`) на ветку `wip/pre-sync` | `git status --short` пуст, кроме untracked `.plans/*` |
| 0.2 | Тег `fork-pre-sync-2026-10-03` на текущий HEAD | `git tag -l fork-pre-sync-*` |
| 0.3 | Снимок `~/.claude` (GSD-часть) и `~/.gsd` | tar-архивы рядом с репозиторием; одна копия уже есть: `scratchpad/preinstall/claude-gsd-before.tar` (901 файл) |
| 0.4 | Базовый прогон чистого upstream в отдельном worktree: `npm ci && npm test` | Записано число падений upstream — эталон для фазы 3 (сейчас известно только: чанки 1–4 из 24 — 444/0) |

---

## Фаза 1. Исправления на текущем `next` — делаются до синхронизации и переносятся с ядром

Эти задачи не зависят от upstream и уменьшают объём слияния.

### 1.1 ⚠ `verify-gates` пишет `status: pending` — M
**Проблема (проверено по коду).** `src/verify-gates.cts:334` создаёт `VERIFICATION.md` со
`status: pending`. Закрытый `VerificationStatus` upstream (`src/verification.cts`,
`reportStatusOf`) принимает только `passed | gaps_found | human_needed` и на `pending` бросает
`VerificationStatusError`. После синхронизации чтение отчёта сломается — тихо, в маршрутизации.
Отсутствующий `status` upstream маршрутизирует как `missing` («шаг верификации не выполнялся»)
— это ровно наш смысл.

**Сделать.** Заготовку писать без ключа `status`. Блок `gates:` оставить.
**Приёмка.**
- тест: `verify gates` на пустой фазе → во frontmatter нет `status`, есть `gates.all_passed`;
- тест: повторный запуск не добавляет `status`;
- после синхронизации (3.5): `gsd_run` чтение статуса фазы с такой заготовкой даёт `missing`,
  не ошибку.

**Попутно:** `src/commands.cts:1803` (scaffold verification) пишет тот же `pending`. В upstream
это тоже есть (`commands.cts:3741`) и падает на их же ридере — это их ошибка (см. D4, 4.8).
У себя исправить так же.

### 1.2 Таймаут блокирующих хуков форка — S
**Проблема.** В `hooks/hooks.json` и `~/.claude/settings.json` три блокирующих PreToolUse-хука
форка стоят на 5 с: `gsd-prohibition-guard`, `gsd-test-tamper-guard`, плюс `gsd-pin-invariants`
(SessionStart/PostCompact). Хук, не уложившийся в таймаут, не блокирует. Upstream поднял
блокирующие до 120 с (#5180); на хуки форка это само не распространится.
**Сделать.** `timeout: 120` для трёх хуков в `hooks/hooks.json`; то же в текущем
`settings.json` до переустановки.
**Приёмка.** Скрипт по `settings.json` показывает 120 у трёх хуков; `gsd-exit-gate` (620)
не трогать.

### 1.3 Дубль ID `mn-verify-gate` — S/M
**Проблема (проверено).** Каждая команда `gsd` печатает «capability mn-verify-gate failed to
load (id collides …)», 10 предупреждений, и до и после переустановки. Встроенная копия в реестре
работает; копия в `~/.gsd/capabilities/mn-verify-gate` не грузится, но из неё берутся скрипты
(18 команд захардкожены на `$HOME/.gsd/capabilities/mn-verify-gate/scripts`).
`${GSD_CAP_DIR}` ни в форке, ни в upstream **не поддерживается** — на него не опираться.
**Сделать.** По `src/capability-loader.cts` выяснить, что делает каталог капабилити
(наличие `capability.json`). Либо убрать `capability.json` из пользовательской копии (скрипты
остаются), либо ставить скрипты установщиком и сменить путь в командах.
**Приёмка.** `node ~/.claude/gsd-core/bin/gsd-tools.cjs loop render-hooks verify:pre --raw 2>&1 | grep -c "failed to load"` → 0; гейты mn-verify-gate по-прежнему в `activeHooks`.

### 1.4 `.pen`-доработки живут только в установленной копии — M
**Проблема.** Ваши доработки `gsd-ui-auditor`, `gsd-ui-checker`, `gsd-ui-researcher` и
`templates/UI-SPEC.md` правлены в `~/.claude`, а форк — это источник. При каждой переустановке
они слетают в `gsd-local-patches/` (сегодня это случилось и было откатано вручную).
**Сделать.** Перенести их в репозиторий трёхсторонним слиянием (они не чисто добавочные:
+66/−4, +64/−10, +31/−11, +31/−0). Тогда они станут частью ядра форка и пройдут синхронизацию.
`agents/gsd-ui-checker.md` — одна из точек конфликта с upstream, учесть в 2.6.
**Приёмка.** После переустановки установщик не сообщает «locally modified» по этим 4 файлам;
`diff` установленных и репозиторных версий пуст.

### 1.5 Записать находки в worklog — S
Дополнить `.plans/mn-fork-worklog.md`: дубль ID (1.3), правило «мерить по `upstream/next`»
уже есть; поведение установщика с `gsd-local-patches`; ошибка `pending` (1.1).

---

## Фаза 2. Синхронизация (стратегия «в») — L, 1–2 дня

| ID | Задача | Приёмка |
|---|---|---|
| 2.1 | `git switch -c sync/upstream-2026-10 upstream/next` | ветка от `8cca2e172` (или свежего tip после `git fetch upstream`) |
| 2.2 | Новые каталоги без конфликтов: `capabilities/mn-verify-gate`, `mn-expertise`, `architecture`; хуки `gsd-exit-gate`, `pin-invariants`, `prohibition-guard`, `test-tamper-guard`, `worktree-provision`; новые `src/*.cts` (`verify-gates`, `plan-status`, `feature-view`, `files-modified-normalize`) и их тесты. Один коммит на зону | `git log --oneline` — по коммиту на зону; тесты зоны зелёные |
| 2.3 | Три агента форка + их записи в `model-catalog.json` | `gsd-architect-reviewer`, `gsd-system-architect`, `gsd-finding-refuter` в `agents/` и каталоге |
| 2.4 | Модели: версии 5.5/5.1, лестница пресетов, `gsd-verifier`=heavy, `intel-updater`; тесты `model-policy-budget-ladder`, `model-catalog-judge-tier`. Удалённые upstream тесты (`fix-2297`, `fix-3045`, `issue-2517`) не возвращать — перенести их проверки в существующие тесты upstream, если они не покрыты | тесты моделей зелёные на переписанном резолвере upstream |
| 2.5 | `capabilities/gemini` — по D2 | |
| 2.6 | Правки существующего кода через `cherry-pick -n` и ручной разбор: `src/{frontmatter,markdown-table,state,verify,project-root,command-aliases,verify-command-router}.cts`, `agents/gsd-verifier.md`, `agents/gsd-ui-checker.md`, `hooks/hooks.json`, `package.json`, `eslint.config.mjs`, `workflows/{autonomous,undo,diagnose-issues}.md`, `gsd-tools.cjs`, `tdd.md`, серия `--cwd` | каждый файл — осознанное решение; нет маркеров конфликта (`git grep -n '^<<<<<<<'` пуст) |
| 2.7 | **Не переносить** (upstream сделал лучше или это производное): вставку `ae05475cd` в `verify-work.md` (общий диспетчер #3866); 20 унаследованных ack-фрагментов; `capability-registry.cjs`, `docs/INVENTORY*`, `capability-matrix.md`, `tests/fixtures/install-tree/*.json` (19 шт.) — пересоздать | `npm run regen:derived` → `npm run lint:generated-sync` чисто |
| 2.8 | 16 modify/delete — решить по каждому: `templates/codebase/{concerns,conventions,integrations,structure,testing}.md`, `templates/discovery.md`, `templates/host/claude-md.md`, `workflows/plan-milestone-gaps.md`, 4 ack-фрагмента, 3 теста. По умолчанию — принять удаление upstream, смысл правки форка перенести туда, где upstream теперь держит это содержимое | список решений записан в worklog |
| 2.9 | 9 форковых подтверждений дрейфа → git-трейлеры `Emitted-Drift-Ack-Hash:` / `Emitted-Drift-Ack-Growth:` (ADR 3942) на коммитах, меняющих эмитируемые байты | `emitted-attribution.test.cjs` зелёный относительно `upstream/next` |
| 2.10 | Тест-ограждение `capability-command-step-dispatch.test.cjs` подправить под общий диспетчер upstream (`ref.command` + валидация) | тест зелёный; контрольный прогон с удалённым диспетчером его роняет |

---

## Фаза 3. Адаптация после слияния — M/L

| ID | Задача | Приёмка |
|---|---|---|
| 3.1 | Хуки форка → реестр кодов выхода (ADR 3889): 24 сырых `process.exit` (`exit-gate` 5, `pin-invariants` 4, `prohibition-guard` 6, `test-tamper` 4, `provision` 5) → `terminateNow` + регистрация кодов | `npm run lint:ci` без `require-registered-exit` |
| 3.2 | Хуки форка → `managed-hooks-registry.cjs`, чтобы установщик проверял их entrypoint | `install` перечисляет их в проверке entrypoint |
| 3.3 | `<fails_when>`: прогнать гейт `verify-failure-directions` по шаблонам и фрагментам форка (`templates/VALIDATION.md`, фрагменты `mn-verify-gate`) | гейт зелёный на собственных файлах форка |
| 3.4 | Миграция живых проектов (norn, ucars, mn): посчитать планы без `<fails_when>` и `checkpoint:decision` без `auto_select` — они начнут блокироваться / останавливать autonomous | отчёт по каждому проекту: N планов затронуто, решение (дописать или дождаться новых фаз) |
| 3.5 | Скрипты `mn-verify-gate` против `state.json`, `PlanningDoc` (отказывает на нестандартных регионах ROADMAP) и закрытого `VerificationStatus`: прогнать `wave-*`, `plan-status`, `check-frontmatter`, `orphan-plans`, `clean-state`, `verify gates` на реальной фазе | все выходят 0/1 по смыслу, ни одного 2 «не смог прочитать»; `clean-state` не считает `state.json` грязью |
| 3.6 | `tdd.md`: прочитать слитый файл; если upstream не покрыл «tautological» и «horizontal slicing» (сейчас не покрыл) — оставить наш блок | нет дублирующих формулировок |
| 3.7 | Правило `validatePath` → `assertWithinRoot` / `tryWithinRoot` в `CLAUDE.md`, `CONTRIBUTING.md`, `.clinerules` | `git grep -n validatePath -- CLAUDE.md CONTRIBUTING.md .clinerules` пуст или ссылается на новое API |
| 3.8 | Падающие до синхронизации: `research-agent-profiles` (7 — расхождение `tools:` с MCP-инструментами форка) и `gsd-executor` > LARGE cap (52561 > 49152; у upstream 46769). Профили — обновить ожидание под инструменты форка; executor — вынести форковую добавку в лениво читаемый reference (ADR-1610 запрещает eager `@`-include ради размера) | оба теста зелёные |
| 3.9 | Полная проверка: `npm run lint:ci`, `npm test` | падений не больше эталона 0.4 |
| 3.10 | Установка: снимок → `node bin/install.js --claude --global` → живая проверка | `render-hooks verify:pre`: 0 предупреждений; нет «locally modified»; на тестовом проекте `verify gates` пишет `gates:` без `status`; блокирующие хуки 120 с |
| 3.11 | Переименование `next` и push — по D3 | `next-pre-sync` существует; `origin/next` обновлён только после 3.10 |

---

## Фаза 4. Улучшения после синхронизации — по убыванию ценности

| ID | Задача | Обоснование | Усилие |
|---|---|---|---|
| 4.1 ✓ `73c11f22b` | **Baseline-гейт на входе execute.** Переиспользовать `verify gates`: красная база до начала работы блокирует старт. Сначала проверить, вычисляет ли upstream гейты на `execute:pre` (в форке — нет, точка объявлена без вызова) | Закрывает «сломанная база маскирует новые баги»; у upstream только предупреждения | M |
| 4.2 ✓ `ad94ca92a` | **Pre-mortem как артефакт.** Блок `<failure_paths>` в PLAN.md: у каждого пути `invariant` и `check` в грамматике `<fails_when>`; гейт на `plan:post` (там есть общий диспетчер predicate-гейтов) | Опирается на `<fails_when>` upstream вместо отдельного механизма; эффект измерим — доля путей без `check` | M |
| 4.3 ✓ `13a81aec2` | **Проверка устаревших `verify_gates`**: команда не найдена / упала по причине окружения → предупреждение | Идея poteto «поддержка проверок как инфраструктура» | S |
| 4.4 ✓ `2f9e3d3a1` | **Пилот `writing-for-agents`** на одном агенте (контекстные указатели, критерий завершения, удаление no-op). Учесть CI-guard `compact_content` и трейлер `Boundary-Move-Declared` | Shipped markdown — это продукт | M |
| 4.5 ✓ `bc7012aed, 8ff4adabb` | **Режим grill** для `discuss-phase` (`discuss-phase/modes/grill.md`): раунды по frontier дерева решений, рекомендованный ответ, факты ищет субагент | В upstream нет | M |
| 4.6 ✓ `f315b9dab` | **Пересказ задачи агентом** перед планированием («in your own words») | poteto; ловит ложные следы до кода | S |
| 4.7 ✓ `b60d0dae7` | `plan-graph` — вывести в `/gsd-progress` по запросу | Картинка для человека; детекция уже есть у upstream | S |
| 4.8 | ~~Issue в upstream~~ — заведено #5202 до решения владельца не заводить issue; новых не заводить | — | — |
| 4.9 | A/B-замер «отчёт помогает находить дефекты» (изоляция запусков по директориям) — до любой работы над HTML-отчётами | arXiv: красивое оформление поднимает доверие, не точность | M |

**Статус (2026-10-04):** 4.1–4.7 сделаны и влиты в `next` (`775ba19bd`..`9f74cfbb6`, фикс интеграции `8f4957136`);
подробности и ключи — `mn-fork-worklog.md`, раздел «Phase 4 of the sync plan». Открыты 4.9 и отложенное ниже.

Отложено сознательно: HTML-отчёты (сначала 4.9), `compact_content` (агентов форка не касается),
bracket-ID фаз (ломают `wave-survey.mjs`), `live-dom-uat` (нет UI-UAT).

---

## Критический путь

```
0.1–0.4 → 1.1 ─┐
          1.2  ├→ 2.1 → 2.2–2.10 → 3.1–3.9 → 3.10 → 3.11 → 4.x
          1.3  │
          1.4 ─┘
```

Фаза 1 параллелится; 1.1 и 1.4 обязательны до 2.6 (иначе переносить дважды).

## Откаты

| Точка | Откат |
|---|---|
| После фазы 1 | `git reset --hard fork-pre-sync-2026-10-03` (тег 0.2) |
| Фаза 2–3 | Удалить ветку `sync/upstream-2026-10`; `next` не тронут до 3.11 |
| 3.10 установка | Распаковать снимок 0.3 поверх `~/.claude` и `~/.gsd` |
| 3.11 | `next-pre-sync` остаётся; `origin` не форсится до зелёной 3.10 |

## Что остаётся неизвестным и проверяется по ходу

- Зелёность чистого upstream целиком (0.4).
- Точное число смысловых конфликтов: `merge-tree` дал 66, из них ~20–25 ручных — оценка.
- Попадает ли блок `gates:` в покрытый набор отпечатка верификации (`canonicalizeCoveredFiles`).
- Как миграции установщика upstream лягут поверх установки 1.9.1 (отдельного файла миграций нет).
- Вычисляет ли upstream гейты на `execute:pre` (определяет форму 4.1).

## Эталон 0.4 (2026-10-03, upstream/next bd93e0aa9, Node v24.11.0)

`npm test` на чистом worktree upstream: **42 440 тестов, 42 395 pass, 13 fail, 31 skipped, 1 todo**
(28 чанков, упали 10). Лог: `/Users/govorin/forks/gsd-sync-backups/2026-10-03/upstream-baseline-test.log`.

13 падений — окружение, не код: в worktree `origin` указывает на GitHub-форк владельца, а не на
upstream, поэтому падают сравнения с `origin/next` (`differential attribution over the real tree`,
`removed-but-needed lint ... against origin/next`), и группа git-тестов (`commit command`,
`#1146 git.base-branch resolver`, `#3776`, `#3859` ×2, `#4767`, `decision-coverage-verify on a
non-git project directory`, `validate health command`, `runtime-launcher-parity`,
`compact-content partition guard`, `quick-batch ... byte-identical`). Критерий 3.9: на слитой ветке
падений не больше этих 13 и тех же имён.

Страж живой конфигурации сообщил 145 изменений в `~/.claude` (71 skills, 37 agents, 32 hooks,
манифест) — это след переустановки форка, выполненной во время прогона (те же числа, что в выводе
установщика), а не запись тестами в живую среду.

## Фаза 5. Mermaid везде, где реализуемо (добавлено 2026-10-04)

Принцип (из `upstream-1.15-what-to-take.md` и arXiv 2508.00255/2601.20476): схема строится
детерминированно **из данных**; модель её не рисует. Где модель всё же рисует (UML в проектах
пользователя), действует детерминированная сверка: синтаксис + каждый идентификатор на схеме существует
в коде. Делается на ветке синхронизации (целевая платформа), логика — как `gsd_run`-команды в
`src/*.cts` (путь upstream), а не скрипты внутри капабилити.

| ID | Схема | Источник данных | Где показывается | Приёмка |
|---|---|---|---|---|
| 5.1 | Общий модуль: построители flowchart/stateDiagram/gantt/classDiagram/erDiagram, экранирование меток, маркер `gsd:derived` | — | `src/mermaid-*.cts` | юнит-тесты на экранирование и форму; dev-проверка настоящим парсером mermaid |
| 5.2 | **Roadmap**: граф фаз (зависимости, статус, milestone) + gantt при наличии дат | `ROADMAP.md` через слой `PlanningDoc` upstream | `gsd_run roadmap graph`, `/gsd-progress` | фикстура с зависимостями/статусами; несуществующая зависимость — красное ребро |
| 5.3 | **План фазы** (перенос `plan-graph`) | `wave`, `depends_on`, SUMMARY/status | `gsd_run plan graph`, `/gsd-progress` | тесты `plan-graph` переносятся |
| 5.4 | **Жизненные циклы** (stateDiagram): статус плана, `VerificationStatus`, `PhaseStatus` | константы в `src/plan-status.cts`, `src/verification.cts`, `src/phase-status.cts` | генерируемый `docs/reference/state-machines.md` (проверка `lint:generated-sync`) | смена enum без регенерации роняет sync-check |
| 5.5 | **Логика workflows**: шаги `<step name>` и переходы, кого спавнит каждый шаг | структура shipped markdown | генерируемый `docs/reference/workflow-maps/*.md` | каждый узел — существующий шаг/агент |
| 5.6 | **Капабилити и точки цикла**: какие капабилити на каких loop points (step/gate/contribution) | `capability-registry.cjs` | генерируемый `docs/reference/loop-hooks-map.md` | регенерация = sync-check |
| 5.7 | **UML в проектах пользователя**: `gsd-doc-writer` и шаблон `DESIGN.md` — Mermaid по умолчанию (class/sequence/state/ER); ER — из Zod (`zod-fieldtable`) | код проекта | `docs/`, `DESIGN.md` | `gsd-doc-verifier` проверяет: синтаксис и что каждый идентификатор (класс, функция, таблица) есть в коде — иначе finding |
| 5.8 | Ревью агентом: сверка схем с источниками на реальном проекте (norn/ucars/mn) | — | — | отчёт ревьюера без расхождений |

## Ревью волн (действует для всех фаз)

После каждой волны — независимый агент-ревьюер по диффу волны против `upstream/next`: правки форка
перенесены по смыслу, решения `sync-conflict-decisions.md` исполнены, нет потерянных изменений и
новых падений относительно эталона. Находки ревью исправляются до слияния (правило бойскаута).

## Принцип решений (2026-10-04)

Решения принимаются автономно после анализа и исследования агентами; выбирается правильный вариант,
а не меньший или костыльный. Следствия для уже сделанного:
- **1.3 был временной мерой.** Правильно: логика `mn-verify-gate` (17 скриптов `.mjs`) — как
  `gsd_run`-команды в `src/*.cts`, как устроены первосторонние капабилити upstream; гейты вызывают
  `gsd_run …`, а не `node $HOME/...`. Ручное зеркалирование в `~/.gsd` исчезает. → задача 3.12.
- **`gsd-worktree-provision`** не «отключить», а переделать по контракту `WorktreeCreate` Claude Code
  (хук сам создаёт worktree и печатает путь) с тестами на создание/провал. → задача 3.13.
- Необратимые шаги (переименование `next`, push в `origin`) выполняются автономно после зелёной фазы 3,
  тега и снимков.

| ID | Задача | Приёмка |
|---|---|---|
| 3.12 | Перевод скриптов `mn-verify-gate` в `gsd_run`-команды (`src/*.cts`, роутер, тесты переносятся), гейты на `gsd_run`; каталог `scripts/` капабилити удаляется | ни одна команда гейта не ссылается на `$HOME`; `~/.gsd/mn-verify-gate` не нужен; все тесты `mn-*` зелёные |
| 3.13 | `gsd-worktree-provision` по контракту `WorktreeCreate`: исследовать контракт (вход JSON, создание worktree, вывод пути, коды), реализовать, зарегистрировать | тест: хук создаёт worktree и печатает путь; при провале снаряжения — понятная ошибка; `isolation: worktree` работает |

## Доработки после волны 3 (обязательные, 2026-10-04)

| ID | Что | Почему | Приёмка |
|---|---|---|---|
| 3.13a | Снаряжение worktree — только в GSD-проектах с `.planning/config.json`; в остальных хук только создаёт worktree от локального HEAD | хук заменяет создание worktree во всех git-проектах; «нет ключа = включено» не должно распространяться на проекты без `.planning/` | тест: проект без `.planning/` → worktree создан, снаряжение не запускалось |
| 3.13b | Поддержка `--worktree "#<N>"` (PR) — как у встроенного механизма | сейчас отклоняется валидацией имени — регрессия | исследовать поведение встроенного механизма; тест на `#123` |
| 3.13c | Предупреждения снаряжения при exit 0 — в служебный каталог worktree внутри `.git` и показ агенту при старте сессии через `pin-invariants` (SessionStart) | сейчас видны только в debug-логе Claude Code | тест: предупреждение снаряжения попадает в `hookSpecificOutput` первой сессии в worktree |
| 3.12c | Поднять версию капабилити mn-verify-gate и `engines.gsd` (новые команды = minor, ADR-894/1244); `mn` в справку `--help`, если семейство капабилити там показывается | не сделано в 3.12B | `capability validate`, тест справки |
| W.1 | Worklog: provision теперь зарегистрирован и работает по контракту; pin-invariants через SessionStart; список найденных дефектов форка за синхронизацию | записи устарели | **выполнено 2026-10-04**: `mn-fork-worklog.md` — контракт provision, pin через SessionStart, таблица дефектов, решения (H3, 3.4c, 3.12c, W031, `.plans/`), «What not to repeat» |
| 5.5a | Дефекты текста workflows, найденные генератором карт: `execute-phase.md` — шаг `initialize` не закрыт (`safe_resume_gate` внутри); `plan-phase.md` ~1021/1079 и `quick/steps/plan-checker-loop.md` ~25/68 — внешний fence ` ```markdown ` закрывается вложенным ` ```json `, `Agent(` выпадает из кода (нужен fence из 4 бэктиков); `docs-update.md` ~350–352/379 — ссылка на несуществующий шаг `detect_runtime_capabilities`. Исправляется только в форке (issue в upstream не заводятся — решение владельца) | схемы из данных находят дефекты текста — исправить, а не обойти | генератор карт без дефектов по этим файлам; тесты workflows зелёные |
| 5.5b | `DEFECT_CLASS_DEFS`/`DEFECT_LINK_STYLE` — в `src/mermaid.cts`, без копий в `workflow-map.cts`/`plan-graph.cts`/`roadmap-graph` | дублирование | один источник, тесты зелёные |

## Только локальная разработка (решение владельца, 2026-10-04)

Ничего не публикуется: нет push в `origin` (ни обычного, ни force после синхронизации), нет issue/PR в
upstream. Переименование `next` → `next-pre-sync` и `sync/upstream-2026-10` → `next` — локально.
Пункты плана про push (D3, 3.11 «origin/next обновлён») отменены. `git fetch upstream` (только чтение) — можно.
| 5.3a | `plan graph` в отчёте `/gsd-progress` рядом с `roadmap graph` | не встроено в 5.2 | тест вывода progress |
| 5.7a | `gsd-system-architect` сам проверяет свой `DESIGN.md` через `gsd_run diagrams check` до завершения | производитель проверяет свой вывод, гейт — страховка | тест/контракт агента; бюджет размера |
| 5.7b | `diagrams check`: блоки `gsd:derived` с `%% gsd:source` перегенерируются и сравниваются (свежесть), а не пропускаются | сейчас их идентификаторы просто пропускаются | тест: устаревший derived-блок → finding |
| 5.7c | `test:mermaid-real` — в локальной цепочке проверок перед сведением (разработка локальная, CI не используется), с установкой зависимостей `tools/mermaid-check` | шага нет | цепочка запускает его; 0 расхождений |
| 3.4a | `gsd_run health`: диагностика статусов `VERIFICATION.md` вне закрытого набора (с предложенной заменой и причиной); `--repair` — только для однозначных (`verified`→`passed`), неоднозначные — в отчёт | upstream переход не сопровождает; в проектах владельца 15 таких отчётов ломают `/gsd-progress`, `roadmap analyze`, `audit-*` | тесты: обнаружение, однозначный repair, неоднозначный — не трогается |
| 3.4b | Применить к проектам владельца (mn, norn, ucars, dkleading и др. — `live-projects-migration.md`): 8 однозначных — `--repair`; 7 неоднозначных — агент по содержимому отчёта (`passed`/`gaps_found`/`human_needed`); по локальному коммиту в каждом проекте, только если файл не изменён текущей работой владельца | иначе после установки падают команды в 4 проектах | `/gsd-progress` и `roadmap analyze` в rpg/leads-api, `audit-open` в trade-mind/ucars — без `VerificationStatusError` |
| 3.4c | `<fails_when>` в старых планах и `checkpoint:decision` без `auto_select` — **не мигрировать**: гейт `<fails_when>` срабатывает только при планировании (написанные планы исполняются), decision без `auto_select` безопасно эскалируется владельцу | зафиксировано, чтобы не возвращаться | запись в worklog |
