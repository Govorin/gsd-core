<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# code-review

Источник: `gsd-core/workflows/code-review.md`. Единицы: 10 шагов `<step>`, 2 секции `gsd:section`. Спавнов: 1 (агенты: `gsd-code-reviewer`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 4.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["code-review.md"]):::root
  u_step_initialize["initialize"]
  u_step_check_config_gate["check_config_gate"]
  u_step_compute_file_scope["compute_file_scope"]
  u_step_resolve_depth["resolve_depth"]
  u_step_check_empty_scope["check_empty_scope"]
  u_step_structural_pre_pass["structural_pre_pass"]
  u_section_structural_pre_pass("§ structural-pre-pass"):::conditional
  u_step_dispatch_reviewer_lanes["dispatch_reviewer_lanes"]
  u_step_spawn_reviewer["spawn_reviewer"]
  u_step_commit_review["commit_review"]
  u_section_dispatch_fix("§ dispatch-fix"):::conditional
  u_step_present_results["present_results"]
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_check_config_gate
  u_step_check_config_gate --> u_step_compute_file_scope
  u_step_compute_file_scope --> u_step_resolve_depth
  u_step_resolve_depth --> u_step_check_empty_scope
  u_step_check_empty_scope --> u_step_structural_pre_pass
  u_step_structural_pre_pass -->|"when#58; state#58;fallow-enabled"| u_section_structural_pre_pass
  u_section_structural_pre_pass --> u_step_dispatch_reviewer_lanes
  u_step_dispatch_reviewer_lanes --> u_step_spawn_reviewer
  u_step_spawn_reviewer --> u_step_commit_review
  u_step_commit_review -->|"when#58; flag#58;#45;#45;fix"| u_section_dispatch_fix
  u_section_dispatch_fix --> u_step_present_results
  u_step_check_empty_scope -.->|"goto"| u_section_dispatch_fix
  u_step_spawn_reviewer -.->|"goto"| u_step_commit_review
  wf_root -.->|"goto"| u_step_present_results
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

## Агенты и точки цикла

```mermaid
flowchart LR
  subgraph g_agents["Агенты"]
    a_gsd_code_reviewer[["gsd-code-reviewer"]]:::agent
  end
  subgraph g_files["Другие workflows и файлы"]
    w_gsd_core_workflows_code_review_fix_md(["workflow#58; code-review-fix"]):::workflow
  end
  wf_root(["code-review.md (вне шагов)"]):::root
  u_step_spawn_reviewer["spawn_reviewer"]
  u_section_dispatch_fix("§ dispatch-fix")
  u_step_spawn_reviewer --> a_gsd_code_reviewer
  wf_root -.-> w_gsd_core_workflows_code_review_fix_md
  u_section_dispatch_fix -.-> w_gsd_core_workflows_code_review_fix_md
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
| — | (вне единиц) | — | — |  |  | `code-review/steps/dispatch-fix.md` |
| 1 | `initialize` | step |  |  |  |  |
| 2 | `check_config_gate` | step |  |  |  |  |
| 3 | `compute_file_scope` | step |  |  |  |  |
| 4 | `resolve_depth` | step |  |  |  |  |
| 5 | `check_empty_scope` | step |  |  |  |  |
| 6 | `structural_pre_pass` | step |  |  |  | `code-review/steps/structural-pre-pass.md` |
| 7 | `structural-pre-pass` | section | when: state:fallow-enabled |  |  | `code-review/steps/structural-pre-pass.md` |
| 8 | `dispatch_reviewer_lanes` | step |  |  |  |  |
| 9 | `spawn_reviewer` | step |  | `gsd-code-reviewer` |  |  |
| 10 | `commit_review` | step |  |  |  |  |
| 11 | `dispatch-fix` | section | when: flag:--fix |  |  | `code-review/steps/dispatch-fix.md` |
| 12 | `present_results` | step |  |  |  |  |

## Дефекты

Дефектов нет.
