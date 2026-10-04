<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# ingest-docs

Источник: `gsd-core/workflows/ingest-docs.md`. Единицы: 10 шагов `<step>`. Спавнов: 2 (агенты: `gsd-doc-synthesizer`, `gsd-roadmapper`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 2; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["ingest-docs.md"]):::root
  u_step_banner["banner"]
  u_step_parse_arguments["parse_arguments"]
  u_step_init_and_mode_detect["init_and_mode_detect"]
  u_step_discover_docs["discover_docs"]
  u_step_classify_parallel["classify_parallel"]
  u_step_synthesize["synthesize"]
  u_step_conflict_gate["conflict_gate"]
  u_step_route_new_mode["route_new_mode"]
  u_step_route_merge_mode["route_merge_mode"]
  u_step_finalize["finalize"]
  wf_root --> u_step_banner
  u_step_banner --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_init_and_mode_detect
  u_step_init_and_mode_detect --> u_step_discover_docs
  u_step_discover_docs --> u_step_classify_parallel
  u_step_classify_parallel --> u_step_synthesize
  u_step_synthesize --> u_step_conflict_gate
  u_step_conflict_gate --> u_step_route_new_mode
  u_step_route_new_mode --> u_step_route_merge_mode
  u_step_route_merge_mode --> u_step_finalize
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
    a_gsd_doc_synthesizer[["gsd-doc-synthesizer"]]:::agent
    a_gsd_roadmapper[["gsd-roadmapper"]]:::agent
  end
  u_step_synthesize["synthesize"]
  u_step_route_new_mode["route_new_mode"]
  u_step_synthesize --> a_gsd_doc_synthesizer
  u_step_route_new_mode --> a_gsd_roadmapper
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
| 1 | `banner` | step |  |  |  |  |
| 2 | `parse_arguments` | step |  |  |  |  |
| 3 | `init_and_mode_detect` | step |  |  |  |  |
| 4 | `discover_docs` | step |  |  |  |  |
| 5 | `classify_parallel` | step |  |  |  |  |
| 6 | `synthesize` | step |  | `gsd-doc-synthesizer` |  |  |
| 7 | `conflict_gate` | step |  |  |  |  |
| 8 | `route_new_mode` | step |  | `gsd-roadmapper` |  |  |
| 9 | `route_merge_mode` | step |  |  |  |  |
| 10 | `finalize` | step |  |  |  |  |

## Дефекты

Дефектов нет.
