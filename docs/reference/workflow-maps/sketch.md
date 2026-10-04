<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# sketch

Источник: `gsd-core/workflows/sketch.md`. Единицы: 12 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 3.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["sketch.md"]):::root
  u_step_banner["banner"]
  u_step_route["route"]
  u_step_frontier_mode["frontier_mode"]
  u_step_setup_directory["setup_directory"]
  u_step_mood_intake["mood_intake"]
  u_step_load_spike_context["load_spike_context"]
  u_step_decompose["decompose"]
  u_step_research_stack["research_stack"]
  u_step_create_manifest["create_manifest"]
  u_step_create_theme["create_theme"]
  u_step_build_sketches["build_sketches"]
  u_step_report["report"]
  wf_root --> u_step_banner
  u_step_banner --> u_step_route
  u_step_route --> u_step_frontier_mode
  u_step_frontier_mode --> u_step_setup_directory
  u_step_setup_directory --> u_step_mood_intake
  u_step_mood_intake --> u_step_load_spike_context
  u_step_load_spike_context --> u_step_decompose
  u_step_decompose --> u_step_research_stack
  u_step_research_stack --> u_step_create_manifest
  u_step_create_manifest --> u_step_create_theme
  u_step_create_theme --> u_step_build_sketches
  u_step_build_sketches --> u_step_report
  u_step_route -.->|"goto"| u_step_frontier_mode
  u_step_route -.->|"goto"| u_step_setup_directory
  u_step_mood_intake -.->|"goto"| u_step_load_spike_context
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
| 2 | `route` | step |  |  |  |  |
| 3 | `frontier_mode` | step |  |  |  |  |
| 4 | `setup_directory` | step |  |  |  |  |
| 5 | `mood_intake` | step |  |  |  |  |
| 6 | `load_spike_context` | step |  |  |  |  |
| 7 | `decompose` | step |  |  |  |  |
| 8 | `research_stack` | step |  |  |  |  |
| 9 | `create_manifest` | step |  |  |  |  |
| 10 | `create_theme` | step |  |  |  |  |
| 11 | `build_sketches` | step |  |  |  |  |
| 12 | `report` | step |  |  |  |  |

## Дефекты

Дефектов нет.
