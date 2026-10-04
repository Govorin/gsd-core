<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# next

Источник: `gsd-core/workflows/next.md`. Единицы: 7 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 9; не называют реальный шаг и не рисуются — **4**; названы по имени шага и нарисованы пунктиром `goto` — 5.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["next.md"]):::root
  u_step_detect_state["detect_state"]
  u_step_safety_gates["safety_gates"]
  u_step_resume_incomplete_phase["resume_incomplete_phase"]
  u_step_prior_phase_completeness["prior_phase_completeness"]
  u_step_spike_sketch_notice["spike_sketch_notice"]
  u_step_determine_next_action["determine_next_action"]
  u_step_show_and_execute["show_and_execute"]
  wf_root --> u_step_detect_state
  u_step_detect_state --> u_step_safety_gates
  u_step_safety_gates --> u_step_resume_incomplete_phase
  u_step_resume_incomplete_phase --> u_step_prior_phase_completeness
  u_step_prior_phase_completeness --> u_step_spike_sketch_notice
  u_step_spike_sketch_notice --> u_step_determine_next_action
  u_step_determine_next_action --> u_step_show_and_execute
  u_step_safety_gates -.->|"goto"| u_step_determine_next_action
  u_step_safety_gates -.->|"goto"| u_step_resume_incomplete_phase
  u_step_resume_incomplete_phase -.->|"goto"| u_step_prior_phase_completeness
  u_step_prior_phase_completeness -.->|"goto"| u_step_determine_next_action
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
| 1 | `detect_state` | step |  |  |  |  |
| 2 | `safety_gates` | step |  |  |  |  |
| 3 | `resume_incomplete_phase` | step |  |  |  |  |
| 4 | `prior_phase_completeness` | step |  |  |  |  |
| 5 | `spike_sketch_notice` | step |  |  |  |  |
| 6 | `determine_next_action` | step |  |  |  |  |
| 7 | `show_and_execute` | step |  |  |  |  |

## Дефекты

Дефектов нет.
