/**
 * Characterization tests for code-review-flags module.
 *
 * These assertions lock the flag-parsing and workflow-dispatch behaviour
 * used by the /gsd:code-review command. Covers both exports and every quirk
 * documented in the hand-written .cjs (ADR-457 build-at-publish migration).
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCodeReviewFlags,
  resolveCodeReviewWorkflow,
  resolveCodeReviewInvocation,
  CODE_REVIEW_USAGE,
  CODE_REVIEW_LENSES,
} = require('../gsd-core/bin/lib/code-review-flags.cjs');
const { exitCodeFor } = require('../gsd-core/bin/lib/exit-code-registry.cjs');

describe('resolveCodeReviewInvocation — phase or window (ADR-5208)', () => {
  const refusal = (argv) => {
    const result = resolveCodeReviewInvocation(argv);
    assert.equal(result.ok, false, `expected ${JSON.stringify(argv)} to be refused`);
    return result;
  };

  test('[happy] a phase alone is a phase review (no regression)', () => {
    const result = resolveCodeReviewInvocation(['3', '--depth=deep']);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'phase');
    assert.equal(result.phase, '3');
    assert.equal(result.flags.depth, 'deep');
  });

  test('[happy] --since without a phase is a window review; --until defaults to HEAD', () => {
    for (const since of ['7d', '12h', '2w', '2026-09-27', '2026-09-27T10:00:00Z', 'v1.2.0', 'last']) {
      const result = resolveCodeReviewInvocation(['--since', since]);
      assert.equal(result.ok, true, since);
      assert.equal(result.mode, 'window');
      assert.equal(result.since, since);
      assert.equal(result.until, 'HEAD');
      assert.deepEqual(result.lenses, []);
    }
  });

  test('[happy] = and space forms are equivalent; lenses keep their order and drop duplicates', () => {
    const spaced = resolveCodeReviewInvocation(['--since', '7d', '--until', 'main', '--lens', 'spec, correctness,spec', '--fix']);
    const joined = resolveCodeReviewInvocation(['--since=7d', '--until=main', '--lens=spec,correctness', '--fix']);
    assert.deepEqual(spaced, joined);
    assert.equal(spaced.until, 'main');
    assert.deepEqual(spaced.lenses, ['spec', 'correctness']);
    assert.equal(spaced.flags.fix, true);
  });

  test('[happy] every declared lens is accepted', () => {
    const result = resolveCodeReviewInvocation(['--since', '7d', '--lens', CODE_REVIEW_LENSES.join(',')]);
    assert.deepEqual(result.lenses, ['correctness', 'standards', 'spec', 'simplify']);
  });

  test('[negative] a phase AND --since is refused with the registered USAGE exit code, in either order', () => {
    for (const argv of [['3', '--since', '7d'], ['--since', '7d', '3'], ['--since=last', '03']]) {
      const result = refusal(argv);
      assert.equal(result.code, CODE_REVIEW_USAGE.PHASE_AND_SINCE);
      assert.equal(result.exit, 'USAGE');
      assert.equal(result.exitCode, exitCodeFor('USAGE'));
    }
  });

  test('[negative] neither a phase nor --since is refused', () => {
    assert.equal(refusal([]).code, CODE_REVIEW_USAGE.PHASE_OR_SINCE_REQUIRED);
    assert.equal(refusal(['--fix', '--codex']).code, CODE_REVIEW_USAGE.PHASE_OR_SINCE_REQUIRED);
  });

  test('[negative] window-only flags without --since are refused', () => {
    assert.equal(refusal(['3', '--until', 'main']).code, CODE_REVIEW_USAGE.UNTIL_WITHOUT_SINCE);
    assert.equal(refusal(['3', '--lens', 'spec']).code, CODE_REVIEW_USAGE.LENS_WITHOUT_SINCE);
  });

  test('[negative] --files and --since both choose the scope: refused', () => {
    assert.equal(refusal(['--since', '7d', '--files=a.ts']).code, CODE_REVIEW_USAGE.FILES_AND_SINCE);
  });

  test('[negative] malformed --since, --until and unknown lenses are refused', () => {
    for (const since of ['0d', '10000d', '07d', '2026-02-30', '2026-9-1', '2026-09-27T24:00Z', '-HEAD']) {
      assert.equal(refusal(['--since', since]).code, CODE_REVIEW_USAGE.INVALID_SINCE, since);
    }
    assert.equal(refusal(['--since', '7d', '--until=-x']).code, CODE_REVIEW_USAGE.INVALID_UNTIL);
    const lens = refusal(['--since', '7d', '--lens', 'spec,perf']);
    assert.equal(lens.code, CODE_REVIEW_USAGE.UNKNOWN_LENS);
    assert.match(lens.message, /perf/);
  });

  test('[boundary] a duration accepts 1 and 9999 of a unit and refuses 0 and 10000', () => {
    assert.equal(resolveCodeReviewInvocation(['--since', '1d']).ok, true);
    assert.equal(resolveCodeReviewInvocation(['--since', '9999d']).ok, true);
    assert.equal(refusal(['--since', '0d']).code, CODE_REVIEW_USAGE.INVALID_SINCE);
    assert.equal(refusal(['--since', '10000d']).code, CODE_REVIEW_USAGE.INVALID_SINCE);
  });

  test('[negative] a value flag with no value is refused, not swallowed as the next flag', () => {
    for (const argv of [['--since'], ['--since', '--fix'], ['--since', '7d', '--until'], ['--since', '7d', '--lens', '--fix']]) {
      assert.equal(refusal(argv).code, CODE_REVIEW_USAGE.MISSING_VALUE, JSON.stringify(argv));
    }
  });

  test('[regression] a --ws value is never read as the phase', () => {
    const result = resolveCodeReviewInvocation(['--ws', 'alpha', '--since', '7d']);
    assert.equal(result.mode, 'window');
    assert.equal(result.flags.phase, '');
  });

  test('[regression] the documented space form `--files a,b` sets files instead of reading as the phase', () => {
    const flags = parseCodeReviewFlags(['2', '--files', 'a.ts,b.ts', '--depth', 'quick']);
    assert.equal(flags.phase, '2');
    assert.equal(flags.files, 'a.ts,b.ts');
    assert.equal(flags.depth, 'quick');
  });

  test('[contract] the refusal codes are a closed set', () => {
    assert.deepEqual(Object.values(CODE_REVIEW_USAGE).sort(), [
      'files-and-since', 'invalid-since', 'invalid-until', 'lens-without-since', 'missing-value',
      'phase-and-since', 'phase-or-since-required', 'unknown-lens', 'until-without-since',
    ]);
  });
});

describe('parseCodeReviewFlags', () => {
  test('no flags → all defaults', () => {
    assert.deepStrictEqual(parseCodeReviewFlags([]), {
      fix: false,
      all: false,
      auto: false,
      depth: '',
      files: '',
      phase: '',
      since: '',
      until: '',
      lens: [],
    });
  });

  test('--fix sets fix:true', () => {
    const flags = parseCodeReviewFlags(['--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
  });

  test('--all sets all:true and implies fix:true', () => {
    const flags = parseCodeReviewFlags(['--all']);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.auto, false);
  });

  test('--auto sets auto:true and implies fix:true', () => {
    const flags = parseCodeReviewFlags(['--auto']);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
  });

  test('--depth=high sets depth', () => {
    const flags = parseCodeReviewFlags(['--depth=high']);
    assert.strictEqual(flags.depth, 'high');
  });

  test('--files=src/foo sets files', () => {
    const flags = parseCodeReviewFlags(['--files=src/foo']);
    assert.strictEqual(flags.files, 'src/foo');
  });

  test('--depth= (empty value) leaves depth as empty string', () => {
    const flags = parseCodeReviewFlags(['--depth=']);
    assert.strictEqual(flags.depth, '');
  });

  test('first positional argument (phase number) is reported, not validated', () => {
    const flags = parseCodeReviewFlags(['2', '--fix']);
    assert.strictEqual(flags.phase, '2');
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(flags.depth, '');
    assert.strictEqual(flags.files, '');
  });

  test('unknown flags are silently ignored', () => {
    assert.deepStrictEqual(parseCodeReviewFlags(['--unknown']), {
      fix: false,
      all: false,
      auto: false,
      depth: '',
      files: '',
      phase: '',
      since: '',
      until: '',
      lens: [],
    });
  });

  test('combined: positional + --all + --depth + --files', () => {
    const flags = parseCodeReviewFlags(['3', '--all', '--depth=deep', '--files=a.ts']);
    assert.deepStrictEqual(flags, {
      fix: true,
      all: true,
      auto: false,
      depth: 'deep',
      files: 'a.ts',
      phase: '3',
      since: '',
      until: '',
      lens: [],
    });
  });
});

describe('resolveCodeReviewWorkflow', () => {
  test('fix:true → code-review-fix.md', () => {
    assert.strictEqual(
      resolveCodeReviewWorkflow({ fix: true, all: false, auto: false, depth: '', files: '' }),
      'code-review-fix.md',
    );
  });

  test('fix:false → code-review.md', () => {
    assert.strictEqual(
      resolveCodeReviewWorkflow({ fix: false, all: false, auto: false, depth: '', files: '' }),
      'code-review.md',
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3727-code-review-fix-flag-dispatch.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3727-code-review-fix-flag-dispatch (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #3727)
// The workflow .md IS the product: its text is loaded and interpreted at
// runtime by the agent host. Structural assertions (step existence, flag
// references in the initialize step) verify the deployed dispatch contract.
// Pure-function assertions on parseCodeReviewFlags / resolveCodeReviewWorkflow
// are IR-level (not raw-text-match) per CONTRIBUTING.md L554.

/**
 * Regression tests for #3727 — /gsd-code-review N --fix silently no-ops.
 *
 * Root cause: code-review.md `initialize` step parses only --depth and
 * --files flags. --fix, --all, and --auto are never parsed, so no dispatch
 * to code-review-fix.md ever occurs.
 *
 * Fix: add parseCodeReviewFlags() to code-review-flags.cjs (typed IR), wire
 * it into the workflow initialize step, and add a dispatch_fix step that
 * delegates to code-review-fix.md when flags.fix is true.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FLAGS_LIB = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'code-review-flags.cjs');
const WORKFLOW_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'code-review.md');

// ---------------------------------------------------------------------------
// Stage 2 seam: typed IR from parseCodeReviewFlags and resolveCodeReviewWorkflow
// These functions are the production code under test — not text-matching on
// the .md source.
// ---------------------------------------------------------------------------

const { parseCodeReviewFlags, resolveCodeReviewWorkflow } = require(FLAGS_LIB);

describe('#3727 — parseCodeReviewFlags: typed IR for code-review argv', () => {
  test('code-review workflow parses --fix flag and dispatches gsd-code-fixer', () => {
    // This is the invariant being violated: --fix must be captured into the IR
    // and must route to the fixer workflow, not be silently dropped.
    const flags = parseCodeReviewFlags(['2', '--fix']);
    assert.strictEqual(flags.fix, true,
      '--fix must set flags.fix = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--fix must dispatch to code-review-fix.md, not code-review.md');
  });

  test('--fix absent: dispatch stays on code-review.md (review-only)', () => {
    // Counter-test (Stage 5 contract 6): omitting --fix must NOT dispatch fixer.
    const flags = parseCodeReviewFlags(['2']);
    assert.strictEqual(flags.fix, false,
      'Without --fix, flags.fix must be false');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review.md',
      'Without --fix, dispatch must stay on code-review.md');
  });

  test('--all implies --fix', () => {
    const flags = parseCodeReviewFlags(['3', '--all']);
    assert.strictEqual(flags.fix, true,
      '--all must imply flags.fix = true');
    assert.strictEqual(flags.all, true,
      '--all must set flags.all = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--all must dispatch to code-review-fix.md');
  });

  test('--auto implies --fix', () => {
    const flags = parseCodeReviewFlags(['3', '--auto']);
    assert.strictEqual(flags.fix, true,
      '--auto must imply flags.fix = true');
    assert.strictEqual(flags.auto, true,
      '--auto must set flags.auto = true');
    const workflow = resolveCodeReviewWorkflow(flags);
    assert.strictEqual(workflow, 'code-review-fix.md',
      '--auto must dispatch to code-review-fix.md');
  });

  test('--fix --all --auto all set simultaneously', () => {
    const flags = parseCodeReviewFlags(['1', '--fix', '--all', '--auto']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.all, true);
    assert.strictEqual(flags.auto, true);
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--depth flag is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--depth=deep', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.depth, 'deep');
    assert.strictEqual(resolveCodeReviewWorkflow(flags), 'code-review-fix.md');
  });

  test('--files flag is still parsed alongside --fix (no regression)', () => {
    const flags = parseCodeReviewFlags(['2', '--files=src/foo.ts,src/bar.ts', '--fix']);
    assert.strictEqual(flags.fix, true);
    assert.strictEqual(flags.files, 'src/foo.ts,src/bar.ts');
  });

  test('empty argv returns all-false IR', () => {
    const flags = parseCodeReviewFlags([]);
    assert.strictEqual(flags.fix, false);
    assert.strictEqual(flags.all, false);
    assert.strictEqual(flags.auto, false);
    assert.strictEqual(flags.depth, '');
    assert.strictEqual(flags.files, '');
  });
});

// ---------------------------------------------------------------------------
// Docs-parity: the workflow .md must contain the dispatch_fix step and
// reference code-review-flags.cjs in the initialize step.
// These are structural invariants on the deployed product text.
// Source-text-is-the-product exemption applies (see file header).
// ---------------------------------------------------------------------------

describe('#3727 — code-review.md structural dispatch contract', () => {
  const src = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // #2994: dispatch_fix moved wholly into a marker-gated step file
  // (gsd-core/workflows/code-review/steps/dispatch-fix.md, when="flag:--fix")
  // — the host now carries only the gsd:section marker + read-or-skip stub.
  const DISPATCH_FIX_STEP_PATH = path.join(
    ROOT,
    'gsd-core',
    'workflows',
    'code-review',
    'steps',
    'dispatch-fix.md',
  );
  const dispatchFixSrc = fs.readFileSync(DISPATCH_FIX_STEP_PATH, 'utf8');

  test('initialize step references code-review-flags.cjs for flag parsing', () => {
    const initStart = src.indexOf('<step name="initialize">');
    const initEnd = src.indexOf('</step>', initStart);
    assert.ok(initStart !== -1, 'workflow must have an initialize step');
    const initSection = src.slice(initStart, initEnd);
    assert.ok(
      initSection.includes('code-review-flags.cjs'),
      'initialize step must reference code-review-flags.cjs to parse --fix/--all/--auto flags'
    );
  });

  test('workflow gates a dispatch-fix section (flag:--fix) whose step file has the dispatch_fix step', () => {
    assert.ok(
      src.includes('<!-- gsd:section id="dispatch-fix" when="flag:--fix" -->') &&
        src.includes('gsd-core/workflows/code-review/steps/dispatch-fix.md'),
      'code-review.md must gate a dispatch-fix section pointing at dispatch-fix.md (missing = --fix is silently no-op)'
    );
    assert.ok(
      dispatchFixSrc.includes('<step name="dispatch_fix">'),
      'dispatch-fix.md step file must contain the dispatch_fix step'
    );
  });

  test('dispatch_fix step delegates to code-review-fix.md when fix flag is true', () => {
    assert.ok(
      dispatchFixSrc.includes('code-review-fix.md'),
      'dispatch_fix step must reference code-review-fix.md workflow'
    );
  });

  test('dispatch_fix step references gsd-code-fixer agent (via code-review-fix.md chain)', () => {
    // The dispatch step must show that fixing will occur, either directly or
    // by loading code-review-fix.md (which in turn spawns gsd-code-fixer).
    assert.ok(
      dispatchFixSrc.includes('gsd-code-fixer') || dispatchFixSrc.includes('code-review-fix.md'),
      'dispatch_fix step must reference gsd-code-fixer agent or code-review-fix.md workflow'
    );
  });
});
  });
}
