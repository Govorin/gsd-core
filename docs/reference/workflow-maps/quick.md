<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# quick

Источник: `gsd-core/workflows/quick.md`. Единицы: 5 секций `gsd:section`. Спавнов: 10 (агенты: `gsd-planner`, `gsd-code-reviewer`, `gsd-phase-researcher`, `gsd-plan-checker`, `gsd-verifier`). Точки цикла: `plan:pre`, `execute:post`.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["quick.md"]):::root
  u_section_discussion_phase("§ discussion-phase"):::conditional
  u_section_research_phase("§ research-phase"):::conditional
  u_section_plan_checker_loop("§ plan-checker-loop"):::conditional
  u_section_worktree_pre_dispatch_commit("§ worktree-pre-dispatch-commit"):::conditional
  u_section_quick_verification("§ quick-verification"):::conditional
  wf_root -->|"when#58; flag#58;#45;#45;discuss"| u_section_discussion_phase
  u_section_discussion_phase -->|"when#58; flag#58;#45;#45;research"| u_section_research_phase
  u_section_research_phase -->|"when#58; flag#58;#45;#45;validate"| u_section_plan_checker_loop
  u_section_plan_checker_loop -->|"when#58; state#58;worktrees-enabled"| u_section_worktree_pre_dispatch_commit
  u_section_worktree_pre_dispatch_commit -->|"when#58; flag#58;#45;#45;validate"| u_section_quick_verification
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
    a_gsd_planner[["gsd-planner"]]:::agent
    a_gsd_code_reviewer[["gsd-code-reviewer"]]:::agent
    a_gsd_phase_researcher[["gsd-phase-researcher"]]:::agent
    a_gsd_plan_checker[["gsd-plan-checker"]]:::agent
    a_gsd_verifier[["gsd-verifier"]]:::agent
  end
  subgraph g_points["Точки цикла и капабилити"]
    p_plan_pre{{"plan#58;pre<br/>+3 gates, +14 contributions"}}:::point
    c_plan_pre_ai_integration_skill_ai_integration_phase["ai-integration#58; skill ai-integration-phase"]:::capability
    c_plan_pre_architecture_agent_gsd_system_architect["architecture#58; agent gsd-system-architect"]:::capability
    c_plan_pre_intel_command_intel_api_surface["intel#58; command intel api-surface"]:::capability
    c_plan_pre_mempalace_skill_mempalace_recall["mempalace#58; skill mempalace-recall"]:::capability
    c_plan_pre_research_agent_gsd_phase_researcher["research#58; agent gsd-phase-researcher"]:::capability
    c_plan_pre_ui_skill_ui_phase["ui#58; skill ui-phase"]:::capability
    c_plan_pre_pattern_mapper_agent_gsd_pattern_mapper["pattern-mapper#58; agent gsd-pattern-mapper"]:::capability
    p_execute_post{{"execute#58;post<br/>+1 gates, +0 contributions"}}:::point
    c_execute_post_code_review_skill_code_review["code-review#58; skill code-review"]:::capability
    c_execute_post_refactor_trigger_command_refactor_evaluate["refactor-trigger#58; command refactor evaluate"]:::capability
  end
  wf_root(["quick.md (вне шагов)"]):::root
  u_section_research_phase("§ research-phase")
  u_section_plan_checker_loop("§ plan-checker-loop")
  u_section_quick_verification("§ quick-verification")
  wf_root --> a_gsd_planner
  wf_root --> a_gsd_code_reviewer
  wf_root -->|"через quick/steps/research-phase.md"| a_gsd_phase_researcher
  wf_root -->|"через quick/steps/plan-checker-loop.md"| a_gsd_plan_checker
  wf_root -->|"через quick/steps/quick-verification.md"| a_gsd_verifier
  u_section_research_phase -->|"через quick/steps/research-phase.md"| a_gsd_phase_researcher
  u_section_plan_checker_loop -->|"через quick/steps/plan-checker-loop.md"| a_gsd_plan_checker
  u_section_plan_checker_loop -->|"через quick/steps/plan-checker-loop.md"| a_gsd_planner
  u_section_quick_verification -->|"через quick/steps/quick-verification.md"| a_gsd_verifier
  p_plan_pre -.-> c_plan_pre_ai_integration_skill_ai_integration_phase
  p_plan_pre -.-> c_plan_pre_architecture_agent_gsd_system_architect
  p_plan_pre -.-> c_plan_pre_intel_command_intel_api_surface
  p_plan_pre -.-> c_plan_pre_mempalace_skill_mempalace_recall
  p_plan_pre -.-> c_plan_pre_research_agent_gsd_phase_researcher
  p_plan_pre -.-> c_plan_pre_ui_skill_ui_phase
  p_plan_pre -.-> c_plan_pre_pattern_mapper_agent_gsd_pattern_mapper
  wf_root --> p_plan_pre
  p_execute_post -.-> c_execute_post_code_review_skill_code_review
  p_execute_post -.-> c_execute_post_refactor_trigger_command_refactor_evaluate
  wf_root --> p_execute_post
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
| — | (вне единиц) | — | — | `gsd-planner`, `gsd-code-reviewer`, `gsd-phase-researcher`, `gsd-plan-checker`, `gsd-verifier` | `plan:pre`, `execute:post` | `quick/steps/discussion-phase.md`, `quick/steps/research-phase.md`, `quick/steps/plan-checker-loop.md`, `quick/steps/worktree-pre-dispatch-commit.md`, `quick/steps/quick-verification.md` |
| 1 | `discussion-phase` | section | when: flag:--discuss |  |  | `quick/steps/discussion-phase.md` |
| 2 | `research-phase` | section | when: flag:--research | `gsd-phase-researcher` |  | `quick/steps/research-phase.md` |
| 3 | `plan-checker-loop` | section | when: flag:--validate | `gsd-plan-checker`, `gsd-planner` |  | `quick/steps/plan-checker-loop.md` |
| 4 | `worktree-pre-dispatch-commit` | section | when: state:worktrees-enabled |  |  | `quick/steps/worktree-pre-dispatch-commit.md` |
| 5 | `quick-verification` | section | when: flag:--validate | `gsd-verifier` |  | `quick/steps/quick-verification.md` |

## Дефекты

Дефектов нет.
