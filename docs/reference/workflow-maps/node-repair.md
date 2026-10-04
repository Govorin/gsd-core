<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# node-repair

Источник: `gsd-core/workflows/node-repair.md`. Единицы: 5 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["node-repair.md"]):::root
  u_step_diagnose["diagnose"]
  u_step_execute_retry["execute_retry"]
  u_step_execute_decompose["execute_decompose"]
  u_step_execute_prune["execute_prune"]
  u_step_execute_escalate["execute_escalate"]
  wf_root --> u_step_diagnose
  u_step_diagnose --> u_step_execute_retry
  u_step_execute_retry --> u_step_execute_decompose
  u_step_execute_decompose --> u_step_execute_prune
  u_step_execute_prune --> u_step_execute_escalate
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
| 1 | `diagnose` | step |  |  |  |  |
| 2 | `execute_retry` | step |  |  |  |  |
| 3 | `execute_decompose` | step |  |  |  |  |
| 4 | `execute_prune` | step |  |  |  |  |
| 5 | `execute_escalate` | step |  |  |  |  |

## Дефекты

Дефектов нет.
