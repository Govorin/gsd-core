<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# pr-branch

Источник: `gsd-core/workflows/pr-branch.md`. Единицы: 5 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 2.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["pr-branch.md"]):::root
  u_step_detect_state["detect_state"]
  u_step_handle_sub_repos["handle_sub_repos"]
  u_step_analyze_commits["analyze_commits"]
  u_step_create_pr_branch["create_pr_branch"]
  u_step_verify["verify"]
  wf_root --> u_step_detect_state
  u_step_detect_state --> u_step_handle_sub_repos
  u_step_handle_sub_repos --> u_step_analyze_commits
  u_step_analyze_commits --> u_step_create_pr_branch
  u_step_create_pr_branch --> u_step_verify
  u_step_handle_sub_repos -.->|"goto"| u_step_analyze_commits
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
| 1 | `detect_state` | step |  |  |  |  |
| 2 | `handle_sub_repos` | step |  |  |  |  |
| 3 | `analyze_commits` | step |  |  |  |  |
| 4 | `create_pr_branch` | step |  |  |  |  |
| 5 | `verify` | step |  |  |  |  |

## Дефекты

Дефектов нет.
