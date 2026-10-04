<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# arch-survey

Источник: `gsd-core/workflows/arch-survey.md`. Единицы: 8 шагов `<step>`. Спавнов: 2 (агенты: `gsd-arch-surveyor`, `gsd-finding-refuter`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["arch-survey.md"]):::root
  u_step_parse_arguments["parse_arguments"]
  u_step_metrics["metrics"]
  u_step_spawn_surveyors["spawn_surveyors"]
  u_step_collect_cards["collect_cards"]
  u_step_refute["refute"]
  u_step_report["report"]
  u_step_decide["decide"]
  u_step_commit["commit"]
  wf_root --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_metrics
  u_step_metrics --> u_step_spawn_surveyors
  u_step_spawn_surveyors --> u_step_collect_cards
  u_step_collect_cards --> u_step_refute
  u_step_refute --> u_step_report
  u_step_report --> u_step_decide
  u_step_decide --> u_step_commit
  u_step_collect_cards -.->|"goto"| u_step_report
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
    a_gsd_arch_surveyor[["gsd-arch-surveyor"]]:::agent
    a_gsd_finding_refuter[["gsd-finding-refuter"]]:::agent
  end
  u_step_spawn_surveyors["spawn_surveyors"]
  u_step_refute["refute"]
  u_step_spawn_surveyors --> a_gsd_arch_surveyor
  u_step_refute --> a_gsd_finding_refuter
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
| 2 | `metrics` | step |  |  |  |  |
| 3 | `spawn_surveyors` | step |  | `gsd-arch-surveyor` |  |  |
| 4 | `collect_cards` | step |  |  |  |  |
| 5 | `refute` | step |  | `gsd-finding-refuter` |  |  |
| 6 | `report` | step |  |  |  |  |
| 7 | `decide` | step |  |  |  |  |
| 8 | `commit` | step |  |  |  |  |

## Дефекты

Дефектов нет.
