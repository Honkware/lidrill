import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import { cachedPolicy, treeLevel } from './policy'

beforeEach(() => db.policy.clear())

describe('cachedPolicy', () => {
  // 1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O, written the way chessops reads games
  const moves = 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5 e1h1'.split(' ')

  it('asks the server once per position and level, with castling as king takes rook', async () => {
    const asked: unknown[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      asked.push(JSON.parse(String(init.body)))
      return Response.json({ moves: [{ uci: 'g8f6', p: 0.6 }, { uci: 'd7d6', p: 0.4 }] })
    }) as typeof fetch
    const policy = cachedPolicy(1500, fetchFn)
    expect(await policy(moves)).toEqual([{ uci: 'g8f6', p: 0.6 }, { uci: 'd7d6', p: 0.4 }])
    await policy(moves)
    expect(asked).toEqual([{ moves, level: 1500 }])
  })

  it('stores a castling reply as king takes rook, so it matches the repertoire', async () => {
    const fetchFn = (async () => Response.json({ moves: [{ uci: 'e1g1', p: 1 }] })) as typeof fetch
    expect(await cachedPolicy(1500, fetchFn)(moves.slice(0, 6))).toEqual([{ uci: 'e1h1', p: 1 }])
  })
})

describe('treeLevel', () => {
  it('rounds the estimate to 100 inside the levels Maia plays', () => {
    expect([treeLevel(1449), treeLevel(1450), treeLevel(420), treeLevel(2600)]).toEqual([1400, 1500, 600, 2300])
  })
})
