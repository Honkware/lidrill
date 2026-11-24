import type { VNode } from 'snabbdom'
import type { Ctrl, DueNow } from '../ctrl'
import { el } from '../el'
import type { Next } from '../next'
import { btnClass, button, card, errorLine, icon, listRow, loadingBlock, rowList, weekBars } from './ui'

// Train when no puzzle is due, and the day's overview at #/train/day: the
// one next thing to do as the big button, the day's parts under it, the
// streak, and a row each for the places that always have something
export function todayView(ctrl: Ctrl): VNode {
  const d = ctrl.due
  const n = ctrl.nextUp
  if (!d || !n) return skeleton()
  return el('div', 'mx-auto max-w-2xl space-y-4', [
    bandNote(ctrl),
    nextCard(ctrl, n),
    dayBar(d),
    streakLine(ctrl),
    rows(ctrl, d),
    ctrl.error ? errorLine(ctrl.error) : null,
  ])
}

// Grey blocks in the shape of the page while the first load runs
function skeleton(): VNode {
  return el('div', 'mx-auto max-w-2xl space-y-4', [loadingBlock('h-40'), loadingBlock('h-6'), loadingBlock('h-40')])
}

// The single home of the band rule: Settings → "What counts". Other
// surfaces link here instead of restating the definition.
export function whatCountsLink(): VNode {
  return el('a', 'underline decoration-dotted underline-offset-2', { attrs: { href: '#/settings' } }, 'What counts?')
}

function nextCard(ctrl: Ctrl, n: Next): VNode {
  return card(
    [
      el('p', 'text-center font-display text-3xl', [n.label, n.count ? el('span', 'tabular-nums', ` ${n.count}`) : null]),
      n.go === 'play' ? el('p', 'mt-1 text-center text-sm tabular-nums text-dim', { attrs: { title: 'Approximate Lichess blitz rating' } }, `about ${ctrl.maiaLevel}`) : null,
      el('div', 'mt-5 grid', [button('Start', () => void ctrl.goNext())]),
    ],
    'py-6 sm:py-8',
  )
}

// One segment per part of the day with anything scheduled, as long as its
// share of the day's items, filled as they are done
function dayBar(d: DueNow): VNode | null {
  const parts = (
    [
      ['Puzzles', d.puzzlesDone, d.puzzlesDone + d.puzzles],
      ['Openings', d.openingsDone, d.openingsDone + d.reviews + d.fresh],
    ] as const
  ).filter(([, , total]) => total > 0)
  if (!parts.length) return null
  return el('div', 'space-y-1 px-1', [
    el(
      'div',
      'flex gap-1',
      parts.map(([name, done, total]) =>
        el('div', 'h-2 basis-0 overflow-hidden rounded-full bg-raised', { style: { flexGrow: String(total) }, attrs: { role: 'img', 'aria-label': `${name} ${done} of ${total}` } }, [
          el('div', 'h-2 bg-accent', { style: { width: `${(100 * done) / total}%` } }),
        ]),
      ),
    ),
    el('p', 'flex gap-4 text-xs tabular-nums text-dim', parts.map(([name, done, total]) => el('span', `${name} ${done}/${total}`))),
  ])
}

function streakLine(ctrl: Ctrl): VNode | null {
  const t = ctrl.today
  if (!t) return null
  const { streak, weeks } = t
  const best = Math.max(streak.best, streak.current)
  return el('div', 'flex items-center justify-between gap-4 px-1', [
    el('p', 'text-sm', { attrs: { title: `Best ${best}` } }, [
      el('span', 'font-display text-2xl tabular-nums', String(streak.current)),
      ` clean ${streak.current === 1 ? 'game' : 'games'}`,
    ]),
    weeks.some(w => w.games) ? weekBars(weeks) : null,
  ])
}

const row = (href: string, name: string, value: string) =>
  listRow(href, [el('span', 'min-w-0 flex-1 truncate font-medium', name), el('span', 'shrink-0 text-sm tabular-nums text-dim', value), icon('next', 16)])

function rows(ctrl: Ctrl, d: DueNow): VNode {
  const l = d.latest
  return rowList(
    [
      row('#/openings', 'Openings', `${d.reviews} due · ${d.fresh} new`),
      l ? row(`#/replay/${encodeURIComponent(l.game.id)}`, 'Turning points', `${l.game.opponent ? `vs ${l.game.opponent} · ` : ''}${l.stops}`) : null,
      row('#/play', 'Play Maia', `about ${ctrl.maiaLevel}`),
    ].filter(r => r !== null),
    'overflow-hidden rounded-xl bg-surface',
  )
}

// One quiet note after a band change: no accent border, expires after
// three days, dismissible. The rule itself lives in Settings → "What counts".
function bandNote(ctrl: Ctrl): VNode | null {
  const hist = ctrl.profile?.bandHistory ?? []
  const last = hist.at(-1)
  if (hist.length < 2 || !last || Date.now() - last.at > 3 * 86400000) return null
  const seenKey = `lidrill.bandNote.${last.at}`
  if (localStorage.getItem(seenKey)) return null
  const order = ['beginner', 'club', 'advanced']
  const up = order.indexOf(last.band) > order.indexOf(hist.at(-2)!.band)
  const extra = up && last.band === 'club' ? ' Defense drills unlocked.' : ''
  return card([
    el('div', 'flex items-start justify-between gap-3', [
      el('p', 'text-sm', [`Level changed to ${last.band}.${extra} `, whatCountsLink()]),
      el(
        'button',
        btnClass('quiet', 'icon'),
        { attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => { localStorage.setItem(seenKey, '1'); ctrl.redraw() } } },
        '✕',
      ),
    ]),
  ])
}
