<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# discuss-phase-power

Источник: `gsd-core/workflows/discuss-phase-power.md`. Единицы: 6 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **4**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["discuss-phase-power.md"]):::root
  u_step_analyze["analyze"]
  u_step_generate_json["generate_json"]
  u_step_generate_html["generate_html"]
  u_step_notify_user["notify_user"]
  u_step_wait_loop["wait_loop"]
  u_step_finalize["finalize"]
  wf_root --> u_step_analyze
  u_step_analyze --> u_step_generate_json
  u_step_generate_json --> u_step_generate_html
  u_step_generate_html --> u_step_notify_user
  u_step_notify_user --> u_step_wait_loop
  u_step_wait_loop --> u_step_finalize
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
| 1 | `analyze` | step |  |  |  |  |
| 2 | `generate_json` | step |  |  |  |  |
| 3 | `generate_html` | step |  |  |  |  |
| 4 | `notify_user` | step |  |  |  |  |
| 5 | `wait_loop` | step |  |  |  |  |
| 6 | `finalize` | step |  |  |  |  |

## Дефекты

Дефектов нет.
