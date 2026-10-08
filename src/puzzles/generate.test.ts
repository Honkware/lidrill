// @vitest-environment node
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { analyzeMoves } from '../analysis/analyze'
import { Engine, type SearchResult, type UciEngine } from '../analysis/engine'
import type { Game, Move } from '../db'
import { bandFromRatings, computeBand } from '../profile'
import { pgnMoves } from '../sync/pgn'
import { findCandidates, generatePuzzles, isUnique, povCp, SOLUTION_PLIES_CAP } from './generate'

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

describe('hold puzzles', () => {  // 6. Ng5 with a made-up 3.5-pawn drop; the engine below is scripted
  const moves = pgnMoves('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. O-O Nf6 6. Ng5 O-O')!.map((m, i) => ({
    ...m,
    eval: { cp: i < 10 ? 30 : -320 },
  }))
  const line = (uci: string, cp: number): SearchResult => ({ eval: { cp }, pv: [uci], depth: 16, multipv: 1 })
  const scripted = (holding: SearchResult[]) =>
    ({ searchLines: async (_: string, __: number, count: number) => (count === 2 ? holding.slice(0, 2) : holding.slice(0, count)) }) as unknown as Engine
  const opts = { swingThresholdCp: 300, marginCp: 150, depth: 16, maxSolutionMoves: 3 }

  it('accepts any of 2-3 moves that keep the position', async () => {
    const [p] = await generatePuzzles(game(moves, 'white'), scripted([line('c2c3', 40), line('h2h3', 20), line('b1c3', -10), line('f1e1', -200)]), opts)
    expect(p.ply).toBe(11)
    expect(p.alternatives).toEqual(['c2c3', 'h2h3', 'b1c3'])
    expect(p.solution).toEqual(['c2c3'])
  })

  it('skips positions where almost anything holds, or where the played move held', async () => {
    const many = [line('c2c3', 40), line('h2h3', 30), line('b1c3', 20), line('f1e1', 10)]
    expect(await generatePuzzles(game(moves, 'white'), scripted(many), opts)).toEqual([])
    const playedHolds = [line('c2c3', 40), line('f3g5', 20), line('f1e1', -300)]
    expect(await generatePuzzles(game(moves, 'white'), scripted(playedHolds), opts)).toEqual([])
  })
})

describe('selection length cap', () => {
  const opts = { swingThresholdCp: 300, marginCp: 150, depth: 16, maxSolutionMoves: 3 }
  // 6. Ng5 blunders (ply 11); the real continuation 6. d4 exd4 7. e5 d5
  // 8. exd6 cxd6 9. c3 is the certified answer line - every scripted search
  // returns its remaining suffix, so extendSolution walks it legally
  const moves = pgnMoves('1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. d3 d6 5. O-O Nf6 6. Ng5 O-O')!.map((m, i) => ({
    ...m,
    eval: { cp: i < 10 ? 30 : -320 },
  }))
  const LINE = ['d2d4', 'e5d4', 'e4e5', 'd7d5', 'e5d6', 'c7d6', 'c2c3']
  const scripted = () => {
    let calls = 0
    return {
      searchLines: async (_fen: string, _depth: number, count: number) => {
        void count
        if (calls++ === 0)
          // the candidate search: the answer, and a much worse second line
          return [
            { eval: { cp: 700 }, pv: LINE, depth: 16, multipv: 1 },
            { eval: { cp: -400 }, pv: ['g1g5'], depth: 16, multipv: 2 },
          ]
        // extension searches run at 2, 4 line-moves played: the legal suffix
        const at = [2, 4][Math.min(calls - 2, 1)]!
        return [{ eval: { cp: 700 }, pv: LINE.slice(at), depth: 16, multipv: 1 }]
      },
    } as unknown as Engine
  }

  it('caps solutions at the band ply cap: deep lines never become puzzles', async () => {
    expect(SOLUTION_PLIES_CAP).toEqual({ beginner: 2, club: 3, advanced: 5 })
    // 5 plies of forced solution: fine for advanced, over cap for club and beginner
    expect(await generatePuzzles(game(moves, 'white'), scripted(), { ...opts, band: 'advanced' })).toHaveLength(1)
    expect(await generatePuzzles(game(moves, 'white'), scripted(), { ...opts, band: 'club' })).toEqual([])
    expect(await generatePuzzles(game(moves, 'white'), scripted(), { ...opts, band: 'beginner' })).toEqual([])
  })

  it('a solution inside the cap still becomes a puzzle', async () => {
    // The same position at club with a two-ply bound: 3 plies ≤ cap 3
    const puzzles = await generatePuzzles(game(moves, 'white'), scripted(), { ...opts, band: 'club', maxSolutionMoves: 2 })
    expect(puzzles).toHaveLength(1)
    expect(puzzles[0]!.solution).toHaveLength(3)
  })

  it('without a band the corpus range is uncapped (certification testing)', async () => {
    const [p] = await generatePuzzles(game(moves, 'white'), scripted(), opts)
    expect(p.solution).toEqual(LINE.slice(0, 5))
  })
})
