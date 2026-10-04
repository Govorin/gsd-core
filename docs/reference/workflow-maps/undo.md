<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# undo

Источник: `gsd-core/workflows/undo.md`. Единицы: 7 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 2; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["undo.md"]):::root
  u_step_banner["banner"]
  u_step_parse_arguments["parse_arguments"]
  u_step_gather_commits["gather_commits"]
  u_step_dependency_check["dependency_check"]
  u_step_confirm_revert["confirm_revert"]
  u_step_execute_revert["execute_revert"]
  u_step_summary["summary"]
  wf_root --> u_step_banner
  u_step_banner --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_gather_commits
  u_step_gather_commits --> u_step_dependency_check
  u_step_dependency_check --> u_step_confirm_revert
  u_step_confirm_revert --> u_step_execute_revert
  u_step_execute_revert --> u_step_summary
  u_step_confirm_revert -.->|"goto"| u_step_execute_revert
  classDef missing fill:#fdecea,stroke:#d33,stroke-dasharray:4 3
  classDef unparsed fill:#f2f2f2,stroke:#888,stroke-dasharray:4 3
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
| 1 | `banner` | step |  |  |  |  |
| 2 | `parse_arguments` | step |  |  |  |  |
| 3 | `gather_commits` | step |  |  |  |  |
| 4 | `dependency_check` | step |  |  |  |  |
| 5 | `confirm_revert` | step |  |  |  |  |
| 6 | `execute_revert` | step |  |  |  |  |
| 7 | `summary` | step |  |  |  |  |

## Дефекты

Дефектов нет.
