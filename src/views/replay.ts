import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import { makeSan } from 'chessops/san'
import { parseUci } from 'chessops/util'
import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import type { Puzzle } from '../db'
import { el } from '../el'
import type { Replay } from '../replay'
import { puzzleJumps, puzzleSide } from './drill'
import { summary } from './summary'
import { board, boardScreen, button, dots, loading, plural, type Mark } from './ui'

export function replayView(ctrl: Ctrl): VNode {
  const r = ctrl.replay
  if (!r) return loading()
  const title = `Turning points${r.game.opponent ? ` vs ${r.game.opponent}` : ''}`
  return boardScreen({ title, back: () => ctrl.back('games'), board: board(`replay:${r.game.id}`, e => r.mount(e)), controls: r.drill && puzzleJumps(r.drill), side: [side(ctrl, r)] })
}

const answer = (p: Puzzle) => makeSan(Chess.fromSetup(parseFen(p.fen).unwrap()).unwrap(), parseUci(p.solution[0])!)

// One square per stop: green found, red missed
const marksOf = (r: Replay): Mark[] => r.stops.map((_, i) => (r.results[i] === true ? 'good' : r.results[i] === false ? 'bad' : undefined))

const progressDots = (r: Replay) => dots(marksOf(r), r.current ? r.stopIndex : -1, `${r.results.filter(Boolean).length} of ${r.stops.length} found`)

function side(ctrl: Ctrl, r: Replay): VNode {
  const n = r.stops.length
  if (r.state === 'done') {
    const found = r.results.filter(Boolean).length
    const missed = r.stops.filter((_, i) => r.results[i] === false)
    return summary(ctrl, {
      score: `${found} / ${n}`,
      marks: marksOf(r),
      counts: [['Found', found], ['Missed', missed.length]],
      missed: missed.map(p => ({ text: `Move ${Math.ceil(p.ply / 2)}`, move: answer(p), open: () => ctrl.openGameAt(r.game.id, p.ply - 1) })),
    })
  }
  if ((r.state === 'stop' || r.state === 'between') && r.drill)
    return el('div', 'space-y-4', [
      progressDots(r),
      el('p', 'text-sm text-dim', `Turning point ${r.state === 'stop' ? r.stopIndex + 1 : r.stopIndex} of ${n}`),
      puzzleSide(r.drill, r.state === 'between' ? [el('div', 'grid', [button(r.stopIndex < n ? 'Continue the game' : 'See the score', () => ctrl.continueReplay())])] : []),
    ])
  return el('div', 'space-y-4', [
    progressDots(r),
    el('p', 'text-sm text-dim', `${plural(n, 'turning point')} to find`),
    button(r.current ? 'Skip to the next turning point' : 'Skip to the end', () => r.skip(), 'quiet'),
  ])
}
