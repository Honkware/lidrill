import { Chess } from 'chessops/chess'
import { parseFen } from 'chessops/fen'
import { describe, expect, it } from 'vitest'
import { parseTyped } from './typed'

describe('parseTyped', () => {
  const start = Chess.default()
  it('reads SAN, sloppy case and UCI', () => {
    expect(parseTyped(start, 'Nf3')).toBe('g1f3')
    expect(parseTyped(start, 'nf3')).toBe('g1f3')
    expect(parseTyped(start, 'e4')).toBe('e2e4')
    expect(parseTyped(start, 'g1f3')).toBe('g1f3')
    expect(parseTyped(start, 'Ke2')).toBeUndefined()
    expect(parseTyped(start, '')).toBeUndefined()
  })
  it('handles castling written with zeros and promotions with check marks', () => {
    const castle = Chess.fromSetup(parseFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1').unwrap()).unwrap()
    expect(parseTyped(castle, '0-0')).toBe('e1h1')
    const promo = Chess.fromSetup(parseFen('8/4P3/8/8/8/8/k7/4K3 w - - 0 1').unwrap()).unwrap()
    expect(parseTyped(promo, 'e8=Q+')).toBe('e7e8q')
  })
})
