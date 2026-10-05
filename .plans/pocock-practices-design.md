# Три практики Pocock в GSD: архитектурный обзор, ревью за период, ретро

Дата: 2026-10-04. Ветка `next` @ `cb8174c86`. Первоисточники: `mattpocock/skills` @ `24fe0ef77`
(MIT), документация Claude Code (`code.claude.com/docs/en/code-review.md`, `commands.md`,
`ultrareview.md`). Только исследование и проект: код не менялся.

> **Статус реализации (2026-10-05).** Волны 0, 1 и 2 (интеграция) влиты в `next`: Z1–Z3
> (тег `pre-pk0`), Z4–Z6 + этапы G (тег `pre-pk1`). Этапы G сделаны контрибуциями капабилити:
> новые loop points `milestone:pre`/`milestone:post` в `complete-milestone` (поправка ADR-857),
> `review stage` (milestone:pre, `code_review.window_at_milestone`, по умолчанию on),
> `arch stage` (milestone:post, `architecture.metrics_at_milestone` on +
> `architecture.survey_at_milestone` suggest), `retro stage` (execute:post и ship:post,
> `retro.auto` suggest); ответ этапа `decision/message/next` описан в `loop-hook-dispatch.md`.
> Не сделано: `audit-fix --source` (волна 2) и волна 3 (замеры). Подробности и хеши —
> `.plans/mn-fork-worklog.md`, раздел «Pocock practices, wave 1 + lifecycle stages».
>
> **Калибровка сигналов retro (2026-10-05).** Сумма сигналов без нормировки давала 997 на длинной
> сессии-оркестраторе и предлагала ретро в 30% сессий корпуса владельца (48 из 247 без единого
> возражения пользователя). Исправлены детекторы nav-streak, revert, edit-churn, repeated-call и
> reread. Поведенческие виды теперь считаются только по главному транскрипту. Score стал
> плотностью с насыщением по виду (`retro.kind_cap`, `retro.volume_calls`, `retro.volume_turns`).
> При пороге 8 ретро предлагается в 10.6% сессий (31 из 292) и в 1 из 247 сессий без возражений.
> Значения §D3 ниже (`nav_streak_min` 8 и т.п.) устарели; действующие — в
> `capabilities/retro/capability.json`, обоснование — ADR-5209 §8.

Принципы, по которым ниже принимаются решения:

- **P1. Детерминированное — в коде, модель — только для суждения.** Всё, что можно посчитать
  (git-история, граф импортов, метрики, сигналы из транскриптов), считает CLI в `src/*.cts`.
  Модель получает результат как данные и делает только то, что требует суждения.
- **P2. Fresh context per agent / thin orchestrators.** Workflow собирает вход через `gsd-tools`,
  запускает агентов и маршрутизирует результат. Тяжёлую работу сам не делает.
- **P3. Урок 4.9** (`.plans/report-ab-results.md`): форма отчёта не повышает точность
  LLM-ревьюера. Вердикт детектора помогает только на помеченных классах и, по направлению,
  ухудшает поиск непомеченных. Отсюда правило: если вывод детектора идёт ревьюеру, в промпте
  явно сказано, **какие классы проверены и что остальное ищется самостоятельно**. Всё новое
  перемеряется тем же харнессом, с вариантом без пре-пасса и с ним.
- **P4. ADR-857.** Новое поведение оформляется как capability. В core loop не появляется новая
  обязательная зависимость.

---

## A. Первоисточники

### A1. `/improve-codebase-architecture` (`skills/engineering/improve-codebase-architecture/`)

- **Вход.** Код. Опционально направление от пользователя (модуль, подсистема, болевая точка, спека
  ближайшей большой работы). Читает `GLOSSARY.md` и `docs/adr/`. Словарь берёт из skill
  `codebase-design`: module, interface, depth, seam, adapter, leverage, locality.
- **Процесс.**
  1. *Scope before you scan (YAGNI).* Если направления нет, идёт по `git log --oneline` и ищет
     горячие точки. Скан смещается к коду, который меняется.
  2. Субагент обходит код «органически» и отмечает трение: понимание одного концепта требует
     прыгать по множеству мелких модулей; **shallow**-модули (интерфейс почти как реализация);
     чистые функции, вынесенные ради тестов, когда баги живут в вызовах (нет locality); модули
     протекают через seams; код не тестируется через текущий интерфейс.
  3. **Deletion test:** если модуль удалить, сложность сконцентрируется или просто переедет
     к вызывающим? Карточку получают только кандидаты, где она концентрируется.
  4. HTML-отчёт в `$TMPDIR` (Tailwind + Mermaid через CDN). Каждая карточка: Files / Problem /
     Solution / Benefits (в терминах locality и leverage, какие тесты упростятся) / Before-After
     диаграмма / сила `Strong | Worth exploring | Speculative`. В конце Top recommendation.
     Интерфейсы ещё не предлагаются.
  5. Пользователь выбирает кандидата, начинается grilling loop. По ходу пополняется
     `GLOSSARY.md`. Если кандидата отвергли с устойчивой причиной, skill предлагает записать ADR,
     чтобы следующий прогон не предложил его снова.
- **Выход.** HTML-файл вне репозитория и решение, а не diff. Реализация идёт отдельно через
  spec → tickets → implement.
- **Что делает хорошо.** Смещение к горячим точкам. Deletion test как фильтр против общих советов
  по уборке. ADR-память об отвергнутом. Строгий общий словарь. Ничего не меняет в коде.
- **Ограничения** (из `docs/engineering/improve-codebase-architecture.md`). Grilling на слабых
  моделях начинается сразу, без отчёта («borderline unusable»), режима без grilling нет. CDN-отчёт
  молча ломается офлайн и при SRI-хуках. Почти никогда не говорит «всё хорошо»: сигнал этого —
  только когда все карточки `Speculative`. На больших legacy-кодовых базах ходит кругами.
  Вывод недетерминирован («always find new stuff»). Ссылается на `Agent(subagent_type=Explore)`,
  поэтому в других харнессах работает хуже. Отвергает метрику глубины Ousterhout (отношение строк
  реализации к строкам интерфейса), потому что её легко накрутить раздуванием реализации.

### A2. `/code-review`: два разных инструмента с одним именем

**Claude Code built-in** (`/code-review [low…max|ultra] [--fix] [--comment] [--max-findings]
[pr#|branch|path|a...b]`, алиас `/review`):

- Вход: коммиты ветки, которых нет в upstream, плюс незакоммиченное. Либо явная цель: путь, PR,
  ветка, диапазон `main...feature`.
- Процесс: форкнутый фоновый субагент. На `low`/`medium` отдаёт только самые уверенные находки,
  `high`…`max` расширяют покрытие. `ultra` запускает облачный мультиагентный прогон с
  верификацией находок против поведения кода. Читает `CLAUDE.md`, **но не `REVIEW.md`** (его
  читает только managed GitHub Code Review). Умеет запускаться по расписанию (scheduled task, без
  `ultra`).
- Выход: текст или findings list, `--fix` применяет правки, `--comment` постит в PR.
- Сильное: correctness-баги, верификация в `ultra`, effort как ручка точности и полноты, scheduling.
- Ограничения: нет знания о планах и спеке, нет журнала решений между прогонами, нет
  проектных стандартов кроме CLAUDE.md. Окно «за неделю» задаётся только руками через
  `a...b`.

**Pocock `code-review`** (`skills/engineering/code-review/SKILL.md`):

- Вход: фиксированная точка (SHA, ветка, тег, `HEAD~5`), обязательна. Diff `<fp>...HEAD`
  (three-dot, без незакоммиченного).
- Процесс: сначала проверка, что ref резолвится и diff не пуст. Потом поиск спеки (issue в
  коммитах → путь → `docs/specs/.scratch` → спросить) и стандартов (`CODING_STANDARDS.md`,
  `CONTRIBUTING.md` + **smell baseline**: 12 запахов Фаулера, всегда как judgement call; repo
  overrides). Дальше **два параллельных субагента**, Standards и Spec, каждый до 400 слов, у каждой
  находки цитата (правило, запах + hunk или строка спеки).
- Выход: две секции `## Standards` / `## Spec` без слияния и переранжирования, худшая находка
  внутри каждой оси.
- Сильное: оси не маскируют друг друга. Цитата обязательна, поэтому находку можно проверить.
  Ранний отказ на плохом ref.
- Ограничения (из `docs/engineering/code-review.md`): находки не перепроверяются
  («hypothesis, not evidence»). Нет сходимости, каждый прогон находит новое. Субагенты могут
  рекурсивно звать `/code-review` (один репорт: 50+ агентов). Если ревьюить в той же сессии, что
  писала код, это confirmation bias. Не видит незакоммиченное.

**Факт об этой установке.** `~/.claude/skills/code-review` — симлинк на `~/.agents/skills/code-review`,
и это Pocock-skill: текст совпадает с upstream до пунктуации. По документации плагинного
обхода локальный skill с тем же именем **затеняет** встроенный `/code-review`. Сейчас `/code-review`
в этой установке — Pocock two-axis, а не встроенный поиск багов. Встроенный остаётся доступен
через `/review` только если алиас не перехвачен; это надо проверить вживую. Плюс доступны
`mattpocock-skills:code-review` и `code-review:code-review` (плагин claude-plugins-official).
GSD-команда называется `gsd-code-review` и в коллизию не входит.

### A3. `/retro` (`skills/engineering/retro/SKILL.md`)

- **Вход.** Записи сессии: по умолчанию текущей, либо указанной в session logs. Загружает
  `writing-for-agents` как стилевой гайд.
- **Процесс.** Ищет кандидатов по семи категориям. Для каждой категории есть триггер «Use when»:
  Navigation (долго искал → navigation pointer), Automated checks (ошибку поймал бы чек; сначала
  прочитать собственные `lint`/`check`/CI репо, потому что **неподключённый или сломанный
  существующий чек — это и есть находка**; репо без guardrail — тоже находка), Coding standards
  (ревьюер пропустил → правило; **сначала классификация**: mechanical → детерминированный чек,
  «full stop»; judgement → `CODING_STANDARDS.md`, который читает ревьюер), Global AGENTS.md
  (вынести steering в стандарты или чеки), Tool economy, No-ops в steering-файлах, Information
  access (tee логов, read-only доступ).
- **Выход.** Список кандидатов по убыванию серьёзности. Ничего не применяется, пока пользователь
  не выбрал.
- **Опорная идея.** Стандарты принадлежат **ревьюеру**, у которого меньше всего контекстного
  давления. CLAUDE.md/AGENTS.md используются только для navigation pointers.
- **Сильное.** Каждый кандидат привязан к моменту сессии. Mechanical → check, а не проза.
  Неподключённый чек считается находкой. AGENTS.md должен со временем сокращаться.
- **Ограничения** (из docs). Видит одну сессию, поэтому не умеет удалять чеки, которые стали
  шумными. После долгой сессии модель «забывает борьбу из середины» и выдумывает общие советы
  под категории. Может переоценить тему одной сессии. Нет dry-run для предложенного чека.
  Порядок по серьёзности — черновик.

---

## B. Карта существующего в GSD

| Существующее | Что делает | Отношение к практике |
|---|---|---|
| `/gsd-code-review` + `gsd-code-reviewer` + `gsd-code-fixer` (capability `code-review`, точки `execute:post` / `execute:wave:post`) | Ревью файлов **одной фазы**. Фаза — обязательный позиционный аргумент. Scope: `--files` > SUMMARY > evaluation scope (`src/gate-evaluation-scope.cts`, union файлов коммитов, а не range). Глубина quick/standard/deep, `--fix`/`--auto`, reviewer lanes (`--codex`, …). Опциональный структурный пре-пасс **fallow** (`code_quality.fallow.*`: dead code, дубли, циклы, CRAP). Каждая находка несёт `guarded by: <rule> \| review only`. Performance вне scope v1 | Практика 2: ядро есть, **нет оконного режима** (неделя, `since last`), нет кумулятивного пре-пасса, нет журнала решений между прогонами, нет отдельной оси стандартов и smell baseline |
| `gsd-finding-refuter` (`mn-verify-gate`) | Пытается опровергнуть находки plan-checker до того, как они попадут к планировщику | Готовый adversarial-верификатор. Закрывает слабость Pocock «не перепроверяет» после переноса на находки ревью |
| capability `architecture`: `gsd-system-architect` (DESIGN.md, `plan:pre`) + `gsd-architect-reviewer` (ARCH-REVIEW.md, `verify:pre`) + contract-drift gate | Соответствие кода **заявленной фазой** структуре: размещение по слоям, разрешённые зависимости, контракты. Без DESIGN.md отдаёт `NO_DESIGN` | Практика 1: смежное, но другое. Это проверка обещаний фазы, а не поиск постепенного дрейфа по всей кодовой базе |
| `/gsd-map-codebase` (`--fast --focus arch\|concerns`, `--paths`) + `gsd-codebase-mapper` | Описывает, **что есть**: ARCHITECTURE/STRUCTURE/CONCERNS.md | Практика 1: нет deletion test, нет кандидатов deepening, нет маршрутизации решений, нет смещения к горячим точкам. CONCERNS.md — полезный вход |
| capability `refactor-trigger` (`gsd-tools refactor evaluate --phase N [--since ref]`, `src/complexity-trigger.cts`) | Цикломатика по функциям JS/TS, порог и скачок от якоря, предложение `-REFACTOR.md` | Детерминированный кирпич для обеих практик (сложность, дельта сложности за окно). Работает только по фазе |
| `src/symbol-index.cts` | Лексер (комментарии и строки вычищены) + декларации TS/Py/Go/Prisma/SQL, `listProjectFiles` | Кирпич для графа импортов. **Графа импортов, fan-in/fan-out, co-change в ядре нет** |
| capability `drift` | Новые каталоги, баррели, роуты вне карты → warn/remap | Сигнал «карта устарела», а не оценка архитектуры |
| capability `broken-windows` (`.planning/WINDOWS.md`, `ship:pre`) | Сквозной реестр дефектов, блокирует ship при `windows_enforce` | Куда класть отложенные находки оконного ревью и обзора |
| `/gsd-audit-fix` | audit → классификация → автофикс. Источник только `audit-uat` | Модель «находка → автофикс». Источники `window-review` и `arch-survey` естественно добавляются как `--source` |
| `/gsd-integration-checker`, `/gsd-audit-milestone`, `/gsd-ui-review` | Межфазная интеграция, закрытие milestone, визуальный аудит | Соседи, без перекрытия |
| `/gsd-forensics` | Пост-мортем упавшего workflow: git (30 коммитов, повторно правленные файлы), `.planning/`, SESSION_REPORT, worktree. **Транскрипты не читает** | Практика 3: частично (детектор stuck loop по git). Цель — диагноз, а не изменение среды |
| `/gsd-extract-learnings` → `graduation.md` (`transition`) | Артефакты фазы → LEARNINGS.md (decisions, lessons, patterns, surprises). Повторяющиеся элементы через HITL переносятся **в PROJECT.md** | Практика 3: знания о продукте, а не о среде агента. Перенос в PROJECT.md противоречит Pocock: always-loaded проза вместо чека |
| capability `profile-pipeline` (`scan-sessions`, `extract-messages`, `profile-sample`; по умолчанию выключена) | Читает `~/.claude/projects/*.jsonl` read-only, но **только user-сообщения** (`type==='user' && userType==='external'`) | Готовое обнаружение сессий и проектов. Для retro нужны tool_use/tool_result, hooks, denials |
| `complete-milestone` → `.planning/RETROSPECTIVE.md` | Повествовательная ретроспектива milestone (What worked / inefficient / lessons) | Потребитель вывода retro, а не замена |
| hooks (`gsd-context-monitor`, `gsd-session-state`, `gsd-prohibition-guard`, `gsd-test-tamper-guard`, …) | Enforcement при записи | Целевая точка для предложений retro категории «mechanical» |
| `agent_skills.gsd-code-reviewer` (config) | Skills, которые грузит только ревьюер (GAP-ANALYSIS: «единственный работающий путь») | Это **и есть** `CODING_STANDARDS.md` по Pocock: стандарты, которые читает ревьюер, а не имплементер |
| `.plans/rules-registry/` | Реестр 571 правила корпуса mn и чем каждое исполняется (линтер, `tools/checks`, workflow, проза) | Готовый вход для retro: правило, которое существует только в прозе, — кандидат в чек |

Схема данных в транскриптах проверена на текущей сессии: записи `type: user|assistant|system|attachment|…`,
блоки `tool_use` / `tool_result` (`is_error`), поля `toolUseResult`, `hookErrors`, `hookInfos`,
`preventedContinuation`, `toolDenialKind`, `isApiErrorMessage`, `isCompactSummary`, `isSidechain`,
`timestamp`, `uuid`/`parentUuid`. Субагенты лежат в `<session>/subagents/`, большие выводы
инструментов — в `<session>/tool-results/`. Всё нужное для детерминированного извлечения сигналов
трения в данных есть.

---

## C. Где детерминированное, где модель

| Практика | Детерминированно (CLI, `src/*.cts`) | Модель (агент с fresh context) |
|---|---|---|
| 1. Архитектурный обзор | Файлы, граф импортов (лексер из symbol-index + алиасы `tsconfig` paths), fan-in/fan-out, LOC, число экспортов, кластеры мелких модулей, pass-through (fan-in 1, fan-out 1, мало LOC), циклы (SCC), churn за окно, **co-change пары** (поддержка и уверенность: «поведение размазано»), сложность (`complexity-trigger`), горячие точки = churn × сложность | Чтение кода в зонах-кандидатах, deletion test, формулировка Problem/Solution/Benefits в словаре codebase-design, сила рекомендации, конфликт с ADR |
| 2. Ревью за период | Резолв окна (`--since 7d \| ref \| last`, union файлов коммитов окна через evaluation-scope), сопоставление коммит → фаза, кумулятивные дельты (рост LOC, дельта сложности base→tip, новые экспорты без потребителей, новые дубли через fallow при наличии, рост TODO и skip), повторы `review only` из прошлых REVIEW.md, журнал решений | Correctness по union-скоупу (существующий `gsd-code-reviewer`), ось стандартов (CLAUDE.md, ревьюерские skills, smell baseline), ось спеки (PLAN/CONTEXT фаз окна), опровержение находок |
| 3. Retro | Сигналы трения из JSONL: tool errors по инструменту и нормализованной команде, повторы идентичного вызова, повторные Read одного файла, циклы правок одного файла, блоки хуков и denials, interrupts, compaction, API errors, циклы падений тест-команды, серии Grep/Glob/Read без Edit (навигационное трение), дорогие выводы (`tool-results/`), fan-out субагентов. Инвентарь guardrails: npm-скрипты lint/check, eslint-rules, hooks registry, gates capabilities, размер CLAUDE.md, список skills. Каждый сигнал несёт указатель `session:uuid:timestamp` | Причина за сигналом, категория Pocock, mechanical или judgement, конкретное изменение, как проверить предложенный чек на текущем дереве |

Внешние MCP пользователя (codebase-memory, serena, atlas) уже есть во frontmatter агентов форка.
Агент может ими пользоваться, но **CLI-ядро от них не зависит**: zero runtime deps, и в рантайме
пользователя их может не быть. fallow остаётся опциональным пре-пассом, как сейчас.

---

## D. Рекомендация

### D1. Практика 1: `/gsd-arch-survey`, третья часть capability `architecture`

**Решение.** Новая команда внутри существующей capability `architecture`. Не режим
`map-codebase` и не режим `architect-reviewer`. Это третья часть той же capability: design
(`plan:pre`) → review (`verify:pre`) → **survey (периодически, вне loop)**. Почему не map-codebase:
другой тип вывода (кандидаты и решения, а не описание) и другой жизненный цикл (решения
копятся, отвергнутое не возвращается). Почему не architect-reviewer: тот сверяет с обещанием
фазы и без DESIGN.md отдаёт `NO_DESIGN`, а дрейф живёт вне обещаний.

**Состав.**

- `commands/gsd/arch-survey.md`: тонкий dispatch.
  `argument-hint: "[area…] [--paths p1,p2] [--since 90d|<ref>] [--grill] [--top N]"`.
- `gsd-core/workflows/arch-survey.md`:
  1. `gsd-tools arch metrics --paths … --since … --json` → `.planning/architecture/metrics-<date>.json`.
  2. Если направления нет, область берётся из горячих точек метрик.
  3. Агенты-исследователи `gsd-arch-surveyor` запускаются параллельно, по одному на зону: топ-K
     зон, разбиение по путям, в каждом свой fresh context. Каждый пишет свои карточки в файл.
  4. Синтез карточек — детерминированная склейка, а не агент.
  5. `gsd-finding-refuter` в режиме `arch` проверяет, что deletion test и указанные файлы
     реальны. Опровергнутое уходит в отдельную секцию «Отклонено при проверке».
  6. Пользователь выбирает кандидата → маршрут: `/gsd-explore` (сократический разбор), или
     `/gsd-phase add` / backlog `999.x`, или «отвергнуть с причиной».
  **grilling по умолчанию выключен.** `--grill` передаёт выбранного кандидата в `/gsd-explore`.
  Это ответ на главную жалобу на upstream.
- `agents/gsd-arch-surveyor.md`: Pocock-процесс. Словарь codebase-design. Deletion test
  обязателен для `Strong`. Карточка: Files, Problem, Solution, Benefits (locality, leverage,
  какие тесты упростятся), сила, конфликт с ADR. Явная строка из P3: «метрики подсвечивают
  только размер, fan-in/out, циклы, co-change и сложность; shallow-интерфейсы, утечки через seam и
  отсутствие locality ищи сам». Разрешено «нечего предлагать» как полноценный результат
  (`verdict: no-strong-candidates`).
- `gsd-core/references/codebase-design.md`: словарь и принципы (адаптация upstream под MIT, со
  ссылкой). Сюда же DEEPENING и design-it-twice. **Отношение строк реализации к строкам интерфейса
  явно отвергается** как метрика глубины. В метриках есть отношение «экспортов на LOC», но только
  как сигнал для поиска, а не как вердикт.
- `src/code-graph.cts` (новый, общий с D2): `buildImportGraph(root, {paths, aliases})` на лексере
  `symbol-index`, резолв относительных путей и алиасов из `tsconfig*.json` `paths` (Nx). Затем
  `fanIn/fanOut`, `stronglyConnected`, `moduleStats`.
- `src/git-history.cts` (новый, общий): `churn(range)`, `coChange(range, {minSupport, minConfidence})`.
  Все git-вызовы идут через seam `execGit`, бюджет ограничен.
- `src/arch-metrics.cts` + роутер `arch-command-router.cts`: CLI-семейство `arch` (`metrics`,
  `status`). Регистрируется как `commands[]` capability `architecture`.
- Ведение решений: `.planning/architecture/DECISIONS.md`, где у каждого кандидата есть id
  (хэш нормализованного множества файлов и вида проблемы) и disposition: accepted → phase N,
  rejected + reason, deferred. Следующий прогон детерминированно исключает rejected с той же
  сигнатурой. Если у проекта есть `docs/adr/`, отвергнутое с устойчивой причиной предлагается
  оформить ADR.
- Отчёт: markdown `.planning/architecture/SURVEY-<date>.md`. **HTML не по умолчанию.** По P3 форма
  не помогает модели, а человеку диаграммы до/после строятся **из `metrics.json` детерминированно**
  (существующий `src/mermaid.cts`). Модель картинки не рисует (принцип «диаграммы из данных»).
- Конфиг (absent = enabled в рамках активной capability): `architecture.survey_window` (`90d`),
  `architecture.survey_top_zones` (`5`), `architecture.small_module_loc` (`40`),
  `architecture.cochange_min_support` (`3`), `architecture.cochange_min_confidence` (`0.6`).

**Loop point.** Нет: обзор запускает человек, периодически. Опционально: contribution в
`complete-milestone`, которая только **предлагает** `/gsd-arch-survey`, когда метрики горячих точек
выросли относительно прошлого обзора. Сама метрика детерминирована.

**Приёмка (тесты).**

- `tests/code-graph.test.cjs`: импорты в комментариях и строках не считаются (лексер). Алиас из
  `tsconfig paths` резолвится. Цикл из 2 и из 3 узлов. Отсутствующий target попадает в
  `unresolved` и не теряется молча.
- `tests/git-history.test.cjs` (`createTempGitProject`): co-change на границах `minSupport-1 /
  minSupport / minSupport+1` и `minConfidence` ровно на пороге. Пустое окно отдаёт `degraded`
  с причиной, а не пустой успех.
- `tests/arch-metrics.test.cjs`: `small_module_loc` на `N-1 / N / N+1`. Pass-through детектор.
  JSON-схема вывода.
- Eval (харнесс `scripts/experiments/report-ab/`, режим arch): фикстурный репозиторий с посеянными
  shallow-кластерами, pass-through и размазанным поведением. Сравниваются recall и precision
  агента **с метриками и без них** (вариант C′ из 4.9: «проверены классы X»). Если метрики снижают
  recall непомеченных классов, они уходят из промпта и остаются только для выбора зон.

**Риски.** Дубли с `map-codebase --focus arch|concerns`: решается тем, что survey читает
`CONCERNS.md` как вход, а не дублирует его. Резолв алиасов: Nx и tsconfig `extends`, нужны
фикстуры. Стоимость: K параллельных агентов, ограничивается через `survey_top_zones`.
«Всегда находит новое»: журнал решений и честный `no-strong-candidates`.

### D2. Практика 2: оконный режим `/gsd-code-review --since`, а не новая команда

**Решение.** Расширить `/gsd-code-review`. Новая команда дублировала бы reviewer/fixer/lanes/fallow
и схему REVIEW.md. Фаза становится необязательной, если задано окно.

**Интерфейс.**
`/gsd-code-review --since <7d|2026-09-27|<ref>|last> [--until <ref>] [--lens correctness,standards,spec,simplify] [--depth …] [--fix]`.
`last` значит «с tip прошлого оконного ревью», то есть инкрементально, по аналогии с #3661.

**Состав.**

- `src/code-review-flags.cts`: `since`, `until`, `lens`. Фаза опциональна, если есть `since`.
  Неоднозначность (фаза и `--since` одновременно) — ошибка, а не молчаливый выбор.
- `src/gate-evaluation-scope.cts`: новый `ScopeUnit` `window`. Union файлов коммитов, достижимых
  из `until` и попадающих в окно. Тот же контракт «union, не range; пустое → degraded и сказано
  почему». Для каждого коммита — фаза из `## Task Commits` SUMMARY, иначе `unattributed`.
- `src/window-review.cts` + `gsd-tools review window-prepass`: кумулятивные дельты по окну.
  Рост LOC по файлу. Дельта сложности base→tip (`complexity-trigger.analyzeSource` над
  `git show base:file` и tip). Новые экспорты без потребителей (`code-graph` fan-in 0). Файлы с
  высокой частотой правок в окне (churn). Повторяющиеся `guarded by: review only` из REVIEW.md
  фаз окна. Дубли через fallow, если он включён. Вывод:
  `.planning/reviews/<date>-window/prepass.json`.
- `gsd-core/workflows/code-review/steps/window-scope.md` (ленивый шаг, чтобы не раздувать
  `code-review.md` на 947 строк; бюджет ADR-1610). Ветка `--since` → prepass → линзы.
- Линзы — **отдельные агенты, каждый в своём fresh context**, параллельно. Оси не сливаются
  (Pocock):
  - `correctness`: существующий `gsd-code-reviewer` над union-скоупом. При превышении бюджета
    скоуп делится на пачки по файлам; каждая пачка — отдельный запуск.
  - `standards`: новый `gsd-standards-reviewer`. Читает CLAUDE.md, `agent_skills.gsd-code-reviewer`,
    CONTRIBUTING/CONTEXT, smell baseline (12 запахов, всегда judgement call, repo overrides).
    Каждая находка цитирует правило или запах вместе с hunk.
  - `spec`: новый `gsd-spec-reviewer`. По коммитам с фазой сверяет с PLAN/CONTEXT/REQUIREMENTS этих
    фаз. По `unattributed` честно пишет «нет спеки».
  - `simplify`: кумулятивные упрощения (дубли между коммитами, полумиграции, мёртвые остатки
    заменённого пути). Это та деградация, которую ревью одного изменения не видит.
  - Пре-пасс передаётся линзам по P3: «проверены классы: рост, сложность, мёртвые экспорты,
    дубли (если fallow); остальное ищи сам». Переранжирования поверх нет.
- Верификация: `gsd-finding-refuter` расширяется на находки ревью (режим `review`). Находка без
  воспроизводимой цитаты отклоняется. Это закрывает «hypothesis, not evidence» у Pocock.
- Выход: `.planning/reviews/<date>-window/REVIEW.md`: та же схема (CR-/WR-/IN-), по секции на
  линзу. `--fix` идёт в существующий `code-review-fix.md`, нужен только параметр пути
  REVIEW.md. `.planning/reviews/LAST-WINDOW.json` хранит tip для `--since last`.
- Журнал решений: `.planning/reviews/DISPOSITIONS.md`. Формат по образцу ADR-3806: стабильный id
  находки = хэш (файл, нормализованный hunk, класс), а не номер строки. Следующий прогон не
  поднимает rejected и deferred снова. Deferred автоматически заводится в `WINDOWS.md`
  (broken-windows). Это ответ на «always find new stuff».
- `gsd-audit-fix --source window-review`: второй источник аудита.
- Расписание: GSD расписание не владеет. В доке указан путь через Claude Code `/loop 7d
  /gsd-code-review --since last` или scheduled task (без `ultra`). Встроенный `/code-review`
  остаётся дополнением для поиска багов в PR.

**Конфиг.** `code_review.window_default` (`7d`), `code_review.window_lenses`
(`correctness,standards,spec,simplify`), `code_review.window_max_files_per_batch` (`40`).

**Приёмка.**

- `tests/code-review-flags.test.cjs`: `--since` без фазы проходит. Фаза вместе с `--since` дают
  ошибку. `--since last` без `LAST-WINDOW.json` — понятная ошибка.
- `tests/gate-evaluation-scope.test.cjs`: `window`. Коммит ровно на границе окна (по времени
  коммита): `-1s / 0 / +1s`. Коммит из другой ветки попадает в `unreachable`. Пустое окно отдаёт
  `degraded`.
- `tests/window-review.test.cjs`: дельта сложности на пороге `refactor.complexity_jump_delta`
  `-1 / = / +1`. Экспорт, потерявший последнего потребителя в окне, обнаруживается. Батчинг:
  `max_files_per_batch` `-1 / = / +1` даёт 1 / 1 / 2 пачки.
- Eval: фикстуры с посеянной кумулятивной деградацией (дубль между двумя коммитами разных фаз,
  мёртвый остаток после замены, полумиграция API). Сравнение recall «ревью по фазам» и «оконное
  ревью», и «с пре-пассом» и «без пре-пасса» (контроль якорения по P3).

**Риски.** Бюджеты: union за неделю может быть сотни файлов; решается батчингом, `--max-files` и
сортировкой по churn × сложности, а отрезанное явно перечисляется. Размер `code-review.md`:
только ленивые steps. Emitted bytes: изменения в shipped markdown требуют fragment в
`tests/emitted-drift-acks/`. Рекурсия субагентов (баг upstream): в брифах линз прямой запрет
звать `/gsd-code-review` или порождать агентов.

### D3. Практика 3: `/gsd-retro`, новая capability `retro`

**Решение.** Новая команда и новая capability. Ни forensics (диагноз упавшего workflow по git),
ни extract-learnings (знание о продукте) не отвечают на вопрос «что поменять в среде агента».
Чтение сессий выносится в общий модуль и переиспользуется profile-pipeline.

**Состав.**

- `commands/gsd/retro.md`:
  `argument-hint: "[--session <id>|--last|--phase N|--since 7d] [--agent-sessions] [--apply <cand-id>]"`.
- `src/session-transcript.cts` (новый, общий): обнаружение сессий проекта (логика вынесена из
  `profile-pipeline`), потоковое чтение JSONL, включая `subagents/` и `tool-results/`.
  Типизированные записи. Адаптеры рантаймов: Claude Code первым. Для рантаймов без
  транскриптов — `status: degraded`, сигналы только из git и `.planning/`, и это явно сказано.
  Секреты маскируются через `src/secrets.cts` до того, как выдержка попадёт в промпт.
- `src/retro-signals.cts` + `gsd-tools retro signals --session … --json`: сигналы трения из
  раздела C. У каждого сигнала есть указатель и ограниченное окно выдержки (N записей до и после).
  Пороги заданы конфигом.
- `src/retro-inventory.cts` + `gsd-tools retro inventory --json`: что уже есть в среде. Скрипты
  `lint`/`check`/`test` из `package.json`, CI-workflow, pre-commit/lefthook, `eslint-rules/`,
  `hooks/managed-hooks-registry.cjs`, gates capabilities, размер CLAUDE.md и `.claude/CLAUDE.md`
  в байтах, `agent_skills.*`, skills. Если рядом есть реестр правил (формат
  `.plans/rules-registry/merged.json`), список «правило только в прозе».
- `agents/gsd-retro-analyst.md` (fresh context): получает сигналы, выдержки и инвентарь, не весь
  транскрипт. Работает по категориям Pocock в терминах GSD:
  - navigation → указатель в CLAUDE.md/CONTEXT.md (предикат), а не проза;
  - mechanical → чек: правило линтера проекта, hook, gate capability в loop point, `gsd-tools verify`;
  - judgement → правило в **ревьюерских** skills (`agent_skills.gsd-code-reviewer`) или в оси
    standards (D2), но не в CLAUDE.md;
  - CLAUDE.md slimming, no-ops, tool economy, information access.
  Обязательное правило: **кандидат без указателя на сигнал отбрасывается**. Неподключённый
  существующий чек из инвентаря — находка первого класса.
- `gsd-finding-refuter` (режим `retro`) проверяет, что указатель реальный и что предложенный чек
  на текущем дереве **срабатывает на инциденте и молчит на чистом коде**. Это закрывает
  отсутствие dry-run у Pocock.
- Выход: `.planning/retros/<date>-<session8>-RETRO.md`. Кандидаты по серьёзности, у каждого
  `id`, категория, указатель, предлагаемое изменение, команда проверки. Ничего не применяется.
- Замыкание петли. Человек выбирает → `--apply <cand-id>` маршрутизирует: mechanical — в
  `/gsd-quick` (атомарный коммит чека с тестом), остальное — в `/gsd-capture`. **Автоприменения
  нет.** Причины: (1) аргумент upstream — авто-хуки блокировали хорошие изменения; (2) правило
  форка «никакой маркер, который может записать проверяемый агент, не освобождает от проверки»:
  агент не пишет правила, которые связывают его самого, без человека.
- Обратная петля, которой нет у Pocock: `.planning/retros/CHECKS.json`. Для каждого принятого чека
  хранятся инцидент-источник, дата и счётчики срабатываний (из транскриптов: блок хука или
  ошибка линтера с этим правилом). `retro signals` по окну отдаёт «никогда не срабатывал за N
  дней» и «срабатывает на коммитах, которые потом не откатывались» как **кандидатов на
  удаление**. Удаление тоже решает человек.
- Опциональный loop point (capability, по умолчанию выключен): contribution `ship:post` и шаг в
  `complete-milestone` запускают **только** `retro signals`. Если сумма сигналов выше
  `retro.suggest_threshold`, выводится одна строка «эта сессия буксовала: `/gsd-retro --session X`».
  Модель при этом не запускается. Гладкая сессия молчит.
- Связи. Вывод retro можно подать в `RETROSPECTIVE.md` milestone. `graduation.md` получает
  предупреждение: lesson, которую можно проверить механически, предлагается как чек, а не как
  строка в PROJECT.md. Встроенные `/doctor` (обрезка CLAUDE.md), `/skill-doctor` (стоимость
  skills) и `fewer-permission-prompts` указаны как инструменты для категорий tool economy и
  permissions, без дублирования.

**Конфиг.** `retro.enabled` (activation key capability), `retro.suggest_threshold`,
`retro.repeat_call_min` (`3`), `retro.reread_min` (`3`), `retro.nav_streak_min` (`8`),
`retro.excerpt_window` (`6`), `retro.max_signals` (`40`).

**Приёмка.**

- `tests/session-transcript.test.cjs`: синтетические JSONL-фикстуры (реальные транскрипты не
  коммитятся). Битая строка пропускается и считается. Субагентские файлы подхватываются.
  Секрет в выдержке замаскирован.
- `tests/retro-signals.test.cjs`: каждый порог на `-1 / = / +1`. `max_signals` на границе: что
  отрезано, перечислено. Указатель стабилен.
- `tests/retro-inventory.test.cjs`: временный проект с `package.json` scripts, хуками и пустым CI.
  Отсутствие guardrail — находка.
- Eval: синтетические сессии с посеянным трением (20 Grep до нужного файла; повтор падающей
  команды; правка, которую потом заблокировал хук; пропущенный ревьюером класс). Ожидаемая
  категория и тип кандидата. Метрика — доля кандидатов, которые прослеживаются до посеянного
  трения, против выдуманных общих советов.

**Риски.** Приватность транскриптов: только read-only, маскирование, без выгрузки. Формат JSONL
меняется между версиями Claude Code: неизвестные поля игнорируются, отсутствие ключевых полей
даёт `degraded`. Только Claude-first: остальные рантаймы получают degraded-режим, и это сказано.
Раздувание правил: обратная петля через `CHECKS.json` и удаление как полноценный кандидат.

---

## E. Порядок внедрения и разбиение на зоны

Порядок выбран по зависимостям, а не по удобству.

**Волна 0 — детерминированные основы, параллельно, непересекающиеся файлы:**

| Зона | Файлы | Тесты |
|---|---|---|
| Z1 граф и история | `src/code-graph.cts`, `src/git-history.cts` | `tests/code-graph.test.cjs`, `tests/git-history.test.cjs` |
| Z2 транскрипты | `src/session-transcript.cts`, рефактор `profile-pipeline` на него (только чтение), `src/retro-signals.cts`, `src/retro-inventory.cts` | `tests/session-transcript*.test.cjs`, `tests/retro-*.test.cjs`, существующие тесты profile-pipeline зелёные |
| Z3 окно в scope | `src/gate-evaluation-scope.cts` (`window`), `src/code-review-flags.cts` | соответствующие `tests/*.test.cjs` |

**Волна 1 — поверхности, параллельно (каждая зависит только от своей основы):**

| Зона | Файлы |
|---|---|
| Z4 оконное ревью | `src/window-review.cts`, `gsd-core/workflows/code-review/steps/window-scope.md`, `agents/gsd-standards-reviewer.md`, `agents/gsd-spec-reviewer.md`, режим `review` в `agents/gsd-finding-refuter.md`, параметр пути в `code-review-fix.md` |
| Z5 архитектурный обзор | `src/arch-metrics.cts`, `src/arch-command-router.cts`, `commands/gsd/arch-survey.md`, `gsd-core/workflows/arch-survey.md`, `agents/gsd-arch-surveyor.md`, `gsd-core/references/codebase-design.md` |
| Z6 retro | `commands/gsd/retro.md`, `gsd-core/workflows/retro.md`, `agents/gsd-retro-analyst.md`, `capabilities/retro/capability.json`, роутер `retro` |

Режимы `finding-refuter` (`review`, `arch`, `retro`) правятся в одном файле. Поэтому файл
принадлежит Z4, а Z5 и Z6 передают свои режимы патчем в волну 2.

**Волна 2 — интеграция, один агент последовательно, потому что файлы общие:**
`capabilities/architecture/capability.json` (commands, config), `capabilities/code-review/capability.json`
(config), `src/config-schema.cts` + `docs/CONFIGURATION.md`, роутеры `commands/gsd/ns-review.md` и
`ns-context.md` (обе раскладки: плоская и nested, #2792), `docs/INVENTORY.md` +
`INVENTORY-MANIFEST.json` (все `families.*`), `npm run regen:derived`, fragment в
`tests/emitted-drift-acks/`, `.compact.md` для новых агентов, если этого требует registry-правило
(сейчас 29 compact на 38 агентов), режимы finding-refuter для arch и retro, `audit-fix --source`.
Проверки: `lint:generated-sync`, `check:alias-drift`, `lint:ci`, `test:affected`.

**Волна 3 — замеры:** три eval-набора из разделов приёмки на харнессе `report-ab` (haiku и sonnet,
с пре-пассом и без). Решение о передаче пре-пасса агентам принимается по данным.

**ADR.**

- Новый ADR «window review unit»: расширение ADR-5057 §4 юнитом `window`. Принцип «union, не
  range» сохраняется.
- Новый ADR для capability `retro`: чтение транскриптов, приватность, Claude-first и degraded для
  остальных, запрет автоприменения.
- Survey укладывается в существующую ADR-857 capability `architecture`. Нужна только поправка
  описания capability.

**Процесс форка.** Только локально (память `no-upstream-issues`): никаких issue и PR. Каждое
изменение записывается в `.plans/mn-fork-worklog.md`. Changelog — через fragment, если ветка
когда-нибудь пойдёт в upstream.

---

## F. Чего не делать

- Не грузить smell baseline и стандарты в CLAUDE.md или в промпт имплементера. Это ось ревьюера
  (Pocock, и это подтверждает путь `agent_skills.gsd-code-reviewer`).
- Не делать HTML-отчёты средством точности. По 4.9 они только для человека и строятся из данных.
- Не давать ревьюеру вывод детектора как полный список. Всегда перечислять, какие классы проверены.
- Не запускать retro и survey на каждой сессии моделью. Детерминированный сигнал решает, стоит ли
  предлагать запуск.
- Не применять предложения retro автоматически.
- Не вводить метрику глубины «строки реализации / строки интерфейса» как вердикт.

---

## G. Решение по этапам жизненного цикла (2026-10-04, по запросу владельца «добавить как этап, вроде executor»)

Принцип: **детерминированный этап — всегда; проход модели — по триггеру или на естественной границе
накопления.** Модельный проход на каждом этапе фазы стоит полного контекста агента и, по 4.9, не
повышает точность сам по себе; сигнал для запуска считает код.

| Практика | Детерминированный этап (всегда, без модели) | Модельный этап (свежий агент-специалист, как executor/verifier) | Ключ и дефолт |
|---|---|---|---|
| Ревью за период | `review window-prepass` по окну с прошлого оконного ревью — на границе milestone (`audit-milestone`/`complete-milestone`), пишет дельты в отчёт аудита | **Этап на границе milestone:** оконное ревью диапазона milestone (`--since last` либо диапазон milestone) — milestone и есть точка накопления, ради которой практика существует | `code_review.window_at_milestone`: `on` (absent = enabled; стоимость — один проход на milestone) |
| Архитектурный дрейф | `arch metrics` на `complete-milestone`: сравнение горячих точек с прошлым обзором (`.planning/architecture/`) | Обзор `gsd-arch-surveyor` по зонам, где метрики выросли выше порога | `architecture.survey_at_milestone`: `suggest` (по умолчанию предлагает с указанием зон) / `auto` (запускает сам) / `off` |
| Retro | `retro signals` на `ship:post` и в конце `execute-phase` (фаза): сигналы трения из транскриптов и артефактов (повторные исправления, откаты, gaps_found, циклы plan-checker/node_repair) | `gsd-retro-analyst`, когда сумма сигналов выше порога | `retro.auto`: `suggest` (по умолчанию) / `auto` / `off`; `retro.signal_threshold` |

Почему не `verify:pre` для обзора и не на каждой фазе для ретро: дрейф и деградация — свойства
окна изменений, а не одной фазы (фазовое соответствие уже проверяет `gsd-architect-reviewer`); ретро
без сигналов трения — пустой проход. Предложения retro никогда не применяются автоматически (F).
Этапы оформляются контрибуциями капабилити в loop points (ADR-857/959) — в волне 2 (интеграция).
