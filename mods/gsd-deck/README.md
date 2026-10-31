# gsd-deck

Установка на любой машине (нужен Claude Code с поддержкой модов):

```
claude plugin marketplace add Govorin/gsd-core
claude plugin install gsd-deck@gsd-core
```

или одной командой в сессии: `/plugin install gsd-deck --marketplace Govorin/gsd-core`. Обновление: `claude plugin marketplace update gsd-core`, затем `/reload-plugins`.

Панель GSD для Claude Code. В ней видно состояние проектов `.planning/` в текущей сессии: какая фаза идёт, сколько планов сделано, что запускать дальше и какие GSD-воркфлоу и агенты работают сейчас.

## Что показывает

- **Шапка проекта в фокусе:** milestone, фаза `N/M` с названием, статус (цветом), полоса планов `сделано/всего`, `stopped_at` и последняя активность. Всё берётся из frontmatter `STATE.md`.
- **Дальше:** вердикт `gsd-tools smart-entry` и кнопки с рекомендуемыми командами. Цифра `1`–`9` или клик кладёт команду в промпт, и её можно поправить перед Enter.
- **Фазы:** таблица из `gsd-tools progress json`. Текущая фаза отмечена `▶`, завершённые — `✓`, «Needs Review» выделены цветом.
- **В этой сессии:** запущенные `/gsd-*` воркфлоу и фоновые `gsd-*` агенты с длительностью.
- **Проекты:** все каталоги с `.planning/` под рабочей директорией (монорепо с `.planning` у каждого приложения). Клик переводит фокус на проект.
- **Строка статуса:** `GSD asgard · P1/16 · executing · 10/15 планов · ▸ /gsd-progress --next`.
- **Подсказка в промпте:** после хода, в котором была GSD-работа, в пустом промпте появляется тусклая подсказка со следующей командой, Tab её принимает. Отключается кнопкой «Подсказки» или `/gsd-deck suggest`.

Фокус переходит на проект сам, когда Claude правит файл внутри него или вызывает `gsd-tools --project-dir <dir>`.

## Команды

`/gsd-deck` открывает панель, `/gsd-deck refresh` обновляет данные, `/gsd-deck rescan` заново ищет проекты, `/gsd-deck suggest` включает и выключает подсказку.

## Откуда данные

Мод ничего не пишет в `.planning/`. Он читает `STATE.md` напрямую и для проекта в фокусе запускает `node gsd-tools.cjs smart-entry --json | progress json | state-snapshot | list-todos --project-dir <dir>`. `gsd-tools.cjs` ищется сначала в `<cwd>/.claude/gsd-core/bin/`, потом в `~/.claude/gsd-core/bin/`, потом в `~/.claude/get-shit-done/bin/`.
