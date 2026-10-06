import { describe, expect, it } from 'vitest'
import { linkSegments } from './explainLinks'

const text = 'Bxf7+ forces Ke7, then Nd5# mates; the e4 pawn stays.'
const links = [
  { index: 0, text: 'Bxf7+', from: 'c4', to: 'f7', fen: 'x', after: 'y' },
  { index: 23, text: 'Nd5#', from: 'c3', to: 'd5', fen: 'y', after: 'z' },
  { index: 39, text: 'e4', to: 'e4' },
]

describe('linkSegments', () => {
  it('links what the server placed, by position, and keeps the text intact', () => {
    const s = linkSegments(text, links)
    expect(s.filter(x => x.target).map(x => x.text)).toEqual(['Bxf7+', 'Nd5#', 'e4'])
    expect(s.map(x => x.text).join('')).toBe(text)
  })

  it('drops links that no longer match the text', () => {
    expect(linkSegments('Something else entirely here, longer than before ok.', links).some(x => x.target)).toBe(false)
  })
})
