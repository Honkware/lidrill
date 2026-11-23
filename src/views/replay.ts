import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import type { Replay } from '../replay'
import { puzzleJumps, puzzleSide } from './drill'
import { board, boardScreen, button, card, dots, label, loading, plural } from './ui'

export function replayView(ctrl: Ctrl): VNode {
  const r = ctrl.replay
  if (!r) return loading()
  const title = `Turning points${r.game.opponent ? ` vs ${r.game.opponent}` : ''}`
  return boardScreen({ title, back: () => ctrl.back('review'), board: board(`replay:${r.game.id}`, e => r.mount(e)), controls: r.drill && puzzleJumps(r.drill), side: [side(ctrl, r)] })
}

// One square per stop: green found, red missed
function progressDots(r: Replay): VNode {
  const found = r.results.filter(Boolean).length
  const marks = r.stops.map((_, i) => (r.results[i] === true ? 'good' : r.results[i] === false ? 'bad' : undefined))
  return dots(marks, r.current ? r.stopIndex : -1, `${found} of ${r.stops.length} found`)
}

function side(ctrl: Ctrl, r: Replay): VNode {
  const n = r.stops.length
  if (r.state === 'done') {
    const score = r.results.filter(Boolean).length
    return el('div', 'space-y-4', [
      progressDots(r),
      el('p', 'font-display text-2xl', `${score} of ${n} found`),
      card(
        [
          label('Journal'),
          el('textarea', 'block w-full rounded-lg bg-raised px-3 py-2 text-sm', {
            attrs: { rows: 3, placeholder: 'What decided this game?' },
            on: { change: e => ctrl.saveJournal({ note: (e.target as HTMLTextAreaElement).value }) },
          }),
        ],
        'space-y-2',
      ),
      el('div', 'grid', [button('Back to the game', () => ctrl.go('game', r.game.id), 'plain')]),
    ])
  }
  if ((r.state === 'stop' || r.state === 'between') && r.drill)
    return el('div', 'space-y-4', [
      progressDots(r),
      el('p', 'text-sm text-dim', `Turning point ${r.state === 'stop' ? r.stopIndex + 1 : r.stopIndex} of ${n}`),
      puzzleSide(r.drill, r.state === 'between' ? [el('div', 'grid', [button(r.stopIndex < n ? 'Continue the game' : 'See the score', () => r.continue())])] : []),
    ])
  return el('div', 'space-y-4', [
    progressDots(r),
    el('p', 'text-sm text-dim', `${plural(n, 'turning point')} to find`),
    button(r.current ? 'Skip to the next turning point' : 'Skip to the end', () => r.skip(), 'quiet'),
  ])
}
