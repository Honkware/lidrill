import type { VNode } from 'snabbdom'
import type { Ctrl, Screen } from '../ctrl'
import { el } from '../el'
import { tabOf, type Tab } from '../routes'
import { drillView } from './drill'
import { gameView } from './review'
import { gamesView } from './games'
import { moreMenu } from './more'
import { learnView, openingsPage, openingView, sparView } from './openings'
import { playView, setupView } from './play'
import { practiceListView, practiceView } from './practice'
import { precisionView } from './precision'
import { replayView } from './replay'
import { settingsView } from './settings'
import { todayView } from './today'
import { btnClass, icon } from './ui'
import { welcomeView } from './welcome'

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'train', label: 'Train', icon: 'train' },
  { tab: 'openings', label: 'Openings', icon: 'openings' },
  { tab: 'more', label: 'More', icon: 'more' },
]

// Board screens take the whole phone screen: no header, and no tab bar
// but on the day's puzzles
const BOARD_SCREENS: Screen[] = ['drill', 'replay', 'game', 'practice', 'maia', 'opening', 'learn', 'spar']

// The sample puzzles of a first visit have nothing to navigate to yet
const signedIn = (ctrl: Ctrl) => !!tabOf(ctrl.screen) && !ctrl.sample

export function view(ctrl: Ctrl): VNode {
  const full = BOARD_SCREENS.includes(ctrl.screen)
  // The day's puzzles are where the app opens, so that board keeps the tabs
  const home = ctrl.screen === 'drill'
  const tabs = signedIn(ctrl) && (!full || home)
  return el('div', 'min-h-dvh', { class: { 'pb-tabbar': tabs } }, [
    header(ctrl, full),
    // Train's board sets its own width (.board-screen.hero)
    el('main', 'mx-auto w-full', { class: { 'max-w-5xl': !home, 'px-4': !full, 'pt-4': !full, 'sm:px-6': true, 'pb-8': !full } }, [ctrl.loaded ? screen(ctrl) : null]),
    tabs ? tabBar(ctrl) : null,
    ctrl.moreOpen ? moreSheet(ctrl) : null,
    ctrl.notice ? notice(ctrl, tabs) : null,
  ])
}

function screen(ctrl: Ctrl): VNode {
  switch (ctrl.screen) {
    case 'welcome':
      return welcomeView(ctrl)
    case 'drill':
      return drillView(ctrl)
    case 'replay':
      return replayView(ctrl)
    case 'game':
      return gameView(ctrl)
    case 'games':
      return gamesView(ctrl)
    case 'train':
      return todayView(ctrl)
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

// The open menu takes the highlight from the tab of the screen under it
const tabClass = (ctrl: Ctrl, t: Tab) => {
  const active = (ctrl.moreOpen ? 'more' : tabOf(ctrl.screen)) === t
  return { 'text-accent': active, 'text-dim': !active }
}

const moreAttrs = (ctrl: Ctrl) => ({ type: 'button', 'aria-haspopup': 'true', 'aria-expanded': String(ctrl.moreOpen) })

// Desktop: logo, the three tabs with More as a dropdown, and the account.
// Phone: logo and sync state, and none at all on board screens, upright or
// sideways.
function header(ctrl: Ctrl, full: boolean): VNode | null {
  const nav = signedIn(ctrl)
  return el('header', 'pt-safe border-b border-raised', { class: { 'max-sm:hidden': full, 'short:hidden': full } }, [
    el('div', 'mx-auto flex h-12 max-w-5xl items-center gap-6 px-4 sm:h-14 sm:px-6', [
      el('a', 'font-display text-xl font-bold', { attrs: { href: nav ? '#/train' : '#' } }, 'lidrill'),
      nav
        ? el(
            'nav',
            'hidden items-center gap-5 sm:flex',
            TABS.map(t =>
              t.tab === 'more'
                ? el('div', 'relative', [
                    el('button', 'text-sm', { attrs: moreAttrs(ctrl), class: tabClass(ctrl, t.tab), on: { click: () => void ctrl.toggleMore() } }, t.label),
                    ctrl.moreOpen ? el('div', 'absolute left-0 top-full z-40 mt-3 w-72 overflow-hidden rounded-xl bg-surface shadow-lg ring-1 ring-raised', [moreMenu(ctrl)]) : null,
                  ])
                : el('a', 'text-sm', { attrs: { href: `#/${t.tab}` }, class: tabClass(ctrl, t.tab) }, t.label),
            ),
          )
        : null,
      el('div', 'ml-auto flex items-center gap-3 text-sm text-dim', [
        ctrl.syncing && ctrl.progress?.total
          ? el('a', 'flex items-center gap-2 tabular-nums', { attrs: { href: '#/games' } }, [
              el('span', 'size-2 animate-pulse rounded-full bg-accent'),
              `Analyzing ${ctrl.progress.done} of ${ctrl.progress.total}`,
            ])
          : null,
        ctrl.auth ? el('span', 'hidden sm:inline', ctrl.auth.username) : null,
      ]),
    ]),
  ])
}

function tabBar(ctrl: Ctrl): VNode {
  const TAB = 'flex h-14 flex-col items-center justify-center gap-1 text-xs'
  return el(
    'nav',
    'pb-safe fixed inset-x-0 bottom-0 z-20 border-t border-raised bg-surface sm:hidden',
    [
      el(
        'div',
        'grid grid-cols-3',
        TABS.map(t =>
          t.tab === 'more'
            ? el('button', TAB, { attrs: moreAttrs(ctrl), class: tabClass(ctrl, t.tab), on: { click: () => void ctrl.toggleMore() } }, [icon(t.icon), t.label])
            : el('a', TAB, { attrs: { href: `#/${t.tab}`, 'aria-current': tabOf(ctrl.screen) === t.tab ? 'page' : false }, class: tabClass(ctrl, t.tab) }, [icon(t.icon), t.label]),
        ),
      ),
    ],
  )
}

// What is under the open menu closes it when tapped. On a phone the menu
// is a sheet that rises from the tab bar, which stays in reach above the
// dimmed page.
function moreSheet(ctrl: Ctrl): VNode {
  return el('div', [
    el('div', 'fixed inset-0 z-10 max-sm:bg-black/50', { on: { click: () => ctrl.closeMore() } }),
    el('div', 'bottom-tabbar fixed inset-x-0 z-30 max-h-[80dvh] overflow-y-auto rounded-t-2xl bg-surface shadow-lg sm:hidden', { attrs: { role: 'dialog', 'aria-label': 'More' } }, [moreMenu(ctrl)]),
  ])
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
      n.undo ? el('button', `${btnClass('quiet', 'sm')} text-accent`, { attrs: { type: 'button' }, on: { click: n.undo } }, 'Undo') : null,
      el('button', btnClass('quiet', 'sm'), { attrs: { type: 'button' }, on: { click: () => ctrl.dismissNotice() } }, 'OK'),
    ],
  )
}
