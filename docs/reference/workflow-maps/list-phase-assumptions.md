<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# list-phase-assumptions

Источник: `gsd-core/workflows/list-phase-assumptions.md`. Единицы: 5 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 3.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["list-phase-assumptions.md"]):::root
  u_step_validate_phase["validate_phase"]
  u_step_analyze_phase["analyze_phase"]
  u_step_present_assumptions["present_assumptions"]
  u_step_gather_feedback["gather_feedback"]
  u_step_offer_next["offer_next"]
  wf_root --> u_step_validate_phase
  u_step_validate_phase --> u_step_analyze_phase
  u_step_analyze_phase --> u_step_present_assumptions
  u_step_present_assumptions --> u_step_gather_feedback
  u_step_gather_feedback --> u_step_offer_next
  u_step_validate_phase -.->|"goto"| u_step_analyze_phase
  u_step_gather_feedback -.->|"goto"| u_step_offer_next
  u_step_offer_next -.->|"goto"| u_step_analyze_phase
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
| 1 | `validate_phase` | step |  |  |  |  |
| 2 | `analyze_phase` | step |  |  |  |  |
| 3 | `present_assumptions` | step |  |  |  |  |
| 4 | `gather_feedback` | step |  |  |  |  |
| 5 | `offer_next` | step |  |  |  |  |

## Дефекты

Дефектов нет.
