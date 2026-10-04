<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# sync-skills

Источник: `gsd-core/workflows/sync-skills.md`. Единицы: 8 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["sync-skills.md"]):::root
  u_heading_Arguments["Arguments"]
  u_heading_Step_1__Parse_Arguments["Step 1#58; Parse Arguments"]
  u_heading_Step_2__Resolve_Skills_Roots["Step 2#58; Resolve Skills Roots"]
  u_heading_Step_3__Compute_Diff_Per_Destination["Step 3#58; Compute Diff Per Destination"]
  u_heading_Step_4__Print_Diff_Report["Step 4#58; Print Diff Report"]
  u_heading_Step_5__Execute__only_when___apply_["Step 5#58; Execute (only when #45;#45;apply)"]
  u_heading_Safety_Rules["Safety Rules"]
  u_heading_Limitations["Limitations"]
  wf_root --> u_heading_Arguments
  u_heading_Arguments --> u_heading_Step_1__Parse_Arguments
  u_heading_Step_1__Parse_Arguments --> u_heading_Step_2__Resolve_Skills_Roots
  u_heading_Step_2__Resolve_Skills_Roots --> u_heading_Step_3__Compute_Diff_Per_Destination
  u_heading_Step_3__Compute_Diff_Per_Destination --> u_heading_Step_4__Print_Diff_Report
  u_heading_Step_4__Print_Diff_Report --> u_heading_Step_5__Execute__only_when___apply_
  u_heading_Step_5__Execute__only_when___apply_ --> u_heading_Safety_Rules
  u_heading_Safety_Rules --> u_heading_Limitations
  u_heading_Step_2__Resolve_Skills_Roots -.->|"goto"| u_heading_Step_3__Compute_Diff_Per_Destination
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
| 1 | `Arguments` | H2 |  |  |  |  |
| 2 | `Step 1: Parse Arguments` | H2 |  |  |  |  |
| 3 | `Step 2: Resolve Skills Roots` | H2 |  |  |  |  |
| 4 | `Step 3: Compute Diff Per Destination` | H2 |  |  |  |  |
| 5 | `Step 4: Print Diff Report` | H2 |  |  |  |  |
| 6 | `Step 5: Execute (only when --apply)` | H2 |  |  |  |  |
| 7 | `Safety Rules` | H2 |  |  |  |  |
| 8 | `Limitations` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
