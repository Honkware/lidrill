import { createEmptyCard } from 'ts-fsrs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db, type Game, type Puzzle } from '../db'
import { serverSync } from './server'

// The client protocol against an in-memory backend: two sequential serverSync
// passes with an emptied IndexedDB in between play the two-devices scenario.

interface WireRow {
  table: string
  id: string
  updatedAt: number
  data: any
}

class FakeBackend {
  rows = new Map<string, WireRow>()
  wiped = 0

  key(r: WireRow) {
    return `${r.table}|${r.id}`
  }

  fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.pathname === '/api/sync/push') {
      const { rows } = JSON.parse(String(init?.body))
      for (const r of rows as WireRow[]) {
        const existing = this.rows.get(this.key(r))
        if (!existing || r.updatedAt > existing.updatedAt) this.rows.set(this.key(r), r)
      }
      return ok({ ok: true })
    }
    if (url.pathname === '/api/sync/pull') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const rows = [...this.rows.values()].filter(r => r.updatedAt > since).sort((a, b) => a.updatedAt - b.updatedAt)
      return ok({ rows, nextCursor: null })
    }
    if (url.pathname === '/api/sync/rows' && init?.method === 'DELETE') {
      this.wiped++
      this.rows.clear()
      return ok({ ok: true })
    }
    return ok({ error: 'not found' }, 404)
  })
}

const game: Game = {
  id: 'lichess:abc', site: 'lichess', url: 'u', pgn: 'pgn', color: 'white', result: 'win', rating: 1200,
  speed: 'blitz', eco: 'A00', opening: 'Opening', playedAt: 1727000000000, moves: [{ san: 'e4', uci: 'e2e4' }], termination: 'resign',
}

const puzzle: Puzzle = {
  id: 'lichess:abc:3', gameId: 'lichess:abc', ply: 3, fen: 'fen', played: 'e2e4', solution: [], solutionLen: 1,
  type: 'hang', tag: 'hang', swingCp: 300, card: { ...createEmptyCard(), due: new Date(1727000000000) },
}

let backend: FakeBackend

beforeEach(async () => {
  backend = new FakeBackend()
  await Promise.all(db.tables.map(t => t.clear()))
})

afterEach(() => vi.unstubAllGlobals())

const sync = () => serverSync('token', backend.fetch as unknown as typeof fetch)

describe('serverSync', () => {
  it('pushes queued rows and clears the queue', async () => {
    await db.games.put(game)
    await db.puzzles.put(puzzle)
    expect(await db.syncQueue.count()).toBe(2)
    const r = await sync()
    expect(r.pushed).toBe(2)
    expect(await db.syncQueue.count()).toBe(0)
    expect(backend.rows.get('games|lichess:abc')?.data).toEqual(game)
    // FSRS card dates serialize to strings on the wire
    const wired = backend.rows.get('puzzles|lichess:abc:3') as { data: Puzzle }
    expect(wired.data.card.due).toBe('2024-09-22T10:13:20.000Z')
  })

  it('queues writes made through any code path, including auto-increment adds', async () => {
    const { recordAttempt } = await import('../train')
    await db.puzzles.put(puzzle)
    await recordAttempt(puzzle, true, new Date(1727000100000))
    expect(await db.syncQueue.count()).toBe(2) // puzzle card update + review add
    const r = await sync()
    expect(r.pushed).toBe(2)
    expect(backend.rows.has('reviews|1')).toBe(true)
  })

  it('a second device pulls what the first pushed (fresh IndexedDB)', async () => {
    await db.games.put(game)
    await sync()
    await Promise.all(db.tables.map(t => t.clear()))
    // ^ device 2: empty browser. Its first pass pulls everything.
    const r = await sync()
    expect(r.pulled).toBe(1)
    expect(await db.games.get('lichess:abc')).toEqual(game)
    // and a following pass is a no-op (watermark remembered)
    expect((await sync()).pulled).toBe(0)
  })

  it('conflict: a server row newer than a dirty local row wins on pull', async () => {
    await db.games.put(game)
    await sync()
    await Promise.all(db.tables.map(t => t.clear()))

    // device 2 writes locally (dirty queue entry at T1) and stays offline;
    // meanwhile device 1's analyzed copy (T2 > T1) reached the server
    await db.games.put(game)
    const t1 = (await db.syncQueue.get(['games', 'lichess:abc']))!.at
    const t2 = t1 + 100_000
    backend.rows.set('games|lichess:abc', { table: 'games', id: 'lichess:abc', updatedAt: t2, data: { ...game, analyzedAt: t2 } })

    const r = await sync()
    expect(r.pulled).toBe(1)
    expect((await db.games.get('lichess:abc'))!.analyzedAt).toBe(t2)
    expect(await db.syncQueue.count()).toBe(0) // the stale push intent is gone
  })

  it('revives FSRS card dates from the wire', async () => {
    await db.puzzles.put(puzzle)
    await sync()
    await Promise.all(db.tables.map(t => t.clear()))
    await sync()
    const got = await db.puzzles.get(puzzle.id)
    expect(got?.card.due instanceof Date).toBe(true)
    expect(got?.card.due.getTime()).toBe(1727000000000)
  })

  it('deleteEverything wipes the server copy on the next pass', async () => {
    const { deleteAllData } = await import('../backup')
    await db.games.put(game)
    await sync()
    await deleteAllData()
    expect((await db.serverMeta.get('wipe'))?.value).toBe(1)
    await sync()
    expect(backend.wiped).toBe(1)
    expect(backend.rows.size).toBe(0)
    // and nothing resurrects on the next pull
    expect((await sync()).pulled).toBe(0)
  })

  it('a 401 means the sign-in expired', async () => {
    backend.fetch.mockImplementation(async () => new Response(JSON.stringify({ error: 'sign-in-expired' }), { status: 401 }))
    await db.games.put(game)
    await expect(sync()).rejects.toThrow()
    const { SignInExpired } = await import('./lichess')
    await expect(sync()).rejects.toBeInstanceOf(SignInExpired)
    // the queue survives, so a re-sign-in retries the push
    expect(await db.syncQueue.count()).toBe(1)
  })
})
