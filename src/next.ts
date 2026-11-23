// The one thing to do next, for Today's big button and the Next button at
// the end of every session. A game left half played comes first, then the
// day's scheduled work (puzzles, then opening cards due, then new opening
// moves), then the latest game's turning points if they haven't been
// replayed, then the open conversion and defense positions. With nothing
// left there is always a game against Maia.

export type Step = 'game' | 'puzzles' | 'reviews' | 'learn' | 'turning' | 'conversion' | 'defense' | 'play'

export interface Due {
  game: boolean // an unfinished game against Maia is saved
  puzzles: number
  reviews: number // opening cards due
  fresh: number // new opening positions offered today
  turning: number // stops in the latest game, 0 once replayed
  conversion: number
  defense: number // 0 while defense is locked
}

export interface Next {
  label: string
  count?: number
  go: Step
}

const ORDER: [Exclude<keyof Due, 'game'>, string][] = [
  ['puzzles', 'Puzzles'],
  ['reviews', 'Openings'],
  ['fresh', 'Learn'],
  ['turning', 'Turning points'],
  ['conversion', 'Conversion'],
  ['defense', 'Defense'],
]

export function nextAction(d: Due): Next {
  if (d.game) return { label: 'Continue game', go: 'game' }
  for (const [key, label] of ORDER) if (d[key] > 0) return { label, count: d[key], go: key === 'fresh' ? 'learn' : key }
  return { label: 'Play Maia', go: 'play' }
}
