import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { Rating } from 'ts-fsrs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../analysis/engine'
import { db } from '../db'
import { addCards, dueCards, grade, judgeMove, saveTreeCards } from './cards'
import { posKey } from './repertoire'

// A recall card wants the repertoire move but lets a nearly equal one pass
// as Hard; a gap is judged against Stockfish's best. The engine is scripted
// with an eval per position.

const at = (ucis: string) => {
  const pos = Chess.default()
  for (const u of ucis.split(' ')) pos.play(parseUci(u)!)
  return makeFen(pos.toSetup())
}

// 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5, White to move
const line = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5'
const fen = at(line)
// Evals for the side to move: Black after each White move, White at the start
const evals: Record<string, number> = {
  [posKey(fen)]: 40,
  [posKey(at(`${line} c2c3`))]: -30,
  [posKey(at(`${line} d2d3`))]: -10,
  [posKey(at(`${line} f3g5`))]: 100,
}
const engine = {
  search: async (f: string): Promise<SearchResult> => ({ eval: { cp: evals[posKey(f)] }, pv: ['c2c3'], depth: 10, multipv: 1 }),
}

describe('judgeMove', () => {
  it('grades the repertoire move Good, a move within 30 cp Hard and a worse one Again', async () => {
    expect((await judgeMove(fen, 'c2c3', 'c2c3', engine)).rating).toBe(Rating.Good)
    const near = await judgeMove(fen, 'd2d3', 'c2c3', engine)
    expect(near).toEqual({ rating: Rating.Hard, text: 'd3 is playable, but your repertoire plays c3.' })
    expect((await judgeMove(fen, 'f3g5', 'c2c3', engine)).rating).toBe(Rating.Again)
  })

  it('takes a gap answer within half a pawn of the best and offers it, else offers the best', async () => {
    expect(await judgeMove(fen, 'd2d3', undefined, engine)).toMatchObject({ rating: Rating.Good, offer: 'd2d3' })
    expect(await judgeMove(fen, 'f3g5', undefined, engine)).toEqual({ rating: Rating.Again, text: 'Stockfish prefers c3. Ng5 is 1.4 pawns worse.', offer: 'c2c3' })
  })
})

describe('dueCards', () => {
  beforeEach(() => db.openingCards.clear())

  it('keeps a card per position, its schedule across rebuilds, and puts the likeliest first', async () => {
    const now = new Date('2026-11-01')
    const nodes = [
      { fen, moves: line.split(' '), reach: 0.2 },
      { fen: at(`${line} c2c3 g8f6`), moves: `${line} c2c3 g8f6`.split(' '), reach: 0.5 },
    ]
    await saveTreeCards(nodes, 'Italian Game', new Set(), now)
    for (const c of await db.openingCards.toArray()) await grade(c, Rating.Good, now)
    await db.openingCards.update(posKey(nodes[1].fen), { 'card.due': new Date('2026-12-01') })
    await saveTreeCards(nodes, 'Italian Game', new Set([posKey(fen)]), now)
    await addCards([{ fen, moves: [], opening: 'Italian Game' }], now)
    const later = new Date('2026-11-15')
    const due = await dueCards(['Italian Game'], later)
    expect(due.map(c => [c.id, c.reach, c.wrong])).toEqual([[posKey(fen), 0.2, true]])
    expect(await dueCards(['Ruy Lopez'], later)).toEqual([])
  })

  it('leaves out a position until it has been learned', async () => {
    const now = new Date('2026-11-01')
    await saveTreeCards([{ fen, moves: line.split(' '), reach: 1 }], 'Italian Game', undefined, now)
    expect(await dueCards(['Italian Game'], now)).toEqual([])
    await grade((await db.openingCards.get(posKey(fen)))!, Rating.Good, now)
    expect(await dueCards(['Italian Game'], new Date('2026-11-15'))).toHaveLength(1)
  })
})
