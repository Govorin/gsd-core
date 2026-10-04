<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# do

Источник: `gsd-core/workflows/do.md`. Единицы: 6 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["do.md"]):::root
  u_step_validate["validate"]
  u_step_check_project["check_project"]
  u_step_route["route"]
  u_step_display["display"]
  u_step_confirm["confirm"]
  u_step_dispatch["dispatch"]
  wf_root --> u_step_validate
  u_step_validate --> u_step_check_project
  u_step_check_project --> u_step_route
  u_step_route --> u_step_display
  u_step_display --> u_step_confirm
  u_step_confirm --> u_step_dispatch
  u_step_confirm -.->|"goto"| u_step_dispatch
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
| 1 | `validate` | step |  |  |  |  |
| 2 | `check_project` | step |  |  |  |  |
| 3 | `route` | step |  |  |  |  |
| 4 | `display` | step |  |  |  |  |
| 5 | `confirm` | step |  |  |  |  |
| 6 | `dispatch` | step |  |  |  |  |

## Дефекты

Дефектов нет.
