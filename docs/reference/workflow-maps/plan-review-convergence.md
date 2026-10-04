<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# plan-review-convergence

Источник: `gsd-core/workflows/plan-review-convergence.md`. Единицы: 6 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **3**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["plan-review-convergence.md"]):::root
  u_heading_1__Parse_and_Normalize_Arguments["1. Parse and Normalize Arguments"]
  u_heading_1_5__Config_Gate__feature_disabled_by_default_["1.5. Config Gate (feature disabled by default)"]
  u_heading_2__Initialize["2. Initialize"]
  u_heading_3__Validate_Phase___Pre_flight_Gate["3. Validate Phase + Pre-flight Gate"]
  u_heading_4__Initial_Planning__if_no_plans_exist_["4. Initial Planning (if no plans exist)"]
  u_heading_5__Convergence_Loop["5. Convergence Loop"]
  wf_root --> u_heading_1__Parse_and_Normalize_Arguments
  u_heading_1__Parse_and_Normalize_Arguments --> u_heading_1_5__Config_Gate__feature_disabled_by_default_
  u_heading_1_5__Config_Gate__feature_disabled_by_default_ --> u_heading_2__Initialize
  u_heading_2__Initialize --> u_heading_3__Validate_Phase___Pre_flight_Gate
  u_heading_3__Validate_Phase___Pre_flight_Gate --> u_heading_4__Initial_Planning__if_no_plans_exist_
  u_heading_4__Initial_Planning__if_no_plans_exist_ --> u_heading_5__Convergence_Loop
  u_heading_4__Initial_Planning__if_no_plans_exist_ -.->|"goto"| u_heading_5__Convergence_Loop
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
| 1 | `1. Parse and Normalize Arguments` | H2 |  |  |  |  |
| 2 | `1.5. Config Gate (feature disabled by default)` | H2 |  |  |  |  |
| 3 | `2. Initialize` | H2 |  |  |  |  |
| 4 | `3. Validate Phase + Pre-flight Gate` | H2 |  |  |  |  |
| 5 | `4. Initial Planning (if no plans exist)` | H2 |  |  |  |  |
| 6 | `5. Convergence Loop` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
