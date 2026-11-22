import type { Color } from 'chessops/types'
import { opposite } from 'chessops/util'
import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { material, type PlayRun } from '../play'
import { el } from '../el'
import { moveTable, score } from './moves'
import { board, button, plural, topBar } from './ui'

const RESULT = { win: 'You won', loss: 'You lost', draw: 'Draw' } as const

export function playView(ctrl: Ctrl): VNode {
  const run = ctrl.play
  if (!run) return el('p', 'p-4 text-dim', 'Loading…')
  const { level, start, color } = run.opts
  const bar = () => topBar('Play Maia', () => ctrl.back('drills'))
  const m = material(run.fen)
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', 'play-board', [
      el('div', 'md:hidden', [bar()]),
      player(run, m, opposite(color), `Maia, about ${level}`),
      board(run.key, e => run.mount(e)),
      player(run, m, color, 'You'),
    ]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [
      el('div', 'hidden md:block', [bar()]),
      run.promoting ? promotion(run) : null,
      el('p', 'text-sm', start ? `From move ${Math.floor(start.moves.length / 2) + 1} of one of your games${start.opening ? `, ${start.opening.split(':')[0]}` : ''}.` : 'A game from the first move.'),
      el('div', 'flex gap-6 text-sm', [
        el('div', [el('p', 'text-xs text-dim', 'You play'), el('p', 'font-medium', color)]),
        run.last ? el('div', [el('p', 'text-xs text-dim', 'Maia played'), el('p', 'font-medium', run.last)]) : null,
      ]),
      run.moves.length ? moveTable(run.moves, run.viewPly, ply => run.go(ply), run.result && score(run.result, color)) : null,
      run.state === 'over' ? over(ctrl) : live(ctrl),
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
      : el('p', 'text-sm text-dim', run.state === 'thinking' ? 'Maia is thinking…' : 'Your move.'),
    el('div', 'flex flex-wrap gap-2', [
      run.live ? null : button('Back to the game', () => run.go(run.moves.length), 'plain'),
      ...(run.resigning
        ? [button('Confirm resign', () => run.resign(), 'plain'), button('Cancel', () => run.cancelResign(), 'quiet')]
        : [button('Resign', () => run.resign(), 'quiet')]),
    ]),
  ])
}

function over(ctrl: Ctrl): VNode {
  const run = ctrl.play!
  const game = run.saved
  const next =
    !game
      ? 'Too short to count.'
      : ctrl.playPuzzles !== undefined
        ? ctrl.playPuzzles
          ? `${plural(ctrl.playPuzzles, 'puzzle')} from this game ${ctrl.playPuzzles === 1 ? 'is' : 'are'} in your queue.`
          : 'No puzzles from this game.'
        : ctrl.syncing
          ? 'Analyzing the game for puzzles…'
          : 'The game is analyzed with your next sync.'
  return el('div', 'space-y-3', [
    el('p', 'font-display text-xl', { class: { 'text-accent': run.result === 'win', 'text-bad': run.result === 'loss' } }, RESULT[run.result!]),
    el('p', 'text-sm text-dim', `${run.ending}. ${next}`),
    game ? el('p', 'text-sm text-dim', `Next opponent: about ${ctrl.maiaLevel}.`) : null,
    el('div', 'flex flex-wrap gap-2', [
      button('Play again', () => ctrl.startPlay(!!run.opts.start)),
      game && ctrl.playPuzzles !== undefined ? button('Review the game', () => ctrl.go('game', game.id), 'plain') : null,
      button('All drills', () => ctrl.go('drills'), 'plain'),
    ]),
  ])
}
