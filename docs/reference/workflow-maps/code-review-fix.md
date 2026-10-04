<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# code-review-fix

Источник: `gsd-core/workflows/code-review-fix.md`. Единицы: 10 шагов `<step>`. Спавнов: 3 (агенты: `gsd-code-fixer`, `gsd-code-reviewer`). Точки цикла: `execute:post`.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["code-review-fix.md"]):::root
  u_step_initialize["initialize"]
  u_step_check_config_gate["check_config_gate"]
  u_step_check_review_exists["check_review_exists"]
  u_step_check_review_status["check_review_status"]
  u_step_spawn_fixer["spawn_fixer"]
  u_step_auto_iteration_loop["auto_iteration_loop"]
  u_step_commit_fix_report["commit_fix_report"]
  u_step_record_disposition["record_disposition"]
  u_step_cleanup_iteration_backups["cleanup_iteration_backups"]
  u_step_present_results["present_results"]
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_check_config_gate
  u_step_check_config_gate --> u_step_check_review_exists
  u_step_check_review_exists --> u_step_check_review_status
  u_step_check_review_status --> u_step_spawn_fixer
  u_step_spawn_fixer --> u_step_auto_iteration_loop
  u_step_auto_iteration_loop --> u_step_commit_fix_report
  u_step_commit_fix_report --> u_step_record_disposition
  u_step_record_disposition --> u_step_cleanup_iteration_backups
  u_step_cleanup_iteration_backups --> u_step_present_results
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
    a_gsd_code_fixer[["gsd-code-fixer"]]:::agent
    a_gsd_code_reviewer[["gsd-code-reviewer"]]:::agent
  end
  subgraph g_points["Точки цикла и капабилити"]
    p_execute_post{{"execute#58;post<br/>+1 gates, +0 contributions"}}:::point
    c_execute_post_code_review_skill_code_review["code-review#58; skill code-review"]:::capability
    c_execute_post_refactor_trigger_command_refactor_evaluate["refactor-trigger#58; command refactor evaluate"]:::capability
  end
  u_step_check_config_gate["check_config_gate"]
  u_step_spawn_fixer["spawn_fixer"]
  u_step_auto_iteration_loop["auto_iteration_loop"]
  u_step_spawn_fixer --> a_gsd_code_fixer
  u_step_auto_iteration_loop --> a_gsd_code_reviewer
  u_step_auto_iteration_loop --> a_gsd_code_fixer
  p_execute_post -.-> c_execute_post_code_review_skill_code_review
  p_execute_post -.-> c_execute_post_refactor_trigger_command_refactor_evaluate
  u_step_check_config_gate --> p_execute_post
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
| 2 | `check_config_gate` | step |  |  | `execute:post` |  |
| 3 | `check_review_exists` | step |  |  |  |  |
| 4 | `check_review_status` | step |  |  |  |  |
| 5 | `spawn_fixer` | step |  | `gsd-code-fixer` |  |  |
| 6 | `auto_iteration_loop` | step |  | `gsd-code-reviewer`, `gsd-code-fixer` |  |  |
| 7 | `commit_fix_report` | step |  |  |  |  |
| 8 | `record_disposition` | step |  |  |  | `execute-phase/steps/code-review-disposition.md` |
| 9 | `cleanup_iteration_backups` | step |  |  |  |  |
| 10 | `present_results` | step |  |  |  |  |

## Дефекты

Дефектов нет.
