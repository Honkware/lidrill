import { describe, expect, it } from 'vitest'
import { lineNotes } from './notes'

// The notes under a learn line say only what the board shows: each case is
// a line of the Italian Game whose last move has a known fact

const last = (ucis: string) => lineNotes(ucis.split(' ')).at(-1)
const giuoco = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 c2c3 g8f6'

describe('lineNotes', () => {
  it('describes the first moves of the Italian Game for both sides', () => {
    expect(lineNotes('e2e4 e7e5 g1f3 b8c6 f1c4'.split(' '))).toEqual([
      'Puts a pawn in the centre and opens lines for the bishop and queen.',
      'Puts a pawn in the centre and opens lines for the bishop and queen.',
      'Develops the knight and attacks the pawn on e5.',
      'Develops the knight and defends the pawn on e5.',
      'Develops the bishop and aims at f7, next to the king.',
    ])
  })

  it('names the piece a pawn attacks and a capture that takes back', () => {
    expect(last(`${giuoco} d2d4`)).toBe('Puts a pawn in the centre and attacks the bishop on c5.')
    expect(last(`${giuoco} d2d4 e5d4`)).toBe('Takes the pawn on d4 and half-opens the e-file.')
    expect(last(`${giuoco} d2d4 e5d4 c3d4`)).toBe('Takes back on d4 and attacks the bishop on c5.')
  })

  it('finds a pin, a double attack and a mate threat', () => {
    expect(last(`${giuoco} d2d3 d7d6 c1g5`)).toBe('Develops the bishop and pins the knight on f6 to the queen on d8.')
    expect(last('e2e4 e7e5 g1f3 b8c6 f1c4 g8f6 f3g5 d7d5 e4d5 f6d5 g5f7')).toBe('Takes the pawn on f7 and attacks the queen on d8 and the rook on h8 at once.')
    expect(last('e2e4 e7e5 f1c4 b8c6 d1h5')).toBe('Threatens mate on f7.')
  })

  it('says castles, and gives no note to a move with nothing notable', () => {
    expect(last(`${giuoco} d2d3 d7d6 e1h1`)).toBe('Castles kingside.')
    expect(last(`${giuoco} d2d3 d7d6 e1h1 a7a6`)).toBeUndefined()
    expect(last(`${giuoco} d2d3 d7d6 e1h1 a7a6 a2a4 e8h8 f1e1`)).toBeUndefined()
  })
})
