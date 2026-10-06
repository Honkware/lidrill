import { describe, expect, it } from 'vitest'
import type { Eval, Game, JournalEntry } from './db'
import { hangOf, openingTable, streak, swings } from './metrics'
import { pgnMoves } from './sync/pgn'

// evals[i] is the eval after move i, white's view
function game(pgn: string, evals: (number | undefined)[], extra: Partial<Game> = {}): Game {
  const moves = pgnMoves(pgn)!.map((m, i) => ({ ...m, eval: evals[i] === undefined ? undefined : ({ cp: evals[i] } as Eval) }))
  return {
    id: 'lichess:x',
    site: 'lichess',
    url: '',
    pgn,
    color: 'white',
    result: 'loss',
    rating: 900,
    speed: 'rapid',
    eco: 'C50',
    opening: 'Italian Game: Giuoco Piano',
    playedAt: 1,
    moves,
    termination: 'resign',
    analyzedAt: 1,
    ...extra,
  }
}

// 5.Ng5?? lets ...Qxg5 take the knight for free
const hung = game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. Ng5 Qxg5 6. Bxg5', [30, 30, 30, 30, 30, 30, 30, 30, -290, -300, -280])

describe('hangs', () => {
  it('measures the swing and the material it cost', () => {
    const s = swings(hung).find(x => x.ply === 9)!
    expect(s.swingCp).toBe(320)
    expect(s.san).toBe('Ng5')
  })

  it('applies the band definitions', () => {
    expect(hangOf(hung, 'beginner')?.san).toBe('Ng5')
    // the queen recaptures nothing back: the knight is just gone
    expect(hangOf(game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. Ng5 Qxg5', [30, 30, 30, 30, 30, 30, 30, 30, -290, -300]), 'club')?.san).toBe('Ng5')
    expect(hangOf(hung, 'advanced', 1000)).toBeUndefined()
    expect(hangOf(hung, 'advanced', 200)?.san).toBe('Ng5')
  })
})

describe('streak', () => {
  const e = (at: number, hang: boolean): JournalEntry => ({
    gameId: `g${at}`,
    at,
    opening: '',
    hung: hang ? { ply: 9, san: 'Ng5', swingCp: 320 } : undefined,
    confirmed: false,
  })
  it('counts zero-hang games since the last hang', () => {
    expect(streak([e(1, false), e(2, false), e(3, true), e(4, false), e(5, false), e(6, false)])).toEqual({
      current: 3,
      best: 3,
      lastHang: { gameId: 'g3', ply: 9 },
    })
    expect(streak([e(1, false), e(2, false), e(3, true)]).best).toBe(2)
  })
})

describe('openingTable', () => {
  it('groups by family', () => {
    const rows = openingTable([hung, { ...hung, result: 'win', opening: 'Italian Game: Two Knights Defense' }])
    expect(rows).toEqual([{ family: 'Italian Game', games: 2, win: 1, draw: 0, loss: 1, avgWorstCp: 320 }])
  })
})
