import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, Timer } from 'claude-code'

import type { Activity, Detail, PhaseCard, PhaseRow, PlanDetail, ProjectSummary, RetroDue, View } from '../types'
import {
  absolute,
  baseName,
  discover,
  gitCheckout,
  projectAbove,
  inspect,
  inspectMilestone,
  inspectPhase,
  inspectPlan,
  GAPS_FOUND,
  isSamePhase,
  locateTools,
  ownerOf,
  projectDirFlag,
  readSummary,
  relativeTo,
} from './gsd'

const PANE = 'gsd-deck'
const STALE_DEBOUNCE_MS = 1500
const AGENT_POLL_MS = 3000
const ACTIVITY_KEPT = 12

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const projects = atom({ plugin: 'gsd-deck', key: 'projects' } as const, [], { shape: 'projects-2' })
const focus = atom({ plugin: 'gsd-deck', key: 'focus' } as const, null)
const detail = atom({ plugin: 'gsd-deck', key: 'detail' } as const, null, { shape: 'detail-5' })
const activity = atom({ plugin: 'gsd-deck', key: 'activity' } as const, [], { shape: 'activity-1' })
const isLoading = atom({ plugin: 'gsd-deck', key: 'isLoading' } as const, false)
const isSuggesting = atom({ plugin: 'gsd-deck', key: 'isSuggesting' } as const, true)
const problem = atom({ plugin: 'gsd-deck', key: 'problem' } as const, null)
const HOME: View = { kind: 'home' }
const view = atom({ plugin: 'gsd-deck', key: 'view' } as const, HOME, { shape: 'view-1' })
const phaseCard = atom({ plugin: 'gsd-deck', key: 'phaseCard' } as const, null, { shape: 'phase-card-2' })
const milestoneCard = atom({ plugin: 'gsd-deck', key: 'milestoneCard' } as const, null, { shape: 'milestone-card-1' })
const isCardLoading = atom({ plugin: 'gsd-deck', key: 'isCardLoading' } as const, false)
const expanded = atom({ plugin: 'gsd-deck', key: 'expanded' } as const, null)
const isAllPhases = atom({ plugin: 'gsd-deck', key: 'isAllPhases' } as const, false)
const planDetail = atom({ plugin: 'gsd-deck', key: 'planDetail' } as const, null, { shape: 'plan-detail-1' })
const isOffered = atom({ plugin: 'gsd-deck', key: 'isOffered' } as const, false)

// What the module itself holds; a reload starts it over and session.start refills it.
const deck: {
  isStarted: boolean
  root: string
  tools: string | undefined
  inflight: Promise<void> | undefined
  isAgain: boolean
  staleTimer: Timer | undefined
  // Whether the running turn did GSD work: only then is the next command proposed.
  isTurnGsd: boolean
  // Background work (the walk, gsd-tools, polling) has started.
  isBooted: boolean
  // The arguments a GSD skill was called with, by skill name, until its
  // skill.prompt shows it loaded.
  pendingArgs: Map<string, string>
} = {
  isStarted: false,
  root: '',
  tools: undefined,
  inflight: undefined,
  isAgain: false,
  staleTimer: undefined,
  isTurnGsd: false,
  isBooted: false,
  pendingArgs: new Map(),
}

const isGsd = (name: string | undefined) => name !== undefined && /^gsd[-:]/.test(name)
const focusKey = () => `focus:${deck.root}`
const spotsKey = () => `spots:${deck.root}`

/** Where a project was found: its folder, the checkout root it is named from, the checkout's label. */
// rootName: what a worktree calls its root project, the main checkout's name.
type Spot = { dir: string; top: string; checkout: string | null; rootName?: string }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($, e.cwd, e.isInteractive || e.surface !== null)

    return started
  })

  // /clear, /resume and a fork empty $.state without a new session.start:
  // the deck reads its projects again rather than drawing an empty pane.
  on('classic.SessionStart', async ($, e, next) => {
    const answered = await next(e)
    if (deck.isStarted && e.source !== 'startup' && e.source !== 'compact') void restore($)

    return answered
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'gsd-deck' }, async ($, e) => {
    await startAsked($)
    const word = e.args.trim()
    if (word === 'rescan') {
      await rescan($)
      const count = (await read($, projects)).length

      return { text: `GSD: проектов с .planning найдено ${count}.` }
    }
    if (word === 'suggest') {
      const isOn = await toggleSuggesting($)

      return { text: `GSD: подсказка следующей команды ${isOn ? 'включена' : 'выключена'}.` }
    }
    if (word === 'refresh') void refreshDetail($)
    const phase = /^(?:phase|p|фаза)\s+(\S+)$/i.exec(word)?.[1]
    const isMilestone = /^(?:milestone|m|майлстоун|веха)$/i.test(word)
    if (phase !== undefined) void openPhase($, phase)
    if (isMilestone) void openMilestone($)
    if (word !== '' && word !== 'refresh' && phase === undefined && !isMilestone) {
      const list = await read($, projects)
      const picked = pickProject(list, word)
      if (picked === undefined) {
        return { text: `GSD: проекта «${word}» нет. Есть: ${list.map(one => one.name).join(', ')}.` }
      }
      await setFocus($, picked.dir)
    }
    const opened = await openPane($, true)

    return { text: opened.isPlaced ? 'GSD-панель открыта.' : 'GSD-панель ждёт места: расширьте терминал.' }
  })

  // The hooks below only watch. They read nothing through `$` before `next`,
  // so a tool call or a prompt is never held up by the deck, and a failure of
  // the deck's own is answered by `next(e)`, which replays a call already made.
  on('prompt.submit', ($, e, next) => {
    if (e.command !== undefined && isGsd(e.command.name)) noteArgs(e.command.name, e.command.args)
    void startLate($)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('skill.prompt', async ($, e, next) => {
    const answered = await next(e)
    if (isGsd(e.skill)) {
      deck.isTurnGsd = true
      await pushSkill($, e.skill)
    }

    return answered
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Skill' }, ($, e, next) => {
    if (isGsd(e.skill)) noteArgs(e.skill, e.args ?? '')

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    void watchEdit($, e.file_path, e.agentId)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    void watchEdit($, e.file_path, e.agentId)

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.command.includes('gsd-tools')) void watchTools($, e.command)

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    await finishSkills($, e.isAborted)
    const wasGsd = deck.isTurnGsd
    deck.isTurnGsd = false
    if (wasGsd) void refreshAndSuggest($)

    return done
  })

  // A close from a card goes back to the overview first, as Back does; the
  // next close closes. A close from the overview stands, and the pane does
  // not open itself again this session.
  on('ui.close', async ($, e, next) => {
    if (e.id !== PANE || e.origin.kind !== 'person') return next(e)
    if ((await read($, view)).kind !== 'home') {
      await goHome($)

      return { value: undefined }
    }

    return next(e)
    // A failure here lets the close through, as the pane had no hook.
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const width = Math.max(20, e.props.bodyColumns)
    const place = { width, isFocused: e.props.isFocused, surface: e.surface }
    const shown = await read($, view)
    if (shown.kind === 'phase') return phaseView(ui, $, place, shown.phase)
    if (shown.kind === 'milestone') return milestoneView(ui, $, place)

    return homeView(ui, $, place)
  })
}

function noteArgs(skill: string, args: string): void {
  deck.pendingArgs.set(skill.replace(':', '-'), args)
}

async function pushSkill($: EngineInterface, skill: string): Promise<void> {
  const name = skill.replace(':', '-')
  const label = deck.pendingArgs.get(name) ?? ''
  deck.pendingArgs.delete(name)
  const now = await $.clock.now()
  await pushActivity($, {
    id: `skill-${name}-${now}`,
    kind: 'skill',
    name: `/${name}`,
    label,
    state: 'running',
    startedAt: now,
    endedAt: null,
  })
}

async function watchEdit($: EngineInterface, filePath: string, agentId: string | undefined): Promise<void> {
  await startLate($)
  const path = absolute(deck.root, filePath)
  const owner = ownerOf(path, await read($, projects))
  if (owner === undefined) return
  // A subagent's edits don't steer the person's view.
  if (agentId === undefined) await setFocus($, owner.dir)
  if (path.includes('/.planning/')) {
    deck.isTurnGsd = true
    markStale($, owner.dir)
  }
}

async function watchTools($: EngineInterface, command: string): Promise<void> {
  await startLate($)
  const pointed = projectDirFlag(command)
  const owner = ownerOf(pointed === undefined ? deck.root : absolute(deck.root, pointed), await read($, projects))
  deck.isTurnGsd = true
  markStale($, owner?.dir)
}

// The command is registered whatever the host: the desktop app hosts its Code
// sessions the way the SDK does, so its session.start says not interactive
// and may come before any surface is attached. What costs (the walk,
// gsd-tools, polling) waits for something that draws, or for /gsd-deck.
async function start($: EngineInterface, cwd: string, isDrawn: boolean): Promise<void> {
  if (deck.isStarted) return
  deck.isStarted = true
  deck.root = cwd
  await $.command.register({
    name: 'gsd-deck',
    description: 'GSD-панель: проекты .planning, фаза, планы, следующая команда',
    argumentHint: '[<проект> | phase <N> | milestone | refresh | rescan | suggest]',
  })
  const kept = await $.store.get('isSuggesting')
  if (typeof kept === 'boolean') await update($, isSuggesting, () => kept)
  if (isDrawn) startBackground($, true)
}

function startBackground($: EngineInterface, isOpening: boolean): void {
  if (deck.isBooted) return
  deck.isBooted = true
  $.clock.every(AGENT_POLL_MS, () => void pollAgents($))
  void boot($, isOpening)
}

// Installed into a session already running, the module may never see its
// session.start: the person's next prompt or tool call starts it instead.
// A surface that attached after the start begins the background work then.
async function startLate($: EngineInterface): Promise<void> {
  if (!deck.isStarted) await start($, await $.session.cwd(), false)
  if (!deck.isBooted && (await $.session.surfaces()).length > 0) startBackground($, true)
}

/** /gsd-deck runs whether or not anything was drawn before. */
async function startAsked($: EngineInterface): Promise<void> {
  if (!deck.isStarted) await start($, await $.session.cwd(), false)
  if (!deck.isBooted) {
    startBackground($, false)
    // The command reads the list right away: let the walk land first.
    await loadProjects($, false)
    await chooseFocus($)
  }
}

async function restore($: EngineInterface): Promise<void> {
  if (!deck.isBooted) return
  const kept = await $.store.get('isSuggesting')
  if (typeof kept === 'boolean') await update($, isSuggesting, () => kept)
  await boot($, false)
}

async function boot($: EngineInterface, isOpening: boolean): Promise<void> {
  const hadCache = Array.isArray(await $.store.get(spotsKey()))
  await loadProjects($, false)
  await chooseFocus($)
  // Opened unasked once a session, after the data is in. The engine seats an
  // unasked pane only from 144 columns; below that it waits for /gsd-deck.
  if (isOpening && (await read($, projects)).length > 0 && !(await read($, isOffered))) {
    await update($, isOffered, () => true)
    void openPane($)
  }
  await paintStatus($)
  await refreshDetail($)
  // The cached list showed at once; a fresh walk picks up projects added since.
  if (hadCache) {
    await loadProjects($, true)
    await chooseFocus($)
  }
}

async function loadProjects($: EngineInterface, isRescan: boolean): Promise<void> {
  let spots = (await $.store.get(spotsKey())) as Spot[] | undefined
  // An empty list is no cache: it is what a walk from the wrong place found.
  if (!Array.isArray(spots) || spots.length === 0 || isRescan) {
    spots = await findSpots($)
    await $.store.set(spotsKey(), spots)
  }
  const summaries = await Promise.all(spots.map(spot => readSummary($, spot.top, spot.dir, spot.checkout, spot.rootName)))
  const found = withoutSameMain(summaries.filter((one): one is ProjectSummary => one !== undefined))
  // The checkout the session is in comes first; within it, the latest activity.
  found.sort(
    (a, b) =>
      Number(a.checkout === MAIN_CHECKOUT) - Number(b.checkout === MAIN_CHECKOUT) ||
      (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
  )
  await update($, projects, () => found)
}

const MAIN_CHECKOUT = 'основной'

// Projects are looked for from the root of the checkout, not from the session's
// folder: a session opened in apps/polyglot/.planning still sees the whole
// monorepo. In a git worktree the main checkout's projects are listed too.
/**
 * The main checkout's copy of a project is listed only where it says
 * something the worktree's copy does not: the same phase, status and plans
 * twice is noise, thirteen times over in a monorepo.
 */
export function withoutSameMain(list: readonly ProjectSummary[]): ProjectSummary[] {
  const said = (one: ProjectSummary) => [one.name, one.phase, one.status, one.completedPlans, one.totalPlans].join('\u0000')
  const inWorktree = new Set(list.filter(one => one.checkout !== MAIN_CHECKOUT).map(said))

  return list.filter(one => one.checkout !== MAIN_CHECKOUT || !inWorktree.has(said(one)))
}

async function findSpots($: EngineInterface): Promise<Spot[]> {
  const checkout = await gitCheckout($, deck.root)
  if (checkout === undefined) {
    const above = await projectAbove($, deck.root)
    const dirs = [...new Set([...(above === undefined ? [] : [above]), ...(await discover($, deck.root))])]

    return dirs.map(dir => ({ dir, top: deck.root, checkout: null }))
  }
  const label = checkout.isWorktree ? `ветка ${checkout.branch ?? baseName(checkout.top)}` : null
  const rootName = checkout.isWorktree ? baseName(checkout.main) : undefined
  const here = (await discover($, checkout.top)).map(dir => ({ dir, top: checkout.top, checkout: label, rootName }))
  const main = checkout.isWorktree
    ? (await discover($, checkout.main)).map(dir => ({ dir, top: checkout.main, checkout: MAIN_CHECKOUT }))
    : []

  return [...here, ...main]
}

async function rescan($: EngineInterface): Promise<void> {
  await loadProjects($, true)
  await chooseFocus($)
  void refreshDetail($)
}

async function reloadSummary($: EngineInterface, dir: string): Promise<void> {
  const fresh = await readSummary($, deck.root, dir)
  if (fresh === undefined) return
  // The name and the checkout label came from the walk, which knows the checkout.
  await update($, projects, list => list.map(one => (one.dir === dir ? { ...fresh, name: one.name, checkout: one.checkout } : one)))
}

async function chooseFocus($: EngineInterface): Promise<void> {
  const list = await read($, projects)
  const current = await read($, focus)
  const kept = (await $.store.get(focusKey())) as string | undefined
  const choice =
    list.find(one => one.dir === current) ??
    list.find(one => one.dir === kept) ??
    ownerOf(deck.root, list) ??
    list[0]
  await update($, focus, () => choice?.dir ?? null)
}

async function setFocus($: EngineInterface, dir: string): Promise<void> {
  if ((await read($, focus)) === dir) return
  await update($, focus, () => dir)
  await goHome($)
  await $.store.set(focusKey(), dir)
  await paintStatus($)
  void refreshDetail($)
}

// One refresh at a time; a request during one runs it once more after.
function refreshDetail($: EngineInterface): Promise<void> {
  if (deck.inflight !== undefined) {
    deck.isAgain = true

    return deck.inflight
  }
  deck.inflight = refreshLoop($).finally(() => {
    deck.inflight = undefined
    void settle($)
  })

  return deck.inflight
}

async function refreshLoop($: EngineInterface): Promise<void> {
  await update($, isLoading, () => true)
  do {
    deck.isAgain = false
    const dir = await read($, focus)
    if (dir === null) break
    deck.tools ??= await locateTools($, deck.root)
    if (deck.tools === undefined) {
      await update($, problem, () => 'gsd-tools.cjs не найден ни в .claude/ проекта, ни в ~/.claude/')
      break
    }
    await reloadSummary($, dir)
    const got = await inspect($, deck.tools, dir)
    // The person moved on while gsd-tools ran: that answer is for another project.
    if ((await read($, focus)) !== dir) continue
    if (got === undefined) {
      await update($, problem, () => 'gsd-tools не ответил по этому проекту')
      continue
    }
    await update($, problem, () => null)
    await update($, detail, () => got.detail)
    await update($, projects, list => list.map(one => (one.dir === dir ? fillGaps(one, got.snapshot) : one)))
    void reloadCard($)
  } while (deck.isAgain)
}

async function settle($: EngineInterface): Promise<void> {
  await update($, isLoading, () => false)
  await paintStatus($)
}

async function refreshAndSuggest($: EngineInterface): Promise<void> {
  await refreshDetail($)
  if (!(await read($, isSuggesting))) return
  const info = await read($, detail)
  const recommended = info?.actions.find(action => action.isRecommended)
  if (recommended !== undefined) await $.prompt.suggest({ text: recommended.command })
}

async function toggleSuggesting($: EngineInterface): Promise<boolean> {
  const isOn = !(await read($, isSuggesting))
  await update($, isSuggesting, () => isOn)
  await $.store.set('isSuggesting', isOn)

  return isOn
}

function markStale($: EngineInterface, dir: string | undefined): void {
  deck.staleTimer?.cancel()
  deck.staleTimer = $.clock.after(STALE_DEBOUNCE_MS, () => void refreshStale($, dir))
}

async function refreshStale($: EngineInterface, dir: string | undefined): Promise<void> {
  if (dir !== undefined) await reloadSummary($, dir)
  if (dir === undefined || dir === (await read($, focus))) await refreshDetail($)
}

async function paintStatus($: EngineInterface): Promise<void> {
  const dir = await read($, focus)
  const project = (await read($, projects)).find(one => one.dir === dir)
  if (project === undefined) {
    $.ui.status(undefined)

    return
  }
  const info = await read($, detail)
  const recommended = info?.dir === dir ? info.actions.find(action => action.isRecommended) : undefined
  // Phase numbers run across milestones; the counts are the milestone's own,
  // so the two are never written as one fraction ("P95/3").
  const parts = [`GSD ${project.name}`]
  if (project.milestone !== null) parts.push(project.milestone)
  const phase = [project.phase !== null ? `фаза ${project.phase}` : '', project.status ?? ''].filter(Boolean)
  if (phase.length > 0) parts.push(phase.join(' '))
  const counts = milestoneCounts(project, info?.dir === dir ? info.phases : [], false)
  if (counts !== '') parts.push(counts)
  if (recommended !== undefined) parts.push(`▸ ${recommended.command}`)
  $.ui.status(parts.join(' · '))
}

// Asked for by the person, the pane takes the keyboard: Tab and Enter work
// where a mouse click does not reach it (the terminal's main screen).
function openPane($: EngineInterface, isAsked = false) {
  return isAsked ? $.ui.open({ id: PANE, title: 'GSD', focus: true }) : $.ui.open({ id: PANE, title: 'GSD' })
}

async function goHome($: EngineInterface): Promise<void> {
  await update($, view, () => HOME)
  await update($, expanded, () => null)
}

async function openPhase($: EngineInterface, phase: string): Promise<void> {
  await update($, view, (): View => ({ kind: 'phase', phase }))
  await update($, expanded, () => null)
  await loadPhaseCard($, phase)
}

async function openMilestone($: EngineInterface): Promise<void> {
  await update($, view, (): View => ({ kind: 'milestone' }))
  await update($, expanded, () => null)
  await loadMilestoneCard($)
}

async function reloadCard($: EngineInterface): Promise<void> {
  const shown = await read($, view)
  if (shown.kind === 'phase') await loadPhaseCard($, shown.phase)
  if (shown.kind === 'milestone') await loadMilestoneCard($)
}

async function loadPhaseCard($: EngineInterface, phase: string): Promise<void> {
  const dir = await read($, focus)
  deck.tools ??= await locateTools($, deck.root)
  if (dir === null || deck.tools === undefined) return
  await update($, isCardLoading, () => true)
  const card = await inspectPhase($, deck.tools, dir, phase).catch(() => undefined)
  await update($, isCardLoading, () => false)
  const now = await read($, view)
  // The person went elsewhere while gsd-tools ran.
  if (now.kind !== 'phase' || now.phase !== phase || (await read($, focus)) !== dir) return
  await update($, phaseCard, () => card ?? null)
}

async function loadMilestoneCard($: EngineInterface): Promise<void> {
  const dir = await read($, focus)
  deck.tools ??= await locateTools($, deck.root)
  if (dir === null || deck.tools === undefined) return
  await update($, isCardLoading, () => true)
  const card = await inspectMilestone($, deck.tools, dir).catch(() => undefined)
  await update($, isCardLoading, () => false)
  if ((await read($, view)).kind !== 'milestone' || (await read($, focus)) !== dir) return
  await update($, milestoneCard, () => card ?? null)
}

async function toggleExpanded($: EngineInterface, id: string): Promise<void> {
  await update($, expanded, current => (current === id ? null : id))
}

async function togglePlan($: EngineInterface, phaseDir: string | null, id: string): Promise<void> {
  const key = `plan:${id}`
  const isOpening = (await read($, expanded)) !== key
  await update($, expanded, () => (isOpening ? key : null))
  if (!isOpening || phaseDir === null) return
  const plan = await inspectPlan($, phaseDir, id).catch(() => undefined)
  if ((await read($, expanded)) === key) await update($, planDetail, () => plan ?? null)
}

async function toggleAllPhases($: EngineInterface): Promise<void> {
  await update($, isAllPhases, current => !current)
}

async function pushActivity($: EngineInterface, entry: Activity): Promise<void> {
  await update($, activity, list => [...list.filter(one => one.id !== entry.id), entry].slice(-ACTIVITY_KEPT))
}

async function finishSkills($: EngineInterface, isAborted: boolean): Promise<void> {
  const now = await $.clock.now()
  const state: Activity['state'] = isAborted ? 'failed' : 'done'
  await update($, activity, list =>
    list.map(one => (one.kind === 'skill' && one.state === 'running' ? { ...one, state, endedAt: now } : one)),
  )
}

// Background agents report through the agent list, not through their Agent call.
async function pollAgents($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE && pane.isShown)) return
  const agents = await $.agent.list().catch(() => [] as AgentInfo[])
  const gsd = agents.filter(agent => isGsd(agent.type))
  if (gsd.length === 0) return
  const now = await $.clock.now()
  const list = await read($, activity)
  // An unchanged list is not written, so polling redraws nothing.
  if (mergeAgents(list, gsd, now) === list) return
  await update($, activity, current => mergeAgents(current, gsd, now))
}

function mergeAgents(list: Activity[], agents: readonly AgentInfo[], now: number): Activity[] {
  let isChanged = false
  const merged = [...list]
  for (const agent of agents) {
    const state = agentState(agent)
    const at = merged.findIndex(one => one.id === agent.id)
    const known = merged[at]
    if (known === undefined) {
      merged.push({
        id: agent.id,
        kind: 'agent',
        name: agent.type,
        label: agent.description,
        state,
        startedAt: now,
        endedAt: state === 'running' ? null : now,
      })
      isChanged = true
    } else if (known.state !== state) {
      merged[at] = { ...known, state, endedAt: state === 'running' ? null : now }
      isChanged = true
    }
  }

  // An unchanged list keeps its identity, so polling redraws nothing.
  return isChanged ? merged.slice(-ACTIVITY_KEPT) : list
}

type Ui = { Box: any; Text: any; Button: any; Markdown: any; Select?: any; Client?: any }
type Place = { width: number; isFocused: boolean; surface: string }

const OVERVIEW_CHARS = 1600

async function homeView(ui: Ui, $: EngineInterface, place: Place) {
  const { Box, Text, Button, Select } = ui
  const list = await read($, projects)
  const dir = await read($, focus)
  const info = await read($, detail)
  const acts = await read($, activity)
  const loading = await read($, isLoading)
  const trouble = await read($, problem)
  const now = await $.clock.now()
  const project = list.find(one => one.dir === dir)
  const shown = info !== null && info.dir === dir ? info : null

  if (list.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">
          {loading ? 'Ищу проекты .planning…' : `Проекта с .planning нет ни в ${deck.root}, ни в папках над ней.`}
        </Text>
        {loading ? null : <Text dimColor>Новый проект в этой папке: /gsd-new-project</Text>}
        {await footer(ui, $, place, loading)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {Select !== undefined && list.length > 1 ? (
        <Select
          key="project"
          label="Проект: "
          value={dir ?? undefined}
          options={list.map(one => ({ value: one.dir, label: `${one.name} · ${projectLine(one, one.dir === dir ? shown : null)}` }))}
          onSelect={(value: string) => setFocus($, value)}
        />
      ) : null}
      {project !== undefined ? header(ui, $, project, place.width, shown?.phases ?? []) : <Text dimColor>Проект не выбран.</Text>}
      {trouble !== null ? <Text color="error" wrap="wrap">{trouble}</Text> : null}
      {shown !== null ? nextBlock(ui, $, shown) : <Text dimColor>{loading ? 'Спрашиваю gsd-tools…' : ' '}</Text>}

      {shown !== null && shown.phases.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {sectionHead(ui, 'Фазы', phaseTally(shown.phases))}
          {await phaseList(ui, $, shown.phases, project?.phase ?? null)}
        </Box>
      ) : null}

      {acts.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {sectionHead(ui, 'В этой сессии', runningTally(acts))}
          {[...acts].reverse().map(one => activityRow(ui, one, now, place.surface))}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        {sectionHead(ui, 'Проекты', String(list.length))}
        {list.map(one => (
          <Button key={`project:${one.dir}`} plain dimColor={one.dir !== dir} onPress={() => setFocus($, one.dir)}>
            {`${one.dir === dir ? '● ' : '○ '}${one.name}`}
            <Text dimColor>{` ${projectLine(one, one.dir === dir ? shown : null)}`}</Text>
          </Button>
        ))}
      </Box>

      {await footer(ui, $, place, loading)}
    </Box>
  )
}

async function phaseView(ui: Ui, $: EngineInterface, place: Place, phase: string) {
  const { Box, Text, Button } = ui
  const card = await read($, phaseCard)
  const loading = await read($, isCardLoading)
  const open = await read($, expanded)
  const opened = await read($, planDetail)
  const info = await read($, detail)
  const dir = await read($, focus)
  const row = info?.phases.find(one => isSamePhase(one.number, phase))
  const shown = card !== null && card.dir === dir && isSamePhase(card.phase, phase) ? card : null
  const title = `Фаза ${phase}${shown !== null ? ` · ${shown.name}` : row !== undefined ? ` · ${row.name}` : ''}`

  if (shown === null) {
    return (
      <Box flexDirection="column">
        {backRow(ui, $)}
        <Text weight="bold" color="claude" wrap="wrap">{title}</Text>
        <Text dimColor>{loading ? 'Читаю ROADMAP и планы…' : 'Нет данных по фазе.'}</Text>
      </Box>
    )
  }

  const away = info !== null && info.dir === dir ? elsewhereFor(info, phase) : {}
  const done = shown.plans.filter(plan => plan.isDone || away[plan.id] !== undefined).length
  const doneHere = shown.plans.filter(plan => plan.isDone).length
  const total = shown.plans.length
  const status = row?.status ?? (total > 0 && done === total ? 'Complete' : null)
  const facts = [
    shown.mode !== null ? `режим ${shown.mode}` : '',
    total > 0 ? `планы ${done}/${total} ${bar(done, total, Math.max(6, Math.min(16, place.width - 36)))}` : 'планов нет',
    done > doneHere ? `здесь ${doneHere}, остальное в ${row?.farthest ?? 'других ветках'}` : '',
    shown.hasCheckpoints ? 'есть чекпойнты' : '',
  ].filter(Boolean)

  return (
    <Box flexDirection="column">
      {backRow(ui, $)}
      <Text weight="bold" color="claude" wrap="wrap">{title}</Text>
      <Text wrap="wrap">
        <Text color={statusColor(status)}>{`● ${status ?? 'нет статуса'}`}</Text>
        <Text dimColor>{`  ${facts.join(' · ')}`}</Text>
      </Text>

      {shown.goal !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">Цель</Text>
          {prose(ui, 'goal', shown.goal)}
        </Box>
      ) : null}

      {shown.criteria.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{`Критерии успеха (${shown.criteria.length})`}</Text>
          {prose(ui, 'criteria', markdownList(shown.criteria, true))}
        </Box>
      ) : null}

      {shown.dependsOn !== null || shown.requirements !== null ? (
        <Box flexDirection="column" marginTop={1}>
          {shown.dependsOn !== null ? prose(ui, 'depends', `*Зависит от:* ${shown.dependsOn}`) : null}
          {shown.requirements !== null ? prose(ui, 'requirements', `*Требования:* ${shown.requirements}`) : null}
        </Box>
      ) : null}

      {shown.artifacts.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">Документы <Text dimColor>(Enter вставляет @ссылку в промпт)</Text></Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {shown.artifacts.map(doc => (
              <Button key={`doc:${doc.path}`} label={doc.kind} dimColor onPress={() => mentionFile($, doc.path)} />
            ))}
          </Box>
        </Box>
      ) : null}

      {total > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">Планы <Text dimColor>(Enter раскрывает план)</Text></Text>
          {shown.plans.map(plan =>
            planRow(ui, $, plan, open === `plan:${plan.id}`, opened !== null && opened.id === plan.id ? opened : null, shown.phaseDir, away[plan.id] ?? null),
          )}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text weight="bold">Команды</Text>
        {actionButtons(ui, $, phaseActions(shown))}
      </Box>
    </Box>
  )
}

async function milestoneView(ui: Ui, $: EngineInterface, place: Place) {
  const { Box, Text, Button, Markdown } = ui
  const card = await read($, milestoneCard)
  const loading = await read($, isCardLoading)
  const open = await read($, expanded)
  const dir = await read($, focus)
  const info = await read($, detail)
  const project = (await read($, projects)).find(one => one.dir === dir)
  const shown = card !== null && card.dir === dir ? card : null
  const version = shown?.version ?? project?.milestone ?? null
  const name = shown?.name ?? project?.milestoneName ?? null
  const title = `Milestone ${[version, name].filter(Boolean).join(' · ') || 'без версии'}`

  if (shown === null) {
    return (
      <Box flexDirection="column">
        {backRow(ui, $)}
        <Text weight="bold" color="claude" wrap="wrap">{title}</Text>
        <Text dimColor>{loading ? 'Читаю ROADMAP и требования…' : 'Нет данных по milestone.'}</Text>
      </Box>
    )
  }

  const reqDone = shown.requirements.filter(one => one.isComplete).length
  const cells = Math.max(6, Math.min(16, place.width - 36))
  const tallies = [
    shown.acceptedPhases !== null ? `фазы ${shown.acceptedPhases.completed}/${shown.acceptedPhases.total}` : '',
    shown.completedPlans !== null
      ? `планы ${shown.completedPlans.completed}/${shown.completedPlans.total} ${bar(shown.completedPlans.completed, shown.completedPlans.total, cells)}`
      : '',
    shown.requirements.length > 0 ? `требования ${reqDone}/${shown.requirements.length}` : '',
    info !== null && info.dir === dir && info.retro !== null ? (retroLeft(info.retro) ?? '') : '',
  ].filter(Boolean)
  const overview =
    shown.overview === null
      ? null
      : shown.overview.length > OVERVIEW_CHARS
        ? `${shown.overview.slice(0, OVERVIEW_CHARS)}…`
        : shown.overview
  // Open requirements first: they are what the milestone still owes.
  const requirements = [...shown.requirements].sort((a, b) => Number(a.isComplete) - Number(b.isComplete))
  const isComplete = project?.status !== null && /complete/i.test(project?.status ?? '')

  return (
    <Box flexDirection="column">
      {backRow(ui, $)}
      <Text weight="bold" color="claude" wrap="wrap">{title}</Text>
      {tallies.length > 0 ? <Text dimColor wrap="wrap">{tallies.join(' · ')}</Text> : null}
      {shown.coreValue !== null ? (
        prose(ui, 'core-value', `*Ценность:* ${shown.coreValue}`)
      ) : null}

      {overview !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">Обзор</Text>
          <Markdown key="overview" text={overview} />
        </Box>
      ) : null}

      {info !== null && info.dir === dir && info.phases.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          {sectionHead(ui, 'Фазы', phaseTally(info.phases))}
          {await phaseList(ui, $, info.phases, project?.phase ?? null)}
        </Box>
      ) : null}

      {requirements.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{`Требования (${reqDone}/${requirements.length} выполнено)`}</Text>
          {requirements.map(one => {
            const isOpen = open === `req:${one.id}`
            const phases = one.phases.length > 0 ? ` [${one.phases.join(', ')}]` : ''

            return (
              <Box flexDirection="column">
                <Button key={`req:${one.id}`} plain dimColor={one.isComplete && !isOpen} onPress={() => toggleExpanded($, `req:${one.id}`)}>
                  <Text color={one.isComplete ? 'success' : undefined} wrap="truncate-end">
                    {`${one.isComplete ? '✓' : '·'} ${one.id}${phases} ${isOpen ? '' : plain(one.text)}`}
                  </Text>
                </Button>
                {isOpen ? (
                  <Box paddingLeft={2}>
                    {prose(ui, `req-text:${one.id}`, one.text)}
                  </Box>
                ) : null}
              </Box>
            )
          })}
        </Box>
      ) : null}

      <Box flexDirection="column" marginTop={1}>
        <Text weight="bold">Команды</Text>
        {actionButtons(ui, $, [
          { command: '/gsd-audit-milestone', isRecommended: isComplete },
          { command: '/gsd-milestone-summary', isRecommended: false },
          { command: '/gsd-complete-milestone', isRecommended: false },
          { command: '/gsd-new-milestone', isRecommended: false },
        ])}
      </Box>
    </Box>
  )
}

// What STATE.md's status word means, in the pane's language.
const STATE_WORD: Record<string, string> = {
  not_started: 'не начат',
  planning: 'планируется',
  executing: 'исполняется',
  verifying: 'проверяется',
  verified_human_needed: 'ждёт ручной проверки',
  paused: 'на паузе',
  blocked: 'заблокирован',
  complete: 'завершён',
  completed: 'завершён',
}

function stateWord(status: string | null): string {
  if (status === null) return 'нет статуса'

  return STATE_WORD[status.toLowerCase()] ?? status.replace(/_/g, ' ')
}

function header(ui: Ui, $: EngineInterface, project: ProjectSummary, width: number, phases: readonly PhaseRow[]) {
  const { Box, Text, Button } = ui
  const milestone = [project.milestone, project.milestoneName].filter(Boolean).join(' · ')
  const name = currentPhaseName(project, phases)
  const phase = project.phase === null ? null : `Фаза ${project.phase}${name !== null ? ` · ${name}` : ''}`
  const tally = planTally(project, phases)
  const counts = milestoneCounts(project, phases)
  const activityLine =
    project.lastActivity === null
      ? null
      : `${project.lastActivity}${project.lastActivityDesc !== null ? ` · ${project.lastActivityDesc}` : ''}`

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
        <Text weight="bold" color="claude" wrap="truncate-end">
          {project.name}
          <Text dimColor weight="regular">{project.checkout !== null ? `  ${project.checkout}` : ''}</Text>
        </Text>
        <Text color={statusColor(project.status)}>{`● ${stateWord(project.status)}`}</Text>
      </Box>
      {milestone !== '' ? (
        <Button key="milestone" plain hotkey="m" onPress={() => openMilestone($)}>
          <Text wrap="truncate-end">{`◆ ${milestone}`}</Text>
          <Text dimColor>{counts === '' ? '' : `  ${counts}`}</Text>
        </Button>
      ) : null}
      {phases.length > 0 ? milestoneStrip(ui, phases, project.phase) : null}
      {phase !== null ? (
        <Button key="current-phase" plain hotkey="p" onPress={() => openPhase($, project.phase ?? '')}>
          <Text wrap="truncate-end">{`▸ ${phase}`}</Text>
        </Button>
      ) : null}
      {tally !== null && tally.total > 0 ? (
        <Text wrap="truncate-end">
          <Text dimColor>планы </Text>
          {meter(ui, tally.done, tally.total, Math.max(8, Math.min(24, width - 22)), 'claude')}
          <Text dimColor>{` ${tally.done}/${tally.total} · ${Math.round((tally.done / tally.total) * 100)}%`}</Text>
          <Text dimColor>{tally.done > tally.here ? `  здесь ${tally.here}, остальное в других ветках` : ''}</Text>
        </Text>
      ) : null}
      {tally !== null && tally.stated !== null ? (
        <Text color="warning" wrap="wrap">{`! STATE.md отстаёт: в нём планы ${tally.stated}, по файлам ${tally.here}/${tally.total}`}</Text>
      ) : null}
      {project.stoppedAt !== null ? <Text dimColor wrap="wrap">{`⏸ ${plain(project.stoppedAt)}`}</Text> : null}
      {activityLine !== null ? <Text dimColor wrap="truncate-end">{plain(activityLine)}</Text> : null}
    </Box>
  )
}

/**
 * STATE.md often names the phase by its folder slug ("chestnye-tsifry");
 * the list has its ROADMAP title ("Честные цифры"). A slug gives way to it.
 */
export function currentPhaseName(project: ProjectSummary, phases: readonly PhaseRow[]): string | null {
  const row = phases.find(one => isSamePhase(one.number, project.phase))
  // A slug is all lower-case ASCII words joined by hyphens; one word ("cli") is a slug too.
  const isSlug = project.phaseName !== null && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.phaseName)

  return project.phaseName === null || isSlug ? (row?.name ?? project.phaseName) : project.phaseName
}

/** One mark per phase of the milestone, in its step's colour; the current one inverted. */
function milestoneStrip(ui: Ui, phases: readonly PhaseRow[], current: string | null) {
  const { Text } = ui
  const accepted = phases.filter(phase => phase.status === 'Complete').length

  return (
    <Text wrap="wrap">
      {phases.map(phase => {
        const step = phaseStep(phase.status)

        return (
          <Text color={step.color} inverse={isSamePhase(phase.number, current)}>
            {step.mark}
          </Text>
        )
      })}
      <Text dimColor>{`  принято ${accepted} из ${phases.length}`}</Text>
    </Text>
  )
}

/** A bar of `cells`: the done part in `color`, the rest dim. */
function meter(ui: Ui, done: number, total: number, cells: number, color: string | undefined) {
  const { Text } = ui
  const filled = Math.round((Math.min(done, total) / Math.max(1, total)) * cells)

  return (
    <Text>
      <Text color={color}>{'━'.repeat(filled)}</Text>
      <Text dimColor>{'─'.repeat(cells - filled)}</Text>
    </Text>
  )
}

/** A section's title on the left and its one-line tally on the right. */
function sectionHead(ui: Ui, title: string, tally: string) {
  const { Box, Text } = ui

  return (
    <Box flexDirection="row" justifyContent="space-between" columnGap={1}>
      <Text weight="bold">{title}</Text>
      <Text dimColor wrap="truncate-start">{tally}</Text>
    </Box>
  )
}

function phaseTally(phases: readonly PhaseRow[]): string {
  const going = phases.filter(phase => phase.status === 'In Progress').length
  const accepted = phases.filter(phase => phase.status === 'Complete').length

  return [going > 0 ? `${going} в работе` : '', `${accepted}/${phases.length} принято`].filter(Boolean).join(' · ')
}

function runningTally(acts: readonly Activity[]): string {
  const running = acts.filter(one => one.state === 'running').length

  return running > 0 ? `${running} идёт` : 'всё завершено'
}

// A running entry ticks on the surface's own clock where the surface runs a
// Client module; elsewhere its age is as of the last redraw.
function activityRow(ui: Ui, one: Activity, now: number, surface: string) {
  const { Box, Text, Client } = ui
  const what = `${one.name}${one.label !== '' ? ` ${one.label}` : ''}`
  const isRunning = one.state === 'running'
  // Only the terminal's and the desktop's tables hold a Client (Elements in the types).
  if (isRunning && (surface === 'terminal' || surface === 'desktop')) {
    return (
      <Box flexDirection="row" columnGap={1}>
        <Client key={`pulse:${one.id}`} module="./pulse.tsx" props={{ since: one.startedAt, now, endAt: one.endedAt, color: 'claude' }} />
        <Text wrap="truncate-end">{what}</Text>
      </Box>
    )
  }

  return (
    <Text color={one.state === 'failed' ? 'error' : isRunning ? 'claude' : undefined} dimColor={one.state === 'done'} wrap="truncate-end">
      {`${activityMark(one)} ${age((one.endedAt ?? now) - one.startedAt)}  ${what}`}
    </Text>
  )
}

// The pane's focal point: what to run next. The only framed section, and
// the only place the accent frames anything.
function nextBlock(ui: Ui, $: EngineInterface, info: Detail) {
  const { Box, Text } = ui
  const flags = [
    info.blockers.length > 0 ? `блокеров: ${info.blockers.length}` : '',
    info.todos > 0 ? `todo: ${info.todos}` : '',
    info.isGitDirty ? 'есть незакоммиченное' : '',
  ].filter(Boolean)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginTop={1}>
      <Text wrap="wrap">
        <Text weight="bold" color="claude">Дальше  </Text>
        <Text dimColor>{plain(info.summary)}</Text>
      </Text>
      {info.blockers.map(blocker => (
        <Text color="error" wrap="wrap">{`⛔ ${blocker}`}</Text>
      ))}
      {info.toolErrors.map(error => (
        <Text color="warning" wrap="wrap">{`! gsd-tools ${plain(error)}`}</Text>
      ))}
      {actionButtons(ui, $, info.actions)}
      {info.retro !== null && info.retro.isDue ? retroRow(ui, $, info.retro) : null}
      {info.retro !== null && info.retro.journal !== 'ok' ? (
        <Text color="warning" wrap="wrap">{`! ${journalWarning(info.retro.journal)}`}</Text>
      ) : null}
      {flags.length > 0 ? <Text dimColor>{flags.join(' · ')}</Text> : null}
    </Box>
  )
}

/** Why the schedule owes a retro, in one line. */
export function retroWhy(retro: RetroDue): string {
  const since = retro.lastRetroAt === null ? 'с начала milestone' : `с ретро ${retro.lastRetroAt.slice(0, 10)}`
  if (retro.trigger === 'milestone-start') {
    return `milestone ${retro.milestone ?? ''} подготовлен, фазы ещё не начаты`.replace('  ', ' ')
  }
  if (retro.trigger === 'cadence') return `${since} исполнено фаз: ${retro.phasesSince} (ретро раз в ${retro.cadence})`

  return 'в сессии много трения'
}

/**
 * Why the retro count is paused. A journal from a newer GSD is valid: deleting
 * it would lose its history, so the advice is to update GSD instead.
 */
export function journalWarning(journal: 'broken' | 'newer'): string {
  return journal === 'newer'
    ? 'Ретро на паузе: RUNS.json записан более новой версией GSD — обновите GSD, журнал не удаляйте'
    : 'Ретро на паузе: .planning/retro/RUNS.json не читается, исправьте или удалите его'
}

/** Where the schedule stands while no retro is owed: how many phases are left. */
export function retroLeft(retro: RetroDue): string | null {
  if (retro.journal === 'newer') return 'ретро на паузе: журнал от более новой версии GSD'
  if (retro.journal === 'broken') return 'ретро на паузе: .planning/retro/RUNS.json не читается'
  if (retro.isDue) return 'пора ретро'
  if (retro.cadence === 0) return null

  return `до ретро фаз: ${Math.max(1, retro.cadence - retro.phasesSince)}`
}

function retroRow(ui: Ui, $: EngineInterface, retro: RetroDue) {
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="row" columnGap={1} marginTop={1}>
      <Button key="action:/gsd-retro" label="/gsd-retro" dimColor onPress={() => fillCommand($, '/gsd-retro')} />
      <Text dimColor wrap="wrap">{`Пора ретро: ${retroWhy(retro)}`}</Text>
    </Box>
  )
}

// The phase ladder of src/phase-status.cts, one glyph and word per step, so
// colour is never the only thing that tells two phases apart.
const PHASE_STEP: Record<string, PhaseStep> = {
  Complete: { mark: '✓', word: 'принята', color: 'success' },
  'Needs Review': { mark: '!', word: 'ждёт проверки', color: 'warning' },
  [GAPS_FOUND]: { mark: '✗', word: 'проверка нашла пробелы', color: 'error' },
  Executed: { mark: '●', word: 'исполнена, не принята' },
  'In Progress': { mark: '◑', word: 'идёт', color: 'claude' },
  Planned: { mark: '○', word: 'спланирована' },
  'Not Started': { mark: '·', word: 'не начата' },
  Pending: { mark: '·', word: 'не начата' },
}
type PhaseStep = { mark: string; word: string; color?: string }
const UNKNOWN_STEP: PhaseStep = { mark: '?', word: 'статус неизвестен' }
const PHASES_AROUND = 4

function phaseStep(status: string): PhaseStep {
  return PHASE_STEP[status] ?? UNKNOWN_STEP
}

/** The phases shown: every one, or PHASES_AROUND either side of the current. */
export function phaseWindow<T>(phases: readonly T[], at: number, isAll: boolean): { shown: T[]; above: number; below: number } {
  if (isAll || at === -1 || phases.length <= PHASES_AROUND * 2 + 1) return { shown: [...phases], above: 0, below: 0 }
  const from = Math.max(0, at - PHASES_AROUND)
  const to = Math.min(phases.length, at + PHASES_AROUND + 1)

  return { shown: phases.slice(from, to), above: from, below: phases.length - to }
}

async function phaseList(ui: Ui, $: EngineInterface, phases: readonly PhaseRow[], current: string | null) {
  const { Box, Button, Text } = ui
  const isAll = await read($, isAllPhases)
  const at = phases.findIndex(phase => isSamePhase(phase.number, current))
  const { shown, above, below } = phaseWindow(phases, at, isAll)
  const steps = [...new Set(phases.map(phase => phase.status))].map(phaseStep)
  const legend = [...new Map(steps.map(step => [step.mark, step])).values()]
    .map(step => `${step.mark} ${step.word}`)
    .join('  ')

  return (
    <Box flexDirection="column">
      <Text dimColor wrap="wrap">{legend}</Text>
      {above > 0 ? (
        <Button key="phases:above" plain dimColor onPress={() => toggleAllPhases($)}>
          {`↑ ещё ${above} раньше`}
        </Button>
      ) : null}
      {shown.map(phase => {
        const isCurrent = isSamePhase(phase.number, current)
        const step = phaseStep(phase.status)
        const count = `${phase.summariesAll}/${phase.plans}`

        return (
          <Button key={`phase:${phase.number}`} plain onPress={() => openPhase($, phase.number)}>
            <Text wrap="truncate-end" weight={isCurrent ? 'bold' : undefined}>
              <Text color={isCurrent ? 'claude' : undefined}>{isCurrent ? '▸ ' : '  '}</Text>
              <Text color={step.color}>{step.mark}</Text>
              {` ${phase.number.padEnd(6)}`}
              {meter(ui, phase.summariesAll, phase.plans, 6, step.color)}
              <Text dimColor>{` ${count.padEnd(8)}`}</Text>
              {plain(phase.name)}
              <Text dimColor>{isCurrent ? '  сейчас' : ''}</Text>
              <Text dimColor>{phase.farthest !== null ? `  ⑂ ${phase.farthest}` : ''}</Text>
            </Text>
          </Button>
        )
      })}
      {below > 0 ? (
        <Button key="phases:below" plain dimColor onPress={() => toggleAllPhases($)}>
          {`↓ ещё ${below} дальше`}
        </Button>
      ) : null}
      {isAll && at !== -1 && phases.length > PHASES_AROUND * 2 + 1 ? (
        <Button key="phases:fold" plain dimColor onPress={() => toggleAllPhases($)}>
          Свернуть к текущей
        </Button>
      ) : null}
    </Box>
  )
}

function actionButtons(ui: Ui, $: EngineInterface, actions: readonly { command: string; isRecommended: boolean }[]) {
  const { Box, Button } = ui

  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      {actions.map((action, at) => (
        <Button
          key={`action:${action.command}`}
          label={action.command}
          hotkey={at < 9 ? String(at + 1) : undefined}
          variant={action.isRecommended ? 'primary' : undefined}
          dimColor={!action.isRecommended}
          onPress={() => fillCommand($, action.command)}
        />
      ))}
    </Box>
  )
}

const PLAN_TRUTHS_SHOWN = 6
const PLAN_FILES_SHOWN = 6

function planRow(
  ui: Ui,
  $: EngineInterface,
  plan: PhaseCard['plans'][number],
  isOpen: boolean,
  info: PlanDetail | null,
  phaseDir: string | null,
  doneIn: string | null,
) {
  const { Box, Button, Text } = ui
  const isDoneElsewhere = !plan.isDone && doneIn !== null
  const mark = plan.isDone || isDoneElsewhere ? '✓' : plan.isReady ? '▶' : '·'
  const wave = plan.wave !== null ? ` в${plan.wave}` : ''

  return (
    <Box flexDirection="column">
      <Button key={`plan:${plan.id}`} plain dimColor={plan.isDone && !isOpen} onPress={() => togglePlan($, phaseDir, plan.id)}>
        <Text wrap="truncate-end" weight={isOpen ? 'bold' : undefined}>
          <Text color={isDoneElsewhere ? undefined : plan.isReady ? 'claude' : plan.isDone ? 'success' : undefined}>{mark}</Text>
          {` ${plan.id}${wave} · `}
          <Text dimColor>{isDoneElsewhere ? `исполнен в ${doneIn}  ` : ''}</Text>
          {plain(plan.objective)}
        </Text>
      </Button>
      {isOpen ? planBody(ui, $, plan, info) : null}
    </Box>
  )
}

function planBody(ui: Ui, $: EngineInterface, plan: PhaseCard['plans'][number], info: PlanDetail | null) {
  const { Box, Button, Text } = ui
  if (info === null) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor>Читаю PLAN.md…</Text>
      </Box>
    )
  }
  const state = plan.isDone ? 'исполнен' : plan.isReady ? 'готов к запуску' : 'ждёт зависимостей'
  const facts = [
    state,
    plan.wave !== null ? `волна ${plan.wave}` : '',
    plan.isAutonomous ? 'без чекпойнтов' : 'с чекпойнтом',
    info.dependsOn.length > 0 ? `после ${info.dependsOn.join(', ')}` : '',
  ].filter(Boolean)
  const truths = info.truths.slice(0, PLAN_TRUTHS_SHOWN)
  const files = info.files.slice(0, PLAN_FILES_SHOWN)

  return (
    <Box paddingLeft={2} flexDirection="column" marginBottom={1}>
      <Text dimColor wrap="wrap">{facts.join(' · ')}</Text>
      {info.objective !== null ? prose(ui, `objective:${info.id}`, info.objective) : null}
      {info.requirements.length > 0 ? (
        <Text wrap="wrap"><Text dimColor>Требования: </Text>{info.requirements.join(', ')}</Text>
      ) : null}

      {info.tasks.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{`Задачи (${info.tasks.length})`}</Text>
          {prose(
            ui,
            `tasks:${info.id}`,
            markdownList(
              info.tasks.map(task => `${task.name}${task.type !== null && task.type !== 'auto' ? ` *(${task.type})*` : ''}`),
              true,
            ),
          )}
        </Box>
      ) : null}

      {truths.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{`Должно стать правдой (${info.truths.length})`}</Text>
          {prose(ui, `truths:${info.id}`, markdownList(truths, false))}
          {info.truths.length > truths.length ? (
            <Text dimColor>{`ещё ${info.truths.length - truths.length} в PLAN.md`}</Text>
          ) : null}
        </Box>
      ) : null}

      {files.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">{`Файлы (${info.files.length})`}</Text>
          {files.map(file => (
            <Text dimColor wrap="truncate-start">{file}</Text>
          ))}
          {info.files.length > files.length ? <Text dimColor>{`ещё ${info.files.length - files.length}`}</Text> : null}
        </Box>
      ) : null}

      {info.summaryPath !== null ? (
        <Box flexDirection="column" marginTop={1}>
          <Text weight="bold">Итог</Text>
          {info.summaryTitle !== null ? prose(ui, `summary-title:${info.id}`, `**${plain(info.summaryTitle)}**`) : null}
          {info.summaryLead !== null ? prose(ui, `summary:${info.id}`, info.summaryLead, true) : null}
        </Box>
      ) : null}

      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key={`plan-doc:${info.planPath}`} label="@PLAN" dimColor onPress={() => mentionFile($, info.planPath)} />
        {info.summaryPath !== null ? (
          <Button key={`plan-doc:${info.summaryPath}`} label="@SUMMARY" dimColor onPress={() => mentionFile($, info.summaryPath ?? '')} />
        ) : null}
      </Box>
    </Box>
  )
}

/** Prose from a planning document, drawn as the model's replies are: code, bold, lists. */
function prose(ui: Ui, key: string, text: string, isDim = false) {
  const { Markdown } = ui

  return <Markdown key={key} text={text} dimColor={isDim ? true : undefined} />
}

/** Items as one markdown list; an item's own line breaks fold so the list holds. */
export function markdownList(items: readonly string[], isNumbered: boolean): string {
  return items
    .map((item, at) => `${isNumbered ? `${at + 1}.` : '-'} ${item.replace(/\s*\n\s*/g, ' ').trim()}`)
    .join('\n')
}

/** One line of a row, which draws no markdown: the markers go, the words stay. */
export function plain(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function backRow(ui: Ui, $: EngineInterface) {
  const { Box, Button } = ui

  return (
    <Box flexDirection="row" columnGap={1} marginBottom={1}>
      <Button key="back" label="← Назад" hotkey="b" autoFocus onPress={() => goHome($)} />
      <Button key="refresh-card" label="Обновить" hotkey="r" dimColor onPress={() => reloadCard($)} />
    </Box>
  )
}

async function footer(ui: Ui, $: EngineInterface, place: Place, loading: boolean) {
  const { Box, Button, Text } = ui

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="refresh" label={loading ? 'Обновляю…' : 'Обновить'} hotkey="r" onPress={() => refreshDetail($)} />
        <Button key="rescan" label="Пересканировать" dimColor onPress={() => rescan($)} />
        <Button
          key="suggest"
          label={(await read($, isSuggesting)) ? 'Подсказка команды: вкл' : 'Подсказка команды: выкл'}
          dimColor
          onPress={() => toggleSuggesting($)}
        />
      </Box>
      {place.surface === 'terminal' && !place.isFocused ? (
        <Text dimColor wrap="wrap">ctrl+x tab: перейти в панель · Tab и стрелки: выбор · Enter: открыть · /gsd-deck &lt;проект&gt;</Text>
      ) : null}
    </Box>
  )
}

function phaseActions(card: PhaseCard): { command: string; isRecommended: boolean }[] {
  const has = (kind: string) => card.artifacts.some(doc => doc.kind === kind)
  const isPending = card.plans.some(plan => !plan.isDone)
  const recommended =
    card.plans.length === 0 ? (has('CONTEXT') ? 'plan' : 'discuss') : isPending ? 'execute' : has('VERIFICATION') ? '' : 'verify'
  const steps = ['discuss', 'plan', 'execute', 'verify']

  return steps.map(step => ({
    command: `/gsd-${step === 'verify' ? 'verify-work' : `${step}-phase`} ${card.phase}`,
    isRecommended: step === recommended,
  }))
}

async function mentionFile($: EngineInterface, path: string): Promise<void> {
  await $.prompt.fill({ text: `@${relativeTo(deck.root, path)} `, mode: 'insert' })
}
// The command goes first, as a slash command must; a draft the person had
// typed stays after it rather than being replaced.
async function fillCommand($: EngineInterface, command: string): Promise<void> {
  const draft = (await $.prompt.read()).text.trim()
  await $.prompt.fill({ text: draft === '' ? `${command} ` : `${command} ${draft}`, mode: 'replace' })
}

// Phase numbers run across milestones; the counts are the milestone's own.
// With the phase list in, the phases are counted from it: STATE.md's count,
// written by hand and often behind, would contradict the list. The pane's
// strip already says it; the status line, with no strip, says it here.
export function milestoneCounts(project: ProjectSummary, phases: readonly PhaseRow[] = [], hasStrip = true): string {
  const parts: string[] = []
  if (phases.length > 0 && !hasStrip) {
    parts.push(`принято ${phases.filter(phase => phase.status === 'Complete').length}/${phases.length}`)
  } else if (phases.length === 0 && project.totalPhases !== null && project.completedPhases !== null) {
    parts.push(`фазы ${project.completedPhases}/${project.totalPhases}`)
  }
  const tally = planTally(project, phases)
  if (tally !== null) parts.push(`планы ${tally.done}/${tally.total}`)

  return parts.join(' · ')
}

export type PlanTally = {
  total: number
  /** Plans with a SUMMARY anywhere in the repository. */
  done: number
  /** Plans with a SUMMARY in this checkout. */
  here: number
  /** What STATE.md says, where it counts the same plans and says fewer done. */
  stated: string | null
}

/**
 * Plans counted from the files, not from STATE.md: the frontmatter is written
 * by hand at the end of a plan and falls behind; the files do not. STATE.md is
 * the fallback until gsd-tools has answered.
 */
export function planTally(project: ProjectSummary, phases: readonly PhaseRow[]): PlanTally | null {
  if (phases.length === 0) {
    if (project.totalPlans === null || project.completedPlans === null) return null

    return { total: project.totalPlans, done: project.completedPlans, here: project.completedPlans, stated: null }
  }
  const total = phases.reduce((sum, phase) => sum + phase.plans, 0)
  const done = phases.reduce((sum, phase) => sum + phase.summariesAll, 0)
  const here = phases.reduce((sum, phase) => sum + phase.summaries, 0)
  // STATE.md may count another scope (a whole milestone over a phase window):
  // it is called behind only where it counts the same plans.
  const isBehind = project.totalPlans === total && project.completedPlans !== null && project.completedPlans < here

  return { total, done, here, stated: isBehind ? `${project.completedPlans}/${project.totalPlans}` : null }
}

/** Plans of a phase done outside this checkout, by plan id. */
function elsewhereFor(info: Detail, phase: string): Record<string, string> {
  const key = Object.keys(info.elsewhere).find(number => isSamePhase(number, phase))

  return key === undefined ? {} : (info.elsewhere[key] ?? {})
}

/** By whole name, then the last path segment, then a part of the name. */
function pickProject(list: readonly ProjectSummary[], word: string): ProjectSummary | undefined {
  const query = word.toLowerCase()

  return (
    list.find(one => one.name.toLowerCase() === query) ??
    list.find(one => one.name.toLowerCase().split('/').pop() === query) ??
    list.find(one => one.name.toLowerCase().includes(query))
  )
}

// The focused project counts its plans as the header does; the others,
// with no list read for them, as their STATE.md says.
function projectLine(one: ProjectSummary, info: Detail | null = null): string {
  const parts: string[] = []
  if (one.phase !== null) parts.push(`P${one.phase}`)
  parts.push(stateWord(one.status))
  const tally = info === null ? null : planTally(one, info.phases)
  if (tally !== null) parts.push(`${tally.done}/${tally.total}`)
  else if (one.totalPlans !== null && one.completedPlans !== null) parts.push(`${one.completedPlans}/${one.totalPlans}`)

  return `${one.checkout !== null ? `${one.checkout} · ` : ''}${parts.join(' ')}`
}

function activityMark(one: Activity): string {
  if (one.state === 'running') return '▶'

  return one.state === 'failed' ? '✗' : '✓'
}

function agentState(agent: AgentInfo): Activity['state'] {
  if (agent.status === 'completed' || agent.status === 'idle') return 'done'
  if (agent.status === 'failed' || agent.status === 'killed') return 'failed'

  return 'running'
}

function statusColor(status: string | null): string | undefined {
  const word = (status ?? '').toLowerCase()
  if (/complete|done|shipped/.test(word)) return 'success'
  if (/block|fail/.test(word)) return 'error'
  if (/verif|review/.test(word)) return 'warning'
  if (/plan/.test(word)) return 'planMode'
  if (/execut|progress/.test(word)) return 'claude'

  return undefined
}

function bar(done: number, total: number, cells: number): string {
  const filled = Math.round((Math.min(done, total) / Math.max(1, total)) * cells)

  return '━'.repeat(filled) + '─'.repeat(cells - filled)
}

function age(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}с`
  const minutes = Math.round(seconds / 60)

  return minutes < 60 ? `${minutes}м` : `${Math.floor(minutes / 60)}ч${String(minutes % 60).padStart(2, '0')}м`
}

function fillGaps(summary: ProjectSummary, snapshot: Partial<ProjectSummary>): ProjectSummary {
  const out: Record<string, unknown> = { ...summary }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value !== undefined && out[key] === null) out[key] = value
  }

  return out as ProjectSummary
}
