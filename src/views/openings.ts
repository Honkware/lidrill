import type { VNode } from 'snabbdom'
import { Rating } from 'ts-fsrs'
import type { Ctrl, OpeningStat } from '../ctrl'
import type { Opening, OpeningCard } from '../db'
import { el } from '../el'
import { NEW_PER_DAY, SET_SIZE } from '../openings/cards'
import { BUILTIN, DEPTH, openingArg } from '../openings/repertoire'
import { lineSan, type OpeningSession } from '../openings/session'
import type { SparStep } from '../openings/spar'
import { board, boardScreen, button, card, errorLine, icon, label, listRow, loading, pct, plural, rowList } from './ui'

const side = (o: Opening) => (o.color === 'white' ? 'White' : 'Black')

// What a Learn button starts: the opening's new positions, up to what is left of today's
const learnN = (ctrl: Ctrl, r: OpeningStat) => Math.min(r.left ?? 0, ctrl.openingsToday.fresh)

const LIMIT_TIP = `Up to ${NEW_PER_DAY} new positions a day, across openings`
const BUILD_TIP = "Maia's likely replies and Stockfish's check of each recommended move, once per opening"

const bar = (share: number, building: boolean, tip: string) =>
  el('div', 'h-2 overflow-hidden rounded bg-raised', { attrs: { title: tip, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(share * 100), 'aria-label': tip } }, [
    el('div', 'h-2 rounded transition-[width]', { class: { 'bg-accent': !building, 'bg-dim': building, 'animate-pulse': building }, style: { width: `${share * 100}%` } }),
  ])

// #/openings: the next step, one row per chosen opening, and the chooser
export function openingsPage(ctrl: Ctrl): VNode {
  return el('div', 'mx-auto max-w-2xl space-y-4', [el('h1', 'font-display text-2xl', 'Openings'), ...body(ctrl)])
}

// The same on Drills, until the page replaces it there
export function openingsCard(ctrl: Ctrl): VNode {
  return card([el('h2', 'font-display text-lg', 'Openings'), ...body(ctrl)], 'space-y-4')
}

function body(ctrl: Ctrl): (VNode | null)[] {
  const rows = ctrl.openingStats
  const picking = ctrl.openingPicking || !ctrl.profile?.openings?.length
  return [
    nextStep(ctrl),
    rows.length ? el('section', 'rounded-xl bg-surface', [rowList(rows.map(r => openingRow(ctrl, r)))]) : null,
    picking ? card(picker(ctrl), 'space-y-4') : null,
    el('div', 'grid sm:flex', [
      picking ? (rows.length ? button('Close', () => ctrl.toggleOpeningPicking(), 'quiet') : null) : button('Add opening', () => ctrl.toggleOpeningPicking(), 'plain'),
    ]),
  ]
}

// Reviews due come first, then today's new positions, then sparring
function nextStep(ctrl: Ctrl): VNode {
  const { due, fresh } = ctrl.openingsToday
  const rows = ctrl.openingStats
  const learn = rows.find(r => learnN(ctrl, r))
  const [text, go]: [string, () => void] = due
    ? [`Review ${Math.min(due, SET_SIZE)}`, () => ctrl.go('opening')]
    : learn
      ? [`Learn ${learnN(ctrl, learn)} · ${learn.opening.name}`, () => ctrl.go('learn', openingArg(learn.opening))]
      : rows[0]
        ? [`Spar · ${rows[0].opening.name}`, () => ctrl.go('spar', openingArg(rows[0].opening))]
        : ['Add opening', () => ctrl.toggleOpeningPicking()]
  return el('div', 'space-y-2', [
    el('div', 'grid', [button(text, go)]),
    el('p', 'text-xs tabular-nums text-dim', { attrs: { title: LIMIT_TIP } }, `Due ${due} · New today ${fresh}`),
  ])
}

function openingRow(ctrl: Ctrl, r: OpeningStat): VNode {
  const arg = openingArg(r.opening)
  const n = learnN(ctrl, r)
  const building = r.coverage === undefined && !r.error
  const tip = building ? BUILD_TIP : `Share of your moves against Maia's likely replies at about ${ctrl.openingLevel} you have learned, through move ${DEPTH}`
  const share = building ? (r.walked ?? 0) : (r.coverage ?? 0)
  return el('li', 'px-4 py-3 sm:flex sm:items-center sm:gap-4 sm:px-5 sm:py-4', [
    el('div', 'min-w-0 flex-1 space-y-2', [
      el('div', 'flex items-baseline gap-2', [
        el('p', 'min-w-0 flex-1 truncate font-medium', r.opening.name),
        el('span', 'text-xs text-dim', side(r.opening)),
        el('span', 'w-10 text-right text-sm tabular-nums', { attrs: { title: tip }, class: { 'text-dim': building } }, r.error ? '–' : pct(share)),
      ]),
      bar(share, building, tip),
      r.error ? errorLine(r.error, 'text-xs') : null,
    ]),
    el('div', 'mt-3 flex flex-wrap gap-2 sm:mt-0 sm:flex-nowrap', [
      el('span', 'grid', { attrs: { title: r.left && !n ? LIMIT_TIP : '' } }, [button(r.left === undefined ? 'Learn' : `Learn ${n}`, () => ctrl.go('learn', arg), 'plain', !n)]),
      button(`Review ${r.due}`, () => ctrl.go('opening', arg), 'plain', !r.due),
      button('Spar', () => ctrl.go('spar', arg), 'quiet'),
    ]),
  ])
}

// The built-in openings and the ones the player plays most in their games,
// then a Lichess study as the source of the repertoire's moves
function picker(ctrl: Ctrl): VNode[] {
  const chosen = ctrl.profile?.openings ?? []
  const same = (a: Opening, b: Opening) => a.name === b.name && a.color === b.color
  // A chosen opening stays on the list to be removed, even once it has
  // dropped out of the player's most played
  const options = [...BUILTIN, ...ctrl.gamesOpenings, ...chosen].filter((o, i, all) => all.findIndex(x => same(x, o)) === i)
  const group = (color: Opening['color']) =>
    el('div', 'space-y-2', [
      label(`As ${color === 'white' ? 'White' : 'Black'}`),
      el(
        'div',
        'flex flex-wrap gap-2',
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
  return ctrl.auth ? [group('white'), group('black'), studyPicker(ctrl)] : [group('white'), group('black')]
}

// A Lichess study's moves come before every other source (study:read,
// asked for on first use)
function studyPicker(ctrl: Ctrl): VNode {
  const current = ctrl.profile?.repertoireStudy
  return el('div', 'space-y-2 border-t border-raised pt-4', [
    label('Lichess study'),
    current ? el('p', 'flex gap-2 text-sm', [el('span', 'min-w-0 flex-1 truncate', current.name), el('span', 'tabular-nums text-dim', `${current.lines.length} lines`)]) : null,
    ctrl.studies
      ? rowList(
          ctrl.studies.map(st => listRow(() => ctrl.useStudy(st), [el('span', 'text-sm', st.name)])),
          'scroll -mx-4 max-h-60 overflow-y-auto sm:-mx-5',
        )
      : el('div', 'flex flex-wrap gap-2', [
          button(current ? 'Pick another study' : 'Pick a study', () => ctrl.loadStudies(), 'plain'),
          current ? button('Stop using it', () => ctrl.useStudy(undefined), 'quiet') : null,
        ]),
  ])
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
  return boardScreen({ title: 'Openings', back: () => ctrl.back('drills'), board: board(`opening-set:${ctrl.openingRound}`, e => s.mount(e)), side: [c ? cardSide(s, c) : setDone(ctrl, s)] })
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
    board: board(`learn:${openingArg(r.opening)}:${ctrl.learnRound}`, e => r.mount(e)),
    side: [
      el('p', 'text-sm font-medium', r.name),
      r.played.length ? el('p', 'text-sm', lineSan(r.played)) : null,
      r.playing
        ? el('p', 'text-sm', { class: { 'text-bad': r.missed, 'text-accent': !r.missed && r.state !== 'your-move', 'text-dim': !r.missed && r.state === 'your-move' } }, r.missed ? 'Missed' : r.state === 'show' ? 'New move' : 'Your move')
        : null,
      r.state === 'line-done' ? el('div', 'grid', [button('Next line', () => r.nextLine())]) : null,
      r.state === 'done'
        ? el('div', 'space-y-3', [
            el('p', 'font-display text-xl', r.lines.length ? `${plural(r.taught, 'new move')} learned` : 'Nothing new to learn'),
            el('div', 'flex flex-wrap gap-2', [button('Back to drills', () => ctrl.go('drills'))]),
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
    board: board(`spar:${openingArg(r.opening)}:${ctrl.sparRound}`, e => r.mount(e)),
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
