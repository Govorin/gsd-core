<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# remove-workspace

Источник: `gsd-core/workflows/remove-workspace.md`. Единицы: 6 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["remove-workspace.md"]):::root
  u_heading_1__Setup["1. Setup"]
  u_heading_2__Safety_Checks["2. Safety Checks"]
  u_heading_3__Confirm_Removal["3. Confirm Removal"]
  u_heading_4__Clean_Up_Worktrees["4. Clean Up Worktrees"]
  u_heading_5__Delete_Workspace_Directory["5. Delete Workspace Directory"]
  u_heading_6__Report["6. Report"]
  wf_root --> u_heading_1__Setup
  u_heading_1__Setup --> u_heading_2__Safety_Checks
  u_heading_2__Safety_Checks --> u_heading_3__Confirm_Removal
  u_heading_3__Confirm_Removal --> u_heading_4__Clean_Up_Worktrees
  u_heading_4__Clean_Up_Worktrees --> u_heading_5__Delete_Workspace_Directory
  u_heading_5__Delete_Workspace_Directory --> u_heading_6__Report
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
| 2 | `2. Safety Checks` | H2 |  |  |  |  |
| 3 | `3. Confirm Removal` | H2 |  |  |  |  |
| 4 | `4. Clean Up Worktrees` | H2 |  |  |  |  |
| 5 | `5. Delete Workspace Directory` | H2 |  |  |  |  |
| 6 | `6. Report` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
