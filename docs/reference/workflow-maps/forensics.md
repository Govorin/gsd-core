<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# forensics

Источник: `gsd-core/workflows/forensics.md`. Единицы: 8 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 0; не называют реальный шаг и не рисуются — **0**; названы по имени шага и нарисованы пунктиром `goto` — 0.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["forensics.md"]):::root
  u_heading_Step_1__Get_Problem_Description["Step 1#58; Get Problem Description"]
  u_heading_Step_2__Gather_Evidence["Step 2#58; Gather Evidence"]
  u_heading_Step_3__Detect_Anomalies["Step 3#58; Detect Anomalies"]
  u_heading_Step_4__Generate_Report["Step 4#58; Generate Report"]
  u_heading_Step_5__Present_Report["Step 5#58; Present Report"]
  u_heading_Step_6__Offer_Interactive_Investigation["Step 6#58; Offer Interactive Investigation"]
  u_heading_Step_7__Offer_Issue_Creation["Step 7#58; Offer Issue Creation"]
  u_heading_Step_8__Update_STATE_md["Step 8#58; Update STATE.md"]
  wf_root --> u_heading_Step_1__Get_Problem_Description
  u_heading_Step_1__Get_Problem_Description --> u_heading_Step_2__Gather_Evidence
  u_heading_Step_2__Gather_Evidence --> u_heading_Step_3__Detect_Anomalies
  u_heading_Step_3__Detect_Anomalies --> u_heading_Step_4__Generate_Report
  u_heading_Step_4__Generate_Report --> u_heading_Step_5__Present_Report
  u_heading_Step_5__Present_Report --> u_heading_Step_6__Offer_Interactive_Investigation
  u_heading_Step_6__Offer_Interactive_Investigation --> u_heading_Step_7__Offer_Issue_Creation
  u_heading_Step_7__Offer_Issue_Creation --> u_heading_Step_8__Update_STATE_md
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
| 1 | `Step 1: Get Problem Description` | H2 |  |  |  |  |
| 2 | `Step 2: Gather Evidence` | H2 |  |  |  |  |
| 3 | `Step 3: Detect Anomalies` | H2 |  |  |  |  |
| 4 | `Step 4: Generate Report` | H2 |  |  |  |  |
| 5 | `Step 5: Present Report` | H2 |  |  |  |  |
| 6 | `Step 6: Offer Interactive Investigation` | H2 |  |  |  |  |
| 7 | `Step 7: Offer Issue Creation` | H2 |  |  |  |  |
| 8 | `Step 8: Update STATE.md` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
