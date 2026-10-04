<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# plant-seed

Источник: `gsd-core/workflows/plant-seed.md`. Единицы: 8 шагов `<step>`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["plant-seed.md"]):::root
  u_step_parse_idea["parse-idea"]
  u_step_create_seed_dir["create-seed-dir"]
  u_step_generate_seed_id["generate-seed-id"]
  u_step_write_seed["write-seed"]
  u_step_collect_breadcrumbs["collect-breadcrumbs"]
  u_step_commit_seed["commit-seed"]
  u_step_confirm["confirm"]
  u_step_enrich_seed["enrich-seed"]
  wf_root --> u_step_parse_idea
  u_step_parse_idea --> u_step_create_seed_dir
  u_step_create_seed_dir --> u_step_generate_seed_id
  u_step_generate_seed_id --> u_step_write_seed
  u_step_write_seed --> u_step_collect_breadcrumbs
  u_step_collect_breadcrumbs --> u_step_commit_seed
  u_step_commit_seed --> u_step_confirm
  u_step_confirm --> u_step_enrich_seed
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
| 1 | `parse-idea` | step |  |  |  |  |
| 2 | `create-seed-dir` | step |  |  |  |  |
| 3 | `generate-seed-id` | step |  |  |  |  |
| 4 | `write-seed` | step |  |  |  |  |
| 5 | `collect-breadcrumbs` | step |  |  |  |  |
| 6 | `commit-seed` | step |  |  |  |  |
| 7 | `confirm` | step |  |  |  |  |
| 8 | `enrich-seed` | step |  |  |  |  |

## Дефекты

Дефектов нет.
