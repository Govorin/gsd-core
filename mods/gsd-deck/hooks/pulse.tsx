// A running workflow's or agent's indicator: a turning mark and its elapsed
// time, ticking on the surface's own clock so the pane is not redrawn every
// second. It stops ticking once the hooks module says the run has ended.
import type { ClientModule } from 'claude-code'

type Props = { since: number; now: number; endAt: number | null; color: string }
type Ref = { base: number; ticks: number; lastNow: number; isRunning: boolean }
type State = { ref: Ref }

const FRAMES = ['◐', '◓', '◑', '◒']

const elapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)

  return minutes < 60
    ? `${minutes}:${String(seconds % 60).padStart(2, '0')}`
    : `${Math.floor(minutes / 60)}ч${String(minutes % 60).padStart(2, '0')}м`
}

const Pulse: ClientModule<Props, State> = (props, surface) => {
  const { Text } = surface.elements
  const ref = surface.state?.ref ?? { base: 0, ticks: 0, lastNow: -1, isRunning: true }
  if (props.now !== ref.lastNow) {
    // A fresh reading from the hooks module: count on from it.
    ref.lastNow = props.now
    ref.base = (props.endAt ?? props.now) - props.since
    ref.ticks = 0
  }
  ref.isRunning = props.endAt === null
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(1000, () => {
      if (ref.isRunning) {
        ref.ticks += 1
        surface.setState({ ref })
      }
    })
  }
  const mark = ref.isRunning ? FRAMES[ref.ticks % FRAMES.length] : '✓'

  return <Text color={props.color}>{`${mark} ${elapsed(ref.base + ref.ticks * 1000)}`}</Text>
}

export default Pulse
