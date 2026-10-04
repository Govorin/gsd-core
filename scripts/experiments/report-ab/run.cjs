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
 * Usage:
 *   node scripts/experiments/report-ab/run.cjs [--out <dir>] [--reps 3] [--concurrency 4]
 *        [--fixtures f1,f2] [--variants A,B,C] [--model sonnet] [--runs <file>]
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

const USER_PREFIX = 'Review this artifact.\n\n';
const RUN_TIMEOUT_MS = 300_000;

function args(argv) {
  const get = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i > -1 ? argv[i + 1] : dflt;
  };
  return {
    out: path.resolve(get('--out', path.join(__dirname, 'out'))),
    reps: Number(get('--reps', '3')),
    concurrency: Number(get('--concurrency', '4')),
    fixtures: get('--fixtures', null),
    variants: get('--variants', 'A,B,C').split(','),
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
    '--system-prompt', SYSTEM_PROMPT,
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
    child.stdin.end(USER_PREFIX + job.report);
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

module.exports = { SYSTEM_PROMPT, parseFindings };
