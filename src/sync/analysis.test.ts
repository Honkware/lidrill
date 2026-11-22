import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accuracy } from '../analysis/accuracy'
import { analyzeMoves } from '../analysis/analyze'
import type { Engine } from '../analysis/engine'
import { fromLichess } from './lichess'

// A real export line with Lichess's computer analysis attached
const raw = JSON.parse(readFileSync('src/sync/fixtures/lichess-analysed.ndjson', 'utf8').trim().split('\n')[0])

describe('Lichess server analysis', () => {
  const game = fromLichess(raw, 'penguingim1')!

  it('carries the evals over onto the moves', () => {
    expect(game.serverAnalysis).toBe(true)
    expect(game.accuracy).toBe(raw.players[game.color].analysis.accuracy)
    expect(game.moves.filter(m => m.eval).length).toBe(raw.analysis.length)
  })

  it('needs no engine for analysed positions, and judges like Lichess', async () => {
    let searches = 0
    const engine = {
      search: async () => (searches++, { eval: { cp: 20 }, pv: [], depth: 1, multipv: 1 }),
    } as unknown as Engine
    const moves = await analyzeMoves(game.moves, engine, { depth: 14, bookPlies: 0 })
    // the start position has no eval in the export; the final move is mate
    expect(searches).toBe(1)
    for (const color of ['white', 'black'] as const) {
      const mine = moves.filter((_, i) => (i % 2 === 0) === (color === 'white'))
      const count = (j: string) => mine.filter(m => m.judg === j).length
      const want = raw.players[color].analysis
      expect({ inaccuracy: count('inaccuracy'), mistake: count('mistake'), blunder: count('blunder') }).toEqual({
        inaccuracy: want.inaccuracy,
        mistake: want.mistake,
        blunder: want.blunder,
      })
    }
  })

  it('gives each side the accuracy Lichess gave it', async () => {
    const engine = { search: async () => ({ eval: { cp: 20 }, pv: [], depth: 1, multipv: 1 }) } as unknown as Engine
    const a = accuracy(await analyzeMoves(game.moves, engine, { depth: 14, bookPlies: 0 }))!
    expect([Math.round(a.white), Math.round(a.black)]).toEqual([raw.players.white.analysis.accuracy, raw.players.black.analysis.accuracy])
  })
})
