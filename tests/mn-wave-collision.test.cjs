'use strict';

/**
 * wave-collision.mjs — the gate that catches two same-wave plans declaring the
 * same file.
 *
 * Same-wave plans execute concurrently in separate worktrees and commit in
 * sequence, so a shared file means the second commit either overwrites the
 * first or lands in a merge conflict. The rule against it is the only
 * parallelism rule in the system, it lives as pseudocode inside the planner
 * prompt, an LLM executes it, and nothing checked the result.
 *
 * Measured across 13 planning roots and 1412 plans: 38 phases of 283 (13.4%)
 * violate it, 107 colliding pairs. The number is stable — data quality doubled
 * between two measurements (non-file entries 10% → 4%) while the violation rate
 * moved 13.3% → 13.4%, which rules out "dirty data" and leaves the prompt.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'wave-collision.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

const PASS = 0;
const COLLISION = 1;
const CANNOT_LOOK = 2;

describe('wave-collision gate', () => {
  let tmp;
  let phaseDir;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-wave-collision-'));
    phaseDir = path.join(tmp, 'phase');
    fs.mkdirSync(phaseDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmp);
  });

  /** Write a plan with the frontmatter shape the real planner emits. */
  function writePlan(name, wave, files) {
    const list = files.map((f) => `  - ${f}`).join('\n');
    fs.writeFileSync(
      path.join(phaseDir, name),
      `---\nwave: ${wave}\nfiles_modified:\n${list}\n---\n\n# ${name}\n`,
    );
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--dir', phaseDir, ...extra], { timeoutMs: RUN_TIMEOUT_MS });
  }

  // ── the defect ────────────────────────────────────────────────────────────

  test('catches two plans in the same wave declaring the same file', () => {
    // The shape measured on the live project: 06-02 and 06-03, both wave 2,
    // both declaring apps/trade-mind/api/src/main.ts.
    writePlan('06-02-PLAN.md', 2, ['apps/api/src/main.ts', 'apps/api/src/vault.ts']);
    writePlan('06-03-PLAN.md', 2, ['apps/api/src/main.ts', 'apps/api/src/heimdall.ts']);

    const r = run();
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, COLLISION, `expected a collision, got ${r.exitCode}: ${r.stdout}`);
    assert.match(r.stderr, /WAVE 2/);
    assert.match(r.stderr, /06-02-PLAN\.md/);
    assert.match(r.stderr, /06-03-PLAN\.md/);
    assert.match(r.stderr, /apps\/api\/src\/main\.ts/);
    // The consequence must be stated, or the reader has to guess why it matters.
    assert.match(r.stderr, /overwrites the first|merge conflict/);
  });

  test('reports every colliding pair, not just the first', () => {
    writePlan('a-PLAN.md', 1, ['src/shared.ts']);
    writePlan('b-PLAN.md', 1, ['src/shared.ts']);
    writePlan('c-PLAN.md', 1, ['src/shared.ts']);

    const r = run();
    assert.equal(r.exitCode, COLLISION);
    // Three plans over one file are three distinct pairs — a report naming one
    // would understate the work needed to fix it.
    assert.match(r.stderr, /3 colliding pair\(s\)/);
  });

  // ── what must NOT count as a collision ────────────────────────────────────

  test('passes when the same file is declared in DIFFERENT waves', () => {
    // Sequencing is precisely the remedy: wave 2 runs after wave 1 finishes.
    writePlan('a-PLAN.md', 1, ['src/shared.ts']);
    writePlan('b-PLAN.md', 2, ['src/shared.ts']);

    const r = run();
    assert.equal(r.exitCode, PASS, `different waves must not collide: ${r.stderr}`);
  });

  test('passes when same-wave plans declare disjoint files', () => {
    writePlan('a-PLAN.md', 1, ['src/a.ts', 'src/b.ts']);
    writePlan('b-PLAN.md', 1, ['src/c.ts', 'src/d.ts']);

    const r = run();
    assert.equal(r.exitCode, PASS, `disjoint files are the healthy case: ${r.stderr}`);
    assert.match(r.stdout, /no shared files/);
  });

  test('normalizes ./-prefixed and trailing-slash paths before comparing', () => {
    // `./src/a.ts` and `src/a.ts` are the same file; a formatting difference
    // must not hide a real collision.
    writePlan('a-PLAN.md', 1, ['./src/a.ts']);
    writePlan('b-PLAN.md', 1, ['src/a.ts']);

    const r = run();
    assert.equal(r.exitCode, COLLISION, 'path formatting must not mask a collision');
  });

  test('does not compare directory or glob entries', () => {
    // 4% of entries on the live project are directories or globs. Expanding a
    // glob would need a tree walk and would fire on paths the plan is about to
    // create, so these are skipped rather than guessed at.
    writePlan('a-PLAN.md', 1, ['libs/shared/**']);
    writePlan('b-PLAN.md', 1, ['libs/shared/**']);

    const r = run(['--verbose']);
    assert.equal(r.exitCode, PASS, `globs must not be compared literally: ${r.stderr}`);
    assert.match(r.stdout, /non-file entr/, 'skipped entries must be reported, not vanish');
  });

  test('passes a phase whose plans carry no wave tag', () => {
    fs.writeFileSync(
      path.join(phaseDir, 'x-PLAN.md'),
      '---\nfiles_modified:\n  - src/a.ts\n---\n\n# no wave\n',
    );
    fs.writeFileSync(
      path.join(phaseDir, 'y-PLAN.md'),
      '---\nfiles_modified:\n  - src/a.ts\n---\n\n# no wave\n',
    );

    const r = run(['--verbose']);
    assert.equal(r.exitCode, PASS, 'untagged plans are not parallelized, so they cannot collide');
    assert.match(r.stdout, /nothing to check/);
  });

  test('passes a phase with a single plan', () => {
    writePlan('only-PLAN.md', 1, ['src/a.ts']);

    const r = run();
    assert.equal(r.exitCode, PASS);
  });

  test('passes a plan declaring no files', () => {
    // 5% of plans on the live project declare none. An empty declaration
    // cannot collide with anything.
    fs.writeFileSync(path.join(phaseDir, 'a-PLAN.md'), '---\nwave: 1\n---\n\n# empty\n');
    writePlan('b-PLAN.md', 1, ['src/a.ts']);

    const r = run();
    assert.equal(r.exitCode, PASS);
  });

  // ── could-not-look is not success ─────────────────────────────────────────

  test('exits 2 when the phase directory does not exist', () => {
    const r = runNode([SCRIPT, '--dir', path.join(tmp, 'nope')], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK, '"could not look" must be distinct from "found nothing"');
  });

  test('exits 2 when --dir is omitted', () => {
    const r = runNode([SCRIPT], { timeoutMs: RUN_TIMEOUT_MS });
    assert.equal(r.exitCode, CANNOT_LOOK);
  });

  // ── the gate is dispatched, not merely present ────────────────────────────

  test('the capability registers the gate at plan:post', () => {
    // The manifest IS the deployed contract: the runtime reads this JSON to
    // decide what runs. A script nothing dispatches is the defect class this
    // fork exists to close.
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'capabilities', 'mn-verify-gate', 'capability.json'),
        'utf8',
      ),
    );

    const gate = (manifest.gates || []).find((g) => g.when === 'workflow.wave_collision');
    assert.ok(gate, 'a gate keyed on workflow.wave_collision must be declared');
    // plan:post, not verify: at planning time the fix is renumbering a wave;
    // by verify the colliding commits already landed.
    assert.equal(gate.point, 'plan:post');
    assert.equal(gate.blocking, true);
    assert.match(gate.check.predicate.command, /wave-collision\.mjs/);

    const cfg = manifest.config['workflow.wave_collision'];
    assert.ok(cfg, 'the gate must own a config key so it can be switched off');
    assert.equal(cfg.default, false, 'a new blocking gate ships off and is opted into');
  });
});
