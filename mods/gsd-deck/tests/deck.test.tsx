import { describe, expect, test } from 'claude-code/testing'

import { currentPhaseName, markdownList, milestoneCounts, phaseWindow, plain, planTally, journalWarning, retroLeft, retroWhy, withoutSameMain } from '../hooks/register'
import {
  artifactKind,
  clean,
  gitCheckout,
  toRetroDue,
  addPlanningFiles,
  archivedPhases,
  elsewhereByPlan,
  gatherPlanning,
  HERE,
  presentPaths,
  withElsewhere,
  canonicalPlanId,
  comparePhase,
  isSamePhase,
  withoutOrphans,
  withVerdicts,
  GAPS_FOUND,
  frontmatterList,
  markdownSection,
  milestoneOf,
  ownerOf,
  parseFrontmatter,
  phaseToken,
  rawField,
  planTasks,
  planTruths,
  projectAbove,
  projectDirFlag,
  projectName,
  roadmapTitles,
  sectionField,
  summaryLead,
  tagBlock,
  toCommand,
  toSummary,
} from '../hooks/gsd'

const STATE_MD = `---
gsd_state_version: "1.0"
milestone: v1.0
current_phase: 1
current_phase_name: Спайк, вердикт скорости
status: executing
stopped_at: "01-13: задачи 1-2 готовы, ждёт чекпойнт 3"
last_activity: 2026-10-24
progress:
  total_phases: 16
  completed_phases: 0
  total_plans: 15
  completed_plans: 10
milestone_name: milestone
---

# Project State
`

const asgard = toSummary('/mn/apps/asgard', 'apps/asgard', STATE_MD)
const root = toSummary('/mn', 'mn', '---\nstatus: complete\n---\n')

const SEED: Record<string, unknown> = {
  projects: { shape: 'projects-2', value: [asgard, root] },
  focus: '/mn/apps/asgard',
  detail: {
    shape: 'detail-5',
    value: {
      dir: '/mn/apps/asgard',
      situation: 'executing',
      summary: 'Phase 1 of 16 · executing',
      actions: [
        { label: 'Continue', command: '/gsd-progress --next', isRecommended: true },
        { label: 'Debug', command: '/gsd-debug', isRecommended: false },
      ],
      phases: [
        { number: '01', name: 'Спайк', plans: 13, summaries: 10, status: 'In Progress', summariesAll: 10, farthest: null },
        { number: '02', name: 'ADR формата', plans: 2, summaries: 0, status: 'Not Started', summariesAll: 0, farthest: null },
      ],
      blockers: [],
      todos: 2,
      isGitDirty: true,
      refreshedAt: 0,
      retro: { isDue: true, trigger: 'cadence', phasesSince: 7, cadence: 3, lastRetroAt: null, milestone: 'v5.0', journal: 'ok' },
      elsewhere: {},
      toolErrors: [],
    },
  },
  activity: {
    shape: 'activity-1',
    value: [
      { id: 'a1', kind: 'agent', name: 'gsd-executor', label: 'Execute 01-13', state: 'running', startedAt: 0, endedAt: null },
    ],
  },
}

const PANE = {
  plugin: 'gsd-deck',
  component: 'Pane',
  requestId: 'gsd-deck',
  props: {
    title: 'GSD',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

describe('STATE.md frontmatter', () => {
  test('reads the flat keys and the progress map', () => {
    const fm = parseFrontmatter(STATE_MD)
    expect(fm.current_phase).toBe(1)
    expect(fm.status).toBe('executing')
    expect((fm.progress as Record<string, unknown>).completed_plans).toBe(10)
  })

  test('keeps a padded phase number a string', () => {
    expect(parseFrontmatter('---\ncurrent_phase: "08"\n---').current_phase).toBe('08')
    expect(parseFrontmatter('---\ncurrent_phase: 08\n---').current_phase).toBe('08')
  })

  test('a file with no frontmatter reads as nothing', () => {
    expect(parseFrontmatter('# Project State\n')).toEqual({})
  })

  test('the template placeholder is no milestone name', () => {
    expect(asgard.milestoneName).toBe(null)
    expect(asgard.totalPlans).toBe(15)
    expect(asgard.phase).toBe('1')
  })
})

describe('routing', () => {
  test('gsd-tools commands come out hyphenated', () => {
    expect(toCommand('/gsd:verify-work')).toBe('/gsd-verify-work')
    expect(toCommand('/gsd:progress --next')).toBe('/gsd-progress --next')
    expect(toCommand('/gsd-debug')).toBe('/gsd-debug')
  })

  test('a path belongs to the deepest project around it', () => {
    expect(ownerOf('/mn/apps/asgard/src/main.rs', [root, asgard])?.dir).toBe('/mn/apps/asgard')
    expect(ownerOf('/mn/libs/x.ts', [root, asgard])?.dir).toBe('/mn')
    // A sibling whose name only starts the same is not inside.
    expect(ownerOf('/mn/apps/asgard-old/a.ts', [asgard])).toBe(undefined)
  })

  test('a gsd-tools call names its project by flag', () => {
    expect(projectDirFlag('node gsd-tools.cjs state-snapshot --project-dir apps/rpg')).toBe('apps/rpg')
    expect(projectDirFlag('node gsd-tools.cjs progress --cwd="apps/rpg"')).toBe('apps/rpg')
    expect(projectDirFlag('node gsd-tools.cjs progress')).toBe(undefined)
    expect(projectDirFlag('git status --cwd x')).toBe(undefined)
  })
})

describe('ROADMAP and phase files', () => {
  test('a field reads with the colon inside or outside the bold', () => {
    const section = '### Phase 2\n\n**Requirements:** Task lifecycle\n**Depends on**: Phase 1\n**Goal:** x'
    expect(sectionField(section, ['requirements'])).toBe('Task lifecycle')
    expect(sectionField(section, ['depends on', 'dependencies'])).toBe('Phase 1')
    expect(sectionField(section, ['mode'])).toBe(null)
  })

  test('a phase document is named by its kind; plans and summaries are not documents', () => {
    expect(artifactKind('04.1-CONTEXT.md')).toBe('CONTEXT')
    expect(artifactKind('01-UI-SPEC.md')).toBe('UI-SPEC')
    expect(artifactKind('04.1-01-PLAN.md')).toBe(undefined)
    expect(artifactKind('01-SUMMARY.md')).toBe(undefined)
    expect(artifactKind('notes.md')).toBe(undefined)
  })

  test('a section runs to the next level-two heading', () => {
    const roadmap = '# Roadmap\n\n## Overview\n\nEditor in Rust.\n\n### Detail\nmore\n\n## Phases\n- x'
    expect(markdownSection(roadmap, /^overview/i)).toBe('Editor in Rust.\n\n### Detail\nmore')
    expect(markdownSection(roadmap, /^missing/i)).toBe(null)
  })
})

test('the pane draws the focused project on every surface', async ($, on) => {
  on('clock.now', () => ({ value: 90_000 }))
  on('state.get', (_, e) => ({ value: { value: SEED[e.key], version: 1 } }))

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /▸ Фаза 1 · Спайк/ })).toBeDefined()
    // The list is in: the strip counts the phases, the header only the plans.
    expect(await ui.find({ type: 'Text', text: /фазы 0\/16/ })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /принято \d+ из \d+/ })).toBeDefined()
    expect(await ui.find({ key: 'milestone' })).toBeDefined()
    expect(await ui.find({ key: 'phase:01' })).toBeDefined()
    expect(await ui.find({ key: 'action:/gsd-progress --next' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /gsd-executor Execute 01-13/ })).toBeDefined()
    // A running agent ticks on the surface's clock where a Client module runs;
    // vscode and mobile draw its age as of the last redraw.
    if (surface === 'terminal' || surface === 'desktop') {
      expect(await ui.find({ key: 'pulse:a1' })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Text', text: /▶ 2м\s+gsd-executor/ })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /исполняется/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Дальше/ })).toBeDefined()
    expect(await ui.find({ key: 'project:/mn' })).toBeDefined()
    expect(await ui.find({ key: 'action:/gsd-retro' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Пора ретро: с начала milestone исполнено фаз: 7 \(ретро раз в 3\)/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a phase number is never written over the milestone count', async ($, on) => {
  // Phase 95 is the third phase of its milestone: "95/3" would be nonsense.
  const late = toSummary(
    '/mn',
    'mn',
    '---\nmilestone: v7.5\ncurrent_phase: 95\nstatus: complete\nprogress:\n  total_phases: 3\n  completed_phases: 3\n  total_plans: 3\n  completed_plans: 3\n---\n',
  )
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({
    value: { value: e.key === 'projects' ? { shape: 'projects-2', value: [late] } : e.key === 'focus' ? '/mn' : undefined, version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Фаза 95/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /фазы 3\/3 · планы 3\/3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /95\/3/ })).toBe(undefined)
  await ui.unmount()
})

const PHASE_CARD = {
  dir: '/mn/apps/asgard',
  phase: '01',
  name: 'Спайк, вердикт скорости',
  goal: 'Известно, держит ли связка критерий скорости',
  mode: 'mvp',
  criteria: ['Спайк открывает ucars', 'Записаны p50/p99'],
  dependsOn: 'Nothing',
  requirements: 'SPK-01, SPK-02',
  plans: [
    { id: '01-01', wave: 1, objective: 'Зафиксировать решения владельца', taskCount: 4, isDone: true, isReady: false, isAutonomous: false },
    { id: '01-10', wave: 10, objective: 'Чекпойнт на Mac', taskCount: 2, isDone: false, isReady: true, isAutonomous: true },
  ],
  artifacts: [{ kind: 'CONTEXT', path: '/mn/apps/asgard/.planning/phases/01-spaik/01-CONTEXT.md' }],
  hasCheckpoints: true,
  phaseDir: '/mn/apps/asgard/.planning/phases/01-spaik',
}

test('a phase opens as a card, and Back returns to the overview', async ($, on) => {
  const writes: unknown[] = []
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({
    value: {
      value:
        e.key === 'view'
          ? { shape: 'view-1', value: { kind: 'phase', phase: '01' } }
          : e.key === 'phaseCard'
            ? { shape: 'phase-card-2', value: PHASE_CARD }
            : SEED[e.key],
      version: 1,
    },
  }))
  // The seeded reads stay at version 1, so every write is answered as landing.
  on('state.set', (_, e) => {
    if (e.key === 'view') writes.push(e.value)

    return { value: { isSet: true, version: 1 } }
  })

  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Фаза 01 · Спайк, вердикт скорости/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /держит ли связка/ })).toBeDefined()
    // Criteria are one markdown list, numbered as the ROADMAP numbers them.
    expect((await ui.find({ key: 'criteria' }))?.text).toBe('1. Спайк открывает ucars\n2. Записаны p50/p99')
    expect(await ui.find({ key: 'plan:01-10' })).toBeDefined()
    expect(await ui.find({ key: 'doc:/mn/apps/asgard/.planning/phases/01-spaik/01-CONTEXT.md' })).toBeDefined()
    // Plans are left to run: execute is the step to take.
    expect(await ui.find({ key: 'action:/gsd-execute-phase 01' })).toBeDefined()
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
  expect(writes.length).toBe(3)
  expect(writes[0]).toEqual({ shape: 'view-1', value: { kind: 'home' } })
})

test('the milestone opens as a card with its requirements', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({
    value: {
      value:
        e.key === 'view'
          ? { shape: 'view-1', value: { kind: 'milestone' } }
          : e.key === 'milestoneCard'
            ? {
                shape: 'milestone-card-1',
                value: {
                  dir: '/mn/apps/asgard',
                  version: 'v1.0',
                  name: null,
                  coreValue: 'быстрее Pencil',
                  overview: 'Редактор **дизайна** на Rust.',
                  requirements: [
                    { id: 'SPK-01', text: 'Спайк открывает .pen', isComplete: false, phases: ['1'] },
                    { id: 'SPK-02', text: 'Замеры записаны', isComplete: true, phases: ['1'] },
                  ],
                  acceptedPhases: { completed: 0, total: 16 },
                  completedPlans: { completed: 10, total: 15 },
                },
              }
            : SEED[e.key],
      version: 1,
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Milestone v1\.0/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /требования 1\/2/ })).toBeDefined()
    expect(await ui.find({ key: 'overview' })).toBeDefined()
    expect(await ui.find({ key: 'req:SPK-01' })).toBeDefined()
    expect(await ui.find({ key: 'phase:02' })).toBeDefined()
    await ui.unmount()
  }
})

test('a value an earlier version stored is declined', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({
    value: { value: e.key === 'projects' ? { shape: 'projects-1', value: [asgard] } : undefined, version: 1 },
  }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Проекта с \.planning нет/ })).toBeDefined()
  await ui.unmount()
})

test('pressing the next command puts it in the prompt', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({ value: { value: SEED[e.key], version: 1 } }))
  const filled: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, cursor: e.text.length }
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'action:/gsd-progress --next' })
    await ui.unmount()
  }
  expect(filled).toEqual(['/gsd-progress --next ', '/gsd-progress --next '])
})

test('a draft the person typed stays after the command', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({ value: { value: SEED[e.key], version: 1 } }))
  on('prompt.read', () => ({ value: { text: 'проверь ещё раз', cursor: 3 } }))
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)

    return { isFilled: true, cursor: e.text.length }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'action:/gsd-debug' })
  await ui.unmount()
  expect(filled).toEqual(['/gsd-debug проверь ещё раз'])
})

describe('the phase list', () => {
  const phases = ['111.1', '111.2', '112', '113', '114', '115', '116', '117', '118', '119', '120']

  test('shows four phases either side of the current one', () => {
    const at = phases.indexOf('118')
    const { shown, above, below } = phaseWindow(phases, at, false)
    expect(shown).toEqual(['114', '115', '116', '117', '118', '119', '120'])
    expect(above).toBe(4)
    expect(below).toBe(0)
  })

  test('at the boundary of the window every phase shows', () => {
    // 2 * 4 + 1 phases fit as they are; one more opens the window.
    // limit: 9 phases, the current one last, all shown
    expect(phaseWindow(phases.slice(0, 9), 8, false)).toEqual({ shown: phases.slice(0, 9), above: 0, below: 0 })
    // limit + 1: 10 phases, the current one fifth, one is left below the window
    expect(phaseWindow(phases.slice(0, 10), 4, false)).toEqual({ shown: phases.slice(0, 9), above: 0, below: 1 })
    // limit - 1: 8 phases always fit
    expect(phaseWindow(phases.slice(0, 8), 0, false).below).toBe(0)
  })

  test('asked for all, or with no current phase, nothing is cut', () => {
    expect(phaseWindow(phases, 8, true).shown.length).toBe(11)
    expect(phaseWindow(phases, -1, false).shown.length).toBe(11)
  })

  test('each status draws its own mark and word, the current one marked apart', async ($, on) => {
    const rows = [
      { number: '111.1', name: 'Ключи ошибок вместо текста', plans: 145, summaries: 137, status: 'In Progress', summariesAll: 137, farthest: null },
      { number: '113', name: 'Очередь генерации контента', plans: 19, summaries: 19, status: 'Executed', summariesAll: 19, farthest: null },
      { number: '114', name: 'Факты сред владельца', plans: 4, summaries: 4, status: 'Needs Review', summariesAll: 4, farthest: null },
      { number: '118', name: 'Агрегация в TS', plans: 16, summaries: 16, status: 'Executed', summariesAll: 16, farthest: null },
    ]
    const polyglot = toSummary('/mn/apps/polyglot', 'apps/polyglot', '---\ncurrent_phase: 118\nstatus: executing\n---\n')
    on('clock.now', () => ({ value: 0 }))
    on('state.get', (_, e) => ({
      value: {
        value:
          e.key === 'projects'
            ? { shape: 'projects-2', value: [polyglot] }
            : e.key === 'focus'
              ? '/mn/apps/polyglot'
              : e.key === 'detail'
                ? { shape: 'detail-5', value: { ...(SEED.detail as { value: object }).value, dir: '/mn/apps/polyglot', phases: rows } }
                : undefined,
        version: 1,
      },
    }))

    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /◑ идёт/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /● исполнена, не принята/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /! ждёт проверки/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Ключи ошибок вместо текста/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /сейчас/ })).toBeDefined()
    await ui.unmount()
  })
})

test('an opened plan shows its tasks, truths, files and result', async ($, on) => {
  const plan = {
    id: '01-01',
    objective: 'Зафиксировать решения владельца до кода.',
    truths: ['Критерий скорости заморожен хэшем'],
    tasks: [
      { name: 'Задача 1: записать критерий', type: 'auto' },
      { name: 'Задача 2: проверить vello_gpu', type: 'checkpoint:human-verify' },
    ],
    dependsOn: [],
    requirements: ['SPK-01'],
    files: ['apps/asgard/docs/decisions.md'],
    planPath: '/mn/apps/asgard/.planning/phases/01-spaik/01-01-PLAN.md',
    summaryPath: '/mn/apps/asgard/.planning/phases/01-spaik/01-01-SUMMARY.md',
    summaryTitle: 'Phase 1 Plan 01: решения владельца',
    summaryLead: 'Критерий и окружение заморожены.',
  }
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({
    value: {
      value:
        e.key === 'view'
          ? { shape: 'view-1', value: { kind: 'phase', phase: '01' } }
          : e.key === 'phaseCard'
            ? { shape: 'phase-card-2', value: PHASE_CARD }
            : e.key === 'expanded'
              ? 'plan:01-01'
              : e.key === 'planDetail'
                ? { shape: 'plan-detail-1', value: plan }
                : SEED[e.key],
      version: 1,
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Задачи \(2\)/ })).toBeDefined()
    expect((await ui.find({ key: 'tasks:01-01' }))?.text).toBe('1. Задача 1: записать критерий\n2. Задача 2: проверить vello_gpu *(checkpoint:human-verify)*')
    expect((await ui.find({ key: 'truths:01-01' }))?.text).toBe('- Критерий скорости заморожен хэшем')
    expect(await ui.find({ type: 'Text', text: /apps\/asgard\/docs\/decisions\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /Критерий и окружение заморожены/ })).toBeDefined()
    expect(await ui.find({ key: `plan-doc:${plan.summaryPath}` })).toBeDefined()
    await ui.unmount()
  }
})

describe('PLAN.md and SUMMARY.md', () => {
  const PLAN = [
    '---',
    'phase: 118-agregatsiya',
    'wave: 2',
    'depends_on: ["118-01"]',
    'files_modified:',
    '  - libs/a.ts',
    '  - "libs/b.ts"',
    'requirements: [ANLZ-04, ANLZ-03]',
    'must_haves:',
    '  truths:',
    '    - "Версия 3 с обеих сторон"',
    '    - Нет агрегатов книги',
    '  artifacts:',
    '    - path: x',
    '---',
    '<objective>',
    'Поднять контракт до версии 3.',
    '',
    'Purpose: критерий 2.',
    '</objective>',
    '<task type="tracer" tdd="true">',
    '  <name>Задача 1 (tracer): гейт</name>',
    '</task>',
    '<task type="auto">',
    '  <name>Задача 2:',
    '    инвариант</name>',
    '</task>',
  ].join('\n')

  test('frontmatter lists read inline and block forms', () => {
    expect(frontmatterList(PLAN, 'depends_on')).toEqual(['118-01'])
    expect(frontmatterList(PLAN, 'files_modified')).toEqual(['libs/a.ts', 'libs/b.ts'])
    expect(frontmatterList(PLAN, 'requirements')).toEqual(['ANLZ-04', 'ANLZ-03'])
    expect(frontmatterList(PLAN, 'missing')).toEqual([])
  })

  test('truths stop where the next must_haves key starts', () => {
    expect(planTruths(PLAN)).toEqual(['Версия 3 с обеих сторон', 'Нет агрегатов книги'])
  })

  test('tasks keep their type and fold a name over lines', () => {
    expect(planTasks(PLAN)).toEqual([
      { name: 'Задача 1 (tracer): гейт', type: 'tracer' },
      { name: 'Задача 2: инвариант', type: 'auto' },
    ])
    expect(tagBlock(PLAN, 'objective')?.startsWith('Поднять контракт')).toBe(true)
  })

  test('a summary leads with its title and first paragraph', () => {
    const summary = '---\nstatus: complete\n---\n\n# Phase 118 Plan 01: штамп\n\nРезультат несёт скаляр.\nВерсия 3.\n\nВетка wt/118-01.\n'
    expect(summaryLead(summary)).toEqual({ title: 'Phase 118 Plan 01: штамп', lead: 'Результат несёт скаляр. Версия 3.' })
  })

  test('ROADMAP titles come from the checklist, first mention wins', () => {
    const roadmap = '- [ ] **Phase 111.1: Ключи ошибок** (∥) - x\n- [x] **Phase 118: Агрегация** - y\n- [x] **Phase 118: старое** - z'
    const titles = roadmapTitles(roadmap)
    expect(titles.get('111.1')).toBe('Ключи ошибок')
    expect(titles.get('118')).toBe('Агрегация')
  })

  test('a plain checklist line or a phase heading names the phase too', () => {
    const roadmap = [
      '- [x] Phase 2: The gate and the writer',
      '- [x] Phase 3: Waves computed in code — completed 2026-08-26. Deferred earlier',
      '- [ ] Phase 6: Wire the wave solver - filed later',
      '## Phase 4.1: Template registry from frontmatter',
      '## Phase 2: Later heading loses',
    ].join('\n')
    const titles = roadmapTitles(roadmap)
    expect(titles.get('2')).toBe('The gate and the writer')
    expect(titles.get('3')).toBe('Waves computed in code')
    expect(titles.get('6')).toBe('Wire the wave solver')
    expect(titles.get('4.1')).toBe('Template registry from frontmatter')
  })

  test('phases are counted from the list once it is in; STATE.md counts only before that', () => {
    const state = toSummary('/p', 'p', '---\nprogress:\n  total_phases: 8\n  completed_phases: 0\n  total_plans: 2\n  completed_plans: 1\n---\n')
    const rows = [
      { number: '1', name: 'a', plans: 1, summaries: 1, status: 'Complete', summariesAll: 1, farthest: null },
      { number: '2', name: 'b', plans: 1, summaries: 0, status: 'Planned', summariesAll: 0, farthest: null },
    ]
    expect(milestoneCounts(state, [])).toBe('фазы 0/8 · планы 1/2')
    expect(milestoneCounts(state, rows)).toBe('планы 1/2')
    expect(milestoneCounts(state, rows, false)).toBe('принято 1/2 · планы 1/2')
  })

  test('the current phase is named by its title where STATE.md holds only the slug', () => {
    const at = (name: string) => toSummary('/p', 'p', `---\ncurrent_phase: 120\ncurrent_phase_name: ${name}\n---\n`)
    const rows = [{ number: '120', name: 'Честные цифры', plans: 1, summaries: 0, status: 'Planned', summariesAll: 0, farthest: null }]
    expect(currentPhaseName(at('chestnye-tsifry'), rows)).toBe('Честные цифры')
    expect(currentPhaseName(at('The gate and the writer'), rows)).toBe('The gate and the writer')
    expect(currentPhaseName(at('chestnye-tsifry'), [])).toBe('chestnye-tsifry')
  })
})

test('control characters never reach a drawing', () => {
  expect(clean('ok\u001b[31m red\u0007 ‮flip\nnext\tcol')).toBe('ok[31m red flip\nnext\tcol')
})

test('every control on the overview does what its label says', async ($, on) => {
  const writes: { key: string; value: unknown }[] = []
  const rows = Array.from({ length: 11 }, (_, at) => ({
    number: String(110 + at),
    name: `Фаза ${110 + at}`,
    plans: 2,
    summaries: at < 8 ? 2 : 0,
    status: at < 8 ? 'Complete' : 'Not Started',
    summariesAll: at < 8 ? 2 : 0,
    farthest: null,
  }))
  const project = toSummary('/mn', 'mn', '---\nmilestone: v7.5\ncurrent_phase: 118\nstatus: executing\n---\n')
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({
    value: {
      value:
        e.key === 'projects'
          ? { shape: 'projects-2', value: [project] }
          : e.key === 'focus'
            ? '/mn'
            : e.key === 'detail'
              ? { shape: 'detail-5', value: { ...(SEED.detail as { value: object }).value, dir: '/mn', phases: rows } }
              : undefined,
      version: 1,
    },
  }))
  on('state.set', (_, e) => {
    writes.push({ key: e.key, value: e.value })

    return { value: { isSet: true, version: 1 } }
  })
  // gsd-tools is out of reach in a test: opening a phase still moves the view.
  on('env.get', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'phase:110' })).toBe(undefined)
  expect(await ui.find({ key: 'phases:above' })).toBeDefined()
  await ui.press({ key: 'phases:above' })
  await ui.press({ key: 'phase:118' })
  await ui.press({ key: 'milestone' })
  await ui.unmount()

  expect(writes.find(one => one.key === 'isAllPhases')?.value).toBe(true)
  expect(writes.filter(one => one.key === 'view').map(one => one.value)).toEqual([
    { shape: 'view-1', value: { kind: 'phase', phase: '118' } },
    { shape: 'view-1', value: { kind: 'milestone' } },
  ])
})

describe('click-through of every remaining control', () => {
  const stateOf = (extra: Record<string, unknown>) => (_: unknown, e: { key: string }) => ({
    value: { value: e.key in extra ? extra[e.key] : SEED[e.key], version: 1 },
  })
  const record = (on: any) => {
    const writes: { key: string; value: unknown }[] = []
    const fills: string[] = []
    on('state.set', (_: unknown, e: { key: string; value: unknown }) => {
      writes.push({ key: e.key, value: e.value })

      return { value: { isSet: true, version: 1 } }
    })
    on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
    on('prompt.fill', (_: unknown, e: { text: string }) => {
      fills.push(e.text)

      return { isFilled: true, cursor: e.text.length }
    })
    on('env.get', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    on('fs.list', () => ({ value: [] }))
    on('fs.read', () => ({ value: '' }))
    on('clock.now', () => ({ value: 0 }))
    on('store.get', () => ({ value: undefined }))
    on('store.set', () => ({ value: undefined }))
    on('ui.status', () => ({ value: undefined }))

    return { writes, fills }
  }
  const keys = (writes: { key: string }[]) => [...new Set(writes.map(one => one.key))]

  test('overview: refresh, rescan, hint toggle, project, current phase', async ($, on) => {
    const { writes } = record(on)
    on('state.get', stateOf({}))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'refresh' })
    await ui.press({ key: 'suggest' })
    await ui.press({ key: 'project:/mn' })
    await ui.press({ key: 'current-phase' })
    await ui.press({ key: 'rescan' })
    await ui.unmount()
    // refresh: no gsd-tools here, so it says so; the hint flips; the project and
    // the current phase move focus and view; rescan rewrites the project list.
    expect(writes.find(one => one.key === 'problem')?.value).toBe('gsd-tools.cjs не найден ни в .claude/ проекта, ни в ~/.claude/')
    expect(writes.find(one => one.key === 'isSuggesting')?.value).toBe(false)
    expect(writes.find(one => one.key === 'focus')?.value).toBe('/mn')
    // A new project returns the view to the overview; the current phase then opens.
    expect(writes.filter(one => one.key === 'view').map(one => one.value)).toEqual([
      { shape: 'view-1', value: { kind: 'home' } },
      { shape: 'view-1', value: { kind: 'phase', phase: '1' } },
    ])
    expect(keys(writes)).toContain('projects')
  })

  test('overview: the project picker moves the focus', async ($, on) => {
    const { writes } = record(on)
    on('state.get', stateOf({}))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.select({ key: 'project', value: '/mn' })
    await ui.unmount()
    expect(writes.find(one => one.key === 'focus')?.value).toBe('/mn')
  })

  test('phase card: document, plan row, @PLAN', async ($, on) => {
    const { writes, fills } = record(on)
    const plan = {
      id: '01-01', objective: 'x', truths: [], tasks: [], dependsOn: [], requirements: [], files: [],
      planPath: '/mn/apps/asgard/.planning/phases/01-spaik/01-01-PLAN.md', summaryPath: null, summaryTitle: null, summaryLead: null,
    }
    on('state.get', stateOf({
      view: { shape: 'view-1', value: { kind: 'phase', phase: '01' } },
      phaseCard: { shape: 'phase-card-2', value: PHASE_CARD },
      expanded: 'plan:01-01',
      planDetail: { shape: 'plan-detail-1', value: plan },
    }))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'doc:/mn/apps/asgard/.planning/phases/01-spaik/01-CONTEXT.md' })
    await ui.press({ key: `plan-doc:${plan.planPath}` })
    await ui.press({ key: 'plan:01-10' })
    await ui.press({ key: 'action:/gsd-verify-work 01' })
    await ui.unmount()
    // The session root is the test's, so a mention carries the path as given.
    expect(fills.length).toBe(3)
    expect(fills[0]?.startsWith('@')).toBe(true)
    expect(fills[2]).toBe('/gsd-verify-work 01 ')
    expect(writes.find(one => one.key === 'expanded')?.value).toBe('plan:01-10')
  })

  test('milestone card: a requirement opens and closes', async ($, on) => {
    const { writes } = record(on)
    on('state.get', stateOf({
      view: { shape: 'view-1', value: { kind: 'milestone' } },
      milestoneCard: {
        shape: 'milestone-card-1',
        value: {
          dir: '/mn/apps/asgard', version: 'v1.0', name: null, coreValue: null, overview: null,
          requirements: [{ id: 'SPK-01', text: 'Спайк', isComplete: false, phases: ['1'] }],
          acceptedPhases: null, completedPlans: null,
        },
      },
    }))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'req:SPK-01' })
    await ui.press({ key: 'back' })
    await ui.unmount()
    expect(writes.find(one => one.key === 'expanded')?.value).toBe('req:SPK-01')
    expect(writes.find(one => one.key === 'view')?.value).toEqual({ shape: 'view-1', value: { kind: 'home' } })
  })
})

test('a host that says not interactive still gets /gsd-deck, and no walk', async ($, on) => {
  // The desktop app hosts its Code sessions as the SDK does: isInteractive is
  // false and no surface is attached yet when the session starts.
  const registered: string[] = []
  const listed: string[] = []
  on('command.register', (_, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('fs.list', (_, e) => {
    listed.push(String(e.path))

    return { value: [] }
  })

  await $.session.start({ cwd: '/mn', surface: null, isInteractive: false })
  expect(registered).toEqual(['gsd-deck'])
  expect(listed).toEqual([])
})

describe('a session opened inside a project', () => {
  const POLYGLOT = '/mn/.claude/worktrees/polyglot-autonomous/apps/polyglot'

  test('inside its .planning, the project is read off the path', async () => {
    const nothing = {} as Parameters<typeof projectAbove>[0]
    expect(await projectAbove(nothing, `${POLYGLOT}/.planning`)).toBe(POLYGLOT)
    expect(await projectAbove(nothing, `${POLYGLOT}/.planning/phases/118-x`)).toBe(POLYGLOT)
  })

  // The test's $ has no fs noun: these two take a stand-in for it.
  const withFiles = (present: readonly string[]) =>
    ({ fs: { exists: async (path: string) => present.includes(path) } }) as unknown as Parameters<typeof projectAbove>[0]

  test('deeper in its code, the nearest folder holding .planning/STATE.md', async () => {
    expect(await projectAbove(withFiles([`${POLYGLOT}/.planning/STATE.md`]), `${POLYGLOT}/web/src`)).toBe(POLYGLOT)
  })

  test('nowhere near one, none', async () => {
    expect(await projectAbove(withFiles([]), '/tmp/scratch')).toBe(undefined)
  })

  test('a project above the session is named by its folder', () => {
    expect(projectName(`${POLYGLOT}/.planning`, POLYGLOT)).toBe('polyglot')
    expect(projectName('/mn', '/mn/apps/rpg')).toBe('apps/rpg')
    expect(projectName('/mn', '/mn')).toBe('mn')
  })
})

describe('which checkout the session runs in', () => {
  // What git answered in mn, from the worktree and from the main checkout.
  const answering = (answers: Record<string, string | null>) =>
    ({
      process: {
        run: async (argv: readonly string[]) => {
          const out = answers[argv.slice(3).join(' ')]

          return out === null || out === undefined
            ? { exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false }
            : { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        },
      },
    }) as unknown as Parameters<typeof gitCheckout>[0]

  test('a worktree knows its main checkout and its branch', async () => {
    const $ = answering({
      'rev-parse --show-toplevel --git-common-dir':
        '/home/dev/mn/.claude/worktrees/polyglot-autonomous\n/home/dev/mn/.git\n',
      'branch --show-current': 'worktree-polyglot-autonomous\n',
    })
    expect(await gitCheckout($, '/home/dev/mn/.claude/worktrees/polyglot-autonomous/apps/polyglot/.planning')).toEqual({
      top: '/home/dev/mn/.claude/worktrees/polyglot-autonomous',
      main: '/home/dev/mn',
      branch: 'worktree-polyglot-autonomous',
      isWorktree: true,
    })
  })

  test('the main checkout is its own main', async () => {
    const $ = answering({
      'rev-parse --show-toplevel --git-common-dir': '/home/dev/mn\n.git\n',
      'branch --show-current': 'main\n',
    })
    expect(await gitCheckout($, '/home/dev/mn')).toEqual({
      top: '/home/dev/mn',
      main: '/home/dev/mn',
      branch: 'main',
      isWorktree: false,
    })
  })

  test('outside git there is no checkout', async () => {
    expect(await gitCheckout(answering({}), '/tmp/scratch')).toBe(undefined)
  })
})

describe('markdown in planning prose', () => {
  test('a row loses the markers it cannot draw, and keeps the words', () => {
    expect(plain('Скаляр `properNounTokenCount` и **версия 3**, см. [ADR](docs/adr.md)')).toBe('Скаляр properNounTokenCount и версия 3, см. ADR')
  })

  test('a list item that spans lines stays one item', () => {
    expect(markdownList(['первый\n  с переносом', 'второй'], true)).toBe('1. первый с переносом\n2. второй')
    expect(markdownList(['a', 'b'], false)).toBe('- a\n- b')
  })
})

describe('the retro schedule', () => {
  // What `retro due` answered for apps/polyglot on the feat/retro-cadence build.
  const POLYGLOT_DUE = {
    due: true, trigger: 'cadence', triggers: ['cadence'], reason: 'cadence-reached', active: true, mode: 'suggest',
    planningDir: '.planning', milestone: 'v5.0', cadencePhases: 3, atMilestoneStart: true,
    phases: { total: 25, executed: 7, started: 11 }, phasesSinceRetro: 7,
    phasesSinceRetroIds: ['113', '114', '115', '116', '117', '118', '119'], baseline: 'milestone',
    lastRetro: null, latestReport: null, journal: '.planning/retro/RUNS.json', problems: [],
  }

  test('reads what gsd-tools answers, and nothing from an older gsd-tools', () => {
    expect(toRetroDue(POLYGLOT_DUE)).toEqual({
      isDue: true, trigger: 'cadence', phasesSince: 7, cadence: 3, lastRetroAt: null, milestone: 'v5.0', journal: 'ok',
    })
    expect(toRetroDue(undefined)).toBe(null)
    expect(toRetroDue({ error: 'Unknown retro subcommand' })).toBe(null)
  })

  test('says why a retro is owed', () => {
    const due = toRetroDue(POLYGLOT_DUE)!
    expect(retroWhy(due)).toBe('с начала milestone исполнено фаз: 7 (ретро раз в 3)')
    expect(retroWhy({ ...due, lastRetroAt: '2026-10-20T10:00:00.000Z', phasesSince: 3 })).toBe('с ретро 2026-10-20 исполнено фаз: 3 (ретро раз в 3)')
    expect(retroWhy({ ...due, trigger: 'milestone-start', phasesSince: 0 })).toBe('milestone v5.0 подготовлен, фазы ещё не начаты')
  })

  test('counts down to the next one at the cadence boundary', () => {
    const base = { isDue: false, trigger: null, cadence: 3, lastRetroAt: null, milestone: 'v1.0', journal: 'ok' as const }
    expect(retroLeft({ ...base, phasesSince: 1 })).toBe('до ретро фаз: 2')
    expect(retroLeft({ ...base, phasesSince: 2 })).toBe('до ретро фаз: 1')
    expect(retroLeft({ ...base, phasesSince: 3, isDue: true, trigger: 'cadence' })).toBe('пора ретро')
    expect(retroLeft({ ...base, cadence: 0, phasesSince: 9 })).toBe(null)
  })

  test('a journal that cannot be read pauses the count instead of inventing one', () => {
    // What retro due answers on the merged build for `{ nope` in RUNS.json.
    const broken = toRetroDue({
      due: false, trigger: null, triggers: [], reason: 'journal-invalid', cadencePhases: 2, milestone: 'v5.0',
      phasesSinceRetro: null, phasesSinceRetroIds: null, baseline: 'unknown', lastRetro: null,
      problems: ['RUNS.json is not JSON'],
    })!
    expect(broken.journal).toBe('broken')
    expect(retroLeft(broken)).toBe('ретро на паузе: .planning/retro/RUNS.json не читается')
    expect(journalWarning('broken')).toContain('исправьте или удалите')
  })

  test('a journal from a newer GSD pauses the count and says to update, not delete', () => {
    // What an older gsd-tools answers for a version-2 RUNS.json after retro §10.
    const newer = toRetroDue({
      due: false, trigger: null, triggers: [], reason: 'journal-newer', cadencePhases: 2, milestone: 'v5.0',
      phasesSinceRetro: null, lastRetro: null, problems: [],
    })!
    expect(newer.journal).toBe('newer')
    expect(retroLeft(newer)).toBe('ретро на паузе: журнал от более новой версии GSD')
    expect(journalWarning('newer')).toContain('обновите GSD')
    expect(journalWarning('newer')).not.toContain('удалите его')
  })

  test('a readable journal counts as ok', () => {
    const fine = toRetroDue({ due: false, trigger: null, reason: 'not-due', cadencePhases: 2, phasesSinceRetro: 1 })!
    expect(fine.journal).toBe('ok')
  })
})

describe('progress across branches and worktrees', () => {
  // apps/polyglot phase 120: main and this checkout hold 9 summaries, the
  // chain of plan branches holds five more (120-10..14), 120-15 is running.
  const P = 'apps/polyglot/.planning/phases/120-chestnye-tsifry'
  const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, at) => String(from + at).padStart(2, '0'))
  const files = (kind: string, list: string[]) => list.map(id => `${P}/120-${id}-${kind}.md`)
  const row = { number: '120', name: 'Честные цифры', plans: 22, summaries: 9, status: 'In Progress', summariesAll: 9, farthest: null }

  const evidence = () => {
    const into = new Map()
    addPlanningFiles(into, [...files('PLAN', ids(1, 22)), ...files('SUMMARY', ids(1, 9))], HERE)
    addPlanningFiles(into, [...files('SUMMARY', ids(1, 14)), ...files('REVIEW', ids(1, 14))], 'wt/120-14')
    addPlanningFiles(into, files('SUMMARY', ids(1, 14)), 'wt/120-15')
    addPlanningFiles(into, [`apps/polyglot/.planning/phases/125-ocheredi/125-01-PLAN.md`, `apps/polyglot/.planning/phases/125-ocheredi/125-01-SUMMARY.md`], 'wt/125-05')
    return into
  }

  test('a phase counts the summaries found anywhere, and names where they are', () => {
    const [merged] = withElsewhere([row], evidence(), new Map())
    expect(merged?.summariesAll).toBe(14)
    expect(merged?.summaries).toBe(9)
    expect(merged?.farthest).toBe('wt/120-14')
    expect(merged?.status).toBe('In Progress')
  })

  test('a phase only a branch knows is listed when the milestone names it, its status raised to what the branch shows', () => {
    const rows = withElsewhere([row], evidence(), new Map([['125', 'Очереди']]), ['120', '125'])
    expect(rows.map(one => one.number)).toEqual(['120', '125'])
    expect(rows[1]).toEqual({ number: '125', name: 'Очереди', plans: 1, summaries: 0, status: 'Executed', summariesAll: 1, farthest: 'wt/125-05' })
    // Not named by the current milestone: not this milestone's phase.
    expect(withElsewhere([row], evidence(), new Map(), ['120']).map(one => one.number)).toEqual(['120'])
  })

  // trade-mind: 92 old milestones' folders still under phases/, gsd-tools lists 9.
  test('a folder of this checkout that gsd-tools does not list is never added', () => {
    const into = new Map()
    addPlanningFiles(into, ['apps/t/.planning/phases/07-legacy/07-01-PLAN.md', 'apps/t/.planning/phases/07-legacy/07-01-SUMMARY.md'], HERE)
    expect(withElsewhere([], into, new Map(), ['07'])).toEqual([])
  })

  test("this checkout's counts are gsd-tools' own: a blocked summary it skips is not counted back", () => {
    const into = new Map()
    addPlanningFiles(into, [`${P}/120-01-PLAN.md`, `${P}/120-01-SUMMARY.md`, `${P}/120-02-PLAN.md`], HERE)
    addPlanningFiles(into, [`${P}/120-03-PLAN.md`, `${P}/120-03-SUMMARY.md`, `${P}/120-01-SUMMARY.md`], 'wt/120-03')
    // gsd-tools: 2 plans, none done (120-01's summary says blocked).
    const [one] = withElsewhere([{ ...row, plans: 2, summaries: 0, summariesAll: 0, status: 'Planned' }], into, new Map())
    expect(one?.plans).toBe(3)
    expect(one?.summariesAll).toBe(1)
    expect(one?.farthest).toBe('wt/120-03')
  })

  test('only plans done outside this checkout are listed as elsewhere', () => {
    const away = elsewhereByPlan(evidence())
    expect(Object.keys(away['120'] ?? {})).toEqual(['120-10', '120-11', '120-12', '120-13', '120-14'])
    expect(away['120']?.['120-10']).toBe('wt/120-14')
  })

  test('git status keeps what is present and drops what is deleted', () => {
    expect(presentPaths(`?? ${P}/120-15-SUMMARY.md\n M ${P}/120-14-PLAN.md\n D ${P}/120-02-SUMMARY.md\nR  old.md -> ${P}/120-16-PLAN.md\n`)).toEqual([
      `${P}/120-15-SUMMARY.md`,
      `${P}/120-14-PLAN.md`,
      `${P}/120-16-PLAN.md`,
    ])
  })

  test('the gather reads this checkout, other worktrees and unmerged branches', async () => {
    const answers: Record<string, string> = {
      'rev-parse --show-toplevel': '/mn\n',
      'ls-tree -r --name-only HEAD -- apps/polyglot/.planning/phases': [...files('PLAN', ids(1, 22)), ...files('SUMMARY', ids(1, 9))].join('\n'),
      'status --porcelain --untracked-files=all -- apps/polyglot/.planning/phases': '',
      'worktree list --porcelain': 'worktree /mn\nHEAD a\nbranch refs/heads/main\n\nworktree /mn-wt-120-15\nHEAD b\nbranch refs/heads/wt/120-15\n',
      'for-each-ref --no-merged=HEAD --sort=-committerdate --format=%(refname:short) refs/heads': 'wt/120-15\nwt/120-14\n',
      'ls-tree -r --name-only wt/120-14 -- apps/polyglot/.planning/phases': files('SUMMARY', ids(1, 14)).join('\n'),
      'ls-tree -r --name-only wt/120-15 -- apps/polyglot/.planning/phases': files('SUMMARY', ids(1, 14)).join('\n'),
      'show wt/120-14:apps/polyglot/.planning/STATE.md': '---\nmilestone: v5.0\n---\n',
      'show wt/120-15:apps/polyglot/.planning/STATE.md': '---\nmilestone: "5.0"\n---\n',
    }
    const asked: string[] = []
    const states = { '/mn/apps/polyglot/.planning/STATE.md': '---\nmilestone: v5.0\n---\n', '/mn-wt-120-15/apps/polyglot/.planning/STATE.md': '---\nmilestone: v5.0\n---\n' }
    const $ = gitAnswering(
      answers,
      asked,
      (where, key) =>
        // The running plan's worktree has written 120-15's summary, not committed yet.
        where === '/mn-wt-120-15' && key.startsWith('status') ? `?? ${P}/120-15-SUMMARY.md\n` : undefined,
      states,
    )

    const found = await gatherPlanning($, '/mn/apps/polyglot')
    const phase = found?.get('120')
    expect(phase?.plans.size).toBe(22)
    expect(phase?.summaries.size).toBe(15)
    expect(phase?.summaries.get('120-09')).toBe(HERE)
    expect(phase?.summaries.get('120-15')).toBe('wt/120-15')
    expect(asked.some(line => line.startsWith('/mn-wt-120-15 status'))).toBe(true)
  })

  // get_your_look_up after closing v1.12: an old fix branch holds v1.0's
  // phases 01-07, a forgotten worktree holds v1.11's 77-87; both milestones
  // are archived here.
  test('a branch or worktree on another milestone, or a phase archived here, is not counted', async () => {
    const state = (milestone: string) => `---\nmilestone: ${milestone}\nstatus: executing\n---\n`
    const old = (phase: string) => [`.planning/phases/${phase}/${phase.slice(0, 2)}-01-PLAN.md`, `.planning/phases/${phase}/${phase.slice(0, 2)}-01-SUMMARY.md`].join('\n')
    const answers: Record<string, string> = {
      'rev-parse --show-toplevel': '/look\n',
      'ls-tree -r --name-only HEAD -- .planning/phases': '',
      'status --porcelain --untracked-files=all -- .planning/phases': '',
      'ls-tree -r -d --name-only HEAD -- .planning/milestones': '.planning/milestones\n.planning/milestones/v1.12-phases\n.planning/milestones/v1.12-phases/92-lenta\n',
      'worktree list --porcelain': 'worktree /look\nHEAD a\nbranch refs/heads/main\n\nworktree /look-wt\nHEAD b\nbranch refs/heads/worktree-investor\n',
      'for-each-ref --no-merged=HEAD --sort=-committerdate --format=%(refname:short) refs/heads': 'fix/old\nwt/92-02\nwt/93-01\nno-state\n',
      'ls-tree -r --name-only no-state -- .planning/phases': old('94-bez-state'),
      'ls-tree -r --name-only fix/old -- .planning/phases': old('01-security'),
      'show fix/old:.planning/STATE.md': state('v1.0'),
      'ls-tree -r --name-only wt/92-02 -- .planning/phases': old('92-lenta'),
      'show wt/92-02:.planning/STATE.md': state('v1.12'),
      'ls-tree -r --name-only wt/93-01 -- .planning/phases': old('93-poisk'),
      'show wt/93-01:.planning/STATE.md': state('v1.12'),
    }
    const files: Record<string, string> = { '/look/.planning/STATE.md': state('v1.12'), '/look-wt/.planning/STATE.md': state('v1.11') }
    const asked: string[] = []
    // The forgotten worktree has an uncommitted v1.11 summary.
    const $ = gitAnswering(answers, asked, (where, key) => (where === '/look-wt' && key.startsWith('status') ? `?? ${old('77-stend').split('\n')[1]}\n` : undefined), files)

    const found = await gatherPlanning($, '/look')
    expect([...(found?.keys() ?? [])]).toEqual(['93'])
    expect(found?.get('93')?.summaries.get('93-01')).toBe('wt/93-01')
    // A branch on another milestone, or with no STATE.md, is never listed.
    expect(asked.filter(line => line.includes('ls-tree -r --name-only fix/old') || line.includes('ls-tree -r --name-only no-state'))).toEqual([])
  })

  test('numbering restarted with this milestone: an older archive does not hide its phase 01', async () => {
    const answers: Record<string, string> = {
      'rev-parse --show-toplevel': '/p\n',
      'ls-tree -r -d --name-only HEAD -- .planning/milestones': '.planning/milestones/v1.0-phases/01-setup\n',
      'for-each-ref --no-merged=HEAD --sort=-committerdate --format=%(refname:short) refs/heads': 'wt/01-02\n',
      'show wt/01-02:.planning/STATE.md': '---\nmilestone: v1.1\n---\n',
      'ls-tree -r --name-only wt/01-02 -- .planning/phases': '.planning/phases/01-auth/01-02-PLAN.md\n.planning/phases/01-auth/01-02-SUMMARY.md',
    }
    const found = await gatherPlanning(gitAnswering(answers, [], () => undefined, { '/p/.planning/STATE.md': '---\nmilestone: v1.1\n---\n' }), '/p')
    expect(found?.get('01')?.summaries.get('01-02')).toBe('wt/01-02')
  })

  test('a STATE.md names its milestone; one without frontmatter names none', () => {
    expect(milestoneOf('---\nmilestone: "v1.12"\n---\n')).toBe('v1.12')
    expect(milestoneOf('# Project State\n')).toBeNull()
    expect(milestoneOf(undefined)).toBeNull()
    expect(milestoneOf('---\nmilestone: 1.10\n---\n')).toBe('1.10')
  })

  test('the milestone archive yields its phase numbers, not its own folders', () => {
    const archive = 'apps/x/.planning/milestones'
    const paths = [archive, `${archive}/v1.3-phases`, `${archive}/v1.3-phases/07.1-hotfix`, `${archive}/v1.3-phases/07-file-size/sub`, `${archive}/v1.4-phases/09-x`]
    expect(archivedPhases(paths)).toEqual(['07.1', '09'])
    expect(archivedPhases(paths, '1.3')).toEqual(['07.1'])
  })
})

/** An engine whose git answers from a table, keyed by the arguments after `-C <dir>`. */
function gitAnswering(
  answers: Record<string, string>,
  asked: string[],
  special: (where: string, key: string) => string | undefined,
  files: Record<string, string> = {},
) {
  return {
    process: {
      run: async (argv: readonly string[]) => {
        const where = argv[2] ?? ''
        const key = argv.slice(3).join(' ')
        asked.push(`${where} ${key}`)
        const out = special(where, key) ?? answers[key]

        return { exitCode: out === undefined ? 1 : 0, stdout: out ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
    fs: {
      read: async (path: string) => {
        const text = files[path]
        if (text === undefined) throw new Error(`ENOENT ${path}`)

        return text
      },
    },
  } as unknown as Parameters<typeof gatherPlanning>[0]
}

describe('plans are counted from the files, not from STATE.md', () => {
  // gsd-core: STATE.md says 14 of 19, every phase directory holds its summaries.
  const project = toSummary('/g', 'gsd-core', '---\nstatus: verifying\nprogress:\n  total_phases: 6\n  completed_phases: 3\n  total_plans: 19\n  completed_plans: 14\n---\n')
  const phases = [3, 3, 3, 4, 3, 3].map((plans, at) => ({
    number: String(at + 1), name: 'x', plans, summaries: plans, status: 'Executed', summariesAll: plans, farthest: null,
  }))

  test('STATE.md behind the files is said so', () => {
    expect(planTally(project, phases)).toEqual({ total: 19, done: 19, here: 19, stated: '14/19' })
  })

  test('at the boundary: STATE.md one behind, level, or counting another scope', () => {
    const at = (completed: number, total = 19) => ({ ...project, completedPlans: completed, totalPlans: total })
    expect(planTally(at(18), phases)?.stated).toBe('18/19')
    expect(planTally(at(19), phases)?.stated).toBe(null)
    // polyglot: STATE.md counts the milestone's 281 plans; the list holds fewer.
    expect(planTally(at(260, 281), phases)?.stated).toBe(null)
  })

  test('before gsd-tools answers, STATE.md is what there is', () => {
    expect(planTally(project, [])).toEqual({ total: 19, done: 14, here: 14, stated: null })
  })

  const mountWith = (on: any, rows: object[]) => {
    on('clock.now', () => ({ value: 0 }))
    on('state.get', (_: unknown, e: { key: string }) => ({
      value: {
        value:
          e.key === 'projects'
            ? { shape: 'projects-2', value: [project] }
            : e.key === 'focus'
              ? '/g'
              : e.key === 'detail'
                ? { shape: 'detail-5', value: { ...(SEED.detail as { value: object }).value, dir: '/g', phases: rows, elsewhere: {} } }
                : undefined,
        version: 1,
      },
    }))
  }

  test('the header flags STATE.md behind the files', async ($, on) => {
    mountWith(on, phases)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /! STATE\.md отстаёт: в нём планы 14\/19, по файлам 19\/19/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /19\/19 · 100%/ })).toBeDefined()
    await ui.unmount()
  })

  test('a phase names the branch its progress is in, and the header says it is elsewhere', async ($, on) => {
    const away = { number: '120', name: 'Честные цифры', plans: 22, summaries: 9, status: 'In Progress', summariesAll: 14, farthest: 'wt/120-14' }
    mountWith(on, [...phases, away])
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /⑂ wt\/120-14/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /здесь 28, остальное в других ветках/ })).toBeDefined()
    // STATE.md counts 19 plans, the list now 41: another scope, no flag.
    expect(await ui.find({ type: 'Text', text: /STATE\.md отстаёт/ })).toBe(undefined)
    await ui.unmount()
  })
})

describe('the project list in a worktree', () => {
  const at = (name: string, checkout: string, phase: string | null, done: number) =>
    toSummary(`/${checkout}/${name}`, name, `---\nstatus: executing\nprogress:\n  total_plans: 15\n  completed_plans: ${done}\n---\n`, checkout)

  test('the main copy that says the same as the worktree copy is dropped; one that differs stays', () => {
    const list = [at('apps/asgard', 'ветка wt', null, 13), at('apps/polyglot', 'ветка wt', null, 14), at('apps/asgard', 'основной', null, 13), at('apps/polyglot', 'основной', null, 9)]
    expect(withoutSameMain(list).map(one => `${one.name} ${one.checkout}`)).toEqual(['apps/asgard ветка wt', 'apps/polyglot ветка wt', 'apps/polyglot основной'])
  })

  test('a hand-written phase field shows as its number', () => {
    expect(phaseToken('7 — polyglot Integration — Second Host (COMPLETE, 2/2 plans)')).toBe('7')
    expect(phaseToken('132.1')).toBe('132.1')
    expect(phaseToken('11a: foundation')).toBe('11a')
    expect(phaseToken('Milestone v1.12 complete')).toBe('Milestone v1.12 complete')
  })
})

describe('a verifier verdict on the phase list', () => {
  // gsd-core's own v1.0: 05's verifier found gaps, gsd-tools still calls it Executed.
  const row = (number: string, status: string) => ({ number, name: number, plans: 3, summaries: 3, status, summariesAll: 3, farthest: null })
  const tree: Record<string, { name: string; kind: string }[]> = {
    '/g/.planning/phases': [
      { name: '04-template-layout', kind: 'dir' },
      { name: '04.1-template-registry', kind: 'dir' },
      { name: '05-feature-as-a-tag', kind: 'dir' },
    ],
    '/g/.planning/phases/04.1-template-registry': [{ name: '04.1-VERIFICATION.md', kind: 'file' }],
    '/g/.planning/phases/05-feature-as-a-tag': [{ name: '05-01-PLAN.md', kind: 'file' }, { name: '05-VERIFICATION.md', kind: 'file' }],
  }
  const text: Record<string, string> = {
    '/g/.planning/phases/04.1-template-registry/04.1-VERIFICATION.md': '---\nstatus: passed\n---\n',
    '/g/.planning/phases/05-feature-as-a-tag/05-VERIFICATION.md': '---\nphase: 05\nstatus: gaps_found\nscore: 16/17\n---\n',
  }
  const $ = {
    fs: {
      list: async (path: string) => tree[path] ?? Promise.reject(new Error(`ENOENT ${path}`)),
      read: async (path: string) => text[path] ?? Promise.reject(new Error(`ENOENT ${path}`)),
    },
  } as unknown as Parameters<typeof withVerdicts>[0]

  test('an executed phase whose verifier found gaps is marked; passed, unread and other steps are left alone', async () => {
    const rows = await withVerdicts($, '/g', [row('04', 'Needs Review'), row('04.1', 'Executed'), row('05', 'Executed'), row('06', 'Executed')])
    expect(rows.map(one => one.status)).toEqual(['Needs Review', 'Executed', GAPS_FOUND, 'Executed'])
  })
})

describe('plan ids as GSD writes them', () => {
  const P = 'apps/polyglot/.planning/phases/111.1-klyuchi'

  test('every *-PLAN.md is a plan; a summary without a plan, and the phase review, are not counted', () => {
    const into = new Map()
    addPlanningFiles(into, [
      `${P}/111.1-03a-PLAN.md`, `${P}/111.1-03a-SUMMARY.md`,
      `${P}/111.1-d31b-PLAN.md`, `${P}/111.1-d31b-SUMMARY.md`,
      `${P}/111.1-b2-1-PLAN.md`, `${P}/111.1-trade-config-d4-PLAN.md`,
      `${P}/111.1-d01-T1-SUMMARY.md`, `${P}/111.1-REVIEW.md`, `${P}/111.1-d31b-REVIEW.md`,
    ], HERE)
    const phase = withoutOrphans(into).get('111.1')
    expect([...(phase?.plans.keys() ?? [])].sort()).toEqual(['111.1-03a', '111.1-b2-1', '111.1-d31b', '111.1-trade-config-d4'])
    expect([...(phase?.summaries.keys() ?? [])].sort()).toEqual(['111.1-03a', '111.1-d31b'])
  })
})

describe('phase and plan ids', () => {
  test('a plan pairs with its summary as gsd-core pairs them', () => {
    expect(canonicalPlanId('68-01-scaffolding')).toBe('68-01')
    expect(canonicalPlanId('68-01')).toBe('68-01')
    expect(canonicalPlanId('03a-01')).toBe('03a-01')
    expect(canonicalPlanId('111.1-d31b')).toBe('111.1-d31b')
    expect(canonicalPlanId('111.1-b2-1')).toBe('111.1-b2-1')
    // A bare digit and a year are slug words, not plan numbers.
    expect(canonicalPlanId('46-6-rs-fix')).toBe('46-6-rs-fix')
    expect(canonicalPlanId('14-2026-notes')).toBe('14-2026-notes')
  })

  test('phase ids compare part by part', () => {
    expect(isSamePhase('01', '1')).toBe(true)
    expect(isSamePhase('1.10', '1.1')).toBe(false)
    expect(isSamePhase('111.10', '111.1')).toBe(false)
    expect(isSamePhase('05b', '05')).toBe(false)
    expect(isSamePhase('05B', '05b')).toBe(true)
    expect(['3.4.38', '3.4.4', '10', '2', '3.4', '05b', '05'].sort(comparePhase)).toEqual(['2', '3.4', '3.4.4', '3.4.38', '05', '05b', '10'])
  })

  test('a frontmatter value reads as written', () => {
    const state = '---\nmilestone: 1.10   # current\ncurrent_phase: "1.10"\nmilestone_name: \'x # y\'\n---\n'
    expect(rawField(state, 'milestone')).toBe('1.10')
    expect(rawField(state, 'current_phase')).toBe('1.10')
    expect(rawField(state, 'milestone_name')).toBe('x # y')
    expect(rawField(state, 'absent')).toBeNull()
    expect(toSummary('/p', 'p', '---\ncurrent_phase: 7 — polyglot Integration (COMPLETE)\n---\n').phase).toBe('7')
  })

  test('a folder with a letter is its own phase', () => {
    const into = new Map()
    addPlanningFiles(into, ['.planning/phases/05-services/05-01-PLAN.md', '.planning/phases/05b-subskills/05b-01-PLAN.md'], HERE)
    expect([...into.keys()].sort()).toEqual(['05', '05b'])
  })
})

describe('ROADMAP titles of the current milestone', () => {
  test('a shipped milestone folded in <details> loses to the current one, and only fills in', () => {
    const roadmap = [
      '<details><summary>v1.0</summary>',
      '',
      '### Phase 1: Old title',
      '### Phase 9: Only in the archive',
      '</details>',
      '',
      '- [ ] **Phase 1: New title**',
      '- [x] **Phase 5:** Colon inside the bold — shipped',
    ].join('\n')
    const titles = roadmapTitles(roadmap)
    expect(titles.get('1')).toBe('New title')
    expect(titles.get('9')).toBe('Only in the archive')
    expect(titles.get('5')).toBe('Colon inside the bold')
  })
})

describe('the verifier report a phase is judged by', () => {
  const tree: Record<string, { name: string; kind: string }[]> = {
    '/f/.planning/phases': [
      { name: '01-setup', kind: 'dir' },
      { name: '28-fractional-kelly', kind: 'dir' },
      { name: '28-kelly-sizing', kind: 'dir' },
    ],
    '/f/.planning/phases/01-setup': [{ name: '01-01-VERIFICATION.md', kind: 'file' }, { name: '01-VERIFICATION.md', kind: 'file' }],
    '/f/.planning/phases/28-fractional-kelly': [{ name: '28-VERIFICATION.md', kind: 'file' }],
    '/f/.planning/phases/28-kelly-sizing': [{ name: '28-VERIFICATION.md', kind: 'file' }],
  }
  const text: Record<string, string> = {
    '/f/.planning/phases/01-setup/01-01-VERIFICATION.md': '---\nstatus: passed\n---\n',
    '/f/.planning/phases/01-setup/01-VERIFICATION.md': '---\nstatus: gaps_found\n---\n',
    '/f/.planning/phases/28-fractional-kelly/28-VERIFICATION.md': '---\nstatus: passed\n---\n',
    '/f/.planning/phases/28-kelly-sizing/28-VERIFICATION.md': '---\nstatus: gaps_found\n---\n',
  }
  const $ = {
    fs: {
      list: async (path: string) => tree[path] ?? Promise.reject(new Error(`ENOENT ${path}`)),
      read: async (path: string) => text[path] ?? Promise.reject(new Error(`ENOENT ${path}`)),
    },
  } as unknown as Parameters<typeof withVerdicts>[0]
  const row = (number: string, name: string) => ({ number, name, plans: 1, summaries: 1, status: 'Executed', summariesAll: 1, farthest: null })

  test("the phase's own report wins over a plan's; of two folders with one number, the one with the row's name", async () => {
    const rows = await withVerdicts($, '/f', [row('01', 'setup'), row('28', 'kelly sizing'), row('28', 'fractional kelly')])
    expect(rows.map(one => one.status)).toEqual([GAPS_FOUND, GAPS_FOUND, 'Executed'])
  })
})

test('a gsd-tools call that failed says why in the next block', async ($, on) => {
  const failing = { ...(SEED.detail as { value: object }).value, toolErrors: ['progress json: Error: Verification report "122-VERIFICATION.md" has status "not_started"'] }
  on('clock.now', () => ({ value: 0 }))
  on('state.get', (_, e) => ({ value: { value: e.key === 'detail' ? { shape: 'detail-5', value: failing } : SEED[e.key], version: 1 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /! gsd-tools progress json: Error: Verification report/ })).toBeDefined()
  await ui.unmount()
})
