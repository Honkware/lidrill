import { beforeEach, describe, expect, it } from 'vitest'
import { db, type Game } from '../db'
import { pgnMoves } from '../sync/pgn'
import { bookFor, bookLength, FALLBACK_BOOK_PLIES } from './book'

// Masters counts for the lines below, trimmed from real explorer answers
const masters: Record<string, Record<string, number>> = {
  '': { e2e4: 1200000, d2d4: 1000000 },
  e2e4: { e7e5: 300000, c7c5: 500000 },
  'e2e4,e7e5': { g1f3: 250000, d1h5: 40 },
  'e2e4,e7e5,d1h5': { b8c6: 25, g7g6: 3 },
  'e2e4,e7e5,d1h5,b8c6': { f1c4: 15 },
  'e2e4,e7e5,d1h5,b8c6,f1c4': { g7g6: 9, d8e7: 4 },
}

beforeEach(() => db.explorer.clear())

describe('bookLength', () => {
  const calls: string[] = []
  const fetchFn = (async (url: string) => {
    const play = new URL(url).searchParams.get('play') ?? ''
    calls.push(play)
    const moves = Object.entries(masters[play] ?? {}).map(([uci, n]) => ({ uci, white: n, draws: 0, black: 0 }))
    return Response.json({ moves })
  }) as typeof fetch

  it('stops at the first move masters rarely played', async () => {
    // 4...Nf6?? is the Scholar's Mate blunder: never book
    const moves = pgnMoves('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#')!
    expect(await bookLength(moves, 'tok', fetchFn)).toBe(5)
  })

  it('gives a game against Maia no book when signed out, and the explorer book when signed in', async () => {
    const moves = pgnMoves('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#')!
    const game = (site: Game['site']) => ({ site, moves }) as Game
    expect(await bookFor()(game('maia'))).toBe(0)
    expect(await bookFor()(game('lichess'))).toBe(FALLBACK_BOOK_PLIES)
    expect(await bookFor('tok', fetchFn)(game('maia'))).toBe(5)
  })

  it('answers repeats from the cache', async () => {
    const moves = pgnMoves('1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#')!
    await bookLength(moves, 'tok', fetchFn)
    calls.length = 0
    await bookLength(moves, 'tok', fetchFn)
    expect(calls).toEqual([])
  })
})
