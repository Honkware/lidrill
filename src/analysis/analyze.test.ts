// @vitest-environment node
// The Node build of Stockfish thinks it's in a browser under jsdom.
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { pgnMoves } from '../sync/pgn'
import { analyzeMoves } from './analyze'
import { Engine, parseInfo, type UciEngine } from './engine'

const require = createRequire(import.meta.url)

// The Node build can only be initialised once per process, so every test
// shares one engine.
let shared: Promise<Engine> | undefined
function sharedEngine(): Promise<Engine> {
  shared ??= (async () => {
    const sf = await require('stockfish')('lite-single')
    const uci: UciEngine = {
      send: (cmd: string) => sf.sendCommand(cmd),
      onLine: (listener: (line: string) => void) => (sf.listener = listener),
    }
    return new Engine(uci)
  })()
  return shared
}

describe('parseInfo', () => {
  it('reads cp, mate and multipv lines', () => {
    expect(parseInfo('info depth 12 seldepth 18 multipv 1 score cp -34 nodes 1 nps 1 pv e7e5 g1f3')).toEqual({
      eval: { cp: -34 },
      pv: ['e7e5', 'g1f3'],
      depth: 12,
      multipv: 1,
    })
    expect(parseInfo('info depth 5 multipv 1 score mate 2 pv h5f7')!.eval).toEqual({ mate: 2 })
    expect(parseInfo('info depth 12 multipv 2 score cp 10 pv d7d5')!.multipv).toBe(2)
    expect(parseInfo('info string NNUE enabled')).toBeNull()
  })
})

describe('analyzeMoves with Stockfish', () => {
  let engine: Engine
  beforeAll(async () => {
    engine = await sharedEngine()
  })

  it('flags the move that allows mate and scores the mate', async () => {
    const moves = pgnMoves('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0')!
    const out = await analyzeMoves(moves, engine, { depth: 10, bookPlies: 0 })
    const nf6 = out[5]
    expect(nf6.san).toBe('Nf6')
    expect(nf6.judg).toBe('blunder')
    expect(nf6.eval).toEqual({ mate: 1 })
    expect(out[6].eval).toEqual({ cp: 10000 })
  }, 60_000)

  it('leaves book plies unsearched and unjudged', async () => {
    const moves = pgnMoves('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6')!
    const out = await analyzeMoves(moves, engine, { depth: 8, bookPlies: 4 })
    expect(out.slice(0, 4).every(m => m.book && !m.eval && !m.judg)).toBe(true)
    expect(out[4].eval).toBeDefined()
  }, 60_000)
})

describe('runQueue', () => {
  it('analyzes newest first, saves each game and stops when aborted', async () => {
    const { db } = await import('../db')
    const { runQueue } = await import('./queue')
    await db.games.clear()
    const base = { site: 'lichess' as const, url: '', pgn: '', color: 'white' as const, result: 'win' as const, rating: 0, speed: 'blitz', eco: '', opening: '', termination: '' }
    const moves = pgnMoves('1. e4 e5 2. Nf3 Nc6')!
    await db.games.bulkAdd([
      { ...base, id: 'old', playedAt: 1, moves },
      { ...base, id: 'new', playedAt: 2, moves },
    ])
    const engine = await sharedEngine()
    const controller = new AbortController()
    const seen: number[] = []
    await runQueue(engine, { depth: 6, bookPlies: async () => 0 }, p => {
      seen.push(p.done)
      if (p.done === 1) controller.abort()
    }, controller.signal)
    expect(seen).toEqual([0, 1])
    expect((await db.games.get('new'))!.analyzedAt).toBeDefined()
    expect((await db.games.get('old'))!.analyzedAt).toBeUndefined()
  }, 60_000)
})
