import type { VNode } from 'snabbdom'
import type { Ctrl, Screen } from '../ctrl'
import { el } from '../el'
import { tabOf } from '../routes'
import { drillView } from './drill'
import { gameView } from './review'
import { gamesView } from './games'
import { learnView, openingsPage, openingView, sparView } from './openings'
import { playView, setupView } from './play'
import { practiceListView, practiceView } from './practice'
import { precisionView } from './precision'
import { replayView } from './replay'
import { settingsView } from './settings'
import { todayView } from './today'
import { trainView } from './train'
import { btnClass, icon } from './ui'
import { welcomeView } from './welcome'

const TABS: { screen: Screen; label: string; icon: string }[] = [
  { screen: 'today', label: 'Today', icon: 'today' },
  { screen: 'train', label: 'Train', icon: 'train' },
  { screen: 'play', label: 'Play', icon: 'play' },
  { screen: 'games', label: 'Games', icon: 'games' },
]

// Board screens take the whole phone screen: no tab bar
const BOARD_SCREENS: Screen[] = ['drill', 'replay', 'game', 'practice', 'maia', 'opening', 'learn', 'spar']

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
    case 'game':
      return gameView(ctrl)
    case 'games':
      return gamesView(ctrl)
    case 'train':
      return trainView(ctrl)
    case 'conversion':
    case 'defense':
      return practiceListView(ctrl, ctrl.screen)
    case 'practice':
      return practiceView(ctrl)
    case 'play':
      return setupView(ctrl)
    case 'maia':
      return playView(ctrl)
    case 'settings':
      return settingsView(ctrl)
    case 'precision':
      return precisionView(ctrl)
    case 'opening':
      return openingView(ctrl)
    case 'learn':
      return learnView(ctrl)
    case 'spar':
      return sparView(ctrl)
    case 'openings':
      return openingsPage(ctrl)
  }
}

// Desktop: logo, nav, account and the gear for Settings. Phone: logo, sync
// state and the gear, and none at all on board screens, upright or sideways.
function header(ctrl: Ctrl, full: boolean): VNode | null {
  const signedIn = ctrl.screen !== 'welcome'
  return el('header', 'pt-safe border-b border-raised', { class: { 'max-sm:hidden': full, 'short:hidden': full } }, [
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
      el('div', '-mr-2 ml-auto flex items-center gap-3 text-sm text-dim', [
        ctrl.syncing && ctrl.progress?.total
          ? el('a', 'flex items-center gap-2 tabular-nums', { attrs: { href: '#/games' } }, [
              el('span', 'size-2 animate-pulse rounded-full bg-accent'),
              `Analyzing ${ctrl.progress.done} of ${ctrl.progress.total}`,
            ])
          : null,
        ctrl.auth ? el('span', 'hidden sm:inline', ctrl.auth.username) : null,
        signedIn
          ? el(
              'a',
              btnClass('quiet', 'icon'),
              { attrs: { href: '#/settings', 'aria-label': 'Settings', title: 'Settings' }, class: { 'text-accent': ctrl.screen === 'settings' } },
              [icon('settings')],
            )
          : null,
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
        'grid grid-cols-4',
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
    'fixed inset-x-4 z-30 mx-auto flex max-w-md items-center gap-3 rounded-xl bg-raised py-1 pl-4 pr-1 shadow-lg',
    { attrs: { role: 'status' }, class: { 'bottom-notice-tabs': tabs, 'bottom-notice': !tabs } },
    [
      el('p', 'flex-1 py-2 text-sm', n.text),
      n.href ? el('a', 'text-sm font-medium text-accent', { attrs: { href: n.href, target: '_blank', rel: 'noopener' } }, 'Open') : null,
      el('button', btnClass('quiet', 'sm'), { attrs: { type: 'button' }, on: { click: () => ctrl.dismissNotice() } }, 'OK'),
    ],
  )
}
