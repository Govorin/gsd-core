<!-- gsd:derived source=scripts/gen-workflow-maps.cjs — regenerated, do not hand-edit -->

# profile-user

Источник: `gsd-core/workflows/profile-user.md`. Единицы: 11 разделов H2. Спавнов: 0. Точки цикла: нет.

> **Переходы в прозе** (фразы «перейди к …»): всего 16; не называют реальный шаг и не рисуются — **4**; названы по имени шага и нарисованы пунктиром `goto` — 12.

Карта построена из разметки workflow: узел — реальный `<step>`, `gsd:section` или раздел H2; рёбра — порядок
документа, условие шага/секции на входящем ребре, переходы по имени шага. Описание обозначений —
в [README](README.md).

## Поток

```mermaid
flowchart TB
  wf_root(["profile-user.md"]):::root
  u_heading_1__Initialize["1. Initialize"]
  u_heading_2__Consent_Gate__ACTV_06_["2. Consent Gate (ACTV-06)"]
  u_heading_3__Session_Scan["3. Session Scan"]
  u_heading_4a__Session_Analysis_Path["4a. Session Analysis Path"]
  u_heading_4b__Questionnaire_Path["4b. Questionnaire Path"]
  u_heading_5__Split_Resolution["5. Split Resolution"]
  u_heading_6__Profile_Write["6. Profile Write"]
  u_heading_7__Result_Display["7. Result Display"]
  u_heading_8__Artifact_Selection__ACTV_05_["8. Artifact Selection (ACTV-05)"]
  u_heading_9__Artifact_Generation["9. Artifact Generation"]
  u_heading_10__Summary___Refresh_Diff["10. Summary & Refresh Diff"]
  wf_root --> u_heading_1__Initialize
  u_heading_1__Initialize --> u_heading_2__Consent_Gate__ACTV_06_
  u_heading_2__Consent_Gate__ACTV_06_ --> u_heading_3__Session_Scan
  u_heading_3__Session_Scan --> u_heading_4a__Session_Analysis_Path
  u_heading_4a__Session_Analysis_Path --> u_heading_4b__Questionnaire_Path
  u_heading_4b__Questionnaire_Path --> u_heading_5__Split_Resolution
  u_heading_5__Split_Resolution --> u_heading_6__Profile_Write
  u_heading_6__Profile_Write --> u_heading_7__Result_Display
  u_heading_7__Result_Display --> u_heading_8__Artifact_Selection__ACTV_05_
  u_heading_8__Artifact_Selection__ACTV_05_ --> u_heading_9__Artifact_Generation
  u_heading_9__Artifact_Generation --> u_heading_10__Summary___Refresh_Diff
  u_heading_1__Initialize -.->|"goto"| u_heading_2__Consent_Gate__ACTV_06_
  u_heading_2__Consent_Gate__ACTV_06_ -.->|"goto"| u_heading_3__Session_Scan
  u_heading_2__Consent_Gate__ACTV_06_ -.->|"goto"| u_heading_4b__Questionnaire_Path
  u_heading_3__Session_Scan -.->|"goto"| u_heading_4b__Questionnaire_Path
  u_heading_3__Session_Scan -.->|"goto"| u_heading_4a__Session_Analysis_Path
  u_heading_4a__Session_Analysis_Path -.->|"goto"| u_heading_5__Split_Resolution
  u_heading_4b__Questionnaire_Path -.->|"goto"| u_heading_5__Split_Resolution
  u_heading_7__Result_Display -.->|"goto"| u_heading_8__Artifact_Selection__ACTV_05_
  u_heading_8__Artifact_Selection__ACTV_05_ -.->|"goto"| u_heading_10__Summary___Refresh_Diff
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
| 1 | `1. Initialize` | H2 |  |  |  |  |
| 2 | `2. Consent Gate (ACTV-06)` | H2 |  |  |  |  |
| 3 | `3. Session Scan` | H2 |  |  |  |  |
| 4 | `4a. Session Analysis Path` | H2 |  |  |  |  |
| 5 | `4b. Questionnaire Path` | H2 |  |  |  |  |
| 6 | `5. Split Resolution` | H2 |  |  |  |  |
| 7 | `6. Profile Write` | H2 |  |  |  |  |
| 8 | `7. Result Display` | H2 |  |  |  |  |
| 9 | `8. Artifact Selection (ACTV-05)` | H2 |  |  |  |  |
| 10 | `9. Artifact Generation` | H2 |  |  |  |  |
| 11 | `10. Summary & Refresh Diff` | H2 |  |  |  |  |

## Дефекты

Дефектов нет.
