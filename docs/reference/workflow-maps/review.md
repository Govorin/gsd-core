<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# review

Источник: `gsd-core/workflows/review.md`. Единицы: 6 шагов `<step>`, 2 секции `gsd:section`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 1; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 1.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["review.md"]):::root
  u_step_detect_clis["detect_clis"]
  u_section_reviewer_instances_note_1("§ reviewer-instances-note-1"):::conditional
  u_step_gather_context["gather_context"]
  u_step_build_prompt["build_prompt"]
  u_step_invoke_reviewers["invoke_reviewers"]
  u_section_reviewer_instances_note_2("§ reviewer-instances-note-2"):::conditional
  u_step_write_reviews["write_reviews"]
  u_step_present_results["present_results"]
  wf_root --> u_step_detect_clis
  u_step_detect_clis -->|"when#58; state#58;reviewer-instances-configured"| u_section_reviewer_instances_note_1
  u_section_reviewer_instances_note_1 --> u_step_gather_context
  u_step_gather_context --> u_step_build_prompt
  u_step_build_prompt --> u_step_invoke_reviewers
  u_step_invoke_reviewers -->|"when#58; state#58;reviewer-instances-configured"| u_section_reviewer_instances_note_2
  u_section_reviewer_instances_note_2 --> u_step_write_reviews
  u_step_write_reviews --> u_step_present_results
  u_step_write_reviews -.->|"goto"| u_step_present_results
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
| 1 | `detect_clis` | step |  |  |  | `review/steps/reviewer-instances-note-1.md` |
| 2 | `reviewer-instances-note-1` | section | when: state:reviewer-instances-configured |  |  | `review/steps/reviewer-instances-note-1.md` |
| 3 | `gather_context` | step |  |  |  |  |
| 4 | `build_prompt` | step |  |  |  |  |
| 5 | `invoke_reviewers` | step |  |  |  | `review/steps/reviewer-instances-note-2.md` |
| 6 | `reviewer-instances-note-2` | section | when: state:reviewer-instances-configured |  |  | `review/steps/reviewer-instances-note-2.md` |
| 7 | `write_reviews` | step |  |  |  |  |
| 8 | `present_results` | step |  |  |  |  |

## Дефекты

Дефектов нет.
