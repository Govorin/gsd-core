<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# audit-fix

Источник: `gsd-core/workflows/audit-fix.md`. Единицы: 7 шагов `<step>`. Спавнов: 1 (агенты: `gsd-executor`). Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 2; не называют реальный шаг и не рисуются — **2**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["audit-fix.md"]):::root
  u_step_parse_arguments["parse-arguments"]
  u_step_run_audit["run-audit"]
  u_step_classify_findings["classify-findings"]
  u_step_present_classification["present-classification"]
  u_step_fix_loop["fix-loop"]
  u_step_window_bookkeeping["window-bookkeeping"]
  u_step_report["report"]
  wf_root --> u_step_parse_arguments
  u_step_parse_arguments --> u_step_run_audit
  u_step_run_audit --> u_step_classify_findings
  u_step_classify_findings --> u_step_present_classification
  u_step_present_classification --> u_step_fix_loop
  u_step_fix_loop --> u_step_window_bookkeeping
  u_step_window_bookkeeping --> u_step_report
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
    a_gsd_executor[["gsd-executor"]]:::agent
  end
  u_step_fix_loop["fix-loop"]
  u_step_fix_loop --> a_gsd_executor
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
| 1 | `parse-arguments` | step |  |  |  |  |
| 2 | `run-audit` | step |  |  |  |  |
| 3 | `classify-findings` | step |  |  |  |  |
| 4 | `present-classification` | step |  |  |  |  |
| 5 | `fix-loop` | step |  | `gsd-executor` |  |  |
| 6 | `window-bookkeeping` | step |  |  |  |  |
| 7 | `report` | step |  |  |  |  |

## Дефекты

Дефектов нет.
