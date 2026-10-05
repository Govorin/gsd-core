#!/usr/bin/env node
'use strict';

/**
 * Report A/B experiment, mode `arch` (pocock wave 3) — fixture generator and variant builder.
 *
 * Question: does handing the architecture surveyor the deterministic `arch metrics` signals help it
 * find deepening candidates, or do the signals anchor it on the classes they flag and pull it away
 * from the ones they cannot see (the 4.9 lesson)?
 *
 * Writes, under the output directory (default: ./out-arch next to this file):
 *
 *   repos/<fx>/          a small TypeScript service per fixture, a real git repository whose
 *                        history has fixed dates, so every sha is reproducible
 *   reports/<fx>/{A,C,Cp,D}.md the four variants of what the surveyor reads
 *   ground-truth.json    the seeded defects (the answer key) and each report's sha256
 *
 * Variants — the SOURCE is the same bytes in all three, only the metrics around it differ. The
 * header follows the surveyor prompt of gsd-core/workflows/arch-survey.md, with one zone holding
 * the whole repository, since a fixture is one zone's worth of code:
 *   A   the zone header and every source file — no metrics;
 *   C   A + the `<signals>` block (ZoneSignals shape, computed for the whole-repository zone) and the
 *       per-module rows of the metrics file (`modules`, `cycles`, `passThrough`, `smallClusters`,
 *       `coChange`, `hotspots`) exactly as `gsd-tools arch metrics` writes them;
 *   Cp  C + the `<what_the_metrics_checked>` block, read verbatim from agents/gsd-arch-surveyor.md
 *       as of CP_SOURCE_REV — the form the fork shipped (C′ of 4.9: "checked only X; find the rest");
 *   D   A + the `<zone_and_metrics>` block the agent ships now, read at generation time: no metrics
 *       in the prompt, the counted classes reported by `arch report` instead (the wave 3 patch).
 *
 * Defect classes (three per category, each seeded three times across six fixtures; two fixtures
 * are clean controls):
 *   flagged by arch metrics:  cycle (a runtime import cycle of 2–3 modules), pass_through (a small
 *                             module with one importer and one import that only forwards),
 *                             small_cluster (3+ small modules in one directory: one concept cut
 *                             into pieces)
 *   not flagged by design:    scattered (one rule re-implemented in three modules, a little
 *                             differently, never changed together), leaky_seam (a store or
 *                             transport hands its callers driver rows / SQL / protocol codes),
 *                             shallow_interface (a module over the small-module bound whose
 *                             interface is as wide as its implementation)
 *
 * The generator checks itself: the real CLI runs over every fixture, and `cycles`, `passThrough`
 * and `smallClusters` must hold exactly the seeded flagged defects (nothing on a control); the
 * shallow module must not be small and no co-change row may appear (none between scattered places).
 *
 * Usage: node scripts/experiments/report-ab/fixtures-arch.cjs [--out <dir>]
 * Needs the compiled lib (`npm run build:lib`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const SURVEYOR = path.join(ROOT, 'agents', 'gsd-arch-surveyor.md');
const METRICS_DATE = '2026-10-01';
const SINCE = '2026-08-01';
// Enough zones that every hot spot opens one; the seed shown is the first zone's (default is 5).
const TOP_ZONES = 20;
const VARIANTS = ['A', 'C', 'Cp', 'D'];
// The commit whose agents/gsd-arch-surveyor.md still carried the C′ block (before the D patch).
const CP_SOURCE_REV = 'ca14cffb3';
const ts = String.raw;

// ─── Fixture table ───────────────────────────────────────────────────────────

const DOMAINS = [
  { key: 'shop', main: 'order', Main: 'Order', mains: 'orders', party: 'customer', Party: 'Customer', parties: 'customers',
    doc: 'invoice', Doc: 'Invoice', item: 'line', Item: 'Line', states: ['pending', 'paid', 'shipped', 'cancelled'],
    prefix: 'INV', currency: 'EUR', taxRate: 0.2, termDays: 14 },
  { key: 'library', main: 'loan', Main: 'Loan', mains: 'loans', party: 'member', Party: 'Member', parties: 'members',
    doc: 'notice', Doc: 'Notice', item: 'copy', Item: 'Copy', states: ['reserved', 'active', 'returned', 'lost'],
    prefix: 'NTC', currency: 'GBP', taxRate: 0, termDays: 21 },
  { key: 'clinic', main: 'appointment', Main: 'Appointment', mains: 'appointments', party: 'patient', Party: 'Patient', parties: 'patients',
    doc: 'bill', Doc: 'Bill', item: 'procedure', Item: 'Procedure', states: ['booked', 'checked_in', 'completed', 'cancelled'],
    prefix: 'BIL', currency: 'USD', taxRate: 0.07, termDays: 30 },
  { key: 'fleet', main: 'trip', Main: 'Trip', mains: 'trips', party: 'driver', Party: 'Driver', parties: 'drivers',
    doc: 'manifest', Doc: 'Manifest', item: 'stop', Item: 'Stop', states: ['planned', 'en_route', 'delivered', 'aborted'],
    prefix: 'MNF', currency: 'EUR', taxRate: 0.19, termDays: 10 },
];

/** Six seeded fixtures (each class a/b/c once, three classes per fixture) and two controls. */
const FIXTURES = [
  { id: 'arch-01', domain: 0, seed: 101, defects: ['cycle-a', 'scattered-b', 'shallow-a'] },
  { id: 'arch-02', domain: 1, seed: 202, defects: ['pass-a', 'leaky-b', 'cluster-b'] },
  { id: 'arch-03', domain: 2, seed: 303, defects: ['cycle-b', 'leaky-c', 'cluster-c'] },
  { id: 'arch-04', domain: 3, seed: 404, defects: ['pass-b', 'scattered-c', 'shallow-b'] },
  { id: 'arch-05', domain: 1, seed: 505, defects: ['cycle-c', 'cluster-a', 'leaky-a'] },
  { id: 'arch-06', domain: 2, seed: 606, defects: ['pass-c', 'scattered-a', 'shallow-c'] },
  { id: 'arch-07', domain: 3, seed: 707, defects: [] },
  { id: 'arch-08', domain: 0, seed: 808, defects: [] },
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

// ─── Paths ───────────────────────────────────────────────────────────────────

function pathsFor(d) {
  return {
    types: 'src/shared/types.ts',
    errors: 'src/shared/errors.ts',
    settings: 'src/config/settings.ts',
    conn: 'src/db/connection.ts',
    mainStore: `src/db/${d.main}-store.ts`,
    partyStore: `src/db/${d.party}-store.ts`,
    pricing: `src/${d.main}/pricing.ts`,
    validation: `src/${d.main}/validation.ts`,
    mainService: `src/${d.main}/service.ts`,
    partyService: `src/${d.party}/service.ts`,
    profile: `src/${d.party}/profile.ts`,
    builder: `src/${d.doc}/builder.ts`,
    renderer: `src/${d.doc}/renderer.ts`,
    templates: 'src/notify/templates.ts',
    mailer: 'src/notify/mailer.ts',
    scheduler: 'src/jobs/scheduler.ts',
    reminders: 'src/jobs/reminders.ts',
    audit: 'src/audit/log.ts',
    router: 'src/http/router.ts',
    middleware: 'src/http/middleware.ts',
    hMain: `src/http/${d.main}-handlers.ts`,
    hParty: `src/http/${d.party}-handlers.ts`,
    gateway: `src/${d.main}/gateway.ts`,
    dispatch: 'src/notify/dispatch.ts',
    exporter: `src/${d.doc}/export.ts`,
    clusterA: ['states', 'is-terminal', 'can-transition', 'label'].map((n) => `src/${d.main}/status/${n}.ts`),
    clusterB: ['prefix', 'sequence', 'pad', 'format'].map((n) => `src/${d.doc}/numbering/${n}.ts`),
    clusterC: ['email', 'phone', 'normalize', 'display'].map((n) => `src/${d.party}/contact/${n}.ts`),
  };
}

// ─── Shared snippets (they keep the callers in step with the variant of their dependency) ───

const SETTINGS_KEYS = ['port', 'databaseUrl', 'poolSize', 'smtpHost', 'smtpPort', 'mailFrom', 'currency', 'taxRate',
  'paymentTermDays', 'reminderLeadDays', 'pageSizeDefault', 'pageSizeMax', 'auditEnabled'];

function cfgImport(f) {
  return f.has('shallow-a') ? "import { config } from '../config/settings';" : "import { settings } from '../config/settings';";
}

function cfg(f, key) {
  return f.has('shallow-a') ? `config().get${cap(key)}()` : `settings().${key}`;
}

function auditImport(f) {
  return f.has('shallow-b') ? "import { audit } from '../audit/log';" : "import { record } from '../audit/log';";
}

/** One audit call, in the shape the audit module of this fixture offers. */
function auditCall(f, d, event, actor, id, extra = '') {
  if (f.has('shallow-b')) {
    const method = {
      mainCreated: `${d.main}Created`, mainStatusChanged: `${d.main}StatusChanged`, mainCancelled: `${d.main}Cancelled`,
      partyRegistered: `${d.party}Registered`, partyUpdated: `${d.party}Updated`, reminderSent: 'reminderSent',
    }[event];
    // The object-literal detail ('from, to: next') becomes positional arguments ('from, next').
    const args = extra.replace(/\w+: (\w+)/g, '$1');
    return `audit.${method}(${[actor, id, args].filter((x) => x !== '').join(', ')});`;
  }
  const [action, entity] = {
    mainCreated: ['created', d.main], mainStatusChanged: ['status_changed', d.main], mainCancelled: ['cancelled', d.main],
    partyRegistered: ['created', d.party], partyUpdated: ['updated', d.party], reminderSent: ['reminded', d.main],
  }[event];
  return `record(${actor}, '${action}', '${entity}', ${id}${extra === '' ? '' : `, { ${extra} }`});`;
}

// ─── Modules ─────────────────────────────────────────────────────────────────

function typesModule(d) {
  const [s0, s1, s2, s3] = d.states;
  return ts`export type ${d.Main}Status = '${s0}' | '${s1}' | '${s2}' | '${s3}';

export interface ${d.Item} {
  code: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface ${d.Main} {
  id: string;
  ${d.party}Id: string;
  status: ${d.Main}Status;
  items: ${d.Item}[];
  createdAt: Date;
  updatedAt: Date;
  note?: string;
}

export interface ${d.Party} {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  tier: 'standard' | 'priority';
  joinedAt: Date;
  expiresAt: Date | null;
}

export interface ${d.Doc} {
  number: string;
  ${d.main}Id: string;
  issuedAt: Date;
  dueAt: Date;
  lines: Array<{ label: string; amount: number }>;
  subtotal: number;
  tax: number;
  total: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
`;
}

function errorsModule() {
  return ts`export class NotFoundError extends Error {
  constructor(readonly entity: string, readonly id: string) {
    super(entity + ' ' + id + ' not found');
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(readonly issues: string[]) {
    super('invalid input: ' + issues.join('; '));
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export function isDomainError(error: unknown): error is NotFoundError | ValidationError | ConflictError {
  return error instanceof NotFoundError || error instanceof ValidationError || error instanceof ConflictError;
}
`;
}

function settingsModule(d, f, rnd) {
  const pool = pick(rnd, [8, 10, 16]);
  const lead = pick(rnd, [2, 3, 5]);
  const head = ts`export interface Settings {
  port: number;
  databaseUrl: string;
  poolSize: number;
  smtpHost: string;
  smtpPort: number;
  mailFrom: string;
  currency: string;
  taxRate: number;
  paymentTermDays: number;
  reminderLeadDays: number;
  pageSizeDefault: number;
  pageSizeMax: number;
  auditEnabled: boolean;
}

const DEFAULTS: Settings = {
  port: 8080,
  databaseUrl: 'postgres://localhost:5432/${d.key}',
  poolSize: ${pool},
  smtpHost: 'localhost',
  smtpPort: 25,
  mailFrom: 'no-reply@${d.key}.example',
  currency: '${d.currency}',
  taxRate: ${d.taxRate},
  paymentTermDays: ${d.termDays},
  reminderLeadDays: ${lead},
  pageSizeDefault: 20,
  pageSizeMax: 100,
  auditEnabled: true,
};

function readNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('setting ' + key + ' is not a number: ' + raw);
  return value;
}

function readString(env: Record<string, string | undefined>, key: string, fallback: string): string {
  const raw = env[key];
  return raw === undefined || raw === '' ? fallback : raw;
}

export function loadSettings(env: Record<string, string | undefined> = process.env): Settings {
  const loaded: Settings = {
    port: readNumber(env, 'PORT', DEFAULTS.port),
    databaseUrl: readString(env, 'DATABASE_URL', DEFAULTS.databaseUrl),
    poolSize: readNumber(env, 'DB_POOL_SIZE', DEFAULTS.poolSize),
    smtpHost: readString(env, 'SMTP_HOST', DEFAULTS.smtpHost),
    smtpPort: readNumber(env, 'SMTP_PORT', DEFAULTS.smtpPort),
    mailFrom: readString(env, 'MAIL_FROM', DEFAULTS.mailFrom),
    currency: readString(env, 'CURRENCY', DEFAULTS.currency),
    taxRate: readNumber(env, 'TAX_RATE', DEFAULTS.taxRate),
    paymentTermDays: readNumber(env, 'PAYMENT_TERM_DAYS', DEFAULTS.paymentTermDays),
    reminderLeadDays: readNumber(env, 'REMINDER_LEAD_DAYS', DEFAULTS.reminderLeadDays),
    pageSizeDefault: readNumber(env, 'PAGE_SIZE_DEFAULT', DEFAULTS.pageSizeDefault),
    pageSizeMax: readNumber(env, 'PAGE_SIZE_MAX', DEFAULTS.pageSizeMax),
    auditEnabled: env.AUDIT_ENABLED !== 'false',
  };
  if (loaded.pageSizeDefault > loaded.pageSizeMax) throw new Error('PAGE_SIZE_DEFAULT exceeds PAGE_SIZE_MAX');
  if (loaded.taxRate < 0 || loaded.taxRate > 1) throw new Error('TAX_RATE must be between 0 and 1');
  return loaded;
}
`;
  if (f.has('shallow-a')) {
    const getters = SETTINGS_KEYS.map((k) => `  get${cap(k)}(): Settings['${k}'] {\n    return this.values.${k};\n  }\n`).join('\n');
    return head + ts`
/** Every setting the service reads, one accessor each. */
export class Config {
  constructor(private readonly values: Settings) {}

${getters}
  setTaxRate(rate: number): void {
    this.values.taxRate = rate;
  }

  setPageSizeMax(size: number): void {
    this.values.pageSizeMax = size;
  }

  setAuditEnabled(enabled: boolean): void {
    this.values.auditEnabled = enabled;
  }

  toJSON(): Settings {
    return { ...this.values };
  }
}

let cached: Config | null = null;

export function config(): Config {
  if (cached === null) cached = new Config(loadSettings());
  return cached;
}

export function resetConfigForTests(): void {
  cached = null;
}
`;
  }
  return head + ts`
let cached: Settings | null = null;

export function settings(): Settings {
  if (cached === null) cached = loadSettings();
  return cached;
}

export function resetSettingsForTests(): void {
  cached = null;
}
`;
}

function connectionModule(d, f, stage, rnd) {
  const retries = pick(rnd, [2, 3]);
  return ts`${cfgImport(f)}

export interface QueryResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface Db {
  query<Row = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<Row>>;
  transaction<T>(work: (db: Db) => Promise<T>): Promise<T>;
}

export interface Driver {
  execute(sql: string, params: unknown[]): Promise<{ rows: unknown[]; rowCount: number }>;
  close(): Promise<void>;
}

const TRANSIENT = new Set(['ECONNRESET', '57P01', '40001', '40P01']);

export function isTransient(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code !== undefined && TRANSIENT.has(code);
}

export function createDb(driver: Driver, maxRetries = ${retries}): Db {
  const run = async <Row>(sql: string, params: unknown[] = []): Promise<QueryResult<Row>> => {
    let attempt = 0;
    for (;;) {
      try {
        const result = await driver.execute(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      } catch (error) {
        attempt += 1;
        if (attempt > maxRetries || !isTransient(error)) throw error;
      }
    }
  };
  const db: Db = {
    query: run,
    async transaction(work) {
      await run('BEGIN');
      try {
        const out = await work(db);
        await run('COMMIT');
        return out;
      } catch (error) {
        await run('ROLLBACK');
        throw error;
      }
    },
  };
  return db;
}

export function placeholders(count: number, start = 1): string {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push('$' + (start + i));
  return out.join(', ');
}

export function connectionString(): string {
  return ${cfg(f, 'databaseUrl')} + '?pool=' + ${cfg(f, 'poolSize')};
}
${stage >= 3 ? ts`
export async function withStatementTimeout<T>(db: Db, ms: number, work: () => Promise<T>): Promise<T> {
  await db.query('SET LOCAL statement_timeout = ' + Math.max(1, Math.floor(ms)));
  return work();
}
` : ''}`;
}

function mainStoreModule(d, f) {
  if (f.has('leaky-a')) {
    return ts`import { Db, QueryResult } from './connection';

/** A row of the ${d.mains} table, as the driver returns it. */
export interface ${d.Main}Row {
  id: string;
  ${d.party}_id: string;
  status: string;
  items_json: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export const ${d.Main.toUpperCase()}_COLUMNS = ['id', '${d.party}_id', 'status', 'items_json', 'note', 'created_at', 'updated_at'];

export class ${d.Main}Store {
  constructor(private readonly db: Db) {}

  /** Rows matching a SQL WHERE fragment, e.g. "status = $1 AND ${d.party}_id = $2". */
  select(where: string, params: unknown[] = [], suffix = ''): Promise<QueryResult<${d.Main}Row>> {
    return this.db.query<${d.Main}Row>('SELECT * FROM ${d.mains} WHERE ' + where + (suffix === '' ? '' : ' ' + suffix), params);
  }

  async count(where: string, params: unknown[] = []): Promise<number> {
    const result = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM ${d.mains} WHERE ' + where, params);
    return Number(result.rows[0].n);
  }

  /** Inserts or updates one row; the caller serialises items_json and the timestamps. */
  upsert(row: ${d.Main}Row): Promise<QueryResult<unknown>> {
    return this.db.query(
      'INSERT INTO ${d.mains} (' + ${d.Main.toUpperCase()}_COLUMNS.join(', ') + ') VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
        'ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, items_json = EXCLUDED.items_json, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at',
      [row.id, row.${d.party}_id, row.status, row.items_json, row.note, row.created_at, row.updated_at],
    );
  }

  /** The connection itself, for statements this store does not cover. */
  raw(): Db {
    return this.db;
  }
}
`;
  }
  return ts`import { Db } from './connection';
import { ${d.Main}, ${d.Main}Status, ${d.Item}, Page } from '../shared/types';
import { NotFoundError } from '../shared/errors';

interface ${d.Main}Row {
  id: string;
  ${d.party}_id: string;
  status: string;
  items_json: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function toDomain(row: ${d.Main}Row): ${d.Main} {
  return {
    id: row.id,
    ${d.party}Id: row.${d.party}_id,
    status: row.status as ${d.Main}Status,
    items: JSON.parse(row.items_json) as ${d.Item}[],
    note: row.note ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export interface ${d.Main}Filter {
  ${d.party}Id?: string;
  status?: ${d.Main}Status;
}

export class ${d.Main}Store {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<${d.Main}> {
    const result = await this.db.query<${d.Main}Row>('SELECT * FROM ${d.mains} WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new NotFoundError('${d.main}', id);
    return toDomain(result.rows[0]);
  }

  async list(filter: ${d.Main}Filter, offset: number, limit: number): Promise<Page<${d.Main}>> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.${d.party}Id !== undefined) {
      params.push(filter.${d.party}Id);
      where.push('${d.party}_id = $' + params.length);
    }
    if (filter.status !== undefined) {
      params.push(filter.status);
      where.push('status = $' + params.length);
    }
    const clause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
    const count = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM ${d.mains}' + clause, params);
    const paged = [...params, limit, offset];
    const rows = await this.db.query<${d.Main}Row>(
      'SELECT * FROM ${d.mains}' + clause + ' ORDER BY created_at DESC LIMIT $' + (paged.length - 1) + ' OFFSET $' + paged.length,
      paged,
    );
    return { items: rows.rows.map(toDomain), total: Number(count.rows[0].n), offset, limit };
  }

  async save(entity: ${d.Main}): Promise<void> {
    await this.db.query(
      'INSERT INTO ${d.mains} (id, ${d.party}_id, status, items_json, note, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
        'ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, items_json = EXCLUDED.items_json, note = EXCLUDED.note, updated_at = EXCLUDED.updated_at',
      [entity.id, entity.${d.party}Id, entity.status, JSON.stringify(entity.items), entity.note ?? null, entity.createdAt.toISOString(), entity.updatedAt.toISOString()],
    );
  }

  async staleSince(status: ${d.Main}Status, cutoff: Date): Promise<${d.Main}[]> {
    const result = await this.db.query<${d.Main}Row>('SELECT * FROM ${d.mains} WHERE status = $1 AND updated_at < $2', [status, cutoff.toISOString()]);
    return result.rows.map(toDomain);
  }
}
`;
}

function partyStoreModule(d, f) {
  if (f.has('leaky-b')) {
    return ts`import { Db, QueryResult } from './connection';

/** A row of the ${d.parties} table, column names as in the schema. */
export interface ${d.Party}Row {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  tier: string;
  joined_at: string;
  expires_at: string | null;
}

export class ${d.Party}Store {
  constructor(private readonly db: Db) {}

  /** The driver result as is: callers check rowCount and read the columns they need. */
  byId(id: string): Promise<QueryResult<${d.Party}Row>> {
    return this.db.query<${d.Party}Row>('SELECT * FROM ${d.parties} WHERE id = $1', [id]);
  }

  byEmail(email: string): Promise<QueryResult<${d.Party}Row>> {
    return this.db.query<${d.Party}Row>('SELECT * FROM ${d.parties} WHERE lower(email) = lower($1)', [email]);
  }

  insert(row: ${d.Party}Row): Promise<QueryResult<unknown>> {
    return this.db.query(
      'INSERT INTO ${d.parties} (id, full_name, email, phone, tier, joined_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [row.id, row.full_name, row.email, row.phone, row.tier, row.joined_at, row.expires_at],
    );
  }

  /** Sets the given columns; keys are column names. */
  updateColumns(id: string, columns: Partial<${d.Party}Row>): Promise<QueryResult<unknown>> {
    const keys = Object.keys(columns);
    const sets = keys.map((k, i) => k + ' = $' + (i + 2));
    return this.db.query('UPDATE ${d.parties} SET ' + sets.join(', ') + ' WHERE id = $1', [id, ...keys.map((k) => (columns as Record<string, unknown>)[k])]);
  }

  expiringBefore(cutoff: string): Promise<QueryResult<${d.Party}Row>> {
    return this.db.query<${d.Party}Row>('SELECT * FROM ${d.parties} WHERE expires_at IS NOT NULL AND expires_at < $1', [cutoff]);
  }
}
`;
  }
  return ts`import { Db } from './connection';
import { ${d.Party} } from '../shared/types';
import { NotFoundError } from '../shared/errors';

interface ${d.Party}Row {
  id: string;
  full_name: string;
  email: string;
  phone: string | null;
  tier: string;
  joined_at: string;
  expires_at: string | null;
}

function toDomain(row: ${d.Party}Row): ${d.Party} {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    tier: row.tier === 'priority' ? 'priority' : 'standard',
    joinedAt: new Date(row.joined_at),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}

export class ${d.Party}Store {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<${d.Party}> {
    const result = await this.db.query<${d.Party}Row>('SELECT * FROM ${d.parties} WHERE id = $1', [id]);
    if (result.rowCount === 0) throw new NotFoundError('${d.party}', id);
    return toDomain(result.rows[0]);
  }

  async findByEmail(email: string): Promise<${d.Party} | null> {
    const result = await this.db.query<${d.Party}Row>('SELECT * FROM ${d.parties} WHERE lower(email) = lower($1)', [email]);
    return result.rowCount === 0 ? null : toDomain(result.rows[0]);
  }

  async save(entity: ${d.Party}): Promise<void> {
    await this.db.query(
      'INSERT INTO ${d.parties} (id, full_name, email, phone, tier, joined_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ' +
        'ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, email = EXCLUDED.email, phone = EXCLUDED.phone, tier = EXCLUDED.tier, expires_at = EXCLUDED.expires_at',
      [entity.id, entity.name, entity.email, entity.phone, entity.tier, entity.joinedAt.toISOString(), entity.expiresAt === null ? null : entity.expiresAt.toISOString()],
    );
  }

  async expiringBefore(cutoff: Date): Promise<${d.Party}[]> {
    const result = await this.db.query<${d.Party}Row>('SELECT * FROM ${d.parties} WHERE expires_at IS NOT NULL AND expires_at < $1', [cutoff.toISOString()]);
    return result.rows.map(toDomain);
  }
}
`;
}

function pricingModule(d, f, stage, rnd) {
  const tierHigh = pick(rnd, [40, 50, 60]);
  const tierLow = pick(rnd, [15, 20, 25]);
  const scattered = f.has('scattered-a');
  const round = scattered ? (x) => `Math.round(${x} * 100) / 100` : (x) => `roundMoney(${x})`;
  return ts`import { ${d.Main}, ${d.Item} } from '../shared/types';
${cfgImport(f)}
${f.has('cycle-b') ? `import { describeLine } from '../${d.doc}/builder';\n` : ''}
export interface PriceBreakdown {
  subtotal: number;
  discount: number;
  tax: number;
  total: number;
}

const VOLUME_TIERS: Array<{ minQuantity: number; rate: number }> = [
  { minQuantity: ${tierHigh}, rate: 0.1 },
  { minQuantity: ${tierLow}, rate: 0.05 },
];

export function lineTotal(item: ${d.Item}): number {
  return item.quantity * item.unitPrice;
}

export function volumeDiscountRate(totalQuantity: number): number {
  for (const tier of VOLUME_TIERS) {
    if (totalQuantity >= tier.minQuantity) return tier.rate;
  }
  return 0;
}
${scattered ? '' : ts`
/** Rounds a currency amount to cents, half away from zero. */
export function roundMoney(amount: number): number {
  return Math.sign(amount) * Math.round(Math.abs(amount) * 100) / 100;
}
`}
export function priceOf(entity: ${d.Main}, priority = false): PriceBreakdown {
  const subtotal = entity.items.reduce((sum, item) => sum + lineTotal(item), 0);
  const quantity = entity.items.reduce((sum, item) => sum + item.quantity, 0);
  let rate = volumeDiscountRate(quantity);
  if (priority) rate += 0.02;
  const discount = ${round('subtotal * rate')};
  const taxable = subtotal - discount;
  const tax = ${round(`taxable * ${cfg(f, 'taxRate')}`)};
  return { subtotal: ${round('subtotal')}, discount, tax, total: ${round('taxable + tax')} };
}

export function formatAmount(amount: number): string {
  return (${round('amount')}).toFixed(2) + ' ' + ${cfg(f, 'currency')};
}

export function priceSummary(entities: ${d.Main}[]): { count: number; total: number; average: number } {
  const totals = entities.map((e) => priceOf(e).total);
  const total = totals.reduce((sum, t) => sum + t, 0);
  return { count: totals.length, total: ${round('total')}, average: totals.length === 0 ? 0 : ${round('total / totals.length')} };
}

export function assertPriced(entity: ${d.Main}): void {
  for (const item of entity.items) {
    if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      throw new Error('${d.item} ' + item.code + ' has no valid price');
    }
  }
}
${f.has('cycle-b') ? ts`
/** Priced, labelled lines, in the wording the ${d.doc} uses. */
export function pricedLines(entity: ${d.Main}): Array<{ label: string; amount: number }> {
  return entity.items.map((item) => ({ label: describeLine(item), amount: lineTotal(item) }));
}
` : ''}${stage >= 5 ? ts`
export function averageItemValue(entity: ${d.Main}): number {
  const quantity = entity.items.reduce((sum, item) => sum + item.quantity, 0);
  return quantity === 0 ? 0 : priceOf(entity).subtotal / quantity;
}
` : ''}`;
}

function validationModule(d, f, stage) {
  return ts`import { ${d.Item} } from '../shared/types';
import { ValidationError } from '../shared/errors';

export interface New${d.Main}Input {
  ${d.party}Id: string;
  items: ${d.Item}[];
  note?: string;
}

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const ID_PATTERN = /^[a-z0-9]{8,32}$/;
const MAX_ITEMS = 200;
const MAX_NOTE = 500;

function itemIssues(item: ${d.Item}, index: number): string[] {
  const issues: string[] = [];
  const where = 'items[' + index + ']';
  if (!CODE_PATTERN.test(item.code)) issues.push(where + '.code is malformed');
  if (item.description.trim() === '') issues.push(where + '.description is empty');
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) issues.push(where + '.quantity must be a positive integer');
  if (!Number.isFinite(item.unitPrice) || item.unitPrice < 0) issues.push(where + '.unitPrice must be zero or more');
  return issues;
}

export function validateNew${d.Main}(input: New${d.Main}Input): New${d.Main}Input {
  const issues: string[] = [];
  if (!ID_PATTERN.test(input.${d.party}Id)) issues.push('${d.party}Id is malformed');
  if (input.items.length === 0) issues.push('at least one ${d.item} is required');
  if (input.items.length > MAX_ITEMS) issues.push('too many ${d.item}s');
  input.items.forEach((item, i) => issues.push(...itemIssues(item, i)));
  const codes = new Set<string>();
  for (const item of input.items) {
    if (codes.has(item.code)) issues.push('duplicate ${d.item} ' + item.code);
    codes.add(item.code);
  }
  if (input.note !== undefined && input.note.length > MAX_NOTE) issues.push('note is longer than ' + MAX_NOTE);
  if (issues.length > 0) throw new ValidationError(issues);
  return { ...input, note: input.note?.trim() };
}

export function validateId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new ValidationError(['id is malformed']);
  return id;
}

export function validatePaging(offset: number, limit: number, max: number): { offset: number; limit: number } {
  const issues: string[] = [];
  if (!Number.isInteger(offset) || offset < 0) issues.push('offset must be zero or more');
  if (!Number.isInteger(limit) || limit <= 0) issues.push('limit must be positive');
  if (issues.length > 0) throw new ValidationError(issues);
  return { offset, limit: Math.min(limit, max) };
}
${stage >= 3 ? ts`
export function validateNote(note: string): string {
  const trimmed = note.trim();
  if (trimmed.length > MAX_NOTE) throw new ValidationError(['note is longer than ' + MAX_NOTE]);
  return trimmed;
}
` : ''}`;
}

/** How the ${'main'} service reaches its store in this fixture. */
function mainStoreAccess(d, f) {
  if (f.has('pass-a')) {
    return {
      imp: `import { ${d.Main}Gateway } from './gateway';`,
      ctor: `private readonly gateway: ${d.Main}Gateway`,
      get: (id) => `const entity = await this.gateway.find(${id});`,
      list: (filter, off, lim) => `return this.gateway.list(${filter}, ${off}, ${lim});`,
      save: (e) => `await this.gateway.save(${e});`,
      helper: '',
    };
  }
  if (f.has('leaky-a')) {
    return {
      imp: `import { ${d.Main}Store, ${d.Main}Row } from '../db/${d.main}-store';`,
      ctor: `private readonly store: ${d.Main}Store`,
      get: (id) => ts`const found = await this.store.select('id = $1', [${id}]);
    if (found.rowCount === 0) throw new NotFoundError('${d.main}', ${id});
    const entity = fromRow(found.rows[0]);`,
      list: (filter, off, lim) => ts`const where = ${filter}.status === undefined ? 'TRUE' : 'status = $1';
    const params = ${filter}.status === undefined ? [] : [${filter}.status];
    const total = await this.store.count(where, params);
    const rows = await this.store.select(where, params, 'ORDER BY created_at DESC LIMIT ' + ${lim} + ' OFFSET ' + ${off});
    return { items: rows.rows.map(fromRow), total, offset: ${off}, limit: ${lim} };`,
      save: (e) => ts`await this.store.upsert({
      id: ${e}.id,
      ${d.party}_id: ${e}.${d.party}Id,
      status: ${e}.status,
      items_json: JSON.stringify(${e}.items),
      note: ${e}.note ?? null,
      created_at: ${e}.createdAt.toISOString(),
      updated_at: ${e}.updatedAt.toISOString(),
    });`,
      helper: ts`
function fromRow(row: ${d.Main}Row): ${d.Main} {
  return {
    id: row.id,
    ${d.party}Id: row.${d.party}_id,
    status: row.status as ${d.Main}Status,
    items: JSON.parse(row.items_json),
    note: row.note ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}
`,
    };
  }
  return {
    imp: `import { ${d.Main}Store } from '../db/${d.main}-store';`,
    ctor: `private readonly store: ${d.Main}Store`,
    get: (id) => `const entity = await this.store.findById(${id});`,
    list: (filter, off, lim) => `return this.store.list(${filter}, ${off}, ${lim});`,
    save: (e) => `await this.store.save(${e});`,
    helper: '',
  };
}

function mainServiceModule(d, f) {
  const [s0, s1, s2, s3] = d.states;
  const acc = mainStoreAccess(d, f);
  const clusterA = f.has('cluster-a');
  const lifecycle = clusterA
    ? ts`import { isState } from './status/states';
import { isTerminal } from './status/is-terminal';
import { canTransition } from './status/can-transition';`
    : '';
  const transitions = clusterA ? '' : ts`
const TRANSITIONS: Record<${d.Main}Status, ${d.Main}Status[]> = {
  ${s0}: ['${s1}', '${s3}'],
  ${s1}: ['${s2}', '${s3}'],
  ${s2}: [],
  ${s3}: [],
};
`;
  const allowed = clusterA ? 'isState(next) && canTransition(entity.status, next)' : 'TRANSITIONS[entity.status].includes(next)';
  const terminal = clusterA ? 'isTerminal(entity.status)' : `entity.status === '${s2}' || entity.status === '${s3}'`;
  const filterType = f.has('leaky-a') ? `{ status?: ${d.Main}Status }` : `{ ${d.party}Id?: string; status?: ${d.Main}Status }`;
  return ts`${acc.imp}
import { ${d.Main}, ${d.Main}Status, Page } from '../shared/types';
import { ConflictError${f.has('leaky-a') ? ', NotFoundError' : ''} } from '../shared/errors';
import { priceOf, PriceBreakdown } from './pricing';
import { validateNew${d.Main}, validatePaging, New${d.Main}Input } from './validation';
${auditImport(f)}
${cfgImport(f)}
${f.has('cycle-a') ? `import { isActive${d.Party} } from '../${d.party}/service';\n` : ''}${lifecycle ? lifecycle + '\n' : ''}${transitions}${acc.helper}
let sequence = 0;

function newId(now: Date): string {
  sequence = (sequence + 1) % 100000;
  return now.getTime().toString(36) + sequence.toString(36).padStart(4, '0');
}

/** True while the ${d.main} still counts against its ${d.party}: not finished, not cancelled. */
export function isOpen(entity: ${d.Main}): boolean {
  return entity.status === '${s0}' || entity.status === '${s1}';
}

export class ${d.Main}Service {
  constructor(${acc.ctor}) {}

  async create(actor: string, input: New${d.Main}Input${f.has('cycle-a') ? `, ${d.party}Expiry: Date | null = null` : ''}): Promise<${d.Main}> {
    const valid = validateNew${d.Main}(input);
${f.has('cycle-a') ? `    if (!isActive${d.Party}(${d.party}Expiry, new Date())) throw new ConflictError('${d.party} ' + valid.${d.party}Id + ' is not active');\n` : ''}    const now = new Date();
    const entity: ${d.Main} = { id: newId(now), ${d.party}Id: valid.${d.party}Id, status: '${s0}', items: valid.items, note: valid.note, createdAt: now, updatedAt: now };
    ${acc.save('entity')}
    ${auditCall(f, d, 'mainCreated', 'actor', 'entity.id')}
    return entity;
  }

  async get(id: string): Promise<${d.Main}> {
    ${acc.get('id')}
    return entity;
  }

  async list(filter: ${filterType}, offset: number, limit: number): Promise<Page<${d.Main}>> {
    const page = validatePaging(offset, limit, ${cfg(f, 'pageSizeMax')});
    ${acc.list('filter', 'page.offset', 'page.limit')}
  }

  async transition(actor: string, id: string, next: ${d.Main}Status): Promise<${d.Main}> {
    ${acc.get('id')}
    if (!(${allowed})) {
      throw new ConflictError('cannot move ${d.main} ' + id + ' from ' + entity.status + ' to ' + next);
    }
    const from = entity.status;
    const updated: ${d.Main} = { ...entity, status: next, updatedAt: new Date() };
    ${acc.save('updated')}
    ${auditCall(f, d, 'mainStatusChanged', 'actor', 'id', 'from, to: next')}
    return updated;
  }

  async cancel(actor: string, id: string, reason: string): Promise<${d.Main}> {
    ${acc.get('id')}
    if (${terminal}) throw new ConflictError('${d.main} ' + id + ' is already closed');
    const cancelled: ${d.Main} = { ...entity, status: '${s3}', note: reason, updatedAt: new Date() };
    ${acc.save('cancelled')}
    ${auditCall(f, d, 'mainCancelled', 'actor', 'id')}
    return cancelled;
  }

  async quote(id: string, priority: boolean): Promise<PriceBreakdown> {
    ${acc.get('id')}
    return priceOf(entity, priority);
  }
}
`;
}

function gatewayModule(d) {
  return ts`import { ${d.Main}Store } from '../db/${d.main}-store';

export class ${d.Main}Gateway {
  constructor(private readonly store: ${d.Main}Store) {}

  find(id: string) {
    return this.store.findById(id);
  }

  list(filter: Parameters<${d.Main}Store['list']>[0], offset: number, limit: number) {
    return this.store.list(filter, offset, limit);
  }

  save(entity: Parameters<${d.Main}Store['save']>[0]) {
    return this.store.save(entity);
  }
}
`;
}

/** The status lifecycle cut into four small modules (cluster-a). */
function clusterAModules(d) {
  const [s0, s1, s2, s3] = d.states;
  return [
    ts`export const STATES = ['${s0}', '${s1}', '${s2}', '${s3}'] as const;

export type State = (typeof STATES)[number];

export function isState(value: string): value is State {
  return (STATES as readonly string[]).includes(value);
}
`,
    ts`export function isTerminal(state: string): boolean {
  return state === '${s2}' || state === '${s3}';
}
`,
    ts`const NEXT: Record<string, string[]> = {
  ${s0}: ['${s1}', '${s3}'],
  ${s1}: ['${s2}', '${s3}'],
  ${s2}: [],
  ${s3}: [],
};

export function canTransition(from: string, to: string): boolean {
  return (NEXT[from] ?? []).includes(to);
}
`,
    ts`const LABELS: Record<string, string> = {
  ${s0}: '${cap(s0.replace('_', ' '))}',
  ${s1}: '${cap(s1.replace('_', ' '))}',
  ${s2}: '${cap(s2.replace('_', ' '))}',
  ${s3}: '${cap(s3.replace('_', ' '))}',
};

export function statusLabel(state: string): string {
  return LABELS[state] ?? state;
}
`,
  ];
}

/** Document numbering cut into four small modules (cluster-b). */
function clusterBModules(d) {
  return [
    ts`export function numberPrefix(year: number): string {
  return '${d.prefix}' + year;
}
`,
    ts`let last = 0;

export function nextSequence(): number {
  last += 1;
  return last;
}

export function resetSequence(value = 0): void {
  last = value;
}
`,
    ts`export function padSequence(value: number, width = 6): string {
  return String(value).padStart(width, '0');
}
`,
    ts`export function formatNumber(prefix: string, padded: string): string {
  return prefix + '-' + padded;
}
`,
  ];
}

/** Contact normalisation cut into four small modules (cluster-c). */
function clusterCModules() {
  return [
    ts`export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}
`,
    ts`export function normalizePhone(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = raw.replace(/[^0-9+]/g, '');
  return digits === '' ? null : digits;
}
`,
    ts`export function collapseWhitespace(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}
`,
    ts`export function contactLine(name: string, email: string, phone: string | null): string {
  return phone === null ? name + ' <' + email + '>' : name + ' <' + email + '>, ' + phone;
}
`,
  ];
}

function partyServiceModule(d, f, rnd) {
  const leaky = f.has('leaky-b');
  const clusterC = f.has('cluster-c');
  const grace = pick(rnd, [3, 7, 14]);
  const contactImports = clusterC
    ? ts`import { normalizeEmail } from './contact/email';
import { normalizePhone } from './contact/phone';
import { collapseWhitespace } from './contact/normalize';
import { contactLine } from './contact/display';
`
    : '';
  const inlineContact = clusterC ? '' : ts`
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function normalizePhone(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = raw.replace(/[^0-9+]/g, '');
  return digits === '' ? null : digits;
}

function collapseWhitespace(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}
`;
  const rowHelper = leaky ? ts`
function fromRow(row: ${d.Party}Row): ${d.Party} {
  return {
    id: row.id,
    name: row.full_name,
    email: row.email,
    phone: row.phone,
    tier: row.tier === 'priority' ? 'priority' : 'standard',
    joinedAt: new Date(row.joined_at),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at),
  };
}
` : '';
  const load = leaky
    ? ts`const result = await this.store.byId(id);
    if (result.rowCount === 0) throw new NotFoundError('${d.party}', id);
    const entity = fromRow(result.rows[0]);`
    : 'const entity = await this.store.findById(id);';
  const byEmail = leaky
    ? ts`const existing = await this.store.byEmail(email);
    if (existing.rowCount > 0) throw new ConflictError('email ' + email + ' is taken');`
    : ts`const existing = await this.store.findByEmail(email);
    if (existing !== null) throw new ConflictError('email ' + email + ' is taken');`;
  const insert = leaky
    ? ts`await this.store.insert({
      id: entity.id,
      full_name: entity.name,
      email: entity.email,
      phone: entity.phone,
      tier: entity.tier,
      joined_at: entity.joinedAt.toISOString(),
      expires_at: entity.expiresAt === null ? null : entity.expiresAt.toISOString(),
    });`
    : 'await this.store.save(entity);';
  const update = leaky
    ? ts`await this.store.updateColumns(id, { email: updated.email, phone: updated.phone });`
    : 'await this.store.save(updated);';
  return ts`import { ${d.Party}Store${leaky ? `, ${d.Party}Row` : ''} } from '../db/${d.party}-store';
import { ${f.has('cycle-a') ? `${d.Main}, ` : ''}${d.Party} } from '../shared/types';
import { ConflictError${leaky ? ', NotFoundError' : ''} } from '../shared/errors';
import { displayName } from './profile';
${auditImport(f)}
${f.has('cycle-a') ? `import { isOpen } from '../${d.main}/service';\n` : ''}${contactImports}
const GRACE_DAYS = ${grace};
${inlineContact}${rowHelper}
/** A ${d.party} is active until its expiry plus the grace period; no expiry means always. */
export function isActive${d.Party}(expiresAt: Date | null, now: Date): boolean {
  if (expiresAt === null) return true;
  return expiresAt.getTime() + GRACE_DAYS * 86400000 >= now.getTime();
}

export interface Register${d.Party}Input {
  name: string;
  email: string;
  phone?: string;
  priority?: boolean;
}

export class ${d.Party}Service {
  constructor(private readonly store: ${d.Party}Store) {}

  async register(actor: string, input: Register${d.Party}Input): Promise<${d.Party}> {
    const email = normalizeEmail(input.email);
    ${byEmail}
    const now = new Date();
    const entity: ${d.Party} = {
      id: now.getTime().toString(36),
      name: collapseWhitespace(input.name),
      email,
      phone: normalizePhone(input.phone ?? null),
      tier: input.priority === true ? 'priority' : 'standard',
      joinedAt: now,
      expiresAt: null,
    };
    ${insert}
    ${auditCall(f, d, 'partyRegistered', 'actor', 'entity.id')}
    return entity;
  }

  async get(id: string): Promise<${d.Party}> {
    ${load}
    return entity;
  }

  async updateContact(actor: string, id: string, email: string, phone: string | null): Promise<${d.Party}> {
    ${load}
    const updated: ${d.Party} = { ...entity, email: normalizeEmail(email), phone: normalizePhone(phone) };
    ${update}
    ${auditCall(f, d, 'partyUpdated', 'actor', 'id')}
    return updated;
  }

  async card(id: string): Promise<string> {
    ${load}
    return ${clusterC ? 'contactLine(displayName(entity), entity.email, entity.phone)' : "displayName(entity) + ' <' + entity.email + '>'"};
  }
${f.has('cycle-a') ? ts`
  async openCount(id: string, recent: ${d.Main}[]): Promise<number> {
    return recent.filter((e) => e.${d.party}Id === id && isOpen(e)).length;
  }
` : ''}}
`;
}

function profileModule(d, f, rnd) {
  const badge = pick(rnd, ['★', '◆', '●']);
  const nextDue = f.has('scattered-b') ? ts`
/** When the ${d.party}'s next payment is due: the payment term after the last ${d.doc}, moved off the weekend. */
export function nextPaymentDue(lastIssuedAt: Date, termDays: number): Date {
  const due = new Date(lastIssuedAt.getTime() + termDays * 86400000);
  while (due.getUTCDay() === 0 || due.getUTCDay() === 6) due.setUTCDate(due.getUTCDate() + 1);
  return due;
}
` : '';
  if (f.has('shallow-c')) {
    return ts`import { ${d.Party} } from '../shared/types';

/** Read and write access to a ${d.party}'s profile, one method per field. */
export class ${d.Party}Profile {
  constructor(private readonly entity: ${d.Party}) {}

  getId(): string {
    return this.entity.id;
  }

  getName(): string {
    return this.entity.name;
  }

  setName(name: string): void {
    this.entity.name = name;
  }

  getEmail(): string {
    return this.entity.email;
  }

  setEmail(email: string): void {
    this.entity.email = email;
  }

  getPhone(): string | null {
    return this.entity.phone;
  }

  setPhone(phone: string | null): void {
    this.entity.phone = phone;
  }

  getTier(): ${d.Party}['tier'] {
    return this.entity.tier;
  }

  setTier(tier: ${d.Party}['tier']): void {
    this.entity.tier = tier;
  }

  getJoinedAt(): Date {
    return this.entity.joinedAt;
  }

  getExpiresAt(): Date | null {
    return this.entity.expiresAt;
  }

  setExpiresAt(expiresAt: Date | null): void {
    this.entity.expiresAt = expiresAt;
  }

  toEntity(): ${d.Party} {
    return { ...this.entity };
  }
}

export function displayName(entity: ${d.Party}): string {
  return new ${d.Party}Profile(entity).getName();
}
${nextDue}`;
  }
  return ts`import { ${d.Party} } from '../shared/types';

export interface ProfileView {
  id: string;
  title: string;
  initials: string;
  badge: string;
  memberFor: string;
  contact: string[];
  expiry: string | null;
}

export function displayName(entity: ${d.Party}): string {
  const name = entity.name.trim();
  return name === '' ? entity.email.split('@')[0] : name;
}

export function initials(entity: ${d.Party}): string {
  const parts = displayName(entity).split(' ').filter((p) => p !== '');
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function tenure(joinedAt: Date, now: Date): string {
  const days = Math.floor((now.getTime() - joinedAt.getTime()) / 86400000);
  if (days < 31) return days + ' days';
  const months = Math.floor(days / 30);
  if (months < 12) return months + ' months';
  return Math.floor(months / 12) + ' years';
}

export function profileView(entity: ${d.Party}, now: Date = new Date()): ProfileView {
  const contact = [entity.email];
  if (entity.phone !== null) contact.push(entity.phone);
  return {
    id: entity.id,
    title: displayName(entity),
    initials: initials(entity),
    badge: entity.tier === 'priority' ? '${badge}' : '',
    memberFor: tenure(entity.joinedAt, now),
    contact,
    expiry: entity.expiresAt === null ? null : entity.expiresAt.toISOString().slice(0, 10),
  };
}

export function sortByName(entities: ${d.Party}[]): ${d.Party}[] {
  return [...entities].sort((a, b) => displayName(a).localeCompare(displayName(b)));
}
${nextDue}`;
}

function builderModule(d, f, rnd) {
  const clusterB = f.has('cluster-b');
  const scattered = f.has('scattered-a');
  const width = pick(rnd, [5, 6]);
  const numbering = clusterB
    ? ts`import { numberPrefix } from './numbering/prefix';
import { nextSequence } from './numbering/sequence';
import { padSequence } from './numbering/pad';
import { formatNumber } from './numbering/format';
`
    : '';
  const inlineNumbering = clusterB ? '' : ts`
let lastNumber = 0;

/** The next ${d.doc} number: prefix, year, zero-padded running count. */
export function nextNumber(issuedAt: Date): string {
  lastNumber += 1;
  return '${d.prefix}' + issuedAt.getUTCFullYear() + '-' + String(lastNumber).padStart(${width}, '0');
}
`;
  const number = clusterB ? 'formatNumber(numberPrefix(issuedAt.getUTCFullYear()), padSequence(nextSequence()))' : 'nextNumber(issuedAt)';
  const round = scattered ? (x) => `Math.round((${x} + Number.EPSILON) * 100) / 100` : (x) => `roundMoney(${x})`;
  const lines = f.has('cycle-b') ? 'pricedLines(entity).map((l) => ({ label: l.label, amount: ' + round('l.amount') + ' }))' : `entity.items.map((item) => ({ label: describeLine(item), amount: ${round('lineTotal(item)')} }))`;
  return ts`import { ${d.Main}, ${d.Item}, ${d.Doc} } from '../shared/types';
import { priceOf, lineTotal${scattered ? '' : ', roundMoney'}${f.has('cycle-b') ? ', pricedLines' : ''} } from '../${d.main}/pricing';
${cfgImport(f)}
${numbering}
const DAY_MS = 86400000;
${inlineNumbering}
export function describeLine(item: ${d.Item}): string {
  const qty = item.quantity === 1 ? '' : item.quantity + ' × ';
  return qty + item.description + ' (' + item.code + ')';
}

export function build${d.Doc}(entity: ${d.Main}, issuedAt: Date = new Date(), priority = false): ${d.Doc} {
  if (entity.items.length === 0) throw new Error('${d.main} ' + entity.id + ' has nothing to bill');
  const price = priceOf(entity, priority);
  const lines = ${lines};
  if (price.discount > 0) lines.push({ label: 'Volume discount', amount: -price.discount });
  return {
    number: ${number},
    ${d.main}Id: entity.id,
    issuedAt,
    dueAt: new Date(issuedAt.getTime() + ${cfg(f, 'paymentTermDays')} * DAY_MS),
    lines,
    subtotal: price.subtotal,
    tax: price.tax,
    total: ${round('price.subtotal - price.discount + price.tax')},
  };
}

export function credit${d.Doc}(original: ${d.Doc}, issuedAt: Date = new Date()): ${d.Doc} {
  return {
    ...original,
    number: original.number + '-CR',
    issuedAt,
    dueAt: issuedAt,
    lines: original.lines.map((l) => ({ label: 'Credit: ' + l.label, amount: -l.amount })),
    subtotal: -original.subtotal,
    tax: -original.tax,
    total: -original.total,
  };
}

export function isOverdue(document: ${d.Doc}, now: Date = new Date()): boolean {
  return document.total > 0 && now.getTime() > document.dueAt.getTime();
}
`;
}

function rendererModule(d, f, stage) {
  const scattered = f.has('scattered-b');
  const payBy = scattered ? ts`
/** The pay-by date printed on the ${d.doc}: issue date plus the payment term, skipping Saturday and Sunday. */
function payBy(issuedAt: Date): Date {
  const date = new Date(issuedAt);
  let left = ${cfg(f, 'paymentTermDays')};
  while (left > 0) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0 && date.getDay() !== 6) left -= 1;
  }
  return date;
}
` : '';
  const due = scattered ? 'payBy(document.issuedAt)' : 'document.dueAt';
  return ts`import { ${d.Doc} } from '../shared/types';
${cfgImport(f)}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function money(amount: number): string {
  return amount.toFixed(2) + ' ' + ${cfg(f, 'currency')};
}
${payBy}
export function renderText(document: ${d.Doc}): string {
  const out: string[] = [];
  out.push('${d.Doc} ' + document.number);
  out.push('Issued: ' + day(document.issuedAt) + '   Due: ' + day(${due}));
  out.push('');
  for (const line of document.lines) {
    out.push(line.label.padEnd(48, ' ') + money(line.amount).padStart(16, ' '));
  }
  out.push('');
  out.push('Subtotal'.padEnd(48, ' ') + money(document.subtotal).padStart(16, ' '));
  out.push('Tax'.padEnd(48, ' ') + money(document.tax).padStart(16, ' '));
  out.push('Total'.padEnd(48, ' ') + money(document.total).padStart(16, ' '));
  return out.join('\n');
}

export function renderHtml(document: ${d.Doc}): string {
  const rows = document.lines
    .map((line) => '<tr><td>' + escapeHtml(line.label) + '</td><td class="amount">' + money(line.amount) + '</td></tr>')
    .join('');
  return [
    '<article class="${d.doc}">',
    '<h1>${d.Doc} ' + escapeHtml(document.number) + '</h1>',
    '<p>Issued ' + day(document.issuedAt) + ', due ' + day(${due}) + '</p>',
    '<table>' + rows + '</table>',
    '<p class="total">Total ' + money(document.total) + '</p>',
    '</article>',
  ].join('\n');
}
${stage >= 5 ? ts`
export function renderSummaryLine(document: ${d.Doc}): string {
  return document.number + ' · ' + day(document.issuedAt) + ' · ' + money(document.total);
}
` : ''}`;
}

function exporterModule(d) {
  return ts`import { renderText, renderHtml } from './renderer';

export function export${d.Doc}(document: Parameters<typeof renderText>[0], format: 'text' | 'html'): string {
  return format === 'html' ? renderHtml(document) : renderText(document);
}

export function contentTypeOf(format: 'text' | 'html'): string {
  return format === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
}
`;
}

function templatesModule(d, stage) {
  return ts`import { ${d.Main} } from '../shared/types';

export type TemplateKind = 'reminder' | 'receipt' | 'welcome' | 'cancelled';

interface Template {
  subject: string;
  body: string;
}

const TEMPLATES: Record<TemplateKind, Template> = {
  reminder: {
    subject: 'Your ${d.main} {{id}} is waiting',
    body: 'Hello {{name}},\n\nyour ${d.main} {{id}} has been {{status}} since {{since}}.\nPlease get in touch if anything is unclear.',
  },
  receipt: {
    subject: '${d.Doc} {{number}}',
    body: 'Hello {{name}},\n\nattached is ${d.doc} {{number}} over {{total}}.',
  },
  welcome: {
    subject: 'Welcome, {{name}}',
    body: 'Hello {{name}},\n\nyour account is ready.',
  },
  cancelled: {
    subject: 'Your ${d.main} {{id}} was cancelled',
    body: 'Hello {{name}},\n\n${d.main} {{id}} was cancelled: {{reason}}.',
  },
};

const PLACEHOLDER = /\{\{([a-zA-Z]+)\}\}/g;

export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, key: string) => (key in vars ? vars[key] : whole));
}

export function missingVars(kind: TemplateKind, vars: Record<string, string>): string[] {
  const t = TEMPLATES[kind];
  const missing = new Set<string>();
  for (const text of [t.subject, t.body]) {
    for (const m of text.matchAll(PLACEHOLDER)) {
      if (!(m[1] in vars)) missing.add(m[1]);
    }
  }
  return [...missing].sort();
}

export function render(kind: TemplateKind, vars: Record<string, string>): Template {
  const missing = missingVars(kind, vars);
  if (missing.length > 0) throw new Error('template ' + kind + ' is missing ' + missing.join(', '));
  const t = TEMPLATES[kind];
  return { subject: fill(t.subject, vars), body: fill(t.body, vars) };
}

export function reminderVars(entity: ${d.Main}, name: string): Record<string, string> {
  return { id: entity.id, name, status: entity.status, since: entity.updatedAt.toISOString().slice(0, 10) };
}
${stage >= 2 ? ts`
export function subjectFor(kind: TemplateKind): string {
  return TEMPLATES[kind].subject.replace(PLACEHOLDER, '…');
}
` : ''}`;
}

function mailerModule(d, f) {
  const cycleC = f.has('cycle-c');
  if (f.has('leaky-c')) {
    return ts`${cfgImport(f)}

/** The SMTP server's reply: 2xx accepted, 4xx try again later, 5xx permanent. */
export interface SmtpReply {
  code: number;
  text: string;
}

export interface SmtpSocket {
  command(line: string): Promise<SmtpReply>;
  data(raw: string): Promise<SmtpReply>;
}

let socket: SmtpSocket = {
  async command() {
    return { code: 250, text: 'OK' };
  },
  async data() {
    return { code: 250, text: 'queued' };
  },
};

export function useSocket(next: SmtpSocket): void {
  socket = next;
}

export function serverAddress(): string {
  return ${cfg(f, 'smtpHost')} + ':' + ${cfg(f, 'smtpPort')};
}

/** The server's EHLO capabilities, one keyword per line after the greeting. */
export async function ehlo(hostname: string): Promise<{ reply: SmtpReply; extensions: string[] }> {
  const reply = await socket.command('EHLO ' + hostname);
  const extensions = reply.text
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(' ')[0].toUpperCase())
    .filter((word) => word !== '');
  return { reply, extensions };
}

/** Escapes lines that start with a dot, as the DATA phase requires. */
export function dotStuff(rawMessage: string): string {
  return rawMessage
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n');
}

/** Runs one SMTP transaction; rawMessage is the full RFC 5322 message, headers included. */
export async function smtpSend(envelopeFrom: string, envelopeTo: string, rawMessage: string): Promise<SmtpReply> {
  const from = await socket.command('MAIL FROM:<' + envelopeFrom + '>');
  if (from.code >= 400) return from;
  const to = await socket.command('RCPT TO:<' + envelopeTo + '>');
  if (to.code >= 400) return to;
  return socket.data(dotStuff(rawMessage));
}

export async function quit(): Promise<SmtpReply> {
  return socket.command('QUIT');
}

export function senderAddress(): string {
  return ${cfg(f, 'mailFrom')};
}
`;
  }
  return ts`${cfgImport(f)}
import { render, TemplateKind } from './templates';
${cycleC ? auditImport(f) + '\n' : ''}
export interface OutgoingMail {
  from: string;
  to: string;
  subject: string;
  body: string;
}

export interface MailTransport {
  deliver(mail: OutgoingMail): Promise<{ accepted: boolean; transient: boolean }>;
}

const sent: OutgoingMail[] = [];

let transport: MailTransport = {
  async deliver(mail) {
    sent.push(mail);
    return { accepted: true, transient: false };
  },
};

export function useTransport(next: MailTransport): void {
  transport = next;
}

const ADDRESS = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

export function isDeliverable(address: string): boolean {
  return ADDRESS.test(address);
}

/** Renders the template and delivers it, retrying transient failures. */
export async function sendTemplate(to: string, kind: TemplateKind, vars: Record<string, string>, attempts = 3): Promise<boolean> {
  if (!isDeliverable(to)) return false;
  const { subject, body } = render(kind, vars);
  const mail: OutgoingMail = { from: ${cfg(f, 'mailFrom')}, to, subject, body };
  for (let i = 0; i < attempts; i++) {
    const result = await transport.deliver(mail);
    if (result.accepted) {
${cycleC ? `      ${auditCall(f, d, 'reminderSent', "'mailer'", "vars.id ?? to")}\n` : ''}      return true;
    }
    if (!result.transient) return false;
  }
  return false;
}

export function outbox(): readonly OutgoingMail[] {
  return sent;
}
`;
}

function dispatchModule() {
  return ts`import { sendTemplate } from './mailer';

export function dispatchReminder(to: string, vars: Record<string, string>): Promise<boolean> {
  return sendTemplate(to, 'reminder', vars);
}

export function dispatchCancellation(to: string, vars: Record<string, string>): Promise<boolean> {
  return sendTemplate(to, 'cancelled', vars);
}
`;
}

function remindersModule(d, f) {
  const [, s1] = d.states;
  const leakyA = f.has('leaky-a');
  const leakyB = f.has('leaky-b');
  const leakyC = f.has('leaky-c');
  const passB = f.has('pass-b');
  const imports = [];
  imports.push(leakyA ? `import { ${d.Main}Store, ${d.Main}Row } from '../db/${d.main}-store';` : `import { ${d.Main}Store } from '../db/${d.main}-store';`);
  imports.push(`import { ${d.Party}Store } from '../db/${d.party}-store';`);
  if (passB) imports.push("import { dispatchReminder } from '../notify/dispatch';");
  else if (leakyC) imports.push("import { smtpSend, senderAddress } from '../notify/mailer';", "import { render, reminderVars } from '../notify/templates';");
  else imports.push("import { sendTemplate } from '../notify/mailer';", "import { reminderVars } from '../notify/templates';");
  imports.push(`import { ${d.Main} } from '../shared/types';`);
  imports.push(cfgImport(f));
  const stale = leakyA
    ? ts`const rows = await this.${d.main}s.select('status = $1 AND updated_at < $2', ['${s1}', cutoff.toISOString()], 'ORDER BY updated_at');
    const stale: ${d.Main}[] = rows.rows.map((row: ${d.Main}Row) => ({
      id: row.id,
      ${d.party}Id: row.${d.party}_id,
      status: row.status as ${d.Main}['status'],
      items: JSON.parse(row.items_json),
      note: row.note ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    }));`
    : `const stale = await this.${d.main}s.staleSince('${s1}', cutoff);`;
  const party = leakyB
    ? ts`const found = await this.${d.party}s.byId(entity.${d.party}Id);
      if (found.rowCount === 0) continue;
      const email = found.rows[0].email;
      const name = found.rows[0].full_name;`
    : ts`const recipient = await this.${d.party}s.findById(entity.${d.party}Id);
      const email = recipient.email;
      const name = recipient.name;`;
  const vars = passB ? `{ id: entity.id, name, status: entity.status, since: entity.updatedAt.toISOString().slice(0, 10) }` : 'reminderVars(entity, name)';
  const send = passB
    ? `const ok = await dispatchReminder(email, ${vars});`
    : leakyC
      ? ts`const message = render('reminder', ${vars});
      const raw = 'From: ' + senderAddress() + '\r\nTo: ' + email + '\r\nSubject: ' + message.subject + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + message.body;
      let reply = await smtpSend(senderAddress(), email, raw);
      if (reply.code >= 400 && reply.code < 500) reply = await smtpSend(senderAddress(), email, raw);
      if (reply.code === 550 || reply.code === 553) this.badAddresses.add(email);
      const ok = reply.code >= 200 && reply.code < 300;`
      : `const ok = await sendTemplate(email, 'reminder', ${vars});`;
  const deadline = f.has('scattered-b') ? ts`
/** The day the payment falls due: the term after the last change, counted in calendar days, Sunday pushed to Monday. */
export function paymentDeadline(from: Date, termDays: number): Date {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + termDays);
  if (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return date;
}
` : '';
  const dueCheck = f.has('scattered-b') ? `\n      if (paymentDeadline(entity.updatedAt, ${cfg(f, 'paymentTermDays')}).getTime() > now.getTime() + ${cfg(f, 'reminderLeadDays')} * 86400000) continue;` : '';
  return ts`${imports.join('\n')}
${deadline}
export interface ReminderRun {
  checked: number;
  sent: number;
  failed: string[];
}

const pendingFollowUps = new Set<string>();

/** Marks a ${d.main} for a follow-up on the next run, whatever its age. */
export function scheduleFollowUp(id: string): void {
  pendingFollowUps.add(id);
}

export class ReminderJob {
  ${leakyC ? 'readonly badAddresses = new Set<string>();\n\n  ' : ''}constructor(
    private readonly ${d.main}s: ${d.Main}Store,
    private readonly ${d.party}s: ${d.Party}Store,
  ) {}

  async run(now: Date = new Date()): Promise<ReminderRun> {
    const cutoff = new Date(now.getTime() - ${cfg(f, 'reminderLeadDays')} * 86400000);
    ${stale}
    const outcome: ReminderRun = { checked: stale.length, sent: 0, failed: [] };
    for (const entity of stale) {${dueCheck}
      ${party}
      ${send}
      if (ok) outcome.sent += 1;
      else outcome.failed.push(entity.id);
      pendingFollowUps.delete(entity.id);
    }
    return outcome;
  }

  pending(): string[] {
    return [...pendingFollowUps].sort();
  }
}
`;
}

function schedulerModule(d, f, stage) {
  const scattered = f.has('scattered-c');
  return ts`import { ReminderJob } from './reminders';
${scattered ? `import { ${d.Party} } from '../shared/types';\n` : ''}${cfgImport(f)}

export interface Job {
  name: string;
  everyMinutes: number;
  run(now: Date): Promise<unknown>;
}

export interface JobFailure {
  job: string;
  at: Date;
  message: string;
}

export class Scheduler {
  private readonly lastRun = new Map<string, number>();
  private readonly failures: JobFailure[] = [];

  constructor(private readonly jobs: Job[]) {}

  due(now: Date): Job[] {
    return this.jobs.filter((job) => {
      const last = this.lastRun.get(job.name);
      return last === undefined || now.getTime() - last >= job.everyMinutes * 60000;
    });
  }

  async tick(now: Date = new Date()): Promise<number> {
    let ran = 0;
    for (const job of this.due(now)) {
      this.lastRun.set(job.name, now.getTime());
      try {
        await job.run(now);
        ran += 1;
      } catch (error) {
        this.failures.push({ job: job.name, at: now, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return ran;
  }

  recentFailures(limit = 20): JobFailure[] {
    return this.failures.slice(-limit);
  }
}

export function reminderJob(job: ReminderJob): Job {
  const every = Math.max(15, ${cfg(f, 'reminderLeadDays')} * 60);
  return { name: 'reminders', everyMinutes: every, run: (now) => job.run(now) };
}
${scattered ? ts`
/** Drops ${d.parties} whose membership has lapsed from the nightly list. */
export function lapsedJob(list${d.Party}s: () => Promise<${d.Party}[]>, drop: (id: string) => Promise<void>): Job {
  return {
    name: 'lapsed-${d.parties}',
    everyMinutes: 24 * 60,
    async run(now) {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      for (const entity of await list${d.Party}s()) {
        const lapsed = entity.expiresAt !== null && entity.expiresAt < startOfDay;
        if (lapsed) await drop(entity.id);
      }
    },
  };
}
` : ''}${stage >= 4 ? ts`
export function nextRunAt(job: Job, lastRun: Date | null): Date {
  return lastRun === null ? new Date(0) : new Date(lastRun.getTime() + job.everyMinutes * 60000);
}
` : ''}`;
}

function auditModule(d, f) {
  const cycleC = f.has('cycle-c');
  const head = ts`${cfgImport(f)}
${cycleC ? "import { scheduleFollowUp } from '../jobs/reminders';\n" : ''}
export type AuditAction = 'created' | 'updated' | 'status_changed' | 'cancelled' | 'reminded' | 'exported';

export interface AuditEntry {
  at: Date;
  actor: string;
  action: AuditAction;
  entity: string;
  entityId: string;
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

const memory: AuditEntry[] = [];

let sink: AuditSink = {
  write(entry) {
    memory.push(entry);
  },
};

export function useAuditSink(next: AuditSink): void {
  sink = next;
}

const EMAIL = /[^@\s]+@[^@\s]+/g;

export function redact(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === 'string' ? value.replace(EMAIL, '***@***') : value;
  }
  return out;
}
`;
  const write = ts`
function write(actor: string, action: AuditAction, entity: string, entityId: string, detail?: Record<string, unknown>): void {
  if (!${cfg(f, 'auditEnabled')}) return;
  sink.write({ at: new Date(), actor, action, entity, entityId, ...(detail === undefined ? {} : { detail: redact(detail) }) });
${cycleC ? "  if (action === 'cancelled') scheduleFollowUp(entityId);\n" : ''}}
`;
  const tail = ts`
export function recent(limit = 50): AuditEntry[] {
  return memory.slice(-limit).reverse();
}

export function byEntity(entity: string, entityId: string): AuditEntry[] {
  return memory.filter((e) => e.entity === entity && e.entityId === entityId);
}
`;
  if (f.has('shallow-b')) {
    return head + write + ts`
/** One method per audited event. */
export class AuditLog {
  ${d.main}Created(actor: string, id: string): void {
    write(actor, 'created', '${d.main}', id);
  }

  ${d.main}Updated(actor: string, id: string): void {
    write(actor, 'updated', '${d.main}', id);
  }

  ${d.main}StatusChanged(actor: string, id: string, from: string, to: string): void {
    write(actor, 'status_changed', '${d.main}', id, { from, to });
  }

  ${d.main}Cancelled(actor: string, id: string): void {
    write(actor, 'cancelled', '${d.main}', id);
  }

  ${d.party}Registered(actor: string, id: string): void {
    write(actor, 'created', '${d.party}', id);
  }

  ${d.party}Updated(actor: string, id: string): void {
    write(actor, 'updated', '${d.party}', id);
  }

  reminderSent(id: string): void {
    write('scheduler', 'reminded', '${d.main}', id);
  }

  ${d.doc}Exported(actor: string, number: string): void {
    write(actor, 'exported', '${d.doc}', number);
  }
}

export const audit = new AuditLog();
` + tail;
  }
  return head + write + ts`
export function record(actor: string, action: AuditAction, entity: string, entityId: string, detail?: Record<string, unknown>): void {
  write(actor, action, entity, entityId, detail);
}
` + tail;
}

function middlewareModule(f, stage) {
  return ts`${cfgImport(f)}
import { ValidationError } from '../shared/errors';

export interface Request {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  body: string;
}

const MAX_BODY_BYTES = 64 * 1024;
let requestCounter = 0;

export function requestId(req: Request): string {
  const given = req.headers['x-request-id'];
  if (given !== undefined && /^[A-Za-z0-9-]{8,64}$/.test(given)) return given;
  requestCounter += 1;
  return 'req-' + Date.now().toString(36) + '-' + requestCounter;
}

export function actorOf(req: Request): string {
  const auth = req.headers.authorization;
  if (auth === undefined || !auth.startsWith('Bearer ')) throw new ValidationError(['missing bearer token']);
  const token = auth.slice('Bearer '.length).trim();
  if (token.length < 16) throw new ValidationError(['malformed bearer token']);
  return 'user:' + token.slice(0, 8);
}

export function jsonBody<T>(req: Request): T {
  if (req.body.length > MAX_BODY_BYTES) throw new ValidationError(['body is larger than ' + MAX_BODY_BYTES + ' bytes']);
  try {
    return JSON.parse(req.body) as T;
  } catch {
    throw new ValidationError(['body is not valid JSON']);
  }
}

export function paging(req: Request): { offset: number; limit: number } {
  const offset = Number(req.query.offset ?? '0');
  const limit = Number(req.query.limit ?? String(${cfg(f, 'pageSizeDefault')}));
  if (!Number.isInteger(offset) || offset < 0) throw new ValidationError(['offset must be zero or more']);
  if (!Number.isInteger(limit) || limit <= 0) throw new ValidationError(['limit must be positive']);
  return { offset, limit: Math.min(limit, ${cfg(f, 'pageSizeMax')}) };
}
${stage >= 2 ? ts`
export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, PATCH', vary: 'origin' };
}
` : ''}`;
}

function mainHandlersModule(d, f) {
  const passC = f.has('pass-c');
  const scattered = f.has('scattered-a');
  const clusterA = f.has('cluster-a');
  const renderImport = passC ? `import { export${d.Doc}, contentTypeOf } from '../${d.doc}/export';` : `import { renderText, renderHtml } from '../${d.doc}/renderer';`;
  const render = passC
    ? `return { status: 200, headers: { 'content-type': contentTypeOf(format) }, body: export${d.Doc}(document, format) };`
    : ts`const body = format === 'html' ? renderHtml(document) : renderText(document);
    return { status: 200, headers: { 'content-type': format === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' }, body };`;
  const amount = scattered
    ? ts`
/** Amounts in responses: two decimals, cut rather than rounded so a total is never overstated. */
function displayAmount(amount: number): string {
  return (Math.trunc(amount * 100) / 100).toFixed(2);
}
`
    : '';
  const show = scattered ? 'displayAmount' : 'formatAmount';
  return ts`import { ${d.Main}Service } from '../${d.main}/service';
import { build${d.Doc} } from '../${d.doc}/builder';
${renderImport}
${scattered ? '' : `import { formatAmount } from '../${d.main}/pricing';\n`}${clusterA ? `import { statusLabel } from '../${d.main}/status/label';\n` : ''}import { Request, actorOf, jsonBody, paging } from './middleware';
import { New${d.Main}Input } from '../${d.main}/validation';
import { ${d.Main}Status } from '../shared/types';

export interface Response {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
${amount}
export function create${d.Main}Handlers(service: ${d.Main}Service) {
  return {
    async create(req: Request): Promise<Response> {
      const created = await service.create(actorOf(req), jsonBody<New${d.Main}Input>(req));
      return { status: 201, body: created };
    },

    async show(req: Request, id: string): Promise<Response> {
      const entity = await service.get(id);
      const price = await service.quote(id, false);
      return { status: 200, body: { ...entity, ${clusterA ? 'statusLabel: statusLabel(entity.status), ' : ''}total: ${show}(price.total) } };
    },

    async list(req: Request): Promise<Response> {
      const { offset, limit } = paging(req);
      const status = req.query.status as ${d.Main}Status | undefined;
      return { status: 200, body: await service.list({ status }, offset, limit) };
    },

    async move(req: Request, id: string): Promise<Response> {
      const { status } = jsonBody<{ status: ${d.Main}Status }>(req);
      return { status: 200, body: await service.transition(actorOf(req), id, status) };
    },

    async cancel(req: Request, id: string): Promise<Response> {
      const { reason } = jsonBody<{ reason: string }>(req);
      return { status: 200, body: await service.cancel(actorOf(req), id, reason) };
    },

    async ${d.doc}(req: Request, id: string): Promise<Response> {
      const entity = await service.get(id);
      const document = build${d.Doc}(entity);
      const format = req.query.format === 'html' ? 'html' : 'text';
      ${render}
    },
  };
}
`;
}

function partyHandlersModule(d, f) {
  const scattered = f.has('scattered-c');
  const shallowC = f.has('shallow-c');
  const viewImport = shallowC ? `import { ${d.Party}Profile } from '../${d.party}/profile';` : `import { profileView } from '../${d.party}/profile';`;
  const view = shallowC
    ? ts`const profile = new ${d.Party}Profile(entity);
      return { status: 200, body: { id: profile.getId(), name: profile.getName(), email: profile.getEmail(), phone: profile.getPhone(), tier: profile.getTier(), active } };`
    : 'return { status: 200, body: { ...profileView(entity), active } };';
  const active = scattered
    ? ts`
/** Shown as active while the membership has not run out; a day of slack for time zones. */
function stillActive(expiresAt: Date | null): boolean {
  return expiresAt === null || expiresAt.getTime() + 86400000 > Date.now();
}
`
    : '';
  const activeExpr = scattered ? 'stillActive(entity.expiresAt)' : 'isActive' + d.Party + '(entity.expiresAt, new Date())';
  return ts`import { ${d.Party}Service, Register${d.Party}Input${scattered ? '' : `, isActive${d.Party}`} } from '../${d.party}/service';
${viewImport}
import { Request, actorOf, jsonBody } from './middleware';
import { ValidationError } from '../shared/errors';
${active}
export function create${d.Party}Handlers(service: ${d.Party}Service) {
  return {
    async register(req: Request): Promise<{ status: number; body: unknown }> {
      const input = jsonBody<Register${d.Party}Input>(req);
      if (typeof input.name !== 'string' || typeof input.email !== 'string') {
        throw new ValidationError(['name and email are required']);
      }
      return { status: 201, body: await service.register(actorOf(req), input) };
    },

    async show(req: Request, id: string): Promise<{ status: number; body: unknown }> {
      const entity = await service.get(id);
      const active = ${activeExpr};
      ${view}
    },

    async contact(req: Request, id: string): Promise<{ status: number; body: unknown }> {
      const { email, phone } = jsonBody<{ email: string; phone: string | null }>(req);
      return { status: 200, body: await service.updateContact(actorOf(req), id, email, phone ?? null) };
    },

    async card(req: Request, id: string): Promise<{ status: number; body: unknown }> {
      return { status: 200, body: { card: await service.card(id) } };
    },
  };
}
`;
}

function routerModule(d, stage) {
  return ts`import { create${d.Main}Handlers } from './${d.main}-handlers';
import { create${d.Party}Handlers } from './${d.party}-handlers';
import { Request, requestId } from './middleware';
import { NotFoundError, ValidationError, ConflictError } from '../shared/errors';

type Handler = (req: Request, id: string) => Promise<{ status: number; body: unknown }>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: Handler;
}

export function buildRoutes(
  ${d.mains}: ReturnType<typeof create${d.Main}Handlers>,
  ${d.parties}: ReturnType<typeof create${d.Party}Handlers>,
): Route[] {
  return [
    { method: 'POST', pattern: /^\/${d.mains}$/, handler: (req) => ${d.mains}.create(req) },
    { method: 'GET', pattern: /^\/${d.mains}$/, handler: (req) => ${d.mains}.list(req) },
    { method: 'GET', pattern: /^\/${d.mains}\/([a-z0-9]+)$/, handler: (req, id) => ${d.mains}.show(req, id) },
    { method: 'PATCH', pattern: /^\/${d.mains}\/([a-z0-9]+)\/status$/, handler: (req, id) => ${d.mains}.move(req, id) },
    { method: 'POST', pattern: /^\/${d.mains}\/([a-z0-9]+)\/cancel$/, handler: (req, id) => ${d.mains}.cancel(req, id) },
    { method: 'GET', pattern: /^\/${d.mains}\/([a-z0-9]+)\/${d.doc}$/, handler: (req, id) => ${d.mains}.${d.doc}(req, id) },
    { method: 'POST', pattern: /^\/${d.parties}$/, handler: (req) => ${d.parties}.register(req) },
    { method: 'GET', pattern: /^\/${d.parties}\/([a-z0-9]+)$/, handler: (req, id) => ${d.parties}.show(req, id) },
    { method: 'PATCH', pattern: /^\/${d.parties}\/([a-z0-9]+)\/contact$/, handler: (req, id) => ${d.parties}.contact(req, id) },
    { method: 'GET', pattern: /^\/${d.parties}\/([a-z0-9]+)\/card$/, handler: (req, id) => ${d.parties}.card(req, id) },
  ];
}

function statusOf(error: unknown): number {
  if (error instanceof ValidationError) return 400;
  if (error instanceof NotFoundError) return 404;
  if (error instanceof ConflictError) return 409;
  return 500;
}

export async function dispatch(routes: Route[], req: Request): Promise<{ status: number; body: unknown; requestId: string }> {
  const id = requestId(req);
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const match = route.pattern.exec(req.path);
    if (match === null) continue;
    try {
      const res = await route.handler(req, match[1] ?? '');
      return { ...res, requestId: id };
    } catch (error) {
      const status = statusOf(error);
      const message = status === 500 ? 'internal error' : (error as Error).message;
      return { status, body: { error: message }, requestId: id };
    }
  }
  return { status: 404, body: { error: 'no route for ' + req.method + ' ' + req.path }, requestId: id };
}
${stage >= 4 ? ts`
export function listRoutes(routes: Route[]): string[] {
  return routes.map((r) => r.method + ' ' + r.pattern.source);
}
` : ''}`;
}

// ─── Fixture assembly ────────────────────────────────────────────────────────

/**
 * The repository at a history stage: stage 1 is the first commit, later stages add one small
 * function to a disjoint pair of files each, so no pair of files changes together three times
 * (no co-change row) and every seeded structure is there from the first commit.
 */
function filesAt(fx, stage) {
  const d = DOMAINS[fx.domain];
  const f = new Set(fx.defects);
  const p = pathsFor(d);
  const rnd = mulberry32(fx.seed);
  const files = {
    [p.types]: typesModule(d),
    [p.errors]: errorsModule(),
    [p.settings]: settingsModule(d, f, rnd),
    [p.conn]: connectionModule(d, f, stage, rnd),
    [p.mainStore]: mainStoreModule(d, f),
    [p.partyStore]: partyStoreModule(d, f),
    [p.pricing]: pricingModule(d, f, stage, rnd),
    [p.validation]: validationModule(d, f, stage),
    [p.mainService]: mainServiceModule(d, f),
    [p.partyService]: partyServiceModule(d, f, rnd),
    [p.profile]: profileModule(d, f, rnd),
    [p.builder]: builderModule(d, f, rnd),
    [p.renderer]: rendererModule(d, f, stage),
    [p.templates]: templatesModule(d, stage),
    [p.mailer]: mailerModule(d, f),
    [p.scheduler]: schedulerModule(d, f, stage),
    [p.reminders]: remindersModule(d, f),
    [p.audit]: auditModule(d, f),
    [p.router]: routerModule(d, stage),
    [p.middleware]: middlewareModule(f, stage),
    [p.hMain]: mainHandlersModule(d, f),
    [p.hParty]: partyHandlersModule(d, f),
  };
  if (f.has('pass-a')) files[p.gateway] = gatewayModule(d);
  if (f.has('pass-b')) files[p.dispatch] = dispatchModule();
  if (f.has('pass-c')) files[p.exporter] = exporterModule(d);
  if (f.has('cluster-a')) clusterAModules(d).forEach((t, i) => (files[p.clusterA[i]] = t));
  if (f.has('cluster-b')) clusterBModules(d).forEach((t, i) => (files[p.clusterB[i]] = t));
  if (f.has('cluster-c')) clusterCModules().forEach((t, i) => (files[p.clusterC[i]] = t));
  return files;
}

const HISTORY = [
  { stage: 1, date: '2026-08-04T09:12:00Z', message: 'feat: initial service' },
  { stage: 2, date: '2026-08-13T14:40:00Z', message: 'feat(notify): subject preview and CORS headers' },
  { stage: 3, date: '2026-08-25T10:05:00Z', message: 'feat: note validation and statement timeouts' },
  { stage: 4, date: '2026-09-09T16:21:00Z', message: 'chore: expose route list and next job run' },
  { stage: 5, date: '2026-09-22T11:48:00Z', message: 'feat: summary lines and average item value' },
];

/** The seeded defects of a fixture, in the ground-truth shape. */
function defectsOf(fx) {
  const d = DOMAINS[fx.domain];
  const p = pathsFor(d);
  const spec = {
    'cycle-a': { class: 'cycle', files: [p.mainService, p.partyService], minFiles: 2,
      description: `${d.main} service imports the ${d.party} service (isActive${d.Party}) and the ${d.party} service imports the ${d.main} service (isOpen): a runtime import cycle` },
    'cycle-b': { class: 'cycle', files: [p.builder, p.pricing], minFiles: 2,
      description: `the ${d.doc} builder imports ${d.main} pricing and pricing imports describeLine back from the builder: a runtime import cycle` },
    'cycle-c': { class: 'cycle', files: [p.mailer, p.reminders, p.audit], minFiles: 2,
      description: 'reminders → mailer (sendTemplate) → audit log (record) → reminders (scheduleFollowUp): a three-module runtime cycle' },
    'pass-a': { class: 'pass_through', files: [p.gateway], minFiles: 1,
      description: `${d.Main}Gateway forwards find/list/save one-to-one to ${d.Main}Store; its only importer is the ${d.main} service` },
    'pass-b': { class: 'pass_through', files: [p.dispatch], minFiles: 1,
      description: 'notify/dispatch only forwards to mailer.sendTemplate with a fixed template kind; its only importer is the reminder job' },
    'pass-c': { class: 'pass_through', files: [p.exporter], minFiles: 1,
      description: `${d.doc}/export only picks renderText or renderHtml from the renderer; its only importer is the ${d.main} handlers` },
    'cluster-a': { class: 'small_cluster', files: p.clusterA, minFiles: 2,
      description: `the ${d.main} status lifecycle (states, terminal check, allowed transitions, labels) is cut into four tiny modules under ${d.main}/status` },
    'cluster-b': { class: 'small_cluster', files: p.clusterB, minFiles: 2,
      description: `${d.doc} numbering (prefix, running sequence, padding, formatting) is cut into four tiny modules under ${d.doc}/numbering` },
    'cluster-c': { class: 'small_cluster', files: p.clusterC, minFiles: 2,
      description: `${d.party} contact normalisation (email, phone, whitespace, display line) is cut into four tiny modules under ${d.party}/contact` },
    'scattered-a': { class: 'scattered', files: [p.pricing, p.builder, p.hMain], minFiles: 2,
      description: 'rounding money to cents is implemented three times, differently: Math.round in pricing, Math.round with EPSILON in the builder, Math.trunc in the handlers' },
    'scattered-b': { class: 'scattered', files: [p.reminders, p.renderer, p.profile], minFiles: 2,
      description: 'the payment deadline (issue/change date + payment term, off the weekend) is computed three times with different rules: reminders (calendar days, Sunday→Monday), renderer (business days), profile (calendar days, UTC weekend skip)' },
    'scattered-c': { class: 'scattered', files: [p.partyService, p.hParty, p.scheduler], minFiles: 2,
      description: `whether a ${d.party} is still active is decided three ways: the service (expiry + grace days), the handlers (expiry + one day), the scheduler (expiry before start of day)` },
    'leaky-a': { class: 'leaky_seam', files: [p.mainStore], minFiles: 1,
      description: `${d.Main}Store hands out driver rows (snake_case columns, items_json) and takes SQL WHERE fragments; the service and the reminder job build SQL and re-map rows themselves` },
    'leaky-b': { class: 'leaky_seam', files: [p.partyStore], minFiles: 1,
      description: `${d.Party}Store returns raw QueryResult rows and updates by column name; callers check rowCount and read full_name/email columns` },
    'leaky-c': { class: 'leaky_seam', files: [p.mailer], minFiles: 1,
      description: 'the mailer exposes the SMTP transaction (raw RFC 5322 message, reply codes); the reminder job builds headers and interprets 4xx/550 codes itself' },
    'shallow-a': { class: 'shallow_interface', files: [p.settings], minFiles: 1,
      description: 'Config exposes one getter per setting (plus setters): its interface is as wide as its implementation and hides nothing' },
    'shallow-b': { class: 'shallow_interface', files: [p.audit], minFiles: 1,
      description: 'AuditLog has one one-line method per audited event, each forwarding to write(): the interface grows with every event and hides nothing' },
    'shallow-c': { class: 'shallow_interface', files: [p.profile], minFiles: 1,
      description: `${d.Party}Profile is a getter/setter per field over the entity: an interface as complex as its implementation` },
  };
  const category = { cycle: 'flagged', pass_through: 'flagged', small_cluster: 'flagged', scattered: 'unflagged', leaky_seam: 'unflagged', shallow_interface: 'unflagged' };
  return fx.defects.map((id) => {
    const s = spec[id];
    return { key: `${fx.id}:${s.class}`, class: s.class, category: category[s.class], variant: id, files: s.files, minFiles: s.minFiles, description: s.description };
  });
}

// ─── Git ─────────────────────────────────────────────────────────────────────

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture Dev',
  GIT_AUTHOR_EMAIL: 'dev@fixture.example',
  GIT_COMMITTER_NAME: 'Fixture Dev',
  GIT_COMMITTER_EMAIL: 'dev@fixture.example',
};

function git(cwd, args, extraEnv = {}) {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: { ...process.env, ...GIT_ENV, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeTree(repo, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function buildRepo(fx, repo) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '--initial-branch=main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.planning/\nnode_modules/\n');
  for (const h of HISTORY) {
    writeTree(repo, filesAt(fx, h.stage));
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', h.message], { GIT_AUTHOR_DATE: h.date, GIT_COMMITTER_DATE: h.date });
  }
  fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.planning', 'config.json'), '{}\n');
  return filesAt(fx, HISTORY[HISTORY.length - 1].stage);
}

function runMetrics(repo) {
  execFileSync(process.execPath, [GSD_TOOLS, 'arch', 'metrics', '--since', SINCE, '--top', String(TOP_ZONES), '--date', METRICS_DATE, '--json'], {
    cwd: repo, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const file = path.join(repo, '.planning', 'architecture', `metrics-${METRICS_DATE}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ─── Self-check ──────────────────────────────────────────────────────────────

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * The signals of one zone holding every module, by the formula of `buildZones` in
 * src/arch-metrics.cts. Real zones are one-hop neighbourhoods of hot spots, so a module with no
 * complexity (a forwarding pass-through, a tiny cluster file) may sit in no zone at all; the
 * fixture is one zone's worth of code, surveyed whole.
 */
function wholeRepoSignals(metrics) {
  return {
    hotspots: metrics.hotspots.map((h) => h.file),
    cycles: metrics.cycles.map((_, i) => i),
    passThrough: metrics.passThrough.map((p) => p.file),
    smallClusters: metrics.smallClusters.map((c) => c.dir),
    coChange: metrics.coChange.map((p) => [p.a, p.b]),
  };
}

function checkFixture(fx, metrics, defects) {
  const fail = (msg) => {
    throw new Error(`${fx.id}: self-check failed — ${msg}`);
  };
  const want = (cls) => defects.filter((x) => x.class === cls);
  const cycles = want('cycle');
  if (metrics.cycles.length !== cycles.length) fail(`cycles ${JSON.stringify(metrics.cycles)} vs seeded ${cycles.length}`);
  for (const c of cycles) {
    if (!metrics.cycles.some((m) => sameSet(m.members, c.files) && m.runtime)) fail(`seeded cycle ${c.files.join(' ')} not reported as a runtime cycle`);
  }
  const pass = want('pass_through').map((x) => x.files[0]);
  if (!sameSet(metrics.passThrough.map((x) => x.file), pass)) fail(`passThrough ${JSON.stringify(metrics.passThrough.map((x) => x.file))} vs ${JSON.stringify(pass)}`);
  const clusters = want('small_cluster');
  if (metrics.smallClusters.length !== clusters.length) fail(`smallClusters ${JSON.stringify(metrics.smallClusters)} vs seeded ${clusters.length}`);
  for (const c of clusters) {
    if (!metrics.smallClusters.some((m) => sameSet(m.modules, c.files))) fail(`seeded cluster ${c.files.join(' ')} not reported`);
  }
  for (const s of want('shallow_interface')) {
    const row = metrics.modules.find((m) => m.file === s.files[0]);
    if (!row || row.small) fail(`shallow module ${s.files[0]} is small (${row && row.loc} loc)`);
  }
  for (const s of want('scattered')) {
    const hit = metrics.coChange.find((c) => s.files.includes(c.a) && s.files.includes(c.b));
    if (hit) fail(`scattered places co-change: ${hit.a} ${hit.b}`);
  }
  if (metrics.coChange.length !== 0) fail(`unexpected co-change rows ${JSON.stringify(metrics.coChange)}`);
}

// ─── Reports ─────────────────────────────────────────────────────────────────

function surveyorBlock(text, tag, where) {
  const m = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`).exec(text);
  if (m === null) throw new Error(`no <${tag}> block in ${where}`);
  return m[0];
}

/** C′: the block as shipped before the D patch, read from git so the Cp reports stay byte-identical. */
function surveyorChecklist() {
  const text = execFileSync('git', ['show', `${CP_SOURCE_REV}:agents/gsd-arch-surveyor.md`], { cwd: ROOT, encoding: 'utf8' });
  return surveyorBlock(text, 'what_the_metrics_checked', `${CP_SOURCE_REV}:agents/gsd-arch-surveyor.md`);
}

/** D: the block the agent ships now — metrics only chose the zone; counted classes are reported without it. */
function surveyorZoneNote() {
  return surveyorBlock(fs.readFileSync(SURVEYOR, 'utf8'), 'zone_and_metrics', SURVEYOR);
}

function buildReports(files, metrics, checklist, zoneNote) {
  const sources = Object.keys(files).sort();
  const header = [
    'Zone: all — whole repository',
    `Survey date: ${METRICS_DATE}`,
    `Seed: ${metrics.zones.length > 0 ? metrics.zones[0].seed : 'none'}`,
    'Files:',
    ...sources,
  ].join('\n');
  const signals = [
    '<signals>',
    JSON.stringify(wholeRepoSignals(metrics), null, 2),
    '</signals>',
    `Per-module rows (loc, fanIn, testFanIn, fanOut, churn, complexity): .planning/architecture/metrics-${METRICS_DATE}.json, \`modules\``,
    '',
    '```json',
    JSON.stringify({
      modules: metrics.modules, cycles: metrics.cycles, passThrough: metrics.passThrough,
      smallClusters: metrics.smallClusters, coChange: metrics.coChange, hotspots: metrics.hotspots,
    }, null, 2),
    '```',
  ].join('\n');
  const body = ['## Source', '', ...sources.map((f) => `### ${f}\n\n\`\`\`ts\n${files[f].replace(/\n+$/, '')}\n\`\`\`\n`)].join('\n');
  const direction = 'Direction from the user: none';
  return {
    A: [header, direction, '', body].join('\n'),
    C: [header, signals, direction, '', body].join('\n'),
    Cp: [header, signals, '', checklist, '', direction, '', body].join('\n'),
    D: [header, '', zoneNote, '', direction, '', body].join('\n'),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function generate(outDir) {
  const checklist = surveyorChecklist();
  const zoneNote = surveyorZoneNote();
  const truth = { mode: 'arch', generated_by: 'scripts/experiments/report-ab/fixtures-arch.cjs', metrics_date: METRICS_DATE, since: SINCE, fixtures: {}, report_sha256: {} };
  for (const fx of FIXTURES) {
    const repo = path.join(outDir, 'repos', fx.id);
    const files = buildRepo(fx, repo);
    const metrics = runMetrics(repo);
    const defects = defectsOf(fx);
    checkFixture(fx, metrics, defects);
    const reports = buildReports(files, metrics, checklist, zoneNote);
    const reportDir = path.join(outDir, 'reports', fx.id);
    fs.mkdirSync(reportDir, { recursive: true });
    for (const v of VARIANTS) {
      fs.writeFileSync(path.join(reportDir, `${v}.md`), reports[v]);
      truth.report_sha256[`${fx.id}/${v}`] = crypto.createHash('sha256').update(reports[v]).digest('hex');
    }
    truth.fixtures[fx.id] = {
      control: defects.length === 0,
      domain: DOMAINS[fx.domain].key,
      head: git(repo, ['rev-parse', 'HEAD']).trim(),
      files: Object.keys(files).sort(),
      defects,
    };
  }
  fs.writeFileSync(path.join(outDir, 'ground-truth.json'), JSON.stringify(truth, null, 2) + '\n');
  return truth;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = path.resolve(i > -1 ? argv[i + 1] : path.join(__dirname, 'out-arch'));
  const truth = generate(outDir);
  for (const [id, fx] of Object.entries(truth.fixtures)) {
    const sizes = VARIANTS.map((v) => `${v} ${(fs.statSync(path.join(outDir, 'reports', id, `${v}.md`)).size / 1024).toFixed(1)}KB`).join(' ');
    process.stdout.write(`${id} ${fx.domain} ${fx.control ? 'control' : fx.defects.map((x) => x.variant).join(',')} files=${fx.files.length} ${sizes}\n`);
  }
}

module.exports = { generate, FIXTURES, DOMAINS, VARIANTS };
