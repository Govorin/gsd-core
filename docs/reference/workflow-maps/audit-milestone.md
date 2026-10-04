<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# audit-milestone

Источник: `gsd-core/workflows/audit-milestone.md`. Единицы: 9 разделов H2. Спавнов: 1 (агенты: `gsd-integration-checker`). Точки цикла: `verify:post`.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["audit-milestone.md"]):::root
  u_heading_0__Initialize_Milestone_Context["0. Initialize Milestone Context"]
  u_heading_1__Determine_Milestone_Scope["1. Determine Milestone Scope"]
  u_heading_2__Read_All_Phase_Verifications["2. Read All Phase Verifications"]
  u_heading_3__Spawn_Integration_Checker["3. Spawn Integration Checker"]
  u_heading_4__Collect_Results["4. Collect Results"]
  u_heading_5__Check_Requirements_Coverage__3_Source_Cross_Reference_["5. Check Requirements Coverage (3-Source Cross-Reference)"]
  u_heading_5_5__Nyquist_Compliance_Discovery["5.5. Nyquist Compliance Discovery"]
  u_heading_6__Aggregate_into_v_version__MILESTONE_AUDIT_md["6. Aggregate into v#123;version#125;-MILESTONE-AUDIT.md"]
  u_heading_7__Present_Results["7. Present Results"]
  wf_root --> u_heading_0__Initialize_Milestone_Context
  u_heading_0__Initialize_Milestone_Context --> u_heading_1__Determine_Milestone_Scope
  u_heading_1__Determine_Milestone_Scope --> u_heading_2__Read_All_Phase_Verifications
  u_heading_2__Read_All_Phase_Verifications --> u_heading_3__Spawn_Integration_Checker
  u_heading_3__Spawn_Integration_Checker --> u_heading_4__Collect_Results
  u_heading_4__Collect_Results --> u_heading_5__Check_Requirements_Coverage__3_Source_Cross_Reference_
  u_heading_5__Check_Requirements_Coverage__3_Source_Cross_Reference_ --> u_heading_5_5__Nyquist_Compliance_Discovery
  u_heading_5_5__Nyquist_Compliance_Discovery --> u_heading_6__Aggregate_into_v_version__MILESTONE_AUDIT_md
  u_heading_6__Aggregate_into_v_version__MILESTONE_AUDIT_md --> u_heading_7__Present_Results
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
    a_gsd_integration_checker[["gsd-integration-checker"]]:::agent
  end
  subgraph g_points["Точки цикла и капабилити"]
    p_verify_post{{"verify#58;post"}}:::point
    c_verify_post_mempalace_skill_mempalace_capture["mempalace#58; skill mempalace-capture"]:::capability
    c_verify_post_nyquist_skill_validate_phase["nyquist#58; skill validate-phase"]:::capability
    c_verify_post_security_skill_secure_phase["security#58; skill secure-phase"]:::capability
    c_verify_post_ui_skill_ui_review["ui#58; skill ui-review"]:::capability
  end
  u_heading_3__Spawn_Integration_Checker["3. Spawn Integration Checker"]
  u_heading_5_5__Nyquist_Compliance_Discovery["5.5. Nyquist Compliance Discovery"]
  u_heading_3__Spawn_Integration_Checker --> a_gsd_integration_checker
  p_verify_post -.-> c_verify_post_mempalace_skill_mempalace_capture
  p_verify_post -.-> c_verify_post_nyquist_skill_validate_phase
  p_verify_post -.-> c_verify_post_security_skill_secure_phase
  p_verify_post -.-> c_verify_post_ui_skill_ui_review
  u_heading_5_5__Nyquist_Compliance_Discovery --> p_verify_post
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
| 1 | `0. Initialize Milestone Context` | H2 |  |  |  |  |
| 2 | `1. Determine Milestone Scope` | H2 |  |  |  |  |
| 3 | `2. Read All Phase Verifications` | H2 |  |  |  |  |
| 4 | `3. Spawn Integration Checker` | H2 |  | `gsd-integration-checker` |  |  |
| 5 | `4. Collect Results` | H2 |  |  |  |  |
| 6 | `5. Check Requirements Coverage (3-Source Cross-Reference)` | H2 |  |  |  |  |
| 7 | `5.5. Nyquist Compliance Discovery` | H2 |  |  | `verify:post` |  |
| 8 | `6. Aggregate into v{version}-MILESTONE-AUDIT.md` | H2 |  |  |  |  |
| 9 | `7. Present Results` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
