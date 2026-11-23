import { describe, expect, it } from 'vitest'
import type { Game, Judgment } from './db'
import { gameTime, timeControl, timeProfile, timeProfiles } from './time'
import { pgnMoves } from './sync/pgn'

// Small games whose clocks are written out by hand, so every number in the
// expectations can be worked out on paper

// 1. Nf3 Nf6 2. Ng1 Ng8 and again, for as many plies as there are clocks
function game(tc: string, clocks: number[], extra: Partial<Game> = {}, judg: Record<number, Judgment> = {}): Game {
  const san = ['Nf3', 'Nf6', 'Ng1', 'Ng8']
  const text = clocks.map((_, i) => `${i % 2 ? '' : `${i / 2 + 1}. `}${san[i % 4]}`).join(' ')
  const pgn = `[TimeControl "${tc}"]\n\n${text} *`
  return {
    id: 'lichess:x',
    site: 'lichess',
    url: '',
    pgn,
    color: 'white',
    result: 'win',
    rating: 1500,
    speed: 'blitz',
    eco: '',
    opening: '',
    playedAt: 1,
    analyzedAt: 1,
    moves: pgnMoves(pgn)!.map((m, i) => (judg[i] ? { ...m, judg: judg[i] } : m)),
    termination: 'resign',
    clocks,
    ...extra,
  }
}

// 60+1: white takes 4 s, 10 s and 2 s over moves 2 to 4, black 2 s each
const short = [6000, 6000, 5700, 5900, 4800, 5800, 4700, 5700]

describe('time per move', () => {
  it('reads the time control from the PGN, or from the speed of a game against Maia', () => {
    expect(timeControl(game('180+2', short))).toEqual({ base: 180, inc: 2 })
    expect(timeControl(game('300', short))).toEqual({ base: 300, inc: 0 })
    expect(timeControl(game('-', short))).toBeUndefined()
    expect(timeControl(game('-', short, { site: 'maia', speed: '5+3' }))).toEqual({ base: 300, inc: 3 })
    expect(timeControl(game('-', short, { site: 'maia', speed: 'untimed' }))).toBeUndefined()
  })

  it('takes the clock before minus the clock after plus the increment, from the second move', () => {
    const t = gameTime(game('60+1', short))!
    expect(t.moves.map(m => [m.move, m.secs])).toEqual([[2, 4], [3, 10], [4, 2]])
    expect(t.median).toBe(4)
  })

  it('times the black side when the player was black', () => {
    expect(gameTime(game('60+1', short, { color: 'black' }))!.moves.map(m => m.secs)).toEqual([2, 2, 2])
  })

  it('calls a move slow over twice the game median and fast under half of it', () => {
    // 10 s is over 2 x 4 s; 2 s is not under 4 / 2
    expect(gameTime(game('60+1', short))!.moves.map(m => m.pace)).toEqual(['normal', 'slow', 'normal'])
  })

  it('leaves out the extra clock Lichess sends after a resignation', () => {
    const g = game('60+1', short)
    expect(gameTime({ ...g, clocks: [...short, 100] })!.moves).toHaveLength(3)
  })

  it('has nothing for a game without clocks or a time control', () => {
    expect(gameTime(game('60+1', short, { clocks: undefined }))).toBeUndefined()
    expect(gameTime(game('-', short))).toBeUndefined()
  })
})

describe('a game against the clock', () => {
  it('counts the share of the base gone after move 15', () => {
    // 14 timed moves of 2 s each leave 100 - 28 = 72 s of 100
    const clocks = Array.from({ length: 30 }, (_, i) => 10000 - (i >> 1) * 200 * (i % 2 ? 0 : 1))
    expect(gameTime(game('100', clocks))!.usedBy15).toBeCloseTo(0.28)
    expect(gameTime(game('100', clocks.slice(0, 28)))!.usedBy15).toBeUndefined()
  })

  it('marks time trouble under a tenth of the base, and a loss on time', () => {
    expect(gameTime(game('60+1', short))!.trouble).toBe(false)
    const low = [...short.slice(0, 6), 590, 5700]
    expect(gameTime(game('60+1', low))!.trouble).toBe(true)
    const flagged = gameTime(game('60+1', short, { result: 'loss', termination: 'outoftime' }))!
    expect(flagged.lostOnTime && flagged.trouble).toBe(true)
    expect(gameTime(game('60+1', short, { result: 'draw', termination: 'outoftime' }))!.lostOnTime).toBe(false)
  })
})

describe('the time profile', () => {
  // White's move 3 (ply index 4) is the slow one in each game
  const five = (extra: Partial<Game> = {}, judg: Record<number, Judgment> = { 4: 'blunder', 6: 'mistake' }) =>
    Array.from({ length: 5 }, (_, i) => game('60+1', short, { id: `lichess:${i}`, playedAt: i, ...extra }, judg))

  it('splits mistakes and blunders by pace across the games', () => {
    const p = timeProfile(five(), 'blitz')!
    expect(p.games).toBe(5)
    expect(p.pace).toEqual({ fast: { moves: 0, errors: 0 }, normal: { moves: 10, errors: 5 }, slow: { moves: 5, errors: 5 } })
  })

  it('needs five analyzed games at the speed, and leaves games against Maia out', () => {
    expect(timeProfile(five().slice(1), 'blitz')).toBeUndefined()
    expect(timeProfile(five({ speed: 'rapid' }), 'blitz')).toBeUndefined()
    expect(timeProfile(five({ analyzedAt: undefined }), 'blitz')).toBeUndefined()
    expect(timeProfile(five({ site: 'maia', speed: '1+1' }), 'blitz')).toBeUndefined()
  })

  it('counts games in time trouble and lost on time', () => {
    const games = [...five(), game('60+1', short, { id: 'lichess:late', playedAt: 9, result: 'loss', termination: 'outoftime' })]
    const p = timeProfile(games, 'blitz')!
    expect([p.games, p.trouble, p.lostOnTime]).toEqual([6, 1, 1])
  })

  it('takes the think time from moves after move 10, else from every move', () => {
    expect(timeProfile(five(), 'blitz')!.think).toBe(4)
    // White takes 1 s a move to move 10 and 5 s on moves 11 and 12
    const spent = (move: number) => (move <= 10 ? move - 1 : 9 + (move - 10) * 5)
    const clocks = Array.from({ length: 24 }, (_, i) => (i % 2 ? 10000 : 10000 - spent((i >> 1) + 1) * 100))
    const long = Array.from({ length: 5 }, (_, i) => game('100', clocks, { id: `lichess:${i}` }))
    expect(timeProfile(long, 'blitz')!.think).toBe(5)
  })

  it('puts the speed with more games first', () => {
    const games = [...five(), ...five({ speed: 'rapid' }), game('60+1', short, { id: 'lichess:r', speed: 'rapid' })]
    expect(timeProfiles(games).map(p => p.speed)).toEqual(['rapid', 'blitz'])
  })
})
