import type { VNode, VNodeChildren } from 'snabbdom'
import { Rating } from 'ts-fsrs'
import type { Ctrl, OpeningStat } from '../ctrl'
import type { Opening } from '../db'
import { el } from '../el'
import { NEW_PER_DAY, SET_SIZE } from '../openings/cards'
import type { LearnRun } from '../openings/learn'
import { FIRST_TRY, HELPED, type LinePlay, type NoteRow, type Resolved } from '../openings/line'
import { BUILTIN, DEPTH, openingArg, posKey } from '../openings/repertoire'
import { lineAsk, lineSan, type Mark, type OpeningSession } from '../openings/session'
import type { SparRun } from '../openings/spar'
import { board, btnClass, button, card, dots, errorLine, icon, label, listRow, loading, pct, rowList } from './ui'

const side = (o: Opening) => (o.color === 'white' ? 'White' : 'Black')

// What a Learn button starts: the opening's new positions, up to what is left
// of today's suggested amount, or another set of that size once it is used up
const learnN = (ctrl: Ctrl, r: OpeningStat) => Math.min(r.left ?? 0, ctrl.openingsToday.fresh || NEW_PER_DAY)

const LIMIT_TIP = `${NEW_PER_DAY} new positions a day is the suggested amount, across openings`
const BUILD_TIP = "Maia's likely replies and Stockfish's check of each recommended move, once per opening"

const bar = (share: number, building: boolean, tip: string, size = 'h-2 rounded') =>
  el('div', `${size} overflow-hidden bg-raised`, { attrs: { title: tip, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(share * 100), 'aria-label': tip } }, [
    el('div', 'h-full rounded transition-[width]', { class: { 'bg-accent': !building, 'bg-dim': building, 'animate-pulse': building }, style: { width: `${share * 100}%` } }),
  ])

// #/openings: the next step, one row per chosen opening, and the chooser
export function openingsPage(ctrl: Ctrl): VNode {
  return el('div', 'mx-auto max-w-2xl space-y-4', [el('h1', 'font-display text-2xl', 'Openings'), ...body(ctrl)])
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
      // Still counting: Learn walks the tree itself and shows its progress
      button(r.left === undefined ? 'Learn' : `Learn ${n}`, () => ctrl.go('learn', arg), 'plain', r.left === 0),
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

// --- the trainer screens ---

const topBar = (title: string, back: () => void, count?: string) =>
  el('div', 'flex items-center gap-2 px-2 py-2 sm:px-0', [
    el('button', btnClass('quiet', 'icon'), { attrs: { 'aria-label': 'Back', type: 'button' }, on: { click: back } }, [icon('back')]),
    el('h1', 'min-w-0 flex-1 truncate font-display text-lg', title),
    count ? el('span', 'shrink-0 pr-2 text-sm tabular-nums text-dim', count) : null,
  ])

// boardScreen's layout with a count at the right of the top bar and, for a
// set, a thin bar across the top for how much of it is done. The bar sits
// above the grid so it spans the screen beside the board too, and takes
// 4px of the room the board leaves for controls these screens don't have.
// TODO: make the count an option of boardScreen once ui.ts is free to change
const trainerScreen = (o: { title: string; count?: string; progress?: number; back: () => void; board: VNode; side: VNodeChildren }) =>
  el('div', [
    o.progress === undefined ? null : bar(o.progress, false, 'Done in this set', 'h-1'),
    el('div', 'board-screen', [
      el('div', '[grid-area:top]', [topBar(o.title, o.back, o.count)]),
      el('div', '[grid-area:board] short:sticky short:top-0 short:self-start', [o.board]),
      el('aside', '[grid-area:side] space-y-4 px-4 pb-8 pt-3 wide:px-0 wide:pt-4', o.side),
    ]),
  ])

// "Italian Game · White", with the explorer's name for the variation under it
const names = (opening: string, color: string, variation?: string, tip?: string) =>
  el('div', { attrs: { title: tip ?? '' } }, [
    el('p', 'text-sm font-medium', `${opening} · ${color}`),
    variation && variation !== opening ? el('p', 'truncate text-xs text-dim', variation) : null,
  ])

const moves = (text: string) => el('p', 'text-sm tabular-nums', text)

type Tone = 'good' | 'warn' | 'bad' | 'new'

// The result of a move: right with the move, or wrong with the move to play
const result = (tone: Tone, word: string, san?: string) =>
  el('div', 'flex items-center gap-2 rounded-xl border-l-4 bg-surface px-4 py-3', { class: { 'border-accent': tone === 'good' || tone === 'new', 'border-warn': tone === 'warn', 'border-bad': tone === 'bad' } }, [
    tone === 'good' ? el('span', 'text-accent', [icon('check', 20)]) : null,
    el('p', 'flex-1 font-display text-lg', { class: { 'text-accent': tone === 'good' || tone === 'new', 'text-warn': tone === 'warn', 'text-bad': tone === 'bad' } }, word),
    san ? el('span', 'text-lg font-medium tabular-nums', san) : null,
  ])

const prompt = (text: string) => el('p', 'text-sm text-dim', text)

const next = (text: string, go: () => void) => el('div', 'grid', [button(text, go)])

// The last asked move: how it was found, as its grade reads
function resolvedBox(r?: Resolved): VNode | null {
  if (!r) return null
  if (r.offer) return result('warn', 'Playable', r.san)
  if (r.skipped) return result('bad', 'Skipped', r.san)
  return r.grade === FIRST_TRY ? result('good', 'First try', r.san) : r.grade === HELPED ? result('warn', 'Retried', r.san) : result('bad', 'Shown', r.san)
}

// The box for an asked move, the same in Learn's practice and in Review
function askBox(p: LinePlay): VNode | null {
  if (p.state === 'judging') return el('p', 'animate-pulse text-sm text-dim', 'Checking…')
  if (p.state === 'solution') return result('bad', 'Solution', p.answerSan)
  if (p.state === 'your-move' && p.tried) return result('bad', 'Try again', p.tried)
  if (p.asking) return prompt(p.help >= 2 ? 'Play the arrow' : 'Your move')
  return resolvedBox(p.last)
}

// Hint, then Hint again for the arrow, then Show solution; Skip beside it
function ladder(p: LinePlay): VNode | null {
  if (!p.offered) return null
  return el('div', 'grid grid-cols-2 gap-2', [
    p.canHelp
      ? el('button', btnClass('plain'), { attrs: { type: 'button' }, class: { 'text-warn': p.help > 0 }, on: { click: () => p.hint() } }, [icon('hint', 18), p.help < 2 ? 'Hint' : 'Show solution'])
      : el('span'),
    el('button', btnClass('quiet'), { attrs: { type: 'button' }, on: { click: () => p.skip() } }, 'Skip'),
  ])
}

// What the moves played so far do, the newest last
const noteList = (rows: NoteRow[]) =>
  rows.length
    ? el(
        'ol',
        'space-y-1.5 border-l-2 border-raised pl-3 text-sm',
        rows.map(r => el('li', [el('span', 'font-medium tabular-nums', r.move), r.text ? ` ${r.text}` : null, r.name ? el('span', 'block text-xs text-dim', r.name) : null])),
      )
    : null

// The squares of a set and, while moves are asked, the run of first tries
const marksRow = (marks: Mark[], current: number, name: string, streak?: number) =>
  el('div', 'flex items-center gap-3', [
    el('div', 'min-w-0 flex-1', [dots(marks, current, name)]),
    streak === undefined ? null : el('span', 'shrink-0 text-xs tabular-nums text-dim', { attrs: { title: 'Moves found on the first try in a row' } }, `In a row ${streak}`),
  ])

// The last few moves before a position, for a row
const tail = (line: string[]) => {
  const parts = lineAsk(line).split(' ')
  return parts.length > 7 ? `… ${parts.slice(-7).join(' ')}` : parts.join(' ')
}

interface Miss {
  id: string
  moves: string[]
  san: string
}

// The end of a set: the count, the squares, the numbers, the positions
// missed (each opens again, ungraded), and where to go next
function summary(ctrl: Ctrl, o: { title: string; big: string; tip?: string; marks: Mark[]; stats: [string, number | string][]; missed: Miss[]; extra?: (VNode | null)[] }): VNode {
  return el('div', 'mx-auto max-w-xl space-y-5 pb-8 wide:pt-4', [
    topBar(o.title, () => ctrl.back('openings')),
    el('div', 'space-y-5 px-4 sm:px-0', [
      el('p', 'text-center font-display text-4xl tabular-nums', { attrs: { title: o.tip ?? '' } }, o.big),
      o.marks.length ? el('div', 'flex justify-center', [dots(o.marks, -1, o.big)]) : null,
      o.stats.length
        ? el(
            'dl',
            'flex flex-wrap justify-center gap-x-6 gap-y-2',
            o.stats.map(([k, v]) => el('div', 'flex items-baseline gap-2', [el('dt', 'text-sm text-dim', k), el('dd', 'font-medium tabular-nums', String(v))])),
          )
        : null,
      o.missed.length
        ? card([
            label('Missed'),
            rowList(
              o.missed.map(m =>
                listRow(() => ctrl.go('opening', `pos:${m.id}`), [
                  el('span', 'min-w-0 flex-1 truncate text-sm tabular-nums', tail(m.moves)),
                  el('span', 'font-medium tabular-nums', m.san),
                  el('span', 'text-dim', [icon('next', 18)]),
                ]),
              ),
              '-mx-4 mt-1 -mb-4 sm:-mx-5 sm:-mb-5',
            ),
          ])
        : null,
      el('div', 'grid gap-2 sm:grid-cols-2', [button('Next', () => ctrl.goNext()), button('Openings', () => ctrl.go('openings'), 'plain')]),
      ...(o.extra ?? []),
    ]),
  ])
}

// Review: a set of due cards, played as lines from move 1
export function openingView(ctrl: Ctrl): VNode {
  const s = ctrl.openingSet
  if (!s) return loading()
  if (s.state === 'done') return reviewDone(ctrl, s)
  const p = s.play
  const c = s.cards.find(x => x.id === s.line.asks[0])!
  const at = s.cards.findIndex(x => !s.grades.has(x.id))
  return trainerScreen({
    title: 'Review',
    count: `Line ${s.index + 1} of ${s.lines.length}`,
    progress: s.progress,
    back: () => ctrl.back('openings'),
    board: board(`opening-set:${ctrl.openingRound}`, e => s.mount(e)),
    side: [
      names(c.opening, s.color === 'white' ? 'White' : 'Black', p.name),
      moves(p.asking ? lineAsk(p.played) : lineSan(p.played)),
      askBox(p),
      ladder(p),
      ...(p.state === 'offer' ? offer(s) : []),
      s.state === 'line-done' ? next(s.index === s.lines.length - 1 ? 'Finish' : 'Next line', () => s.nextLine()) : null,
      noteList(p.noteRows),
      s.cards.length > 1 ? marksRow(s.marks, at, `Card ${at + 1} of ${s.cards.length}`, p.streak) : null,
    ],
  })
}

// A playable other move: the repertoire move beside it, and the choice to keep it
function offer(s: OpeningSession): VNode[] {
  const san = s.play.last!.san
  return [
    el('p', 'text-sm', [el('span', 'text-dim', 'Repertoire '), s.play.answerSan ?? '']),
    s.added ? el('p', 'flex items-center gap-1 text-sm text-accent', [icon('check', 16), `${san} added`]) : el('div', 'grid', [button(`Use ${san} instead`, () => void s.add(), 'plain')]),
    next('Continue', () => s.play.next()),
  ]
}

function reviewDone(ctrl: Ctrl, s: OpeningSession): VNode {
  const n = (r: Rating) => [...s.grades.values()].filter(g => g === r).length
  if (!s.cards.length) return summary(ctrl, { title: 'Review', big: 'Nothing due', marks: [], stats: [], missed: [] })
  return summary(ctrl, {
    title: 'Review',
    big: `${n(Rating.Good) + n(Rating.Hard)} / ${s.cards.length}`,
    marks: s.marks,
    stats: [
      ['First try', n(Rating.Good)],
      ['Hard', n(Rating.Hard)],
      ['Missed', n(Rating.Again)],
    ],
    missed: s.misses,
  })
}

// Learn: today's set of an opening's new positions, a line at a time, each
// played with arrows and then practised without
export function learnView(ctrl: Ctrl): VNode {
  const r = ctrl.learn
  if (!r) return ctrl.learnError ? el('div', 'p-4', [errorLine(ctrl.learnError)]) : walking(ctrl)
  if (r.state === 'done') return learnDone(ctrl, r)
  const p = r.play
  const practice = r.pass === 'practice'
  return trainerScreen({
    title: `${practice ? 'Practice' : 'Learn'}: ${r.opening.name}`,
    count: `Line ${r.index + 1} of ${r.lines.length}`,
    progress: r.progress,
    back: () => ctrl.back('openings'),
    board: board(`learn:${openingArg(r.opening)}:${ctrl.learnRound}`, e => r.mount(e)),
    side: [
      names(r.opening.name, side(r.opening), p.name),
      moves(p.state === 'your-move' ? lineAsk(p.played) : lineSan(p.played)),
      practice ? askBox(p) : showBox(r),
      practice ? ladder(p) : null,
      r.state === 'shown' ? next('Practice the line', () => r.practise()) : null,
      r.state === 'line-done' ? next(r.index === r.lines.length - 1 ? 'Finish' : 'Next line', () => r.nextLine()) : null,
      noteList(p.noteRows),
      marksRow(r.marks, r.taught, `${r.taught} of ${r.fresh.length} learned`, practice ? p.streak : undefined),
    ],
  })
}

// Playing the line with arrows: a wrong move only snaps back
function showBox(r: LearnRun): VNode | null {
  const p = r.play
  if (p.state !== 'your-move') return null
  if (p.tried) return result('bad', 'Try again', p.tried)
  return r.isNew ? result('new', 'New move', p.answerSan) : prompt('Your move')
}

// Until the set is ready: the tree being walked, if one is
function walking(ctrl: Ctrl): VNode {
  const row = ctrl.openingStats.find(r => r.walked !== undefined)
  const w = ctrl.learnWalked ?? row?.walked
  if (w === undefined) return loading()
  return el('div', 'mx-auto max-w-xl space-y-2 p-4', { attrs: { role: 'status' } }, [
    el('p', 'flex gap-2 text-sm text-dim', [el('span', 'flex-1', ctrl.learnWalked === undefined && row ? `Checking moves · ${row.opening.name}` : 'Checking moves'), el('span', 'tabular-nums', pct(w))]),
    bar(w, true, BUILD_TIP),
  ])
}

function learnDone(ctrl: Ctrl, r: LearnRun): VNode {
  const title = `Learn: ${r.opening.name}`
  if (!r.fresh.length) return summary(ctrl, { title, big: 'Nothing to learn', tip: LIMIT_TIP, marks: [], stats: [], missed: [] })
  return summary(ctrl, {
    title,
    big: `${r.taught} learned`,
    marks: r.marks,
    stats: [
      ['Lines', r.lines.length],
      ['Missed', r.misses.length],
    ],
    missed: r.misses,
  })
}

// Spar: one game from move 1 against Maia, through the player's DEPTH-th move
export function sparView(ctrl: Ctrl): VNode {
  const r = ctrl.spar
  if (!r) return loading()
  if (r.state === 'done') return sparDone(ctrl, r)
  const mine = r.opening.color === 'white' ? Math.ceil(r.line.length / 2) : Math.floor(r.line.length / 2)
  const last = r.steps.at(-1)
  return trainerScreen({
    title: `Spar: ${r.opening.name}`,
    count: `${Math.min(mine + (r.state === 'your-move' ? 1 : 0), DEPTH)} / ${DEPTH}`,
    back: () => ctrl.back('openings'),
    board: board(`spar:${openingArg(r.opening)}:${ctrl.sparRound}`, e => r.mount(e)),
    side: [
      names(r.opening.name, side(r.opening), undefined, `Against Maia at about ${ctrl.openingLevel}, through move ${DEPTH}`),
      moves(r.state === 'your-move' ? lineAsk(r.line) : lineSan(r.line)),
      last ? (last.known ? result('good', 'Repertoire', last.san) : last.answer ? result('bad', 'Missed', last.answer) : result('warn', 'New position', last.san)) : null,
      prompt(r.state === 'thinking' ? 'Maia to move' : 'Your move'),
      dots(sparMarks(r), r.steps.length, 'Your moves'),
    ],
  })
}

// Good for a repertoire move, bad where the repertoire had another, warn
// where it had none; grey once the game has left the repertoire
const sparMarks = (r: SparRun): Mark[] => Array.from({ length: DEPTH }, (_, i) => r.steps[i] && (r.steps[i].known ? 'good' : r.steps[i].answer ? 'bad' : 'warn'))

function sparDone(ctrl: Ctrl, r: SparRun): VNode {
  const known = r.steps.filter(s => s.known).length
  const miss = r.steps.find(s => !s.known && s.answer)
  return summary(ctrl, {
    title: `Spar: ${r.opening.name}`,
    big: `${known} / ${r.steps.length}`,
    tip: 'Your moves from your repertoire, up to the first that was not',
    marks: sparMarks(r),
    stats: [['Stockfish', r.evalText ?? '…']],
    missed: miss && r.cards.has(posKey(miss.fen)) ? [{ id: posKey(miss.fen), moves: miss.moves, san: miss.answer! }] : [],
    extra: [r.error ? errorLine(r.error) : null, el('div', 'grid sm:flex', [button('Spar again', () => ctrl.sparAgain(), 'quiet')])],
  })
}
