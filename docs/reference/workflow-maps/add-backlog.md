<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# add-backlog

Источник: `gsd-core/workflows/add-backlog.md`. Единицы: 6 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["add-backlog.md"]):::root
  u_heading_Step_1__Read_ROADMAP_md["Step 1#58; Read ROADMAP.md"]
  u_heading_Step_2__Find_next_backlog_number["Step 2#58; Find next backlog number"]
  u_heading_Step_3__Write_ROADMAP_entry["Step 3#58; Write ROADMAP entry"]
  u_heading_Step_4__Create_the_phase_directory["Step 4#58; Create the phase directory"]
  u_heading_Step_5__Commit["Step 5#58; Commit"]
  u_heading_Step_6__Report["Step 6#58; Report"]
  wf_root --> u_heading_Step_1__Read_ROADMAP_md
  u_heading_Step_1__Read_ROADMAP_md --> u_heading_Step_2__Find_next_backlog_number
  u_heading_Step_2__Find_next_backlog_number --> u_heading_Step_3__Write_ROADMAP_entry
  u_heading_Step_3__Write_ROADMAP_entry --> u_heading_Step_4__Create_the_phase_directory
  u_heading_Step_4__Create_the_phase_directory --> u_heading_Step_5__Commit
  u_heading_Step_5__Commit --> u_heading_Step_6__Report
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
| 1 | `Step 1: Read ROADMAP.md` | H2 |  |  |  |  |
| 2 | `Step 2: Find next backlog number` | H2 |  |  |  |  |
| 3 | `Step 3: Write ROADMAP entry` | H2 |  |  |  |  |
| 4 | `Step 4: Create the phase directory` | H2 |  |  |  |  |
| 5 | `Step 5: Commit` | H2 |  |  |  |  |
| 6 | `Step 6: Report` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
