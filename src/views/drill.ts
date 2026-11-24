import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { coachLine } from '../coach'
import { runProgress, type Drill, type Outcome } from '../drill'
import { el } from '../el'
import type { BoardLink, Segment } from '../server/render'
import { board, boardScreen, btnClass, button, errorLine, icon, jumps, loading, moveInput, runBar, type Mark } from './ui'
import { drillGameLine } from '../server/surface'
import { summary } from './summary'
import { countdownBar } from './time'
import { ownGamesCard } from './welcome'

export function drillView(ctrl: Ctrl): VNode {
  if (ctrl.sample) return sampleView(ctrl)
  const timed = ctrl.timed
  const top = {
    title: timed ? 'Move under a clock' : "Today's puzzles",
    back: () => (timed ? ctrl.go(timed.from) : ctrl.go('train', 'day')),
    note: timed ? undefined : coachLine({ due: ctrl.due?.puzzles ?? 0, week: ctrl.today?.weeks.at(-1), time: ctrl.timeProfiles[0] }),
  }
  return run(ctrl, top, [])
}

// The first visit's three puzzles: the same screen with nowhere to go back
// to, and the sign-in a tap away. It opens by itself after the first solve
// and at the end.
function sampleView(ctrl: Ctrl): VNode {
  const open = ctrl.ownGames || ctrl.sessionDone
  const action = el('button', btnClass('quiet', 'sm'), { attrs: { type: 'button', 'aria-expanded': String(open) }, on: { click: () => ctrl.toggleOwnGames() } }, 'Sign in')
  return run(ctrl, { title: 'Sample puzzles', action }, [open ? ownGamesCard(ctrl) : null])
}

function run(ctrl: Ctrl, top: { title: string; back?: () => void; action?: VNode; note?: string }, first: (VNode | null)[]): VNode {
  const last = ctrl.drills.at(-1)
  // The summary keeps the last puzzle's board, under its own key since that
  // puzzle's board was destroyed when it ended
  if (ctrl.sessionDone && last && ctrl.review.viewing === undefined)
    return boardScreen({ ...top, hero: true, board: board(`done:${last.key}`, e => last.mount(e)), side: [...first, sessionSummary(ctrl)] })
  const d = ctrl.displayDrill
  if (!d) return loading()
  return boardScreen({ ...top, hero: true, board: boardWithWheel(d), controls: puzzleJumps(d), side: [...first, sessionRow(ctrl), countdownBar(ctrl), side(ctrl, d)] })
}

const markOf = (o?: Outcome): Mark => (o === 'clean' ? 'good' : o === 'hinted' ? 'warn' : o ? 'bad' : undefined)

function sessionSummary(ctrl: Ctrl): VNode {
  const out = ctrl.session
  const count = (o: Outcome) => out.filter(x => x === o).length
  const solved = count('clean') + count('hinted')
  return summary(ctrl, {
    score: `${solved} / ${out.length}`,
    marks: out.map(markOf),
    counts: ctrl.timed
      ? [['Solved', solved], ['Out of time', ctrl.timed.outs]]
      : [['Clean', count('clean')], ['Hint', count('hinted')], ['Missed', out.length - solved]],
    missed: ctrl.drills.flatMap((d, i) =>
      d.outcome === 'missed' || d.outcome === 'shown' ? [{ text: puzzleName(d), move: d.sanAt(d.puzzle.solution[0]), open: () => ctrl.viewPuzzle(i) }] : [],
    ),
  })
}

function puzzleName(d: Drill): string {
  const p = d.puzzle
  if (p.source === 'lichess') return p.rating ? `Lichess ${p.rating}` : 'Lichess'
  return `${d.game?.opponent ? `vs ${d.game.opponent}, ` : ''}move ${Math.ceil(p.ply / 2)}`
}

// "Puzzle 3 of 7" over a bar with one segment per puzzle in the run: green
// solved, amber with the hint, red missed, outlined for the one on screen -
// the live puzzle or the completed one being reviewed (chevrons step back
// through them read-only)
function sessionRow(ctrl: Ctrl): VNode {
  const done = ctrl.session
  const { at, total } = runProgress(done.length, ctrl.queueLeft, ctrl.answered || ctrl.sessionDone, ctrl.review.viewing)
  const step = (name: string, aria: string, onClick: () => void, enabled: boolean) =>
    el(
      'button',
      btnClass('quiet', 'icon'),
      { attrs: { type: 'button', 'aria-label': aria, disabled: !enabled }, on: { click: onClick } },
      [icon(name, 16)],
    )
  return el('div', 'flex items-center gap-1', [
    step('prev', 'Previous puzzle', () => ctrl.sessionBack(), ctrl.review.canBack),
    el('div', 'min-w-0 flex-1 space-y-1.5', [
      el('p', 'text-sm tabular-nums', `Puzzle ${at} of ${total}`),
      runBar(
        Array.from({ length: total }, (_, i) => markOf(done[i])),
        at - 1,
        `${done.length} of ${total} done`,
      ),
    ]),
    step('next', 'Next puzzle', () => ctrl.sessionForward(), ctrl.review.canForward),
  ])
}

// Mouse wheel over the board steps through the moves once the puzzle is over
function boardWithWheel(d: Drill): VNode {
  const b = board(d.key, e => d.mount(e))
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
        ? feedbackBox('good', '✓ Best move')
        : feedbackBox(
            'plain',
            hold ? `Find a move that holds for ${d.color}` : `Find the best move for ${d.color}`,
            hold && d.step === 0 ? `Your move in the game lost material. ${d.puzzle.alternatives!.length} moves would have kept the position.` : null,
          )
  // The slot stays reserved before the hint is earned (invisible keeps the
  // box, so the reveal shifts nothing)
  const available = d.hintReady
  return el('div', 'space-y-3', [
    box,
    // The hint keeps a fixed slot once the puzzle is running, so revealing
    // it never shifts the layout (the packet is precomputed at sync,
    // so the hint is ready the moment a try fails - gating is only whose
    // turn it is)
    // One row, so space-y on the column can't push the second button down
    el('div', 'flex flex-wrap gap-2', [
      el(
        'button',
        btnClass('plain'),
        {
          attrs: { type: 'button', title: 'Hint (H)', disabled: !d.yourTurn, 'aria-hidden': available ? 'false' : 'true' },
          class: { 'text-warn': d.showHint, invisible: !available },
          on: { click: () => d.hint() },
        },
        [icon('hint', 18), d.showHint ? 'Hide hint' : 'Hint'],
      ),
      d.canViewSolution ? button('View the solution', () => d.viewSolution(), 'plain') : null,
    ]),
    // Typing moves is for keyboards; on a phone it's clutter
    el('div', 'hidden md:block', [moveInput(t => d.typeMove(t))]),
    drillContext(d),
  ])
}

const TITLES = {
  clean: ['good', 'Solved'],
  hinted: ['good', 'Solved with the hint'],
  // missed and shown end the same way: the answer line carries the difference
  missed: ['bad', 'Not solved'],
  shown: ['bad', 'Not solved'],
} as const

// The line from the puzzle position on: ✓ for moves the player found,
// greyed for the shown solution, plain for free play afterwards
function moveLine(d: Drill): VNode {
  const items: VNode[] = []
  d.nodes.forEach((n, i) => {
    if (!n.san || i < d.start) return
    items.push(
      // A move in the line, sized like the cells of the move list
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
  if (d.evalText) items.push(el('span', 'ml-auto px-2 text-xs tabular-nums text-dim', { attrs: { title: 'Stockfish, on this device' } }, d.evalText))
  return el('div', 'flex flex-wrap items-center gap-1', items)
}

// Under the board once the puzzle is over, to step through its line
export const puzzleJumps = (d: Drill) => (d.state === 'playing' ? null : jumps(d.cursor, d.start, d.nodes.length - 1, i => d.go(i)))

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
  if (!w || !d.showWhy) return null
  if (w.loading) {
    const [done, total] = w.progress ?? [0, 0]
    return el('p', 'mt-3 animate-pulse text-sm text-dim', total ? `Checking with Stockfish, ${done} of ${total}…` : 'Explaining…')
  }
  if (w.error) return errorLine(w.error, 'mt-3')
  const slot = (name: string) => w.slots?.find(s => s.slot === name)?.segments ?? []
  const nextTime = slot('nextTime')
  // A sample's own text is the one slot
  const para = (name: string, classes = '') => (slot(name).length ? el('p', classes, linked(d, slot(name))) : null)
  return el('div', 'mt-3 space-y-2 border-t border-raised pt-3 text-sm', [
    para('whatHappened'),
    para('why'),
    para('pattern', 'text-dim'),
    ...(nextTime.length ? [el('p', 'text-dim', [el('span', 'font-medium', 'Next time: '), ...linked(d, nextTime)])] : []),
  ])
}

// Puts the explanation inside the result card
function whyCard(box: VNode, why: VNode | null): VNode {
  if (why) box.children = [...(box.children ?? []), why]
  return box
}

// Over: one card with the result, the answer, the game move and "Why?";
// one card with the line and Stockfish's view
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
  // The cost words come from the shared validated surface, never
  // composed here; an unmeasurable swing omits the clause
  const game = p.played && !affirmed ? (drillGameLine({ san: d.sanAt(p.played) }, p.swingCp) ?? '') : ''
  const why = el('button', btnClass('plain', 'sm'), { attrs: { type: 'button', title: 'Why? (W)', 'aria-expanded': String(d.showWhy) }, on: { click: () => d.toggleWhy() } }, 'Why?')
  return el('div', 'space-y-3', [
    whyCard(feedbackBox(tone, title, `${answer}${game}`.trim() || null, why), whyPart(d)),
    el('div', 'rounded-xl bg-surface p-2', [moveLine(d)]),
    ...after,
    drillContext(d),
  ])
}

// Spar plays on from the puzzle's position against Maia, once the puzzle
// is over and for a puzzle from a stored game. Retry is the puzzle again for
// practice; Bury takes it out of the deck for good, in one click.
function tools(ctrl: Ctrl, d: Drill): VNode | null {
  const tool = (name: string, title: string, onClick: () => void) => el('button', btnClass('quiet', 'sm'), { attrs: { type: 'button', title }, on: { click: onClick } }, name)
  const items = [
    d.state === 'view' && d.game ? tool('Spar vs Maia', 'Play on from this position against Maia', () => ctrl.sparFrom(d)) : null,
    ctrl.canRetry ? tool('Retry', 'Try this puzzle again (R)', () => ctrl.retry()) : null,
    ctrl.canBury ? tool('Bury', 'Take this puzzle out of the deck (B)', () => void ctrl.bury()) : null,
  ].filter(t => t !== null)
  return items.length ? el('div', 'flex flex-wrap gap-2', items) : null
}

function side(ctrl: Ctrl, d: Drill): VNode {
  if (d.state === 'playing') return el('div', 'space-y-3', [puzzleSide(d, []), tools(ctrl, d)])
  const reviewing = ctrl.review.viewing !== undefined
  return puzzleSide(d, [
    el('div', 'primary-action grid bg-bg py-2', [
      el('button', btnClass(), { attrs: { type: 'button', title: 'Space or Enter' }, on: { click: reviewing ? () => ctrl.sessionForward() : () => void ctrl.next() } }, reviewing ? 'Next' : ctrl.queueLeft ? 'Continue' : 'Done'),
    ]),
    el('div', 'flex flex-wrap items-center justify-between gap-2', [
      reviewing
        ? el('p', 'text-sm text-dim', ctrl.sample ? 'Earlier puzzle.' : 'Earlier puzzle, already graded.')
        : el('label', 'flex items-center gap-2 text-sm text-dim', [
            el('input', 'size-4 accent-accent', { attrs: { type: 'checkbox' }, props: { checked: ctrl.autoNext }, on: { change: e => ctrl.setAutoNext((e.target as HTMLInputElement).checked) } }),
            'Auto-continue after a solve',
          ]),
      d.failed && d.puzzle.source !== 'lichess' && !reviewing && !ctrl.timed && !ctrl.sample ? noteToggle(ctrl) : null,
    ]),
    tools(ctrl, d),
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
