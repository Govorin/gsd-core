<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# extract-learnings

Источник: `gsd-core/workflows/extract-learnings.md`. Единицы: 8 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["extract-learnings.md"]):::root
  u_step_initialize["initialize"]
  u_step_collect_artifacts["collect_artifacts"]
  u_step_extract_learnings["extract-learnings"]
  u_step_capture_thought_integration["capture_thought_integration"]
  u_step_write_learnings["write_learnings"]
  u_step_calibrate_estimates["calibrate_estimates"]
  u_step_update_state["update_state"]
  u_step_report["report"]
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_collect_artifacts
  u_step_collect_artifacts --> u_step_extract_learnings
  u_step_extract_learnings --> u_step_capture_thought_integration
  u_step_capture_thought_integration --> u_step_write_learnings
  u_step_write_learnings --> u_step_calibrate_estimates
  u_step_calibrate_estimates --> u_step_update_state
  u_step_update_state --> u_step_report
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
| 1 | `initialize` | step |  |  |  |  |
| 2 | `collect_artifacts` | step |  |  |  |  |
| 3 | `extract-learnings` | step |  |  |  |  |
| 4 | `capture_thought_integration` | step |  |  |  |  |
| 5 | `write_learnings` | step |  |  |  |  |
| 6 | `calibrate_estimates` | step |  |  |  |  |
| 7 | `update_state` | step |  |  |  |  |
| 8 | `report` | step |  |  |  |  |

## Дефекты

Дефектов нет.
