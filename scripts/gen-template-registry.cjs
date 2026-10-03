#!/usr/bin/env node
'use strict';

/**
 * gen-template-registry.cjs — compiles the `gsd-template:` block declared by
 * every shipped template under gsd-core/templates/ into two committed
 * artifacts: docs/TEMPLATE-REGISTRY.json (the manifest, and `--check`'s
 * comparison target) and the delimited Template Index region of
 * gsd-core/templates/README.md.
 *
 * Usage:
 *   node scripts/gen-template-registry.cjs                      # print the manifest to stdout
 *   node scripts/gen-template-registry.cjs --write              # write both artifacts
 *   node scripts/gen-template-registry.cjs --check              # exit 1 if a committed artifact is stale
 *   node scripts/gen-template-registry.cjs --check --json       # same, + typed report on stdout
 *   node scripts/gen-template-registry.cjs --write \
 *     --templates-dir <p> --manifest-path <p> --readme-path <p> # override the three hardcoded
 *                                                               # repo-root paths (tests use this
 *                                                               # to point the real CLI at a temp
 *                                                               # fixture tree, with no fs
 *                                                               # monkeypatching required)
 *
 * The authored contract this implements is docs/reference/template-registry.md.
 * Where this script and that document disagree, this script is the defect.
 *
 * ── Why no `.cts` module is emitted (D-74) ──
 *
 * The reference generator (scripts/gen-feature-vocabulary.cjs) emits BOTH a JSON
 * manifest and a typed `src/*.cts` module, because it has a runtime consumer:
 * `allowedValues` imports the vocabulary. This registry has none, and emitting
 * one anyway would ship dead code plus a second artifact to keep in sync.
 *
 * Measured (D-72): nothing in `src/`, `gsd-core/bin/` or `bin/` opens a template
 * file at runtime. Templates are consumed by AGENTS reading them as text through
 * `@` references. The nearest-looking candidate, `CANONICAL_EXACT` in
 * src/artifacts.cts, is a DIFFERENT SET — it enumerates `.planning/` root
 * artifact filenames for `isCanonicalPlanningFile`, and 7 of its 13 members have
 * no template file at all. Generating it from template frontmatter would delete
 * those 7 entries and silently un-protect real planning state (see
 * docs/reference/template-registry.md, "What the three registries actually are").
 *
 * If a consumer ever appears, the `.cts` emission shape is already proven by
 * gen-feature-vocabulary.cjs and is a small addition, not a redesign. Do not
 * re-litigate this without a consumer in hand.
 *
 * ── Every parse failure is loud (T-04.1-06) ──
 *
 * A missing block, a block merged into artifact frontmatter, an unknown key, an
 * omitted key, an out-of-vocabulary value, and an empty templates directory are
 * ALL hard errors. None of them degrade to an empty registry, because an empty
 * registry means "no templates found", which is indistinguishable from "the walk
 * broke".
 *
 * ── Injection (T-04.1-05) ──
 *
 * Field values are constrained by a closed key set and a closed value grammar
 * (`readers` entries match /^[a-z][a-z0-9:._-]*$/), and every emitted JSON string
 * goes through JSON.stringify, so no template content can close a literal. The
 * markdown table additionally escapes `|`, which is the only character able to
 * break out of a table cell.
 *
 * `--check --json` (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test
 * Outputs"): emits `{ ok, reason, count, offendingPath, offendingKey,
 * fixCommand }` — `reason` is always one of the frozen `REASON` values (exported
 * below) so tests assert `report.reason === REASON.FAIL_X` instead of
 * regex-matching the prose the non-JSON mode still prints for human operators.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATES_DIR = path.join(ROOT, 'gsd-core', 'templates');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'TEMPLATE-REGISTRY.json');
const README_PATH = path.join(TEMPLATES_DIR, 'README.md');

const OPEN_MARKER = '<!-- gsd:template-registry -->';
const CLOSE_MARKER = '<!-- /gsd:template-registry -->';

const FIX_COMMAND = 'node scripts/gen-template-registry.cjs --write';

/**
 * README.md is this generator's OUTPUT, not one of its inputs. It carries no
 * `gsd-template:` block and must not be demanded to.
 */
const EXCLUDED_BASENAMES = new Set(['README.md']);

// ─── The closed key set and value grammar (docs/reference/template-registry.md) ─

/** Exactly five keys, in the order the emitted table's columns take. */
const KEY_ORDER = Object.freeze(['level', 'lifecycle', 'required', 'author', 'readers']);

const CLOSED_VALUES = Object.freeze({
  level: Object.freeze(['project', 'milestone', 'phase', 'host']),
  lifecycle: Object.freeze(['active', 'deprecated', 'experimental']),
  author: Object.freeze(['agent', 'human', 'generated']),
});

/** A reader is an agent or workflow identifier. Closed shape, open membership. */
const READER_PATTERN = /^[a-z][a-z0-9:._-]*$/;

// ─── Typed reason enum (CONTRIBUTING.md "Prohibited: Raw Text Matching") ──────

/**
 * Stable reason codes for `checkReport`'s `reason` field and for the `code`
 * carried by `RegistryError`. Tests assert via
 * `assert.equal(report.reason, REASON.X)` rather than regex-matching the
 * human-readable prose the non-JSON modes still write to stdout/stderr.
 *
 * Adding a new reason requires updating this map AND the tests' shape assertion
 * that locks the documented set of codes (`Object.keys(REASON).sort()`).
 */
const REASON = Object.freeze({
  OK_UP_TO_DATE: 'ok_up_to_date',
  OK_TEMPLATES_ABSENT: 'ok_templates_absent',
  FAIL_STALE_MANIFEST: 'fail_stale_manifest',
  FAIL_STALE_README: 'fail_stale_readme',
  FAIL_MANIFEST_MISSING: 'fail_manifest_missing',
  FAIL_MANIFEST_UNPARSEABLE: 'fail_manifest_unparseable',
  FAIL_README_MISSING: 'fail_readme_missing',
  FAIL_README_MARKERS_MISSING: 'fail_readme_markers_missing',
  FAIL_README_MARKERS_INVERTED: 'fail_readme_markers_inverted',
  FAIL_TEMPLATES_UNREADABLE: 'fail_templates_unreadable',
  FAIL_BLOCK_MISSING: 'fail_block_missing',
  FAIL_BLOCK_MALFORMED: 'fail_block_malformed',
  FAIL_BLOCK_IN_ARTIFACT_BLOCK: 'fail_block_in_artifact_block',
  FAIL_UNKNOWN_KEY: 'fail_unknown_key',
  FAIL_MISSING_KEY: 'fail_missing_key',
});

/**
 * A parse failure carrying a typed `code` from `REASON`, plus the offending path
 * and key as DATA. Extends ExitError so `runMain` already knows how to render
 * it, while `checkReport` reads the structured fields instead of re-deriving the
 * failure from prose.
 */
class RegistryError extends ExitError {
  constructor(code, message, { offendingPath = null, offendingKey = null } = {}) {
    super(1, message);
    this.name = 'RegistryError';
    this.reason = code;
    this.offendingPath = offendingPath;
    this.offendingKey = offendingKey;
  }
}

// ─── Walking ─────────────────────────────────────────────────────────────────

/**
 * Collect every `.md` file under `dir`, recursively, as POSIX paths relative to
 * `dir`.
 *
 * The result is SORTED with an explicit comparator. `readdirSync` order is
 * filesystem-dependent and must never reach the emitted artifacts — that is
 * criterion 2. Recursion is not optional either: `codebase/`, `host/` and
 * `research-project/` hold 16 of the 44 shipped templates, and a one-level glob
 * is exactly the miscount that produced the stale "32" figure.
 *
 * @param {string} dir
 * @returns {string[]} relative POSIX paths, sorted.
 */
function walkTemplates(dir) {
  const found = [];

  const visit = (absDir, relDir) => {
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      throw new RegistryError(
        REASON.FAIL_TEMPLATES_UNREADABLE,
        `Cannot read template directory ${absDir}: ${err && err.message}\n`,
      );
    }
    // Sort the directory listing itself so recursion order is deterministic
    // too, not merely the final array.
    const names = entries.map((e) => e.name).sort(compareStrings);
    const byName = new Map(entries.map((e) => [e.name, e]));

    for (const name of names) {
      const entry = byName.get(name);
      const abs = path.join(absDir, name);
      const rel = relDir === '' ? name : `${relDir}/${name}`;
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (entry.isFile() && name.endsWith('.md') && !EXCLUDED_BASENAMES.has(name)) {
        found.push(rel);
      }
    }
  };

  visit(dir, '');
  found.sort(compareStrings);
  return found;
}

/**
 * Explicit lexicographic comparator. `Array.prototype.sort`'s default coerces to
 * string and compares by UTF-16 code unit, which is what we want — but stating
 * it makes the determinism guarantee readable rather than incidental.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Frontmatter block scanning ──────────────────────────────────────────────

/**
 * Split a markdown file into its leading FILE-LEVEL `---` blocks.
 *
 * "File-level" is the load-bearing qualifier. Twelve of the shipped templates
 * teach an artifact's frontmatter by showing it INSIDE a fenced code block:
 *
 *     ```markdown
 *     ---
 *     phase: {N}
 *     ---
 *     ```
 *
 * A scanner that matched `---` anywhere would read that fenced content as
 * template metadata. So fenced regions are tracked and skipped, and scanning
 * stops at the first non-blank line that is neither a fence nor a block opener —
 * the blocks this generator cares about are all at the head of the file.
 *
 * @param {string} text
 * @returns {Array<{ lines: string[] }>} the leading file-level blocks, in order.
 */
function scanLeadingBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') {
      i++;
      continue;
    }

    // A fence at the head of the file means the artifact frontmatter it may
    // contain is NOT file-level. Stop: any registry block would have preceded
    // it (shapes B and C both place the block at byte 0).
    if (/^\s*(```|~~~)/.test(line)) break;

    if (line === '---') {
      const body = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (lines[j] === '---') {
          closed = true;
          break;
        }
        body.push(lines[j]);
        j++;
      }
      if (!closed) break;
      blocks.push({ lines: body });
      i = j + 1;
      continue;
    }

    break;
  }

  return blocks;
}

/**
 * The top-level keys declared by a frontmatter block's lines.
 *
 * Only column-0 `key:` lines count as top-level; indented lines are the nested
 * fields of whichever key preceded them. Comment lines are ignored, which is why
 * the spec's mandatory two-line ignore-comment can head the block without
 * appearing as a key.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function topLevelKeys(lines) {
  const keys = [];
  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const match = /^([A-Za-z0-9_-]+)\s*:/.exec(line);
    if (match !== null) keys.push(match[1]);
  }
  return keys;
}

// ─── Parsing one template ────────────────────────────────────────────────────

/**
 * Parse the `gsd-template:` block out of one template's text.
 *
 * The placement rule, per docs/reference/template-registry.md: the registry
 * block is the file-level `---` block whose SOLE top-level key is
 * `gsd-template:`. It is identified by that key, never by ordinal position —
 * a position-keyed parser would mis-read the 28 shape-C files, where the block
 * is first, or the 4 shape-A files, where it is second.
 *
 * Finding `gsd-template` inside a block that ALSO carries artifact keys is
 * `FAIL_BLOCK_IN_ARTIFACT_BLOCK` — a hard error, never a tolerated merge. That
 * failure mode is the whole reason the separate-block rule exists (D-71): the
 * byte-0 block in VALIDATION.md, SECURITY.md and UI-SPEC.md is a TEMPLATE OF
 * OUTPUT whose keys agents copy into produced artifacts, so a merged
 * `gsd-template:` would be stamped onto real planning state in every project,
 * forever.
 *
 * @param {string} text - the template's full contents.
 * @param {string} relPath - repo-relative POSIX path, for error attribution.
 * @returns {{ path: string, level: string, lifecycle: string, required: boolean, author: string, readers: string[] }}
 */
function parseTemplate(text, relPath) {
  const blocks = scanLeadingBlocks(text);

  let registryBlock = null;
  for (const block of blocks) {
    const keys = topLevelKeys(block.lines);
    if (!keys.includes('gsd-template')) continue;

    if (keys.length !== 1) {
      throw new RegistryError(
        REASON.FAIL_BLOCK_IN_ARTIFACT_BLOCK,
        `${relPath}: \`gsd-template:\` is merged into a block that also carries ` +
        `${keys.filter((k) => k !== 'gsd-template').map((k) => `\`${k}\``).join(', ')}.\n` +
        'The registry block must be a SEPARATE frontmatter block whose only top-level key is\n' +
        '`gsd-template:`. Merging it into an artifact-frontmatter block makes every agent that\n' +
        'reproduces that frontmatter stamp `gsd-template:` onto real planning state.\n' +
        'See docs/reference/template-registry.md, "The placement rule".\n',
        { offendingPath: relPath },
      );
    }

    registryBlock = block;
    break;
  }

  if (registryBlock === null) {
    throw new RegistryError(
      REASON.FAIL_BLOCK_MISSING,
      `${relPath}: no \`gsd-template:\` registry block.\n` +
      'Every shipped template must declare one — a frontmatter block whose only top-level key\n' +
      'is `gsd-template:`, placed as the first file-level block that is not artifact frontmatter.\n' +
      'See docs/reference/template-registry.md.\n',
      { offendingPath: relPath },
    );
  }

  return { path: relPath, ...parseFields(registryBlock.lines, relPath) };
}

/**
 * Parse the five nested fields under `gsd-template:`.
 *
 * Hand-written, because zero runtime dependencies is a hard constraint and the
 * grammar is closed and one level deep. Anything the grammar does not accept is
 * an error — a shallow parser that shrugs at what it does not recognise is how a
 * typo becomes a silently-absent field.
 *
 * @param {string[]} lines - the block's body lines.
 * @param {string} relPath
 * @returns {{ level: string, lifecycle: string, required: boolean, author: string, readers: string[] }}
 */
function parseFields(lines, relPath) {
  const raw = new Map();
  let inside = false;

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (!/^\s/.test(line)) {
      inside = /^gsd-template\s*:/.test(line);
      continue;
    }
    if (!inside) continue;

    const match = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      throw new RegistryError(
        REASON.FAIL_BLOCK_MALFORMED,
        `${relPath}: unparseable line in the \`gsd-template:\` block: ${JSON.stringify(line)}\n` +
        'Each field must have the shape `  key: value`.\n',
        { offendingPath: relPath },
      );
    }

    const key = match[1];
    if (!KEY_ORDER.includes(key)) {
      throw new RegistryError(
        REASON.FAIL_UNKNOWN_KEY,
        `${relPath}: unknown key \`${key}\` under \`gsd-template:\`.\n` +
        `The key set is CLOSED: ${KEY_ORDER.join(', ')}. An unknown key is an authoring error,\n` +
        'not a silently-carried extra field. See docs/reference/template-registry.md.\n',
        { offendingPath: relPath, offendingKey: key },
      );
    }
    if (raw.has(key)) {
      throw new RegistryError(
        REASON.FAIL_BLOCK_MALFORMED,
        `${relPath}: key \`${key}\` is declared more than once under \`gsd-template:\`.\n`,
        { offendingPath: relPath, offendingKey: key },
      );
    }
    raw.set(key, match[2].trim());
  }

  for (const key of KEY_ORDER) {
    if (!raw.has(key)) {
      throw new RegistryError(
        REASON.FAIL_MISSING_KEY,
        `${relPath}: \`gsd-template:\` is missing the required key \`${key}\`.\n` +
        `All five keys are required: ${KEY_ORDER.join(', ')}. Omitting one is as much an\n` +
        'authoring error as inventing one — there is no default and no null.\n',
        { offendingPath: relPath, offendingKey: key },
      );
    }
  }

  const fields = {};
  for (const key of KEY_ORDER) {
    fields[key] = parseValue(key, raw.get(key), relPath);
  }
  return fields;
}

/**
 * Coerce and validate one field value against the closed grammar.
 *
 * @param {string} key
 * @param {string} rawValue
 * @param {string} relPath
 * @returns {string|boolean|string[]}
 */
function parseValue(key, rawValue, relPath) {
  if (key === 'required') {
    // A genuine boolean, not the string "true" — stated in the spec because a
    // stringly-typed flag is the kind of thing a downstream reader tests for
    // truthiness and gets wrong for "false".
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    throw new RegistryError(
      REASON.FAIL_BLOCK_MALFORMED,
      `${relPath}: \`required\` must be the boolean \`true\` or \`false\`, got ${JSON.stringify(rawValue)}.\n`,
      { offendingPath: relPath, offendingKey: key },
    );
  }

  if (key === 'readers') {
    const match = /^\[(.*)\]$/.exec(rawValue);
    if (match === null) {
      throw new RegistryError(
        REASON.FAIL_BLOCK_MALFORMED,
        `${relPath}: \`readers\` must be a YAML flow sequence like \`[gsd-planner, gsd-executor]\`, ` +
        `got ${JSON.stringify(rawValue)}.\n`,
        { offendingPath: relPath, offendingKey: key },
      );
    }
    const inner = match[1].trim();
    if (inner === '') return [];
    const readers = inner.split(',').map((s) => s.trim());
    for (const reader of readers) {
      if (!READER_PATTERN.test(reader)) {
        throw new RegistryError(
          REASON.FAIL_BLOCK_MALFORMED,
          `${relPath}: illegal reader identifier ${JSON.stringify(reader)} in \`readers\`.\n` +
          `A reader must match ${READER_PATTERN}.\n`,
          { offendingPath: relPath, offendingKey: key },
        );
      }
    }
    return readers;
  }

  const allowed = CLOSED_VALUES[key];
  if (!allowed.includes(rawValue)) {
    throw new RegistryError(
      REASON.FAIL_BLOCK_MALFORMED,
      `${relPath}: \`${key}\` must be one of ${allowed.join(' · ')}, got ${JSON.stringify(rawValue)}.\n`,
      { offendingPath: relPath, offendingKey: key },
    );
  }
  return rawValue;
}

// ─── Building the registry ───────────────────────────────────────────────────

/**
 * Build the registry from a templates directory.
 *
 * An EMPTY result is never returned. A directory with no templates raises
 * FAIL_BLOCK_MISSING, because "zero templates declared a block" and "the walk
 * broke" would otherwise be the same observation (T-04.1-06).
 *
 * @param {string} [templatesDir]
 * @returns {{ templates: object[], count: number }}
 */
function buildRegistry(templatesDir = TEMPLATES_DIR) {
  const relPaths = walkTemplates(templatesDir);

  if (relPaths.length === 0) {
    throw new RegistryError(
      REASON.FAIL_BLOCK_MISSING,
      `No \`.md\` templates found under ${templatesDir}.\n` +
      'An empty registry is never a legal result: "no templates" and "the walk broke" would be\n' +
      'indistinguishable. Check the path.\n',
    );
  }

  const templates = relPaths.map((rel) => {
    const abs = path.join(templatesDir, ...rel.split('/'));
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      throw new RegistryError(
        REASON.FAIL_TEMPLATES_UNREADABLE,
        `Cannot read ${rel}: ${err && err.message}\n`,
        { offendingPath: rel },
      );
    }
    return parseTemplate(text, rel);
  });

  // Already sorted by `walkTemplates`; re-stated so the guarantee survives any
  // future change to the walk.
  templates.sort((a, b) => compareStrings(a.path, b.path));

  return { templates, count: templates.length };
}

// ─── Serialization ───────────────────────────────────────────────────────────

/**
 * Serialize the registry to the committed plain-JSON manifest text. Plain JSON,
 * not a CommonJS module — mirroring docs/FEATURE-VOCABULARY.json and
 * docs/CONTEXT-INDEX.json: a committed, generated, `--check`-guarded manifest
 * that is NOT runtime code and is never scanned as such.
 *
 * @param {{ templates: object[], count: number }} registry
 * @returns {string}
 */
function serializeManifest(registry) {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

/**
 * Escape a value for a markdown table cell. `|` is the only character able to
 * break out of a cell; escaping it is the table-shaped half of T-04.1-05.
 *
 * @param {string} value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value).replace(/\|/g, '\\|');
}

/**
 * Render the README's Template Index region body — everything BETWEEN the
 * markers, markers excluded.
 *
 * Column order matches KEY_ORDER, which matches the spec's key order. Rows are
 * in the registry's sorted path order. Nothing here reads a clock or a random
 * source, so the region is a pure function of the parsed registry.
 *
 * @param {{ templates: object[], count: number }} registry
 * @returns {string}
 */
function renderReadmeRegion(registry) {
  const header = [
    '',
    '## Template Index',
    '',
    '> _This region is generated by `scripts/gen-template-registry.cjs` from the `gsd-template:` block in',
    '> each template file. Do not hand-edit it — run `npm run regen:derived` instead; edits between the',
    '> markers are overwritten and `npm run lint:generated-sync` will fail on drift._',
    '',
    `${registry.count} templates ship under \`gsd-core/templates/\`.`,
    '',
    '| Template | Level | Lifecycle | Required | Author | Readers |',
    '|----------|-------|-----------|----------|--------|---------|',
  ];

  const rows = registry.templates.map((t) => {
    const readers = t.readers.length === 0 ? '—' : t.readers.map((r) => `\`${escapeCell(r)}\``).join(', ');
    return `| \`${escapeCell(t.path)}\` | ${escapeCell(t.level)} | ${escapeCell(t.lifecycle)} | ` +
      `${t.required ? 'yes' : 'no'} | ${escapeCell(t.author)} | ${readers} |`;
  });

  return `${[...header, ...rows].join('\n')}\n\n`;
}

// ─── README region splicing ──────────────────────────────────────────────────

/**
 * Locate the marker pair in a README's text.
 *
 * Absent markers, inverted markers, and a SECOND marker pair are all hard
 * errors. A generator that appends when it cannot find its region is how a
 * hand-maintained file gets silently duplicated — and a second pair makes
 * "which region do I own?" unanswerable.
 *
 * @param {string} text
 * @param {string} relPath - for error attribution.
 * @returns {{ openAt: number, closeAt: number }}
 */
function locateRegion(text, relPath) {
  const openAt = text.indexOf(OPEN_MARKER);
  const closeAt = text.indexOf(CLOSE_MARKER);

  if (openAt === -1 || closeAt === -1) {
    const missing = [];
    if (openAt === -1) missing.push(OPEN_MARKER);
    if (closeAt === -1) missing.push(CLOSE_MARKER);
    throw new RegistryError(
      REASON.FAIL_README_MARKERS_MISSING,
      `${relPath} is missing the template-registry marker(s): ${missing.join(' and ')}\n` +
      'The generated region must be delimited by both marker comments, each on its own line.\n',
      { offendingPath: relPath },
    );
  }

  if (closeAt < openAt) {
    throw new RegistryError(
      REASON.FAIL_README_MARKERS_INVERTED,
      `${relPath} has ${CLOSE_MARKER} before ${OPEN_MARKER}.\n` +
      'The opening marker must precede the closing marker.\n',
      { offendingPath: relPath },
    );
  }

  if (text.indexOf(OPEN_MARKER, openAt + 1) !== -1 || text.indexOf(CLOSE_MARKER, closeAt + 1) !== -1) {
    throw new RegistryError(
      REASON.FAIL_README_MARKERS_MISSING,
      `${relPath} carries more than one template-registry marker pair.\n` +
      'Exactly one region can be owned by the generator; a second pair makes ownership ambiguous.\n',
      { offendingPath: relPath },
    );
  }

  return { openAt, closeAt };
}

/**
 * Replace strictly between the markers, preserving the markers themselves and
 * every byte outside them.
 *
 * @param {string} text
 * @param {string} region
 * @param {string} relPath
 * @returns {string}
 */
function spliceRegion(text, region, relPath) {
  const { openAt, closeAt } = locateRegion(text, relPath);
  return text.slice(0, openAt + OPEN_MARKER.length) + region + text.slice(closeAt);
}

/**
 * Read the region currently between the markers, CRLF-normalized so a CRLF
 * checkout is not misreported as drift.
 *
 * @param {string} text
 * @param {string} relPath
 * @returns {string}
 */
function extractRegion(text, relPath) {
  const normalized = text.replace(/\r\n/g, '\n');
  const { openAt, closeAt } = locateRegion(normalized, relPath);
  return normalized.slice(openAt + OPEN_MARKER.length, closeAt);
}

// ─── Typed check report ──────────────────────────────────────────────────────

/**
 * Compute the full `--check` result as a typed, non-throwing report — the
 * structured intermediate representation CONTRIBUTING.md's "Prohibited: Raw Text
 * Matching on Test Outputs" section requires alongside the human prose `main()`
 * still prints. Never throws; every failure mode is a `reason` code from the
 * frozen `REASON` enum, and the offending path/key travel as data.
 *
 * @param {{ templatesDir?: string, manifestPath?: string, readmePath?: string }} [opts]
 * @returns {{ ok: boolean, reason: string, count: number, offendingPath: string|null, offendingKey: string|null, fixCommand: string, message: string }}
 */
function checkReport(opts = {}) {
  const templatesDir = opts.templatesDir || TEMPLATES_DIR;
  const manifestPath = opts.manifestPath || MANIFEST_PATH;
  const readmePath = opts.readmePath || README_PATH;

  const base = { offendingPath: null, offendingKey: null, fixCommand: FIX_COMMAND };

  // ── The one tolerated absence, and why it is narrow (D-75) ──
  //
  // An ABSENT templates directory means there is nothing to verify against: the
  // committed manifest is the registry's only surviving definition in that tree,
  // and this check cannot second-guess it. Failing there would break a checkout
  // that legitimately lacks the source while proving nothing.
  //
  // The distinction that matters is preserved in the reason code: "absent,
  // nothing to verify" (ok_templates_absent) is NOT "the registry is empty" and
  // is NOT "the artifacts are stale". And it is tolerated ONLY in `--check` —
  // `--write` against an absent directory is still a hard error, so regenerating
  // can never silently produce an empty registry.
  if (!fs.existsSync(templatesDir)) {
    return {
      ok: true,
      reason: REASON.OK_TEMPLATES_ABSENT,
      count: 0,
      ...base,
      message: `${displayPath(templatesDir)} is absent — nothing to verify against; skipping the drift check.\n`,
    };
  }

  let live;
  try {
    live = buildRegistry(templatesDir);
  } catch (err) {
    if (err instanceof RegistryError) {
      return {
        ok: false,
        reason: err.reason,
        count: 0,
        ...base,
        offendingPath: err.offendingPath,
        offendingKey: err.offendingKey,
        message: err.message,
      };
    }
    throw err;
  }

  const withCount = { ...base, count: live.count };

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_MISSING,
      ...withCount,
      message: `${displayPath(manifestPath)} does not exist. Run:\n  ${FIX_COMMAND}\n`,
    };
  }

  let committed;
  try {
    committed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!committed || typeof committed !== 'object' || !Array.isArray(committed.templates)) {
      throw new Error('parsed JSON does not have the expected registry shape');
    }
  } catch (err) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_UNPARSEABLE,
      ...withCount,
      message: `${displayPath(manifestPath)} is unparseable: ${err && err.message}\n  Run: ${FIX_COMMAND}\n`,
    };
  }

  // Compared as PARSED JSON, which is CRLF-agnostic by construction.
  if (JSON.stringify(committed) !== JSON.stringify(live)) {
    return {
      ok: false,
      reason: REASON.FAIL_STALE_MANIFEST,
      ...withCount,
      message: `${displayPath(manifestPath)} is stale. Run:\n  ${FIX_COMMAND}\n`,
    };
  }

  if (!fs.existsSync(readmePath)) {
    return {
      ok: false,
      reason: REASON.FAIL_README_MISSING,
      ...withCount,
      message: `${displayPath(readmePath)} does not exist. Run:\n  ${FIX_COMMAND}\n`,
    };
  }

  const readmeRel = displayPath(readmePath);
  let currentRegion;
  try {
    currentRegion = extractRegion(fs.readFileSync(readmePath, 'utf8'), readmeRel);
  } catch (err) {
    if (err instanceof RegistryError) {
      return {
        ok: false,
        reason: err.reason,
        ...withCount,
        offendingPath: err.offendingPath,
        message: err.message,
      };
    }
    throw err;
  }

  // The region is generated text, so it IS compared as text — but the extracted
  // side is CRLF-normalized, so a CRLF checkout is not reported as drift.
  if (currentRegion !== renderReadmeRegion(live)) {
    return {
      ok: false,
      reason: REASON.FAIL_STALE_README,
      ...withCount,
      message: `The template-registry region of ${readmeRel} is stale. Run:\n  ${FIX_COMMAND}\n`,
    };
  }

  return {
    ok: true,
    reason: REASON.OK_UP_TO_DATE,
    ...withCount,
    message: `${displayPath(manifestPath)} and the ${readmeRel} registry region are up to date ` +
      `(${live.count} templates).\n`,
  };
}

/**
 * Render a path for human messages: repo-relative when it is inside the repo,
 * absolute otherwise (a temp fixture tree). Never emitted into an artifact —
 * absolute paths must not reach generated output.
 *
 * @param {string} target
 * @returns {string}
 */
function displayPath(target) {
  const rel = path.relative(ROOT, target);
  return rel.startsWith('..') ? target : rel;
}

// ─── Argument parsing ────────────────────────────────────────────────────────

const PATH_FLAGS = Object.freeze({
  '--templates-dir': 'templatesDir',
  '--manifest-path': 'manifestPath',
  '--readme-path': 'readmePath',
});

/**
 * True when `value` cannot be accepted as a path argument: absent, empty, or
 * flag-shaped (so a dangling `--templates-dir` immediately followed by the NEXT
 * flag is rejected rather than silently swallowing it as a literal path).
 *
 * @param {string|undefined} value
 * @returns {boolean}
 */
function isMissingPathValue(value) {
  return value === undefined || value === '' || value.startsWith('-');
}

/**
 * Parse CLI arguments into a structured options object.
 *
 * `--check` and `--write` together collapse into `mode: 'unknown'` — the same
 * clean usage-error path an unrecognized flag takes. Letting the last flag win
 * would make `--check --write` exit 0 while REWRITING the artifacts it was meant
 * to gate, which is the gate silently disarming itself.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ mode: 'check'|'write'|'default'|'unknown', json: boolean, templatesDir: string, manifestPath: string, readmePath: string, unknownArg?: string, usageMessage?: string }}
 */
function parseArgs(argv) {
  const opts = {
    mode: 'default',
    json: false,
    templatesDir: TEMPLATES_DIR,
    manifestPath: MANIFEST_PATH,
    readmePath: README_PATH,
  };
  let sawCheck = false;
  let sawWrite = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') {
      sawCheck = true;
      opts.mode = 'check';
    } else if (arg === '--write') {
      sawWrite = true;
      opts.mode = 'write';
    } else if (arg === '--json') {
      opts.json = true;
    } else if (Object.prototype.hasOwnProperty.call(PATH_FLAGS, arg)) {
      const value = argv[i + 1];
      if (isMissingPathValue(value)) {
        return {
          ...opts,
          mode: 'unknown',
          unknownArg: arg,
          usageMessage: `${arg} requires a non-empty path argument (got ${value === undefined ? 'nothing' : JSON.stringify(value)})`,
        };
      }
      i++;
      opts[PATH_FLAGS[arg]] = path.resolve(value);
    } else {
      opts.mode = 'unknown';
      opts.unknownArg = arg;
    }
  }

  if (sawCheck && sawWrite) {
    return { ...opts, mode: 'unknown', usageMessage: '--check and --write are mutually exclusive' };
  }

  return opts;
}

// ─── Main ────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'unknown') {
    process.stderr.write(
      'Usage: gen-template-registry.cjs [--write|--check] [--json] ' +
      '[--templates-dir <path>] [--manifest-path <path>] [--readme-path <path>]\n',
    );
    if (opts.usageMessage) process.stderr.write(`${opts.usageMessage}\n`);
    throw new ExitError(1);
  }

  if (opts.mode === 'default') {
    process.stdout.write(serializeManifest(buildRegistry(opts.templatesDir)));
    return;
  }

  if (opts.mode === 'check') {
    const report = checkReport(opts);

    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ok: report.ok,
        reason: report.reason,
        count: report.count,
        offendingPath: report.offendingPath,
        offendingKey: report.offendingKey,
        fixCommand: report.fixCommand,
      })}\n`);
    } else if (report.ok) {
      process.stdout.write(report.message);
    }

    if (!report.ok) {
      // JSON mode already carries the structured report on stdout — do not
      // duplicate the prose onto stderr, but the exit code must still be 1.
      throw new ExitError(1, opts.json ? undefined : report.message);
    }
    return;
  }

  // opts.mode === 'write'. Both artifacts are rendered BEFORE either is written,
  // so a malformed README marker pair cannot leave a written manifest paired
  // with an unwritten region.
  const registry = buildRegistry(opts.templatesDir);
  const manifestText = serializeManifest(registry);

  const readmeRel = displayPath(opts.readmePath);
  let readmeText;
  try {
    readmeText = fs.readFileSync(opts.readmePath, 'utf8');
  } catch (err) {
    throw new RegistryError(
      REASON.FAIL_README_MISSING,
      `Cannot read ${readmeRel}: ${err && err.message}\n`,
      { offendingPath: readmeRel },
    );
  }
  const nextReadme = spliceRegion(readmeText, renderReadmeRegion(registry), readmeRel);

  fs.mkdirSync(path.dirname(opts.manifestPath), { recursive: true });
  fs.writeFileSync(opts.manifestPath, manifestText, 'utf8');
  fs.writeFileSync(opts.readmePath, nextReadme, 'utf8');

  process.stdout.write(
    `Wrote ${displayPath(opts.manifestPath)} and the ${readmeRel} registry region\n` +
    `  ${registry.count} template${registry.count !== 1 ? 's' : ''}\n`,
  );
}

// ─── Exports (for tests) ─────────────────────────────────────────────────────

module.exports = {
  walkTemplates,
  scanLeadingBlocks,
  topLevelKeys,
  parseTemplate,
  parseFields,
  buildRegistry,
  serializeManifest,
  renderReadmeRegion,
  locateRegion,
  spliceRegion,
  extractRegion,
  checkReport,
  parseArgs,
  RegistryError,
  REASON,
  KEY_ORDER,
  CLOSED_VALUES,
  OPEN_MARKER,
  CLOSE_MARKER,
  FIX_COMMAND,
  TEMPLATES_DIR,
  MANIFEST_PATH,
  README_PATH,
};

// ─── CLI entry point ─────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
