#!/usr/bin/env python3
"""Ответить, легален ли импорт между слоями — по тому же графу, что читает линтер.

Зачем скрипт, а не таблица в тексте: слоёв 51, у каждого свой список
разрешённого, и держать это в прозе невозможно — при первом же расхождении
проза начнёт врать, а линт останется прав. Скрипт читает граф, извлечённый из
`tools/oxc-plugins/src/rules/conventions/layer-config.ts`, поэтому ответ здесь
и вердикт CI совпадают по построению.

    # можно ли из services импортировать infrastructure?
    python3 check_import.py services infrastructure/db

    # что вообще разрешено этому слою
    python3 check_import.py --allowed ui/flows

    # кто имеет право импортировать этот слой
    python3 check_import.py --consumers rules

    # слой по пути файла
    python3 check_import.py --layer-of libs/velo/ui/stores/src/lib/booking.store.ts
"""
from __future__ import annotations

import difflib
import json
import re
import sys
from pathlib import Path

GRAPH_PATH = Path(__file__).resolve().parent.parent / "references" / "layer-graph.json"


def load() -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    data = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
    return data["layers"], data["consumers"]


LAYER_PATH_RE = re.compile(r"(?:^|/)libs/([^/]+)/(.+?)/src/")


def layer_of(path: str, layers: dict[str, list[str]]) -> str | None:
    """Слой по пути файла — тем же разбором, что и `layer-path-parser.ts`.

    Паритет с линтером здесь не вежливость, а условие полезности: `--layer-of`
    стоит первым шагом чеклиста ревью, и расхождение отравляет все последующие
    шаги. Поэтому воспроизводится ровно тот алгоритм:

    1. берётся всё между `libs/<domain>/` и ПЕРВЫМ `/src/` — то есть путь без
       `/src/` слоя не даёт вовсе (у линтера он тоже не даёт);
    2. полученный сегмент ищется в графе целиком, затем укорачивается справа:
       `ui/presentation/react` → `ui/presentation`. Так react и ngx, будучи
       разными библиотеками, попадают в один слой;
    3. если ни один префикс не известен графу — возвращается внешний сегмент,
       как это делает линтер: неизвестное имя лучше молчания, потому что видно,
       что именно не опознано.
    """
    m = LAYER_PATH_RE.search(path.replace("\\", "/"))
    if not m:
        return None
    segs = [s for s in m.group(2).split("/") if s]
    for depth in range(len(segs), 0, -1):
        cand = "/".join(segs[:depth])
        if cand in layers:
            return cand
    return segs[0] if segs else None


def unknown(name: str, layers: dict[str, list[str]], role: str) -> int:
    """Слоя нет в графе — это НЕ то же самое, что «импорт запрещён».

    Различать обязательно: опечатка, отвеченная вердиктом «нельзя», выглядит как
    архитектурная находка и попадает в ревью как нарушение, которого нет.
    Отдельный код возврата (2) позволяет вызывающему отличить «мусор на входе»
    от «правило сработало».
    """
    close = difflib.get_close_matches(name, layers, n=3, cutoff=0.6)
    print(f"✗ слоя-{role} `{name}` нет в графе — это не запрет, это неизвестное имя.")
    if close:
        print(f"  Возможно, имелось в виду: {', '.join(close)}")
    print("  Слой по пути файла: --layer-of <путь>. Полный список: --list")
    return 2


def need(argv: list[str], n: int) -> str | None:
    return argv[n] if len(argv) > n else None


def main() -> int:
    layers, consumers = load()

    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    flag = sys.argv[1]

    if flag == "--list":
        print("\n".join(f"  {k}" for k in sorted(layers)))
        return 0

    if flag == "--allowed":
        layer = need(sys.argv, 2)
        if layer is None:
            print("Нужен слой: --allowed <слой>")
            return 2
        if layer not in layers:
            return unknown(layer, layers, "источника")
        deps = layers[layer]
        if not deps:
            print(f"`{layer}` — лист: не импортирует ничего из монорепозитория.")
        else:
            print(f"`{layer}` может импортировать:\n  " + "\n  ".join(sorted(deps)))
        return 0

    if flag == "--consumers":
        layer = need(sys.argv, 2)
        if layer is None:
            print("Нужен слой: --consumers <слой>")
            return 2
        if layer not in layers:
            return unknown(layer, layers, "цели")
        who = consumers.get(layer, [])
        if not who:
            print(f"`{layer}` не импортирует ни один слой графа — он терминальный (его потребляют приложения) либо неиспользуемый.")
        else:
            print(f"`{layer}` разрешено импортировать из:\n  " + "\n  ".join(sorted(who)))
        return 0

    if flag == "--layer-of":
        path = need(sys.argv, 2)
        if path is None:
            print("Нужен путь: --layer-of <путь-к-файлу>")
            return 2
        found = layer_of(path, layers)
        if found:
            print(found)
            return 0
        print(f"✗ слой не распознан по пути `{path}`.")
        print("  Разбор требует формы `libs/<domain>/<layer>/…/src/…` — ровно как у линтера.")
        print("  Нет `/src/` в пути (файл в корне либы, конфиг, тест вне src) → слоя нет и у линтера тоже.")
        print("  Путь вне `libs/` (apps/, tools/, docs/) слоями не описывается вовсе.")
        return 2

    # обычная форма: from → to
    src, dst = sys.argv[1], need(sys.argv, 2)
    if dst is None:
        print("Нужны два слоя: <откуда> <куда>")
        return 2
    if src not in layers:
        return unknown(src, layers, "источника")
    if dst not in layers:
        return unknown(dst, layers, "цели")

    allowed = layers[src]
    if dst in allowed:
        print(f"✓ можно: `{src}` → `{dst}`")
        return 0

    print(f"✗ НЕЛЬЗЯ: `{src}` → `{dst}`")
    print(f"\n`{src}` может импортировать только:\n  " + ("\n  ".join(sorted(allowed)) or "(ничего — это лист)"))
    # Подсказать обход: через какой разрешённый слой цель достижима.
    bridges = sorted(a for a in allowed if dst in layers.get(a, []))
    if bridges:
        print(f"\nЧерез что `{dst}` достижим легально: {', '.join(bridges)}")
        print("Это и есть штатный путь — прямое ребро отсутствует намеренно.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
