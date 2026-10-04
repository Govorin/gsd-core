<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# discuss-phase-assumptions

Источник: `gsd-core/workflows/discuss-phase-assumptions.md`. Единицы: 16 шагов `<step>`, 1 секция `gsd:section`. Спавнов: 2 (агенты: `gsd-assumptions-analyzer`, `general-purpose`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 12; не называют реальный шаг и не рисуются — **3**; названы по имени шага и нарисованы пунктиром `goto` — 9.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["discuss-phase-assumptions.md"]):::root
  u_step_initialize["initialize"]
  u_step_check_existing["check_existing"]
  u_step_load_prior_context["load_prior_context"]
  u_step_cross_reference_todos["cross_reference_todos"]
  u_step_load_methodology["load_methodology"]
  u_step_scout_codebase["scout_codebase"]
  u_step_deep_codebase_analysis["deep_codebase_analysis"]
  u_step_external_research["external_research"]
  u_step_present_assumptions["present_assumptions"]
  u_step_correct_assumptions["correct_assumptions"]
  u_step_write_context["write_context"]
  u_step_write_discussion_log["write_discussion_log"]
  u_step_git_commit["git_commit"]
  u_step_update_state["update_state"]
  u_step_confirm_creation["confirm_creation"]
  u_step_auto_advance["auto_advance"]
  u_section_auto_advance_dispatch("§ auto-advance-dispatch"):::conditional
  wf_root --> u_step_initialize
  u_step_initialize --> u_step_check_existing
  u_step_check_existing --> u_step_load_prior_context
  u_step_load_prior_context --> u_step_cross_reference_todos
  u_step_cross_reference_todos --> u_step_load_methodology
  u_step_load_methodology --> u_step_scout_codebase
  u_step_scout_codebase --> u_step_deep_codebase_analysis
  u_step_deep_codebase_analysis --> u_step_external_research
  u_step_external_research --> u_step_present_assumptions
  u_step_present_assumptions --> u_step_correct_assumptions
  u_step_correct_assumptions --> u_step_write_context
  u_step_write_context --> u_step_write_discussion_log
  u_step_write_discussion_log --> u_step_git_commit
  u_step_git_commit --> u_step_update_state
  u_step_update_state --> u_step_confirm_creation
  u_step_confirm_creation --> u_step_auto_advance
  u_step_auto_advance -->|"when#58; state#58;auto-advance-active"| u_section_auto_advance_dispatch
  u_step_initialize -.->|"goto"| u_step_check_existing
  u_step_check_existing -.->|"goto"| u_step_load_prior_context
  u_step_present_assumptions -.->|"goto"| u_step_write_context
  u_step_present_assumptions -.->|"goto"| u_step_correct_assumptions
  u_step_correct_assumptions -.->|"goto"| u_step_write_context
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
    a_gsd_assumptions_analyzer[["gsd-assumptions-analyzer"]]:::agent
    a_general_purpose[["general-purpose (встроенный)"]]:::builtin
  end
  u_step_deep_codebase_analysis["deep_codebase_analysis"]
  u_step_external_research["external_research"]
  u_step_deep_codebase_analysis --> a_gsd_assumptions_analyzer
  u_step_external_research --> a_general_purpose
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
| 2 | `check_existing` | step |  |  |  |  |
| 3 | `load_prior_context` | step |  |  |  |  |
| 4 | `cross_reference_todos` | step |  |  |  |  |
| 5 | `load_methodology` | step |  |  |  |  |
| 6 | `scout_codebase` | step |  |  |  |  |
| 7 | `deep_codebase_analysis` | step |  | `gsd-assumptions-analyzer` |  |  |
| 8 | `external_research` | step |  | `general-purpose` |  |  |
| 9 | `present_assumptions` | step |  |  |  |  |
| 10 | `correct_assumptions` | step |  |  |  |  |
| 11 | `write_context` | step |  |  |  |  |
| 12 | `write_discussion_log` | step |  |  |  |  |
| 13 | `git_commit` | step |  |  |  |  |
| 14 | `update_state` | step |  |  |  |  |
| 15 | `confirm_creation` | step |  |  |  |  |
| 16 | `auto_advance` | step |  |  |  | `discuss-phase-assumptions/steps/auto-advance-dispatch.md` |
| 17 | `auto-advance-dispatch` | section | when: state:auto-advance-active |  |  | `discuss-phase-assumptions/steps/auto-advance-dispatch.md` |

## Дефекты

Дефектов нет.
