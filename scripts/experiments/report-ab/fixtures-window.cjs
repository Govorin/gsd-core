#!/usr/bin/env node
'use strict';

/**
 * Report A/B experiment, mode `window` (pocock wave 3) — fixture generator and variant builder.
 *
 * Question: does handing a window reviewer the deterministic `review window-prepass` output help
 * it find the cumulative defects of a window of commits, or does it anchor the reviewer on the
 * classes the pre-pass measures and pull it away from the ones it cannot see (the 4.9 lesson)?
 *
 * Writes, under the output directory (default: ./out-window next to this file):
 *
 *   repos/<fx>/          a small TypeScript order service per fixture, a real git repository with
 *                        fixed dates (every sha is reproducible): two commits before the window,
 *                        9–15 commits in it, and two earlier window reviews under .planning/reviews/
 *   reports/<fx>/{A,C,Cp}.md   the three variants of what the reviewer reads
 *   ground-truth.json    the seeded defects (the answer key) and each report's sha256
 *
 * Variants — the window material is the same bytes in all three, only the pre-pass differs:
 *   A   the window header, the window's commit log with the files of every commit, the two earlier
 *       window reviews, the cumulative diff base..tip of src/ and every source file at the tip;
 *   C   A + the pre-pass section first: prepass.json exactly as `gsd-tools review window-prepass`
 *       writes it;
 *   Cp  C + the `<window_prepass>` block ahead of the JSON. Its text is produced by RUNNING the node
 *       snippet of step 2 of gsd-core/workflows/code-review/steps/window-scope.md, read at
 *       generation time — the form the fork ships (C′ of 4.9: "checked only X; find the rest").
 *
 * Defect classes (each seeded three times across six fixtures, 3–4 per fixture, never two in one
 * file of a fixture; two fixtures are clean controls):
 *   flagged by the pre-pass:  complexity (a function gains branches over one or two window commits:
 *                             `complexity.rises`), unused_export (a window commit adds an export no
 *                             module imports: `exports`, change `new`), hotspot (one file patched by
 *                             five fix commits of the same logic: the top of `churn`), recurring (a
 *                             problem both earlier window reviews raised as `guarded by: review only`
 *                             is still in the code, and the window touches the file:
 *                             `reviewOnly.recurring`)
 *   not flagged by design:    logic (a logic error introduced in the window), duplicate (one
 *                             behaviour implemented twice by two window commits in two modules,
 *                             diverging), contract (a caller or callee breaks a documented contract)
 *
 * The generator checks itself: the real CLI runs over every fixture, and `complexity.rises`,
 * `exports`, the ≥5-commit `churn` rows and `reviewOnly.recurring` must hold exactly the seeded
 * flagged defects (nothing on a control), every class must have run, and no other file may reach
 * four commits.
 *
 * Usage: node scripts/experiments/report-ab/fixtures-window.cjs [--out <dir>]
 * Needs the compiled lib (`npm run build:lib`).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GSD_TOOLS = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const WINDOW_SCOPE = path.join(ROOT, 'gsd-core', 'workflows', 'code-review', 'steps', 'window-scope.md');
const PREPASS_DATE = '2026-10-01';
const VARIANTS = ['A', 'C', 'Cp'];

/**
 * Seeded defect ids: <class>-<placement>. Each class has three placements in different files.
 *   cx-a shipping/rates.ts shippingCost   cx-b orders/pricing.ts applyDiscounts   cx-c notify/email.ts sendWithRetry
 *   ue-a invoices/render.ts               ue-b orders/service.ts                  ue-c config.ts
 *   hs-a util/dates.ts                    hs-b catalog/products.ts                hs-c customers/service.ts
 *   rc-a http/routes.ts                   rc-b orders/repo.ts                     rc-c invoices/render.ts
 *   lg-a orders/repo.ts                   lg-b shipping/rates.ts                  lg-c catalog/products.ts
 *   dp-a customers/service + notify/email dp-b orders/pricing + invoices/render   dp-c orders/service + http/routes
 *   ct-a notify/email.ts                  ct-b customers/repo.ts                  ct-c orders/service.ts
 */
const FIXTURES = [
  { id: 'win-01', seed: 101, defects: ['cx-a', 'ue-a', 'hs-a'] },
  { id: 'win-02', seed: 202, defects: ['cx-b', 'rc-a', 'dp-a', 'ct-c'] },
  { id: 'win-03', seed: 303, defects: ['hs-b', 'rc-b', 'ct-a', 'ue-b'] },
  { id: 'win-04', seed: 404, defects: ['cx-c', 'rc-c', 'lg-b', 'dp-c'] },
  { id: 'win-05', seed: 505, defects: ['ue-c', 'hs-c', 'lg-c'] },
  { id: 'win-06', seed: 606, defects: ['ct-b', 'dp-b', 'lg-a'] },
  { id: 'win-07', seed: 707, defects: [] },
  { id: 'win-08', seed: 808, defects: [] },
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

const PRODUCT_POOL = [
  ['MUG-001', 'Stoneware mug', 1299, 420],
  ['TEE-104', 'Organic cotton tee', 2499, 180],
  ['BAG-220', 'Canvas tote', 1899, 350],
  ['LMP-310', 'Desk lamp', 4999, 1600],
  ['KET-115', 'Electric kettle', 3999, 1300],
  ['NBK-007', 'Dot-grid notebook', 899, 300],
  ['BTL-450', 'Steel bottle', 2199, 380],
  ['CHR-900', 'Folding chair', 8999, 5200],
  ['RUG-512', 'Wool rug', 12999, 7400],
  ['PLT-033', 'Ceramic planter', 2799, 950],
];

/** Literal values that vary per fixture and touch no measured structure. */
function literalsFor(fx) {
  const rnd = mulberry32(fx.seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const pool = [...PRODUCT_POOL];
  const products = [];
  while (products.length < 5) products.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return {
    shop: pick(['shop', 'store', 'goods', 'market']),
    taxRate: pick(['0.07', '0.08', '0.0825']),
    pageSize: pick([10, 20, 25]),
    eu: pick(['1.6', '1.8']),
    intl: pick(['2.4', '2.75', '3']),
    coupon: pick([['AUTUMN', 12], ['FRIENDS', 20], ['SPRING', 8]]),
    products,
    saleIndex: Math.floor(rnd() * 5),
  };
}

/** Joins lines, dropping false/null/undefined parts, flattening nested arrays. */
function src(...parts) {
  return parts.flat(Infinity).filter((p) => p !== false && p !== null && p !== undefined).join('\n') + '\n';
}

/** How many hotspot fixes of `id` have landed; -1 when the file is not this fixture's hotspot. */
const hot = (f, s, id) => (f.has(id) ? s.fixes : -1);

// ─── Modules ─────────────────────────────────────────────────────────────────

function configModule(f, s, v) {
  return src(
    s.regions && "import type { Region } from './orders/types';",
    s.regions && '',
    "export const CURRENCY = 'USD';",
    `export const TAX_RATE = ${v.taxRate};`,
    'export const FREE_SHIPPING_MIN_CENTS = 10000;',
    `export const MAIL_FROM = 'orders@${v.shop}.example';`,
    'export const MAX_SEND_ATTEMPTS = 3;',
    s.history && `export const PAGE_SIZE = ${v.pageSize};`,
    s.regions && [
      '',
      '/** Shipping price multiplier per destination region. */',
      `export const REGION_MULTIPLIER: Record<Region, number> = { domestic: 1, eu: ${v.eu}, intl: ${v.intl} };`,
    ],
    s.regions && f.has('ue-c') && [
      '',
      "const ENABLED_FEATURES = new Set<string>(['regional-rates']);",
      '',
      '/** Whether a feature flag is switched on for this deployment. */',
      'export function featureEnabled(name: string): boolean {',
      '  return ENABLED_FEATURES.has(name);',
      '}',
    ],
  );
}

function errorsModule() {
  return src(
    '/** A lookup by id found nothing. */',
    'export class NotFoundError extends Error {',
    '  constructor(readonly entity: string, readonly id: string) {',
    "    super(entity + ' ' + id + ' not found');",
    "    this.name = 'NotFoundError';",
    '  }',
    '}',
    '',
    '/** Input that breaks a business rule; `field` names the offending input. */',
    'export class ValidationError extends Error {',
    '  constructor(readonly field: string, readonly problem: string) {',
    "    super(field + ' ' + problem);",
    "    this.name = 'ValidationError';",
    '  }',
    '}',
  );
}

function moneyModule() {
  return src(
    "import { CURRENCY } from '../config';",
    '',
    '/** Formats an amount in integer cents, e.g. 1999 → "$19.99". The argument is always cents, never dollars. */',
    'export function formatMoney(cents: number): string {',
    "  const sign = cents < 0 ? '-' : '';",
    '  const abs = Math.abs(Math.round(cents));',
    '  const dollars = Math.floor(abs / 100);',
    "  const rest = String(abs % 100).padStart(2, '0');",
    "  const symbol = CURRENCY === 'USD' ? '$' : CURRENCY + ' ';",
    "  return sign + symbol + dollars.toLocaleString('en-US') + '.' + rest;",
    '}',
    '',
    '/** Rounds a fractional cent amount half away from zero. */',
    'export function roundCents(value: number): number {',
    '  return value < 0 ? -Math.round(-value) : Math.round(value);',
    '}',
  );
}

function datesModule(f, s) {
  const h = hot(f, s, 'hs-a');
  const holiday = h >= 4 ? 'day.toISOString().slice(0, 10)' : 'formatDate(day)';
  return src(
    'const DAY_MS = 86_400_000;',
    h >= 3 && "const HOLIDAYS = new Set<string>(['2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']);",
    '',
    'export function addDays(date: Date, days: number): Date {',
    '  return new Date(date.getTime() + days * DAY_MS);',
    '}',
    '',
    '/** Midnight UTC of the same calendar day. */',
    'export function startOfDay(date: Date): Date {',
    '  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));',
    '}',
    '',
    'export function isWeekend(date: Date): boolean {',
    '  const day = date.getUTCDay();',
    '  return day === 0 || day === 6;',
    '}',
    '',
    'function pad(n: number): string {',
    "  return String(n).padStart(2, '0');",
    '}',
    '',
    '/** YYYY-MM-DD of the UTC calendar day. */',
    'export function formatDate(date: Date): string {',
    "  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());",
    '}',
    '',
    '/** Business days after `start` up to and including `end`. */',
    'export function businessDaysBetween(start: Date, end: Date): number {',
    h >= 2 && '  if (end < start) return -businessDaysBetween(end, start);',
    h >= 1 ? '  const from = startOfDay(start);' : '  const from = start;',
    h >= 1 ? '  const to = startOfDay(end);' : '  const to = end;',
    h >= 5 && '  if (from.getTime() === to.getTime()) return 0;',
    '  let count = 0;',
    '  for (let day = addDays(from, 1); day <= to; day = addDays(day, 1)) {',
    h >= 3 ? `    if (!isWeekend(day) && !HOLIDAYS.has(${holiday})) count += 1;` : '    if (!isWeekend(day)) count += 1;',
    '  }',
    '  return count;',
    '}',
  );
}

function idsModule() {
  return src(
    'let counter = 0;',
    '',
    '/** A process-unique id such as `ord_lx3k9a1`. */',
    'export function newId(prefix: string): string {',
    '  counter += 1;',
    "  return prefix + '_' + Date.now().toString(36) + counter.toString(36);",
    '}',
  );
}

function customerTypesModule() {
  return src(
    'export interface Customer {',
    '  id: string;',
    '  /** Lower-cased. */',
    '  email: string;',
    '  firstName: string;',
    '  lastName: string;',
    '  createdAt: Date;',
    '}',
    '',
    'export interface NewCustomer {',
    '  email: string;',
    '  firstName: string;',
    '  lastName: string;',
    '}',
  );
}

function customerRepoModule(f, s) {
  const throws = f.has('ct-b') && s.dupCheck;
  return src(
    throws && "import { NotFoundError } from '../errors';",
    "import type { Customer } from './types';",
    '',
    'export class CustomerRepo {',
    '  private readonly byId = new Map<string, Customer>();',
    '',
    '  /** The customer with this id, or null when there is none. */',
    throws
      ? [
        '  findById(id: string): Customer {',
        '    const customer = this.byId.get(id);',
        "    if (customer === undefined) throw new NotFoundError('customer', id);",
        '    return customer;',
        '  }',
      ]
      : [
        '  findById(id: string): Customer | null {',
        '    return this.byId.get(id) ?? null;',
        '  }',
      ],
    s.dupCheck && [
      '',
      '  /** The customer registered with this (lower-cased) email, or null. */',
      '  findByEmail(email: string): Customer | null {',
      '    for (const customer of this.byId.values()) {',
      '      if (customer.email === email) return customer;',
      '    }',
      '    return null;',
      '  }',
    ],
    '',
    '  save(customer: Customer): void {',
    '    this.byId.set(customer.id, customer);',
    '  }',
    '}',
  );
}

function displayNameLines(f, s) {
  const h = hot(f, s, 'hs-c');
  if (h < 1) return ["  return (customer.firstName + ' ' + customer.lastName).trim();"];
  const chain = [
    '  const parts = [customer.firstName, customer.lastName]',
    '    .map((part) => part.trim())',
    h >= 3 && "    .map((part) => part.replace(/\\s+/g, ' '))",
    h >= 5 && '    .map(capitalize)',
    h >= 2 && '    .filter((part) => part.length > 0)',
  ].filter(Boolean);
  chain[chain.length - 1] += ';';
  return [
    ...chain,
    h >= 4 ? "  const name = parts.join(' ');" : "  return parts.join(' ');",
    h >= 4 && '  return name.length > 0 ? name : customer.email;',
  ];
}

function customerServiceModule(f, s) {
  const exportValidator = !f.has('dp-a');
  return src(
    "import { ValidationError } from '../errors';",
    "import { newId } from '../util/ids';",
    "import type { CustomerRepo } from './repo';",
    "import type { Customer, NewCustomer } from './types';",
    '',
    s.emailValidation && [
      'const EMAIL_PATTERN = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;',
      '',
      '/** Whether `email` looks like a deliverable address. */',
      `${exportValidator ? 'export ' : ''}function isValidEmail(email: string): boolean {`,
      '  return EMAIL_PATTERN.test(email);',
      '}',
      '',
    ],
    hot(f, s, 'hs-c') >= 5 && [
      'function capitalize(part: string): string {',
      '  return part.charAt(0).toUpperCase() + part.slice(1);',
      '}',
      '',
    ],
    '/** The customer\'s name as shown on mail and invoices. */',
    'export function displayName(customer: Customer): string {',
    displayNameLines(f, s),
    '}',
    '',
    'export class CustomerService {',
    '  constructor(private readonly repo: CustomerRepo) {}',
    '',
    '  register(input: NewCustomer, now: Date): Customer {',
    '    const email = input.email.trim().toLowerCase();',
    s.emailValidation && "    if (!isValidEmail(email)) throw new ValidationError('email', 'is not a valid address');",
    s.dupCheck && "    if (this.repo.findByEmail(email) !== null) throw new ValidationError('email', 'is already registered');",
    "    if (input.firstName.trim() === '') throw new ValidationError('firstName', 'is required');",
    "    const customer: Customer = { id: newId('cus'), email, firstName: input.firstName, lastName: input.lastName, createdAt: now };",
    '    this.repo.save(customer);',
    '    return customer;',
    '  }',
    '',
    '  /** The customer with this id, or null when there is none. */',
    '  find(id: string): Customer | null {',
    '    return this.repo.findById(id);',
    '  }',
    '}',
  );
}

function productsModule(f, s, v) {
  const h = hot(f, s, 'hs-b');
  const rows = v.products.map(([sku, name, price, grams], i) => {
    const sale = i === v.saleIndex ? "salePercent: 20, saleEndsAt: new Date('2026-10-20T00:00:00Z')" : 'salePercent: 0, saleEndsAt: null';
    return `  { sku: '${sku}', name: '${name}', priceCents: ${price}, weightGrams: ${grams}, ${sale} },`;
  });
  const percent = h >= 2 ? 'percent' : 'product.salePercent';
  let price = `product.priceCents * (1 - ${percent} / 100)`;
  if (h >= 3) price = `roundCents(${price})`;
  else if (h >= 1) price = `Math.round(${price})`;
  if (h >= 4) price = `Math.max(1, ${price})`;
  let saleEnd = 'now < product.saleEndsAt';
  if (f.has('lg-c')) saleEnd = 'now > product.saleEndsAt';
  if (h >= 5) saleEnd = 'now.getTime() < product.saleEndsAt.getTime() + DAY_MS';
  return src(
    h >= 3 && "import { roundCents } from '../util/money';",
    h >= 3 && '',
    'export interface Product {',
    '  sku: string;',
    '  name: string;',
    '  priceCents: number;',
    '  weightGrams: number;',
    '  /** Percent off while the sale runs; 0 when there is no sale. */',
    '  salePercent: number;',
    '  /** The sale ends at this instant; null when there is no sale. */',
    '  saleEndsAt: Date | null;',
    '}',
    '',
    h >= 5 && 'const DAY_MS = 86_400_000;',
    h >= 5 && '',
    'const PRODUCTS: readonly Product[] = [',
    rows,
    '];',
    '',
    '/** The product with this SKU, or null when the catalog has none. */',
    'export function findProduct(sku: string): Product | null {',
    '  return PRODUCTS.find((p) => p.sku === sku) ?? null;',
    '}',
    '',
    s.sales && [
      '/** Whether the product\'s sale is running at `now`. */',
      'function onSale(product: Product, now: Date): boolean {',
      '  if (product.saleEndsAt === null || product.salePercent <= 0) return false;',
      `  return ${saleEnd};`,
      '}',
      '',
    ],
    '/** Unit price in cents at `now`, with a running sale applied. */',
    'export function priceFor(product: Product, now: Date): number {',
    s.sales ? '  if (onSale(product, now)) {' : '  if (product.saleEndsAt !== null && now < product.saleEndsAt) {',
    h >= 2 && '    const percent = Math.min(90, Math.max(0, product.salePercent));',
    `    return ${price};`,
    '  }',
    '  return product.priceCents;',
    '}',
  );
}

function orderTypesModule() {
  return src(
    "export type Region = 'domestic' | 'eu' | 'intl';",
    '',
    "export type OrderStatus = 'placed' | 'cancelled' | 'shipped';",
    '',
    'export interface OrderLine {',
    '  sku: string;',
    '  quantity: number;',
    '  unitCents: number;',
    '  weightGrams: number;',
    '}',
    '',
    'export interface Order {',
    '  id: string;',
    '  customerId: string;',
    '  region: Region;',
    '  status: OrderStatus;',
    '  lines: OrderLine[];',
    '  subtotalCents: number;',
    '  discountCents: number;',
    '  shippingCents: number;',
    '  taxCents: number;',
    '  totalCents: number;',
    '  createdAt: Date;',
    '}',
  );
}

function orderRepoModule(f, s) {
  return src(
    "import type { Order } from './types';",
    '',
    'export class OrderRepo {',
    '  private readonly byId = new Map<string, Order>();',
    '  private readonly byCustomer = new Map<string, Order[]>();',
    '',
    '  /** The order with this id, or null when there is none. */',
    '  findOrder(id: string): Order | null {',
    '    return this.byId.get(id) ?? null;',
    '  }',
    '',
    '  save(order: Order): void {',
    '    if (!this.byId.has(order.id)) {',
    '      const list = this.byCustomer.get(order.customerId) ?? [];',
    '      list.push(order);',
    '      this.byCustomer.set(order.customerId, list);',
    '    }',
    '    this.byId.set(order.id, order);',
    '  }',
    '',
    '  /** The customer\'s orders, oldest first. */',
    '  listByCustomer(customerId: string): Order[] {',
    f.has('rc-b') ? '    return this.byCustomer.get(customerId) ?? [];' : '    return [...(this.byCustomer.get(customerId) ?? [])];',
    '  }',
    '}',
    s.history && [
      '',
      '/** Page `pageNumber` (1-based) of `items`, `size` items per page. */',
      'export function page<T>(items: readonly T[], pageNumber: number, size: number): T[] {',
      f.has('lg-a') ? '  const start = pageNumber * size;' : '  const start = (pageNumber - 1) * size;',
      '  return items.slice(start, start + size);',
      '}',
    ],
  );
}

function applyDiscountsLines(f, s) {
  if (!(f.has('cx-b') && s.tiers)) {
    return [
      '  if (coupon === null) return 0;',
      '  const percent = COUPONS[coupon.trim().toUpperCase()];',
      '  if (percent === undefined) return 0;',
      '  return roundCents((subtotalCents * percent) / 100);',
    ];
  }
  return [
    "  if (coupon === null || coupon.trim() === '') return 0;",
    '  const code = coupon.trim().toUpperCase();',
    '  let percent = COUPONS[code] ?? 0;',
    "  if (code.startsWith('VIP-')) {",
    '    const year = Number(code.slice(4));',
    '    if (Number.isInteger(year) && year >= 2025) {',
    '      percent = subtotalCents >= 50000 ? 20 : 15;',
    '    } else {',
    '      percent = 5;',
    '    }',
    "  } else if (code === 'BULK') {",
    '    if (subtotalCents >= 100000) percent = 12;',
    '    else if (subtotalCents >= 50000) percent = 8;',
    '    else percent = 0;',
    "  } else if (code.startsWith('WELCOME') && subtotalCents < 20000) {",
    '    percent = Math.min(percent, 10);',
    '  }',
    '  if (percent <= 0) return 0;',
    '  const discount = roundCents((subtotalCents * percent) / 100);',
    '  return discount > MAX_DISCOUNT_CENTS ? MAX_DISCOUNT_CENTS : discount;',
  ];
}

function pricingModule(f, s, v) {
  return src(
    s.tax && "import { TAX_RATE } from '../config';",
    "import { roundCents } from '../util/money';",
    s.tax ? "import type { OrderLine, Region } from './types';" : "import type { OrderLine } from './types';",
    '',
    `const COUPONS: Record<string, number> = { SAVE10: 10, WELCOME: 15, ${v.coupon[0]}: ${v.coupon[1]} };`,
    f.has('cx-b') && s.tiers && 'const MAX_DISCOUNT_CENTS = 25000;',
    s.tax && 'const TAX_RATES: Record<Region, number> = { domestic: TAX_RATE, eu: 0.2, intl: 0 };',
    '',
    '/** Sum of the lines in cents. */',
    'export function subtotal(lines: readonly OrderLine[]): number {',
    '  return lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);',
    '}',
    '',
    '/** Discount in cents for a coupon code; 0 for no coupon or an unknown one. */',
    'export function applyDiscounts(subtotalCents: number, coupon: string | null): number {',
    applyDiscountsLines(f, s),
    '}',
    s.tax && [
      '',
      '/** Tax in cents on `amountCents` for the destination region. */',
      'export function taxFor(amountCents: number, region: Region): number {',
      '  return roundCents(amountCents * TAX_RATES[region]);',
      '}',
    ],
  );
}

function orderServiceModule(f, s) {
  const pricingNames = s.tax ? 'applyDiscounts, subtotal, taxFor' : 'applyDiscounts, subtotal';
  let shipping = '    const shippingCents = shippingCost(weightGrams, subtotalCents - discountCents);';
  if (s.regions) {
    shipping = f.has('ct-c')
      ? ['    const weightKg = weightGrams / 1000;', '    const shippingCents = shippingCost(weightKg, input.region, subtotalCents - discountCents);']
      : '    const shippingCents = shippingCost(weightGrams, input.region, subtotalCents - discountCents);';
  }
  return src(
    "import { findProduct, priceFor } from '../catalog/products';",
    !s.tax && "import { TAX_RATE } from '../config';",
    "import { NotFoundError, ValidationError } from '../errors';",
    "import { shippingCost } from '../shipping/rates';",
    "import { newId } from '../util/ids';",
    !s.tax && "import { roundCents } from '../util/money';",
    `import { ${pricingNames} } from './pricing';`,
    s.history && "import { page } from './repo';",
    "import type { OrderRepo } from './repo';",
    "import type { Order, OrderLine, Region } from './types';",
    '',
    'export interface PlaceOrderInput {',
    '  customerId: string;',
    '  items: Array<{ sku: string; quantity: number }>;',
    '  region: Region;',
    '  coupon: string | null;',
    '}',
    s.history && [
      '',
      'const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;',
      '',
      '/** An order can be cancelled while it is placed and less than 24 hours old. */',
      `${f.has('dp-c') ? '' : 'export '}function canCancel(order: Order, now: Date): boolean {`,
      "  return order.status === 'placed' && now.getTime() - order.createdAt.getTime() < CANCEL_WINDOW_MS;",
      '}',
    ],
    s.history && f.has('ue-b') && [
      '',
      '/** CSV of orders for the finance export: id, customer, status, total in dollars. */',
      'export function ordersToCsv(orders: readonly Order[]): string {',
      "  const rows = orders.map((o) => [o.id, o.customerId, o.status, (o.totalCents / 100).toFixed(2)].join(','));",
      "  return ['id,customer,status,total', ...rows].join('\\n');",
      '}',
    ],
    '',
    'export class OrderService {',
    '  constructor(private readonly repo: OrderRepo) {}',
    '',
    '  place(input: PlaceOrderInput, now: Date): Order {',
    '    const lines: OrderLine[] = input.items.map((item) => {',
    '      const product = findProduct(item.sku);',
    "      if (product === null) throw new ValidationError('sku', 'unknown product ' + item.sku);",
    '      return { sku: product.sku, quantity: item.quantity, unitCents: priceFor(product, now), weightGrams: product.weightGrams };',
    '    });',
    '    const subtotalCents = subtotal(lines);',
    '    const discountCents = applyDiscounts(subtotalCents, input.coupon);',
    '    const weightGrams = lines.reduce((sum, line) => sum + line.weightGrams * line.quantity, 0);',
    shipping,
    s.tax
      ? '    const taxCents = taxFor(subtotalCents - discountCents, input.region);'
      : '    const taxCents = roundCents((subtotalCents - discountCents) * TAX_RATE);',
    '    const order: Order = {',
    "      id: newId('ord'),",
    '      customerId: input.customerId,',
    '      region: input.region,',
    "      status: 'placed',",
    '      lines,',
    '      subtotalCents,',
    '      discountCents,',
    '      shippingCents,',
    '      taxCents,',
    '      totalCents: subtotalCents - discountCents + shippingCents + taxCents,',
    '      createdAt: now,',
    '    };',
    '    this.repo.save(order);',
    '    return order;',
    '  }',
    '',
    '  cancel(id: string, now: Date): Order {',
    '    const order = this.repo.findOrder(id);',
    "    if (order === null) throw new NotFoundError('order', id);",
    s.history
      ? "    if (!canCancel(order, now)) throw new ValidationError('status', 'the order can no longer be cancelled');"
      : "    if (order.status !== 'placed') throw new ValidationError('status', 'only placed orders can be cancelled');",
    "    const cancelled: Order = { ...order, status: 'cancelled' };",
    '    this.repo.save(cancelled);',
    '    return cancelled;',
    '  }',
    s.history && [
      '',
      '  /** Page `pageNumber` of the customer\'s orders, oldest first. */',
      '  history(customerId: string, pageNumber: number, size: number): Order[] {',
      '    return page(this.repo.listByCustomer(customerId), pageNumber, size);',
      '  }',
    ],
    '}',
  );
}

function shippingCostLines(f, s) {
  if (!s.regions) {
    return [
      '  // Goods worth FREE_SHIPPING_MIN_CENTS or more ship free.',
      '  if (subtotalCents >= FREE_SHIPPING_MIN_CENTS) return 0;',
      '  const kg = Math.ceil(weightGrams / 1000);',
      '  return BASE_CENTS + kg * PER_KG_CENTS;',
    ];
  }
  if (!f.has('cx-a')) {
    return [
      '  // Goods worth FREE_SHIPPING_MIN_CENTS or more ship free.',
      `  if (subtotalCents ${f.has('lg-b') ? '>' : '>='} FREE_SHIPPING_MIN_CENTS) return 0;`,
      '  const kg = Math.ceil(weightGrams / 1000);',
      '  return Math.round((BASE_CENTS + kg * PER_KG_CENTS) * REGION_MULTIPLIER[region]);',
    ];
  }
  return [
    '  // Goods worth FREE_SHIPPING_MIN_CENTS or more ship free within the country.',
    "  if (subtotalCents >= FREE_SHIPPING_MIN_CENTS && region === 'domestic') return 0;",
    '  const kg = Math.ceil(weightGrams / 1000);',
    '  let cents = BASE_CENTS + kg * PER_KG_CENTS;',
    "  if (region === 'eu') {",
    '    cents += kg > 5 ? 900 : 400;',
    "  } else if (region === 'intl') {",
    '    cents += kg > 5 ? 2400 : 1200;',
    '    if (kg > 20) cents += 3000;',
    '  }',
    s.surcharges && [
      '  if (weightGrams > OVERSIZE_GRAMS) {',
      "    cents += region === 'domestic' ? 1500 : 4000;",
      '  }',
      '  if (subtotalCents < 2000 || kg === 0) cents += SMALL_ORDER_CENTS;',
      '  for (const tier of WEIGHT_TIERS) {',
      '    if (kg >= tier.minKg) {',
      '      cents += tier.extraCents;',
      '      break;',
      '    }',
      '  }',
    ],
    '  return Math.round(cents * REGION_MULTIPLIER[region]);',
  ];
}

function ratesModule(f, s) {
  return src(
    s.regions ? "import { FREE_SHIPPING_MIN_CENTS, REGION_MULTIPLIER } from '../config';" : "import { FREE_SHIPPING_MIN_CENTS } from '../config';",
    "import type { Region } from '../orders/types';",
    "import { addDays, isWeekend, startOfDay } from '../util/dates';",
    '',
    'const BASE_CENTS = 499;',
    'const PER_KG_CENTS = 120;',
    f.has('cx-a') && s.surcharges && [
      'const OVERSIZE_GRAMS = 30000;',
      'const SMALL_ORDER_CENTS = 250;',
      'const WEIGHT_TIERS = [',
      '  { minKg: 50, extraCents: 6000 },',
      '  { minKg: 25, extraCents: 2500 },',
      '  { minKg: 10, extraCents: 900 },',
      '];',
    ],
    'const TRANSIT_DAYS: Record<Region, number> = { domestic: 2, eu: 5, intl: 9 };',
    '',
    '/** Shipping in cents for a parcel of `weightGrams` grams (grams, not kilograms). */',
    s.regions
      ? 'export function shippingCost(weightGrams: number, region: Region, subtotalCents: number): number {'
      : 'export function shippingCost(weightGrams: number, subtotalCents: number): number {',
    shippingCostLines(f, s),
    '}',
    '',
    '/** The delivery date: the region\'s transit time in business days after `from`. */',
    'export function estimateDelivery(from: Date, region: Region): Date {',
    '  let day = startOfDay(from);',
    '  let left = TRANSIT_DAYS[region];',
    '  while (left > 0) {',
    '    day = addDays(day, 1);',
    '    if (!isWeekend(day)) left -= 1;',
    '  }',
    '  return day;',
    '}',
  );
}

function renderModule(f, s) {
  const tb = s.taxBreakdown;
  const dup = tb && f.has('dp-b');
  const escape = !f.has('rc-c');
  return src(
    dup && "import { TAX_RATE } from '../config';",
    "import { displayName } from '../customers/service';",
    "import type { Customer } from '../customers/types';",
    tb && !dup && "import { taxFor } from '../orders/pricing';",
    dup ? "import type { Order, Region } from '../orders/types';" : "import type { Order } from '../orders/types';",
    "import { addDays, businessDaysBetween, formatDate } from '../util/dates';",
    "import { formatMoney } from '../util/money';",
    '',
    'const PAYMENT_TERM_DAYS = 14;',
    escape && [
      "const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' };",
      '',
      'function escapeHtml(value: string): string {',
      '  return value.replace(/[&<>"\']/g, (ch) => HTML_ESCAPES[ch]);',
      '}',
    ],
    dup && [
      '',
      '/** Tax on one invoice line. */',
      'function lineTax(amountCents: number, region: Region): number {',
      "  const rate = region === 'eu' ? 0.21 : region === 'intl' ? 0 : TAX_RATE;",
      '  return Math.floor(amountCents * rate);',
      '}',
    ],
    '',
    '/** The invoice of an order as an HTML fragment. */',
    'export function renderInvoice(order: Order, customer: Customer): string {',
    '  const due = addDays(order.createdAt, PAYMENT_TERM_DAYS);',
    escape ? '  const name = escapeHtml(displayName(customer));' : '  const name = displayName(customer);',
    '  const rows = order.lines.map((line) => {',
    '    const amount = line.unitCents * line.quantity;',
    tb
      ? [
        `    const tax = ${dup ? 'lineTax' : 'taxFor'}(amount, order.region);`,
        "    return '<tr><td>' + line.sku + '</td><td>' + line.quantity + '</td><td>' + formatMoney(amount) + '</td><td>' + formatMoney(tax) + '</td></tr>';",
      ]
      : "    return '<tr><td>' + line.sku + '</td><td>' + line.quantity + '</td><td>' + formatMoney(amount) + '</td></tr>';",
    '  });',
    '  return [',
    "    '<h1>Invoice ' + order.id + '</h1>',",
    "    '<p>Billed to ' + name + '</p>',",
    "    '<table>',",
    '    ...rows,',
    "    '</table>',",
    "    '<p>Subtotal ' + formatMoney(order.subtotalCents) + ', discount ' + formatMoney(order.discountCents) + ', shipping ' + formatMoney(order.shippingCents) + ', tax ' + formatMoney(order.taxCents) + '</p>',",
    "    '<p><strong>Total ' + formatMoney(order.totalCents) + '</strong></p>',",
    "    '<p>Payment due ' + formatDate(due) + ' (' + businessDaysBetween(order.createdAt, due) + ' business days)</p>',",
    "  ].join('\\n');",
    '}',
    tb && f.has('ue-a') && [
      '',
      '/** Invoice number in the format of the old billing system: INV-<year>-<last six of the id>. */',
      'export function legacyInvoiceNumber(order: Order): string {',
      "  return 'INV-' + order.createdAt.getUTCFullYear() + '-' + order.id.slice(-6).toUpperCase();",
      '}',
    ],
  );
}

function sendWithRetryLines(f, s) {
  if (!f.has('cx-c') || !s.confirmation) {
    return [
      '  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {',
      "    if (transport.send(mail) === 'ok') return true;",
      '  }',
      '  return false;',
    ];
  }
  if (!s.throttle) {
    return [
      '  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {',
      '    const result = transport.send(mail);',
      "    if (result === 'ok') return true;",
      "    if (result === 'rejected') return false;",
      '  }',
      '  return false;',
    ];
  }
  return [
    '  let delayMs = 0;',
    '  for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {',
    '    const result = transport.send(mail);',
    "    if (result === 'ok') return true;",
    "    if (result === 'rejected') return false;",
    "    if (result === 'throttled') {",
    '      delayMs = delayMs === 0 ? INITIAL_BACKOFF_MS : Math.min(delayMs * 2, MAX_BACKOFF_MS);',
    "    } else if (result === 'soft-bounce' && attempt < MAX_SEND_ATTEMPTS) {",
    '      delayMs = SOFT_BOUNCE_DELAY_MS;',
    "    } else if (result === 'soft-bounce') {",
    '      return false;',
    '    }',
    '    if (delayMs > 0 && attempt < MAX_SEND_ATTEMPTS) transport.wait(delayMs);',
    '  }',
    '  return false;',
  ];
}

function emailModule(f, s) {
  const throttle = f.has('cx-c') && s.throttle;
  const dup = f.has('dp-a');
  const sharedValidator = s.emailValidation && !dup;
  const total = f.has('ct-a')
    ? ['  const totalDollars = order.totalCents / 100;', "  const footer = 'Total: ' + formatMoney(totalDollars);"]
    : "  const footer = 'Total: ' + formatMoney(order.totalCents);";
  return src(
    "import { MAIL_FROM, MAX_SEND_ATTEMPTS } from '../config';",
    sharedValidator ? "import { displayName, isValidEmail } from '../customers/service';" : "import { displayName } from '../customers/service';",
    "import type { Customer } from '../customers/types';",
    s.confirmation && "import type { Order } from '../orders/types';",
    s.confirmation && "import { formatMoney } from '../util/money';",
    '',
    throttle ? "export type SendResult = 'ok' | 'throttled' | 'rejected' | 'soft-bounce';" : "export type SendResult = 'ok' | 'throttled' | 'rejected';",
    '',
    'export interface Mail {',
    '  from: string;',
    '  to: string;',
    '  subject: string;',
    '  body: string;',
    '}',
    '',
    'export interface Transport {',
    '  send(mail: Mail): SendResult;',
    throttle && '  wait(ms: number): void;',
    '}',
    throttle && ['', 'const INITIAL_BACKOFF_MS = 500;', 'const MAX_BACKOFF_MS = 8000;', 'const SOFT_BOUNCE_DELAY_MS = 2000;'],
    s.confirmation && dup && [
      '',
      'const ADDRESS = /^[^\\s@]+@[^\\s@]+\\.[a-z]+$/i;',
      '',
      'function looksLikeEmail(value: string): boolean {',
      '  return ADDRESS.test(value);',
      '}',
    ],
    '',
    '/** Sends `mail`, trying up to MAX_SEND_ATTEMPTS times; true once the transport accepts it. */',
    'export function sendWithRetry(transport: Transport, mail: Mail): boolean {',
    sendWithRetryLines(f, s),
    '}',
    '',
    'export function welcomeMail(customer: Customer): Mail {',
    "  return { from: MAIL_FROM, to: customer.email, subject: 'Welcome, ' + displayName(customer), body: 'Thanks for signing up.' };",
    '}',
    s.confirmation && [
      '',
      'export function orderConfirmation(order: Order, customer: Customer): Mail {',
      dup && "  if (!looksLikeEmail(customer.email)) throw new Error('cannot mail ' + customer.email);",
      sharedValidator && "  if (!isValidEmail(customer.email)) throw new Error('cannot mail ' + customer.email);",
      "  const lines = order.lines.map((line) => line.quantity + ' x ' + line.sku);",
      total,
      "  const body = ['Hi ' + displayName(customer) + ',', '', ...lines, '', footer].join('\\n');",
      "  return { from: MAIL_FROM, to: customer.email, subject: 'Your order ' + order.id, body };",
      '}',
    ],
  );
}

function routesModule(f, s) {
  const emailNames = s.confirmation ? 'orderConfirmation, sendWithRetry, welcomeMail' : 'sendWithRetry, welcomeMail';
  const sharedCancel = s.apiTotals && !f.has('dp-c');
  let cancellable = null;
  if (s.apiTotals) {
    cancellable = f.has('dp-c')
      ? "    cancellable: order.status === 'placed' && now.getTime() - order.createdAt.getTime() < 48 * HOUR_MS,"
      : '    cancellable: canCancel(order, now),';
  }
  return src(
    s.history && "import { PAGE_SIZE } from '../config';",
    "import type { CustomerService } from '../customers/service';",
    "import { NotFoundError, ValidationError } from '../errors';",
    s.invoices && "import { renderInvoice } from '../invoices/render';",
    `import { ${emailNames} } from '../notify/email';`,
    "import type { Transport } from '../notify/email';",
    "import type { OrderRepo } from '../orders/repo';",
    sharedCancel && "import { canCancel } from '../orders/service';",
    "import type { OrderService } from '../orders/service';",
    "import type { Region } from '../orders/types';",
    "import { estimateDelivery } from '../shipping/rates';",
    "import { formatDate } from '../util/dates';",
    '',
    'export interface Request {',
    '  params: Record<string, string>;',
    '  query: Record<string, string>;',
    '  body: Record<string, unknown>;',
    '}',
    '',
    'export interface Response {',
    '  status: number;',
    '  body: unknown;',
    '}',
    '',
    'export interface Deps {',
    '  customers: CustomerService;',
    '  orders: OrderService;',
    '  orderRepo: OrderRepo;',
    '  transport: Transport;',
    '  now: () => Date;',
    '}',
    '',
    'export type Handler = (deps: Deps, req: Request) => Response;',
    '',
    "const REGIONS: readonly string[] = ['domestic', 'eu', 'intl'];",
    s.apiTotals && f.has('dp-c') && 'const HOUR_MS = 60 * 60 * 1000;',
    '',
    'function text(value: unknown): string {',
    "  return typeof value === 'string' ? value.trim() : '';",
    '}',
    '',
    'function statusOf(error: unknown): number {',
    '  if (error instanceof ValidationError) return 400;',
    '  if (error instanceof NotFoundError) return 404;',
    '  return 500;',
    '}',
    '',
    'function fail(error: unknown): Response {',
    "  return { status: statusOf(error), body: { error: error instanceof Error ? error.message : 'internal error' } };",
    '}',
    '',
    'function parseItems(raw: unknown): Array<{ sku: string; quantity: number }> {',
    "  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError('items', 'at least one item is required');",
    '  return raw.map((entry: Record<string, unknown>) => {',
    f.has('rc-a')
      ? '    return { sku: text(entry.sku), quantity: Number(entry.quantity) };'
      : [
        '    const quantity = Number(entry.quantity);',
        "    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new ValidationError('quantity', 'must be a whole number from 1 to 99');",
        '    return { sku: text(entry.sku), quantity };',
      ],
    '  });',
    '}',
    '',
    'function createCustomer(deps: Deps, req: Request): Response {',
    '  try {',
    '    const customer = deps.customers.register(',
    '      { email: text(req.body.email), firstName: text(req.body.firstName), lastName: text(req.body.lastName) },',
    '      deps.now(),',
    '    );',
    '    sendWithRetry(deps.transport, welcomeMail(customer));',
    '    return { status: 201, body: { id: customer.id } };',
    '  } catch (error) {',
    '    return fail(error);',
    '  }',
    '}',
    '',
    'function createOrder(deps: Deps, req: Request): Response {',
    '  try {',
    '    const customer = deps.customers.find(text(req.body.customerId));',
    "    if (customer === null) return { status: 400, body: { error: 'unknown customer' } };",
    '    const region = text(req.body.region);',
    "    if (!REGIONS.includes(region)) return { status: 400, body: { error: 'unknown region ' + region } };",
    '    const coupon = text(req.body.coupon);',
    '    const now = deps.now();',
    '    const order = deps.orders.place(',
    "      { customerId: customer.id, items: parseItems(req.body.items), region: region as Region, coupon: coupon === '' ? null : coupon },",
    '      now,',
    '    );',
    s.confirmation && '    sendWithRetry(deps.transport, orderConfirmation(order, customer));',
    '    return { status: 201, body: { id: order.id, totalCents: order.totalCents, estimatedDelivery: formatDate(estimateDelivery(now, order.region)) } };',
    '  } catch (error) {',
    '    return fail(error);',
    '  }',
    '}',
    s.invoices && [
      '',
      'function invoice(deps: Deps, req: Request): Response {',
      '  const order = deps.orderRepo.findOrder(req.params.id);',
      "  if (order === null) return { status: 404, body: { error: 'no order ' + req.params.id } };",
      '  const customer = deps.customers.find(order.customerId);',
      "  if (customer === null) return { status: 409, body: { error: 'the order has no customer record' } };",
      '  return { status: 200, body: renderInvoice(order, customer) };',
      '}',
    ],
    '',
    'function cancelOrder(deps: Deps, req: Request): Response {',
    '  try {',
    '    const order = deps.orders.cancel(req.params.id, deps.now());',
    '    return { status: 200, body: { id: order.id, status: order.status } };',
    '  } catch (error) {',
    '    return fail(error);',
    '  }',
    '}',
    s.history && [
      '',
      'function orderHistory(deps: Deps, req: Request): Response {',
      "  const pageNumber = Math.max(1, Math.floor(Number(req.query.page ?? '1')) || 1);",
      '  const orders = deps.orders.history(req.params.id, pageNumber, PAGE_SIZE);',
      s.apiTotals && '  const now = deps.now();',
      '  const items = orders.map((order) => ({',
      '    id: order.id,',
      '    status: order.status,',
      '    totalCents: order.totalCents,',
      '    placedAt: formatDate(order.createdAt),',
      cancellable,
      '  }));',
      '  return { status: 200, body: { page: pageNumber, items } };',
      '}',
    ],
    '',
    'export const ROUTES: Record<string, Handler> = {',
    "  'POST /customers': createCustomer,",
    "  'POST /orders': createOrder,",
    s.invoices && "  'GET /orders/:id/invoice': invoice,",
    "  'POST /orders/:id/cancel': cancelOrder,",
    s.history && "  'GET /customers/:id/orders': orderHistory,",
    '};',
  );
}

function mainModule(f, s) {
  return src(
    "import { CustomerRepo } from './customers/repo';",
    "import { CustomerService } from './customers/service';",
    "import { ROUTES } from './http/routes';",
    "import type { Deps } from './http/routes';",
    "import type { Mail, Transport } from './notify/email';",
    "import { OrderRepo } from './orders/repo';",
    "import { OrderService } from './orders/service';",
    '',
    'const outbox: Mail[] = [];',
    'const transport: Transport = {',
    '  send(mail) {',
    '    outbox.push(mail);',
    "    return 'ok';",
    '  },',
    f.has('cx-c') && s.throttle && ['  wait() {', '    // The in-process outbox never throttles.', '  },'],
    '};',
    'const orderRepo = new OrderRepo();',
    'const deps: Deps = {',
    '  customers: new CustomerService(new CustomerRepo()),',
    '  orders: new OrderService(orderRepo),',
    '  orderRepo,',
    '  transport,',
    '  now: () => new Date(),',
    '};',
    '',
    "console.log('order service: ' + Object.keys(ROUTES).length + ' routes, outbox ' + outbox.length + ', started ' + deps.now().toISOString());",
  );
}

/** Every source file of fixture `fx` at state `s` (the flags landed so far). */
function filesAt(fx, s) {
  const f = new Set(fx.defects);
  const v = literalsFor(fx);
  const files = {
    'src/config.ts': configModule(f, s, v),
    'src/errors.ts': errorsModule(),
    'src/util/money.ts': moneyModule(),
    'src/util/dates.ts': datesModule(f, s),
    'src/util/ids.ts': idsModule(),
    'src/customers/types.ts': customerTypesModule(),
    'src/customers/repo.ts': customerRepoModule(f, s),
    'src/customers/service.ts': customerServiceModule(f, s),
    'src/catalog/products.ts': productsModule(f, s, v),
    'src/orders/types.ts': orderTypesModule(),
    'src/orders/repo.ts': orderRepoModule(f, s),
    'src/orders/pricing.ts': pricingModule(f, s, v),
    'src/orders/service.ts': orderServiceModule(f, s),
    'src/shipping/rates.ts': ratesModule(f, s),
    'src/notify/email.ts': emailModule(f, s),
    'src/http/routes.ts': routesModule(f, s),
    'src/main.ts': mainModule(f, s),
  };
  if (s.invoices) files['src/invoices/render.ts'] = renderModule(f, s);
  return files;
}

// ─── History ─────────────────────────────────────────────────────────────────

const BASE_HISTORY = [
  { date: '2026-08-18T10:00:00Z', flag: null, message: 'feat: order service with customers, catalog, orders and shipping' },
  { date: '2026-09-03T14:20:00Z', flag: 'invoices', message: 'feat(invoices): HTML invoices' },
];

const HOTSPOT_MESSAGES = {
  'hs-a': [
    'fix(dates): count business days on UTC midnights',
    'fix(dates): negative business-day count for reversed ranges',
    'fix(dates): skip public holidays in business-day counts',
    'fix(dates): compare holidays by UTC calendar date',
    'fix(dates): a same-day range counts zero business days',
  ],
  'hs-b': [
    'fix(catalog): round sale prices to whole cents',
    'fix(catalog): clamp the sale percent to 0-90',
    'fix(catalog): round sale prices half away from zero',
    'fix(catalog): never price a product below one cent',
    'fix(catalog): a sale runs through its last day',
  ],
  'hs-c': [
    'fix(customers): trim each name part in displayName',
    'fix(customers): no trailing space without a last name',
    'fix(customers): collapse repeated spaces inside names',
    'fix(customers): fall back to the email when both names are empty',
    'fix(customers): capitalise name parts in displayName',
  ],
};

/**
 * The window's events in order. `when` limits an event to fixtures seeding that defect; `hot`
 * marks the slots of the five hotspot fixes (used only by a fixture with a hotspot).
 */
const WINDOW_EVENTS = [
  { flag: 'emailValidation', message: 'feat(customers): validate email addresses on registration' },
  { flag: 'history', message: (f) => (f.has('ue-b') ? 'feat(orders): paginated order history, cancellation window, CSV export' : 'feat(orders): paginated order history and a 24h cancellation window') },
  { hot: 1 },
  { flag: 'regions', message: (f) => (f.has('ue-c') ? 'feat(shipping): regional shipping rates and a feature-flag helper' : 'feat(shipping): regional shipping rates') },
  { flag: 'surcharges', when: 'cx-a', message: 'feat(shipping): oversize, small-order and weight-tier surcharges' },
  { hot: 2 },
  { flag: 'tax', message: 'feat(pricing): tax rates per destination region' },
  { flag: 'tiers', when: 'cx-b', message: 'feat(pricing): VIP, bulk and welcome coupon rules' },
  { flag: 'taxBreakdown', message: (f) => (f.has('ue-a') ? 'feat(invoices): tax per invoice line and legacy invoice numbers' : 'feat(invoices): tax per invoice line') },
  { hot: 3 },
  { flag: 'confirmation', message: 'feat(notify): order confirmation email' },
  { flag: 'throttle', when: 'cx-c', message: 'fix(notify): back off on throttling, retry soft bounces' },
  { hot: 4 },
  { flag: 'sales', message: 'refactor(catalog): one sale-window check for prices' },
  { flag: 'dupCheck', message: (f) => (f.has('ct-b') ? 'feat(customers): reject duplicate registrations; repo lookups throw NotFoundError' : 'feat(customers): reject duplicate registrations') },
  { hot: 5 },
  { flag: 'apiTotals', message: 'feat(api): tell clients whether an order can still be cancelled' },
];

const WINDOW_START = Date.parse('2026-09-22T08:30:00Z');
const WINDOW_STEP_MS = 5 * 3600 * 1000;

function windowEventsOf(fx) {
  const f = new Set(fx.defects);
  const hotspot = fx.defects.find((d) => d.startsWith('hs-')) ?? null;
  const events = [];
  for (const e of WINDOW_EVENTS) {
    if (e.hot !== undefined) {
      if (hotspot !== null) events.push({ fix: e.hot, message: HOTSPOT_MESSAGES[hotspot][e.hot - 1] });
      continue;
    }
    if (e.when !== undefined && !f.has(e.when)) continue;
    events.push({ flag: e.flag, message: typeof e.message === 'function' ? e.message(f) : e.message });
  }
  return events.map((e, i) => ({ ...e, date: new Date(WINDOW_START + i * WINDOW_STEP_MS).toISOString().replace('.000Z', 'Z') }));
}

// ─── Earlier window reviews ──────────────────────────────────────────────────

/** 1-based line of the first line of `file` holding `needle` (in `files`); throws when absent. */
function lineOf(files, file, needle) {
  const i = files[file].split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`lineOf: ${JSON.stringify(needle)} not in ${file}`);
  return i + 1;
}

function finding(id, title, ref, issue, fix, guard) {
  return [`### ${id}: ${title}`, '', `**File:** \`${ref}\``, `**Issue:** ${issue}`, `**Fix:** ${fix}`, `guarded by: ${guard}`, ''];
}

const RECURRING = {
  'rc-a': {
    file: 'src/http/routes.ts', needle: 'function parseItems',
    first: ['Order quantities are taken from the request body unchecked', '`parseItems` passes `Number(entry.quantity)` through, so 0, negative and fractional quantities reach pricing.', 'Reject quantities that are not whole numbers from 1 to 99 with a 400.'],
    second: ['Order quantity still accepted without validation', 'Negative and fractional quantities from `POST /orders` still go straight into the order lines (raised in the previous window review).', 'Validate the quantity in `parseItems`; add a test so this stops coming back.'],
  },
  'rc-b': {
    file: 'src/orders/repo.ts', needle: 'listByCustomer(customerId',
    first: ['`listByCustomer` hands out the repository\'s internal array', 'Callers receive the stored array itself; sorting or splicing it changes the repository state.', 'Return a copy.'],
    second: ['Internal order list still returned by reference', '`listByCustomer` still returns the array kept in `byCustomer` (raised in the previous window review).', 'Return a copy, and cover it with a test.'],
  },
  'rc-c': {
    file: 'src/invoices/render.ts', needle: 'const name =',
    first: ['Customer name interpolated into invoice HTML unescaped', 'The display name goes into `<p>Billed to …</p>` as is; a name containing markup is injected into the invoice.', 'Escape the name before interpolating it.'],
    second: ['Invoice HTML still embeds the customer name unescaped', 'The billed-to line still interpolates `displayName(customer)` raw (raised in the previous window review).', 'Escape it, and add a test with markup in the name.'],
  },
};

/** The two earlier window reviews (path → text), from the files at the window's base. */
function earlierReviews(fx, baseFiles) {
  const rc = fx.defects.find((d) => d.startsWith('rc-')) ?? null;
  const r = rc === null ? null : RECURRING[rc];
  const ref = (file, needle) => `${file}:${lineOf(baseFiles, file, needle)}`;
  const first = [
    '# Window review 2026-09-08',
    '',
    '_Window: 2026-09-01..2026-09-08 · lenses: correctness, standards, simplify, spec_',
    '',
    '## Correctness',
    '',
    ...finding('WR-01', 'Cancelling an order does not check whether it shipped', ref('src/orders/service.ts', 'cancel(id: string'),
      '`cancel` overwrote the status without looking at it, so a shipped order could be cancelled.', 'Cancel only orders that are still `placed`.', 'review only'),
    ...finding('WR-02', 'Customer email compared case-sensitively', ref('src/customers/service.ts', 'register(input'),
      'Two registrations differing only in letter case created two customers.', 'Lower-case the email before saving.', 'test tests/customers.test.ts'),
    ...(r === null ? [] : finding('WR-03', r.first[0], ref(r.file, r.needle), r.first[1], r.first[2], 'review only')),
    '## Standards',
    '',
    ...finding('IN-01', 'Shipping base price is a magic number', ref('src/shipping/rates.ts', 'export function shippingCost'),
      'The base shipping price was an inline literal.', 'Name it.', 'review only'),
  ];
  const second = [
    '# Window review 2026-09-15',
    '',
    '_Window: 2026-09-08..2026-09-15 · lenses: correctness, standards, simplify, spec_',
    '',
    '## Correctness',
    '',
    ...finding('WR-01', 'formatMoney drops the sign of negative amounts', ref('src/util/money.ts', 'export function formatMoney'),
      'Refund lines rendered as positive amounts.', 'Keep the sign.', 'review only'),
    ...(r === null ? [] : finding('WR-02', r.second[0], ref(r.file, r.needle), r.second[1], r.second[2], 'review only')),
    '## Standards',
    '',
    ...finding('IN-01', 'Coupon table is untyped', ref('src/orders/pricing.ts', 'const COUPONS'),
      'The coupon table was inferred as a literal type, so lookups by an arbitrary code did not type-check.', 'Type it as `Record<string, number>`.', 'tsc --strict'),
  ];
  return {
    '.planning/reviews/2026-09-08-window/REVIEW.md': first.join('\n').replace(/\n+$/, '') + '\n',
    '.planning/reviews/2026-09-15-window/REVIEW.md': second.join('\n').replace(/\n+$/, '') + '\n',
  };
}

// ─── Ground truth ────────────────────────────────────────────────────────────

const DEFECT_SPEC = {
  'cx-a': { class: 'complexity', files: ['src/shipping/rates.ts'], minFiles: 1, symbol: 'shippingCost',
    description: 'shippingCost grew region, weight, oversize, small-order and weight-tier branches over two window commits; one function now holds every pricing rule' },
  'cx-b': { class: 'complexity', files: ['src/orders/pricing.ts'], minFiles: 1, symbol: 'applyDiscounts',
    description: 'applyDiscounts grew nested VIP-year, bulk-tier and welcome branches plus a cap in one window commit' },
  'cx-c': { class: 'complexity', files: ['src/notify/email.ts'], minFiles: 1, symbol: 'sendWithRetry',
    description: 'sendWithRetry grew a branch per transport result (rejected, throttled with backoff, soft bounce on/after the last attempt) over two window commits' },
  'ue-a': { class: 'unused_export', files: ['src/invoices/render.ts'], minFiles: 1, symbol: 'legacyInvoiceNumber',
    description: 'legacyInvoiceNumber is exported in the window and imported by nothing' },
  'ue-b': { class: 'unused_export', files: ['src/orders/service.ts'], minFiles: 1, symbol: 'ordersToCsv',
    description: 'ordersToCsv is exported in the window and imported by nothing' },
  'ue-c': { class: 'unused_export', files: ['src/config.ts'], minFiles: 1, symbol: 'featureEnabled',
    description: 'featureEnabled (and its flag set) is exported in the window and used by nothing' },
  'hs-a': { class: 'hotspot', files: ['src/util/dates.ts'], minFiles: 1, symbol: 'businessDaysBetween',
    description: 'util/dates.ts was patched by five fix commits of businessDaysBetween in one window: unstable logic with no test pinning it' },
  'hs-b': { class: 'hotspot', files: ['src/catalog/products.ts'], minFiles: 1, symbol: 'priceFor',
    description: 'catalog/products.ts was patched by five fix commits of the sale-price computation in one window: unstable logic with no test pinning it' },
  'hs-c': { class: 'hotspot', files: ['src/customers/service.ts'], minFiles: 1, symbol: 'displayName',
    description: 'customers/service.ts was patched by five fix commits of displayName in one window: unstable logic with no test pinning it' },
  'rc-a': { class: 'recurring', files: ['src/http/routes.ts'], minFiles: 1, symbol: 'parseItems',
    description: 'order quantities are still not validated in parseItems, raised as review-only in both earlier window reviews; the window touched the file again without fixing or guarding it' },
  'rc-b': { class: 'recurring', files: ['src/orders/repo.ts'], minFiles: 1, symbol: 'listByCustomer',
    description: 'listByCustomer still returns the internal array, raised as review-only in both earlier window reviews; the window touched the file again without fixing or guarding it' },
  'rc-c': { class: 'recurring', files: ['src/invoices/render.ts'], minFiles: 1, symbol: 'renderInvoice',
    description: 'the customer name is still interpolated into invoice HTML unescaped, raised as review-only in both earlier window reviews; the window touched the file again without fixing or guarding it' },
  'lg-a': { class: 'logic', files: ['src/orders/repo.ts'], minFiles: 1, symbol: 'page',
    description: 'page() is documented 1-based but starts at pageNumber * size, so page 1 skips the first page of orders' },
  'lg-b': { class: 'logic', files: ['src/shipping/rates.ts'], minFiles: 1, symbol: 'shippingCost',
    description: 'free shipping changed from >= to > FREE_SHIPPING_MIN_CENTS, contrary to the comment: an order of exactly the minimum pays shipping' },
  'lg-c': { class: 'logic', files: ['src/catalog/products.ts'], minFiles: 1, symbol: 'onSale',
    description: 'onSale compares now > saleEndsAt: the sale price applies after the sale ended and not while it runs' },
  'dp-a': { class: 'duplicate', files: ['src/customers/service.ts', 'src/notify/email.ts'], minFiles: 2, symbol: 'isValidEmail',
    description: 'email validation is implemented twice in the window, with different patterns: isValidEmail in customers/service and looksLikeEmail in notify/email' },
  'dp-b': { class: 'duplicate', files: ['src/orders/pricing.ts', 'src/invoices/render.ts'], minFiles: 2, symbol: 'taxFor',
    description: 'tax is computed twice in the window: taxFor in orders/pricing (eu 20%, rounded) and lineTax in invoices/render (eu 21%, floored)' },
  'dp-c': { class: 'duplicate', files: ['src/orders/service.ts', 'src/http/routes.ts'], minFiles: 2, symbol: 'canCancel',
    description: 'the cancellation rule is implemented twice in the window: canCancel in orders/service (24 h) and an inline check in the history route (48 h)' },
  'ct-a': { class: 'contract', files: ['src/notify/email.ts', 'src/util/money.ts'], minFiles: 1, symbol: 'orderConfirmation',
    description: 'orderConfirmation passes dollars (totalCents / 100) to formatMoney, whose contract is integer cents: the mail shows a total 100 times too small' },
  'ct-b': { class: 'contract', files: ['src/customers/repo.ts', 'src/customers/service.ts', 'src/http/routes.ts'], minFiles: 1, symbol: 'findById',
    description: 'CustomerRepo.findById now throws NotFoundError while its doc, CustomerService.find (Customer | null) and the routes still expect null: an unknown customer becomes a 404 or an uncaught error instead of a 400/409' },
  'ct-c': { class: 'contract', files: ['src/orders/service.ts', 'src/shipping/rates.ts'], minFiles: 1, symbol: 'shippingCost',
    description: 'OrderService.place passes the weight in kilograms to shippingCost, whose contract is grams: shipping is priced as if every parcel weighed under a kilogram' },
};

const CATEGORY = { complexity: 'flagged', unused_export: 'flagged', hotspot: 'flagged', recurring: 'flagged', logic: 'unflagged', duplicate: 'unflagged', contract: 'unflagged' };

function defectsOf(fx) {
  return fx.defects.map((id) => {
    const s = DEFECT_SPEC[id];
    return { key: `${fx.id}:${s.class}`, class: s.class, category: CATEGORY[s.class], variant: id, files: s.files, minFiles: s.minFiles, symbol: s.symbol, description: s.description };
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
    cwd, env: { ...process.env, ...GIT_ENV, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

function writeTree(repo, files) {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
}

function commit(repo, message, date) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
}

function buildRepo(fx, repo) {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '--initial-branch=main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.planning/\nnode_modules/\n');
  const s = { fixes: 0 };
  for (const h of BASE_HISTORY) {
    if (h.flag !== null) s[h.flag] = true;
    writeTree(repo, filesAt(fx, s));
    commit(repo, h.message, h.date);
  }
  const baseFiles = filesAt(fx, s);
  const base = git(repo, ['rev-parse', 'HEAD']).trim();
  const events = windowEventsOf(fx);
  for (const e of events) {
    if (e.fix !== undefined) s.fixes = e.fix;
    else s[e.flag] = true;
    writeTree(repo, filesAt(fx, s));
    commit(repo, e.message, e.date);
  }
  const tip = git(repo, ['rev-parse', 'HEAD']).trim();
  const reviews = earlierReviews(fx, baseFiles);
  writeTree(repo, { '.planning/config.json': '{}\n', ...reviews });
  return { base, tip, commits: events.length, files: filesAt(fx, s), reviews };
}

function runPrepass(repo, base) {
  const out = execFileSync(process.execPath, [GSD_TOOLS, 'review', 'window-prepass', '--since', base, '--until', 'HEAD', '--date', PREPASS_DATE], {
    cwd: repo, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  }).trim();
  const stdout = out.startsWith('@file:') ? fs.readFileSync(out.slice('@file:'.length), 'utf8') : out;
  const cli = JSON.parse(stdout);
  const file = fs.readFileSync(path.join(repo, cli.prepass), 'utf8');
  return { cli: stdout, path: cli.prepass, prepass: JSON.parse(file), text: file };
}

// ─── Self-check ──────────────────────────────────────────────────────────────

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

function checkFixture(fx, prepass, defects) {
  const fail = (msg) => {
    throw new Error(`${fx.id}: self-check failed — ${msg}`);
  };
  const want = (cls) => defects.filter((x) => x.class === cls);
  for (const c of prepass.classes) if (c.status !== 'checked') fail(`class ${c.class} ${c.status} (${c.reason})`);
  const rises = prepass.complexity.rises.map((r) => `${r.file}::${r.name}`);
  const seededRises = want('complexity').map((x) => `${x.files[0]}::${x.symbol}`);
  if (!sameSet(rises, seededRises)) fail(`complexity rises ${JSON.stringify(prepass.complexity.rises.map((r) => [r.file, r.name, r.base, r.tip]))} vs ${JSON.stringify(seededRises)}`);
  const exportsFound = prepass.exports.map((e) => `${e.file}::${e.name}::${e.change}`);
  const seededExports = want('unused_export').map((x) => `${x.files[0]}::${x.symbol}::new`);
  if (!sameSet(exportsFound, seededExports)) fail(`exports ${JSON.stringify(exportsFound)} vs ${JSON.stringify(seededExports)}`);
  const hotspots = want('hotspot').map((x) => x.files[0]);
  const heavy = prepass.churn.filter((c) => c.commits >= 5).map((c) => c.file);
  if (!sameSet(heavy, hotspots)) fail(`files with >=5 commits ${JSON.stringify(heavy)} vs ${JSON.stringify(hotspots)}`);
  const crowded = prepass.churn.filter((c) => c.commits >= 4 && !hotspots.includes(c.file));
  if (crowded.length > 0) fail(`non-hotspot files with >=4 commits ${JSON.stringify(crowded)}`);
  const recurring = prepass.reviewOnly.recurring.map((r) => r.file);
  if (!sameSet(recurring, want('recurring').map((x) => x.files[0]))) fail(`recurring ${JSON.stringify(recurring)}`);
  if (prepass.reviewOnly.reviewsRead.length !== 2) fail(`reviews read ${JSON.stringify(prepass.reviewOnly.reviewsRead)}`);
}

// ─── Reports ─────────────────────────────────────────────────────────────────

/** The shipped PREPASS_BRIEF: step 2's node snippet of window-scope.md, run on the CLI's output. */
function prepassBriefSnippet() {
  const text = fs.readFileSync(WINDOW_SCOPE, 'utf8');
  const m = /PREPASS_BRIEF=\$\(printf '%s' "\$PREPASS_JSON" \| node -e "([\s\S]*?)" "\$PREPASS_PATH"\)/.exec(text);
  if (m === null) throw new Error(`no PREPASS_BRIEF snippet in ${WINDOW_SCOPE}`);
  // Inside bash double quotes these would be expanded or unescaped; the snippet has to be free of them.
  if (/[$`]|\\["\\$`]/.test(m[1])) throw new Error('PREPASS_BRIEF snippet uses shell-sensitive characters; extend the unquoting');
  return m[1];
}

function runBrief(snippet, repo, run) {
  return execFileSync(process.execPath, ['-e', snippet, run.path], { cwd: repo, input: run.cli, encoding: 'utf8' });
}

function buildReports(repo, built, run, brief) {
  const short = (sha) => sha.slice(0, 7);
  const log = git(repo, ['log', '--no-color', '--stat=120', '--format=commit %h%n%s%n', `${built.base}..${built.tip}`]).replace(/\n+$/, '');
  const diff = git(repo, ['diff', '--no-color', built.base, built.tip, '--', 'src']).replace(/\n+$/, '');
  const sources = Object.keys(built.files).sort();
  const window = [
    `Window review over ${short(built.base)}..${short(built.tip)}, ${built.commits} commits`,
    '',
    '## Commits in the window',
    '',
    '```text',
    log,
    '```',
    '',
    '## Earlier window reviews',
    '',
    ...Object.entries(built.reviews).flatMap(([p, t]) => [`### ${p}`, '', '````markdown', t.replace(/\n+$/, ''), '````', '']),
    '## Cumulative diff (src/)',
    '',
    '```diff',
    diff,
    '```',
    '',
    '## Source at the tip',
    '',
    ...sources.map((f) => `### ${f}\n\n\`\`\`ts\n${built.files[f].replace(/\n+$/, '')}\n\`\`\`\n`),
  ].join('\n');
  const json = ['```json', run.text.replace(/\n+$/, ''), '```'].join('\n');
  const heading = `## Pre-pass (${run.path})`;
  return {
    A: window,
    C: [heading, '', json, '', window].join('\n'),
    Cp: [heading, '', '<window_prepass>', brief.replace(/\n+$/, ''), '</window_prepass>', '', json, '', window].join('\n'),
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function generate(outDir) {
  const snippet = prepassBriefSnippet();
  const truth = { mode: 'window', generated_by: 'scripts/experiments/report-ab/fixtures-window.cjs', prepass_date: PREPASS_DATE, fixtures: {}, report_sha256: {} };
  const briefs = {};
  for (const fx of FIXTURES) {
    const repo = path.join(outDir, 'repos', fx.id);
    const built = buildRepo(fx, repo);
    const run = runPrepass(repo, built.base);
    const defects = defectsOf(fx);
    checkFixture(fx, run.prepass, defects);
    const brief = runBrief(snippet, repo, run);
    briefs[fx.id] = brief;
    const reports = buildReports(repo, built, run, brief);
    const reportDir = path.join(outDir, 'reports', fx.id);
    fs.mkdirSync(reportDir, { recursive: true });
    for (const v of VARIANTS) {
      fs.writeFileSync(path.join(reportDir, `${v}.md`), reports[v]);
      truth.report_sha256[`${fx.id}/${v}`] = crypto.createHash('sha256').update(reports[v]).digest('hex');
    }
    truth.fixtures[fx.id] = {
      control: defects.length === 0,
      base: built.base,
      tip: built.tip,
      commits: built.commits,
      files: Object.keys(built.files).sort(),
      defects,
    };
  }
  fs.writeFileSync(path.join(outDir, 'ground-truth.json'), JSON.stringify(truth, null, 2) + '\n');
  return { truth, briefs };
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const outDir = path.resolve(i > -1 ? argv[i + 1] : path.join(__dirname, 'out-window'));
  const { truth } = generate(outDir);
  for (const [id, fx] of Object.entries(truth.fixtures)) {
    const sizes = VARIANTS.map((v) => `${v} ${(fs.statSync(path.join(outDir, 'reports', id, `${v}.md`)).size / 1024).toFixed(1)}KB`).join(' ');
    process.stdout.write(`${id} ${fx.control ? 'control' : fx.defects.map((x) => x.variant).join(',')} commits=${fx.commits} files=${fx.files.length} ${sizes}\n`);
  }
}

module.exports = { generate, FIXTURES, VARIANTS, DEFECT_SPEC };
