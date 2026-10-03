'use strict';

/**
 * run-log-report.mjs — reads .planning/RUN-LOG.jsonl and reports how the last
 * run went.
 *
 * Not wired to any gate: it is a reporting tool, and its exit code is what a
 * human or a script reads to decide whether a run needs looking at. That makes
 * the three codes the whole contract, and the distinction between 1 and 2 the
 * part worth holding — an absent log is "could not look", never "the run was
 * clean". In this fork that difference is not academic: `rg` is a shell function
 * rather than a binary, so a subshell that calls it gets empty output and exit
 * 0, which reads as "found nothing". Every script here is written so that shape
 * of mistake is impossible, and these tests keep it that way for this one.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');

const SCRIPT = path.join(
  __dirname,
  '..',
  'capabilities',
  'mn-verify-gate',
  'scripts',
  'run-log-report.mjs',
);

/** Bounds one run of the gate script against a small temp fixture. */
const RUN_TIMEOUT_MS = 30000;

const CLEAN = 0;
const BLOCKED = 1;
const CANNOT_LOOK = 2;

describe('run-log-report', () => {
  let repo;
  let logPath;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-run-log-'));
    fs.mkdirSync(path.join(repo, '.planning'), { recursive: true });
    logPath = path.join(repo, '.planning', 'RUN-LOG.jsonl');
  });

  afterEach(() => {
    cleanup(repo);
  });

  /** One JSONL line per event, which is the format the script consumes. */
  function writeLog(events) {
    fs.writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  function run(extra = []) {
    return runNode([SCRIPT, '--log', logPath, ...extra], { cwd: repo, timeoutMs: RUN_TIMEOUT_MS });
  }

  test('exits 2 when the log does not exist', () => {
    // The distinction that matters: no log is "could not look". Reporting a
    // clean run here would state something nobody observed.
    const r = run();
    assert.equal(
      r.exitCode,
      CANNOT_LOOK,
      `a missing log is unverifiable, not clean: ${r.stdout}${r.stderr}`,
    );
  });

  test('exits 2 when the log is unreadable garbage', () => {
    fs.writeFileSync(logPath, 'this is not JSONL at all\n{{{\n');

    const r = run();
    assert.equal(
      r.exitCode,
      CANNOT_LOOK,
      `an unparseable log must not read as a clean run: ${r.stdout}${r.stderr}`,
    );
  });

  test('exits 0 for a run with no blockers', () => {
    writeLog([
      { run: 'r1', event: 'run_start', ts: '2026-08-08T10:00:00Z' },
      { run: 'r1', event: 'plan', status: 'ok', phase: '01' },
      { run: 'r1', event: 'run_end', status: 'ok', ts: '2026-08-08T10:05:00Z' },
    ]);

    const r = run();
    assert.equal(r.exitCode, CLEAN, `a clean run must report clean: ${r.stdout}${r.stderr}`);
  });

  test('exits 1 when the run hit a blocker', () => {
    writeLog([
      { run: 'r1', event: 'run_start', ts: '2026-08-08T10:00:00Z' },
      { run: 'r1', event: 'blocker', phase: '01', detail: 'waiting on a decision' },
      { run: 'r1', event: 'run_end', status: 'halted', ts: '2026-08-08T10:05:00Z' },
    ]);

    const r = run();
    assert.equal(r.exitCode, BLOCKED, `a blocker must be reported: ${r.stdout}${r.stderr}`);
  });

  test('exits 1 when a gate blocked the run', () => {
    writeLog([
      { run: 'r1', event: 'run_start', ts: '2026-08-08T10:00:00Z' },
      { run: 'r1', event: 'gate', status: 'block', phase: '01', detail: 'workflow.verify_enforce' },
      { run: 'r1', event: 'run_end', status: 'halted', ts: '2026-08-08T10:05:00Z' },
    ]);

    const r = run();
    assert.equal(r.exitCode, BLOCKED, `a gate block must be reported: ${r.stdout}${r.stderr}`);
  });

  test('reports the latest run by default, not the whole history', () => {
    // A report that averaged over every run ever would never go clean again
    // after one bad day.
    writeLog([
      { run: 'old', event: 'run_start', ts: '2026-08-01T10:00:00Z' },
      { run: 'old', event: 'blocker', phase: '01', detail: 'historical failure' },
      { run: 'old', event: 'run_end', status: 'halted', ts: '2026-08-01T10:05:00Z' },
      { run: 'new', event: 'run_start', ts: '2026-08-08T10:00:00Z' },
      { run: 'new', event: 'plan', status: 'ok', phase: '01' },
      { run: 'new', event: 'run_end', status: 'ok', ts: '2026-08-08T10:05:00Z' },
    ]);

    const r = run();
    assert.equal(
      r.exitCode,
      CLEAN,
      `an old failure must not taint the current run: ${r.stdout}${r.stderr}`,
    );
  });
});
