import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Game, type Puzzle } from './db'
import { Drill, type Outcome } from './drill'
import type { TimeProfile } from './time'
import { Countdown, limitFor, thinkFor, timedSet } from './timed'

// The countdown on the player's own puzzles: its length from the time
// profile, and a time-out that ends the puzzle without touching its schedule

// Legal's mate: 6. Bxf7+ Ke7 7. Nd5#
const legal: Puzzle = {
  id: 'p:legal', gameId: 'lichess:g', ply: 11, fen: 'rn1qkbnr/ppp2pp1/3p3p/4N3/2B1P3/2N5/PPPP1PPP/R1BbK2R w KQkq - 0 6',
  played: 'e1d1', solution: ['c4f7', 'e8e7', 'c3d5'], solutionLen: 2, type: 'missed-win', tag: 'mate', swingCp: 900, card: createEmptyCard(new Date(1000)),
}

const pace = { fast: { moves: 0, errors: 0 }, normal: { moves: 0, errors: 0 }, slow: { moves: 0, errors: 0 } }
const blitz: TimeProfile = { speed: 'blitz', games: 20, think: 3.4, trouble: 0, lostOnTime: 0, pace }
const rapid: TimeProfile = { speed: 'rapid', games: 8, think: 14.6, trouble: 0, lostOnTime: 0, pace }
const at = (site: Game['site'], speed: string) => ({ site, speed }) as Game

describe('the countdown length', () => {
  it('rounds the think time and holds it between 5 and 60 s for each move', () => {
    expect(limitFor(14.6, 1)).toBe(15)
    expect(limitFor(3.4, 2)).toBe(10)
    expect(limitFor(95, 1)).toBe(60)
  })

  it('takes the think time from the speed of the puzzle game, else the main speed', () => {
    expect(thinkFor([blitz, rapid], at('chesscom', 'rapid'))).toBe(14.6)
    expect(thinkFor([blitz, rapid], at('maia', '10+5'))).toBe(14.6)
    expect(thinkFor([blitz, rapid], at('lichess', 'bullet'))).toBe(3.4)
    expect(thinkFor([blitz, rapid], at('maia', 'untimed'))).toBe(3.4)
  })

  it('picks own puzzles due soonest and leaves Lichess puzzles out', () => {
    const later = { ...legal, id: 'p:later', solutionLen: 1, card: createEmptyCard(new Date(5000)) }
    const lichess = { ...legal, id: 'lichess:x', source: 'lichess' as const, card: createEmptyCard(new Date(0)) }
    const games = new Map([['lichess:g', at('lichess', 'rapid')]])
    expect(timedSet([later, lichess, legal], games, [blitz, rapid], 12)).toEqual([
      { id: 'p:legal', limit: 30 },
      { id: 'p:later', limit: 15 },
    ])
  })
})

describe('a puzzle against the countdown', () => {
  let outcomes: Outcome[]

  beforeEach(async () => {
    outcomes = []
    await db.reviews.clear()
    await db.puzzles.put(legal)
    // IndexedDB (fake-indexeddb) keeps the real setTimeout
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => vi.useRealTimers())

  const start = () => {
    const d = new Drill(legal, () => {}, { record: false, onFinish: o => outcomes.push(o) })
    let outs = 0
    const c = new Countdown(5, d, () => {}, () => outs++)
    return { d, c, outs: () => outs }
  }

  it('shows the solution at zero and counts it as a miss', async () => {
    const { d, c, outs } = start()
    await vi.waitFor(() => expect(d.yourTurn).toBe(true))
    vi.advanceTimersByTime(4900)
    expect(d.state).toBe('playing')
    vi.advanceTimersByTime(300)
    expect([c.out, outs(), d.state]).toEqual([true, 1, 'view'])
    await vi.waitFor(() => expect(outcomes).toEqual(['shown']))
  })

  it('leaves the schedule and the review history as they were', async () => {
    const { d } = start()
    await vi.waitFor(() => expect(d.yourTurn).toBe(true))
    vi.advanceTimersByTime(6000)
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect((await db.puzzles.get(legal.id))!.card.reps).toBe(0)
    expect(await db.reviews.count()).toBe(0)
  })

  it('stops once the puzzle is solved', async () => {
    const { d, c } = start()
    await vi.waitFor(() => expect(d.yourTurn).toBe(true))
    d.move('c4', 'f7')
    await vi.waitFor(() => expect(d.yourTurn).toBe(true))
    d.move('c3', 'd5')
    vi.advanceTimersByTime(6000)
    await vi.waitFor(() => expect(outcomes).toEqual(['clean']))
    expect(c.out).toBe(false)
  })
})
