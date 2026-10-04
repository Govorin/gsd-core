<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# resume-project

Источник: `gsd-core/workflows/resume-project.md`. Единицы: 8 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 8; не называют реальный шаг и не рисуются — **6**; названы по имени шага и нарисованы пунктиром `goto` — 2.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["resume-project.md"]):::root
  u_step_initialize["initialize"]
  u_step_load_state["load_state"]
  u_step_check_incomplete_work["check_incomplete_work"]
  u_step_present_status["present_status"]
  u_step_determine_next_action["determine_next_action"]
  u_step_offer_options["offer_options"]
  u_step_route_to_workflow["route_to_workflow"]
  u_step_update_session["update_session"]
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_load_state
  u_step_load_state --> u_step_check_incomplete_work
  u_step_check_incomplete_work --> u_step_present_status
  u_step_present_status --> u_step_determine_next_action
  u_step_determine_next_action --> u_step_offer_options
  u_step_offer_options --> u_step_route_to_workflow
  u_step_route_to_workflow --> u_step_update_session
  u_step_initialize -.->|"goto"| u_step_load_state
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
| 1 | `initialize` | step |  |  |  |  |
| 2 | `load_state` | step |  |  |  |  |
| 3 | `check_incomplete_work` | step |  |  |  |  |
| 4 | `present_status` | step |  |  |  |  |
| 5 | `determine_next_action` | step |  |  |  |  |
| 6 | `offer_options` | step |  |  |  |  |
| 7 | `route_to_workflow` | step |  |  |  |  |
| 8 | `update_session` | step |  |  |  |  |

## Дефекты

Дефектов нет.
