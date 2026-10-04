# Backlog

Локальный список находок и задач по этому форку. Не публикуется как GitHub Issues —
для внутреннего отслеживания владельцем форка.

## Открыто

### Тест `handles nothing to commit` (`tests/commands.test.cjs:1346`) падает независимо от рабочей ветки

**Обнаружено:** 2026-08-16, полный прогон `node --test tests/commands.test.cjs` во время
разбора `--cwd`-фикса ниже (см. «Закрыто»). Не связано с этим фиксом — воспроизведено
на `git stash` (чистое дерево до правки).

**Симптом:** `output.reason` возвращает `commit_failed` вместо ожидаемого
`nothing_to_commit`. Тест создаёт временный git-репозиторий в `tmpDir`, коммитит
начальное состояние, затем вызывает `gsd-tools commit "test message"` без изменений
файлов — ожидается, что команда распознает пустой diff и вернёт `nothing_to_commit`.

**Гипотеза (не проверена):** вероятно, зависит от локальной git-конфигурации машины
(`user.name`/`user.email` не заданы глобально, или иная причина `git commit` внутри
тестового `tmpDir` фейлится до проверки на пустой diff — код падает раньше, чем
успевает распознать «нечего коммитить», и репортит generic `commit_failed`).

**Не проверено:** какая именно строка в `cmdCommit`/аналоге формирует
`commit_failed` вместо `nothing_to_commit`, и воспроизводится ли на CI/другой машине.

### `phase.complete` не пересчитывает `progress.completed_phases`/`completed_plans` в STATE.md frontmatter

**Обнаружено:** 2026-08-16, `legion-app`, сразу после `phase.complete "13"` — при
проверке STATE.md перед возобновлением `/gsd-autonomous --from 14`.

**Симптом:** `phase.complete` верно обновил `current_phase: 14` и
`current_phase_name` во frontmatter, но НЕ обновил соседние поля
`progress.completed_phases` (осталось `12`, реально `13`) и
`progress.completed_plans` (осталось `68`, реально `72` — 4 плана Фазы 13
доехали). Раздел `## Progress` (`total_phases`/`completed_phases` и т.п.) —
единственное место, откуда пользователь и стартовый баннер autonomous узнают
агрегатный прогресс; расхождение искажает именно эту сводку, не влияя на саму
фильтрацию фаз (та идёт по `phase_complete` каждой фазы отдельно в ROADMAP.md,
не по агрегату STATE.md).

**Не проверено:** какая именно функция в `phase.cts`/аналоге отвечает за
frontmatter-апдейт STATE.md и почему она правит `current_phase` но пропускает
`progress.*` — не читал код на этот раз, только зафиксировал симптом сравнением
`git show HEAD:.planning/STATE.md` до и после вызова `phase.complete`.

**Проверено 2026-08-20 — воспроизвести не удалось; гипотеза о пропуске `progress.*` неверна.**
`cmdPhaseComplete` (src/phase.cts:1796) вызывает `transitionCore` (:2676), а после него
`syncStateFrontmatter`, который перестраивает блок `progress` из состояния диска
(src/state.cts:1848-1855). На синтетическом проекте (2 фазы, по плану и summary
в каждой) `phase complete 2` дал `completed_phases: 0 → 2`, `completed_plans: 0 → 2`.

Что при этом действительно расходится и объясняет исходное наблюдение: поле
`progress.percent` записывается только когда границу milestone удалось определить
(`milestoneUnbounded` → `percent = null`, #1761). После архивации milestone фазы
уезжают в `milestones/`, `total_phases` становится `null`, и `percent` из frontmatter
исчезает — видно в `mn/libs/modules/konung/.planning/STATE.md` (есть `completed_phases: 7`,
нет `percent`) против `ucars` (есть `percent: 71`). Это задокументированное поведение
#1761, а не потеря пересчёта.

**Остаётся непроверенным:** конкретный прогон в `legion-app`. Возможные объяснения —
STATE.md читался до завершения транзакции, либо milestone там был unbounded. Без
исходного дерева отличить их нельзя, поэтому пункт закрыт как невоспроизводимый,
а не как исправленный.

### `phase.complete` warning путает `DEF-*` (deferred decisions) с `REQ-ID` требованиями

**Обнаружено:** 2026-08-15, `/gsd-autonomous` в `legion-app`, transition Фазы 13 →14
(`node gsd-tools.cjs query phase.complete "13"`).

**Симптом:** результат содержал warning:

```
"REQUIREMENTS.md: 3 REQ-ID(s) found in body but missing from Traceability table:
DEF-03, DEF-05, DEF-04 — add them manually to keep traceability in sync"
```

Но `DEF-03`/`DEF-04`/`DEF-05` в `legion-app/.planning/REQUIREMENTS.md` — это не
формальные требования (`REQ-*`/`TOOL-*`/`ENF-*`), а отдельная таблица «Deferred
Decisions» (строки 414-416, вне секции `## Traceability`) — отложенные продуктовые
решения владельца (потребители Staff-API, кириллица/латиница и т.п.), которые по
построению не участвуют в Traceability-таблице требований v1.

**Причина (гипотеза, не проверена чтением кода):** матчер, ищущий "REQ-ID" в теле
файла для сверки с Traceability, вероятно использует общий regex вида `[A-Z]+-\d+`
без различения namespace (`REQ-`/`DEF-`/`TOOL-`/`ENF-` и т.д.), поэтому ловит любую
ID-подобную строку независимо от её смысловой категории.

**Причина, установлена чтением кода 2026-08-20:** `src/phase.cts:2418` собирает
ID из тела файла паттерном `/\*\*([A-Z][A-Z0-9]*-\d+)\*\*/g` — namespace-агностично,
как и предполагала гипотеза. Секционный фильтр рядом (`DEFERRED_KEYWORD_RE`) уже
умел подавлять `## Deferred v2 Requirements` и `## Future Backlog`, но слова
`decision`/`decisions` в нём не было, поэтому таблица «Deferred Decisions» под
фильтр не попадала.

**Исправлено:** `decisions?` добавлено в `DEFERRED_KEYWORD_RE`.

Фильтровать по ПРЕФИКСУ ID (`REQ-`/`TOOL-`/`ENF-`) — очевидная альтернатива и она
неверна: проекты именуют требования свободно (`ucars` — ENF/UI/FEAT/APP, `trade-mind` —
MONEY/RT/ROUTES/SVC/BOOT), и whitelist тихо перестал бы проверять большинство из них.
Про принадлежность строки к требованиям говорит секция, а не префикс.

Проверено, что правка ничего не подавляет из существующего: ни в одном из шести
REQUIREMENTS.md в `mn`/`awesome-projects` нет заголовка со словом «decision».

**Тесты:** два кейса в `tests/phase.test.cjs` — «Deferred Decisions» не предупреждает,
и (обратная половина контракта) неотслеженное требование в активной секции
по-прежнему предупреждает, в каком бы namespace оно ни было.

### Установленный runtime отстаёт от ветки `feat/mn-verify-gate` — `artifact-frontmatter-equals` недоступен

**Обнаружено:** 2026-08-15, во время автономного прогона `/gsd-autonomous` в проекте
`legion-app` (Фаза 12, шаг transition после `passed`-верификации).

**Симптом:** блокирующий гейт `ship:pre` (capability `security`, predicate
`artifact-frontmatter-equals`) падает с ошибкой:

```
Error: gate predicate evaluation failed: Unknown predicate kind:
"artifact-frontmatter-equals". Known kinds: command-exit-zero
```

**Причина, установлена точно:** коммит `d3ddcaba` — «fix(#2785): implement missing
gate predicate evaluators (#2816)», датирован 2026-08-03 — реализует
`artifact-frontmatter-equals` в `src/gate-predicate-evaluator.cts`
(`EVALUATOR_KINDS = ['command-exit-zero', 'artifact-frontmatter-equals']`). Коммит
существует в форке на ветке `feat/mn-verify-gate`, рабочее дерево форка чистое
(правка не потеряна, не забыта — просто не выкачена).

Установленный runtime `~/.claude/gsd-core` — версия `1.9.1`, скомпилированный
`bin/lib/gate-predicate-evaluator.cjs` **не содержит** `artifact-frontmatter-equals`
(`grep -c "artifact-frontmatter-equals" bin/lib/gate-predicate-evaluator.cjs` → `0`).
Ветка `feat/mn-verify-gate` не смержена в `main` этого форка, и после мержа сама
установка (`npx -y @opengsd/gsd-core@latest --claude --local` или эквивалент) не
перезапускалась.

**Не недоделанная фича — недокаченный релиз.** Разбираться в логике
`artifact-frontmatter-equals` не нужно, она уже написана и, предположительно,
покрыта тестами (см. `tests/` рядом с `src/gate-predicate-evaluator.cts`).

**Что нужно сделать:**
1. Смержить `feat/mn-verify-gate` в `main` (после ревью — 3 коммита впереди
   `origin/main` на момент находки).
2. Пересобрать (`npm run build`) и переустановить runtime в
   `~/.claude/gsd-core` (или туда, куда указывает актуальный setup-скрипт).
3. Проверить, что второй заблокировавший гейт того же прогона —
   `api-coverage.verify-pre` (query, не predicate; capId `ai-integration`,
   `workflow.api_coverage_gate`) — тоже реализован в этой же ветке или в другой;
   на момент находки не проверялось, реализован ли он вообще где-либо в форке.

**Побочный эффект, встреченный на практике:** `handle_blocker` в
`autonomous.md` для такого случая (гейт не смог выполниться — расценивается
как блокер, "gate that could not run is not a gate that passed") корректно
остановил transition вместо того, чтобы молча пропустить непройденный гейт —
сам механизм сработал правильно.

## Закрыто

### Явный `--cwd` к ещё не существующей вложенной директории игнорируется — `gsd-new-project` не может забутстрапить изолированный `.planning/` внутри монорепо

**Обнаружено:** 2026-08-16, `mn` монорепо, при попытке запустить `/gsd-new-project`
для нового продуктового модуля (`libs/modules/norn/`) как отдельного GSD-проекта —
по образцу того, как `libs/heimdall/` задуман переиспользуемым модулем, встраиваемым
в любое приложение репозитория. Владелец явно запросил изолированный `.planning/`
внутри поддиректории существующего git-дерева (`libs/modules/norn/.planning/`),
БЕЗ отдельного git worktree — тот же git-репозиторий, что у корневого monorepo GSD.

**Симптом:** `gsd_run query init.new-project --cwd /repo/libs/modules/norn` (директория
существует, но ещё пуста — первый запуск, `.planning/` там ещё нет) возвращал
`project_root: /repo` и `project_exists: true`, находя корневой `.planning/PROJECT.md`
монорепы вместо честного `project_exists: false` для новой поддиректории. Любое
продолжение workflow писало бы новые планировочные артефакты в чужой, уже занятый
`.planning/` корневого проекта.

**Причина, установлена точно.** Два НЕЗАВИСИМЫХ резолвера `cwd` внутри `main()`
(`gsd-core/bin/gsd-tools.cjs`), оба применяющие одну и ту же эвристику "владеет ли
эта директория уже `.planning/`, иначе откатиться выше" — правильную эвристику ТОЛЬКО
для случая, когда `cwd` неявный (`process.cwd()`), и ошибочную, когда `cwd` был
передан explicit-флагом (в этом случае каждая из них должна доверять указанному пути
буквально, `.planning/` там или нет — это цель бутстрапа, а не признак чужого дерева):

1. `resolveMainWorktreeCwd(cwd)` (строка ~3637) — короткое замыкание на
   `existsSync(cwd/.planning)`, иначе `resolveWorktreeRoot(cwd)` → git worktree root.
2. `findProjectRoot(cwd)` (`gsd-core/bin/lib/project-root.cjs`, вызывается отдельно
   на строке ~3826 в `main()`, ПОСЛЕ первого резолвера) — тот же паттерн: "(0) own
   `.planning/` guard", иначе walk-up до ближайшего предка с `.planning/`.

Первый вызов сначала выглядел исправленным (добавление `explicitCwd`-параметра дало
верный `cwd` сразу после его возврата — подтверждено `console.error`-трассировкой),
но второй, независимый вызов чуть ниже по тому же `main()` откатывал результат
обратно, потому что о явности `--cwd` не знал вообще — отдельный код, отдельный
баг с тем же корнем.

**Исправление:** оба резолвера получили доступ к флагу "был ли `--cwd` передан
явно" (`explicitCwd`, вычисляется в `main()` рядом с самим парсингом `--cwd`/`--cwd=`)
и коротко замыкаются на явном `cwd` без дальнейшей auto-детекции, когда флаг `true`:
- `resolveMainWorktreeCwd(cwd, { explicitCwd })` — новая ранняя проверка
  `if (deps.explicitCwd) return cwd;`.
- `main()`: `if (!SKIP_ROOT_RESOLUTION.has(command) && !explicitCwd) { cwd = findProjectRoot(cwd); }`.

Поведение БЕЗ явного `--cwd` (обычный интерактивный запуск из любого места внутри
дерева) не меняется — обе эвристики продолжают работать как раньше для ambient
`process.cwd()`, что и защищают существующие тесты (`resolveMainWorktreeCwd (#3050)`
suite в `tests/commands.test.cjs`, все зелёные после правки).

**Тесты:** добавлены 2 кейса в `tests/commands.test.cjs` под тем же `describe`
(`resolveMainWorktreeCwd (#3050)`): explicit `--cwd` short-circuits даже когда
`.planning/` ещё не существует (регрессия на сам баг); non-explicit cwd продолжает
auto-resolve к worktree root, когда `.planning/` отсутствует (защита старого пути).
Полный `node --test tests/commands.test.cjs`: 199/200 (единственный failure —
`handles nothing to commit`, отдельная предсуществующая находка выше, не регрессия
от этой правки — воспроизведена и на `git stash`'нутом чистом дереве).

**Применено также к установленной копии** `~/.claude/gsd-core/bin/gsd-tools.cjs`
(не только в этом форке) — иначе Claude Code сессии, использующие установленный
runtime вместо форка напрямую, продолжили бы бить в тот же баг.

### `phase.complete` не обновляет Traceability-таблицу REQUIREMENTS.md при отсутствии совпадающей строки

**Обнаружено:** 2026-08-15, тот же прогон (Фаза 12 legion-app), сразу после
находки про `artifact-frontmatter-equals`.

**Симптом:** `gsd_run query phase.complete 12` корректно проставил чекбоксы
`[x]` для PLAT-10/CONTRACT-09/CONTRACT-10 в теле REQUIREMENTS.md, но вернул
предупреждение и НЕ обновил статус в таблице Traceability внизу файла:

```
"REQUIREMENTS.md: Traceability row write skipped for REQ-ID(s) cited by
ROADMAP (no matching row found): PLAT-10, CONTRACT-09, CONTRACT-10"
```

Строки в таблице существовали (`| PLAT-10 | Фаза 12 — Vue-мост | Задача |
Pending |`), но, видимо, matcher ищет их по другому шаблону/полю, чем тот,
что уже есть в файле, — отсюда "no matching row found" при физически
присутствующей строке. Не разбирался в причине несовпадения матчера
(потребует чтения кода `requirements.cts`/аналога), просто зафиксировал
симптом. Правился вручную в проекте.

**Причина, установлена точно (2026-08-15):** `updateTableCell`
(`src/markdown-table.cts`) брала только ПЕРВУЮ GFM-таблицу, найденную в
переданном тексте. `updateTraceabilityCell` (`src/phase.cts`) вызывает её,
передав ей весь срез `## Traceability` секции — а секция `REQUIREMENTS.md`
у legion-app открывается двумя вспомогательными таблицами-легендами
(«Тип / Критерий закрытия» и «Статус / Критерий / Что доказано») ПЕРЕД
настоящей таблицей `| Requirement | Phase | Тип | Status |`. Матчер
натыкался на первую таблицу-легенду, не находил в ней колонку `Status`,
получал `{ok:false, reason:'unknown column: Status'}` и молча пропускал
запись — даже когда искомая строка реально существовала в третьей таблице
той же секции. Воспроизведено напрямую на живом
`legion-app/.planning/REQUIREMENTS.md`.

**Фикс:** `updateTableCell` теперь сканирует таблицы в тексте
последовательно и пропускает таблицу, если в ней нет искомой колонки или ни
одна строка не подошла под `match`, вместо немедленного фейла на первой
найденной таблице. Коммит на ветке `feat/mn-verify-gate`
(`src/markdown-table.cts` + регрессионные тесты в
`tests/markdown-table.test.cjs`, тесты `markdown-table`/`phase`/`roadmap`/
`milestone`/`state` — 640+ тестов зелёные).
