import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { PlayRun } from '../play'
import { el } from '../el'
import { moveTable, score } from './moves'
import { board, button, plural, topBar } from './ui'

const RESULT = { win: 'You won', loss: 'You lost', draw: 'Draw' } as const

export function playView(ctrl: Ctrl): VNode {
  const run = ctrl.play
  if (!run) return el('p', 'p-4 text-dim', 'Loading…')
  const { level, start } = run.opts
  const bar = () => topBar('Play Maia', () => ctrl.back('drills'))
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [bar()]), board(run.key, e => run.mount(e))]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [
      el('div', 'hidden md:block', [bar()]),
      clocks(run),
      run.promoting ? promotion(run) : null,
      el('p', 'text-sm', start ? `From move ${Math.floor(start.moves.length / 2) + 1} of one of your games${start.opening ? `, ${start.opening.split(':')[0]}` : ''}.` : 'A game from the first move.'),
      el('div', 'flex gap-6 text-sm', [
        el('div', [el('p', 'text-xs text-dim', 'Maia'), el('p', 'font-medium tabular-nums', { attrs: { title: 'Approximate Lichess blitz rating' } }, `about ${level}`)]),
        el('div', [el('p', 'text-xs text-dim', 'You play'), el('p', 'font-medium', run.opts.color)]),
        run.last ? el('div', [el('p', 'text-xs text-dim', 'Maia played'), el('p', 'font-medium', run.last)]) : null,
      ]),
      run.moves.length ? moveTable(run.moves, run.viewPly, ply => run.go(ply), run.result && score(run.result, run.opts.color)) : null,
      run.state === 'over' ? over(ctrl) : live(ctrl),
    ]),
  ])
}

// m:ss, with tenths under ten seconds as on Lichess
function clockText(ms: number): string {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${ms < 10000 ? `.${Math.floor((ms % 1000) / 100)}` : ''}`
}

function clocks(run: PlayRun): VNode | null {
  if (!run.opts.clock) return null
  const row = (name: string, color: 'white' | 'black') => {
    const ms = run.clock(color)
    return el('div', 'flex items-baseline justify-between rounded-lg px-3 py-1', { class: { 'bg-raised': run.running === color, 'text-bad': ms < 10000 } }, [
      el('span', 'text-sm', name),
      el('span', 'font-display text-2xl tabular-nums', clockText(ms)),
    ])
  }
  return el('div', 'max-w-xs space-y-1', [row('Maia', run.opts.color === 'white' ? 'black' : 'white'), row('You', run.opts.color)])
}

const PIECES = [['q', 'queen'], ['r', 'rook'], ['b', 'bishop'], ['n', 'knight']] as const

// Right under the clocks, so it is in view below the board on a phone
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
