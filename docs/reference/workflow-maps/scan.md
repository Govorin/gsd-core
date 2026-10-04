<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# scan

Источник: `gsd-core/workflows/scan.md`. Единицы: 6 разделов H2. Спавнов: 1 (агенты: `gsd-codebase-mapper`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["scan.md"]):::root
  u_heading_Focus_to_Document_Mapping["Focus-to-Document Mapping"]
  u_heading_Step_1__Parse_arguments_and_resolve_focus["Step 1#58; Parse arguments and resolve focus"]
  u_heading_Step_2__Check_for_existing_documents["Step 2#58; Check for existing documents"]
  u_heading_Step_3__Create_output_directory["Step 3#58; Create output directory"]
  u_heading_Step_4__Spawn_mapper_agent["Step 4#58; Spawn mapper agent"]
  u_heading_Step_5__Report["Step 5#58; Report"]
  wf_root --> u_heading_Focus_to_Document_Mapping
  u_heading_Focus_to_Document_Mapping --> u_heading_Step_1__Parse_arguments_and_resolve_focus
  u_heading_Step_1__Parse_arguments_and_resolve_focus --> u_heading_Step_2__Check_for_existing_documents
  u_heading_Step_2__Check_for_existing_documents --> u_heading_Step_3__Create_output_directory
  u_heading_Step_3__Create_output_directory --> u_heading_Step_4__Spawn_mapper_agent
  u_heading_Step_4__Spawn_mapper_agent --> u_heading_Step_5__Report
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
    a_gsd_codebase_mapper[["gsd-codebase-mapper"]]:::agent
  end
  u_heading_Step_4__Spawn_mapper_agent["Step 4#58; Spawn mapper agent"]
  u_heading_Step_4__Spawn_mapper_agent --> a_gsd_codebase_mapper
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
| 1 | `Focus-to-Document Mapping` | H2 |  |  |  |  |
| 2 | `Step 1: Parse arguments and resolve focus` | H2 |  |  |  |  |
| 3 | `Step 2: Check for existing documents` | H2 |  |  |  |  |
| 4 | `Step 3: Create output directory` | H2 |  |  |  |  |
| 5 | `Step 4: Spawn mapper agent` | H2 |  | `gsd-codebase-mapper` |  |  |
| 6 | `Step 5: Report` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
