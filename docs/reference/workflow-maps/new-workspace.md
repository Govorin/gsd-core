<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# new-workspace

Источник: `gsd-core/workflows/new-workspace.md`. Единицы: 9 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["new-workspace.md"]):::root
  u_heading_1__Setup["1. Setup"]
  u_heading_2__Parse_Arguments["2. Parse Arguments"]
  u_heading_3__Select_Repos["3. Select Repos"]
  u_heading_4__Select_Strategy["4. Select Strategy"]
  u_heading_5__Validate["5. Validate"]
  u_heading_6__Create_Workspace["6. Create Workspace"]
  u_heading_7__Write_WORKSPACE_md["7. Write WORKSPACE.md"]
  u_heading_8__Initialize__planning_["8. Initialize .planning/"]
  u_heading_9__Report_and_Next_Steps["9. Report and Next Steps"]
  wf_root --> u_heading_1__Setup
  u_heading_1__Setup --> u_heading_2__Parse_Arguments
  u_heading_2__Parse_Arguments --> u_heading_3__Select_Repos
  u_heading_3__Select_Repos --> u_heading_4__Select_Strategy
  u_heading_4__Select_Strategy --> u_heading_5__Validate
  u_heading_5__Validate --> u_heading_6__Create_Workspace
  u_heading_6__Create_Workspace --> u_heading_7__Write_WORKSPACE_md
  u_heading_7__Write_WORKSPACE_md --> u_heading_8__Initialize__planning_
  u_heading_8__Initialize__planning_ --> u_heading_9__Report_and_Next_Steps
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
| 1 | `1. Setup` | H2 |  |  |  |  |
| 2 | `2. Parse Arguments` | H2 |  |  |  |  |
| 3 | `3. Select Repos` | H2 |  |  |  |  |
| 4 | `4. Select Strategy` | H2 |  |  |  |  |
| 5 | `5. Validate` | H2 |  |  |  |  |
| 6 | `6. Create Workspace` | H2 |  |  |  |  |
| 7 | `7. Write WORKSPACE.md` | H2 |  |  |  |  |
| 8 | `8. Initialize .planning/` | H2 |  |  |  |  |
| 9 | `9. Report and Next Steps` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
