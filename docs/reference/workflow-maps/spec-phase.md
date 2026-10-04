<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# spec-phase

Источник: `gsd-core/workflows/spec-phase.md`. Единицы: 10 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 10; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 8.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["spec-phase.md"]):::root
  u_heading_Step_1__Initialize["Step 1#58; Initialize"]
  u_heading_Step_2__Scout_Codebase["Step 2#58; Scout Codebase"]
  u_heading_Step_3__First_Ambiguity_Assessment["Step 3#58; First Ambiguity Assessment"]
  u_heading_Step_4__Socratic_Interview_Loop["Step 4#58; Socratic Interview Loop"]
  u_heading_Step_5___covered_inline_u2014_ambiguity_scoring_is_per_round_["Step 5#58; (covered inline — ambiguity scoring is per-round)"]
  u_heading_Step_5_5__Edge_Completeness_Probe["Step 5.5#58; Edge-Completeness Probe"]
  u_heading_Step_5_6__Prohibition_Completeness_Probe__must_NOT_["Step 5.6#58; Prohibition-Completeness Probe (must-NOT)"]
  u_heading_Step_6__Generate_SPEC_md["Step 6#58; Generate SPEC.md"]
  u_heading_Step_7__Commit["Step 7#58; Commit"]
  u_heading_Step_8__Wrap_Up["Step 8#58; Wrap Up"]
  wf_root --> u_heading_Step_1__Initialize
  u_heading_Step_1__Initialize --> u_heading_Step_2__Scout_Codebase
  u_heading_Step_2__Scout_Codebase --> u_heading_Step_3__First_Ambiguity_Assessment
  u_heading_Step_3__First_Ambiguity_Assessment --> u_heading_Step_4__Socratic_Interview_Loop
  u_heading_Step_4__Socratic_Interview_Loop --> u_heading_Step_5___covered_inline_u2014_ambiguity_scoring_is_per_round_
  u_heading_Step_5___covered_inline_u2014_ambiguity_scoring_is_per_round_ --> u_heading_Step_5_5__Edge_Completeness_Probe
  u_heading_Step_5_5__Edge_Completeness_Probe --> u_heading_Step_5_6__Prohibition_Completeness_Probe__must_NOT_
  u_heading_Step_5_6__Prohibition_Completeness_Probe__must_NOT_ --> u_heading_Step_6__Generate_SPEC_md
  u_heading_Step_6__Generate_SPEC_md --> u_heading_Step_7__Commit
  u_heading_Step_7__Commit --> u_heading_Step_8__Wrap_Up
  u_heading_Step_1__Initialize -.->|"goto"| u_heading_Step_3__First_Ambiguity_Assessment
  u_heading_Step_3__First_Ambiguity_Assessment -.->|"goto"| u_heading_Step_5_5__Edge_Completeness_Probe
  u_heading_Step_3__First_Ambiguity_Assessment -.->|"goto"| u_heading_Step_4__Socratic_Interview_Loop
  u_heading_Step_4__Socratic_Interview_Loop -.->|"goto"| u_heading_Step_5_5__Edge_Completeness_Probe
  u_heading_Step_5_5__Edge_Completeness_Probe -.->|"goto"| u_heading_Step_5_6__Prohibition_Completeness_Probe__must_NOT_
  u_heading_Step_5_6__Prohibition_Completeness_Probe__must_NOT_ -.->|"goto"| u_heading_Step_6__Generate_SPEC_md
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
| 1 | `Step 1: Initialize` | H2 |  |  |  |  |
| 2 | `Step 2: Scout Codebase` | H2 |  |  |  |  |
| 3 | `Step 3: First Ambiguity Assessment` | H2 |  |  |  |  |
| 4 | `Step 4: Socratic Interview Loop` | H2 |  |  |  |  |
| 5 | `Step 5: (covered inline — ambiguity scoring is per-round)` | H2 |  |  |  |  |
| 6 | `Step 5.5: Edge-Completeness Probe` | H2 |  |  |  |  |
| 7 | `Step 5.6: Prohibition-Completeness Probe (must-NOT)` | H2 |  |  |  |  |
| 8 | `Step 6: Generate SPEC.md` | H2 |  |  |  |  |
| 9 | `Step 7: Commit` | H2 |  |  |  |  |
| 10 | `Step 8: Wrap Up` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
