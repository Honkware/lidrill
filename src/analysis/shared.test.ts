import { describe, expect, it } from 'vitest'
import type { Game, Move } from '../db'
import { analyzeMoves } from './analyze'
import type { Engine } from './engine'
import { evalsKey, shareable, shared, withShared } from './shared'

const moves: Move[] = ['e2e4', 'e7e5', 'g1f3'].map(uci => ({ san: '', uci }))
const game = (over: Partial<Game> = {}) => ({ id: 'chesscom:1', site: 'chesscom', moves, ...over }) as Game
const key = evalsKey(moves, 14)

const serving = (found: Record<string, unknown>, calls: unknown[] = []) =>
  (async (_: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string))
    return new Response(JSON.stringify({ found }))
  }) as unknown as typeof fetch

describe('shared evals', () => {
  it('names a game by the hash the server computes for the same moves and depth', () => {
    // the value asserted in server/test_app.py
    expect(key).toBe('5874d995026839a121819905e56e157a43fd79e5cc578877eb20e173e93cf473')
    expect(evalsKey(moves, 16)).not.toBe(key)
  })

  it('leaves out games against Maia and games Lichess analysed', async () => {
    expect(shareable(game())).toBe(true)
    expect(shareable(game({ site: 'maia' }))).toBe(false)
    expect(shareable(game({ serverAnalysis: true }))).toBe(false)
    const calls: { keys: string[] }[] = []
    await shared(serving({}, calls)).get([game(), game({ id: 'maia:1', site: 'maia' })], 14)
    expect(calls).toEqual([{ keys: [key] }])
  })

  it('takes what the server has by game id, and nothing that is not one eval per move', async () => {
    const evals = [null, { cp: 31 }, { cp: 25 }]
    expect(await shared(serving({ [key]: evals })).get([game()], 14)).toEqual(new Map([['chesscom:1', evals]]))
    expect((await shared(serving({ [key]: evals.slice(1) })).get([game()], 14)).size).toBe(0)
    expect((await shared(serving({ [key]: [null, { cp: 'x' }, null] })).get([game()], 14)).size).toBe(0)
  })

  it('searches as before when the server cannot be reached', async () => {
    const down = (async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    expect((await shared(down).get([game()], 14)).size).toBe(0)
    await expect(shared(down).put(moves, 14)).resolves.toBeUndefined()
  })

  it('uploads the moves and the eval after each one', async () => {
    const calls: unknown[] = []
    await shared(serving({}, calls)).put([{ ...moves[0] }, { ...moves[1], eval: { cp: 31 } }, { ...moves[2], eval: { mate: 4 } }], 14)
    expect(calls).toEqual([{ depth: 14, moves: ['e2e4', 'e7e5', 'g1f3'], evals: [null, { cp: 31 }, { mate: 4 }] }])
  })

  it('saves the engine every position the shared evals cover', async () => {
    let searches = 0
    const engine = { search: async () => (searches++, { eval: { cp: 20 }, pv: [], depth: 14, multipv: 1 }) } as unknown as Engine
    const filled = withShared(moves, [{ cp: 30 }, { cp: 31 }, { cp: 25 }])
    const analyzed = await analyzeMoves(filled, engine, { depth: 14, bookPlies: 0 })
    // only the start position, which no move's eval describes
    expect(searches).toBe(1)
    expect(analyzed.map(m => m.eval)).toEqual([{ cp: 30 }, { cp: 31 }, { cp: 25 }])
    // an eval the game already has is kept
    expect(withShared([{ ...moves[0], eval: { cp: 5 } }], [{ cp: 30 }])[0].eval).toEqual({ cp: 5 })
  })
})
