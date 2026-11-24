import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { MIN_GAMES } from '../time'
import { limitFor } from '../timed'
import { icon, listRow, rowList } from './ui'

// Everything outside the two tabs, as a row with its count. A row with
// nothing behind it yet is dimmed, with the reason as its tooltip. A tap
// anywhere in the menu closes it, since the row for the page already open
// changes no route.
export function moreMenu(ctrl: Ctrl): VNode {
  const d = ctrl.due
  const l = d?.latest
  const clock = ctrl.timeProfiles[0]
  const menu = rowList([
    l
      ? row('Turning points', `${l.game.opponent ? `vs ${l.game.opponent} · ` : ''}${l.stops}`, `#/replay/${encodeURIComponent(l.game.id)}`)
      : row('Turning points', '–', undefined, 'None yet'),
    row('Play Maia', `about ${ctrl.maiaLevel}`, '#/play'),
    row('Conversion', d ? `${d.conversion} open` : '', '#/conversion'),
    ctrl.profile?.band === 'beginner'
      ? row('Defense', 'locked', undefined, 'Unlocks at club level (rated 1000+)')
      : row('Defense', d ? `${d.defense} open` : '', '#/defense'),
    clock
      ? row('Clock', `${limitFor(clock.think, 1)} s a move`, () => void ctrl.startTimed('train'))
      : row('Clock', '–', undefined, `Needs ${MIN_GAMES} analyzed blitz or rapid games with clocks`),
    row('Games', String(ctrl.counts.games), '#/games'),
    row('Settings', '', '#/settings'),
  ])
  menu.data = { ...menu.data, on: { click: () => ctrl.closeMore() } }
  return menu
}

function row(name: string, value: string, to: string | (() => void) | undefined, title?: string): VNode {
  const body = [el('span', 'min-w-0 flex-1 truncate font-medium', name), el('span', 'shrink-0 text-sm tabular-nums text-dim', value)]
  if (!to) return el('li', 'flex min-h-11 items-center gap-3 px-4 py-3 opacity-50 sm:px-5', { attrs: { title: title!, 'aria-disabled': 'true' } }, body)
  return listRow(to, [...body, icon('next', 16)])
}
