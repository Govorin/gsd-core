// One `.planning` project as its STATE.md frontmatter describes it.
export type ProjectSummary = {
  /** Absolute project root: the directory holding `.planning/`. */
  dir: string
  /** The root relative to the session's directory, or its basename for the root itself. */
  name: string
  milestone: string | null
  milestoneName: string | null
  phase: string | null
  phaseName: string | null
  status: string | null
  stoppedAt: string | null
  lastActivity: string | null
  lastActivityDesc: string | null
  totalPhases: number | null
  completedPhases: number | null
  totalPlans: number | null
  completedPlans: number | null
  /**
   * Which checkout of the repository the project lives in, where the session
   * runs in a git worktree: `ветка <branch>` for the worktree, `основной` for
   * the main checkout. Null outside a worktree.
   */
  checkout: string | null
}

export type PhaseRow = {
  number: string
  name: string
  plans: number
  /** Plans with a SUMMARY in this checkout. */
  summaries: number
  status: string
  /** Plans with a SUMMARY anywhere in the repository: this checkout, other worktrees, unmerged branches. */
  summariesAll: number
  /** The branch holding most of the summaries this checkout lacks; null when nothing is elsewhere. */
  farthest: string | null
}

export type NextAction = {
  label: string
  /** Already in this runtime's spelling: `/gsd-verify-work`, not `/gsd:verify-work`. */
  command: string
  isRecommended: boolean
}

// `gsd-tools retro due`: whether the retro schedule says one is owed now.
export type RetroDue = {
  isDue: boolean
  /** `signals`, `cadence` or `milestone-start`; null while none fires. */
  trigger: string | null
  phasesSince: number
  /** Phases between scheduled retros; 0 when the schedule is off. */
  cadence: number
  lastRetroAt: string | null
  milestone: string | null
  /**
   * The journal of past retros: `broken` cannot be read, `newer` was written by
   * a newer GSD than the one installed. Nothing is counted until it is `ok`.
   */
  journal: 'ok' | 'broken' | 'newer'
}

// What gsd-tools says about the focused project: smart-entry, progress, todos.
export type Detail = {
  dir: string
  situation: string
  summary: string
  actions: NextAction[]
  phases: PhaseRow[]
  blockers: string[]
  todos: number
  isGitDirty: boolean
  refreshedAt: number
  /** Null where gsd-tools has no `retro due` (installed before the schedule). */
  retro: RetroDue | null
  /** Plans done outside this checkout, by phase number then plan id: where their SUMMARY is. */
  elsewhere: Record<string, Record<string, string>>
  /** gsd-tools calls that failed, each with the first line it gave as the reason. */
  toolErrors: string[]
}

export type Activity = {
  id: string
  kind: 'skill' | 'agent'
  /** `/gsd-execute-phase` for a workflow, `gsd-executor` for an agent. */
  name: string
  label: string
  state: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt: number | null
}

/** What the pane shows: the overview, one phase, or the milestone. */
export type View = { kind: 'home' } | { kind: 'phase'; phase: string } | { kind: 'milestone' }

export type PlanRow = {
  id: string
  wave: number | null
  objective: string
  taskCount: number | null
  isDone: boolean
  isReady: boolean
  isAutonomous: boolean
}

// One phase as ROADMAP.md, the plan index and the phase directory describe it.
export type PhaseCard = {
  dir: string
  phase: string
  name: string
  goal: string | null
  mode: string | null
  criteria: string[]
  dependsOn: string | null
  requirements: string | null
  plans: PlanRow[]
  /** The phase's own documents by kind, `CONTEXT`, `RESEARCH`, ..., with their paths. */
  artifacts: { kind: string; path: string }[]
  hasCheckpoints: boolean
  /** The phase directory, absolute; plans are read from it on demand. */
  phaseDir: string | null
}

// One plan as its PLAN.md and SUMMARY.md say, read when the person opens it.
export type PlanDetail = {
  id: string
  objective: string | null
  /** `must_haves.truths`: what has to hold once the plan is done. */
  truths: string[]
  tasks: { name: string; type: string | null }[]
  dependsOn: string[]
  requirements: string[]
  files: string[]
  planPath: string
  summaryPath: string | null
  summaryTitle: string | null
  summaryLead: string | null
}

export type Requirement = {
  id: string
  text: string
  isComplete: boolean
  phases: string[]
}

export type Tally = { completed: number; total: number }

export type MilestoneCard = {
  dir: string
  version: string | null
  name: string | null
  coreValue: string | null
  overview: string | null
  requirements: Requirement[]
  acceptedPhases: Tally | null
  completedPlans: Tally | null
}

declare module 'claude-code' {
  interface PluginState {
    'gsd-deck': {
      projects: Shaped<ProjectSummary[]>
      focus: string | null
      detail: Shaped<Detail | null>
      activity: Shaped<Activity[]>
      isLoading: boolean
      isSuggesting: boolean
      problem: string | null
      view: Shaped<View>
      phaseCard: Shaped<PhaseCard | null>
      milestoneCard: Shaped<MilestoneCard | null>
      isCardLoading: boolean
      /** The plan or requirement row the person opened, by id. */
      expanded: string | null
      /** The phase list shows every phase, not the window around the current one. */
      isAllPhases: boolean
      planDetail: Shaped<PlanDetail | null>
      /** The pane opened itself once this session; it does not again, closed or reloaded. */
      isOffered: boolean
    }
  }
}
