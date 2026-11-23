import { Chess } from 'chessops/chess'
import { makeFen } from 'chessops/fen'
import { parseUci } from 'chessops/util'
import { Rating } from 'ts-fsrs'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SearchResult } from '../analysis/engine'
import { db } from '../db'
import { addCards, dueCards, grade, judgeMove, learnCard, NEW_PER_DAY, openingsDue, saveTreeCards } from './cards'
import { posKey } from './repertoire'

// Review wants the repertoire move but lets a nearly equal one pass as
// Hard. The engine is scripted with an eval per position.

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
    expect(await judgeMove(fen, 'c2c3', 'c2c3', engine)).toEqual({ rating: Rating.Good })
    expect(await judgeMove(fen, 'd2d3', 'c2c3', engine)).toEqual({ rating: Rating.Hard, offer: 'd2d3' })
    expect(await judgeMove(fen, 'f3g5', 'c2c3', engine)).toEqual({ rating: Rating.Again })
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

describe('openingsDue', () => {
  const now = new Date('2026-11-20T18:00')
  // Positions by their card id; only the cards matter here
  const nodes = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ fen: `${tag}${i} w - - 0 1`, moves: [], reach: 0.1 }))
  const learn = async (ids: string[], when: Date) => {
    for (const id of ids) await learnCard((await db.openingCards.get(id))!, when)
  }

  beforeEach(async () => {
    await db.openingCards.clear()
    await db.profile.put({ id: 'me', openings: [{ name: 'Italian Game', color: 'white', moves: [] }] } as never)
  })

  it('offers at most the daily limit of new positions, however large the tree', async () => {
    await saveTreeCards(nodes(694, 'a'), 'Italian Game', undefined, now)
    expect(await openingsDue(now)).toEqual({ due: 0, fresh: NEW_PER_DAY })
  })

  it('counts positions learned today in any opening against the limit, and none from yesterday', async () => {
    await saveTreeCards(nodes(20, 'a'), 'Italian Game', undefined, now)
    await saveTreeCards(nodes(20, 'b'), 'Ruy Lopez', undefined, now)
    await learn(['a0 w - -', 'b0 w - -', 'b1 w - -'], new Date('2026-11-20T09:00'))
    await learn(['b2 w - -'], new Date('2026-11-19T23:00'))
    expect((await openingsDue(now)).fresh).toBe(NEW_PER_DAY - 3)
  })

  it('offers only what is left to learn, and leaves out positions no tree reaches', async () => {
    await saveTreeCards(nodes(2, 'a'), 'Italian Game', undefined, now)
    await addCards([{ fen: 'g0 w - - 0 1', moves: [], opening: 'Italian Game' }], now)
    expect((await openingsDue(now)).fresh).toBe(2)
  })

  it('counts learned cards that are due, in the chosen openings only', async () => {
    await saveTreeCards(nodes(3, 'a'), 'Italian Game', undefined, now)
    await saveTreeCards(nodes(1, 'b'), 'Ruy Lopez', undefined, now)
    const before = new Date('2026-11-01')
    await learn(['a0 w - -', 'a1 w - -', 'b0 w - -'], before)
    expect(await openingsDue(now)).toEqual({ due: 2, fresh: 1 })
  })
})
