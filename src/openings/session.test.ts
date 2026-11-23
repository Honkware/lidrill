import { createEmptyCard, Rating } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchResult } from '../analysis/engine'
import { db, type OpeningCard } from '../db'
import { keyOf, posKey } from './repertoire'
import { OpeningSession, replay, reviewLines } from './session'

// Review plays due positions as lines from move 1. In the Giuoco Piano
// (1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5) White's repertoire is 4. c3, then
// 5. d3 after 4...Nf6 and 5. d4 after 4...d6; 4. b4 is a line of its own.

const gp = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5'
const card = (ucis: string): OpeningCard => {
  const moves = ucis.split(' ')
  return { id: keyOf(replay(moves)), opening: 'Italian Game', moves, reach: 0.5, card: createEmptyCard(new Date('2026-11-01')) }
}
const a = card(gp)
const b = card(`${gp} c2c3 g8f6`)
const c = card(`${gp} c2c3 d7d6`)
const d = card(`${gp} b2b4 c5b4`)
const rep = new Map([
  [a.id, 'c2c3'],
  [b.id, 'd2d3'],
  [c.id, 'd2d4'],
  [d.id, 'c2c3'],
])

describe('reviewLines', () => {
  it('asks every due position a line passes with its repertoire move, once, in the order of the likeliest card', () => {
    const lines = reviewLines([c, a, b, d], rep)
    expect(lines.map(l => l.asks)).toEqual([[a.id, c.id], [b.id], [d.id]])
    expect(lines[0].moves.join(' ')).toBe(`${gp} c2c3 d7d6 d2d4`)
  })

  it('keeps a position on its own line when the line through it plays another move there', () => {
    expect(reviewLines([a, d], rep).map(l => l.asks)).toEqual([[a.id], [d.id]])
  })
})

describe('OpeningSession', () => {
  // At b the repertoire move keeps the eval and anything else gives Black two pawns
  const kept = keyOf(replay([...b.moves, 'd2d3']))
  const engine = {
    search: async (fen: string): Promise<SearchResult> => ({ eval: { cp: posKey(fen) === kept ? 0 : 200 }, pv: [], depth: 10, multipv: 1 }),
  }

  beforeEach(async () => {
    await db.openingCards.clear()
    await db.openingCards.bulkPut([a, b])
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => vi.useRealTimers())

  it('plays the moves before a due position itself and grades each due position by how it was found', async () => {
    const s = new OpeningSession([a, b], rep, engine, () => {})
    s.begin()
    await vi.advanceTimersByTimeAsync(300 * 6)
    expect([s.play.state, s.play.ply]).toEqual(['your-move', 6])
    await s.play.move('c2c3')
    await vi.advanceTimersByTimeAsync(300)
    await s.play.move('h2h3')
    expect([s.play.state, s.play.tried]).toEqual(['your-move', 'h3'])
    await s.play.move('d2d3')
    expect(s.state).toBe('line-done')
    expect([...s.grades.values()]).toEqual([Rating.Good, Rating.Hard])
    expect((await db.openingCards.get(b.id))!.card.reps).toBe(1)
    s.nextLine()
    expect(s.state).toBe('done')
  })
})
