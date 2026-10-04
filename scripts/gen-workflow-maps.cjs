#!/usr/bin/env node
'use strict';

/**
 * Generates `docs/reference/workflow-maps/<workflow>.md` — one map per shipped
 * workflow that has a unit (`<step>`, `gsd:section`, H2 of `<process>`) or a
 * spawn — and the index `docs/reference/workflow-maps/README.md` (phase 5.5).
 *
 * The logic lives in `src/workflow-map.cts` (compiled to
 * `gsd-core/bin/lib/workflow-map.cjs`); this script only reads the committed
 * inputs and writes or compares the documents:
 *
 *   - `gsd-core/workflows/*.md` and the fragment files they reference
 *   - `agents/*.md` (which agent names exist)
 *   - `capability-registry.cjs`: `byAgent` (capability agents) and
 *     `byLoopPoint` (the capability steps hung on each loop point)
 *   - `loop-host-contract.cjs`: the loop points that exist
 *   - `gsd-core/workflows/section-manifest.json`: the section fragments
 *
 * Usage:
 *   node scripts/gen-workflow-maps.cjs                      # print the index to stdout
 *   node scripts/gen-workflow-maps.cjs --write              # rewrite docs/reference/workflow-maps/
 *   node scripts/gen-workflow-maps.cjs --check              # exit 1 if any map is stale, missing or extra
 *   node scripts/gen-workflow-maps.cjs --check --target <dir>  # test-only: another directory
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const DOC_DIR_REL = 'docs/reference/workflow-maps';
const DOC_DIR = path.join(ROOT, DOC_DIR_REL);
const LIB_DIR = path.join(ROOT, 'gsd-core', 'bin', 'lib');
const WORKFLOWS_REL = 'gsd-core/workflows';
const INDEX_FILE = 'README.md';

function loadCompiled(name) {
  const p = path.join(LIB_DIR, `${name}.cjs`);
  if (!fs.existsSync(p)) {
    throw new ExitError(2, `gen-workflow-maps: compiled artifact not found at gsd-core/bin/lib/${name}.cjs.\nRun \`npm run build:lib\` first.`);
  }
  return require(p);
}

/** Read a repo-relative file under gsd-core/workflows/, or null when it does not exist. */
function readWorkflowFile(relPath) {
  const abs = path.resolve(ROOT, relPath);
  const base = path.join(ROOT, WORKFLOWS_REL) + path.sep;
  if (!abs.startsWith(base)) return null;
  try {
    return fs.statSync(abs).isFile() ? fs.readFileSync(abs, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Everything the maps are built from, as plain data — a test can hand in a
 * modified set (a renamed step, a removed agent) without touching the repo.
 */
function loadSources() {
  const registry = loadCompiled('capability-registry');
  const { LOOP_HOST_CONTRACT } = loadCompiled('loop-host-contract');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, WORKFLOWS_REL, 'section-manifest.json'), 'utf8'));
  const workflowsDir = path.join(ROOT, WORKFLOWS_REL);
  const workflows = fs
    .readdirSync(workflowsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((file) => ({
      name: file.replace(/\.md$/, ''),
      path: `${WORKFLOWS_REL}/${file}`,
      text: fs.readFileSync(path.join(workflowsDir, file), 'utf8'),
    }));
  const agents = fs
    .readdirSync(path.join(ROOT, 'agents'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
  const loopHooks = {};
  for (const [point, view] of Object.entries(registry.byLoopPoint)) {
    loopHooks[point] = {
      steps: view.steps.map((s) => ({ capId: s.capId, ref: { ...s.ref } })),
      gates: view.gates.length,
      contributions: view.contributions.length,
    };
  }
  return {
    workflows,
    agents,
    capabilityAgents: Object.keys(registry.byAgent).sort(),
    loopPoints: LOOP_HOST_CONTRACT.flatMap((step) => step.points),
    loopHooks,
    manifest: manifest.workflows,
    readFile: readWorkflowFile,
  };
}

/** `{ maps, files }`: every parsed map, and file name → document text for the output directory. Pure over `sources`. */
function renderWorkflowMaps(sources, wm = loadCompiled('workflow-map')) {
  const base = {
    agents: new Set(sources.agents),
    capabilityAgents: new Set(sources.capabilityAgents),
    loopPoints: new Set(sources.loopPoints),
    loopHooks: sources.loopHooks,
    readFile: sources.readFile,
  };
  const maps = [];
  const skipped = [];
  for (const w of sources.workflows) {
    const map = wm.parseWorkflow(w, { ...base, manifest: sources.manifest[w.name] ?? [] });
    if (wm.hasMap(map)) maps.push(map);
    else skipped.push(w.name);
  }
  const files = new Map();
  for (const map of maps) files.set(`${map.workflow}.md`, wm.renderWorkflowMapDoc(map, sources.loopHooks));
  files.set(INDEX_FILE, wm.renderWorkflowMapsIndex(maps, skipped));
  return { maps, files };
}

function parseArgs(argv) {
  const opts = { write: false, check: false, targetDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--target') {
      const value = argv[i + 1];
      if (value === undefined) throw new ExitError(1, '--target requires a directory argument.');
      opts.targetDir = value;
      i++;
    } else {
      throw new ExitError(1, `unknown flag: ${arg}\nRecognized flags: --write, --check, --target <dir>.`);
    }
  }
  return opts;
}

/** Markdown files currently in the output directory that this generator wrote (first line = its derived marker). */
function generatedFilesIn(dir, marker) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 1)[0] === marker)
    .sort();
}

/** Differences between the expected files and the directory: `{ stale, missing, extra }` (file names). */
function diffDir(dir, files, marker) {
  const stale = [];
  const missing = [];
  for (const [name, text] of files) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) missing.push(name);
    else if (fs.readFileSync(p, 'utf8') !== text) stale.push(name);
  }
  const extra = generatedFilesIn(dir, marker).filter((f) => !files.has(f));
  return { stale, missing, extra };
}

function main() {
  const { write, check, targetDir } = parseArgs(process.argv.slice(2));
  const wm = loadCompiled('workflow-map');
  const marker = loadCompiled('mermaid').derivedMarker(wm.WORKFLOW_MAPS_SOURCE);
  const { files } = renderWorkflowMaps(loadSources(), wm);
  // `--target` exists for test isolation only (as in gen-state-machines.cjs).
  const dir = targetDir ? path.resolve(targetDir) : DOC_DIR;
  const display = targetDir || DOC_DIR_REL;

  if (write) {
    fs.mkdirSync(dir, { recursive: true });
    const { extra } = diffDir(dir, files, marker);
    for (const name of extra) fs.rmSync(path.join(dir, name));
    for (const [name, text] of files) fs.writeFileSync(path.join(dir, name), text, 'utf8');
    process.stdout.write(`Wrote ${files.size} file(s) to ${display}${extra.length > 0 ? `, removed ${extra.length} stale map(s)` : ''}.\n`);
    return 0;
  }
  if (check) {
    const { stale, missing, extra } = diffDir(dir, files, marker);
    if (stale.length + missing.length + extra.length > 0) {
      const list = (label, names) => (names.length > 0 ? `  ${label}: ${names.join(', ')}\n` : '');
      process.stderr.write(
        `${display} does not match gsd-core/workflows/ (a workflow, an agent, the capability registry or the section manifest changed without regeneration):\n` +
          list('stale', stale) +
          list('missing', missing) +
          list('extra', extra) +
          'Run:\n  node scripts/gen-workflow-maps.cjs --write\n\n',
      );
      throw new ExitError(1);
    }
    process.stdout.write(`${display} is up to date (${files.size} file(s)).\n`);
    return 0;
  }
  process.stdout.write(files.get(INDEX_FILE));
  return 0;
}

if (require.main === module) runMain(main);

module.exports = {
  loadSources,
  renderWorkflowMaps,
  parseArgs,
  diffDir,
  DOC_DIR,
  DOC_DIR_REL,
  INDEX_FILE,
};
