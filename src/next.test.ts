import { describe, expect, it } from 'vitest'
import { nextAction, type Due } from './next'

// The order Today and the session ends offer things in, and that there is
// always something to press.

const none: Due = { game: false, puzzles: 0, reviews: 0, fresh: 0, turning: 0, conversion: 0, defense: 0 }
const all: Due = { game: true, puzzles: 12, reviews: 5, fresh: 3, turning: 2, conversion: 4, defense: 1 }

describe('nextAction', () => {
  it('continues an unfinished game before anything else', () => {
    expect(nextAction(all)).toEqual({ label: 'Continue game', go: 'game' })
  })

  it('takes puzzles, opening reviews, new moves, turning points, conversion and defense in that order', () => {
    const steps = []
    let d = { ...all, game: false }
    for (const key of ['puzzles', 'reviews', 'fresh', 'turning', 'conversion', 'defense'] as const) {
      steps.push(nextAction(d))
      d = { ...d, [key]: 0 }
    }
    expect(steps).toEqual([
      { label: 'Puzzles', count: 12, go: 'puzzles' },
      { label: 'Openings', count: 5, go: 'reviews' },
      { label: 'Learn', count: 3, go: 'learn' },
      { label: 'Turning points', count: 2, go: 'turning' },
      { label: 'Conversion', count: 4, go: 'conversion' },
      { label: 'Defense', count: 1, go: 'defense' },
    ])
  })

  it('offers a game against Maia when nothing is due', () => {
    expect(nextAction(none)).toEqual({ label: 'Play Maia', go: 'play' })
  })
})
