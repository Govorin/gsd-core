<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# eval-review

Источник: `gsd-core/workflows/eval-review.md`. Единицы: 7 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["eval-review.md"]):::root
  u_heading_0__Initialize["0. Initialize"]
  u_heading_1__Detect_Input_State["1. Detect Input State"]
  u_heading_2__Gather_Context_Paths["2. Gather Context Paths"]
  u_heading_3__Spawn_gsd_eval_auditor["3. Spawn gsd-eval-auditor"]
  u_heading_4__Parse_Auditor_Result["4. Parse Auditor Result"]
  u_heading_5__Display_Summary["5. Display Summary"]
  u_heading_6__Commit["6. Commit"]
  wf_root --> u_heading_0__Initialize
  u_heading_0__Initialize --> u_heading_1__Detect_Input_State
  u_heading_1__Detect_Input_State --> u_heading_2__Gather_Context_Paths
  u_heading_2__Gather_Context_Paths --> u_heading_3__Spawn_gsd_eval_auditor
  u_heading_3__Spawn_gsd_eval_auditor --> u_heading_4__Parse_Auditor_Result
  u_heading_4__Parse_Auditor_Result --> u_heading_5__Display_Summary
  u_heading_5__Display_Summary --> u_heading_6__Commit
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
| 4 | `3. Spawn gsd-eval-auditor` | H2 |  |  |  |  |
| 5 | `4. Parse Auditor Result` | H2 |  |  |  |  |
| 6 | `5. Display Summary` | H2 |  |  |  |  |
| 7 | `6. Commit` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
