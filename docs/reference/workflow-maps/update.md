<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# update

Источник: `gsd-core/workflows/update.md`. Единицы: 10 шагов `<step>`, 1 секция `gsd:section`. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 3; не называют реальный шаг и не рисуются — **3**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["update.md"]):::root
  u_step_get_installed_version["get_installed_version"]
  u_step_parse_update_channel["parse_update_channel"]
  u_step_check_latest_version["check_latest_version"]
  u_step_compare_versions["compare_versions"]
  u_section_channel_banner("§ channel-banner"):::conditional
  u_step_show_changes_and_confirm["show_changes_and_confirm"]
  u_step_backup_custom_files["backup_custom_files"]
  u_step_run_update["run_update"]
  u_step_display_result["display_result"]
  u_step_restore_custom_files["restore_custom_files"]
  u_step_check_local_patches["check_local_patches"]
  wf_root --> u_step_get_installed_version
  u_step_get_installed_version --> u_step_parse_update_channel
  u_step_parse_update_channel --> u_step_check_latest_version
  u_step_check_latest_version --> u_step_compare_versions
  u_step_compare_versions -->|"when#58; state#58;next-channel"| u_section_channel_banner
  u_section_channel_banner --> u_step_show_changes_and_confirm
  u_step_show_changes_and_confirm --> u_step_backup_custom_files
  u_step_backup_custom_files --> u_step_run_update
  u_step_run_update --> u_step_display_result
  u_step_display_result --> u_step_restore_custom_files
  u_step_restore_custom_files --> u_step_check_local_patches
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
| 1 | `get_installed_version` | step |  |  |  |  |
| 2 | `parse_update_channel` | step |  |  |  |  |
| 3 | `check_latest_version` | step |  |  |  |  |
| 4 | `compare_versions` | step |  |  |  | `update/steps/channel-banner.md` |
| 5 | `channel-banner` | section | when: state:next-channel |  |  | `update/steps/channel-banner.md` |
| 6 | `show_changes_and_confirm` | step |  |  |  |  |
| 7 | `backup_custom_files` | step |  |  |  |  |
| 8 | `run_update` | step |  |  |  |  |
| 9 | `display_result` | step |  |  |  |  |
| 10 | `restore_custom_files` | step |  |  |  |  |
| 11 | `check_local_patches` | step |  |  |  |  |

## Дефекты

Дефектов нет.
