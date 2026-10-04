<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# reapply-patches

Источник: `gsd-core/workflows/reapply-patches.md`. Единицы: 7 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 4; не называют реальный шаг и не рисуются — **4**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["reapply-patches.md"]):::root
  u_heading_Step_1__Detect_backed_up_patches["Step 1#58; Detect backed-up patches"]
  u_heading_Step_2__Determine_baseline_for_three_way_comparison["Step 2#58; Determine baseline for three-way comparison"]
  u_heading_Step_3__Show_patch_summary["Step 3#58; Show patch summary"]
  u_heading_Step_4__Merge_each_file["Step 4#58; Merge each file"]
  u_heading_Step_5__Hunk_Verification_Gate["Step 5#58; Hunk Verification Gate"]
  u_heading_Step_6__Cleanup_option["Step 6#58; Cleanup option"]
  u_heading_Step_7__Report["Step 7#58; Report"]
  wf_root --> u_heading_Step_1__Detect_backed_up_patches
  u_heading_Step_1__Detect_backed_up_patches --> u_heading_Step_2__Determine_baseline_for_three_way_comparison
  u_heading_Step_2__Determine_baseline_for_three_way_comparison --> u_heading_Step_3__Show_patch_summary
  u_heading_Step_3__Show_patch_summary --> u_heading_Step_4__Merge_each_file
  u_heading_Step_4__Merge_each_file --> u_heading_Step_5__Hunk_Verification_Gate
  u_heading_Step_5__Hunk_Verification_Gate --> u_heading_Step_6__Cleanup_option
  u_heading_Step_6__Cleanup_option --> u_heading_Step_7__Report
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
| 1 | `Step 1: Detect backed-up patches` | H2 |  |  |  |  |
| 2 | `Step 2: Determine baseline for three-way comparison` | H2 |  |  |  |  |
| 3 | `Step 3: Show patch summary` | H2 |  |  |  |  |
| 4 | `Step 4: Merge each file` | H2 |  |  |  |  |
| 5 | `Step 5: Hunk Verification Gate` | H2 |  |  |  |  |
| 6 | `Step 6: Cleanup option` | H2 |  |  |  |  |
| 7 | `Step 7: Report` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
