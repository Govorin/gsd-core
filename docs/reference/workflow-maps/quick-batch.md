<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# quick-batch

Источник: `gsd-core/workflows/quick-batch.md`. Единицы: 2 секции `gsd:section`. Спавнов: 10 (агенты: `gsd-phase-researcher`, `gsd-planner`, `gsd-plan-checker`, `gsd-executor`, `gsd-verifier`). Точки цикла: `plan:pre`.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["quick-batch.md"]):::root
  u_section_research_phase("§ research-phase"):::conditional
  u_section_verification_wave("§ verification-wave"):::conditional
  wf_root -->|"when#58; flag#58;#45;#45;research"| u_section_research_phase
  u_section_research_phase -->|"when#58; flag#58;#45;#45;validate"| u_section_verification_wave
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
    a_gsd_phase_researcher[["gsd-phase-researcher"]]:::agent
    a_gsd_planner[["gsd-planner"]]:::agent
    a_gsd_plan_checker[["gsd-plan-checker"]]:::agent
    a_gsd_executor[["gsd-executor"]]:::agent
    a_gsd_verifier[["gsd-verifier"]]:::agent
  end
  subgraph g_points["Точки цикла и капабилити"]
    p_plan_pre{{"plan#58;pre<br/>+3 gates, +12 contributions"}}:::point
    c_plan_pre_ai_integration_skill_ai_integration_phase["ai-integration#58; skill ai-integration-phase"]:::capability
    c_plan_pre_architecture_agent_gsd_system_architect["architecture#58; agent gsd-system-architect"]:::capability
    c_plan_pre_intel_command_intel_api_surface["intel#58; command intel api-surface"]:::capability
    c_plan_pre_mempalace_skill_mempalace_recall["mempalace#58; skill mempalace-recall"]:::capability
    c_plan_pre_research_agent_gsd_phase_researcher["research#58; agent gsd-phase-researcher"]:::capability
    c_plan_pre_ui_skill_ui_phase["ui#58; skill ui-phase"]:::capability
    c_plan_pre_pattern_mapper_agent_gsd_pattern_mapper["pattern-mapper#58; agent gsd-pattern-mapper"]:::capability
  end
  subgraph g_files["Другие workflows и файлы"]
    w_gsd_core_workflows_quick_md(["workflow#58; quick"]):::workflow
  end
  wf_root(["quick-batch.md (вне шагов)"]):::root
  u_section_research_phase("§ research-phase")
  u_section_verification_wave("§ verification-wave")
  wf_root -->|"через quick-batch/steps/research-phase.md"| a_gsd_phase_researcher
  wf_root -->|"через quick-batch/steps/planner-wave.md"| a_gsd_planner
  wf_root -->|"через quick-batch/steps/plan-checker-loop.md"| a_gsd_plan_checker
  wf_root -->|"через quick-batch/steps/worktree-dispatch.md"| a_gsd_executor
  wf_root -->|"через quick-batch/steps/verification-wave.md"| a_gsd_verifier
  u_section_research_phase -->|"через quick-batch/steps/research-phase.md"| a_gsd_phase_researcher
  u_section_verification_wave -->|"через quick-batch/steps/verification-wave.md"| a_gsd_verifier
  p_plan_pre -.-> c_plan_pre_ai_integration_skill_ai_integration_phase
  p_plan_pre -.-> c_plan_pre_architecture_agent_gsd_system_architect
  p_plan_pre -.-> c_plan_pre_intel_command_intel_api_surface
  p_plan_pre -.-> c_plan_pre_mempalace_skill_mempalace_recall
  p_plan_pre -.-> c_plan_pre_research_agent_gsd_phase_researcher
  p_plan_pre -.-> c_plan_pre_ui_skill_ui_phase
  p_plan_pre -.-> c_plan_pre_pattern_mapper_agent_gsd_pattern_mapper
  wf_root -->|"через quick-batch/steps/planner-wave.md"| p_plan_pre
  wf_root -.-> w_gsd_core_workflows_quick_md
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
| — | (вне единиц) | — | — | `gsd-phase-researcher`, `gsd-planner`, `gsd-plan-checker`, `gsd-executor`, `gsd-verifier` | `plan:pre` | `quick.md`, `quick-batch/steps/resume-mode.md`, `quick-batch/steps/batch-init.md`, `quick-batch/steps/research-phase.md`, `quick-batch/steps/planner-wave.md`, `quick-batch/steps/plan-checker-loop.md`, `quick-batch/steps/worktree-dispatch.md`, `quick-batch/steps/merge-wave.md`, `quick-batch/steps/verification-wave.md`, `quick-batch/steps/completion.md` |
| 1 | `research-phase` | section | when: flag:--research | `gsd-phase-researcher` |  | `quick-batch/steps/research-phase.md` |
| 2 | `verification-wave` | section | when: flag:--validate | `gsd-verifier` |  | `quick-batch/steps/verification-wave.md` |

## Дефекты

- `spawn-in-prose`: вызов Agent(… gsd-plan-checker) (gsd-core/workflows/quick/steps/plan-checker-loop.md:71) записан в прозе, а не в блоке кода (если рядом блок кода — проверьте парность ограничителей ```)
