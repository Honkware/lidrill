// @vitest-environment node
// Golden checks against the reference account's real games,
// frozen in src/sync/fixtures/player_01.ndjson on Oct 6 2026. The engine part
// takes about a minute: GOLDEN=1 bun run test:golden.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { analyzeMoves } from './analysis/analyze'
import { Engine, type UciEngine } from './analysis/engine'
import type { Game } from './db'
import { hangOf } from './metrics'
import { bandFromRatings } from './profile'
import { generatePuzzles } from './puzzles/generate'
import { fromLichess } from './sync/lichess'

const require = createRequire(import.meta.url)
const games = readFileSync('src/sync/fixtures/player_01.ndjson', 'utf8')
  .trim()
  .split('\n')
  .map(l => fromLichess(JSON.parse(l), 'player_01')!)
const analysed = games.filter(g => g.serverAnalysis)

// Lichess's evals cover every position but the start, which this answers
const noEngine = { search: async () => ({ eval: { cp: 20 }, pv: [], depth: 1, multipv: 1 }) } as unknown as Engine
const judged = async (g: Game) => ({ ...g, moves: await analyzeMoves(g.moves, noEngine, { depth: 1, bookPlies: 8 }), analyzedAt: 1 })

describe('reference account', () => {
  it('has the 25 games, 12 with Lichess analysis', () => {
    expect(games.length).toBe(25)
    expect(analysed.length).toBe(12)
  })

  it('is a beginner: 9 provisional rapid games at 884 beat the 1500 starting ratings', () => {
    // perfs from /api/user/player_01 on Oct 6 2026
    const perfs = { rapid: { rating: 884, games: 9, prov: true }, classical: { rating: 1270, games: 1, prov: true } }
    expect(bandFromRatings(perfs)).toBe('beginner')
  })

  it('is hang-dominant: most analysed games have a 3-pawn hang', async () => {
    const hangs = (await Promise.all(analysed.map(judged))).filter(g => hangOf(g, 'beginner'))
    expect(hangs.length).toBe(10)
  })
})

describe.runIf(process.env.GOLDEN)('reference games with Stockfish', () => {
  it('replay of game0006 stops on the move before mate and asks for a saving move', async () => {
    const sf = await require('stockfish')('lite-single')
    const uci: UciEngine = { send: c => sf.sendCommand(c), onLine: l => (sf.listener = l) }
    const engine = new Engine(uci)
    const game = games.find(g => g.id === 'lichess:game0006')!
    // 29. Ra1?? R8c3#
    expect(game.moves.slice(-2).map(m => m.san)).toEqual(['Ra1', 'R8c3#'])
    const moves = await analyzeMoves(game.moves, engine, { depth: 14, bookPlies: 8 })
    const stops = await generatePuzzles({ ...game, moves, analyzedAt: 1 }, engine, { swingThresholdCp: 300, marginCp: 150, depth: 16, maxSolutionMoves: 3 })
    const last = stops.find(p => p.ply === 57)
    expect(last).toBeDefined()
    expect(last!.played).toBe(game.moves[56].uci)
    const accepted = last!.alternatives ?? [last!.solution[0]]
    expect(accepted).not.toContain(last!.played)
  }, 180_000)
})
