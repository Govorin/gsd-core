<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# cleanup

Источник: `gsd-core/workflows/cleanup.md`. Единицы: 9 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["cleanup.md"]):::root
  u_step_identify_completed_milestones["identify_completed_milestones"]
  u_step_determine_phase_membership["determine_phase_membership"]
  u_step_identify_quick_tasks["identify_quick_tasks"]
  u_step_show_dry_run["show_dry_run"]
  u_step_archive_phases["archive_phases"]
  u_step_archive_quick_tasks["archive_quick_tasks"]
  u_step_prune_local_branches["prune_local_branches"]
  u_step_commit["commit"]
  u_step_report["report"]
  wf_root --> u_step_identify_completed_milestones
  u_step_identify_completed_milestones --> u_step_determine_phase_membership
  u_step_determine_phase_membership --> u_step_identify_quick_tasks
  u_step_identify_quick_tasks --> u_step_show_dry_run
  u_step_show_dry_run --> u_step_archive_phases
  u_step_archive_phases --> u_step_archive_quick_tasks
  u_step_archive_quick_tasks --> u_step_prune_local_branches
  u_step_prune_local_branches --> u_step_commit
  u_step_commit --> u_step_report
  u_step_show_dry_run -.->|"goto"| u_step_archive_phases
  classDef missing fill:#fdecea,stroke:#d33,stroke-dasharray:4 3
  classDef unparsed fill:#f5f5f5,stroke:#999999,stroke-dasharray:4 3,color:#555
  classDef conditional fill:#fff8e1,stroke:#b28704
  classDef root fill:#263238,color:#ffffff,stroke:#263238
  classDef agent fill:#e8f0fe,stroke:#3367d6
  classDef builtin fill:#eeeeee,stroke:#777777
  classDef capability fill:#e6f4ea,stroke:#2e7d32
  classDef dynamic fill:#f2f2f2,stroke:#888,stroke-dasharray:2 2
  classDef point fill:#f3e8fd,stroke:#8e24aa
  classDef workflow fill:#ffffff,stroke:#555555
```

## Единицы

| # | Единица | Вид | Условие | Спавны | Точки цикла | Читает |
|---|---|---|---|---|---|---|
| 1 | `identify_completed_milestones` | step |  |  |  |  |
| 2 | `determine_phase_membership` | step |  |  |  |  |
| 3 | `identify_quick_tasks` | step |  |  |  |  |
| 4 | `show_dry_run` | step |  |  |  |  |
| 5 | `archive_phases` | step |  |  |  |  |
| 6 | `archive_quick_tasks` | step |  |  |  |  |
| 7 | `prune_local_branches` | step |  |  |  |  |
| 8 | `commit` | step |  |  |  |  |
| 9 | `report` | step |  |  |  |  |

## Дефекты

Дефектов нет.
