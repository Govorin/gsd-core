<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# ship

Источник: `gsd-core/workflows/ship.md`. Единицы: 10 шагов `<step>`. Спавнов: 2. Точки цикла: `ship:pre`, `ship:post`.

> **Переходы в прозе** (фразы «перейди к …»): всего 6; не называют реальный шаг и не рисуются — **5**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["ship.md"]):::root
  u_step_initialize["initialize"]
  u_step_preflight_checks["preflight_checks"]
  u_step_filter_planning_commits["filter_planning_commits"]
  u_step_push_branch["push_branch"]
  u_step_generate_pr_body["generate_pr_body"]
  u_step_create_pr["create_pr"]
  u_step_optional_review["optional_review"]
  u_step_track_shipping["track_shipping"]
  u_step_ship_post_capability_dispatch["ship_post_capability_dispatch"]
  u_step_report["report"]
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_preflight_checks
  u_step_preflight_checks --> u_step_filter_planning_commits
  u_step_filter_planning_commits --> u_step_push_branch
  u_step_push_branch --> u_step_generate_pr_body
  u_step_generate_pr_body --> u_step_create_pr
  u_step_create_pr --> u_step_optional_review
  u_step_optional_review --> u_step_track_shipping
  u_step_track_shipping --> u_step_ship_post_capability_dispatch
  u_step_ship_post_capability_dispatch --> u_step_report
  u_step_filter_planning_commits -.->|"goto"| u_step_push_branch
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
  subgraph g_points["Точки цикла и капабилити"]
    p_ship_post{{"ship#58;post"}}:::point
    c_ship_post_mempalace_agent_gsd_mempalace_curator["mempalace#58; agent gsd-mempalace-curator"]:::capability
    c_ship_post_retro_command_retro_stage["retro#58; command retro stage"]:::capability
    p_ship_pre{{"ship#58;pre<br/>+9 gates, +0 contributions"}}:::point
  end
  subgraph g_files["Другие workflows и файлы"]
    w_gsd_core_workflows_pr_branch_md(["workflow#58; pr-branch"]):::workflow
  end
  u_step_preflight_checks["preflight_checks"]
  u_step_filter_planning_commits["filter_planning_commits"]
  u_step_ship_post_capability_dispatch["ship_post_capability_dispatch"]
  p_ship_post -.-> c_ship_post_mempalace_agent_gsd_mempalace_curator
  p_ship_post -.-> c_ship_post_retro_command_retro_stage
  u_step_ship_post_capability_dispatch --> p_ship_post
  u_step_preflight_checks --> p_ship_pre
  u_step_filter_planning_commits -.-> w_gsd_core_workflows_pr_branch_md
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
| 2 | `preflight_checks` | step |  |  | `ship:pre` |  |
| 3 | `filter_planning_commits` | step |  |  |  | `pr-branch.md` |
| 4 | `push_branch` | step |  |  |  |  |
| 5 | `generate_pr_body` | step |  |  |  |  |
| 6 | `create_pr` | step |  |  |  |  |
| 7 | `optional_review` | step |  |  |  |  |
| 8 | `track_shipping` | step |  |  |  |  |
| 9 | `ship_post_capability_dispatch` | step |  | `ref.agent` | `ship:post` |  |
| 10 | `report` | step |  |  |  |  |

## Дефекты

Дефектов нет.
