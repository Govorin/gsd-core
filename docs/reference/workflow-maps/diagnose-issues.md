<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# diagnose-issues

Источник: `gsd-core/workflows/diagnose-issues.md`. Единицы: 6 шагов `<step>`. Спавнов: 1 (агенты: `gsd-debugger`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **3**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["diagnose-issues.md"]):::root
  u_step_parse_gaps["parse_gaps"]
  u_step_report_plan["report_plan"]
  u_step_spawn_agents["spawn_agents"]
  u_step_collect_results["collect_results"]
  u_step_update_uat["update_uat"]
  u_step_report_results["report_results"]
  wf_root --> u_step_parse_gaps
  u_step_parse_gaps --> u_step_report_plan
  u_step_report_plan --> u_step_spawn_agents
  u_step_spawn_agents --> u_step_collect_results
  u_step_collect_results --> u_step_update_uat
  u_step_update_uat --> u_step_report_results
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

## Агенты и точки цикла

```mermaid
flowchart LR
  subgraph g_agents["Агенты"]
    a_gsd_debugger[["gsd-debugger"]]:::agent
  end
  u_step_spawn_agents["spawn_agents"]
  u_step_spawn_agents --> a_gsd_debugger
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
| 1 | `parse_gaps` | step |  |  |  |  |
| 2 | `report_plan` | step |  |  |  |  |
| 3 | `spawn_agents` | step |  | `gsd-debugger` |  |  |
| 4 | `collect_results` | step |  |  |  |  |
| 5 | `update_uat` | step |  |  |  |  |
| 6 | `report_results` | step |  |  |  |  |

## Дефекты

Дефектов нет.
