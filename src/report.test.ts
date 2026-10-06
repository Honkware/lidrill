import { describe, expect, it } from 'vitest'
import type { Game, JournalEntry, Profile, Review } from './db'
import { calibrate, heldLead, recurringLeak, weeklyZeroHang } from './report'
import { pgnMoves } from './sync/pgn'

const now = new Date('2026-10-06T12:00:00Z')
const DAY = 24 * 3600e3

const game = (id: string, pgn: string, extra: Partial<Game> = {}): Game => ({
  id,
  site: 'lichess',
  url: '',
  pgn,
  color: 'white',
  result: 'loss',
  rating: 900,
  speed: 'rapid',
  eco: '',
  opening: '',
  playedAt: +now - DAY,
  moves: pgnMoves(pgn)!,
  termination: 'resign',
  analyzedAt: 1,
  ...extra,
})

describe('recurringLeak', () => {
  // three games flagged with a queen hang at ply 5
  const pgn = '1. e4 e5 2. Nc3 Nc6 3. Qh5'
  const games = ['a', 'b', 'c'].map(id => game(id, pgn))
  const entry = (id: string, at = +now - DAY): JournalEntry => ({ gameId: id, at, opening: '', hung: { ply: 5, san: 'Qh5', swingCp: 400 }, confirmed: false })

  it('groups hangs by the piece that moved', () => {
    expect(recurringLeak(games, games.map(g => entry(g.id)), now)).toEqual({ role: 'queen', count: 3, file: 'h' })
  })

  it('needs three within 90 days', () => {
    expect(recurringLeak(games, [entry('a'), entry('b'), entry('c', +now - 100 * DAY)], now)).toBeUndefined()
  })
})

describe('calibrate', () => {
  const profile: Profile = { id: 'me', band: 'club', bandHistory: [], swingThresholdCp: 150, marginCp: 100 }
  const reviews = (solved: number, total: number): Review[] =>
    Array.from({ length: total }, (_, i) => ({ puzzleId: `p${i}`, at: +now - DAY, solved: i < solved }))

  it('turns the knob the right way', () => {
    expect(calibrate(profile, reviews(19, 20), now)?.swingThresholdCp).toBe(125)
    expect(calibrate(profile, reviews(10, 20), now)?.swingThresholdCp).toBe(175)
    expect(calibrate(profile, reviews(16, 20), now)).toBeUndefined()
  })

  it('waits for 20 attempts and a week between moves', () => {
    expect(calibrate(profile, reviews(10, 19), now)).toBeUndefined()
    const moved = { ...profile, thresholdHistory: [{ cp: 175, at: +now - 2 * DAY, solveRate: 0.5 }] }
    expect(calibrate(moved, reviews(10, 20), now)).toBeUndefined()
  })
})

describe('heldLead', () => {
  it('needs 5 points held for 4 plies', () => {
    expect(heldLead(game('x', '1. e4 e5 2. Qh5 Qh4 3. Qxh4 Nc6 4. Qh3 Nf6 5. Nc3 d6'))).toBe(true)
    expect(heldLead(game('y', '1. e4 e5 2. Nf3 Nc6'))).toBe(false)
  })
})

describe('weeklyZeroHang', () => {
  it('buckets by week, newest last', () => {
    const e = (at: number, hang: boolean): JournalEntry => ({ gameId: String(at), at, opening: '', hung: hang ? { ply: 1, san: '', swingCp: 1 } : undefined, confirmed: false })
    const weeks = weeklyZeroHang([e(+now - DAY, false), e(+now - 2 * DAY, true), e(+now - 10 * DAY, false)], now, 3)
    expect(weeks).toEqual([undefined, 1, 0.5])
  })
})
