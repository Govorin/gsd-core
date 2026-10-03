'use strict';

/**
 * mn-expertise — the capability that carries the project's expertise skills as
 * files, so a checkout works the same on a machine that has never seen them.
 *
 * Before it, `agent_skills` pointed at ~/.claude/skills and ~/.agents/skills —
 * paths that exist on exactly one machine. A clone elsewhere resolved every
 * entry to nothing, silently, and the pipeline ran without the expertise it was
 * configured to use.
 *
 * Two properties are pinned here, and the second is the one that will be broken
 * by accident:
 *
 *   1. The skills resolve from the capability on a HOME with no global skills
 *      directory at all.
 *   2. `skills[]` stays EMPTY. That field declares SURFACE skills — the ones
 *      that become /gsd-* commands and must exist in commands/gsd/. Every
 *      first-party capability keeps the registry a no-op against that manifest
 *      (tests/capability-consumption.test.cjs). Listing the vendored skills
 *      there broke that invariant, and it bought nothing: agent_skills reaches
 *      them by scanning the directory, not by reading the manifest.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runNode } = require('./helpers/process-seam.cjs');
const { cleanup } = require('./helpers.cjs');
const { GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const REPO = path.join(__dirname, '..');
const CAPABILITY_DIR = path.join(REPO, 'capabilities', 'mn-expertise');
const TOOLS = path.join(REPO, 'gsd-core', 'bin', 'gsd-tools.cjs');

describe('mn-expertise capability', () => {
  test('declares no surface skills, keeping the registry a no-op', () => {
    // The manifest IS the deployed contract — the installer and the registry
    // generator both read this JSON.
    const manifest = JSON.parse(fs.readFileSync(path.join(CAPABILITY_DIR, 'capability.json'), 'utf8'));

    assert.deepEqual(
      manifest.skills,
      [],
      'skills[] declares SURFACE skills that must exist in commands/gsd/; the vendored ' +
        'expertise skills are reached through agent_skills instead. Listing them here ' +
        'breaks the registry-is-a-no-op invariant in capability-consumption.test.cjs.',
    );
  });

  test('ships every skill as a real file, not a symlink', () => {
    // Four of these lived in ~/.agents/skills behind symlinks — precisely the
    // machine-shaped dependency the capability removes. A symlink that survived
    // the copy would reintroduce it silently on the machine it was made on.
    const skillsDir = path.join(CAPABILITY_DIR, 'skills');
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });

    assert.ok(entries.length > 0, 'the capability must ship at least one skill');

    for (const entry of entries) {
      const dir = path.join(skillsDir, entry.name);
      assert.ok(
        !fs.lstatSync(dir).isSymbolicLink(),
        `${entry.name} is a symlink — it would not survive a clone onto another machine`,
      );
      assert.ok(
        fs.existsSync(path.join(dir, 'SKILL.md')),
        `${entry.name} has no SKILL.md — an @-include would point at nothing`,
      );
    }
  });

  test('carries no .git directory from the skill it was copied from', () => {
    // Several sources are checkouts of their own. A nested .git would confuse
    // both this repository and anything cloning it.
    const skillsDir = path.join(CAPABILITY_DIR, 'skills');
    const found = [];
    const stack = [skillsDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        if (e.name === '.git') found.push(path.join(dir, e.name));
        else stack.push(path.join(dir, e.name));
      }
    }
    assert.deepEqual(found, [], `nested .git directories must not be vendored: ${found.join(', ')}`);
  });
});

describe('mn-expertise portability', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-portable-home-'));
    projectDir = path.join(fakeHome, 'proj');
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });

    // A machine that has never had a global skills directory, carrying only
    // what a clone would bring.
    const capDest = path.join(fakeHome, '.gsd', 'capabilities', 'mn-expertise');
    fs.mkdirSync(path.dirname(capDest), { recursive: true });
    fs.cpSync(CAPABILITY_DIR, capDest, { recursive: true });
  });

  afterEach(() => {
    cleanup(fakeHome);
  });

  function writeAgentSkills(map) {
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ agent_skills: map }, null, 2),
    );
  }

  function queryAgentSkills(agentType) {
    return runNode([TOOLS, 'query', 'agent-skills', agentType], {
      cwd: projectDir,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, GSD_HOME: fakeHome },
      timeoutMs: GSD_TOOLS_CLI_MODERATE_TIMEOUT_MS,
    });
  }

  test('a vendored skill resolves on a HOME with no global skills directory', () => {
    assert.ok(
      !fs.existsSync(path.join(fakeHome, '.claude', 'skills')),
      'precondition: the fake HOME must have no global skills directory',
    );

    writeAgentSkills({ 'gsd-executor': ['global:quality-typescript'] });
    const r = queryAgentSkills('gsd-executor');

    assert.equal(r.exitCode, 0, `query failed: ${r.stderr}`);
    assert.match(
      r.stdout,
      /mn-expertise[/\\]skills[/\\]quality-typescript[/\\]SKILL\.md/,
      `must resolve from the capability, got: ${r.stdout}`,
    );
    assert.doesNotMatch(r.stderr, /WARNING/, `no entry may be dropped: ${r.stderr}`);
  });

  test('every skill the capability ships is reachable by its bare name', () => {
    // The whole point is that a config written against a personal machine keeps
    // working. Each shipped skill must answer to `global:<name>`.
    const names = fs
      .readdirSync(path.join(CAPABILITY_DIR, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    writeAgentSkills({ 'gsd-executor': names.map((n) => `global:${n}`) });
    const r = queryAgentSkills('gsd-executor');

    assert.equal(r.exitCode, 0, `query failed: ${r.stderr}`);
    const resolved = (r.stdout.match(/SKILL\.md/g) || []).length;
    assert.equal(
      resolved,
      names.length,
      `all ${names.length} shipped skills must resolve, got ${resolved}: ${r.stderr}`,
    );
  });

  test('a name the capability does not ship still fails loudly', () => {
    // The fallback searches; it must not invent. A typo has to stay visible.
    writeAgentSkills({ 'gsd-executor': ['global:not-a-real-skill'] });
    const r = queryAgentSkills('gsd-executor');

    assert.equal(r.exitCode, 0, 'the query itself still succeeds');
    assert.match(r.stderr, /Global skill not found/, 'an unknown name must warn, not resolve');
  });
});
