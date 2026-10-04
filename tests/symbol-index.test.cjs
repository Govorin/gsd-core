'use strict';

/**
 * Unit tests for symbol-index.cjs (built from src/symbol-index.cts) — the
 * declaration recognizer behind `diagrams check` (phase 5.7).
 *
 * The properties pinned here are the ones a diagram check leans on:
 *   - a declaration of each supported shape is found, with its kind, owner and line;
 *   - a name inside a comment, string, template literal or regex declares nothing;
 *   - `absent` only when nothing in the tree spells the name — a mention, an
 *     unsupported language or a file over the size limit makes it `ambiguous`;
 *   - the file set honours `.gitignore`; the size limit is exact at its boundary.
 *
 * Fixtures are real files in a temp git project; assertions read the typed
 * index and lookup results.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempGitProject, createTempDir, cleanup } = require('./helpers.cjs');
const si = require('../gsd-core/bin/lib/symbol-index.cjs');

function write(root, rel, text) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** `kind[:owner]@line` of every declaration of `name`, sorted. */
function declsOf(index, name) {
  return (index.decls.get(name) ?? []).map((d) => `${d.kind}${d.owner ? `:${d.owner}` : ''}@${d.file}:${d.line}`).sort();
}

describe('symbol-index: declarations by language', () => {
  let root;
  beforeEach(() => {
    root = createTempGitProject('gsd-symidx-');
  });
  afterEach(() => {
    cleanup(root);
  });

  test('TypeScript/JavaScript: classes with heritage, members, types, enums, functions, schemas, tables, exports', () => {
    write(root, 'src/thing.ts', [
      'export interface IThingRepository extends Base {',
      '  findById(id: string): Promise<Thing | null>;',
      '  readonly size: number;',
      '}',
      'export abstract class DrizzleThingRepository extends Store<T> implements IThingRepository {',
      '  private db = 1;',
      '  async findById(id: string) { if (id) { return 1; } }',
      '  handle = () => {};',
      '}',
      'export type Kind = "a" | "b";',
      'export const enum OrderStatus { Pending = "pending" }',
      'export async function createThing() {}',
      'export const update = async (x) => x;',
      "export const users = pgTable('app_users', {",
      "  id: serial('id').primaryKey(),",
      "  createdAt: timestamp('created_at'),",
      '});',
      'export const CreateThingDto = z.object({ name: z.string() });',
      "export { Foo as Bar, Baz } from './foo';",
    ].join('\n'));
    write(root, 'lib/legacy.cjs', 'exports.legacyHelper = () => 1;\nmodule.exports = { other, named: 2 };\n');
    const index = si.buildSymbolIndex(root);
    assert.deepEqual(declsOf(index, 'IThingRepository'), ['interface@src/thing.ts:1']);
    assert.deepEqual(index.decls.get('DrizzleThingRepository')[0].heritage, ['Store', 'T', 'IThingRepository']);
    assert.deepEqual(index.decls.get('IThingRepository')[0].heritage, ['Base']);
    assert.deepEqual(declsOf(index, 'findById'), ['method:DrizzleThingRepository@src/thing.ts:7', 'method:IThingRepository@src/thing.ts:2']);
    assert.deepEqual(declsOf(index, 'size'), ['field:IThingRepository@src/thing.ts:3']);
    assert.deepEqual(declsOf(index, 'handle'), ['field:DrizzleThingRepository@src/thing.ts:8']);
    assert.deepEqual(declsOf(index, 'Kind'), ['type@src/thing.ts:10']);
    assert.deepEqual(declsOf(index, 'OrderStatus'), ['enum@src/thing.ts:11']);
    assert.deepEqual(declsOf(index, 'createThing'), ['function@src/thing.ts:12']);
    assert.deepEqual(declsOf(index, 'update'), ['function@src/thing.ts:13']);
    assert.deepEqual(declsOf(index, 'users'), ['table@src/thing.ts:14']);
    assert.deepEqual(declsOf(index, 'app_users'), ['table@src/thing.ts:14']);
    assert.deepEqual(declsOf(index, 'created_at'), ['field:app_users@src/thing.ts:16', 'field:users@src/thing.ts:16']);
    assert.deepEqual(declsOf(index, 'createdAt'), ['field:app_users@src/thing.ts:16', 'field:users@src/thing.ts:16']);
    assert.deepEqual(declsOf(index, 'CreateThingDto'), ['schema@src/thing.ts:18']);
    assert.deepEqual(declsOf(index, 'name'), ['field:CreateThingDto@src/thing.ts:18']);
    assert.deepEqual(declsOf(index, 'Bar'), ['export@src/thing.ts:19']);
    assert.deepEqual(declsOf(index, 'Baz'), ['export@src/thing.ts:19']);
    assert.deepEqual(declsOf(index, 'legacyHelper'), ['export@lib/legacy.cjs:1']);
    assert.deepEqual(declsOf(index, 'named'), ['export@lib/legacy.cjs:2']);
    assert.deepEqual(declsOf(index, 'thing'), ['module@src/thing.ts:1'], 'a file is a module named after its basename');
  });

  test('a name in a comment, string, template literal or regex declares nothing and is not even a mention', () => {
    write(root, 'src/noise.ts', [
      '// class InLineComment {}',
      '/* interface InBlockComment {} */',
      'const a = "class InDouble {}";',
      "const b = 'class InSingle {}';",
      'const c = `interface InTemplate ${1 + 2} { } class AlsoInTemplate {}`;',
      'const d = /class InRegex/;',
      "const e = x / 2 + '/ LeakyIfDivisionMisread';",
      'export class RealOne {}',
    ].join('\n'));
    const index = si.buildSymbolIndex(root);
    for (const name of ['InLineComment', 'InBlockComment', 'InDouble', 'InSingle', 'InTemplate', 'AlsoInTemplate', 'InRegex', 'LeakyIfDivisionMisread']) {
      assert.deepEqual(si.lookup(index, name), { verdict: 'absent' }, name);
    }
    assert.equal(si.lookup(index, 'RealOne', { kinds: ['class'] }).verdict, 'declared');
  });

  test('Python: classes with bases, methods, fields, functions, SQLAlchemy tables; docstrings declare nothing', () => {
    write(root, 'app/svc.py', [
      'class ThingService(BaseService, Mixin):',
      '    """class NotReal: a docstring"""',
      '    name: str = "x"',
      "    __tablename__ = 'things'",
      '    def create(self, dto):',
      '        def inner():',
      '            pass',
      '    async def remove(self):',
      '        pass',
      '# def commented(): pass',
      'def helper():',
      '    pass',
      "orders = Table('orders', meta)",
    ].join('\n'));
    const index = si.buildSymbolIndex(root);
    assert.deepEqual(index.decls.get('ThingService')[0].heritage, ['BaseService', 'Mixin']);
    assert.deepEqual(declsOf(index, 'create'), ['method:ThingService@app/svc.py:5']);
    assert.deepEqual(declsOf(index, 'remove'), ['method:ThingService@app/svc.py:8']);
    assert.deepEqual(declsOf(index, 'inner'), [], 'a nested def is not a method of the class');
    assert.deepEqual(declsOf(index, 'name'), ['field:ThingService@app/svc.py:3']);
    assert.deepEqual(declsOf(index, 'things'), ['table@app/svc.py:4']);
    assert.deepEqual(declsOf(index, 'helper'), ['function@app/svc.py:11']);
    assert.deepEqual(declsOf(index, 'orders'), ['table@app/svc.py:13', 'table@app/svc.py:13']);
    assert.equal(si.lookup(index, 'NotReal').verdict, 'absent');
    assert.equal(si.lookup(index, 'commented').verdict, 'absent');
  });

  test('Go: structs and their fields, interfaces and their methods, receiver methods, functions, const groups', () => {
    write(root, 'pkg/repo.go', [
      'package pkg',
      'type Repo struct {',
      '\tID, Name string `json:"id"`',
      '\tBase',
      '}',
      'type Store interface {',
      '\tGet(id string) error',
      '}',
      'type Status string',
      'const (',
      '\tActive Status = "active"',
      ')',
      'func (r *Repo) Save() error { return nil }',
      'func NewRepo() *Repo { return nil }',
    ].join('\n'));
    const index = si.buildSymbolIndex(root);
    assert.deepEqual(declsOf(index, 'Repo'), ['class@pkg/repo.go:2']);
    assert.deepEqual(declsOf(index, 'Name'), ['field:Repo@pkg/repo.go:3']);
    assert.deepEqual(declsOf(index, 'Base'), [], 'an embedded type is not a field');
    assert.deepEqual(declsOf(index, 'Get'), ['method:Store@pkg/repo.go:7']);
    assert.deepEqual(declsOf(index, 'Status'), ['type@pkg/repo.go:9']);
    assert.deepEqual(declsOf(index, 'Active'), ['const@pkg/repo.go:11']);
    assert.deepEqual(declsOf(index, 'Save'), ['method:Repo@pkg/repo.go:13']);
    assert.deepEqual(declsOf(index, 'NewRepo'), ['function@pkg/repo.go:14']);
  });

  test('Prisma models/enums with @@map, SQL CREATE TABLE with columns', () => {
    write(root, 'prisma/schema.prisma', [
      'model User {',
      '  id    Int    @id',
      '  email String // comment',
      '  @@map("app_user")',
      '}',
      'enum Role {',
      '  ADMIN',
      '}',
    ].join('\n'));
    write(root, 'db/001.sql', [
      '-- CREATE TABLE ghost (x int);',
      'CREATE TABLE IF NOT EXISTS public."orders" (',
      '  id serial PRIMARY KEY,',
      "  note text DEFAULT 'a, b',",
      '  CONSTRAINT fk FOREIGN KEY (id) REFERENCES x(id)',
      ');',
    ].join('\n'));
    const index = si.buildSymbolIndex(root);
    assert.deepEqual(declsOf(index, 'User'), ['table@prisma/schema.prisma:1']);
    assert.deepEqual(declsOf(index, 'email'), ['field:User@prisma/schema.prisma:3', 'field:app_user@prisma/schema.prisma:3']);
    assert.deepEqual(declsOf(index, 'app_user'), ['table@prisma/schema.prisma:4']);
    assert.deepEqual(declsOf(index, 'Role'), ['enum@prisma/schema.prisma:6']);
    assert.deepEqual(declsOf(index, 'orders'), ['table@db/001.sql:2']);
    assert.deepEqual(declsOf(index, 'note'), ['field:orders@db/001.sql:4']);
    assert.deepEqual(declsOf(index, 'CONSTRAINT'), []);
    assert.equal(si.lookup(index, 'ghost').verdict, 'absent', 'a SQL comment declares nothing');
  });
});

describe('symbol-index: lookup verdicts', () => {
  let root;
  beforeEach(() => {
    root = createTempGitProject('gsd-symidx-lookup-');
  });
  afterEach(() => {
    cleanup(root);
  });

  test('declared / ambiguous (other kind or owner, mention only, foreign language) / absent', () => {
    write(root, 'src/a.ts', 'export class Thing {\n  run() {}\n}\nexport function helper() {}\nuseIt(OnlyMentioned);\n');
    write(root, 'src/Legacy.java', 'public class LegacyThing {}\n');
    const index = si.buildSymbolIndex(root);
    assert.deepEqual(si.lookup(index, 'Thing', { kinds: ['class'] }), { verdict: 'declared', at: 'src/a.ts:1' });
    assert.equal(si.lookup(index, 'run', { kinds: ['method'], owners: ['Thing'] }).verdict, 'declared');
    const otherOwner = si.lookup(index, 'run', { kinds: ['method'], owners: ['Other'] });
    assert.equal(otherOwner.verdict, 'ambiguous');
    assert.equal(otherOwner.at, 'src/a.ts:2');
    assert.equal(si.lookup(index, 'helper', { kinds: ['class'] }).verdict, 'ambiguous', 'declared, but as another kind');
    assert.equal(si.lookup(index, 'OnlyMentioned').verdict, 'ambiguous');
    assert.equal(si.lookup(index, 'LegacyThing').verdict, 'ambiguous', 'an unsupported language never yields absent');
    assert.deepEqual(si.lookup(index, 'NowhereAtAll'), { verdict: 'absent' });
  });

  test('the file set honours .gitignore', () => {
    write(root, '.gitignore', 'dist/\n');
    write(root, 'dist/bundle.js', 'export class OnlyInBuildOutput {}\n');
    write(root, 'src/b.ts', 'export class Tracked {}\n');
    const index = si.buildSymbolIndex(root);
    assert.equal(si.lookup(index, 'Tracked').verdict, 'declared');
    assert.equal(si.lookup(index, 'OnlyInBuildOutput').verdict, 'absent');
  });

  test('size limit boundary: limit-1 and limit are lexed, limit+1 is skipped and can only be ambiguous', () => {
    const sized = (name, bytes) => {
      const head = `export class ${name} {}\n`;
      return head + ' '.repeat(bytes - Buffer.byteLength(head));
    };
    write(root, 'src/under.ts', sized('UnderLimit', si.MAX_FILE_BYTES - 1));
    write(root, 'src/at.ts', sized('AtLimit', si.MAX_FILE_BYTES));
    write(root, 'src/over.ts', sized('OverLimit', si.MAX_FILE_BYTES + 1));
    const index = si.buildSymbolIndex(root);
    assert.equal(si.lookup(index, 'UnderLimit').verdict, 'declared');
    assert.equal(si.lookup(index, 'AtLimit').verdict, 'declared');
    assert.deepEqual(index.skipped, [{ file: 'src/over.ts', reason: 'too_large' }]);
    assert.equal(si.lookup(index, 'OverLimit').verdict, 'ambiguous');
    assert.equal(si.lookup(index, 'NotInAnyFile').verdict, 'absent', 'a skipped file is searched, not presumed to hold everything');
  });

  test('loose spelling: USER ≈ users ≈ user_s, never equal to an exact match', () => {
    write(root, 'src/t.ts', "export const users = pgTable('users', {});\nexport interface UserAccount {}\n");
    const index = si.buildSymbolIndex(root);
    assert.deepEqual(si.looseMatches(index, 'USER', ['table']).map((d) => d.name), ['users']);
    assert.deepEqual(si.looseMatches(index, 'users', ['table']), [], 'an exact name is not a loose match');
    assert.deepEqual(si.looseMatches(index, 'user_accounts', ['interface']).map((d) => d.name), ['UserAccount']);
  });
});

describe('symbol-index: outside a git work tree', () => {
  let root;
  beforeEach(() => {
    root = createTempDir('gsd-symidx-walk-');
  });
  afterEach(() => {
    cleanup(root);
  });

  test('the walk skips dependency, build and planning directories', () => {
    write(root, 'src/a.ts', 'export class Kept {}\n');
    write(root, 'node_modules/x/index.js', 'export class FromDependency {}\n');
    write(root, '.planning/x.ts', 'export class FromPlanning {}\n');
    const index = si.buildSymbolIndex(root);
    assert.equal(si.lookup(index, 'Kept').verdict, 'declared');
    assert.equal(si.lookup(index, 'FromDependency').verdict, 'absent');
    assert.equal(si.lookup(index, 'FromPlanning').verdict, 'absent');
  });
});

describe('symbol-index: symbolMembers (%% gsd:source)', () => {
  let root;
  beforeEach(() => {
    root = createTempDir('gsd-symidx-members-');
  });
  afterEach(() => {
    cleanup(root);
  });

  test('enum, literal union, const object, z.enum, Python Enum, Prisma/SQL enum, Go typed constants', () => {
    write(root, 'a.ts', [
      "export enum OrderStatus { Pending = 'pending', Paid = 'paid' }",
      "export type Phase = 'draft'",
      "  | 'final';",
      "export const Level = { Low: 'low', High: 'high' } as const;",
      "export const Mode = z.enum(['fast', 'slow']);",
    ].join('\n'));
    write(root, 'b.py', 'class Color(Enum):\n    RED = "red"\n    BLUE = "blue"\n');
    write(root, 'c.prisma', 'enum Role {\n  ADMIN\n  USER\n}\n');
    write(root, 'd.sql', "CREATE TYPE mood AS ENUM ('sad', 'ok');\n");
    write(root, 'e.go', 'package e\nconst (\n\tOn Switch = "on"\n\tOff Switch = "off"\n)\n');
    const members = (file, sym) => si.symbolMembers(root, file, sym);
    assert.deepEqual(members('a.ts', 'OrderStatus'), { ok: true, members: ['Pending', 'pending', 'Paid', 'paid'], at: 'a.ts:1' });
    assert.deepEqual(members('a.ts', 'Phase').members, ['draft', 'final']);
    assert.deepEqual(members('a.ts', 'Level').members, ['Low', 'low', 'High', 'high']);
    assert.deepEqual(members('a.ts', 'Mode').members, ['fast', 'slow']);
    assert.deepEqual(members('b.py', 'Color').members, ['RED', 'red', 'BLUE', 'blue']);
    assert.deepEqual(members('c.prisma', 'Role').members, ['ADMIN', 'USER']);
    assert.deepEqual(members('d.sql', 'mood').members, ['sad', 'ok']);
    assert.deepEqual(members('e.go', 'Switch').members, ['On', 'on', 'Off', 'off']);
  });

  test('a missing file, a missing symbol and an unsupported language are distinct failures', () => {
    write(root, 'a.ts', 'export const x = 1;\n');
    write(root, 'a.rb', 'X = 1\n');
    assert.deepEqual(si.symbolMembers(root, 'nope.ts', 'X'), { ok: false, reason: 'file_missing' });
    assert.deepEqual(si.symbolMembers(root, 'a.ts', 'Ghost'), { ok: false, reason: 'symbol_absent' });
    assert.deepEqual(si.symbolMembers(root, 'a.rb', 'X'), { ok: false, reason: 'unsupported_language' });
  });
});
