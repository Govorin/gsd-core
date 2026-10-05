#!/usr/bin/env node
'use strict';

/**
 * Report A/B experiment (sync plan task 4.9) — the reviewer runs.
 *
 * Each run is one headless `claude -p` call that sees ONE variant of ONE fixture and nothing
 * else:
 *   - cwd is a fresh mkdtemp directory outside the repo holding only that report;
 *   - the report is passed on stdin, and the session has no tools at all (`--tools ""`), no MCP
 *     (`--strict-mcp-config`), no user/project settings, hooks or CLAUDE.md
 *     (`--setting-sources ""`), and a fixed system prompt that replaces the default one;
 *   - nothing in the prompt, the directory name or the report names the variant.
 * The ground truth never leaves the generator's output directory.
 *
 * Runs are executed in a seeded shuffled order (so time-of-day drift spreads over all variants),
 * a few at a time, and appended to <out>/runs-<model>.jsonl as they finish. A rerun skips the
 * (fixture, variant, rep) keys already recorded, so an interrupted batch resumes.
 *
 * `--mode` picks the artifact and the system prompt: `plan` (4.9, the default: phase plans,
 * variants A,B,C, ./out), `window` (pocock wave 3: a window of commits, variants A,C,Cp,
 * ./out-window) or `arch` (pocock wave 3: one zone for the architecture surveyor, variants
 * A,C,Cp,D,D2, ./out-arch).
 *
 * Usage:
 *   node scripts/experiments/report-ab/run.cjs [--mode plan|window|arch] [--out <dir>] [--reps 3]
 *        [--concurrency 4] [--fixtures f1,f2] [--variants A,B,C] [--model sonnet] [--runs <file>]
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SYSTEM_PROMPT = [
  'You review the plans of one software-project phase before they are executed.',
  'Plans run in waves: every plan in a wave runs in parallel, and a wave starts only after the previous one finished.',
  'Find every problem in the artifact that would make the phase execute incorrectly or report a false state.',
  'Report only problems the artifact itself supports; do not invent any. If there are none, return an empty list.',
  '',
  'Answer with ONLY a JSON object, no prose and no code fence:',
  '{"findings":[{"kind":"<kind>","plans":["<plan id>",...],"files":["<path>",...],"description":"<one sentence>"}]}',
  '',
  'kind is exactly one of: dependency_cycle, unknown_reference, wave_order, missing_dependency,',
  'status_inconsistency, file_conflict, vague_task, missing_verification, scope, other.',
  'plans lists EVERY plan id involved in the problem (e.g. "03-04"); files may be empty.',
].join('\n');

// Mode `window` (pocock wave 3): the reviewer reads one window of commits — the log, the earlier
// window reviews, the cumulative diff and the source at the tip — with or without the pre-pass.
// The kinds name every seeded class, padded with distractors, in no telling order.
const WINDOW_SYSTEM_PROMPT = [
  'You review the work that landed on a TypeScript service during one window of commits: the cumulative change across the window, not one commit at a time.',
  'Find every problem the window introduced or left in place: defects in behaviour, and the cumulative degradation that reviewing one change at a time misses.',
  'Report only problems the artifact itself supports; do not invent any. If there are none, return an empty list.',
  '',
  'Answer with ONLY a JSON object, no prose and no code fence:',
  '{"findings":[{"kind":"<kind>","files":["<path>",...],"symbol":"<function or export name, or empty>","description":"<one sentence>"}]}',
  '',
  'kind is exactly one of: logic_error, complexity_growth, duplicated_logic, unused_export, contract_violation,',
  'churn_hotspot, recurring_issue, security, naming, missing_test, style, other.',
  'files lists EVERY file involved in the problem, as repository paths (e.g. "src/orders/service.ts").',
].join('\n');

// Mode `arch`: the surveyor's role from agents/gsd-arch-surveyor.md, condensed, with its card
// vocabulary as the closed kind list. The metrics (and the "checked only" block) are variant data.
const ARCH_SYSTEM_PROMPT = [
  'You survey one zone of a TypeScript codebase and note where its structure makes change expensive: where understanding one concept means bouncing between many small modules, where a module\'s interface is nearly as complex as its implementation, where a seam leaks.',
  'Turn what you find into candidates for deepening — refactors that put more behaviour behind a smaller interface. One candidate per problem; two problems over the same files are two candidates only if they are different kinds of friction.',
  'Report only problems the artifact itself supports. "Nothing strong here" is a full result: return an empty list rather than manufacture a candidate.',
  '',
  'Answer with ONLY a JSON object, no prose and no code fence:',
  '{"findings":[{"kind":"<kind>","files":["<path>",...],"strength":"strong|worth-exploring|speculative","description":"<one sentence: the friction and what deepening would buy>"}]}',
  '',
  'kind is exactly one of: shallow-module, pass-through, scattered-concept, no-locality, leaky-seam, untestable-interface, cycle, smeared-change, other.',
  'files lists EVERY module involved, as repository paths (e.g. "src/orders/service.ts").',
].join('\n');

const MODES = Object.freeze({
  plan: { systemPrompt: SYSTEM_PROMPT, userPrefix: 'Review this artifact.\n\n', out: 'out', variants: 'A,B,C' },
  window: { systemPrompt: WINDOW_SYSTEM_PROMPT, userPrefix: 'Review this artifact.\n\n', out: 'out-window', variants: 'A,C,Cp' },
  arch: { systemPrompt: ARCH_SYSTEM_PROMPT, userPrefix: 'Survey this zone.\n\n', out: 'out-arch', variants: 'A,C,Cp,D,D2' },
});

const RUN_TIMEOUT_MS = 300_000;

function args(argv) {
  const get = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : dflt;
  };
  const modeName = get('--mode', 'plan');
  const mode = MODES[modeName];
  if (!mode) throw new Error(`--mode must be one of ${Object.keys(MODES).join(', ')}, got ${modeName}`);
  return {
    mode: modeName,
    systemPrompt: mode.systemPrompt,
    userPrefix: mode.userPrefix,
    out: path.resolve(get('--out', path.join(__dirname, mode.out))),
    reps: Number(get('--reps', '3')),
    concurrency: Number(get('--concurrency', '4')),
    fixtures: get('--fixtures', null),
    variants: get('--variants', mode.variants).split(','),
    model: get('--model', 'sonnet'),
    seed: Number(get('--seed', '49')),
    runs: get('--runs', null),
  };
}

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

/** The reviewer's text → its findings, or null when it is not the JSON object asked for. */
function parseFindings(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(obj.findings) ? obj.findings : null;
  } catch {
    return null;
  }
}

function runOne(job, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-'));
  fs.writeFileSync(path.join(dir, 'REPORT.md'), job.report);
  const cliArgs = [
    '-p',
    '--model', opts.model,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--system-prompt', opts.systemPrompt,
    '--no-session-persistence',
    '--output-format', 'json',
    '--max-budget-usd', '1',
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('claude', cliArgs, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      let res = null;
      try {
        res = JSON.parse(stdout);
      } catch {
        res = null;
      }
      const text = res && typeof res.result === 'string' ? res.result : null;
      const findings = parseFindings(text);
      resolve({
        fixture: job.fixture,
        variant: job.variant,
        rep: job.rep,
        ok: code === 0 && findings !== null,
        exit_code: code,
        wall_ms: Date.now() - started,
        duration_ms: res ? res.duration_ms : null,
        cost_usd: res ? res.total_cost_usd : null,
        input_tokens: res && res.usage ? res.usage.input_tokens : null,
        cache_creation_input_tokens: res && res.usage ? res.usage.cache_creation_input_tokens : null,
        cache_read_input_tokens: res && res.usage ? res.usage.cache_read_input_tokens : null,
        output_tokens: res && res.usage ? res.usage.output_tokens : null,
        model: res && res.modelUsage ? Object.keys(res.modelUsage) : null,
        findings,
        raw: text,
        stderr: stderr.slice(0, 2000),
      });
    });
    child.stdin.end(opts.userPrefix + job.report);
  });
}

async function main() {
  const opts = args(process.argv.slice(2));
  const truth = JSON.parse(fs.readFileSync(path.join(opts.out, 'ground-truth.json'), 'utf8'));
  const fixtures = opts.fixtures ? opts.fixtures.split(',') : Object.keys(truth.fixtures);
  const runsPath = path.join(opts.out, opts.runs ?? `runs-${opts.model}.jsonl`);
  const done = new Set();
  if (fs.existsSync(runsPath)) {
    for (const line of fs.readFileSync(runsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (r.ok) done.add(`${r.fixture}/${r.variant}/${r.rep}`);
    }
  }

  const jobs = [];
  for (const fixture of fixtures) {
    for (const variant of opts.variants) {
      const report = fs.readFileSync(path.join(opts.out, 'reports', fixture, `${variant}.md`), 'utf8');
      for (let rep = 1; rep <= opts.reps; rep++) {
        if (!done.has(`${fixture}/${variant}/${rep}`)) jobs.push({ fixture, variant, rep, report });
      }
    }
  }
  const rnd = mulberry32(opts.seed);
  for (let i = jobs.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [jobs[i], jobs[j]] = [jobs[j], jobs[i]];
  }

  process.stdout.write(`${jobs.length} run(s) to do, ${done.size} already recorded\n`);
  let next = 0;
  let finished = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const rec = await runOne(job, opts);
      fs.appendFileSync(runsPath, JSON.stringify(rec) + '\n');
      finished += 1;
      process.stdout.write(
        `[${finished}/${jobs.length}] ${rec.fixture}/${rec.variant}/${rec.rep} ok=${rec.ok} findings=${rec.findings ? rec.findings.length : '-'} ${rec.wall_ms}ms $${rec.cost_usd}\n`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}

module.exports = { SYSTEM_PROMPT, WINDOW_SYSTEM_PROMPT, ARCH_SYSTEM_PROMPT, MODES, parseFindings };
