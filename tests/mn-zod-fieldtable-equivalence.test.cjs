'use strict';

/**
 * TRANSITIONAL — deleted together with
 * capabilities/mn-verify-gate/scripts/zod-fieldtable.mjs.
 *
 * Runs the legacy script (under bun, as its fragment did) and
 * `gsd-tools mn zod-fieldtable` on the same TypeScript schema module and
 * asserts they agree wherever the two are meant to agree:
 *
 *   - the field table (heading, marker, every row, the summary line) and the
 *     enum value set: byte for byte;
 *   - the erDiagram of a schema the script could draw correctly (a REQUIRED
 *     nested object, at most ten attributes per child): the same entities,
 *     attributes and relationships once parsed back into a model.
 *
 * Deliberate differences, not compared here and pinned in
 * tests/mn-zod-fieldtable.test.cjs instead: an optional child is `zero-or-one`
 * (the script drew every child `||--||`); a child keeps all its attributes
 * (the script cut at ten); arrays of objects and `$defs` become entities; an
 * attribute type keeps `enum(3)` instead of `enum_3_`.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const LEGACY = path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'scripts', 'zod-fieldtable.mjs');

let zodDir = null;
try {
  zodDir = path.dirname(require.resolve('zod/package.json'));
} catch {
  zodDir = null;
}

/** Field-table part of a document: every line before the first fence. */
function tablePart(markdown) {
  const lines = markdown.trim().split('\n');
  const end = lines.indexOf('```mermaid');
  return end === -1 ? lines : lines.slice(0, end).filter((l, i, a) => !(i === a.length - 1 && l === ''));
}

/** The erDiagram parsed into { entities: {id: ['type name', …]}, relationships: ['L R label'] }. */
function parseEr(markdown) {
  const lines = markdown.split('\n');
  const start = lines.indexOf('```mermaid');
  if (start === -1) return null;
  const entities = {};
  const relationships = [];
  let current = null;
  const norm = (t) => t.replace(/[^A-Za-z0-9]/g, '_');
  for (const line of lines.slice(start + 2)) {
    if (line === '```') break;
    let m;
    if ((m = line.match(/^\s+(\w+) \{$/))) {
      current = m[1];
      entities[current] = [];
    } else if (/^\s+\}$/.test(line)) {
      current = null;
    } else if (current !== null && (m = line.match(/^\s+(\S+) (\w+)/))) {
      entities[current].push(`${norm(m[1])} ${m[2]}`);
    } else if ((m = line.match(/^\s+(\w+) \S+ (\w+) : "?([^"]+)"?$/))) {
      relationships.push(`${m[1]} ${m[2]} ${m[3]}`);
    }
  }
  return { entities, relationships };
}

describe('zod-fieldtable: legacy script ↔ gsd-tools mn zod-fieldtable', () => {
  let project;
  beforeEach(() => {
    project = createTempProject('gsd-mn-zod-eq-');
  });
  afterEach(() => cleanup(project));

  const fixture = () => {
    fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });
    fs.symlinkSync(zodDir, path.join(project, 'node_modules', 'zod'), 'dir');
    fs.writeFileSync(
      path.join(project, 'entry.dto.ts'),
      [
        "import { z } from 'zod';",
        'export const entryDto = z.object({',
        '  title: z.string().min(1).max(300),',
        '  email: z.email().optional(),',
        "  mood: z.enum(['low', 'mid', 'high']),",
        "  cuisine: z.enum(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).optional(),",
        '  rating: z.number().int().min(1).max(5).default(3),',
        '  count: z.number().int(),',
        '  tags: z.array(z.string()).max(10).optional(),',
        '  place: z.object({ name: z.string(), lat: z.number(), lng: z.number() }),',
        '});',
        "export const moodSchema = z.enum(['low', 'mid', 'high']);",
        '',
      ].join('\n'),
    );
  };

  const legacy = (exportName) => {
    const r = runHook(LEGACY, ['--file', 'entry.dto.ts', '--export', exportName], { interpreter: 'bun', cwd: project, timeoutMs: PROBE_TIMEOUT_MS });
    return r;
  };
  const current = (exportName) => {
    const r = runGsdTools(['mn', 'zod-fieldtable', '--file', 'entry.dto.ts', '--export', exportName, '--raw'], project);
    assert.equal(r.success, true, r.error);
    return r.output;
  };

  test('same field table and same erDiagram model for an object schema', { skip: zodDir === null && 'zod is not resolvable in this checkout' }, (t) => {
    fixture();
    const old = legacy('entryDto');
    if (old.outcome === OUTCOME.SPAWN_FAILED) {
      t.skip('bun is not installed');
      return;
    }
    assert.equal(old.outcome, OUTCOME.EXITED);
    assert.equal(old.exitCode, 0, old.stderr);
    const now = current('entryDto');
    assert.equal(tablePart(now).length, 16, 'heading, blank, marker, blank, header, rule, 8 rows, blank, summary');
    assert.deepEqual(tablePart(now), tablePart(old.stdout));
    const er = parseEr(now);
    assert.deepEqual(er.relationships, ['entry Place place']);
    assert.equal(er.entities.Place.length, 3);
    assert.deepEqual(er, parseEr(old.stdout));
  });

  test('same value set for an enum schema', { skip: zodDir === null && 'zod is not resolvable in this checkout' }, (t) => {
    fixture();
    const old = legacy('moodSchema');
    if (old.outcome === OUTCOME.SPAWN_FAILED) {
      t.skip('bun is not installed');
      return;
    }
    assert.equal(old.exitCode, 0, old.stderr);
    assert.equal(current('moodSchema').trim(), old.stdout.trim());
  });
});
