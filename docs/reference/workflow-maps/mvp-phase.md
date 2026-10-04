<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# mvp-phase

Источник: `gsd-core/workflows/mvp-phase.md`. Единицы: 9 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 2.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["mvp-phase.md"]):::root
  u_heading_1__Parse_and_validate_phase_argument["1. Parse and validate phase argument"]
  u_heading_2__Validate_phase_exists_and_check_status["2. Validate phase exists and check status"]
  u_heading_3__User_story_prompts["3. User story prompts"]
  u_heading_4__SPIDR_splitting_check["4. SPIDR splitting check"]
  u_heading_5__Update_ROADMAP_md["5. Update ROADMAP.md"]
  u_heading_6__Verify_the_write["6. Verify the write"]
  u_heading_7__Delegate_to__gsd_plan_phase["7. Delegate to /gsd#58;plan-phase"]
  u_heading_8__Surface_deferred_phase_splits__if_any_["8. Surface deferred phase splits (if any)"]
  u_heading_9__Exit["9. Exit"]
  wf_root --> u_heading_1__Parse_and_validate_phase_argument
  u_heading_1__Parse_and_validate_phase_argument --> u_heading_2__Validate_phase_exists_and_check_status
  u_heading_2__Validate_phase_exists_and_check_status --> u_heading_3__User_story_prompts
  u_heading_3__User_story_prompts --> u_heading_4__SPIDR_splitting_check
  u_heading_4__SPIDR_splitting_check --> u_heading_5__Update_ROADMAP_md
  u_heading_5__Update_ROADMAP_md --> u_heading_6__Verify_the_write
  u_heading_6__Verify_the_write --> u_heading_7__Delegate_to__gsd_plan_phase
  u_heading_7__Delegate_to__gsd_plan_phase --> u_heading_8__Surface_deferred_phase_splits__if_any_
  u_heading_8__Surface_deferred_phase_splits__if_any_ --> u_heading_9__Exit
  u_heading_4__SPIDR_splitting_check -.->|"goto"| u_heading_5__Update_ROADMAP_md
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
| 1 | `1. Parse and validate phase argument` | H2 |  |  |  |  |
| 2 | `2. Validate phase exists and check status` | H2 |  |  |  |  |
| 3 | `3. User story prompts` | H2 |  |  |  |  |
| 4 | `4. SPIDR splitting check` | H2 |  |  |  |  |
| 5 | `5. Update ROADMAP.md` | H2 |  |  |  |  |
| 6 | `6. Verify the write` | H2 |  |  |  |  |
| 7 | `7. Delegate to /gsd:plan-phase` | H2 |  |  |  |  |
| 8 | `8. Surface deferred phase splits (if any)` | H2 |  |  |  |  |
| 9 | `9. Exit` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
