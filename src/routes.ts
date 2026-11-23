// The screens, and which of them a bare name in the URL hash opens. Board
// screens take an argument (#/game/<id>) and are opened in ctrl.ts.

export type Screen = 'welcome' | 'today' | 'drill' | 'replay' | 'game' | 'games' | 'drills' | 'practice' | 'play' | 'settings' | 'precision' | 'opening' | 'learn' | 'spar' | 'openings'

const PAGES: Screen[] = ['today', 'games', 'drills', 'settings', 'precision', 'openings']

// Pages that were renamed, so old bookmarks still land
const MOVED = { review: 'games' } as const satisfies Record<string, Screen>

export type Moved = keyof typeof MOVED

export const movedTo = (name: string): Screen | undefined => (Object.hasOwn(MOVED, name) ? MOVED[name as Moved] : undefined)

export const pageOf = (name: string): Screen => (PAGES.includes(name as Screen) ? (name as Screen) : 'today')
