/**
 * Zod field table — the half of a UI contract that already exists in code.
 *
 * UI-SPEC.md carries palette, spacing and typography, and not one field. A
 * designer told "draw the check-in form" learns that an empty state exists and
 * does not learn that the form has seven fields, two of them enums of 47 values
 * (a select will not do, it needs a searchable combobox), and a title that runs
 * to 300 characters. That half is already written down — in the Zod schema that
 * validates the request — and simply never reaches the plan.
 *
 * Derived here (re-read, so it cannot go stale):
 *   name · type · required · bounds · enum values · default, and an erDiagram
 *   of the nesting.
 * NOT derived, because it is not in a schema and must not be invented:
 *   which control · field order · grouping · error copy · when validation
 *   fires · conditional visibility · per-role visibility.
 *
 * ── Two halves, so the core never loads TypeScript ──
 *
 *   1. A PURE converter over JSON Schema (what Zod 4's `z.toJSONSchema()`
 *      emits, draft 2020-12): `buildFieldTable`, `buildErSpec`,
 *      `renderFieldTable`. No fs, no process — the core, its tests and any
 *      other caller (the 5.7 diagram tooling) share exactly this code.
 *   2. A LOADER that turns `--file <ts> --export <name>` into that JSON Schema
 *      by running the PROJECT's own runtime in the project directory (`bun`
 *      when it is on PATH — it reads TS and tsconfig path aliases — otherwise
 *      this Node with type stripping, which reads TS but not aliases). The
 *      schema module and `zod` resolve from the project, never from GSD, so
 *      the core gains no dependency. No runtime that can load the module →
 *      the command says so; it does not draw a table from memory.
 *
 * The ER diagram is built with `src/mermaid.cts` (the same builders every
 * other derived diagram uses), so an entity or relationship that was not read
 * from the schema cannot appear: the builder throws on an undeclared id.
 *
 * Ported from `capabilities/mn-verify-gate/scripts/zod-fieldtable.mjs`. The
 * field table is the same table; the ER part is wider and stricter than the
 * script's — see `buildErSpec`.
 *
 * ADR-457 build-at-publish: source in src/mn-zod-fieldtable.cts, compiled to
 * gsd-core/bin/lib/mn-zod-fieldtable.cjs (gitignored).
 */

import fs from 'node:fs';
import childProcess from 'node:child_process';
import { createIdRegistry, derivedMarker, erDiagram, fence } from './mermaid.cjs';
import type { ErAttribute, ErCardinality, ErDiagramSpec, ErEntity, ErKey, ErRelationship } from './mermaid.cjs';

// ─── JSON Schema (the subset Zod 4 emits) ────────────────────────────────────

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  format?: string;
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  /** Explicit ER key, from `.meta({ key: 'PK' })`. Keys are never inferred. */
  key?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const DEF_REF = /^#\/\$defs\/(.+)$/;

/** The `$defs` entry a `$ref` names, `root` for `#`, or null when it does not resolve. */
function resolveRef(ref: string, root: JsonSchema): { name: string | null; schema: JsonSchema } | null {
  if (ref === '#') return { name: null, schema: root };
  const m = ref.match(DEF_REF);
  if (m === null) return null;
  const def = root.$defs?.[m[1]];
  return isObject(def) ? { name: m[1], schema: def } : null;
}

/** `X | null` (how `.nullable()` projects) → X; anything else unchanged. */
function unwrapNullable(p: JsonSchema): { schema: JsonSchema; nullable: boolean } {
  const branches = p.anyOf ?? p.oneOf;
  if (!Array.isArray(branches)) return { schema: p, nullable: false };
  const nonNull = branches.filter((b) => !(isObject(b) && b.type === 'null'));
  if (nonNull.length === 1 && nonNull.length < branches.length) return { schema: nonNull[0], nullable: true };
  return { schema: p, nullable: false };
}

// ─── Field table ─────────────────────────────────────────────────────────────

/** A human type: what decides the control. */
export function typeOf(p: JsonSchema, root: JsonSchema = p): string {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return 'any';
  const { schema, nullable } = unwrapNullable(p);
  if (nullable) return `${typeOf(schema, root)} or null`;
  if (typeof p.$ref === 'string') {
    const target = resolveRef(p.$ref, root);
    return target === null ? 'any' : typeOf(target.schema, root);
  }
  if (Array.isArray(p.enum)) return `enum(${p.enum.length})`;
  if (p.type === 'array') return `array<${p.items ? typeOf(p.items, root) : 'any'}>`;
  if (p.type === 'string' && p.format) return p.format;
  if (p.type === 'object') return 'object';
  return typeof p.type === 'string' ? p.type : 'any';
}

/**
 * The limits a designer must see before laying out: field length, range, list
 * size. `z.number().int()` projects with ±Number.MAX_SAFE_INTEGER — a word-size
 * limit, not a decision about the field — so it reads as unbounded.
 */
export function boundsOf(p: JsonSchema): string {
  const b: string[] = [];
  const lim = (v: number | undefined, fallback: string): string | number =>
    v === undefined || Math.abs(v) === Number.MAX_SAFE_INTEGER ? fallback : v;
  if (p.minLength !== undefined || p.maxLength !== undefined) b.push(`len ${p.minLength ?? 0}..${p.maxLength ?? '∞'}`);
  if (p.minimum !== undefined || p.maximum !== undefined) b.push(`${lim(p.minimum, '−∞')}..${lim(p.maximum, '∞')}`);
  if (p.minItems !== undefined || p.maxItems !== undefined) b.push(`items ${p.minItems ?? 0}..${p.maxItems ?? '∞'}`);
  if (p.pattern && !p.format) b.push('pattern');
  return b.join(', ') || '—';
}

/** How many enum values a table cell shows before summarising the rest. */
export const ENUM_PREVIEW = 6;

export interface FieldRow {
  name: string;
  type: string;
  required: boolean;
  bounds: string;
  /** Enum preview (`a \| b \| …+N`), or `—`. */
  values: string;
  /** `JSON.stringify(default)`, or null when the schema declares none. */
  default: string | null;
}

export type FieldTable =
  | { kind: 'object'; fields: FieldRow[]; requiredCount: number }
  | { kind: 'enum'; values: unknown[] };

export type FieldTableResult =
  | { ok: true; table: FieldTable }
  | { ok: false; reason: 'not_an_object_or_enum'; message: string };

function enumPreview(values: unknown[]): string {
  const shown = values.slice(0, ENUM_PREVIEW).map(String).join(' \\| ');
  return values.length > ENUM_PREVIEW ? `${shown} \\| …+${values.length - ENUM_PREVIEW}` : shown;
}

/**
 * The table for one schema. Not every DTO is an object: an enum schema reaches
 * the designer too, and it is exactly what answers "how many options" — three
 * is radio buttons, forty is a searchable combobox — so it yields its values
 * instead of a refusal. Anything else has no fields to tabulate.
 */
export function buildFieldTable(schema: JsonSchema): FieldTableResult {
  const props = isObject(schema.properties) ? Object.entries(schema.properties) : [];
  if (props.length === 0) {
    if (Array.isArray(schema.enum)) return { ok: true, table: { kind: 'enum', values: [...schema.enum] } };
    const type = typeof schema.type === 'string' ? schema.type : 'unknown';
    return {
      ok: false,
      reason: 'not_an_object_or_enum',
      message: `the schema projects to neither properties nor an enum (type: ${type})`,
    };
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = props.map(([name, p]): FieldRow => ({
    name,
    type: typeOf(p, schema),
    required: required.has(name),
    bounds: boundsOf(p),
    values: Array.isArray(p.enum) ? enumPreview(p.enum) : '—',
    default: p.default !== undefined ? JSON.stringify(p.default) : null,
  }));
  return { ok: true, table: { kind: 'object', fields, requiredCount: fields.filter((f) => f.required).length } };
}

// ─── ER diagram ──────────────────────────────────────────────────────────────

const ER_KEY_SET: ReadonlySet<string> = new Set(['PK', 'FK', 'UK']);

export interface ErDefect {
  kind: 'unresolved-ref';
  /** Dotted property path from the root, e.g. `address.country`. */
  path: string;
  ref: string;
}

export interface ErBuild {
  spec: ErDiagramSpec;
  defects: ErDefect[];
}

/** The root entity's name: the export minus a `Dto`/`Schema` suffix. */
export function rootEntityName(exportName: string): string {
  return exportName.replace(/Dto$|Schema$/, '') || 'Root';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** An attribute name the ER grammar accepts; the original rides in the comment when it had to change. */
function erAttributeName(name: string): { name: string; renamed: boolean } {
  const spelled = name.replace(/[^A-Za-z0-9_]/g, '_');
  const safe = /^[A-Za-z_]/.test(spelled) ? spelled : `f_${spelled}`;
  return { name: safe, renamed: safe !== name };
}

/**
 * The schema's nesting as an erDiagram spec — DATA for `mermaid.erDiagram`.
 *
 *   - every object is an entity: the root (named after the export), each
 *     inline nested object (named after its property, capitalised), each
 *     `$defs` entry (named after the def — shared, drawn once however many
 *     properties point at it);
 *   - a nested object is a relationship `exactly-one` (required) or
 *     `zero-or-one` (optional) from its parent; an array of objects is
 *     `one-or-more` (required with `minItems ≥ 1`) or `zero-or-more`;
 *   - every other property is an attribute (its `typeOf`); an object with no
 *     declared properties (a record, `z.any()` projected as object) too;
 *   - keys (`PK`/`FK`/`UK`) come ONLY from an explicit `.meta({ key })` —
 *     never guessed from a name like `id`;
 *   - a `$ref` that does not resolve is a DEFECT: listed, and drawn as an
 *     attribute of type `unresolved`, never dropped.
 *
 * Wider than the script it replaces, which drew one level of inline objects,
 * always as `||--||`, and cut each child at ten attributes: an optional child
 * drawn as mandatory and a silently shortened entity are both inventions.
 */
export function buildErSpec(schema: JsonSchema, exportName: string): ErBuild {
  const ids = createIdRegistry();
  const entities: ErEntity[] = [];
  const relationships: ErRelationship[] = [];
  const defects: ErDefect[] = [];
  const taken = new Set<string>();
  /** `$defs` name (or `#` for the root) → entity id, so a shared def is drawn once. */
  const defEntity = new Map<string, string>();

  const claim = (want: string, parent: string): string => {
    const name = taken.has(want) ? `${parent}${want}` : want;
    const id = ids.id(name);
    taken.add(name);
    return id;
  };

  const addEntity = (id: string, obj: JsonSchema, path: string): void => {
    const entity: ErEntity = { id, attributes: [] };
    entities.push(entity);
    const attrs = entity.attributes as ErAttribute[];
    const required = new Set(Array.isArray(obj.required) ? obj.required : []);
    for (const [prop, raw] of Object.entries(obj.properties ?? {})) {
      const here = path === '' ? prop : `${path}.${prop}`;
      const p = isObject(raw) ? (raw as JsonSchema) : {};
      const link = linkTarget(p, here, required.has(prop));
      if (link !== null) {
        relationships.push({
          left: id,
          right: link.entity(id, prop),
          leftCardinality: 'exactly-one',
          rightCardinality: link.cardinality,
          label: prop,
        });
        continue;
      }
      const attrName = erAttributeName(prop);
      const unresolved = unwrapNullable(p).schema.$ref;
      const isDangling = typeof unresolved === 'string' && resolveRef(unresolved, schema) === null;
      if (isDangling) defects.push({ kind: 'unresolved-ref', path: here, ref: unresolved });
      const keys = typeof p.key === 'string' && ER_KEY_SET.has(p.key) ? [p.key as ErKey] : [];
      const comments = [
        ...(attrName.renamed ? [prop] : []),
        ...(isDangling ? [`unresolved $ref ${unresolved}`] : []),
      ];
      attrs.push({
        type: isDangling ? 'unresolved' : typeOf(p, schema),
        name: attrName.name,
        ...(keys.length > 0 ? { keys } : {}),
        ...(comments.length > 0 ? { comment: comments.join('; ') } : {}),
      });
    }
  };

  /** When property `p` is a link to another entity: its cardinality and how to get the entity id. */
  const linkTarget = (
    p: JsonSchema,
    path: string,
    required: boolean,
  ): { cardinality: ErCardinality; entity: (parentId: string, prop: string) => string } | null => {
    const { schema: inner } = unwrapNullable(p);
    const isArray = inner.type === 'array' && isObject(inner.items);
    const target = isArray ? unwrapNullable(inner.items as JsonSchema).schema : inner;
    const objectOf = (s: JsonSchema): { def: string | null; obj: JsonSchema } | null => {
      if (typeof s.$ref === 'string') {
        const r = resolveRef(s.$ref, schema);
        if (r === null || !isObject(r.schema.properties)) return null;
        return { def: r.name ?? '#', obj: r.schema };
      }
      return s.type === 'object' && isObject(s.properties) ? { def: null, obj: s } : null;
    };
    const found = objectOf(target);
    if (found === null) return null;
    const cardinality: ErCardinality = isArray
      ? required && (inner.minItems ?? 0) >= 1
        ? 'one-or-more'
        : 'zero-or-more'
      : required
        ? 'exactly-one'
        : 'zero-or-one';
    return {
      cardinality,
      entity: (parentId: string, prop: string): string => {
        if (found.def !== null) {
          const known = defEntity.get(found.def);
          if (known !== undefined) return known;
          const id = found.def === '#' ? rootId : claim(found.def, parentId);
          defEntity.set(found.def, id);
          if (found.def !== '#') addEntity(id, found.obj, path);
          return id;
        }
        const id = claim(capitalize(prop), parentId);
        addEntity(id, found.obj, path);
        return id;
      },
    };
  };

  const rootId = claim(rootEntityName(exportName), '');
  defEntity.set('#', rootId);
  addEntity(rootId, schema, '');
  return { spec: { entities, relationships }, defects };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export const ZOD_FIELDTABLE_SOURCE = 'zod-fieldtable';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * The derived document: heading, marker, the table (or the value set), the
 * one-line reminder of what the schema does NOT decide, and — when the schema
 * nests — the fenced erDiagram plus any ER defects.
 */
export function renderFieldTable(exportName: string, table: FieldTable, er: ErBuild | null): string {
  const out: string[] = [];
  if (table.kind === 'enum') {
    out.push(`### Value set — \`${exportName}\``, '', derivedMarker(ZOD_FIELDTABLE_SOURCE), '');
    out.push(`${table.values.length} values: ${table.values.map((v) => `\`${String(v)}\``).join(' · ')}`, '');
    out.push(
      '_Control choice follows from the count: a handful fits radio buttons, a long list needs search. That call is a design decision, not schema data._',
    );
    return `${out.join('\n')}\n`;
  }
  out.push(`### Field table — \`${exportName}\``, '', derivedMarker(ZOD_FIELDTABLE_SOURCE), '');
  out.push('| Field | Type | Required | Bounds | Values | Default |');
  out.push('|-------|------|----------|--------|--------|---------|');
  for (const f of table.fields) {
    const dflt = f.default !== null ? `\`${f.default}\`` : '—';
    out.push(`| \`${cell(f.name)}\` | ${cell(f.type)} | ${f.required ? 'yes' : 'no'} | ${f.bounds} | ${f.values} | ${dflt} |`);
  }
  out.push('');
  out.push(
    `_${table.fields.length} fields, ${table.requiredCount} required. Control, order, grouping and error copy are design decisions — record them alongside, they are not in the schema._`,
  );
  if (er !== null && (er.spec.relationships ?? []).length > 0) {
    out.push('', fence(erDiagram(er.spec)));
  }
  if (er !== null && er.defects.length > 0) {
    out.push('', 'ER defects:', ...er.defects.map((d) => `- \`${d.path}\`: $ref ${d.ref} does not resolve`));
  }
  return `${out.join('\n')}\n`;
}

// ─── Loader: the project's runtime, in the project's directory ───────────────

/**
 * Runs inside the project's runtime (bun, or node with type stripping) as an
 * ES module. Inputs arrive through the environment — never interpolated into
 * source — and the answer is one JSON object on stdout. Every failure is an
 * answer (`ok: false` + reason), so a crash is distinguishable from a refusal.
 */
export const LOADER_SOURCE = `
const out = (o) => process.stdout.write(JSON.stringify(o));
const target = process.env.GSD_ZOD_TARGET;
const kind = process.env.GSD_ZOD_KIND;
const name = process.env.GSD_ZOD_EXPORT;
const { pathToFileURL } = await import('node:url');
const { resolve } = await import('node:path');
let mod;
try {
  mod = await import(kind === 'module' ? target : pathToFileURL(resolve(target)).href);
} catch (e) {
  out({ ok: false, reason: 'import_failed', message: String((e && e.message) || e) });
  process.exit(0);
}
const schema = mod[name];
if (schema === undefined) {
  out({ ok: false, reason: 'no_export', message: 'no export ' + JSON.stringify(name), available: Object.keys(mod).filter((k) => /(Dto|Schema)$/.test(k)) });
  process.exit(0);
}
let z;
try {
  ({ z } = await import('zod'));
} catch (e) {
  out({ ok: false, reason: 'no_zod', message: String((e && e.message) || e) });
  process.exit(0);
}
try {
  out({ ok: true, schema: z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) });
} catch (e) {
  out({ ok: false, reason: 'not_zod', message: String((e && e.message) || e) });
}
`;

export interface SpawnOutcome {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the program could not be started (`ENOENT` = not installed). */
  errorCode: string | null;
}

export type Spawner = (program: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => SpawnOutcome;

function errnoCode(err: Error | undefined): string | null {
  const code: unknown = err !== undefined && 'code' in err ? err.code : undefined;
  return typeof code === 'string' ? code : null;
}

/** Production spawner: argv array, no shell, bounded. */
export const defaultSpawner: Spawner = (program, args, opts) => {
  const r = childProcess.spawnSync(program, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: opts.timeoutMs,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    errorCode: errnoCode(r.error),
  };
};

/** Node strips TypeScript types by default from 22.18 / 23.6; older 22.x needs the flag. */
export function nodeTypeStripArgs(version: string = process.versions.node): string[] {
  const [major, minor] = version.split('.').map(Number);
  return major === 22 && minor < 18 ? ['--experimental-strip-types'] : [];
}

export type LoaderReason = 'import_failed' | 'no_export' | 'no_zod' | 'not_zod' | 'no_runtime' | 'loader_failed';

export type LoadResult =
  | { ok: true; runtime: 'bun' | 'node'; schema: JsonSchema }
  | { ok: false; reason: LoaderReason; message: string; runtime: 'bun' | 'node' | null; available?: string[] };

export interface LoadOptions {
  cwd: string;
  /** `file`: a path (resolved against `cwd`); `module`: a specifier the runtime resolves (an alias, a package). */
  kind: 'file' | 'module';
  target: string;
  exportName: string;
  timeoutMs?: number;
  _spawn?: Spawner;
  /** The node binary for the fallback; defaults to the one running GSD. */
  _nodePath?: string;
}

export const LOADER_TIMEOUT_MS = 60_000;

/**
 * Turn a Zod schema export into JSON Schema in the project's runtime. bun is
 * tried first (TS + tsconfig aliases); only when bun is not installed does
 * node take over (TS without aliases). A bun that starts and then fails is
 * reported, not retried under node — node would fail too and hide why.
 */
export function loadZodJsonSchema(opts: LoadOptions): LoadResult {
  const spawn = opts._spawn ?? defaultSpawner;
  const env = { ...process.env, GSD_ZOD_TARGET: opts.target, GSD_ZOD_KIND: opts.kind, GSD_ZOD_EXPORT: opts.exportName };
  const timeoutMs = opts.timeoutMs ?? LOADER_TIMEOUT_MS;
  const attempts: Array<{ runtime: 'bun' | 'node'; program: string; args: string[] }> = [
    { runtime: 'bun', program: 'bun', args: ['-e', LOADER_SOURCE] },
    {
      runtime: 'node',
      program: opts._nodePath ?? process.execPath,
      args: [...nodeTypeStripArgs(), '--no-warnings', '--input-type=module', '-e', LOADER_SOURCE],
    },
  ];
  for (const a of attempts) {
    const r = spawn(a.program, a.args, { cwd: opts.cwd, env, timeoutMs });
    if (r.errorCode === 'ENOENT') continue;
    let answer: unknown = null;
    try {
      answer = JSON.parse(r.stdout);
    } catch {
      answer = null;
    }
    if (!isObject(answer) || typeof answer.ok !== 'boolean') {
      const why = r.errorCode !== null ? r.errorCode : `exit ${r.status}`;
      const tail = r.stderr.trim().split('\n').slice(-3).join(' | ');
      return { ok: false, reason: 'loader_failed', runtime: a.runtime, message: `${a.runtime} loader gave no answer (${why})${tail ? `: ${tail}` : ''}` };
    }
    if (answer.ok === true) {
      if (!isObject(answer.schema)) {
        return { ok: false, reason: 'not_zod', runtime: a.runtime, message: 'the export did not project to a JSON Schema object' };
      }
      return { ok: true, runtime: a.runtime, schema: answer.schema };
    }
    const reason = (['import_failed', 'no_export', 'no_zod', 'not_zod'] as const).find((x) => x === answer.reason) ?? 'loader_failed';
    const available = Array.isArray(answer.available) ? answer.available.map(String) : undefined;
    return {
      ok: false,
      reason,
      runtime: a.runtime,
      message: typeof answer.message === 'string' ? answer.message : reason,
      ...(available !== undefined ? { available } : {}),
    };
  }
  return { ok: false, reason: 'no_runtime', runtime: null, message: 'neither bun nor a node binary could be started' };
}

// ─── Command core ────────────────────────────────────────────────────────────

export type ZodFieldtableSource =
  | { kind: 'json-schema'; path: string }
  | { kind: 'file' | 'module'; target: string };

export interface ZodFieldtableOptions {
  cwd: string;
  source: ZodFieldtableSource;
  exportName: string;
  _load?: (opts: LoadOptions) => LoadResult;
}

export type ZodFieldtableResult =
  | {
      ok: true;
      export: string;
      source: 'json-schema' | 'loader';
      runtime: 'bun' | 'node' | null;
      kind: 'object' | 'enum';
      fields: FieldRow[];
      field_count: number;
      required_count: number;
      values: unknown[];
      er: ErDiagramSpec | null;
      defects: ErDefect[];
      markdown: string;
    }
  | {
      ok: false;
      reason: LoaderReason | 'unreadable' | 'bad_json' | 'not_an_object_or_enum';
      message: string;
      available?: string[];
    };

/** Everything `gsd-tools mn zod-fieldtable` does except argv parsing, path confinement and exit. */
export function runZodFieldtable(opts: ZodFieldtableOptions): ZodFieldtableResult {
  let schema: JsonSchema;
  let runtime: 'bun' | 'node' | null = null;
  if (opts.source.kind === 'json-schema') {
    let text: string;
    try {
      text = fs.readFileSync(opts.source.path, 'utf-8');
    } catch (e) {
      return { ok: false, reason: 'unreadable', message: `cannot read ${opts.source.path}: ${(e as Error).message}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return { ok: false, reason: 'bad_json', message: `${opts.source.path} is not JSON: ${(e as Error).message}` };
    }
    if (!isObject(parsed)) return { ok: false, reason: 'bad_json', message: `${opts.source.path} is not a JSON Schema object` };
    schema = parsed;
  } else {
    const load = opts._load ?? loadZodJsonSchema;
    const loaded = load({ cwd: opts.cwd, kind: opts.source.kind, target: opts.source.target, exportName: opts.exportName });
    if (!loaded.ok) {
      return { ok: false, reason: loaded.reason, message: loaded.message, ...(loaded.available ? { available: loaded.available } : {}) };
    }
    schema = loaded.schema;
    runtime = loaded.runtime;
  }
  const built = buildFieldTable(schema);
  if (!built.ok) return { ok: false, reason: built.reason, message: `${opts.exportName}: ${built.message}` };
  const er = built.table.kind === 'object' ? buildErSpec(schema, opts.exportName) : null;
  return {
    ok: true,
    export: opts.exportName,
    source: opts.source.kind === 'json-schema' ? 'json-schema' : 'loader',
    runtime,
    kind: built.table.kind,
    fields: built.table.kind === 'object' ? built.table.fields : [],
    field_count: built.table.kind === 'object' ? built.table.fields.length : 0,
    required_count: built.table.kind === 'object' ? built.table.requiredCount : 0,
    values: built.table.kind === 'enum' ? built.table.values : [],
    er: er !== null && (er.spec.relationships ?? []).length > 0 ? er.spec : null,
    defects: er?.defects ?? [],
    markdown: renderFieldTable(opts.exportName, built.table, er),
  };
}
