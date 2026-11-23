import type { VNode, VNodeChildren } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { MIN_GAMES } from '../time'
import { limitFor } from '../timed'
import { loadingBlock } from './ui'

// Every way to train, as a tile with its count. A tile with nothing behind
// it yet is dimmed, with the reason as its tooltip.
export function trainView(ctrl: Ctrl): VNode {
  const d = ctrl.due
  const head = el('h1', 'font-display text-2xl', 'Train')
  if (!d) return el('div', 'mx-auto max-w-2xl space-y-4', [head, loadingBlock('h-64')])
  const locked = ctrl.profile?.band === 'beginner'
  const clock = ctrl.timeProfiles[0]
  const l = d.latest
  return el('div', 'mx-auto max-w-2xl space-y-4', [
    head,
    el('div', 'grid grid-cols-2 gap-3 sm:grid-cols-3', [
      tile('Puzzles', d.puzzles, 'due', d.puzzles ? () => void ctrl.startDrill() : undefined, d.puzzles ? undefined : 'None due'),
      tile('Openings', d.reviews + d.fresh, `${d.reviews} due · ${d.fresh} new`, '#/openings'),
      tile('Conversion', d.conversion, 'open', '#/conversion'),
      locked ? tile('Defense', '–', 'locked', undefined, 'Unlocks at club level (rated 1000+)') : tile('Defense', d.defense, 'open', '#/defense'),
      clock
        ? tile('Clock', `${limitFor(clock.think, 1)} s`, 'a move', () => void ctrl.startTimed('train'))
        : tile('Clock', '–', 'a move', undefined, `Needs ${MIN_GAMES} analyzed blitz or rapid games with clocks`),
      l
        ? tile('Turning points', l.stops, l.game.opponent ? `vs ${l.game.opponent}` : 'latest game', `#/replay/${encodeURIComponent(l.game.id)}`)
        : tile('Turning points', '–', 'latest game', undefined, 'None yet'),
    ]),
  ])
}

const TILE = 'flex min-h-28 flex-col justify-between gap-3 rounded-xl bg-surface p-4 text-left transition-colors'

function tile(name: string, value: string | number, sub: string, to: string | (() => void) | undefined, title?: string): VNode {
  const body: VNodeChildren = [
    el('p', 'font-medium', name),
    el('div', 'min-w-0', [el('p', 'font-display text-3xl leading-none tabular-nums', String(value)), el('p', 'mt-1 truncate text-xs text-dim', sub)]),
  ]
  const attrs: Record<string, string> = title ? { title } : {}
  if (!to) return el('div', `${TILE} opacity-50`, { attrs: { ...attrs, 'aria-disabled': 'true' } }, body)
  const live = `${TILE} hover:bg-hover active:bg-press focus-visible:-outline-offset-2`
  return typeof to === 'string'
    ? el('a', live, { attrs: { ...attrs, href: to } }, body)
    : el('button', live, { attrs: { ...attrs, type: 'button' }, on: { click: to } }, body)
}
