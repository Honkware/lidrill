import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import type { Replay } from '../replay'
import { puzzleSide } from './drill'
import { board, button, card, label, topBar } from './ui'

export function replayView(ctrl: Ctrl): VNode {
  const r = ctrl.replay
  if (!r) return el('p', 'p-4 text-dim', 'Loading…')
  const title = `Turning points${r.game.opponent ? ` vs ${r.game.opponent}` : ''}`
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [topBar(title, () => ctrl.back('review'))]), board(`replay:${r.game.id}`, e => r.mount(e))]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [el('div', 'hidden md:block', [topBar(title, () => ctrl.back('review'))]), side(ctrl, r)]),
  ])
}

function progressDots(r: Replay): VNode {
  return el(
    'div',
    'flex gap-1',
    r.stops.map((_, i) =>
      el('span', 'h-2 flex-1 rounded-full', {
        class: { 'bg-accent': r.results[i] === true, 'bg-bad': r.results[i] === false, 'bg-raised': r.results[i] === undefined },
      }),
    ),
  )
}

function side(ctrl: Ctrl, r: Replay): VNode {
  const n = r.stops.length
  if (r.state === 'done') {
    const score = r.results.filter(Boolean).length
    return el('div', 'space-y-4', [
      progressDots(r),
      el('p', 'font-display text-2xl', `${score} of ${n} found`),
      el('p', 'text-sm text-dim', score === n ? 'Every turning point. Next time, find them over the board.' : 'The ones you missed are in your puzzle queue too.'),
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
    el('p', 'font-display text-xl', 'Replaying…'),
    el('p', 'text-sm text-dim', `Move ${Math.ceil(r.ply / 2)}. The board stops where the game turned and asks for your move.`),
    button(r.current ? 'Skip to the next stop' : 'Skip to the end', () => r.skip(), 'plain'),
  ])
}
