'use strict';

/**
 * `gsd-tools config-advise` (S7, src/config-advise.cts) — recommend existing knobs from the
 * project's own `.planning/` artifacts.
 *
 * The October 2026 review found half of what three projects "missed" already in GSD, off by
 * default and never discovered. Each rule fires at a threshold; every threshold is tested at
 * N-1 (silent), N (fires) and N+1 (fires), and every rule is tested with its knob already on
 * (silent — an enabled knob is never recommended). The CLI and the two payloads that surface the
 * summary (`init progress`, `validate health`) are pinned as JSON contracts.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { cleanup, createTempDir, createTempProject, runGsdTools } = require('./helpers.cjs');
const { writeFiles } = require('./helpers/mn-gate-fixture.cjs');
const advise = require('../gsd-core/bin/lib/config-advise.cjs');

const T = advise.ADVISE_THRESHOLDS;

function plan(n, body = 'plain change', files = '[src/a.ts]') {
  return `---\nphase: 01\nplan: ${n}\nwave: 1\nfiles_modified: ${files}\n---\n<tasks>\n<task type="auto"><name>t</name><action>${body}</action></task>\n</tasks>\n`;
}
const penPlan = (n) => plan(n, 'Draw the screen', '[design/app.pen]');

function review(critical, warning, status = 'issues_found') {
  return `---\nphase: 01\nfindings:\n  critical: ${critical}\n  warning: ${warning}\n  info: 9\n  total: ${critical + warning + 9}\nstatus: ${status}\n---\n\n# Review\n`;
}

function verification(status, body = '') {
  return `---\nphase: 01\nstatus: ${status}\n---\n\n# Verification\n\n${body}\n`;
}

function writeConfig(dir, config) {
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
}

function phase(dir, name, files) {
  writeFiles(path.join(dir, '.planning', 'phases', name), files);
}

const ruleOf = (advice, rule) => advice.rules.find((r) => r.rule === rule);
const recOf = (advice, rule) => advice.recommendations.find((r) => r.rule === rule);

describe('config-advise rules', () => {
  let projectDir;
  let agentsDir;
  let savedAgentsDir;

  beforeEach(() => {
    savedAgentsDir = process.env.GSD_AGENTS_DIR;
    projectDir = createTempProject('gsd-advise-');
    agentsDir = createTempDir('gsd-advise-agents-');
    process.env.GSD_AGENTS_DIR = agentsDir;
  });

  afterEach(() => {
    if (savedAgentsDir === undefined) delete process.env.GSD_AGENTS_DIR;
    else process.env.GSD_AGENTS_DIR = savedAgentsDir;
    cleanup(projectDir);
    cleanup(agentsDir);
  });

  test('an empty project recommends nothing and has a null summary', () => {
    const a = advise.adviseConfig(projectDir);
    assert.equal(a.count, 0);
    assert.equal(a.summary, null);
    assert.deepEqual(a.rules.map((r) => r.rule), ['plan_chunked', 'code_review_point', 'verify_work', 'verify_gates', 'agent_tools']);
  });

  // ── plan_chunked ──────────────────────────────────────────────────────────

  describe('plan_chunked (plans per phase)', () => {
    const plansOnDisk = (n) => {
      const files = {};
      for (let i = 1; i <= n; i++) files[`01-${String(i).padStart(2, '0')}-PLAN.md`] = plan(i);
      phase(projectDir, '01-big', files);
    };

    test(`N-1 = ${T.PLANS_PER_PHASE - 1} plans: silent`, () => {
      plansOnDisk(T.PLANS_PER_PHASE - 1);
      const a = advise.adviseConfig(projectDir);
      assert.equal(ruleOf(a, 'plan_chunked').fired, false);
      assert.equal(recOf(a, 'plan_chunked'), undefined);
    });

    test(`N = ${T.PLANS_PER_PHASE} plans: recommends plan_chunked + chunked_parallel`, () => {
      plansOnDisk(T.PLANS_PER_PHASE);
      const rec = recOf(advise.adviseConfig(projectDir), 'plan_chunked');
      assert.deepEqual(rec.settings, { 'workflow.plan_chunked': true, 'planning.chunked_parallel': true });
      assert.equal(rec.command, 'gsd-tools config-set workflow.plan_chunked true && gsd-tools config-set planning.chunked_parallel true');
      assert.match(rec.reason, /01-big has 6 plans/);
    });

    test(`N+1 = ${T.PLANS_PER_PHASE + 1} plans: fires`, () => {
      plansOnDisk(T.PLANS_PER_PHASE + 1);
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'plan_chunked').fired, true);
    });

    const writeRoadmap = (lines, milestone = 'v2.0') => {
      fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), lines.join('\n'));
      fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), `---\nmilestone: ${milestone}\n---\n\n# State\n`);
    };

    test('a count declared in the active milestone of ROADMAP.md counts before the plans exist', () => {
      writeRoadmap(['# Roadmap', '', '## Milestone v2.0', '', '### Phase 4: Big', `**Plans:** ${T.PLANS_PER_PHASE} plans`, '', '### Phase 5: Small', '**Plans**: 2 plans', '']);
      const rule = ruleOf(advise.adviseConfig(projectDir), 'plan_chunked');
      assert.equal(rule.fired, true);
      assert.deepEqual(rule.evidence.largest, { phase: '4', plans: T.PLANS_PER_PHASE, source: 'roadmap' });
    });

    test('a preamble listing an earlier milestone\'s phases is not read (mn: phases 01–03 of v1.0 above v2.0)', () => {
      writeRoadmap([
        '# Roadmap', '',
        '- [x] **Phase 1: Old**', '- [x] **Phase 2: Old**', '- [ ] **Phase 3: Old**', '',
        '### Phase 3: Old', `**Plans:** ${T.PLANS_PER_PHASE + 4} plans`, '',
        '## Milestone v2.0', '', '### Phase 4: New', '**Plans:** 2 plans', '',
      ]);
      const rule = ruleOf(advise.adviseConfig(projectDir), 'plan_chunked');
      assert.equal(rule.fired, false, JSON.stringify(rule.evidence));
    });

    test('an unversioned ROADMAP whose earlier phases are checked done does not fire on them (mn: phase 03 of v1.0)', () => {
      // No milestone headings: the whole document is "current", so the old read cited phase 3.
      writeRoadmap([
        '# Roadmap', '', '## Phases', '',
        '- [x] **Phase 1: Old**', '- [x] **Phase 3: Old**', '- [ ] **Phase 4: New**', '',
        '## Phase Details', '',
        '### Phase 3: Old', `**Plans:** ${T.PLANS_PER_PHASE + 4} plans`, '',
        '### Phase 4: New', '**Plans:** 2 plans', '',
      ]);
      const rule = ruleOf(advise.adviseConfig(projectDir), 'plan_chunked');
      assert.equal(rule.fired, false, JSON.stringify(rule.evidence));
    });

    test('a preamble phase with a directory in .planning/phases still counts, unless it is checked done', () => {
      const lines = ['# Roadmap', '', '### Phase 3: Old', `**Plans:** ${T.PLANS_PER_PHASE} plans`, '', '## Milestone v2.0', ''];
      phase(projectDir, '03-old', { '.keep': '' });
      writeRoadmap(lines);
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'plan_chunked').fired, true, 'a phase directory makes it a phase still to plan');
      writeRoadmap(['- [x] **Phase 3: Old**', ...lines]);
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'plan_chunked').fired, false, 'a checked phase is done');
    });

    test('roadmapPlanCounts records the milestone section and the done mark', () => {
      const counts = advise.roadmapPlanCounts(['- [x] **Phase 03: A**', '### Phase 3: A', '**Plans:** 4 plans', '<details><summary>v1.0 shipped</summary>', '### Phase 4: B', '**Plans:** 1 plan'].join('\n'));
      assert.deepEqual(counts, [
        { phase: '3', plans: 4, milestone: null, done: true },
        { phase: '4', plans: 1, milestone: 'v1.0', done: false },
      ]);
    });

    test('the primary key decides: plan_chunked on with chunked_parallel deliberately off is not re-advised', () => {
      plansOnDisk(T.PLANS_PER_PHASE);
      writeConfig(projectDir, { workflow: { plan_chunked: true }, planning: { chunked_parallel: false } });
      const a = advise.adviseConfig(projectDir);
      assert.equal(ruleOf(a, 'plan_chunked').already_enabled, true);
      assert.equal(recOf(a, 'plan_chunked'), undefined);
    });

    test('an explicit chunked_parallel: false is kept out of the recommendation', () => {
      plansOnDisk(T.PLANS_PER_PHASE);
      writeConfig(projectDir, { planning: { chunked_parallel: false } });
      assert.deepEqual(recOf(advise.adviseConfig(projectDir), 'plan_chunked').settings, { 'workflow.plan_chunked': true });
    });

    test('a ROADMAP count outside the active milestone is not read (mn: phase 08 of a shipped v2.0)', () => {
      fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), [
        '# Roadmap', '',
        '<details>', '<summary>v2.0 (shipped)</summary>', '',
        '## Milestone v2.0', '', '### Phase 8: Old', `**Plans:** ${T.PLANS_PER_PHASE + 4} plans`, '',
        '</details>', '',
        '## Milestone v3.0 (current)', '', '### Phase 9: New', '**Plans:** 2 plans', '',
      ].join('\n'));
      fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), '---\nmilestone: v3.0\n---\n\n# State\n');
      const rule = ruleOf(advise.adviseConfig(projectDir), 'plan_chunked');
      assert.equal(rule.fired, false, JSON.stringify(rule.evidence));
    });

    test('both knobs on: fired but not recommended', () => {
      plansOnDisk(T.PLANS_PER_PHASE + 1);
      writeConfig(projectDir, { workflow: { plan_chunked: true }, planning: { chunked_parallel: true } });
      const a = advise.adviseConfig(projectDir);
      assert.equal(ruleOf(a, 'plan_chunked').fired, true);
      assert.equal(ruleOf(a, 'plan_chunked').already_enabled, true);
      assert.equal(recOf(a, 'plan_chunked'), undefined);
    });
  });

  // ── code_review_point ─────────────────────────────────────────────────────

  describe('code_review_point (fix-worthy findings at phase end)', () => {
    const N = T.REVIEW_FIX_FINDINGS;

    test(`N-1 = ${N - 1} critical+warning: silent (info findings do not count)`, () => {
      phase(projectDir, '01-a', { '01-REVIEW.md': review(1, N - 2) });
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'code_review_point').fired, false);
    });

    test(`N = ${N}: recommends execute:wave:post`, () => {
      phase(projectDir, '01-a', { '01-REVIEW.md': review(1, N - 1) });
      const rec = recOf(advise.adviseConfig(projectDir), 'code_review_point');
      assert.deepEqual(rec.settings, { 'workflow.code_review_point': 'execute:wave:post' });
      assert.equal(rec.command, 'gsd-tools config-set workflow.code_review_point execute:wave:post');
    });

    test(`N+1 = ${N + 1}: fires`, () => {
      phase(projectDir, '01-a', { '01-REVIEW.md': review(0, N + 1) });
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'code_review_point').fired, true);
    });

    test('a skipped review is not evidence', () => {
      phase(projectDir, '01-a', { '01-REVIEW.md': review(3, N, 'skipped') });
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'code_review_point').fired, false);
    });

    test('already per-wave: not recommended', () => {
      phase(projectDir, '01-a', { '01-REVIEW.md': review(2, N) });
      writeConfig(projectDir, { workflow: { code_review_point: 'execute:wave:post' } });
      const a = advise.adviseConfig(projectDir);
      assert.equal(ruleOf(a, 'code_review_point').already_enabled, true);
      assert.equal(recOf(a, 'code_review_point'), undefined);
    });
  });

  // ── verify_work ───────────────────────────────────────────────────────────

  describe('verify_work (phases waiting on human verification)', () => {
    const waiting = (n) => {
      for (let i = 1; i <= n; i++) {
        const p = String(i).padStart(2, '0');
        phase(projectDir, `${p}-p${i}`, { [`${p}-VERIFICATION.md`]: verification('human_needed') });
      }
    };

    test(`N-1 = ${T.HUMAN_VERIFICATION_PHASES - 1} phase: silent`, () => {
      waiting(T.HUMAN_VERIFICATION_PHASES - 1);
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'verify_work').fired, false);
    });

    test(`N = ${T.HUMAN_VERIFICATION_PHASES} phases: recommends verify-work on the oldest, then audit-uat`, () => {
      waiting(T.HUMAN_VERIFICATION_PHASES);
      const rec = recOf(advise.adviseConfig(projectDir), 'verify_work');
      assert.equal(rec.settings, null, 'a command to run, not a knob');
      assert.match(rec.command, /verify-work 01/);
      assert.match(rec.command, /audit-uat/);
    });

    test(`N+1 = ${T.HUMAN_VERIFICATION_PHASES + 1} phases: fires`, () => {
      waiting(T.HUMAN_VERIFICATION_PHASES + 1);
      assert.deepEqual(ruleOf(advise.adviseConfig(projectDir), 'verify_work').evidence.phases, ['01', '02', '03']);
    });

    test('an open UAT counts as waiting; a passed verification does not', () => {
      phase(projectDir, '01-a', { '01-UAT.md': '---\nstatus: testing\n---\n\n## Tests\n' });
      phase(projectDir, '02-b', { '02-VERIFICATION.md': verification('passed') });
      phase(projectDir, '03-c', { '03-VERIFICATION.md': verification('human_needed') });
      assert.deepEqual(ruleOf(advise.adviseConfig(projectDir), 'verify_work').evidence.phases, ['01', '03']);
    });
  });

  // ── verify_gates ──────────────────────────────────────────────────────────

  describe('verify_gates (reports citing hand-run checks)', () => {
    const citing = (n) => {
      for (let i = 1; i <= n; i++) {
        const p = String(i).padStart(2, '0');
        phase(projectDir, `${p}-g${i}`, {
          [`${p}-VERIFICATION.md`]: verification('passed', 'Ran `npm test` (120 passed) and:\n\n```bash\nnpx tsc --noEmit\n```\n'),
        });
      }
    };

    test(`N-1 = ${T.GATE_CITING_REPORTS - 1} report: silent`, () => {
      citing(T.GATE_CITING_REPORTS - 1);
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'verify_gates').fired, false);
    });

    test(`N = ${T.GATE_CITING_REPORTS} reports: proposes the cited commands as verify_gates + record`, () => {
      citing(T.GATE_CITING_REPORTS);
      const rec = recOf(advise.adviseConfig(projectDir), 'verify_gates');
      assert.deepEqual(rec.settings, {
        'workflow.verify_gates': { tests: 'npm test', typecheck: 'npx tsc --noEmit' },
        'workflow.verify_gates_record': true,
      });
      assert.equal(
        rec.command,
        `gsd-tools config-set workflow.verify_gates '{"tests":"npm test","typecheck":"npx tsc --noEmit"}' && gsd-tools config-set workflow.verify_gates_record true`,
      );
    });

    test(`N+1 = ${T.GATE_CITING_REPORTS + 1} reports: fires`, () => {
      citing(T.GATE_CITING_REPORTS + 1);
      assert.equal(ruleOf(advise.adviseConfig(projectDir), 'verify_gates').fired, true);
    });

    test('the primary key decides: verify_gates configured, record off → not re-advised', () => {
      citing(T.GATE_CITING_REPORTS);
      writeConfig(projectDir, { workflow: { verify_gates: { tests: 'npm test' } } });
      const a = advise.adviseConfig(projectDir);
      assert.equal(ruleOf(a, 'verify_gates').already_enabled, true);
      assert.equal(recOf(a, 'verify_gates'), undefined);
    });

    test('an explicit verify_gates_record: false is kept out of the recommendation', () => {
      citing(T.GATE_CITING_REPORTS);
      writeConfig(projectDir, { workflow: { verify_gates_record: false } });
      assert.deepEqual(Object.keys(recOf(advise.adviseConfig(projectDir), 'verify_gates').settings), ['workflow.verify_gates']);
    });

    test('gateName: one kind names it; a command running several kinds is "checks"', () => {
      assert.equal(advise.gateName('npm test'), 'tests');
      assert.equal(advise.gateName('npx tsc --noEmit'), 'typecheck');
      assert.equal(advise.gateName('nx run-many -t typecheck lint test build'), 'checks');
      assert.equal(advise.gateName('pnpm eslint .'), 'lint');
    });

    test('gates configured and recorded: not recommended', () => {
      citing(T.GATE_CITING_REPORTS + 1);
      writeConfig(projectDir, { workflow: { verify_gates: { tests: 'npm test' }, verify_gates_record: true } });
      assert.equal(recOf(advise.adviseConfig(projectDir), 'verify_gates'), undefined);
    });

    test('citedGateCommands ignores frontmatter and prose that is not a check', () => {
      const cmds = advise.citedGateCommands('---\ngates:\n  tests: npm test\n---\nWe used `README.md` and ran `pnpm lint`; also `git status`.\n');
      assert.deepEqual(cmds, ['pnpm lint']);
    });
  });

  // ── agent_tools (reuses the S4 preflight) ─────────────────────────────────

  describe('agent_tools (plans naming tools the executor lacks)', () => {
    test('a missing grant is recommended as agent_tools + reinstall', () => {
      fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), '---\nname: gsd-executor\ntools: Read, Write\n---\n');
      phase(projectDir, '01-ui', { '01-01-PLAN.md': penPlan(1) });
      const rec = recOf(advise.adviseConfig(projectDir), 'agent_tools');
      assert.deepEqual(rec.settings, { 'agent_tools.gsd-executor': ['mcp__pencil__*'] });
      assert.match(rec.command, /^gsd-tools config-set agent_tools\.gsd-executor '\["mcp__pencil__\*"\]', then re-install GSD for \w+ the same way it was installed/);
    });

    test('a tool only mentioned in prose is not an agent_tools recommendation', () => {
      fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), '---\nname: gsd-executor\ntools: Read, Write\n---\n');
      phase(projectDir, '01-ui', { '01-01-PLAN.md': plan(1, 'Do not touch or stage app.pen.') });
      assert.equal(recOf(advise.adviseConfig(projectDir), 'agent_tools'), undefined);
    });

    test('granted: silent', () => {
      fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), '---\nname: gsd-executor\ntools: Read, mcp__pencil__*\n---\n');
      phase(projectDir, '01-ui', { '01-01-PLAN.md': penPlan(1) });
      assert.equal(recOf(advise.adviseConfig(projectDir), 'agent_tools'), undefined);
    });

    test('no installed agent: not recommended, but reported as unknown in the evidence', () => {
      phase(projectDir, '01-ui', { '01-01-PLAN.md': penPlan(1) });
      const a = advise.adviseConfig(projectDir);
      assert.equal(recOf(a, 'agent_tools'), undefined);
      assert.equal(ruleOf(a, 'agent_tools').evidence.unknown.length, 1);
    });
  });

  test('archived milestones are not read', () => {
    const files = {};
    for (let i = 1; i <= T.PLANS_PER_PHASE + 2; i++) files[`01-0${i}-PLAN.md`] = plan(i);
    writeFiles(path.join(projectDir, '.planning', 'milestones', 'v1.0-phases', '01-old'), files);
    assert.equal(ruleOf(advise.adviseConfig(projectDir), 'plan_chunked').fired, false);
  });
});

// ─── CLI and surfaces ────────────────────────────────────────────────────────

describe('config-advise CLI and surfaces', () => {
  let projectDir;
  let agentsDir;

  beforeEach(() => {
    projectDir = createTempProject('gsd-advise-cli-');
    agentsDir = createTempDir('gsd-advise-cli-agents-');
    const files = {};
    for (let i = 1; i <= T.PLANS_PER_PHASE; i++) files[`01-0${i}-PLAN.md`] = plan(i);
    phase(projectDir, '01-big', files);
  });

  afterEach(() => {
    cleanup(projectDir);
    cleanup(agentsDir);
  });

  const env = () => ({ GSD_AGENTS_DIR: agentsDir });

  test('--json prints the ConfigAdvice object', () => {
    const r = runGsdTools(['config-advise', '--json'], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    const json = JSON.parse(r.output);
    assert.equal(json.count, 1);
    assert.equal(json.recommendations[0].rule, 'plan_chunked');
    assert.equal(typeof json.recommendations[0].reason, 'string');
    assert.equal(typeof json.recommendations[0].command, 'string');
    assert.equal(json.rules.length, 5);
    assert.equal(typeof json.summary, 'string');
  });

  test('the query form reaches the same verb', () => {
    const r = runGsdTools(['query', 'config-advise', '--json'], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    assert.equal(JSON.parse(r.output).count, 1);
  });

  test('without --json it prints the human report', () => {
    const r = runGsdTools(['config-advise'], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    assert.deepEqual(r.output.split('\n').slice(0, 2).map((l) => l.trim().split(' ')[0]), ['Config', '1.']);
  });

  test('init progress carries config_advice {count, summary}', () => {
    const r = runGsdTools(['init', 'progress'], projectDir, env());
    assert.equal(r.exitCode, 0, r.error);
    const json = JSON.parse(r.output);
    assert.equal(json.config_advice.count, 1);
    assert.equal(json.config_advice.summary, advise.adviseConfig(projectDir).summary);
  });

  test('validate health reports I011 as info and does not change status for it', () => {
    const before = JSON.parse(runGsdTools(['validate', 'health'], projectDir, env()).output);
    const i011 = before.info.filter((i) => i.code === 'I011');
    assert.equal(i011.length, 1);
    assert.equal(i011[0].fix, 'gsd-tools config-advise');
    assert.equal(before.warnings.some((w) => w.code === 'I011'), false);
    writeConfig(projectDir, { workflow: { plan_chunked: true }, planning: { chunked_parallel: true } });
    const after = JSON.parse(runGsdTools(['validate', 'health'], projectDir, env()).output);
    assert.equal(after.info.some((i) => i.code === 'I011'), false, 'nothing to advise → no I011');
  });
});
