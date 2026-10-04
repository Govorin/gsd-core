<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# ultraplan-phase

Источник: `gsd-core/workflows/ultraplan-phase.md`. Единицы: 6 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["ultraplan-phase.md"]):::root
  u_step_banner["banner"]
  u_step_runtime_gate["runtime_gate"]
  u_step_initialize["initialize"]
  u_step_build_prompt["build_prompt"]
  u_step_return_path_card["return_path_card"]
  u_step_trigger["trigger"]
  wf_root --> u_step_banner
  u_step_banner --> u_step_runtime_gate
  u_step_runtime_gate --> u_step_initialize
  u_step_initialize --> u_step_build_prompt
  u_step_build_prompt --> u_step_return_path_card
  u_step_return_path_card --> u_step_trigger
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
| 1 | `banner` | step |  |  |  |  |
| 2 | `runtime_gate` | step |  |  |  |  |
| 3 | `initialize` | step |  |  |  |  |
| 4 | `build_prompt` | step |  |  |  |  |
| 5 | `return_path_card` | step |  |  |  |  |
| 6 | `trigger` | step |  |  |  |  |

## Дефекты

Дефектов нет.
