<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# validate-phase

Источник: `gsd-core/workflows/validate-phase.md`. Единицы: 9 разделов H2. Спавнов: 1 (агенты: `gsd-nyquist-auditor`). Точки цикла: `verify:post`.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["validate-phase.md"]):::root
  u_heading_0__Initialize["0. Initialize"]
  u_heading_1__Detect_Input_State["1. Detect Input State"]
  u_heading_2__Discovery["2. Discovery"]
  u_heading_3__Gap_Analysis["3. Gap Analysis"]
  u_heading_4__Present_Gap_Plan["4. Present Gap Plan"]
  u_heading_5__Spawn_gsd_nyquist_auditor["5. Spawn gsd-nyquist-auditor"]
  u_heading_6__Generate_Update_VALIDATION_md["6. Generate/Update VALIDATION.md"]
  u_heading_7__Commit["7. Commit"]
  u_heading_8__Results___Routing["8. Results + Routing"]
  wf_root --> u_heading_0__Initialize
  u_heading_0__Initialize --> u_heading_1__Detect_Input_State
  u_heading_1__Detect_Input_State --> u_heading_2__Discovery
  u_heading_2__Discovery --> u_heading_3__Gap_Analysis
  u_heading_3__Gap_Analysis --> u_heading_4__Present_Gap_Plan
  u_heading_4__Present_Gap_Plan --> u_heading_5__Spawn_gsd_nyquist_auditor
  u_heading_5__Spawn_gsd_nyquist_auditor --> u_heading_6__Generate_Update_VALIDATION_md
  u_heading_6__Generate_Update_VALIDATION_md --> u_heading_7__Commit
  u_heading_7__Commit --> u_heading_8__Results___Routing
  u_heading_3__Gap_Analysis -.->|"goto"| u_heading_6__Generate_Update_VALIDATION_md
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
    a_gsd_nyquist_auditor[["gsd-nyquist-auditor"]]:::agent
  end
  subgraph g_points["Точки цикла и капабилити"]
    p_verify_post{{"verify#58;post"}}:::point
    c_verify_post_mempalace_skill_mempalace_capture["mempalace#58; skill mempalace-capture"]:::capability
    c_verify_post_nyquist_skill_validate_phase["nyquist#58; skill validate-phase"]:::capability
    c_verify_post_security_skill_secure_phase["security#58; skill secure-phase"]:::capability
    c_verify_post_ui_skill_ui_review["ui#58; skill ui-review"]:::capability
  end
  u_heading_0__Initialize["0. Initialize"]
  u_heading_5__Spawn_gsd_nyquist_auditor["5. Spawn gsd-nyquist-auditor"]
  u_heading_5__Spawn_gsd_nyquist_auditor --> a_gsd_nyquist_auditor
  p_verify_post -.-> c_verify_post_mempalace_skill_mempalace_capture
  p_verify_post -.-> c_verify_post_nyquist_skill_validate_phase
  p_verify_post -.-> c_verify_post_security_skill_secure_phase
  p_verify_post -.-> c_verify_post_ui_skill_ui_review
  u_heading_0__Initialize --> p_verify_post
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
| 1 | `0. Initialize` | H2 |  |  | `verify:post` |  |
| 2 | `1. Detect Input State` | H2 |  |  |  |  |
| 3 | `2. Discovery` | H2 |  |  |  |  |
| 4 | `3. Gap Analysis` | H2 |  |  |  |  |
| 5 | `4. Present Gap Plan` | H2 |  |  |  |  |
| 6 | `5. Spawn gsd-nyquist-auditor` | H2 |  | `gsd-nyquist-auditor` |  |  |
| 7 | `6. Generate/Update VALIDATION.md` | H2 |  |  |  |  |
| 8 | `7. Commit` | H2 |  |  |  |  |
| 9 | `8. Results + Routing` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
