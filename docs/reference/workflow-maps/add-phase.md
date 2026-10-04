<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# add-phase

Источник: `gsd-core/workflows/add-phase.md`. Единицы: 5 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["add-phase.md"]):::root
  u_step_parse_arguments["parse_arguments"]
  u_step_init_context["init_context"]
  u_step_add_phase["add_phase"]
  u_step_update_project_state["update_project_state"]
  u_step_completion["completion"]
  wf_root --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_init_context
  u_step_init_context --> u_step_add_phase
  u_step_add_phase --> u_step_update_project_state
  u_step_update_project_state --> u_step_completion
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
| 1 | `parse_arguments` | step |  |  |  |  |
| 2 | `init_context` | step |  |  |  |  |
| 3 | `add_phase` | step |  |  |  |  |
| 4 | `update_project_state` | step |  |  |  |  |
| 5 | `completion` | step |  |  |  |  |

## Дефекты

Дефектов нет.
