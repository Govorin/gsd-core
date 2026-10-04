/**
 * Design registry — design node → component in code.
 *
 * The bridge between design and code is half built already: DESIGN-SYSTEM.md
 * (the quality-design convention) carries component ids, their states, the
 * zone map and the screen registry. What it lacks is the column "is this
 * component written". This module answers exactly that: it takes the list of
 * design masters and reports which have an implementation on disk.
 *
 * What it does NOT do: it is not a source of truth about the design. Per
 * quality-design the live design file is the truth and DESIGN-SYSTEM.md is
 * authoritative only while it matches. This only reconciles an already
 * recorded registry with the disk; when they disagree, fix the document.
 *
 * Input, in decreasing order of trust:
 *   html      — a Pencil `export_html` export (canonical: what is actually
 *               drawn, with structure);
 *   registry  — DESIGN-SYSTEM.md: the markdown table under a heading about
 *               components (works without Pencil running);
 *   pen       — the raw `.pen` JSON (emergency path; the output says so).
 *
 * Derived (re-read, never stale): whether a component file exists, its path,
 * drift both ways, instance counts. NOT derived (a human decision, so never
 * invented): todo/in-progress/done, deliberate divergence, which states are
 * mandatory, breakpoints the design does not draw, a mapping between names
 * that diverged (`--map`), whether a component is needed at all.
 *
 * Matching is exact on a normalised name, ON PURPOSE: substring matching gave
 * false hits (RecDrinkRow → DrinkRow), and a false "built" closes a task
 * nobody did. Diverged names are closed by a `--map` file — a recorded
 * decision, not a guess.
 *
 * Ported from `capabilities/mn-verify-gate/scripts/design-registry.mjs`. The
 * readers and the reconciliation are the script's, split into pure functions;
 * file walks are sorted so the same tree always yields the same document.
 *
 * ADR-457 build-at-publish: source in src/mn-design-registry.cts, compiled to
 * gsd-core/bin/lib/mn-design-registry.cjs (gitignored).
 */

import fs from 'node:fs';
import path from 'node:path';
import { derivedMarker } from './mermaid.cjs';

// ─── Design masters ──────────────────────────────────────────────────────────

export interface Master {
  id: string;
  name: string;
  states: string[];
  instances: number;
  origin: string;
}

export type SourceMode = 'html' | 'registry' | 'pen';

export interface SourceInfo {
  mode: SourceMode;
  label: string;
  fallback: boolean;
  extra: { files?: number; dangling?: number; tokens?: number; themes?: string[] };
}

export type ReadFailure = { ok: false; reason: 'not_found' | 'unreadable' | 'empty'; message: string; hint?: string };
export type MastersResult = { ok: true; masters: Master[] } | ReadFailure;

/**
 * Masters from HTML export pages. Pencil writes the node id and name on an
 * element; both attribute orders are accepted. Only `component/…` names are
 * Kit masters; a repeated id counts as an instance.
 */
export function parseHtmlMasters(pages: Array<{ file: string; text: string }>): MastersResult {
  const found = new Map<string, Master>();
  for (const page of pages) {
    const patterns: Array<[RegExp, 0 | 1]> = [
      [/data-(?:node-)?id=["']([\w-]+)["'][^>]*data-(?:node-)?name=["']([^"']+)["']/gi, 0],
      [/data-(?:node-)?name=["']([^"']+)["'][^>]*data-(?:node-)?id=["']([\w-]+)["']/gi, 1],
    ];
    for (const [re, order] of patterns) {
      for (const m of page.text.matchAll(re)) {
        const id = order === 0 ? m[1] : m[2];
        const name = order === 0 ? m[2] : m[1];
        if (!/^component\//i.test(name)) continue;
        const clean = name.replace(/^component\//i, '').trim();
        const known = found.get(id);
        if (known === undefined) found.set(id, { id, name: clean, states: [], instances: 0, origin: path.basename(page.file) });
        else known.instances += 1;
      }
    }
  }
  if (found.size === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'в HTML-экспорте не нашлось ни одного узла с data-id/data-name и префиксом "component/"',
      hint: 'Экспорт может не нести атрибутов нод. Тогда идите через --registry (DESIGN-SYSTEM.md) — он для этого и заведён.',
    };
  }
  return { ok: true, masters: [...found.values()] };
}

/**
 * Masters from DESIGN-SYSTEM.md: ONLY the table under a heading about
 * components. Without that anchor the parser drags in tokens
 * (`p-green-500 | #1F7A3D`), the zone map and backticked prose — measured on
 * a real file: 41 "components", ~35 of them noise.
 */
export function parseRegistryMasters(markdown: string): MastersResult {
  const HEAD_RE = /^\s{0,3}#{2,4}\s+(.*)$/;
  const COMPONENT_SECTION = /(компонент|component)/i;
  const found = new Map<string, Master>();
  let inSection = false;
  for (const line of markdown.split('\n')) {
    const head = line.match(HEAD_RE);
    if (head) {
      inSection = COMPONENT_SECTION.test(head[1]);
      continue;
    }
    if (!inSection || !/^\s*\|/.test(line)) continue;
    const cells = line
      .split('|')
      .map((c) => c.trim())
      .filter((c, i, a) => !(i === 0 && !c) && !(i === a.length - 1 && !c));
    if (cells.length < 2) continue;
    const idCell = cells[0].replace(/`/g, '').trim();
    if (!/^[A-Za-z0-9_-]{4,12}$/.test(idCell)) continue;
    if (/^(id|нода|node|компонент)/i.test(idCell)) continue;
    if (/^-+$/.test(idCell)) continue;
    const name = cells[1].replace(/[`*]/g, '').trim();
    // A component name is an identifier, not a phrase and not a hex colour.
    if (!name || !/^[A-Za-z][A-Za-z0-9 _-]{1,40}$/.test(name)) continue;
    if (/^#[0-9a-f]{3,8}$/i.test(name)) continue;
    const tail = cells[cells.length - 1] || '';
    const states =
      cells.length >= 3 && /[·×]/.test(tail)
        ? tail
            .split(/[·×]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    if (!found.has(idCell)) found.set(idCell, { id: idCell, name, states, instances: 0, origin: 'DESIGN-SYSTEM.md' });
  }
  if (found.size === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'не нашлось таблицы компонентов',
      hint:
        'Ожидается секция с «Компонент» в заголовке (например «### Компоненты Kit»),\n' +
        'а под ней markdown-таблица: первая колонка — id ноды, вторая — имя компонента.',
    };
  }
  return { ok: true, masters: [...found.values()] };
}

interface PenNode {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  ref?: unknown;
  reusable?: unknown;
  children?: unknown;
}

function penChildren(n: PenNode): PenNode[] {
  return Array.isArray(n.children) ? (n.children as PenNode[]).filter((c) => typeof c === 'object' && c !== null) : [];
}

/** Masters from a raw `.pen` document: `reusable` nodes; states from `StateCell · <name>` frames. */
export function parsePenMasters(
  doc: unknown,
  origin: string,
): { ok: true; masters: Master[]; extra: SourceInfo['extra'] } | ReadFailure {
  if (typeof doc !== 'object' || doc === null || !Array.isArray((doc as PenNode).children)) {
    return { ok: false, reason: 'unreadable', message: `${origin} не похож на .pen — нет массива children.` };
  }
  const nodes: PenNode[] = [];
  const walk = (n: PenNode): void => {
    nodes.push(n);
    for (const c of penChildren(n)) walk(c);
  };
  for (const c of penChildren(doc)) walk(c);

  const instanceCount = new Map<unknown, number>();
  for (const n of nodes) if (n.type === 'ref' && n.ref) instanceCount.set(n.ref, (instanceCount.get(n.ref) ?? 0) + 1);

  const statesBy = new Map<unknown, Set<string>>();
  for (const n of nodes) {
    const nodeName = typeof n.name === 'string' ? n.name : '';
    if (!/^StateCell\b/.test(nodeName)) continue;
    const label = nodeName.replace(/^StateCell\s*·?\s*/, '').trim() || '(без имени)';
    for (const c of penChildren(n)) {
      if (c.type !== 'ref' || !c.ref) continue;
      const set = statesBy.get(c.ref) ?? new Set<string>();
      set.add(label);
      statesBy.set(c.ref, set);
    }
  }

  const masters: Master[] = nodes
    .filter((n) => n.reusable)
    .map((n) => ({
      id: String(n.id),
      name: (typeof n.name === 'string' ? n.name : '').replace(/^component\//, ''),
      states: [...(statesBy.get(n.id) ?? [])],
      instances: instanceCount.get(n.id) ?? 0,
      origin,
    }));
  if (masters.length === 0) {
    return { ok: false, reason: 'empty', message: `в ${origin} нет ни одного узла с reusable:true — нечего сверять.` };
  }
  const ids = new Set(nodes.map((n) => n.id));
  const dangling = nodes.filter((n) => n.type === 'ref' && n.ref && !ids.has(n.ref)).length;
  const d = doc as { variables?: unknown; themes?: unknown };
  return {
    ok: true,
    masters,
    extra: {
      dangling,
      tokens: typeof d.variables === 'object' && d.variables !== null ? Object.keys(d.variables).length : 0,
      themes: typeof d.themes === 'object' && d.themes !== null ? Object.keys(d.themes) : [],
    },
  };
}

// ─── Code ────────────────────────────────────────────────────────────────────

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next', 'tmp', '.expo']);

/** Component source files under `root`: `.js/.jsx/.ts/.tsx`, not tests or stories; sorted walk. */
export function listSources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.[jt]sx?$/.test(e.name) && !/\.(spec|test|stories)\./.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}

const EXPORT_RE = /export\s+(?:default\s+)?(?:const|function|class)\s+([A-Z]\w*)/g;

/** Exported PascalCase symbols → the files exporting them, in walk order. */
export function collectExports(files: Array<{ file: string; text: string }>): Map<string, string[]> {
  const bySymbol = new Map<string, string[]>();
  for (const { file, text } of files) {
    for (const m of text.matchAll(EXPORT_RE)) {
      const list = bySymbol.get(m[1]) ?? [];
      list.push(file);
      bySymbol.set(m[1], list);
    }
  }
  return bySymbol;
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export type Confidence = 'exact' | 'mapped' | 'ignored' | 'map-broken' | null;

export interface RegistryRow {
  nodeId: string;
  component: string;
  instances: number;
  states: string[];
  /** Project-relative POSIX path of the first exporting file, or null. */
  code: string | null;
  symbol: string | null;
  /** Number of files exporting the matched name when more than one, else 0. */
  ambiguous: number;
  confidence: Confidence;
  status: 'implemented' | 'ignored' | 'missing';
}

export interface CodeOnly {
  symbol: string;
  file: string;
}

/** `--map`: node id or component name → symbol, or `false` for "not needed". */
export type ManualMap = Record<string, string | false>;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const KIT_HINT = /(\/kit\/|\/ui-kit\/|\/components?\/|ui-native)/;
const NOT_A_COMPONENT = /(\.screen\.|\.context\.|\.provider\.|-icons?\.|\/icons?\/|\.hook\.|\/gallery\/)/;

/**
 * Join masters to exports. `rel` turns an absolute file into the path the
 * document shows. Rows are ordered by instance count, then name; code-only
 * symbols (in a Kit-looking file, not icons/providers/screens) by name.
 */
export function reconcile(
  masters: Master[],
  exportsBySymbol: Map<string, string[]>,
  manualMap: ManualMap,
  rel: (file: string) => string,
): { rows: RegistryRow[]; codeOnly: CodeOnly[] } {
  const byNorm = new Map<string, { sym: string; files: string[] }>();
  for (const [sym, files] of exportsBySymbol) {
    const k = norm(sym);
    if (!byNorm.has(k)) byNorm.set(k, { sym, files });
  }
  const rows = masters
    .map((m): RegistryRow => {
      let match: { sym: string; files: string[] } | null = null;
      let confidence: Confidence = null;
      const own = (k: string): boolean => Object.prototype.hasOwnProperty.call(manualMap, k);
      const want = own(m.id) ? manualMap[m.id] : own(m.name) ? manualMap[m.name] : undefined;
      if (want !== undefined) {
        if (want === false) confidence = 'ignored';
        else if (exportsBySymbol.has(want)) {
          match = { sym: want, files: exportsBySymbol.get(want) as string[] };
          confidence = 'mapped';
        } else confidence = 'map-broken';
      } else {
        const hit = byNorm.get(norm(m.name));
        if (hit !== undefined) {
          match = hit;
          confidence = 'exact';
        }
      }
      return {
        nodeId: m.id,
        component: m.name,
        instances: m.instances,
        states: m.states,
        code: match ? rel(match.files[0]) : null,
        symbol: match ? match.sym : null,
        ambiguous: match && match.files.length > 1 ? match.files.length : 0,
        confidence,
        status: match ? 'implemented' : confidence === 'ignored' ? 'ignored' : 'missing',
      };
    })
    .sort((a, b) => b.instances - a.instances || a.component.localeCompare(b.component, 'en'));

  const designNorms = new Set(masters.map((m) => norm(m.name)));
  const codeOnly: CodeOnly[] = [];
  for (const [sym, files] of exportsBySymbol) {
    if (designNorms.has(norm(sym))) continue;
    if (/(Icon|Provider|Context|Screen)$/.test(sym)) continue;
    const uiFile = files.find((f) => KIT_HINT.test(f) && /\.[jt]sx$/.test(f) && !NOT_A_COMPONENT.test(f));
    if (!uiFile) continue;
    codeOnly.push({ symbol: sym, file: rel(uiFile) });
  }
  codeOnly.sort((a, b) => a.symbol.localeCompare(b.symbol, 'en'));
  return { rows, codeOnly };
}

// ─── Rendering ───────────────────────────────────────────────────────────────

export const DESIGN_REGISTRY_SOURCE = 'design-registry';

export interface RegistrySummary {
  sourceMode: SourceMode;
  sourceLabel: string;
  fallback: boolean;
  masters: number;
  implemented: number;
  missing: number;
  ignored: number;
  codeOnly: number;
  ambiguous: number;
  mapBroken: number;
  files?: number;
  dangling?: number;
  tokens?: number;
  themes?: string[];
}

export function summarize(source: SourceInfo, masters: Master[], rows: RegistryRow[], codeOnly: CodeOnly[]): RegistrySummary {
  return {
    sourceMode: source.mode,
    sourceLabel: source.label,
    fallback: source.fallback,
    masters: masters.length,
    implemented: rows.filter((r) => r.status === 'implemented').length,
    missing: rows.filter((r) => r.status === 'missing').length,
    ignored: rows.filter((r) => r.status === 'ignored').length,
    codeOnly: codeOnly.length,
    ambiguous: rows.filter((r) => r.ambiguous).length,
    mapBroken: rows.filter((r) => r.confidence === 'map-broken').length,
    ...source.extra,
  };
}

const esc = (s: string): string => s.replace(/\|/g, '\\|');

/** The derived registry document (Russian, as the design documents it sits next to). */
export function renderRegistry(summary: RegistrySummary, masters: Master[], rows: RegistryRow[], codeOnly: CodeOnly[]): string {
  const out: string[] = [derivedMarker(DESIGN_REGISTRY_SOURCE)];
  if (summary.fallback) {
    out.push('');
    out.push('> ⚠ Прочитано напрямую из `.pen`, в обход HTML-экспорта. Это аварийный путь:');
    out.push('> канон — `export_html` из Pencil, либо реестр в `DESIGN-SYSTEM.md`.');
  }
  out.push('');
  out.push(
    `Источник: \`${summary.sourceLabel}\` · мастеров ${summary.masters} · **реализовано ${summary.implemented}**, не начато ${summary.missing}, в коде без ноды ${summary.codeOnly}.`,
  );
  out.push('');
  out.push('Колонки «Нода», «Компонент», «Состояния» — из дизайна. Колонка «Код» — с диска,');
  out.push('перечитывается. Статус `todo/in-progress/done` и осознанные расхождения');
  out.push('здесь не выводятся: это решение человека, его место в DESIGN-SYSTEM.md.');
  const mapBroken = rows.filter((r) => r.confidence === 'map-broken');
  const ambiguous = rows.filter((r) => r.ambiguous);
  if (summary.dangling) out.push(`\n⚠ Битых ссылок в дизайне: ${summary.dangling} — инстанс указывает на удалённый мастер.`);
  if (mapBroken.length) out.push(`\n⚠ В \`--map\` указаны символы, которых нет в коде: ${mapBroken.map((r) => r.component).join(', ')}`);
  if (ambiguous.length) out.push(`\n⚠ Имя встречается в нескольких файлах (взят первый): ${ambiguous.map((r) => r.component).join(', ')}`);
  out.push('');
  out.push('## Реестр');
  out.push('');
  const showInst = masters.some((m) => m.instances > 0);
  out.push(`| Нода | Компонент |${showInst ? ' Исп. |' : ''} Состояния в дизайне | Код | Реализован |`);
  out.push(`|---|---|${showInst ? '---:|' : ''}---|---|---|`);
  for (const r of rows) {
    const states = r.states.length ? esc(r.states.join(' · ')) : '—';
    const code = r.code ? `\`${esc(r.code)}\`` : '—';
    const done = r.status === 'implemented' ? '✅' : r.status === 'ignored' ? '⊘ не нужен' : '❌';
    out.push(`| \`${r.nodeId}\` | ${esc(r.component)} |${showInst ? ` ${r.instances} |` : ''} ${states} | ${code} | ${done} |`);
  }
  if (codeOnly.length) {
    out.push('');
    out.push('## В коде, но не в реестре дизайна');
    out.push('');
    out.push('Либо дизайн отстал от кода, либо компонент служебный и в макет не попадёт.');
    out.push('Решает человек — помечать в DESIGN-SYSTEM.md, а не здесь.');
    out.push('');
    out.push('| Символ | Файл |');
    out.push('|---|---|');
    for (const c of codeOnly) out.push(`| ${esc(c.symbol)} | \`${esc(c.file)}\` |`);
  }
  return `${out.join('\n')}\n`;
}

// ─── Command core ────────────────────────────────────────────────────────────

export interface DesignRegistryOptions {
  /** Project root: relative paths in the document are relative to it. */
  cwd: string;
  /** Absolute input (confined by the router). */
  source: { mode: SourceMode; path: string };
  /** Absolute code root. */
  code: string;
  /** Absolute `--map` file, or null. */
  map: string | null;
  /** `--check`: fail on unimplemented components beyond `threshold`, or on a broken map. */
  check: boolean;
  threshold: number;
}

export type DesignRegistryResult =
  | {
      ok: true;
      summary: RegistrySummary;
      components: RegistryRow[];
      codeOnly: CodeOnly[];
      markdown: string;
      /** Set when `check` was asked and failed: the caller fails the process after printing. */
      check_failed: null | { reason: 'map_broken' | 'unimplemented'; message: string };
    }
  | { ok: false; reason: ReadFailure['reason'] | 'bad_map'; message: string; hint?: string };

function posixRel(cwd: string, file: string): string {
  return path.relative(cwd, file).split(path.sep).join('/');
}

function readMasters(opts: DesignRegistryOptions): { ok: true; masters: Master[]; source: SourceInfo } | ReadFailure {
  const { mode, path: input } = opts.source;
  const label = posixRel(opts.cwd, input);
  if (!fs.existsSync(input)) {
    const hint =
      mode === 'html' ? 'Сделайте export_html из Pencil в этот путь.' : mode === 'registry' ? 'DESIGN-SYSTEM.md заводится по скиллу quality-design.' : undefined;
    return { ok: false, reason: 'not_found', message: `не найден ${mode === 'html' ? 'HTML-экспорт' : 'файл'}: ${label}`, ...(hint ? { hint } : {}) };
  }
  if (mode === 'html') {
    const files: string[] = [];
    if (fs.statSync(input).isDirectory()) {
      const walk = (d: string): void => {
        const entries = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (/\.html?$/i.test(e.name)) files.push(f);
        }
      };
      walk(input);
    } else files.push(input);
    if (files.length === 0) {
      return { ok: false, reason: 'empty', message: `в ${label} нет ни одного .html`, hint: 'Проверьте, что export_html действительно отработал.' };
    }
    const parsed = parseHtmlMasters(files.map((file) => ({ file, text: fs.readFileSync(file, 'utf-8') })));
    if (!parsed.ok) return parsed;
    return { ok: true, masters: parsed.masters, source: { mode, label, fallback: false, extra: { files: files.length } } };
  }
  let text: string;
  try {
    text = fs.readFileSync(input, 'utf-8');
  } catch (e) {
    return { ok: false, reason: 'unreadable', message: `не смог прочитать ${label}: ${(e as Error).message}` };
  }
  if (mode === 'registry') {
    const parsed = parseRegistryMasters(text);
    if (!parsed.ok) return { ...parsed, message: `в ${label} ${parsed.message}` };
    return { ok: true, masters: parsed.masters, source: { mode, label, fallback: false, extra: {} } };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return {
      ok: false,
      reason: 'unreadable',
      message: `не смог прочитать ${label}: ${(e as Error).message}`,
      hint: 'Если файл открыт в Pencil и не сохранён — сохраните его.',
    };
  }
  const parsed = parsePenMasters(doc, path.basename(input));
  if (!parsed.ok) return parsed;
  return { ok: true, masters: parsed.masters, source: { mode, label, fallback: true, extra: parsed.extra } };
}

/** Everything `gsd-tools mn design-registry` does except argv parsing, path confinement and exit. */
export function runDesignRegistry(opts: DesignRegistryOptions): DesignRegistryResult {
  const read = readMasters(opts);
  if (!read.ok) return read;
  if (!fs.existsSync(opts.code)) {
    return { ok: false, reason: 'not_found', message: `каталог кода не найден: ${posixRel(opts.cwd, opts.code)}` };
  }
  const sources = listSources(opts.code);
  if (sources.length === 0) {
    return { ok: false, reason: 'empty', message: `под ${posixRel(opts.cwd, opts.code)} нет ни одного исходника — сверять не с чем.` };
  }
  const texts: Array<{ file: string; text: string }> = [];
  for (const file of sources) {
    try {
      texts.push({ file, text: fs.readFileSync(file, 'utf-8') });
    } catch {
      // An unreadable source file exports nothing we can see — skipping it is what the script did.
    }
  }
  let manualMap: ManualMap = {};
  if (opts.map !== null) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(opts.map, 'utf-8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
      manualMap = parsed as ManualMap;
    } catch (e) {
      return { ok: false, reason: 'bad_map', message: `не смог прочитать --map ${posixRel(opts.cwd, opts.map)}: ${(e as Error).message}` };
    }
  }
  const { rows, codeOnly } = reconcile(read.masters, collectExports(texts), manualMap, (f) => posixRel(opts.cwd, f));
  const summary = summarize(read.source, read.masters, rows, codeOnly);
  let check_failed: null | { reason: 'map_broken' | 'unimplemented'; message: string } = null;
  if (opts.check) {
    const missing = rows.filter((r) => r.status === 'missing');
    if (summary.mapBroken > 0) {
      check_failed = { reason: 'map_broken', message: `--map ссылается на ${summary.mapBroken} несуществующих символов.` };
    } else if (missing.length > opts.threshold) {
      check_failed = {
        reason: 'unimplemented',
        message: `${missing.length} компонентов дизайна без реализации (порог ${opts.threshold}): ${missing.map((r) => r.component).join(', ')}`,
      };
    }
  }
  return {
    ok: true,
    summary,
    components: rows,
    codeOnly,
    markdown: renderRegistry(summary, read.masters, rows, codeOnly),
    check_failed,
  };
}
