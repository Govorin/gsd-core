<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# debug

Источник: `gsd-core/workflows/debug.md`. Единицы: 8 разделов H2. Спавнов: 3 (агенты: `gsd-debug-session-manager`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **3**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["debug.md"]):::root
  u_heading_0__Initialize_Context["0. Initialize Context"]
  u_heading_1a__LIST_subcommand["1a. LIST subcommand"]
  u_heading_1b__STATUS_subcommand["1b. STATUS subcommand"]
  u_heading_1c__CONTINUE_subcommand["1c. CONTINUE subcommand"]
  u_heading_1d__Check_Active_Sessions__SUBCMD_debug_["1d. Check Active Sessions (SUBCMD=debug)"]
  u_heading_2__Gather_Symptoms__if_new_issue__SUBCMD_debug_["2. Gather Symptoms (if new issue, SUBCMD=debug)"]
  u_heading_3__Initial_Session_Setup__new_session_["3. Initial Session Setup (new session)"]
  u_heading_4__Session_Management__delegated_to_gsd_debug_session_manager_["4. Session Management (delegated to gsd-debug-session-manager)"]
  wf_root --> u_heading_0__Initialize_Context
  u_heading_0__Initialize_Context --> u_heading_1a__LIST_subcommand
  u_heading_1a__LIST_subcommand --> u_heading_1b__STATUS_subcommand
  u_heading_1b__STATUS_subcommand --> u_heading_1c__CONTINUE_subcommand
  u_heading_1c__CONTINUE_subcommand --> u_heading_1d__Check_Active_Sessions__SUBCMD_debug_
  u_heading_1d__Check_Active_Sessions__SUBCMD_debug_ --> u_heading_2__Gather_Symptoms__if_new_issue__SUBCMD_debug_
  u_heading_2__Gather_Symptoms__if_new_issue__SUBCMD_debug_ --> u_heading_3__Initial_Session_Setup__new_session_
  u_heading_3__Initial_Session_Setup__new_session_ --> u_heading_4__Session_Management__delegated_to_gsd_debug_session_manager_
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
    a_gsd_debug_session_manager[["gsd-debug-session-manager"]]:::agent
  end
  u_heading_1c__CONTINUE_subcommand["1c. CONTINUE subcommand"]
  u_heading_4__Session_Management__delegated_to_gsd_debug_session_manager_["4. Session Management (delegated to gsd-debug-session-manager)"]
  u_heading_1c__CONTINUE_subcommand --> a_gsd_debug_session_manager
  u_heading_4__Session_Management__delegated_to_gsd_debug_session_manager_ --> a_gsd_debug_session_manager
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
| 1 | `0. Initialize Context` | H2 |  |  |  |  |
| 2 | `1a. LIST subcommand` | H2 |  |  |  |  |
| 3 | `1b. STATUS subcommand` | H2 |  |  |  |  |
| 4 | `1c. CONTINUE subcommand` | H2 |  | `gsd-debug-session-manager` |  |  |
| 5 | `1d. Check Active Sessions (SUBCMD=debug)` | H2 |  |  |  |  |
| 6 | `2. Gather Symptoms (if new issue, SUBCMD=debug)` | H2 |  |  |  |  |
| 7 | `3. Initial Session Setup (new session)` | H2 |  |  |  |  |
| 8 | `4. Session Management (delegated to gsd-debug-session-manager)` | H2 |  | `gsd-debug-session-manager` |  |  |

## Дефекты

Дефектов нет.
