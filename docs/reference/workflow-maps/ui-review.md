<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# ui-review

Источник: `gsd-core/workflows/ui-review.md`. Единицы: 7 разделов H2. Спавнов: 1 (агенты: `gsd-ui-auditor`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["ui-review.md"]):::root
  u_heading_0__Initialize["0. Initialize"]
  u_heading_1__Detect_Input_State["1. Detect Input State"]
  u_heading_2__Gather_Context_Paths["2. Gather Context Paths"]
  u_heading_3__Spawn_gsd_ui_auditor["3. Spawn gsd-ui-auditor"]
  u_heading_4__Handle_Return["4. Handle Return"]
  u_heading_Automated_UI_Verification__when_Playwright_MCP_is_available_["Automated UI Verification (when Playwright-MCP is available)"]
  u_heading_5__Commit__if_configured_["5. Commit (if configured)"]
  wf_root --> u_heading_0__Initialize
  u_heading_0__Initialize --> u_heading_1__Detect_Input_State
  u_heading_1__Detect_Input_State --> u_heading_2__Gather_Context_Paths
  u_heading_2__Gather_Context_Paths --> u_heading_3__Spawn_gsd_ui_auditor
  u_heading_3__Spawn_gsd_ui_auditor --> u_heading_4__Handle_Return
  u_heading_4__Handle_Return --> u_heading_Automated_UI_Verification__when_Playwright_MCP_is_available_
  u_heading_Automated_UI_Verification__when_Playwright_MCP_is_available_ --> u_heading_5__Commit__if_configured_
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
    a_gsd_ui_auditor[["gsd-ui-auditor"]]:::agent
  end
  u_heading_3__Spawn_gsd_ui_auditor["3. Spawn gsd-ui-auditor"]
  u_heading_3__Spawn_gsd_ui_auditor --> a_gsd_ui_auditor
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
| 1 | `0. Initialize` | H2 |  |  |  |  |
| 2 | `1. Detect Input State` | H2 |  |  |  |  |
| 3 | `2. Gather Context Paths` | H2 |  |  |  |  |
| 4 | `3. Spawn gsd-ui-auditor` | H2 |  | `gsd-ui-auditor` |  |  |
| 5 | `4. Handle Return` | H2 |  |  |  |  |
| 6 | `Automated UI Verification (when Playwright-MCP is available)` | H2 |  |  |  |  |
| 7 | `5. Commit (if configured)` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
