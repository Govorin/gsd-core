<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# import

Источник: `gsd-core/workflows/import.md`. Единицы: 8 шагов `<step>`. Спавнов: 1 (агенты: `gsd-plan-checker`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["import.md"]):::root
  u_step_banner["banner"]
  u_step_parse_arguments["parse_arguments"]
  u_step_plan_load_context["plan_load_context"]
  u_step_plan_read_input["plan_read_input"]
  u_step_plan_conflict_detection["plan_conflict_detection"]
  u_step_plan_convert["plan_convert"]
  u_step_plan_validate["plan_validate"]
  u_step_plan_finalize["plan_finalize"]
  wf_root --> u_step_banner
  u_step_banner --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_plan_load_context
  u_step_plan_load_context --> u_step_plan_read_input
  u_step_plan_read_input --> u_step_plan_conflict_detection
  u_step_plan_conflict_detection --> u_step_plan_convert
  u_step_plan_convert --> u_step_plan_validate
  u_step_plan_validate --> u_step_plan_finalize
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

## Агенты и точки цикла

```mermaid
flowchart LR
  subgraph g_agents["Агенты"]
    a_gsd_plan_checker[["gsd-plan-checker"]]:::agent
  end
  u_step_plan_validate["plan_validate"]
  u_step_plan_validate --> a_gsd_plan_checker
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
| 3 | `plan_load_context` | step |  |  |  |  |
| 4 | `plan_read_input` | step |  |  |  |  |
| 5 | `plan_conflict_detection` | step |  |  |  |  |
| 6 | `plan_convert` | step |  |  |  |  |
| 7 | `plan_validate` | step |  | `gsd-plan-checker` |  |  |
| 8 | `plan_finalize` | step |  |  |  |  |

## Дефекты

Дефектов нет.
