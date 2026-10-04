<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# health

Источник: `gsd-core/workflows/health.md`. Единицы: 6 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["health.md"]):::root
  u_step_parse_args["parse_args"]
  u_step_context_check["context_check"]
  u_step_run_health_check["run_health_check"]
  u_step_format_output["format_output"]
  u_step_offer_repair["offer_repair"]
  u_step_verify_repairs["verify_repairs"]
  wf_root --> u_step_parse_args
  u_step_parse_args --> u_step_context_check
  u_step_context_check --> u_step_run_health_check
  u_step_run_health_check --> u_step_format_output
  u_step_format_output --> u_step_offer_repair
  u_step_offer_repair --> u_step_verify_repairs
  u_step_parse_args -.->|"goto"| u_step_context_check
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
| 1 | `parse_args` | step |  |  |  |  |
| 2 | `context_check` | step |  |  |  |  |
| 3 | `run_health_check` | step |  |  |  |  |
| 4 | `format_output` | step |  |  |  |  |
| 5 | `offer_repair` | step |  |  |  |  |
| 6 | `verify_repairs` | step |  |  |  |  |

## Дефекты

Дефектов нет.
