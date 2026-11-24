import { describe, expect, it } from 'vitest'
import { movedTo, pageOf, tabOf, type Screen } from './routes'

// Where a bare name in the URL hash lands, old bookmarks included, and
// which of the three tabs each screen lights.

describe('routes', () => {
  it('sends the old Review page to Games, Drills to Train and Today to the overview on Train', () => {
    expect([movedTo('review'), movedTo('drills'), movedTo('today')]).toEqual(['games', 'train', 'train/day'])
  })

  it('leaves current pages and unknown names alone', () => {
    expect(['games', 'train', 'play', 'toString', ''].map(movedTo)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('opens a known page by name and anything else on Train', () => {
    expect(['train', 'play', 'games', 'settings', 'precision', 'openings', 'conversion', 'defense', 'nowhere', ''].map(pageOf)).toEqual([
      'train', 'play', 'games', 'settings', 'precision', 'openings', 'conversion', 'defense', 'train', 'train',
    ])
  })

  it('never redirects to a name that redirects again or opens nothing', () => {
    for (const name of ['review', 'drills', 'today']) {
      const to = movedTo(name)!.split('/')[0]
      expect(movedTo(to)).toBeUndefined()
      expect(pageOf(to)).toBe(to)
    }
  })
})

describe('tabOf', () => {
  it('lights Train for the day and its puzzles', () => {
    expect([tabOf('train'), tabOf('drill')]).toEqual(['train', 'train'])
  })

  it('lights Openings for the page and its three board screens', () => {
    expect((['openings', 'opening', 'learn', 'spar'] as Screen[]).map(tabOf)).toEqual(Array(4).fill('openings'))
  })

  it('lights More for every screen its menu leads to', () => {
    const more: Screen[] = ['replay', 'play', 'maia', 'conversion', 'defense', 'practice', 'games', 'game', 'settings', 'precision']
    expect(more.map(tabOf)).toEqual(Array(more.length).fill('more'))
  })

  it('lights no tab before sign-in', () => {
    expect(tabOf('welcome')).toBeUndefined()
  })
})
