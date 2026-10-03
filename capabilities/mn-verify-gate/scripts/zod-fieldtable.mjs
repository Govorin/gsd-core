#!/usr/bin/env node
/**
 * Field table из Zod-схемы — то, что дизайнер и планировщик должны знать
 * о форме до того, как её нарисуют.
 *
 * Зачем: UI-SPEC.md несёт палитру, шкалу отступов и типографику, но ни одного
 * поля. Дизайнер узнаёт, что бывает пустое состояние, и не узнаёт, что в форме
 * семь полей, из них два — enum на 47 вариантов (селект не годится, нужен
 * combobox с поиском), а название бывает до 300 символов. Эта половина
 * контракта уже описана в Zod и просто никуда не доезжает.
 *
 * Генерируется (derived) — не устаревает, потому что перечитывается:
 *   имя · тип · обязательность · min/max · enum-варианты · формат · default
 * Не генерируется (authored, решение человека) — и потому не выдумывается:
 *   какой контрол · порядок полей · группировка · текст ошибки для человека ·
 *   момент валидации · условная видимость · права по ролям
 *
 * Вывод — markdown-таблица плюс erDiagram, если схема вложенная.
 *
 *   node zod-fieldtable.mjs --module @savor/dtos --export journalEntryDto
 *   node zod-fieldtable.mjs --file libs/savor/dtos/src/journal-entry.dto.ts --export journalEntryDto
 *
 * Требует рантайм, умеющий грузить TS напрямую (bun). Схема — источник правды;
 * повторять её в markdown руками значит заводить вторую правду, которая разойдётся.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : d;
};

const target = arg('module') ?? arg('file');
const exportName = arg('export');

if (!target || !exportName) {
  console.error('usage: --module <alias> | --file <path>  --export <schemaName>');
  process.exit(1);
}

const specifier = arg('module') ? target : pathToFileURL(resolve(target)).href;

let mod;
try {
  mod = await import(specifier);
} catch (err) {
  console.error(`FAIL: cannot import ${specifier}\n${err.message}`);
  console.error('Run under a TS-capable runtime (bun) and from a directory where the alias resolves.');
  process.exit(1);
}

const schema = mod[exportName];
if (!schema) {
  const available = Object.keys(mod).filter((k) => k.endsWith('Dto') || k.endsWith('Schema'));
  console.error(`FAIL: no export "${exportName}" in ${target}`);
  if (available.length) console.error(`Available: ${available.join(', ')}`);
  process.exit(1);
}

const { z } = await import('zod');

let json;
try {
  json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
} catch (err) {
  console.error(`FAIL: ${exportName} is not a Zod schema, or cannot be projected: ${err.message}`);
  process.exit(1);
}

/** Человекочитаемый тип: то, что влияет на выбор контрола. */
function typeOf(p) {
  if (p.enum) return `enum(${p.enum.length})`;
  if (p.type === 'array') return `array<${p.items ? typeOf(p.items) : 'any'}>`;
  if (p.type === 'string' && p.format) return p.format;
  if (p.type === 'object') return 'object';
  return p.type ?? 'any';
}

/** Границы, которые дизайнер обязан увидеть до вёрстки: длина поля, диапазон, размер списка. */
function boundsOf(p) {
  const b = [];
  // z.number().int() проецируется с границами Number.MAX_SAFE_INTEGER — это
  // предел разрядности, а не решение о поле. Показывать его дизайнеру значит
  // выдать «до 9007199254740991» за осмысленный лимит.
  const lim = (v, fallback) => (v === undefined || Math.abs(v) === Number.MAX_SAFE_INTEGER ? fallback : v);
  if (p.minLength !== undefined || p.maxLength !== undefined) b.push(`len ${p.minLength ?? 0}..${p.maxLength ?? '∞'}`);
  if (p.minimum !== undefined || p.maximum !== undefined) b.push(`${lim(p.minimum, '−∞')}..${lim(p.maximum, '∞')}`);
  if (p.minItems !== undefined || p.maxItems !== undefined) b.push(`items ${p.minItems ?? 0}..${p.maxItems ?? '∞'}`);
  if (p.pattern && !p.format) b.push('pattern');
  return b.join(', ') || '—';
}

const required = new Set(json.required ?? []);
const props = Object.entries(json.properties ?? {});

// Не каждый DTO — объект: enum-схема (`export const x = SomeEnumSchema`) тоже
// приезжает к дизайнеру, и именно она отвечает на вопрос «сколько вариантов в
// контроле» — три это radio, сорок это combobox с поиском. Печатаем варианты,
// а не отказываем.
if (!props.length) {
  if (json.enum) {
    console.log(`### Value set — \`${exportName}\``);
    console.log();
    console.log('<!-- gsd:derived source=zod-fieldtable — regenerated, do not hand-edit -->');
    console.log();
    console.log(`${json.enum.length} values: ${json.enum.map((v) => `\`${v}\``).join(' · ')}`);
    console.log();
    console.log(`_Control choice follows from the count: a handful fits radio buttons, a long list needs search. That call is a design decision, not schema data._`);
    process.exit(0);
  }
  console.error(`FAIL: ${exportName} projects to neither properties nor an enum (type: ${json.type ?? 'unknown'}).`);
  process.exit(1);
}

const nested = [];
const rows = props.map(([name, p]) => {
  if (p.type === 'object' && p.properties) nested.push([name, p]);
  const enumValues = p.enum ? p.enum.slice(0, 6).join(' \\| ') + (p.enum.length > 6 ? ` \\| …+${p.enum.length - 6}` : '') : '—';
  return `| \`${name}\` | ${typeOf(p)} | ${required.has(name) ? 'yes' : 'no'} | ${boundsOf(p)} | ${enumValues} | ${p.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : '—'} |`;
});

console.log(`### Field table — \`${exportName}\``);
console.log();
console.log('<!-- gsd:derived source=zod-fieldtable — regenerated, do not hand-edit -->');
console.log();
console.log('| Field | Type | Required | Bounds | Values | Default |');
console.log('|-------|------|----------|--------|--------|---------|');
rows.forEach((r) => console.log(r));
console.log();
console.log(`_${props.length} fields, ${required.size} required. Control, order, grouping and error copy are design decisions — record them alongside, they are not in the schema._`);

if (nested.length) {
  console.log();
  console.log('```mermaid');
  console.log('erDiagram');
  const root = exportName.replace(/Dto$|Schema$/, '') || 'Root';
  const safe = (t) => typeOf(t).replace(/\W/g, '_');
  for (const [name] of nested) {
    const child = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`  ${root} ||--|| ${child} : ${name}`);
  }
  // Атрибуты — одним блоком на сущность: erDiagram не принимает по блоку на поле.
  console.log(`  ${root} {`);
  for (const [name, p] of props.filter(([, x]) => x.type !== 'object')) {
    console.log(`    ${safe(p)} ${name}`);
  }
  console.log('  }');
  for (const [name, p] of nested) {
    const child = name.charAt(0).toUpperCase() + name.slice(1);
    console.log(`  ${child} {`);
    for (const [f, fp] of Object.entries(p.properties ?? {}).slice(0, 10)) {
      console.log(`    ${safe(fp)} ${f}`);
    }
    console.log('  }');
  }
  console.log('```');
}
