# Harness-практики, август 2026 — что внедрять в форк

Дата: 2026-08-20. Ветка: `feat/mn-verify-gate`.
Метод: шесть параллельных исследований — (1) инвентарь механизмов форка, (2) измеренные результаты
(arXiv/METR/вендорские ablation-и, IX.2025–VIII.2026), (3) OSS-фреймворки и их конвергенция,
(4) актуальная платформа Claude Code (31 hook-событие, subagent-frontmatter, `/goal`, worktree-хуки),
(5) гайдлайны Anthropic (22 поста IX.2025–VII.2026), (6) аудит реального использования в
`$mn` (10 `.planning/`-корней, 6 257 коммитов) и `$awe` (3 корня, 207 фаз, 29 milestone-ов).
Подробный отчёт по Anthropic лежит рядом: `research-anthropic-harness-guidance-2026-08.md`.

---

## 0. TL;DR

Форк уже покрывает большую часть «модной» поверхности: fresh context per agent, гейты на 12 точках
loop-а, независимый verifier с abstention, plan-checker, ratchets, worktree-изоляция, injection-сканер.
Пробелы лежат не в «ещё одном агенте», а в **четырёх классах**, по которым есть измеренные данные
и одновременно — зафиксированная боль в `mn`/`awe`:

| # | Класс | Evidence | Боль в mn/awe |
|---|---|---|---|
| A | **Enforcement хуками, а не prompt-ом** — запреты плана, exit-gate исполнителя, re-injection инвариантов после compaction | governance decay 0→59 % после compaction, constraint pinning → 0 % (измерено); «CLAUDE.md is context, hooks are enforcement» (Anthropic) | `quality-gate.sh` Stop-hook уже написан вручную в `mn`; 858-строчный CLAUDE.md; wave-коллизии по файлам |
| B | **Гейт-результаты как поля, заполняемые инструментом, а не прозой verifier-а** | «lucky pass», SpecBench (скрытые тесты vs видимые), «verifier must be nearly perfect» | Лучшие VERIFICATION.md (`norn/13`, `root/03`, `ucars/16`) делают это вручную; большинство — 0 command-блоков |
| C | **Явные stop-conditions и бюджеты автономии** | MAX_TURNS/time-exhaustion — доминирующий класс провалов; «clean stop» harness в 40× дешевле за решённую задачу | `/gsd-autonomous` без cap-а по токенам/итерациям; `AskUserQuestion` таймауты дефолтятся |
| D | **Надёжность worktree-изоляции** | анекдотично, но конвергентно (Cursor/Codex/CC 2.1.222 fix) | **#1 operational failure** в ретро `ucars`: stale base, «Initial commit», 380 коммитов позади, 47 брошенных деревьев, MCP не доступен в worktree-агентах |

Что **не** делать (популярно, но опровергнуто или без данных): толстый CLAUDE.md как рычаг качества;
принудительный TDD как гарантия; рой параллельных писателей; иерархия «дешёвый планировщик → дорогой
эскалатор»; многослойная summarization-compaction; панель из 5 критиков на каждый план.

---

## 1. Что у форка уже есть (чтобы не предлагать существующее)

Сжатая выжимка инвентаря (полный — в отчёте субагента, ключевые файлы указаны):

- **Loop-точки:** `discuss|plan|execute|verify|ship : pre|post` + `execute:wave:pre|post`
  (`src/loop-resolver.cts`). Predicate kinds: `command-exit-zero`, `artifact-frontmatter-equals`
  (`src/gate-predicate-evaluator.cts`; второй отсутствует в установленном 1.9.1 — BACKLOG).
- **Верификация:** `gsd-verifier` (goal-backward, `spec_truths`, abstention-статусы), `gsd-plan-checker`
  (7 измерений), nyquist, security, broken-windows, architecture (advisory), drift, schema-gate,
  plan-drift-guard, review lanes + cross-AI convergence, `mn-verify-gate` (12 гейтов, все
  `command-exit-zero`, все **default off**): assertion-ratchet, blast-radius, contract-drift,
  orphan-plans, migration-safety, wave-collision/wave-solve, verify/nyquist/security/windows enforce.
- **Контекст:** fresh context per agent, `context-budget.md`, `gsd-context-monitor.js`
  (PreCompact/SubagentStop/Stop, 35 %/25 %), size-ratchet (ADR-1610), section-manifest `when=`
  (только workflows, не агенты), agent_skills dual injection (ADR-1866).
- **Автономия:** `/gsd-autonomous` + `handle_blocker` → `WAITING.json`; checkpoints
  (`blocking-human` не авто-апрувится); лимиты только `max_concurrent_agents=3`, таймауты гейтов,
  `--to N`. **Нет** token/cost-бюджета и cap-а итераций.
- **Память:** extract-learnings → `LEARNINGS-DIGEST.md` (окно 3 фазы), graduation, retrospective,
  mempalace/intel/graphify (off).
- **Изоляция:** worktree (harness/orchestrator/none, fail-closed), `gsd-agent-isolation-guard`,
  `gsd-worktree-path-guard`, `gsd-write-guard`, `gsd-prompt-guard`, `gsd-read-injection-scanner`.
- **Качество самого harness-а:** тесты на байты промптов, emitted-attribution, golden parity, ratchets,
  Stryker 80 %, loop-walk QA (ADR-2966). **Нет** behavioural eval-ов агентов (только байты и loop-walk).
- **Hook-bus:** `PORTABLE_EVENT_FLOOR` = SessionStart/PreToolUse/PostToolUse/Stop/SessionEnd;
  `hooks.json` не использует `PostCompact`, `WorktreeCreate/Remove`, `SubagentStop` для гейтов,
  `TaskCompleted`.

Открытые пункты самого форка (worklog/BACKLOG): waves в коде (26/174 фаз нарушают
«одна волна — непересекающиеся файлы»), lifecycle-status в frontmatter плана, template layout,
дубликат-детекторы не в commit path, nested-`.planning/` резолвинг, `phase.complete` не пересчитывает
progress/traceability.

---

## 2. Evidence-карта: что реально измерено

Ранжировано по силе данных. «Измерено» = контролируемое сравнение с числами; «анекдот» = production-опыт
без контроля; «мнение» = рекомендация без данных.

### 2.1 Сильные данные (внедрять)

| Практика | Результат | Источник |
|---|---|---|
| **Независимый/adversarial verifier вместо self-check** | parallel rollouts + tournament: Opus 4.5 SWE-V 70.9→77.6, TB2 46.9→59.1; agentic judges: hacked-resolved 28.6 %→0.6 %; Devin Review: 2 бага/PR, лучше при раздельных контекстах | arXiv 2604.16529; 2606.26300; cognition.com/blog/multi-agents-working |
| **Скрытые проверки, не видимые, как критерий done** | разрыв visible/hidden тестов растёт ~28 п.п. на 10× размера кода; агент собрал 2 900-строчную hash-таблицу под тесты | SpecBench arXiv 2605.21384; CapCode 2606.07379 |
| **Constraint pinning после compaction** | нарушение правил после compaction 0→59 % (DeepSeek-V4), 0→41 % (GPT-5.4-mini); pinning ~47 токенов → 0 % | arXiv 2606.22528 |
| **Структурированная детерминированная компакция / reset вместо summarization** | model-free eviction = fresh per-task сессии (68.25 vs 68.40 % TB2) при −20…70 % стоимости; latent compression: 7 vs 86 решённых SWE-V | arXiv 2606.11213; 2605.11051; Factory compression eval |
| **Короткий контекст для verifier/monitor** | Opus 4.6/GPT-5.4/Gemini 3.1 пропускают опасное действие в 2–30× чаще после 800K токенов | Martin & Roger, V.2026 |
| **Tool-output pruning** | +2.6 % точности при −52 % стоимости; unfiltered context — нейтрально/отрицательно | JetBrains NeurIPS-25 WS; SWE-ContextBench |
| **Harness — рычаг стоимости, модель — рычаг способности** | pass-rate между harness-ами ±2–8 п.п., токены/решение — 40×; MAX_TURNS и time-exhaustion — главные fingerprints провала | arXiv 2607.22585; TB2 paper; METR 2026-02-13 |
| **Mutation-guided тесты** | +8.56 % fault detection над лучшим LLM-методом; Meta production 73 % acceptance | arXiv 2602.08146; engineering.fb.com 2025-09-30 |
| **Observability-driven эволюция harness-а** | TB2 69.7→77.0 за 10 итераций; gains из tools/middleware/memory, **не** из system prompt | AHE arXiv 2604.25850 |

### 2.2 Популярно, но не подтверждено или опровергнуто (не тратить усилия)

| Практика | Что показали данные | Источник |
|---|---|---|
| Большой AGENTS.md/CLAUDE.md как рычаг корректности | Claude 53.3→55.6 %, Codex 58.8→52.9–56.9 % — незначимо; эффект только на эффективность. OpenAI: ≤100 строк как карта | arXiv 2607.27250; openai.com/index/harness-engineering |
| «Пиши тесты первым» как гарантия | +20 % токенов, без прироста resolution; тесты работают как debugging probes | arXiv 2602.07900 |
| Reflexion/итеративный self-review | recall 27→33 %, SNR 5.11→1.95 | arXiv 2603.11078 |
| Рой параллельных писателей / автономные сети агентов | MAST: 41–87 % failure; Cognition отказалась после production | arXiv 2503.13657; Cognition IV.2026 |
| Иерархия «дешёвая модель → дорогая» | потолок качества съедает экономию; работает только frontier-peer делегирование | Cognition IV.2026 |
| Жёсткое следование плану | лучшие агенты отклоняются тактически; over-anchoring — измеренный провал | METR 2026-02-13; ASE'26 2604.12147 |
| Coverage-ratchets, DoD-чеклисты, commit-per-task, worktrees | широко рекомендуется, **контролируемых измерений нет** — гигиена, не рычаг | — |
| Config-файловые sandbox-ограничения | обойдены в Cursor/Codex/Gemini CLI/Antigravity без атаки на границу | CSA, Microsoft V.2026 |

### 2.3 Что говорит Anthropic (VIII.2026) — применимо к форку напрямую

- «Put the judge in a different context than the worker» — `/goal` (Stop-hook с fresh Haiku-судьёй),
  Managed Agents Outcomes (grader в отдельном окне, `max_iterations` 3/20).
- «Enforce with hooks, instruct with CLAUDE.md» — `PreToolUse` deny/`updatedInput`,
  `TaskCompleted`/`TeammateIdle`/`SubagentStop` exit-2; CLAUDE.md <200 строк, `.claude/rules/*.md` с `paths:`.
- «Verifier must be nearly perfect, otherwise Claude will solve the wrong problem» (C-compiler post).
- JSON для machine-owned state, Markdown — для людей («model is less likely to overwrite JSON»).
- Re-validate every harness assumption on each new model (Opus 4.6 убрал sprint-декомпозицию; Fable 5
  получает от памяти 3× больше, чем Opus 4.8).
- Prompt-cache: не менять model/effort посреди фазы, skills — append, fork-subagents делят кэш,
  subagent cache TTL 5 мин даже на подписке.
- Postmortem 23.04: ablation-тест на каждое изменение system prompt; soak; dogfood публичной сборки.

### 2.4 Конвергенция OSS (≥3 фреймворка независимо)

Fresh context per unit · file-based state · spec→plan→tasks с checkpoint-ом · hooks на lifecycle ·
worktree-изоляция · multi-perspective review · «verification as evidence» · autonomous loop со stop-условиями ·
learnings-loop · drift-detection артефакт↔код · selective injection стандартов через индекс ·
**минимализм как контр-тренд** (Pi, mini-SWE-agent, Agent OS v3, OpenSpec delta specs).

Идеи, которых у форка нет: `converge` (Spec Kit) — diff кодовой базы против spec/plan и дописать gap
как задачи; hashline edits (OMO); Kiro PBT-из-spec как evidence с привязкой к REQ-ID; gstack `/learn`
quarantine→graduation после 3 успехов (у форка graduation есть); egress hash-chain receipts;
Todo-continuation enforcer с evidence-audit (OMO) ≈ `/goal`.

Upstream GSD (1.11.0 от 2026-08-19): plan drift guard стал cross-artifact; declared-scope diff
validation для wave-веток; coincidental-reliance flagging в verifier; estimate→actual calibration (1.9);
catastrophic-shrink guard (1.10). Форк отстал на 672 коммита/30 д — часть `mn-verify-gate` гейтов
(blast-radius, wave-collision) могут схлопнуться в config после синка.

---

## 3. Что нужно вашему workflow (из аудита mn/awe)

Двенадцать наблюдений субагента, сжатые до тех, что меняют приоритеты:

1. **Nested `.planning/` в монорепе — основная топология** (10 + 3 корня). Все path-баги из ретро —
   отсюда. Без детерминированного резолвинга (ближайший `.planning/` для state, repo-root для skills)
   любые новые гейты будут стрелять по неверному корню.
2. **Milestone-scoped tooling**: 207 фаз в одном каталоге; `roadmap analyze`/`milestone complete`
   считают всю историю; дробные фазы (`68b.1`, `07.1`) ломают `phase.insert/complete`.
3. **Честность верификации — per-agent дисциплина, не механизм.** Лучшие артефакты (`norn/13 ## Gates`:
   «typecheck 5/5 · tests 204 · oxlint 0 errors», `root/03 GATE-BASELINE.md`, `ucars/16 “every command
   actually executed”`) делают то, что должен делать инструмент.
4. **Отклонения от плана — норма**: ~80 % SUMMARY содержат `[Rule 1/2/3]`; «plan's snippet does not
   compile / would have crashed» — регулярно. Harness должен ожидать неверный план.
5. **Worktree — #1 operational failure** (см. TL;DR D). MCP (`pencil`, `atlas`) недоступны в
   worktree-агентах (`ideas/atlas-mcp-backlog.md §B-2`).
6. **Конвенции живут в lint-правилах и self-testing check-скриптах** (99 oxc-правил, 40+
   `tools/checks/*` со spec-ами, baseline + non-decreasing ratchet, per-rule selftest, lefthook,
   `enforcement.yml`). Harness должен **вызывать их**, а не изобретать свои.
7. **Plan-checker и verifier окупаются, researcher — не всегда** (`research: false` в 3 корнях;
   ретро: plan-checker поймал RBAC-дыру до кода).
8. **Лёгкие режимы востребованы**: 87 `/gsd-quick` (все с SUMMARY), фазы CONTEXT+SUMMARY без PLAN,
   самописные manager-промпты «делегируй всё через gsd-агентов в `--auto`, эскалируй только
   manager-решения».
9. **Слоты для нестандартных артефактов**: `NN-GATE.md`, `NN-HUMAN-UAT.md`, `NN-VALIDATION.md`,
   `deferred-items.md` изобретаются заново в каждой фазе — «silently dropped» иначе.
10. **Стиль: числа и команды, не прилагательные**; каждый tooling-change несёт комментарий
    с инцидентом-мотивацией.

---

## 4. Gap-матрица: практика → форк → evidence → ценность для mn/awe

Оценки: **E** — сила evidence (3 = измерено, 2 = анекдот конвергентный, 1 = мнение);
**P** — боль в mn/awe (3 = в ретро как recurring); **C** — стоимость внедрения (1 = дни, 3 = недели).

| Практика | В форке сейчас | E | P | C | Вердикт |
|---|---|---|---|---|---|
| Prohibition-guard: PreToolUse блокирует Write/Edit вне `files_modified` ∪ declared плана | только post-hoc `blast-radius` на verify:pre | 2 | 3 | 1 | **T1** |
| Executor exit-gate: SubagentStop/TaskCompleted exit-2 → affected lint/typecheck/test проекта | нет в форке; в `mn` написан вручную (`.claude/hooks/quality-gate.sh`) | 3 | 3 | 1 | **T1** |
| PostCompact re-injection инвариантов (pinned rules + prohibitions активной фазы) | только PreCompact-warning | 3 | 2 | 1 | **T1** |
| Gate-результаты как frontmatter-поля, заполняемые `gsd_run verify gates` (не агентом) | verifier пишет прозу; `artifact-frontmatter-equals` есть, нечем заполнять | 3 | 3 | 2 | **T1** |
| Test-tamper guard: PreToolUse блокирует удаление assertions/изменение существующих spec вне плана | assertion-ratchet (post-hoc, default off) | 3 | 2 | 1 | **T1** |
| Бюджет и cap-ы автономии: `autonomous.max_phases`, `budget_usd`, per-agent `maxTurns`, `/goal` как стоп-судья | нет | 3 | 2 | 2 | **T1** |
| WorktreeCreate/Remove hooks: fresh base check, deps, `.mcp.json` pass-through, gc | `worktree-base-ref`, `worktree-gc` script (ручной), isolation-guard | 2 | 3 | 2 | **T1** |
| CLAUDE.md-диета: <200 строк + `.claude/rules/*.md` с `paths:` + `/doctor` | `claude_md_path` → 165-строчный; в `mn` 858 строк | 3 | 1 | 1 | **T1** (дёшево) |
| Канонические слоты `HUMAN-UAT.md`, `GATE.md`, `deferred-items.md` с gate на `pending` | `deferred-items.md` шаблон есть; UAT только audit | 1 | 3 | 1 | **T1** |
| Structured handoff (intent/files/decisions/next) вместо compaction для оркестраторов | `continue-here.md` свободной формы; fresh per phase уже | 3 | 1 | 1 | **T2** |
| Mutation spot-check на touched files в verify:pre | Stryker только на сам форк | 3 | 2 | 2 | **T2** |
| Behavioural evals harness-а: 20–50 кейсов из ретро mn/awe, `claude -p --output-format json`, graders file_exists/regex/llm | loop-walk + байтовые тесты | 3 | 2 | 3 | **T2** |
| Refute-or-promote: один «refuter» на findings plan-checker-а вместо панели критиков | plan-checker single-pass; review lanes | 3 | 1 | 2 | **T2** |
| Machine-owned state в JSON (`state.json`) с рендером STATE.md | ADR-1817 rebuild-derivability; BACKLOG-баги — ровно «markdown как БД» | 2 | 3 | 3 | **T2** (стратегически) |
| Lite-phase mode (CONTEXT+SUMMARY+VERIFICATION-lite) как официальный режим | quick есть; lite-фаза — обходной путь | 1 | 3 | 2 | **T2** |
| Deviation taxonomy → planner calibration (кол-во «plan snippet не компилируется» на фазу) | LEARNINGS-DIGEST; upstream 1.9 estimate→actual | 2 | 2 | 2 | **T2** |
| `converge`: diff кода против SPEC/PLAN, дописать gap как задачи | plan-drift-guard (symbols), gap-analysis (REQ-ID) | 2 | 2 | 2 | **T2** |
| Subagent `memory: project` для verifier/planner | mempalace off; evidence слабая | 1 | 1 | 1 | **T3** (эксперимент) |
| Hostile-critic panel ×5 на каждый план | — | 1 | 1 | 2 | **T3** |
| Forced TDD по умолчанию | `tdd` capability opt-in | 1 | 1 | — | оставить opt-in |
| Параллельные писатели >3 / shared checkout без disjointness | `max_concurrent_agents=3`, wave-collision | 3 (против) | — | — | **не делать** |
| Model-size иерархия planner/executor | `model_profile adaptive` | 2 (против) | — | — | держать planner/verifier на frontier-tier |

---

## 5. Рекомендации по волнам

### Волна A — enforcement хуками (1–2 недели, всё в `hooks/` + одна capability)

**A1. `gsd-prohibition-guard.js`** (PreToolUse: Write|Edit|MultiEdit).
Читает активный PLAN (по `STATE.md`/`in_progress` frontmatter — R-3 уже закрыт), строит allow-set из
`files_modified` + `<prohibitions>` + явных `allow_outside` ; вне набора — `permissionDecision: "ask"`
(в `--auto`: `deny` + `systemMessage` с командой «дополни `files_modified` и повтори»). Это
`blast-radius` во время записи, а не на verify. Закрывает половину wave-коллизий (worklog R-1) без
решения задачи «waves в коде».
Config: `workflow.prohibition_guard: ask|deny|off`. Тесты: boundary на glob/dir-записи
(`files_modified` содержит 10 % glob-ов — именно там ломается).

**A2. `gsd-executor-exit-gate.js`** (SubagentStop для `gsd-executor`; TaskCompleted в agent-teams).
Портировать `mn/.claude/hooks/quality-gate.sh` в capability: команда из config
(`workflow.exit_gate_command`, default — автодетект `lefthook run pre-commit` / `nx affected -t
lint,typecheck --base=<worktree-base>`), scoped к worktree агента (урок из комментария в
`quality-gate.sh` — stale snapshot обвинил агента в 19 чужих файлах). Exit 2 + stderr с командой →
агент продолжает до зелёного. Это и есть «verifier near-perfect» на самом дешёвом уровне: lint/typecheck
детерминированы и уже написаны пользователем (99 oxc-правил).
Бюджет повторов: `exit_gate_max_retries: 3`, потом `checkpoint:human-verify`.

**A3. `gsd-pin-invariants.js`** (PostCompact + SessionStart).
`additionalContext` = блок `<!-- gsd:pinned -->…<!-- /gsd:pinned -->` из CLAUDE.md (≤50 строк,
size-ratchet) + `prohibitions`/`must_haves` активного плана + `WAITING.json` если есть. Замена
`gsd-context-monitor`-у PreCompact-warning-а не требуется — дополняет. На non-Claude runtime-ах
PostCompact вне `PORTABLE_EVENT_FLOOR` → degrade до SessionStart.

**A4. `gsd-test-tamper-guard.js`** (PreToolUse: Edit|Write на `**/*.spec.*`, `tests/**`).
Правило из Anthropic feature-list («unacceptable to remove or edit tests») и RHB: существующий spec
можно менять, только если путь в `files_modified` плана **и** diff не уменьшает число `expect(`/`assert`
(используется готовый `assertion-ratchet.mjs` на одном файле). Иначе `ask`.

**A5. CLAUDE.md-диета в mn/awe** (не код форка, но часть внедрения): 858 → <200 строк; Either/Nx/testing
правила — в `.claude/rules/*.md` с `paths:` (например `paths: ["libs/**/*.ts"]`); запустить `/doctor`.
Evidence: корректность не растёт от объёма, а стоимость кэша и «rot» — да.

### Волна B — evidence-поля и границы автономии (2–3 недели)

**B1. `gsd_run verify gates`** — новая команда: выполняет `exit_gate_command` + `nx affected -t test` +
(опц.) `tools/checks/*` проекта и **сама** пишет в `VERIFICATION.md` frontmatter:
```yaml
gates:
  typecheck: { passed: 5, failed: 0 }
  tests:     { passed: 204, failed: 0, skipped: 2 }
  lint:      { errors: 0, warnings: 5700 }
  commands:  [ "nx affected -t typecheck --base=abc123", ... ]
  ran_at: 2026-08-20T11:02:00Z
```
`gsd-verifier` получает поля read-only и обязан ссылаться на них, а не перезапускать/пересказывать.
Гейт `ship:pre`: `artifact-frontmatter-equals VERIFICATION.md gates.tests.failed 0` — тот самый
predicate, который появился в `d3ddcaba`. Это прямая механизация `norn/13 ## Gates`.

**B2. `HUMAN-UAT.md` как канонический артефакт** (реестр `CANONICAL_EXACT`), шаблон с таблицей
`id | check | device/env | status: pending|passed|failed | evidence`. Verifier при `human_needed`
пишет туда, `audit-milestone` читает; опциональный гейт `ship:pre` на `pending == 0`
(`workflow.human_uat_enforce`, default off). То же для `GATE.md` (baseline до/после) — как
`execute:pre` step, пишущий `GATE-BASELINE.md` из B1-команды. Закрывает «silently dropped».

**B3. Бюджеты автономии** в `autonomous.md` + config:
`autonomous.max_phases` (default 5), `autonomous.max_gap_closure_retries` (сейчас hardcoded 1),
`autonomous.budget_usd` (читать `total_cost_usd` из `claude -p --output-format json`, если запуск
headless; иначе считать по agent-history.json), `maxTurns` во frontmatter `gsd-executor` (120) и
`gsd-verifier` (60). При исчерпании — `WAITING.json type=budget`, не тихий стоп.
Плюс `/goal` как внешний стоп-судья для manager-промптов пользователя: документировать рецепт
«`/goal "все фазы 12–14 имеют VERIFICATION.md status: passed и gates.tests.failed == 0"`» —
fresh Haiku-судья, не исполнитель, решает о завершении (в точности Anthropic «judge in a different
context»).

**B4. Worktree lifecycle hooks** (`WorktreeCreate`/`WorktreeRemove`, Claude Code GA):
- Create: проверить `worktree.baseRef` свежий (`git merge-base --is-ancestor`), иначе `continue:false`
  с причиной «base N commits behind»; `bun install --frozen-lockfile` или symlink `node_modules`
  (конфигурируемо `worktree.deps: install|link|none`); скопировать `.mcp.json`/`settings.local.json`
  → закрывает «MCP не доступен в worktree-агентах».
- Remove: вызвать существующий `worktree-gc` (у `mn` 47 брошенных деревьев).
- На runtime-ах без этих событий — текущий `executor-isolation-dispatch.md` путь без изменений.

**B5. Structured handoff**: `continue-here.md` → обязательные секции `intent / files_touched /
decisions / open_questions / next_step` (schema в `frontmatter.cjs`), `pause-work` валидирует.
Дёшево, evidence сильная (Factory: artifact trail — слабейшее измерение у всех методов компакции).

### Волна C — качество самого harness-а (параллельно, по мере сил)

**C1. Behavioural evals из ретро.** 20–50 кейсов «два эксперта согласятся»: RBAC-дыра в CSV-export
(plan-checker должен FAIL), compose-файл назван неверно (executor должен записать deviation),
plan snippet не компилируется (executor не должен «следовать плану»), traceability не обновлена после
`passed` (phase.complete должен обновить). Запуск: `claude -p --output-format json` на fixture-проекте,
graders: `file_exists`, regex по frontmatter, llm-rubric. Формат — `skill-creator` `evals/evals.json`
(`claude plugin eval` — early access, не GA; не завязываться). Это единственный измеренный способ
улучшать harness не через prompt (AHE: gains из tools/middleware, не из system prompt).

**C2. Mutation spot-check** (`verify:pre`, opt-in `workflow.mutation_spot_check`): Stryker/`vitest
--mutate` на ≤5 файлах из `files_modified` с наибольшим diff-ом; порог — «ни один мутант не выжил в
функциях, упомянутых в `must_haves`». В `norn/13` пользователь уже поймал false-green мутацией вручную.

**C3. `state.json` как machine-owned источник** (ADR-1817 rebuild уже декларирует derivability):
`progress.*`, traceability, phase-status — в JSON; `STATE.md`/таблицы REQUIREMENTS рендерятся.
Класс BACKLOG-багов (`phase.complete` не пересчитывает progress, DEF-* vs REQ-ID, `updateTableCell`)
исчезает по построению. Самая дорогая, но самая структурная правка; синхронизировать с upstream
`state-md-transition`.

**C4. Refuter на plan-checker**: один дополнительный проход «опровергни каждый FAIL/WARN» с
`agent_skills` lens (R-0.6 путь) перед возвратом планировщику — поднимает precision без SNR-коллапса
Reflexion-а. Не панель ×5.

**C5. Deviation taxonomy**: executor пишет `deviation.kind: plan_wrong|env_drift|scope_add|…` в
SUMMARY frontmatter; `extract-learnings` агрегирует; `new-milestone` показывает «за milestone
планировщик ошибся в N/M планах, топ-причина — …». Связать с upstream estimate→actual (1.9).

### Предпосылки (без них волны A/B стреляют мимо)

- **Nested `.planning/` резолвинг** детерминированно (ближайший вверх для state; repo-root для skills;
  `--cwd` explicit уже починен в BACKLOG). Все новые хуки читают план через один резолвер.
- **Синк с upstream 1.11** (672 коммита): `artifact-frontmatter-equals` в установленный runtime,
  declared-scope diff validation, cross-artifact drift — после синка пересмотреть, какие из 12 гейтов
  `mn-verify-gate` становятся config-ом.
- **Включить по умолчанию** в mn/awe то, что уже есть и default off: `assertion_ratchet`,
  `blast_radius`, `verify_enforce`, `nyquist_enforce` — без этого B1 не на что опереться.

---

## 6. Что сознательно не делаем

- Не растим CLAUDE.md/агентские промпты ради качества — ablation-ы не показывают эффекта; size-ratchet
  форка уже смотрит в правильную сторону.
- Не включаем `tdd` по умолчанию; не требуем «тест первым» — +20 % токенов без прироста.
- Не поднимаем `max_concurrent_agents` > 3 и не вводим shared-checkout параллель без
  file-disjointness из `wave_collision`.
- Не строим «дешёвый planner → дорогой executor»: planner/plan-checker/verifier — frontier-tier,
  фиксированный effort на фазу (инвалидация кэша при смене).
- Не заменяем fresh-context-per-phase на многослойную compaction; `handoff` вместо `/compact`.
- Не полагаемся на `claude plugin eval`/`/skill-doctor` как на GA — строим evals в формате
  `skill-creator`, который переживёт оба.
- Не делаем egress hash-chain / `/freeze`-локи (gstack) — для solo-разработчика с lefthook и
  `always_confirm_destructive` это ceremony без evidence.

---

## 7. Риски

- **Hooks-only enforcement не портируется** на runtime-ы без PostCompact/SubagentStop/WorktreeCreate
  (`PORTABLE_EVENT_FLOOR`). Решение: каждый хук объявляет degrade-путь (SessionStart / step в
  loop-точке), fail-closed документирован в capability.json.
- **Exit-gate может зациклить исполнителя** на legacy-долге (5 700 anti-slop warnings в `mn`) —
  обязательно `lint-staged-baselined`-семантика из `awe` (errors block, baselined — нет).
- **Prohibition-guard и glob-ы в `files_modified`** (10 % glob, 14 % пусто) — пустой список должен
  означать «ask на всё», не «allow всё».
- **`/goal` и budget** — на подписке subagent cache TTL 5 мин; длинные `--auto` прогоны дорожают при
  смене model_profile `adaptive` посреди фазы; фиксировать модель на фазу.
- **Evals дороги** в поддержке; начать с 20 кейсов из ретро, не с 50.

---

## 8. Источники (ключевые)

Anthropic: engineering/effective-harnesses-for-long-running-agents (2025-11-26) ·
engineering/harness-design-long-running-apps (2026-03-24) · engineering/building-c-compiler (2026-02-05) ·
engineering/demystifying-evals-for-ai-agents (2026-01-09) · engineering/april-23-postmortem ·
claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything (2026-04-30) ·
claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code (2026-06-02) ·
code.claude.com/docs/en/{hooks,sub-agents,skills,goal,scheduled-tasks,workflows,checkpointing,memory,prompt-caching}.
Evidence: arXiv 2606.22528 (governance decay) · 2606.11213 (CWL eviction) · 2605.11051 (latent
compression) · 2605.21384 (SpecBench) · 2604.16529 (RTV/PDR) · 2606.26300 (verification horizon) ·
2607.22585 (harness fingerprints) · 2604.25850 (AHE) · 2607.27250 (context files ablation) ·
2602.07900 (agent-written tests) · 2603.11078 (review SNR) · 2602.08146 (mutation) · 2503.13657 (MAST) ·
metr.org/blog/2026-1-29-time-horizon-1-1 · metr.org/notes/2026-02-13-measuring-time-horizon-using-claude-code-and-codex ·
factory.ai/news/evaluating-compression · cognition.com/blog/multi-agents-working (2026-04-22) ·
openai.com/index/harness-engineering.
OSS: github.com/open-gsd/gsd-core/releases (1.11.0, 2026-08-19) · obra/superpowers · garrytan/gstack ·
github/spec-kit (`converge`) · Fission-AI/OpenSpec · kiro.dev/docs/specs/correctness ·
code-yeongyu/oh-my-opencode · anthropics/claude-plugins-official/ralph-loop · EveryInc/compound-engineering-plugin ·
swe-agent/mini-swe-agent · ai-boost/awesome-harness-engineering.
Локально: `.plans/mn-fork-worklog.md`, `BACKLOG.md`, `$mn/apps/*/.planning/RETROSPECTIVE.md`,
`$awe/apps/ucars/.planning/RETROSPECTIVE.md`, `$mn/.claude/hooks/quality-gate.sh`, `$awe/lefthook.yml`,
`$awe/tools/checks/`.
