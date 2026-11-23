import { describe, expect, it } from 'vitest'
import { movedTo, pageOf, tabOf, type Screen } from './routes'

// Where a bare name in the URL hash lands, old bookmarks included, and
// which of the four tabs each screen lights.

describe('routes', () => {
  it('sends the old Review page to Games and Drills to Train', () => {
    expect([movedTo('review'), movedTo('drills')]).toEqual(['games', 'train'])
  })

  it('leaves current pages and unknown names alone', () => {
    expect(['games', 'train', 'play', 'toString', ''].map(movedTo)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('opens a known page by name and anything else on Today', () => {
    expect(['train', 'play', 'games', 'settings', 'openings', 'conversion', 'defense', 'nowhere', ''].map(pageOf)).toEqual([
      'train', 'play', 'games', 'settings', 'openings', 'conversion', 'defense', 'today', 'today',
    ])
  })
})

describe('tabOf', () => {
  it('lights Train for every training screen, Play for the game and Games for review', () => {
    expect((['drill', 'practice', 'defense', 'openings', 'learn', 'spar'] as Screen[]).map(tabOf)).toEqual(Array(6).fill('train'))
    expect([tabOf('maia'), tabOf('game'), tabOf('replay')]).toEqual(['play', 'games', 'games'])
  })

  it('lights no tab for Settings and the release gate', () => {
    expect([tabOf('settings'), tabOf('precision'), tabOf('today')]).toEqual([undefined, undefined, 'today'])
  })
})
