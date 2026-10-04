<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# manager

Источник: `gsd-core/workflows/manager.md`. Единицы: 5 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 16; не называют реальный шаг и не рисуются — **4**; названы по имени шага и нарисованы пунктиром `goto` — 12.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["manager.md"]):::root
  u_step_initialize["initialize"]
  u_step_dashboard["dashboard"]
  u_step_handle_action["handle_action"]
  u_step_background_completion["background_completion"]
  u_step_exit["exit"]
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_dashboard
  u_step_dashboard --> u_step_handle_action
  u_step_handle_action --> u_step_background_completion
  u_step_background_completion --> u_step_exit
  u_step_initialize -.->|"goto"| u_step_dashboard
  u_step_dashboard -.->|"goto"| u_step_exit
  u_step_dashboard -.->|"goto"| u_step_handle_action
  u_step_handle_action -.->|"goto"| u_step_dashboard
  u_step_handle_action -.->|"goto"| u_step_exit
  u_step_background_completion -.->|"goto"| u_step_dashboard
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
| 1 | `initialize` | step |  |  |  |  |
| 2 | `dashboard` | step |  |  |  |  |
| 3 | `handle_action` | step |  |  |  |  |
| 4 | `background_completion` | step |  |  |  |  |
| 5 | `exit` | step |  |  |  |  |

## Дефекты

Дефектов нет.
