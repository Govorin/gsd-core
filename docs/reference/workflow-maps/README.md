<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# Карты workflows

Логика каждого workflow из `gsd-core/workflows/` — шаги, переходы и спавны агентов — построенная из
разметки самого markdown, а не нарисованная. Перегенерация: `node scripts/gen-workflow-maps.cjs --write`
(входит в `npm run regen:derived`); `--check` (часть `npm run lint:generated-sync`) падает, когда workflow
изменён без перегенерации.

## Что на карте

- **Узел** — то, что есть в файле: блок `<step name=…>`; фрагмент `<!-- gsd:section id when -->` (скруглённый,
  с префиксом `§`); в workflow без шагов — заголовок H2 внутри `<process>`. Тёмный узел — сам workflow.
- **Сплошное ребро** — порядок документа. Подпись на ребре — условие входа: `если: …` (атрибут `condition`
  шага) или `when: …` (закрытый словарь секций). Условный узел подсвечен жёлтым: он пропускается, когда
  условие ложно.
- **Пунктир `goto`** — фраза перехода («go to», «proceed to», «skip to», «перейди к» …), называющая реальную
  единицу: имя шага, id секции или номер нумерованного раздела (`step 5.5`). Остальные фразы («the next
  step», «Route A», «step 3» в файле без нумерованных разделов) не рисуются, а **считаются** — счётчик в шапке
  каждой карты.
- **Агенты** (`[[…]]`) — аргумент `subagent_type` вызова `Agent(` в блоке кода или в inline-коде, сверенный
  с `agents/*.md` (синий), встроенными агентами рантайма (серый) и агентами капабилити из реестра (зелёный).
  `dynamic: X` — тип агента из переменной; к кандидатам ведёт пунктир, только если все присваивания
  переменной — литералы.
- **Точки цикла** (шестиугольник) — вызов `loop render-hooks <point>`; к точке подшиты шаги капабилити из
  `byLoopPoint` реестра. `ref.agent` хука капабилити разрешается через эти точки.
- Спавны и точки из файлов, которые единица читает (`gsd-core/workflows/<workflow>/steps/*.md` и т. п.),
  приписаны этой единице с подписью `через …`.

**Дефекты рисуются красным**, а не отбрасываются: неизвестный агент, переход к snake_case-имени, которого
нет среди шагов, точка вне `LOOP_HOST_CONTRACT`, ссылка на несуществующий файл, шаг без закрывающего
`</step>` (серый пунктир), вызов `Agent(` в прозе вместо блока кода, расхождение маркеров
`gsd:section` с `section-manifest.json`.

## Workflows (89)

Всего фраз перехода: 390, из них не называют реальный шаг: 175. Дефектов: 0.

| Workflow | Единицы | Спавны | Агенты | Точки цикла | Переходы без имени | Дефекты |
|---|---|---|---|---|---|---|
| [add-backlog](add-backlog.md) | 6 разделов H2 | 0 | 0 |  | 0 / 0 | 0 |
| [add-phase](add-phase.md) | 5 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [add-tests](add-tests.md) | 9 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [add-todo](add-todo.md) | 9 шагов `<step>` | 0 | 0 |  | 1 / 1 | 0 |
| [ai-integration-phase](ai-integration-phase.md) | 12 разделов H2 | 0 | 0 |  | 0 / 1 | 0 |
| [analyze-dependencies](analyze-dependencies.md) | 6 разделов H2 | 0 | 0 |  | 0 / 0 | 0 |
| [arch-survey](arch-survey.md) | 8 шагов `<step>` | 2 | 2 |  | 0 / 1 | 0 |
| [audit-fix](audit-fix.md) | 7 шагов `<step>` | 1 | 1 |  | 2 / 2 | 0 |
| [audit-milestone](audit-milestone.md) | 9 разделов H2 | 1 | 1 | `verify:post` | 0 / 0 | 0 |
| [audit-uat](audit-uat.md) | 4 шага `<step>` | 0 | 0 |  | 0 / 1 | 0 |
| [autonomous](autonomous.md) | 7 шагов `<step>`, 10 секций `gsd:section` | 0 | 0 | `execute:post`, `verify:post`, `ship:pre`, `verify:pre` | 18 / 34 | 0 |
| [check-todos](check-todos.md) | 10 шагов `<step>` | 0 | 0 |  | 5 / 6 | 0 |
| [cleanup](cleanup.md) | 9 шагов `<step>` | 0 | 0 |  | 0 / 1 | 0 |
| [code-review-fix](code-review-fix.md) | 10 шагов `<step>` | 3 | 2 | `execute:post` | 0 / 0 | 0 |
| [code-review](code-review.md) | 11 шагов `<step>`, 2 секции `gsd:section` | 4 | 3 |  | 0 / 4 | 0 |
| [complete-milestone](complete-milestone.md) | 15 шагов `<step>`, 2 секции `gsd:section` | 0 | 0 | `milestone:pre`, `milestone:post` | 3 / 6 | 0 |
| [debug](debug.md) | 8 разделов H2 | 3 | 1 |  | 3 / 3 | 0 |
| [diagnose-issues](diagnose-issues.md) | 6 шагов `<step>` | 1 | 1 |  | 3 / 3 | 0 |
| [discuss-phase-assumptions](discuss-phase-assumptions.md) | 17 шагов `<step>`, 1 секция `gsd:section` | 2 | 2 |  | 4 / 13 | 0 |
| [discuss-phase-power](discuss-phase-power.md) | 7 шагов `<step>` | 0 | 0 |  | 5 / 5 | 0 |
| [discuss-phase](discuss-phase.md) | 17 шагов `<step>` | 0 | 0 | `discuss:pre`, `discuss:post` | 3 / 11 | 0 |
| [do](do.md) | 6 шагов `<step>` | 0 | 0 |  | 2 / 3 | 0 |
| [docs-update](docs-update.md) | 16 шагов `<step>`, 1 секция `gsd:section` | 11 | 1 |  | 6 / 22 | 0 |
| [edit-phase](edit-phase.md) | 10 шагов `<step>` | 0 | 0 |  | 1 / 1 | 0 |
| [eval-review](eval-review.md) | 7 разделов H2 | 0 | 0 |  | 0 / 0 | 0 |
| [execute-phase](execute-phase.md) | 18 шагов `<step>`, 3 секции `gsd:section` | 3 | 2 | `execute:post`, `execute:pre`, `execute:wave:pre`, `execute:wave:post`, `verify:post` | 12 / 17 | 0 |
| [execute-plan](execute-plan.md) | 24 шага `<step>` | 1 | 1 |  | 3 / 3 | 0 |
| [explore](explore.md) | 6 разделов H2 | 1 | 1 |  | 3 / 3 | 0 |
| [extract-learnings](extract-learnings.md) | 8 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [fast](fast.md) | 6 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [forensics](forensics.md) | 8 разделов H2 | 0 | 0 |  | 0 / 0 | 0 |
| [graduation](graduation.md) | 10 разделов H2 | 0 | 0 |  | 0 / 1 | 0 |
| [health](health.md) | 6 шагов `<step>` | 0 | 0 |  | 0 / 1 | 0 |
| [import](import.md) | 8 шагов `<step>` | 1 | 1 |  | 0 / 0 | 0 |
| [inbox](inbox.md) | 9 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [ingest-docs](ingest-docs.md) | 10 шагов `<step>` | 2 | 2 |  | 2 / 2 | 0 |
| [insert-phase](insert-phase.md) | 5 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [list-phase-assumptions](list-phase-assumptions.md) | 5 шагов `<step>` | 0 | 0 |  | 0 / 3 | 0 |
| [list-seeds](list-seeds.md) | 3 шага `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [list-workspaces](list-workspaces.md) | 2 раздела H2 | 0 | 0 |  | 0 / 0 | 0 |
| [manager](manager.md) | 5 шагов `<step>` | 0 | 0 |  | 4 / 16 | 0 |
| [map-codebase](map-codebase.md) | 13 шагов `<step>` | 4 | 1 |  | 1 / 12 | 0 |
| [milestone-summary](milestone-summary.md) | 9 разделов H2 | 0 | 0 |  | 0 / 2 | 0 |
| [mvp-phase](mvp-phase.md) | 9 разделов H2 | 0 | 0 |  | 2 / 4 | 0 |
| [new-milestone](new-milestone.md) | 16 разделов H2, 2 секции `gsd:section` | 3 | 3 | `roadmap:post` | 2 / 4 | 0 |
| [new-project](new-project.md) | 13 разделов H2, 3 секции `gsd:section` | 15 | 3 | `roadmap:post` | 5 / 10 | 0 |
| [new-workspace](new-workspace.md) | 9 разделов H2 | 0 | 0 |  | 1 / 1 | 0 |
| [next](next.md) | 7 шагов `<step>` | 0 | 0 |  | 4 / 9 | 0 |
| [node-repair](node-repair.md) | 5 шагов `<step>` | 0 | 0 |  | 1 / 1 | 0 |
| [note](note.md) | 5 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [onboard](onboard.md) | 4 раздела H2 | 0 | 0 |  | 6 / 6 | 0 |
| [pause-work](pause-work.md) | 6 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [plan-phase](plan-phase.md) | 41 раздел H2, 6 секций `gsd:section` | 10 | 2 | `plan:pre`, `plan:post` | 9 / 45 | 0 |
| [plan-review-convergence](plan-review-convergence.md) | 6 разделов H2 | 0 | 0 |  | 3 / 4 | 0 |
| [plant-seed](plant-seed.md) | 8 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [pr-branch](pr-branch.md) | 5 шагов `<step>` | 0 | 0 |  | 1 / 3 | 0 |
| [profile-user](profile-user.md) | 11 разделов H2 | 0 | 0 |  | 4 / 16 | 0 |
| [progress](progress.md) | 8 шагов `<step>`, 3 секции `gsd:section` | 0 | 0 |  | 16 / 16 | 0 |
| [quick-batch](quick-batch.md) | 2 секции `gsd:section` | 10 | 5 | `plan:pre` | 1 / 1 | 0 |
| [quick](quick.md) | 5 секций `gsd:section` | 10 | 5 | `plan:pre`, `execute:post` | 0 / 0 | 0 |
| [reapply-patches](reapply-patches.md) | 7 разделов H2 | 0 | 0 |  | 4 / 4 | 0 |
| [remove-phase](remove-phase.md) | 7 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [remove-workspace](remove-workspace.md) | 6 разделов H2 | 0 | 0 |  | 0 / 0 | 0 |
| [resume-project](resume-project.md) | 8 шагов `<step>` | 0 | 0 |  | 6 / 8 | 0 |
| [retro](retro.md) | 9 шагов `<step>` | 2 | 2 |  | 0 / 3 | 0 |
| [review](review.md) | 6 шагов `<step>`, 2 секции `gsd:section` | 0 | 0 |  | 0 / 1 | 0 |
| [scan](scan.md) | 6 разделов H2 | 1 | 1 |  | 0 / 0 | 0 |
| [secure-phase](secure-phase.md) | 9 разделов H2 | 1 | 1 | `verify:post` | 0 / 4 | 0 |
| [session-report](session-report.md) | 4 шага `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [settings-advanced](settings-advanced.md) | 6 шагов `<step>` | 0 | 0 |  | 3 / 4 | 0 |
| [settings-integrations](settings-integrations.md) | 6 шагов `<step>` | 0 | 0 |  | 2 / 2 | 0 |
| [settings](settings.md) | 6 шагов `<step>` | 0 | 0 |  | 1 / 1 | 0 |
| [ship](ship.md) | 10 шагов `<step>` | 2 | 0 | `ship:pre`, `ship:post` | 4 / 6 | 0 |
| [sketch-wrap-up](sketch-wrap-up.md) | 12 шагов `<step>` | 0 | 0 |  | 1 / 1 | 0 |
| [sketch](sketch.md) | 12 шагов `<step>` | 0 | 0 |  | 1 / 4 | 0 |
| [smart-entry](smart-entry.md) | 6 шагов `<step>` | 0 | 0 |  | 0 / 1 | 0 |
| [spec-phase](spec-phase.md) | 10 разделов H2 | 0 | 0 |  | 2 / 10 | 0 |
| [spike-wrap-up](spike-wrap-up.md) | 14 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [spike](spike.md) | 14 шагов `<step>` | 0 | 0 |  | 2 / 5 | 0 |
| [stats](stats.md) | 3 шага `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [sync-skills](sync-skills.md) | 8 разделов H2 | 0 | 0 |  | 0 / 1 | 0 |
| [transition](transition.md) | 14 шагов `<step>`, 1 секция `gsd:section` | 0 | 0 |  | 4 / 5 | 0 |
| [ui-phase](ui-phase.md) | 13 разделов H2 | 2 | 2 |  | 3 / 10 | 0 |
| [ui-review](ui-review.md) | 7 разделов H2 | 1 | 1 |  | 0 / 0 | 0 |
| [ultraplan-phase](ultraplan-phase.md) | 6 шагов `<step>` | 0 | 0 |  | 0 / 0 | 0 |
| [undo](undo.md) | 7 шагов `<step>` | 0 | 0 |  | 1 / 2 | 0 |
| [update](update.md) | 10 шагов `<step>`, 1 секция `gsd:section` | 0 | 0 |  | 3 / 3 | 0 |
| [validate-phase](validate-phase.md) | 9 разделов H2 | 1 | 1 | `verify:post` | 0 / 1 | 0 |
| [verify-work](verify-work.md) | 17 шагов `<step>`, 2 секции `gsd:section` | 19 | 3 | `verify:pre`, `verify:post`, `execute:post` | 2 / 16 | 0 |

## Без карты

В этих workflows нет ни шагов, ни секций, ни разделов H2 внутри `<process>`, ни спавнов — рисовать нечего:

- `help`
- `thread`
