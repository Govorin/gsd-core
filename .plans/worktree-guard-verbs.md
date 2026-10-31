# План: проверки worktree в GSD Core под проверку изоляции Claude Code ≥ 2.1.310 (проект 2026-10-30)

Источник доказательств: `.plans/worktree-isolation-verifier.md`.

## Выбор: (b) охранные проверки — глаголы CLI + (e) литерал запуска подставляет оркестратор при отправке

Две разные проблемы:
1. **Как запустить инструмент.** Нужен литеральный путь без переменных. Надёжно его знает только оркестратор: он уже запустил `gsd-tools` через загрузчик с проверкой подлинности. `init` отдаёт `gsd_tools_cmd`, оркестратор подставляет `{GSD_TOOLS_CMD}` в промпт субагента (тем же механизмом, что `{EXPECTED_BASE}`, `{PINNED_ROOT}`).
2. **Как выполнить проверку.** Логика — в типизированном глаголе (ADR-3473: у инварианта один владелец). git вызывается из node.

Отвергнуто:
- (a) литеральный путь от установщика: ломает переносимый `$HOME` и `--local` (#4377, upstream #5637), двигает 150 копий загрузчика, `$(git …)` в охранных блоках остаётся;
- (c) скрипты по литеральному пути: проходят только потому, что Claude Code не читает их содержимое;
- (d) голый `gsd_run` через PATH: export из #5465 есть лишь в 5 из 122 сессий, нет Windows-shim, теряется проверка подлинности.

## Что нашлось помимо брифа

- `hooks/gsd-path-export.js` (#5465) почти не срабатывает: в `~/.claude/session-env/` export PATH есть в 5 из 122 каталогов.
- Глобальная установка Claude пишет `$HOME/.claude/` (`computePathPrefix`, `src/runtime-artifact-conversion.cts:3298`). Локальная — относительный путь, `${VAR:-default}` маскируются (#4377, `bin/install.js:~8130`).
- Отказывают и другие блоки исполнителя (`agents/gsd-executor.md:370-470`):
  - шаг «0. Pre-commit HEAD safety»: `$(git symbolic-ref…)`, `$(gsd_run query git.base-branch …)`;
  - ledger #3968: `"$(git rev-parse --git-dir)/gsd-plan-head-before-…"`;
  - `IS_BEHAVIOR_ADDING=$(gsd_run query task.is-behavior-adding …)`.
- `quick-batch` запускает исполнителей в `harness-worktree`, но `worktree_branch_check` не встраивает (`gsd-core/workflows/quick-batch/steps/worktree-dispatch.md`). Дыра уже сейчас.
- Cursor тоже `harness-worktree`; Codex и остальные — `orchestrator-worktree`/`none`. Решение одно на все рантаймы.
- Номер ADR: 5211.

## Инвентарь

- **Загрузчик `gsd_run`.**
  - 150 строк в 146 файлах: workflows 123, agents 18, commands 3, references 2.
  - Два варианта текста: 2573 Б и 883 Б.
  - Ещё 13 мест подключают `@…/gsd-run-resolver.md`.
  - Источник — `gsd-core/workflows/_runtime-launcher.snippet.sh`, его разносит `scripts/sync-runtime-launcher.cjs` (`npm run sync:launcher`), сверку держит `tests/runtime-launcher-parity.test.cjs`.
  - Запись в `CLAUDE_ENV_FILE` в загрузчике — мёртвый код (≈170 Б × 150). Отдельная задача.
- **Охранные блоки.**
  - `references/worktree-branch-check.md` (≈1,25 КБ bash, выход 42);
  - `references/worktree-path-safety.md`: 0p — 3272 Б, 0a — 762, 0b — 297, 0c — 15845;
  - `agents/gsd-executor.md`: inline 0a, 0b, 0, ledger (≈3 КБ);
  - места встраивания: `execute-phase/steps/executor-isolation-dispatch.md`, `steps/sequential-root-pin.md`, `execute-plan.md`, `quick.md`, `diagnose-issues.md`.
- **Бюджеты.**

  | Файл | Размер | Предел | Запас |
  |---|---|---|---|
  | `plan-phase.md` | 98 296 | 98 304 | 8 Б (не трогать) |
  | `execute-phase.md` | 93 200 | 98 304 | ≈5,1 КБ |
  | `quick.md` | 44 474 | LARGE | ≈17 КБ |
  | `gsd-executor.md` | 42 158 | 49 152 | ≈7 КБ |
  | `gsd-debugger.md` | 46 964 | 49 152 | ≈2,2 КБ |

## Волны (каждая оставляет `next` зелёным)

### Волна 0 — пробы, без кода

Пробный агент с `isolation: "worktree"`:

| Проба | Что проверяет |
|---|---|
| P1 | литеральный путь к установленному gsd-tools |
| P2 | скрипт в общем checkout — аналог `--local` |
| P3 | путь в кавычках |
| P4 | git внутри node |
| P5 | `\|\| exit 42` |
| P6 | `$( )` вокруг node |
| P7 | аргумент указывает в общий checkout |
| P8 | голый `gsd_run` |
| P9 | heredoc на stdin |

Что решают пробы:
- P2 — `--local`: если отказ, берём копию внутри worktree по относительному литералу `node .claude/gsd-core/bin/gsd-tools.cjs`, а если её нет — стоп с понятной причиной.
- P7 — форму стадии `abs-path`.
- P6 — можно ли захватывать вывод.

Результаты дописать в `.plans/worktree-isolation-verifier.md`.

**Результаты волны 0 (2026-10-30, Claude Code 2.1.314, агент с `isolation: "worktree"`):**

| Проба | Итог | Вывод для плана |
|---|---|---|
| P1 | проходит | литеральный путь к установленному `gsd-tools` работает |
| P2 | проходит | скрипт в общем checkout разрешён: для `--local` годится тот же литеральный абсолютный путь, запасная ветка не нужна |
| P3 | проходит | путь в одинарных кавычках разрешён |
| P4 | проходит | git внутри node не проверяется |
| P5 | проходит | `\|\| exit 42` можно |
| P6 | проходит | вывод node можно захватывать в `$( )`: проверка смотрит только на git, sed и вычисляемые аргументы |
| P7 | проходит | аргумент в общий checkout разрешён: стадия `abs-path` нужна сама, на отказ Claude Code рассчитывать нельзя |
| P8 | ERROR 127 | `gsd_run` в оболочке субагента нет |
| P9 | проходит | heredoc на stdin node разрешён |

Перенести эту таблицу в `.plans/worktree-isolation-verifier.md`.

### Волна 1 — модули и глаголы, без правки отгружаемого markdown (после синхронизации 1.19: upstream #5548 чистит `GIT_DIR`/`GIT_WORK_TREE` в execGit)

**`src/worktree-guard.cts`.** Чистые функции решений; git через внедряемый runner поверх `execGit`. Результат: `{ ok, stage, code, detail }`.

| Стадия | Что проверяет | Коды | Выход |
|---|---|---|---|
| `branch` | `--expected-base`, `--alternate-base` | `head_detached`, `protected_branch`, `namespace_mismatch`, `base_mismatch`, `git_unavailable` | 42 |
| `pre-commit` | шаг 0; `--sequential`; защищённая ветка в процессе; при нечитаемом конфиге — запасной список из пяти имён | — | 1 |
| `sentinel` | 0a; sentinel `git-dir/gsd-spawn-toplevel` | `cwd_drift`; вне linked worktree `applies:false` | 1 |
| `abs-path` | 0b; `--path` повторяемый; `tryWithinRoot` (ADR-4650) вместо сравнения префикса строки | `outside_worktree`, `root_unresolved` | 1 |
| `automated` | 0c; `--plan <PLAN.md> --task <id>`, глагол сам читает `<automated>` | — | 1 |
| `pin` | 0p, `--root` | `root_mismatch`, `root_unresolved` | 1 |

Сравнение путей — через `toComparablePathKey` (на win32 без учёта регистра).

**`src/automated-command-containment.cts`.** Перенос грамматики 0c (`_OPEN`, `_LAUNCH`, `_EXEC`, `_DIR`, `_norm`, `_unquote`). Список «чего guard не видит» — в doc-комментарий модуля.

**Ещё:**
- `worktree plan-ledger --phase X --plan Y` (#3968);
- маршрут `guard` и `plan-ledger` в `routeWorktree` (`gsd-core/bin/gsd-tools.cjs:~4955`);
- CONTEXT.md (Worktree Lifecycle Module);
- `npm run regen:derived`.

**Тесты:**
- позитив и негатив на каждый код;
- границы: путь равен корню, корень плюс `/`, соседний `/root-x`, завершающий слэш, первый и второй вызов sentinel, regex пространства имён на краях (`agent-`, `worktree-wf_`, `release/x`);
- сломанный git → отказ (ADR-3409);
- неизвестная стадия или нет обязательного флага → ненулевой выход;
- **дифференциальный тест:** корпус 0c и 0p (`tests/executor-mvp-tdd-section.test.cjs:569-900`, `tests/worktree.test.cjs`) через старый bash и через глагол, вердикты совпадают;
- вызовы через `runGsdTools` и process-seam.

### Волна 2 — литерал запуска

**`src/gsd-tools-invocation.cts`** (новый модуль, чтобы не пересечься с изменениями 1.19 в `shell-command-projection.cts`):
- `gsd_tools_path` = realpath `__filename` запущенного `gsd-tools.cjs`;
- `gsd_tools_cmd` = `node '<path>'`, кавычки через существующие хелперы; на win32 путь вида `C:/…`;
- `--local` — по результату P2.

**`src/init.cts`:** одна строка-spread в выводах `init.execute-phase`, `init.quick`, `init.quick-batch`, `init.execute-plan` и в init для diagnose.

**Тесты:** путь с пробелом, симлинк установки, Windows-проекция, локальная установка, совпадение `runtime-identity` у полученного пути.

### Волна 3 — отгружаемый текст (один коммит с тестами)

- **`worktree-branch-check.md`** → `{GSD_TOOLS_CMD} worktree guard branch --expected-base {EXPECTED_BASE} --alternate-base '{EXPECTED_BASE_ALTERNATE}'`; любой ненулевой выход = HALT, exit 42, без самовосстановления.
- **`worktree-path-safety.md`:** 0a, 0b, 0c, 0p → вызовы глагола; текст о границах 0c короче.
- **`gsd-executor.md`:** 0a, 0b, 0, ledger → вызовы. Правило `<gsd_tools_launcher>`: в изолированной отправке GSD-инструменты — только `{GSD_TOOLS_CMD} <args>` с литеральными аргументами, строку загрузчика не выполнять.
- **Места отправки** (`executor-isolation-dispatch.md`, `sequential-root-pin.md`, `execute-plan.md`, `quick.md`, `diagnose-issues.md`): взять `gsd_tools_cmd` из JSON `init`, подставить `{GSD_TOOLS_CMD}`.
- **`quick-batch/steps/worktree-dispatch.md`:** встроить branch-check (закрыть дыру).
- **`src/isolation-shell-form.cts`:** `classifyIsolationShellForm(cmd) → {ok, violations[]}` — консервативная модель таблицы проб, линт нашего текста. Тест `tests/worktree-dispatch-shell-forms.test.cjs` прогоняет каждый обязательный блок после подстановки: нет `$(`, обратных кавычек, `$VAR` в аргументах git/node/sed, `cd … &&`, `-C`.
- **Тесты, извлекающие bash** (`worktree.test.cjs`, `executor-mvp-tdd-section.test.cjs`, `executor-isolation-prompt-contract.test.cjs`, `worktree-safety.test.cjs:6392`): перевести на «блок вызывает глагол с плейсхолдерами + запуск после подстановки на настоящем linked worktree».
- **`tests/no-bare-gsd-tools-command-position.test.cjs`:** пересчитать номер строки в `PROSE_ALLOWLIST` для `agents/gsd-executor.md`.
- **Байты:**
  - исходники: около −20 КБ в path-safety, −2,5 КБ в executor, −1 КБ в branch-check, +1,5 КБ в местах отправки;
  - конвертер не меняется, поэтому trailer-ы не нужны; проверка — `GSD_EMITTED_BASE=upstream/next node --test tests/emitted-attribution.test.cjs`;
  - затем `regen:derived`, `lint:generated-sync`.
- **`plan-phase.md` не трогать.**
- `npm run sync:launcher` должен быть идемпотентным и не съедать `{GSD_TOOLS_CMD}` (суффикс `_CMD` выбран специально: regex снимает строки `GSD_TOOLS=`).

### Волна 4 — уборка и живая проверка

- Удалить bash-сторону дифференциальных тестов.
- Обновить `docs/ARCHITECTURE.md`, CONTEXT.md, INVENTORY, добавить changeset.
- Скилл `worktree-hook-rules`: «используй `{GSD_TOOLS_CMD}` из промпта».

**Живая проба после `node bin/install.js --claude --global`.** Агент с `isolation: "worktree"`:
1. `git rev-parse HEAD`;
2. `node /Users/govorin/.claude/gsd-core/bin/gsd-tools.cjs worktree guard branch --expected-base <SHA> --alternate-base ''` → ok;
3. то же с нулевым SHA → выход 42, `base_mismatch`;
4. `sentinel` два раза подряд;
5. `pin --root /Users/govorin/forks/gsd-core` → `root_mismatch`;
6. `abs-path --path README.md`;
7. `automated --plan <файл> --task 1`;
8. `plan-ledger`.

Затем сквозной прогон: `/gsd-quick "append a line to README"` в отдельном git-проекте с `.planning/`. В транскриптах субагентов не должно быть «isolated in the worktree» и «too complex to verify».

## Черновик ADR-5211 (по-английски, как соседние)

Title: «Worktree guards are CLI verbs, launched by a literal invocation the orchestrator substitutes at dispatch».

- **Status:** Proposed, fork-local (mn fork, 2026-10-30). Принят 2026-10-31: `docs/adr/5211-worktree-guard-verbs.md`.
- **Builds on:** ADR-3473, 3409, 4630, 4650, 457.

**Context.** Claude Code ≥ 2.1.310 refuses unverifiable Bash in `isolation: "worktree"` agents. GSD's mandatory blocks are written in exactly the refused forms: resolver, `worktree_branch_check`, 0a, 0b, 0c (15.8 KB bash), 0p, pre-commit HEAD, ledger. A refused guard gets improvised or skipped; a skipped branch check is the failure it exists to prevent (#2924, #48). Three non-fixes:
- an installer literal path (portable `$HOME`, committed local installs #4377/#5637; leaves `$(git …)`);
- PATH export (#5465 reached 5 of 122 sessions; loses the identity proof);
- scripts by literal path (pass only because the body is unread).

**Decision.**
1. Guards are verbs with typed results, exit codes unchanged (branch 42, others 1); any fault is a refusal (ADR-3409).
2. `init` exposes `gsd_tools_cmd` (realpath of the running tool, platform-quoted); the orchestrator substitutes `{GSD_TOOLS_CMD}` at build time.
3. In isolated dispatch, GSD tools take literal arguments only; the resolver line is not run.
4. One form for every runtime; no converter change.
5. Our own mandatory blocks are linted against the probe table (`isolation-shell-form`).

**Consequences.**
- Guards are testable on JSON; differential run against the old bash before deletion.
- About −20 KB in path-safety; `plan-phase.md` untouched.
- Prompt depends on `init` exposing `gsd_tools_cmd`; skew needs a reinstall mid-run, and a missing verb is HALT.
- Main-session workflows keep the resolver.
- Defence in depth stays: Claude Code's check, `gsd-worktree-path-guard`, the verbs.
- `--local` depends on P2.

**Alternatives rejected.** Installer literal path; shell scripts by literal path; bare `gsd_run` via PATH; table of refused forms in the executor prompt.

## Отклонения (реализация 2026-10-31)

1. **Движок 0c — vendored RE2 в режиме leftmost-longest, а не перевод на RegExp.** Выражения
   bash-охраны — POSIX ERE, а grep выбирает самое длинное совпадение из самых левых; RegExp в
   JavaScript берёт первое подошедшее. Перевод на RegExp молча менял бы извлекаемый текст (сама
   охрана опирается на «`_EXEC` длиннее `_DIR`»). Выражения перенесены дословно и считаются через
   уже вендоренный `vendor/re2js.cjs` с флагом `LONGEST_MATCH` (`src/posix-ere.cts` — только
   рамка grep: построчно, пустые совпадения не печатаются). Первый вариант со своим NFA-движком
   выброшен: re2js уже в репозитории и линейный.
2. **Дифференциальный тест — по замороженным снимкам bash** (`tests/fixtures/legacy-worktree-guards/`),
   а не по живому тексту справочников: в волне 3 текст меняется, а сравнение должно пережить
   волну 3. В волне 1 тест проверял, что снимки байт-в-байт равны отгружаемым блокам; в волне 3
   эта проверка снята. Тест — `*.slow.test.cjs` (≈55 с). Плюс 300 детерминированных
   сгенерированных команд для 0c: 615 строк, вердикты совпали, кроме трёх записанных усилений:
   - пустой корень (git не ответил): bash считал «всё внутри» и пропускал, глагол отказывает;
   - пустой sentinel: bash проходил навсегда, глагол — `sentinel_corrupt`;
   - `abs-path`: bash сравнивал префикс строки и пропускал `../main` и симлинк в main,
     глагол разрешает путь через `tryWithinRoot` и отказывает.
3. **Коды стадий шире таблицы плана.** Добавлены `git_unavailable`/`root_unresolved` для всех стадий,
   `expected_base_invalid` (неподставленный `{EXPECTED_BASE}`), `sentinel_corrupt`, `pin_unbound`,
   `pin_not_absolute`, `pin_unresolved`, коды `automated` (`relocates_outside_worktree`,
   `names_main_checkout`, `task_not_found`, `plan_unreadable`, `plan_outside_project`,
   `command_too_large`, `command_invalid`), `ledger_corrupt`. Без них «ошибка глагола» и «отказ
   проверки» сливались бы в один код.
4. **`--command` у `automated`.** Основной путь — `--plan --task` (глагол сам читает `<automated>`
   через `verify-command-grounding.extractAutomatedCommandsByTask`, единственного владельца
   разбора). `--command` нужен тестам и инструментам; исполнителю его не предлагают. План читается
   и из worktree, и из основного checkout: `init` якорит `phase_dir` на корне оркестратора (#2376).
   Лимит команды — 64 Ki символов, проверен на границах.
5. **Новый глагол `worktree materialize`.** В плане его не было. Изолированный путь `quick.md`
   обязан выполнить блок `git show "${QUICK_PLAN_COMMIT}:${QUICK_PLAN_PATH}" > …` — это переменные в
   аргументах git, Claude Code его отклоняет. К тому же `QUICK_DIR` абсолютный (#2376), так что
   старый блок фактически ничего не делал. Глагол пишет файл через `git restore --source`
   (байт-в-байт, индекс не трогает), абсолютный путь в основном checkout переносит в worktree,
   отказ — выход 42, как прежде.
6. **`worktree tools-cmd [--raw]`.** У `diagnose-issues` нет `init`; литерал запуска он берёт этим
   глаголом. `init` для diagnose не заводился.
7. **`src/isolation-shell-form.cts` → `tests/helpers/isolation-shell-form.cjs`.** Классификатор
   нужен только тестам; в `src/` он попал бы в каждую установку без единого потребителя.
   Положительный контроль — замороженный bash: модель отклоняет каждый старый блок.
8. **Путь `orchestrator-worktree` (`executor-isolation-dispatch.md`) не тронут.** Там исполнитель —
   отдельный процесс без проверки изоляции хоста, а промпт — строка в одинарных кавычках, куда
   `node '<путь>'` вставить нельзя. Без блока `<gsd_tools_launcher>` исполнитель читает
   `{GSD_TOOLS_CMD}` как `gsd_run` — это и есть запасная ветка правила.
9. **Шаг 0 исполнителя — флаг `--sequential` вместо литерала `SEQUENTIAL=true`.** Тексты
   `execute-phase.md`, `quick.md`, `execute-plan.md` говорят «pass `--sequential`». «Связанный
   worktree» глагол определяет по `.git`-файлу в корне toplevel, а не в cwd: bash из подкаталога
   worktree пропускал проверку пространства имён.
10. **Мелкие формы исполнителя переписаны попутно:** `worktree_metadata_capture` (три простых
    `git rev-parse`), чтение ledger при SUMMARY (тот же `plan-ledger`), хэш задачи
    (`git rev-parse --short HEAD` отдельным вызовом), строка `IS_BEHAVIOR_ADDING`. Строка
    `PROJECT_ROOT=$(git rev-parse --show-toplevel …)` в `<required_reading>` `execute-phase.md`
    оставлена как есть: на неё опирается подстановка последовательного режима, а запаса под
    пояснение нет (см. п. 13).
11. **`quick-batch`** получает `EXPECTED_BASE=$(git rev-parse HEAD)` на каждый элемент и пустой
    `{EXPECTED_BASE_ALTERNATE}`: план там не коммитится перед отправкой отдельным коммитом, как в
    `quick.md`.
12. **Скилл `worktree-hook-rules`** лежит вне репозитория (`~/.claude/skills/`); строка про
    загрузчик обновлена там, в коммиты не входит.
13. **Бюджет `execute-phase.md` — не 5 КБ, а 77 Б.** Кроме предела яруса (98 304 Б) действует
    замороженный потолок ADR-857 Phase 6: меньше 93 600 Б (`tests/claude-orchestration.test.cjs`).
    До работы файл был 93 523 Б. Поэтому заметка о встраивании `<worktree_branch_check>` сжата до
    ссылки на контракт фрагмента, правило подстановки `{GSD_TOOLS_CMD}` сказано один раз (в списке
    полей `init`), а последовательный промпт блока `<gsd_tools_launcher>` не получает: исполнитель
    без блока читает `{GSD_TOOLS_CMD}` как `gsd_run`, а вне изоляции загрузчик работает. Итог
    93 586 Б, запас 14 Б.
14. **Попутно, отдельным коммитом:** `planner-lessons.md` писал `/gsd-plan-phase`; тест
    пространства имён (#3443) был красным на `next` с a454972f4. Исправлено.
15. **`npm run sync:launcher` неидемпотентен на `next`** — переписывает `retro.md` (удаляет строку
    загрузчика). Это было до этой работы и не тронуто; `{GSD_TOOLS_CMD}` синхронизация не трогает.
