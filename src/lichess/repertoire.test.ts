import { describe, expect, it } from 'vitest'
import type { Game } from '../db'
import { pgnMoves } from '../sync/pgn'
import { deviation, followsLines, listStudies, studyCompliance, studyLines } from './repertoire'

// Two chapters as Lichess exports them, plus one set up from a position
const pgn = `[Event "Repertoire: Italian"]
[Site "https://lichess.org/study/abc/ch1"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 *


[Event "Repertoire: vs Sicilian"]

1. e4 c5 2. c3 d5 3. exd5 Qxd5 4. d4 *


[Event "Endgame"]
[FEN "8/8/8/4k3/8/8/4K3/4R3 w - - 0 1"]
[SetUp "1"]

1. Re4+ *`

const game = (pgnText: string, playedAt = 0) => ({ moves: pgnMoves(pgnText)!, playedAt }) as Game

describe('study repertoire', () => {
  const lines = studyLines(pgn)

  it('takes each chapter mainline from the start position', () => {
    expect(lines.length).toBe(2)
    expect(lines[0].slice(0, 3)).toEqual(['e2e4', 'e7e5', 'g1f3'])
  })

  it('counts a game that stays on a line for four moves', () => {
    expect(followsLines(game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4'), lines)).toBe(true)
    expect(followsLines(game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 d6'), lines)).toBe(false)
    expect(followsLines(game('1. e4 e5 2. Nf3 Nc6 3. Bb5'), lines)).toBe(false)
    expect(studyCompliance([game('1. e4 c5 2. c3 d5 3. exd5 Qxd5 4. d4 Nc6', 2), game('1. d4 d5', 1)], lines)).toBe(0.5)
  })

  it('lists studies from the ndjson endpoint with the token', async () => {
    let auth = ''
    const fetchFn = (async (_: string, init?: RequestInit) => {
      auth = new Headers(init?.headers).get('Authorization') ?? ''
      return new Response('{"id":"abc","name":"Repertoire","createdAt":1}\n{"id":"def","name":"Endgames","createdAt":2}\n')
    }) as typeof fetch
    expect(await listStudies('someone', 'lio_x', fetchFn)).toEqual([
      { id: 'abc', name: 'Repertoire' },
      { id: 'def', name: 'Endgames' },
    ])
    expect(auth).toBe('Bearer lio_x')
  })
})

describe('deviation', () => {
  const lines = studyLines(pgn)
  it('finds the first move off the closest line and who played it', () => {
    const mine = { ...game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3'), color: 'white' } as Game
    expect(deviation(mine, lines)).toEqual({ ply: 7, expected: 'c2c3', byPlayer: true })
    const theirs = { ...game('1. e4 e5 2. Nf3 d6'), color: 'white' } as Game
    expect(deviation(theirs, lines)).toEqual({ ply: 4, expected: 'b8c6', byPlayer: false })
    expect(deviation({ ...game('1. d4 d5'), color: 'white' } as Game, lines)).toBeUndefined()
  })
})
