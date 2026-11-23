import { describe, expect, it } from 'vitest'
import { movedTo, pageOf } from './routes'

// Where a bare name in the URL hash lands, old bookmarks included.

describe('routes', () => {
  it('sends the old Review page to Games', () => {
    expect(movedTo('review')).toBe('games')
  })

  it('leaves current pages and unknown names alone', () => {
    expect(['games', 'today', 'toString', ''].map(movedTo)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('opens a known page by name and anything else on Today', () => {
    expect(['games', 'settings', 'openings', 'nowhere', ''].map(pageOf)).toEqual(['games', 'settings', 'openings', 'today', 'today'])
  })
})
