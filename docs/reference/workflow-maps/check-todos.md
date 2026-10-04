<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# check-todos

Источник: `gsd-core/workflows/check-todos.md`. Единицы: 10 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 6; не называют реальный шаг и не рисуются — **5**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["check-todos.md"]):::root
  u_step_init_context["init_context"]
  u_step_parse_filter["parse_filter"]
  u_step_list_todos["list_todos"]
  u_step_handle_selection["handle_selection"]
  u_step_load_context["load_context"]
  u_step_check_roadmap["check_roadmap"]
  u_step_offer_actions["offer_actions"]
  u_step_execute_action["execute_action"]
  u_step_update_state["update_state"]
  u_step_git_commit["git_commit"]
  wf_root --> u_step_init_context
  u_step_init_context --> u_step_parse_filter
  u_step_parse_filter --> u_step_list_todos
  u_step_list_todos --> u_step_handle_selection
  u_step_handle_selection --> u_step_load_context
  u_step_load_context --> u_step_check_roadmap
  u_step_check_roadmap --> u_step_offer_actions
  u_step_offer_actions --> u_step_execute_action
  u_step_execute_action --> u_step_update_state
  u_step_update_state --> u_step_git_commit
  u_step_execute_action -.->|"goto"| u_step_list_todos
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
| 2 | `parse_filter` | step |  |  |  |  |
| 3 | `list_todos` | step |  |  |  |  |
| 4 | `handle_selection` | step |  |  |  |  |
| 5 | `load_context` | step |  |  |  |  |
| 6 | `check_roadmap` | step |  |  |  |  |
| 7 | `offer_actions` | step |  |  |  |  |
| 8 | `execute_action` | step |  |  |  |  |
| 9 | `update_state` | step |  |  |  |  |
| 10 | `git_commit` | step |  |  |  |  |

## Дефекты

Дефектов нет.
