import type { Color } from 'chessops/types'
import { opposite } from 'chessops/util'
import { h, type VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { accuracy } from '../analysis/accuracy'
import type { Game, MaiaSpeed } from '../db'
import { history, MAX_LEVEL, MIN_LEVEL, startLabel } from '../maia'
import { material, readGame, TIMES, type PlayRun, type SavedGame } from '../play'
import { el } from '../el'
import { moveTable, score } from './moves'
import { board, boardScreen, btnClass, button, card, dateLabel, errorLine, jumps, judgColor, label, listRow, loading, plural, rowList, segmented } from './ui'
import { nextButtons } from './summary'
import { playTimeLine } from './time'

const RESULT = { win: 'Won', loss: 'Lost', draw: 'Draw' } as const

// Whole games against Maia-3: the Play page, then the game's board screen.
// Its strength was measured, not guaranteed, so the level reads "about" and
// never promises a rating.
export function setupView(ctrl: Ctrl): VNode {
  const level = ctrl.maiaLevel
  const { time, color, pace } = ctrl.playChoices
  const saved = readGame()
  const step = (by: number) =>
    el(
      'button',
      `${btnClass('plain', 'fill')} tabular-nums`,
      { attrs: { type: 'button', disabled: level === (by < 0 ? MIN_LEVEL : MAX_LEVEL) }, on: { click: () => ctrl.stepMaiaLevel(by) } },
      `${by < 0 ? '−' : '+'}${Math.abs(by)}`,
    )
  return el('div', 'mx-auto max-w-xl space-y-4', [
    el('h1', 'font-display text-2xl', 'Play'),
    card([
      el('p', 'text-center font-display text-3xl tabular-nums', { attrs: { title: 'Approximate Lichess blitz rating' } }, `about ${level}`),
      el('p', 'mt-1 text-center text-sm text-dim', `${time === 'unlimited' ? 'Unlimited' : time} · ${COLOUR[color]} · ${PACE[pace]}`),
      el('div', 'mt-5 grid gap-2', [
        saved ? button('Continue game', () => ctrl.go('maia')) : null,
        button('Play', () => ctrl.startPlay(false), saved ? 'plain' : 'primary'),
      ]),
      saved ? el('p', 'mt-2 text-center text-xs text-dim', savedText(saved)) : null,
    ]),
    card([
      label('Level'),
      levelLine(ctrl, ctrl.maiaSpeed),
      el('div', 'mt-3 grid grid-cols-6 gap-2', [-100, -10, -1, 1, 10, 100].map(step)),
      ctrl.playLevel === undefined
        ? null
        : el('p', 'mt-2 text-center text-xs text-dim', [
            // A link in the line of text, so not a button()
            el('button', 'underline', { attrs: { type: 'button' }, on: { click: () => ctrl.stepMaiaLevel(0) } }, 'Back to the level that follows your results'),
          ]),
      // Seven times fit a phone's card only with the symbol for unlimited
      segments('Time', TIMES.map(t => (t === 'unlimited' ? [t, '∞', 'Unlimited'] : [t, t])), time, t => ctrl.setPlayChoice({ time: t })),
      segments('Colour', [['white', 'White'], ['black', 'Black'], ['random', 'Random']], color, c => ctrl.setPlayChoice({ color: c })),
      segments('Pace', [['human', 'Human'], ['instant', 'Instant']], pace, p => ctrl.setPlayChoice({ pace: p }), 'Human takes about as long as a person; Instant replies at once'),
    ]),
    ctrl.playStarts.length
      ? el('div', 'space-y-2', [
          label('From your games'),
          rowList(
            ctrl.playStarts.slice(0, 5).map(s => listRow(() => ctrl.startPlay(s), [el('span', 'min-w-0 truncate text-sm', `${startLabel(s)}, ${dateLabel(s.playedAt)}`)])),
            'overflow-hidden rounded-xl bg-surface',
          ),
        ])
      : null,
  ])
}

const COLOUR = { white: 'White', black: 'Black', random: 'Random' }
const PACE = { human: 'Human', instant: 'Instant' }

// The estimate going into each of the last games at the chosen speed, then
// the estimate now, once there are enough games for a line to mean anything
function levelLine(ctrl: Ctrl, speed: MaiaSpeed): VNode | null {
  const pts = history(ctrl.maiaGames, speed)
  if (pts.length < 5) return null
  const n = pts.length
  if (ctrl.maiaEstimate.from === speed) pts.push(ctrl.maiaRating)
  const lo = Math.min(...pts)
  const hi = Math.max(...pts)
  const w = 100
  const ht = 32
  const xy = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${hi === lo ? ht / 2 : 2 + ((hi - v) / (hi - lo)) * (ht - 4)}`).join(' ')
  return el('div', 'mt-3', { attrs: { title: `Estimate over the last ${n} ${speed} games` } }, [
    el('div', 'flex items-center gap-2 text-xs tabular-nums text-dim', [
      el('span', String(pts[0])),
      // Stretched to the card's width; the stroke stays 2px wide
      h('svg', { attrs: { viewBox: `0 0 ${w} ${ht}`, preserveAspectRatio: 'none', height: ht, class: 'min-w-0 flex-1', 'aria-hidden': 'true' } }, [
        h('polyline', { attrs: { points: xy, fill: 'none', class: 'stroke-accent', 'stroke-width': 2, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' } }),
      ]),
      el('span', String(pts.at(-1))),
    ]),
  ])
}

function savedText({ opts, moves }: SavedGame): string {
  const c = opts.clock
  return `${c ? `${c.base / 60}+${c.inc}` : 'Unlimited'} · Maia about ${opts.level} · move ${Math.floor(moves.length / 2) + 1}`
}

// [value, text, a spoken name when the text is a symbol]
function segments<T extends string>(name: string, opts: [T, string, string?][], current: T, pick: (v: T) => void, title?: string): VNode {
  return el('div', 'mt-3 space-y-1', [el('p', 'text-xs text-dim', title ? { attrs: { title } } : {}, name), segmented(name, opts, current, pick)])
}

export function playView(ctrl: Ctrl): VNode {
  const run = ctrl.play
  if (!run) return loading()
  const { level, start, color } = run.opts
  const m = material(run.fen)
  const moves = run.moves.length ? moveTable(run.moves, run.viewPly, ply => run.go(ply), run.result && score(run.result, color)) : null
  return boardScreen({
    title: 'Play Maia',
    back: () => ctrl.back('play'),
    above: player(run, m, opposite(color), `Maia, about ${level}`),
    board: board(run.key, e => run.mount(e)),
    below: player(run, m, color, 'You'),
    controls: run.live ? null : jumps(run.viewPly, 0, run.moves.length, ply => run.go(ply)),
    side: [
      // Once it is over the summary comes first, in view under the board on a phone
      ...(run.state === 'over'
        ? [over(ctrl), moves]
        : [
            run.promoting ? promotion(run) : null,
            start ? el('p', 'text-sm', `From move ${Math.floor(start.moves.length / 2) + 1} of an earlier game${start.opening ? `, ${start.opening.split(':')[0]}` : ''}.`) : null,
            el('div', 'flex gap-6 text-sm', [
              el('div', [el('p', 'text-xs text-dim', 'You play'), el('p', 'font-medium', color)]),
              run.last ? el('div', [el('p', 'text-xs text-dim', 'Maia played'), el('p', 'font-medium', run.last)]) : null,
            ]),
            moves,
            live(ctrl),
          ]),
    ],
  })
}

// m:ss, with tenths under ten seconds as on Lichess
function clockText(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${ms < 10000 ? `.${Math.floor((ms % 1000) / 100)}` : ''}`
}

// One side's bar, above or below the board as on Lichess: the name, the
// pieces it has taken with its lead in points, and its clock
function player(run: PlayRun, m: ReturnType<typeof material>, color: Color, name: string): VNode {
  const lead = color === 'white' ? m.diff : -m.diff
  const ms = run.clock(color)
  return el('div', 'flex h-10 items-center gap-2 px-2 wide:px-0', [
    el('span', 'shrink-0 text-sm font-medium', { attrs: name === 'You' ? {} : { title: 'Approximate Lichess blitz rating' } }, name),
    el('span', 'mat flex min-w-0 flex-1 items-center overflow-hidden', [
      ...m[color].map(role => el('span', `piece-preview ${opposite(color)} ${role}`)),
      lead > 0 ? el('span', 'ml-3 text-sm text-dim tabular-nums', `+${lead}`) : null,
    ]),
    run.opts.clock
      ? el('span', 'rounded-lg px-2 font-display text-2xl tabular-nums', { class: { 'bg-raised': run.running === color, 'text-bad': ms < 10000 } }, clockText(ms))
      : null,
  ])
}

const PIECES = [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']] as const

// At the top of the panel, so it is in view below the board on a phone
function promotion(run: PlayRun): VNode {
  return el('div', 'flex items-center gap-2', [
    ...PIECES.map(([piece, role]) =>
      // 56px, a size up from an icon button, to fit the piece
      el(
        'button',
        'grid size-14 place-items-center rounded-lg bg-raised',
        { attrs: { type: 'button', 'aria-label': `Promote to ${role}`, title: `Promote to ${role}` }, on: { click: () => void run.promote(piece) } },
        [el('span', `piece-preview ${run.opts.color} ${role}`)],
      ),
    ),
    button('Cancel', () => void run.promote(), 'quiet'),
  ])
}

function live(ctrl: Ctrl): VNode {
  const run = ctrl.play!
  return el('div', 'space-y-3', [
    run.state === 'failed'
      ? el('div', 'space-y-2', [errorLine(run.error), button('Try again', () => run.retry(), 'plain')])
      : el('p', 'text-sm text-dim', run.state === 'thinking' ? 'Maia is thinking…' : run.offering ? 'Draw offered…' : run.note ? `${run.note} Your move.` : 'Your move.'),
    el('div', 'flex flex-wrap gap-2', [
      run.live ? null : button('Back to the game', () => run.go(run.moves.length), 'plain'),
      ...(run.resigning
        ? [button('Confirm resign', () => run.resign(), 'plain'), button('Cancel', () => run.cancelResign(), 'quiet')]
        : [button('Offer draw', () => void run.offerDraw(), 'quiet', !run.canOfferDraw), button('Resign', () => run.resign(), 'quiet')]),
    ]),
  ])
}

function over(ctrl: Ctrl): VNode {
  const run = ctrl.play!
  const game = run.saved
  const ids = ctrl.playPuzzles
  const solve = !!ids?.length
  return el('div', 'space-y-4', [
    el('div', [
      el('p', 'font-display text-xl', { class: { 'text-accent': run.result === 'win', 'text-bad': run.result === 'loss' } }, RESULT[run.result!]),
      el('p', 'text-sm text-dim', `${run.ending}.`),
    ]),
    run.tooShort
      ? el('p', 'text-sm text-dim', 'Resigned in under 5 moves, so not saved.')
      : game
        ? el('p', 'text-sm', ['Estimate against Maia: ', el('span', 'font-medium tabular-nums', `${run.opts.rating} → ${ctrl.maiaRatingAt(game.speed)}`)])
        : null,
    game ? playTimeLine(game) : null,
    !game ? null : ids ? analysis(game, run.opts.color, ids, ctrl) : el('p', 'text-sm text-dim', ctrl.syncing ? 'Analyzing the game…' : 'Not analyzed yet.'),
    el('div', 'flex flex-wrap gap-2', [button('Rematch', () => ctrl.rematch(), 'plain'), game ? button('Review the game', () => ctrl.go('game', game.id), 'plain') : null]),
    nextButtons(ctrl, !solve),
  ])
}

const JUDGED = [['inaccuracy', 'inaccuracies'], ['mistake', 'mistakes'], ['blunder', 'blunders']] as const

// Once the game is analyzed: both accuracies, the player's slips, and the
// puzzles made from them
function analysis(game: Game, color: Color, ids: string[], ctrl: Ctrl): VNode {
  const a = accuracy(game.moves)
  const mine = game.moves.filter((_, i) => (i % 2 === 0) === (color === 'white'))
  return el('div', 'space-y-3', [
    a
      ? el('p', 'text-sm', [
          'Accuracy ',
          el('span', 'font-medium tabular-nums', `${Math.round(a[color])}%`),
          ' vs Maia ',
          el('span', 'font-medium tabular-nums', `${Math.round(a[opposite(color)])}%`),
        ])
      : null,
    el(
      'p',
      'flex flex-wrap gap-x-4 text-sm',
      JUDGED.map(([j, many]) => {
        const n = mine.filter(m => m.judg === j).length
        return el('span', { class: { [judgColor[j]]: n > 0, 'text-dim': !n } }, [el('strong', 'tabular-nums', String(n)), ` ${n === 1 ? j : many}`])
      }),
    ),
    ids.length
      ? el('div', 'space-y-2', [
          el('p', 'text-sm', `${plural(ids.length, 'puzzle')} from this game.`),
          button(ids.length === 1 ? 'Solve it' : 'Solve them', () => ctrl.solvePuzzles(ids)),
        ])
      : el('p', 'text-sm text-dim', 'No puzzles from this game.'),
  ])
}
