<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# add-todo

Источник: `gsd-core/workflows/add-todo.md`. Единицы: 9 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["add-todo.md"]):::root
  u_step_init_context["init_context"]
  u_step_extract_content["extract_content"]
  u_step_infer_area["infer_area"]
  u_step_infer_severity["infer_severity"]
  u_step_check_duplicates["check_duplicates"]
  u_step_create_file["create_file"]
  u_step_update_state["update_state"]
  u_step_git_commit["git_commit"]
  u_step_confirm["confirm"]
  wf_root --> u_step_init_context
  u_step_init_context --> u_step_extract_content
  u_step_extract_content --> u_step_infer_area
  u_step_infer_area --> u_step_infer_severity
  u_step_infer_severity --> u_step_check_duplicates
  u_step_check_duplicates --> u_step_create_file
  u_step_create_file --> u_step_update_state
  u_step_update_state --> u_step_git_commit
  u_step_git_commit --> u_step_confirm
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
| 1 | `init_context` | step |  |  |  |  |
| 2 | `extract_content` | step |  |  |  |  |
| 3 | `infer_area` | step |  |  |  |  |
| 4 | `infer_severity` | step |  |  |  |  |
| 5 | `check_duplicates` | step |  |  |  |  |
| 6 | `create_file` | step |  |  |  |  |
| 7 | `update_state` | step |  |  |  |  |
| 8 | `git_commit` | step |  |  |  |  |
| 9 | `confirm` | step |  |  |  |  |

## Дефекты

Дефектов нет.
