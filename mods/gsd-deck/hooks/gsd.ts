import type { EngineInterface } from 'claude-code'

import type {
  Detail,
  PlanDetail,
  RetroDue,
  MilestoneCard,
  NextAction,
  PhaseCard,
  PhaseRow,
  PlanRow,
  ProjectSummary,
  Requirement,
  Tally,
} from '../types'

// Directories that never hold a project root of their own. Hidden ones are
// skipped too, which keeps `.claude/worktrees/*` copies out of the list.
const SKIP = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'tmp', 'vendor',
  'src', 'lib', 'tests', 'test', 'docs', 'assets', 'public', 'migrations', 'fixtures',
  '__pycache__',
])
const MAX_DEPTH = 4
const MAX_DIRS = 4000
const LIST_BATCH = 24

export function join(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

export function baseName(path: string): string {
  const parts = path.split('/').filter(Boolean)

  return parts[parts.length - 1] ?? path
}

/** A project under the session's directory by its path there; one above it by its own name. */
export function projectName(root: string, dir: string): string {
  return dir === root || dir.startsWith(root + '/') ? relativeTo(root, dir) : baseName(dir)
}

export function parentOf(path: string): string {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')

  return cut <= 0 ? '/' : path.slice(0, cut)
}

const MAX_UP = 8

/**
 * The project the session's directory sits inside, when it is not a project
 * root itself: a session opened in `apps/polyglot/.planning` or in
 * `apps/polyglot/src` belongs to `apps/polyglot`, which a walk down from
 * there never meets.
 */
export async function projectAbove($: EngineInterface, root: string): Promise<string | undefined> {
  const parts = root.split('/')
  const at = parts.lastIndexOf('.planning')
  // Inside a .planning directory the answer is in the path; nothing is read.
  if (at > 0) return parts.slice(0, at).join('/') || '/'
  let dir = parentOf(root)
  for (let step = 0; step < MAX_UP && dir !== '/'; step += 1, dir = parentOf(dir)) {
    if (await $.fs.exists(join(dir, '.planning/STATE.md')).catch(() => false)) return dir
  }

  return undefined
}

/** The checkout the session runs in, and the main one when that is a worktree. */
export type Checkout = { top: string; main: string; branch: string | null; isWorktree: boolean }

export async function gitCheckout($: EngineInterface, cwd: string): Promise<Checkout | undefined> {
  const git = (args: string[]) =>
    $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 5000 }).then(
      ran => (ran.exitCode === 0 ? clean(ran.stdout).trim() : undefined),
      () => undefined,
    )
  const [top, common] = ((await git(['rev-parse', '--show-toplevel', '--git-common-dir'])) ?? '').split('\n')
  if (top === undefined || top === '' || common === undefined || common === '') return undefined
  // A worktree names the main repository's .git absolutely; the main checkout says ".git".
  const commonDir = absolute(top, common)
  const main = baseName(commonDir) === '.git' ? parentOf(commonDir) : top

  return { top, main, branch: (await git(['branch', '--show-current'])) || null, isWorktree: main !== top }
}

export function relativeTo(root: string, dir: string): string {
  if (dir === root) return baseName(root)

  return dir.startsWith(root + '/') ? dir.slice(root.length + 1) : dir
}

// The STATE.md frontmatter is flat YAML with one nested map (`progress:`);
// this reads exactly that much and nothing more.
export function parseFrontmatter(text: string): Record<string, unknown> {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}

  const root: Record<string, unknown> = {}
  let nested: Record<string, unknown> | null = null
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break
    const match = /^(\s*)([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (match === null) continue
    const indent = match[1] ?? ''
    const key = match[2] ?? ''
    const raw = match[3] ?? ''
    if (indent.length > 0 && nested !== null) {
      nested[key] = scalar(raw)
    } else if (raw.trim() === '') {
      nested = {}
      root[key] = nested
    } else {
      nested = null
      root[key] = scalar(raw)
    }
  }

  return root
}

function scalar(raw: string): string | number | null {
  const text = raw.trim()
  if (text === '' || text === 'null' || text === '~') return null
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  // "01" stays a string: phase numbers keep their padding.
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) return Number(text)

  return text
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = String(value).trim()

  return text === '' || text === 'null' || text === 'None' ? null : text
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A top-level frontmatter value as written, not through the scalars:
 * `milestone: 1.10` is version 1.10 and `current_phase: 1.10` phase 1.10,
 * not the number 1.1. Quotes and a trailing `# comment` are dropped.
 */
export function rawField(stateMd: string | undefined, key: string): string | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(stateMd ?? '')?.[1] ?? ''
  const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head)?.[1]?.trim() ?? ''
  const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw)

  return asText(quoted !== null ? quoted[2] : raw.replace(/\s+#.*$/, ''))
}

/** The phase number a hand-written phase field starts with: "7 — polyglot Integration (COMPLETE)" is 7. */
export function phaseToken(phase: string): string {
  return /^\d+(?:\.\d+)*[a-z]?(?=$|[\s—–:(-])/i.exec(phase.trim())?.[0] ?? phase
}

export function toSummary(dir: string, name: string, stateMd: string, checkout: string | null = null): ProjectSummary {
  const fm = parseFrontmatter(stateMd)
  const progress = (typeof fm.progress === 'object' && fm.progress !== null ? fm.progress : {}) as Record<
    string,
    unknown
  >
  const milestoneName = asText(fm.milestone_name)
  const phase = rawField(stateMd, 'current_phase')

  return {
    dir,
    name,
    milestone: rawField(stateMd, 'milestone'),
    // The template's placeholder is the word itself.
    milestoneName: milestoneName === 'milestone' ? null : milestoneName,
    phase: phase === null ? null : phaseToken(phase),
    phaseName: asText(fm.current_phase_name),
    status: asText(fm.status),
    stoppedAt: asText(fm.stopped_at),
    lastActivity: asText(fm.last_activity),
    lastActivityDesc: asText(fm.last_activity_desc),
    totalPhases: asCount(progress.total_phases),
    completedPhases: asCount(progress.completed_phases),
    totalPlans: asCount(progress.total_plans),
    completedPlans: asCount(progress.completed_plans),
    checkout,
  }
}

// gsd-tools speaks the colon spelling; Claude Code installs the skills hyphenated.
export function toCommand(command: string): string {
  return command.replace(/^\/gsd:/, '/gsd-')
}

/** The deepest project whose root holds `path`. */
export function ownerOf(path: string, projects: readonly ProjectSummary[]): ProjectSummary | undefined {
  return projects
    .filter(project => path === project.dir || path.startsWith(project.dir + '/'))
    .sort((a, b) => b.dir.length - a.dir.length)[0]
}

/** The directory a gsd-tools invocation in a Bash command points at, if any. */
export function projectDirFlag(command: string): string | undefined {
  if (!command.includes('gsd-tools')) return undefined
  const match = /--(?:project-dir|cwd)[= ]("[^"]+"|'[^']+'|\S+)/.exec(command)

  return match?.[1] === undefined ? undefined : match[1].replace(/^["']|["']$/g, '')
}

export function absolute(cwd: string, path: string): string {
  const joined = path.startsWith('/') ? path : join(cwd, path)
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }

  return '/' + out.join('/')
}

/** Every directory under `root` (itself included) that holds a `.planning/`. */
export async function discover($: EngineInterface, root: string): Promise<string[]> {
  const found: string[] = []
  let frontier = [root]
  let visited = 0
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length > 0 && visited < MAX_DIRS; depth++) {
    const below: string[] = []
    for (let at = 0; at < frontier.length; at += LIST_BATCH) {
      const batch = frontier.slice(at, at + LIST_BATCH)
      const listed = await Promise.all(
        batch.map(dir =>
          $.fs.list(dir).then(
            entries => ({ dir, entries }),
            () => ({ dir, entries: [] }),
          ),
        ),
      )
      for (const { dir, entries } of listed) {
        visited += 1
        if (entries.some(entry => entry.name === '.planning' && entry.kind === 'dir')) found.push(dir)
        for (const entry of entries) {
          if (entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIP.has(entry.name)) {
            below.push(join(dir, entry.name))
          }
        }
      }
    }
    frontier = below
  }

  return found
}

export async function readSummary(
  $: EngineInterface,
  root: string,
  dir: string,
  checkout: string | null = null,
  rootName?: string,
): Promise<ProjectSummary | undefined> {
  const text = await readText($, join(dir, '.planning/STATE.md'))
  const name = dir === root && rootName !== undefined ? rootName : projectName(root, dir)

  return text === undefined ? undefined : toSummary(dir, name, text, checkout)
}

/** The installed gsd-tools.cjs: the project's own install first, then the user's. */
export async function locateTools($: EngineInterface, cwd: string): Promise<string | undefined> {
  const home = (await $.env.get('HOME')) ?? ''
  const candidates = [
    join(cwd, '.claude/gsd-core/bin/gsd-tools.cjs'),
    join(home, '.claude/gsd-core/bin/gsd-tools.cjs'),
    join(home, '.claude/get-shit-done/bin/gsd-tools.cjs'),
  ]
  for (const candidate of candidates) {
    if (await $.fs.exists(candidate).catch(() => false)) return candidate
  }

  return undefined
}

// One ESC or BEL in a STATE.md would make the engine refuse the whole tree,
// so text from disk and from gsd-tools loses its control characters on entry.
// Newline and tab stay; so does everything printable.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g

export function clean(text: string): string {
  return text.replace(CONTROL, '')
}

function scrub(value: unknown): unknown {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map(scrub)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, scrub(inner)]))
  }

  return value
}

export async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  return $.fs.read(path).then(
    text => (typeof text === 'string' ? clean(text) : ''),
    () => undefined,
  )
}

/**
 * A gsd-tools JSON answer; undefined when it fails. A failing call that
 * says why (`progress json` refusing a malformed VERIFICATION.md) has its
 * first stderr line kept in `errors`, so the panel says it rather than
 * drawing an empty list.
 */
async function runJson($: EngineInterface, tools: string, dir: string, args: string[], errors: string[] = []): Promise<any> {
  const ran = await $.process
    .run(['node', tools, ...args, '--project-dir', dir], { cwd: dir, timeoutMs: 20_000 })
    .catch(() => undefined)
  if (ran === undefined) return undefined
  if (ran.exitCode !== 0) {
    const why = clean(ran.stderr ?? '').split('\n').map(line => line.trim()).find(line => line !== '')
    if (why !== undefined) errors.push(`${args.join(' ')}: ${why.length > 300 ? `${why.slice(0, 299)}…` : why}`)

    return undefined
  }
  try {
    return scrub(JSON.parse(ran.stdout))
  } catch {
    return undefined
  }
}

export type Inspected = { detail: Detail; snapshot: Partial<ProjectSummary> }

export async function inspect($: EngineInterface, tools: string, dir: string): Promise<Inspected | undefined> {
  const toolErrors: string[] = []
  const [entry, progress, snapshot, todos, retro] = await Promise.all([
    runJson($, tools, dir, ['smart-entry', '--json'], toolErrors),
    runJson($, tools, dir, ['progress', 'json'], toolErrors),
    runJson($, tools, dir, ['state-snapshot']),
    runJson($, tools, dir, ['list-todos']),
    runJson($, tools, dir, ['retro', 'due']),
  ])
  if (entry === undefined && progress === undefined && snapshot === undefined) return undefined

  const actions: NextAction[] = Array.isArray(entry?.actions)
    ? entry.actions
        .filter((action: any) => typeof action?.command === 'string')
        .map((action: any) => ({
          label: String(action.label ?? action.id ?? action.command),
          command: toCommand(action.command),
          isRecommended: action.recommended === true,
        }))
    : []
  // progress names a phase by its directory slug ("klyuchi oshibok"); ROADMAP
  // holds the title as written ("Ключи ошибок вместо текста").
  const titles = roadmapTitles((await readText($, join(dir, '.planning/ROADMAP.md'))) ?? '')
  const here: PhaseRow[] = Array.isArray(progress?.phases)
    ? progress.phases.map((phase: any) => ({
        number: String(phase.number ?? ''),
        name: titleOf(titles, String(phase.number ?? '')) ?? String(phase.name ?? ''),
        plans: Number(phase.plans ?? 0),
        summaries: Number(phase.summaries ?? 0),
        status: String(phase.status ?? ''),
        summariesAll: Number(phase.summaries ?? 0),
        farthest: null,
      }))
    : []
  // Work in a GSD repository often lives in plan worktrees and a chain of
  // unmerged branches; counting this checkout alone shows a phase as behind.
  const files = await gatherPlanning($, dir).catch(() => undefined)
  // The current milestone's phase ids from its ROADMAP section (smart-entry #5228).
  const milestonePhases: string[] = Array.isArray(entry?.signals?.milestone_phases) ? entry.signals.milestone_phases.map(String) : []
  const phases = await withVerdicts($, dir, files === undefined ? here : withElsewhere(here, files, titles, milestonePhases))
  const blockers: string[] = Array.isArray(snapshot?.blockers)
    ? snapshot.blockers.map((blocker: unknown) =>
        typeof blocker === 'string' ? blocker : JSON.stringify(blocker),
      )
    : []

  return {
    detail: {
      dir,
      situation: String(entry?.situation ?? 'unknown'),
      summary: String(entry?.summary ?? ''),
      actions,
      phases,
      blockers,
      todos: Number(todos?.count ?? 0),
      isGitDirty: entry?.signals?.git_dirty === true,
      refreshedAt: await $.clock.now(),
      retro: toRetroDue(retro),
      elsewhere: files === undefined ? {} : elsewhereByPlan(files),
      toolErrors,
    },
    snapshot: {
      phase: asText(snapshot?.current_phase) ?? undefined,
      phaseName: asText(snapshot?.current_phase_name) ?? undefined,
      status: asText(snapshot?.status) ?? undefined,
      milestone: asText(progress?.milestone_version) ?? undefined,
      milestoneName: asText(progress?.milestone_name) ?? undefined,
      totalPhases: asCount(entry?.signals?.total_phases) ?? undefined,
    },
  }
}

export function toRetroDue(due: any): RetroDue | null {
  if (typeof due?.due !== 'boolean') return null

  return {
    isDue: due.due,
    trigger: asText(due.trigger),
    phasesSince: asCount(due.phasesSinceRetro) ?? 0,
    cadence: asCount(due.cadencePhases) ?? 0,
    lastRetroAt: asText(due.lastRetro?.at),
    milestone: asText(due.milestone),
    journal: due.reason === 'journal-newer' ? 'newer' : due.reason === 'journal-invalid' ? 'broken' : 'ok',
  }
}

/** Phase numbers compare as numbers: "02" is phase 2, "04.1" its own. */
// A phase id: an integer, dotted decimal parts, an optional letter ("05b").
// Compared part by part: "01" is "1", but "1.10" is not "1.1".
const PHASE_ID = /^(\d+)((?:\.\d+)*)([a-z]?)$/i

function phaseParts(id: string): { numbers: number[]; letter: string } | null {
  const found = PHASE_ID.exec(id.trim())
  if (found === null) return null

  return {
    numbers: [found[1] ?? '', ...(found[2] ?? '').split('.').filter(Boolean)].map(Number),
    letter: (found[3] ?? '').toLowerCase(),
  }
}

export function comparePhase(a: string, b: string): number {
  const left = phaseParts(a)
  const right = phaseParts(b)
  if (left === null || right === null) return a.localeCompare(b)
  for (let at = 0; at < Math.max(left.numbers.length, right.numbers.length); at++) {
    const delta = (left.numbers[at] ?? -1) - (right.numbers[at] ?? -1)
    if (delta !== 0) return delta
  }

  return left.letter.localeCompare(right.letter)
}

export function isSamePhase(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false

  return phaseParts(a) !== null && phaseParts(b) !== null ? comparePhase(a, b) === 0 : a === b
}

/** A `**Label:** value` line of a ROADMAP phase section, either colon placement. */
export function sectionField(section: string, labels: readonly string[]): string | null {
  for (const line of section.split('\n')) {
    const match = /^\*\*([^*]+?):?\*\*:?\s*(.+)$/.exec(line.trim())
    const label = match?.[1]?.trim().toLowerCase()
    if (label !== undefined && labels.includes(label) && match?.[2] !== undefined) return match[2].trim()
  }

  return null
}

/** `04.1-CONTEXT.md` is the phase's CONTEXT; plans and summaries are counted elsewhere. */
export function artifactKind(file: string): string | undefined {
  const match = /^[\d.]+-([A-Z][A-Z0-9-]*)\.md$/.exec(file)
  const kind = match?.[1]

  return kind === undefined || kind === 'PLAN' || kind === 'SUMMARY' ? undefined : kind
}

/** A `## Heading` section of a markdown file, without the heading, up to the next `## `. */
export function markdownSection(text: string, heading: RegExp): string | null {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex(line => /^##\s/.test(line) && heading.test(line.replace(/^##\s+/, '')))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => /^##\s/.test(line))
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim()

  return body === '' ? null : body
}

export async function inspectPhase(
  $: EngineInterface,
  tools: string,
  dir: string,
  phase: string,
): Promise<PhaseCard | undefined> {
  const [roadmap, index, found] = await Promise.all([
    runJson($, tools, dir, ['roadmap', 'get-phase', phase]),
    runJson($, tools, dir, ['phase-plan-index', phase]),
    runJson($, tools, dir, ['find-phase', phase]),
  ])
  if (roadmap?.found !== true && index === undefined) return undefined

  const ready = new Set<string>(Array.isArray(index?.ready_plans) ? index.ready_plans : [])
  const plans: PlanRow[] = Array.isArray(index?.plans)
    ? index.plans.map((plan: any) => ({
        id: String(plan.id ?? ''),
        wave: typeof plan.wave === 'number' ? plan.wave : null,
        objective: String(plan.objective ?? ''),
        taskCount: typeof plan.task_count === 'number' ? plan.task_count : null,
        isDone: plan.has_summary === true,
        isReady: ready.has(String(plan.id)),
        isAutonomous: plan.autonomous === true,
      }))
    : []
  const phaseDir = typeof found?.directory === 'string' ? join(dir, found.directory) : undefined
  const listed = phaseDir === undefined ? [] : await $.fs.list(phaseDir).catch(() => [])
  const artifacts = listed
    .filter(entry => entry.kind === 'file')
    .flatMap(entry => {
      const kind = artifactKind(entry.name)

      return kind === undefined || phaseDir === undefined ? [] : [{ kind, path: join(phaseDir, entry.name) }]
    })
  const section = typeof roadmap?.section === 'string' ? roadmap.section : ''

  return {
    dir,
    phase,
    name: asText(roadmap?.phase_name) ?? asText(found?.phase_name) ?? phase,
    goal: asText(roadmap?.goal),
    mode: asText(roadmap?.mode),
    criteria: Array.isArray(roadmap?.success_criteria) ? roadmap.success_criteria.map(String) : [],
    dependsOn: sectionField(section, ['depends on', 'dependencies']),
    requirements: sectionField(section, ['requirements']),
    plans,
    artifacts,
    hasCheckpoints: index?.has_checkpoints === true,
    phaseDir: phaseDir ?? null,
  }
}

function asTally(value: any): Tally | null {
  return typeof value?.completed === 'number' && typeof value?.total === 'number'
    ? { completed: value.completed, total: value.total }
    : null
}

export async function inspectMilestone(
  $: EngineInterface,
  tools: string,
  dir: string,
): Promise<MilestoneCard | undefined> {
  const planningFile = async (name: string) => (await readText($, join(dir, `.planning/${name}`))) ?? ''
  const [planning, roadmap, state, project] = await Promise.all([
    runJson($, tools, dir, ['planning', 'inspect']),
    planningFile('ROADMAP.md'),
    planningFile('STATE.md'),
    planningFile('PROJECT.md'),
  ])
  if (planning === undefined && roadmap === '') return undefined

  const requirements: Requirement[] = Array.isArray(planning?.requirements)
    ? planning.requirements.map((row: any) => ({
        id: String(row.id ?? ''),
        text: String(row.text ?? ''),
        isComplete: row.complete === true,
        phases: Array.isArray(row.mappedPhases) ? row.mappedPhases.map(String) : [],
      }))
    : []
  const coreValue =
    /\*\*Core value:?\*\*:?\s*(.+)/i.exec(state)?.[1]?.trim() ??
    markdownSection(project, /core value/i)?.split('\n')[0]?.trim() ??
    null

  return {
    dir,
    version: asText(planning?.milestone?.version),
    name: asText(planning?.milestone?.name),
    coreValue,
    overview: markdownSection(roadmap, /^overview/i),
    requirements,
    acceptedPhases: asTally(planning?.progress?.accepted_phases),
    completedPlans: asTally(planning?.progress?.completed_plans),
  }
}

/** Phase titles from ROADMAP's checklist, `- [x] **Phase 111.2: Title**`; the first mention wins. */
// A ROADMAP names a phase in its checklist, bold (colon inside or outside
// the bold) or plain with prose after a spaced dash, or in a heading over the
// phase's section.
const TITLE_LINES = [
  /^\s*-\s*\[[ xX]\]\s*\*\*Phase\s+([\d.]+[a-z]?):\s*(.+?)\*\*/i,
  /^\s*-\s*\[[ xX]\]\s*\*\*Phase\s+([\d.]+[a-z]?):\*\*\s*(.+?)(?:\s+[—–-]\s|$)/i,
  /^\s*-\s*\[[ xX]\]\s*Phase\s+([\d.]+[a-z]?):\s*(.+?)(?:\s+[—–-]\s|$)/i,
  /^#{2,4}\s+Phase\s+([\d.]+[a-z]?):\s*(.+?)\s*$/i,
]

/**
 * Phase titles by number, first mention wins. Shipped milestones sit in
 * `<details>` above the current one (the GSD template), and with restarted
 * numbering their phase 1 is not this one's: a title outside `<details>`
 * wins, one inside is only a fallback.
 */
export function roadmapTitles(text: string): Map<string, string> {
  const open = new Map<string, string>()
  const folded = new Map<string, string>()
  let depth = 0
  for (const line of text.split(/\r?\n/)) {
    depth += (line.match(/<details\b/gi) ?? []).length
    const match = TITLE_LINES.map(pattern => pattern.exec(line)).find(found => found !== null)
    const number = match?.[1]
    const title = match?.[2]?.replace(/\*\*/g, '').trim()
    const into = depth > 0 ? folded : open
    if (number !== undefined && title !== undefined && title !== '' && !into.has(number)) into.set(number, title)
    depth = Math.max(0, depth - (line.match(/<\/details>/gi) ?? []).length)
  }
  for (const [number, title] of folded) if (!open.has(number)) open.set(number, title)

  return open
}

/** "01" in progress is "1" or "01" in ROADMAP. */
export function titleOf(titles: ReadonlyMap<string, string>, number: string): string | undefined {
  for (const [key, title] of titles) if (isSamePhase(key, number)) return title

  return undefined
}

/** A frontmatter list, block (`key:` then `  - a`) or inline (`key: [a, b]`). */
export function frontmatterList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return []
  const end = lines.indexOf('---', 1)
  const head = lines.slice(1, end === -1 ? undefined : end)
  const at = head.findIndex(line => line.startsWith(`${key}:`))
  if (at === -1) return []
  const inline = /^[^:]+:\s*\[(.*)\]\s*$/.exec(head[at] ?? '')?.[1]
  if (inline !== undefined) return inline.split(',').map(unquote).filter(Boolean)
  const items: string[] = []
  for (const line of head.slice(at + 1)) {
    const item = /^\s+-\s+(.*)$/.exec(line)?.[1]
    if (item === undefined) break
    items.push(unquote(item))
  }

  return items
}

function unquote(raw: string): string {
  const text = raw.trim()

  return text.length >= 2 && /^["'].*["']$/.test(text) ? text.slice(1, -1) : text
}

/** The text between `<tag>` and `</tag>`, trimmed. */
export function tagBlock(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  const body = match?.[1]?.trim()

  return body === undefined || body === '' ? null : body
}

/** `must_haves: truths:` items, each one line of what must hold when the plan is done. */
export function planTruths(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex(line => /^\s+truths:\s*$/.test(line))
  if (at === -1) return []
  const indent = (lines[at]?.match(/^\s*/)?.[0].length ?? 0) + 1
  const truths: string[] = []
  for (const line of lines.slice(at + 1)) {
    const item = /^(\s+)-\s+(.*)$/.exec(line)
    if (item === null || (item[1]?.length ?? 0) < indent) break
    truths.push(unquote(item[2] ?? ''))
  }

  return truths
}

export function planTasks(text: string): { name: string; type: string | null }[] {
  const tasks: { name: string; type: string | null }[] = []
  const pattern = /<task(\s[^>]*)?>[\s\S]*?<name>([\s\S]*?)<\/name>/g
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const type = /type="([^"]+)"/.exec(match[1] ?? '')?.[1] ?? null
    tasks.push({ name: (match[2] ?? '').trim().replace(/\s+/g, ' '), type })
  }

  return tasks
}

/** A SUMMARY's `# title` and the paragraph under it. */
export function summaryLead(text: string): { title: string | null; lead: string | null } {
  const body = text.replace(/^---[\s\S]*?\n---\s*\n/, '')
  const lines = body.split(/\r?\n/)
  const at = lines.findIndex(line => /^#\s/.test(line))
  const title = at === -1 ? null : (lines[at] ?? '').replace(/^#\s+/, '').trim()
  const rest = lines.slice(at + 1)
  const start = rest.findIndex(line => line.trim() !== '')
  const paragraph: string[] = []
  for (const line of start === -1 ? [] : rest.slice(start)) {
    if (line.trim() === '' || /^#/.test(line)) break
    paragraph.push(line.trim())
  }

  return { title, lead: paragraph.length > 0 ? paragraph.join(' ') : null }
}

/** The objective's opening paragraph: what the plan does, before Purpose/Output. */
function objectiveLead(objective: string | null): string | null {
  if (objective === null) return null
  const lead = objective.split(/\n\s*\n/)[0]?.replace(/\s+/g, ' ').trim()

  return lead === undefined || lead === '' ? null : lead
}

export async function inspectPlan(
  $: EngineInterface,
  phaseDir: string,
  id: string,
): Promise<PlanDetail | undefined> {
  const plan = await readText($, join(phaseDir, `${id}-PLAN.md`))
  if (plan === undefined) return undefined
  const summary = await readText($, join(phaseDir, `${id}-SUMMARY.md`))
  const files = frontmatterList(plan, 'files_modified')
  const done = summary === undefined ? null : summaryLead(summary)

  return {
    id,
    objective: objectiveLead(tagBlock(plan, 'objective')),
    truths: planTruths(plan),
    tasks: planTasks(plan),
    dependsOn: frontmatterList(plan, 'depends_on'),
    requirements: frontmatterList(plan, 'requirements'),
    files,
    planPath: join(phaseDir, `${id}-PLAN.md`),
    summaryPath: summary === undefined ? null : join(phaseDir, `${id}-SUMMARY.md`),
    summaryTitle: done?.title ?? null,
    summaryLead: done?.lead ?? null,
  }
}

/** One phase's planning files across the repository, by plan id. */
export type PhaseFiles = {
  dir: string
  /** Plan id → where its PLAN was found first: HERE, then a worktree's branch, then a branch. */
  plans: Map<string, string>
  /** Plan id → where its SUMMARY was found first, in the same order. */
  summaries: Map<string, string>
}

export const HERE = 'здесь'

// Any `*-PLAN.md` is a plan, as src/plan-scan.cts has it.
const PLAN_FILE = /^(.+)-(PLAN|SUMMARY)\.md$/
// The phase folder's id: "120", "111.1", "05b".
const PHASE_DIR = /^(\d+(?:\.\d+)*[a-z]?)-/i

/**
 * The plan id a PLAN or SUMMARY file pairs under, as src/core-utils.cts's
 * extractCanonicalPlanId has it: `<phase>-<two digits>` where the name goes
 * on with a slug (`68-01-scaffolding` pairs with `68-01`), else the whole
 * name (`111.1-d31b`, `111.1-b2-1`).
 */
export function canonicalPlanId(base: string): string {
  const parts = base.split('-').filter(Boolean)
  const phase = parts.findIndex(part => /^(?:\d{2,}[a-z]?|\d[a-z])(?:\.\d+)*$/i.test(part))
  const plan = phase === -1 ? undefined : parts[phase + 1]

  return plan !== undefined && /^(?:\d{2}[a-z]?|\d[a-z])(?:\.\d+)*$/i.test(plan) ? `${parts[phase]}-${plan}` : base
}

/** Files under `.planning/phases/<dir>/`, from git or from disk, folded into per-phase sets. */
export function addPlanningFiles(
  into: Map<string, PhaseFiles>,
  paths: readonly string[],
  source: string,
  isKept: (number: string) => boolean = () => true,
): void {
  for (const path of paths) {
    const match = /\.planning\/phases\/([^/]+)\/([^/]+)$/.exec(path)
    const dir = match?.[1]
    const file = PLAN_FILE.exec(match?.[2] ?? '')
    const number = PHASE_DIR.exec(dir ?? '')?.[1]
    if (dir === undefined || number === undefined || file?.[1] === undefined || !isKept(number)) continue
    const id = canonicalPlanId(file[1])
    const phase = into.get(number) ?? { dir, plans: new Map(), summaries: new Map() }
    into.set(number, phase)
    const kind = file[2] === 'PLAN' ? phase.plans : phase.summaries
    if (!kind.has(id)) kind.set(id, source)
  }
}

/** Paths `git status --porcelain` lists as present: added, modified, untracked; never deleted. */
export function presentPaths(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .filter(line => line.length > 3 && !line.slice(0, 2).includes('D'))
    .map(line => {
      const path = line.slice(3)
      const arrow = path.indexOf(' -> ')

      return arrow === -1 ? path : path.slice(arrow + 4)
    })
}

const BRANCHES_READ = 200
const GIT_BATCH = 8

/** The milestone a STATE.md is on; null when it does not say. */
export function milestoneOf(stateMd: string | undefined): string | null {
  return rawField(stateMd, 'milestone')
}

const bareVersion = (milestone: string) => milestone.replace(/^v/i, '')

/**
 * Phase numbers a milestone archive holds, from paths under
 * `.planning/milestones/`: the named milestone's archive only, every archive
 * when none is named. Numbering may restart with a new milestone
 * (`--reset-phase-numbers`), so an older archive's 01 says nothing of this one's.
 */
export function archivedPhases(paths: readonly string[], milestone: string | null = null): string[] {
  return paths.flatMap(path => {
    const found = /\.planning\/milestones\/([^/]+)-phases\/(\d+(?:\.\d+)*[a-z]?)-[^/]+$/i.exec(path)
    const isOurs = milestone === null || (found?.[1] !== undefined && bareVersion(found[1]) === bareVersion(milestone))

    return found?.[2] === undefined || !isOurs ? [] : [found[2]]
  })
}

/**
 * The project's plans across its repository: this checkout (committed and
 * not), the files other worktrees have not committed yet, and every local
 * branch not merged into this checkout. A worktree or branch counts only
 * while its STATE.md is on this checkout's milestone, and never for a phase
 * this checkout has archived: an old branch holds an old milestone's phases.
 * Undefined outside git, or where `.planning` is not tracked and nothing
 * else holds it.
 */
export async function gatherPlanning($: EngineInterface, projectDir: string): Promise<Map<string, PhaseFiles> | undefined> {
  const git = (cwd: string, args: string[]) =>
    $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 10_000 }).then(
      ran => (ran.exitCode === 0 ? clean(ran.stdout) : undefined),
      () => undefined,
    )
  const top = (await git(projectDir, ['rev-parse', '--show-toplevel']))?.trim()
  if (top === undefined || top === '') return undefined
  const rel = projectDir === top ? '' : projectDir.slice(top.length + 1)
  const planning = rel === '' ? '.planning' : `${rel}/.planning`
  const scope = `${planning}/phases`
  const lines = (text: string | undefined) => (text ?? '').split('\n').filter(Boolean)
  const into = new Map<string, PhaseFiles>()

  // This checkout first, so a plan done here is attributed here.
  addPlanningFiles(into, lines(await git(top, ['ls-tree', '-r', '--name-only', 'HEAD', '--', scope])), HERE)
  addPlanningFiles(into, presentPaths((await git(top, ['status', '--porcelain', '--untracked-files=all', '--', scope])) ?? ''), HERE)

  const milestone = milestoneOf(await readText($, join(projectDir, '.planning/STATE.md')))
  const isOnMilestone = (stateMd: string | undefined) => {
    const theirs = milestoneOf(stateMd)

    return milestone === null || (theirs !== null && bareVersion(theirs) === bareVersion(milestone))
  }
  const archived = archivedPhases(lines(await git(top, ['ls-tree', '-r', '-d', '--name-only', 'HEAD', '--', `${planning}/milestones`])), milestone)
  const isLive = (number: string) => !archived.some(one => isSamePhase(one, number))

  // What other worktrees have written but not committed.
  const worktrees: { path: string; branch: string }[] = []
  let path: string | undefined
  for (const line of lines(await git(top, ['worktree', 'list', '--porcelain']))) {
    if (line.startsWith('worktree ')) path = line.slice(9)
    if (line.startsWith('branch ') && path !== undefined && path !== top) {
      worktrees.push({ path, branch: line.slice(7).replace(/^refs\/heads\//, '') })
    }
  }
  for (let at = 0; at < worktrees.length; at += GIT_BATCH) {
    const batch = worktrees.slice(at, at + GIT_BATCH)
    const found = await Promise.all(
      batch.map(tree =>
        Promise.all([
          git(tree.path, ['status', '--porcelain', '--untracked-files=all', '--', scope]),
          readText($, join(tree.path, `${planning}/STATE.md`)),
        ]),
      ),
    )
    batch.forEach((tree, index) => {
      const [status, state] = found[index] ?? []
      if (isOnMilestone(state)) addPlanningFiles(into, presentPaths(status ?? ''), tree.branch, isLive)
    })
  }

  // Every branch that holds commits this checkout has not merged.
  const branches = lines(await git(top, ['for-each-ref', '--no-merged=HEAD', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'])).slice(0, BRANCHES_READ)
  // Their STATE.md first: a branch on another milestone costs one read, not two.
  const onMilestone: string[] = []
  for (let at = 0; at < branches.length; at += GIT_BATCH) {
    const batch = branches.slice(at, at + GIT_BATCH)
    const states = milestone === null ? [] : await Promise.all(batch.map(branch => git(top, ['show', `${branch}:${planning}/STATE.md`])))
    batch.forEach((branch, index) => {
      if (milestone === null || isOnMilestone(states[index])) onMilestone.push(branch)
    })
  }
  for (let at = 0; at < onMilestone.length; at += GIT_BATCH) {
    const batch = onMilestone.slice(at, at + GIT_BATCH)
    const found = await Promise.all(batch.map(branch => git(top, ['ls-tree', '-r', '--name-only', branch, '--', scope])))
    batch.forEach((branch, index) => addPlanningFiles(into, lines(found[index]), branch, isLive))
  }

  return withoutOrphans(into)
}

/** A summary counts for a plan some source holds; a task's own summary (`d01-T1`) is no plan done. */
export function withoutOrphans(into: Map<string, PhaseFiles>): Map<string, PhaseFiles> {
  for (const phase of into.values()) {
    for (const id of [...phase.summaries.keys()]) if (!phase.plans.has(id)) phase.summaries.delete(id)
  }

  return into
}

/** Plans done only outside this checkout, by the source holding each. */
function doneElsewhere(phase: PhaseFiles): string[] {
  return [...phase.summaries].filter(([id, source]) => source !== HERE && phase.plans.has(id)).map(([, source]) => source)
}

/** The source holding most of a phase's plans done outside this checkout. */
function farthestSource(phase: PhaseFiles): string | null {
  const counts = new Map<string, number>()
  for (const source of doneElsewhere(phase)) counts.set(source, (counts.get(source) ?? 0) + 1)
  let best: string | null = null
  for (const [source, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = source

  return best
}

// The ladder of src/phase-status.cts, lower to higher.
const LADDER = ['Not Started', 'Pending', 'Planned', 'In Progress', 'Executed', 'Needs Review', 'Complete']

/**
 * This checkout's rows are gsd-tools' own, counts and all: its pairing
 * rules (superseded plans, blocked summaries) are not redone here. Other
 * worktrees and branches add only what this checkout has no file for: a
 * plan planned or done there alone. A phase gsd-tools does not list is added
 * only where the current milestone's ROADMAP names it and its plans come
 * from elsewhere; an old milestone's folder still under `phases/` is not one.
 */
export function withElsewhere(
  rows: readonly PhaseRow[],
  files: ReadonlyMap<string, PhaseFiles>,
  titles: ReadonlyMap<string, string>,
  milestonePhases: readonly string[] = [],
): PhaseRow[] {
  const seen = new Set<string>()
  const merged = rows.map(row => {
    const entry = [...files.entries()].find(([number]) => isSamePhase(number, row.number))
    if (entry === undefined) return row
    seen.add(entry[0])
    const phase = entry[1]
    const plans = row.plans + [...phase.plans.values()].filter(source => source !== HERE).length
    const summariesAll = Math.min(plans, row.summaries + doneElsewhere(phase).length)

    return { ...row, plans, summariesAll, farthest: summariesAll > row.summaries ? farthestSource(phase) : null, status: promoted(row.status, summariesAll, plans) }
  })
  const added = [...files.entries()]
    .filter(
      ([number, phase]) =>
        !seen.has(number) &&
        milestonePhases.some(one => isSamePhase(one, number)) &&
        [...phase.plans.values()].some(source => source !== HERE),
    )
    .map(([number, phase]) => {
      const summaries = [...phase.summaries].filter(([id, source]) => source === HERE && phase.plans.has(id)).length
      const summariesAll = summaries + doneElsewhere(phase).length

      return {
        number,
        name: titleOf(titles, number) ?? phase.dir.replace(PHASE_DIR, '').replace(/-/g, ' '),
        plans: phase.plans.size,
        summaries,
        status: promoted('Not Started', summariesAll, phase.plans.size),
        summariesAll,
        farthest: summariesAll > summaries ? farthestSource(phase) : null,
      }
    })

  return [...merged, ...added].sort((a, b) => comparePhase(a.number, b.number))
}

/** The panel's own step for an executed phase whose verifier found gaps; gsd-tools calls it Executed. */
export const GAPS_FOUND = 'Gaps Found'

/**
 * An executed phase whose VERIFICATION.md says `gaps_found` is shown as such:
 * smart-entry then says "verification failed", and the list must say where.
 */
export async function withVerdicts($: EngineInterface, projectDir: string, rows: readonly PhaseRow[]): Promise<PhaseRow[]> {
  if (!rows.some(row => row.status === 'Executed')) return [...rows]
  const root = join(projectDir, '.planning/phases')
  const dirs = await $.fs.list(root).then(
    entries => entries.filter(entry => entry.kind === 'dir').map(entry => entry.name),
    () => [] as string[],
  )

  return Promise.all(
    rows.map(async row => {
      if (row.status !== 'Executed') return row
      const dir = phaseDirOf(dirs, row)
      if (dir === undefined) return row
      const names = await $.fs.list(join(root, dir)).then(
        entries => entries.map(entry => entry.name),
        () => [] as string[],
      )
      const token = PHASE_DIR.exec(dir)?.[1] ?? row.number
      // The phase's own report first, as gsd-core reads it; else the first by name.
      const report = names.find(name => name === `${token}-VERIFICATION.md`) ?? names.filter(name => name.endsWith('-VERIFICATION.md')).sort()[0]
      const text = report === undefined ? undefined : await readText($, join(join(root, dir), report))
      const verdict = text === undefined ? null : asText(parseFrontmatter(text).status)

      return verdict === 'gaps_found' ? { ...row, status: GAPS_FOUND } : row
    }),
  )
}

/** A row's folder: the one with its id, and of two with the same id, the one with its name. */
function phaseDirOf(dirs: readonly string[], row: PhaseRow): string | undefined {
  const same = dirs.filter(name => isSamePhase(PHASE_DIR.exec(name)?.[1] ?? null, row.number)).sort()
  const words = (name: string) => name.replace(PHASE_DIR, '').replace(/-/g, ' ').toLowerCase()

  return same.find(name => words(name) === row.name.toLowerCase()) ?? same[0]
}

/** A status never reads as behind the summaries found anywhere; it never claims acceptance. */
function promoted(status: string, summaries: number, plans: number): string {
  const floor = plans > 0 && summaries >= plans ? 'Executed' : summaries > 0 ? 'In Progress' : status
  const rank = (word: string) => LADDER.indexOf(word)

  return rank(floor) > rank(status) ? floor : status
}

export function elsewhereByPlan(files: ReadonlyMap<string, PhaseFiles>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [number, phase] of files) {
    for (const [id, source] of phase.summaries) {
      if (source === HERE) continue
      out[number] = { ...(out[number] ?? {}), [id]: source }
    }
  }

  return out
}
