<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# autonomous

Источник: `gsd-core/workflows/autonomous.md`. Единицы: 7 шагов `<step>`, 10 секций `gsd:section`. Спавнов: 0. Точки цикла: `execute:post`, `verify:post`, `ship:pre`, `verify:pre`.

> **Переходы в прозе** (фразы «перейди к …»): всего 34; не называют реальный шаг и не рисуются — **18**; названы по имени шага и нарисованы пунктиром `goto` — 16.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["autonomous.md"]):::root
  u_step_initialize["initialize"]
  u_section_converge_fail_fast("§ converge-fail-fast"):::conditional
  u_section_converge_banner("§ converge-banner"):::conditional
  u_step_discover_phases["discover_phases"]
  u_step_execute_phase["execute_phase"]
  u_section_spec_phase("§ spec-phase")
  u_section_converge_dispatch_bg("§ converge-dispatch-bg"):::conditional
  u_section_converge_dispatch_inline("§ converge-dispatch-inline"):::conditional
  u_section_converge_loop("§ converge-loop"):::conditional
  u_section_blocking_gates("§ blocking-gates")
  u_section_human_needed("§ human-needed")
  u_section_gaps_found("§ gaps-found")
  u_step_smart_discuss["smart_discuss"]
  u_step_iterate["iterate"]
  u_section_phase_budget("§ phase-budget")
  u_step_lifecycle["lifecycle"]
  u_step_handle_blocker["handle_blocker"]
  wf_root --> u_step_initialize
  u_step_initialize -->|"when#58; state#58;plan-strategy-converge"| u_section_converge_fail_fast
  u_section_converge_fail_fast -->|"when#58; state#58;plan-strategy-converge"| u_section_converge_banner
  u_section_converge_banner --> u_step_discover_phases
  u_step_discover_phases --> u_step_execute_phase
  u_step_execute_phase --> u_section_spec_phase
  u_section_spec_phase -->|"when#58; state#58;plan-strategy-converge"| u_section_converge_dispatch_bg
  u_section_converge_dispatch_bg -->|"when#58; state#58;plan-strategy-converge"| u_section_converge_dispatch_inline
  u_section_converge_dispatch_inline -->|"when#58; state#58;plan-strategy-converge"| u_section_converge_loop
  u_section_converge_loop --> u_section_blocking_gates
  u_section_blocking_gates --> u_section_human_needed
  u_section_human_needed --> u_section_gaps_found
  u_section_gaps_found --> u_step_smart_discuss
  u_step_smart_discuss --> u_step_iterate
  u_step_iterate --> u_section_phase_budget
  u_section_phase_budget --> u_step_lifecycle
  u_step_lifecycle --> u_step_handle_blocker
  u_step_execute_phase -.->|"goto"| u_step_handle_blocker
  u_step_execute_phase -.->|"goto"| u_step_iterate
  u_step_iterate -.->|"goto"| u_step_lifecycle
  u_step_iterate -.->|"goto"| u_step_handle_blocker
  u_step_iterate -.->|"goto"| u_step_execute_phase
  u_step_lifecycle -.->|"goto"| u_step_handle_blocker
  wf_root -.->|"goto"| u_step_handle_blocker
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
    p_execute_post{{"execute#58;post<br/>+1 gates, +0 contributions"}}:::point
    c_execute_post_code_review_skill_code_review["code-review#58; skill code-review"]:::capability
    c_execute_post_refactor_trigger_command_refactor_evaluate["refactor-trigger#58; command refactor evaluate"]:::capability
    p_verify_post{{"verify#58;post"}}:::point
    c_verify_post_mempalace_skill_mempalace_capture["mempalace#58; skill mempalace-capture"]:::capability
    c_verify_post_nyquist_skill_validate_phase["nyquist#58; skill validate-phase"]:::capability
    c_verify_post_security_skill_secure_phase["security#58; skill secure-phase"]:::capability
    c_verify_post_ui_skill_ui_review["ui#58; skill ui-review"]:::capability
    p_ship_pre{{"ship#58;pre<br/>+9 gates, +0 contributions"}}:::point
    p_verify_pre{{"verify#58;pre<br/>+6 gates, +0 contributions"}}:::point
    c_verify_pre_architecture_agent_gsd_architect_reviewer["architecture#58; agent gsd-architect-reviewer"]:::capability
    c_verify_pre_mn_verify_gate_command_verify_gates["mn-verify-gate#58; command verify gates"]:::capability
    c_verify_pre_mn_verify_gate_command_verify_mutation["mn-verify-gate#58; command verify mutation"]:::capability
  end
  subgraph g_files["Другие workflows и файлы"]
    w_gsd_core_workflows_transition_md(["workflow#58; transition"]):::workflow
  end
  u_step_execute_phase["execute_phase"]
  u_section_blocking_gates("§ blocking-gates")
  u_section_human_needed("§ human-needed")
  p_execute_post -.-> c_execute_post_code_review_skill_code_review
  p_execute_post -.-> c_execute_post_refactor_trigger_command_refactor_evaluate
  u_step_execute_phase --> p_execute_post
  p_verify_post -.-> c_verify_post_mempalace_skill_mempalace_capture
  p_verify_post -.-> c_verify_post_nyquist_skill_validate_phase
  p_verify_post -.-> c_verify_post_security_skill_secure_phase
  p_verify_post -.-> c_verify_post_ui_skill_ui_review
  u_step_execute_phase --> p_verify_post
  u_step_execute_phase -->|"через autonomous/steps/blocking-gates.md"| p_ship_pre
  p_verify_pre -.-> c_verify_pre_architecture_agent_gsd_architect_reviewer
  p_verify_pre -.-> c_verify_pre_mn_verify_gate_command_verify_gates
  p_verify_pre -.-> c_verify_pre_mn_verify_gate_command_verify_mutation
  u_step_execute_phase -->|"через autonomous/steps/blocking-gates.md"| p_verify_pre
  u_section_blocking_gates -->|"через autonomous/steps/blocking-gates.md"| p_ship_pre
  u_section_blocking_gates -->|"через autonomous/steps/blocking-gates.md"| p_verify_pre
  u_step_execute_phase -.-> w_gsd_core_workflows_transition_md
  u_section_human_needed -.-> w_gsd_core_workflows_transition_md
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
| 1 | `initialize` | step |  |  |  | `autonomous/steps/converge-fail-fast.md`, `autonomous/steps/converge-banner.md` |
| 2 | `converge-fail-fast` | section | when: state:plan-strategy-converge |  |  | `autonomous/steps/converge-fail-fast.md` |
| 3 | `converge-banner` | section | when: state:plan-strategy-converge |  |  | `autonomous/steps/converge-banner.md` |
| 4 | `discover_phases` | step |  |  |  |  |
| 5 | `execute_phase` | step |  |  | `execute:post`, `verify:post`, `ship:pre`, `verify:pre` | `autonomous/steps/spec-phase.md`, `autonomous/steps/converge-dispatch-bg.md`, `autonomous/steps/converge-dispatch-inline.md`, `autonomous/steps/converge-loop.md`, `autonomous/steps/blocking-gates.md`, `transition.md`, `autonomous/steps/human-needed.md`, `autonomous/steps/gaps-found.md` |
| 6 | `spec-phase` | section |  |  |  | `autonomous/steps/spec-phase.md` |
| 7 | `converge-dispatch-bg` | section | when: state:plan-strategy-converge |  |  | `autonomous/steps/converge-dispatch-bg.md` |
| 8 | `converge-dispatch-inline` | section | when: state:plan-strategy-converge |  |  | `autonomous/steps/converge-dispatch-inline.md` |
| 9 | `converge-loop` | section | when: state:plan-strategy-converge |  |  | `autonomous/steps/converge-loop.md` |
| 10 | `blocking-gates` | section |  |  | `ship:pre`, `verify:pre` | `autonomous/steps/blocking-gates.md` |
| 11 | `human-needed` | section |  |  |  | `autonomous/steps/human-needed.md` |
| 12 | `gaps-found` | section |  |  |  | `autonomous/steps/gaps-found.md` |
| 13 | `smart_discuss` | step |  |  |  |  |
| 14 | `iterate` | step |  |  |  | `autonomous/steps/phase-budget.md` |
| 15 | `phase-budget` | section |  |  |  | `autonomous/steps/phase-budget.md` |
| 16 | `lifecycle` | step |  |  |  |  |
| 17 | `handle_blocker` | step |  |  |  |  |

## Дефекты

Дефектов нет.
