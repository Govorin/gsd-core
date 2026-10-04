<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# fast

Источник: `gsd-core/workflows/fast.md`. Единицы: 6 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["fast.md"]):::root
  u_step_parse_task["parse_task"]
  u_step_scope_check["scope_check"]
  u_step_execute_inline["execute_inline"]
  u_step_commit["commit"]
  u_step_log_to_state["log_to_state"]
  u_step_done["done"]
  wf_root --> u_step_parse_task
  u_step_parse_task --> u_step_scope_check
  u_step_scope_check --> u_step_execute_inline
  u_step_execute_inline --> u_step_commit
  u_step_commit --> u_step_log_to_state
  u_step_log_to_state --> u_step_done
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
| 1 | `parse_task` | step |  |  |  |  |
| 2 | `scope_check` | step |  |  |  |  |
| 3 | `execute_inline` | step |  |  |  |  |
| 4 | `commit` | step |  |  |  |  |
| 5 | `log_to_state` | step |  |  |  |  |
| 6 | `done` | step |  |  |  |  |

## Дефекты

Дефектов нет.
