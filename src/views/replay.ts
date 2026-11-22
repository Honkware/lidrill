import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import type { Replay } from '../replay'
import { puzzleSide } from './drill'
import { board, button, card, label, loading, plural, topBar } from './ui'

export function replayView(ctrl: Ctrl): VNode {
  const r = ctrl.replay
  if (!r) return loading()
  const title = `Turning points${r.game.opponent ? ` vs ${r.game.opponent}` : ''}`
  return el('div', 'md:grid md:grid-cols-[auto_minmax(0,1fr)] md:gap-6 md:pt-4', [
    el('div', [el('div', 'md:hidden', [topBar(title, () => ctrl.back('review'))]), board(`replay:${r.game.id}`, e => r.mount(e))]),
    el('aside', 'space-y-4 px-4 pb-8 pt-3 md:px-0 md:pt-0', [el('div', 'hidden md:block', [topBar(title, () => ctrl.back('review'))]), side(ctrl, r)]),
  ])
}

// One square per stop, styled like the drill's session row: green found,
// red missed, grey to come, outlined for the current one
function progressDots(r: Replay): VNode {
  const found = r.results.filter(Boolean).length
  const current = r.current ? r.stopIndex : -1
  return el(
    'div',
    'flex flex-wrap gap-1',
    { attrs: { 'aria-label': `${found} of ${r.stops.length} found` } },
    r.stops.map((_, i) =>
      el('span', 'size-3 rounded-sm', {
        class: {
          'bg-accent': r.results[i] === true,
          'bg-bad': r.results[i] === false,
          'bg-raised': r.results[i] === undefined,
          'ring-2': i === current,
          'ring-fg': i === current,
        },
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
      score < n ? el('p', 'text-sm text-dim', 'Missed ones join your puzzle queue.') : null,
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
    el('p', 'text-sm text-dim', `Replaying the game. ${plural(n, 'turning point')} to find.`),
    button(r.current ? 'Skip to the next turning point' : 'Skip to the end', () => r.skip(), 'quiet'),
  ])
}
