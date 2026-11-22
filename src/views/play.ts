import type { Color } from 'chessops/types'
import { opposite } from 'chessops/util'
import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { accuracy } from '../analysis/accuracy'
import type { Game } from '../db'
import { material, type PlayRun } from '../play'
import { el } from '../el'
import { moveTable, score } from './moves'
import { board, button, judgColor, plural, topBar } from './ui'

const RESULT = { win: 'You won', loss: 'You lost', draw: 'Draw' } as const

export function playView(ctrl: Ctrl): VNode {
  const run = ctrl.play
  if (!run) return el('p', 'p-4 text-dim', 'Loading…')
  const { level, start, color } = run.opts
  const bar = () => topBar('Play Maia', () => ctrl.back('drills'))
  const m = material(run.fen)
  const moves = run.moves.length ? moveTable(run.moves, run.viewPly, ply => run.go(ply), run.result && score(run.result, color)) : null
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', 'play-board', [
      el('div', 'md:hidden', [bar()]),
      player(run, m, opposite(color), `Maia, about ${level}`),
      board(run.key, e => run.mount(e)),
      player(run, m, color, 'You'),
    ]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [
      el('div', 'hidden md:block', [bar()]),
      // Once it is over the summary comes first, in view under the board on a phone
      ...(run.state === 'over'
        ? [over(ctrl), moves]
        : [
            run.promoting ? promotion(run) : null,
            el('p', 'text-sm', start ? `From move ${Math.floor(start.moves.length / 2) + 1} of one of your games${start.opening ? `, ${start.opening.split(':')[0]}` : ''}.` : 'A game from the first move.'),
            el('div', 'flex gap-6 text-sm', [
              el('div', [el('p', 'text-xs text-dim', 'You play'), el('p', 'font-medium', color)]),
              run.last ? el('div', [el('p', 'text-xs text-dim', 'Maia played'), el('p', 'font-medium', run.last)]) : null,
            ]),
            moves,
            live(ctrl),
          ]),
    ]),
  ])
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
  return el('div', 'flex h-10 items-center gap-2 px-2 md:px-0', [
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
      ? el('div', 'space-y-2', [el('p', 'text-sm text-bad', run.error), button('Try again', () => run.retry(), 'plain')])
      : el('p', 'text-sm text-dim', run.state === 'thinking' ? 'Maia is thinking…' : run.offering ? 'You offered a draw.' : run.note ? `${run.note} Your move.` : 'Your move.'),
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
      ? el('p', 'text-sm text-dim', 'Too short to count.')
      : game
        ? el('p', 'text-sm', ['Your level against Maia: ', el('span', 'font-medium tabular-nums', `${run.opts.rating} → ${ctrl.maiaRatingAt(game.speed)}`)])
        : null,
    !game ? null : ids ? analysis(game, run.opts.color, ids, ctrl) : el('p', 'text-sm text-dim', ctrl.syncing ? 'Analyzing the game…' : 'The game is analyzed with your next sync.'),
    el('div', 'flex flex-wrap gap-2', [
      button('Rematch', () => ctrl.rematch(), solve ? 'plain' : 'primary'),
      game ? button('Review the game', () => ctrl.go('game', game.id), 'plain') : null,
      button('All drills', () => ctrl.go('drills'), 'plain'),
    ]),
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
          'Accuracy: you ',
          el('span', 'font-medium tabular-nums', `${Math.round(a[color])}%`),
          ', Maia ',
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
          el('p', 'text-sm', `${plural(ids.length, 'mistake')} from this game ${ids.length === 1 ? 'is now a puzzle' : 'are now puzzles'}.`),
          button(ids.length === 1 ? 'Solve it now' : 'Solve them now', () => ctrl.solvePuzzles(ids)),
        ])
      : el('p', 'text-sm text-dim', 'No puzzles from this game.'),
  ])
}
