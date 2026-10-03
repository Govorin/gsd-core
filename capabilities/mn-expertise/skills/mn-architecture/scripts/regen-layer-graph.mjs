import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// Источник истины живёт в РЕПОЗИТОРИИ (по умолчанию — cwd), а результат кладётся
// рядом со скриптом. В оригинале обе стороны были захардкожены относительно
// корня mn: `tools/...` и `.claude/skills/...`. Вендоренная копия лежит по
// другому пути (`capabilities/mn-expertise/skills/...`), поэтому цель берётся
// от самого файла — иначе регенератор молча пишет мимо своего графа и дрейф,
// который он существует чтобы устранять, остаётся на месте.
//
// Путь к источнику можно переопределить аргументом — граф нужен и тем
// проектам, где `layer-config.ts` лежит не в `tools/oxc-plugins`.
const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(
  process.argv[2] || 'tools/oxc-plugins/src/rules/conventions/layer-config.ts',
);
const TARGET = join(HERE, '..', 'references', 'layer-graph.json');

const src = readFileSync(SOURCE, 'utf8');
const body = src.slice(src.indexOf('LAYER_GRAPH'));
const layers = {};
const re = /^\s{2}(?:'([^']+)'|([A-Za-z][A-Za-z0-9-]*)):\s*\[([^\]]*)\]/gm;
let m;
while ((m = re.exec(body))) {
  const key = m[1] ?? m[2];
  const vals = [...m[3].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  layers[key] = vals;
}
const consumers = {};
for (const [k, vs] of Object.entries(layers)) for (const v of vs) (consumers[v] ??= []).push(k);
for (const k of Object.keys(consumers)) consumers[k].sort();
writeFileSync(TARGET,
  JSON.stringify({ layers, consumers }, null, 1) + '\n');
console.log('слоёв:', Object.keys(layers).length, '| потребителей:', Object.keys(consumers).length);
// Запуск из корня репозитория, где лежит layer-config.ts:
//   node <путь>/regen-layer-graph.mjs [путь/к/layer-config.ts]
// Источник истины — LAYER_GRAPH в layer-config.ts.
// references/layer-graph.json — производная; править руками нельзя, разъедется.
