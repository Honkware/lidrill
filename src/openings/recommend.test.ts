import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../analysis/engine'
import { db } from '../db'
import { mastersFor, recommend } from './recommend'
import { posKey } from './repertoire'

// The recommended move is the masters' favourite unless Stockfish finds it
// more than PLAYABLE_CP worse than its own move. The engine is scripted
// with an eval per position and always wants to castle.

const at = (ucis: string) => {
  const pos = Chess.default()
  for (const u of ucis.split(' ')) pos.play(parseUci(u)!)
  return makeFen(pos.toSetup())
}

// 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5, White to move
const line = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5'
const moves = line.split(' ')
// Black to move after each White move, so Black's view
const evals: Record<string, number> = {
  [posKey(at(line))]: 40,
  [posKey(at(`${line} c2c3`))]: -10,
  [posKey(at(`${line} d2d3`))]: 0,
}
const engine = {
  search: async (f: string): Promise<SearchResult> => ({ eval: { cp: evals[posKey(f)] }, pv: ['e1g1'], depth: 10, multipv: 1 }),
}

describe('recommend', () => {
  it('takes the most played masters move when it is within 30 cp of Stockfish', async () => {
    expect(await recommend(moves, async () => ({ c2c3: 9000, e1g1: 8000 }), engine)).toBe('c2c3')
  })

  it("takes Stockfish's move, castling as king takes rook, when the masters' move is further off", async () => {
    expect(await recommend(moves, async () => ({ d2d3: 9000, c2c3: 8000 }), engine)).toBe('e1h1')
  })

  it("takes Stockfish's move when signed out", async () => {
    expect(await recommend(moves, undefined, engine)).toBe('e1h1')
  })
})

describe('mastersFor', () => {
  beforeEach(() => db.explorer.clear())

  it('stops asking the explorer after it fails once', async () => {
    let calls = 0
    const fetchFn = (async () => (calls++, new Response('', { status: 429 }))) as typeof fetch
    const masters = mastersFor('tok', fetchFn)
    expect(await recommend(moves, masters, engine)).toBe('e1h1')
    expect(await recommend(moves, masters, engine)).toBe('e1h1')
    expect(calls).toBe(1)
  })

  it('keeps the opening name with the counts', async () => {
    const fetchFn = (async () => Response.json({ moves: [{ uci: 'c2c3', white: 5, draws: 3, black: 2 }], opening: { eco: 'C50', name: 'Italian Game: Giuoco Piano' } })) as typeof fetch
    expect(await mastersFor('tok', fetchFn)!(moves)).toEqual({ c2c3: 10 })
    expect((await db.explorer.get(moves.join(',')))?.opening?.name).toBe('Italian Game: Giuoco Piano')
  })
})
