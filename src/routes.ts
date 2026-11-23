// The screens, and which of them a bare name in the URL hash opens. Board
// screens take an argument (#/game/<id>) and are opened in ctrl.ts.

export type Screen =
  | 'welcome'
  | 'today'
  | 'train'
  | 'play'
  | 'games'
  | 'settings'
  | 'precision'
  | 'openings'
  | 'conversion'
  | 'defense'
  | 'drill'
  | 'practice'
  | 'opening'
  | 'learn'
  | 'spar'
  | 'maia'
  | 'game'
  | 'replay'

const PAGES: Screen[] = ['today', 'train', 'play', 'games', 'settings', 'precision', 'openings', 'conversion', 'defense']

// Pages that were renamed or merged, so old bookmarks still land
const MOVED = { review: 'games', drills: 'train' } as const satisfies Record<string, Screen>

export type Moved = keyof typeof MOVED

export const movedTo = (name: string): Screen | undefined => (Object.hasOwn(MOVED, name) ? MOVED[name as Moved] : undefined)

export const pageOf = (name: string): Screen => (PAGES.includes(name as Screen) ? (name as Screen) : 'today')

const TRAIN: Screen[] = ['drill', 'practice', 'conversion', 'defense', 'openings', 'opening', 'learn', 'spar']

// The tab lit for a screen. Settings and the release gate under it light
// none, since they are behind the gear.
export function tabOf(s: Screen): Screen | undefined {
  if (s === 'game' || s === 'replay') return 'games'
  if (s === 'maia') return 'play'
  if (TRAIN.includes(s)) return 'train'
  return s === 'today' || s === 'train' || s === 'play' || s === 'games' ? s : undefined
}
