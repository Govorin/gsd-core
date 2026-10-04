<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# edit-phase

Источник: `gsd-core/workflows/edit-phase.md`. Единицы: 10 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **1**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["edit-phase.md"]):::root
  u_step_parse_arguments["parse_arguments"]
  u_step_init_context["init_context"]
  u_step_load_phase["load_phase"]
  u_step_check_phase_status["check_phase_status"]
  u_step_present_current_values["present_current_values"]
  u_step_collect_edits["collect_edits"]
  u_step_validate_depends_on["validate_depends_on"]
  u_step_show_diff_and_confirm["show_diff_and_confirm"]
  u_step_write_updated_phase["write_updated_phase"]
  u_step_completion["completion"]
  wf_root --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_init_context
  u_step_init_context --> u_step_load_phase
  u_step_load_phase --> u_step_check_phase_status
  u_step_check_phase_status --> u_step_present_current_values
  u_step_present_current_values --> u_step_collect_edits
  u_step_collect_edits --> u_step_validate_depends_on
  u_step_validate_depends_on --> u_step_show_diff_and_confirm
  u_step_show_diff_and_confirm --> u_step_write_updated_phase
  u_step_write_updated_phase --> u_step_completion
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
| 1 | `parse_arguments` | step |  |  |  |  |
| 2 | `init_context` | step |  |  |  |  |
| 3 | `load_phase` | step |  |  |  |  |
| 4 | `check_phase_status` | step |  |  |  |  |
| 5 | `present_current_values` | step |  |  |  |  |
| 6 | `collect_edits` | step |  |  |  |  |
| 7 | `validate_depends_on` | step |  |  |  |  |
| 8 | `show_diff_and_confirm` | step |  |  |  |  |
| 9 | `write_updated_phase` | step |  |  |  |  |
| 10 | `completion` | step |  |  |  |  |

## Дефекты

Дефектов нет.
