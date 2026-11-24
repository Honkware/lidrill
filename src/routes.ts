// The screens, and which of them a bare name in the URL hash opens. Board
// screens take an argument (#/game/<id>) and are opened in ctrl.ts.

export type Screen =
  | 'welcome'
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

const PAGES: Screen[] = ['train', 'play', 'games', 'settings', 'precision', 'openings', 'conversion', 'defense']

// Pages that were renamed or merged, so old bookmarks still land. Today is
// Train with the day's overview kept open (#/train/day); the tiles that
// were on Train are the More menu.
const MOVED = { review: 'games', drills: 'train', today: 'train/day' } as const

export type Moved = keyof typeof MOVED

export const movedTo = (name: string): string | undefined => (Object.hasOwn(MOVED, name) ? MOVED[name as Moved] : undefined)

export const pageOf = (name: string): Screen => (PAGES.includes(name as Screen) ? (name as Screen) : 'train')

export type Tab = 'train' | 'openings' | 'more'

const OPENINGS: Screen[] = ['openings', 'opening', 'learn', 'spar']

// The tab lit for a screen: Train for the day's puzzles, Openings for the
// opening trainer, and More for everything its menu leads to
export function tabOf(s: Screen): Tab | undefined {
  if (s === 'welcome') return undefined
  if (s === 'train' || s === 'drill') return 'train'
  return OPENINGS.includes(s) ? 'openings' : 'more'
}
