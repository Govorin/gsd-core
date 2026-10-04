<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# settings-integrations

Источник: `gsd-core/workflows/settings-integrations.md`. Единицы: 6 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 2; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["settings-integrations.md"]):::root
  u_step_ensure_and_load_config["ensure_and_load_config"]
  u_step_read_current["read_current"]
  u_step_section_1_search_integrations["section_1_search_integrations"]
  u_step_section_2_review_models["section_2_review_models"]
  u_step_section_3_agent_skills["section_3_agent_skills"]
  u_step_confirm["confirm"]
  wf_root --> u_step_ensure_and_load_config
  u_step_ensure_and_load_config --> u_step_read_current
  u_step_read_current --> u_step_section_1_search_integrations
  u_step_section_1_search_integrations --> u_step_section_2_review_models
  u_step_section_2_review_models --> u_step_section_3_agent_skills
  u_step_section_3_agent_skills --> u_step_confirm
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
| 1 | `ensure_and_load_config` | step |  |  |  |  |
| 2 | `read_current` | step |  |  |  |  |
| 3 | `section_1_search_integrations` | step |  |  |  |  |
| 4 | `section_2_review_models` | step |  |  |  |  |
| 5 | `section_3_agent_skills` | step |  |  |  |  |
| 6 | `confirm` | step |  |  |  |  |

## Дефекты

Дефектов нет.
