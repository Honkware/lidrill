import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Drill } from '../drill'
import { el } from '../el'
import type { BoardLink, Segment } from '../server/render'
import { board, button, icon, moveInput, pawnsWorth, topBar } from './ui'

export function drillView(ctrl: Ctrl): VNode {
  const d = ctrl.drill
  if (!d) return el('p', 'p-4 text-dim', 'Loading…')
  const top = topBar("Today's puzzles", () => ctrl.go('today'))
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [top]), boardWithWheel(d)]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [el('div', 'hidden md:block', [top]), sessionRow(ctrl), side(ctrl, d)]),
  ])
}

// One square per puzzle in today's run: green solved, amber with the hint,
// red missed, outlined for the current one (as Lichess's session row)
function sessionRow(ctrl: Ctrl): VNode {
  const done = ctrl.session
  const total = done.length + 1 + ctrl.queueLeft
  return el(
    'div',
    'flex flex-wrap gap-1',
    { attrs: { 'aria-label': `${done.length} of ${total} done` } },
    Array.from({ length: total }, (_, i) => {
      const r = done[i]
      return el('span', 'size-3 rounded-sm', {
        class: {
          'bg-accent': r === 'clean',
          'bg-warn': r === 'hinted',
          'bg-bad': r === 'missed' || r === 'shown',
          'bg-raised': !r,
          'ring-2': i === done.length,
          'ring-fg': i === done.length,
        },
      })
    }),
  )
}

// Mouse wheel over the board steps through the moves once the puzzle is over
function boardWithWheel(d: Drill): VNode {
  const b = board(d.puzzle.id, e => d.mount(e))
  b.data = {
    ...b.data,
    on: {
      wheel: (e: WheelEvent) => {
        if (d.state !== 'view' || e.ctrlKey) return
        e.preventDefault()
        d.go(d.cursor + (e.deltaY > 0 ? 1 : -1))
      },
    },
  }
  return b
}

export function drillContext(d: Drill): VNode | null {
  const p = d.puzzle
  if (p.source === 'lichess')
    return el('p', 'text-sm text-dim', [
      // Lichess hides the rating while you solve; it shows in review
      `Lichess puzzle${p.rating && d.state !== 'playing' ? `, rated ${p.rating}` : ''}. `,
      el('a', 'underline', { attrs: { href: `https://lichess.org/training/${p.id.replace('lichess:', '')}`, target: '_blank', rel: 'noopener' } }, 'Open on Lichess'),
    ])
  const g = d.game
  if (!g) return null
  return el('p', 'text-sm text-dim', [
    `${g.opponent ? `vs ${g.opponent}, ` : ''}${g.opening || 'your game'}, move ${Math.ceil(p.ply / 2)}. `,
    el('a', 'underline', { attrs: { href: `#/game/${encodeURIComponent(g.id)}` } }, 'See the game'),
  ])
}

const feedbackBox = (tone: 'good' | 'bad' | 'plain', title: string, text?: string | VNode | null, extra?: VNode | null) =>
  el('div', 'rounded-xl bg-surface p-4', { class: { 'border-l-4': tone !== 'plain', 'border-accent': tone === 'good', 'border-bad': tone === 'bad' } }, [
    el('div', 'flex items-start justify-between gap-3', [
      el('p', 'font-display text-xl', { class: { 'text-accent': tone === 'good', 'text-bad': tone === 'bad' } }, title),
      extra ?? null,
    ]),
    text ? el('p', 'mt-1 text-sm text-dim', [text]) : null,
  ])

function playing(d: Drill): VNode {
  const hold = !!d.puzzle.alternatives
  const box =
    d.feedback === 'fail'
      ? feedbackBox('bad', '✗ Not the move', `${d.misses.length > 1 ? `Tried ${d.misses.join(', ')}. ` : ''}Try something else.`)
      : d.feedback === 'good'
        ? feedbackBox('good', '✓ Best move', 'Keep going…')
        : feedbackBox(
            'plain',
            hold ? `Find a move that holds for ${d.color}` : `Find the best move for ${d.color}`,
            hold && d.step === 0 ? `Your move in the game lost material. ${d.puzzle.alternatives!.length} moves would have kept the position.` : null,
          )
  // Earned after a failed try or once shown; the slot stays reserved either
  // way (invisible keeps the box, so the reveal shifts nothing)
  const available = d.feedback === 'fail' || d.showHint
  return el('div', 'space-y-3', [
    box,
    // The hint keeps a fixed slot once the puzzle is running, so revealing
    // it never shifts the layout (the packet is precomputed at sync,
    // so the hint is ready the moment a try fails - gating is only whose
    // turn it is)
    el(
      'button',
      'inline-flex min-h-11 items-center gap-2 rounded-lg bg-raised px-4 text-sm font-medium',
      {
        attrs: { type: 'button', disabled: !d.yourTurn, 'aria-hidden': available ? 'false' : 'true' },
        class: { 'text-warn': d.showHint, 'opacity-50': !d.yourTurn, invisible: !available },
        on: { click: () => d.hint() },
      },
      [icon('hint', 18), d.showHint ? 'Hide hint' : 'Hint'],
    ),
    d.canViewSolution ? button('View the solution', () => d.viewSolution(), 'plain') : null,
    // Typing moves is for keyboards; on a phone it's clutter
    el('div', 'hidden md:block', [moveInput(t => d.typeMove(t))]),
    drillContext(d),
  ])
}

const TITLES = {
  clean: ['good', 'Solved'],
  hinted: ['good', 'Solved with the hint'],
  // missed and shown end the same way: the answer line carries the difference
  missed: ['bad', 'Puzzle complete'],
  shown: ['bad', 'Puzzle complete'],
} as const

// The line from the puzzle position on: ✓ for moves the player found,
// greyed for the shown solution, plain for free play afterwards
function moveLine(d: Drill): VNode {
  const items: VNode[] = []
  d.nodes.forEach((n, i) => {
    if (!n.san || i < d.start) return
    items.push(
      el(
        'button',
        'rounded px-2 py-1 text-sm',
        {
          attrs: { type: 'button' },
          class: { 'bg-raised': d.cursor === i, 'text-accent': !!n.mark, 'text-dim': !!n.solution || i === d.start },
          on: { click: () => d.go(i) },
        },
        `${n.san}${n.mark ? ' ✓' : ''}`,
      ),
    )
  })
  if (d.misses.length) items.push(el('span', 'px-2 text-sm text-bad', `✗ ${d.misses.join(', ')}`))
  return el('div', 'flex flex-wrap items-center gap-1', items)
}

const navButton = (name: string, labelText: string, onClick: () => void) =>
  el('button', 'grid size-11 place-items-center rounded-lg text-dim active:bg-raised', { attrs: { type: 'button', 'aria-label': labelText }, on: { click: onClick } }, [icon(name)])

// Every move mention in the explanation is a link - ref or certified text -
// and each one behaves the same: hover with a mouse, tap on a touch screen
// (tap again to put the board back), or Enter/Space from the keyboard. A tap
// also fires mouse-compatibility events, so only real mouse pointers count
// as hovering.
let lastPointer = 'mouse'

function linked(d: Drill, segments: Segment[]): (VNode | string)[] {
  const toggle = (target: BoardLink) => d.preview(d.previewing === target ? undefined : target)
  return segments.map(({ text: t, link: target, frame }) =>
    target
      ? el(
          'span',
          // Game-line facts read differently from puzzle-position facts:
          // dashed underline marks "this happened in the original game"
          frame === 'game'
            ? 'cursor-pointer rounded font-medium text-accent underline decoration-dashed underline-offset-2'
            : 'cursor-pointer rounded font-medium text-accent underline decoration-dotted underline-offset-2',
          {
            class: { 'bg-raised': d.previewing === target },
            attrs: { tabindex: 0, role: 'button', 'aria-label': frame === 'game' ? `Show ${t} from the game on the board` : `Show ${t} on the board` },
            on: {
              pointerdown: (e: PointerEvent) => (lastPointer = e.pointerType),
              pointerenter: (e: PointerEvent) => e.pointerType === 'mouse' && d.preview(target),
              pointerleave: (e: PointerEvent) => e.pointerType === 'mouse' && d.previewing === target && d.preview(),
              click: (e: Event) => {
                e.preventDefault()
                if (lastPointer !== 'mouse') toggle(target)
              },
              keydown: (e: KeyboardEvent) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                toggle(target)
              },
              blur: () => d.previewing === target && d.preview(),
            },
          },
          t,
        )
      : t,
  )
}

// The slots: what happened and why read as one paragraph each; the
// pattern and the habit to keep sit below, quieter. Some packets carry no
// habit: then there is no nextTime row at all
function whyPart(d: Drill): VNode | null {
  const w = d.why
  if (!w) return null
  if (w.loading) {
    const [done, total] = w.progress ?? [0, 0]
    return el('p', 'mt-3 animate-pulse text-sm text-dim', total ? `Checking with Stockfish… ${done} of ${total}` : 'Working it out…')
  }
  if (w.error) return el('p', 'mt-3 text-sm text-bad', w.error)
  const slot = (name: string) => w.slots?.find(s => s.slot === name)?.segments ?? []
  const nextTime = slot('nextTime')
  return el('div', 'mt-3 space-y-2 border-t border-raised pt-3 text-sm', [
    el('p', '', linked(d, slot('whatHappened'))),
    el('p', '', linked(d, slot('why'))),
    el('p', 'text-dim', linked(d, slot('pattern'))),
    ...(nextTime.length ? [el('p', 'text-dim', [el('span', 'font-medium', 'Next time: '), ...linked(d, nextTime)])] : []),
  ])
}

// Puts the explanation inside the result card
function whyCard(box: VNode, why: VNode | null): VNode {
  if (why) box.children = [...(box.children ?? []), why]
  return box
}

// Over: one card with the result, the answer, the game move and "Why?";
// one card with the line to step through and Stockfish's view
export function puzzleSide(d: Drill, after: (VNode | null)[]): VNode {
  if (d.state === 'playing') return playing(d)
  const p = d.puzzle
  const [tone, title] = TITLES[d.outcome ?? 'clean']
  const answer = p.alternatives ? `${d.holdingSans.join(' or ')} held.` : d.outcome === 'clean' ? '' : `The move was ${d.sanAt(p.solution[0])}.`
  // The game move's cost is contrast-frame language - it belongs on
  // a miss, never on an affirm frame (best/also-good). The solve frame the
  // Why? card uses is the server's membership of the solving move; the card
  // mirrors it (the found move against the puzzle's own solutions)
  const affirmed = !!d.solvedMove && (p.solution[0] === d.solvedMove || !!p.alternatives?.includes(d.solvedMove))
  const game = p.played && !affirmed ? ` In the game: ${d.sanAt(p.played)}, giving away about ${pawnsWorth(p.swingCp)}.` : ''
  const why = d.why ? null : el('button', 'shrink-0 rounded-full bg-raised px-3 py-1 text-sm font-medium', { attrs: { type: 'button' }, on: { click: () => d.explain() } }, 'Why?')
  return el('div', 'space-y-3', [
    whyCard(feedbackBox(tone, title, `${answer}${game}`.trim() || null, why), whyPart(d)),
    el('div', 'rounded-xl bg-surface p-2', [
      moveLine(d),
      el('div', 'mt-1 flex items-center', [
        navButton('first', 'Puzzle start', () => d.go(d.start)),
        navButton('prev', 'Previous move', () => d.go(d.cursor - 1)),
        navButton('next', 'Next move', () => d.go(d.cursor + 1)),
        navButton('last', 'Last move', () => d.go(d.nodes.length - 1)),
        d.evalText ? el('span', 'ml-auto pr-2 text-xs tabular-nums text-dim', { attrs: { title: 'Stockfish, on this device' } }, d.evalText) : null,
      ]),
    ]),
    ...after,
    drillContext(d),
  ])
}

function side(ctrl: Ctrl, d: Drill): VNode {
  if (d.state === 'playing') return puzzleSide(d, [])
  return puzzleSide(d, [
    el('div', 'grid', [button(ctrl.queueLeft ? 'Continue' : 'Done', () => ctrl.next())]),
    el('div', 'flex flex-wrap items-center justify-between gap-2', [
      el('label', 'flex items-center gap-2 text-sm text-dim', [
        el('input', 'size-4 accent-accent', { attrs: { type: 'checkbox' }, props: { checked: ctrl.autoNext }, on: { change: e => ctrl.setAutoNext((e.target as HTMLInputElement).checked) } }),
        'Auto-continue after a solve',
      ]),
      d.failed && d.puzzle.source !== 'lichess' ? noteToggle(ctrl) : null,
    ]),
  ])
}

// "Why did you miss it?" folded away until wanted
function noteToggle(ctrl: Ctrl): VNode {
  return el('details', 'w-full text-sm', [
    el('summary', 'cursor-pointer py-1 text-dim', 'Note why you missed it'),
    el('textarea', 'mt-2 block w-full rounded-lg bg-raised px-3 py-2', {
      attrs: { rows: 2, placeholder: "e.g. didn't check his checks" },
      on: { change: e => ctrl.saveWhy((e.target as HTMLTextAreaElement).value) },
    }),
  ])
}
