#!/usr/bin/env node
'use strict';

/**
 * Generates `docs/reference/loop-hooks-map.md` — capability × loop point (step /
 * gate / contribution), in the order the registry runs them — from committed data
 * only, so the document regenerates byte-for-byte on any machine:
 *
 *   - the Loop Host Contract       gsd-core/bin/lib/loop-host-contract.cjs
 *   - the capability registry      gsd-core/bin/lib/capability-registry.cjs (`byLoopPoint`, `configSchema`, `bySkill`)
 *   - the RAW declarations         capabilities/<id>/capability.json — the registry generator skips a hook on
 *                                  an unknown point or a non-feature capability in silence, so declared vs
 *                                  registered is the only place that loss shows (drawn as `dropped-hook`)
 *   - the host call sites          `loop render-hooks <point>` in HOST_LOOP_FILES, scanned by the SAME
 *                                  `scanWiredKinds` the registry generator's wiring gate uses
 *   - the refs' targets            agents/*.md, commands/gsd/*.md
 *
 * All logic is in src/loop-hooks-map.cts (compiled to gsd-core/bin/lib/loop-hooks-map.cjs by
 * `npm run build:lib`); this script only reads files and writes one.
 *
 * Usage:
 *   node scripts/gen-loop-hooks-map.cjs              # print the document to stdout
 *   node scripts/gen-loop-hooks-map.cjs --write      # rewrite docs/reference/loop-hooks-map.md
 *   node scripts/gen-loop-hooks-map.cjs --check      # exit 1 if the committed document is stale
 *   node scripts/gen-loop-hooks-map.cjs --check --target <path>  # test-only: another file
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const { HOST_LOOP_FILES, scanWiredKinds } = require('./gen-loop-host-contract.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC_REL = 'docs/reference/loop-hooks-map.md';
const DOC_PATH = path.join(ROOT, DOC_REL);
const LIB_DIR = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const SOURCE = 'scripts/gen-loop-hooks-map.cjs';

function loadCompiled(name) {
  const p = path.join(LIB_DIR, `${name}.cjs`);
  if (!fs.existsSync(p)) {
    throw new ExitError(2, `gen-loop-hooks-map: compiled artifact not found at gsd-core/bin/lib/${name}.cjs.\nRun \`npm run build:lib\` first.`);
  }
  return require(p);
}

/** `*.md` basenames of a directory, sorted. */
function markdownNames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name.slice(0, -'.md'.length))
    .sort();
}

/** Every `capabilities/<id>/capability.json`, raw, sorted by id. */
function readDeclared(root) {
  const capDir = path.join(root, 'capabilities');
  const out = [];
  for (const entry of fs.readdirSync(capDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = path.join(capDir, entry.name, 'capability.json');
    if (!fs.existsSync(file)) continue;
    let cap;
    try {
      cap = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new ExitError(1, `gen-loop-hooks-map: capabilities/${entry.name}/capability.json is not JSON: ${e.message}`);
    }
    out.push({
      capId: typeof cap.id === 'string' ? cap.id : entry.name,
      role: String(cap.role),
      steps: Array.isArray(cap.steps) ? cap.steps : [],
      gates: Array.isArray(cap.gates) ? cap.gates : [],
      contributions: Array.isArray(cap.contributions) ? cap.contributions : [],
    });
  }
  return out;
}

/** One host per (workflow file, point): the kinds its `loop render-hooks` dispatch text covers. */
function readHosts(root) {
  const hosts = [];
  for (const rel of HOST_LOOP_FILES) {
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const [point, kinds] of scanWiredKinds(text)) {
      hosts.push({ file: rel, point, kinds: ['step', 'gate', 'contribution'].filter((k) => kinds.has(k)) });
    }
  }
  return hosts;
}

/** The builder's input — plain data, so a test can hand in a modified set. */
function loadSources(root = ROOT) {
  const { LOOP_HOST_CONTRACT } = loadCompiled('loop-host-contract');
  const registry = loadCompiled('capability-registry');
  const skills = [...new Set([...Object.keys(registry.bySkill), ...markdownNames(path.join(root, 'commands', 'gsd'))])].sort();
  return {
    contract: LOOP_HOST_CONTRACT,
    byLoopPoint: registry.byLoopPoint,
    declared: readDeclared(root),
    configKeys: Object.keys(registry.configSchema).sort(),
    agents: markdownNames(path.join(root, 'agents')),
    skills,
    hosts: readHosts(root),
  };
}

function renderLoopHooksMapDoc(sources) {
  const lhm = loadCompiled('loop-hooks-map');
  return lhm.renderLoopHooksMap(lhm.buildLoopHooksMap(sources), sources.contract, SOURCE);
}

function parseArgs(argv) {
  const opts = { write: false, check: false, targetPath: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--target') {
      const value = argv[i + 1];
      if (value === undefined) throw new ExitError(1, '--target requires a path argument.');
      opts.targetPath = value;
      i++;
    } else {
      throw new ExitError(1, `unknown flag: ${arg}\nRecognized flags: --write, --check, --target <path>.`);
    }
  }
  return opts;
}

function main() {
  const { write, check, targetPath } = parseArgs(process.argv.slice(2));
  const expected = renderLoopHooksMapDoc(loadSources());
  // `--target` exists for test isolation only (as in gen-state-machines.cjs).
  const resolvedPath = targetPath ? path.resolve(targetPath) : DOC_PATH;
  const displayPath = targetPath || DOC_REL;

  if (write) {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    fs.writeFileSync(resolvedPath, expected, 'utf8');
    process.stdout.write(`Wrote ${displayPath}.\n`);
    return 0;
  }
  if (check) {
    const current = fs.existsSync(resolvedPath) ? fs.readFileSync(resolvedPath, 'utf8') : null;
    if (current !== expected) {
      process.stderr.write(
        `${displayPath} is ${current === null ? 'missing' : 'stale'} — it does not match the loop host contract, the ` +
          'capability registry, capabilities/*/capability.json or the host workflows.\nRun:\n  node scripts/gen-loop-hooks-map.cjs --write\n\n',
      );
      throw new ExitError(1);
    }
    process.stdout.write(`${displayPath} is up to date.\n`);
    return 0;
  }
  process.stdout.write(expected);
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  loadSources,
  renderLoopHooksMapDoc,
  parseArgs,
  DOC_PATH,
  DOC_REL,
  SOURCE,
};
