<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# milestone-summary

Источник: `gsd-core/workflows/milestone-summary.md`. Единицы: 9 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 2; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 2.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["milestone-summary.md"]):::root
  u_heading_Step_1__Resolve_Version["Step 1#58; Resolve Version"]
  u_heading_Step_2__Locate_Artifacts["Step 2#58; Locate Artifacts"]
  u_heading_Step_3__Discover_Phase_Artifacts["Step 3#58; Discover Phase Artifacts"]
  u_heading_Step_4__Gather_Git_Statistics["Step 4#58; Gather Git Statistics"]
  u_heading_Step_5__Generate_Summary_Document["Step 5#58; Generate Summary Document"]
  u_heading_Step_6__Write_and_Commit["Step 6#58; Write and Commit"]
  u_heading_Step_7__Present_Summary["Step 7#58; Present Summary"]
  u_heading_Step_8__Offer_Interactive_Mode["Step 8#58; Offer Interactive Mode"]
  u_heading_Step_9__Update_STATE_md["Step 9#58; Update STATE.md"]
  wf_root --> u_heading_Step_1__Resolve_Version
  u_heading_Step_1__Resolve_Version --> u_heading_Step_2__Locate_Artifacts
  u_heading_Step_2__Locate_Artifacts --> u_heading_Step_3__Discover_Phase_Artifacts
  u_heading_Step_3__Discover_Phase_Artifacts --> u_heading_Step_4__Gather_Git_Statistics
  u_heading_Step_4__Gather_Git_Statistics --> u_heading_Step_5__Generate_Summary_Document
  u_heading_Step_5__Generate_Summary_Document --> u_heading_Step_6__Write_and_Commit
  u_heading_Step_6__Write_and_Commit --> u_heading_Step_7__Present_Summary
  u_heading_Step_7__Present_Summary --> u_heading_Step_8__Offer_Interactive_Mode
  u_heading_Step_8__Offer_Interactive_Mode --> u_heading_Step_9__Update_STATE_md
  u_heading_Step_3__Discover_Phase_Artifacts -.->|"goto"| u_heading_Step_5__Generate_Summary_Document
  u_heading_Step_6__Write_and_Commit -.->|"goto"| u_heading_Step_8__Offer_Interactive_Mode
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
| 1 | `Step 1: Resolve Version` | H2 |  |  |  |  |
| 2 | `Step 2: Locate Artifacts` | H2 |  |  |  |  |
| 3 | `Step 3: Discover Phase Artifacts` | H2 |  |  |  |  |
| 4 | `Step 4: Gather Git Statistics` | H2 |  |  |  |  |
| 5 | `Step 5: Generate Summary Document` | H2 |  |  |  |  |
| 6 | `Step 6: Write and Commit` | H2 |  |  |  |  |
| 7 | `Step 7: Present Summary` | H2 |  |  |  |  |
| 8 | `Step 8: Offer Interactive Mode` | H2 |  |  |  |  |
| 9 | `Step 9: Update STATE.md` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
