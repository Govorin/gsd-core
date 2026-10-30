# Синхронизация с upstream 1.19 — решения по конфликтам (2026-10-30)

Worktree `/Users/govorin/forks/gsd-core-wt-sync-1.19`, ветка `sync/upstream-1.19` от `next` (`5721c403b`;
страховочный тег `pre-sync-1.19`). `git merge upstream/next` (`7d68e2b72`, 34 коммита, предок `fa377ad5d`),
19 конфликтных файлов. Правило то же, что в 1.18: смысл правки форка сохраняется, то, что upstream
сделал лучше или заменил, берётся от upstream. Источник смысла форка — `git log --merge -p -- <file>`
и `.plans/mn-fork-worklog.md`.

## Исходный код

### `src/phase-id.cts` (экспорт)
- Форк (`60df172ff`): `phaseDepRefs(prose)` — один читатель ссылок на фазы в depends-on прозе
  (регистронезависимый, `Phase 1a` → `1a`), его читают init.manager, planning-inspect и roadmap graph.
- Upstream (#5528, `57942161d`): `tokenizePhaseDependencyReferences` / `extractPhaseDependencyTokens(prose, convention)` —
  читатель с учётом bracket-конвенции (`[CK.02] 01`); для не-bracket — регистрозависимый токен.
- Решение: экспортировать все три. `phaseDepRefs` остаётся владельцем регистронезависимого цикла
  (init.manager вне bracket и roadmap graph), докблок переписан: bracket-aware и регистрозависимое
  извлечение — `extractPhaseDependencyTokens`.

### `src/init.cts` (manager `dep_phases`)
- Форк: цикл по `phaseDepRefs(prose)`.
- Upstream: под bracket — `extractPhaseDependencyTokens`, иначе локальная копия `legacyManagerDependencyTokens`
  (тот же регистронезависимый цикл), плюс сравнение по bracket-идентичности.
- Решение: ветвление и сравнение по идентичности от upstream; не-bracket ветка вызывает `phaseDepRefs`
  вместо локальной копии (тот же regex `gi`, порядок тот же; дедупликация по точному написанию ничего не
  меняет, ниже всё равно дедуп по нормализованному номеру). Импорт `PHASE_DEP_REF_SOURCE` больше не нужен.
  Так не появляется вторая копия цикла (смысл `60df172ff`), а поведение upstream сохранено.

### `src/planning-inspect.cts` (`dependencies`)
- Форк: `phaseDepRefs` (регистронезависимо: `Phase 1a` → `1a`).
- Upstream: `extractPhaseDependencyTokens(m[1], phaseIdConvention)`; в комментарии init.cts upstream прямо
  говорит, что прогон planning-inspect через расширенный хелпер менял байты `Phase 1a` с `1` на `1a`.
- Решение: сторона upstream целиком (файл теперь совпадает с upstream). Это возвращает upstream-байты
  planning-inspect и добавляет bracket-конвенцию.

### `src/phase.cts` (экспорт)
- Форк: экспорт `resolveDependencyId` (для `check mn-wave-solve`, `90d4d6aff`).
- Upstream: тестовые швы `_computeBracketRenumberMapping`, `_replaceQualifiedBracketReference` (#4304).
- Решение: объединение.

### `src/roadmap.cts`
- Импорт: upstream убрал `replaceInCurrentMilestone` и добавил `checklistBulletExtent`, `phaseChecklistBullet`,
  `withPhaseSection`, константу `ANY_PHASE_ENTRY_LINE`; форк добавил `milestoneSections`. Решение: строка upstream
  + `milestoneSections` (`replaceInCurrentMilestone` в файле больше нигде не используется).
- Результат analyze: форк вынес тело `cmdRoadmapAnalyze` в `analyzeRoadmap` с типом `RoadmapAnalysis`
  (`de4c09bf2`, общий сбор фаз для analyze и graph); upstream (#5221) добавил `roadmap_record` (ворота
  полноты для ship). Решение: блок upstream целиком, `const result: RoadmapAnalysis`, в тип добавлено
  `roadmap_record: Record<string, boolean> | null`.
- Сборка (без конфликта, но не собиралось): upstream (#5186) добавил `collectAnalyzePhases` параметры `cwd` и
  `directoryContext`. Форковый `analyzeMilestoneSections` теперь строит `directoryContext` так же, как
  `analyzeRoadmap` (`phaseDirectoryOptions(cwd, undefined, rawContent)`), и передаёт оба.

### `src/roadmap-graph.cts` (без конфликта, но не собиралось)
- Форк читал Progress-таблицу через `roadmapParser.findRoadmapProgressTable` — upstream удалил его
  (#5761 «один владелец Progress-таблицы»).
- Решение: `locateRoadmapProgress(roadmapText).table` из `roadmap-progress.cts`. Поведение по умолчанию
  (`sectionMiss: 'none'`) совпадает со старым: таблица ищется только в секции Progress, а без секции во всём
  документе. Отличие: заголовок теперь «начинается со слова Progress» (`Progress Tracker`) — правило upstream.

### `src/shell-command-projection.cts` (`execGit`)
- Форк: `GIT_STABLE_LOCALE_ENV` (`LC_ALL=C.UTF-8`, `3ca0290b3`) и опция `maxBuffer` (`d4ff22b83`).
- Upstream (#5548): реэкспорт `GIT_LOCATION_ENV_VARS`, `scrubGitLocationEnv` из `read-only-git-env.cjs`
  (по умолчанию база `readOnlyGitEnv()` уже вычищена от `GIT_DIR` и т.п.).
- Решение: объединение — реэкспорт upstream перед блоком форка, тело `execGit` форка (локаль + maxBuffer).

## Отгружаемый markdown и доки

### `agents/gsd-executor.md`
- Форк (`2f9e3d3a1`, writing-for-agents пилот): вызов `roadmap.update-plan-progress` в блоке requirements,
  комментарий ужат до `# Mark completed requirements (see Requirement IDs below)`.
- Upstream (#5221): запись ROADMAP перенесена ВЫШЕ записей STATE (с остановкой на `missing_phase_details`),
  в этом блоке осталось только requirements, комментарий в две строки.
- Решение: вызов ROADMAP здесь убран (upstream его перенёс, он уже есть выше); комментарий форка (короче, смысл тот же).

### `docs/how-to/acknowledge-emitted-drift.md`
- Форк (`73292af83`): строка про отзыв (withdraw) в таблице «When it still fails».
- Upstream (#5734): строка про двойное объявление дополнена — коммит слияния release → main не читается.
- Решение: строка форка про отзыв + строка upstream.

### `docs/INVENTORY.md`
- Объединение строк таблицы CLI-модулей: форковые `api-coverage-command-router`, `arch-*`, `mn-*`,
  `mutation-restore-journal` и upstream-овые `args-terminator`, `milestone-release-map` (по алфавиту).

## Тесты

### `tests/cli-exit.test.cjs`
- Форк: `reasonCount === 31` (27 + 4 форковых кода).
- Upstream: `reasonCount === 30` (27 + три кода #5186) и `deepEqual` по полному списку ключей.
- Решение: 34; комментарии обеих сторон; в список ключей добавлены `DIAGRAMS_SOURCE_UNAVAILABLE`,
  `WINDOW_REVIEW_UNRESOLVABLE`, `ARCH_INPUT_UNAVAILABLE`, `RETRO_LESSONS_INVALID`.

### `tests/io.test.cjs`
- Форк убрал число из заголовка describe («exhaustive over the enum»); upstream поменял число на 30.
- Решение: формулировка форка без числа (число каждый раз ломается; таблица и так сверяется с enum).

### `tests/no-bare-gsd-tools-command-position.test.cjs`
- Upstream сдвинул запись `agents/gsd-executor.md:836` (envelope `gsd-tools query commit`).
- У форка этой записи нет: абзац про envelope переписан без голого `gsd-tools query commit` (как и в 1.18).
- Решение: сторона форка (записи нет).

### `tests/helpers/emitted-runtime.cjs` (`readAckTrailers`)
- Форк (`73292af83`): трейлеры читаются по коммитам в порядке истории (`--reverse --topo-order`) со всеми
  именами `ACK_TRAILER_NAMES` (ack + withdraw), записи `%(trailers)` и `%B` спариваются по индексу
  (проверка равенства числа записей), результат в `parseAckTrailerSequence(commits)`.
- Upstream (#5734): `%s` ведёт каждую запись; коммит слияния release → main (`isReleaseMergeSubject`) не читается
  ни в проходе трейлеров, ни в проходе тел (там через `subjectOfBody`).
- Решение: формат форка с ведущим `%s`; каждый коммит сохраняет слот (`releaseMerge`, `acks`), чтобы спаривание
  по индексу осталось верным; в проходе тел коммит пропускается по флагу из `%s` (запись i — тот же коммит);
  в `parseAckTrailerSequence` идут только не-release коммиты. `subjectOfBody` стал не нужен и удалён
  (нигде больше не использовался).

## Производные (не руками)

`docs/CONTEXT-INDEX.json`, `docs/INVENTORY-MANIFEST.json`, `examples/dynamic-context-management/CONTEXT-INDEX.json`,
`tests/fixtures/compact-content-benchmark-baseline.json`, `pi/package-agents/{gsd-executor.md,manifest.json}`:
сторона upstream, затем `npm run build:lib`, `npm run regen:derived`, `node scripts/gen-capability-registry.cjs --write`
(после смены версий capability), `node scripts/benchmark-compact-content.cjs --write` (его нет в `regen:derived`).
`npm run lint:generated-sync` — чисто.

## После слияния

### `hooks/gsd-exit-gate.js`, `hooks/gsd-worktree-provision.js` (коммит `fix(sync): scrub inherited git location env…`)
- Upstream #5548 убрал унаследованные `GIT_DIR`/`GIT_WORK_TREE`/… из всех git-вызовов в `src/` и `hooks/`
  (тесты `tests/git-location-env-scrub.test.cjs` перечисляют только upstream-хуки). Два форковых хука остались вне:
  exit gate вызывал `rev-parse --show-toplevel` с унаследованным env; worktree-provision передавал `process.env`
  явно и тем обходил вычищенную базу `readOnlyGitEnv()`.
- Решение: оба через `gitEnv()` из `hooks/lib/git-probe.js` (копия скраба для хуков, сверяется с `src` тестом
  upstream). Тесты в `tests/mn-enforcement-hooks.test.cjs` и `tests/mn-worktree-provision.test.cjs`; без правки оба падают.

### Потребители форка (asgard, только чтение; установленный `~/.claude/gsd-core` против слитого дерева)
`roadmap get-phase 1|1.1`, `progress json`, `phase-plan-index 1`, `find-phase 1|1.1`, `planning inspect`, `retro due`,
`smart-entry --json`, `state-snapshot`, `list-todos`: ключи и значения совпадают байт в байт. `roadmap analyze`:
добавлен только `roadmap_record` (#5221), ничего не удалено и не сменило тип. `roadmap graph` (обе формы) — тот же
вывод. `.planning/` в asgard не изменился (хеш до и после).

### Исправления после полного прогона и ревью
- `a454972f4` `plan-phase.md` 98 658 B > XL 98 304 (и две линии PRE_PHASE6 < 98 300): у форка было 8 B запаса,
  upstream #5528 добавил 362 B в 13c. Текст upstream не тронут; два форковых пункта чтения (LEARNINGS-DIGEST,
  CROSS-DOMAIN) вынесены в `gsd-core/references/planner-lessons.md` (одна ссылка), шаг 11 ведёт в 11b, 11b одной
  фразой (фразы, которые пинит `mn-finding-refuter`, и переход 11b → 12 в карте сохранены). 98 270 B.
- `c0b6903e2` тест #5325 (MCP config-path) на macOS сравнивал `/var` с `/private/var` (CLI читает cwd через
  `process.cwd()`, MCP передаёт cwd как есть); upstream гоняет файл только на Linux/Windows. Сравнение через realpath.
- `34a56362b` (ревью MINOR-1) команда гейта и `worktree_install_command` — тоже `env: gitEnv()`; по тесту на каждую.
- `8e4726f51` (MINOR-2) `roadmap graph` под bracket читает `extractPhaseDependencyTokens`; квалифицированная ссылка
  удовлетворяется только фазой своей вехи (`[GSD.01] 05` — missing, а не `05` текущей вехи); каталоги bracket несут веху.
- `24464d796` (MINOR-3) перенос строк комментария в `init.cts`, формулировка upstream в `tests/io.test.cjs`.
- `9e25a6a69` (п. 4) раздел о синхронизации 1.19 в `.plans/mn-fork-worklog.md`.
