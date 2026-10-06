// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { analyzeMoves } from '../analysis/analyze'
import { Engine, type SearchResult, type UciEngine } from '../analysis/engine'
import type { Game, Move } from '../db'
import { bandFromRatings, computeBand } from '../profile'
import { pgnMoves } from '../sync/pgn'
import { findCandidates, generatePuzzles, isUnique, povCp } from './generate'

const require = createRequire(import.meta.url)

const game = (moves: Move[], color: 'white' | 'black', extra: Partial<Game> = {}): Game => ({
  id: 'test:1', site: 'lichess', url: '', pgn: '', color, result: 'loss', rating: 800, speed: 'rapid',
  eco: '', opening: '', playedAt: 0, termination: '', moves, ...extra,
})

describe('computeBand', () => {
  const g = (rating: number, speed = 'rapid', playedAt = 0) => game([], 'white', { rating, speed, playedAt })
  it('uses the median of recent rapid/classical games', () => {
    expect(computeBand([g(900), g(950), g(2000)])).toBe('beginner')
    expect(computeBand([g(1200), g(1500), g(900)])).toBe('club')
    expect(computeBand([g(1900), g(2100)])).toBe('advanced')
  })
  it('prefers the settled Lichess rating in the most played slow speed', () => {
    const perfs = { rapid: { rating: 884, games: 3, prov: true }, classical: { rating: 1270, games: 12 }, blitz: { rating: 2000, games: 90 } }
    expect(bandFromRatings(perfs)).toBe('club')
    expect(computeBand([g(1900)], perfs)).toBe('club')
    expect(bandFromRatings({ blitz: { rating: 1500, games: 4, prov: true } })).toBeUndefined()
    expect(computeBand([g(1900)], { blitz: { rating: 1500, games: 4, prov: true } })).toBe('advanced')
  })
  it('falls back to blitz, then to beginner', () => {
    expect(computeBand([g(1500, 'blitz')])).toBe('club')
    expect(computeBand([])).toBe('beginner')
  })
})

describe('candidates', () => {
  const line = (evals: (number | undefined)[]) => {
    const sans = pgnMoves('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 Bb4+ 7. Nc3 Nxe4')!
    return sans.map((m, i) => ({ ...m, eval: evals[i] === undefined ? undefined : { cp: evals[i] } }))
  }
  it('keeps player moves that drop past the threshold, after ply 10', () => {
    // ply 11 (white's 6th) drops 350 for white
    const evals = [20, 20, 20, 20, 20, 20, 20, 20, 20, 20, -330, -330, -330, -330]
    const c = findCandidates(game(line(evals), 'white'), 300)
    expect(c.map(x => x.ply)).toEqual([11])
    expect(c[0].swingCp).toBe(350)
  })
  it('ignores the opponent\'s moves, early plies and decided positions', () => {
    const early = [20, 20, -400, -400, -400, -400, -400, -400, -400, -400, -400, -400, -400, -400]
    expect(findCandidates(game(line(early), 'white'), 300)).toEqual([])
    expect(findCandidates(game(line(early), 'black'), 300)).toEqual([])
    const decided = [950, 950, 950, 950, 950, 950, 950, 950, 950, 950, 500, 500, 500, 500]
    expect(findCandidates(game(line(decided), 'white'), 300)).toEqual([])
  })
})

describe('uniqueness', () => {
  const r = (cp: number | undefined, mate?: number): SearchResult => ({ eval: { cp, mate }, pv: ['e2e4'], depth: 18, multipv: 1 })
  it('needs a gap of at least the margin, or mate against no mate', () => {
    expect(isUnique([r(300), r(150)], 150)).toBe(true)
    expect(isUnique([r(300), r(200)], 150)).toBe(false)
    expect(isUnique([r(undefined, 2), r(800)], 150)).toBe(true)
    expect(isUnique([r(undefined, 2), r(undefined, 3)], 150)).toBe(false)
  })
  it('squashes mates to ±1000 for swings', () => {
    expect(povCp({ mate: -2 }, 'white')).toBe(-1000)
    expect(povCp({ cp: 250 }, 'black')).toBe(-250)
  })
})

describe('generatePuzzles with Stockfish', () => {
  it('turns a missed Legal\'s mate into a mate puzzle', async () => {
    const sf = await require('stockfish')('lite-single')
    const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
    const engine = new Engine(uci)
    // 6. Kxd1 instead of 6. Bxf7+ Ke7 7. Nd5#
    const moves = pgnMoves('1. e4 e5 2. Nf3 d6 3. Bc4 Bg4 4. Nc3 h6 5. Nxe5 Bxd1 6. Kxd1 dxe5 *')!
    const analyzed = await analyzeMoves(moves, engine, { depth: 12, bookPlies: 0 })
    const puzzles = await generatePuzzles(game(analyzed, 'white'), engine, {
      swingThresholdCp: 300, marginCp: 150, depth: 16, maxSolutionMoves: 3,
    })
    expect(puzzles).toHaveLength(1)
    const p = puzzles[0]
    expect(p.ply).toBe(11)
    expect(p.played).toBe('e1d1')
    expect(p.solution).toEqual(['c4f7', 'e8e7', 'c3d5'])
    expect(p.solutionLen).toBe(2)
    expect(p.tag).toBe('mate')
    expect(p.type).toBe('missed-win')
  }, 120_000)
})
