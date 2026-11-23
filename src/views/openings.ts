import type { VNode } from 'snabbdom'
import { Rating } from 'ts-fsrs'
import type { Ctrl, OpeningStat } from '../ctrl'
import type { Opening, OpeningCard } from '../db'
import { el } from '../el'
import { BUILTIN, DEPTH } from '../openings/repertoire'
import { lineSan, type OpeningSession } from '../openings/session'
import type { SparStep } from '../openings/spar'
import { board, boardScreen, button, card, errorLine, icon, loading, pct, plural } from './ui'

const side = (o: Opening) => (o.color === 'white' ? 'White' : 'Black')
const sparArg = (o: Opening) => `${o.color}:${o.name}`

// TODO: replaced by the Openings page work
export const openingsPage = (ctrl: Ctrl): VNode => el('div', 'mx-auto max-w-2xl space-y-4', [el('h1', 'font-display text-2xl', 'Openings'), openingsCard(ctrl)])

// The Openings card at the top of Drills
export function openingsCard(ctrl: Ctrl): VNode {
  const rows = ctrl.openingStats
  return card([
    el('h2', 'font-display text-lg', 'Openings'),
    rows.length ? el('ul', 'mt-3 divide-y divide-raised', rows.map(r => openingRow(ctrl, r))) : el('p', 'mt-3 text-sm text-dim', 'No openings chosen yet.'),
    el('div', 'mt-4 flex flex-wrap gap-2', [button(ctrl.openingPicking ? 'Close the list' : 'Add or remove openings', () => ctrl.toggleOpeningPicking(), 'plain')]),
    ctrl.openingPicking ? picker(ctrl) : null,
  ])
}

function openingRow(ctrl: Ctrl, r: OpeningStat): VNode {
  const coverage = r.coverage !== undefined ? `${pct(r.coverage)} learned` : r.error ? 'not counted' : 'counting…'
  const arg = sparArg(r.opening)
  return el('li', 'py-3', [
    el('p', 'truncate font-medium', r.opening.name),
    el('p', 'text-xs text-dim', [
      `${side(r.opening)}, `,
      el('span', { attrs: { title: `Share of your moves against Maia's likely replies at about ${ctrl.openingLevel} you have learned, through move ${DEPTH}` } }, coverage),
    ]),
    r.error ? el('p', 'text-xs text-bad', r.error) : null,
    el('div', 'mt-2 flex flex-wrap gap-2', [
      button(r.fresh ? `Learn ${r.fresh}` : 'Learn', () => ctrl.go('learn', arg), 'primary', !r.fresh),
      button(`Review ${r.due}`, () => ctrl.go('opening', arg), 'plain', !r.due),
      button('Spar', () => ctrl.go('spar', arg), 'plain'),
    ]),
  ])
}

// The built-in openings, then the ones the player plays most in their games
function picker(ctrl: Ctrl): VNode {
  const chosen = ctrl.profile?.openings ?? []
  const same = (a: Opening, b: Opening) => a.name === b.name && a.color === b.color
  // A chosen opening stays on the list to be removed, even once it has
  // dropped out of the player's most played
  const options = [...BUILTIN, ...ctrl.gamesOpenings, ...chosen].filter((o, i, all) => all.findIndex(x => same(x, o)) === i)
  const group = (color: Opening['color']) =>
    el('div', 'mt-3', [
      el('p', 'text-xs text-dim', `As ${color === 'white' ? 'White' : 'Black'}`),
      el(
        'div',
        'mt-1 flex flex-wrap gap-2',
        options
          .filter(o => o.color === color)
          .map(o => {
            const on = chosen.some(c => same(c, o))
            return el(
              'button',
              'min-h-9 rounded-md px-3 text-sm',
              { attrs: { type: 'button', 'aria-pressed': String(on) }, class: { 'bg-accent': on, 'text-bg': on, 'bg-raised': !on }, on: { click: () => ctrl.toggleOpening(o) } },
              o.name,
            )
          }),
      ),
    ])
  return el('div', [group('white'), group('black')])
}

const TONE: Record<number, ['good' | 'warn' | 'bad', string]> = {
  [Rating.Good]: ['good', 'Good'],
  [Rating.Hard]: ['warn', 'Playable'],
  [Rating.Again]: ['bad', 'Missed'],
}

// A set of due opening cards, one move each
export function openingView(ctrl: Ctrl): VNode {
  const s = ctrl.openingSet
  if (!s) return el('p', 'p-4 text-dim', 'Loading…')
  const c = s.card
  return boardScreen({ title: 'Openings', back: () => ctrl.back('drills'), board: board('opening-set', e => s.mount(e)), side: [c ? cardSide(s, c) : setDone(ctrl, s)] })
}

function cardSide(s: OpeningSession, c: OpeningCard): VNode {
  const v = s.verdict
  const last = s.index === s.cards.length - 1
  const tone = v && TONE[v.rating][0]
  return el('div', 'space-y-3', [
    el('p', 'text-xs text-dim', `Card ${s.index + 1} of ${s.cards.length}, ${c.opening}`),
    el('p', 'text-sm', lineSan(c.moves)),
    s.state === 'your-move' ? el('p', 'text-sm text-dim', 'Your move') : s.state === 'judging' ? el('p', 'animate-pulse text-sm text-dim', 'Checking…') : null,
    v
      ? el('div', 'rounded-xl bg-surface p-4 border-l-4', { class: { 'border-accent': tone === 'good', 'border-warn': tone === 'warn', 'border-bad': tone === 'bad' } }, [
          el('p', 'font-display text-xl', { class: { 'text-accent': tone === 'good', 'text-warn': tone === 'warn', 'text-bad': tone === 'bad' } }, TONE[v.rating][1]),
          v.rating === Rating.Good ? null : el('p', 'mt-1 text-sm', [el('span', 'text-dim', 'Repertoire '), s.answerSan ?? '']),
        ])
      : null,
    v?.offer
      ? s.added
        ? el('p', 'flex items-center gap-1 text-sm text-accent', [icon('check', 16), `${s.offerSan} added to your repertoire`])
        : el('div', 'grid', [button(`Use ${s.offerSan} instead`, () => void s.add(), 'plain')])
      : null,
    s.state === 'judged' ? el('div', 'grid', [button(last ? 'Finish' : 'Next', () => s.next())]) : null,
  ])
}

function setDone(ctrl: Ctrl, s: OpeningSession): VNode {
  const n = (r: Rating) => s.grades.filter(g => g === r).length
  return el('div', 'space-y-3', [
    el('p', 'font-display text-xl', s.cards.length ? 'Set done' : 'No opening cards due'),
    s.cards.length ? el('p', 'text-sm text-dim', `${n(Rating.Good)} good, ${n(Rating.Hard)} playable, ${n(Rating.Again)} missed`) : null,
    el('div', 'grid', [button('Back to drills', () => ctrl.go('drills'))]),
  ])
}

// The next line of an opening, from move 1
export function learnView(ctrl: Ctrl): VNode {
  const r = ctrl.learn
  if (!r) return ctrl.learnError ? el('div', 'p-4', [errorLine(ctrl.learnError)]) : loading()
  return boardScreen({
    title: `Learn: ${r.opening.name}`,
    back: () => ctrl.back('drills'),
    board: board(`learn:${sparArg(r.opening)}:${ctrl.learnRound}`, e => r.mount(e)),
    side: [
      el('p', 'text-sm font-medium', r.name),
      r.played.length ? el('p', 'text-sm', lineSan(r.played)) : null,
      r.state === 'your-move'
        ? el('p', 'text-sm', { class: { 'text-bad': r.missed, 'text-accent': !r.missed && r.isNew, 'text-dim': !r.missed && !r.isNew } }, r.missed ? 'Missed' : r.isNew ? 'New move' : 'Your move')
        : null,
      r.state === 'done'
        ? el('div', 'space-y-3', [
            el('p', 'font-display text-xl', r.line.length ? `${plural(r.taught, 'new move')} learned` : 'Nothing new to learn'),
            el('div', 'flex flex-wrap gap-2', [r.more ? button('Next line', () => void ctrl.learnAgain()) : null, button('Back to drills', () => ctrl.go('drills'), r.more ? 'plain' : 'primary')]),
          ])
        : null,
    ],
  })
}

// "5." for White's move, "5..." for Black's, from the position it was played in
const moveNo = (fen: string) => `${fen.split(' ')[5]}${fen.split(' ')[1] === 'w' ? '.' : '...'}`

function stepLine(s: SparStep): VNode {
  const what = s.known ? 'your repertoire move' : s.answer ? `your repertoire plays ${s.answer}` : 'no repertoire move here'
  return el('li', 'flex items-start gap-2 py-2 text-sm', [
    el('span', 'shrink-0 font-medium tabular-nums', { class: { 'text-accent': s.known, 'text-bad': !s.known } }, `${moveNo(s.fen)} ${s.san}`),
    el('span', 'text-dim', what),
  ])
}

// One sparring game from move 1, over after the player's DEPTH-th move
export function sparView(ctrl: Ctrl): VNode {
  const r = ctrl.spar
  if (!r) return el('p', 'p-4 text-dim', 'Loading…')
  const miss = r.steps.find(s => !s.known)
  return boardScreen({
    title: `Spar: ${r.opening.name}`,
    back: () => ctrl.back('drills'),
    board: board(`spar:${sparArg(r.opening)}:${ctrl.sparRound}`, e => r.mount(e)),
    side: [
      el('p', 'text-xs text-dim', `${side(r.opening)} against Maia at about ${ctrl.openingLevel}, through move ${DEPTH}`),
      r.line.length ? el('p', 'text-sm', lineSan(r.line)) : null,
      r.state === 'done'
        ? el('div', 'space-y-3', [
            r.error ? el('p', 'text-sm text-bad', r.error) : null,
            el('ul', 'divide-y divide-raised', r.steps.map(stepLine)),
            miss ? null : el('p', 'text-sm text-dim', 'Every move was from your repertoire.'),
            r.evalText ? el('p', 'text-sm', [el('span', 'text-dim', 'Stockfish at the end: '), el('span', 'font-medium tabular-nums', r.evalText)]) : null,
            el('div', 'flex flex-wrap gap-2', [button('Spar again', () => ctrl.sparAgain()), button('Back to drills', () => ctrl.go('drills'), 'plain')]),
          ])
        : el('p', 'text-sm text-dim', r.state === 'thinking' ? 'Maia is thinking…' : 'Your move.'),
    ],
  })
}
