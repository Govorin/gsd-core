<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# requirements-review

Источник: `gsd-core/workflows/requirements-review.md`. Единицы: 7 шагов `<step>`. Спавнов: 2 (агенты: `gsd-requirements-reviewer`, `gsd-finding-refuter`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 2.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["requirements-review.md"]):::root
  u_step_parse_arguments["parse_arguments"]
  u_step_prepare["prepare"]
  u_step_lenses["lenses"]
  u_step_refute["refute"]
  u_step_compose["compose"]
  u_step_decide["decide"]
  u_step_present["present"]
  wf_root --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_prepare
  u_step_prepare --> u_step_lenses
  u_step_lenses --> u_step_refute
  u_step_refute --> u_step_compose
  u_step_compose --> u_step_decide
  u_step_decide --> u_step_present
  u_step_decide -.->|"goto"| u_step_present
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

## Агенты и точки цикла

```mermaid
flowchart LR
  subgraph g_agents["Агенты"]
    a_gsd_requirements_reviewer[["gsd-requirements-reviewer"]]:::agent
    a_gsd_finding_refuter[["gsd-finding-refuter"]]:::agent
  end
  u_step_lenses["lenses"]
  u_step_refute["refute"]
  u_step_lenses --> a_gsd_requirements_reviewer
  u_step_refute --> a_gsd_finding_refuter
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
| 1 | `parse_arguments` | step |  |  |  |  |
| 2 | `prepare` | step |  |  |  |  |
| 3 | `lenses` | step |  | `gsd-requirements-reviewer` |  |  |
| 4 | `refute` | step |  | `gsd-finding-refuter` |  |  |
| 5 | `compose` | step |  |  |  |  |
| 6 | `decide` | step |  |  |  |  |
| 7 | `present` | step |  |  |  |  |

## Дефекты

Дефектов нет.
