import { describe, expect, it } from 'vitest'
import { linkSegments } from './explainLinks'

const known = new Map([
  ['Bxf7', { from: 'c4', to: 'f7' }],
  ['Nd5', { from: 'c3', to: 'd5' }],
])

describe('linkSegments', () => {
  it('links known moves with their squares and other moves or squares by destination', () => {
    const s = linkSegments('Bxf7+ forces Ke7, then 7. Nd5# mates; the e4 pawn is loose.', known)
    expect(s.filter(x => x.target)).toEqual([
      { text: 'Bxf7+', target: { from: 'c4', to: 'f7' } },
      { text: 'Ke7', target: { to: 'e7' } },
      { text: '7. Nd5#', target: { from: 'c3', to: 'd5' } },
      { text: 'e4', target: { to: 'e4' } },
    ])
    expect(s.map(x => x.text).join('')).toBe('Bxf7+ forces Ke7, then 7. Nd5# mates; the e4 pawn is loose.')
  })

  it('leaves ordinary words, files and numbers alone', () => {
    const s = linkSegments('Open the f-file in 2 moves; a pawn, B3 and h9 are not squares.', known)
    expect(s.filter(x => x.target)).toEqual([])
  })

  it('handles promotions, captures and black move numbers', () => {
    const s = linkSegments('After 10...exd5 the b8=Q push wins.', new Map())
    expect(s.filter(x => x.target).map(x => [x.text, x.target!.to])).toEqual([
      ['10...exd5', 'd5'],
      ['b8=Q', 'b8'],
    ])
  })
})
