import type { VNode } from 'snabbdom'
import type { Ctrl, Screen } from '../ctrl'
import { el } from '../el'
import { drillsView, practiceView } from './drills'
import { drillView } from './drill'
import { gameView, reviewView } from './review'
import { gamesView } from './games'
import { replayView } from './replay'
import { settingsView } from './settings'
import { todayView } from './today'
import { icon } from './ui'
import { welcomeView } from './welcome'

const TABS: { screen: Screen; label: string; icon: string }[] = [
  { screen: 'today', label: 'Today', icon: 'today' },
  { screen: 'review', label: 'Review', icon: 'review' },
  { screen: 'drills', label: 'Drills', icon: 'drills' },
  { screen: 'games', label: 'Games', icon: 'games' },
  { screen: 'settings', label: 'Settings', icon: 'settings' },
]

// Board screens take the whole phone screen: no tab bar
const BOARD_SCREENS: Screen[] = ['drill', 'replay', 'game', 'practice']

const tabOf = (s: Screen): Screen => (s === 'game' || s === 'replay' ? 'review' : s === 'practice' ? 'drills' : s === 'drill' ? 'today' : s)

export function view(ctrl: Ctrl): VNode {
  const full = BOARD_SCREENS.includes(ctrl.screen)
  const tabs = ctrl.screen !== 'welcome' && !full
  return el('div', 'min-h-dvh', { class: { 'pb-tabbar': tabs } }, [
    header(ctrl, full),
    el('main', 'mx-auto w-full max-w-5xl', { class: { 'px-4': !full, 'pt-4': !full, 'sm:px-6': true, 'pb-8': !full } }, [ctrl.loaded ? screen(ctrl) : null]),
    tabs ? tabBar(ctrl) : null,
    ctrl.notice ? notice(ctrl, tabs) : null,
  ])
}

function screen(ctrl: Ctrl): VNode {
  switch (ctrl.screen) {
    case 'welcome':
      return welcomeView(ctrl)
    case 'today':
      return todayView(ctrl)
    case 'drill':
      return drillView(ctrl)
    case 'replay':
      return replayView(ctrl)
    case 'review':
      return reviewView(ctrl)
    case 'game':
      return gameView(ctrl)
    case 'games':
      return gamesView(ctrl)
    case 'drills':
      return drillsView(ctrl)
    case 'practice':
      return practiceView(ctrl)
    case 'settings':
      return settingsView(ctrl)
  }
}

// Desktop: logo, nav and account. Phone: logo and sync state only, and none
// at all on board screens.
function header(ctrl: Ctrl, full: boolean): VNode | null {
  const signedIn = ctrl.screen !== 'welcome'
  return el('header', 'pt-safe border-b border-raised', { class: { 'max-sm:hidden': full } }, [
    el('div', 'mx-auto flex h-12 max-w-5xl items-center gap-6 px-4 sm:h-14 sm:px-6', [
      el('a', 'font-display text-xl font-bold', { attrs: { href: signedIn ? '#/today' : '#' } }, 'lidrill'),
      signedIn
        ? el(
            'nav',
            'hidden gap-5 sm:flex',
            TABS.map(t =>
              el(
                'a',
                'text-sm',
                { attrs: { href: `#/${t.screen}` }, class: { 'text-accent': tabOf(ctrl.screen) === t.screen, 'text-dim': tabOf(ctrl.screen) !== t.screen } },
                t.label,
              ),
            ),
          )
        : null,
      el('div', 'ml-auto flex items-center gap-3 text-sm text-dim', [
        ctrl.syncing && ctrl.progress?.total
          ? el('a', 'flex items-center gap-2 tabular-nums', { attrs: { href: '#/games' } }, [
              el('span', 'size-2 animate-pulse rounded-full bg-accent'),
              `Analyzing ${ctrl.progress.done}/${ctrl.progress.total}`,
            ])
          : null,
        ctrl.auth ? el('span', 'hidden sm:inline', ctrl.auth.username) : null,
      ]),
    ]),
  ])
}

function tabBar(ctrl: Ctrl): VNode {
  return el(
    'nav',
    'pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-raised bg-surface sm:hidden',
    [
      el(
        'div',
        'grid grid-cols-5',
        TABS.map(t => {
          const active = tabOf(ctrl.screen) === t.screen
          return el(
            'a',
            'flex h-14 flex-col items-center justify-center gap-1 text-xs',
            { attrs: { href: `#/${t.screen}`, 'aria-current': active ? 'page' : false }, class: { 'text-accent': active, 'text-dim': !active } },
            [icon(t.icon), t.label],
          )
        }),
      ),
    ],
  )
}

function notice(ctrl: Ctrl, tabs: boolean): VNode {
  const n = ctrl.notice!
  return el(
    'div',
    'fixed inset-x-4 z-30 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-raised px-4 py-3 shadow-lg',
    { class: { 'bottom-notice-tabs': tabs, 'bottom-notice': !tabs } },
    [
      el('p', 'flex-1 text-sm', n.text),
      n.href ? el('a', 'text-sm font-medium text-accent', { attrs: { href: n.href, target: '_blank', rel: 'noopener' } }, 'Open') : null,
      el('button', 'text-sm text-dim', { attrs: { type: 'button' }, on: { click: () => ctrl.dismissNotice() } }, 'OK'),
    ],
  )
}
