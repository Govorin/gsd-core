'use strict';

/**
 * Fixtures for the mn-verify-gate gates (`gsd_run check mn-*`): a temp GSD project, numbered phase
 * directories inside it, and the two ways a test reaches a gate —
 *
 *   in-process  `evaluate(...)` returns the `GateResult` (the typed surface most tests pin);
 *   CLI         `runMnCheck(...)` runs `gsd-tools check <verb> ... --raw` and parses the payload
 *               (the surface the workflows read: exit 0, JSON with `block` and `message`).
 *
 * A gate resolves its phase the way the dispatchers name it (a phase number, a phase directory,
 * `--phase N`), so a fixture phase lives where `find-phase` looks: `.planning/phases/NN-slug`.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { createTempProject, runGsdTools } = require('../helpers.cjs');

/** A temp GSD project (`.planning/` present, no git). Pair with `cleanup()` in `afterEach`. */
function createMnProject(prefix = 'gsd-mn-gate-') {
  return createTempProject(prefix);
}

/** Write `{ relativePath: content }` under `dir`, creating parent directories. */
function writeFiles(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/**
 * Create the next numbered phase directory (`01-gate`, `02-gate`, …) in `projectDir` and fill it.
 * Returns `{ phaseDir, phaseNumber }` — `phaseNumber` is the zero-padded token.
 */
function makePhase(projectDir, files = {}, slug = 'gate') {
  const phasesRoot = path.join(projectDir, '.planning', 'phases');
  fs.mkdirSync(phasesRoot, { recursive: true });
  const taken = fs.readdirSync(phasesRoot).length;
  const phaseNumber = String(taken + 1).padStart(2, '0');
  const phaseDir = path.join(phasesRoot, `${phaseNumber}-${slug}`);
  fs.mkdirSync(phaseDir, { recursive: true });
  writeFiles(phaseDir, files);
  return { phaseDir, phaseNumber };
}

/** Write `.planning/config.json` with `workflow` merged in. */
function writeWorkflowConfig(projectDir, workflow) {
  const file = path.join(projectDir, '.planning', 'config.json');
  let config = {};
  if (fs.existsSync(file)) config = JSON.parse(fs.readFileSync(file, 'utf8'));
  config.workflow = { ...(config.workflow || {}), ...workflow };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/**
 * Run `gsd-tools check <verb> <args...> --raw` in `projectDir` and return the parsed payload.
 * A gate verdict always exits 0; a non-zero exit fails the assertion with stderr attached.
 */
function runMnCheck(projectDir, verb, args = []) {
  const r = runGsdTools(['check', verb, ...args, '--raw'], projectDir);
  assert.equal(r.success, true, `check ${verb} must exit 0 with a verdict: ${r.error}`);
  const payload = JSON.parse(r.output);
  assert.equal(typeof payload.block, 'boolean', 'the payload must carry block');
  assert.equal(typeof payload.message, 'string', 'the payload must carry message');
  return payload;
}

/** Run `gsd-tools check <verb> ...` expecting a usage failure; returns the raw result. */
function runMnCheckFailure(projectDir, verb, args = []) {
  const r = runGsdTools(['check', verb, ...args, '--raw'], projectDir);
  assert.notEqual(r.exitCode, 0, `check ${verb} must fail its invocation: ${r.output}`);
  return r;
}

module.exports = {
  createMnProject,
  writeFiles,
  makePhase,
  writeWorkflowConfig,
  runMnCheck,
  runMnCheckFailure,
};
