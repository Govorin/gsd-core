'use strict';

/**
 * The one place that shapes the environment a test child process inherits.
 *
 * Both test runners — scripts/run-tests.cjs (`npm test`, every CI lane) and
 * scripts/affected-tests-lib.cjs (`npm run test:affected`) — call this before
 * spawning `node --test`. It used to live inline in run-tests.cjs only, so the
 * affected runner handed tests the developer's raw shell env: with a real
 * ~/.gsd/defaults.json the config loader's #3532 shadow warning reached the
 * children's stderr, and tests/refactor-trigger-cli.test.cjs went 11 red under
 * test:affected while staying 44/44 under run-tests.cjs. Two runners, one
 * definition of "hermetic".
 *
 * Dev-only test instrumentation: it lives at the top level of scripts/ (not
 * scripts/lib/, which bin/install.js ships to users) and is '!'-excluded from
 * package.json files[] together with the runners that require it.
 */

const { mkdtempSync } = require('node:fs');
const { basename, join } = require('node:path');
const { tmpdir } = require('node:os');

// In-process tests resolve `.planning` via planningDir(cwd), which honours
// GSD_PROJECT/GSD_WORKSTREAM. A developer shell inside a GSD workstream exports
// GSD_WORKSTREAM, which would redirect fixture STATE.md reads away from each
// <tmp>/.planning and silently diverge from the clean CI/Docker env. Strip them
// so a local run matches CI; tests that need them set them explicitly.
const AMBIENT_VARS_STRIPPED = Object.freeze([
  'GSD_PROJECT',
  'GSD_WORKSTREAM',
  'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS',
]);

// Sandbox the overlay home so the loader's global scan ($GSD_HOME/.gsd/capabilities)
// and the global defaults ($GSD_HOME/.gsd/defaults.json) cannot read a developer's
// real installed state during tests (ADR-1244 D2). The prefix doubles as the
// reuse marker below and as run-tests.cjs's sweep reservation.
const GSD_HOME_SANDBOX_PREFIX = 'gsd-test-home-';

/**
 * Make `env` hermetic for test children, IN PLACE.
 *
 * IDEMPOTENT: a nested runner spawn (tests/run-tests-harness.test.cjs, or the
 * affected runner delegating a suite to run-tests.cjs) inherits the sandbox via
 * env and REUSES it, never mkdtemps a fresh dir per invocation — that churned
 * ~20+ temp dirs per harness run and amplified Docker load.
 *
 * `created` tells the caller whether it owns the sandbox and must remove it.
 * The sandbox is created under `tmpRoot`, which defaults to os.tmpdir() read at
 * call time — run-tests.cjs calls this after repointing TMPDIR at its run root,
 * so its sandbox lands (and is removed) inside that root.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ tmpRoot?: string }} [options]
 * @returns {{ gsdHome: string, created: boolean }}
 */
function isolateTestEnv(env, { tmpRoot = tmpdir() } = {}) {
  for (const key of AMBIENT_VARS_STRIPPED) delete env[key];
  const inherited = env.GSD_HOME;
  if (inherited && basename(inherited).startsWith(GSD_HOME_SANDBOX_PREFIX)) {
    return { gsdHome: inherited, created: false };
  }
  env.GSD_HOME = mkdtempSync(join(tmpRoot, GSD_HOME_SANDBOX_PREFIX));
  return { gsdHome: env.GSD_HOME, created: true };
}

module.exports = {
  AMBIENT_VARS_STRIPPED,
  GSD_HOME_SANDBOX_PREFIX,
  isolateTestEnv,
};
