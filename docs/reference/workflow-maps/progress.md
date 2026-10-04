<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# progress

Источник: `gsd-core/workflows/progress.md`. Единицы: 8 шагов `<step>`, 2 секции `gsd:section`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 16; не называют реальный шаг и не рисуются — **16**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["progress.md"]):::root
  u_step_init_context["init_context"]
  u_step_load["load"]
  u_step_analyze_roadmap["analyze_roadmap"]
  u_step_recent["recent"]
  u_step_position["position"]
  u_step_report["report"]
  u_section_mvp_display("§ mvp-display"):::conditional
  u_step_route["route"]
  u_step_edge_cases["edge_cases"]
  u_section_forensic_audit("§ forensic-audit"):::conditional
  wf_root --> u_step_init_context
  u_step_init_context --> u_step_load
  u_step_load --> u_step_analyze_roadmap
  u_step_analyze_roadmap --> u_step_recent
  u_step_recent --> u_step_position
  u_step_position --> u_step_report
  u_step_report -->|"when#58; state#58;phase-mvp-mode"| u_section_mvp_display
  u_section_mvp_display --> u_step_route
  u_step_route --> u_step_edge_cases
  u_step_edge_cases -->|"when#58; flag#58;#45;#45;forensic"| u_section_forensic_audit
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
| — | (вне единиц) | — | — |  |  | `progress/steps/mvp-display.md`, `progress/steps/forensic-audit.md` |
| 1 | `init_context` | step |  |  |  |  |
| 2 | `load` | step |  |  |  |  |
| 3 | `analyze_roadmap` | step |  |  |  |  |
| 4 | `recent` | step |  |  |  |  |
| 5 | `position` | step |  |  |  |  |
| 6 | `report` | step |  |  |  |  |
| 7 | `mvp-display` | section | when: state:phase-mvp-mode |  |  | `progress/steps/mvp-display.md` |
| 8 | `route` | step |  |  |  |  |
| 9 | `edge_cases` | step |  |  |  |  |
| 10 | `forensic-audit` | section | when: flag:--forensic |  |  | `progress/steps/forensic-audit.md` |

## Дефекты

Дефектов нет.
