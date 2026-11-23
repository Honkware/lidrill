import type { VNode } from 'snabbdom'
import type { Ctrl } from '../ctrl'
import { el } from '../el'
import { btnClass, button, card, empty, errorLine, label, loadingBlock, plural, weekBars } from './ui'

// Home IA: one hero (streak), one primary action (due), then at most three
// half cards (turning points, this week's focus, drills). Everything else
// lives a tap away: openings and game detail in Review, the plan, Lichess
// themes and the band rule in Settings.
export function todayView(ctrl: Ctrl): VNode {
  const t = ctrl.today
  const p = ctrl.profile
  if (!t || !p)
    return ctrl.ready
      ? el('div', 'space-y-4', [
          empty(ctrl.syncing ? 'Fetching games…' : 'No games yet.'),
          ctrl.error ? errorLine(ctrl.error) : null,
        ])
      : skeleton()
  return el('div', 'grid gap-4 md:grid-cols-2', [
    streakCard(ctrl),
    bandNote(ctrl),
    dueCard(ctrl),
    replayCard(ctrl),
    focusCard(ctrl),
    drillsCard(ctrl),
    ctrl.error ? errorLine(ctrl.error, 'md:col-span-2') : null,
  ])
}

// Grey blocks in the shape of the dashboard while the first load runs
function skeleton(): VNode {
  return el('div', 'grid gap-4 md:grid-cols-2', [loadingBlock('h-32 md:col-span-2'), loadingBlock('h-44'), loadingBlock('h-44'), loadingBlock('h-40'), loadingBlock('h-40')])
}

// The single home of the band rule: Settings → "What counts". Other
// surfaces link here instead of restating the definition.
export function whatCountsLink(): VNode {
  return el('a', 'underline decoration-dotted underline-offset-2', { attrs: { href: '#/settings' } }, 'What counts?')
}

// Hero metric. No rule text on the card.
function streakCard(ctrl: Ctrl): VNode {
  const { streak, weeks } = ctrl.today!
  const played = weeks.some(w => w.games)
  const best = Math.max(streak.best, streak.current)
  return card(
    [
      el('div', 'flex items-end justify-between gap-4', [
        el('div', [
          el('p', 'font-display text-5xl leading-none tabular-nums', String(streak.current)),
          el('p', 'mt-1 text-sm', `clean ${streak.current === 1 ? 'game' : 'games'} in a row`),
        ]),
        played ? el('div', 'flex flex-col items-end gap-1', [weekBars(weeks), el('p', 'text-xs text-dim', 'last 8 weeks')]) : null,
      ]),
      el('p', 'mt-3 text-xs text-dim', [best ? `Best ${best}. ` : '', whatCountsLink()]),
    ],
    'md:col-span-2',
  )
}

function dueCard(ctrl: Ctrl): VNode {
  const { queue } = ctrl.today!
  const { remaining, doneToday } = ctrl.today!.due
  const external = queue.puzzles.filter(x => x.source === 'lichess').length
  return card([
    label('Due today'),
    el('p', 'mt-1 font-display text-3xl', plural(remaining, 'puzzle')),
    external ? el('p', 'mt-1 text-sm text-dim', `${external} from Lichess`) : null,
    ctrl.today!.openingDue
      ? el('p', 'mt-1 text-sm', [`${plural(ctrl.today!.openingDue, 'opening card')} due. `, el('a', 'text-accent underline', { attrs: { href: '#/opening' } }, 'Train')])
      : null,
    remaining
      ? el('div', 'mt-4 grid', [button('Start', () => ctrl.startDrill())])
      : el(
          'p',
          'mt-2 text-sm text-dim',
          doneToday
            ? 'Done for today.'
            : ctrl.counts.puzzles
              ? 'Nothing due today.'
              : ctrl.syncing
                ? 'Analyzing games…'
                : 'No puzzles yet. Sync your games first.',
        ),
  ])
}

function replayCard(ctrl: Ctrl): VNode | null {
  const pick = ctrl.today!.replayPick
  if (!pick) return null
  return card([
    label('Turning points'),
    el('p', 'mt-1', [`Last game${pick.game.opponent ? ` vs ${pick.game.opponent}` : ''}: `, el('strong', '', plural(pick.stops, 'turning point'))]),
    el('div', 'mt-4 grid', [button('Replay', () => ctrl.go('replay', pick.game.id), 'plain')]),
  ])
}

// The week's one focus: the recurring leak if there is one, otherwise the
// weakest area (report.focus already picks). One line of data plus one
// action - improvement-areas style, never both a focus and a leak card.
function focusCard(ctrl: Ctrl): VNode | null {
  const r = ctrl.today!.report
  const d = ctrl.today!.practice
  const open = d.conversion + (ctrl.profile!.band === 'beginner' ? 0 : d.defense)
  if (!r.focus) return null
  return card([
    label(r.leak ? 'Recurring' : 'This week'),
    el('p', 'mt-2', r.focus),
    r.leak
      ? el('a', 'mt-3 inline-block text-sm text-accent', { attrs: { href: '#/review' } }, 'See the games')
      : open
        ? el('a', 'mt-3 inline-block text-sm text-accent', { attrs: { href: '#/drills' } }, 'Open drills')
        : null,
  ])
}

function drillsCard(ctrl: Ctrl): VNode | null {
  const d = ctrl.today!.practice
  const beginner = ctrl.profile!.band === 'beginner'
  const open = d.conversion + (beginner ? 0 : d.defense)
  if (!open && !d.cleared) return null
  return card([
    label('Drills'),
    el('p', 'mt-2', open ? `${plural(open, 'position')} to play out.` : 'All cleared.'),
    d.cleared ? el('p', 'mt-1 text-sm text-dim', `${d.cleared} cleared.`) : null,
    open ? el('div', 'mt-4 grid', [button('Open drills', () => ctrl.go('drills'), 'plain')]) : null,
  ])
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
  return card(
    [
      el('div', 'flex items-start justify-between gap-3', [
        el('p', 'text-sm', [`Level changed to ${last.band}.${extra} `, whatCountsLink()]),
        el(
          'button',
          btnClass('quiet', 'icon'),
          { attrs: { type: 'button', 'aria-label': 'Dismiss' }, on: { click: () => { localStorage.setItem(seenKey, '1'); ctrl.redraw() } } },
          '✕',
        ),
      ]),
    ],
    'md:col-span-2',
  )
}
