<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# explore

Источник: `gsd-core/workflows/explore.md`. Единицы: 6 разделов H2. Спавнов: 1 (агенты: `gsd-phase-researcher`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **3**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["explore.md"]):::root
  u_heading_Step_1__Open_the_conversation["Step 1#58; Open the conversation"]
  u_heading_Step_2__Socratic_conversation__2_5_exchanges_["Step 2#58; Socratic conversation (2-5 exchanges)"]
  u_heading_Step_3__Mid_conversation_research_offer__after_2_3_exchanges_["Step 3#58; Mid-conversation research offer (after 2-3 exchanges)"]
  u_heading_Step_4__Crystallize_outputs__after_3_6_exchanges_["Step 4#58; Crystallize outputs (after 3-6 exchanges)"]
  u_heading_Step_5__Write_selected_outputs["Step 5#58; Write selected outputs"]
  u_heading_Step_6__Close["Step 6#58; Close"]
  wf_root --> u_heading_Step_1__Open_the_conversation
  u_heading_Step_1__Open_the_conversation --> u_heading_Step_2__Socratic_conversation__2_5_exchanges_
  u_heading_Step_2__Socratic_conversation__2_5_exchanges_ --> u_heading_Step_3__Mid_conversation_research_offer__after_2_3_exchanges_
  u_heading_Step_3__Mid_conversation_research_offer__after_2_3_exchanges_ --> u_heading_Step_4__Crystallize_outputs__after_3_6_exchanges_
  u_heading_Step_4__Crystallize_outputs__after_3_6_exchanges_ --> u_heading_Step_5__Write_selected_outputs
  u_heading_Step_5__Write_selected_outputs --> u_heading_Step_6__Close
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
  end
  u_heading_Step_3__Mid_conversation_research_offer__after_2_3_exchanges_["Step 3#58; Mid-conversation research offer (after 2-3 exchanges)"]
  u_heading_Step_3__Mid_conversation_research_offer__after_2_3_exchanges_ --> a_gsd_phase_researcher
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
| 1 | `Step 1: Open the conversation` | H2 |  |  |  |  |
| 2 | `Step 2: Socratic conversation (2-5 exchanges)` | H2 |  |  |  |  |
| 3 | `Step 3: Mid-conversation research offer (after 2-3 exchanges)` | H2 |  | `gsd-phase-researcher` |  |  |
| 4 | `Step 4: Crystallize outputs (after 3-6 exchanges)` | H2 |  |  |  |  |
| 5 | `Step 5: Write selected outputs` | H2 |  |  |  |  |
| 6 | `Step 6: Close` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
