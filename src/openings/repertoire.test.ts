import { Chess } from 'chessops/chess'
import { parseUci } from 'chessops/util'
import { describe, expect, it } from 'vitest'
import type { Game, Opening } from '../db'
import { pgnMoves } from '../sync/pgn'
import { keyOf, repertoireMoves, sharedLine } from './repertoire'

// The repertoire is one move per position on the player's side, whichever
// move order reached it, with a study beating the other sources

const game = (pgn: string, extra: Partial<Game> = {}): Game => ({
  id: `lichess:${pgn.length}`,
  site: 'lichess',
  url: '',
  pgn,
  color: 'white',
  result: 'win',
  rating: 1500,
  speed: 'rapid',
  eco: '',
  opening: 'Italian Game',
  playedAt: 1,
  moves: pgnMoves(pgn)!,
  termination: '',
  ...extra,
})

const italian: Opening = { name: 'Italian Game', color: 'white', moves: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4'] }

const after = (ucis: string[]) => {
  const pos = Chess.default()
  for (const u of ucis) pos.play(parseUci(u)!)
  return keyOf(pos)
}

describe('repertoireMoves', () => {
  it('stores a position reached by two move orders once', () => {
    // 1. Nf3 d5 2. d4 Nf6 and 1. d4 d5 2. Nf3 Nf6 reach one position with
    // different halfmove clocks
    const a: Opening = { name: 'A', color: 'white', moves: ['g1f3', 'd7d5', 'd2d4', 'g8f6', 'c2c4'] }
    const b: Opening = { name: 'B', color: 'white', moves: ['d2d4', 'd7d5', 'g1f3', 'g8f6', 'c2c4'] }
    const moves = repertoireMoves([a, b], [], [], [])
    const shared = after(['g1f3', 'd7d5', 'd2d4', 'g8f6'])
    expect(after(['d2d4', 'd7d5', 'g1f3', 'g8f6'])).toBe(shared)
    expect(moves.filter(m => m.fen === shared)).toEqual([{ fen: shared, uci: 'c2c4', source: 'builtin' }])
    // the start, after 1. Nf3 d5, after 1. d4 d5, and the shared position
    expect(moves).toHaveLength(4)
  })

  it('takes a move played twice in games, and a study move over it', () => {
    const twice = [game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6'), game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6')]
    const at = after(['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5'])
    expect(repertoireMoves([italian], [], twice, []).find(m => m.fen === at)).toEqual({ fen: at, uci: 'd2d3', source: 'games' })
    const study = [['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'f8c5', 'c2c3']]
    expect(repertoireMoves([italian], study, twice, []).find(m => m.fen === at)).toEqual({ fen: at, uci: 'c2c3', source: 'study' })
  })

  it('leaves out a game move played once or judged a mistake, and a study line for another opening', () => {
    const once = [game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6')]
    const judged = [0, 1].map(() => game('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 Nf6'))
    judged.forEach(g => (g.moves[6] = { ...g.moves[6], judg: 'inaccuracy' }))
    const ruy = [['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5', 'a7a6']]
    expect(repertoireMoves([italian], ruy, once, [])).toHaveLength(3)
    expect(repertoireMoves([italian], [], judged, [])).toHaveLength(3)
  })
})

describe('sharedLine', () => {
  it('follows the moves at least half the games agree on', () => {
    const games = ['1. e4 c5 2. Nf3 d6', '1. e4 c5 2. Nf3 Nc6', '1. e4 c5 2. c3 d5'].map(p => game(p, { color: 'black' }))
    expect(sharedLine(games)).toEqual(['e2e4', 'c7c5', 'g1f3'])
  })
})
