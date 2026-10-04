<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# inbox

Источник: `gsd-core/workflows/inbox.md`. Единицы: 9 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["inbox.md"]):::root
  u_step_preflight["preflight"]
  u_step_fetch_issues["fetch_issues"]
  u_step_review_issues["review_issues"]
  u_step_fetch_prs["fetch_prs"]
  u_step_review_prs["review_prs"]
  u_step_check_gates["check_gates"]
  u_step_generate_report["generate_report"]
  u_step_auto_actions["auto_actions"]
  u_step_report["report"]
  wf_root --> u_step_preflight
  u_step_preflight --> u_step_fetch_issues
  u_step_fetch_issues --> u_step_review_issues
  u_step_review_issues --> u_step_fetch_prs
  u_step_fetch_prs --> u_step_review_prs
  u_step_review_prs --> u_step_check_gates
  u_step_check_gates --> u_step_generate_report
  u_step_generate_report --> u_step_auto_actions
  u_step_auto_actions --> u_step_report
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
| 1 | `preflight` | step |  |  |  |  |
| 2 | `fetch_issues` | step |  |  |  |  |
| 3 | `review_issues` | step |  |  |  |  |
| 4 | `fetch_prs` | step |  |  |  |  |
| 5 | `review_prs` | step |  |  |  |  |
| 6 | `check_gates` | step |  |  |  |  |
| 7 | `generate_report` | step |  |  |  |  |
| 8 | `auto_actions` | step |  |  |  |  |
| 9 | `report` | step |  |  |  |  |

## Дефекты

Дефектов нет.
