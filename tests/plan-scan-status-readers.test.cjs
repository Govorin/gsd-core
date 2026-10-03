'use strict';

/**
 * Reader #1 regression pins — src/plan-scan.cts against the new status vocabulary.
 *
 * `status` is not a field this phase introduced. It ships today with two
 * independent readers, and `scanPhasePlans` is the first of them (#2349,
 * src/plan-scan.cts:49-68). It reads exactly ONE value — `superseded` — and a
 * plan carrying it is dropped from BOTH the plan count and the summary count,
 * because such a plan can never gain a matching `*-SUMMARY.md` and would
 * otherwise pin its phase at `completed: false` and the milestone below 100%
 * forever.
 *
 * Phase 1 gives that field a closed four-value vocabulary. Nothing here asserts
 * the vocabulary — plan-status.unit.test.cjs and the plan `status` section of
 * frontmatter-cli.test.cjs do that. These tests assert the OPPOSITE: that teaching src/ about
 * `done` and `blocked` left this reader's counting behaviour untouched. The
 * phase can satisfy every ROADMAP criterion and still break the tree here, which
 * is why the CONTEXT verification section names these checks as mandatory and
 * places them in this phase rather than in Phase 2.
 *
 * Everything is exercised through the exported `scanPhasePlans` against real
 * temp directories holding real files. This reader opens file *contents*; a
 * stubbed fixture would skip the code path that matters. Nothing here reads
 * source text (local/no-source-grep).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const scanPhasePlans = require('../gsd-core/bin/lib/plan-scan.cjs');

/**
 * src/plan-scan.cts bounds its frontmatter read to this many bytes. The constant
 * is module-private (not exported), so it is restated here under the name of its
 * source. The over-cap test below asserts its fixture genuinely exceeds this
 * value, so the boundary keeps being exercised even if the cap grows and this
 * copy goes stale — the assertion fails loudly instead of silently passing a
 * fixture that now fits.
 */
const PLAN_FRONTMATTER_READ_CAP = 64 * 1024; // src/plan-scan.cts: PLAN_FRONTMATTER_READ_CAP

describe('plan-scan (reader #1) after the status vocabulary landed', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-plan-scan-status-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** A phase directory holding the given files, returned as an absolute path. */
  function phaseWith(files) {
    const dir = path.join(tmpDir, `phase-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  }

  /** A minimal plan file, optionally carrying a `status:` line. */
  function plan(status) {
    const statusLine = status === undefined ? '' : `status: ${status}\n`;
    return `---\nphase: 01\nplan: 01\n${statusLine}---\n\n# a plan\n`;
  }

  const SUMMARY = '---\nphase: 01\n---\n\n# a summary\n';

  // ── the #2349 behaviour, unchanged ────────────────────────────────────────

  test('a superseded plan is still dropped from BOTH counts, leaving the phase complete', () => {
    // D-00a. Three plans, one superseded, SUMMARYs for the other two. If the
    // superseded plan were counted, planCount would be 3 against summaryCount 2
    // and the phase would read incomplete forever — the exact failure #2349 fixed.
    const dir = phaseWith({
      '01-01-PLAN.md': plan('superseded'),
      '01-02-PLAN.md': plan(),
      '01-03-PLAN.md': plan(),
      '01-02-SUMMARY.md': SUMMARY,
      '01-03-SUMMARY.md': SUMMARY,
    });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 2, 'the superseded plan must not inflate the denominator');
    assert.equal(result.summaryCount, 2, 'nor, via countMatchedSummaries, the numerator');
    assert.equal(result.completed, true, 'a phase whose remaining plans all have SUMMARYs is complete');
    assert.deepEqual(
      result.planFiles,
      ['01-02-PLAN.md', '01-03-PLAN.md'],
      'the superseded plan is absent from the returned set, not merely uncounted',
    );
  });

  test('a superseded plan written "status:  SUPERSEDED" is still recognised', () => {
    // D-06a. What ships is `status.trim().toLowerCase() === 'superseded'`, so
    // capitals and a leading space are accepted today. A vocabulary check that
    // demanded exact lowercase would reject a file this reader accepts — two
    // readers disagreeing about the same bytes, which is the failure this phase
    // exists to prevent. The fixture carries the exact shape the CONTEXT names.
    const dir = phaseWith({
      '01-01-PLAN.md': '---\nphase: 01\nplan: 01\nstatus:  SUPERSEDED\n---\n\n# a plan\n',
      '01-02-PLAN.md': plan(),
      '01-03-PLAN.md': plan(),
      '01-02-SUMMARY.md': SUMMARY,
      '01-03-SUMMARY.md': SUMMARY,
    });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 2, 'mixed case must be normalised exactly as before');
    assert.equal(result.summaryCount, 2);
    assert.equal(result.completed, true);
  });

  test('a plan with status: done is counted like any other plan', () => {
    // The load-bearing negative. `done` is a value this phase newly teaches src/
    // to recognise, and the most plausible way a well-meaning follow-up breaks
    // this reader is by treating the whole vocabulary as exclusion-worthy rather
    // than only `superseded` (#2349 scope). Completion is inferred from SUMMARY
    // presence (D-05); the status claim alone changes nothing here.
    const dir = phaseWith({
      '01-01-PLAN.md': plan('done'),
      '01-02-PLAN.md': plan(),
    });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 2, 'only `superseded` is excluded — never `done`');
    assert.equal(result.summaryCount, 0);
    assert.equal(result.completed, false, 'claiming done without a SUMMARY does not complete a phase');
    assert.deepEqual(result.planFiles, ['01-01-PLAN.md', '01-02-PLAN.md']);
  });

  test('a plan carrying status: blocked or in_progress is counted like any other plan', () => {
    // The remaining two vocabulary values, for the same reason: recognising a
    // value in src/ must not make this counter drop it.
    const dir = phaseWith({
      '01-01-PLAN.md': plan('blocked'),
      '01-02-PLAN.md': plan('in_progress'),
    });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 2);
    assert.deepEqual(result.planFiles, ['01-01-PLAN.md', '01-02-PLAN.md']);
  });

  test('a plan with no status at all is counted normally', () => {
    // D-04: an absent status is valid and means "not started". Roughly 1031
    // plans on disk across consuming trees are in exactly this state and not one
    // is migrated.
    const dir = phaseWith({
      '01-01-PLAN.md': plan(),
      '01-01-SUMMARY.md': SUMMARY,
    });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 1);
    assert.equal(result.summaryCount, 1);
    assert.equal(result.completed, true);
  });

  // ── the fail-safe direction — deliberate, do NOT "fix" ─────────────────────
  //
  // Every test below asserts that an UNREADABLE or NON-REGULAR plan is counted
  // as a NORMAL plan rather than dropped. That is the safe direction for a
  // counter: dropping a plan nobody could read silently completes a phase that
  // is not complete. It is also load-bearing against a DoS — the
  // `statSync().isFile()` pre-open guard rejects a symlink resolving to a device
  // such as /dev/zero before any open (a git-committable vector, cf. #2378
  // /#2383), and the read is bounded to PLAN_FRONTMATTER_READ_CAP.
  //
  // If one of these assertions fails, the assertion is the specification: the
  // behaviour regressed, the test is not stale. See D-00a and the CONTEXT
  // verification section, "Do not 'fix' the fail-safe direction."

  test('deliberate — do not "fix": a DIRECTORY named *-PLAN.md is counted as a normal plan', () => {
    // Exercises the statSync().isFile() guard portably. A directory is not a
    // regular file, isPlanSuperseded returns false without opening it, and the
    // entry stays in the count. A device node or symlink would test the same
    // guard while being unavailable or unsafe on some CI platforms.
    const dir = phaseWith({});
    fs.mkdirSync(path.join(dir, '01-01-PLAN.md'));

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 1, 'a non-regular plan path is counted, never silently dropped');
    assert.deepEqual(result.planFiles, ['01-01-PLAN.md']);
  });

  test('deliberate — do not "fix": a zero-byte plan is counted as a normal plan', () => {
    // st.size === 0 short-circuits before any read. Nothing can be known about
    // the file's status, so it is counted.
    const dir = phaseWith({ '01-01-PLAN.md': '' });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 1);
    assert.equal(result.completed, false, 'an empty plan without a SUMMARY leaves the phase open');
  });

  test('deliberate — do not "fix": a plan with unparseable frontmatter is counted as a normal plan', () => {
    // No frontmatter delimiters at all: extractFrontmatter yields no `status`,
    // so the plan is counted. Garbage must not be able to remove a plan from the
    // denominator.
    const dir = phaseWith({
      '01-01-PLAN.md': 'not frontmatter at all\n:::\n\tstatus superseded ??\n[[[\n',
    });

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 1);
    assert.deepEqual(result.planFiles, ['01-01-PLAN.md']);
  });

  test('deliberate — do not "fix": a status pushed beyond the 64 KiB read cap is counted as a normal plan', () => {
    // The read is bounded, so a `status: superseded` sitting past the cap is
    // never seen and the plan is counted. This is the DoS mitigation working as
    // designed (T-01-08): a pathologically large committed plan cannot be
    // slurped into memory just to inspect one key. It also means an oversized
    // plan cannot use distance to talk itself out of the denominator.
    const padding = `# ${'x'.repeat(78)}\n`.repeat(1200);
    const content = `---\nphase: 01\n${padding}status: superseded\n---\n\n# a plan\n`;
    const dir = phaseWith({ '01-01-PLAN.md': content });

    // Guard the fixture itself: if the cap ever grows past this file's size, the
    // test would silently stop exercising the boundary and pass for the wrong
    // reason. Fail loudly instead.
    const size = fs.statSync(path.join(dir, '01-01-PLAN.md')).size;
    assert.ok(
      size > PLAN_FRONTMATTER_READ_CAP,
      `fixture must exceed the read cap to exercise it: ${size} bytes vs cap ${PLAN_FRONTMATTER_READ_CAP}`,
    );
    assert.ok(
      content.indexOf('status: superseded') > PLAN_FRONTMATTER_READ_CAP,
      'the status key must sit beyond the cap, not merely the file end',
    );
    // Verified by probe: what the bounded read hands to extractFrontmatter is a
    // prefix with no closing `---`, so it parses as no frontmatter rather than
    // as partial frontmatter. Both routes reach the same fail-safe answer —
    // count the plan — and the test asserts the answer, not the route.

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 1, 'a status the bounded read cannot reach does not drop the plan');
    assert.deepEqual(result.planFiles, ['01-01-PLAN.md']);
  });

  test('a huge plan whose frontmatter block fits INSIDE the read cap is still excluded', () => {
    // The other side of the same boundary, and the reason the bound is a
    // performance guard rather than a functional limit: a plan can be far larger
    // than the cap and still be read correctly, because frontmatter sits at byte
    // 0 and closes long before the body. Without this case, "counted" in the test
    // above could mean the reader stopped working entirely rather than that the
    // cap held.
    //
    // Note what the over-cap case actually proves, established by probe: it is
    // the CLOSING `---` that must fall inside the cap, not merely the `status`
    // key. A prefix truncated mid-block parses as no frontmatter at all, so the
    // plan is counted — fail-safe either way, which is the point.
    const body = `# ${'x'.repeat(78)}\n`.repeat(1200); // ~96 KiB, all after the block
    const dir = phaseWith({
      '01-01-PLAN.md': `---\nphase: 01\nstatus: superseded\n---\n\n${body}`,
      '01-02-PLAN.md': plan(),
      '01-02-SUMMARY.md': SUMMARY,
    });

    const size = fs.statSync(path.join(dir, '01-01-PLAN.md')).size;
    assert.ok(
      size > PLAN_FRONTMATTER_READ_CAP,
      `fixture must exceed the read cap for this to be a boundary: ${size} bytes`,
    );

    const result = scanPhasePlans(dir);

    assert.equal(result.planCount, 1, 'a frontmatter block within the cap is read and the plan excluded');
    assert.deepEqual(result.planFiles, ['01-02-PLAN.md']);
    assert.equal(result.completed, true);
  });
});
