#!/usr/bin/env node
'use strict';

/**
 * gen-feature-vocabulary.cjs — compiles the closed `feature:` vocabulary from
 * the `<!-- gsd:feature-vocabulary -->` block in .planning/ROADMAP.md into two
 * committed artifacts: docs/FEATURE-VOCABULARY.json (the manifest, and
 * `--check`'s comparison target) and src/feature-vocabulary.cts (the generated
 * TS module `allowedValues` consumes).
 *
 * Usage:
 *   node scripts/gen-feature-vocabulary.cjs                     # print the manifest to stdout
 *   node scripts/gen-feature-vocabulary.cjs --write             # write both artifacts
 *   node scripts/gen-feature-vocabulary.cjs --check             # exit 1 if a committed artifact is stale
 *   node scripts/gen-feature-vocabulary.cjs --check --json      # same, + typed report on stdout
 *   node scripts/gen-feature-vocabulary.cjs --write \
 *     --roadmap-path <p> --module-path <p> --manifest-path <p>  # override the three hardcoded
 *                                                               # repo-root paths (tests use this
 *                                                               # to point the real CLI at a temp
 *                                                               # fixture tree, with no fs
 *                                                               # monkeypatching required)
 *
 * ── Why a generator, and not a runtime read of ROADMAP.md (D-53) ──
 *
 * `frontmatter` is a member of `SKIP_ROOT_RESOLUTION` in
 * gsd-core/bin/gsd-tools.cjs — the set of commands that must work from ANY cwd,
 * including one with no `.planning/` directory at all, for which
 * `findProjectRoot` is deliberately never called. A runtime ROADMAP read inside
 * the validator would therefore either reverse that dispatch decision (changing
 * behaviour for `frontmatter get/set/merge` too), or fail to find ROADMAP.md and
 * fall back to an empty vocabulary — at which point EVERY `feature:` value
 * validates. That is a vocabulary degrading silently, which is the exact failure
 * this phase exists to prevent.
 *
 * So the list is compiled at build time. ROADMAP.md stays the single authored
 * definition, this script is the only thing that reads it, and `--check` in
 * `lint:generated-sync` makes drift a failing gate instead of a silent one. The
 * pattern is not new: gen-context-index.cjs already parses a repo-root markdown
 * file into a committed JSON manifest under exactly this contract.
 *
 * ── Every parse failure is loud (T-05-02) ──
 *
 * An absent block, an empty block, a malformed entry, a non-normalised token, and
 * a duplicate token are all hard errors. None of them degrade to `[]`, because an
 * empty allowed-set would silently accept every `feature:` value — the empty-set
 * and could-not-read cases must never be indistinguishable.
 *
 * ── Injection (T-05-01) ──
 *
 * Tokens are constrained to `[a-z][a-z0-9-]*` and every emitted string literal
 * goes through JSON.stringify, so no ROADMAP content can close a string literal
 * and inject code into the generated module.
 *
 * `--check --json` (CONTRIBUTING.md "Prohibited: Raw Text Matching on Test
 * Outputs"): emits `{ ok, reason, features, count }` — `reason` is always one of
 * the frozen `REASON` values (exported below) so tests assert
 * `report.reason === REASON.FAIL_X` instead of regex-matching the prose the
 * non-JSON mode still prints for human operators.
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const ROADMAP_PATH = path.join(ROOT, '.planning', 'ROADMAP.md');
const MODULE_PATH = path.join(ROOT, 'src', 'feature-vocabulary.cts');
const MANIFEST_PATH = path.join(ROOT, 'docs', 'FEATURE-VOCABULARY.json');

const OPEN_MARKER = '<!-- gsd:feature-vocabulary -->';
const CLOSE_MARKER = '<!-- /gsd:feature-vocabulary -->';

/**
 * The legal token shape. Lowercase, starting with a letter, then letters,
 * digits, and hyphens. The STORED form is the NORMALISED form, so a token that
 * needs normalisation to become legal is an authoring mistake in ROADMAP.md, not
 * something this script silently fixes — see `parseVocabularyBlock`.
 */
const TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/;

/** `- token — gloss`, with an em dash separating the two. */
const ENTRY_PATTERN = /^-\s+(\S+)\s+—\s+(.+)$/;

// ─── Typed reason enum (CONTRIBUTING.md "Prohibited: Raw Text Matching") ───────

/**
 * Stable reason codes for `checkReport`'s `reason` field, and for the `code`
 * carried by `VocabularyError`. Tests assert via
 * `assert.equal(report.reason, REASON.X)` rather than regex-matching the
 * human-readable prose the non-JSON modes still write to stdout/stderr, so the
 * diagnostic surface is a typed enum, not free text.
 *
 * Adding a new reason requires updating this map AND the tests' shape assertion
 * that locks the documented set of codes (`Object.keys(REASON).sort()`).
 */
const REASON = Object.freeze({
  OK_UP_TO_DATE: 'ok_up_to_date',
  OK_ROADMAP_ABSENT: 'ok_roadmap_absent',
  FAIL_STALE_MANIFEST: 'fail_stale_manifest',
  FAIL_STALE_MODULE: 'fail_stale_module',
  FAIL_MANIFEST_MISSING: 'fail_manifest_missing',
  FAIL_MANIFEST_UNPARSEABLE: 'fail_manifest_unparseable',
  FAIL_MODULE_MISSING: 'fail_module_missing',
  FAIL_ROADMAP_MISSING: 'fail_roadmap_missing',
  FAIL_ROADMAP_UNREADABLE: 'fail_roadmap_unreadable',
  FAIL_MARKERS_MISSING: 'fail_markers_missing',
  FAIL_MARKERS_INVERTED: 'fail_markers_inverted',
  FAIL_BLOCK_EMPTY: 'fail_block_empty',
  FAIL_ENTRY_MALFORMED: 'fail_entry_malformed',
  FAIL_TOKEN_NOT_NORMALIZED: 'fail_token_not_normalized',
  FAIL_DUPLICATE_TOKEN: 'fail_duplicate_token',
});

/**
 * A parse failure carrying a typed `code` from `REASON` alongside the human
 * message. Extends ExitError so `runMain` already knows how to render it, while
 * `checkReport` can read `.code` and report structurally instead of re-deriving
 * the failure from prose.
 */
class VocabularyError extends ExitError {
  constructor(code, message) {
    super(1, message);
    this.name = 'VocabularyError';
    this.reason = code;
  }
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Normalise a raw token exactly the way `normalizePlanStatus` does — `trim()`
 * then `toLowerCase()` and nothing else (D-51). Duplicated here, and ONLY here,
 * because this build-time script must run before `npm run build:lib` has
 * necessarily produced gsd-core/bin/lib/plan-status.cjs; the RUNTIME
 * normalisation in the generated module imports the shared function rather than
 * re-deriving it, which is where D-51's "same shape, in one place" requirement
 * actually binds.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeToken(raw) {
  return raw.trim().toLowerCase();
}

/**
 * Read a ROADMAP.md-shaped markdown file. Throws a typed VocabularyError naming
 * the path (never a bare stack trace) when it is missing or unreadable.
 *
 * @param {string} [roadmapPath] - defaults to the real repo-root .planning/ROADMAP.md.
 * @returns {string}
 */
function readRoadmapMarkdown(roadmapPath = ROADMAP_PATH) {
  try {
    return fs.readFileSync(roadmapPath, 'utf8');
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? REASON.FAIL_ROADMAP_MISSING : REASON.FAIL_ROADMAP_UNREADABLE;
    throw new VocabularyError(code, `Cannot read ${path.relative(ROOT, roadmapPath)}: ${err && err.message}`);
  }
}

/**
 * Extract the vocabulary entries from a ROADMAP.md-shaped markdown string.
 *
 * Every failure mode below is an error rather than a degraded result, because
 * the degraded result in each case is an empty vocabulary, and an empty
 * vocabulary makes every `feature:` value valid (T-05-02).
 *
 * @param {string} markdown
 * @returns {Array<{ token: string, gloss: string }>} sorted by token, deduplicated by construction.
 */
function parseVocabularyBlock(markdown) {
  const openAt = markdown.indexOf(OPEN_MARKER);
  const closeAt = markdown.indexOf(CLOSE_MARKER);

  if (openAt === -1 || closeAt === -1) {
    const missing = [];
    if (openAt === -1) missing.push(OPEN_MARKER);
    if (closeAt === -1) missing.push(CLOSE_MARKER);
    throw new VocabularyError(
      REASON.FAIL_MARKERS_MISSING,
      `ROADMAP.md is missing the feature-vocabulary marker(s): ${missing.join(' and ')}\n` +
      'The closed feature list must be delimited by both marker comments, each on its own line.\n',
    );
  }

  if (closeAt < openAt) {
    throw new VocabularyError(
      REASON.FAIL_MARKERS_INVERTED,
      `ROADMAP.md has ${CLOSE_MARKER} before ${OPEN_MARKER}.\n` +
      'The opening marker must precede the closing marker.\n',
    );
  }

  const body = markdown.slice(openAt + OPEN_MARKER.length, closeAt);
  const lines = body.split('\n').map((line) => line.trim()).filter((line) => line !== '');

  if (lines.length === 0) {
    throw new VocabularyError(
      REASON.FAIL_BLOCK_EMPTY,
      'The ROADMAP.md feature-vocabulary block contains zero entries.\n' +
      'An empty vocabulary would make EVERY `feature:` value valid, so this is an\n' +
      'error rather than an empty result. Author at least one `- token — gloss` entry.\n',
    );
  }

  const entries = [];
  const seen = new Map();

  for (const line of lines) {
    const match = ENTRY_PATTERN.exec(line);
    if (match === null) {
      throw new VocabularyError(
        REASON.FAIL_ENTRY_MALFORMED,
        `Malformed feature-vocabulary entry in ROADMAP.md: ${JSON.stringify(line)}\n` +
        'Each entry must have the shape `- token — gloss` (em dash between token and gloss).\n',
      );
    }

    const rawToken = match[1];
    const gloss = match[2].trim();
    const token = normalizeToken(rawToken);

    if (rawToken !== token || !TOKEN_PATTERN.test(token)) {
      throw new VocabularyError(
        REASON.FAIL_TOKEN_NOT_NORMALIZED,
        `Illegal feature token in ROADMAP.md: ${JSON.stringify(rawToken)}\n` +
        'A token must already be lowercase and match /^[a-z][a-z0-9-]*$/. The stored form is\n' +
        'the normalised form, so a token needing normalisation to be legal is an authoring\n' +
        'mistake, not something this generator silently fixes.\n',
      );
    }

    if (seen.has(token)) {
      throw new VocabularyError(
        REASON.FAIL_DUPLICATE_TOKEN,
        `Duplicate feature token in ROADMAP.md: ${JSON.stringify(token)}\n` +
        'Each token must be declared exactly once.\n',
      );
    }

    seen.set(token, true);
    entries.push({ token, gloss });
  }

  // Sorted so the artifacts are a deterministic function of the block's CONTENT
  // and not of its authored order.
  entries.sort((a, b) => (a.token < b.token ? -1 : a.token > b.token ? 1 : 0));
  return entries;
}

/**
 * Build the vocabulary manifest object from the given ROADMAP.md-shaped file.
 *
 * @param {string} [roadmapPath] - defaults to the real repo-root .planning/ROADMAP.md.
 * @returns {{ features: string[], glosses: Record<string, string>, count: number }}
 */
function buildVocabulary(roadmapPath = ROADMAP_PATH) {
  const entries = parseVocabularyBlock(readRoadmapMarkdown(roadmapPath));
  const glosses = {};
  for (const { token, gloss } of entries) glosses[token] = gloss;
  return {
    features: entries.map((e) => e.token),
    glosses,
    count: entries.length,
  };
}

// ─── Serialization ────────────────────────────────────────────────────────────

/**
 * Serialize the vocabulary to the committed plain-JSON manifest text
 * (docs/FEATURE-VOCABULARY.json). Plain JSON — not a CommonJS module —
 * mirroring docs/CONTEXT-INDEX.json's precedent: a committed, generated,
 * `--check`-guarded manifest that is NOT runtime code and is never scanned as
 * such.
 *
 * @param {{ features: string[], glosses: Record<string, string>, count: number }} vocabulary
 * @returns {string}
 */
function serializeManifest(vocabulary) {
  return JSON.stringify(vocabulary, null, 2) + '\n';
}

/**
 * Serialize the vocabulary to the generated src/feature-vocabulary.cts module
 * text.
 *
 * `FEATURE_VALUES` is shaped EXACTLY like `PLAN_STATUSES` (src/plan-status.cts)
 * — a frozen `as const` tuple — so `allowedValues`'s existing
 * `Record<string, readonly string[]>` type consumes it in Plan 02 with no
 * widening. `isFeature` normalises via `normalizePlanStatus` imported from
 * `./plan-status.cjs`: importing the shared normaliser rather than re-deriving
 * trim+lowercase is D-51's "same shape, in one place" requirement, and it is
 * what keeps a second runtime normalisation from existing.
 *
 * Note the deliberate import direction — the GENERATED module imports the shared
 * normaliser; `plan-status.cts` is not touched and gains no knowledge of
 * features.
 *
 * Every interpolated string goes through JSON.stringify, so no ROADMAP content
 * can close a literal and inject code (T-05-01).
 *
 * @param {{ features: string[], glosses: Record<string, string> }} vocabulary
 * @returns {string}
 */
function serializeModule(vocabulary) {
  const glossLines = vocabulary.features.map(
    (token) => ` *   ${token} — ${vocabulary.glosses[token]}`,
  );
  const valueLines = vocabulary.features.map((token) => `  ${JSON.stringify(token)},`);

  return `/**
 * Feature Vocabulary — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Source of truth: the \`<!-- gsd:feature-vocabulary -->\` block in
 * .planning/ROADMAP.md.
 * Generator:       scripts/gen-feature-vocabulary.cjs
 *
 * Edit the ROADMAP block and re-run:
 *
 *     node scripts/gen-feature-vocabulary.cjs --write
 *
 * \`node scripts/gen-feature-vocabulary.cjs --check\`, wired into
 * \`npm run lint:generated-sync\`, fails when this file disagrees with that
 * block — so a hand edit here is caught by a gate, not by review.
 *
 * The vocabulary:
 *
${glossLines.join('\n')}
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import planStatus = require('./plan-status.cjs');

/**
 * The closed \`feature:\` vocabulary, sorted and deduplicated by the generator.
 *
 * Typed exactly like \`PLAN_STATUSES\` (src/plan-status.cts) — an \`as const\`
 * tuple — so \`allowedValues\`'s \`Record<string, readonly string[]>\` consumes it
 * with no widening and no new machinery.
 *
 * \`Object.freeze\` is applied ON TOP of \`as const\` deliberately. \`as const\`
 * is a COMPILE-TIME readonly marker only: tsc emits a plain mutable array, so
 * \`PLAN_STATUSES\` itself answers \`Object.isFrozen\` with \`false\` and can be
 * mutated by any JS caller that never sees the types. This vocabulary is a
 * security boundary — a pushed value would silently widen the allowed set — so
 * the runtime guarantee is made real rather than assumed from the type.
 */
const FEATURE_VALUES = Object.freeze([
${valueLines.join('\n')}
] as const);

type Feature = (typeof FEATURE_VALUES)[number];

/**
 * Type guard: is \`value\` a member of the closed vocabulary, after
 * normalisation?
 *
 * Normalisation is \`normalizePlanStatus\` — the SHARED \`trim()\` +
 * \`toLowerCase()\` from src/plan-status.cts, imported rather than re-derived
 * (D-51). A second copy here is exactly the drift this fork already paid for
 * once. \`normalizePlanStatus\` returns \`null\` for a non-string and for the
 * empty-after-trim string, both of which are non-members.
 */
function isFeature(value: unknown): value is Feature {
  const normalized = planStatus.normalizePlanStatus(value);
  if (normalized === null) return false;
  return (FEATURE_VALUES as readonly string[]).includes(normalized);
}

export = {
  FEATURE_VALUES,
  isFeature,
};
`;
}

// ─── Typed check report ───────────────────────────────────────────────────────

/**
 * Compute the full `--check` result as a typed, non-throwing report — the
 * structured intermediate representation CONTRIBUTING.md's "Prohibited: Raw Text
 * Matching on Test Outputs" section requires alongside the human prose `main()`
 * still prints. Never throws; every failure mode is a `reason` code from the
 * frozen `REASON` enum.
 *
 * @param {string} [roadmapPath]
 * @param {string} [manifestPath]
 * @param {string} [modulePath]
 * @returns {{ ok: boolean, reason: string, features: string[], count: number, message: string }}
 */
function checkReport(roadmapPath = ROADMAP_PATH, manifestPath = MANIFEST_PATH, modulePath = MODULE_PATH) {
  let live;
  try {
    live = buildVocabulary(roadmapPath);
  } catch (err) {
    if (err instanceof VocabularyError) {
      // ── The one tolerated absence, and why it is narrow ──
      //
      // The source of this vocabulary lives in .planning/ROADMAP.md, and
      // .planning/ is GITIGNORED. So a fresh clone — including every CI
      // checkout, which runs this via `lint:ci` → `lint:generated-sync` — has
      // the committed artifacts but not the file they were generated from.
      // Failing there would break CI on every PR while proving nothing: with no
      // ROADMAP to compare against, there is no drift to detect. The committed
      // docs/FEATURE-VOCABULARY.json is the vocabulary's only surviving
      // definition in that tree, and this check cannot second-guess it.
      //
      // This is deliberately the ONLY tolerated failure, and it is tolerated
      // ONLY in `--check`:
      //   - an UNREADABLE (as opposed to absent) ROADMAP still fails — that is
      //     a real fault, not an expected checkout shape;
      //   - a PRESENT ROADMAP that disagrees with the artifacts still fails,
      //     which is the entire drift guarantee and is untouched;
      //   - `--write` never takes this path, so regenerating without a ROADMAP
      //     is still a hard error rather than a silent empty vocabulary.
      //
      // The distinction that matters is preserved in the reason code: "absent,
      // nothing to verify" (ok_roadmap_absent) is not "the list is empty", and
      // it is not "the artifacts are stale".
      if (err.reason === REASON.FAIL_ROADMAP_MISSING) {
        return {
          ok: true,
          reason: REASON.OK_ROADMAP_ABSENT,
          features: [],
          count: 0,
          message: `${path.relative(ROOT, roadmapPath)} is absent (.planning/ is gitignored) — ` +
            'nothing to verify against; skipping the drift check.\n',
        };
      }
      return { ok: false, reason: err.reason, features: [], count: 0, message: err.message };
    }
    throw err;
  }

  const fields = { features: live.features, count: live.count };

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_MISSING,
      ...fields,
      message: `${path.relative(ROOT, manifestPath)} does not exist. Run:\n  node scripts/gen-feature-vocabulary.cjs --write\n`,
    };
  }

  let committedManifest;
  try {
    committedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!committedManifest || typeof committedManifest !== 'object' || !Array.isArray(committedManifest.features)) {
      throw new Error('parsed JSON does not have the expected vocabulary shape');
    }
  } catch (err) {
    return {
      ok: false,
      reason: REASON.FAIL_MANIFEST_UNPARSEABLE,
      ...fields,
      message: `${path.relative(ROOT, manifestPath)} is unparseable: ${err && err.message}\n` +
        'Run:\n  node scripts/gen-feature-vocabulary.cjs --write\n',
    };
  }

  // Comparing PARSED JSON (rather than raw file text) is inherently
  // CRLF-agnostic: JSON.parse treats \r\n and \n as equivalent insignificant
  // whitespace between tokens, and no token or gloss can contain an embedded
  // newline (the parser only accepts single-physical-line entries).
  if (JSON.stringify(committedManifest) !== JSON.stringify(live)) {
    return {
      ok: false,
      reason: REASON.FAIL_STALE_MANIFEST,
      ...fields,
      message: `${path.relative(ROOT, manifestPath)} is stale. Run:\n  node scripts/gen-feature-vocabulary.cjs --write\n`,
    };
  }

  if (!fs.existsSync(modulePath)) {
    return {
      ok: false,
      reason: REASON.FAIL_MODULE_MISSING,
      ...fields,
      message: `${path.relative(ROOT, modulePath)} does not exist. Run:\n  node scripts/gen-feature-vocabulary.cjs --write\n`,
    };
  }

  // The module is generated text, so it IS compared as text — but with line
  // endings normalised, so a CRLF checkout is not reported as drift.
  const committedModule = fs.readFileSync(modulePath, 'utf8').replace(/\r\n/g, '\n');
  if (committedModule !== serializeModule(live)) {
    return {
      ok: false,
      reason: REASON.FAIL_STALE_MODULE,
      ...fields,
      message: `${path.relative(ROOT, modulePath)} is stale. Run:\n  node scripts/gen-feature-vocabulary.cjs --write\n`,
    };
  }

  return {
    ok: true,
    reason: REASON.OK_UP_TO_DATE,
    ...fields,
    message: `${path.relative(ROOT, manifestPath)} and ${path.relative(ROOT, modulePath)} are up to date.\n`,
  };
}

// ─── Argument parsing ─────────────────────────────────────────────────────────

const PATH_FLAGS = Object.freeze({
  '--roadmap-path': 'roadmapPath',
  '--module-path': 'modulePath',
  '--manifest-path': 'manifestPath',
});

/**
 * True when `value` cannot be accepted as a path argument: absent (no more
 * argv), empty string, or flag-shaped (starts with `-`, so a dangling
 * `--roadmap-path` immediately followed by the NEXT flag is rejected rather than
 * silently swallowing that flag as a literal path).
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
 * clean, no-stack-trace usage-error path an unrecognized flag takes. Letting the
 * last flag seen win would make `--check --write` exit 0 while REWRITING the
 * committed artifacts instead of gating them, which is the gate silently
 * disarming itself.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {{ mode: 'check'|'write'|'default'|'unknown', json: boolean, roadmapPath: string, modulePath: string, manifestPath: string, unknownArg?: string, usageMessage?: string }}
 */
function parseArgs(argv) {
  const opts = {
    mode: 'default',
    json: false,
    roadmapPath: ROADMAP_PATH,
    modulePath: MODULE_PATH,
    manifestPath: MANIFEST_PATH,
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

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.mode === 'unknown') {
    process.stderr.write(
      'Usage: gen-feature-vocabulary.cjs [--write|--check] [--json] ' +
      '[--roadmap-path <path>] [--module-path <path>] [--manifest-path <path>]\n',
    );
    if (opts.usageMessage) process.stderr.write(`${opts.usageMessage}\n`);
    throw new ExitError(1);
  }

  if (opts.mode === 'default') {
    process.stdout.write(serializeManifest(buildVocabulary(opts.roadmapPath)));
    return;
  }

  if (opts.mode === 'check') {
    const report = checkReport(opts.roadmapPath, opts.manifestPath, opts.modulePath);

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        ok: report.ok,
        reason: report.reason,
        features: report.features,
        count: report.count,
      }) + '\n');
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

  // opts.mode === 'write'
  const vocabulary = buildVocabulary(opts.roadmapPath);
  fs.mkdirSync(path.dirname(opts.manifestPath), { recursive: true });
  fs.writeFileSync(opts.manifestPath, serializeManifest(vocabulary), 'utf8');
  fs.mkdirSync(path.dirname(opts.modulePath), { recursive: true });
  fs.writeFileSync(opts.modulePath, serializeModule(vocabulary), 'utf8');
  process.stdout.write(
    `Wrote ${path.relative(ROOT, opts.manifestPath)} and ${path.relative(ROOT, opts.modulePath)}\n` +
    `  ${vocabulary.count} feature${vocabulary.count !== 1 ? 's' : ''}: ${vocabulary.features.join(', ')}\n`,
  );
}

// ─── Exports (for tests) ──────────────────────────────────────────────────────

module.exports = {
  normalizeToken,
  readRoadmapMarkdown,
  parseVocabularyBlock,
  buildVocabulary,
  serializeManifest,
  serializeModule,
  checkReport,
  parseArgs,
  VocabularyError,
  REASON,
  OPEN_MARKER,
  CLOSE_MARKER,
  ROADMAP_PATH,
  MODULE_PATH,
  MANIFEST_PATH,
};

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  runMain(main);
}
