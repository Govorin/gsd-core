<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# onboard

Источник: `gsd-core/workflows/onboard.md`. Единицы: 4 раздела H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 6; не называют реальный шаг и не рисуются — **6**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["onboard.md"]):::root
  u_heading_1__Render_the_Onboarding_Projection["1. Render the Onboarding Projection"]
  u_heading_2__Execute__next_action_["2. Execute #96;next_action#96;"]
  u_heading_3__Create_Onboarding_Summary["3. Create Onboarding Summary"]
  u_heading_4__Final_Status["4. Final Status"]
  wf_root --> u_heading_1__Render_the_Onboarding_Projection
  u_heading_1__Render_the_Onboarding_Projection --> u_heading_2__Execute__next_action_
  u_heading_2__Execute__next_action_ --> u_heading_3__Create_Onboarding_Summary
  u_heading_3__Create_Onboarding_Summary --> u_heading_4__Final_Status
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
| 1 | `1. Render the Onboarding Projection` | H2 |  |  |  |  |
| 2 | 2. Execute `next_action` | H2 |  |  |  |  |
| 3 | `3. Create Onboarding Summary` | H2 |  |  |  |  |
| 4 | `4. Final Status` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
